/**
 * Cox proportional-hazards module.
 *
 * The build plan lists Cox with the families whose coefficients are
 * "unverifiable except at a saturated design", and for the coefficient that is
 * right — Newton has to run, and it runs in SAS. What the plan did not account
 * for is how much of the model AROUND the coefficient is closed form. All of
 * this is EXECUTED in both twins and checked by the harness:
 *
 *   - the partial log-likelihood at the null, which PROC PHREG prints as its
 *     "without covariates" -2 LOG L;
 *   - the SCORE at the null, which is exactly the log-rank numerator O - E;
 *   - the INFORMATION at the null, which equals the log-rank variance when no
 *     event time is tied and DIFFERS when one is;
 *   - the score test, its alpha = 0.05 decision against 3.8416, and the
 *     one-step estimator exp(U/I).
 *
 * The emitted SAS then checks PHREG against three of them (cox-core.ts):
 * the null -2 LOG L, `U(beta_hat) = 0` — the defining equation of the estimate,
 * closed form here because the exposure is binary — and, where it applies, the
 * constant-proportion closed-form maximum. None ships a reference number.
 *
 * WHAT IS NOT BUILT, named rather than approximated: the proportional-hazards
 * assumption is not TESTED here (Schoenfeld residuals at the fitted beta need
 * beta, and their test needs a p-value); there are no time-varying covariates,
 * no stratified baseline hazard, and no Efron ties — see readiness for why the
 * last one is a refusal and not an omission.
 *
 * Verified vs Gold Case A (no ties): U(0) = -31/42, I(0) = 1265/1764 — the SAME
 * value as the log-rank variance — score chi-square 0.75968, logL(0) = -5.81711.
 * The risk-set proportion varies (1/2, 4/7, 2/3), so the closed-form anchor is
 * correctly NOT APPLICABLE. Verified vs Gold Case C (one tie): I(0) = 3/4
 * against a log-rank variance of 13/20, which is the difference Gold A cannot
 * show; and every risk set is half exposed, so the anchor DOES apply and gives
 * HR = 1/2 exactly.
 */
