/**
 * Standardization (g-formula) and the doubly-robust AIPW estimator.
 *
 * Wave 7.1 named doubly-robust estimation as a GAP rather than a refusal, on
 * the grounds that with categorical covariates the outcome regression is also
 * saturated and the whole thing is closed form. This closes it, and it turns
 * out to close something more useful than a missing feature.
 *
 * WHAT IS COMPUTED, all of it in both twins. SAS-PRIMARY: nothing.
 *   - the per-cell outcome means m1 and m0, which ARE the saturated outcome
 *     regression's fitted values;
 *   - the G-FORMULA: standardize those cell means over the population's own
 *     covariate distribution;
 *   - AIPW, the augmented estimator, computed independently from the score and
 *     the residuals;
 *   - the influence-function variance and its Wald interval.
 *
 * THE IDENTITY. With BOTH models saturated over the SAME cells, AIPW is
 * algebraically identical to the g-formula — the augmentation term cancels the
 * weighting exactly. Two completely different expressions, one over cells and
 * one over subjects, must produce the same number. The module emits the
 * residual as a row, and the harness pins it. This is the cheapest strong check
 * in the whole causal family: no reference value, no second fixture, just two
 * routes to one quantity.
 *
 * AND THE THING THIS MODULE EXISTS FOR. The g-formula CANNOT BE COMPUTED in a
 * cell that holds only one arm: m1 has no treated subjects to average, or m0
 * has no controls. That is not a diagnostic about a distribution, it is a term
 * that does not exist. So this estimator is forced to restrict itself to the
 * cells where the contrast is defined, and to say how many people that drops.
 *
 * On Gold Case A that restriction is the whole story:
 *
 *     IPTW over all 8 subjects        risk difference  -37/84 = -0.44048
 *     g-formula over the 5 where
 *       the contrast exists           risk difference   -7/10 = -0.70000
 *
 * Same data, same score, same outcome. The two differ by 0.25952 — more than
 * half the size of either estimate — and the entire difference is the three
 * subjects in single-arm cells that inverse-probability weighting silently
 * carried along at weight 1. Neither number is a mistake. The IPTW module
 * reports its identification row first for exactly this reason, and this module
 * is what that row is warning about.
 *
 * Ref: Robins Math Modelling 1986;7:1393 (the g-formula); Robins, Rotnitzky &
 * Zhao JASA 1994;89:846 (AIPW); Hernan & Robins, Causal Inference (2020) ch.13.
 */
