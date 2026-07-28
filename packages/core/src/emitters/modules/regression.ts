/**
 * GLM module — the analytic dataset and the crude effect in both twins, the
 * fitted coefficients in SAS, and a saturated-design anchor tying them together.
 *
 * The build plan is blunt about the constraint: fitted coefficients need
 * IRLS/Newton, warehouse SQL has neither, and "the saturated anchor is the only
 * real check available". So the work here is deciding what is genuinely
 * verifiable and refusing to dress up the rest.
 *
 * WHAT BOTH TWINS COMPUTE, and the harness executes:
 *   - the analytic dataset: one row per at-risk subject, with the incident
 *     outcome inside the horizon, the exposure arm, and every covariate;
 *   - the 2x2 of exposure by outcome;
 *   - from it, in closed form, the odds ratio, risk ratio and risk difference,
 *     plus the Woolf log-odds standard error and its Wald interval.
 *
 * WHAT ONLY SAS COMPUTES: the adjusted coefficients. SQL emits them NULL beside
 * a label naming the procedure, under the same SAS-primary contract as the
 * exact Poisson interval and the trend p-value.
 *
 * THE ANCHOR. A logistic model whose only predictor is the two-level exposure is
 * SATURATED for a 2x2: it has as many parameters as cells to fit, so its
 * maximum-likelihood estimate is not an approximation of the closed-form log
 * odds ratio — it IS that number. The emitted SAS therefore fits that model,
 * recomputes the closed form from its own data, and prints whether they agree.
 * No reference value travels with the program; the check is self-contained, and
 * it is the one place a site can see the fitting machinery validated rather than
 * trusted.
 *
 * Verified vs Gold Case A: at-risk 8, split 4/4 by arm, with 2 events under
 * DRUG_X and 1 under DRUG_Y. Reference DRUG_X, so the reported effect is for
 * DRUG_Y: OR = (1/3)/(2/2) = 1/3 EXACTLY, RR = 0.25/0.5 = 0.5, RD = -0.25.
 * Woolf SE = sqrt(1 + 1/3 + 1/2 + 1/2) = sqrt(7/3). Hand-derived, asserted in
 * verify/run.ts.
 */
import type { RegressionAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine, q, describeWindow, windowConds } from "../sql-base";
import { cmt, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import { rateCoreSqlCtes, censorPlan, renderCensorSql, renderCensorSas } from "../rate-core";
import { ledgerSqlCtes, ledgerSasSteps, DEFAULT_ED_PLACE_OF_SERVICE } from "../ledger";
import { comorbidityScoreSasScore, comorbidityScoreSasSteps, comorbidityScoreSqlCtes, indexAnalysisFor } from "../comorbidity";
import {
  balanceCovariates,
  outcomeSettingPlan,
  parityStamp,
  renderDaysPerYear,
  regressionLimitations,
  regressionParity,
  stratLabel,
  REGRESSION_METHOD_NOTES,
  type BalanceCovariate,
} from "../parity";

const MEASURE = "regression";
/** Label on the adjusted rows, naming what produces them. */
const ADJ_METHOD_BY_FAMILY: Record<string, string> = {
  logistic: "sas_proc_logistic",
  poisson: "sas_proc_genmod",
  negative_binomial: "sas_proc_genmod_negbin",
  gamma_log: "sas_proc_genmod_gamma",
};
const adjMethod = (family: string) => ADJ_METHOD_BY_FAMILY[family] ?? "sas_primary";
/** The effect a family's exponentiated coefficient IS. Labelling a Poisson
 *  coefficient "odds_ratio" would be a mislabeled statistic — the worst kind,
 *  because it reads as correct. */
const ADJ_STATISTIC_BY_FAMILY: Record<string, string> = {
  logistic: "odds_ratio",
  poisson: "rate_ratio",
  negative_binomial: "rate_ratio",
  gamma_log: "cost_ratio",
};
const adjStatistic = (family: string) => ADJ_STATISTIC_BY_FAMILY[family] ?? "effect";

/** Resolve exposure levels and the covariates the model can actually build. */
function plan(ctx: SqlCtx | SasCtx, an: RegressionAnalysis) {
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
  };
}

