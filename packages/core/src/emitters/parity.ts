/**
 * SAS↔SQL parity layer.
 *
 * Each emitter stamps a machine-readable `PARITY <kind> <json>` header into the
 * generated program for every analysis it emits, built from the values it
 * ACTUALLY CONSUMED at the point of code generation (not from the spec object
 * directly). The verification harness parses the headers out of both language
 * outputs and deep-compares them, so a twin that silently defaults, ignores, or
 * mis-renders a parameter fails verification instead of shipping drift.
 *
 * SAS cannot be executed in the harness (no free SAS runtime), so parity — the
 * same consumed parameters plus matching arithmetic signatures — is how the SAS
 * twin inherits the SQL twin's machine-verified ground truth.
 */
import type {
  CalendarTrendAnalysis,
  ComorbidityIndexAnalysis,
  CodeSystem,
  CumulativeIncidenceAnalysis,
  IncidenceRateAnalysis,
  OutcomeDefinition,
  PeriodPrevalenceAnalysis,
  PointPrevalenceAnalysis,
  RelativeWindow,
  ResourceUseAnalysis,
  Stratifier,
  TrendSpec,
} from "../spec/types";
import type { StudySpec } from "../spec/types";

/** Default mean days per year — internally consistent (rate/person-years/CI all
 *  agree). Overridable per study via spec.meta.daysPerYear (e.g. 365 for the HEOR
 *  Handbook AE-rate convention) so the analyst decides per their requirements. */
export const DEFAULT_DAYS_PER_YEAR = 365.25;

/** Render the person-time constant as a DECIMAL literal (e.g. "365.0") so SQL
 *  arithmetic is numeric — an integer constant would trigger integer division
 *  (451 vs 451.55; see corrections/2026-07-24-incidence-integer-division.md). */
export function renderDaysPerYear(spec: StudySpec): string {
  const y = spec.meta.daysPerYear ?? DEFAULT_DAYS_PER_YEAR;
  return Number.isInteger(y) ? y.toFixed(1) : String(y);
}

/** The parameter set an incidence-rate twin must consume identically. */
export interface IncidenceParity {
  id: string;
  codeListId: string;
  rateMultiplier: number;
  /** the rendered literal each twin embedded, compared as a string */
  daysPerYear: string;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  censorAt: string[]; // sorted
  maxFollowupDays: number | null;
  ciMethod: string;   // the method actually computed (not merely requested)
  recurrence: string; // the recurrence actually produced
  /** the care-setting filter ACTUALLY applied to outcome events */
  settingFilter: string;
  /** strata the twin actually emitted (id/axis/bands), in spec order */
  strata: SupportedStratifier[];
}

/** Stable-key JSON so both languages serialize byte-identically. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** One-line parity stamp; caller wraps in its language's comment syntax. */
export function parityStamp(kind: string, values: object): string {
  return `PARITY ${kind} ${stableJson(values)}`;
}

