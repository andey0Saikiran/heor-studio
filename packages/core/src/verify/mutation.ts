/**
 * Mutation tests — the standing proof that parity verification can FAIL.
 *
 * A verification suite that only ever runs against correct code proves
 * nothing about its own sensitivity. The stamp-only parity checks looked
 * green for months while being structurally incapable of failing (both
 * languages built the stamp from the same spec object), and an adversarial
 * review demonstrated it by sabotaging the SAS twin without turning anything
 * red.
 *
 * So: deliberately corrupt the emitted code — the way a bad edit or a
 * copy-paste slip actually would — and assert the fingerprint comparison
 * catches every corruption. Each mutation asserts twice:
 *
 *   1. the mutation ACTUALLY changed the text (else the test is vacuous and
 *      would "pass" by doing nothing);
 *   2. the resulting fingerprint mismatch is detected.
 *
 * A mutation that stops being caught means the harness lost sensitivity —
 * which is exactly the regression this file exists to prevent.
 */
import { emitSql } from "../emitters/sql";
import { emitSas } from "../emitters/sas";
import { parseParityStamps } from "../emitters/parity";
import {
  fingerprint,
  expectedFromStamp,
  diffFingerprints,
  diffAgainstExpected,
  constantProfile,
  diffConstantProfile,
  languageLocalChecks,
  spineFingerprint,
} from "./fingerprint";
import { sasStructureChecks } from "./sas-lint";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import { GOLD_F_SPEC, GOLD_F_OPTS } from "./fixture-f";
import { GOLD_G_SPEC, GOLD_G_OPTS } from "./fixture-g";
import { GOLD_H_SPEC, GOLD_H_OPTS } from "./fixture-h";
import { GOLD_I_SPEC, GOLD_I_OPTS } from "./fixture-i";
import { GOLD_J_SPEC, GOLD_J_OPTS } from "./fixture-j";
import type { StudySpec } from "../spec/types";
import type { Check } from "./run";

interface Mutation {
  /** what a reviewer would call this defect */
  name: string;
  /** parity kind whose program to corrupt */
  kind: string;
  /** which twin to corrupt */
  lang: "sql" | "sas";
  /** corrupt the analysis program (or the SAS setup file when `setup` is true) */
  apply: (text: string) => string;
  /** mutate 00_setup.sas instead of the analysis program */
  setup?: boolean;
  /** when a KIND has several analyses (two regressions, say), pick the program
   *  whose path matches. Without this every mutation lands on the first one and
   *  a pattern meant for the second reads as vacuous. */
  pathMatch?: RegExp;
  /**
   * Pin the gold spec whose emission to corrupt.
   *
   * The runner otherwise takes the FIRST source that emits the kind, which for
   * resource_use is Gold A — a program with none of the optional economics
   * declared. A mutation of the CPI factor would then find nothing to replace
   * and read as vacuous rather than as a test. Naming the fixture says which
   * emission the corruption is about.
   *
   * Gold I is the same story for the Wave-2 options: Gold A emits
   * propensity_score, iptw_outcome and g_formula with no banding, no
   * stratification and no E-value, so every corruption of those would land on a
   * program that never asked for them.
   */
  source?: "A" | "F" | "G" | "H" | "I" | "J";
  /**
   * Set when the mutation is DELIBERATELY not idempotent, with the reason.
   *
   * See the partial-replacement check below for why this field exists. The only
   * legitimate case so far is a mutation whose replacement text still contains
   * the pattern it matched — a wrapping corruption — which would re-wrap
   * forever if applied twice.
   */
  notIdempotent?: string;
}

/** Corruptions that MUST be caught. Each mirrors a real failure mode:
 *  a mistyped constant, a dropped predicate, a wrong unit, a flipped filter. */
