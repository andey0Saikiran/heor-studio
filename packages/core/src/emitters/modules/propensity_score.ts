/**
 * Propensity-score adjustment by inverse-probability weighting.
 *
 * THE FAMILY POSES A PROBLEM THE OTHERS DID NOT. A propensity score is a fitted
 * logistic probability, so the rule this project arrived at in Wave 6.4 —
 * "needs Newton" carves out the coefficient, it does not refuse the model —
 * would make the score SAS-primary. But unlike Cox, where everything AROUND the
 * coefficient is closed form, here everything downstream DEPENDS on it. Carve
 * out the score and the SQL twin has nothing left to compute.
 *
 * The SATURATED design resolves it (see emitters/ps-core.ts): a logistic model
 * over categorical cells has as many parameters as cells, so its
 * maximum-likelihood fitted probability in each cell IS the observed treated
 * fraction. Readiness refuses a continuous covariate rather than emitting a
 * pipeline of NULLs, and the emitted SAS checks the saturated claim against
 * PROC LOGISTIC rather than asserting it.
 *
 * EXECUTED IN BOTH TWINS: the score, ATE/ATT weights, stabilization, trimming,
 * the effective sample size, the positivity diagnostics, and the standardized
 * differences BEFORE and AFTER weighting. SAS-PRIMARY: nothing — the second
 * family in this bundle where the SQL twin is complete.
 *
 * THE POSITIVITY ROWS ARE THE POINT. Weighting builds two pseudo-populations,
 * one from each arm, and both are meant to represent the same population. A
 * DIFFERENCE in their sizes proves a violation — it can only come from cells
 * that are entirely one arm. The converse is false, which this module claimed
 * until a second fixture configuration disproved it: scored on region x sex,
 * Gold Case A has four subjects off support and a pseudo-population gap of
 * exactly zero. `subjects_off_support` is the authoritative row.
 *
 * Verified vs Gold Case A, scoring on region: cell scores 1/3, 1/3, 1/2 and 1 —
 * the last because region 4 holds two treated subjects and no control. The
 * treated pseudo-population is 10 and the control one is 8, and the gap of 2 IS
 * those two subjects. ATE weights 3, 3, 2, 1, 1 and 1.5, 1.5, 1.5, 1.5, 2;
 * effective sample sizes 25/6 and 64/13 against an n of 5 in each arm.
 *
 * AND ONE RESULT WORTH READING BEFORE TRUSTING ANY OF IT: weighting on region
 * makes the age imbalance WORSE, from an SMD of -0.63246 to -0.76234. That is
 * not a defect. Adjusting for one covariate does not balance others and can
 * degrade them, and a tool that only ever showed balance improving would be
 * hiding the most important thing it can tell an analyst.
 */
import type { PropensityScoreAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, sq, INCLUDE_SETUP } from "../sas-base";
import { psSqlCtes, psSasSteps, psSasAnchor } from "../ps-core";
import {
  balanceCovariates,
  outcomeSettingPlan,
  parityStamp,
  propensityScoreLimitations,
  propensityScoreParity,
  stratLabel,
  PROPENSITY_SCORE_METHOD_NOTES,
  REGION_LABELS,
  SEX_LABELS,
  type BalanceCovariate,
} from "../parity";

const MEASURE = "propensity_score";
const ORD_DESIGN = 0;
const ORD_POSITIVITY = 10;
const ORD_WEIGHTS = 20;
const ORD_BALANCE = 30;

/** The categorical axes a saturated cell can be built from. Readiness refuses
 *  anything else, so this map and that list must agree. */
type CellAxis = "sex" | "region" | "plan_type" | "year";

function plan(ctx: SqlCtx | SasCtx, an: PropensityScoreAnalysis) {
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
  const { supported, unsupported } = balanceCovariates(
    spec.baseline,
    an.balanceCovariateIds,
    new Set(spec.analyses.filter((x) => x.kind === "comorbidity_index" && x.enabled).map((x) => x.id)),
  );
  return {
    gv, referenceLevel, treatedLevel, cellAxes,
    balance: supported,
    droppedBalance: unsupported.map((u) => u.id),
    emittable: Boolean(gv && referenceLevel && treatedLevel && cellAxes.length > 0 && an.method === "iptw"),
  };
}

/** SQL expression for one cell axis. */
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