/** Parse every parity stamp out of a generated file's content. */
export function parseParityStamps(content: string): Array<{ kind: string; values: Record<string, unknown> }> {
  const out: Array<{ kind: string; values: Record<string, unknown> }> = [];
  for (const m of content.matchAll(/PARITY (\w+) (\{[^\n]*\})/g)) {
    try {
      out.push({ kind: m[1], values: JSON.parse(m[2]) as Record<string, unknown> });
    } catch {
      out.push({ kind: m[1], values: { __unparseable: m[2] } });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Stratification — shared between the twins so stratum LABELS are
 *  byte-identical across languages (a label mismatch breaks any
 *  downstream join/report comparing SAS output to SQL output).
 * ------------------------------------------------------------------ */

/** Default age-band lower bounds when a Stratifier omits ageBandLowerBounds
 *  (mirrors the Table-1 grouping: <18, 18-34, 35-44, 45-54, 55-64, 65+). */
export const DEFAULT_AGE_BANDS = [0, 18, 35, 45, 55, 65];

/** MarketScan coded values → the display labels BOTH twins must emit. */
export const SEX_LABELS: Record<string, string> = { "1": "Male", "2": "Female" };
export const REGION_LABELS: Record<string, string> = {
  "1": "Northeast", "2": "North Central", "3": "South", "4": "West", "5": "Unknown",
};

/** Band labels from inclusive lower bounds, e.g. [0,18,65] → ["0-17","18-64","65+"]. */
export function ageBandLabels(bounds: number[]): string[] {
  const b = [...bounds].sort((x, y) => x - y);
  return b.map((lo, i) => (i === b.length - 1 ? `${lo}+` : `${lo}-${b[i + 1] - 1}`));
}

/** Stratifier display label as stored in the output tables. Capped at 40 chars
 *  because the SAS twin declares stratifier/stratum as $40 — SQL applies the
 *  SAME cap so both languages store byte-identical values. */
export function stratLabel(label: string): string {
  return label.slice(0, 40);
}

export type DemographicAxis = "age_band" | "sex" | "region" | "plan_type" | "year";

export interface SupportedStratifier {
  id: string;
  label: string;
  axis: DemographicAxis;
  /** sorted ascending; present only for age_band */
  bands?: number[];
}

/** Split stratifiers into the demographic axes the incidence twins implement
 *  vs the ones they don't (baseline-source strata need the flag machinery). */
export function splitStratifiers(stratifyBy: Stratifier[]): {
  supported: SupportedStratifier[];
  unsupported: Stratifier[];
} {
  const supported: SupportedStratifier[] = [];
  const unsupported: Stratifier[] = [];
  for (const s of stratifyBy) {
    if (s.source.kind === "demographic") {
      supported.push({
        id: s.id,
        label: s.label,
        axis: s.source.axis,
        ...(s.source.axis === "age_band"
          ? { bands: [...(s.ageBandLowerBounds ?? DEFAULT_AGE_BANDS)].sort((a, b) => a - b) }
          : {}),
      });
    } else {
      unsupported.push(s);
    }
  }
  return { supported, unsupported };
}

/* ------------------------------------------------------------------ *
 *  Outcome care-setting enforcement — shared so both twins apply (and
 *  stamp) exactly the same filter.
 * ------------------------------------------------------------------ */

export interface SettingPlan {
  /** the setting filter both twins enforce; null = no filter */
  enforce: "outpatient" | "inpatient" | null;
  /** stamped value: the filter ACTUALLY applied ("any" when none) */
  stamped: string;
  /** REVIEW note when the requested setting cannot be enforced */
  note: string | null;
}

/** Decide how an OutcomeDefinition's care setting is enforced for a given
 *  code-list system. Drug/NDC events are inherently pharmacy claims: a
 *  "pharmacy" filter on them is a no-op, and inpatient/outpatient filters on
 *  pharmacy events are unsatisfiable — surfaced, never silently applied. */
export function outcomeSettingPlan(od: OutcomeDefinition, listSystem: CodeSystem): SettingPlan {
  const isDrugList = listSystem === "drug_name" || listSystem === "ndc";
  if (od.setting === "any") return { enforce: null, stamped: "any", note: null };
  if (isDrugList) {
    if (od.setting === "pharmacy")
      return { enforce: null, stamped: "pharmacy_all", note: null }; // all drug events ARE pharmacy
    return {
      enforce: null,
      stamped: "any",
      note: `outcome care-setting "${od.setting}" cannot apply to pharmacy (drug) events - no filter applied; review the outcome definition`,
    };
  }
  if (od.setting === "pharmacy")
    return {
      enforce: null,
      stamped: "any",
      note: `outcome care-setting "pharmacy" cannot apply to a diagnosis/procedure code list - no filter applied; review the outcome definition`,
    };
  return { enforce: od.setting, stamped: od.setting, note: null };
}

/**
 * Spec options the incidence twins do NOT yet implement. Emitted as visible
 * review notes in BOTH languages so a generated program never silently claims
 * behavior it doesn't have; the modules land these one by one.
 */
/** What is actually true about mortality in MarketScan, per BR-LIM-002.
 *
 *  Earlier wording in the emitters said death was "unascertainable", which
 *  contradicts our own business rule: mortality is severely limited but NOT
 *  absent — in-hospital death is observable through DSTATUS on the I, S and F
 *  tables (de-duplicated across them, with the date column differing by table).
 *  Saying "unascertainable" both misstated the rule and hid the real
 *  consequence: person-time keeps accruing past an observed in-hospital death. */
export const DEATH_CENSOR_NOTE =
  `censorAt includes "death" but death censoring is NOT implemented - person-time ` +
  `continues past an in-hospital death. MarketScan mortality is limited, not absent ` +
  `(BR-LIM-002): in-hospital deaths are observable via DSTATUS on I/S/F and must be ` +
  `de-duplicated across those tables; out-of-hospital deaths are not observable at ` +
  `all without the separately licensed Mortality Database. Add a death-date term ` +
  `before reporting any endpoint where death competes with the outcome`;

export function incidenceLimitations(an: IncidenceRateAnalysis, listSystem: CodeSystem, spec?: StudySpec): string[] {
  const out: string[] = [];
  const od = an.outcomeDefinition;
  if (od.minClaims > 1)
    out.push(`outcome minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts as the outcome`);
  const settingNote = outcomeSettingPlan(od, listSystem).note;
  if (settingNote) out.push(settingNote);
  if (od.diagnosisPosition !== "any")
    out.push(`diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count (the events spine does not record claim position yet)`);
  if (an.recurrence !== "first_only")
    out.push(`recurrence="all_events" is NOT implemented - FIRST-event incidence is produced`);
  if (an.ciMethod === "poisson_exact")
    out.push(
      `ciMethod "poisson_exact": the SQL twin reports Byar's closed form (labeled poisson_byar) because ` +
      `warehouse SQL cannot invert the Poisson CDF. The EXACT gamma interval IS produced, in the SAS twin, ` +
      `as ci_low_exact / ci_high_exact (SAS-PRIMARY: NULL in SQL by contract, never approximated there). ` +
      `Report the exact interval from the SAS output; the two agree closely except at very small counts`
    );
  else if (an.ciMethod !== "poisson_byar")
    out.push(`ciMethod "${an.ciMethod}" is NOT implemented - the Byar exact-Poisson approximation is produced and labeled poisson_byar`);
  if (an.personTimeRule.censorAt.includes("death"))
    out.push(DEATH_CENSOR_NOTE);
  // the delivery's observation limit, if the analyst declared one
  if (spec) {
    const cut = dataCutLimit(spec);
    out.push(cut ? cut.note : NO_DATA_CUT_NOTE);
  }
  for (const s of splitStratifiers(an.stratifyBy).unsupported)
    out.push(`stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted - demographic axes only for now`);
  return out;
}

/** The parity record for an incidence twin, from values the caller consumed. */
export function incidenceParity(
  an: IncidenceRateAnalysis,
  consumed: { daysPerYear: string; censorTerms: string[]; settingFilter: string; strata: SupportedStratifier[] }
): IncidenceParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    rateMultiplier: an.rateMultiplier,
    daysPerYear: consumed.daysPerYear,
    washout: {
      start: an.washout.start,
      end: an.washout.end,
      includesIndex: an.washout.includesIndex,
    },
    censorAt: [...consumed.censorTerms].sort(),
    maxFollowupDays: an.personTimeRule.maxFollowupDays ?? null,
    // what the twins actually compute today (limitations above make this loud)
    ciMethod: "poisson_byar",
    recurrence: "first_only",
    settingFilter: consumed.settingFilter,
    strata: consumed.strata,
  };
}

/* ================================================================== *
 *  Point prevalence
 * ================================================================== */

/** The parameter set a point-prevalence twin must consume identically. */
export interface PointPrevalenceParity {
  id: string;
  codeListId: string;
  /** the anchor actually rendered: fixed date literal, or per-subject index */
  anchor: { kind: "fixed" | "index"; date: string | null };
  /** denominator basis actually computed (cohort-based, enrolled-on-anchor) */
  denominator: "cohort_enrolled_on_anchor";
  /** case definition actually computed */
  caseRule: "ever_on_or_before_anchor";
  ciMethod: string; // the method actually computed ("wilson"), never the requested one
  /** the care-setting filter ACTUALLY applied to outcome events */
  settingFilter: string;
  /** strata the twin actually emitted (id/axis/bands), in spec order */
  strata: SupportedStratifier[];
}

/** Spec options the point-prevalence twins do NOT implement yet — visible REVIEW
 *  notes in both languages so a program never silently claims behavior it lacks. */
export function pointPrevalenceLimitations(
  an: PointPrevalenceAnalysis,
  listSystem: CodeSystem
): string[] {
  const out: string[] = [];
  const od = an.outcomeDefinition;
  if (od.minClaims > 1)
    out.push(`outcome minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts as a prevalent case`);
  const settingNote = outcomeSettingPlan(od, listSystem).note;
  if (settingNote) out.push(settingNote);
  if (od.diagnosisPosition !== "any")
    out.push(`diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count (the events spine does not record claim position yet)`);
  if (an.ciMethod === "clopper_pearson")
    out.push(`ciMethod "clopper_pearson" is NOT implemented (needs an exact beta inverse, SAS-only: proc freq ... / binomial(cl=clopperpearson)) - the Wilson score interval is produced and labeled wilson`);
  if (an.ciMethod === "wald")
    out.push(`ciMethod "wald" is NOT implemented (poor small-sample coverage; Newcombe 1998) - the Wilson score interval is produced and labeled wilson`);
  for (const s of splitStratifiers(an.stratifyBy).unsupported)
    out.push(`stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted - demographic axes only for now`);
  if (an.referenceStratum)
    out.push(`referenceStratum "${an.referenceStratum}" is NOT used - no prevalence-ratio column is produced yet`);
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed, so never conditional). */
export const POINT_PREVALENCE_METHOD_NOTES = [
  `denominator is COHORT-based (final analysis cohort enrolled on the anchor date), not a population denominator - MarketScan carries no general-population denominator and the spine pulls enrollment for indexed members only`,
  `"alive on the anchor date" is proxied by enrollment on the anchor date - core MarketScan observes only IN-HOSPITAL death (DSTATUS on I/S/F), so out-of-hospital deaths are indistinguishable from continued enrollment (BR-LIM-002)`,
  `case = >= 1 qualifying event on-or-BEFORE the anchor date within the study period (all-available lookback; the spec has no activeLookbackWindow field)`,
];

/** The parity record for a point-prevalence twin, from values the caller consumed. */
export function pointPrevalenceParity(
  an: PointPrevalenceAnalysis,
  consumed: { settingFilter: string; strata: SupportedStratifier[] }
): PointPrevalenceParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    anchor: {
      kind: an.anchorDate.kind,
      date: an.anchorDate.kind === "fixed" ? an.anchorDate.date : null,
    },
    denominator: "cohort_enrolled_on_anchor",
    caseRule: "ever_on_or_before_anchor",
    // what the twins actually compute today (limitations make this loud)
    ciMethod: "wilson",
    settingFilter: consumed.settingFilter,
    strata: consumed.strata,
  };
}