const MUTATIONS: Mutation[] = [
  {
    name: "SAS rate is 100x too large (multiplier 1000 -> 100000)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(rate_per_1000py\s*=\s*round\(\s*patients\s*\*\s*)1000(\s*\*)/i, "$1100000$2"),
  },
  {
    name: "SAS person-time constant drifts (365.25 -> 365 in 00_setup)",
    kind: "incidence", lang: "sas", setup: true,
    apply: (t) => t.replace(/(%let\s+days_per_year\s*=\s*)365\.25/i, "$1365"),
  },
  {
    // Targets the admin_censor EXPRESSION, not the comment above it that
    // describes the same arithmetic — a mutation that only edits prose proves
    // nothing (the first version of this test did exactly that and "passed").
    name: "SAS adds a day to every patient's follow-up (+365 -> +366)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(min\([^;]*?index_date\s*\+\s*)365(\s*\)\s*as admin_censor)/i, "$1366$2"),
  },
  {
    name: "SAS care-setting filter inverted (outpatient -> inpatient)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(e\.setting\s*=\s*')OP(')/gi, "$1IP$2"),
  },
  {
    name: "SAS washout upper bound dropped (prevalent cases leak in)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/and\s+e\.svcdate\s*<=\s*a\.index_date\s*;/i, ";"),
  },
  {
    name: "SAS counts events ON the index date too (> becomes >=)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(e\.svcdate\s*)>(\s*a\.index_date)/i, "$1>=$2"),
  },
  {
    name: "SAS Byar CI loses its cube (**3 dropped)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/\*\*\s*3/g, "**1"),
  },
  {
    name: "SQL washout window widened (365 -> 730 days)",
    kind: "incidence", lang: "sql",
    apply: (t) => t.replace(/(index_date\s*-\s*)365(\s*\))/gi, "$1730$2"),
  },
  {
    name: "SQL point-prevalence anchor date shifted",
    kind: "point_prevalence", lang: "sql",
    apply: (t) => t.replace(/DATE\s*'2019-07-20'/gi, "DATE '2019-08-20'"),
  },
  {
    name: "SQL risk horizon doubled (365 -> 730)",
    kind: "cumulative_incidence", lang: "sql",
    apply: (t) => t.replace(/(index_date\s*\+\s*)365\b/i, "$1730"),
  },
  {
    name: "SQL Wilson z^2/2 constant mistyped (1.9208 -> 1.96)",
    kind: "point_prevalence", lang: "sql",
    apply: (t) => t.replace(/1\.9208/g, "1.96"),
  },
  {
    name: "SAS period-prevalence window shifted by a year",
    kind: "period_prevalence", lang: "sas",
    apply: (t) => t.replace(/'01JAN2019'd/gi, "'01JAN2018'd"),
  },
  {
    // POPULATION variance silently shrinks every SMD; the balance table would
    // still look plausible and would under-report imbalance.
    name: "SQL SMD switches to population variance (VAR_SAMP -> VAR_POP)",
    kind: "smd_balance", lang: "sql",
    apply: (t) => t.replace(/VAR_SAMP\(/gi, "VAR_POP("),
  },
  {
    name: "SAS SMD loses the pooled halving (denominator no longer /2)",
    kind: "smd_balance", lang: "sas",
    apply: (t) => t.replace(/\)\s*\/\s*2\s*\)/g, "))"),
  },
  {
    name: "SQL imbalance threshold loosened (0.1 -> 0.5)",
    kind: "smd_balance", lang: "sql",
    apply: (t) => t.replace(/>\s*0\.1\s*THEN 1/gi, "> 0.5 THEN 1"),
  },
  {
    name: "SAS balance reference arm flipped (sign of every SMD inverts)",
    kind: "smd_balance", lang: "sas",
    apply: (t) => t.replace(/in \('DRUG_X', 'DRUG_Y'\)/i, "in ('DRUG_Y', 'DRUG_X')"),
  },
  {
    /* One day. Events dated 2019-12-31 silently move out of the 2019 bucket and
     * the table still shows three complete years — the exact reason the bucket
     * boundaries are emitted as literals from ONE generator and fingerprinted. */
    name: "SQL trend bucket boundary shifted by a day (2019-12-31 -> 2019-12-30)",
    kind: "calendar_trend", lang: "sql",
    apply: (t) => t.replace(/DATE '2019-12-31'/, "DATE '2019-12-30'"),
  },
  {
    // Unequal scores change the statistic without changing a single count.
    name: "SAS trend scores no longer equally spaced (bucket 2 scored 3)",
    kind: "calendar_trend", lang: "sas",
    apply: (t) => t.replace(/bucket_ord = 2; bucket =/, "bucket_ord = 3; bucket ="),
  },
  {
    // sum(w^2 * n) is the variance term; pointing it at the case counts leaves a
    // finite, plausible z that is simply wrong.
    name: "SQL Cochran-Armitage variance term reads cases instead of denominators",
    kind: "calendar_trend", lang: "sql",
    apply: (t) => t.replace(/SUM\(bucket_ord \* bucket_ord \* denominator\)/, "SUM(bucket_ord * bucket_ord * patients)"),
  },
  {
    // Dividing by the variance rather than its square root: z shrinks toward
    // zero, so a real trend quietly reads as no trend.
    name: "SAS trend z divides by the variance, not its square root",
    kind: "calendar_trend", lang: "sas",
    apply: (t) => t.replace(/round\(t_stat \/ sqrt\(var_t\)/, "round(t_stat / (var_t)"),
  },
  {
    /* The pooled SE loses its weighting: with unequal arm variances this is a
     * different, wrong standard error that still looks like one.
     * /g because the emitter writes the pooled variance TWICE (once for the SD
     * row, once inside the SE); replacing one occurrence leaves the other
     * matching and the mutation reads as not-caught — the same
     * partial-replacement trap the D3 spine mutation fell into. */
    name: "SQL OLS pooled SE drops the degrees-of-freedom weighting",
    kind: "regression", lang: "sql", pathMatch: /glm_a_glm_ols/,
    apply: (t) => t.replace(/\(\(b_en - 1\) \* v_exp \+ \(d_un - 1\) \* v_unexp\)/g, "(v_exp + v_unexp)"),
  },
  {
    // The coefficient becomes the difference of TOTALS rather than means.
    name: "SAS OLS coefficient uses arm totals instead of arm means",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm_ols/,
    apply: (t) => t.replace(/mean_diff = m_exp - m_unexp;/, "mean_diff = a_ee - c_ue;"),
  },
  {
    /* Zero-cost subjects swept into the gamma fit. A gamma response must be
     * strictly positive, so this either fails at the site or — worse, if the
     * site's data has a floor — quietly changes which subjects the estimate
     * describes. */
    name: "SQL gamma model stops excluding zero-cost subjects",
    kind: "regression", lang: "sql", pathMatch: /glm_a_glm_cost/,
    apply: (t) => t.replace(/SUM\(CASE WHEN exposed = 1 AND y > 0 THEN y ELSE 0 END\) AS a_ee/, "SUM(CASE WHEN exposed = 1 THEN y ELSE 0 END) AS a_ee"),
  },
  {
    /* The cost ratio built from TOTALS rather than MEANS. With unequal arm
     * sizes those differ, and the result is still a plausible-looking ratio. */
    name: "SAS cost ratio divides arm TOTALS instead of arm means",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm_cost/,
    apply: (t) => t.replace(/log\(\(a_ee \/ b_en\) \/ \(c_ue \/ d_un\)\)/, "log(a_ee / c_ue)"),
  },
  {
    /* The recurrent response collapses back to an indicator: every subject with
     * two events silently becomes a subject with one, and the rate drops by an
     * amount nothing in the output explains. */
    name: "SQL recurrent response collapses to a 0/1 indicator (repeat events vanish)",
    kind: "regression", lang: "sql", pathMatch: /glm_a_glm_nb/,
    apply: (t) => t.replace(/COUNT\(DISTINCT a\.event_date\) AS n_events/, "MIN(1) AS n_events"),
  },
  {
    /* Person-time stops at the first event while counts keep accruing — the
     * incoherent combination readiness refuses, reintroduced downstream. */
    name: "SAS recurrent model censors person-time at the first event (later events uncountable)",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm_nb/,
    apply: (t) => t.replace(/censor_date = admin_censor;/, "censor_date = min(coalesce(fu_date, '31DEC9999'd), admin_censor);"),
  },
  {
    /* THE ESTIMAND SWAP: dividing counts instead of rates turns a rate ratio
     * into a risk-of-count ratio. The person-time is still computed, still
     * reported, and simply stops being used. */
    name: "SQL poisson rate ratio divides COUNTS instead of rates (the offset stops mattering)",
    kind: "regression", lang: "sql", pathMatch: /glm_a_glm_pois/,
    apply: (t) => t.replace(/LN\(\(a_ee \* 1\.0 \/ pt_exp\) \/ \(c_ue \* 1\.0 \/ pt_unexp\)\)/, "LN((a_ee * 1.0) / (c_ue * 1.0))"),
  },
  {
    // The Poisson SE depends on event counts alone; adding person-time terms
    // shrinks it and narrows every interval.
    name: "SAS poisson standard error pulls in person-time (interval silently narrows)",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm_pois/,
    apply: (t) => t.replace(/sqrt\(1\/a_ee \+ 1\/c_ue\)/, "sqrt(1/a_ee + 1/c_ue + 1/pt_exp + 1/pt_unexp)"),
  },
  {
    /* The cross-product inverted: OR becomes its own reciprocal. Still a
     * perfectly plausible odds ratio, pointing the opposite way. */
    name: "SQL odds ratio inverts the cross product (a*d / b*c becomes b*c / a*d)",
    kind: "regression", lang: "sql", pathMatch: /glm_a_glm\./,
    apply: (t) => t.replace(/LN\(\(a_ee \* 1\.0 \* d_un\) \/ \(b_en \* 1\.0 \* c_ue\)\)/, "LN((b_en * 1.0 * c_ue) / (a_ee * 1.0 * d_un))"),
  },
  {
    // Exposure and reference swap, flipping the sign of every reported effect.
    name: "SAS regression flips which arm is the exposure",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm\./,
    apply: (t) => t.replace(/when a\.arm = 'DRUG_Y' then 1/, "when a.arm = 'DRUG_X' then 1"),
  },
  {
    // A shorter horizon drops later events; the model answers a different question.
    name: "SQL regression horizon shortened (365 -> 180 days)",
    kind: "regression", lang: "sql", pathMatch: /glm_a_glm\./,
    apply: (t) => t.replace(/fu_date <= \(s\.index_date \+ 365\)/, "fu_date <= (s.index_date + 180)"),
  },
  {
    /* The Woolf SE loses a term: the interval narrows and the estimate looks
     * more precise than the data supports. */
    name: "SAS Woolf standard error drops a cell (1/d_un lost)",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm\./,
    apply: (t) => t.replace(/sqrt\(1\/a_ee \+ 1\/b_en \+ 1\/c_ue \+ 1\/d_un\)/, "sqrt(1/a_ee + 1/b_en + 1/c_ue)"),
  },
  {
    /* A zero cell silently continuity-corrected instead of returning NULL —
     * the estimand changes and nothing says so. */
    name: "SQL adds a continuity correction instead of returning NULL on a zero cell",
    kind: "regression", lang: "sql", pathMatch: /glm_a_glm\./,
    apply: (t) => t.replace(/CASE WHEN b_en > 0 AND c_ue > 0 AND a_ee > 0 AND d_un > 0/, "CASE WHEN 1 = 1"),
  },
  {
    // The SAS twin stops fitting, leaving a column of NULLs in both languages.
    name: "SAS regression stops fitting the adjusted model",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm\./,
    apply: (t) => t.replace(/_adj_pe/g, "_adj_skipped"),
  },
  {
    /* THE ANCHOR REMOVED. Without the saturated self-check the fitted estimates
     * are simply trusted — the one validation the site could actually see. */
    name: "SAS regression drops the saturated-design anchor check",
    kind: "regression", lang: "sas", pathMatch: /glm_a_glm\./,
    apply: (t) => t.replace(/anchor_verdict/g, "unused_note"),
  },
  {
    /* THE EXACT BUG the axis-vs-measure keying prevents: a second CONTINUOUS
     * covariate reading age's moments. The balance table then reports age's SMD
     * twice, once labelled "Comorbidity index", and every number in it is a
     * real number correctly computed from the wrong variable. */
    name: "SAS balance reads AGE's moments for the comorbidity index",
    kind: "smd_balance", lang: "sas",
    apply: (t) => t.replace(/value_ref = round\(cci_m_ref/, "value_ref = round(age_m_ref"),
  },
  {
    // The balance table stops applying the hierarchy while the index analysis
    // keeps applying it: two comorbidity means for one cohort.
    name: "SQL balance scores the comorbidity index WITHOUT the hierarchy",
    kind: "smd_balance", lang: "sql",
    apply: (t) => t.replace(/THEN 0 ELSE cd\.weight END AS weight_applied/, "THEN cd.weight ELSE cd.weight END AS weight_applied"),
  },
  {
    /* THE INPATIENT DOUBLE COUNT. Breaking the CASEID match lets a stay's own
     * service lines back in alongside the admission total that already contains
     * them — on the fixture, $15,000 becomes $22,000, and every number in the
     * table stays perfectly well-formed. */
    name: "SQL ledger double counts inpatient (admission total summed WITH its own service lines)",
    kind: "resource_use", lang: "sql",
    apply: (t) => t.replace(/i2\.caseid = s\.caseid/, "1 = 0"),
  },
  {
    // SAS loses the admission-date fallback, so a service line with no CASEID
    // is treated differently in the two twins.
    name: "SAS ledger loses the admission-date fallback for lines with no CASEID",
    kind: "resource_use", lang: "sas",
    apply: (t) => t.replace(/i2\.admdate = s\.admdate/, "1 = 0"),
  },
  {
    // Keying ambulatory encounters on something line-unique turns one visit
    // with three lines into three visits.
    name: "SQL ambulatory encounters keyed per claim LINE instead of per service date",
    kind: "resource_use", lang: "sql",
    apply: (t) => t.replace(/CAST\(o\.svcdate AS VARCHAR\) AS enc_id/, "CAST(o.svcdate AS VARCHAR) || CAST(o.paytot AS VARCHAR) AS enc_id"),
  },
  {
    // Dropping the NDC collapses two different drugs dispensed on one day into
    // a single fill, understating pharmacy utilization.
    name: "SAS pharmacy fills collapse to one per day (NDC dropped from the encounter key)",
    kind: "resource_use", lang: "sas",
    apply: (t) => t.replace(/put\(r\.svcdate, yymmdd10\.\) \|\| ':' \|\| strip\(r\.ndcnum\)/, "put(r.svcdate, yymmdd10.)"),
  },
  {
    /* A quantile the spec never asked for. On a program with reportQuantiles
     * OFF, the median is the only figure either twin may take, so a quartile
     * appearing beside it is a number the analyst did not declare and the SAS
     * twin does not compute. */
    name: "SQL adds an undeclared quartile beside the median",
    kind: "resource_use", lang: "sql", source: "A",
    apply: (t) => t.replace(/PERCENTILE_CONT\(0\.5\) WITHIN GROUP \(ORDER BY CAST\(paid AS DOUBLE PRECISION\)\) AS paid_median/,
      "PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY CAST(paid AS DOUBLE PRECISION)) AS paid_median"),
  },
  {
    // Leaving PCTLDEF implicit makes the median depend on a site option.
    name: "SAS leaves PCTLDEF to the site default (median silently becomes site-dependent)",
    kind: "resource_use", lang: "sas", source: "A",
    apply: (t) => t.replace(/ pctldef=5/, ""),
  },

  /* ---- THE ECONOMICS LAYER (Gold Case H) -----------------------------------
   * Every corruption below leaves a program that runs and prints a complete,
   * plausible cost table. None of them can be found by looking at the output:
   * a disease-related total that quietly equals the all-cause one, a PPPM over
   * the wrong denominator, a CPI factor of 1.0 and a flipped quantile
   * definition all produce dollar figures of the right magnitude and the wrong
   * meaning. They are pinned to Gold H because Gold A declares none of these
   * options, and a mutation with nothing to match is not a test. */
  {
    /* ATTRIBUTION FALLING BACK TO ALL-CAUSE. Drop the dr filter from the
     * disease-related sum and the two columns become the same number — which
     * looks like a study where everything is disease-related rather than like
     * a broken predicate. */
    name: "SQL disease-related cost silently sums EVERY payment (attribution falls back to all-cause)",
    kind: "resource_use", lang: "sql", source: "H",
    apply: (t) => t.replace(/SUM\(CASE WHEN dr = 1 THEN paid ELSE 0 END\) AS dr_paid,/g, "SUM(paid) AS dr_paid,"),
  },
  {
    name: "SAS disease-related cost silently sums EVERY payment",
    kind: "resource_use", lang: "sas", source: "H",
    apply: (t) => t.replace(/sum\(case when dr = 1 then paid else 0 end\) as dr_paid,/g, "sum(paid) as dr_paid,"),
  },
  {
    /* THE DIAGNOSIS SLOT, shifted. The outpatient family has no principal
     * column, so "primary" means DX1; reading DX2 instead attributes exactly
     * the claims the declared rule excludes and excludes the ones it counts.
     * The label still says primary_only. On Gold H this is the difference
     * between $20,250 and a number built from the wrong claim. */
    name: "SAS attribution reads a SECONDARY outpatient slot while still labelled primary_only",
    kind: "resource_use", lang: "sas", source: "H",
    apply: (t) => t.replace(/o\.dx1 in \(/g, "o.dx2 in ("),
  },
  {
    /* THE PPPM DENOMINATOR REVERTING TO THE FIXED WINDOW. observed_days is the
     * stitched-episode figure — the very quantity CostNormalization exists to
     * replace. On Gold H it turns $200.00 into $172.73 and nothing about the
     * table looks wrong. */
    name: "SQL PPPM divides by the fixed-window observed days instead of eligible member-time",
    kind: "resource_use", lang: "sql", source: "H",
    apply: (t) => t.replace(/s\.paid_elig \* 30\.0 \/ NULLIF\(s\.eligible_days, 0\)/g,
      "s.paid_elig * 30.0 / NULLIF(s.observed_days, 0)"),
  },
  {
    name: "SAS PPPM divides by the fixed-window observed days instead of eligible member-time",
    kind: "resource_use", lang: "sas", source: "H",
    apply: (t) => t.replace(/= round\(paid_elig \* 30\.0 \/ eligible_days, 0\.01\)/g,
      "= round(paid_elig * 30.0 / observed_days, 0.01)"),
  },
  {
    /* THE MEMBER-MONTH SOURCE. Reading the STITCHED episodes instead of the
     * enrollment segments puts every bridged gap back into the denominator —
     * months in which nobody was covered — and silently ignores capitation. */
    name: "SQL member-months read the stitched episodes, so bridged gaps re-enter the denominator",
    kind: "resource_use", lang: "sql", source: "H",
    apply: (t) => t.replace(/JOIN ccaet_all e ON e\.enrolid = c\.enrolid/g,
      "JOIN tz_h_enroll_episodes e ON e.enrolid = c.enrolid"),
  },
  {
    /* THE CPI FACTOR BECOMING 1.0. Every claim then enters in the dollars of
     * its own service year while the program still prints "2021 dollars". */
    name: "SQL CPI restatement becomes a no-op (every factor 1.0, label unchanged)",
    kind: "resource_use", lang: "sql", source: "H",
    apply: (t) => t.replace(/WHEN (\d{4}) THEN [\d.]+/g, "WHEN $1 THEN 1.00000000"),
  },
  {
    name: "SAS CPI restatement becomes a no-op (every factor 1.0, label unchanged)",
    kind: "resource_use", lang: "sas", source: "H",
    apply: (t) => t.replace(/when (\d{4}) then [\d.]+/g, "when $1 then 1.00000000"),
  },
  {
    /* A MISSING INDEX YEAR TREATED AS 1.0 rather than as missing: the claim
     * enters unadjusted, beside adjusted dollars, and nothing counts it. */
    name: "SQL restates a claim with no index year at 1.0 instead of leaving it NULL",
    kind: "resource_use", lang: "sql", source: "H",
    apply: (t) => t.replace(/ELSE NULL END AS paid/g, "ELSE 1.00000000 END AS paid"),
  },
  {
    /* THE QUANTILE DEFINITION FLIPPED. Both twins still compute a median; they
     * compute DIFFERENT medians, and on Gold H the answer moves from $1,575 to
     * $1,050 while the emitted label still reads "interpolated". */
    name: "SQL quantiles flip from the declared interpolated definition to nearest-rank",
    kind: "resource_use", lang: "sql", source: "H",
    apply: (t) => t.replace(/PERCENTILE_CONT\(/g, "PERCENTILE_DISC("),
  },
  {
    name: "SAS quantiles flip from the declared interpolated definition to nearest-rank (PCTLDEF=3)",
    kind: "resource_use", lang: "sas", source: "H",
    apply: (t) => t.replace(/pctldef=5/g, "pctldef=3"),
  },
  {
    /* CAPITATED MONTHS BACK IN THE NUMERATOR while the denominator still drops
     * them: real dollars over fewer months, so PPPM rises for a reason that has
     * nothing to do with the cohort. */
    name: "SQL PPPM numerator stops excluding claims from capitated months",
    kind: "resource_use", lang: "sql", source: "H",
    apply: (t) => t.replace(/SUM\(CASE WHEN elig = 1 THEN paid ELSE 0 END\) AS paid_elig,/g, "SUM(paid) AS paid_elig,"),
  },
  {
    /* THE CAPITATED PLAN LIST, emptied. Capitated months quietly rejoin the
     * denominator and the PPPM falls, with the program still saying they were
     * excluded. */
    name: "SAS capitated plan-type list loses POS-with-capitation (7)",
    kind: "resource_use", lang: "sas", source: "H",
    apply: (t) => t.replace(/not in \('4', '7'\)/g, "not in ('4')"),
  },
  {
    /* The hierarchy stops applying: severe forms ADD to their milder forms
     * instead of replacing them. Every score rises by a plausible amount and
     * the table stays perfectly well-formed — cohort mean 1.1 becomes 1.3. */
    name: "SQL comorbidity hierarchy stops withholding (severe forms ADD to mild ones)",
    kind: "comorbidity_index", lang: "sql",
    apply: (t) => t.replace(/THEN 0 ELSE cd\.weight END AS weight_applied/, "THEN cd.weight ELSE cd.weight END AS weight_applied"),
  },
  {
    // A superseded condition's prevalence would silently read as absent.
    name: "SQL condition prevalence counts only UNSUPERSEDED patients",
    kind: "comorbidity_index", lang: "sql",
    apply: (t) => t.replace(/FROM cond cd LEFT JOIN has h ON h\.cond_id = cd\.cond_id/, "FROM cond cd LEFT JOIN applied h ON h.cond_id = cd.cond_id AND h.weight_applied > 0"),
  },
  {
    // Members with no comorbidity drop out, so the mean is over the affected
    // rather than over the cohort — an inflated index that looks reasonable.
    name: "SAS index excludes members with no condition (mean over the affected, not the cohort)",
    kind: "comorbidity_index", lang: "sas",
    apply: (t) => t.replace(/left join work\._(\w+)_applied as b/, "inner join work._$1_applied as b"),
  },
  {
    name: "SAS comorbidity weight mistyped (severe liver 3 -> 2)",
    kind: "comorbidity_index", lang: "sas",
    apply: (t) => t.replace(/cond_id = "sliv"; cond_label = "([^"]*)"; weight = 3;/, 'cond_id = "sliv"; cond_label = "$1"; weight = 2;'),
  },
  {
    name: "SQL loses a supersession rule (complicated diabetes no longer replaces uncomplicated)",
    kind: "comorbidity_index", lang: "sql",
    apply: (t) => t.replace(/  UNION ALL SELECT 'dmc' AS winner, 'dm' AS loser\n/, "").replace(/  SELECT 'dmc' AS winner, 'dm' AS loser\n  UNION ALL /, "  "),
  },
  {
    name: "SQL comorbidity lookback widened (365 -> 730 days)",
    kind: "comorbidity_index", lang: "sql",
    apply: (t) => t.replace(/\(c\.index_date - 365\)/g, "(c.index_date - 730)"),
  },
  /* ---- negative weights: the failure modes that only exist once a weight can
   * be below zero, and that every twin was blind to until Wave 3 ------------- */
  {
    /* THE CLAMP. With only positive weights GREATEST(score, 0) is a no-op and
     * nobody would ever notice it; with a negative weight it silently rewrites
     * every negative patient to zero. The mean rises, the lowest band empties,
     * and the table is otherwise perfect. Gold A carries the same expression, so
     * this is caught on a spec that never asked for a negative weight either. */
    name: "SQL comorbidity score silently CLAMPED at zero (negative totals rewritten to 0)",
    kind: "comorbidity_index", lang: "sql",
    apply: (t) => t.replace(
      /COALESCE\(SUM\(a\.weight_applied\), 0\) AS score/g,
      "GREATEST(COALESCE(SUM(a.weight_applied), 0), 0) AS score",
    ),
  },
  {
    name: "SAS comorbidity score silently CLAMPED at zero (the same defect, other twin)",
    kind: "comorbidity_index", lang: "sas",
    apply: (t) => t.replace(
      /coalesce\(sum\(b\.weight_applied\), 0\) as score/g,
      "max(coalesce(sum(b.weight_applied), 0), 0) as score",
    ),
  },
  {
    /* A NEGATIVE WEIGHT FLIPPED POSITIVE. Every patient carrying it moves by 14
     * points and the index still looks like an index. Needs Gold J, which is the
     * only fixture with a negative weight to corrupt. */
    name: "SQL van Walraven drug-abuse weight loses its sign (-7 -> 7)",
    kind: "comorbidity_index", lang: "sql", source: "J",
    apply: (t) => t.replace(/'drug' AS cond_id, '([^']*)' AS cond_label, -7 AS weight/g, "'drug' AS cond_id, '$1' AS cond_label, 7 AS weight"),
  },
  {
    /* THE SUPERSEDED CONDITION LOSES ITS PREVALENCE AS WELL AS ITS WEIGHT, in
     * the SAS twin. The SQL twin's version of this is above; both are needed,
     * because the whole point of the rule is that a scoring convention must not
     * be allowed to hide a clinical fact in EITHER language. */
    name: "SAS condition prevalence counts only UNSUPERSEDED patients",
    kind: "comorbidity_index", lang: "sas",
    apply: (t) => t.replace(
      /left join work\._(\w+)_has as h on h\.cond_id = cd\.cond_id/g,
      "left join work._$1_applied as h on h.cond_id = cd.cond_id and h.weight_applied ne 0",
    ),
  },
  /* ---- sweeps: every one of these leaves a complete, well-formed summary ---- */
  {
    /* AN ARM IS DROPPED. The table still has a range, a primary estimate and a
     * direction verdict — computed over two arms instead of three, with the
     * disagreeing one gone. Nothing about the output looks short. */
    name: "SQL sweep drops the disagreeing arm from the arm table",
    kind: "sweep", lang: "sql", source: "J",
    apply: (t) => t.replace(/\n  UNION ALL\n  SELECT CAST\('fem' AS VARCHAR\) AS sw_arm_id[^\n]*/g, ""),
  },
  {
    /* THE PRIMARY ARM IS CHOSEN AFTER THE FACT. Replacing the pre-declared
     * predicate with "whichever arm has the largest effect" is the single most
     * consequential corruption in this file: it produces a study whose primary
     * analysis was selected by its own result, and the table it emits is
     * indistinguishable from an honest one. */
    name: "SQL sweep reassigns the primary arm to whichever has the largest effect",
    kind: "sweep", lang: "sql", source: "J",
    apply: (t) => t.replace(
      /SELECT sw_est AS primary_est FROM arms WHERE sw_arm_id = '[^']*'/g,
      "SELECT sw_est AS primary_est FROM arms ORDER BY sw_est DESC LIMIT 1",
    ),
  },
  {
    /* THE DIRECTION WARNING IS SUPPRESSED. Every arm is still reported and the
     * range is still right; the one row that says the sign flips now says it
     * does not. */
    name: "SQL sweep suppresses the direction-disagreement verdict (always 0)",
    kind: "sweep", lang: "sql", source: "J",
    apply: (t) => t.replace(/CASE WHEN n_above > 0 AND n_below > 0 THEN 1 ELSE 0 END/g, "0"),
  },
  {
    name: "SAS sweep suppresses the direction-disagreement verdict (the same defect, other twin)",
    kind: "sweep", lang: "sas", source: "J",
    apply: (t) => t.replace(/estimate = \(n_above > 0 and n_below > 0\)/g, "estimate = 0"),
  },
  {
    /* A SUBGROUP RELABELLED AS A SENSITIVITY CHECK. The number does not move at
     * all; only the claim attached to it does, from "the effect differs between
     * populations" to "the effect is stable under a different method". */
    name: "SAS sweep relabels the subgroup arm as a sensitivity check",
    kind: "sweep", lang: "sas", source: "J",
    apply: (t) => t.replace(/sw_arm_kind = 'subgroup'; sw_arm_label/g, "sw_arm_kind = 'sensitivity'; sw_arm_label"),
  },
  {
    /* THE ARM READS THE WRONG ROW of its own analysis's result table. A risk
     * ratio where an odds ratio belongs is the same order of magnitude, on the
     * same scale, about the same null. */
    name: "SQL sweep reads the risk ratio where the odds ratio was declared",
    kind: "sweep", lang: "sql", source: "J",
    apply: (t) => t.replace(/AND statistic = 'odds_ratio'\) AS sw_est/g, "AND statistic = 'risk_ratio') AS sw_est"),
  },
  {
    name: "SQL resource-use window shortened (364 -> 180 days)",
    kind: "resource_use", lang: "sql",
    apply: (t) => t.replace(/index_date \+ 364\)/g, "index_date + 180)"),
  },
  /* ---- survival ---------------------------------------------------------- *
   * Every mutation here is a defect that leaves a MONOTONE, PLAUSIBLE survival
   * curve. That is the whole hazard of this family: an inverted risk set or a
   * dropped tie correction does not crash, does not look odd on a plot, and
   * answers a different question with the same confidence. */
  {
    /* THE CLASSIC KAPLAN-MEIER BUG. `>=` includes subjects whose event is AT t,
     * which is correct - they are at risk right up to the instant they fail.
     * A `>` drops them from their own denominator, so every conditional
     * survival is too high and the whole curve lifts. */
    name: "SQL risk set excludes subjects who fail AT t (>= becomes >)",
    kind: "survival", lang: "sql", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/SUM\(CASE WHEN s\.t >= e\.t THEN 1 ELSE 0 END\) AS n_risk/g, "SUM(CASE WHEN s.t > e.t THEN 1 ELSE 0 END) AS n_risk"),
  },
  {
    /* Greenwood's denominator loses the (n-d) factor: the variance shrinks and
     * every interval on the curve narrows. The point estimates are untouched,
     * so nothing about the curve itself looks wrong. */
    name: "SAS Greenwood variance drops its (n - d) factor (every interval narrows)",
    kind: "survival", lang: "sas", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/_g \+ n_event \/ \(n_risk \* \(n_risk - n_event\)\)/, "_g + n_event / (n_risk * n_risk)"),
  },
  {
    /* The log-log limits swap. A larger exponent on a number below 1 gives a
     * SMALLER value, so +z belongs on the LOWER limit; swapping them produces an
     * interval that is still inside [0,1], still contains the estimate, and is
     * inverted. */
    name: "SQL log-log interval swaps its limits (+z lands on the upper bound)",
    kind: "survival", lang: "sql", pathMatch: /km_a_km\./,
    apply: (t) => t
      .replace(/EXP\(1\.96 \* \(SQRT\(gw\) \/ ABS\(LN\(surv\)\)\)\)\) END AS ci_low/, "EXP(-1.96 * (SQRT(gw) / ABS(LN(surv))))) END AS ci_low")
      .replace(/EXP\(-1\.96 \* \(SQRT\(gw\) \/ ABS\(LN\(surv\)\)\)\)\) END AS ci_high/, "EXP(1.96 * (SQRT(gw) / ABS(LN(surv))))) END AS ci_high"),
  },
  {
    /* Follow-up no longer stops at the endpoint. Every survival time becomes the
     * administrative one while the event flags stay set, so the curve describes
     * enrollment. Readiness forbids the SPEC that would do this; nothing stopped
     * the EMITTER from doing it. */
    name: "SAS follow-up no longer stops at the event (time becomes administrative)",
    kind: "survival", lang: "sas", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/t  = min\(coalesce\(fu_date, '31DEC9999'd\), admin_censor\) - index_date;/, "t  = admin_censor - index_date;"),
  },
  {
    /* The median's boundary. Gold Case A's reference arm lands on EXACTLY one
     * half, so a median defined with a strict `<` reports NOT REACHED for a
     * curve that plainly reached it. */
    name: "SQL median requires survival STRICTLY below one half (the boundary case vanishes)",
    kind: "survival", lang: "sql", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/surv <= 0\.5 \+ 1e-9/, "surv < 0.5 - 1e-9"),
  },
  {
    /* The log-rank expectation reads the WRONG margin: n instead of n1 gives an
     * expectation equal to the total events, and the statistic inflates. */
    name: "SQL log-rank expectation ignores the arm split (E = d, not d*n1/n)",
    kind: "survival", lang: "sql", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/SUM\(d \* 1\.0 \* n1 \/ NULLIF\(n, 0\)\) AS e_exp/, "SUM(d * 1.0) AS e_exp"),
  },
  {
    /* THE TIE CORRECTION, deleted. (n-d)/(n-1) equals 1 whenever d = 1, so on
     * Gold Case A - and on any fixture with distinct event times - this changes
     * NO executed number. It is caught by the fingerprint alone, which is
     * exactly why the fingerprint scrapes it. */
    name: "SAS log-rank drops the tie correction ((n-d)/(n-1) removed)",
    kind: "survival", lang: "sas", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/d \* \(n - d\) \* n1 \* \(n - n1\) \/ \(n \* n \* \(n - 1\)\)/g, "d * n1 * (n - n1) / (n * n)"),
  },
  {
    /* The alpha = 0.05 decision loosened to alpha = 0.10 while still LABELLED
     * 0.05 - a significance claim nobody chose. */
    name: "SQL log-rank decision uses the 0.10 critical value while still labelled 0.05",
    kind: "survival", lang: "sql", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/> 3\.8416 THEN 1 ELSE 0 END/, "> 2.7055 THEN 1 ELSE 0 END"),
  },
  {
    /* SAS-PRIMARY, deleted: the anchor goes away and the program still produces
     * every number, checking none of them. */
    name: "SAS deletes the PROC LIFETEST anchor (nothing checks the closed form)",
    kind: "survival", lang: "sas", pathMatch: /km_a_km\./,
    apply: (t) => t.replace(/anchor_verdict = 'PASS: LIFETEST = closed-form product limit'/, "anchor_verdict = 'PASS'"),
  },
  {
    /* SAS-PRIMARY, filled in: SQL guesses the p-value from the statistic it has
     * rather than deferring it. A normal-approximation p-value beside a
     * chi-square statistic is exactly the invented number the contract exists
     * to prevent. */
    name: "SQL fills in the log-rank p-value instead of leaving it to SAS",
    kind: "survival", lang: "sql", pathMatch: /km_a_km\./,
    /* The pattern anchors on the p_value row's ord (40004) and replaces the
     * FIRST NULL estimate that follows it. Anchoring on 'p_value' alone would
     * also match the method label two lines down, and anchoring on
     * "CAST(NULL AS NUMERIC)" alone would hit the first of eleven such casts
     * elsewhere in the file - the partial-replacement trap that made an earlier
     * OLS mutation read as NOT CAUGHT. */
    apply: (t) => t.replace(
      /(CAST\('p_value' AS VARCHAR\),\s*\n\s*CAST\(40004 AS INT\),(?:\s*CAST\(NULL AS INT\),)+\s*\n\s*)CAST\(NULL AS NUMERIC\)/,
      "$1CAST(0.05 AS NUMERIC)"),
  },
  /* ---- cox ----------------------------------------------------------------- *
   * The first two are the ones worth reading. Both corrupt a quantity that is
   * NUMERICALLY IDENTICAL on Gold Case A to the thing it was swapped with, so
   * execution against that fixture cannot see them at all — the fingerprint
   * can, and Gold Case C then makes them numbers. That pairing is the argument
   * for having both mechanisms. */
  {
    /* Breslow's information replaced by the LOG-RANK VARIANCE. They are the same
     * value whenever no event time is tied, which is every event time on Gold
     * Case A — so every executed check there still passes. On Gold Case C the
     * two are 3/4 and 13/20. */
    name: "SQL Cox information silently becomes the log-rank variance (identical without ties)",
    kind: "cox", lang: "sql",
    apply: (t) => t.replace(
      /SUM\(d \* 1\.0 \* n1 \* \(n - n1\) \/ NULLIF\(n \* 1\.0 \* n, 0\)\) AS information0/,
      "SUM(CASE WHEN n > 1 THEN d * 1.0 * (n - d) * n1 * (n - n1) / (n * 1.0 * n * (n - 1)) ELSE 0 END) AS information0"),
  },
  {
    /* The null partial log-likelihood loses its event-count weight. With d = 1
     * everywhere, d*ln(n) IS ln(n), so this changes nothing on Gold Case A and
     * shifts the number PHREG is checked against the moment a time is tied. */
    name: "SAS null log-likelihood drops the event-count weight (invisible without ties)",
    kind: "cox", lang: "sas",
    apply: (t) => t.replace(/-sum\(d \* log\(n\)\) as loglik0/, "-sum(log(n)) as loglik0"),
  },
  {
    /* The score loses its expectation: what remains is the raw exposed event
     * count, which is a number with the right units and no meaning as a score. */
    name: "SQL Cox score drops the expected count (U becomes O)",
    kind: "cox", lang: "sql",
    apply: (t) => t.replace(/SUM\(d1\) - SUM\(d \* 1\.0 \* n1 \/ NULLIF\(n, 0\)\) AS score_u0/, "SUM(d1) AS score_u0"),
  },
  {
    /* THE ANCHOR FIRES UNCONDITIONALLY. The closed form is only the maximum
     * when the risk-set share is constant; without that guard it prints a
     * confident wrong hazard ratio on every study that is not Gold Case C. */
    name: "SQL closed-form anchor drops its constant-proportion guard",
    kind: "cox", lang: "sql",
    apply: (t) => t.replace(/AND ABS\(c\.p_max - c\.p_min\) < 1e-12/, "AND 1 = 1"),
  },
  {
    /* The separation guard removed: with every event in one arm the maximum
     * likelihood estimate is INFINITE, and this would report a finite number
     * for it. */
    name: "SAS closed-form anchor stops guarding complete separation",
    kind: "cox", lang: "sas",
    apply: (t) => t.replace(/and d1_exposed > 0 and d1_exposed < d_total then do;/, "and 1 then do;"),
  },
  {
    /* THE STRONGEST SELF-CHECK, deleted. The program still fits the model and
     * still prints a coefficient; nothing then verifies that the coefficient
     * solves the equation defining it. */
    name: "SAS deletes the U(beta_hat) = 0 self-check",
    kind: "cox", lang: "sas",
    apply: (t) => t.replace(
      /u_at_bhat = u_at_bhat \+ d1 - d \* \(n1 \* _r\) \/ \(\(n - n1\) \+ n1 \* _r\);/,
      "u_at_bhat = 0;"),
  },
  {
    // The null -2logL comparison silently always passes.
    name: "SAS null -2logL check compares a number against itself",
    kind: "cox", lang: "sas",
    apply: (t) => t.replace(/_gap = abs\(closed_form_m2ll - phreg_m2ll\);/, "_gap = 0;"),
  },
  {
    /* ties=efron with Breslow closed forms. PHREG would maximize a DIFFERENT
     * likelihood than every quantity this program checks it against, so the
     * U(beta_hat)=0 check would fail on a correct fit — which is exactly why
     * readiness refuses efron rather than offering it. */
    name: "SAS switches to Efron ties while the closed forms stay Breslow",
    kind: "cox", lang: "sas",
    apply: (t) => t.replace(/\/ ties=breslow risklimits;/, "/ ties=efron risklimits;"),
  },
  {
    /* SAS-PRIMARY, filled in: SQL reports the one-step estimate as the fitted
     * coefficient. It is the right order of magnitude and the wrong number —
     * 0.35728 against a maximum of 0.35583 on Gold Case A, and 0.51342 against
     * an exact 0.5 on Gold Case C. */
    name: "SQL reports the one-step estimate as the FITTED Cox coefficient",
    kind: "cox", lang: "sql",
    /* /g DELIBERATELY: the emitter writes one adjusted row per model term, and
     * corrupting only the first leaves the others NULL for a single-occurrence
     * check to find. Same trap as the OLS pooled variance and the D3 spine. */
    apply: (t) => t.replace(
      /(CAST\('adjusted' AS VARCHAR\) AS component,[\s\S]{0,200}?CAST\(\d+ AS INT\) AS ord,\s*\n\s*)CAST\(NULL AS NUMERIC\) AS estimate/g,
      "$1ROUND(CAST(EXP(score_u0 / NULLIF(information0, 0)) AS NUMERIC), 5) AS estimate"),
  },
  /* ---- competing_risks --------------------------------------------------- *
   * The first is the one that matters. It is the standard way to write an
   * Aalen-Johansen estimator wrong, it produces a perfectly plausible monotone
   * curve, and on Gold Cases A, B and C it changes NOTHING — because none of
   * them has a competing event. It is exactly the 1 - KM bias the estimator
   * exists to remove, reintroduced silently. */
  {
    name: "SQL competing-risks risk set becomes PER-CAUSE (reintroduces the 1-KM bias)",
    kind: "competing_risks", lang: "sql",
    apply: (t) => t.replace(
      /SUM\(CASE WHEN s\.t = e\.t AND s\.cause > 0 THEN 1 ELSE 0 END\) AS d_all/,
      "SUM(CASE WHEN s.t = e.t AND s.cause = 1 THEN 1 ELSE 0 END) AS d_all"),
  },
  {
    /* The weight becomes S at the CURRENT event time instead of the previous
     * one. Every cumulative incidence comes out one factor too small, the curve
     * is still monotone and still below 1, and the partition identity — which
     * is the module's own self-check — breaks, which is the point of having it. */
    name: "SQL Aalen-Johansen weights by S(t) instead of S(t-)",
    kind: "competing_risks", lang: "sql",
    apply: (t) => t.replace(/ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING/, "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"),
  },
  {
    // the cross-term of the delta-method variance dropped: the SE is then
    // wrong by an amount that still looks like a standard error
    name: "SAS drops the cross-term from the delta-method variance",
    kind: "competing_risks", lang: "sas",
    apply: (t) => t.replace(/- 2 \* sum\( \(a\.cif_(\d+) - b\.cif_\d+\) \* b\.s_prev/g, "- 0 * sum( (a.cif_$1 - b.cif_$1) * b.s_prev"),
  },
  {
    /* The identity check reduced to a tautology. The row still prints HOLDS on
     * every dataset, including ones where the estimator is broken — which is
     * the failure mode a self-check that ships WITH the result has to be
     * protected against, since nobody downstream re-derives it. */
    name: "SQL partition-identity check always says HOLDS",
    kind: "competing_risks", lang: "sql",
    apply: (t) => t.replace(/CASE WHEN ABS\(\(cif_1 \+ cif_2\) - \(1\.0 - surv_all\)\) < 1e-9/, "CASE WHEN 1 = 1"),
  },
  {
    // the naive comparison stops treating competing events as censored, so the
    // "bias" it reports is zero on every dataset and the module silently loses
    // the only argument it makes
    name: "SAS naive KM counts ALL causes, so the reported bias is always zero",
    kind: "competing_risks", lang: "sas",
    apply: (t) => t.replace(/sum\(case when s\.t = e\.t and s\.cause = (\d+) then 1 else 0 end\) as d_k/g,
      "sum(case when s.t = e.t and s.cause > 0 then 1 else 0 end) as d_k"),
  },
  {
    /* Same-day tie between two causes resolved by cause DESCENDING. Nothing in
     * any current fixture has one, so no number moves — but the rule is part of
     * the twin contract, and the two languages would silently disagree about
     * which cause claimed the subject the first time a study had one. */
    name: "SQL breaks a same-day cause tie toward the COMPETING event instead",
    kind: "competing_risks", lang: "sql",
    apply: (t) => t.replace(/ORDER BY a\.event_date, a\.cause\) AS rn/, "ORDER BY a.event_date, a.cause DESC) AS rn"),
  },
  {
    name: "SAS deletes the PROC LIFETEST CIF anchor",
    kind: "competing_risks", lang: "sas",
    apply: (t) => t.replace(/eventcode=1;/, "eventcode=99;"),
  },
  {
    // the interval stops being clamped, so a probability can be reported below
    // zero or above one
    name: "SQL competing-risks interval is no longer clamped to [0,1]",
    kind: "competing_risks", lang: "sql",
    apply: (t) => t.replace(/GREATEST\(0\.0, cif_(\d+) - 1\.96/g, "(cif_$1 - 1.96"),
  },
  /* ---- fine_gray ---------------------------------------------------------- *
   * The first is the mutation this whole module is defined against: delete the
   * one predicate that retains competing-event subjects and you have a
   * cause-specific Cox model. It converges, it prints a hazard ratio, and it
   * answers a different question. */
  {
    name: "SQL Fine-Gray stops retaining competing-event subjects (silently becomes Cox)",
    kind: "fine_gray", lang: "sql",
    apply: (t) => t.replace(/WHERE x\.t >= e\.t OR x\.cause >= 2/, "WHERE x.t >= e.t"),
  },
  {
    /* G built on the EVENTS instead of on censoring. One predicate. The weights
     * come out wrong in a direction nobody would question, because the curve is
     * still monotone in [0,1] and the estimates still look like hazard ratios. */
    name: "SAS builds G on the EVENTS instead of the censoring distribution",
    kind: "fine_gray", lang: "sas",
    apply: (t) => t.replace(
      /sum\(case when x\.t = c\.t and x\.cause = 0 then 1 else 0 end\) as d/,
      "sum(case when x.t = c.t and x.cause > 0 then 1 else 0 end) as d"),
  },
  {
    // the weight inverted: G(t_j)/G(t) instead of G(t)/G(t_j), so retained
    // subjects gain influence over time instead of losing it
    name: "SQL inverts the IPCW weight ratio",
    kind: "fine_gray", lang: "sql",
    apply: (t) => t.replace(
      /ELSE COALESCE\(\(SELECT g\.g FROM fgg g WHERE g\.t <= e\.t ORDER BY g\.t DESC LIMIT 1\), 1\.0\)\n\s*\/ NULLIF\(COALESCE\(\(SELECT g\.g FROM fgg g WHERE g\.t <= x\.t ORDER BY g\.t DESC LIMIT 1\), 1\.0\), 0\)/,
      "ELSE COALESCE((SELECT g.g FROM fgg g WHERE g.t <= x.t ORDER BY g.t DESC LIMIT 1), 1.0)\n                 / NULLIF(COALESCE((SELECT g.g FROM fgg g WHERE g.t <= e.t ORDER BY g.t DESC LIMIT 1), 1.0), 0)"),
  },
  {
    /* THE DIAGNOSTIC THAT TELLS A READER WHICH MODEL THEY HAVE, corrupted back
     * to the definition that was actually wrong here first: "weight = 1" is not
     * "still at risk", because a retained subject also has weight 1 until G
     * drops. Gold Case D caught this the first time as a real defect. */
    name: "SQL infers cause-specific membership from the weight instead of the at-risk flag",
    kind: "fine_gray", lang: "sql",
    apply: (t) => t.replace(/SUM\(m\.at_risk\) AS n_cause_specific/, "SUM(CASE WHEN m.w = 1.0 THEN 1 ELSE 0 END) AS n_cause_specific"),
  },
  {
    name: "SAS drops eventcode= so PROC PHREG fits a cause-specific Cox model instead",
    kind: "fine_gray", lang: "sas",
    apply: (t) => t.replace(/ \/ eventcode=1 risklimits;/, " / risklimits;"),
  },
  {
    name: "SAS deletes the subdistribution-vs-cause-specific self-check",
    kind: "fine_gray", lang: "sas",
    apply: (t) => t.replace(/if wn_total > n_cs_total \+ 1e-9 then/g, "if 1 then"),
  },

  /* ---- TREATMENT SWITCHING --------------------------------------------
   * Every corruption below leaves a program reporting a switch rate between
   * 0% and 100%. Nothing raises, nothing looks impossible. */
  {
    /* THE OFF-BY-ONE, which decides P4 in Gold Case G: a 30-day supply from
     * day 0 ends on day 29, so a new drug on day 30 overlaps by ZERO. Drop the
     * -1 and P4's overlap becomes 1, flipping it out of the strict-rule group
     * with no impossible number anywhere. */
    name: "SQL drops the off-by-one on the index drug's last covered day",
    kind: "treatment_switching", lang: "sql",
    apply: (t) => t.replace(/\+ f\.days_supply - 1 AS d_end/g, "+ f.days_supply AS d_end"),
  },
  {
    name: "SAS drops the off-by-one on the index drug's last covered day",
    kind: "treatment_switching", lang: "sas",
    apply: (t) => t.replace(/\+ f\.daysupp - 1/g, "+ f.daysupp"),
  },
  {
    /* STRICTLY AFTER INDEX. Relaxing this reports a switch for every patient
     * who started BOTH drugs on day one - combination initiators become
     * switchers, and the switch rate rises for a reason that is pure
     * definition error. */
    name: "SQL lets a to-drug dispensed ON the index date count as a switch",
    kind: "treatment_switching", lang: "sql",
    apply: (t) => t.replace(/WHERE d_start > 0 AND/g, "WHERE d_start >= 0 AND"),
  },
  {
    name: "SAS lets a to-drug dispensed ON the index date count as a switch",
    kind: "treatment_switching", lang: "sas",
    apply: (t) => t.replace(/f\.svcdate - a\.index_date > 0/g, "f.svcdate - a.index_date >= 0"),
  },
  {
    /* THE THRESHOLD, moved rather than removed. Every count stays plausible
     * and a different set of patients is called switchers. */
    name: "SQL widens the permissible overlap to 90 days",
    kind: "treatment_switching", lang: "sql",
    apply: (t) => t.replace(/overlap_days <= 30/g, "overlap_days <= 90").replace(/overlap_days > 30/g, "overlap_days > 90"),
  },
  {
    name: "SAS widens the permissible overlap to 90 days",
    kind: "treatment_switching", lang: "sas",
    apply: (t) => t.replace(/overlap_days <= 30/g, "overlap_days <= 90").replace(/overlap_days > 30/g, "overlap_days > 90"),
  },
  {
    /* THE SENSITIVITY BAND. Collapsing the strict bound onto the declared rule
     * makes the band look narrow: the program then reports that the rule
     * decided almost nobody, which is the opposite of the truth on Gold G. */
    name: "SQL collapses the strict bound onto the declared rule, hiding the band",
    kind: "treatment_switching", lang: "sql",
    apply: (t) => t.replace(/overlap_days <= 0 THEN 1 ELSE 0 END AS switched_strict/g,
      "overlap_days <= 30 THEN 1 ELSE 0 END AS switched_strict"),
  },
  {
    /* THE OVERLAP FLOOR. Without GREATEST(...,0) a patient whose index supply
     * ended long before the new drug gets a NEGATIVE overlap, which is still
     * <= the threshold, so it keeps classifying as a switch - the mutation is
     * caught by the expression, not by the count. */
    name: "SQL removes the floor on overlap days",
    kind: "treatment_switching", lang: "sql",
    apply: (t) => t.replace(
      /GREATEST\(COALESCE\(fc\.from_last_day, t\.to_day - 1\) - t\.to_day \+ 1, 0\)/g,
      "COALESCE(fc.from_last_day, t.to_day - 1) - t.to_day + 1"),
  },
  {
    /* THE DEFINITIONAL CAVEAT on line of therapy. Deleting it leaves a line
     * number that travels without its definition, which is the single most
     * quietly wrong thing this module can emit. */
    name: "SQL deletes the line-of-therapy definitional caveat",
    kind: "treatment_switching", lang: "sql",
    apply: (t) => t.replace(/DEFINITIONAL, NOT MEASURED/g, "line of therapy"),
  },
  {
    name: "SAS deletes the line-of-therapy definitional caveat",
    kind: "treatment_switching", lang: "sas",
    apply: (t) => t.replace(/DEFINITIONAL, NOT MEASURED/g, "line of therapy"),
  },
  {
    /* THE SAS TWIN READING THE WRONG TABLE - the same defect class that
     * actually shipped in the adherence module. */
    name: "SAS switching reads an index-drug table no emitter creates",
    kind: "treatment_switching", lang: "sas",
    apply: (t) => t.replace(/tz\.&tag\._ev_\w+/g, "tz.&tag._020_rx"),
  },

  /* ---- ADHERENCE ------------------------------------------------------
   * Every corruption below leaves a program that runs and reports a PDC
   * between 0 and 1. That is the whole failure mode of this module: there is
   * no exception to raise and no impossible value to notice. */
  {
    /* THE OFF-BY-ONE. A 30-day supply dispensed on day 0 covers days 0..29.
     * Dropping the -1 gives every fill one extra day: on Gold F it takes P1's
     * six tiling fills to 186 covered days over a 180-day window, so PDC goes
     * ABOVE 1 — but only because that patient tiles exactly. For a patient with
     * any gap it just quietly raises adherence. */
    name: "SQL drops the interval off-by-one (supply covers one day too many)",
    kind: "adherence", lang: "sql",
    apply: (t) => t.replace(/\+ days_supply - 1/g, "+ days_supply"),
  },
  {
    name: "SAS drops the interval off-by-one",
    kind: "adherence", lang: "sas",
    apply: (t) => t.replace(/\+ f\.daysupp - 1 as d_end/g, "+ f.daysupp as d_end"),
  },
  {
    /* THE MERGE. Comparing against the previous row's end instead of the
     * running maximum splits an island whenever one fill is nested inside
     * another, which invents a gap and can turn a persistent patient into a
     * discontinuation. */
    name: "SQL merges islands against the PREVIOUS end instead of the running maximum",
    kind: "adherence", lang: "sql",
    apply: (t) => t.replace(
      /MAX\(d_end\) OVER \(PARTITION BY enrolid ORDER BY d_start, d_end/g,
      "LAG(d_end) OVER (PARTITION BY enrolid ORDER BY d_start, d_end"),
  },
  {
    /* THE STOCKPILE CURSOR. Replacing the running max with the bare start
     * removes the "finish the current supply first" assumption while leaving
     * a stockpiled column that still looks computed. On Gold F this is the
     * difference between P2 being adherent and not. */
    name: "SQL flattens the stockpile cursor to the raw fill start",
    kind: "adherence", lang: "sql",
    apply: (t) => t.replace(/MAX\(d_start - \(t_cum - days_supply\)\) OVER/g, "MIN(d_start - (t_cum - days_supply)) OVER"),
  },
  {
    name: "SAS flattens the stockpile cursor",
    kind: "adherence", lang: "sas",
    apply: (t) => t.replace(/u_max = max\(u_max, d_start - \(t_cum - days_supply\)\);/g, "u_max = d_start - (t_cum - days_supply);"),
  },
  {
    /* THE MPR GUARD. Removing GREATEST(...,0) lets a negative clipped span
     * subtract from days dispensed. MPR can then fall below PDC and the
     * program's own identity row reports "the interval merge is broken" about
     * a merge that is fine, sending the analyst to debug correct code. */
    name: "SQL removes the MPR numerator guard (a negative span subtracts from days dispensed)",
    kind: "adherence", lang: "sql",
    apply: (t) => t.replace(
      /SUM\(GREATEST\(LEAST\(d_end, (-?\d+)\) - GREATEST\(d_start, (-?\d+)\) \+ 1, 0\)\) AS dispensed/g,
      "SUM(LEAST(d_end, $1) - GREATEST(d_start, $2) + 1) AS dispensed"),
  },
  {
    /* CLEANING SILENCE. Keeping the drop but deleting the count restores
     * exactly the behaviour this module was built to eliminate: fills vanish
     * and the patient simply looks less adherent. */
    name: "SQL stops counting dropped fills (the drop stays, the attrition tally goes)",
    kind: "adherence", lang: "sql",
    apply: (t) => t.replace(/AS n_raw,/g, "AS n_ignored,"),
  },
  {
    /* THE DAYS-SUPPLY CAP, moved rather than removed: a cap of 3650 admits a
     * decade of supply on one dispensing and every downstream number stays
     * plausible. */
    name: "SQL widens the days-supply cap tenfold",
    kind: "adherence", lang: "sql",
    apply: (t) => t.replace(/days_supply IS NULL OR days_supply <= 365\)/g, "days_supply IS NULL OR days_supply <= 3650)"),
  },
  {
    name: "SAS widens the days-supply cap tenfold",
    kind: "adherence", lang: "sas",
    apply: (t) => t.replace(/daysupp = \. OR daysupp <= 365\)/g, "daysupp = . OR daysupp <= 3650)"),
  },
  {
    /* CENSORING COLLAPSED INTO DISCONTINUATION — the error that turns "still
     * on treatment when we stopped looking" into "never stopped". */
    name: "SQL counts everyone as discontinued, erasing the censoring distinction",
    kind: "adherence", lang: "sql",
    apply: (t) => t.replace(/COUNT\(\*\) - SUM\(discontinued\) AS n_censored/g, "0 AS n_censored"),
  },
  {
    /* THE SAS TWIN READING THE WRONG TABLE. This is the defect that actually
     * shipped: the module named a `020_rx` member no emitter creates. The
     * mutation reproduces it, so the harness is now the thing that would have
     * caught it. */
    name: "SAS reads a fills table that no emitter creates",
    kind: "adherence", lang: "sas",
    apply: (t) => t.replace(/tz\.&tag\._ev_\w+/g, "tz.&tag._020_rx"),
  },
  {
    name: "SAS deletes the U(beta_hat) = 0 check on the weighted risk sets",
    kind: "fine_gray", lang: "sas",
    apply: (t) => t.replace(
      /u_at_bhat = u_at_bhat \+ d1 - d \* \(wn1 \* _r\) \/ \(\(wn - wn1\) \+ wn1 \* _r\);/,
      "u_at_bhat = 0;"),
  },
  {
    /* The separation guard removed from the one-step. With every event in one
     * arm the score is at its extreme, and the step is a large FINITE number
     * standing in for an infinite estimate — which reads as an overwhelming
     * effect rather than as no estimate at all. Gold Case D is exactly that
     * data. */
    name: "SQL one-step drops its complete-separation guard",
    kind: "fine_gray", lang: "sql",
    apply: (t) => t.replace(/CASE WHEN d1_exposed > 0 AND d1_exposed < d_total THEN ROUND\(/g, "CASE WHEN 1 = 1 THEN ROUND("),
  },
  {
    name: "SQL reports the one-step as the FITTED subdistribution coefficient",
    kind: "fine_gray", lang: "sql",
    apply: (t) => t.replace(
      /(CAST\('adjusted' AS VARCHAR\) AS component,[\s\S]{0,260}?CAST\(\d+ AS INT\) AS ord,\s*\n\s*)CAST\(NULL AS NUMERIC\) AS estimate/g,
      "$1ROUND(CAST(EXP(score_u0 / NULLIF(information0, 0)) AS NUMERIC), 5) AS estimate"),
  },
  /* ---- propensity_score ---------------------------------------------------- */
  {
    /* The score stops being the cell fraction. Any other expression here is a
     * different estimator, and the saturated-MLE claim in every method note
     * becomes false while the pipeline still produces weights that look fine. */
    name: "SQL propensity score is no longer the cell treated fraction",
    kind: "propensity_score", lang: "sql",
    apply: (t) => t.replace(/SUM\(treated\) \* 1\.0 \/ COUNT\(\*\) AS ps/, "0.5 AS ps"),
  },
  {
    /* ATE and ATT differ ONLY in these two expressions. Swapping the control
     * weight gives a perfectly plausible set of weights for the other
     * estimand — and the label above them would still say ATE. */
    name: "SQL uses the ATT control weight while claiming ATE",
    kind: "propensity_score", lang: "sql",
    apply: (t) => t.replace(/ELSE 1\.0 \/ NULLIF\(1 - c\.ps, 0\) END AS w_raw/, "ELSE c.ps / NULLIF(1 - c.ps, 0) END AS w_raw"),
  },
  {
    /* A weight of 1/0 becomes a large finite number instead of NULL. It then
     * sums into a pseudo-population total that looks finite, and the positivity
     * gap — the whole diagnostic — reports a number nobody can interpret. */
    name: "SAS lets a zero denominator produce a weight instead of a missing value",
    kind: "propensity_score", lang: "sas",
    apply: (t) => t.replace(/if 1 - ps > 0 then w_raw = /, "if 1 else w_raw = "),
  },
  {
    /* THE WEIGHTED VARIANCE, replaced by the naive form. It shrinks the
     * denominator of every standardized difference, so a weighted analysis
     * looks better balanced than it is — in the direction nobody checks. */
    name: "SQL weighted variance becomes the naive SUM(w(x-xbar)^2)/SUM(w)",
    kind: "propensity_score", lang: "sql",
    apply: (t) => t.replace(/\(b\.sw_t \/ NULLIF\(b\.sw_t \* b\.sw_t - b\.sw2_t, 0\)\)/g, "(1.0 / NULLIF(b.sw_t, 0))"),
  },
  {
    /* The cell separator dropped, so "Male" + "1" and "Male" + "1..." collapse
     * into the same cell and two different covariate combinations get one
     * score. pathMatch is REQUIRED: a one-axis score emits no separator at all,
     * and programsByKind returns the first program of the kind — which is the
     * one-axis one, where this mutation is silently vacuous. */
    name: "SQL drops the cell separator, so distinct covariate combinations collide",
    kind: "propensity_score", lang: "sql", pathMatch: /_a_ps2\./,
    apply: (t) => t.replace(/ \|\| '\|' \|\| /g, " || "),
  },
  {
    name: "SAS deletes the PROC LOGISTIC saturation anchor",
    kind: "propensity_score", lang: "sas",
    apply: (t) => t.replace(
      /ps_anchor_verdict = 'PASS: saturated closed form = PROC LOGISTIC fitted probability'/,
      "ps_anchor_verdict = 'PASS'"),
  },
  {
    // Kish's ESS replaced by the raw n, which is the number weighting invalidates
    name: "SQL reports the raw n instead of the effective sample size",
    kind: "propensity_score", lang: "sql",
    apply: (t) => t.replace(/POWER\(sw_t, 2\) \/ NULLIF\(sw2_t, 0\)/, "CAST(n_t AS DOUBLE PRECISION)"),
  },
  /* ---- iptw_outcome -------------------------------------------------------- */
  {
    /* HAJEK -> HORVITZ-THOMPSON. SUM(wY)/n instead of SUM(wY)/SUM(w). It is a
     * different estimator, it can produce a "risk" above 1, and on any data
     * where the weights do not sum to n it silently reports the wrong number. */
    name: "SQL weighted risk becomes Horvitz-Thompson instead of Hajek",
    kind: "iptw_outcome", lang: "sql",
    apply: (t) => t.replace(/SUM\(w \* y\) \/ NULLIF\(SUM\(w\), 0\) AS mu/, "SUM(w * y) / NULLIF(COUNT(*), 0) AS mu"),
  },
  {
    /* THE SANDWICH REPLACED BY THE NAIVE FORM. p(1-p)/n_eff is the variance of
     * a different estimator and is too small, so every interval in the module
     * gets narrower and nothing about the output looks wrong. */
    name: "SQL sandwich variance becomes the naive p(1-p)/n_effective",
    kind: "iptw_outcome", lang: "sql",
    apply: (t) => t.replace(
      /SUM\(k\.w \* k\.w \* POWER\(k\.y - h\.mu, 2\)\) \/ NULLIF\(POWER\(h\.sw, 2\), 0\) AS var_mu/,
      "MAX(h.mu * (1 - h.mu)) / NULLIF(MAX(h.sw), 0) AS var_mu"),
  },
  {
    /* THE SCORE ESTIMATED ON THE WHOLE COHORT and applied to the at-risk set.
     * Weights built in one population and used in another describe neither, and
     * every number downstream still looks entirely ordinary. */
    name: "SAS estimates the score on the cohort instead of the at-risk set",
    kind: "iptw_outcome", lang: "sas",
    /* /g: the at-risk table appears several times in the SAS, and corrupting
     * only the first left the fingerprint's looser predecessor satisfied by a
     * later one. Fifth time a single-occurrence replacement has hidden a
     * partial corruption in this repo. */
    apply: (t) => t.replace(/from work\.(_\w+)_atrisk as a/g, "from tz.060_cohort as a"),
  },
  {
    // the identification row demoted below the estimates it qualifies
    name: "SQL moves the identification row below the effect estimates",
    kind: "iptw_outcome", lang: "sql",
    apply: (t) => t.replace(
      /(CAST\('identification' AS VARCHAR\) AS component, CAST\('subjects_off_support' AS VARCHAR\) AS statistic,\s*\n\s*)CAST\(0 AS INT\) AS ord/,
      "$1CAST(99 AS INT) AS ord"),
  },
  {
    /* THE RISK-DIFFERENCE INTERVAL CLAMPED. A limit pinned at exactly -1 reads
     * as a boundary rather than as an approximation that has broken down, which
     * is the one signal the diagnostic row exists to raise. */
    name: "SQL clamps the risk-difference interval into [-1, 1]",
    kind: "iptw_outcome", lang: "sql",
    notIdempotent: "the replacement WRAPS the text it matched, so the pattern still matches afterwards and a second pass would wrap again. Nothing is left uncorrupted — this is the one shape the twice-applied test cannot distinguish from a partial replacement.",
    apply: (t) => t.replace(/ROUND\(CAST\(mu1 - mu0 - 1\.96 \* \(SQRT\(v1 \+ v0\)\) AS NUMERIC\), 5\)/, "GREATEST(-1.0, ROUND(CAST(mu1 - mu0 - 1.96 * (SQRT(v1 + v0)) AS NUMERIC), 5))"),
  },
  {
    name: "SAS deletes the weighted saturated anchor",
    kind: "iptw_outcome", lang: "sas",
    apply: (t) => t.replace(/lsmeans treated;/, "/* lsmeans removed */"),
  },
  {
    // the crude contrast dropped, so the weighted number stands alone
    name: "SQL stops reporting the unadjusted contrast beside the weighted one",
    kind: "iptw_outcome", lang: "sql",
    apply: (t) => t.replace(/CAST\('unadjusted' AS VARCHAR\)/g, "CAST('effect' AS VARCHAR)"),
  },
  /* ---- g_formula ----------------------------------------------------------- */
  {
    /* THE UNDEFINED TERM IMPUTED TO ZERO. A cell with no treated subject has no
     * treated mean; COALESCE-ing it to 0 invents an outcome for a group that
     * does not exist, and the estimator then reports on the whole cohort with a
     * number partly made up. */
    name: "SQL imputes a missing cell mean to zero instead of leaving it undefined",
    kind: "g_formula", lang: "sql",
    apply: (t) => t.replace(/AVG\(CASE WHEN treated = 1 THEN y END\) AS m1/g, "COALESCE(AVG(CASE WHEN treated = 1 THEN y END), 0) AS m1"),
  },
  {
    /* THE RESTRICTION DROPPED. Single-arm cells re-enter, and every estimate
     * silently becomes a statement about a population where the contrast does
     * not exist. */
    name: "SQL stops restricting to cells with both arms",
    kind: "g_formula", lang: "sql",
    apply: (t) => t.replace(/WHERE n_t > 0 AND n_c > 0/g, "WHERE 1 = 1"),
  },
  {
    /* Cells weighted EQUALLY rather than by size. A different estimand, and one
     * that looks exactly like the right answer. */
    name: "SAS standardizes over equally-weighted cells instead of cell sizes",
    kind: "g_formula", lang: "sas",
    apply: (t) => t.replace(/sum\(n_cell \* m1\) \/ sum\(n_cell\) as g1/g, "mean(m1) as g1"),
  },
  {
    /* THE AUGMENTATION TERM DELETED. AIPW collapses to plain IPTW, the identity
     * with the g-formula breaks, and the module's own check catches it — which
     * is the point of emitting the identity as a row. */
    name: "SQL drops the AIPW augmentation term",
    kind: "g_formula", lang: "sql",
    apply: (t) => t.replace(/\s*- \(s\.treated - c\.e\) \/ NULLIF\(c\.e, 0\) \* c\.m1 AS a1_i/g, " AS a1_i"),
  },
  {
    /* The covariance dropped from the variance. The arms share every subject,
     * so this OVERSTATES the interval — the safe direction, and therefore the
     * one nobody questions. */
    name: "SQL treats the two arms as independent in the AIPW variance",
    kind: "g_formula", lang: "sql",
    apply: (t) => t.replace(/v1 \+ v0 - 2 \* cov10/g, "v1 + v0"),
  },
  {
    name: "SAS deletes the zero-variance boundary warning",
    kind: "g_formula", lang: "sas",
    apply: (t) => t.replace(/if v1 <= 0 or v0 <= 0 then method='AN ARM HAS ZERO/g, "if 0 then method='AN ARM HAS ZERO"),
  },
  /* ---- Wave 2: declared coarsening, stratification, E-values, controls ----
   *
   * All pinned to Gold I, the only fixture that declares any of them. Gold A
   * emits the same three kinds with none of these options, so a corruption
   * aimed at Gold A's emission would find nothing and read as vacuous.
   */
  {
    /* A BAND BOUNDARY MOVES. The label beside it still says '<50', so the
     * result table reads exactly as before while a subject aged 50-54 has
     * silently changed covariate value - and therefore changed cell, score,
     * weight and stratum. Nothing about the output looks unusual. */
    name: "SQL band boundary shifts (age cut 50 -> 55) while the label still says <50",
    kind: "propensity_score", lang: "sql", source: "I",
    apply: (t) => t.replace(/AS DOUBLE PRECISION\) < 50 THEN/g, "AS DOUBLE PRECISION) < 55 THEN"),
  },
  {
    /* A ONE-ARM STRATUM CONTRIBUTES ZERO INSTEAD OF NULL. Zero is a real
     * effect estimate: it is pooled as though it had been measured AND it
     * enlarges the denominator, so the pooled number moves twice. On Gold I it
     * moves from 185/42 to 185/48 while every count in the table stays put. */
    name: "SQL pools a one-arm stratum as 0 instead of excluding it as NULL",
    kind: "propensity_score", lang: "sql", source: "I",
    apply: (t) => t.replace(/ELSE NULL END AS diff/g, "ELSE 0 END AS diff"),
  },
  {
    /* THE CONVENTIONAL RECIPE. NTILE(K) over a SATURATED score cuts through
     * tied groups - everyone in a covariate cell shares the score - so which
     * subject lands on each side depends on row arrival order. That is the
     * exact order-dependence that got greedy matching refused, and it produces
     * a perfectly ordinary-looking set of quintiles. */
    name: "SQL forms strata with NTILE instead of boundaries between distinct scores",
    kind: "propensity_score", lang: "sql", source: "I",
    apply: (t) => t.replace(
      /LEAST\(5, FLOOR\(v\.n_below \* 5\.0 \/ NULLIF\(t\.n_all, 0\)\) \+ 1\)/g,
      "NTILE(5) OVER (ORDER BY v.ps)"),
  },
  {
    /* THE E-VALUE LOSES ITS SQUARE ROOT. RR + RR(RR-1) is still a number
     * larger than RR, still monotone in RR, and still looks like an E-value -
     * it is simply a different and much larger one, which reads as robustness. */
    name: "SQL E-value drops the sqrt term (RR + RR(RR-1) instead of RR + sqrt(RR(RR-1)))",
    kind: "iptw_outcome", lang: "sql", source: "I",
    apply: (t) => t.replace(/rr \+ SQRT\(rr \* \(rr - 1\)\)/g, "rr + (rr * (rr - 1))"),
  },
  {
    /* A NEGATIVE CONTROL SILENTLY PASSES. The upper limit of the breach test
     * is widened while the row that PRINTS the threshold still says 1.25, so
     * the table reports the declared threshold and the verdict was computed
     * against another one. Gold I's fracture control (RR = 21/8) stops
     * breaching and the suite reports "no control breached". */
    name: "SQL widens the negative-control breach test while still printing the declared threshold",
    kind: "negative_control", lang: "sql", source: "I",
    apply: (t) => t.replace(/ > 1\.25 THEN 1/g, " > 100 THEN 1"),
  },
  {
    /* THE RATIONALE GOES MISSING. Every ratio stays exactly the same, and the
     * suite becomes a list of outcomes nobody argued for - which a reader
     * cannot distinguish from a list of controls that were reasoned about. */
    name: "SQL drops the rationale row beside each negative control",
    kind: "negative_control", lang: "sql", source: "I",
    apply: (t) => t.replace(/CAST\('rationale' AS VARCHAR\) AS statistic/g, "CAST('control_note' AS VARCHAR) AS statistic"),
  },
];

