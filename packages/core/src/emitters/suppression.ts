/**
 * Small-cell suppression — the control that makes generated results releasable.
 *
 * BR-DEL-004: the "suppress cells below 11" rule comes from CMS Data Use
 * Agreements; no equivalent published Merative threshold exists for MarketScan,
 * where the constraint is contractual and journal-driven. So the threshold is
 * CONFIGURABLE (default 11) and every released table states the rule applied.
 *
 * The rule is DERIVATION-AWARE, which is the part naive implementations get
 * wrong: masking one cell is useless when the group total and the surviving
 * siblings let a reader subtract it back out. If a stratifier group ends up with
 * exactly ONE masked cell and more than one cell in total, the smallest
 * surviving cell is masked too (complementary suppression), so no single value
 * is recoverable by arithmetic.
 *
 * Suppression NEVER edits the analysis tables in place: each `<table>` keeps its
 * exact computed values for the analyst's own QC, and a parallel
 * `<table>_released` carries the masked, shareable version plus a `suppressed`
 * flag and the rule label. The generated code says plainly which of the two may
 * leave the analyst's environment.
 */
import type { StudySpec } from "../spec/types";

/** Resolved suppression policy for a study. */
export interface SuppressionPolicy {
  enabled: boolean;
  threshold: number;
  ruleLabel: string;
}

export const DEFAULT_SUPPRESSION_THRESHOLD = 11;

/** Policy for a spec, with BR-DEL-004 defaults. Suppression is ON unless the
 *  analyst turns it off: a disclosure control that defaults to off is one that
 *  gets forgotten, and forgetting is the failure mode that matters here. */
export function suppressionPolicy(spec: StudySpec): SuppressionPolicy {
  const s = spec.suppression;
  const threshold = s?.threshold != null && s.threshold > 0 ? Math.floor(s.threshold) : DEFAULT_SUPPRESSION_THRESHOLD;
  return {
    enabled: s?.enabled !== false,
    threshold,
    ruleLabel: s?.ruleLabel?.trim() || `cells with 1-${threshold - 1} patients suppressed (n < ${threshold})`,
  };
}

/** How one result table is masked. */
export interface SuppressionShape {
  /** columns identifying the row, copied through unchanged */
  labelCols: string[];
  /** columns defining a complementary-suppression group (siblings that sum to a total) */
  groupCols: string[];
  /** the patient count that decides whether the cell is small */
  countCol: string;
  /** denominator, if the table has one. A small DENOMINATOR is disclosive too:
   *  "3 of 3" identifies the group as surely as a small numerator does, and the
   *  numerator is recoverable from a published rate. */
  denomCol?: string;
  /** every column nulled when the row is suppressed (counts AND anything derived from them) */
  maskCols: string[];
  /** non-disclosive columns copied through (method labels etc.) */
  keepCols: string[];
  /** deterministic tiebreaker when two cells are equally small */
  tieBreakCol: string;
  /** A THIRD identity column for the results contract, for tables whose rows
   *  are not identified by two labels.
   *
   *  Every shape until survival was identified by (group, level) — a stratifier
   *  and its stratum, a term and its statistic. A life table is not: its rows
   *  are one curve at many TIMES, so (stratum, statistic) repeats down the
   *  whole table and the long-format deliverable would carry rows nothing could
   *  tell apart. Rather than distort the module into a two-column identity,
   *  the contract grew a nullable third column. Shapes that do not need it
   *  emit NULL, which is why the "fully labeled" check does not require it. */
  rowDetailCol?: string;
}

const ANALYSIS_COMMON = {
  labelCols: ["measure", "stratifier", "stratum"],
  groupCols: ["measure", "stratifier"],
  countCol: "patients",
  denomCol: "denominator",
  keepCols: ["ci_method"],
  tieBreakCol: "stratum",
};

/** Output shape per PARITY stamp kind (plus the spine's table1).
 *  Every registered module MUST appear here — enforced at load below, so a new
 *  analysis cannot ship results that quietly skip disclosure control. */