/* ================================================================== *
 *  Period prevalence
 * ================================================================== */

/** The parameter set a period-prevalence twin must consume identically. */
export interface PeriodPrevalenceParity {
  id: string;
  codeListId: string;
  period: { start: string; end: string };
  denominatorRule: "enrolled_anytime";
  /** numerator definition actually computed (event dated inside the period) */
  numeratorRule: "event_in_period";
  ciMethod: string; // the method actually computed ("wilson")
  settingFilter: string;
  strata: SupportedStratifier[];
}

/** Spec options the period-prevalence twins do NOT implement yet. */
export function periodPrevalenceLimitations(
  an: PeriodPrevalenceAnalysis,
  listSystem: CodeSystem
): string[] {
  const out: string[] = [];
  const od = an.outcomeDefinition;
  if (od.minClaims > 1)
    out.push(`outcome minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim in the period counts as a case`);
  const settingNote = outcomeSettingPlan(od, listSystem).note;
  if (settingNote) out.push(settingNote);
  if (od.diagnosisPosition !== "any")
    out.push(`diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count (the events spine does not record claim position yet)`);
  if (an.ciMethod === "clopper_pearson")
    out.push(`ciMethod "clopper_pearson" is NOT implemented (needs an exact beta inverse, SAS-only: proc freq ... / binomial(cl=clopperpearson)) - the Wilson score interval is produced and labeled wilson`);
  if (an.ciMethod === "wald")
    out.push(`ciMethod "wald" is NOT implemented (poor small-sample coverage; Newcombe 1998) - the Wilson score interval is produced and labeled wilson`);
  for (const s of splitStratifiers(an.stratifyBy).unsupported)
    out.push(`stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted - demographic axes only for now`);
  if (an.referenceStratum)
    out.push(`referenceStratum "${an.referenceStratum}" is NOT used - no prevalence-ratio column is produced yet`);
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const PERIOD_PREVALENCE_METHOD_NOTES = [
  `denominator is COHORT-based (final analysis cohort enrolled at ANY time in the period), not a population denominator - MarketScan carries no general-population denominator and the spine pulls enrollment for indexed members only`,
  `PANEL CHURN: partial-period enrollees enter the denominator with less than full observation, so the estimate is conservative (biased down) versus a fully-enrolled denominator, and it moves whenever the denominator rule moves`,
  `numerator = a qualifying event DATED inside the period; there is NO carry-in (a member whose only qualifying claims predate the period is not counted), so this undercounts true clinical prevalence of chronic disease`,
];

/** The parity record for a period-prevalence twin, from consumed values. */
export function periodPrevalenceParity(
  an: PeriodPrevalenceAnalysis,
  consumed: { settingFilter: string; strata: SupportedStratifier[] }
): PeriodPrevalenceParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    period: { start: an.prevalencePeriod.start, end: an.prevalencePeriod.end },
    denominatorRule: "enrolled_anytime",
    numeratorRule: "event_in_period",
    ciMethod: "wilson",
    settingFilter: consumed.settingFilter,
    strata: consumed.strata,
  };
}

/* ================================================================== *
 *  Cumulative incidence (risk)
 * ================================================================== */

