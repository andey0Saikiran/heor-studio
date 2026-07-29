/**
 * IPTW outcome model — the weighted effect estimate.
 *
 * The propensity module produces the score, the weights and the balance. This
 * one produces the number a study reports. They are separate analyses because
 * they fail differently, and the difference matters: a beautifully balanced
 * weighted sample can still be a population in which the effect is NOT
 * IDENTIFIED, and a module that emitted an estimate without saying so would be
 * doing the most damaging thing this project can do.
 *
 * EXECUTED IN BOTH TWINS, all of it. SAS-PRIMARY: nothing.
 *   - the saturated score, on the AT-RISK set this analysis defines;
 *   - the Hajek weighted risk per arm, SUM(wY)/SUM(w);
 *   - its SANDWICH variance, SUM(w^2 (Y-mu)^2) / (SUM w)^2;
 *   - risk difference, risk ratio and odds ratio with Wald intervals;
 *   - the UNADJUSTED contrast beside each one, and the shift.
 *
 * THREE THINGS THIS MODULE REFUSES TO LET PASS QUIETLY.
 *
 *  1. IDENTIFICATION. Subjects in cells that are entirely one arm have no
 *     counterpart at any weight. Their presence does not make the arithmetic
 *     fail — it makes the estimand undefined. The `identified` row is emitted
 *     FIRST and carries the count.
 *
 *  2. THE VARIANCE. The naive move on a weighted sample is p(1-p)/n_effective.
 *     That is the variance of a different estimator and it is too small. What
 *     is emitted is the sandwich variance of the Hajek RATIO, which is closed
 *     form and is labeled `weights_treated_as_known` — because it is
 *     conservative rather than exact, and "robust" alone would overclaim.
 *
 *  3. AN INTERVAL THAT LEAVES THE RANGE. A Wald interval on a risk difference
 *     can run below -1 or above 1, which is impossible for a difference of two
 *     probabilities and means the normal approximation has broken down. It is
 *     reported UNCLAMPED with a diagnostic row saying so — clamping would hide
 *     precisely the signal that the interval should not be trusted.
 *
 * Verified vs Gold Case A, scored on region over the at-risk set of 8:
 * cells 1/2, 1/3, 0 and 1 — so THREE of the eight subjects are off support and
 * the estimate is not identified. Weighted risks 1/7 and 7/12; risk difference
 * -37/84, risk ratio 12/49, odds ratio 5/42; sandwich variances 50/2401 and
 * 631/10368. Weighting moves the risk difference from -0.25 to -0.44048, and
 * the interval on it runs from -1.00066 — below the range a risk difference can
 * occupy, which the diagnostic row reports.
 */