/** Model terms, exposure first — the order both twins must emit. */
function terms(p: { exposedLevel: string; covariates: BalanceCovariate[] }, gvLabel: string): string[] {
  return [stratLabel(gvLabel), ...p.covariates.map((c) => stratLabel(c.label))];
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlRegression(ctx: SqlCtx, an: RegressionAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_glm${suffix}`;
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const p = plan(ctx, an);
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  const washoutPred = wc.length > 0 ? wc.join("\n      AND ") : "TRUE";
  const horizonEnd = d.offset("s.index_date", an.horizonDays);
  const isCount = an.family === "poisson" || an.family === "negative_binomial";
  const isCost = an.family === "gamma_log";
  const isRecurrent = (an.recurrence ?? "first_only") === "all_events";
  const censor = an.personTimeRule ? censorPlan(spec, an.personTimeRule) : null;
  const censorFinal = censor?.atOutcome
    ? `LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor)`
    : `admin_censor`;
  const Y = renderDaysPerYear(spec);

  const L: string[] = [];
  L.push(
    `-- ${parityStamp(
      "regression",
      regressionParity(an, {
        referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms,
        settingFilter: setting.stamped, effectStatistic: adjStatistic(an.family),
        offset: censor ? { applied: censor.applied, dataCut: censor.dataCut } : null,
        responseKind: isCost ? "cost" : isRecurrent ? "count" : "indicator",
      }),
    )}`,
  );
  const limits = regressionLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of REGRESSION_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(`-- SAS-PRIMARY: the adjusted estimates are NULL here BY CONTRACT - fitting a`);
  L.push(`-- GLM needs iteratively reweighted least squares, which warehouse SQL has no`);
  L.push(`-- way to run. They are computed by PROC LOGISTIC in the SAS twin.`);

  if (!p.emittable) {
    L.push(`-- No model emitted: the exposure variable did not resolve to two levels.`);
    return {
      slug: `glm${suffix}`,
      title: `Regression${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted - exposure unresolved",
      extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`],
      body: L.join("\n"),
    };
  }

  const cciCov = p.covariates.find((c) => c.axis === "comorbidity_index");
  const cciAn = indexAnalysisFor(spec, cciCov?.analysisId);
  /* The cohort stores index_code. When the index list is a DRUG-NAME list that
   * code is the resolved NDC, not the arm label, so the arm has to come back
   * through the same lookup 01_ndc_lookup built — exactly as the balance table
   * does. Comparing index_code to 'DRUG_X' directly would match nothing and
   * emit an empty, perfectly well-formed model. */
  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `ch.index_code`;

  L.push(d.createTableAs(out));
  // The at-risk chain is rate-core's, not a second copy: same cohort, same
  // washout, same "first event strictly after index" as the incidence twins.
  L.push(
    ...rateCoreSqlCtes(ctx, {
      wp,
      codeListId: clid,
      settingEnforce: setting.enforce,
      washoutDescription: describeWindow(an.washout),
      washoutPredicate: washoutPred,
      needDemo: true,
    }),
  );
  if (cciCov && cciAn) {
    const sc = comorbidityScoreSqlCtes(ctx, { wp, an: cciAn, cohortCte: "atrisk", prefix: "cci_" });
    L.push(...sc.lines);
  }
  /* Person-time, for count families only. Censored by the SAME plan the
   * incidence twins render (rate-core.censorPlan), so the model's offset cannot
   * disagree with the rate table it sits beside. */
  if (isCount && censor) {
    L.push(`ptc0 AS (   -- censoring: ${censor.applied.join(" / ")}${censor.dataCut ? ` / data cut ${censor.dataCut}` : ``}`);
    L.push(`  SELECT c.enrolid, c.index_date, ${renderCensorSql(ctx, censor)} AS admin_censor, f.fu_date`);
    L.push(`  FROM atrisk c`);
    L.push(`  JOIN ${wp}_enroll_episodes ep`);
    L.push(`    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end`);
    L.push(`  LEFT JOIN first_fu f ON f.enrolid = c.enrolid`);
    L.push(`),`);
    L.push(`ptc AS (`);
    L.push(`  SELECT enrolid, ${d.daysBetween(censorFinal, "index_date")} AS person_days`);
    L.push(`  FROM ptc0`);
    L.push(`),`);
  }
  if (isCost && an.costResponse) {
    /* The RESPONSE is each subject's COST, read through the SHARED ledger — so
     * it is the same quantity the resource-use table reports, inpatient
     * double-count rule and all. Joined to `atrisk`, not to the whole cohort. */
    L.push(
      ...ledgerSqlCtes(ctx, {
        wp,
        window: an.costResponse.window,
        settings: an.costResponse.settings,
        costField: an.costResponse.costField,
        edPlaces: DEFAULT_ED_PLACE_OF_SERVICE,
        cohortCte: "atrisk",
        prefix: "cst_",
      }),
    );
    L.push(`cost_pt AS (   -- total cost per at-risk subject over the window`);
    L.push(`  SELECT c.enrolid, COALESCE(SUM(e.paid), 0) AS cost`);
    L.push(`  FROM atrisk c LEFT JOIN cst_encounters_kept e ON e.enrolid = c.enrolid`);
    L.push(`  GROUP BY c.enrolid`);
    L.push(`),`);
  }
  if (isRecurrent) {
    /* The RESPONSE is a count, not an indicator. Distinct qualifying dates, so a
     * stay billed on several lines is one event — the same grain the events
     * spine already enforces. */
    L.push(`ev_n AS (   -- recurrent events per subject inside the horizon`);
    L.push(`  SELECT c.enrolid, COUNT(DISTINCT a.event_date) AS n_events`);
    L.push(`  FROM atrisk c`);
    L.push(`  JOIN ae a ON a.enrolid = c.enrolid`);
    L.push(`   AND a.event_date > c.index_date`);
    L.push(`   AND a.event_date <= ${d.offset("c.index_date", an.horizonDays)}`);
    L.push(`  GROUP BY c.enrolid`);
    L.push(`),`);
  }
  L.push(`subj AS (   -- the ANALYTIC DATASET: one row per at-risk subject`);
  L.push(`  SELECT s.enrolid,`);
  L.push(`         CASE WHEN s.arm = '${q(p.exposedLevel)}' THEN 1 ELSE 0 END AS exposed,`);
  if (isRecurrent) {
    L.push(`         -- COUNT of qualifying events in the horizon (recurrence: all_events)`);
    L.push(`         COALESCE(en.n_events, 0) AS y,`);
  } else if (isCost) {
    L.push(`         -- COST over the window (gamma_log response)`);
    L.push(`         COALESCE(cp.cost, 0) AS y,`);
  } else {
    L.push(`         -- incident event INSIDE the horizon; a subject counts once`);
    L.push(`         CASE WHEN f.fu_date IS NOT NULL AND f.fu_date <= ${horizonEnd} THEN 1 ELSE 0 END AS y,`);
  }
  L.push(`         CAST(${d.year("s.index_date")} - dm.dobyr AS NUMERIC) AS age_val,`);
  /* Trailing commas built from the ACTUAL tail, not from one optional column.
   * The previous form put the comma on sex_male only when a comorbidity
   * covariate existed, so a count model WITHOUT one emitted
   * "... AS sex_male CAST(...) AS person_days" and failed to parse. Gold Case B
   * has no comorbidity covariate and caught it on its first run. */
  const tail: string[] = [];
  if (cciCov && cciAn) tail.push(`         CAST(COALESCE(cs.score, 0) AS NUMERIC) AS cci_val`);
  // the model's OFFSET: log person-time. A count model without it fits counts.
  if (isCount) tail.push(`         CAST(COALESCE(pt.person_days, 0) AS NUMERIC) AS person_days`);
  L.push(`         CASE WHEN dm.sex = '1' THEN 1.0 ELSE 0.0 END AS sex_male${tail.length > 0 ? `,` : ``}`);
  tail.forEach((line, i) => L.push(`${line}${i < tail.length - 1 ? `,` : ``}`));
  L.push(`  FROM (SELECT a.enrolid, a.index_date, ${armExpr} AS arm FROM atrisk a`);
  L.push(`        JOIN ${wp}_cohort ch ON ch.enrolid = a.enrolid`);
  if (viaNdc) {
    L.push(`        JOIN ${wp}_ndc_lookup nl`);
    L.push(`          ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = ch.index_code`);
  }
  L.push(`       ) s`);
  L.push(`  LEFT JOIN first_fu f ON f.enrolid = s.enrolid`);
  L.push(`  LEFT JOIN demo1 dm ON dm.enrolid = s.enrolid`);
  if (cciCov && cciAn) L.push(`  LEFT JOIN cci_per_pt cs ON cs.enrolid = s.enrolid`);
  if (isCount) L.push(`  LEFT JOIN ptc pt ON pt.enrolid = s.enrolid`);
  if (isRecurrent) L.push(`  LEFT JOIN ev_n en ON en.enrolid = s.enrolid`);
  if (isCost) L.push(`  LEFT JOIN cost_pt cp ON cp.enrolid = s.enrolid`);
  L.push(`  WHERE s.arm IN ('${q(p.referenceLevel)}', '${q(p.exposedLevel)}')`);
  L.push(`),`);
  L.push(`cells AS (   -- the table the closed form is computed from`);
  if (isCost) {
    /* Gamma requires a STRICTLY POSITIVE response, so zero-cost subjects cannot
     * enter the fit. They are counted, reported, and excluded — never dropped
     * silently and never rescued by adding a small constant, which changes the
     * estimand. This is the second part of a two-part model; the first part
     * (any cost at all) is a separate logistic analysis. */
    L.push(`  SELECT SUM(CASE WHEN exposed = 1 AND y > 0 THEN y ELSE 0 END) AS a_ee,`);
    L.push(`         SUM(CASE WHEN exposed = 1 AND y > 0 THEN 1 ELSE 0 END) AS b_en,`);
    L.push(`         SUM(CASE WHEN exposed = 0 AND y > 0 THEN y ELSE 0 END) AS c_ue,`);
    L.push(`         SUM(CASE WHEN exposed = 0 AND y > 0 THEN 1 ELSE 0 END) AS d_un,`);
    L.push(`         SUM(CASE WHEN y = 0 THEN 1 ELSE 0 END) AS n_zero,`);
    L.push(`         SUM(CASE WHEN exposed = 1 THEN 1 ELSE 0 END) AS n_exp_all,`);
    L.push(`         SUM(CASE WHEN exposed = 0 THEN 1 ELSE 0 END) AS n_unexp_all,`);
    // sample variances on the POSITIVE subset, for the delta-method interval
    L.push(`         VAR_SAMP(CASE WHEN exposed = 1 AND y > 0 THEN CAST(y AS DOUBLE PRECISION) END) AS v_exp,`);
    L.push(`         VAR_SAMP(CASE WHEN exposed = 0 AND y > 0 THEN CAST(y AS DOUBLE PRECISION) END) AS v_unexp`);
  } else if (isRecurrent) {
    // a count response has no "non-event" cell; b/d carry SUBJECT counts so the
    // design rows can still report arm sizes
    L.push(`  SELECT SUM(CASE WHEN exposed = 1 THEN y ELSE 0 END) AS a_ee,`);
    L.push(`         SUM(CASE WHEN exposed = 1 THEN 1 ELSE 0 END) AS b_en,`);
    L.push(`         SUM(CASE WHEN exposed = 0 THEN y ELSE 0 END) AS c_ue,`);
    L.push(`         SUM(CASE WHEN exposed = 0 THEN 1 ELSE 0 END) AS d_un,`);
    L.push(`         MAX(y) AS max_events,`);
  } else {
    L.push(`  SELECT SUM(CASE WHEN exposed = 1 AND y = 1 THEN 1 ELSE 0 END) AS a_ee,`);
    L.push(`         SUM(CASE WHEN exposed = 1 AND y = 0 THEN 1 ELSE 0 END) AS b_en,`);
    L.push(`         SUM(CASE WHEN exposed = 0 AND y = 1 THEN 1 ELSE 0 END) AS c_ue,`);
    L.push(`         SUM(CASE WHEN exposed = 0 AND y = 0 THEN 1 ELSE 0 END) AS d_un${isCount ? `,` : ``}`);
  }
  if (isCount) {
    L.push(`         SUM(CASE WHEN exposed = 1 THEN person_days ELSE 0 END) AS pt_exp,`);
    L.push(`         SUM(CASE WHEN exposed = 0 THEN person_days ELSE 0 END) AS pt_unexp`);
  }
  L.push(`  FROM subj`);
  L.push(`),`);
  /* A zero cell makes the log-odds interval undefined. The program returns
   * NULL rather than adding a continuity correction: a correction changes the
   * estimand, and doing it silently is how a study reports a number nobody
   * chose. */
  L.push(`eff AS (`);
  L.push(`  SELECT a_ee, b_en, c_ue, d_un,`);
  L.push(isRecurrent || isCost
    ? `         b_en AS n_exp, d_un AS n_unexp,`
    : `         (a_ee + b_en) AS n_exp, (c_ue + d_un) AS n_unexp,`);
  if (isCost) L.push(`         n_zero, n_exp_all, n_unexp_all, v_exp, v_unexp,`);
  if (isRecurrent) L.push(`         max_events,`);
  if (isCost) {
    /* The saturated Gamma-log model reproduces the observed arm MEANS, so its
     * MLE of the exposure coefficient IS ln(mean_exposed / mean_reference).
     * That is the anchor, in closed form.
     *
     * The interval is the DELTA METHOD on the log ratio of means, and it is
     * labeled as such: it is NOT the fitted model's interval, which needs the
     * Gamma dispersion parameter and is therefore SAS-primary. Reporting a
     * delta-method interval under a model-based label would be the mislabeling
     * this project refuses. */
    L.push(`         CASE WHEN a_ee > 0 AND c_ue > 0 AND b_en > 0 AND d_un > 0`);
    L.push(`              THEN LN((a_ee * 1.0 / b_en) / (c_ue * 1.0 / d_un)) END AS log_cr,`);
    L.push(`         CASE WHEN a_ee > 0 AND c_ue > 0 AND b_en > 1 AND d_un > 1`);
    L.push(`              THEN SQRT( v_exp / (b_en * POWER(a_ee * 1.0 / b_en, 2))`);
    L.push(`                       + v_unexp / (d_un * POWER(c_ue * 1.0 / d_un, 2)) ) END AS se_log_cr`);
  } else if (isCount) {
    L.push(`         pt_exp, pt_unexp,`);
    /* The Poisson closed form: a ratio of RATES, not of odds. Its standard
     * error depends only on the EVENT counts — person-time enters the point
     * estimate and not the variance. */
    L.push(`         CASE WHEN a_ee > 0 AND c_ue > 0 AND pt_exp > 0 AND pt_unexp > 0`);
    L.push(`              THEN LN((a_ee * 1.0 / pt_exp) / (c_ue * 1.0 / pt_unexp)) END AS log_rr,`);
    L.push(`         CASE WHEN a_ee > 0 AND c_ue > 0`);
    L.push(`              THEN SQRT(1.0/a_ee + 1.0/c_ue) END AS se_log_rr`);
  } else {
    L.push(`         CASE WHEN b_en > 0 AND c_ue > 0 AND a_ee > 0 AND d_un > 0`);
    L.push(`              THEN LN((a_ee * 1.0 * d_un) / (b_en * 1.0 * c_ue)) END AS log_or,`);
    L.push(`         CASE WHEN a_ee > 0 AND b_en > 0 AND c_ue > 0 AND d_un > 0`);
    L.push(`              THEN SQRT(1.0/a_ee + 1.0/b_en + 1.0/c_ue + 1.0/d_un) END AS se_log_or`);
  }
  L.push(`  FROM cells`);
  L.push(`)`);
  L.push(`SELECT '${MEASURE}' AS measure, component, term, statistic, ord,`);
  L.push(`       estimate, ci_low, ci_high, se_log, method`);
  L.push(`FROM (`);
  // 1. the design: cell counts, so the closed form can be re-derived by hand
  const designRow = (ord: number, term: string, stat: string, expr: string) =>
    `  SELECT 'design' AS component, '${term}' AS term, '${stat}' AS statistic, ${ord} AS ord,` +
    ` CAST(${expr} AS NUMERIC) AS estimate, CAST(NULL AS NUMERIC) AS ci_low, CAST(NULL AS NUMERIC) AS ci_high,` +
    ` CAST(NULL AS NUMERIC) AS se_log, CAST('observed' AS VARCHAR) AS method FROM eff`;
  if (isCost) {
    L.push(designRow(0, q(p.exposedLevel), "n", "n_exp_all"));
    L.push(`  UNION ALL`);
    L.push(designRow(1, q(p.exposedLevel), "n_positive_cost", "n_exp"));
    L.push(`  UNION ALL`);
    L.push(designRow(2, q(p.exposedLevel), "total_cost", "a_ee"));
    L.push(`  UNION ALL`);
    L.push(designRow(3, q(p.exposedLevel), "mean_cost", `${d.roundN(`a_ee * 1.0 / NULLIF(b_en, 0)`, 5)}`));
    L.push(`  UNION ALL`);
    L.push(designRow(4, q(p.referenceLevel), "n", "n_unexp_all"));
    L.push(`  UNION ALL`);
    L.push(designRow(5, q(p.referenceLevel), "n_positive_cost", "n_unexp"));
    L.push(`  UNION ALL`);
    L.push(designRow(6, q(p.referenceLevel), "total_cost", "c_ue"));
    L.push(`  UNION ALL`);
    L.push(designRow(7, q(p.referenceLevel), "mean_cost", `${d.roundN(`c_ue * 1.0 / NULLIF(d_un, 0)`, 5)}`));
  } else {
  L.push(designRow(0, q(p.exposedLevel), "n", "n_exp"));
  L.push(`  UNION ALL`);
  L.push(designRow(1, q(p.exposedLevel), "events", "a_ee"));
  if (isCount) {
    L.push(`  UNION ALL`);
    L.push(designRow(2, q(p.exposedLevel), "person_days", "pt_exp"));
    L.push(`  UNION ALL`);
    L.push(designRow(3, q(p.exposedLevel), "rate_per_1000py", `ROUND(CAST(a_ee * 1000.0 * ${Y} / NULLIF(pt_exp, 0) AS NUMERIC), 5)`));
  }
  L.push(`  UNION ALL`);
  L.push(designRow(isCount ? 4 : 2, q(p.referenceLevel), "n", "n_unexp"));
  L.push(`  UNION ALL`);
  L.push(designRow(isCount ? 5 : 3, q(p.referenceLevel), "events", "c_ue"));
  if (isCount) {
    L.push(`  UNION ALL`);
    L.push(designRow(6, q(p.referenceLevel), "person_days", "pt_unexp"));
    L.push(`  UNION ALL`);
    L.push(designRow(7, q(p.referenceLevel), "rate_per_1000py", `ROUND(CAST(c_ue * 1000.0 * ${Y} / NULLIF(pt_unexp, 0) AS NUMERIC), 5)`));
  }
  }
  // 2. the crude effect, closed form, in BOTH twins
  const crude = (ord: number, stat: string, est: string, lo: string, hi: string, se: string) =>
    `  SELECT 'crude', '${q(stratLabel(gvLabel))}', '${stat}', ${ord},` +
    ` ${est}, ${lo}, ${hi}, ${se}, CAST('closed_form_2x2' AS VARCHAR) FROM eff`;
  if (isCost) {
    L.push(`  UNION ALL`);
    L.push(crude(10, "cost_ratio",
      d.roundN(`EXP(log_cr)`, 5),
      d.roundN(`EXP(log_cr - 1.96 * se_log_cr)`, 5),
      d.roundN(`EXP(log_cr + 1.96 * se_log_cr)`, 5),
      d.roundN(`se_log_cr`, 5)).replace("'closed_form_2x2'", "'delta_method_ratio_of_means'"));
    L.push(`  UNION ALL`);
    L.push(crude(11, "mean_cost_difference",
      d.roundN(`a_ee * 1.0 / NULLIF(b_en, 0) - c_ue * 1.0 / NULLIF(d_un, 0)`, 5),
      `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`)
      .replace("'closed_form_2x2'", "'difference_of_means'"));
    /* ZERO-COST SUBJECTS. Gamma needs y > 0, so these cannot enter the fit.
     * Reported as a row rather than dropped: how many were excluded, and from
     * what, is part of the result. */
    L.push(`  UNION ALL`);
    L.push(
      `  SELECT 'diagnostic', 'zero_cost', 'subjects_excluded_from_fit', 14,` +
        ` CAST(n_zero AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),` +
        ` CAST(CASE WHEN n_zero > 0` +
        ` THEN 'EXCLUDED from the gamma fit: a gamma response must be strictly positive. This is the SECOND part of a two-part model; the first part (any cost at all) is a separate logistic analysis'` +
        ` ELSE 'no zero-cost subjects, so the gamma fit uses everyone' END AS VARCHAR) FROM eff`,
    );
  } else if (isCount) {
    L.push(`  UNION ALL`);
    L.push(crude(10, "rate_ratio",
      d.roundN(`EXP(log_rr)`, 5),
      d.roundN(`EXP(log_rr - 1.96 * se_log_rr)`, 5),
      d.roundN(`EXP(log_rr + 1.96 * se_log_rr)`, 5),
      d.roundN(`se_log_rr`, 5)));
    L.push(`  UNION ALL`);
    L.push(crude(11, "rate_difference_per_1000py",
      d.roundN(`a_ee * 1000.0 * ${Y} / NULLIF(pt_exp, 0) - c_ue * 1000.0 * ${Y} / NULLIF(pt_unexp, 0)`, 5),
      `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`));
  } else {
    L.push(`  UNION ALL`);
    L.push(crude(10, "odds_ratio",
      d.roundN(`EXP(log_or)`, 5),
      d.roundN(`EXP(log_or - 1.96 * se_log_or)`, 5),
      d.roundN(`EXP(log_or + 1.96 * se_log_or)`, 5),
      d.roundN(`se_log_or`, 5)));
    L.push(`  UNION ALL`);
    L.push(crude(11, "risk_ratio",
      d.roundN(`(a_ee * 1.0 / NULLIF(n_exp, 0)) / NULLIF(c_ue * 1.0 / NULLIF(n_unexp, 0), 0)`, 5),
      `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`));
    L.push(`  UNION ALL`);
    L.push(crude(12, "risk_difference",
      d.roundN(`a_ee * 1.0 / NULLIF(n_exp, 0) - c_ue * 1.0 / NULLIF(n_unexp, 0)`, 5),
      `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`));
  }
  /* NB DISPERSION DEGENERACY, reported as data rather than left to the reader.
   * With no subject contributing more than one event the response is Bernoulli,
   * whose variance is always BELOW its mean — the dispersion parameter is not
   * identified and the fit collapses to Poisson. A model that printed a
   * dispersion estimate anyway would look like it had measured something. */
  if (an.family === "negative_binomial") {
    /* VARIANCE-TO-MEAN RATIO — the closed-form statistic that says whether NB
     * is warranted at all. Poisson assumes it is 1; above 1 is overdispersion
     * (NB earns its extra parameter), at or below 1 the NB fit has nothing to
     * estimate. Both twins compute it, so it is executed rather than asserted. */
    L.push(`  UNION ALL`);
    L.push(
      `  SELECT 'diagnostic', 'overdispersion', 'variance_to_mean_ratio', 14,` +
        ` ${d.roundN(`(SELECT VAR_SAMP(CAST(y AS DOUBLE PRECISION)) FROM subj) / NULLIF((SELECT AVG(CAST(y AS DOUBLE PRECISION)) FROM subj), 0)`, 5)},` +
        ` CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),` +
        ` CAST(CASE WHEN (SELECT VAR_SAMP(CAST(y AS DOUBLE PRECISION)) FROM subj)` +
        ` > (SELECT AVG(CAST(y AS DOUBLE PRECISION)) FROM subj)` +
        ` THEN 'OVERDISPERSED: NB warranted over Poisson'` +
        ` ELSE 'NOT overdispersed: the NB dispersion parameter adds nothing' END AS VARCHAR) FROM eff`,
    );
    L.push(`  UNION ALL`);
    L.push(
      `  SELECT 'diagnostic', 'overdispersion', 'max_events_per_subject', 15,` +
        ` CAST(max_events AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),` +
        ` CAST(CASE WHEN max_events <= 1 THEN 'DEGENERATE: no subject has >1 event, so the dispersion parameter is NOT identified and negative binomial reduces to Poisson' ELSE 'dispersion is estimable' END AS VARCHAR) FROM eff`,
    );
  }
  // 3. the adjusted model — SAS-primary, declared and NULL
  modelTerms.forEach((t, i) => {
    L.push(`  UNION ALL`);
    L.push(
      `  SELECT 'adjusted', '${q(t)}', '${adjStatistic(an.family)}', ${20 + i},` +
        ` CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),` +
        ` CAST('${adjMethod(an.family)}' AS VARCHAR) FROM eff`,
    );
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: 2x2 design, the closed-form crude effect, and the adjusted model`);
  L.push(`-- whose estimates the SAS twin fills in.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY ord;`);

  return {
    slug: `glm${suffix}`,
    title: `Regression${suffix ? ` (${an.label})` : ""}`,
    subtitle: `${an.family}: 2x2 design + closed-form crude effect (adjusted model is SAS-primary)`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); outcome code list "${clid}", horizon ${an.horizonDays}d.`,
      `Exposure ${p.exposedLevel} vs reference ${p.referenceLevel}; adjusted terms: ${modelTerms.join(", ")}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasRegression(ctx: SasCtx, an: RegressionAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_glm${suffix}`);
  const cohT = ctx.finalCohort;
  const evT = ctx.evOf(an.outcomeDefinition.codeListId);
  const enrT = ctx.tbl("040_enroll");
  const listSystem = findCodeList(spec, an.outcomeDefinition.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` : setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
  const p = plan(ctx, an);
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const limits = regressionLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs);
  const label = an.label.replace(/"/g, "'");
  const cciCov = p.covariates.find((c) => c.axis === "comorbidity_index");
  const cciAn = indexAnalysisFor(spec, cciCov?.analysisId);
  const cciScore = cciCov && cciAn ? comorbidityScoreSasSteps(ctx, { an: cciAn, num, cohT, evOf: ctx.evOf }) : null;
  const isCountS = an.family === "poisson" || an.family === "negative_binomial";
  const isCostS = an.family === "gamma_log";
  const glmDist = an.family === "negative_binomial" ? "negbin" : an.family === "gamma_log" ? "gamma" : "poisson";
  const costLedger = isCostS && an.costResponse
    ? ledgerSasSteps(ctx, {
        wp: "", num: `${num}c`, cohT: `work._${num}_atrisk`, epiT: ctx.tbl("050_epi"),
        window: an.costResponse.window, settings: an.costResponse.settings,
        costField: an.costResponse.costField, edPlaces: DEFAULT_ED_PLACE_OF_SERVICE,
      })
    : null;
  const isRecurrentS = (an.recurrence ?? "first_only") === "all_events";
  const censorS = an.personTimeRule ? censorPlan(spec, an.personTimeRule) : null;
  const YS = ctx.daysPerYearLit;
  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const sasVar = (c: BalanceCovariate) => (c.axis === "age" ? "age_val" : c.axis === "sex" ? "sex_male" : "cci_val");

  const lines: string[] = [
    ...header(spec, `${num}_glm${suffix}.sas`, [
      `${an.family} regression for "${an.label}".`,
      `The analytic dataset and the CRUDE effect are computed here AND in the SQL`,
      `twin; the ADJUSTED coefficients are SAS-primary (SQL emits them NULL).`,
      `SATURATED ANCHOR: the unadjusted model is saturated for a 2x2, so its MLE`,
      `must equal the closed-form log odds ratio computed below from the same`,
      `data. This program checks that itself and prints the verdict.`,
      `Twin of the SQL glm program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp(
      "regression",
      regressionParity(an, {
        referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms,
        settingFilter: setting.stamped, effectStatistic: adjStatistic(an.family),
        offset: censorS ? { applied: censorS.applied, dataCut: censorS.dataCut } : null,
        responseKind: isCostS ? "cost" : isRecurrentS ? "count" : "indicator",
      }),
    )} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...REGRESSION_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
  );
  if (!p.emittable) {
    lines.push(`/* No model emitted: the exposure variable did not resolve to two levels. */`);
    return { path: `sas/${num}_glm${suffix}.sas`, language: "sas", title: `${num} Regression`, content: lines.join("\n") };
  }

  lines.push(
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- prevalent-case washout -> at risk ---------------------*/`,
    `proc sql;`,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    ...sasWindowConds(an.washout, "e").map((l) => `    ${l}`),
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  ;`,
    ``,
    `  create table work._${num}_atrisk as`,
    ...(viaNdcS
      ? [
          `  /* the index list is a DRUG-NAME list, so index_code is the resolved NDC`,
          `     and the arm label comes back through the NDC lookup */`,
          `  select a.*, n.pattern as arm length=40`,
          `  from ${cohT} as a`,
          `  inner join ${ndcT} as n on n.ndcnum = a.index_code`,
          `  where a.enrolid not in (select enrolid from work._${num}_prev)`,
          `    and n.pattern in ('${sq(p.referenceLevel)}', '${sq(p.exposedLevel)}');`,
        ]
      : [
          `  select a.*, a.index_code as arm length=40`,
          `  from ${cohT} as a`,
          `  where a.enrolid not in (select enrolid from work._${num}_prev)`,
          `    and a.index_code in ('${sq(p.referenceLevel)}', '${sq(p.exposedLevel)}');`,
        ]),
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_atrisk`, "at-risk subjects"),
    ``,
    ...(isCostS ? [`/* (no first-event lookup: the response is a cost total, not an event) */`, ``] : []),
    ...(isCostS ? [] : [
    `/*-------------------- first incident event inside the horizon ---------------*/`,
    `proc sql;`,
    `  create table work._${num}_fu as`,
    `  select a.enrolid, min(e.svcdate) as fu_date format=date9.`,
    `  from work._${num}_atrisk as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    `    and e.svcdate >  a.index_date`,
    `    and e.svcdate <= a.index_date + ${an.horizonDays}`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  group by a.enrolid;`,
    `quit;`,
    ``,
    ]),
    ...(costLedger
      ? [
          `/*-------------------- COST response, via the shared ledger -------------------`,
          `  The same encounter rules the resource-use table uses, including the`,
          `  inpatient double count: an admission's stay-level total is taken and its`,
          `  own service lines are dropped. */`,
          ...costLedger.lines,
          `proc sql;`,
          `  create table work._${num}_cost as`,
          `  select a.enrolid, coalesce(sum(e.paid), 0) as cost`,
          `  from work._${num}_atrisk as a`,
          `  left join ${costLedger.encounters} as e on e.enrolid = a.enrolid`,
          `  group by a.enrolid;`,
          `quit;`,
          ``,
        ]
      : []),
    ...(isRecurrentS
      ? [
          `/*-------------------- recurrent events per subject --------------------------*/`,
          `proc sql;`,
          `  create table work._${num}_evn as`,
          `  select a.enrolid, count(distinct e.svcdate) as n_events`,
          `  from work._${num}_atrisk as a`,
          `  inner join ${evT} as e`,
          `    on  e.enrolid = a.enrolid`,
          `    and e.svcdate >  a.index_date`,
          `    and e.svcdate <= a.index_date + ${an.horizonDays}`,
          ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
          `  group by a.enrolid;`,
          `quit;`,
          ``,
        ]
      : []),
    ...(cciScore ? [...cciScore.lines, ...comorbidityScoreSasScore(num, cohT)] : []),
    ...(isCountS && censorS
      ? [
          `/*-------------------- person-time (the model's log offset) ------------------`,
          `  Censored by the SAME plan the incidence twins render (rate-core.censorPlan),`,
          `  so this offset cannot disagree with the rate table beside it. */`,
          `proc sql;`,
          `  create table work._${num}_pt0 as`,
          `  select a.enrolid, a.index_date,`,
          `         ${renderCensorSas(censorS)} as admin_censor format=date9.,`,
          `         f.fu_date`,
          `  from work._${num}_atrisk as a`,
          `  inner join ${ctx.tbl("050_epi")} as ep`,
          `    on  ep.enrolid = a.enrolid`,
          `    and a.index_date between ep.dtstart and ep.dtend`,
          `  left join work._${num}_fu as f on f.enrolid = a.enrolid;`,
          `quit;`,
          ``,
          `data work._${num}_pt;`,
          `  set work._${num}_pt0;`,
          ...(censorS.atOutcome
            ? [`  /* follow-up stops at the earliest of outcome and admin censoring */`,
               `  censor_date = min(coalesce(fu_date, '31DEC9999'd), admin_censor);`]
            : [`  /* follow-up runs to the admin censor date (no censoring at outcome) */`,
               `  censor_date = admin_censor;`]),
          `  person_days = censor_date - index_date;`,
          `  keep enrolid person_days;`,
          `run;`,
          ``,
        ]
      : []),
    `/*-------------------- the ANALYTIC DATASET ----------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_subj as`,
    `  select a.enrolid,`,
    `         (case when a.arm = '${sq(p.exposedLevel)}' then 1 else 0 end) as exposed,`,
    ...(isRecurrentS
      ? [`         coalesce(n.n_events, 0) as y,   /* COUNT (recurrence: all_events) */`]
      : isCostS
        ? [`         coalesce(cst.cost, 0) as y,     /* COST (gamma_log response) */`]
        : [`         (case when f.enrolid is not null then 1 else 0 end) as y,`]),
    `         (year(a.index_date) - b.dobyr) as age_val,`,
    `         (case when b.sex = '1' then 1 else 0 end) as sex_male${cciScore ? "," : ""}`,
    ...(cciScore ? [`         coalesce(s.score, 0) as cci_val${isCountS ? "," : ""}`] : []),
    ...(isCountS ? [`         coalesce(pt.person_days, 0) as person_days`] : []),
    `  from work._${num}_atrisk as a`,
    ...(isCostS ? [] : [`  left join work._${num}_fu as f on f.enrolid = a.enrolid`]),
    `  left join (select enrolid, min(dobyr) as dobyr, min(sex) as sex`,
    `             from ${enrT} group by enrolid) as b`,
    `    on b.enrolid = a.enrolid`,
    ...(cciScore ? [`  left join ${cciScore.scoreTable} as s on s.enrolid = a.enrolid`] : []),
    ...(isCountS ? [`  left join work._${num}_pt as pt on pt.enrolid = a.enrolid`] : []),
    ...(isRecurrentS ? [`  left join work._${num}_evn as n on n.enrolid = a.enrolid`] : []),
    ...(isCostS ? [`  left join work._${num}_cost as cst on cst.enrolid = a.enrolid`] : []),
    `  ;`,
    `quit;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  The 2x2 and the CLOSED FORM - the same arithmetic as the SQL twin.`,
    `  A zero cell leaves the interval undefined; this returns missing rather than`,
    `  applying a continuity correction, which would change the estimand silently.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_cells as`,
    ...(isCostS
      ? [
          `  /* gamma needs y > 0, so zero-cost subjects are COUNTED and EXCLUDED,`,
          `     never dropped silently and never rescued with a small constant. */`,
          `  select sum(case when exposed = 1 and y > 0 then y else 0 end) as a_ee,`,
          `         sum(case when exposed = 1 and y > 0 then 1 else 0 end) as b_en,`,
          `         sum(case when exposed = 0 and y > 0 then y else 0 end) as c_ue,`,
          `         sum(case when exposed = 0 and y > 0 then 1 else 0 end) as d_un,`,
          `         sum(case when y = 0 then 1 else 0 end) as n_zero,`,
          `         sum(case when exposed = 1 then 1 else 0 end) as n_exp_all,`,
          `         sum(case when exposed = 0 then 1 else 0 end) as n_unexp_all,`,
          `         var(case when exposed = 1 and y > 0 then y else . end) as v_exp,`,
          `         var(case when exposed = 0 and y > 0 then y else . end) as v_unexp`,
        ]
      : isRecurrentS
      ? [
          `  /* a COUNT response has no "non-event" cell: a_ee sums counts, and`,
          `     b_en / d_un carry SUBJECT counts so the design rows still report`,
          `     arm sizes. */`,
          `  select sum(case when exposed = 1 then y else 0 end) as a_ee,`,
          `         sum(case when exposed = 1 then 1 else 0 end) as b_en,`,
          `         sum(case when exposed = 0 then y else 0 end) as c_ue,`,
          `         sum(case when exposed = 0 then 1 else 0 end) as d_un,`,
          `         max(y) as max_events,`,
        ]
      : [
          `  select sum(case when exposed = 1 and y = 1 then 1 else 0 end) as a_ee,`,
          `         sum(case when exposed = 1 and y = 0 then 1 else 0 end) as b_en,`,
          `         sum(case when exposed = 0 and y = 1 then 1 else 0 end) as c_ue,`,
          `         sum(case when exposed = 0 and y = 0 then 1 else 0 end) as d_un${isCountS ? "," : ""}`,
        ]),
    ...(isCountS
      ? [
          `         sum(case when exposed = 1 then person_days else 0 end) as pt_exp,`,
          `         sum(case when exposed = 0 then person_days else 0 end) as pt_unexp`,
        ]
      : []),
    `  from work._${num}_subj;`,
    `quit;`,
    ``,
    `data work._${num}_eff;`,
    `  set work._${num}_cells;`,
    ...(isRecurrentS || isCostS
      ? [`  n_exp   = b_en;`, `  n_unexp = d_un;`]
      : [`  n_exp   = a_ee + b_en;`, `  n_unexp = c_ue + d_un;`]),
    ...(isCostS
      ? [
          `  /* The saturated gamma-log model reproduces the observed arm MEANS, so`,
          `     its MLE of the exposure coefficient IS ln(mean_exposed/mean_ref).`,
          `     The interval below is the DELTA METHOD on that ratio - NOT the fitted`,
          `     model's interval, which needs the gamma dispersion parameter. */`,
          `  if a_ee > 0 and c_ue > 0 and b_en > 0 and d_un > 0 then`,
          `    log_cr = log((a_ee / b_en) / (c_ue / d_un));`,
          `  if a_ee > 0 and c_ue > 0 and b_en > 1 and d_un > 1 then`,
          `    se_log_cr = sqrt( v_exp / (b_en * (a_ee/b_en)**2)`,
          `                    + v_unexp / (d_un * (c_ue/d_un)**2) );`,
        ]
      : isCountS
      ? [
          `  /* the Poisson closed form: a ratio of RATES. Person-time enters the`,
          `     point estimate; the standard error depends only on event counts. */`,
          `  if a_ee > 0 and c_ue > 0 and pt_exp > 0 and pt_unexp > 0 then do;`,
          `    log_rr    = log((a_ee / pt_exp) / (c_ue / pt_unexp));`,
          `    se_log_rr = sqrt(1/a_ee + 1/c_ue);`,
          `  end;`,
        ]
      : [
          `  if a_ee > 0 and b_en > 0 and c_ue > 0 and d_un > 0 then do;`,
          `    log_or     = log((a_ee * d_un) / (b_en * c_ue));`,
          `    se_log_or  = sqrt(1/a_ee + 1/b_en + 1/c_ue + 1/d_un);`,
          `  end;`,
        ]),
    `run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  SATURATED-DESIGN ANCHOR.`,
    `  The model below has ONE predictor - the exposure - which makes it saturated`,
    `  for a 2x2: as many free parameters as cells to fit. Its maximum-likelihood`,
    `  estimate is therefore not an approximation of the closed-form log odds`,
    `  ratio, it IS that number. Comparing the two is the only check on the`,
    `  fitting machinery that does not require trusting it.`,
    `  descending: model the probability that y = 1, not y = 0.`,
    `----------------------------------------------------------------------------*/`,
    ...(isCountS
      ? [
          `data work._${num}_subj;`,
          `  set work._${num}_subj;`,
          `  /* the OFFSET. person_days = 0 cannot be logged, and a subject with no`,
          `     observed time contributes nothing to a rate, so it is set missing`,
          `     and GENMOD drops the row rather than silently treating it as 1 day. */`,
          `  if person_days > 0 then log_pt = log(person_days);`,
          `  else log_pt = .;`,
          `run;`,
          ``,
          `ods output ParameterEstimates = work._${num}_anchor_pe;`,
          `proc genmod data=work._${num}_subj;`,
          `  model y = exposed / dist=${glmDist} link=log${isCostS ? "" : " offset=log_pt"};`,
          `run;`,
        ]
      : [
          `ods output ParameterEstimates = work._${num}_anchor_pe;`,
          `proc logistic data=work._${num}_subj descending;`,
          `  model y = exposed;`,
          `run;`,
        ]),
    ``,
    `data work._${num}_anchor;`,
    `  merge work._${num}_anchor_pe (where=(upcase(Variable) = 'EXPOSED') rename=(Estimate = fitted_log_or))`,
    `        work._${num}_eff (keep=${isCostS ? "log_cr" : isCountS ? "log_rr" : "log_or"});`,
    `  length anchor_verdict $48;`,
    ...(isCostS ? [`  log_or = log_cr;`] : isCountS ? [`  log_or = log_rr;`] : []),
    `  _gap = abs(fitted_log_or - log_or);`,
    `  if log_or = . then anchor_verdict = 'NOT CHECKABLE (a zero cell)';`,
    `  else if _gap < 1e-6 then anchor_verdict = 'PASS: saturated MLE = closed form';`,
    `  else anchor_verdict = 'FAIL: saturated MLE differs from closed form';`,
    `  drop _gap;`,
    `run;`,
    ``,
    `title "Saturated-design anchor: fitted vs closed-form log odds ratio";`,
    `proc print data=work._${num}_anchor noobs;`,
    `  var fitted_log_or log_or anchor_verdict;`,
    `run;`,
    ``,
    `/*-------------------- the ADJUSTED model (SAS-primary) ----------------------*/`,
    `/* These estimates exist ONLY here: the SQL twin emits them NULL because`,
    `   fitting needs iteratively reweighted least squares. */`,
    ...(isCountS
      ? [
          `ods output ParameterEstimates = work._${num}_adj_pe;`,
          `proc genmod data=work._${num}_subj;`,
          `  model y = exposed${p.covariates.length > 0 ? " " + p.covariates.map(sasVar).join(" ") : ""} / dist=${glmDist} link=log${isCostS ? "" : " offset=log_pt"};`,
          `run;`,
        ]
      : [
          `ods output ParameterEstimates = work._${num}_adj_pe;`,
          `proc logistic data=work._${num}_subj descending;`,
          `  model y = exposed${p.covariates.length > 0 ? " " + p.covariates.map(sasVar).join(" ") : ""};`,
          `run;`,
        ]),
    ``,
    `title "Adjusted ${cmt(an.family)} model: ${label}";`,
    `proc print data=work._${num}_adj_pe noobs;`,
    `run;`,
    `title;`,
    ``,
    `/*-------------------- assemble the result table -----------------------------*/`,
    ...(an.family === "negative_binomial"
      ? [
          `/* the closed-form dispersion diagnostic, from the analytic dataset */`,
          `proc sql;`,
          `  create table work._${num}_disp as`,
          `  select var(y) as _var_y, mean(y) as _mean_y from work._${num}_subj;`,
          `quit;`,
          ``,
        ]
      : []),
    `data ${outT};`,
    `  set work._${num}_eff;`,
    ...(an.family === "negative_binomial" ? [`  if _n_ = 1 then set work._${num}_disp;`] : []),
    `  length measure $20 component $10 term $40 statistic $24 method $60;`,
    `  measure = "${MEASURE}";`,
    `  /* design */`,
    `  component='design'; term="${sq(p.exposedLevel)}";    statistic='n';      ord=0; estimate=n_exp;   method='observed'; ci_low=.; ci_high=.; se_log=.; output;`,
    `  component='design'; term="${sq(p.exposedLevel)}";    statistic='events'; ord=1; estimate=a_ee;    method='observed'; output;`,
    ...(isCountS
      ? [
          `  component='design'; term="${sq(p.exposedLevel)}"; statistic='person_days'; ord=2; estimate=pt_exp; method='observed'; output;`,
          `  component='design'; term="${sq(p.exposedLevel)}"; statistic='rate_per_1000py'; ord=3;`,
          `  if pt_exp > 0 then estimate = round(a_ee * 1000 * ${YS} / pt_exp, 0.00001); else estimate = .; output;`,
        ]
      : []),
    `  component='design'; term="${sq(p.referenceLevel)}";  statistic='n';      ord=${isCountS ? 4 : 2}; estimate=n_unexp; method='observed'; output;`,
    `  component='design'; term="${sq(p.referenceLevel)}";  statistic='events'; ord=${isCountS ? 5 : 3}; estimate=c_ue;    method='observed'; output;`,
    ...(isCountS
      ? [
          `  component='design'; term="${sq(p.referenceLevel)}"; statistic='person_days'; ord=6; estimate=pt_unexp; method='observed'; output;`,
          `  component='design'; term="${sq(p.referenceLevel)}"; statistic='rate_per_1000py'; ord=7;`,
          `  if pt_unexp > 0 then estimate = round(c_ue * 1000 * ${YS} / pt_unexp, 0.00001); else estimate = .; output;`,
        ]
      : []),
    `  /* crude, closed form - identical arithmetic to the SQL twin */`,
    `  component='crude'; term="${sq(stratLabel(gvLabel))}"; method='closed_form_2x2';`,
    ...(isCountS
      ? [
          `  statistic='rate_ratio'; ord=10;`,
          `  if log_rr ne . then do;`,
          `    estimate = round(exp(log_rr), 0.00001);`,
          `    ci_low   = round(exp(log_rr - 1.96 * se_log_rr), 0.00001);`,
          `    ci_high  = round(exp(log_rr + 1.96 * se_log_rr), 0.00001);`,
          `    se_log   = round(se_log_rr, 0.00001);`,
          `  end;`,
          `  output;`,
          `  ci_low=.; ci_high=.; se_log=.;`,
          `  statistic='rate_difference_per_1000py'; ord=11;`,
          `  if pt_exp > 0 and pt_unexp > 0`,
          `    then estimate = round(a_ee * 1000 * ${YS} / pt_exp - c_ue * 1000 * ${YS} / pt_unexp, 0.00001);`,
          `    else estimate = .;`,
          `  output;`,
        ]
      : [
          `  statistic='odds_ratio'; ord=10;`,
          `  if log_or ne . then do;`,
          `    estimate = round(exp(log_or), 0.00001);`,
          `    ci_low   = round(exp(log_or - 1.96 * se_log_or), 0.00001);`,
          `    ci_high  = round(exp(log_or + 1.96 * se_log_or), 0.00001);`,
          `    se_log   = round(se_log_or, 0.00001);`,
          `  end;`,
          `  output;`,
          `  ci_low=.; ci_high=.; se_log=.;`,
          `  statistic='risk_ratio'; ord=11;`,
          `  if n_exp > 0 and n_unexp > 0 and c_ue > 0`,
          `    then estimate = round((a_ee / n_exp) / (c_ue / n_unexp), 0.00001);`,
          `    else estimate = .;`,
          `  output;`,
          `  statistic='risk_difference'; ord=12;`,
          `  if n_exp > 0 and n_unexp > 0`,
          `    then estimate = round(a_ee / n_exp - c_ue / n_unexp, 0.00001);`,
          `    else estimate = .;`,
          `  output;`,
        ]),
    ...(an.family === "negative_binomial"
      ? [
          `  /* NB DISPERSION DEGENERACY, reported as data. With no subject above one`,
          `     event the response is Bernoulli, whose variance is always BELOW its`,
          `     mean: the dispersion parameter is not identified and the fit reduces`,
          `     to Poisson. Printing a dispersion estimate anyway would look like a`,
          `     measurement. */`,
          `  component='diagnostic'; term='overdispersion'; statistic='variance_to_mean_ratio'; ord=14;`,
          `  if _mean_y > 0 then estimate = round(_var_y / _mean_y, 0.00001); else estimate = .;`,
          `  ci_low=.; ci_high=.; se_log=.;`,
          `  if _var_y > _mean_y then method = 'OVERDISPERSED: NB warranted over Poisson';`,
          `  else method = 'NOT overdispersed: the NB dispersion parameter adds nothing';`,
          `  output;`,
          `  component='diagnostic'; term='overdispersion'; statistic='max_events_per_subject'; ord=15;`,
          `  estimate = max_events; ci_low=.; ci_high=.; se_log=.;`,
          `  if max_events <= 1 then method = 'DEGENERATE: dispersion NOT identified';`,
          `  else method = 'dispersion is estimable';`,
          `  output;`,
        ]
      : []),
    `  /* adjusted - the estimates the model above produced */`,
    `  estimate=.; ci_low=.; ci_high=.; se_log=.;`,
    `  component='adjusted'; statistic='${adjStatistic(an.family)}'; method="${adjMethod(an.family)}";`,
    ...modelTerms.map((t, i) => `  term="${sq(t)}"; ord=${20 + i}; output;`),
    `  keep measure component term statistic ord estimate ci_low ci_high se_log method;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by ord;`,
    `run;`,
    ``,
    `title "Regression: ${label}";`,
    `proc print data=${outT} noobs;`,
    `run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_glm${suffix}.sas`,
    language: "sas",
    title: `${num} Regression${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const regressionModule: AnalysisModule<RegressionAnalysis> = {
  analysisKind: "regression",
  stampKind: "regression",
  resultSlug: "glm",
  sql: sqlRegression,
  sas: sasRegression,
};