/** The parameter set a cumulative-incidence twin must consume identically. */
export interface CumulativeIncidenceParity {
  id: string;
  codeListId: string;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  horizonDays: number;
  /** the estimator actually computed (naive at-risk risk, complete-follow-up) */
  riskMethod: "naive_at_risk";
  ciMethod: string; // "wilson"
  settingFilter: string;
  strata: SupportedStratifier[];
}

/** Spec options the cumulative-incidence twins do NOT implement yet. */
export function cumulativeIncidenceLimitations(
  an: CumulativeIncidenceAnalysis,
  listSystem: CodeSystem
): string[] {
  const out: string[] = [];
  const od = an.outcomeDefinition;
  if (od.minClaims > 1)
    out.push(`outcome minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts as the event`);
  const settingNote = outcomeSettingPlan(od, listSystem).note;
  if (settingNote) out.push(settingNote);
  if (od.diagnosisPosition !== "any")
    out.push(`diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count (the events spine does not record claim position yet)`);
  if (an.competingRiskDeath !== "ignore")
    out.push(`competingRiskDeath="${an.competingRiskDeath}" is NOT implemented - a naive at-risk cumulative incidence is produced; use SAS proc lifetest (1-KM) or the Aalen-Johansen CIF for censoring / competing-risk adjustment`);
  if (an.incidentWithRespectTo !== "cohort_entry")
    out.push(`incidentWithRespectTo="${an.incidentWithRespectTo}" is NOT implemented - incidence is defined with respect to cohort entry via the washout window only`);
  if (an.ciMethod === "clopper_pearson")
    out.push(`ciMethod "clopper_pearson" is NOT implemented (needs an exact beta inverse, SAS-only: proc freq ... / binomial(cl=clopperpearson)) - the Wilson score interval is produced and labeled wilson`);
  if (an.ciMethod === "wald")
    out.push(`ciMethod "wald" is NOT implemented (poor small-sample coverage; Newcombe 1998) - the Wilson score interval is produced and labeled wilson`);
  for (const s of splitStratifiers(an.stratifyBy).unsupported)
    out.push(`stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted - demographic axes only for now`);
  if (an.referenceStratum)
    out.push(`referenceStratum "${an.referenceStratum}" is NOT used - no risk-ratio column is produced yet`);
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const CUMULATIVE_INCIDENCE_METHOD_NOTES = [
  `denominator is the at-risk set (final analysis cohort, event-free at index after the washout window); each subject is counted once (first_only)`,
  `NAIVE risk = cases within the horizon / at-risk, assuming COMPLETE follow-up through the horizon; a subject who disenrolls before the horizon without the event is treated as a non-case, which can UNDERESTIMATE risk - set competingRiskDeath="censor" (KM, SAS-only) when censoring is material`,
  `the risk is defined relative to cohort entry (index); the washout window removes prevalent cases so only new-onset events count`,
];

/** The parity record for a cumulative-incidence twin, from consumed values. */
export function cumulativeIncidenceParity(
  an: CumulativeIncidenceAnalysis,
  consumed: { settingFilter: string; strata: SupportedStratifier[] }
): CumulativeIncidenceParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    washout: {
      start: an.washout.start,
      end: an.washout.end,
      includesIndex: an.washout.includesIndex,
    },
    horizonDays: an.horizonDays,
    riskMethod: "naive_at_risk",
    ciMethod: "wilson",
    settingFilter: consumed.settingFilter,
    strata: consumed.strata,
  };
}

export type { RelativeWindow };

/* ------------------------------------------------------------------ *
 *  Statistical engine — SMD balance
 * ------------------------------------------------------------------ */

/** A covariate the balance table can actually compute, with how it is measured.
 *  Continuous covariates compare means; binary ones compare proportions. */
export interface BalanceCovariate {
  id: string;
  label: string;
  /** "continuous" -> mean/SD SMD; "binary" -> proportion SMD */
  measure: "continuous" | "binary";
  /** for binary demographic covariates, the coded value counted as the "1" */
  positiveValue?: string;
  /** where the value is read from. "comorbidity_index" is not a demographic —
   *  it is a DERIVED score, computed by the shared scorer in
   *  emitters/comorbidity.ts so Table 1, this table and the index analysis
   *  cannot disagree about it. */
  axis: "age" | "sex" | "comorbidity_index";
  /** for axis "comorbidity_index": the ComorbidityIndexAnalysis being scored */
  analysisId?: string;
}

export interface SmdParity {
  id: string;
  groupVarId: string;
  levels: string[];
  referenceLevel: string;
  /* The AXIS is stamped alongside the measure because the measure alone stopped
   * identifying the source variable the moment a second CONTINUOUS covariate
   * (a comorbidity index) joined the table. Without it the stamp could not say
   * which variable a row's moments come from, which is exactly the thing that
   * silently goes wrong. */
  covariates: Array<{ id: string; measure: string; axis: string }>;
  /** pooled-SD denominator convention actually computed */
  smdDenominator: "pooled_sd_sample_variance";
  imbalanceThreshold: number;
}

export function smdParity(
  id: string,
  consumed: {
    groupVarId: string;
    levels: string[];
    referenceLevel: string;
    covariates: BalanceCovariate[];
    imbalanceThreshold: number;
  }
): SmdParity {
  return {
    id,
    groupVarId: consumed.groupVarId,
    levels: [...consumed.levels],
    referenceLevel: consumed.referenceLevel,
    covariates: consumed.covariates.map((c) => ({ id: c.id, measure: c.measure, axis: c.axis })),
    smdDenominator: "pooled_sd_sample_variance",
    imbalanceThreshold: consumed.imbalanceThreshold,
  };
}

/** Baseline characteristics the balance table can compute today: age
 *  (continuous), sex (binary), and a comorbidity_index scored by the shared
 *  engine. Everything else needs the baseline covariate tables the P2+ work
 *  adds, and is reported as a limitation rather than silently dropped. */