import type { GFormulaAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import { cmt, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import {
  axisStamp,
  bandOccupancySasSteps,
  bandOccupancySqlCte,
  bandSlots,
  bandingStamp,
  cellAssignSas,
  cellExprSql,
  coarseningNotes,
  cutLit,
  oneArmBandCountSas,
  oneArmBandCountSql,
  resolveCellAxes,
  sasBandedValueStep,
  type CellAxis,
} from "../banding-core";
import {
  eValueSas,
  eValueSql,
  nearestNullLimitSas,
  nearestNullLimitSql,
  EVALUE_METHOD_NOTES,
  EVALUE_POINT_METHOD,
} from "../evalue-core";
import {
  outcomeSettingPlan,
  parityStamp,
  gFormulaLimitations,
  gFormulaParity,
  stratLabel,
  G_FORMULA_METHOD_NOTES,
} from "../parity";

const MEASURE = "g_formula";
const ORD_SUPPORT = 0;
const ORD_CELLS = 10;
const ORD_G = 20;
const ORD_AIPW = 30;
const ORD_IDENT = 40;
const ORD_COARSEN = 500;
const ORD_EVALUE = 600;

function plan(ctx: SqlCtx | SasCtx, an: GFormulaAnalysis) {
  const spec = ctx.spec;
  const gv = spec.groupVars.find((g) => g.id === an.groupVarId);
  const referenceLevel = gv?.referenceLevel ?? gv?.levels[0] ?? "";
  const treatedLevel = gv?.levels.find((l) => l !== referenceLevel) ?? "";
  const cellAxes: CellAxis[] = resolveCellAxes(spec.baseline, an.covariateIds, an.bandings);
  return {
    gv, referenceLevel, treatedLevel, cellAxes,
    slots: bandSlots(cellAxes),
    bandings: bandingStamp(an.bandings, spec.baseline),
    eValue: an.eValue ? { includeLimit: an.eValue.includeLimit !== false } : undefined,
    emittable: Boolean(gv && referenceLevel && treatedLevel && cellAxes.length > 0),
  };
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlGFormula(ctx: SqlCtx, an: GFormulaAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_gform${suffix}`;
  const p = plan(ctx, an);
  const L: string[] = [];
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);

  L.push(`-- ${parityStamp("g_formula", gFormulaParity(an, {
    referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
    cellAxes: p.cellAxes.map(axisStamp), settingFilter: setting.stamped, bandings: p.bandings,
  }))}`);
  const limits = gFormulaLimitations(an, listSystem);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of G_FORMULA_METHOD_NOTES) L.push(`--   * ${note}`);
  const coarse = coarseningNotes(p.cellAxes);
  if (coarse.length > 0) {
    L.push(`-- REVIEW - DECLARED COARSENING (always emitted when a covariate is banded):`);
    for (const note of coarse) L.push(`--   * ${note}`);
  }
  if (p.eValue) {
    L.push(`-- REVIEW - E-VALUE (always emitted when one is requested):`);
    for (const note of EVALUE_METHOD_NOTES) L.push(`--   * ${note}`);
  }

  if (!p.emittable) {
    L.push(`-- NOT EMITTED: the exposure or the covariates did not resolve.`);
    return {
      slug: `gform${suffix}`, title: `Standardization${suffix ? ` (${an.label})` : ""}`,
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
  C.push(`atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),`);
  C.push(`demo AS (`);
  C.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
  C.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
  C.push(`  FROM atrisk c`);
  C.push(`  JOIN ${ctx.t("enrollment_detail")} en ON en.enrolid = c.enrolid AND en.dtstart <= c.index_date`);
  C.push(`),`);
  C.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  C.push(`cases AS (`);
  C.push(`  SELECT DISTINCT c.enrolid FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid`);
  C.push(`   AND a.event_date > c.index_date AND a.event_date <= ${d.offset("c.index_date", an.horizonDays)}`);
  C.push(`),`);
  if (p.slots.length > 0) {
    C.push(`subj0 AS (   -- each CELL AXIS as its own column, so a COARSENED axis is reportable`);
    C.push(`  SELECT c.enrolid,`);
    C.push(`         CASE WHEN ${armExpr} = '${q(p.treatedLevel)}' THEN 1 ELSE 0 END AS treated,`);
    p.cellAxes.forEach((a, j) => C.push(`         ${cellExprSql(a, ctx)} AS ax${j},`));
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
    C.push(`subj AS (`);
    C.push(`  SELECT s.*, ${p.cellAxes.map((_a, j) => `ax${j}`).join(` || '|' || `)} AS cell FROM subj0 s`);
    C.push(`),`);
  } else {
    C.push(`subj AS (`);
    C.push(`  SELECT c.enrolid,`);
    C.push(`         CASE WHEN ${armExpr} = '${q(p.treatedLevel)}' THEN 1 ELSE 0 END AS treated,`);
    C.push(`         ${p.cellAxes.map((a) => cellExprSql(a, ctx)).join(` || '|' || `)} AS cell,`);
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
  }
  /* THE SATURATED OUTCOME REGRESSION. m1 and m0 are the cell means, which ARE
   * the fitted values of a model with a term for every cell-by-arm
   * combination. Both are NULL when the cell has no such subject, and that
   * NULL is the point: it is a term that does not exist, not a small number. */
  C.push(`cellm AS (`);
  C.push(`  SELECT cell,`);
  C.push(`         COUNT(*) AS n_cell,`);
  C.push(`         SUM(treated) AS n_t,`);
  C.push(`         COUNT(*) - SUM(treated) AS n_c,`);
  C.push(`         SUM(treated) * 1.0 / COUNT(*) AS e,`);
  C.push(`         -- the saturated outcome regression's fitted values. NULL when`);
  C.push(`         -- the cell has nobody in that arm: an undefined TERM, not a`);
  C.push(`         -- small number, and no imputation belongs here.`);
  C.push(`         AVG(CASE WHEN treated = 1 THEN y END) AS m1,`);
  C.push(`         AVG(CASE WHEN treated = 0 THEN y END) AS m0`);
  C.push(`  FROM subj GROUP BY cell`);
  C.push(`),`);
  C.push(`ok_cells AS (SELECT * FROM cellm WHERE n_t > 0 AND n_c > 0),`);
  C.push(`support AS (`);
  C.push(`  SELECT (SELECT COUNT(*) FROM cellm) AS n_cells,`);
  C.push(`         (SELECT COUNT(*) FROM ok_cells) AS n_cells_both,`);
  C.push(`         (SELECT SUM(n_cell) FROM cellm) AS n_total,`);
  C.push(`         (SELECT COALESCE(SUM(n_cell), 0) FROM ok_cells) AS n_restricted`);
  C.push(`),`);
  /* THE G-FORMULA: standardize the cell means over the covariate distribution
   * of the RESTRICTED population — the one in which the contrast exists. */
  C.push(`gf AS (`);
  C.push(`  SELECT SUM(n_cell * m1) / NULLIF(SUM(n_cell), 0) AS g1,`);
  C.push(`         SUM(n_cell * m0) / NULLIF(SUM(n_cell), 0) AS g0`);
  C.push(`  FROM ok_cells`);
  C.push(`),`);
  /* AIPW, computed INDEPENDENTLY over subjects. Under double saturation this
   * must equal the g-formula above; the identity row below is the check. */
  C.push(`aipw_i AS (   -- the per-subject influence contributions`);
  C.push(`  SELECT s.enrolid,`);
  C.push(`         s.treated * s.y / NULLIF(c.e, 0)`);
  C.push(`           - (s.treated - c.e) / NULLIF(c.e, 0) * c.m1 AS a1_i,`);
  C.push(`         (1 - s.treated) * s.y / NULLIF(1 - c.e, 0)`);
  C.push(`           + (s.treated - c.e) / NULLIF(1 - c.e, 0) * c.m0 AS a0_i`);
  C.push(`  FROM subj s JOIN ok_cells c ON c.cell = s.cell`);
  C.push(`),`);
  C.push(`aipw AS (SELECT AVG(a1_i) AS a1, AVG(a0_i) AS a0, COUNT(*) AS n_used FROM aipw_i),`);
  /* The influence-function variance: (1/n^2) SUM (psi - mean)^2, plus the
   * covariance term, because the two arms share subjects. */
  C.push(`aipw_v AS (`);
  C.push(`  SELECT SUM(POWER(i.a1_i - a.a1, 2)) / NULLIF(POWER(MAX(a.n_used), 2), 0) AS v1,`);
  C.push(`         SUM(POWER(i.a0_i - a.a0, 2)) / NULLIF(POWER(MAX(a.n_used), 2), 0) AS v0,`);
  C.push(`         -- the arms are NOT independent here: every subject contributes`);
  C.push(`         -- to both influence functions, so the covariance is a real term`);
  C.push(`         -- and dropping it would overstate the interval.`);
  C.push(`         SUM((i.a1_i - a.a1) * (i.a0_i - a.a0)) / NULLIF(POWER(MAX(a.n_used), 2), 0) AS cov10`);
  C.push(`  FROM aipw_i i CROSS JOIN aipw a`);
  C.push(`)${p.slots.length > 0 || p.eValue ? `,` : ``}`);
  if (p.slots.length > 0) {
    /* Occupancy over the FULL at-risk set, not the restricted one: a band that
     * lost an arm is exactly why the restriction happened, and reporting it
     * after the restriction would hide the cause. */
    C.push(...bandOccupancySqlCte({ from: "subj", slots: p.slots, alias: "bocc" }));
    if (!p.eValue) C[C.length - 1] = C[C.length - 1].replace(/,\s*$/, "");
  }
  if (p.eValue) {
    /* THE RISK RATIO AND ITS INTERVAL, on the g-formula/AIPW scale. The
     * g-formula rows above carry point estimates only, because under double
     * saturation AIPW IS the g-formula and one interval covers both. The
     * E-value needs a RATIO interval, so it is derived here by the delta method
     * from the same influence-function variances - INCLUDING the covariance,
     * since every subject contributes to both arms. */
    const seLogRr = `SQRT(GREATEST(v1 / NULLIF(POWER(a1, 2), 0) + v0 / NULLIF(POWER(a0, 2), 0) - 2 * cov10 / NULLIF(a1 * a0, 0), 0))`;
    const rrE = `a1 / NULLIF(a0, 0)`;
    C.push(`ev0 AS (   -- the risk ratio and its delta-method interval, for the E-value`);
    C.push(`  SELECT ${rrE} AS rr,`);
    C.push(`         EXP(LN(NULLIF(${rrE}, 0)) - 1.96 * (${seLogRr})) AS rr_lo,`);
    C.push(`         EXP(LN(NULLIF(${rrE}, 0)) + 1.96 * (${seLogRr})) AS rr_hi`);
    C.push(`  FROM aipw CROSS JOIN aipw_v`);
    C.push(`),`);
    C.push(`ev AS (   -- and the limit NEAREST THE NULL, computed ONCE`);
    C.push(`  -- NULL when the interval covers 1: there is no limit on the far side`);
    C.push(`  -- to bound, and the row below says what that means.`);
    C.push(`  SELECT rr, rr_lo, rr_hi, ${nearestNullLimitSql(`rr_lo`, `rr_hi`)} AS rr_near`);
    C.push(`  FROM ev0`);
    C.push(`)`);
  }

  const NULLN = `CAST(NULL AS NUMERIC)`;
  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;

  L.push(d.createTableAs(out));
  L.push(...C);
  L.push(`SELECT '${MEASURE}' AS measure, component, statistic, ord, estimate, se, ci_low, ci_high, method`);
  L.push(`FROM (`);
  const parts: string[][] = [];
  const row = (component: string, statistic: string, ord: number, est: string, method: string, from: string, se = NULLN, lo = NULLN, hi = NULLN) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${statistic}'`)} AS statistic,`,
    `         ${INT(String(ord))} AS ord, ${est} AS estimate, ${se} AS se,`,
    `         ${lo} AS ci_low, ${hi} AS ci_high, ${STR(method)} AS method`,
    `  FROM ${from}`,
  ];

  /* 1. THE RESTRICTION, first — because it defines what population every number
   * below describes, and it is not the one in the attrition table. */
  parts.push(row("support", "cells_total", ORD_SUPPORT, `CAST(n_cells AS NUMERIC)`, `'covariate cells'`, "support"));
  parts.push(row("support", "cells_with_both_arms", ORD_SUPPORT + 1, `CAST(n_cells_both AS NUMERIC)`,
    `'the g-formula needs BOTH a treated mean and a control mean in a cell. In a single-arm cell one of them is not a small number - it is a term with nothing to average'`, "support"));
  parts.push(row("support", "subjects_in_analysis", ORD_SUPPORT + 2, `CAST(n_restricted AS NUMERIC)`,
    `'the population these estimates describe'`, "support"));
  parts.push(row("support", "subjects_excluded", ORD_SUPPORT + 3, `CAST(n_total - n_restricted AS NUMERIC)`,
    `CASE WHEN n_total > n_restricted` +
    ` THEN 'EXCLUDED because their covariate cell holds only one arm. The estimates below describe a DIFFERENT population from the cohort - narrower, and defined by who happened to have a counterpart. Inverse-probability weighting does not exclude them; it carries them at weight 1 and reports a number for a population that includes people with no comparison group'` +
    ` ELSE 'every subject sits in a cell with both arms, so no restriction was needed' END`, "support"));

  // 2. the cell-level fitted values
  parts.push(row("cells", "restricted_population_share", ORD_CELLS, d.roundN(`n_restricted * 1.0 / NULLIF(n_total, 0)`, 5),
    `'share of the at-risk set these estimates cover'`, "support"));

  // 3. the g-formula
  parts.push(row("g_formula", "standardized_risk_treated", ORD_G, d.roundN(`g1`, 5),
    `'cell means standardized over the restricted population own covariate distribution'`, "gf"));
  parts.push(row("g_formula", "standardized_risk_control", ORD_G + 1, d.roundN(`g0`, 5), `'as above'`, "gf"));
  parts.push(row("g_formula", "risk_difference", ORD_G + 2, d.roundN(`g1 - g0`, 5), `'g-formula contrast'`, "gf"));
  parts.push(row("g_formula", "risk_ratio", ORD_G + 3, d.roundN(`g1 / NULLIF(g0, 0)`, 5), `'g-formula contrast'`, "gf"));

  // 4. AIPW, computed independently, with the influence-function interval
  const seRd = `SQRT(GREATEST(v1 + v0 - 2 * cov10, 0))`;
  parts.push([
    `  SELECT ${STR(`'aipw'`)}, ${STR(`'risk_treated'`)}, ${INT(String(ORD_AIPW))},`,
    `         ${d.roundN(`a.a1`, 5)}, ${d.roundN(`SQRT(GREATEST(v.v1, 0))`, 5)}, ${NULLN}, ${NULLN},`,
    `         ${STR(`'augmented estimator, computed over SUBJECTS rather than cells'`)}`,
    `  FROM aipw a CROSS JOIN aipw_v v`,
  ]);
  parts.push([
    `  SELECT ${STR(`'aipw'`)}, ${STR(`'risk_control'`)}, ${INT(String(ORD_AIPW + 1))},`,
    `         ${d.roundN(`a.a0`, 5)}, ${d.roundN(`SQRT(GREATEST(v.v0, 0))`, 5)}, ${NULLN}, ${NULLN},`,
    `         ${STR(`'augmented estimator'`)}`,
    `  FROM aipw a CROSS JOIN aipw_v v`,
  ]);
  parts.push([
    `  SELECT ${STR(`'aipw'`)}, ${STR(`'risk_difference'`)}, ${INT(String(ORD_AIPW + 2))},`,
    `         ${d.roundN(`a.a1 - a.a0`, 5)}, ${d.roundN(seRd, 5)},`,
    `         ${d.roundN(`a.a1 - a.a0 - 1.96 * (${seRd})`, 5)}, ${d.roundN(`a.a1 - a.a0 + 1.96 * (${seRd})`, 5)},`,
    `         ${STR(`'influence-function variance, INCLUDING the covariance between arms - every subject contributes to both, so dropping it would overstate the interval'`)}`,
    `  FROM aipw a CROSS JOIN aipw_v v`,
  ]);
  /* A ZERO STANDARD ERROR IS A BOUNDARY, NOT PRECISION. It arises when every
   * subject in an arm has the same outcome, which at these sample sizes is a
   * small-sample accident rather than certainty. */
  parts.push([
    `  SELECT ${STR(`'aipw'`)}, ${STR(`'zero_variance_arm'`)}, ${INT(String(ORD_AIPW + 3))},`,
    `         ${INT(`CASE WHEN v.v1 <= 0 OR v.v0 <= 0 THEN 1 ELSE 0 END`)}, ${NULLN}, ${NULLN}, ${NULLN},`,
    `         CASE WHEN v.v1 <= 0 OR v.v0 <= 0`,
    `              THEN ${STR(`'AN ARM HAS ZERO ESTIMATED VARIANCE. That is a BOUNDARY, not precision: every subject in it had the same outcome, which at this sample size is an accident rather than certainty. Any interval built on it is too narrow, and a standard error of 0 must not be read as an exact estimate'`)}`,
    `              ELSE ${STR(`'both arms have positive estimated variance'`)} END`,
    `  FROM aipw_v v`,
  ]);

  /* 5. THE IDENTITY. Under double saturation the augmentation cancels the
   * weighting exactly, so these two must agree. Two expressions, one over
   * cells and one over subjects, checking each other with nothing shipped. */
  parts.push([
    `  SELECT ${STR(`'identity'`)}, ${STR(`'aipw_minus_g_formula'`)}, ${INT(String(ORD_IDENT))},`,
    `         ${d.roundN(`(a.a1 - a.a0) - (g.g1 - g.g0)`, 8)}, ${NULLN}, ${NULLN}, ${NULLN},`,
    `         CASE WHEN ABS((a.a1 - a.a0) - (g.g1 - g.g0)) < 1e-9`,
    `              THEN ${STR(`'HOLDS: with both the score and the outcome model saturated over the same cells, the augmentation term cancels the weighting exactly and AIPW IS the g-formula. These are two different expressions - one over cells, one over subjects - and their agreement is a check on both'`)}`,
    `              ELSE ${STR(`'BROKEN: AIPW and the g-formula disagree. Under double saturation they are algebraically identical, so one of the two is wrong - do not report either'`)} END`,
    `  FROM aipw a CROSS JOIN gf g`,
  ]);

  if (p.slots.length > 0) {
    const bandedAxes = p.cellAxes.filter((a) => a.kind === "banded");
    parts.push(row("coarsening", "bands_declared", ORD_COARSEN, `CAST(${p.slots.length} AS NUMERIC)`,
      `'${q(bandedAxes.map((a) => `${stratLabel(a.label)} cut at ${(a.cutPoints ?? []).map(cutLit).join("/")}`).join("; "))}. A continuous covariate has no cells until it is banded, and these are the cells standardized over. CONFOUNDING WITHIN A BAND IS UNCONTROLLED, and a WIDER band controls LESS'`,
      "bocc"));
    p.slots.forEach((s) => {
      parts.push(row("coarsening", `band_${s.ord}_treated`, ORD_COARSEN + s.ord * 2 - 1, `CAST(b${s.ord}_t AS NUMERIC)`,
        `'treated subjects in band ${q(s.label)} of ${q(stratLabel(s.covariateLabel))}, over the whole at-risk set'`, "bocc"));
      parts.push(row("coarsening", `band_${s.ord}_control`, ORD_COARSEN + s.ord * 2, `CAST(b${s.ord}_c AS NUMERIC)`,
        `CASE WHEN (b${s.ord}_t + b${s.ord}_c) > 0 AND (b${s.ord}_t = 0 OR b${s.ord}_c = 0)` +
        ` THEN 'THIS BAND HOLDS ONE ARM ONLY (band ${q(s.label)}). Its cells cannot be standardized and are dropped by the restriction above - the coarsening is what created the band those subjects are stranded in'` +
        ` ELSE 'both arms occupy this band' END`, "bocc"));
    });
    parts.push(row("coarsening", "bands_with_one_arm", ORD_COARSEN + p.slots.length * 2 + 1,
      `CAST(${oneArmBandCountSql(p.slots)} AS NUMERIC)`,
      `CASE WHEN (${oneArmBandCountSql(p.slots)}) > 0` +
      ` THEN 'BANDS WITH NO COUNTERPART. Read this beside subjects_excluded: a wider cut would have kept them and controlled less; a narrower one would have dropped more'` +
      ` ELSE 'every non-empty band holds both arms' END`, "bocc"));
  }

  if (p.eValue) {
    parts.push(row("e_value", "risk_ratio_e_value", ORD_EVALUE, d.roundN(eValueSql(`rr`), 5),
      `'${q(EVALUE_POINT_METHOD)}. It bounds the RESTRICTED population these estimates describe, not the cohort'`, "ev"));
    if (p.eValue.includeLimit) {
      const nearest = `rr_near`;
      parts.push(row("e_value", "limit_nearest_null", ORD_EVALUE + 1, d.roundN(nearest, 5),
        `CASE WHEN (${nearest}) IS NULL` +
        ` THEN 'THE INTERVAL CROSSES THE NULL, so there is no limit on the far side to bound. The data are already compatible with no effect'` +
        ` ELSE 'the confidence limit closer to 1, from the delta method on the influence-function variances INCLUDING the between-arm covariance' END`, "ev"));
      parts.push(row("e_value", "limit_e_value", ORD_EVALUE + 2,
        `COALESCE(${d.roundN(eValueSql(nearest), 5)}, CAST(1 AS NUMERIC))`,
        `CASE WHEN (${nearest}) IS NULL` +
        ` THEN 'ONE BY CONSTRUCTION, AND THAT IS THE FINDING: the interval crosses the null, so NO unmeasured confounding at all is needed - THE DATA ARE COMPATIBLE WITH NO EFFECT. Do not read this 1 as a small number on the same scale as the point E-value above it'` +
        ` ELSE 'the minimum confounding strength that would move the confidence limit nearest the null to 1. Usually the more informative of the pair' END`, "ev"));
    }
  }

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: the SUPPORT rows define which population these estimates describe.`);
  L.push(`-- It is narrower than the cohort whenever any covariate cell holds one arm.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `gform${suffix}`,
    title: `Standardization${suffix ? ` (${an.label})` : ""}`,
    subtitle: `g-formula + AIPW, with the identity between them checked`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); outcome "${clid}", horizon ${an.horizonDays}d.`,
      `Treated ${p.treatedLevel} vs reference ${p.referenceLevel}; cells: ${p.cellAxes.map((c) => c.label).join(" x ")}.`,
      ...(p.slots.length > 0
        ? [`COARSENED: ${p.cellAxes.filter((a) => a.kind === "banded").map((a) => `${a.label} cut at ${(a.cutPoints ?? []).map(cutLit).join("/")}`).join("; ")}. Confounding WITHIN a band is uncontrolled.`]
        : []),
      ...(p.eValue ? [`E-value requested${p.eValue.includeLimit ? ` (point and confidence limit)` : ` (point estimate only)`}.`] : []),
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasGFormula(ctx: SasCtx, an: GFormulaAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_gform${suffix}`);
  const cohT = ctx.finalCohort;
  const p = plan(ctx, an);
  const lbl = an.label.replace(/"/g, "'");
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const limits = gFormulaLimitations(an, listSystem);

  const lines: string[] = [
    ...header(spec, `${num}_gform${suffix}.sas`, [
      `Standardization (g-formula) and AIPW for "${an.label}".`,
      `Both models are SATURATED over the same covariate cells, so both are`,
      `closed form and the augmentation cancels the weighting exactly: AIPW IS`,
      `the g-formula here, and the program checks that rather than assuming it.`,
      `READ THE SUPPORT ROWS FIRST. The g-formula cannot be computed in a cell`,
      `holding one arm - that is an undefined term, not a small number - so`,
      `these estimates describe a NARROWER population than the cohort.`,
      `Twin of the SQL gform program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("g_formula", gFormulaParity(an, {
      referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
      cellAxes: p.cellAxes.map(axisStamp), settingFilter: setting.stamped, bandings: p.bandings,
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...G_FORMULA_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
  );
  const coarseSas = coarseningNotes(p.cellAxes);
  if (coarseSas.length > 0) {
    lines.push(`/* REVIEW - DECLARED COARSENING (always emitted when a covariate is banded):`, ...coarseSas.map((n) => `   * ${cmt(n)}`), `*/`);
  }
  if (p.eValue) {
    lines.push(`/* REVIEW - E-VALUE (always emitted when one is requested):`, ...EVALUE_METHOD_NOTES.map((n) => `   * ${cmt(n)}`), `*/`);
  }
  lines.push(
    ``,
    ...INCLUDE_SETUP,
  );
  if (!p.emittable) {
    lines.push(`/* NOT EMITTED: the exposure or the covariates did not resolve. */`, ``);
    return { path: `sas/${num}_gform${suffix}.sas`, language: "sas", title: `${num} Standardization (not emitted)`, content: lines.join("\n") };
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
    `/*-------------------- washout -> at-risk, and the outcome --------------------*/`,
    `proc sql;`,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid from ${cohT} as a`,
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
    `  select distinct a.enrolid from work._${num}_atrisk as a`,
    `  inner join ${evT} as e`,
    `    on e.enrolid = a.enrolid and e.svcdate > a.index_date`,
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
    `  left join ${enrT} as b on b.enrolid = a.enrolid and b.dtstart <= a.index_date;`,
    `quit;`,
    ``,
    `proc sort data=work._${num}_s0; by enrolid descending seg_start descending seg_end; run;`,
    ``,
    `data work._${num}_subj;`,
    `  set work._${num}_s0;`,
    `  by enrolid;`,
    `  if first.enrolid;`,
    `  length cell $200 ${p.cellAxes.map((_, j) => `_c${j}`).join(" ")} $40;`,
    ...(p.slots.length > 0 ? [`  length ${p.cellAxes.map((_a, j) => `ax${j}`).join(" ")} $40;`] : []),
    `  treated = (arm = "${sq(p.treatedLevel)}");`,
    ...(p.slots.length > 0 ? sasBandedValueStep().map((l) => `  ${l}`) : []),
    ...p.cellAxes.flatMap((a, j) => [
      `  /* cell axis: ${cmt(a.label)} (${a.kind}) */`,
      ...cellAssignSas(a, `_c${j}`).map((l) => `  ${l}`),
    ]),
    `  cell = ${p.cellAxes.map((_, j) => `strip(_c${j})`).join(` || '|' || `)};`,
    ...(p.slots.length > 0 ? p.cellAxes.map((_a, j) => `  ax${j} = _c${j};`) : []),
    `  if arm not in ("${sq(p.referenceLevel)}", "${sq(p.treatedLevel)}") then delete;`,
    `  keep enrolid treated cell y${p.slots.length > 0 ? ` ${p.cellAxes.map((_a, j) => `ax${j}`).join(" ")}` : ""};`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "subjects in the analysis set", [`sum(y) as events`]),
    ``,
    `/*----------------------------------------------------------------------------`,
    `  The SATURATED outcome regression. m1 and m0 are the cell means, which ARE`,
    `  its fitted values. Both are MISSING when the cell holds nobody in that arm:`,
    `  an undefined term, not a small number, and no imputation belongs here.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_cellm as`,
    `  select cell, count(*) as n_cell, sum(treated) as n_t,`,
    `         count(*) - sum(treated) as n_c,`,
    `         sum(treated) / count(*) as e,`,
    `         mean(case when treated = 1 then y else . end) as m1,`,
    `         mean(case when treated = 0 then y else . end) as m0`,
    `  from work._${num}_subj group by cell;`,
    ``,
    `  create table work._${num}_ok as`,
    `  select * from work._${num}_cellm where n_t > 0 and n_c > 0;`,
    ``,
    `  create table work._${num}_support as`,
    `  select (select count(*) from work._${num}_cellm) as n_cells,`,
    `         (select count(*) from work._${num}_ok) as n_cells_both,`,
    `         (select sum(n_cell) from work._${num}_cellm) as n_total,`,
    `         (select coalesce(sum(n_cell), 0) from work._${num}_ok) as n_restricted`,
    `  from work._${num}_cellm (obs=1);`,
    ``,
    `  create table work._${num}_gf as`,
    `  select sum(n_cell * m1) / sum(n_cell) as g1,`,
    `         sum(n_cell * m0) / sum(n_cell) as g0`,
    `  from work._${num}_ok;`,
    ``,
    `  create table work._${num}_ai as`,
    `  select s.enrolid,`,
    `         s.treated * s.y / c.e - (s.treated - c.e) / c.e * c.m1 as a1_i,`,
    `         (1 - s.treated) * s.y / (1 - c.e) + (s.treated - c.e) / (1 - c.e) * c.m0 as a0_i`,
    `  from work._${num}_subj as s`,
    `  inner join work._${num}_ok as c on c.cell = s.cell;`,
    ``,
    `  create table work._${num}_aipw as`,
    `  select mean(a1_i) as a1, mean(a0_i) as a0, count(*) as n_used from work._${num}_ai;`,
    `quit;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_aiv as`,
    `  select sum((i.a1_i - a.a1)**2) / (a.n_used**2) as v1,`,
    `         sum((i.a0_i - a.a0)**2) / (a.n_used**2) as v0,`,
    `         /* the arms are NOT independent: every subject contributes to both`,
    `            influence functions, so dropping the covariance would overstate`,
    `            the interval */`,
    `         sum((i.a1_i - a.a1) * (i.a0_i - a.a0)) / (a.n_used**2) as cov10`,
    `  from work._${num}_ai as i, work._${num}_aipw as a;`,
    `quit;`,
    ``,
    ...(p.slots.length > 0 ? bandOccupancySasSteps({ num, from: `work._${num}_subj`, slots: p.slots }) : []),
    `/*-------------------- assemble the result table ------------------------------*/`,
    `data ${outT};`,
    `  length measure $20 component $12 statistic $32 method $420;`,
    `  set work._${num}_support;`,
    `  if _n_ = 1 then set work._${num}_gf;`,
    `  if _n_ = 1 then set work._${num}_aipw;`,
    `  if _n_ = 1 then set work._${num}_aiv;`,
    `  measure = "${MEASURE}"; se = .; ci_low = .; ci_high = .;`,
    `  component='support'; statistic='cells_total'; ord=${ORD_SUPPORT}; estimate=n_cells; method='covariate cells'; output;`,
    `  statistic='cells_with_both_arms'; ord=${ORD_SUPPORT + 1}; estimate=n_cells_both;`,
    `  method='the g-formula needs BOTH a treated mean and a control mean in a cell. In a single-arm cell one of them is not a small number - it is a term with nothing to average'; output;`,
    `  statistic='subjects_in_analysis'; ord=${ORD_SUPPORT + 2}; estimate=n_restricted;`,
    `  method='the population these estimates describe'; output;`,
    `  statistic='subjects_excluded'; ord=${ORD_SUPPORT + 3}; estimate=n_total - n_restricted;`,
    `  if n_total > n_restricted then method='EXCLUDED because their covariate cell holds only one arm. The estimates below describe a DIFFERENT population from the cohort - narrower, and defined by who happened to have a counterpart';`,
    `  else method='every subject sits in a cell with both arms, so no restriction was needed'; output;`,
    `  component='cells'; statistic='restricted_population_share'; ord=${ORD_CELLS};`,
    `  estimate = round(n_restricted / n_total, 0.00001);`,
    `  method='share of the at-risk set these estimates cover'; output;`,
    `  component='g_formula'; statistic='standardized_risk_treated'; ord=${ORD_G}; estimate=round(g1, 0.00001);`,
    `  method='cell means standardized over the restricted population own covariate distribution'; output;`,
    `  statistic='standardized_risk_control'; ord=${ORD_G + 1}; estimate=round(g0, 0.00001); method='as above'; output;`,
    `  statistic='risk_difference'; ord=${ORD_G + 2}; estimate=round(g1 - g0, 0.00001); method='g-formula contrast'; output;`,
    `  statistic='risk_ratio'; ord=${ORD_G + 3};`,
    `  if g0 > 0 then estimate = round(g1 / g0, 0.00001); else estimate = .; output;`,
    `  component='aipw'; statistic='risk_treated'; ord=${ORD_AIPW}; estimate=round(a1, 0.00001);`,
    `  se = round(sqrt(max(v1, 0)), 0.00001);`,
    `  method='augmented estimator, computed over SUBJECTS rather than cells'; output;`,
    `  statistic='risk_control'; ord=${ORD_AIPW + 1}; estimate=round(a0, 0.00001);`,
    `  se = round(sqrt(max(v0, 0)), 0.00001); method='augmented estimator'; output;`,
    `  _serd = sqrt(max(v1 + v0 - 2*cov10, 0));`,
    `  statistic='risk_difference'; ord=${ORD_AIPW + 2}; estimate=round(a1 - a0, 0.00001); se=round(_serd, 0.00001);`,
    `  ci_low = round(a1 - a0 - 1.96*_serd, 0.00001);`,
    `  ci_high = round(a1 - a0 + 1.96*_serd, 0.00001);`,
    `  method='influence-function variance, INCLUDING the covariance between arms'; output;`,
    `  se=.; ci_low=.; ci_high=.;`,
    `  statistic='zero_variance_arm'; ord=${ORD_AIPW + 3}; estimate=(v1 <= 0 or v0 <= 0);`,
    `  if v1 <= 0 or v0 <= 0 then method='AN ARM HAS ZERO ESTIMATED VARIANCE. That is a BOUNDARY, not precision: every subject in it had the same outcome, which at this sample size is an accident rather than certainty';`,
    `  else method='both arms have positive estimated variance'; output;`,
    `  component='identity'; statistic='aipw_minus_g_formula'; ord=${ORD_IDENT};`,
    `  estimate = round((a1 - a0) - (g1 - g0), 0.00000001);`,
    `  if abs((a1 - a0) - (g1 - g0)) < 1e-9 then method='HOLDS: with both the score and the outcome model saturated over the same cells, the augmentation term cancels the weighting exactly and AIPW IS the g-formula';`,
    `  else method='BROKEN: AIPW and the g-formula disagree. Under double saturation they are algebraically identical, so one of the two is wrong - do not report either';`,
    `  output;`,
    `  keep measure component statistic ord estimate se ci_low ci_high method;`,
    `run;`,
    ``,
  );

  const extraSets: string[] = [];
  if (p.slots.length > 0) {
    const bandedAxes = p.cellAxes.filter((a) => a.kind === "banded");
    lines.push(
      `data work._${num}_co;`,
      `  length measure $20 component $12 statistic $32 method $420;`,
      `  set work._${num}_bocc;`,
      `  measure = "${MEASURE}"; component = 'coarsening'; se = .; ci_low = .; ci_high = .;`,
      `  statistic='bands_declared'; ord=${ORD_COARSEN}; estimate=${p.slots.length};`,
      `  method='${sq(bandedAxes.map((a) => `${stratLabel(a.label)} cut at ${(a.cutPoints ?? []).map(cutLit).join("/")}`).join("; "))}. A continuous covariate has no cells until it is banded, and these are the cells standardized over. CONFOUNDING WITHIN A BAND IS UNCONTROLLED, and a WIDER band controls LESS'; output;`,
      ...p.slots.flatMap((s) => [
        `  statistic='band_${s.ord}_treated'; ord=${ORD_COARSEN + s.ord * 2 - 1}; estimate=b${s.ord}_t;`,
        `  method='treated subjects in band ${sq(s.label)} of ${sq(stratLabel(s.covariateLabel))}, over the whole at-risk set'; output;`,
        `  statistic='band_${s.ord}_control'; ord=${ORD_COARSEN + s.ord * 2}; estimate=b${s.ord}_c;`,
        `  if (b${s.ord}_t + b${s.ord}_c) > 0 and (b${s.ord}_t = 0 or b${s.ord}_c = 0) then method='THIS BAND HOLDS ONE ARM ONLY (band ${sq(s.label)}). Its cells cannot be standardized and are dropped by the restriction above - the coarsening is what created the band those subjects are stranded in';`,
        `  else method='both arms occupy this band'; output;`,
      ]),
      `  statistic='bands_with_one_arm'; ord=${ORD_COARSEN + p.slots.length * 2 + 1};`,
      `  estimate = ${oneArmBandCountSas(p.slots)};`,
      `  if estimate > 0 then method='BANDS WITH NO COUNTERPART. Read this beside subjects_excluded: a wider cut would have kept them and controlled less; a narrower one would have dropped more';`,
      `  else method='every non-empty band holds both arms'; output;`,
      `  keep measure component statistic ord estimate se ci_low ci_high method;`,
      `run;`,
      ``,
    );
    extraSets.push(`work._${num}_co`);
  }

  if (p.eValue) {
    const nearestSas = nearestNullLimitSas(`_rr_lo`, `_rr_hi`);
    lines.push(
      `/*-------------------- the E-VALUE, on the standardized risk ratio ------------*/`,
      `data work._${num}_ev;`,
      `  length measure $20 component $12 statistic $32 method $420;`,
      `  set work._${num}_aipw;`,
      `  if _n_ = 1 then set work._${num}_aiv;`,
      `  measure = "${MEASURE}"; component = 'e_value'; se = .; ci_low = .; ci_high = .;`,
      `  /* the ratio interval comes from the SAME influence-function variances as`,
      `     the risk-difference interval above, INCLUDING the between-arm`,
      `     covariance - every subject contributes to both arms */`,
      `  if a0 > 0 and a1 > 0 then do;`,
      `    _rr = a1 / a0;`,
      `    _selrr = sqrt(max(v1/(a1**2) + v0/(a0**2) - 2*cov10/(a1*a0), 0));`,
      `    _rr_lo = exp(log(_rr) - 1.96*_selrr);`,
      `    _rr_hi = exp(log(_rr) + 1.96*_selrr);`,
      `  end;`,
      `  else do; _rr = .; _rr_lo = .; _rr_hi = .; end;`,
      `  statistic='risk_ratio_e_value'; ord=${ORD_EVALUE}; estimate=round(${eValueSas(`_rr`)}, 0.00001);`,
      `  method='${sq(EVALUE_POINT_METHOD)}. It bounds the RESTRICTED population these estimates describe, not the cohort'; output;`,
      ...(p.eValue.includeLimit
        ? [
            `  _near = ${nearestSas};`,
            `  statistic='limit_nearest_null'; ord=${ORD_EVALUE + 1}; estimate=round(_near, 0.00001);`,
            `  if _near = . then method='THE INTERVAL CROSSES THE NULL, so there is no limit on the far side to bound. The data are already compatible with no effect';`,
            `  else method='the confidence limit closer to 1, from the delta method on the influence-function variances INCLUDING the between-arm covariance'; output;`,
            `  statistic='limit_e_value'; ord=${ORD_EVALUE + 2};`,
            `  if _near = . then estimate = 1; else estimate = round(${eValueSas(`_near`)}, 0.00001);`,
            `  if _near = . then method='ONE BY CONSTRUCTION, AND THAT IS THE FINDING: the interval crosses the null, so NO unmeasured confounding at all is needed - THE DATA ARE COMPATIBLE WITH NO EFFECT. Do not read this 1 as a small number on the same scale as the point E-value above it';`,
            `  else method='the minimum confounding strength that would move the confidence limit nearest the null to 1. Usually the more informative of the pair'; output;`,
          ]
        : []),
      `  keep measure component statistic ord estimate se ci_low ci_high method;`,
      `run;`,
      ``,
    );
    extraSets.push(`work._${num}_ev`);
  }

  if (extraSets.length > 0) {
    lines.push(
      `data ${outT};`,
      `  set ${outT}${extraSets.map((t) => ` ${t}`).join("")};`,
      `run;`,
      ``,
    );
  }

  lines.push(
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Standardization and AIPW: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_gform${suffix}.sas`,
    language: "sas",
    title: `${num} Standardization${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const gFormulaModule: AnalysisModule<GFormulaAnalysis> = {
  analysisKind: "g_formula",
  stampKind: "g_formula",
  resultSlug: "gform",
  sql: sqlGFormula,
  sas: sasGFormula,
};