export const SUPPRESSION_SHAPES: Record<string, SuppressionShape> = {
  incidence: {
    ...ANALYSIS_COMMON,
    maskCols: ["patients", "denominator", "person_days", "person_years", "rate_per_1000py", "ci_low", "ci_high"],
  },
  point_prevalence: {
    ...ANALYSIS_COMMON,
    maskCols: ["patients", "denominator", "prevalence", "prevalence_pct", "ci_low", "ci_high"],
  },
  period_prevalence: {
    ...ANALYSIS_COMMON,
    maskCols: ["patients", "denominator", "prevalence", "prevalence_pct", "ci_low", "ci_high"],
  },
  cumulative_incidence: {
    ...ANALYSIS_COMMON,
    maskCols: ["patients", "denominator", "risk", "risk_pct", "ci_low", "ci_high"],
  },
  smd_balance: {
    // Rows are covariates, NOT a partition of a total, so complementary
    // suppression does not apply — each row is its own group (n_cells = 1).
    // Arm sizes are the disclosive quantity: a small arm masks the whole row.
    labelCols: ["characteristic", "measure"],
    groupCols: ["characteristic"],
    countCol: "n_ref",
    denomCol: "n_oth",
    maskCols: ["n_ref", "n_oth", "value_ref", "value_oth", "smd"],
    keepCols: ["imbalanced"],
    tieBreakCol: "characteristic",
  },
  standardization: {
    // Rows are age bands, which DO partition the cohort, so complementary
    // suppression applies: a lone masked band is recoverable from the Overall
    // row. The weights themselves are public reference data and stay visible —
    // masking them would hide the method without protecting anyone.
    labelCols: ["measure", "stratum"],
    groupCols: ["measure"],
    countCol: "patients",
    denomCol: "denominator",
    maskCols: ["patients", "denominator", "person_days", "person_years", "band_rate", "weighted_contribution", "dsr", "ci_low", "ci_high"],
    keepCols: ["weight", "ci_method", "covered_weight_pct"],
    tieBreakCol: "stratum",
  },
  calendar_trend: {
    /* Buckets do not partition the cohort - a member enrolled across several
     * buckets is counted once in each - but the Trend row IS the sum of them,
     * so a lone masked bucket is recoverable by subtraction exactly as it would
     * be from a true total. Complementary suppression therefore applies, with
     * the Trend row in the same group as the buckets it aggregates.
     *
     * trend_z masks with its row because the statistic is computed FROM every
     * bucket count, including the masked ones. */
    labelCols: ["measure", "bucket"],
    groupCols: ["measure"],
    countCol: "patients",
    denomCol: "denominator",
    maskCols: ["patients", "denominator", "prevalence", "prevalence_pct", "ci_low", "ci_high", "trend_z", "trend_p"],
    keepCols: ["bucket_ord", "b_start", "b_end", "is_partial", "ci_method", "trend_method", "trend_p_method"],
    tieBreakCol: "bucket",
  },
  resource_use: {
    /* Settings do not partition PATIENTS (one member can use several), but the
     * combined ALL row IS the sum of their encounters and payments, so a lone
     * masked setting is recoverable by subtraction. Complementary suppression
     * therefore applies, with ALL in the same group as its components.
     *
     * Every derived statistic masks with its row: a mean, an SD and a max over
     * a cell of two people are each as disclosive as the count. observed_days
     * stays visible - it is a property of enrollment, not of who used care. */
    labelCols: ["measure", "setting"],
    groupCols: ["measure"],
    countCol: "users",
    denomCol: "denominator",
    maskCols: [
      "users", "denominator", "users_pct", "encounters", "enc_per_patient", "enc_sd",
      "enc_median", "enc_max", "enc_per_person_year", "paid_total", "paid_per_patient",
      "paid_sd", "paid_median", "paid_max", "paid_per_person_year",
    ],
    keepCols: ["observed_days", "cost_field", "setting_ord"],
    tieBreakCol: "setting",
  },
  comorbidity_index: {
    /* The score-band rows DO partition the cohort, so a lone masked band is
     * recoverable from the others plus the index row's n. Condition rows do not
     * partition anything (a member can have several), but they sit in the same
     * table and a small condition cell is disclosive on its own.
     *
     * The WEIGHT stays visible: it is a published constant the analyst supplied,
     * not a property of any patient, and masking it would hide the method
     * without protecting anyone — the same call the standardization shape makes
     * about reference weights. */
    labelCols: ["measure", "component", "category"],
    groupCols: ["measure", "component"],
    countCol: "patients",
    denomCol: "denominator",
    maskCols: ["patients", "denominator", "pct", "score_mean", "score_sd", "score_median", "score_max"],
    keepCols: ["ord", "weight", "index_name"],
    tieBreakCol: "category",
  },
  regression: {
    /* The DESIGN rows are the 2x2, and the crude effect is computed FROM them,
     * so they are the disclosive quantity and everything derived masks with
     * them. Cells within a component do partition (exposed n = events +
     * non-events), which is why complementary suppression applies.
     *
     * The adjusted rows carry no counts at all — their estimates come from SAS —
     * but they mask with their group anyway: an adjusted odds ratio computed on
     * a handful of subjects is as identifying as the cells it was fitted on. */
    labelCols: ["measure", "component", "term", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate", "ci_low", "ci_high", "se_log"],
    keepCols: ["ord", "method"],
    tieBreakCol: "term",
  },
  survival: {
    /* THE LIFE TABLE IS THE MOST DISCLOSIVE TABLE THIS PROJECT PRODUCES, and
     * saying so is more useful than quietly masking it. Nearly every row of a
     * Kaplan-Meier life table carries n_event = 1 — that row is one patient's
     * event date, to the day. At the default threshold of 11 the whole
     * component masks, which is the correct answer and not a defect: the
     * releasable form of a survival curve is S(t) at a handful of fixed
     * horizons, where n_risk is a group rather than an individual.
     *
     * Grouping is per CURVE (measure, component, stratum). Within one curve the
     * life-table rows partition that arm's events and sum to its total, so a
     * lone masked row is recoverable by subtraction and complementary
     * suppression applies. Across curves they are not siblings — two arms at
     * day 200 do not sum to anything — so they are not grouped together.
     *
     * n_risk is the denominator because a small RISK SET is disclosive on its
     * own: "3 still at risk, 1 event" identifies a person as surely as the
     * event count does, and the survival drop reveals the numerator anyway.
     * The median, log-rank and hazard-ratio rows carry no counts, so they are
     * not primary-suppressed — but each is computed FROM the whole curve, and
     * an arm small enough to mask is an arm whose median is as identifying as
     * the cells it came from. */
    labelCols: ["measure", "component", "time_days", "stratum", "statistic"],
    groupCols: ["measure", "component", "stratum"],
    rowDetailCol: "time_days",
    countCol: "n_event",
    denomCol: "n_risk",
    maskCols: ["n_risk", "n_event", "n_censor", "estimate", "se", "ci_low", "ci_high"],
    keepCols: ["ord", "method"],
    tieBreakCol: "time_days",
  },
  treatment_switching: {
    /* Every switching statistic is a count of PEOPLE, or a mean computed from
     * one, so the whole block masks together. mean_days_to_switch is the
     * disclosive one to watch: with a single switcher it IS that person's
     * switch date. */
    labelCols: ["measure", "component", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate"],
    keepCols: ["ord", "method"],
    tieBreakCol: "statistic",
  },
  adherence: {
    /* Patient counts are the disclosive quantity — n_adherent and
     * n_discontinued are counts of people. The means are computed from them, so
     * everything masks together. */
    labelCols: ["measure", "component", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate"],
    keepCols: ["ord", "method"],
    tieBreakCol: "statistic",
  },
  g_formula: {
    labelCols: ["measure", "component", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate", "se", "ci_low", "ci_high"],
    keepCols: ["ord", "method"],
    tieBreakCol: "statistic",
  },
  iptw_outcome: {
    /* The DESIGN rows carry raw event counts, which are the disclosive
     * quantity; the effect rows are computed from them. Everything masks
     * together, and the identification rows keep their method text because a
     * suppressed table that hid "the effect is not identified" would be worse
     * than one that hid the estimate. */
    labelCols: ["measure", "component", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate", "se", "ci_low", "ci_high"],
    keepCols: ["ord", "method"],
    tieBreakCol: "statistic",
  },
  propensity_score: {
    /* Cell counts and pseudo-population sizes are the disclosive quantities
     * here — a cell of one is one identifiable person, and the positivity rows
     * are built from exactly those cells. Everything masks with them. */
    labelCols: ["measure", "component", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate"],
    keepCols: ["ord", "term", "method"],
    tieBreakCol: "statistic",
  },
  fine_gray: {
    /* The same shape as cox — the design rows carry the counts everything else
     * is computed from, and an estimate fitted on a handful of events is as
     * identifying as those counts. */
    labelCols: ["measure", "component", "term", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate", "se", "ci_low", "ci_high"],
    keepCols: ["ord", "method"],
    tieBreakCol: "statistic",
  },
  competing_risks: {
    /* The life-table rows are per-event-time and therefore per-patient, exactly
     * as the survival module's are; the horizon rows are not. Grouping by
     * component keeps the two under separate complementary-masking groups, so a
     * suppressed life table does not drag the horizon estimates down with it. */
    /* at_label sits INSIDE the list, not at the end: the results contract takes
     * the LAST TWO label columns as the row identity, so (cause, component)
     * must be last and the point identifier rides along as rowDetailCol. */
    labelCols: ["measure", "at_label", "cause", "component"],
    groupCols: ["measure", "component", "cause"],
    countCol: "n_event",
    denomCol: "n_risk",
    maskCols: ["n_risk", "n_event", "estimate", "se", "ci_low", "ci_high"],
    keepCols: ["at_kind", "at_days", "method"],
    /* at_label carries the point identity — event time or horizon, never both
     * — so (cause, component, at_label) is unique and every contract row is
     * fully labeled. */
    rowDetailCol: "at_label",
    tieBreakCol: "at_label",
  },
  cox: {
    /* Same shape as the regression table, and for the same reason: the DESIGN
     * rows are the counts everything else is computed from, so everything masks
     * with them. The score, information and one-step rows carry no counts, but
     * an estimate fitted on a handful of events is as identifying as the event
     * counts it came from — and unlike the survival life table, none of these
     * rows is per-patient, so the whole table does not vanish at a realistic
     * threshold. */
    labelCols: ["measure", "component", "term", "statistic"],
    groupCols: ["measure", "component"],
    countCol: "estimate",
    maskCols: ["estimate", "se", "ci_low", "ci_high"],
    keepCols: ["ord", "method"],
    tieBreakCol: "statistic",
  },
  table1: {
    labelCols: ["ord", "characteristic", "category"],
    groupCols: ["characteristic"],
    countCol: "n_patients",
    // means/SDs/medians of a tiny cell are disclosive too, so they mask with it
    maskCols: ["n_patients", "pct", "mean_val", "sd_val", "median_val"],
    keepCols: [],
    tieBreakCol: "category",
  },
};

/** A result table to be suppressed. */
export interface SuppressionTarget {
  /** unqualified table name, e.g. "tz_study_incidence" */
  table: string;
  /** key into SUPPRESSION_SHAPES */
  shapeKey: string;
  /** human label for the generated comment */
  label: string;
}

export function shapeFor(shapeKey: string): SuppressionShape | undefined {
  return SUPPRESSION_SHAPES[shapeKey];
}

/* -------------------------------------------------------------- *
 *  SQL
 * -------------------------------------------------------------- */

/** Suppression pass for one table (Postgres/Snowflake — plain window functions). */
export function suppressionSqlFor(t: SuppressionTarget, p: SuppressionPolicy): string[] {
  const s = SUPPRESSION_SHAPES[t.shapeKey];
  if (!s) return [`-- (no suppression shape registered for ${t.shapeKey}; table left unreleased)`];
  const grp = s.groupCols.join(", ");
  const out: string[] = [];

  out.push(`-- ${t.label}`);
  out.push(`DROP TABLE IF EXISTS ${t.table}_released;`);
  out.push(`CREATE TABLE ${t.table}_released AS`);
  out.push(`WITH flagged AS (`);
  out.push(`  -- A cell is small when its patient count OR its denominator is above`);
  out.push(`  -- zero but below the threshold. A true zero is not disclosive and stays`);
  out.push(`  -- visible; a small denominator is (a rate then reveals the numerator).`);
  out.push(`  SELECT r.*,`);
  out.push(`         CASE WHEN (r.${s.countCol} > 0 AND r.${s.countCol} < ${p.threshold})`);
  if (s.denomCol) out.push(`               OR (r.${s.denomCol} > 0 AND r.${s.denomCol} < ${p.threshold})`);
  out.push(`              THEN 1 ELSE 0 END AS primary_supp`);
  out.push(`  FROM ${t.table} r`);
  out.push(`),`);
  out.push(`grp AS (`);
  out.push(`  SELECT f.*,`);
  out.push(`         SUM(f.primary_supp) OVER (PARTITION BY ${grp}) AS n_supp,`);
  out.push(`         COUNT(*)            OVER (PARTITION BY ${grp}) AS n_cells,`);
  out.push(`         ROW_NUMBER() OVER (PARTITION BY ${grp}, f.primary_supp`);
  out.push(`                            -- zeros LAST: masking a true zero adds no`);
  out.push(`                            -- protection (the masked cells would still sum`);
  out.push(`                            -- to the recoverable value), so the complementary`);
  out.push(`                            -- mask must land on the smallest NON-ZERO cell.`);
  out.push(`                            ORDER BY CASE WHEN f.${s.countCol} = 0 THEN 1 ELSE 0 END,`);
  out.push(`                                     f.${s.countCol}, f.${s.tieBreakCol}) AS rn_small`);
  out.push(`  FROM flagged f`);
  out.push(`),`);
  out.push(`decided AS (`);
  out.push(`  SELECT g.*,`);
  out.push(`         CASE`);
  out.push(`           WHEN g.primary_supp = 1 THEN 1`);
  out.push(`           -- DERIVATION-AWARE (BR-DEL-004): one masked cell in a group of`);
  out.push(`           -- siblings can be recovered as (total - the others), so mask the`);
  out.push(`           -- smallest survivor as well.`);
  out.push(`           WHEN g.n_supp = 1 AND g.n_cells > 1 AND g.primary_supp = 0 AND g.rn_small = 1 THEN 1`);
  out.push(`           ELSE 0`);
  out.push(`         END AS supp`);
  out.push(`  FROM grp g`);
  out.push(`)`);
  const cols = [
    ...s.labelCols,
    ...s.maskCols.map((c) => `CASE WHEN supp = 1 THEN NULL ELSE ${c} END AS ${c}`),
    ...s.keepCols,
    `supp AS suppressed`,
    `'${p.ruleLabel.replace(/'/g, "''")}' AS suppression_rule`,
  ];
  out.push(`SELECT ${cols.join(",\n       ")}`);
  out.push(`FROM decided;`);
  out.push(``);
  return out;
}

/* -------------------------------------------------------------- *
 *  SAS
 * -------------------------------------------------------------- */

/** SAS twin. PROC SQL has no window functions, so group totals come from a
 *  self-join and the smallest survivor from a sort + BY-group FIRST. */
export function suppressionSasFor(t: SuppressionTarget, p: SuppressionPolicy, work: string): string[] {
  const s = SUPPRESSION_SHAPES[t.shapeKey];
  if (!s) return [`/* (no suppression shape registered for ${t.shapeKey}) */`];
  const grpOn = s.groupCols.map((c) => `f.${c} = g.${c}`).join(" and ");
  const grpSel = s.groupCols.join(", ");
  const out: string[] = [];

  out.push(`/* ${t.label} */`);
  out.push(`proc sql;`);
  out.push(`  create table ${work}_f as`);
  const sasSmall = [`r.${s.countCol} > 0 and r.${s.countCol} < ${p.threshold}`]
    .concat(s.denomCol ? [`r.${s.denomCol} > 0 and r.${s.denomCol} < ${p.threshold}`] : [])
    .map((c) => `(${c})`)
    .join(" or ");
  out.push(`  select r.*,`);
  out.push(`         (case when ${sasSmall} then 1 else 0 end) as primary_supp,`);
  out.push(`         (case when r.${s.countCol} = 0 then 1 else 0 end) as zero_cell`);
  out.push(`  from ${t.table} as r;`);
  out.push(``);
  out.push(`  create table ${work}_g as`);
  out.push(`  select f.*, g.n_supp, g.n_cells`);
  out.push(`  from ${work}_f as f`);
  out.push(`  inner join (select ${grpSel},`);
  out.push(`                     sum(primary_supp) as n_supp,`);
  out.push(`                     count(*)          as n_cells`);
  out.push(`              from ${work}_f`);
  out.push(`              group by ${grpSel}) as g`);
  out.push(`    on ${grpOn};`);
  out.push(`quit;`);
  out.push(``);
  out.push(`/* smallest NON-ZERO survivor first within each group (zeros last): masking`);
  out.push(`   a true zero would leave the value recoverable, so it must not be chosen`);
  out.push(`   as the complementary cell. */`);
  out.push(`proc sort data=${work}_g;`);
  out.push(`  by ${s.groupCols.join(" ")} primary_supp zero_cell ${s.countCol} ${s.tieBreakCol};`);
  out.push(`run;`);
  out.push(``);
  out.push(`data ${t.table}_released;`);
  out.push(`  set ${work}_g;`);
  out.push(`  by ${s.groupCols.join(" ")} primary_supp;`);
  out.push(`  length suppression_rule $200;`);
  out.push(`  if primary_supp = 1 then suppressed = 1;`);
  out.push(`  /* DERIVATION-AWARE (BR-DEL-004): a lone masked cell is recoverable from`);
  out.push(`     the group total, so the smallest survivor is masked too. */`);
  out.push(`  else if n_supp = 1 and n_cells > 1 and first.primary_supp then suppressed = 1;`);
  out.push(`  else suppressed = 0;`);
  out.push(`  if suppressed = 1 then do;`);
  for (const c of s.maskCols) out.push(`    ${c} = .;`);
  out.push(`  end;`);
  out.push(`  suppression_rule = "${p.ruleLabel.replace(/"/g, "'")}";`);
  out.push(`  drop primary_supp zero_cell n_supp n_cells;`);
  out.push(`run;`);
  out.push(``);
  return out;
}

/* -------------------------------------------------------------- *
 *  Results contract
 * -------------------------------------------------------------- */

/**
 * A single tidy, long-format table containing every released result.
 *
 * The product used to stop at CREATE TABLE, but what a client, journal or payer
 * receives is formatted tables — and every table shell, report writer and
 * spreadsheet export needs ONE predictable shape to read from rather than a
 * different column layout per analysis. This is that shape:
 *
 *   table_id | analysis_label | row_group | row_level | row_detail | stat
 *            | value | suppressed | suppression_rule
 *
 * row_detail is NULL for every shape whose rows are identified by two labels;
 * it carries the time index for a life table, whose rows are not.
 *
 * It is built from the *_released tables, so masked cells arrive as NULL with
 * suppressed = 1 and the rule attached — a shell can then print "<11" or "—"
 * without needing to re-derive the policy, and cannot accidentally print a
 * value that was supposed to be masked.
 */
export function resultsContractSql(targets: SuppressionTarget[], p: SuppressionPolicy): string[] {
  const out: string[] = [];
  out.push(`DROP TABLE IF EXISTS ${RESULTS_TABLE_PLACEHOLDER};`);
  out.push(`CREATE TABLE ${RESULTS_TABLE_PLACEHOLDER} AS`);
  const blocks: string[] = [];
  for (const t of targets) {
    const s = SUPPRESSION_SHAPES[t.shapeKey];
    if (!s) continue;
    // the last two label columns are the row identity in every shape; a
    // time-indexed table adds a third (see rowDetailCol)
    const [rowGroup, rowLevel] = s.labelCols.slice(-2);
    const rowDetail = s.rowDetailCol ? `CAST(${s.rowDetailCol} AS VARCHAR)` : `CAST(NULL AS VARCHAR)`;
    for (const stat of s.maskCols) {
      blocks.push(
        [
          `SELECT '${t.table}' AS table_id,`,
          `       '${t.label.replace(/'/g, "''")}' AS analysis_label,`,
          `       CAST(${rowGroup} AS VARCHAR) AS row_group,`,
          `       CAST(${rowLevel} AS VARCHAR) AS row_level,`,
          `       ${rowDetail} AS row_detail,`,
          `       '${stat}' AS stat,`,
          `       CAST(${stat} AS NUMERIC) AS value,`,
          `       suppressed,`,
          `       suppression_rule`,
          `FROM ${t.table}_released`,
        ].join("\n"),
      );
    }
  }
  out.push(blocks.join("\nUNION ALL\n"));
  out.push(`;`);
  out.push(``);
  out.push(`-- Rule in force for every row above: ${p.ruleLabel}`);
  out.push(``);
  return out;
}

/** Placeholder replaced by the emitter with the study's work-table prefix. */
export const RESULTS_TABLE_PLACEHOLDER = "__RESULTS__";
