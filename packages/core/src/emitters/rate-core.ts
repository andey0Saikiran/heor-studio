/**
 * rate-core — the shared at-risk / person-time chain.
 *
 * Every rate-shaped measure walks the same path: cohort -> qualifying events ->
 * prevalent-case washout -> at-risk denominator -> first event after index ->
 * demographics at index -> person-time. It lived inline in modules/incidence.ts,
 * which was fine with one such module and becomes a correctness hazard with
 * several: standardization, calendar trend and the rate-regression feeders all
 * need this chain, and a re-implementation is a place for the twins to diverge
 * quietly — exactly the failure class the D1/D3 spine defects belonged to.
 *
 * The extraction is behaviour-preserving BY CONSTRUCTION: these helpers emit the
 * same strings the module emitted, and the refactor was gated on a byte-identity
 * diff of all 50 generated files before and after. If a future edit here changes
 * emitted text, the gold numbers and the fingerprints both move — which is the
 * intended alarm, not an inconvenience.
 */
import { q } from "./sql-base";
import type { Ctx as SqlCtx } from "./sql-base";

/** Inputs the at-risk chain needs, all already resolved by the caller. */
export interface RateCoreSqlInput {
  /** work-table prefix, e.g. "tz_study" */
  wp: string;
  /** outcome code-list id */
  codeListId: string;
  /** care-setting filter actually enforced, or null */
  settingEnforce: "outpatient" | "inpatient" | null;
  /** human description of the washout window, for the inline comment */
  washoutDescription: string;
  /** the washout predicate, already rendered */
  washoutPredicate: string;
  /** emit the demographics CTEs (only when the measure is stratified) */
  needDemo: boolean;
}

/**
 * The CTE chain from `cohort` through `first_fu` (+ `demo`/`demo1` when
 * stratified). Returns lines the caller pushes verbatim; the caller owns the
 * `WITH` keyword placement and everything downstream of `pt`.
 */
export function rateCoreSqlCtes(ctx: SqlCtx, i: RateCoreSqlInput): string[] {
  const L: string[] = [];
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${i.wp}_cohort),`);
  L.push(
    `ae AS (SELECT enrolid, event_date FROM ${i.wp}_events WHERE code_list_id = '${q(i.codeListId)}'` +
      (i.settingEnforce ? ` AND setting = '${i.settingEnforce}'` : ``) +
      `),`,
  );
  L.push(`prevalent AS (   -- washout: ${i.washoutDescription}`);
  L.push(`  SELECT DISTINCT c.enrolid`);
  L.push(`  FROM cohort c JOIN ae a ON a.enrolid = c.enrolid`);
  L.push(`  WHERE ${i.washoutPredicate}`);
  L.push(`),`);
  L.push(`atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),`);
  L.push(`first_fu AS (   -- first qualifying outcome strictly after index`);
  L.push(`  SELECT c.enrolid, MIN(a.event_date) AS fu_date`);
  L.push(`  FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid AND a.event_date > c.index_date`);
  L.push(`  GROUP BY c.enrolid`);
  L.push(`),`);
  if (i.needDemo) {
    L.push(`demo AS (   -- enrollment segment in force at (or latest before) index; rn=1 wins`);
    L.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
    L.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid`);
    L.push(`                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
    L.push(`  FROM atrisk c`);
    L.push(`  JOIN ${ctx.t("enrollment_detail")} en`);
    L.push(`    ON en.enrolid = c.enrolid`);
    L.push(`   AND en.dtstart <= c.index_date`);
    L.push(`),`);
    L.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  }
  return L;
}

/**
 * Byar's closed-form Poisson limits.
 *
 * Kept here, beside the chain that produces the counts, so the CI arithmetic
 * cannot drift away from the person-time it divides. `patientsExpr` is the
 * count column, so callers can reuse this over any grouping.
 * Ref: Breslow & Day 1987; Ulm, Am J Epidemiol 1990;131:373.
 */
export function byarLowSql(patientsExpr = "patients"): string {
  return `(CASE WHEN ${patientsExpr} = 0 THEN 0 ELSE POWER(1 - 1.0/(9*${patientsExpr}) - 1.96/(3*SQRT(${patientsExpr})), 3) * ${patientsExpr} END)`;
}

export function byarHighSql(patientsExpr = "patients"): string {
  return `POWER(1 - 1.0/(9*(${patientsExpr}+1)) + 1.96/(3*SQRT(${patientsExpr}+1)), 3) * (${patientsExpr}+1)`;
}

/** SAS twin of the Byar limits, as DATA-step statements.
 *  `**` is SAS's power operator; the exponent 3 is fingerprinted in both
 *  languages precisely because losing it is silent and plausible. */
export function byarSasLines(patientsVar = "patients"): string[] {
  return [
    `    if ${patientsVar} = 0 then _byar_low = 0;`,
    `    else _byar_low = ((1 - 1/(9*${patientsVar}) - 1.96/(3*sqrt(${patientsVar})))**3) * ${patientsVar};`,
    `    _byar_high = ((1 - 1/(9*(${patientsVar}+1)) + 1.96/(3*sqrt(${patientsVar}+1)))**3) * (${patientsVar}+1);`,
  ];
}