export function balanceCovariates(
  baseline: Array<{ id: string; label: string; kind: string; comorbidityIndexAnalysisId?: string }>,
  covariateIds: string[],
  /** ids of ENABLED comorbidity_index analyses, so a dangling reference lands in
   *  `unsupported` with a reason rather than emitting a column of nulls */
  enabledIndexIds: ReadonlySet<string> = new Set()
): { supported: BalanceCovariate[]; unsupported: Array<{ id: string; kind: string }> } {
  const wanted = covariateIds.length > 0 ? baseline.filter((b) => covariateIds.includes(b.id)) : baseline;
  const supported: BalanceCovariate[] = [];
  const unsupported: Array<{ id: string; kind: string }> = [];
  for (const b of wanted) {
    if (b.kind === "age") supported.push({ id: b.id, label: b.label, measure: "continuous", axis: "age" });
    else if (b.kind === "sex") supported.push({ id: b.id, label: b.label, measure: "binary", axis: "sex", positiveValue: "1" });
    else if (b.kind === "comorbidity_index" && b.comorbidityIndexAnalysisId && enabledIndexIds.has(b.comorbidityIndexAnalysisId))
      supported.push({
        id: b.id, label: b.label, measure: "continuous",
        axis: "comorbidity_index", analysisId: b.comorbidityIndexAnalysisId,
      });
    else unsupported.push({ id: b.id, kind: b.kind });
  }
  return { supported, unsupported };
}

export const SMD_METHOD_NOTES = [
  `SMD uses the POOLED standard deviation with SAMPLE variance (n-1) in both arms:`,
  `  continuous: (mean_ref - mean_other) / sqrt((var_ref + var_other) / 2)`,
  `  binary:     (p_ref - p_other)       / sqrt((p_ref(1-p_ref) + p_other(1-p_other)) / 2)`,
  `Sign is reference-arm-minus-comparator, so a negative SMD means the reference`,
  `arm is LOWER on that covariate. |SMD| above the threshold flags imbalance;`,
  `SMD is a descriptive balance diagnostic, NOT a hypothesis test - it carries no`,
  `p-value and is deliberately insensitive to sample size (Austin 2009).`,
];

/* ------------------------------------------------------------------ *
 *  Ascertainment window
 * ------------------------------------------------------------------ */

/**
 * The date span the EVENT PULL must cover — which is not the study period.
 *
 * The event table used to be hard-bounded to meta.studyPeriod, but baseline
 * lookbacks, prevalent-case washouts and follow-up horizons all reach OUTSIDE
 * it. A protocol whose "study period" means the identification window (a very
 * common reading) then truncated its own washout: on the gold fixture, setting
 * studyPeriod to 2019 alone dropped the excluded-as-prevalent count from 2 to 0
 * and inflated the at-risk denominator from 8 to 10 — while the code ran
 * cleanly and reported success. Silent and plausible is the worst combination.
 *
 * So the pull window is derived from what the spec actually ASKS FOR: the
 * deepest lookback before the earliest possible index date, and the longest
 * follow-up after the latest one, unioned with the stated study period.
 */