const balCol = (c: BalanceCovariate) => (c.axis === "age" ? "age_val" : c.axis === "sex" ? "sex_male" : "cci_val");

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlPropensityScore(ctx: SqlCtx, an: PropensityScoreAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_ps${suffix}`;
  const p = plan(ctx, an);
  const L: string[] = [];

  L.push(`-- ${parityStamp("propensity_score", propensityScoreParity(an, {
    referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
    cellAxes: p.cellAxes.map((c) => c.axis), balanceTerms: p.balance.map((c) => stratLabel(c.label)),
  }))}`);
  const limits = propensityScoreLimitations(an, p.droppedBalance);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of PROPENSITY_SCORE_METHOD_NOTES) L.push(`--   * ${note}`);

  if (!p.emittable) {
    L.push(`-- NOT EMITTED: ${an.method !== "iptw" ? `method "${an.method}" is not emitted — see readiness for why.` : `the exposure or the propensity covariates did not resolve.`}`);
    return {
      slug: `ps${suffix}`, title: `Propensity score${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted", extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`], body: L.join("\n"),
    };
  }

  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `c.index_code`;
  const needCci = p.balance.some((b) => b.axis === "comorbidity_index");

  const C: string[] = [];
  C.push(`WITH cohort AS (SELECT enrolid, index_date, index_code FROM ${wp}_cohort),`);
  C.push(`demo AS (   -- enrollment segment in force at (or latest before) index; rn=1 wins`);
  C.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
  C.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
  C.push(`  FROM cohort c`);
  C.push(`  JOIN ${ctx.t("enrollment_detail")} en ON en.enrolid = c.enrolid AND en.dtstart <= c.index_date`);
  C.push(`),`);
  C.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  C.push(`subj AS (   -- one row per cohort member: arm, CELL, and the balance covariates`);
  C.push(`  SELECT c.enrolid,`);
  C.push(`         CASE WHEN ${armExpr} = '${q(p.treatedLevel)}' THEN 1 ELSE 0 END AS treated,`);
  /* THE CELL. Concatenated in a FIXED axis order, which the parity stamp
   * records: two twins that agreed on the covariates but spelled the cell
   * differently would produce different scores from the same data, and no
   * comparison of NUMBERS would say so. */
  C.push(`         ${p.cellAxes.map((a) => cellExprSql(a.axis, ctx)).join(` || '|' || `)} AS cell,`);
  C.push(`         CAST(${d.year("c.index_date")} - dm.dobyr AS DOUBLE PRECISION) AS age_val,`);
  C.push(`         CASE WHEN dm.sex = '1' THEN 1.0 ELSE 0.0 END AS sex_male${needCci ? `,` : ``}`);
  if (needCci) C.push(`         CAST(0 AS DOUBLE PRECISION) AS cci_val`);
  C.push(`  FROM cohort c`);
  C.push(`  LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid`);
  if (viaNdc) {
    C.push(`  JOIN ${wp}_ndc_lookup nl`);
    C.push(`    ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = c.index_code`);
  }
  C.push(`  WHERE ${armExpr} IN ('${q(p.referenceLevel)}', '${q(p.treatedLevel)}')`);
  C.push(`),`);
  C.push(...psSqlCtes({ subjectsCte: "subj", estimand: an.estimand, stabilized: an.stabilized, trim: an.trim }));

  /* Positivity, from the cell table: a cell with no control (or no treated)
   * contributes to one pseudo-population and not the other. */
  C.push(`pos AS (`);
  C.push(`  SELECT SUM(CASE WHEN n_control_cell = 0 THEN 1 ELSE 0 END) AS cells_all_treated,`);
  C.push(`         SUM(CASE WHEN n_treated_cell = 0 THEN 1 ELSE 0 END) AS cells_all_control,`);
  C.push(`         SUM(CASE WHEN n_control_cell = 0 OR n_treated_cell = 0 THEN n_cell ELSE 0 END) AS subjects_off_support,`);
  C.push(`         COUNT(*) AS n_cells, MIN(ps) AS min_ps, MAX(ps) AS max_ps`);
  C.push(`  FROM pscell`);
  C.push(`),`);
  C.push(`wsum AS (`);
  C.push(`  SELECT SUM(CASE WHEN treated = 1 THEN w ELSE 0 END) AS sw_t,`);
  C.push(`         SUM(CASE WHEN treated = 0 THEN w ELSE 0 END) AS sw_c,`);
  C.push(`         SUM(CASE WHEN treated = 1 THEN w * w ELSE 0 END) AS sw2_t,`);
  C.push(`         SUM(CASE WHEN treated = 0 THEN w * w ELSE 0 END) AS sw2_c,`);
  C.push(`         SUM(CASE WHEN treated = 1 THEN 1 ELSE 0 END) AS n_t,`);
  C.push(`         SUM(CASE WHEN treated = 0 THEN 1 ELSE 0 END) AS n_c,`);
  C.push(`         MAX(w) AS max_w,`);
  C.push(`         SUM(CASE WHEN w IS NULL THEN 1 ELSE 0 END) AS n_undefined_weight,`);
  C.push(`         SUM(trimmed) AS n_trimmed`);
  C.push(`  FROM psw`);
  C.push(`),`);
  /* Balance, per covariate: unweighted and weighted standardized differences,
   * in two passes because the weighted variance needs its own mean first. */
  p.balance.forEach((b, i) => {
    const col = balCol(b);
    C.push(`bm${i} AS (`);
    C.push(`  SELECT SUM(CASE WHEN treated = 1 THEN w ELSE 0 END) AS sw_t,`);
    C.push(`         SUM(CASE WHEN treated = 0 THEN w ELSE 0 END) AS sw_c,`);
    C.push(`         SUM(CASE WHEN treated = 1 THEN w * w ELSE 0 END) AS sw2_t,`);
    C.push(`         SUM(CASE WHEN treated = 0 THEN w * w ELSE 0 END) AS sw2_c,`);
    C.push(`         SUM(CASE WHEN treated = 1 THEN w * ${col} ELSE 0 END) AS swx_t,`);
    C.push(`         SUM(CASE WHEN treated = 0 THEN w * ${col} ELSE 0 END) AS swx_c,`);
    C.push(`         AVG(CASE WHEN treated = 1 THEN ${col} END) AS m_t,`);
    C.push(`         AVG(CASE WHEN treated = 0 THEN ${col} END) AS m_c,`);
    C.push(`         VAR_SAMP(CASE WHEN treated = 1 THEN ${col} END) AS v_t,`);
    C.push(`         VAR_SAMP(CASE WHEN treated = 0 THEN ${col} END) AS v_c`);
    C.push(`  FROM psk`);
    C.push(`),`);
    C.push(`bal${i} AS (`);
    C.push(`  SELECT b.m_t, b.m_c, b.v_t, b.v_c,`);
    C.push(`         b.swx_t / NULLIF(b.sw_t, 0) AS wm_t,`);
    C.push(`         b.swx_c / NULLIF(b.sw_c, 0) AS wm_c,`);
    /* The FREQUENCY-WEIGHTED sample variance (Austin 2009), not
     * SUM(w(x-xbar)^2)/SUM(w). The naive form shrinks the denominator of every
     * standardized difference, which makes a weighted analysis look better
     * balanced than it is — in the direction nobody checks. */
    C.push(`         (b.sw_t / NULLIF(b.sw_t * b.sw_t - b.sw2_t, 0))`);
    C.push(`           * SUM(CASE WHEN k.treated = 1 THEN k.w * POWER(k.${col} - b.swx_t / NULLIF(b.sw_t, 0), 2) ELSE 0 END) AS wv_t,`);
    C.push(`         (b.sw_c / NULLIF(b.sw_c * b.sw_c - b.sw2_c, 0))`);
    C.push(`           * SUM(CASE WHEN k.treated = 0 THEN k.w * POWER(k.${col} - b.swx_c / NULLIF(b.sw_c, 0), 2) ELSE 0 END) AS wv_c`);
    C.push(`  FROM psk k CROSS JOIN bm${i} b`);
    C.push(`  GROUP BY b.m_t, b.m_c, b.v_t, b.v_c, b.sw_t, b.sw_c, b.sw2_t, b.sw2_c, b.swx_t, b.swx_c`);
    C.push(`),`);
  });
  C[C.length - 1] = C[C.length - 1].replace(/,\s*$/, "");

  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;

  L.push(d.createTableAs(out));
  L.push(...C);
  L.push(`SELECT '${MEASURE}' AS measure, component, term, statistic, ord, estimate, method`);
  L.push(`FROM (`);
  const parts: string[][] = [];
  const row = (component: string, term: string, statistic: string, ord: number, est: string, method: string, from: string) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${q(term)}'`)} AS term,`,
    `         ${STR(`'${statistic}'`)} AS statistic, ${INT(String(ord))} AS ord,`,
    `         ${est} AS estimate, ${STR(method)} AS method`,
    `  FROM ${from}`,
  ];
  const cmp = `${p.treatedLevel} vs ${p.referenceLevel}`;

  parts.push(row("design", cmp, "n_treated", ORD_DESIGN, `CAST(n_t AS NUMERIC)`, `'observed'`, "wsum"));
  parts.push(row("design", cmp, "n_control", ORD_DESIGN + 1, `CAST(n_c AS NUMERIC)`, `'observed'`, "wsum"));
  parts.push(row("design", cmp, "n_cells", ORD_DESIGN + 2, `CAST(n_cells AS NUMERIC)`,
    `'covariate cells. The score is the treated fraction in each, which is the MAXIMUM-LIKELIHOOD estimate because a logistic model over cells is saturated'`, "pos"));
  parts.push(row("design", cmp, "min_score", ORD_DESIGN + 3, d.roundN(`min_ps`, 5), `'observed'`, "pos"));
  parts.push(row("design", cmp, "max_score", ORD_DESIGN + 4, d.roundN(`max_ps`, 5), `'observed'`, "pos"));

  /* POSITIVITY — the rows this module exists to produce. */
  parts.push(row("positivity", cmp, "cells_with_no_control", ORD_POSITIVITY, `CAST(cells_all_treated AS NUMERIC)`,
    `CASE WHEN cells_all_treated > 0 THEN 'these cells have a score of exactly 1: nobody in them is untreated, so there is no counterfactual to weight toward' ELSE 'every cell contains a control' END`, "pos"));
  parts.push(row("positivity", cmp, "cells_with_no_treated", ORD_POSITIVITY + 1, `CAST(cells_all_control AS NUMERIC)`,
    `CASE WHEN cells_all_control > 0 THEN 'these cells have a score of exactly 0' ELSE 'every cell contains a treated subject' END`, "pos"));
  parts.push(row("positivity", cmp, "subjects_off_support", ORD_POSITIVITY + 2, `CAST(subjects_off_support AS NUMERIC)`,
    `'people in cells that are entirely one arm. They cannot be balanced by any weighting, because the arm they would be compared with is empty'`, "pos"));
  parts.push(row("positivity", cmp, "pseudo_population_treated", ORD_POSITIVITY + 3, d.roundN(`sw_t`, 5),
    `'SUM of the treated weights: the size of the population the treated arm is being asked to represent'`, "wsum"));
  parts.push(row("positivity", cmp, "pseudo_population_control", ORD_POSITIVITY + 4, d.roundN(`sw_c`, 5),
    `'SUM of the control weights: the same population, reconstructed from the other arm'`, "wsum"));
  /* THE DIAGNOSTIC. Under a saturated score these two are exact integers and
   * they agree if and only if every cell has both arms. */
  parts.push(row("positivity", cmp, "pseudo_population_gap", ORD_POSITIVITY + 5, d.roundN(`ABS(sw_t - sw_c)`, 5),
    `CASE WHEN ABS(sw_t - sw_c) > 1e-9` +
    ` THEN 'THE TWO PSEUDO-POPULATIONS ARE DIFFERENT SIZES. Both are meant to represent the same population, so this gap PROVES a positivity violation - it can only arise from cells that are entirely one arm. Weighting cannot fix it; it is a limit of the data'` +
    ` ELSE 'the two pseudo-populations are the same size. That is NOT evidence that positivity holds - the cells containing treated members and the cells containing controls can hold equally many people by accident. Read subjects_off_support above' END`, "wsum"));
  parts.push(row("positivity", cmp, "subjects_with_undefined_weight", ORD_POSITIVITY + 6, `CAST(n_undefined_weight AS NUMERIC)`,
    `'a weight of 1/0 is undefined, not large. These rows are NULL rather than summed into a total that would look finite'`, "wsum"));

  parts.push(row("weights", cmp, "sum_treated", ORD_WEIGHTS, d.roundN(`sw_t`, 5), `'${an.estimand.toUpperCase()}${an.stabilized ? `, stabilized` : ``}'`, "wsum"));
  parts.push(row("weights", cmp, "sum_control", ORD_WEIGHTS + 1, d.roundN(`sw_c`, 5), `'${an.estimand.toUpperCase()}${an.stabilized ? `, stabilized` : ``}'`, "wsum"));
  parts.push(row("weights", cmp, "max_weight", ORD_WEIGHTS + 2, d.roundN(`max_w`, 5),
    `'one subject standing in for many is the failure mode weighting is prone to; compare this against the arm sizes above'`, "wsum"));
  /* Kish's effective sample size: how many EQUALLY weighted subjects carry the
   * same information. Always <= n, with equality only when every weight is the
   * same, so it is the honest denominator for a weighted analysis. */
  parts.push(row("weights", cmp, "effective_n_treated", ORD_WEIGHTS + 3, d.roundN(`POWER(sw_t, 2) / NULLIF(sw2_t, 0)`, 5),
    `'Kish effective sample size: how many EQUALLY weighted subjects carry the same information. Never more than the actual n, and equal to it only when every weight is the same'`, "wsum"));
  parts.push(row("weights", cmp, "effective_n_control", ORD_WEIGHTS + 4, d.roundN(`POWER(sw_c, 2) / NULLIF(sw2_c, 0)`, 5),
    `'Kish effective sample size for the control arm'`, "wsum"));
  parts.push(row("weights", cmp, "subjects_trimmed", ORD_WEIGHTS + 5, `CAST(n_trimmed AS NUMERIC)`,
    an.trim > 0
      ? `'excluded by the score trim [${an.trim}, ${1 - an.trim}]. A trimmed analysis estimates an effect in a DIFFERENT population than the cohort describes, which is why the count is reported rather than absorbed'`
      : `'no trimming requested'`, "wsum"));

  /* BALANCE — the deliverable, before and after, per covariate. */
  p.balance.forEach((b, i) => {
    const label = stratLabel(b.label);
    const smdU = `(m_c - m_t) / NULLIF(SQRT((v_c + v_t) / 2.0), 0)`;
    const smdW = `(wm_c - wm_t) / NULLIF(SQRT((wv_c + wv_t) / 2.0), 0)`;
    parts.push(row("balance", label, "smd_unweighted", ORD_BALANCE + i * 3, d.roundN(smdU, 5),
      `'standardized difference, control minus treated, before weighting'`, `bal${i}`));
    parts.push(row("balance", label, "smd_weighted", ORD_BALANCE + i * 3 + 1, d.roundN(smdW, 5),
      `'after weighting, with the FREQUENCY-WEIGHTED sample variance (Austin 2009). The naive SUM(w(x-xbar)^2)/SUM(w) shrinks this denominator and makes balance look better than it is'`, `bal${i}`));
    parts.push(row("balance", label, "abs_smd_change", ORD_BALANCE + i * 3 + 2, d.roundN(`ABS(${smdW}) - ABS(${smdU})`, 5),
      `CASE WHEN ABS(${smdW}) > ABS(${smdU}) + 1e-9` +
      ` THEN 'WORSE: weighting INCREASED the imbalance in this covariate. That is a real possibility whenever it is not in the propensity model, and it is the reason both numbers are reported'` +
      ` WHEN ABS(${smdW}) <= 0.1 THEN 'improved, and below the conventional 0.1 threshold'` +
      ` ELSE 'improved, but still above the conventional 0.1 threshold' END`, `bal${i}`));
  });

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: read the POSITIVITY rows before the balance ones. A pseudo-population`);
  L.push(`-- gap means some subjects have no counterpart in the other arm at all.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `ps${suffix}`,
    title: `Propensity score${suffix ? ` (${an.label})` : ""}`,
    subtitle: `saturated propensity score + ${an.estimand.toUpperCase()} weights + balance before/after`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}).`,
      `Treated ${p.treatedLevel} vs reference ${p.referenceLevel}; score cells: ${p.cellAxes.map((c) => c.label).join(" x ")}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasPropensityScore(ctx: SasCtx, an: PropensityScoreAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_ps${suffix}`);
  const cohT = ctx.finalCohort;
  const p = plan(ctx, an);
  const lbl = an.label.replace(/"/g, "'");
  const limits = propensityScoreLimitations(an, p.droppedBalance);

  const lines: string[] = [
    ...header(spec, `${num}_ps${suffix}.sas`, [
      `Propensity-score adjustment by inverse-probability weighting for "${an.label}".`,
      `The score is CLOSED FORM here: a logistic model over categorical cells is`,
      `saturated, so its maximum-likelihood fitted probability in each cell IS the`,
      `observed treated fraction. The PROC LOGISTIC anchor below checks that`,
      `claim against SAS's own fitting rather than asserting it.`,
      `SAS-PRIMARY: nothing. The SQL twin computes every number in this program.`,
      `Twin of the SQL ps program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("propensity_score", propensityScoreParity(an, {
      referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
      cellAxes: p.cellAxes.map((c) => c.axis), balanceTerms: p.balance.map((c) => stratLabel(c.label)),
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...PROPENSITY_SCORE_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
  );
  if (!p.emittable) {
    lines.push(`/* NOT EMITTED: ${an.method !== "iptw" ? `method "${cmt(an.method)}" is not emitted - see readiness.` : `the exposure or the propensity covariates did not resolve.`} */`, ``);
    return { path: `sas/${num}_ps${suffix}.sas`, language: "sas", title: `${num} Propensity score (not emitted)`, content: lines.join("\n") };
  }

  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const enrT = ctx.tbl("040_enroll");
  const needCciS = p.balance.some((b) => b.axis === "comorbidity_index");
  const cmp = sq(`${p.treatedLevel} vs ${p.referenceLevel}`);

  lines.push(
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- one row per cohort member -----------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_s0 as`,
    `  select a.enrolid, a.index_date,`,
    ...(viaNdcS ? [`         n.pattern as arm length=40,`] : [`         a.index_code as arm length=40,`]),
    `         b.dobyr, b.sex, b.region, b.plantyp,`,
    `         b.dtstart as seg_start, b.dtend as seg_end`,
    `  from ${cohT} as a`,
    ...(viaNdcS ? [`  left join ${ndcT} as n on n.ndcnum = a.index_code`] : []),
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
    `  /* the CELL, in the SAME axis order as the SQL twin - the parity stamp`,
    `     records that order, because two twins that agreed on the covariates and`,
    `     spelled the cell differently would produce different scores and no`,
    `     comparison of numbers would say so. */`,
    `  cell = ${p.cellAxes.map((_, j) => `strip(_c${j})`).join(` || '|' || `)};`,
    `  age_val  = year(index_date) - dobyr;`,
    `  sex_male = (sex = '1');`,
    ...(needCciS ? [`  cci_val  = 0;`] : []),
    `  if arm not in ("${sq(p.referenceLevel)}", "${sq(p.treatedLevel)}") then delete;`,
    `  keep enrolid treated cell age_val sex_male${needCciS ? " cci_val" : ""};`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "cohort members scored", [`sum(treated) as treated`]),
    ``,
    ...psSasSteps({ num, subjT: `work._${num}_subj`, estimand: an.estimand, stabilized: an.stabilized, trim: an.trim }),
    ``,
    ...psSasAnchor({ num, subjT: `work._${num}_subj` }),
    ``,
    `/*-------------------- positivity, weights and balance -----------------------*/`,
    `proc sql;`,
    `  create table work._${num}_pos as`,
    `  select sum(case when n_control_cell = 0 then 1 else 0 end) as cells_all_treated,`,
    `         sum(case when n_treated_cell = 0 then 1 else 0 end) as cells_all_control,`,
    `         sum(case when n_control_cell = 0 or n_treated_cell = 0 then n_cell else 0 end) as subjects_off_support,`,
    `         count(*) as n_cells, min(ps) as min_ps, max(ps) as max_ps`,
    `  from work._${num}_pscell;`,
    ``,
    `  create table work._${num}_wsum as`,
    `  select sum(case when treated = 1 then w else 0 end) as sw_t,`,
    `         sum(case when treated = 0 then w else 0 end) as sw_c,`,
    `         sum(case when treated = 1 then w*w else 0 end) as sw2_t,`,
    `         sum(case when treated = 0 then w*w else 0 end) as sw2_c,`,
    `         sum(treated) as n_t, count(*) - sum(treated) as n_c,`,
    `         max(w) as max_w,`,
    `         sum(case when w is missing then 1 else 0 end) as n_undefined_weight,`,
    `         sum(trimmed) as n_trimmed`,
    `  from work._${num}_psw;`,
    `quit;`,
    ``,
  );
  p.balance.forEach((b, i) => {
    const col = balCol(b);
    lines.push(
      `proc sql;`,
      `  create table work._${num}_bm${i} as`,
      `  select sum(case when treated = 1 then w else 0 end) as sw_t,`,
      `         sum(case when treated = 0 then w else 0 end) as sw_c,`,
      `         sum(case when treated = 1 then w*w else 0 end) as sw2_t,`,
      `         sum(case when treated = 0 then w*w else 0 end) as sw2_c,`,
      `         sum(case when treated = 1 then w*${col} else 0 end) as swx_t,`,
      `         sum(case when treated = 0 then w*${col} else 0 end) as swx_c,`,
      `         mean(case when treated = 1 then ${col} else . end) as m_t,`,
      `         mean(case when treated = 0 then ${col} else . end) as m_c,`,
      `         var(case when treated = 1 then ${col} else . end) as v_t,`,
      `         var(case when treated = 0 then ${col} else . end) as v_c`,
      `  from work._${num}_psk;`,
      ``,
      `  create table work._${num}_bal${i} as`,
      `  select b.m_t, b.m_c, b.v_t, b.v_c,`,
      `         b.swx_t / b.sw_t as wm_t,`,
      `         b.swx_c / b.sw_c as wm_c,`,
      `         /* the FREQUENCY-WEIGHTED sample variance (Austin 2009), not`,
      `            sum(w(x-xbar)^2)/sum(w) - the naive form shrinks the denominator`,
      `            of every standardized difference and flatters the balance */`,
      `         (b.sw_t / (b.sw_t*b.sw_t - b.sw2_t))`,
      `           * sum(case when k.treated = 1 then k.w * (k.${col} - b.swx_t/b.sw_t)**2 else 0 end) as wv_t,`,
      `         (b.sw_c / (b.sw_c*b.sw_c - b.sw2_c))`,
      `           * sum(case when k.treated = 0 then k.w * (k.${col} - b.swx_c/b.sw_c)**2 else 0 end) as wv_c`,
      `  from work._${num}_psk as k, work._${num}_bm${i} as b`,
      `  group by b.m_t, b.m_c, b.v_t, b.v_c, b.sw_t, b.sw_c, b.sw2_t, b.sw2_c, b.swx_t, b.swx_c;`,
      `quit;`,
      ``,
    );
  });

  lines.push(
    `data ${outT};`,
    `  length measure $20 component $12 term $60 statistic $32 method $320;`,
    `  set work._${num}_wsum;`,
    `  if _n_ = 1 then set work._${num}_pos;`,
    `  measure = "${MEASURE}"; term = "${cmp}";`,
    `  component='design'; statistic='n_treated'; ord=${ORD_DESIGN}; estimate=n_t; method='observed'; output;`,
    `  statistic='n_control'; ord=${ORD_DESIGN + 1}; estimate=n_c; output;`,
    `  statistic='n_cells'; ord=${ORD_DESIGN + 2}; estimate=n_cells;`,
    `  method='covariate cells. The score is the treated fraction in each, which is the MAXIMUM-LIKELIHOOD estimate because a logistic model over cells is saturated'; output;`,
    `  statistic='min_score'; ord=${ORD_DESIGN + 3}; estimate=round(min_ps, 0.00001); method='observed'; output;`,
    `  statistic='max_score'; ord=${ORD_DESIGN + 4}; estimate=round(max_ps, 0.00001); output;`,
    `  component='positivity';`,
    `  statistic='cells_with_no_control'; ord=${ORD_POSITIVITY}; estimate=cells_all_treated;`,
    `  if cells_all_treated > 0 then method='these cells have a score of exactly 1: nobody in them is untreated, so there is no counterfactual to weight toward';`,
    `  else method='every cell contains a control'; output;`,
    `  statistic='cells_with_no_treated'; ord=${ORD_POSITIVITY + 1}; estimate=cells_all_control;`,
    `  if cells_all_control > 0 then method='these cells have a score of exactly 0';`,
    `  else method='every cell contains a treated subject'; output;`,
    `  statistic='subjects_off_support'; ord=${ORD_POSITIVITY + 2}; estimate=subjects_off_support;`,
    `  method='people in cells that are entirely one arm. They cannot be balanced by any weighting, because the arm they would be compared with is empty'; output;`,
    `  statistic='pseudo_population_treated'; ord=${ORD_POSITIVITY + 3}; estimate=round(sw_t, 0.00001);`,
    `  method='SUM of the treated weights: the size of the population the treated arm is being asked to represent'; output;`,
    `  statistic='pseudo_population_control'; ord=${ORD_POSITIVITY + 4}; estimate=round(sw_c, 0.00001);`,
    `  method='SUM of the control weights: the same population, reconstructed from the other arm'; output;`,
    `  statistic='pseudo_population_gap'; ord=${ORD_POSITIVITY + 5}; estimate=round(abs(sw_t - sw_c), 0.00001);`,
    `  if abs(sw_t - sw_c) > 1e-9 then method='THE TWO PSEUDO-POPULATIONS ARE DIFFERENT SIZES. Both are meant to represent the same population, so this gap PROVES a positivity violation - it can only arise from cells that are entirely one arm';`,
    `  else method='the two pseudo-populations are the same size. That is NOT evidence that positivity holds - read subjects_off_support above'; output;`,
    `  statistic='subjects_with_undefined_weight'; ord=${ORD_POSITIVITY + 6}; estimate=n_undefined_weight;`,
    `  method='a weight of 1/0 is undefined, not large. These rows are missing rather than summed into a total that would look finite'; output;`,
    `  component='weights';`,
    `  statistic='sum_treated'; ord=${ORD_WEIGHTS}; estimate=round(sw_t, 0.00001); method='${an.estimand.toUpperCase()}${an.stabilized ? ", stabilized" : ""}'; output;`,
    `  statistic='sum_control'; ord=${ORD_WEIGHTS + 1}; estimate=round(sw_c, 0.00001); output;`,
    `  statistic='max_weight'; ord=${ORD_WEIGHTS + 2}; estimate=round(max_w, 0.00001);`,
    `  method='one subject standing in for many is the failure mode weighting is prone to; compare this against the arm sizes above'; output;`,
    `  statistic='effective_n_treated'; ord=${ORD_WEIGHTS + 3};`,
    `  if sw2_t > 0 then estimate = round((sw_t**2) / sw2_t, 0.00001); else estimate = .;`,
    `  method='Kish effective sample size: how many EQUALLY weighted subjects carry the same information. Never more than the actual n'; output;`,
    `  statistic='effective_n_control'; ord=${ORD_WEIGHTS + 4};`,
    `  if sw2_c > 0 then estimate = round((sw_c**2) / sw2_c, 0.00001); else estimate = .;`,
    `  method='Kish effective sample size for the control arm'; output;`,
    `  statistic='subjects_trimmed'; ord=${ORD_WEIGHTS + 5}; estimate=n_trimmed;`,
    an.trim > 0
      ? `  method='excluded by the score trim; a trimmed analysis estimates an effect in a DIFFERENT population than the cohort describes'; output;`
      : `  method='no trimming requested'; output;`,
    `  keep measure component term statistic ord estimate method;`,
    `run;`,
    ``,
  );
  p.balance.forEach((b, i) => {
    const label = sq(stratLabel(b.label));
    lines.push(
      `data work._${num}_br${i};`,
      `  length measure $20 component $12 term $60 statistic $32 method $320;`,
      `  set work._${num}_bal${i};`,
      `  measure = "${MEASURE}"; component = 'balance'; term = "${label}";`,
      `  _u = (m_c - m_t) / sqrt((v_c + v_t) / 2);`,
      `  _w = (wm_c - wm_t) / sqrt((wv_c + wv_t) / 2);`,
      `  statistic='smd_unweighted'; ord=${ORD_BALANCE + i * 3}; estimate=round(_u, 0.00001);`,
      `  method='standardized difference, control minus treated, before weighting'; output;`,
      `  statistic='smd_weighted'; ord=${ORD_BALANCE + i * 3 + 1}; estimate=round(_w, 0.00001);`,
      `  method='after weighting, with the FREQUENCY-WEIGHTED sample variance (Austin 2009)'; output;`,
      `  statistic='abs_smd_change'; ord=${ORD_BALANCE + i * 3 + 2}; estimate=round(abs(_w) - abs(_u), 0.00001);`,
      `  if abs(_w) > abs(_u) + 1e-9 then method='WORSE: weighting INCREASED the imbalance in this covariate. That is a real possibility whenever it is not in the propensity model, and it is the reason both numbers are reported';`,
      `  else if abs(_w) <= 0.1 then method='improved, and below the conventional 0.1 threshold';`,
      `  else method='improved, but still above the conventional 0.1 threshold';`,
      `  output;`,
      `  keep measure component term statistic ord estimate method;`,
      `run;`,
      ``,
    );
  });
  lines.push(
    `data ${outT};`,
    `  set ${outT}${p.balance.map((_, i) => ` work._${num}_br${i}`).join("")};`,
    `run;`,
    ``,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Propensity-score adjustment: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  void outcomeSettingPlan;
  return {
    path: `sas/${num}_ps${suffix}.sas`,
    language: "sas",
    title: `${num} Propensity score${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const propensityScoreModule: AnalysisModule<PropensityScoreAnalysis> = {
  analysisKind: "propensity_score",
  stampKind: "propensity_score",
  resultSlug: "ps",
  sql: sqlPropensityScore,
  sas: sasPropensityScore,
};
