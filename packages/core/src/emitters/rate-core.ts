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
import type { PersonTimeRule, StudySpec } from "../spec/types";
import { q } from "./sql-base";
import type { Ctx as SqlCtx } from "./sql-base";
import { dataCutLimit } from "./parity";

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

/* ------------------------------------------------------------------ *
 *  Administrative censoring — decided ONCE, rendered per language
 * ------------------------------------------------------------------ */

/**
 * Which bounds follow-up is censored at.
 *
 * This exists because the two twins were choosing their own term lists, and
 * they disagreed. The SQL builder applied `meta.dataCutDate`; the SAS builder
 * never did. With a data cut declared, SQL censored at the cut and SAS ran to
 * the study end — different person-time, different rates, in the same bundle.
 *
 * Nothing caught it. The PARITY stamp records `censorAt`, which both twins read
 * from the same spec field, so the stamps agreed. The fingerprints scraped the
 * max-follow-up offset, not the cut. And Gold Case A does not set
 * `meta.dataCutDate`, so no fixture ever exercised the path — the same shape as
 * the `poisson_exact` fingerprint collision found earlier: a defect that only
 * appears once someone uses the feature.
 *
 * So the decision is made HERE, once, and each language only renders it. A twin
 * cannot omit a term it never chose.
 */
export type CensorTerm =
  | { kind: "disenrollment" }
  | { kind: "study_end"; date: string }
  | { kind: "max_followup"; days: number }
  | { kind: "data_cut"; date: string };

export interface CensorPlan {
  /** ordered terms both languages must render, identically */
  terms: CensorTerm[];
  /** censorAt values actually honored — what the parity stamp records */
  applied: string[];
  /** follow-up also stops at the outcome */
  atOutcome: boolean;
  /** the effective data-cut date, when one is declared */
  dataCut: string | null;
}

/** Build the censoring plan for a person-time rule. `death` is NOT applied —
 *  see DEATH_CENSOR_NOTE (BR-LIM-002) — and is surfaced as a REVIEW note. */
export function censorPlan(spec: StudySpec, rule: PersonTimeRule): CensorPlan {
  const cens = rule.censorAt;
  const maxFu = rule.maxFollowupDays;
  const studyEnd = spec.meta.studyPeriod.end;
  const cut = dataCutLimit(spec);
  const terms: CensorTerm[] = [];
  if (cens.includes("disenrollment")) terms.push({ kind: "disenrollment" });
  if (cens.includes("study_end")) terms.push({ kind: "study_end", date: studyEnd });
  if (cens.includes("max_followup") && maxFu != null) terms.push({ kind: "max_followup", days: maxFu });
  /* The DELIVERY's observation limit, independent of the protocol's. It is not
   * a censorAt value — the analyst does not opt into it — so it is added
   * whenever a cut is declared, in BOTH languages. */
  if (cut) terms.push({ kind: "data_cut", date: cut.date });
  if (terms.length === 0) terms.push({ kind: "study_end", date: studyEnd }); // always bound follow-up
  return {
    terms,
    applied: cens.filter(
      (c) => c === "outcome" || c === "disenrollment" || c === "study_end" || (c === "max_followup" && maxFu != null),
    ),
    atOutcome: cens.includes("outcome"),
    dataCut: cut?.date ?? null,
  };
}

/** SQL rendering of the plan's admin-censor expression. */
export function renderCensorSql(ctx: SqlCtx, plan: CensorPlan, indexExpr = "c.index_date"): string {
  const rendered = plan.terms.map((t) => {
    switch (t.kind) {
      case "disenrollment": return "ep.episode_end";
      case "study_end": return `DATE '${t.date}'`;
      case "max_followup": return ctx.d.offset(indexExpr, t.days);
      case "data_cut": return `DATE '${t.date}'`;
    }
  });
  return rendered.length === 1 ? rendered[0] : `LEAST(${rendered.join(", ")})`;
}

/** SAS rendering of the SAME plan. */
export function renderCensorSas(plan: CensorPlan, indexExpr = "a.index_date"): string {
  const rendered = plan.terms.map((t) => {
    switch (t.kind) {
      case "disenrollment": return "ep.dtend";
      case "study_end": return "&study_end.";
      case "max_followup": return `${indexExpr} + ${t.days}`;
      case "data_cut": return sasDateLit(t.date);
    }
  });
  return rendered.length === 1 ? rendered[0] : `min(${rendered.join(", ")})`;
}

const CENSOR_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function sasDateLit(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `'${String(d).padStart(2, "0")}${CENSOR_MONTHS[(m ?? 1) - 1]}${y}'d`;
}