export interface AscertainmentWindow {
  /** ISO date, or null when some window is unbounded ("anytime_before") */
  start: string | null;
  end: string;
  /** why the window is wider than meta.studyPeriod (for the REVIEW note) */
  reasons: string[];
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ascertainmentWindow(spec: StudySpec): AscertainmentWindow {
  const reasons: string[] = [];
  const idxStart = spec.indexEvent.indexPeriod.start;
  const idxEnd = spec.indexEvent.indexPeriod.end;
  let unbounded = false;
  let backDays = 0;

  const consider = (days: number, why: string) => {
    if (days > backDays) { backDays = days; reasons.push(why); }
  };
  if (spec.enrollment.baselineDays > 0)
    consider(spec.enrollment.baselineDays, `baseline lookback ${spec.enrollment.baselineDays}d`);
  for (const c of spec.criteria) {
    const w = "window" in c.test ? c.test.window : undefined;
    if (!w) continue;
    if (w.start === "anytime_before") { unbounded = true; reasons.push(`criterion "${c.id}" looks back with no bound`); }
    else if (w.start < 0) consider(-w.start, `criterion "${c.id}" lookback ${-w.start}d`);
  }
  let fwdDays = spec.enrollment.followupDays;
  if (fwdDays > 0) reasons.push(`follow-up ${fwdDays}d`);
  let latestFixed: string | null = null;

  for (const a of spec.analyses) {
    if (!a.enabled) continue;
    if ("washout" in a && a.washout) {
      if (a.washout.start === "anytime_before") { unbounded = true; reasons.push(`analysis "${a.id}" washout has no lower bound`); }
      else if (a.washout.start < 0) consider(-a.washout.start, `analysis "${a.id}" washout ${-a.washout.start}d`);
    }
    if (a.kind === "cumulative_incidence" && a.horizonDays > fwdDays) {
      fwdDays = a.horizonDays; reasons.push(`analysis "${a.id}" risk horizon ${a.horizonDays}d`);
    }
    if (a.kind === "incidence_rate" && a.personTimeRule.maxFollowupDays && a.personTimeRule.maxFollowupDays > fwdDays) {
      fwdDays = a.personTimeRule.maxFollowupDays; reasons.push(`analysis "${a.id}" max follow-up ${a.personTimeRule.maxFollowupDays}d`);
    }
    /* The resource-use window is the same hazard the studyPeriod truncation
     * defect was: a 2-year cost window with a 1-year enrollment requirement
     * would pull only the first year of claims and report the shortfall as
     * low utilization. It only ever widens the pull. */
    if (a.kind === "resource_use") {
      const w = a.ascertainmentWindow;
      if (w.start === "anytime_before") { unbounded = true; reasons.push(`analysis "${a.id}" resource-use window has no lower bound`); }
      else if (w.start < 0) consider(-w.start, `analysis "${a.id}" resource-use lookback ${-w.start}d`);
      if (typeof w.end === "number" && w.end > fwdDays) {
        fwdDays = w.end; reasons.push(`analysis "${a.id}" resource-use window ends day ${w.end}`);
      }
    }
    if (a.kind === "period_prevalence") {
      if (!latestFixed || a.prevalencePeriod.end > latestFixed) latestFixed = a.prevalencePeriod.end;
      reasons.push(`analysis "${a.id}" prevalence period ends ${a.prevalencePeriod.end}`);
    }
    if (a.kind === "point_prevalence" && a.anchorDate.kind === "fixed") {
      if (!latestFixed || a.anchorDate.date > latestFixed) latestFixed = a.anchorDate.date;
      reasons.push(`analysis "${a.id}" anchor date ${a.anchorDate.date}`);
    }
  }

  let start: string | null = null;
  if (!unbounded) {
    const derivedStart = shiftIso(idxStart, -backDays);
    // widen to whichever reaches further back — never narrow the pull
    start = derivedStart < spec.meta.studyPeriod.start ? derivedStart : spec.meta.studyPeriod.start;
  }
  const candidates = [spec.meta.studyPeriod.end, shiftIso(idxEnd, fwdDays)];
  if (latestFixed) candidates.push(latestFixed);
  const end = candidates.reduce((a, b) => (a > b ? a : b));
  return { start, end, reasons: [...new Set(reasons)] };
}

/* ------------------------------------------------------------------ *
 *  Data cut / claims run-out
 * ------------------------------------------------------------------ */

/** Effective observation limit imposed by the DELIVERY, not the protocol.
 *
 *  Claims accrue for months after service, so the last stretch of any extract is
 *  incomplete: events that happened are not in the data yet. Two things go wrong
 *  if the window ignores it — every member still enrolled at the cut reads as
 *  DISENROLLED (their final DTEND is truncated there), and the immature tail is
 *  counted as event-free person-time, biasing every rate downward.
 *
 *  Returns null when the analyst has not declared a cut. The emitters then say
 *  so in a REVIEW note rather than inventing a date. */
export function dataCutLimit(spec: StudySpec): { date: string; note: string } | null {
  const cut = spec.meta.dataCutDate;
  if (!cut) return null;
  const runout = spec.meta.claimsRunoutMonths ?? 0;
  if (runout <= 0) {
    return { date: cut, note: `follow-up censored at the data cut ${cut} (no claims run-out declared — the final months of the extract may be incomplete)` };
  }
  const d = new Date(`${cut}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - runout);
  const eff = d.toISOString().slice(0, 10);
  return { date: eff, note: `follow-up censored at ${eff} = data cut ${cut} minus ${runout} months of claims run-out, so the immature tail is excluded rather than counted as event-free` };
}

/** REVIEW note when no data cut is declared. */
export const NO_DATA_CUT_NOTE =
  `meta.dataCutDate is NOT declared, so follow-up is bounded only by the study period. ` +
  `In a real extract the last months are incomplete: members still enrolled at the cut ` +
  `look DISENROLLED and the immature tail counts as event-free person-time, biasing rates ` +
  `downward. Declare dataCutDate (and claimsRunoutMonths) before reporting person-time results`;

/* ================================================================== *
 *  Calendar trend
 * ================================================================== */

/** One calendar bucket, with its boundaries already CLIPPED to the study period. */
export interface TrendBucket {
  /** 0-based ordinal — also the Cochran-Armitage score (see below) */
  ord: number;
  /** display label, e.g. "2019", "2019-Q3", "2019-07" */
  label: string;
  /** ISO bounds, inclusive, clipped to meta.studyPeriod */
  start: string;
  end: string;
  /** true when clipping shortened the natural bucket */
  isPartial: boolean;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function lastDayOfMonth(y: number, m: number): number {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return MONTH_DAYS[m - 1];
}

const isoOf = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The calendar buckets a trend runs over, derived from meta.studyPeriod.
 *
 * Generated HERE, in TypeScript, rather than by a SQL calendar generator or a
 * SAS `%do` loop, precisely so BOTH twins receive the identical literal
 * boundaries. A recursive CTE and a macro loop are two implementations of the
 * same intent, and two implementations are where twins drift — this is the one
 * place that difference would be invisible, because a bucket that is one day off
 * still produces a full, plausible-looking trend table.
 *
 * Boundaries are CLIPPED to the study period, and a clipped bucket is flagged:
 * a half-length bucket has systematically fewer events, which bends the trend.
 * That is reported, never silently smoothed.
 */
export function trendBuckets(spec: StudySpec, bucket: TrendSpec["bucket"]): TrendBucket[] {
  const { start: pStart, end: pEnd } = spec.meta.studyPeriod;
  const [sy, sm] = pStart.split("-").map(Number);
  const [ey, em] = pEnd.split("-").map(Number);
  const natural: Array<{ label: string; start: string; end: string }> = [];

  if (bucket === "calendar_year") {
    for (let y = sy; y <= ey; y++) natural.push({ label: String(y), start: isoOf(y, 1, 1), end: isoOf(y, 12, 31) });
  } else if (bucket === "calendar_quarter") {
    for (let y = sy; y <= ey; y++) {
      for (let qi = 1; qi <= 4; qi++) {
        const m0 = (qi - 1) * 3 + 1;
        const m1 = m0 + 2;
        if (y === sy && m1 < sm) continue;
        if (y === ey && m0 > em) continue;
        natural.push({ label: `${y}-Q${qi}`, start: isoOf(y, m0, 1), end: isoOf(y, m1, lastDayOfMonth(y, m1)) });
      }
    }
  } else {
    for (let y = sy; y <= ey; y++) {
      for (let m = 1; m <= 12; m++) {
        if (y === sy && m < sm) continue;
        if (y === ey && m > em) continue;
        natural.push({ label: `${y}-${String(m).padStart(2, "0")}`, start: isoOf(y, m, 1), end: isoOf(y, m, lastDayOfMonth(y, m)) });
      }
    }
  }

  return natural
    .filter((b) => b.end >= pStart && b.start <= pEnd)
    .map((b, i) => {
      const start = b.start < pStart ? pStart : b.start;
      const end = b.end > pEnd ? pEnd : b.end;
      return { ord: i, label: b.label, start, end, isPartial: start !== b.start || end !== b.end };
    });
}

/** The parameter set a calendar-trend twin must consume identically. */
export interface CalendarTrendParity {
  id: string;
  codeListId: string;
  base: CalendarTrendAnalysis["base"];
  bucket: TrendSpec["bucket"];
  /** the test actually computed, which may differ from the requested method */
  trendMethod: string;
  /** every bucket boundary, in order — a shifted bucket changes this list */
  buckets: Array<{ ord: number; label: string; start: string; end: string }>;
  /** Cochran-Armitage scores, in bucket order */
  scores: number[];
  denominatorRule: "enrolled_anytime";
  numeratorRule: "event_in_bucket";
  ciMethod: string;
  settingFilter: string;
  /** the p-value is SAS-primary; SQL emits it NULL */
  pValueSource: "sas_primary";
}

/** Spec options the calendar-trend twins do NOT implement yet. */
export function calendarTrendLimitations(an: CalendarTrendAnalysis, listSystem: CodeSystem, buckets: TrendBucket[]): string[] {
  const out: string[] = [];
  const od = an.outcomeDefinition;
  if (od.minClaims > 1)
    out.push(`outcome minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim in a bucket counts as a case`);
  const settingNote = outcomeSettingPlan(od, listSystem).note;
  if (settingNote) out.push(settingNote);
  if (od.diagnosisPosition !== "any")
    out.push(`diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count (the events spine does not record claim position yet)`);
  if (an.trend.method !== "cochran_armitage")
    out.push(
      `trend method "${an.trend.method}" is NOT implemented - ${
        an.trend.method === "poisson_rate_trend"
          ? "a Poisson rate trend needs person-time SPLIT across calendar buckets (no emitter builds that yet) and a fitted log-linear slope, which has no closed form"
          : "a linear slope on proportions needs a fitted OLS coefficient, which has no closed form in SQL"
      }; the Cochran-Armitage trend test IS computed and labeled cochran_armitage`,
    );
  if (!an.trend.reportPerBucket)
    out.push(`trend.reportPerBucket=false is IGNORED - the per-bucket rows are always emitted, because a trend statistic with no visible buckets cannot be reviewed`);
  for (const s of splitStratifiers(an.stratifyBy).unsupported)
    out.push(`stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted`);
  if (an.stratifyBy.length > 0)
    out.push(`stratifyBy is NOT yet applied to the trend - the test is computed on the whole cohort; a stratified trend needs one test per stratum plus a homogeneity test`);
  const partial = buckets.filter((b) => b.isPartial);
  if (partial.length > 0)
    out.push(
      `bucket(s) ${partial.map((b) => b.label).join(", ")} are PARTIAL (clipped to the study period). A short bucket accrues fewer events at the same underlying rate, which bends the trend; the equally-spaced scores below do not correct for it`,
    );
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const CALENDAR_TREND_METHOD_NOTES = [
  `per-bucket denominator = final-cohort members whose stitched enrollment episode OVERLAPS the bucket; numerator = members with >= 1 qualifying event DATED inside it (same rules as the period-prevalence module, applied bucket by bucket)`,
  `a member enrolled across several buckets is counted ONCE PER BUCKET, so the Trend row's counts are person-BUCKET sums, not distinct patients - they are the quantities the trend statistic is computed from, and must not be read as a cohort size`,
  `Cochran-Armitage scores are the 0-based bucket ORDINALS (0, 1, 2, ...), the standard equally-spaced default. They assume the buckets are equally spaced in time, which partial (clipped) buckets are not`,
  `the trend statistic z is computed in BOTH twins from the same closed form; only the two-sided p-value is SAS-primary (it inverts the normal CDF, which warehouse SQL has no function for)`,
  `this tests for a MONOTONE linear trend in the bucket proportions. It has no power against non-monotone change (a rise then a fall can return z near zero), so the per-bucket rows must be read alongside it`,
];

/** The parity record for a calendar-trend twin, from consumed values. */
export function calendarTrendParity(
  an: CalendarTrendAnalysis,
  consumed: { settingFilter: string; buckets: TrendBucket[] },
): CalendarTrendParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    base: an.base,
    bucket: an.trend.bucket,
    trendMethod: "cochran_armitage",
    buckets: consumed.buckets.map((b) => ({ ord: b.ord, label: b.label, start: b.start, end: b.end })),
    scores: consumed.buckets.map((b) => b.ord),
    denominatorRule: "enrolled_anytime",
    numeratorRule: "event_in_bucket",
    ciMethod: "wilson",
    settingFilter: consumed.settingFilter,
    pValueSource: "sas_primary",
  };
}