interface Program {
  content: string;
  kind: string;
  stamp: Record<string, unknown>;
}

/** First emitted program carrying a stamp of the given kind, per language.
 *  `pathMatch` narrows to a specific analysis when a kind has several. */
function programsByKind(
  files: Array<{ path: string; content: string }>,
  pathMatch?: RegExp,
): Map<string, Program> {
  const out = new Map<string, Program>();
  for (const f of files) {
    if (pathMatch && !pathMatch.test(f.path)) continue;
    for (const s of parseParityStamps(f.content)) {
      if (!out.has(s.kind)) out.set(s.kind, { content: f.content, kind: s.kind, stamp: s.values });
    }
  }
  return out;
}

/** Run every mutation and report whether the harness catches it. */
export function mutationChecks(): Check[] {
  const checks: Check[] = [];
  /* Mutations used to be applied to GOLD_A_SPEC's output alone, which silently
   * limited what could be mutated to what Gold A happens to emit. Adherence is
   * the first module Gold A cannot express — it needs a fills feeder and a
   * refill pattern of its own — so a mutation of it would have reported "no
   * adherence program emitted" rather than testing anything. Each mutation now
   * resolves against the FIRST gold spec that emits its kind in both languages,
   * exactly as verify/coverage.ts does. */
  const SOURCES = [
    { name: "A", spec: GOLD_A_SPEC, opts: GOLD_A_OPTS },
    { name: "F", spec: GOLD_F_SPEC, opts: GOLD_F_OPTS },
    { name: "G", spec: GOLD_G_SPEC, opts: GOLD_G_OPTS },
    { name: "H", spec: GOLD_H_SPEC, opts: GOLD_H_OPTS },
    { name: "I", spec: GOLD_I_SPEC, opts: GOLD_I_OPTS },
    { name: "J", spec: GOLD_J_SPEC, opts: GOLD_J_OPTS },
  ].map(({ name, spec, opts }) => {
    const sas = emitSas(spec, opts);
    return {
      name,
      sql: emitSql(spec, "postgres", opts),
      sas,
      setup: sas.find((f) => /setup/i.test(f.path))?.content ?? "",
    };
  });

  for (const m of MUTATIONS) {
    const pool = m.source ? SOURCES.filter((s) => s.name === m.source) : SOURCES;
    const src =
      pool.find(
        (s) =>
          (m.pathMatch ? programsByKind(s.sql, m.pathMatch) : programsByKind(s.sql)).get(m.kind) &&
          (m.pathMatch ? programsByKind(s.sas, m.pathMatch) : programsByKind(s.sas)).get(m.kind),
      ) ?? pool[0] ?? SOURCES[0];
    const setup = src.setup;
    const sqlProg = (m.pathMatch ? programsByKind(src.sql, m.pathMatch) : programsByKind(src.sql)).get(m.kind);
    const sasProg = (m.pathMatch ? programsByKind(src.sas, m.pathMatch) : programsByKind(src.sas)).get(m.kind);
    if (!sqlProg || !sasProg) {
      checks.push({ name: `mutation: ${m.name}`, status: "fail", detail: `no ${m.kind} program emitted in both languages` });
      continue;
    }

    // Apply the corruption to exactly one artifact.
    const mutatedSetup = m.setup ? m.apply(setup) : setup;
    const mutatedSql = m.lang === "sql" && !m.setup ? m.apply(sqlProg.content) : sqlProg.content;
    const mutatedSas = m.lang === "sas" && !m.setup ? m.apply(sasProg.content) : sasProg.content;

    const changed = m.setup
      ? mutatedSetup !== setup
      : m.lang === "sql"
        ? mutatedSql !== sqlProg.content
        : mutatedSas !== sasProg.content;

    /* THE PARTIAL-REPLACEMENT CHECK.
     *
     * `String.replace` with a non-global pattern corrupts only the FIRST
     * occurrence. When the emitter writes the same expression several times —
     * an adjusted row per model term, a pooled variance used twice, an at-risk
     * table referenced throughout — the surviving copies satisfy any check that
     * merely asks "does the correct text appear", and the mutation reads as
     * CAUGHT or as vacuous for the wrong reason. That has happened FIVE times
     * in this repo (the D3 spine, the OLS pooled variance, the Cox adjusted
     * rows, the Fine-Gray self-check, the IPTW score population), and each time
     * it was found by accident.
     *
     * A partial replacement has an exact signature: applying the mutation
     * TWICE gives a different result from applying it once, because the second
     * pass finds the copies the first one left. So that is what is tested.
     *
     * A mutation that is legitimately non-idempotent — one whose replacement
     * still contains the pattern it matched — declares `notIdempotent` with a
     * reason, which turns silence into an explicit acknowledgement. */
    {
      const before = m.setup ? setup : m.lang === "sql" ? sqlProg.content : sasProg.content;
      const once = m.apply(before);
      const twice = m.apply(once);
      const idempotent = twice === once;
      checks.push({
        name: `mutation replaces EVERY occurrence: ${m.name}`,
        status: idempotent || m.notIdempotent ? "pass" : "fail",
        detail: m.notIdempotent
          ? `declared non-idempotent: ${m.notIdempotent}`
          : idempotent
            ? "applying it twice changes nothing more, so no copy was left behind"
            : "applying it TWICE changes the text again — the first pass left copies behind, so any check that asks whether the correct text still appears is satisfied by a survivor. Use the /g flag, or declare notIdempotent with the reason",
      });
    }

    if (!changed) {
      // The pattern no longer matches the emitted code: the mutation is a
      // no-op, so "caught" would be meaningless. Fail loudly instead.
      checks.push({
        name: `mutation: ${m.name}`,
        status: "fail",
        detail: "mutation pattern did not match the emitted code — the test is vacuous; update the pattern",
      });
      continue;
    }

    const fpSql = fingerprint(m.kind, "sql", mutatedSql);
    const fpSas = fingerprint(m.kind, "sas", mutatedSas, mutatedSetup);
    const crossLang = diffFingerprints(fpSql, fpSas);
    const vsStampSql = diffAgainstExpected(fpSql, expectedFromStamp(m.kind, sqlProg.stamp));
    const vsStampSas = diffAgainstExpected(fpSas, expectedFromStamp(m.kind, sasProg.stamp));
    const constSql = diffConstantProfile(m.kind, "sql", constantProfile("sql", mutatedSql));
    const constSas = diffConstantProfile(m.kind, "sas", constantProfile("sas", mutatedSas, mutatedSetup));
    /* SAS-PRIMARY contract keys are language-LOCAL, so the cross-language diff
     * deliberately skips them (see LANGUAGE_LOCAL_KEYS). They therefore have to
     * be evaluated here too, or a mutation that breaks the contract — SAS
     * quietly stopping fitting, or the saturated anchor being deleted — would
     * read as "not caught" while the harness genuinely does check it elsewhere.
     * Doing it in the generic runner means every future language-local key is
     * covered by every mutation automatically. */
    const local = [
      ...languageLocalChecks("sql", fpSql, m.kind).filter((c) => !c.ok),
      ...languageLocalChecks("sas", fpSas, m.kind).filter((c) => !c.ok),
    ];

    const reasons = [
      crossLang.length > 0 ? `cross-language: ${crossLang.join(" | ")}` : "",
      vsStampSql.length + vsStampSas.length > 0 ? `vs stamp: ${[...vsStampSql, ...vsStampSas].join(" | ")}` : "",
      constSql.length + constSas.length > 0 ? `constants: ${[...constSql, ...constSas].join(" | ")}` : "",
      local.length > 0 ? `SAS-primary contract: ${local.map((c) => c.detail).join(" | ")}` : "",
    ].filter(Boolean);
    const caught = reasons.length > 0;
    const how = reasons.join("; ");
    checks.push({
      name: `mutation caught: ${m.name}`,
      status: caught ? "pass" : "fail",
      detail: caught ? how : "NOT CAUGHT — the harness is blind to this corruption",
    });
  }

  checks.push(...sasPrimaryMutationChecks());
  checks.push(...sasStructureMutationChecks());
  checks.push(...spineMutationChecks());
  checks.push(...suppressionMutationChecks());
  return checks;
}

