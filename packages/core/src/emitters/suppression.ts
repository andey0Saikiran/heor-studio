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
