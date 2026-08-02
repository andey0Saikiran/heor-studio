/**
 * Fine-Gray subdistribution hazard model.
 *
 * A CORRECTION FIRST. Wave 6.3 filed this beside Gray's test under "refused,
 * not approximated", saying it needed Newton "plus the usual reason". Half
 * right. Gray's test is refused because it is a different and more intricate
 * statistic where a close-enough version would be a mislabeled test. Fine-Gray
 * is not that: it has exactly the Cox structure, so it takes exactly the Cox
 * carve-out — beta is SAS-primary and everything around it is closed form.
 * Lumping a buildable model in with an unbuildable statistic was the error.
 *
 * WHAT DIFFERS FROM COX, and it is one rule: a subject who fails from a
 * COMPETING cause STAYS in the risk set, weighted by G(t)/G(t_j) with G the
 * Kaplan-Meier of the censoring distribution. That is what makes the
 * coefficient an effect on the CUMULATIVE INCIDENCE rather than on the rate
 * among survivors.
 *
 * EXECUTED IN BOTH TWINS: G, every weight, the modified risk set beside the
 * cause-specific one, the null partial log-likelihood, the score, the
 * information, the score test and the one-step estimator.
 *
 * THREE SELF-CHECKS on PROC PHREG. Two are the Cox ones. The third is specific
 * and is the one this model most needs: WITHOUT `eventcode=` on the MODEL
 * statement, PHREG fits a cause-specific Cox model — it runs cleanly, converges,
 * prints a hazard ratio, and answers a different question. The program compares
 * its own two risk-set totals and says so when they are indistinguishable.
 *
 * Verified vs Gold Case A: the competing cause never occurs, so this must
 * reduce to Cox IDENTICALLY — U = -31/42, I = 1265/1764, logL(0) = -5.8171112,
 * score chi-square 0.75968, one-step HR 0.35728, every one of them the number
 * the Cox module produces. Verified vs Gold Case D: the modified risk set is 5
 * at the second event time where the cause-specific one is 4, and every cause-1
 * event is in one arm so the estimate is INFINITE and the closed forms return
 * NULL. Verified vs Gold Case E: G drops to 2/3 at day 300, so the
 * competing-event subject enters the day-400 risk set at weight 2/3 and the
 * weighted denominator is 8/3 rather than 3.
 */
