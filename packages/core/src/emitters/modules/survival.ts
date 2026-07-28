/**
 * Survival module — Kaplan-Meier curves, S(t) at fixed horizons, median
 * survival, and the two-group log-rank test.
 *
 * This family inverts the usual split. In the regression family every fitted
 * coefficient is SAS-primary because IRLS has no SQL counterpart; here the
 * product-limit estimator, Greenwood's variance, both interval forms, the
 * median AND the log-rank statistic are all closed form, so all of them are
 * EXECUTED in both twins and checked by the harness. Exactly one column is
 * SAS-primary: the p-value, because a chi-square tail probability is the only
 * quantity in the whole module that needs a distribution function.
 *
 * That leaves a gap worth closing rather than tolerating. A DECISION at
 * alpha = 0.05 does not need a CDF — for one degree of freedom the critical
 * value is z^2, which this repo already pins as 3.8416 — so the emitted SQL
 * states the decision and labels it as a critical-value comparison, and the
 * exact p-value still comes from SAS. An analyst gets an answer from the SQL
 * alone without anybody inventing a number.
 *
 * THE ANCHOR. The SAS twin does not simply run PROC LIFETEST and report it. It
 * computes the same closed form the SQL does, runs LIFETEST beside it, and
 * prints a row-by-row PASS/FAIL. Unlike a GLM's MLE, the product-limit
 * estimator has a closed form, so the procedure can be checked rather than
 * trusted — the survival analogue of the saturated-design anchor.
 *
 * Verified vs Gold Case A: 8 at risk, events at days 100 (P02), 200 (P03) and
 * 300 (P07), everyone else censored at 365. S = 7/8, 3/4, 5/8 with Greenwood
 * sums 1/56, 1/24, 3/40. S(365) = 0.625, so 1 - S(365) = 0.375, which is the
 * cumulative-incidence module's independently computed 3/8 — two modules,
 * different algorithms, same number. Reference arm median = 200 EXACTLY (the
 * curve lands on one half, which is the boundary the median's inequality is
 * evaluated at); exposed arm median NULL. Log-rank chi-square = 961/1265 =
 * 0.75968, below 3.8416. All hand-derived, all asserted in verify/run.ts.
 */