import type { CoxAnalysis } from "../../spec/types";
import { findCodeList, survivalOutcome } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import { cmt, describeWin, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import { rateCoreSqlCtes, censorPlan, renderCensorSql, renderCensorSas } from "../rate-core";
import { CHI2_CRIT_95_DF1, CHI2_CRIT_95_DF1_EXACT } from "../km-core";
import { coxSqlCtes, coxSasSteps, coxSasSelfChecks, PROPORTION_EPS, SCORE_ZERO_EPS } from "../cox-core";
import {
  balanceCovariates,
  outcomeSettingPlan,
  parityStamp,
  coxLimitations,
  coxParity,
  stratLabel,
  COX_METHOD_NOTES,
  type BalanceCovariate,
} from "../parity";

const MEASURE = "cox";

const ORD_DESIGN = 0;
const ORD_SCORE = 10;
const ORD_ONESTEP = 20;
const ORD_ANCHOR = 30;
const ORD_ADJUSTED = 40;

function plan(ctx: SqlCtx | SasCtx, an: CoxAnalysis) {
  const spec = ctx.spec;
  const gv = spec.groupVars.find((g) => g.id === an.groupVarId);
  const referenceLevel = gv?.referenceLevel ?? gv?.levels[0] ?? "";
  const exposedLevel = gv?.levels.find((l) => l !== referenceLevel) ?? "";
  const { supported, unsupported } = balanceCovariates(
    spec.baseline,
    an.covariateIds,
    new Set(spec.analyses.filter((x) => x.kind === "comorbidity_index" && x.enabled).map((x) => x.id)),
  );
  return {
    gv,
    referenceLevel,
    exposedLevel,
    covariates: supported,
    droppedCovs: unsupported.map((u) => u.id),
    emittable: Boolean(gv && referenceLevel && exposedLevel),
    comparison: `${exposedLevel} vs ${referenceLevel}`,
  };
}

function terms(p: { covariates: BalanceCovariate[] }, gvLabel: string): string[] {
  return [stratLabel(gvLabel), ...p.covariates.map((c) => stratLabel(c.label))];
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlCox(ctx: SqlCtx, an: CoxAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_cox${suffix}`;
  const od = survivalOutcome(an);
  const p = plan(ctx, an);
  const L: string[] = [];

  /* Belt to readiness' braces. A refused endpoint must not reach an emitter,
   * and if it ever does the program must say so rather than silently emit an
   * empty one — the failure mode the gate exists to prevent. */
  if (!od || !p.emittable) {
    L.push(`-- NOT EMITTED: ${!od ? `this analysis declares a MORTALITY endpoint, which is refused (DSTATUS is in-hospital only and masked from 2016).` : `the exposure variable did not resolve to two levels.`}`);
    return {
      slug: `cox${suffix}`, title: `Cox model${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted", extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`], body: L.join("\n"),
    };
  }

  const clid = od.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(od, listSystem);
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  const washoutPred = wc.length > 0 ? wc.join("\n      AND ") : "TRUE";
  const censor = censorPlan(spec, an.personTimeRule);
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `ch.index_code`;

  L.push(
    `-- ${parityStamp("cox", coxParity(an, {
      settingFilter: setting.stamped, censorTerms: censor.applied, dataCut: censor.dataCut,
      referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms,
    }))}`,
  );
  const limits = coxLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs, spec);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of COX_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(`-- SAS-PRIMARY: the fitted coefficient is NULL here BY CONTRACT - maximizing`);
  L.push(`-- a partial likelihood needs Newton-Raphson, which warehouse SQL cannot run.`);
  L.push(`-- Everything the fit is CHECKED against below is closed form and executed.`);

  const C: string[] = [];
  C.push(...rateCoreSqlCtes(ctx, {
    wp, codeListId: clid, settingEnforce: setting.enforce,
    washoutDescription: describeWindow(an.washout), washoutPredicate: washoutPred, needDemo: false,
  }));
  C.push(`s0 AS (   -- censoring: ${censor.applied.join(" / ")}${censor.dataCut ? ` / data cut ${censor.dataCut}` : ``}`);
  C.push(`  SELECT c.enrolid, c.index_date, ${renderCensorSql(ctx, censor)} AS admin_censor, f.fu_date, ${armExpr} AS arm`);
  C.push(`  FROM atrisk c`);
  C.push(`  JOIN ${ctx.cohortT} ch ON ch.enrolid = c.enrolid`);
  if (viaNdc) {
    C.push(`  JOIN ${wp}_ndc_lookup nl`);
    C.push(`    ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = ch.index_code`);
  }
  C.push(`  JOIN ${wp}_enroll_episodes ep`);
  C.push(`    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end`);
  C.push(`  LEFT JOIN first_fu f ON f.enrolid = c.enrolid`);
  C.push(`),`);
  C.push(`subj AS (   -- the ANALYTIC DATASET: follow-up time, event flag, exposure`);
  C.push(`  SELECT enrolid,`);
  C.push(`         ${d.daysBetween(`LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor)`, "index_date")} AS t,`);
  C.push(`         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN 1 ELSE 0 END AS ev,`);
  C.push(`         CASE WHEN arm = '${q(p.exposedLevel)}' THEN 1 ELSE 0 END AS exposed`);
  C.push(`  FROM s0`);
  C.push(`  WHERE arm IN ('${q(p.referenceLevel)}', '${q(p.exposedLevel)}')`);
  C.push(`),`);
  C.push(...coxSqlCtes({ subjectsCte: "subj" }));
  C[C.length - 1] = C[C.length - 1].replace(/,\s*$/, "");

  const NUM = (e: string) => `CAST(${e} AS NUMERIC)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;
  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const NULLN = `CAST(NULL AS NUMERIC)`;
  const chi = `POWER(score_u0, 2) / NULLIF(information0, 0)`;

  L.push(d.createTableAs(out));
  L.push(...C);
  L.push(`SELECT '${MEASURE}' AS measure, component, term, statistic, ord,`);
  L.push(`       estimate, se, ci_low, ci_high, method`);
  L.push(`FROM (`);

  const parts: string[][] = [];
  /* A UNION takes its column NAMES from the first branch only, so every branch
   * carries the aliases: leaving them off the first one produced a table whose
   * outer SELECT referenced a column that did not exist. */
  const row = (component: string, term: string, statistic: string, ord: number, est: string, method: string, from = "cx", se = NULLN, lo = NULLN, hi = NULLN) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${q(term)}'`)} AS term,`,
    `         ${STR(`'${statistic}'`)} AS statistic, ${INT(String(ord))} AS ord,`,
    `         ${est} AS estimate, ${se} AS se, ${lo} AS ci_low, ${hi} AS ci_high, ${STR(method)} AS method`,
    `  FROM ${from}`,
  ];

  // 1. the design: what the partial likelihood was built from
  parts.push(row("design", p.comparison, "event_times", ORD_DESIGN, NUM(`n_event_times`), `'distinct times at which at least one event occurred'`));
  parts.push(row("design", p.comparison, "events_total", ORD_DESIGN + 1, NUM(`d_total`), `'observed'`));
  parts.push(row("design", p.comparison, "events_exposed", ORD_DESIGN + 2, NUM(`d1_exposed`), `'observed'`));
  /* TIED EVENT TIMES, counted and reported. It decides which tie approximation
   * matters, and it decides whether the Cox information and the log-rank
   * variance below should agree — so a reader who sees them differ has the
   * reason in the same table. */
  parts.push(row("design", p.comparison, "tied_event_times", ORD_DESIGN + 3, NUM(`tied_event_times`),
    `CASE WHEN tied_event_times = 0` +
    ` THEN 'no tied event times, so Breslow and Efron coincide and the Cox information equals the log-rank variance'` +
    ` ELSE 'tied event times PRESENT: Breslow is used here and Efron would generally be preferable; the Cox information and the log-rank variance no longer agree' END`));

  // 2. the closed forms at beta = 0 — all executed in both twins
  parts.push(row("score", p.comparison, "partial_loglik_0", ORD_SCORE, `${d.roundN(`loglik0`, 5)}`,
    `'-SUM(d*ln(n)) over event times. PROC PHREG prints -2 times this as its "without covariates" fit statistic, so the two can be compared directly'`));
  parts.push(row("score", p.comparison, "minus_2_loglik_0", ORD_SCORE + 1, `${d.roundN(`-2 * loglik0`, 5)}`,
    `'the number to compare against PHREG null -2 LOG L'`));
  parts.push(row("score", p.comparison, "score_u0", ORD_SCORE + 2, `${d.roundN(`score_u0`, 5)}`,
    `'the score at beta=0. This IS the log-rank numerator O-E: the log-rank test is the Cox score test at the null'`));
  parts.push(row("score", p.comparison, "information_0", ORD_SCORE + 3, `${d.roundN(`information0`, 5)}`,
    `'SUM(d*p*(1-p)) with p the exposed share of the risk set (Breslow)'`));
  /* The log-rank variance beside it, and a row that says whether they agree. */
  parts.push(row("score", p.comparison, "logrank_variance", ORD_SCORE + 4, `${d.roundN(`logrank_v`, 5)}`,
    `'the log-rank variance, which carries a (n-d)/(n-1) tie correction Breslow information does not. EQUAL to information_0 when no event time is tied'`));
  parts.push(row("score", p.comparison, "score_chi_square", ORD_SCORE + 5, `${d.roundN(chi, 5)}`,
    `'U(0)^2 / I(0), chi-square on 1 df - EXECUTED in both twins'`));
  parts.push(row("score", p.comparison, "reject_at_0.05", ORD_SCORE + 6,
    NUM(`CASE WHEN information0 IS NULL OR information0 = 0 THEN NULL WHEN ${chi} > ${CHI2_CRIT_95_DF1} THEN 1 ELSE 0 END`),
    `CASE WHEN information0 IS NULL OR information0 = 0` +
    ` THEN 'NOT CHECKABLE: no event times, so the score test is undefined'` +
    ` ELSE 'chi-square(1) vs ${CHI2_CRIT_95_DF1} = z^2 at the repo-wide z = 1.96. The exact quantile is ${CHI2_CRIT_95_DF1_EXACT}; a statistic between the two would be called significant here and not by SAS' END`));
  parts.push(row("score", p.comparison, "score_p_value", ORD_SCORE + 7, NULLN,
    `'sas_proc_phreg - a chi-square tail probability needs a CDF warehouse SQL does not have'`));

  // 3. the one-step estimator — the first Newton step, closed form
  const lhr = `score_u0 / NULLIF(information0, 0)`;
  const sehr = `1.0 / SQRT(NULLIF(information0, 0))`;
  parts.push(row("one_step", p.comparison, "hazard_ratio_one_step", ORD_ONESTEP,
    d.roundN(`EXP(${lhr})`, 5),
    `'exp(U(0)/I(0)): the FIRST NEWTON STEP from the null, not the maximum. It is closed form where the MLE is not, and it drifts from the MLE as the effect grows - the fitted estimate below is the reportable one'`,
    "cx", d.roundN(sehr, 5), d.roundN(`EXP(${lhr} - 1.96 * (${sehr}))`, 5), d.roundN(`EXP(${lhr} + 1.96 * (${sehr}))`, 5)));

  // 4. THE ANCHOR
  /* NULL when the share is not constant. Reporting p_min beside a method that
   * says "VARIES" put a number in the estimate column that was the minimum of a
   * moving quantity and read like the quantity itself. */
  parts.push(row("anchor", p.comparison, "risk_set_exposed_share", ORD_ANCHOR,
    `${d.roundN(`CASE WHEN ABS(p_max - p_min) < ${PROPORTION_EPS} THEN p_min END`, 5)}`,
    `CASE WHEN ABS(p_max - p_min) < ${PROPORTION_EPS}` +
    ` THEN 'CONSTANT across every risk set, so the partial likelihood is binomial and its maximum is closed form'` +
    ` ELSE 'VARIES across risk sets (this is the usual case), so there is no closed-form maximum' END`));
  parts.push(row("anchor", p.comparison, "event_share_exposed", ORD_ANCHOR + 1, `${d.roundN(`d1_exposed * 1.0 / NULLIF(d_total, 0)`, 5)}`,
    `'q = the exposed share of EVENTS, the other half of the closed form'`));
  parts.push(row("anchor", p.comparison, "closed_form_hazard_ratio", ORD_ANCHOR + 2, `${d.roundN(`closed_form_hr`, 5)}`,
    `CASE WHEN closed_form_hr IS NOT NULL` +
    ` THEN 'HR = [q/(1-q)] / [p/(1-p)]. The SAS twin checks its fitted hazard ratio against this number'` +
    ` WHEN d1_exposed = 0 OR d1_exposed = d_total` +
    ` THEN 'NOT APPLICABLE: every event is in one arm (complete separation), so the maximum likelihood estimate is infinite and no finite number belongs here'` +
    ` ELSE 'NOT APPLICABLE: the risk-set exposed share is not constant, which is the usual case. The fitted coefficient is then checkable only by U(beta_hat)=0, which the SAS twin does' END`));

  // 5. the fitted model — SAS-primary
  modelTerms.forEach((t, i) => {
    parts.push(row("adjusted", t, "hazard_ratio", ORD_ADJUSTED + i, NULLN, `'sas_proc_phreg (ties=breslow)'`));
  });

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: everything the Cox fit is CHECKED against, computed here in closed`);
  L.push(`-- form. The fitted coefficient itself is SAS-primary and NULL above.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `cox${suffix}`,
    title: `Cox model${suffix ? ` (${an.label})` : ""}`,
    subtitle: `Cox closed forms at the null + one-step HR (the fitted coefficient is SAS-primary)`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); endpoint code list "${clid}".`,
      `Exposure ${p.exposedLevel} vs reference ${p.referenceLevel}; adjusted terms: ${modelTerms.join(", ")}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasCox(ctx: SasCtx, an: CoxAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_cox${suffix}`);
  const cohT = ctx.finalCohort;
  const od = survivalOutcome(an);
  const p = plan(ctx, an);
  const label = an.label.replace(/"/g, "'");

  if (!od || !p.emittable) {
    return {
      path: `sas/${num}_cox${suffix}.sas`, language: "sas", title: `${num} Cox model (not emitted)`,
      content: [...header(spec, `${num}_cox${suffix}.sas`, [
        `NOT EMITTED: ${!od ? `mortality endpoint, which is refused (DSTATUS is in-hospital only, masked from 2016).` : `the exposure did not resolve to two levels.`}`,
      ]), ``].join("\n"),
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
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const limits = coxLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs, spec);
  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const enrT = ctx.tbl("040_enroll");
  const sasVar = (c: BalanceCovariate) => (c.axis === "age" ? "age_val" : c.axis === "sex" ? "sex_male" : "cci_val");
  const covVars = p.covariates.filter((c) => c.axis === "age" || c.axis === "sex").map(sasVar);
  const needDemo = covVars.length > 0;

  const lines: string[] = [
    ...header(spec, `${num}_cox${suffix}.sas`, [
      `Cox proportional hazards for "${an.label}".`,
      `The COEFFICIENT is SAS-primary: maximizing a partial likelihood needs`,
      `Newton-Raphson, which the SQL twin cannot run. Everything the fit is`,
      `CHECKED against is closed form and computed in BOTH twins.`,
      `THREE SELF-CHECKS on PROC PHREG, none shipping a reference value:`,
      `  1. the null -2 LOG L against the closed-form partial log-likelihood;`,
      `  2. U(beta_hat) = 0, the equation that DEFINES the estimate;`,
      `  3. the constant-proportion closed-form maximum, where it applies.`,
      `Twin of the SQL cox program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("cox", coxParity(an, {
      settingFilter: setting.stamped, censorTerms: censorS.applied, dataCut: censorS.dataCut,
      referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms,
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...COX_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
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
    `  select a.* from ${cohT} as a`,
    `  where a.enrolid not in (select enrolid from work._${num}_prev);`,
    ``,
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
    ...levelCheck(`work._${num}_atrisk`, "at-risk cohort"),
    ``,
    `/*-------------------- the analytic dataset ----------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_s0 as`,
    `  select a.enrolid, a.index_date,`,
    `         ${renderCensorSas(censorS)} as admin_censor format=date9.,`,
    `         b.fu_date,`,
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
    `  left join work._${num}_first_fu as b`,
    `    on b.enrolid = a.enrolid;`,
    `quit;`,
    ``,
    `data work._${num}_subj;`,
    `  set work._${num}_s0;`,
    `  ev = (fu_date ne . and fu_date <= admin_censor);`,
    `  t  = min(coalesce(fu_date, '31DEC9999'd), admin_censor) - index_date;`,
    `  exposed = (arm = "${sq(p.exposedLevel)}");`,
    ...(needDemo ? [`  age_val  = year(index_date) - dobyr;`, `  sex_male = (sex = '1');`] : []),
    `  if arm not in ("${sq(p.referenceLevel)}", "${sq(p.exposedLevel)}") then delete;`,
    `  keep enrolid t ev exposed${needDemo ? " age_val sex_male" : ""};`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "subjects in the risk set", [`sum(ev) as events`]),
    ``,
    ...coxSasSteps({ num, subjT: `work._${num}_subj` }),
    ``,
    `/*----------------------------------------------------------------------------`,
    `  THE FIT. ties=breslow is EXPLICIT, not left to the default: every closed`,
    `  form above is Breslow's, so a fit maximizing Efron's likelihood would fail`,
    `  the U(beta_hat)=0 check below even when it was perfectly correct.`,
    `----------------------------------------------------------------------------*/`,
    `ods output ParameterEstimates = work._${num}_pe`,
    `           FitStatistics      = work._${num}_fit;`,
    `proc phreg data=work._${num}_subj;`,
    `  model t*ev(0) = exposed${covVars.length > 0 ? " " + covVars.join(" ") : ""} / ties=breslow risklimits;`,
    `run;`,
    ``,
    `title "Cox model: ${label}";`,
    `proc print data=work._${num}_pe noobs; run;`,
    `title;`,
    ``,
    ...coxSasSelfChecks({ num, peT: `work._${num}_pe`, fitT: `work._${num}_fit` }),
    ``,
  );

  /* Assemble — the same rows, in the same order, as the SQL twin. */
  const cmp = sq(p.comparison);
  lines.push(
    `/*-------------------- assemble the result table -----------------------------*/`,
    `data ${outT};`,
    `  set work._${num}_cx;`,
    `  length measure $20 component $10 term $40 statistic $28 method $260;`,
    `  measure = "${MEASURE}";`,
    `  term = "${cmp}"; se = .; ci_low = .; ci_high = .;`,
    `  if information0 > 0 then _chi = (score_u0**2) / information0; else _chi = .;`,
    `  component='design'; statistic='event_times';     ord=${ORD_DESIGN};   estimate=n_event_times;`,
    `  method='distinct times at which at least one event occurred'; output;`,
    `  statistic='events_total';    ord=${ORD_DESIGN + 1}; estimate=d_total;    method='observed'; output;`,
    `  statistic='events_exposed';  ord=${ORD_DESIGN + 2}; estimate=d1_exposed; method='observed'; output;`,
    `  statistic='tied_event_times'; ord=${ORD_DESIGN + 3}; estimate=tied_event_times;`,
    `  if tied_event_times = 0 then method='no tied event times, so Breslow and Efron coincide and the Cox information equals the log-rank variance';`,
    `  else method='tied event times PRESENT: Breslow is used here and Efron would generally be preferable; the Cox information and the log-rank variance no longer agree';`,
    `  output;`,
    `  component='score';`,
    `  statistic='partial_loglik_0'; ord=${ORD_SCORE};   estimate=round(loglik0, 0.00001);`,
    `  method='-SUM(d*ln(n)) over event times. PROC PHREG prints -2 times this as its "without covariates" fit statistic'; output;`,
    `  statistic='minus_2_loglik_0'; ord=${ORD_SCORE + 1}; estimate=round(-2 * loglik0, 0.00001);`,
    `  method='the number to compare against PHREG null -2 LOG L'; output;`,
    `  statistic='score_u0';        ord=${ORD_SCORE + 2}; estimate=round(score_u0, 0.00001);`,
    `  method='the score at beta=0. This IS the log-rank numerator O-E'; output;`,
    `  statistic='information_0';   ord=${ORD_SCORE + 3}; estimate=round(information0, 0.00001);`,
    `  method='SUM(d*p*(1-p)) with p the exposed share of the risk set (Breslow)'; output;`,
    `  statistic='logrank_variance'; ord=${ORD_SCORE + 4}; estimate=round(logrank_v, 0.00001);`,
    `  method='the log-rank variance, which carries a (n-d)/(n-1) tie correction Breslow information does not'; output;`,
    `  statistic='score_chi_square'; ord=${ORD_SCORE + 5}; estimate=round(_chi, 0.00001);`,
    `  method='U(0)^2 / I(0), chi-square on 1 df - EXECUTED in both twins'; output;`,
    `  statistic='reject_at_0.05';  ord=${ORD_SCORE + 6};`,
    `  if _chi = . then do; estimate=.; method='NOT CHECKABLE: no event times, so the score test is undefined'; end;`,
    `  else do;`,
    `    estimate = (_chi > ${CHI2_CRIT_95_DF1});`,
    `    method='chi-square(1) vs ${CHI2_CRIT_95_DF1} = z^2 at the repo-wide z = 1.96. The exact quantile is ${CHI2_CRIT_95_DF1_EXACT}';`,
    `  end;`,
    `  output;`,
    `  /* the SAS-primary p-value: PHREG computed it above; the cell is left`,
    `     missing so this table has the same shape as the SQL twin's. */`,
    `  statistic='score_p_value';   ord=${ORD_SCORE + 7}; estimate=.;`,
    `  method='sas_proc_phreg - a chi-square tail probability needs a CDF warehouse SQL does not have'; output;`,
    `  component='one_step'; statistic='hazard_ratio_one_step'; ord=${ORD_ONESTEP};`,
    `  if information0 > 0 then do;`,
    `    _lhr = score_u0 / information0;`,
    `    _se  = 1 / sqrt(information0);`,
    `    estimate = round(exp(_lhr), 0.00001);`,
    `    se       = round(_se, 0.00001);`,
    `    ci_low   = round(exp(_lhr - 1.96 * _se), 0.00001);`,
    `    ci_high  = round(exp(_lhr + 1.96 * _se), 0.00001);`,
    `  end;`,
    `  else do; estimate=.; se=.; ci_low=.; ci_high=.; end;`,
    `  method='exp(U(0)/I(0)): the FIRST NEWTON STEP from the null, not the maximum'; output;`,
    `  se=.; ci_low=.; ci_high=.;`,
    `  component='anchor';`,
    `  statistic='risk_set_exposed_share'; ord=${ORD_ANCHOR};`,
    `  if abs(p_max - p_min) < ${PROPORTION_EPS} then estimate = round(p_min, 0.00001); else estimate = .;`,
    `  if abs(p_max - p_min) < ${PROPORTION_EPS} then method='CONSTANT across every risk set, so the partial likelihood is binomial and its maximum is closed form';`,
    `  else method='VARIES across risk sets (this is the usual case), so there is no closed-form maximum';`,
    `  output;`,
    `  statistic='event_share_exposed'; ord=${ORD_ANCHOR + 1};`,
    `  if d_total > 0 then estimate = round(d1_exposed / d_total, 0.00001); else estimate = .;`,
    `  method='q = the exposed share of EVENTS, the other half of the closed form'; output;`,
    `  statistic='closed_form_hazard_ratio'; ord=${ORD_ANCHOR + 2}; estimate=round(closed_form_hr, 0.00001);`,
    `  if closed_form_hr ne . then method='HR = [q/(1-q)] / [p/(1-p)]. The self-check above compares the fitted hazard ratio against this number';`,
    `  else if d1_exposed = 0 or d1_exposed = d_total then method='NOT APPLICABLE: every event is in one arm (complete separation), so the estimate is infinite';`,
    `  else method='NOT APPLICABLE: the risk-set exposed share is not constant, which is the usual case';`,
    `  output;`,
    `  /* the FITTED estimates - the estimates the model above produced */`,
    `  estimate=.; se=.; ci_low=.; ci_high=.;`,
    `  component='adjusted'; statistic='hazard_ratio'; method='sas_proc_phreg (ties=breslow)';`,
    ...modelTerms.map((t, i) => `  term="${sq(t)}"; ord=${ORD_ADJUSTED + i}; output;`),
    `  keep measure component term statistic ord estimate se ci_low ci_high method;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Cox closed forms and the fitted model: ${label}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  void SCORE_ZERO_EPS; // used inside coxSasSelfChecks
  return {
    path: `sas/${num}_cox${suffix}.sas`,
    language: "sas",
    title: `${num} Cox model${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const coxModule: AnalysisModule<CoxAnalysis> = {
  analysisKind: "cox",
  stampKind: "cox",
  resultSlug: "cox",
  sql: sqlCox,
  sas: sasCox,
};