import type { FineGrayAnalysis, OutcomeDefinition } from "../../spec/types";
import { findCodeList, survivalOutcome } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import { cmt, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import { censorPlan, renderCensorSql, renderCensorSas } from "../rate-core";
import { CHI2_CRIT_95_DF1, CHI2_CRIT_95_DF1_EXACT } from "../km-core";
import { fineGraySqlCtes, fineGraySasSteps, fineGraySasSelfChecks, FG_PROPORTION_EPS } from "../finegray-core";
import {
  balanceCovariates,
  outcomeSettingPlan,
  parityStamp,
  fineGrayLimitations,
  fineGrayParity,
  stratLabel,
  FINE_GRAY_METHOD_NOTES,
  type BalanceCovariate,
} from "../parity";

const MEASURE = "fine_gray";
const ORD_DESIGN = 0;
const ORD_SCORE = 10;
const ORD_ONESTEP = 20;
const ORD_ANCHOR = 30;
const ORD_ADJUSTED = 40;

function plan(ctx: SqlCtx | SasCtx, an: FineGrayAnalysis) {
  const spec = ctx.spec;
  const gv = spec.groupVars.find((g) => g.id === an.groupVarId);
  const referenceLevel = gv?.referenceLevel ?? gv?.levels[0] ?? "";
  const exposedLevel = gv?.levels.find((l) => l !== referenceLevel) ?? "";
  const { supported, unsupported } = balanceCovariates(
    spec.baseline,
    an.covariateIds,
    new Set(spec.analyses.filter((x) => x.kind === "comorbidity_index" && x.enabled).map((x) => x.id)),
  );
  const od = survivalOutcome(an);
  const causes: Array<{ code: number; od: OutcomeDefinition }> = [];
  if (od) causes.push({ code: 1, od });
  an.competingEvents.forEach((ce, i) => causes.push({ code: 2 + i, od: ce.outcomeDefinition }));
  return {
    gv, referenceLevel, exposedLevel, causes,
    covariates: supported,
    droppedCovs: unsupported.map((u) => u.id),
    emittable: Boolean(gv && referenceLevel && exposedLevel && od),
    comparison: `${exposedLevel} vs ${referenceLevel}`,
  };
}

function terms(p: { covariates: BalanceCovariate[] }, gvLabel: string): string[] {
  return [stratLabel(gvLabel), ...p.covariates.map((c) => stratLabel(c.label))];
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlFineGray(ctx: SqlCtx, an: FineGrayAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_fgray${suffix}`;
  const od = survivalOutcome(an);
  const p = plan(ctx, an);
  const L: string[] = [];

  if (!od || !p.emittable) {
    L.push(`-- NOT EMITTED: ${!od ? `the event of interest is a MORTALITY endpoint, which is refused (DSTATUS is in-hospital only and masked from 2016).` : `the exposure variable did not resolve to two levels.`}`);
    return {
      slug: `fgray${suffix}`, title: `Fine-Gray${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted", extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`], body: L.join("\n"),
    };
  }

  const clid = od.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(od, listSystem);
  const censor = censorPlan(spec, an.personTimeRule);
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `ch.index_code`;

  L.push(`-- ${parityStamp("fine_gray", fineGrayParity(an, {
    censorTerms: censor.applied, dataCut: censor.dataCut, settingFilter: setting.stamped,
    referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms,
    causes: p.causes.map((c) => ({ code: c.code, codeListId: c.od.codeListId })),
  }))}`);
  const limits = fineGrayLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs, spec);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of FINE_GRAY_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(`-- SAS-PRIMARY: the fitted coefficient is NULL here BY CONTRACT - maximizing`);
  L.push(`-- a partial likelihood needs Newton-Raphson. Everything the fit is CHECKED`);
  L.push(`-- against below is closed form and executed.`);

  const C: string[] = [];
  C.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${ctx.cohortT}),`);
  p.causes.forEach((c, i) => {
    const cs = outcomeSettingPlan(c.od, findCodeList(spec, c.od.codeListId)?.system ?? "icd10cm");
    C.push(`${i === 0 ? `ev AS (` : `  UNION ALL`}`);
    C.push(`  SELECT enrolid, event_date, ${c.code} AS cause`);
    C.push(`  FROM ${wp}_events WHERE code_list_id = '${q(c.od.codeListId)}'` +
      (cs.enforce ? ` AND setting = '${cs.enforce}'` : ``));
  });
  C.push(`),`);
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  C.push(`prevalent AS (   -- washout on the EVENT OF INTEREST: ${describeWindow(an.washout)}`);
  C.push(`  SELECT DISTINCT c.enrolid`);
  C.push(`  FROM cohort c JOIN ev a ON a.enrolid = c.enrolid AND a.cause = 1`);
  C.push(`  WHERE ${wc.length > 0 ? wc.join("\n      AND ") : "TRUE"}`);
  C.push(`),`);
  C.push(`atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),`);
  C.push(`first_any AS (   -- the FIRST event of ANY cause, and which cause it was`);
  C.push(`  SELECT enrolid, event_date AS fu_date, cause FROM (`);
  C.push(`    SELECT c.enrolid, a.event_date, a.cause,`);
  C.push(`           ROW_NUMBER() OVER (PARTITION BY c.enrolid ORDER BY a.event_date, a.cause) AS rn`);
  C.push(`    FROM atrisk c JOIN ev a ON a.enrolid = c.enrolid AND a.event_date > c.index_date`);
  C.push(`  ) z WHERE rn = 1`);
  C.push(`),`);
  C.push(`s0 AS (   -- censoring: ${censor.applied.join(" / ")}${censor.dataCut ? ` / data cut ${censor.dataCut}` : ``}`);
  C.push(`  SELECT c.enrolid, c.index_date, ${renderCensorSql(ctx, censor)} AS admin_censor,`);
  C.push(`         f.fu_date, f.cause, ${armExpr} AS arm`);
  C.push(`  FROM atrisk c`);
  C.push(`  JOIN ${ctx.cohortT} ch ON ch.enrolid = c.enrolid`);
  if (viaNdc) {
    C.push(`  JOIN ${wp}_ndc_lookup nl`);
    C.push(`    ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = ch.index_code`);
  }
  C.push(`  JOIN ${wp}_enroll_episodes ep`);
  C.push(`    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end`);
  C.push(`  LEFT JOIN first_any f ON f.enrolid = c.enrolid`);
  C.push(`),`);
  C.push(`subj AS (   -- time, WHICH cause ended it (0 = censored), and the exposure`);
  C.push(`  SELECT enrolid,`);
  C.push(`         ${d.daysBetween(`LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor)`, "index_date")} AS t,`);
  C.push(`         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN cause ELSE 0 END AS cause,`);
  C.push(`         CASE WHEN arm = '${q(p.exposedLevel)}' THEN 1 ELSE 0 END AS exposed`);
  C.push(`  FROM s0`);
  C.push(`  WHERE arm IN ('${q(p.referenceLevel)}', '${q(p.exposedLevel)}')`);
  C.push(`),`);
  C.push(...fineGraySqlCtes({ subjectsCte: "subj" }));
  C[C.length - 1] = C[C.length - 1].replace(/,\s*$/, "");

  const NULLN = `CAST(NULL AS NUMERIC)`;
  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;
  const chi = `POWER(score_u0, 2) / NULLIF(information0, 0)`;

  L.push(d.createTableAs(out));
  L.push(...C);
  L.push(`SELECT '${MEASURE}' AS measure, component, term, statistic, ord,`);
  L.push(`       estimate, se, ci_low, ci_high, method`);
  L.push(`FROM (`);

  const parts: string[][] = [];
  const row = (component: string, term: string, statistic: string, ord: number, est: string, method: string, from = "fg", se = NULLN, lo = NULLN, hi = NULLN) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${q(term)}'`)} AS term,`,
    `         ${STR(`'${statistic}'`)} AS statistic, ${INT(String(ord))} AS ord,`,
    `         ${est} AS estimate, ${se} AS se, ${lo} AS ci_low, ${hi} AS ci_high, ${STR(method)} AS method`,
    `  FROM ${from}`,
  ];

  parts.push(row("design", p.comparison, "event_times", ORD_DESIGN, `CAST(n_event_times AS NUMERIC)`, `'distinct times at which the event of INTEREST occurred'`));
  parts.push(row("design", p.comparison, "events_total", ORD_DESIGN + 1, `CAST(d_total AS NUMERIC)`, `'observed'`));
  parts.push(row("design", p.comparison, "events_exposed", ORD_DESIGN + 2, `CAST(d1_exposed AS NUMERIC)`, `'observed'`));
  /* THE ROWS THAT ARE THE MODEL. The subdistribution denominator against the
   * cause-specific one: their difference is the retained competing-event
   * subjects, and if it is zero this is a Cox model wearing another name. */
  parts.push(row("design", p.comparison, "subdistribution_risk_total", ORD_DESIGN + 3, `${d.roundN(`wn_total`, 5)}`,
    `'the WEIGHTED denominator summed over event times: competing-event subjects are retained'`));
  parts.push(row("design", p.comparison, "cause_specific_risk_total", ORD_DESIGN + 4, `CAST(n_cs_total AS NUMERIC)`,
    `'what a CAUSE-SPECIFIC Cox model would use over the same event times'`));
  parts.push(row("design", p.comparison, "retained_by_subdistribution", ORD_DESIGN + 5, `${d.roundN(`wn_total - n_cs_total`, 5)}`,
    `CASE WHEN wn_total > n_cs_total + 1e-9` +
    ` THEN 'the weighted contribution of subjects who failed from a competing cause and were RETAINED. This is the entire difference between this model and a Cox model'` +
    ` ELSE 'ZERO: no competing-event subject was ever retained, so these risk sets are the cause-specific ones and this fit is a Cox model by another name' END`));

  parts.push(row("score", p.comparison, "partial_loglik_0", ORD_SCORE, `${d.roundN(`loglik0`, 5)}`,
    `'-SUM(d*ln(weighted n)) over event times. PROC PHREG prints -2 times this as its "without covariates" fit statistic'`));
  parts.push(row("score", p.comparison, "minus_2_loglik_0", ORD_SCORE + 1, `${d.roundN(`-2 * loglik0`, 5)}`,
    `'the number to compare against PHREG null -2 LOG L'`));
  parts.push(row("score", p.comparison, "score_u0", ORD_SCORE + 2, `${d.roundN(`score_u0`, 5)}`,
    `'the score at beta=0, over the SUBDISTRIBUTION risk sets. With no competing event it is exactly the log-rank numerator'`));
  parts.push(row("score", p.comparison, "information_0", ORD_SCORE + 3, `${d.roundN(`information0`, 5)}`,
    `'SUM(d*p*(1-p)) with p the WEIGHTED exposed share of the subdistribution risk set'`));
  parts.push(row("score", p.comparison, "score_chi_square", ORD_SCORE + 4, `${d.roundN(chi, 5)}`,
    `'U(0)^2 / I(0), chi-square on 1 df - EXECUTED in both twins'`));
  parts.push(row("score", p.comparison, "reject_at_0.05", ORD_SCORE + 5,
    `CAST(CASE WHEN information0 IS NULL OR information0 = 0 THEN NULL WHEN ${chi} > ${CHI2_CRIT_95_DF1} THEN 1 ELSE 0 END AS NUMERIC)`,
    `CASE WHEN information0 IS NULL OR information0 = 0` +
    ` THEN 'NOT CHECKABLE: no event times, so the score test is undefined'` +
    ` ELSE 'chi-square(1) vs ${CHI2_CRIT_95_DF1} = z^2 at the repo-wide z = 1.96. The exact quantile is ${CHI2_CRIT_95_DF1_EXACT}' END`));
  parts.push(row("score", p.comparison, "score_p_value", ORD_SCORE + 6, NULLN,
    `'sas_proc_phreg - a chi-square tail probability needs a CDF warehouse SQL does not have'`));

  const lhr = `score_u0 / NULLIF(information0, 0)`;
  const sehr = `1.0 / SQRT(NULLIF(information0, 0))`;
  /* SEPARATION GUARD on the one-step too, not only on the anchor. With every
   * event in one arm the score is at its extreme and the step is a large finite
   * number standing in for an infinite estimate — which reads as a very strong
   * effect rather than as no estimate at all. */
  const finite = `d1_exposed > 0 AND d1_exposed < d_total`;
  parts.push(row("one_step", p.comparison, "subdistribution_hr_one_step", ORD_ONESTEP,
    `CASE WHEN ${finite} THEN ${d.roundN(`EXP(${lhr})`, 5)} END`,
    `CASE WHEN ${finite}` +
    ` THEN 'exp(U(0)/I(0)): the FIRST NEWTON STEP from the null, not the maximum. The fitted estimate below is the reportable one'` +
    ` ELSE 'NOT ESTIMABLE: every event of interest is in one arm (complete separation), so the maximum likelihood estimate is INFINITE. A finite number here would be a stand-in for one' END`,
    "fg",
    `CASE WHEN ${finite} THEN ${d.roundN(sehr, 5)} END`,
    `CASE WHEN ${finite} THEN ${d.roundN(`EXP(${lhr} - 1.96 * (${sehr}))`, 5)} END`,
    `CASE WHEN ${finite} THEN ${d.roundN(`EXP(${lhr} + 1.96 * (${sehr}))`, 5)} END`));

  parts.push(row("anchor", p.comparison, "weighted_exposed_share", ORD_ANCHOR,
    `${d.roundN(`CASE WHEN ABS(p_max - p_min) < ${FG_PROPORTION_EPS} THEN p_min END`, 5)}`,
    `CASE WHEN ABS(p_max - p_min) < ${FG_PROPORTION_EPS}` +
    ` THEN 'CONSTANT across every subdistribution risk set, so the partial likelihood is binomial and its maximum is closed form'` +
    ` ELSE 'VARIES across risk sets (this is the usual case), so there is no closed-form maximum' END`));
  parts.push(row("anchor", p.comparison, "event_share_exposed", ORD_ANCHOR + 1,
    `${d.roundN(`d1_exposed * 1.0 / NULLIF(d_total, 0)`, 5)}`, `'q = the exposed share of EVENTS, the other half of the closed form'`));
  parts.push(row("anchor", p.comparison, "closed_form_subdistribution_hr", ORD_ANCHOR + 2, `${d.roundN(`closed_form_hr`, 5)}`,
    `CASE WHEN closed_form_hr IS NOT NULL` +
    ` THEN 'HR = [q/(1-q)] / [p/(1-p)] on the WEIGHTED shares - the same theorem as the Cox anchor, with weights. The SAS twin checks its fitted estimate against this'` +
    ` WHEN d1_exposed = 0 OR d1_exposed = d_total` +
    ` THEN 'NOT APPLICABLE: every event of interest is in one arm (complete separation), so the estimate is infinite and no finite number belongs here'` +
    ` ELSE 'NOT APPLICABLE: the weighted exposed share is not constant, which is the usual case. The fitted coefficient is then checkable only by U(beta_hat)=0, which the SAS twin does' END`));

  modelTerms.forEach((t, i) => {
    parts.push(row("adjusted", t, "subdistribution_hazard_ratio", ORD_ADJUSTED + i, NULLN, `'sas_proc_phreg (eventcode=1)'`));
  });

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: the subdistribution risk sets and every closed form on them. The`);
  L.push(`-- fitted coefficient itself is SAS-primary and NULL above. Check the`);
  L.push(`-- retained_by_subdistribution row first: if it is zero this is a Cox model.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `fgray${suffix}`,
    title: `Fine-Gray${suffix ? ` (${an.label})` : ""}`,
    subtitle: `subdistribution risk sets + closed forms (the fitted coefficient is SAS-primary)`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); endpoint "${clid}".`,
      `Exposure ${p.exposedLevel} vs reference ${p.referenceLevel}; adjusted terms: ${modelTerms.join(", ")}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasFineGray(ctx: SasCtx, an: FineGrayAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_fgray${suffix}`);
  const cohT = ctx.finalCohort;
  const od = survivalOutcome(an);
  const p = plan(ctx, an);
  const lbl = an.label.replace(/"/g, "'");

  if (!od || !p.emittable) {
    return {
      path: `sas/${num}_fgray${suffix}.sas`, language: "sas", title: `${num} Fine-Gray (not emitted)`,
      content: [...header(spec, `${num}_fgray${suffix}.sas`, [
        `NOT EMITTED: ${!od ? `mortality endpoint, which is refused.` : `the exposure did not resolve to two levels.`}`,
      ]), ``].join("\n"),
    };
  }

  const listSystem = findCodeList(spec, od.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(od, listSystem);
  const censorS = censorPlan(spec, an.personTimeRule);
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const limits = fineGrayLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs, spec);
  const epiT = ctx.tbl("050_epi");
  const enrT = ctx.tbl("040_enroll");
  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const sasVar = (c: BalanceCovariate) => (c.axis === "age" ? "age_val" : c.axis === "sex" ? "sex_male" : "cci_val");
  const covVars = p.covariates.filter((c) => c.axis === "age" || c.axis === "sex").map(sasVar);
  const needDemo = covVars.length > 0;
  const cmp = sq(p.comparison);

  const lines: string[] = [
    ...header(spec, `${num}_fgray${suffix}.sas`, [
      `Fine-Gray subdistribution hazard model for "${an.label}".`,
      `A subject who fails from a COMPETING cause STAYS in the risk set, weighted`,
      `by G(t)/G(t_j) with G the Kaplan-Meier of the CENSORING distribution. That`,
      `one rule is the whole difference from a Cox model, and it is what makes the`,
      `coefficient an effect on the CUMULATIVE INCIDENCE.`,
      `THREE SELF-CHECKS on PROC PHREG, none shipping a reference value: the null`,
      `-2 LOG L; U(beta_hat) = 0 on the weighted risk sets; and whether a`,
      `SUBDISTRIBUTION model was actually fitted at all - without eventcode= this`,
      `procedure fits a cause-specific Cox model, cleanly, and answers a different`,
      `question.`,
      `Twin of the SQL fgray program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("fine_gray", fineGrayParity(an, {
      censorTerms: censorS.applied, dataCut: censorS.dataCut, settingFilter: setting.stamped,
      referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms,
      causes: p.causes.map((c) => ({ code: c.code, codeListId: c.od.codeListId })),
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...FINE_GRAY_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- every cause's events, tagged ---------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_ev as`,
  );
  p.causes.forEach((c, i) => {
    const evT = ctx.evOf(c.od.codeListId);
    const cs = outcomeSettingPlan(c.od, findCodeList(spec, c.od.codeListId)?.system ?? "icd10cm");
    const cond = cs.enforce === "outpatient" ? ` and e.setting = 'OP'` : cs.enforce === "inpatient" ? ` and e.setting = 'IP'` : ``;
    lines.push(
      `${i === 0 ? "  " : "  union all\n  "}select e.enrolid, e.svcdate, ${c.code} as cause`,
      `  from ${evT} as e where 1 = 1${cond}`,
    );
  });
  const washLines = sasWindowConds(an.washout, "e");
  lines.push(
    `  ;`,
    ``,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join work._${num}_ev as e`,
    `    on e.enrolid = a.enrolid and e.cause = 1`,
    `  where 1 = 1`,
    ...washLines.map((l, i) => `    ${l}${i === washLines.length - 1 ? ";" : ""}`),
    ...(washLines.length === 0 ? [`  ;`] : []),
    ``,
    `  create table work._${num}_atrisk as`,
    `  select a.* from ${cohT} as a`,
    `  where a.enrolid not in (select enrolid from work._${num}_prev);`,
    ``,
    `  create table work._${num}_fa0 as`,
    `  select a.enrolid, e.svcdate, e.cause`,
    `  from work._${num}_atrisk as a`,
    `  inner join work._${num}_ev as e`,
    `    on e.enrolid = a.enrolid and e.svcdate > a.index_date;`,
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_atrisk`, "at-risk cohort"),
    ``,
    `proc sort data=work._${num}_fa0; by enrolid svcdate cause; run;`,
    ``,
    `data work._${num}_first_any;`,
    `  set work._${num}_fa0;`,
    `  by enrolid;`,
    `  if first.enrolid;`,
    `  rename svcdate = fu_date;`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_s0 as`,
    `  select a.enrolid, a.index_date,`,
    `         ${renderCensorSas(censorS)} as admin_censor format=date9.,`,
    `         f.fu_date, f.cause,`,
    ...(viaNdcS ? [`         n.pattern as arm length=40`] : [`         a.index_code as arm length=40`]),
    ...(needDemo ? [`         , dm.dobyr, dm.sex`] : []),
    `  from work._${num}_atrisk as a`,
    ...(viaNdcS ? [`  left join ${ndcT} as n`, `    on n.ndcnum = a.index_code`] : []),
    ...(needDemo
      ? [`  left join (select enrolid, dobyr, sex from ${enrT} group by enrolid, dobyr, sex) as dm`,
         `    on dm.enrolid = a.enrolid`]
      : []),
    `  inner join ${epiT} as ep`,
    `    on  ep.enrolid = a.enrolid`,
    `    and a.index_date between ep.dtstart and ep.dtend`,
    `  left join work._${num}_first_any as f`,
    `    on f.enrolid = a.enrolid;`,
    `quit;`,
    ``,
    `data work._${num}_subj;`,
    `  set work._${num}_s0;`,
    `  t = min(coalesce(fu_date, '31DEC9999'd), admin_censor) - index_date;`,
    `  if fu_date ne . and fu_date <= admin_censor then cause = cause;`,
    `  else cause = 0;`,
    `  exposed = (arm = "${sq(p.exposedLevel)}");`,
    ...(needDemo ? [`  age_val  = year(index_date) - dobyr;`, `  sex_male = (sex = '1');`] : []),
    `  if arm not in ("${sq(p.referenceLevel)}", "${sq(p.exposedLevel)}") then delete;`,
    `  keep enrolid t cause exposed${needDemo ? " age_val sex_male" : ""};`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "subjects in the risk set", [`sum(cause = 1) as events_of_interest`]),
    ``,
    ...fineGraySasSteps({ num, subjT: `work._${num}_subj` }),
    ``,
    `/*----------------------------------------------------------------------------`,
    `  THE FIT. eventcode=1 is what makes this a SUBDISTRIBUTION model. Without it`,
    `  PROC PHREG fits a cause-specific Cox model - cleanly, convergently, and`,
    `  answering a different question. Self-check 3 below tests for exactly that.`,
    `----------------------------------------------------------------------------*/`,
    `ods output ParameterEstimates = work._${num}_pe`,
    `           FitStatistics      = work._${num}_fit;`,
    `proc phreg data=work._${num}_subj;`,
    `  model t*cause(0) = exposed${covVars.length > 0 ? " " + covVars.join(" ") : ""} / eventcode=1 risklimits;`,
    `run;`,
    ``,
    `title "Fine-Gray subdistribution model: ${lbl}";`,
    `proc print data=work._${num}_pe noobs; run;`,
    `title;`,
    ``,
    ...fineGraySasSelfChecks({ num, peT: `work._${num}_pe`, fitT: `work._${num}_fit` }),
    ``,
    `/*-------------------- assemble the result table ------------------------------*/`,
    `data ${outT};`,
    `  set work._${num}_fg;`,
    `  length measure $20 component $10 term $40 statistic $32 method $260;`,
    `  measure = "${MEASURE}"; term = "${cmp}"; se = .; ci_low = .; ci_high = .;`,
    `  if information0 > 0 then _chi = (score_u0**2) / information0; else _chi = .;`,
    `  _finite = (d1_exposed > 0 and d1_exposed < d_total);`,
    `  component='design'; statistic='event_times'; ord=${ORD_DESIGN}; estimate=n_event_times;`,
    `  method='distinct times at which the event of INTEREST occurred'; output;`,
    `  statistic='events_total'; ord=${ORD_DESIGN + 1}; estimate=d_total; method='observed'; output;`,
    `  statistic='events_exposed'; ord=${ORD_DESIGN + 2}; estimate=d1_exposed; method='observed'; output;`,
    `  statistic='subdistribution_risk_total'; ord=${ORD_DESIGN + 3}; estimate=round(wn_total, 0.00001);`,
    `  method='the WEIGHTED denominator summed over event times: competing-event subjects are retained'; output;`,
    `  statistic='cause_specific_risk_total'; ord=${ORD_DESIGN + 4}; estimate=n_cs_total;`,
    `  method='what a CAUSE-SPECIFIC Cox model would use over the same event times'; output;`,
    `  statistic='retained_by_subdistribution'; ord=${ORD_DESIGN + 5}; estimate=round(wn_total - n_cs_total, 0.00001);`,
    `  if wn_total > n_cs_total + 1e-9 then method='the weighted contribution of subjects who failed from a competing cause and were RETAINED. This is the entire difference between this model and a Cox model';`,
    `  else method='ZERO: no competing-event subject was ever retained, so these risk sets are the cause-specific ones and this fit is a Cox model by another name';`,
    `  output;`,
    `  component='score';`,
    `  statistic='partial_loglik_0'; ord=${ORD_SCORE}; estimate=round(loglik0, 0.00001);`,
    `  method='-SUM(d*ln(weighted n)) over event times'; output;`,
    `  statistic='minus_2_loglik_0'; ord=${ORD_SCORE + 1}; estimate=round(-2 * loglik0, 0.00001);`,
    `  method='the number to compare against PHREG null -2 LOG L'; output;`,
    `  statistic='score_u0'; ord=${ORD_SCORE + 2}; estimate=round(score_u0, 0.00001);`,
    `  method='the score at beta=0, over the SUBDISTRIBUTION risk sets'; output;`,
    `  statistic='information_0'; ord=${ORD_SCORE + 3}; estimate=round(information0, 0.00001);`,
    `  method='SUM(d*p*(1-p)) with p the WEIGHTED exposed share'; output;`,
    `  statistic='score_chi_square'; ord=${ORD_SCORE + 4}; estimate=round(_chi, 0.00001);`,
    `  method='U(0)^2 / I(0), chi-square on 1 df - EXECUTED in both twins'; output;`,
    `  statistic='reject_at_0.05'; ord=${ORD_SCORE + 5};`,
    `  if _chi = . then do; estimate=.; method='NOT CHECKABLE: no event times, so the score test is undefined'; end;`,
    `  else do;`,
    `    estimate = (_chi > ${CHI2_CRIT_95_DF1});`,
    `    method='chi-square(1) vs ${CHI2_CRIT_95_DF1} = z^2 at the repo-wide z = 1.96. The exact quantile is ${CHI2_CRIT_95_DF1_EXACT}';`,
    `  end;`,
    `  output;`,
    `  statistic='score_p_value'; ord=${ORD_SCORE + 6}; estimate=.;`,
    `  method='sas_proc_phreg - a chi-square tail probability needs a CDF warehouse SQL does not have'; output;`,
    `  component='one_step'; statistic='subdistribution_hr_one_step'; ord=${ORD_ONESTEP};`,
    `  if _finite and information0 > 0 then do;`,
    `    _lhr = score_u0 / information0; _se = 1 / sqrt(information0);`,
    `    estimate = round(exp(_lhr), 0.00001); se = round(_se, 0.00001);`,
    `    ci_low = round(exp(_lhr - 1.96 * _se), 0.00001);`,
    `    ci_high = round(exp(_lhr + 1.96 * _se), 0.00001);`,
    `    method='exp(U(0)/I(0)): the FIRST NEWTON STEP from the null, not the maximum';`,
    `  end;`,
    `  else do;`,
    `    estimate=.; se=.; ci_low=.; ci_high=.;`,
    `    method='NOT ESTIMABLE: every event of interest is in one arm (complete separation), so the maximum likelihood estimate is INFINITE';`,
    `  end;`,
    `  output;`,
    `  se=.; ci_low=.; ci_high=.;`,
    `  component='anchor'; statistic='weighted_exposed_share'; ord=${ORD_ANCHOR};`,
    `  if abs(p_max - p_min) < ${FG_PROPORTION_EPS} then do;`,
    `    estimate = round(p_min, 0.00001);`,
    `    method='CONSTANT across every subdistribution risk set, so the partial likelihood is binomial and its maximum is closed form';`,
    `  end;`,
    `  else do;`,
    `    estimate = .;`,
    `    method='VARIES across risk sets (this is the usual case), so there is no closed-form maximum';`,
    `  end;`,
    `  output;`,
    `  statistic='event_share_exposed'; ord=${ORD_ANCHOR + 1};`,
    `  if d_total > 0 then estimate = round(d1_exposed / d_total, 0.00001); else estimate = .;`,
    `  method='q = the exposed share of EVENTS, the other half of the closed form'; output;`,
    `  statistic='closed_form_subdistribution_hr'; ord=${ORD_ANCHOR + 2}; estimate=round(closed_form_hr, 0.00001);`,
    `  if closed_form_hr ne . then method='HR = [q/(1-q)] / [p/(1-p)] on the WEIGHTED shares - the same theorem as the Cox anchor, with weights';`,
    `  else if not _finite then method='NOT APPLICABLE: every event of interest is in one arm (complete separation), so the estimate is infinite';`,
    `  else method='NOT APPLICABLE: the weighted exposed share is not constant, which is the usual case';`,
    `  output;`,
    `  estimate=.; se=.; ci_low=.; ci_high=.;`,
    `  component='adjusted'; statistic='subdistribution_hazard_ratio'; method='sas_proc_phreg (eventcode=1)';`,
    ...modelTerms.map((t, i) => `  term="${sq(t)}"; ord=${ORD_ADJUSTED + i}; output;`),
    `  keep measure component term statistic ord estimate se ci_low ci_high method;`,
    `run;`,
    ``,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Fine-Gray closed forms and the fitted model: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_fgray${suffix}.sas`,
    language: "sas",
    title: `${num} Fine-Gray${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const fineGrayModule: AnalysisModule<FineGrayAnalysis> = {
  analysisKind: "fine_gray",
  stampKind: "fine_gray",
  resultSlug: "fgray",
  sql: sqlFineGray,
  sas: sasFineGray,
};