import type { SurvivalAnalysis } from "../../spec/types";
import { findCodeList, survivalOutcome } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import { cmt, describeWin, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import { rateCoreSqlCtes, censorPlan, renderCensorSql, renderCensorSas } from "../rate-core";
import {
  kmSqlCtes,
  kmSeSql,
  kmCiSql,
  kmHorizonSqlCtes,
  kmMedianSqlCtes,
  logRankSqlCtes,
  kmSasLifeTableSteps,
  kmSasCiLines,
  kmSasLifetestAnchor,
  MEDIAN_EPS,
  CHI2_CRIT_95_DF1,
  CHI2_CRIT_95_DF1_EXACT,
} from "../km-core";
import {
  outcomeSettingPlan,
  parityStamp,
  survivalLimitations,
  survivalParity,
  SURVIVAL_METHOD_NOTES,
} from "../parity";

const MEASURE = "survival";

/** ord bands, so one ORDER BY sorts a table of five different row shapes. */
const ORD_LIFE = 10000;
const ORD_HORIZON = 20000;
const ORD_MEDIAN = 30000;
const ORD_LOGRANK = 40000;
const ORD_HR = 50000;

/** Resolve the two exposure levels, when the analysis asks for a comparison. */
function plan(ctx: SqlCtx | SasCtx, an: SurvivalAnalysis) {
  const gv = an.groupVarId ? ctx.spec.groupVars.find((g) => g.id === an.groupVarId) : undefined;
  const referenceLevel = gv?.referenceLevel ?? gv?.levels[0] ?? null;
  const exposedLevel = gv?.levels.find((l) => l !== referenceLevel) ?? null;
  const grouped = Boolean(gv && referenceLevel && exposedLevel);
  return {
    gv,
    referenceLevel: grouped ? referenceLevel : null,
    exposedLevel: grouped ? exposedLevel : null,
    grouped,
    /* 'Overall' always, then the two arms. The log-rank statistic is
     * accumulated for the EXPOSED level, matching the regression family, where
     * every reported effect is for the non-reference arm. */
    strata: grouped ? ["Overall", referenceLevel as string, exposedLevel as string] : ["Overall"],
    comparison: grouped ? `${exposedLevel} vs ${referenceLevel}` : null,
  };
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlSurvival(ctx: SqlCtx, an: SurvivalAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_km${suffix}`;
  const od = survivalOutcome(an);
  const p = plan(ctx, an);

  const L: string[] = [];

  /* The death endpoint never reaches here — readiness refuses it (spec/types.ts,
   * "survival" case). This is the belt to that braces: an emitter that silently
   * produced an empty program for a refused endpoint would be a worse failure
   * than the refusal it was meant to enforce. */
  if (!od) {
    L.push(`-- NOT EMITTED: this analysis declares a MORTALITY endpoint, which is refused.`);
    L.push(`-- MarketScan's only native death signal is DSTATUS: in-hospital death only,`);
    L.push(`-- masked from data year 2016. See specReadiness("survival").`);
    return {
      slug: `km${suffix}`,
      title: `Survival${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted - mortality endpoint is refused",
      extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`],
      body: L.join("\n"),
    };
  }

  const clid = od.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(od, listSystem);
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  const washoutPred = wc.length > 0 ? wc.join("\n      AND ") : "TRUE";

  /* Censoring is decided ONCE in rate-core and only rendered here, so this
   * curve's follow-up cannot disagree with the incidence table's person-time
   * about when a subject stopped being observed. */
  const censor = censorPlan(spec, an.personTimeRule);
  const adminCensor = renderCensorSql(ctx, censor);

  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `ch.index_code`;

  L.push(
    `-- ${parityStamp(
      "survival",
      survivalParity(an, {
        settingFilter: setting.stamped, censorTerms: censor.applied, dataCut: censor.dataCut,
        strata: p.strata, referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, logRank: p.grouped,
      }),
    )}`,
  );
  const limits = survivalLimitations(an, listSystem, spec);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of SURVIVAL_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(`-- SAS-PRIMARY: the log-rank P-VALUE is NULL here BY CONTRACT - a chi-square`);
  L.push(`-- tail probability needs a distribution function warehouse SQL does not have.`);
  L.push(`-- The STATISTIC itself is computed below, in closed form, and executed.`);

  const C: string[] = [];
  C.push(
    ...rateCoreSqlCtes(ctx, {
      wp,
      codeListId: clid,
      settingEnforce: setting.enforce,
      washoutDescription: describeWindow(an.washout),
      washoutPredicate: washoutPred,
      needDemo: false,
    }),
  );
  C.push(`s0 AS (   -- censoring: ${censor.applied.join(" / ")}${censor.dataCut ? ` / data cut ${censor.dataCut}` : ``}`);
  C.push(`  SELECT c.enrolid, c.index_date, ${adminCensor} AS admin_censor, f.fu_date${p.grouped ? `, ${armExpr} AS arm` : ``}`);
  C.push(`  FROM atrisk c`);
  if (p.grouped) {
    C.push(`  JOIN ${wp}_cohort ch ON ch.enrolid = c.enrolid`);
    if (viaNdc) {
      C.push(`  JOIN ${wp}_ndc_lookup nl`);
      C.push(`    ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = ch.index_code`);
    }
  }
  C.push(`  JOIN ${wp}_enroll_episodes ep`);
  C.push(`    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end`);
  C.push(`  LEFT JOIN first_fu f ON f.enrolid = c.enrolid`);
  C.push(`),`);
  C.push(`subj AS (   -- ONE row per at-risk subject: follow-up time and event flag`);
  C.push(`  SELECT enrolid,`);
  C.push(`         -- time runs from each subject's OWN index date to the earliest of`);
  C.push(`         -- the endpoint and the administrative censor`);
  C.push(`         ${d.daysBetween(`LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor)`, "index_date")} AS t,`);
  C.push(`         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN 1 ELSE 0 END AS ev${p.grouped ? `,` : ``}`);
  if (p.grouped) {
    C.push(`         arm,`);
    C.push(`         CASE WHEN arm = '${q(p.exposedLevel as string)}' THEN 1 ELSE 0 END AS exposed`);
  }
  C.push(`  FROM s0`);
  if (p.grouped) C.push(`  WHERE arm IN ('${q(p.referenceLevel as string)}', '${q(p.exposedLevel as string)}')`);
  C.push(`),`);
  C.push(`survs AS (   -- the SAME subjects, once per curve they belong to`);
  C.push(`  SELECT enrolid, t, ev, CAST('Overall' AS VARCHAR) AS stratum FROM subj`);
  if (p.grouped) {
    C.push(`  UNION ALL`);
    C.push(`  SELECT enrolid, t, ev, CAST(arm AS VARCHAR) FROM subj`);
  }
  C.push(`),`);
  C.push(...kmSqlCtes({ subjectsCte: "survs" }));
  C.push(...kmHorizonSqlCtes({ subjectsCte: "survs", kmCte: "km", horizons: an.horizonDays }));
  C.push(...kmMedianSqlCtes({ subjectsCte: "survs", kmCte: "km", horizons: an.horizonDays }));
  if (p.grouped) C.push(...logRankSqlCtes({ subjectsCte: "subj" }));
  /* EVERY POINT THAT GETS AN INTERVAL, in one place.
   *
   * A life-table row and a horizon row are the same statistic at different
   * times, so the interval arithmetic is written ONCE over their union instead
   * of once per row shape. That is not only less code: the z constant then
   * appears a fixed number of times no matter which row shapes a spec asked
   * for, which is what lets verify/fingerprint.ts pin its occurrence count and
   * catch a single mistyped 1.96 (see EXPECTED_CONSTANTS). Two copies of the
   * same formula make that count depend on spec options, and a count that
   * moves legitimately is a count nobody can pin. */
  C.push(`pts0 AS (`);
  C.push(`  SELECT CAST('life_table' AS VARCHAR) AS component, stratum,`);
  C.push(`         t AS time_days, n_risk, n_event, n_censor, surv, gw`);
  C.push(`  FROM km`);
  C.push(`  UNION ALL`);
  C.push(`  SELECT CAST('horizon' AS VARCHAR), stratum,`);
  C.push(`         horizon, n_risk_at, CAST(NULL AS BIGINT), CAST(NULL AS BIGINT), surv, gw`);
  C.push(`  FROM hz`);
  C.push(`),`);
  C.push(`pts AS (`);
  C.push(`  SELECT component, stratum, time_days, n_risk, n_event, n_censor, surv,`);
  C.push(`         ${kmSeSql()} AS se,`);
  C.push(`         ${kmCiSql(an.ciMethod).low} AS ci_low,`);
  C.push(`         ${kmCiSql(an.ciMethod).high} AS ci_high`);
  C.push(`  FROM pts0`);
  C.push(`),`);

  // the last CTE keeps a trailing comma from its builder; the final SELECT follows
  C[C.length - 1] = C[C.length - 1].replace(/,\s*$/, "");

  L.push(d.createTableAs(out));
  L.push(...C);

  const NUM = (e: string) => `CAST(${e} AS NUMERIC)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;
  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const NULLN = `CAST(NULL AS NUMERIC)`;
  const NULLI = `CAST(NULL AS INT)`;

  L.push(`SELECT '${MEASURE}' AS measure, component, stratum, statistic, ord, time_days,`);
  L.push(`       n_risk, n_event, n_censor, estimate, se, ci_low, ci_high, method`);
  L.push(`FROM (`);

  const parts: string[][] = [];

  if (an.emitLifeTable) {
    /* THE LIFE TABLE IS THE MOST DISCLOSIVE TABLE THIS PROJECT EMITS. Nearly
     * every row has n_event = 1, and a row that says "one event, at day 200" is
     * one patient's event date. It exists behind an explicit spec opt-in, and
     * the suppression pass masks it wholesale at any realistic threshold — see
     * SUPPRESSION_SHAPES.survival. The horizon rows below are the releasable
     * form of the same curve. */
    parts.push([
      `  SELECT ${STR(`component`)} AS component, ${STR(`stratum`)} AS stratum,`,
      `         ${STR(`'survival'`)} AS statistic, ${INT(`${ORD_LIFE} + time_days`)} AS ord,`,
      `         ${INT(`time_days`)} AS time_days, ${INT(`n_risk`)} AS n_risk,`,
      `         ${INT(`n_event`)} AS n_event, ${INT(`n_censor`)} AS n_censor,`,
      `         ${d.roundN(`surv`, 5)} AS estimate, ${d.roundN(`se`, 5)} AS se,`,
      `         ${d.roundN(`ci_low`, 5)} AS ci_low, ${d.roundN(`ci_high`, 5)} AS ci_high,`,
      `         ${STR(`'km_${an.ciMethod}'`)} AS method`,
      `  FROM pts WHERE component = 'life_table'`,
    ]);
  }

  /* S(t) at the requested horizons. This is the row shape a report actually
   * carries, and unlike the life table it survives disclosure control, because
   * n_risk at a horizon is a group and not an individual. */
  parts.push([
    `  SELECT ${STR(`component`)}, ${STR(`stratum`)}, ${STR(`'survival'`)},`,
    `         ${INT(`${ORD_HORIZON} + time_days`)}, ${INT(`time_days`)}, ${INT(`n_risk`)},`,
    `         ${NULLI}, ${NULLI},`,
    `         ${d.roundN(`surv`, 5)}, ${d.roundN(`se`, 5)},`,
    `         ${d.roundN(`ci_low`, 5)}, ${d.roundN(`ci_high`, 5)},`,
    `         ${STR(`'km_${an.ciMethod}'`)}`,
    `  FROM pts WHERE component = 'horizon'`,
  ]);

  /* A NULL median is a RESULT. "More than half were still event-free when
   * follow-up ended" is the finding; omitting the row would read as a
   * computation that failed. */
  parts.push([
    `  SELECT ${STR(`'median'`)}, ${STR(`stratum`)}, ${STR(`'median_survival_days'`)},`,
    `         ${INT(String(ORD_MEDIAN))}, ${INT(`median_days`)}, ${NULLI}, ${NULLI}, ${NULLI},`,
    `         ${NUM(`median_days`)}, ${NULLN}, ${NULLN}, ${NULLN},`,
    `         ${STR(
      `CASE WHEN median_days IS NULL` +
        ` THEN 'NOT REACHED: survival never fell to one half, so more than half of this group was still event-free when follow-up ended'` +
        ` ELSE 'smallest t with S(t) <= 0.5 (tolerance ${MEDIAN_EPS}); no interval is emitted - Brookmeyer-Crowley is not built' END`,
    )}`,
    `  FROM med`,
  ]);

  if (p.grouped) {
    const comp = q(p.comparison as string);
    const chi = `POWER(o_exp - e_exp, 2) / NULLIF(v_exp, 0)`;
    const lrRow = (ord: number, stat: string, est: string, method: string) => [
      `  SELECT ${STR(`'logrank'`)}, ${STR(`'${comp}'`)}, ${STR(`'${stat}'`)},`,
      `         ${INT(String(ord))}, ${NULLI}, ${NULLI}, ${NULLI}, ${NULLI},`,
      `         ${est}, ${NULLN}, ${NULLN}, ${NULLN},`,
      `         ${STR(method)}`,
      `  FROM lrsum`,
    ];
    /* O, E and V are emitted, not just the statistic they combine into. The
     * log-rank is one number built from three, and a reviewer who can see the
     * three can tell an arm with more events than expected from an arm with
     * fewer — which is the direction of the effect, and is invisible once they
     * are squared together. */
    parts.push(lrRow(ORD_LOGRANK + 0, "observed_exposed", NUM(`o_exp`), `'events observed in ${sq(p.exposedLevel as string)}'`));
    parts.push(lrRow(ORD_LOGRANK + 1, "expected_exposed", d.roundN(`e_exp`, 5), `'hypergeometric expectation given the margins at each event time'`));
    parts.push(lrRow(ORD_LOGRANK + 2, "variance", d.roundN(`v_exp`, 5), `'sum of d(n-d)n1n0 / (n^2 (n-1)); the (n-d)/(n-1) factor is the TIE correction'`));
    parts.push(lrRow(ORD_LOGRANK + 3, "chi_square", d.roundN(chi, 5), `'closed_form_mantel (1 df) - EXECUTED in both twins'`));
    /* THE P-VALUE: the one SAS-primary column in this module. */
    parts.push(lrRow(ORD_LOGRANK + 4, "p_value", NULLN, `'sas_proc_lifetest - a chi-square tail probability needs a CDF warehouse SQL does not have'`));
    /* THE DECISION, without a p-value. For 1 df the 95% critical value is z^2,
     * which this repo already pins as 3.8416 for the Wilson interval — so a
     * decision at alpha = 0.05 needs a comparison against a constant and no
     * CDF at all. The caveat is emitted with it rather than left to be found. */
    parts.push([
      `  SELECT ${STR(`'logrank'`)}, ${STR(`'${comp}'`)}, ${STR(`'reject_at_0.05'`)},`,
      `         ${INT(String(ORD_LOGRANK + 5))}, ${NULLI}, ${NULLI}, ${NULLI}, ${NULLI},`,
      `         ${NUM(`CASE WHEN v_exp IS NULL OR v_exp = 0 THEN NULL WHEN ${chi} > ${CHI2_CRIT_95_DF1} THEN 1 ELSE 0 END`)},`,
      `         ${NULLN}, ${NULLN}, ${NULLN},`,
      `         ${STR(
        `CASE WHEN v_exp IS NULL OR v_exp = 0` +
          ` THEN 'NOT CHECKABLE: no event times, so the log-rank statistic is undefined'` +
          ` ELSE 'chi-square(1) vs ${CHI2_CRIT_95_DF1} = z^2 at the repo-wide z = 1.96. The exact quantile is ${CHI2_CRIT_95_DF1_EXACT}, so a statistic between the two would be called significant here and not by SAS' END`,
      )}`,
      `  FROM lrsum`,
    ]);
    /* THE ONE-STEP HAZARD RATIO. exp((O-E)/V) is the first Newton step from
     * beta = 0 toward the Cox partial-likelihood MLE, so it is closed form and
     * executable where the MLE is not. It is labeled peto_one_step and NOT
     * "hazard ratio" without qualification: it is biased away from the null
     * when the true ratio is far from 1 or the arms are unbalanced, and when
     * the Cox module lands its fitted estimate is the reportable one. */
    const lhr = `(o_exp - e_exp) / NULLIF(v_exp, 0)`;
    const sehr = `1.0 / SQRT(NULLIF(v_exp, 0))`;
    parts.push([
      `  SELECT ${STR(`'hazard_ratio'`)}, ${STR(`'${comp}'`)}, ${STR(`'hazard_ratio_peto'`)},`,
      `         ${INT(String(ORD_HR))}, ${NULLI}, ${NULLI}, ${NULLI}, ${NULLI},`,
      `         ${d.roundN(`EXP(${lhr})`, 5)}, ${d.roundN(sehr, 5)},`,
      `         ${d.roundN(`EXP(${lhr} - 1.96 * (${sehr}))`, 5)},`,
      `         ${d.roundN(`EXP(${lhr} + 1.96 * (${sehr}))`, 5)},`,
      `         ${STR(`'peto_one_step: exp((O-E)/V), the first Newton step toward the Cox MLE. Biased away from the null at large effects or unbalanced arms; the fitted Cox estimate is the reportable one'`)}`,
      `  FROM lrsum`,
    ]);
  }

  parts.forEach((rows, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rows);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord, stratum;`);
  L.push("");
  L.push(`-- REVIEW: survival at ${an.horizonDays.join("/")} days, median, and the log-rank`);
  L.push(`-- statistic. The p-value column is NULL by contract; the SAS twin fills it.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY ord, stratum;`);

  return {
    slug: `km${suffix}`,
    title: `Survival${suffix ? ` (${an.label})` : ""}`,
    subtitle: `Kaplan-Meier + ${an.ciMethod} CI, median${p.grouped ? ", log-rank" : ""} (only the p-value is SAS-primary)`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); endpoint code list "${clid}".`,
      `Horizons: ${an.horizonDays.join(", ")} days.${p.grouped ? ` Log-rank ${p.comparison}.` : ""}`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasSurvival(ctx: SasCtx, an: SurvivalAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_km${suffix}`);
  const cohT = ctx.finalCohort;
  const od = survivalOutcome(an);
  const p = plan(ctx, an);
  const label = an.label.replace(/"/g, "'");

  if (!od) {
    return {
      path: `sas/${num}_km${suffix}.sas`,
      language: "sas",
      title: `${num} Survival (not emitted)`,
      content: [
        ...header(spec, `${num}_km${suffix}.sas`, [
          `NOT EMITTED: this analysis declares a MORTALITY endpoint, which is refused.`,
          `MarketScan's only native death signal is DSTATUS: in-hospital death only,`,
          `masked from data year 2016. See specReadiness("survival").`,
        ]),
        ``,
      ].join("\n"),
    };
  }

  const evT = ctx.evOf(od.codeListId);
  const epiT = ctx.tbl("050_epi");
  const listSystem = findCodeList(spec, od.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(od, listSystem);
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` :
    setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
  const washLines = [...(sasSettingCond ? [sasSettingCond] : []), ...sasWindowConds(an.washout, "e")];

  const censorS = censorPlan(spec, an.personTimeRule);
  const adminExpr = renderCensorSas(censorS);
  const limits = survivalLimitations(an, listSystem, spec);

  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const conftype = an.ciMethod === "linear" ? "linear" : "loglog";

  const lines: string[] = [
    ...header(spec, `${num}_km${suffix}.sas`, [
      `Kaplan-Meier survival for "${an.label}".`,
      `Nearly everything here is computed in BOTH twins: the product-limit`,
      `estimator, Greenwood's variance, the ${an.ciMethod} interval, the median`,
      `${p.grouped ? `and the log-rank statistic ` : ``}are all closed form. The p-value is the ONLY`,
      `SAS-primary column - a chi-square tail probability needs a CDF.`,
      `ANCHOR: PROC LIFETEST is run BESIDE the closed form and compared to it,`,
      `row by row, with a PASS/FAIL printed. The procedure is checked, not trusted.`,
      `Twin of the SQL km program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp(
      "survival",
      survivalParity(an, {
        settingFilter: setting.stamped, censorTerms: censorS.applied, dataCut: censorS.dataCut,
        strata: p.strata, referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, logRank: p.grouped,
      }),
    )} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...SURVIVAL_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- prevalent-case washout -> at risk ---------------------*/`,
    `/* washout window: ${cmt(describeWin(an.washout))} */`,
    `proc sql;`,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join ${evT} as e`,
    `    on e.enrolid = a.enrolid`,
    `  where 1 = 1`,
    ...washLines.map((l, idx) => `    ${l}${idx === washLines.length - 1 ? ";" : ""}`),
    ...(washLines.length === 0 ? [`  ;`] : []),
    ``,
    `  create table work._${num}_atrisk as`,
    `  select a.*`,
    `  from ${cohT} as a`,
    `  where a.enrolid not in (select enrolid from work._${num}_prev);`,
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_atrisk`, "at-risk cohort"),
    ``,
    `/*-------------------- first endpoint strictly after index -------------------*/`,
    `proc sql;`,
    `  create table work._${num}_first_fu as`,
    `  select a.enrolid, min(e.svcdate) as fu_date format=date9.`,
    `  from work._${num}_atrisk as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    `    and e.svcdate > a.index_date`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  group by a.enrolid;`,
    `quit;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Follow-up time. The administrative censor is the SAME plan the incidence`,
    `  twins render (rate-core.censorPlan), earliest of:`,
    ...censorS.terms.map((t) => `    - ${cmt(t.kind === "disenrollment" ? "disenrollment (episode end)" : t.kind === "study_end" ? `study end ${t.date}` : t.kind === "max_followup" ? `index + ${t.days} days` : `data cut ${t.date}`)}`),
    `  and time then stops at the earliest of that and the endpoint itself.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_s0 as`,
    `  select a.enrolid, a.index_date,`,
    `         ${adminExpr} as admin_censor format=date9.,`,
    `         b.fu_date${p.grouped ? `,` : ``}`,
    ...(p.grouped
      ? viaNdcS
        ? [`         n.pattern as arm length=40`]
        : [`         a.index_code as arm length=40`]
      : []),
    `  from work._${num}_atrisk as a`,
    ...(p.grouped && viaNdcS
      ? [`  left join ${ndcT} as n`, `    on n.ndcnum = a.index_code`]
      : []),
    `  inner join ${epiT} as ep`,
    `    on  ep.enrolid = a.enrolid`,
    `    and a.index_date between ep.dtstart and ep.dtend`,
    `  left join work._${num}_first_fu as b`,
    `    on b.enrolid = a.enrolid;`,
    `quit;`,
    ``,
    `data work._${num}_subj;`,
    `  set work._${num}_s0;`,
    `  /* time from each subject's OWN index date to the earliest of the endpoint`,
    `     and the administrative censor */`,
    `  ev = (fu_date ne . and fu_date <= admin_censor);`,
    `  t  = min(coalesce(fu_date, '31DEC9999'd), admin_censor) - index_date;`,
    ...(p.grouped
      ? [`  exposed = (arm = "${sq(p.exposedLevel as string)}");`,
         `  if arm not in ("${sq(p.referenceLevel as string)}", "${sq(p.exposedLevel as string)}") then delete;`]
      : []),
    `  keep enrolid t ev${p.grouped ? " arm exposed" : ""};`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "subjects with follow-up time", [`sum(ev) as events`, `sum(t) as person_days`]),
    ``,
    `/*-------------------- one row per curve the subject belongs to --------------*/`,
    `data work._${num}_survs;`,
    `  set work._${num}_subj;`,
    `  length stratum $40;`,
    `  stratum = 'Overall'; output;`,
    ...(p.grouped ? [`  stratum = arm; output;`] : []),
    `  keep enrolid t ev stratum;`,
    `run;`,
    ``,
    ...kmSasLifeTableSteps({ num, survsT: `work._${num}_survs` }),
    ``,
    ...kmSasLifetestAnchor({ num, subjT: `work._${num}_subj`, conftype }),
    ``,
    `/*-------------------- S(t) at the requested horizons ------------------------*/`,
    `data work._${num}_hzn;`,
    `  length horizon 8;`,
    ...an.horizonDays.map((h) => `  horizon = ${h}; output;`),
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_strata as`,
    `  select distinct stratum from work._${num}_survs;`,
    ``,
    `  /* the last life-table row at or before each horizon; a horizon before the`,
    `     first event has no such row, and survival there is 1 - not missing */`,
    `  create table work._${num}_hz as`,
    `  select st.stratum, h.horizon,`,
    `         coalesce((select k.surv from work._${num}_km as k`,
    `                   where k.stratum = st.stratum and k.t <= h.horizon`,
    `                   having k.t = max(k.t)), 1) as surv,`,
    `         (select k.gw from work._${num}_km as k`,
    `           where k.stratum = st.stratum and k.t <= h.horizon`,
    `           having k.t = max(k.t)) as gw,`,
    `         (select count(*) from work._${num}_survs as sv`,
    `           where sv.stratum = st.stratum and sv.t >= h.horizon) as n_risk_at`,
    `  from work._${num}_strata as st, work._${num}_hzn as h;`,
    `quit;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  EVERY POINT THAT GETS AN INTERVAL, in one place. A life-table row and a`,
    `  horizon row are the same statistic at different times, so the interval is`,
    `  written ONCE over their union - matching the SQL twin's pts CTE, and`,
    `  keeping the z constant's occurrence count independent of spec options.`,
    `----------------------------------------------------------------------------*/`,
    `data work._${num}_pts;`,
    `  length component $12;`,
    `  set work._${num}_km (in=_a keep=stratum t n_risk n_event n_censor surv gw)`,
    `      work._${num}_hz (in=_b keep=stratum horizon surv gw n_risk_at);`,
    `  if _a then do; component = 'life_table'; time_days = t; end;`,
    `  else do;`,
    `    component = 'horizon'; time_days = horizon;`,
    `    n_risk = n_risk_at; n_event = .; n_censor = .;`,
    `  end;`,
    ...kmSasCiLines(an.ciMethod),
    `  keep component stratum time_days n_risk n_event n_censor surv se ci_low ci_high;`,
    `run;`,
    ``,
    `/*-------------------- median survival ---------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_med as`,
    `  select st.stratum,`,
    `         (select min(k.t) from work._${num}_km as k`,
    `           where k.stratum = st.stratum and k.surv <= 0.5 + ${MEDIAN_EPS}) as median_days`,
    `  from work._${num}_strata as st;`,
    `quit;`,
    ``,
  );

  if (p.grouped) {
    lines.push(
      `/*----------------------------------------------------------------------------`,
      `  LOG-RANK. The statistic is CLOSED FORM and computed here as well as in the`,
      `  SQL twin: at each event time E = d*n1/n and V = d(n-d)n1n0 / (n^2 (n-1)),`,
      `  where (n-d)/(n-1) is the tie correction. Only the P-VALUE needs PROC`,
      `  LIFETEST, because only it needs a chi-square distribution function.`,
      `----------------------------------------------------------------------------*/`,
      `proc sql;`,
      `  create table work._${num}_lr as`,
      `  select e.t,`,
      `         sum(case when s.t >= e.t then 1 else 0 end) as n,`,
      `         sum(case when s.t >= e.t and s.exposed = 1 then 1 else 0 end) as n1,`,
      `         sum(case when s.t = e.t and s.ev = 1 then 1 else 0 end) as d,`,
      `         sum(case when s.t = e.t and s.ev = 1 and s.exposed = 1 then 1 else 0 end) as d1`,
      `  from (select distinct t from work._${num}_subj where ev = 1) as e,`,
      `       work._${num}_subj as s`,
      `  group by e.t;`,
      `quit;`,
      ``,
      `/* PROC SQL rather than a DATA step ON PURPOSE. A retain-and-output DATA`,
      `   step emits NOTHING when its input is empty, so a curve with no events`,
      `   would produce no log-rank rows here while the SQL twin produced a full`,
      `   set of NULLs - a shape divergence between the twins that only appears`,
      `   on the one input built to test it. An SQL aggregate with no GROUP BY`,
      `   returns one row of missings, which is what the SQL twin does. */`,
      `proc sql;`,
      `  create table work._${num}_lrsum as`,
      `  select sum(d1) as o_exp,`,
      `         sum(d * n1 / n) as e_exp,`,
      `         sum(case when n > 1 then d * (n - d) * n1 * (n - n1) / (n * n * (n - 1))`,
      `                  else 0 end) as v_exp,`,
      `         count(*) as n_event_times`,
      `  from work._${num}_lr;`,
      `quit;`,
      ``,
      `/* the P-VALUE - the one column the SQL twin cannot produce */`,
      `ods output HomTests = work._${num}_hom;`,
      `proc lifetest data=work._${num}_subj method=km notable;`,
      `  time t*ev(0);`,
      `  strata exposed / test=logrank;`,
      `run;`,
      ``,
      `title "Log-rank: ${label}";`,
      `proc print data=work._${num}_hom noobs;`,
      `run;`,
      `title;`,
      ``,
    );
  }

  /* Assemble. One table, five row shapes, discriminated by `component` — the
   * same layout the SQL twin builds, so the two can be compared row for row. */
  const emptyNums = `  n_risk=.; n_event=.; n_censor=.; se=.; ci_low=.; ci_high=.;`;
  lines.push(
    `/*-------------------- assemble the result table -----------------------------*/`,
    `data work._${num}_rows;`,
    `  length measure $20 component $12 stratum $40 statistic $24 method $220;`,
    `  measure = "${MEASURE}";`,
    ...(an.emitLifeTable
      ? [
          `  /* THE LIFE TABLE IS THE MOST DISCLOSIVE TABLE HERE: most rows carry`,
          `     n_event = 1, which is one patient's event date. It is emitted only`,
          `     because the spec asked for it, and the suppression pass masks it`,
          `     wholesale at any realistic threshold. */`,
          `  do until (_e1);`,
          `    set work._${num}_pts (where=(component = 'life_table')) end=_e1;`,
          `    statistic = 'survival';`,
          `    ord = ${ORD_LIFE} + time_days;`,
          `    estimate = round(surv, 0.00001);`,
          `    se = round(se, 0.00001);`,
          `    ci_low = round(ci_low, 0.00001); ci_high = round(ci_high, 0.00001);`,
          `    method = 'km_${an.ciMethod}';`,
          `    output;`,
          `  end;`,
        ]
      : []),
    `  do until (_e2);`,
    `    set work._${num}_pts (where=(component = 'horizon')) end=_e2;`,
    `    statistic = 'survival';`,
    `    ord = ${ORD_HORIZON} + time_days;`,
    `    estimate = round(surv, 0.00001);`,
    `    se = round(se, 0.00001);`,
    `    ci_low = round(ci_low, 0.00001); ci_high = round(ci_high, 0.00001);`,
    `    method = 'km_${an.ciMethod}';`,
    `    output;`,
    `  end;`,
    `  do until (_e3);`,
    `    set work._${num}_med end=_e3;`,
    `    component = 'median'; statistic = 'median_survival_days';`,
    `    ord = ${ORD_MEDIAN}; time_days = median_days;`,
    emptyNums,
    `    estimate = median_days;`,
    `    /* a NULL median is a RESULT, not a gap */`,
    `    if median_days = . then method = 'NOT REACHED: survival never fell to one half, so more than half of this group was still event-free when follow-up ended';`,
    `    else method = 'smallest t with S(t) <= 0.5 (tolerance ${MEDIAN_EPS}); no interval is emitted - Brookmeyer-Crowley is not built';`,
    `    output;`,
    `  end;`,
  );
  if (p.grouped) {
    const comp = sq(p.comparison as string);
    lines.push(
      `  set work._${num}_lrsum;`,
      `  stratum = "${comp}"; component = 'logrank';`,
      emptyNums,
      `  time_days = .;`,
      `  if v_exp > 0 then _chi = (o_exp - e_exp)**2 / v_exp; else _chi = .;`,
      `  statistic = 'observed_exposed'; ord = ${ORD_LOGRANK}; estimate = o_exp;`,
      `  method = 'events observed in ${sq(p.exposedLevel as string)}'; output;`,
      `  statistic = 'expected_exposed'; ord = ${ORD_LOGRANK + 1}; estimate = round(e_exp, 0.00001);`,
      `  method = 'hypergeometric expectation given the margins at each event time'; output;`,
      `  statistic = 'variance'; ord = ${ORD_LOGRANK + 2}; estimate = round(v_exp, 0.00001);`,
      `  method = 'sum of d(n-d)n1n0 / (n^2 (n-1)); the (n-d)/(n-1) factor is the TIE correction'; output;`,
      `  statistic = 'chi_square'; ord = ${ORD_LOGRANK + 3}; estimate = round(_chi, 0.00001);`,
      `  method = 'closed_form_mantel (1 df) - EXECUTED in both twins'; output;`,
      `  /* the ONE SAS-primary column. PROC LIFETEST computed it above; it is left`,
      `     missing HERE so the assembled table has the same shape as the SQL twin's,`,
      `     and the value is printed from work._${num}_hom instead. */`,
      `  statistic = 'p_value'; ord = ${ORD_LOGRANK + 4}; estimate = .;`,
      `  method = 'sas_proc_lifetest - a chi-square tail probability needs a CDF warehouse SQL does not have'; output;`,
      `  statistic = 'reject_at_0.05'; ord = ${ORD_LOGRANK + 5};`,
      `  if _chi = . then do;`,
      `    estimate = .;`,
      `    method = 'NOT CHECKABLE: no event times, so the log-rank statistic is undefined';`,
      `  end;`,
      `  else do;`,
      `    estimate = (_chi > ${CHI2_CRIT_95_DF1});`,
      `    method = 'chi-square(1) vs ${CHI2_CRIT_95_DF1} = z^2 at the repo-wide z = 1.96. The exact quantile is ${CHI2_CRIT_95_DF1_EXACT}, so a statistic between the two would be called significant here and not by SAS';`,
      `  end;`,
      `  output;`,
      `  /* peto one-step: exp((O-E)/V) is the first Newton step toward the Cox MLE,`,
      `     so it is closed form where the MLE is not. Labeled, because it is biased`,
      `     away from the null at large effects or unbalanced arms. */`,
      `  component = 'hazard_ratio'; statistic = 'hazard_ratio_peto'; ord = ${ORD_HR};`,
      `  if v_exp > 0 then do;`,
      `    _lhr = (o_exp - e_exp) / v_exp;`,
      `    _se  = 1 / sqrt(v_exp);`,
      `    estimate = round(exp(_lhr), 0.00001);`,
      `    se       = round(_se, 0.00001);`,
      `    ci_low   = round(exp(_lhr - 1.96 * _se), 0.00001);`,
      `    ci_high  = round(exp(_lhr + 1.96 * _se), 0.00001);`,
      `  end;`,
      `  else do; estimate = .; se = .; ci_low = .; ci_high = .; end;`,
      `  method = 'peto_one_step: exp((O-E)/V), the first Newton step toward the Cox MLE. Biased away from the null at large effects or unbalanced arms; the fitted Cox estimate is the reportable one';`,
      `  output;`,
    );
  }
  lines.push(
    `  keep measure component stratum statistic ord time_days n_risk n_event n_censor`,
    `       estimate se ci_low ci_high method;`,
    `run;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_rows;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by ord stratum;`,
    `run;`,
    ``,
    `title "Survival: ${label}";`,
    `proc print data=${outT} noobs;`,
    `run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_km${suffix}.sas`,
    language: "sas",
    title: `${num} Survival${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const survivalModule: AnalysisModule<SurvivalAnalysis> = {
  analysisKind: "survival",
  stampKind: "survival",
  resultSlug: "km",
  sql: sqlSurvival,
  sas: sasSurvival,
};