import type { IptwOutcomeAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import { cmt, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import { psSqlCtes, psSasSteps, hajekSqlCtes, hajekSasSteps, hajekSasAnchor } from "../ps-core";
import {
  outcomeSettingPlan,
  parityStamp,
  iptwOutcomeLimitations,
  iptwOutcomeParity,
  IPTW_OUTCOME_METHOD_NOTES,
  REGION_LABELS,
  SEX_LABELS,
} from "../parity";

const MEASURE = "iptw_outcome";
const ORD_IDENT = 0;
const ORD_DESIGN = 10;
const ORD_EFFECT = 20;
const ORD_UNADJ = 30;
const ORD_DIAG = 40;

type CellAxis = "sex" | "region" | "plan_type" | "year";

function plan(ctx: SqlCtx | SasCtx, an: IptwOutcomeAnalysis) {
  const spec = ctx.spec;
  const gv = spec.groupVars.find((g) => g.id === an.groupVarId);
  const referenceLevel = gv?.referenceLevel ?? gv?.levels[0] ?? "";
  const treatedLevel = gv?.levels.find((l) => l !== referenceLevel) ?? "";
  const cellAxes: Array<{ id: string; label: string; axis: CellAxis }> = [];
  for (const id of an.psCovariateIds) {
    const b = spec.baseline.find((x) => x.id === id);
    if (b && (b.kind === "sex" || b.kind === "region" || b.kind === "plan_type" || b.kind === "year"))
      cellAxes.push({ id, label: b.label, axis: b.kind });
  }
  return {
    gv, referenceLevel, treatedLevel, cellAxes,
    emittable: Boolean(gv && referenceLevel && treatedLevel && cellAxes.length > 0 && !an.doublyRobust),
    comparison: `${treatedLevel} vs ${referenceLevel}`,
  };
}

function cellExprSql(axis: CellAxis, ctx: SqlCtx): string {
  switch (axis) {
    case "sex":
      return `CASE CAST(dm.sex AS VARCHAR) ${Object.entries(SEX_LABELS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE 'Unknown' END`;
    case "region":
      return `CASE CAST(dm.region AS VARCHAR) ${Object.entries(REGION_LABELS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE 'Unknown' END`;
    case "plan_type":
      return `COALESCE(CAST(dm.plantyp AS VARCHAR), 'Unknown')`;
    case "year":
      return `CAST(${ctx.d.year("c.index_date")} AS VARCHAR)`;
  }
}

function cellAssignSas(axis: CellAxis, v: string): string[] {
  switch (axis) {
    case "sex": {
      const arms = Object.entries(SEX_LABELS).map(([k, lab], j) => `${j === 0 ? "if" : "else if"} sex = '${k}' then ${v} = '${lab}';`);
      return [...arms, `else ${v} = 'Unknown';`];
    }
    case "region": {
      const arms = Object.entries(REGION_LABELS).map(([k, lab], j) => `${j === 0 ? "if" : "else if"} region = '${k}' then ${v} = '${lab}';`);
      return [...arms, `else ${v} = 'Unknown';`];
    }
    case "plan_type":
      return [`${v} = strip(vvalue(plantyp));`, `if ${v} in ('', '.') then ${v} = 'Unknown';`];
    case "year":
      return [`${v} = strip(put(year(index_date), 4.));`];
  }
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlIptwOutcome(ctx: SqlCtx, an: IptwOutcomeAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_iptw${suffix}`;
  const p = plan(ctx, an);
  const L: string[] = [];
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);

  L.push(`-- ${parityStamp("iptw_outcome", iptwOutcomeParity(an, {
    referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
    cellAxes: p.cellAxes.map((c) => c.axis), settingFilter: setting.stamped,
  }))}`);
  const limits = iptwOutcomeLimitations(an, listSystem);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of IPTW_OUTCOME_METHOD_NOTES) L.push(`--   * ${note}`);

  if (!p.emittable) {
    L.push(`-- NOT EMITTED: ${an.doublyRobust ? `doubly-robust estimation is not built yet — see readiness.` : `the exposure or the propensity covariates did not resolve.`}`);
    return {
      slug: `iptw${suffix}`, title: `IPTW outcome${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted", extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`], body: L.join("\n"),
    };
  }

  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `c.index_code`;
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);

  const C: string[] = [];
  C.push(`WITH cohort AS (SELECT enrolid, index_date, index_code FROM ${wp}_cohort),`);
  C.push(`ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${q(clid)}'` +
    (setting.enforce ? ` AND setting = '${setting.enforce}'` : ``) + `),`);
  C.push(`prevalent AS (   -- washout: ${describeWindow(an.washout)}`);
  C.push(`  SELECT DISTINCT c.enrolid FROM cohort c JOIN ae a ON a.enrolid = c.enrolid`);
  C.push(`  WHERE ${wc.length > 0 ? wc.join("\n      AND ") : "TRUE"}`);
  C.push(`),`);
  /* THE SCORE IS ESTIMATED ON THE AT-RISK SET, not on the whole cohort.
   * Weights built in one population and applied in another describe neither,
   * and the washout is what defines the population this effect is about. */
  C.push(`atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),`);
  C.push(`demo AS (`);
  C.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
  C.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
  C.push(`  FROM atrisk c`);
  C.push(`  JOIN ${ctx.t("enrollment_detail")} en ON en.enrolid = c.enrolid AND en.dtstart <= c.index_date`);
  C.push(`),`);
  C.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  C.push(`cases AS (   -- first qualifying event in (index, index + ${an.horizonDays}d]`);
  C.push(`  SELECT DISTINCT c.enrolid FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid`);
  C.push(`   AND a.event_date > c.index_date AND a.event_date <= ${d.offset("c.index_date", an.horizonDays)}`);
  C.push(`),`);
  C.push(`subj AS (`);
  C.push(`  SELECT c.enrolid,`);
  C.push(`         CASE WHEN ${armExpr} = '${q(p.treatedLevel)}' THEN 1 ELSE 0 END AS treated,`);
  C.push(`         ${p.cellAxes.map((a) => cellExprSql(a.axis, ctx)).join(` || '|' || `)} AS cell,`);
  C.push(`         CASE WHEN cs.enrolid IS NOT NULL THEN 1.0 ELSE 0.0 END AS y`);
  C.push(`  FROM atrisk c`);
  C.push(`  LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid`);
  C.push(`  LEFT JOIN cases cs ON cs.enrolid = c.enrolid`);
  if (viaNdc) {
    C.push(`  JOIN ${wp}_ndc_lookup nl`);
    C.push(`    ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = c.index_code`);
  }
  C.push(`  WHERE ${armExpr} IN ('${q(p.referenceLevel)}', '${q(p.treatedLevel)}')`);
  C.push(`),`);
  C.push(...psSqlCtes({ subjectsCte: "subj", estimand: an.estimand, stabilized: an.stabilized, trim: an.trim }));
  C.push(`support AS (`);
  C.push(`  SELECT SUM(CASE WHEN n_control_cell = 0 OR n_treated_cell = 0 THEN n_cell ELSE 0 END) AS off_support,`);
  C.push(`         COUNT(*) AS n_cells, SUM(n_cell) AS n_total`);
  C.push(`  FROM pscell`);
  C.push(`),`);
  C.push(...hajekSqlCtes({ subjectsCte: "psk", outcomeCol: "y" }));
  C.push(`unadj AS (`);
  C.push(`  SELECT AVG(CASE WHEN treated = 1 THEN y END) AS u1,`);
  C.push(`         AVG(CASE WHEN treated = 0 THEN y END) AS u0`);
  C.push(`  FROM psk`);
  C.push(`)`);

  const NULLN = `CAST(NULL AS NUMERIC)`;
  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;

  L.push(d.createTableAs(out));
  L.push(...C);
  L.push(`SELECT '${MEASURE}' AS measure, component, statistic, ord,`);
  L.push(`       estimate, se, ci_low, ci_high, method`);
  L.push(`FROM (`);
  const parts: string[][] = [];
  const row = (component: string, statistic: string, ord: number, est: string, method: string, from: string, se = NULLN, lo = NULLN, hi = NULLN) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${statistic}'`)} AS statistic,`,
    `         ${INT(String(ord))} AS ord, ${est} AS estimate, ${se} AS se,`,
    `         ${lo} AS ci_low, ${hi} AS ci_high, ${STR(method)} AS method`,
    `  FROM ${from}`,
  ];

  /* 1. IDENTIFICATION, FIRST. Everything below is arithmetic that succeeds
   * whether or not the estimand exists. */
  parts.push(row("identification", "subjects_off_support", ORD_IDENT, `CAST(off_support AS NUMERIC)`,
    `CASE WHEN off_support > 0` +
    ` THEN 'THE EFFECT IS NOT IDENTIFIED FOR THESE SUBJECTS. They sit in covariate cells that are entirely one arm, so they have no counterpart at ANY weight. The estimate below is still computed - the arithmetic does not fail - but it describes a population that does not exist. Restrict the analysis to cells containing both arms, or say plainly which subjects the effect excludes'` +
    ` ELSE 'every covariate cell contains both arms, so the weighted contrast is identified across the whole analysis set' END`, "support"));
  parts.push(row("identification", "analysis_set_n", ORD_IDENT + 1, `CAST(n_total AS NUMERIC)`,
    `'subjects at risk after the washout. The score is estimated HERE, not on the whole cohort: weights built in one population and applied in another describe neither'`, "support"));
  parts.push(row("identification", "identified", ORD_IDENT + 2,
    `CAST(CASE WHEN off_support = 0 THEN 1 ELSE 0 END AS NUMERIC)`,
    `'1 when every cell has both arms. Read this row before any estimate below it'`, "support"));

  // 2. the weighted design
  parts.push(row("design", "n_treated", ORD_DESIGN, `CAST(n1 AS NUMERIC)`, `'observed'`, "arms"));
  parts.push(row("design", "n_control", ORD_DESIGN + 1, `CAST(n0 AS NUMERIC)`, `'observed'`, "arms"));
  parts.push(row("design", "events_treated", ORD_DESIGN + 2, `CAST(e1 AS NUMERIC)`, `'observed, unweighted'`, "arms"));
  parts.push(row("design", "events_control", ORD_DESIGN + 3, `CAST(e0 AS NUMERIC)`, `'observed, unweighted'`, "arms"));
  parts.push(row("design", "weighted_n_treated", ORD_DESIGN + 4, d.roundN(`sw1`, 5), `'SUM of the treated weights'`, "arms"));
  parts.push(row("design", "weighted_n_control", ORD_DESIGN + 5, d.roundN(`sw0`, 5), `'SUM of the control weights'`, "arms"));

  // 3. the effect, with the sandwich interval
  const seRd = `SQRT(v1 + v0)`;
  parts.push(row("effect", "weighted_risk_treated", ORD_EFFECT, d.roundN(`mu1`, 5),
    `'Hajek ratio SUM(wY)/SUM(w) - NOT SUM(wY)/n, which can leave [0,1]'`, "arms", d.roundN(`SQRT(v1)`, 5)));
  parts.push(row("effect", "weighted_risk_control", ORD_EFFECT + 1, d.roundN(`mu0`, 5),
    `'Hajek ratio'`, "arms", d.roundN(`SQRT(v0)`, 5)));
  parts.push(row("effect", "risk_difference", ORD_EFFECT + 2, d.roundN(`mu1 - mu0`, 5),
    `'sandwich variance of the Hajek ratio, weights_treated_as_known. It is CONSERVATIVE: propagating the score estimation generally narrows this interval rather than widening it'`,
    "arms", d.roundN(seRd, 5), d.roundN(`mu1 - mu0 - 1.96 * (${seRd})`, 5), d.roundN(`mu1 - mu0 + 1.96 * (${seRd})`, 5)));
  const seLrr = `SQRT(v1 / NULLIF(POWER(mu1, 2), 0) + v0 / NULLIF(POWER(mu0, 2), 0))`;
  parts.push(row("effect", "risk_ratio", ORD_EFFECT + 3, d.roundN(`mu1 / NULLIF(mu0, 0)`, 5),
    `'delta method on the log scale, weights_treated_as_known'`, "arms",
    d.roundN(seLrr, 5),
    d.roundN(`EXP(LN(NULLIF(mu1 / NULLIF(mu0, 0), 0)) - 1.96 * (${seLrr}))`, 5),
    d.roundN(`EXP(LN(NULLIF(mu1 / NULLIF(mu0, 0), 0)) + 1.96 * (${seLrr}))`, 5)));
  const seLor = `SQRT(v1 / NULLIF(POWER(mu1 * (1 - mu1), 2), 0) + v0 / NULLIF(POWER(mu0 * (1 - mu0), 2), 0))`;
  const orExpr = `(mu1 / NULLIF(1 - mu1, 0)) / NULLIF(mu0 / NULLIF(1 - mu0, 0), 0)`;
  parts.push(row("effect", "odds_ratio", ORD_EFFECT + 4, d.roundN(orExpr, 5),
    `'delta method on the log scale, weights_treated_as_known'`, "arms",
    d.roundN(seLor, 5),
    d.roundN(`EXP(LN(NULLIF(${orExpr}, 0)) - 1.96 * (${seLor}))`, 5),
    d.roundN(`EXP(LN(NULLIF(${orExpr}, 0)) + 1.96 * (${seLor}))`, 5)));

  /* 4. THE UNADJUSTED CONTRAST, beside the weighted one. Weighting is a claim
   * that the crude number is wrong, and a reader cannot judge the claim
   * without both. */
  parts.push(row("unadjusted", "risk_treated", ORD_UNADJ, d.roundN(`u1`, 5), `'crude, unweighted'`, "unadj"));
  parts.push(row("unadjusted", "risk_control", ORD_UNADJ + 1, d.roundN(`u0`, 5), `'crude, unweighted'`, "unadj"));
  parts.push(row("unadjusted", "risk_difference", ORD_UNADJ + 2, d.roundN(`u1 - u0`, 5), `'crude, unweighted'`, "unadj"));
  parts.push([
    `  SELECT ${STR(`'unadjusted'`)}, ${STR(`'weighting_shift'`)}, ${INT(String(ORD_UNADJ + 3))},`,
    `         ${d.roundN(`(a.mu1 - a.mu0) - (u.u1 - u.u0)`, 5)}, ${NULLN}, ${NULLN}, ${NULLN},`,
    `         ${STR(`'how far weighting moved the risk difference. A large shift is not evidence the weighted number is better - it is evidence the two populations differ, which is what makes the identification row above the one that decides whether either can be reported'`)}`,
    `  FROM arms a CROSS JOIN unadj u`,
  ]);

  /* 5. THE INTERVAL LEFT THE RANGE. A Wald interval on a risk difference can
   * run outside [-1, 1], which is impossible for a difference of probabilities
   * and means the normal approximation has broken down. Reported UNCLAMPED:
   * clamping would hide exactly the signal that it should not be trusted. */
  parts.push(row("diagnostic", "rd_interval_within_range", ORD_DIAG,
    `CAST(CASE WHEN mu1 - mu0 - 1.96 * (${seRd}) >= -1 AND mu1 - mu0 + 1.96 * (${seRd}) <= 1 THEN 1 ELSE 0 END AS NUMERIC)`,
    `CASE WHEN mu1 - mu0 - 1.96 * (${seRd}) < -1 OR mu1 - mu0 + 1.96 * (${seRd}) > 1` +
    ` THEN 'THE INTERVAL LEAVES [-1, 1], which a difference of two probabilities cannot. The normal approximation has broken down at this sample size. It is reported UNCLAMPED on purpose - clamping would hide the one signal saying the interval should not be trusted'` +
    ` ELSE 'the interval stays inside the range a risk difference can occupy' END`, "arms"));

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: read the IDENTIFICATION rows first. Every estimate below them is`);
  L.push(`-- arithmetic that succeeds whether or not the estimand exists.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `iptw${suffix}`,
    title: `IPTW outcome model${suffix ? ` (${an.label})` : ""}`,
    subtitle: `Hajek weighted effect + sandwich interval (nothing deferred to SAS)`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); outcome "${clid}", horizon ${an.horizonDays}d.`,
      `Treated ${p.treatedLevel} vs reference ${p.referenceLevel}; score cells: ${p.cellAxes.map((c) => c.label).join(" x ")}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasIptwOutcome(ctx: SasCtx, an: IptwOutcomeAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_iptw${suffix}`);
  const cohT = ctx.finalCohort;
  const p = plan(ctx, an);
  const lbl = an.label.replace(/"/g, "'");
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const limits = iptwOutcomeLimitations(an, listSystem);

  const lines: string[] = [
    ...header(spec, `${num}_iptw${suffix}.sas`, [
      `IPTW outcome model for "${an.label}" - the weighted effect estimate.`,
      `The Hajek weighted risk per arm and its SANDWICH variance, both closed`,
      `form, so nothing here is deferred to SAS.`,
      `READ THE IDENTIFICATION ROWS FIRST. Subjects in covariate cells that are`,
      `entirely one arm have no counterpart at any weight: the arithmetic still`,
      `succeeds, and the estimand does not exist.`,
      `Twin of the SQL iptw program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("iptw_outcome", iptwOutcomeParity(an, {
      referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
      cellAxes: p.cellAxes.map((c) => c.axis), settingFilter: setting.stamped,
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...IPTW_OUTCOME_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
  );
  if (!p.emittable) {
    lines.push(`/* NOT EMITTED: ${an.doublyRobust ? `doubly-robust estimation is not built yet - see readiness.` : `the exposure or the propensity covariates did not resolve.`} */`, ``);
    return { path: `sas/${num}_iptw${suffix}.sas`, language: "sas", title: `${num} IPTW outcome (not emitted)`, content: lines.join("\n") };
  }

  const evT = ctx.evOf(clid);
  const enrT = ctx.tbl("040_enroll");
  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` : setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
  const washLines = [...(sasSettingCond ? [sasSettingCond] : []), ...sasWindowConds(an.washout, "e")];

  lines.push(
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- washout -> the AT-RISK analysis set --------------------*/`,
    `/* The score is estimated HERE, not on the whole cohort: weights built in one`,
    `   population and applied in another describe neither. */`,
    `proc sql;`,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join ${evT} as e on e.enrolid = a.enrolid`,
    `  where 1 = 1`,
    ...washLines.map((l, i) => `    ${l}${i === washLines.length - 1 ? ";" : ""}`),
    ...(washLines.length === 0 ? [`  ;`] : []),
    ``,
    `  create table work._${num}_atrisk as`,
    `  select a.* from ${cohT} as a`,
    `  where a.enrolid not in (select enrolid from work._${num}_prev);`,
    ``,
    `  create table work._${num}_cases as`,
    `  select distinct a.enrolid`,
    `  from work._${num}_atrisk as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    `    and e.svcdate > a.index_date`,
    `    and e.svcdate <= a.index_date + ${an.horizonDays}`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  ;`,
    ``,
    `  create table work._${num}_s0 as`,
    `  select a.enrolid, a.index_date,`,
    ...(viaNdcS ? [`         n.pattern as arm length=40,`] : [`         a.index_code as arm length=40,`]),
    `         b.dobyr, b.sex, b.region, b.plantyp,`,
    `         b.dtstart as seg_start, b.dtend as seg_end,`,
    `         case when c.enrolid is not null then 1 else 0 end as y`,
    `  from work._${num}_atrisk as a`,
    ...(viaNdcS ? [`  left join ${ndcT} as n on n.ndcnum = a.index_code`] : []),
    `  left join work._${num}_cases as c on c.enrolid = a.enrolid`,
    `  left join ${enrT} as b`,
    `    on  b.enrolid = a.enrolid`,
    `    and b.dtstart <= a.index_date;`,
    `quit;`,
    ``,
    `proc sort data=work._${num}_s0;`,
    `  by enrolid descending seg_start descending seg_end;`,
    `run;`,
    ``,
    `data work._${num}_subj;`,
    `  set work._${num}_s0;`,
    `  by enrolid;`,
    `  if first.enrolid;`,
    `  length cell $200 ${p.cellAxes.map((_, j) => `_c${j}`).join(" ")} $40;`,
    `  treated = (arm = "${sq(p.treatedLevel)}");`,
    ...p.cellAxes.flatMap((a, j) => [
      `  /* cell axis: ${cmt(a.label)} (${a.axis}) */`,
      ...cellAssignSas(a.axis, `_c${j}`).map((l) => `  ${l}`),
    ]),
    `  cell = ${p.cellAxes.map((_, j) => `strip(_c${j})`).join(` || '|' || `)};`,
    `  if arm not in ("${sq(p.referenceLevel)}", "${sq(p.treatedLevel)}") then delete;`,
    `  keep enrolid treated cell y;`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "subjects in the analysis set", [`sum(y) as events`, `sum(treated) as treated`]),
    ``,
    ...psSasSteps({ num, subjT: `work._${num}_subj`, estimand: an.estimand, stabilized: an.stabilized, trim: an.trim }),
    ``,
    ...hajekSasSteps({ num, subjT: `work._${num}_psk`, outcomeCol: "y" }),
    ``,
    ...hajekSasAnchor({ num, subjT: `work._${num}_psk`, outcomeCol: "y" }),
    ``,
    `/*-------------------- support, and the crude contrast ------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_support as`,
    `  select sum(case when n_control_cell = 0 or n_treated_cell = 0 then n_cell else 0 end) as off_support,`,
    `         count(*) as n_cells, sum(n_cell) as n_total`,
    `  from work._${num}_pscell;`,
    ``,
    `  create table work._${num}_unadj as`,
    `  select mean(case when treated = 1 then y else . end) as u1,`,
    `         mean(case when treated = 0 then y else . end) as u0`,
    `  from work._${num}_psk;`,
    `quit;`,
    ``,
    `/*-------------------- assemble the result table ------------------------------*/`,
    `data ${outT};`,
    `  length measure $20 component $16 statistic $32 method $360;`,
    `  set work._${num}_arms;`,
    `  if _n_ = 1 then set work._${num}_support;`,
    `  if _n_ = 1 then set work._${num}_unadj;`,
    `  measure = "${MEASURE}"; se = .; ci_low = .; ci_high = .;`,
    `  /* IDENTIFICATION FIRST. Everything below is arithmetic that succeeds`,
    `     whether or not the estimand exists. */`,
    `  component='identification'; statistic='subjects_off_support'; ord=${ORD_IDENT}; estimate=off_support;`,
    `  if off_support > 0 then method='THE EFFECT IS NOT IDENTIFIED FOR THESE SUBJECTS. They sit in covariate cells that are entirely one arm, so they have no counterpart at ANY weight. The estimate below is still computed - the arithmetic does not fail - but it describes a population that does not exist';`,
    `  else method='every covariate cell contains both arms, so the weighted contrast is identified across the whole analysis set';`,
    `  output;`,
    `  statistic='analysis_set_n'; ord=${ORD_IDENT + 1}; estimate=n_total;`,
    `  method='subjects at risk after the washout. The score is estimated HERE, not on the whole cohort'; output;`,
    `  statistic='identified'; ord=${ORD_IDENT + 2}; estimate=(off_support = 0);`,
    `  method='1 when every cell has both arms. Read this row before any estimate below it'; output;`,
    `  component='design'; statistic='n_treated'; ord=${ORD_DESIGN}; estimate=n1; method='observed'; output;`,
    `  statistic='n_control'; ord=${ORD_DESIGN + 1}; estimate=n0; output;`,
    `  statistic='events_treated'; ord=${ORD_DESIGN + 2}; estimate=e1; method='observed, unweighted'; output;`,
    `  statistic='events_control'; ord=${ORD_DESIGN + 3}; estimate=e0; output;`,
    `  statistic='weighted_n_treated'; ord=${ORD_DESIGN + 4}; estimate=round(sw1, 0.00001); method='SUM of the treated weights'; output;`,
    `  statistic='weighted_n_control'; ord=${ORD_DESIGN + 5}; estimate=round(sw0, 0.00001); method='SUM of the control weights'; output;`,
    `  component='effect';`,
    `  statistic='weighted_risk_treated'; ord=${ORD_EFFECT}; estimate=round(mu1, 0.00001); se=round(sqrt(v1), 0.00001);`,
    `  method='Hajek ratio SUM(wY)/SUM(w) - NOT SUM(wY)/n, which can leave [0,1]'; output;`,
    `  statistic='weighted_risk_control'; ord=${ORD_EFFECT + 1}; estimate=round(mu0, 0.00001); se=round(sqrt(v0), 0.00001);`,
    `  method='Hajek ratio'; output;`,
    `  _serd = sqrt(v1 + v0);`,
    `  statistic='risk_difference'; ord=${ORD_EFFECT + 2}; estimate=round(mu1 - mu0, 0.00001); se=round(_serd, 0.00001);`,
    `  ci_low = round(mu1 - mu0 - 1.96 * _serd, 0.00001);`,
    `  ci_high = round(mu1 - mu0 + 1.96 * _serd, 0.00001);`,
    `  method='sandwich variance of the Hajek ratio, weights_treated_as_known. It is CONSERVATIVE: propagating the score estimation generally narrows this interval'; output;`,
    `  if mu0 > 0 and mu1 > 0 then do;`,
    `    _selrr = sqrt(v1/(mu1**2) + v0/(mu0**2));`,
    `    statistic='risk_ratio'; ord=${ORD_EFFECT + 3}; estimate=round(mu1/mu0, 0.00001); se=round(_selrr, 0.00001);`,
    `    ci_low = round(exp(log(mu1/mu0) - 1.96*_selrr), 0.00001);`,
    `    ci_high = round(exp(log(mu1/mu0) + 1.96*_selrr), 0.00001);`,
    `    method='delta method on the log scale, weights_treated_as_known'; output;`,
    `    _selor = sqrt(v1/((mu1*(1-mu1))**2) + v0/((mu0*(1-mu0))**2));`,
    `    _or = (mu1/(1-mu1)) / (mu0/(1-mu0));`,
    `    statistic='odds_ratio'; ord=${ORD_EFFECT + 4}; estimate=round(_or, 0.00001); se=round(_selor, 0.00001);`,
    `    ci_low = round(exp(log(_or) - 1.96*_selor), 0.00001);`,
    `    ci_high = round(exp(log(_or) + 1.96*_selor), 0.00001);`,
    `    output;`,
    `  end;`,
    `  se=.; ci_low=.; ci_high=.;`,
    `  component='unadjusted'; statistic='risk_treated'; ord=${ORD_UNADJ}; estimate=round(u1, 0.00001); method='crude, unweighted'; output;`,
    `  statistic='risk_control'; ord=${ORD_UNADJ + 1}; estimate=round(u0, 0.00001); output;`,
    `  statistic='risk_difference'; ord=${ORD_UNADJ + 2}; estimate=round(u1 - u0, 0.00001); output;`,
    `  statistic='weighting_shift'; ord=${ORD_UNADJ + 3}; estimate=round((mu1 - mu0) - (u1 - u0), 0.00001);`,
    `  method='how far weighting moved the risk difference. A large shift is not evidence the weighted number is better - it is evidence the two populations differ'; output;`,
    `  component='diagnostic'; statistic='rd_interval_within_range'; ord=${ORD_DIAG};`,
    `  estimate = (mu1 - mu0 - 1.96*_serd >= -1 and mu1 - mu0 + 1.96*_serd <= 1);`,
    `  if mu1 - mu0 - 1.96*_serd < -1 or mu1 - mu0 + 1.96*_serd > 1 then`,
    `    method='THE INTERVAL LEAVES [-1, 1], which a difference of two probabilities cannot. The normal approximation has broken down at this sample size. It is reported UNCLAMPED on purpose';`,
    `  else method='the interval stays inside the range a risk difference can occupy';`,
    `  output;`,
    `  keep measure component statistic ord estimate se ci_low ci_high method;`,
    `run;`,
    ``,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "IPTW outcome model: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_iptw${suffix}.sas`,
    language: "sas",
    title: `${num} IPTW outcome${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const iptwOutcomeModule: AnalysisModule<IptwOutcomeAnalysis> = {
  analysisKind: "iptw_outcome",
  stampKind: "iptw_outcome",
  resultSlug: "iptw",
  sql: sqlIptwOutcome,
  sas: sasIptwOutcome,
};