/* ================================================================== *
 *  Resource use and cost
 * ================================================================== */

/** The parameter set a resource-use twin must consume identically. */
export interface ResourceUseParity {
  id: string;
  window: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  /** observed-day denominator length implied by the window */
  windowDays: number | null;
  settings: string[];
  costField: string;
  edPlaceOfService: string[];
  includeCombined: boolean;
  /** the inpatient rule actually implemented */
  inpatientRule: "admission_total_lines_excluded";
  /** encounter grain, per family */
  encounterGrain: { inpatient: string; ambulatory: string; pharmacy: string };
  daysPerYear: string;
  /** the quantile estimator actually used (see RESOURCE_USE_METHOD_NOTES) */
  medianEstimator: "percentile_cont_equivalent";
}

/** Spec options the resource-use twins do NOT implement yet. */
export function resourceUseLimitations(an: ResourceUseAnalysis): string[] {
  const out: string[] = [];
  if (an.costField === "netpay")
    out.push(`costField "netpay" is emitted as requested, but NETPAY nets out coordination-of-benefits and is NOT comparable across plan types - PAYTOT is the usual choice for a total-cost-of-care figure`);
  if (!an.settings.includes("ed") && an.settings.includes("outpatient"))
    out.push(`ED visits are NOT separated - without "ed" in settings[] every emergency visit is counted as an ordinary outpatient visit, which understates acute utilization`);
  out.push(`no inflation adjustment is applied - payments are in NOMINAL dollars of their service year, so a multi-year window mixes them. CostMeasurement.inflationAdjustment is not consumed yet`);
  out.push(`the ledger counts ENCOUNTERS, not claim lines or units of service; procedure-level and length-of-stay measures are not emitted`);
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const RESOURCE_USE_METHOD_NOTES = [
  `INPATIENT DOUBLE COUNT: an admission carries a stay-level total AND its own service lines, which already roll up into that total. This program takes the admission record and DROPS its service lines. Summing both is the classic error and inflates the largest cost component in most studies`,
  `service lines with NO matching admission record are kept as stays in their own right (matched by CASEID where present, by admission date where not) - dropping them would silently lose stays that straddle a year-file boundary`,
  `a stay is dated at ADMISSION, so a stay that began before the window is not counted even when its service lines fall inside it`,
  `encounter grain: inpatient = one per stay; ambulatory = one per member per service date per class; pharmacy = one per member per date per NDC (two different products on one day are two fills)`,
  `denominators are the WHOLE cohort, not users - a member with no encounters contributes a zero, so the mean is a per-member figure and not a per-user one. "users" is reported separately`,
  `MEDIAN is comparable across the twins; QUARTILES would not be. SQL's PERCENTILE_CONT and SAS's PCTLDEF=5 agree exactly at p=0.5 for every n (both return the average of the two central order statistics when n is even, and the central one when odd) but diverge elsewhere, so no quartile is emitted`,
  `costs are NOMINAL and un-discounted; skew is expected. The mean and the median are both reported precisely because they disagree in cost data, and the mean is the one that drives budget impact`,
];

/** The parity record for a resource-use twin, from consumed values. */
export function resourceUseParity(
  an: ResourceUseAnalysis,
  consumed: { settings: string[]; edPlaces: string[]; windowDays: number | null; daysPerYear: string },
): ResourceUseParity {
  return {
    id: an.id,
    window: { start: an.ascertainmentWindow.start, end: an.ascertainmentWindow.end, includesIndex: an.ascertainmentWindow.includesIndex },
    windowDays: consumed.windowDays,
    settings: consumed.settings,
    costField: an.costField,
    edPlaceOfService: consumed.edPlaces,
    includeCombined: an.includeCombined,
    inpatientRule: "admission_total_lines_excluded",
    encounterGrain: {
      inpatient: "one_per_stay_at_admission",
      ambulatory: "one_per_member_date_class",
      pharmacy: "one_per_member_date_ndc",
    },
    daysPerYear: consumed.daysPerYear,
    medianEstimator: "percentile_cont_equivalent",
  };
}

/* ================================================================== *
 *  Weighted comorbidity index
 * ================================================================== */

/** Score-band labels from inclusive lower bounds, e.g. [0,1,3] -> 0 / 1-2 / 3+. */
export function scoreBandLabels(lowers: number[]): Array<{ lower: number; label: string }> {
  const b = [...lowers].sort((x, y) => x - y);
  return b.map((lo, i) => ({
    lower: lo,
    label: i === b.length - 1 ? `${lo}+` : b[i + 1] - lo === 1 ? `${lo}` : `${lo}-${b[i + 1] - 1}`,
  }));
}

/** The parameter set a comorbidity-index twin must consume identically. */
export interface ComorbidityIndexParity {
  id: string;
  indexName: string;
  lookback: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  /** every condition, in emission order, with the weight actually used */
  conditions: Array<{ id: string; codeListId: string; weight: number }>;
  /** the hierarchy, flattened and sorted so both twins serialize it identically */
  supersessions: Array<{ winner: string; loser: string }>;
  bands: string[];
  /** what supersession actually does, so the stamp cannot imply more than the code does */
  supersessionEffect: "withholds_weight_keeps_prevalence";
  medianEstimator: "percentile_cont_equivalent";
}

/** Spec options the comorbidity-index twins do NOT implement yet. */
export function comorbidityIndexLimitations(an: ComorbidityIndexAnalysis): string[] {
  const out: string[] = [];
  out.push(
    `the WEIGHTS and CODE LISTS are taken verbatim from the spec and are NOT validated against any published index - "${an.indexName}" is the label the analyst attached to them, not a lookup this program performed`,
  );
  out.push(
    `conditions are ascertained from ANY care setting and ANY diagnosis position, with a single qualifying claim; published algorithms that require two outpatient claims or an inpatient diagnosis are NOT enforced, which will over-ascertain relative to those definitions`,
  );
  out.push(
    `no age adjustment is applied - the age-weighted Charlson variants add points by decade, and adding them here would double count whenever age is already a covariate`,
  );
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const COMORBIDITY_INDEX_METHOD_NOTES = [
  `score = SUM of the weights of the conditions present in the lookback, after the hierarchy: when a condition that SUPERSEDES another is present, the superseded condition contributes 0 rather than its weight (severe liver disease replaces mild, complicated diabetes replaces uncomplicated, and so on as the spec declares)`,
  `a superseded condition still reports its PREVALENCE in the condition rows - only its weight is withheld. Hiding the prevalence as well would let a scoring convention conceal a clinical fact`,
  `every cohort member is scored, including those with no qualifying condition, so the mean is over the whole cohort and a score of 0 is a real value rather than a missing one`,
  `the lookback is a fixed window relative to index; a member with less observed history has fewer chances to accrue conditions, which biases the index DOWNWARD for late enrollees unless continuous enrollment is required`,
  `the median is comparable across the twins (PERCENTILE_CONT at p = 0.5 equals SAS PCTLDEF=5 exactly); no quartile is emitted, because the two estimators diverge away from the median`,
];

/** The parity record for a comorbidity-index twin, from consumed values. */
export function comorbidityIndexParity(
  an: ComorbidityIndexAnalysis,
  consumed: { pairs: Array<{ winner: string; loser: string }>; bands: Array<{ lower: number; label: string }> },
): ComorbidityIndexParity {
  return {
    id: an.id,
    indexName: an.indexName,
    lookback: { start: an.lookback.start, end: an.lookback.end, includesIndex: an.lookback.includesIndex },
    conditions: an.conditions.map((c) => ({ id: c.id, codeListId: c.codeListId, weight: c.weight })),
    supersessions: [...consumed.pairs].sort((a, b) => (a.winner + a.loser).localeCompare(b.winner + b.loser)),
    bands: consumed.bands.map((b) => b.label),
    supersessionEffect: "withholds_weight_keeps_prevalence",
    medianEstimator: "percentile_cont_equivalent",
  };
}