/** Corruptions of the SUPPRESSION pass. A disclosure control that quietly stops
 *  working is the worst failure in this file's remit: the output still looks
 *  finished, and the leak is invisible until someone else finds it. */
function suppressionMutationChecks(): Check[] {
  const checks: Check[] = [];
  const sqlFiles = emitSql(GOLD_A_SPEC, "postgres", GOLD_A_OPTS);
  const sup = sqlFiles.find((f) => /suppression/i.test(f.path));
  if (!sup) return [{ name: "suppression mutation", status: "fail", detail: "no suppression program emitted" }];

  const cases: Array<{ name: string; apply: (t: string) => string; detect: (t: string) => boolean }> = [
    {
      name: "threshold lowered to 1 (nothing would ever be masked)",
      apply: (t) => t.replace(/< 11\b/g, "< 1"),
      // a threshold of 1 can never fire: counts are integers, so n > 0 AND n < 1 is empty
      detect: (t) => /< 1\b(?!\d)/.test(t),
    },
    {
      name: "complementary (derivation-aware) clause removed",
      // /g: the clause is emitted once per result table, and a real regression
      // in the generator would drop every one of them — removing a single
      // occurrence leaves the others and proves nothing (the same
      // partial-replacement trap the D3 spine mutation fell into).
      apply: (t) => t.replace(/WHEN g\.n_supp = 1 AND[^\n]*\n/g, ""),
      detect: (t) => !/n_supp = 1 AND/.test(t),
    },
    {
      name: "masking turned into a pass-through (values no longer nulled)",
      apply: (t) => t.replace(/CASE WHEN supp = 1 THEN NULL ELSE (\w+) END AS \1/g, "$1"),
      detect: (t) => !/THEN NULL ELSE/.test(t),
    },
    {
      name: "denominator dropped from the small-cell test",
      apply: (t) => t.replace(/\s*OR \(r\.denominator > 0 AND r\.denominator < \d+\)/g, ""),
      detect: (t) => !/OR \(r\.denominator/.test(t),
    },
  ];

  for (const c of cases) {
    const mutated = c.apply(sup.content);
    if (mutated === sup.content) {
      checks.push({
        name: `suppression mutation: ${c.name}`,
        status: "fail",
        detail: "mutation pattern did not match — vacuous test; update the pattern",
      });
      continue;
    }
    const caught = c.detect(mutated) && !c.detect(sup.content);
    checks.push({
      name: `suppression mutation caught: ${c.name}`,
      status: caught ? "pass" : "fail",
      detail: caught ? "the emitted suppression program no longer has the property it must have" : "NOT CAUGHT",
    });
  }
  return checks;
}

/** Corruptions of the COHORT SPINE — the step every analysis depends on, and
 *  the one that had no parity coverage at all until two real defects (D1/D3)
 *  were found there by audit rather than by the harness. */
function spineMutationChecks(): Check[] {
  const checks: Check[] = [];
  const sqlFiles = emitSql(GOLD_A_SPEC, "postgres", GOLD_A_OPTS);
  const sasFiles = emitSas(GOLD_A_SPEC, GOLD_A_OPTS);
  const setup = sasFiles.find((f) => /setup/i.test(f.path))?.content ?? "";

  const base = () => spineFingerprint("sql", sqlFiles);

  const cases: Array<{ name: string; lang: "sql" | "sas"; apply: (t: string) => string }> = [
    {
      // exactly the D1 defect: SAS one day stricter than SQL
      name: "SAS continuous-enrollment window off by one day (the D1 defect)",
      lang: "sas",
      apply: (t) => t.replace(/(b\.dtstart\s*<=\s*a\.index_date\s*-\s*)\(\s*&baseline_days\.\s*-\s*1\s*\)/i, "$1&baseline_days."),
    },
    {
      // exactly the D3 defect: SQL compares against the previous row only
      name: "SQL episode stitching reverts to LAG (the D3 nested-segment defect)",
      lang: "sql",
      apply: (t) => t.replace(/MAX\(dtend\)\s*OVER\s*\(([^)]*)ROWS BETWEEN UNBOUNDED PRECEDING\s*AND 1 PRECEDING\)/gi, "LAG(dtend) OVER ($1)"),
    },
    {
      name: "SQL follow-up requirement shortened (365 -> 180)",
      lang: "sql",
      apply: (t) => t.replace(/(episode_end\s*>=\s*\(\s*i\.index_date\s*\+\s*)365/i, "$1180"),
    },
    {
      name: "SAS gap allowance widened (31 -> 90)",
      lang: "sas",
      apply: (t) => t.replace(/(%let\s+gap_allowance\s*=\s*)31/i, "$190"),
    },
  ];

  for (const c of cases) {
    const mutSql = c.lang === "sql" ? sqlFiles.map((f) => ({ ...f, content: c.apply(f.content) })) : sqlFiles;
    const mutSas = c.lang === "sas" ? sasFiles.map((f) => ({ ...f, content: c.apply(f.content) })) : sasFiles;
    const mutSetup = c.lang === "sas" ? c.apply(setup) : setup;

    const changed =
      c.lang === "sql"
        ? mutSql.some((f, i) => f.content !== sqlFiles[i].content)
        : mutSas.some((f, i) => f.content !== sasFiles[i].content) || mutSetup !== setup;
    if (!changed) {
      checks.push({ name: `spine mutation: ${c.name}`, status: "fail", detail: "mutation pattern did not match — vacuous test; update the pattern" });
      continue;
    }

    const fpSql = spineFingerprint("sql", mutSql);
    const fpSas = spineFingerprint("sas", mutSas, mutSetup);
    const drift = diffFingerprints(fpSql, fpSas);
    const stitchBroken = fpSql.stitch_uses_running_max !== "yes" || fpSas.stitch_uses_running_max !== "yes";
    const caught = drift.length > 0 || stitchBroken;
    checks.push({
      name: `spine mutation caught: ${c.name}`,
      status: caught ? "pass" : "fail",
      detail: caught
        ? [drift.join(" | "), stitchBroken ? "running-max stitch lost" : ""].filter(Boolean).join("; ")
        : `NOT CAUGHT — spine fingerprint is blind (${JSON.stringify(base())})`,
    });
  }
  return checks;
}

/** The SAS-PRIMARY contract must be enforceable in BOTH directions:
 *  a column that SQL is supposed to leave NULL must not be computed there, and
 *  a column SAS is supposed to compute must not go missing. Without these two
 *  mutations the contract is just a comment — the exemption from numeric parity
 *  would become a hole through which unverified numbers ship. */
function sasPrimaryMutationChecks(): Check[] {
  const checks: Check[] = [];
  const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
  const inc = spec.analyses.find((a) => a.kind === "incidence_rate");
  if (!inc || inc.kind !== "incidence_rate") {
    return [{ name: "sas-primary mutations", status: "fail", detail: "no incidence analysis in the gold spec" }];
  }
  inc.ciMethod = "poisson_exact"; // activates the SAS-primary columns

  const sqlProg = emitSql(spec, "postgres", GOLD_A_OPTS).find((f) => /incidence/.test(f.path))?.content ?? "";
  const sasFiles = emitSas(spec, GOLD_A_OPTS);
  const sasProg = sasFiles.find((f) => /incidence/.test(f.path))?.content ?? "";
  const setup = sasFiles.find((f) => /setup/i.test(f.path))?.content ?? "";

  // baseline: the contract must hold on the UNMUTATED emission
  const baseSql = fingerprint("incidence", "sql", sqlProg);
  const baseSas = fingerprint("incidence", "sas", sasProg, setup);
  checks.push({
    name: "sas-primary: contract holds on clean emission",
    status: baseSql.exact_ci_null_in_sql === "yes" && baseSas.exact_ci_computed_in_sas === "yes" ? "pass" : "fail",
    detail: `sql null=${baseSql.exact_ci_null_in_sql}, sas computed=${baseSas.exact_ci_computed_in_sas}`,
  });

  // direction 1: SQL fakes the number instead of leaving it NULL
  const faked = sqlProg.replace(
    /CAST\(NULL AS DOUBLE PRECISION\) AS ci_low_exact/i,
    "ROUND(ci_low * 0.98, 2) AS ci_low_exact",
  );
  const fakedChanged = faked !== sqlProg;
  const fakedFp = fingerprint("incidence", "sql", faked);
  checks.push({
    name: "sas-primary mutation caught: SQL computes a guess instead of NULL",
    status: fakedChanged && fakedFp.exact_ci_null_in_sql !== "yes" ? "pass" : "fail",
    detail: !fakedChanged
      ? "mutation pattern did not match — vacuous test"
      : fakedFp.exact_ci_null_in_sql !== "yes"
        ? "a plausible-looking SQL value is rejected (it would be wrong AND labeled right)"
        : "NOT CAUGHT — SQL may fabricate a SAS-primary column",
  });

  // direction 2: the SAS statistic is deleted
  const stripped = sasProg.replace(/gaminv\(/gi, "0*(");
  const strippedChanged = stripped !== sasProg;
  const strippedFp = fingerprint("incidence", "sas", stripped, setup);
  checks.push({
    name: "sas-primary mutation caught: SAS exact statistic deleted",
    status: strippedChanged && strippedFp.exact_ci_computed_in_sas !== "yes" ? "pass" : "fail",
    detail: !strippedChanged
      ? "mutation pattern did not match — vacuous test"
      : strippedFp.exact_ci_computed_in_sas !== "yes"
        ? "a SAS-primary column that stops being computed is detected"
        : "NOT CAUGHT — the SAS side could quietly stop computing it",
  });

  /* The SECOND SAS-primary column, on a different kind and for a different
   * reason (normal CDF rather than inverse incomplete gamma). Worth its own
   * mutations because the contract is only as good as its weakest instance, and
   * because the trend case is the one where SQL leaving a column NULL sits
   * directly beside a number SQL DOES compute — the tempting place to "just
   * fill it in for consistency". */
  {
    const sqlTrend = emitSql(GOLD_A_SPEC, "postgres", GOLD_A_OPTS).find((f) => /trend/.test(f.path))?.content ?? "";
    const sasAll = emitSas(GOLD_A_SPEC, GOLD_A_OPTS);
    const sasTrend = sasAll.find((f) => /trend/.test(f.path))?.content ?? "";
    const sasSetup = sasAll.find((f) => /setup/i.test(f.path))?.content ?? "";

    const cleanSql = fingerprint("calendar_trend", "sql", sqlTrend);
    const cleanSas = fingerprint("calendar_trend", "sas", sasTrend, sasSetup);
    checks.push({
      name: "sas-primary: trend p-value contract holds on clean emission",
      status: cleanSql.trend_p_null_in_sql === "yes" && cleanSas.trend_p_computed_in_sas === "yes" ? "pass" : "fail",
      detail: `sql null=${cleanSql.trend_p_null_in_sql}, sas computed=${cleanSas.trend_p_computed_in_sas}`,
    });

    // direction 1: SQL fills the p-value in with a constant rather than NULL
    const fakedP = sqlTrend.replace(
      /CAST\(NULL AS NUMERIC\),(\s*\n\s*)CAST\('sas_normal_cdf' AS VARCHAR\)/,
      "0.05,$1CAST('sas_normal_cdf' AS VARCHAR)",
    );
    const fakedPChanged = fakedP !== sqlTrend;
    const fakedPFp = fingerprint("calendar_trend", "sql", fakedP);
    checks.push({
      name: "sas-primary mutation caught: SQL fabricates the trend p-value",
      status: fakedPChanged && fakedPFp.trend_p_null_in_sql !== "yes" ? "pass" : "fail",
      detail: !fakedPChanged
        ? "mutation pattern did not match — vacuous test"
        : fakedPFp.trend_p_null_in_sql !== "yes"
          ? "a p-value in the SQL twin is rejected — it would carry the label of a test SQL never ran"
          : "NOT CAUGHT — SQL may invent a p-value",
    });

    // direction 2: the SAS p-value stops being computed, leaving the column
    // absent in BOTH twins while the method label still claims a source
    const noProbnorm = sasTrend.replace(/probnorm\(/gi, "0*(");
    const noProbnormChanged = noProbnorm !== sasTrend;
    const noProbnormFp = fingerprint("calendar_trend", "sas", noProbnorm, sasSetup);
    checks.push({
      name: "sas-primary mutation caught: SAS trend p-value deleted",
      status: noProbnormChanged && noProbnormFp.trend_p_computed_in_sas !== "yes" ? "pass" : "fail",
      detail: !noProbnormChanged
        ? "mutation pattern did not match — vacuous test"
        : noProbnormFp.trend_p_computed_in_sas !== "yes"
          ? "detected — otherwise the column would be NULL in SQL, absent in SAS, and labeled as sourced"
          : "NOT CAUGHT — the p-value could vanish from both twins",
    });

    /* The z statistic must NOT drift into the SAS-primary set. It is closed form
     * and executed against hand-computed truth; quietly declaring it SAS-primary
     * would retire a verified number into an unverifiable one — a regression
     * that ADDS a plausible-looking contract rather than breaking one. */
    checks.push({
      name: "sas-primary: the trend STATISTIC stays executable in SQL (not absorbed into the contract)",
      status: cleanSql.ca_z_is_t_over_sd === "yes" ? "pass" : "fail",
      detail: cleanSql.ca_z_is_t_over_sd === "yes"
        ? "z is computed in the SQL twin and executed by the harness; only the p-value is SAS-primary"
        : "SQL no longer computes z — a verified number has been moved beyond verification",
    });
  }

  return checks;
}

/** Corruptions the SAS STRUCTURAL lint must catch. Same principle as above: a
 *  structural check that has never gone red is an unproven check. */
const SAS_STRUCTURE_MUTATIONS: Array<{ name: string; apply: (t: string) => string }> = [
  {
    name: "SAS proc sql left unclosed (missing quit;)",
    apply: (t) => t.replace(/\bquit\s*;/i, ""),
  },
  {
    name: "SAS data step left unclosed (missing run;)",
    apply: (t) => t.replace(/\brun\s*;/i, ""),
  },
  {
    // Anchored on the _byar_low ASSIGNMENT: the first `sqrt(` in the file is
    // inside the comment that explains the formula, and corrupting prose
    // proves nothing (this mutation "passed" that way until it was retargeted).
    name: "SAS expression left with an unbalanced parenthesis",
    apply: (t) => t.replace(/(_byar_low\s*=\s*)\(/i, "$1(("),
  },
  {
    name: "SAS block comment left unterminated",
    apply: (t) => t.replace(/\*\//, " "),
  },
  {
    name: "SAS references an undefined macro variable",
    apply: (t) => t.replace(/&days_per_year\./i, "&days_per_yr."),
  },
  {
    name: "SAS analysis program loses its %include of 00_setup",
    apply: (t) => t.replace(/%include\s+["'][^"']*setup[^"']*["']\s*;/i, ""),
  },
];

function sasStructureMutationChecks(): Check[] {
  const checks: Check[] = [];
  const files = emitSas(GOLD_A_SPEC, GOLD_A_OPTS);
  const targetIdx = files.findIndex((f) => /incidence/i.test(f.path));
  if (targetIdx < 0) {
    return [{ name: "sas structure mutations", status: "fail", detail: "no incidence SAS program emitted" }];
  }

  for (const m of SAS_STRUCTURE_MUTATIONS) {
    const mutated = files.map((f, i) => (i === targetIdx ? { ...f, content: m.apply(f.content) } : f));
    if (mutated[targetIdx].content === files[targetIdx].content) {
      checks.push({
        name: `sas structure mutation: ${m.name}`,
        status: "fail",
        detail: "mutation pattern did not match — the test is vacuous; update the pattern",
      });
      continue;
    }
    const failures = sasStructureChecks(mutated).filter((c) => c.status === "fail");
    checks.push({
      name: `sas structure mutation caught: ${m.name}`,
      status: failures.length > 0 ? "pass" : "fail",
      detail: failures.length > 0
        ? failures.map((f) => f.detail).join(" | ").slice(0, 180)
        : "NOT CAUGHT — the SAS structural lint is blind to this",
    });
  }
  return checks;
}
