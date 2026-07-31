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
  RegressionAnalysis,
  RelativeWindow,
  ResourceUseAnalysis,
  Stratifier,
  CoxAnalysis,
  CompetingRisksAnalysis,
  FineGrayAnalysis,
  PropensityScoreAnalysis,
  IptwOutcomeAnalysis,
  GFormulaAnalysis,
  AdherenceAnalysis,
  SurvivalAnalysis,
  TrendSpec,
} from "../spec/types";
import type { StudySpec } from "../spec/types";
import { survivalOutcome, daysSupplyCleaningFor } from "../spec/types";

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
  /** the DELIVERY's observation limit, when one is declared. Stamped because it
   *  is not a censorAt value the analyst opts into — it is applied whenever
   *  meta.dataCutDate is set, and the SAS twin used to omit it entirely. */
  dataCut: string | null;
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
  consumed: { daysPerYear: string; censorTerms: string[]; settingFilter: string; strata: SupportedStratifier[]; dataCut: string | null }
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
    dataCut: consumed.dataCut,
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
    /* Adherence reaches the pull in BOTH directions, and both are silent if
     * missed. Forward: a measurement window ending past followupDays would pull
     * no pharmacy claims for its tail, and fills that were never pulled read as
     * non-adherence rather than as missing data. Backward: a dispensing BEFORE
     * the window whose supply reaches into it is in scope by construction (the
     * interval algebra keeps any fill whose end lands at or after the window
     * start), so the pull has to reach back a full maximum days supply beyond
     * the window start or those covered days silently disappear. */
    if (a.kind === "adherence") {
      const cap = daysSupplyCleaningFor(a).maxDaysSupplyCap;
      const wStart = typeof a.window.start === "number" ? a.window.start : 0;
      const back = Math.max(0, -wStart) + cap;
      consider(back, `analysis "${a.id}" needs fills reaching into its window: ${cap}d max supply before day ${wStart}`);
      if (typeof a.window.end === "number" && a.window.end > fwdDays) {
        fwdDays = a.window.end; reasons.push(`analysis "${a.id}" adherence window ends day ${a.window.end}`);
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

/* ================================================================== *
 *  Regression (GLM)
 * ================================================================== */

/** The parameter set a regression twin must consume identically. */
export interface RegressionParity {
  id: string;
  family: string;
  codeListId: string;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  horizonDays: number;
  groupVarId: string;
  /** baseline category; the coefficient is for the OTHER level */
  referenceLevel: string;
  exposedLevel: string;
  /** adjusted-model terms in order, exposure first */
  terms: string[];
  settingFilter: string;
  /** "indicator" (0/1) or "count" (recurrent events). The cell algebra and the
   *  crude closed form differ between them, so the checks must know which. */
  responseKind: "indicator" | "count" | "cost" | "continuous";
  /** the effect the exponentiated coefficient IS — labelling a Poisson
   *  coefficient "odds_ratio" would be a mislabeled statistic, so the label is
   *  stamped and compared */
  effectStatistic: string;
  /** censoring bounds for the log offset, when the family needs one */
  offset: { applied: string[]; dataCut: string | null } | null;
  /** what each twin actually produces */
  crudeEffect: "closed_form_2x2";
  adjustedSource: "sas_primary";
  /** the check the SAS twin performs on itself */
  saturatedAnchor: "unadjusted_mle_equals_closed_form_log_or";
}

/** Spec options the regression twins do NOT implement yet. */
export function regressionLimitations(an: RegressionAnalysis, listSystem: CodeSystem, covLabels: string[], droppedCovs: string[]): string[] {
  const out: string[] = [];
  const settingNote = outcomeSettingPlan(an.outcomeDefinition, listSystem).note;
  if (settingNote) out.push(settingNote);
  if (an.outcomeDefinition.minClaims > 1)
    out.push(`outcome minClaims=${an.outcomeDefinition.minClaims} is NOT yet enforced - any single qualifying claim inside the horizon counts as an event`);
  for (const d of droppedCovs)
    out.push(`covariate "${d}" is NOT in the adjusted model - only age, sex and a comorbidity_index referencing an ENABLED index analysis are derivable from the cohort spine today`);
  if (covLabels.length === 0)
    out.push(`no covariates resolved, so the "adjusted" model is identical to the crude one - it is still emitted, and at that point its MLE MUST reproduce the closed-form estimate exactly`);
  out.push(`NO variable selection, interaction, spline or collinearity diagnostic is emitted - the model is exactly the terms listed, in the order listed`);
  if (an.family === "poisson")
    out.push(`the Poisson model assumes the variance equals the mean. Overdispersion is NOT tested for and NOT corrected - an overdispersed outcome will produce standard errors that are too small and intervals that are too narrow, with nothing in the output to say so`);
  out.push(`the crude interval is the WOOLF (log-odds) Wald interval; it is poor at small cell counts and is not an exact interval. Any zero cell makes it undefined, and the program returns NULL rather than adding a continuity correction, because a correction silently changes the estimand`);
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const REGRESSION_METHOD_NOTES = [
  `the ANALYTIC DATASET and the CRUDE effect are computed in BOTH twins: a 2x2 of exposure by incident event, and from it the odds ratio, risk ratio and risk difference in closed form`,
  `the ADJUSTED coefficients are SAS-PRIMARY. Fitting a GLM needs iteratively reweighted least squares, which warehouse SQL cannot run, so SQL emits those estimates as NULL beside a label naming the procedure that produces them - never a guess`,
  `SATURATED-DESIGN ANCHOR: a logistic model whose only predictor is the two-level exposure is saturated for a 2x2, so its maximum-likelihood estimate EQUALS the closed-form log odds ratio. The SAS program fits that model and checks itself against the closed form it computes from its own data - no reference number is shipped with it`,
  `the outcome is INCIDENT: prevalent cases are removed by the washout before the model is built, so the odds ratio is for new-onset disease and not for prevalence`,
  `subjects are counted ONCE. A subject with several qualifying claims inside the horizon contributes one event, and the horizon is measured from each subject's own index date`,
  `the exposure coefficient is for the NON-reference level. Flipping referenceLevel inverts the sign of every reported effect, which is why it is stamped and compared across the twins`,
];

/** The parity record for a regression twin, from consumed values. */
export function regressionParity(
  an: RegressionAnalysis,
  consumed: {
    referenceLevel: string; exposedLevel: string; terms: string[]; settingFilter: string;
    effectStatistic: string; offset: { applied: string[]; dataCut: string | null } | null;
    responseKind: "indicator" | "count" | "cost" | "continuous";
  },
): RegressionParity {
  return {
    id: an.id,
    family: an.family,
    codeListId: an.outcomeDefinition.codeListId,
    washout: { start: an.washout.start, end: an.washout.end, includesIndex: an.washout.includesIndex },
    horizonDays: an.horizonDays,
    groupVarId: an.groupVarId,
    referenceLevel: consumed.referenceLevel,
    exposedLevel: consumed.exposedLevel,
    terms: consumed.terms,
    settingFilter: consumed.settingFilter,
    responseKind: consumed.responseKind,
    effectStatistic: consumed.effectStatistic,
    offset: consumed.offset,
    crudeEffect: "closed_form_2x2",
    adjustedSource: "sas_primary",
    saturatedAnchor: "unadjusted_mle_equals_closed_form_log_or",
  };
}

/* ------------------------------------------------------------------ *
 *  Survival / time-to-event
 * ------------------------------------------------------------------ */

export interface SurvivalParity {
  id: string;
  /** the endpoint's code list. The DEATH endpoint never reaches an emitter —
   *  readiness refuses it — so this is always a claims event. */
  codeListId: string;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  /** censorAt values actually honored, and the delivery cut if one applies */
  censorTerms: string[];
  dataCut: string | null;
  /** day marks S(t) is reported at, in order */
  horizonDays: number[];
  ciMethod: string;
  settingFilter: string;
  /** every stratum whose curve is emitted, 'Overall' first */
  strata: string[];
  referenceLevel: string | null;
  exposedLevel: string | null;
  /** the log-rank statistic is emitted (needs a two-level exposure) */
  logRank: boolean;
  emitLifeTable: boolean;
  /** what each twin actually produces. Note how little is SAS-primary here
   *  compared with the regression family: the estimator, its variance, both
   *  interval forms, the median AND the log-rank statistic are all closed
   *  form — only the chi-square tail probability is not. */
  estimator: "product_limit";
  variance: "greenwood";
  logRankStatistic: "closed_form_mantel";
  logRankPValue: "sas_primary";
  kmAnchor: "lifetest_equals_closed_form_product_limit";
}

/** Spec options the survival twins do NOT implement. */
export function survivalLimitations(an: SurvivalAnalysis, listSystem: CodeSystem, spec?: StudySpec): string[] {
  const out: string[] = [];
  const od = survivalOutcome(an);
  if (od) {
    const settingNote = outcomeSettingPlan(od, listSystem).note;
    if (settingNote) out.push(settingNote);
    if (od.minClaims > 1)
      out.push(`endpoint minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts as the event, so the survival time is the FIRST claim's date rather than the date a multi-claim definition would be satisfied`);
  }
  if (an.personTimeRule.censorAt.includes("death")) out.push(DEATH_CENSOR_NOTE);
  if (spec && !dataCutLimit(spec)) out.push(NO_DATA_CUT_NOTE);
  /* The interval that is NOT emitted, named. A median with no interval reads as
   * a point estimate somebody chose not to qualify. */
  out.push(`NO confidence interval is emitted for the MEDIAN. The Brookmeyer-Crowley interval is the set of times whose confidence band covers one half, which is derivable from the band this program already computes - it is simply not built yet, and a median is reported without one rather than with an invented one`);
  out.push(`the curves are UNADJUSTED. No stratified, weighted or covariate-adjusted survival is emitted, so a difference between arms carries every confounder the arms differ on`);
  out.push(`CENSORING IS ASSUMED NON-INFORMATIVE. Nothing in claims data can test that, and the assumption fails hardest exactly when a member leaves the plan BECAUSE of their disease - which biases survival UPWARD`);
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const SURVIVAL_METHOD_NOTES = [
  `almost everything here is EXECUTED in both twins: the product-limit estimator, Greenwood's variance, both interval forms, the median and the log-rank statistic are all closed form. The p-value is the ONLY SAS-primary column, because it is the only quantity needing a distribution function warehouse SQL does not have`,
  `KAPLAN-MEIER ANCHOR: the SAS twin also runs PROC LIFETEST and compares it, row by row, against the closed form it computed itself. Unlike a fitted GLM the product-limit estimator has a closed form, so the procedure can be CHECKED rather than trusted - and no reference number ships with the program`,
  `the LOG-RANK DECISION at alpha = 0.05 is emitted without a p-value: for one degree of freedom the critical value is z^2, so a decision needs only a comparison against a constant. The exact p-value stays SAS-primary`,
  `follow-up starts at each subject's own index date and stops at the earliest of the endpoint and the administrative censor, so time is measured from the same origin for everyone regardless of calendar date`,
  `the endpoint is INCIDENT: prevalent cases are removed by the washout before the curve starts, so the curve describes time to NEW-ONSET disease and not time to a first observed claim for existing disease`,
  `a NULL median is a RESULT, not a gap - it means more than half of the arm was still event-free when follow-up ended, and the row is emitted rather than omitted so it cannot read as a failed computation`,
];

/** The parity record for a survival twin, from consumed values. */
export function survivalParity(
  an: SurvivalAnalysis,
  consumed: {
    settingFilter: string; censorTerms: string[]; dataCut: string | null;
    strata: string[]; referenceLevel: string | null; exposedLevel: string | null; logRank: boolean;
  },
): SurvivalParity {
  return {
    id: an.id,
    codeListId: survivalOutcome(an)?.codeListId ?? "",
    washout: { start: an.washout.start, end: an.washout.end, includesIndex: an.washout.includesIndex },
    censorTerms: consumed.censorTerms,
    dataCut: consumed.dataCut,
    horizonDays: an.horizonDays,
    ciMethod: an.ciMethod,
    settingFilter: consumed.settingFilter,
    strata: consumed.strata,
    referenceLevel: consumed.referenceLevel,
    exposedLevel: consumed.exposedLevel,
    logRank: consumed.logRank,
    emitLifeTable: an.emitLifeTable,
    estimator: "product_limit",
    variance: "greenwood",
    logRankStatistic: "closed_form_mantel",
    logRankPValue: "sas_primary",
    kmAnchor: "lifetest_equals_closed_form_product_limit",
  };
}

/* ------------------------------------------------------------------ *
 *  Cox proportional hazards
 * ------------------------------------------------------------------ */

export interface CoxParity {
  id: string;
  codeListId: string;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  censorTerms: string[];
  dataCut: string | null;
  settingFilter: string;
  referenceLevel: string;
  exposedLevel: string;
  /** fitted-model terms in order, exposure first */
  terms: string[];
  /** Breslow only — readiness refuses anything else, and the reason is that the
   *  SQL twin's closed forms ARE Breslow's. A stamp that let this vary would let
   *  the twins disagree about which likelihood is being maximized. */
  ties: "breslow";
  /** what each twin actually produces */
  nullLoglik: "closed_form_breslow";
  score: "closed_form_equals_logrank_numerator";
  information: "closed_form_breslow";
  oneStep: "first_newton_step";
  fittedCoefficient: "sas_primary";
  /** the three checks the SAS twin runs on PROC PHREG */
  selfChecks: ["null_minus_2_loglik", "score_at_beta_hat_is_zero", "constant_proportion_closed_form"];
}

/** Spec options the Cox twins do NOT implement. Each is a real modelling choice
 *  a protocol might ask for, named rather than silently absent. */
export function coxLimitations(
  an: CoxAnalysis, listSystem: CodeSystem, covLabels: string[], droppedCovs: string[], spec?: StudySpec,
): string[] {
  const out: string[] = [];
  const od = survivalOutcome(an);
  if (od) {
    const settingNote = outcomeSettingPlan(od, listSystem).note;
    if (settingNote) out.push(settingNote);
    if (od.minClaims > 1)
      out.push(`endpoint minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts, so the survival time is the FIRST claim's date`);
  }
  if (an.personTimeRule.censorAt.includes("death")) out.push(DEATH_CENSOR_NOTE);
  if (spec && !dataCutLimit(spec)) out.push(NO_DATA_CUT_NOTE);
  for (const d of droppedCovs)
    out.push(`covariate "${d}" is NOT in the fitted model - only age, sex and a comorbidity_index referencing an ENABLED index analysis are derivable from the cohort spine today`);
  if (covLabels.length === 0)
    out.push(`no covariates resolved, so the "adjusted" model is the unadjusted one - it is still emitted, and at that point its coefficient is the one every closed form on this table describes`);
  /* THE ASSUMPTION THE MODEL IS NAMED AFTER, and it is not tested here. */
  out.push(`PROPORTIONAL HAZARDS IS ASSUMED AND NOT TESTED. A Schoenfeld-residual test needs residuals evaluated at the fitted coefficient and a p-value for their correlation with time, neither of which this program computes. If the hazard ratio changes over follow-up, the single number reported here is a weighted average of a ratio that was never constant - and nothing in the output says so. Run "assess ph / resample" in PROC PHREG, or report a time-stratified estimate`);
  out.push(`NO time-varying covariates: every covariate is measured once, at baseline, so a treatment that starts after index is modelled as if it had always been there (immortal-time bias)`);
  out.push(`NO stratified baseline hazard: a single baseline hazard is assumed to apply to every subject`);
  out.push(`ties are handled by BRESLOW's approximation. When tied event times are COMMON, Efron's is materially better and Breslow biases the coefficient toward the null - the tied_event_times row in the result says how many there are, which is the number that decides whether this matters`);
  return out;
}

/** Method notes ALWAYS emitted (describe what IS computed). */
export const COX_METHOD_NOTES = [
  `the COEFFICIENT is SAS-primary: maximizing a partial likelihood needs Newton-Raphson, which warehouse SQL cannot run, so SQL emits it NULL beside the procedure that produces it - never a guess`,
  `everything the fit is CHECKED AGAINST is closed form and computed in BOTH twins: the partial log-likelihood at the null, the score, the information, the score test and the one-step estimator`,
  `the SCORE at beta = 0 IS the log-rank numerator O - E. The log-rank test is the Cox score test at the null, so a survival analysis and a Cox model on the same data must agree on that number exactly`,
  `the INFORMATION at beta = 0 equals the LOG-RANK VARIANCE when no event time is tied, and differs when one is - the log-rank carries a (n-d)/(n-1) correction Breslow's information does not. Both are emitted, beside a count of tied event times, so a reader can see which regime the data are in`,
  `SELF-CHECK, in the SAS twin: U(beta_hat) = 0. That is the equation DEFINING the estimate, and because the exposure is binary the score at any beta is closed form in the risk-set counts alone - so the fitted coefficient is checked against its own definition rather than trusted`,
  `SELF-CHECK: PROC PHREG's "without covariates" -2 LOG L must equal -2 times the closed-form null partial log-likelihood computed here from the same data`,
  `THE ANCHOR, where it applies: if every risk set has the same exposed share p, the partial likelihood collapses to a binomial whose maximum is closed form, HR = [q/(1-q)] / [p/(1-p)] with q the exposed share of events. Real risk sets drift, so this is usually NOT APPLICABLE and says so - it is a verification device, the way a saturated 2x2 is`,
  `the one-step estimator exp(U(0)/I(0)) is the FIRST NEWTON STEP from the null, not the maximum. It is reported because it is executable, and labelled because it is not the answer`,
];

export function coxParity(
  an: CoxAnalysis,
  consumed: {
    settingFilter: string; censorTerms: string[]; dataCut: string | null;
    referenceLevel: string; exposedLevel: string; terms: string[];
  },
): CoxParity {
  return {
    id: an.id,
    codeListId: survivalOutcome(an)?.codeListId ?? "",
    washout: { start: an.washout.start, end: an.washout.end, includesIndex: an.washout.includesIndex },
    censorTerms: consumed.censorTerms,
    dataCut: consumed.dataCut,
    settingFilter: consumed.settingFilter,
    referenceLevel: consumed.referenceLevel,
    exposedLevel: consumed.exposedLevel,
    terms: consumed.terms,
    ties: "breslow",
    nullLoglik: "closed_form_breslow",
    score: "closed_form_equals_logrank_numerator",
    information: "closed_form_breslow",
    oneStep: "first_newton_step",
    fittedCoefficient: "sas_primary",
    selfChecks: ["null_minus_2_loglik", "score_at_beta_hat_is_zero", "constant_proportion_closed_form"],
  };
}

/* ------------------------------------------------------------------ *
 *  Competing risks (Aalen-Johansen)
 * ------------------------------------------------------------------ */

export interface CompetingRisksParity {
  id: string;
  /** cause code -> which code list ascertains it, in emission order. The CAUSE
   *  NUMBERING is part of the contract: if the twins disagreed about which cause
   *  is 2, every CIF would be attached to the wrong label while the partition
   *  identity still held perfectly. */
  causes: Array<{ code: number; id: string; codeListId: string }>;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  censorTerms: string[];
  dataCut: string | null;
  settingFilter: string;
  horizonDays: number[];
  emitNaiveComparison: boolean;
  emitLifeTable: boolean;
  estimator: "aalen_johansen";
  variance: "delta_method_closed_form";
  /** unusually for this repo, nothing is deferred to SAS here */
  sasPrimary: "none";
}

export function competingRisksLimitations(an: CompetingRisksAnalysis, listSystem: CodeSystem, spec?: StudySpec): string[] {
  const out: string[] = [];
  const od = survivalOutcome(an);
  if (od) {
    const note = outcomeSettingPlan(od, listSystem).note;
    if (note) out.push(note);
    if (od.minClaims > 1)
      out.push(`endpoint minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts, so the failure time is the FIRST claim's date`);
  }
  if (an.personTimeRule.censorAt.includes("death")) out.push(DEATH_CENSOR_NOTE);
  if (spec && !dataCutLimit(spec)) out.push(NO_DATA_CUT_NOTE);
  /* GRAY'S TEST: not emitted rather than approximated. */
  out.push(`NO GRAY'S TEST. The competing-risks analogue of the log-rank compares SUBDISTRIBUTION hazards, and its weights depend on the cumulative incidence at each event time — it is closed form, but it is a different and more intricate statistic than the log-rank, and a "close enough" version of it would be a mislabeled test rather than a rounding error. If you need a formal comparison, PROC LIFETEST with eventcode= produces Gray's test, and a survival analysis on the CAUSE-SPECIFIC events gives the log-rank — which answers a DIFFERENT question, see the method notes`);
  out.push(`NO FINE-GRAY REGRESSION: there is no subdistribution-hazard model here, so there is no adjusted competing-risks effect estimate. The cumulative incidences are unadjusted`);
  out.push(`the causes are assumed EXHAUSTIVE. Any failure mode not in the endpoint or competingEvents[] is treated as CENSORING, which puts it back in the position this analysis exists to correct — the partition identity cannot detect a cause nobody declared`);
  if (!an.emitNaiveComparison)
    out.push(`emitNaiveComparison is OFF, so the 1 - Kaplan-Meier estimate and the bias against it are not reported. That difference is the reason this analysis is being run instead of a simpler one, and a reader without it has to take the choice on faith`);
  return out;
}

export const COMPETING_RISKS_METHOD_NOTES = [
  `Aalen-Johansen: CIF_k(t) = SUM over event times of S(t_prev) * d_k / n, with S the ALL-CAUSE Kaplan-Meier. The risk set is all-cause on purpose — a competing event removes the subject from every cause's denominator, including its own`,
  `the PARTITION IDENTITY is emitted as a row: the causes are exhaustive and mutually exclusive, so the cumulative incidences sum to EXACTLY 1 - S(t) at every mark. It is not a tolerance check — the sums telescope, and any error in one cause's accumulation breaks it. Read those rows first`,
  `the naive 1 - Kaplan-Meier per cause is computed BESIDE the CIF and the difference reported, so the reason for using this estimator is a subtraction in the output rather than a claim in a note`,
  `naive per-cause risks can sum to MORE than the total probability of any event — mutually exclusive outcomes whose probabilities exceed the chance of either happening. When that occurs it is flagged, because it is the clearest evidence that treating competing events as censoring is not a small approximation`,
  `the variance is the delta-method form (Klein & Moeschberger 2e 4.9), three sums over the same risk sets. Its interval is a Wald interval on the raw scale, CLAMPED to [0,1] and labelled as clamped: near the boundary it runs outside the range a probability can take`,
  `CAUSE-SPECIFIC vs SUBDISTRIBUTION hazards answer different questions. A log-rank or Cox model on the cause-specific events estimates the ETIOLOGIC effect on the rate among those still at risk; the cumulative incidence here is the PREDICTIVE quantity, what fraction of the original cohort will have this event. Both are legitimate and they routinely point in different directions — reporting one and discussing the other is a common and serious error`,
  `SAS-PRIMARY: nothing. There is no p-value and no fitted coefficient in this analysis, so the SQL twin is complete — which is true of no other family in this bundle`,
];

export function competingRisksParity(
  an: CompetingRisksAnalysis,
  consumed: {
    censorTerms: string[]; dataCut: string | null; settingFilter: string;
    causes: Array<{ code: number; id: string; codeListId: string }>;
  },
): CompetingRisksParity {
  return {
    id: an.id,
    causes: consumed.causes,
    washout: { start: an.washout.start, end: an.washout.end, includesIndex: an.washout.includesIndex },
    censorTerms: consumed.censorTerms,
    dataCut: consumed.dataCut,
    settingFilter: consumed.settingFilter,
    horizonDays: an.horizonDays,
    emitNaiveComparison: an.emitNaiveComparison,
    emitLifeTable: an.emitLifeTable,
    estimator: "aalen_johansen",
    variance: "delta_method_closed_form",
    sasPrimary: "none",
  };
}

/* ------------------------------------------------------------------ *
 *  Fine-Gray subdistribution hazard
 * ------------------------------------------------------------------ */

export interface FineGrayParity {
  id: string;
  causes: Array<{ code: number; codeListId: string }>;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  censorTerms: string[];
  dataCut: string | null;
  settingFilter: string;
  referenceLevel: string;
  exposedLevel: string;
  terms: string[];
  /** the one thing that distinguishes this from Cox */
  riskSet: "subdistribution_ipcw_weighted";
  weights: "kaplan_meier_of_censoring";
  nullLoglik: "closed_form";
  score: "closed_form";
  information: "closed_form";
  oneStep: "first_newton_step";
  fittedCoefficient: "sas_primary";
  selfChecks: ["null_minus_2_loglik", "score_at_beta_hat_is_zero", "subdistribution_actually_fitted"];
}

export function fineGrayLimitations(
  an: FineGrayAnalysis, listSystem: CodeSystem, covLabels: string[], droppedCovs: string[], spec?: StudySpec,
): string[] {
  const out: string[] = [];
  const od = survivalOutcome(an);
  if (od) {
    const note = outcomeSettingPlan(od, listSystem).note;
    if (note) out.push(note);
    if (od.minClaims > 1)
      out.push(`endpoint minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts, so the failure time is the FIRST claim's date`);
  }
  if (an.personTimeRule.censorAt.includes("death")) out.push(DEATH_CENSOR_NOTE);
  if (spec && !dataCutLimit(spec)) out.push(NO_DATA_CUT_NOTE);
  for (const d of droppedCovs)
    out.push(`covariate "${d}" is NOT in the fitted model - only age, sex and a comorbidity_index referencing an ENABLED index analysis are derivable from the cohort spine today`);
  if (covLabels.length === 0)
    out.push(`no covariates resolved, so the "adjusted" model is the unadjusted one`);
  /* The assumption, and it is stronger here than in a Cox model. */
  out.push(`PROPORTIONAL SUBDISTRIBUTION HAZARDS IS ASSUMED AND NOT TESTED, and this assumption is HARDER to justify than the Cox one it resembles: the subdistribution hazard is not a rate among people who could still have the event, so its constancy over time has no simple clinical reading. Nothing here tests it`);
  out.push(`the CENSORING distribution is assumed INDEPENDENT of exposure. The weights are G(t)/G(t_j) from a single pooled Kaplan-Meier, so if one arm is followed longer or lost more often the weights are wrong for both. A stratified or covariate-dependent G is not emitted`);
  out.push(`NO time-varying covariates and NO stratified baseline subdistribution hazard`);
  out.push(`this model answers a DIFFERENT question from a cause-specific Cox model on the same data, and the two routinely disagree in magnitude and occasionally in DIRECTION. Neither is wrong; reporting one while discussing the other is`);
  return out;
}

export const FINE_GRAY_METHOD_NOTES = [
  `the RISK SET is what makes this Fine-Gray rather than Cox: a subject who fails from a COMPETING cause STAYS in the denominator, weighted by G(t)/G(t_j) with G the Kaplan-Meier of the CENSORING distribution. Every other piece of arithmetic is the Cox one`,
  `treating censoring as the event - which is how G is built - is the classic error everywhere else in this bundle and is exactly right here. It is a different quantity, and the two differ by one predicate`,
  `the coefficient is an effect on the CUMULATIVE INCIDENCE, not on the rate among survivors. A cause-specific Cox model on the same data estimates the etiologic effect and routinely gives a different number`,
  `SAS-PRIMARY: the coefficient only. The null partial log-likelihood, the score, the information, the score test and the one-step estimator are all closed form and computed in BOTH twins`,
  `THE REDUCTION that makes this checkable: with NO competing events the modified risk set has nothing extra to hold, every weight is 1, and this model becomes Cox IDENTICALLY - the same numbers, not similar ones`,
  `SELF-CHECK, in the SAS twin: whether a SUBDISTRIBUTION model was fitted at all. Without eventcode= on the MODEL statement PROC PHREG fits a cause-specific Cox model - cleanly, convergently, and answering a different question. That is the single most likely way for this analysis to be silently wrong, so the program compares its own two risk-set totals and says when they are indistinguishable`,
  `SELF-CHECK: U(beta_hat) = 0 on the weighted risk sets, and PHREG's null -2 LOG L against the closed form - the same two the Cox module runs`,
  `COMPLETE SEPARATION (every event of interest in one arm) makes the estimate INFINITE. The one-step and the closed form both return NULL rather than the large finite number that would read as a very strong effect`,
];

export function fineGrayParity(
  an: FineGrayAnalysis,
  consumed: {
    censorTerms: string[]; dataCut: string | null; settingFilter: string;
    referenceLevel: string; exposedLevel: string; terms: string[];
    causes: Array<{ code: number; codeListId: string }>;
  },
): FineGrayParity {
  return {
    id: an.id,
    causes: consumed.causes,
    washout: { start: an.washout.start, end: an.washout.end, includesIndex: an.washout.includesIndex },
    censorTerms: consumed.censorTerms,
    dataCut: consumed.dataCut,
    settingFilter: consumed.settingFilter,
    referenceLevel: consumed.referenceLevel,
    exposedLevel: consumed.exposedLevel,
    terms: consumed.terms,
    riskSet: "subdistribution_ipcw_weighted",
    weights: "kaplan_meier_of_censoring",
    nullLoglik: "closed_form",
    score: "closed_form",
    information: "closed_form",
    oneStep: "first_newton_step",
    fittedCoefficient: "sas_primary",
    selfChecks: ["null_minus_2_loglik", "score_at_beta_hat_is_zero", "subdistribution_actually_fitted"],
  };
}

/* ------------------------------------------------------------------ *
 *  Propensity score (IPTW)
 * ------------------------------------------------------------------ */

export interface PropensityScoreParity {
  id: string;
  referenceLevel: string;
  treatedLevel: string;
  /** THE CELL SPELLING, in order. Two twins that agreed on the covariates but
   *  concatenated them differently would produce different scores from the same
   *  data, and no comparison of NUMBERS would catch it — the cell is a string,
   *  and its construction is part of the contract. */
  cellAxes: string[];
  balanceTerms: string[];
  method: string;
  estimand: string;
  stabilized: boolean;
  trim: number;
  score: "saturated_closed_form";
  variance: "frequency_weighted_sample";
  sasPrimary: "none";
}

export function propensityScoreLimitations(an: PropensityScoreAnalysis, droppedBalance: string[]): string[] {
  const out: string[] = [];
  for (const d of droppedBalance)
    out.push(`balance covariate "${d}" is NOT reported - only age, sex and a comorbidity_index referencing an ENABLED index analysis are derivable from the cohort spine today`);
  out.push(`the score is SATURATED over categorical cells, which is what makes it closed form. It is therefore a FULLY INTERACTED model: every combination of the covariates gets its own probability. That is the most flexible specification available and also the one most prone to empty cells - read the positivity rows first`);
  out.push(`NO CONTINUOUS COVARIATE can enter the score. Readiness refuses one rather than emitting a pipeline whose every number would come from a probability that is not the maximum-likelihood estimate. Band it, or fit the score elsewhere`);
  out.push(`the OUTCOME MODEL is not run here. This analysis produces the score, the weights and the balance; a weighted effect estimate is a separate analysis, and the weights it would need are per-subject rather than in this summary table`);
  out.push(`weighting adjusts for what is IN the score and nothing else. Unmeasured confounding is untouched, and covariates outside the model can end up MORE imbalanced - the balance rows report both numbers so that is visible rather than assumed away`);
  if (an.trim > 0)
    out.push(`TRIMMING at ${an.trim} changes the estimand: the effect is now for the sub-population whose score falls inside the bounds, which is not the cohort described in the attrition table`);
  if (an.method === "iptw" && !an.stabilized)
    out.push(`weights are UNSTABILIZED, so their scale is the pseudo-population rather than the sample. Stabilized weights change the scale and not the balance, and make the effective sample size easier to read against the actual n`);
  return out;
}

export const PROPENSITY_SCORE_METHOD_NOTES = [
  `the score is the SATURATED maximum-likelihood estimate: a logistic model over categorical cells has as many parameters as cells, so its fitted probability in each cell IS the observed treated fraction. That is arithmetic, not a fit - and the SAS twin checks it against PROC LOGISTIC rather than asserting it`,
  `POSITIVITY IS REPORTED AS A COUNT OF PEOPLE, not as a warning about a distribution. Read subjects_off_support first: it counts the members of cells that are entirely one arm, directly`,
  `the pseudo-population gap is a CORROBORATING row, not the test. A gap PROVES a positivity violation - it can only come from single-arm cells. A gap of zero proves nothing: the cells containing treated members and the cells containing controls can hold the same number of people by arithmetic accident, and on one of this project's own fixtures they do, with four subjects off support and a gap of exactly zero`,
  `a weight of 1/0 is UNDEFINED, not large. Those rows are NULL and counted separately rather than summed into a total that would look finite`,
  `the effective sample size is Kish's: how many EQUALLY weighted subjects carry the same information. It is never more than the actual n, and equal to it only when every weight is the same - so it is the honest denominator for anything computed on the weighted sample`,
  `the weighted standardized difference uses the FREQUENCY-WEIGHTED sample variance (Austin Stat Med 2009;28:3083). The naive SUM(w(x-xbar)^2)/SUM(w) shrinks the denominator and makes a weighted analysis look better balanced than it is`,
  `balance is reported BEFORE and AFTER, per covariate, with the change. Weighting can make a covariate WORSE if it is not in the score, and a table that only showed the after number would hide it`,
  `SAS-PRIMARY: nothing. Every number in this analysis is computed by both twins`,
];

export function propensityScoreParity(
  an: PropensityScoreAnalysis,
  consumed: { referenceLevel: string; treatedLevel: string; cellAxes: string[]; balanceTerms: string[] },
): PropensityScoreParity {
  return {
    id: an.id,
    referenceLevel: consumed.referenceLevel,
    treatedLevel: consumed.treatedLevel,
    cellAxes: consumed.cellAxes,
    balanceTerms: consumed.balanceTerms,
    method: an.method,
    estimand: an.estimand,
    stabilized: an.stabilized,
    trim: an.trim,
    score: "saturated_closed_form",
    variance: "frequency_weighted_sample",
    sasPrimary: "none",
  };
}

/* ------------------------------------------------------------------ *
 *  IPTW outcome model
 * ------------------------------------------------------------------ */

export interface IptwOutcomeParity {
  id: string;
  codeListId: string;
  horizonDays: number;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  settingFilter: string;
  referenceLevel: string;
  treatedLevel: string;
  cellAxes: string[];
  estimand: string;
  stabilized: boolean;
  trim: number;
  /** the score is estimated in the AT-RISK set, not the whole cohort */
  scorePopulation: "at_risk_after_washout";
  estimator: "hajek_ratio";
  variance: "sandwich_weights_treated_as_known";
  sasPrimary: "none";
}

export function iptwOutcomeLimitations(an: IptwOutcomeAnalysis, listSystem: CodeSystem): string[] {
  const out: string[] = [];
  const note = outcomeSettingPlan(an.outcomeDefinition, listSystem).note;
  if (note) out.push(note);
  if (an.outcomeDefinition.minClaims > 1)
    out.push(`outcome minClaims=${an.outcomeDefinition.minClaims} is NOT yet enforced - any single qualifying claim counts as an event`);
  out.push(`the outcome is a BINARY indicator over a fixed horizon. Nobody is censored: a subject who leaves the data before the horizon is counted as event-free, which understates risk. Use the survival or competing-risks modules when follow-up is incomplete`);
  out.push(`the sandwich variance treats the WEIGHTS AS KNOWN. They come from a fitted score, and propagating that estimation generally NARROWS the interval rather than widening it (Lunceford & Davidian 2004), so what is reported is conservative for the ATE and is labelled weights_treated_as_known rather than simply "robust"`);
  out.push(`NO doubly-robust augmentation. With categorical covariates the outcome regression would also be saturated, so this is buildable and simply not built - the missing piece is the augmentation term's own influence function, since the AIPW variance is not the Hajek sandwich`);
  out.push(`NO bootstrap interval: it needs an RNG and would break byte-stable emission outright`);
  if (an.estimand === "att")
    out.push(`the ATT weights make this the effect among the TREATED, so the risk in the control arm is a counterfactual for the treated population and not a description of the controls themselves`);
  return out;
}

export const IPTW_OUTCOME_METHOD_NOTES = [
  `READ THE IDENTIFICATION ROWS FIRST. Subjects in covariate cells that are entirely one arm have no counterpart at ANY weight. The arithmetic below them succeeds regardless; the estimand does not exist for those subjects, and no weighting can create it`,
  `the score is estimated on the AT-RISK set this analysis defines, not on the whole cohort. Weights built in one population and applied in another describe neither`,
  `the weighted risk is the HAJEK ratio SUM(wY)/SUM(w), not the Horvitz-Thompson SUM(wY)/n. The two differ whenever the weights do not sum to n, which is almost always, and only the Hajek form is guaranteed to stay inside [0,1]`,
  `the variance is the SANDWICH form for that ratio, SUM(w^2 (Y-mu)^2)/(SUM w)^2. The naive p(1-p)/n_effective is the variance of a different estimator and is too small`,
  `it treats the WEIGHTS AS KNOWN, which is conservative: propagating the score's own estimation generally narrows the interval. The label says weights_treated_as_known rather than "robust", because "robust" would claim more than this computes`,
  `the UNADJUSTED contrast is reported beside the weighted one. Weighting is a claim that the crude number is wrong, and a reader cannot judge that claim without both`,
  `a Wald interval on a risk difference can leave [-1, 1], which a difference of two probabilities cannot. It is reported UNCLAMPED with a diagnostic row - clamping would hide the one signal saying the approximation has broken down`,
  `SAS-PRIMARY: nothing. Every number here is computed by both twins`,
];

export function iptwOutcomeParity(
  an: IptwOutcomeAnalysis,
  consumed: { referenceLevel: string; treatedLevel: string; cellAxes: string[]; settingFilter: string },
): IptwOutcomeParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    horizonDays: an.horizonDays,
    washout: { start: an.washout.start, end: an.washout.end, includesIndex: an.washout.includesIndex },
    settingFilter: consumed.settingFilter,
    referenceLevel: consumed.referenceLevel,
    treatedLevel: consumed.treatedLevel,
    cellAxes: consumed.cellAxes,
    estimand: an.estimand,
    stabilized: an.stabilized,
    trim: an.trim,
    scorePopulation: "at_risk_after_washout",
    estimator: "hajek_ratio",
    variance: "sandwich_weights_treated_as_known",
    sasPrimary: "none",
  };
}

/* ------------------------------------------------------------------ *
 *  Standardization (g-formula) / AIPW
 * ------------------------------------------------------------------ */

export interface GFormulaParity {
  id: string;
  codeListId: string;
  horizonDays: number;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  settingFilter: string;
  referenceLevel: string;
  treatedLevel: string;
  cellAxes: string[];
  outcomeModel: "saturated_cell_means";
  scoreModel: "saturated_cell_fraction";
  /** the population the estimates describe, which is NOT the cohort */
  population: "cells_with_both_arms";
  variance: "influence_function_with_covariance";
  sasPrimary: "none";
}

export function gFormulaLimitations(an: GFormulaAnalysis, listSystem: CodeSystem): string[] {
  const out: string[] = [];
  const note = outcomeSettingPlan(an.outcomeDefinition, listSystem).note;
  if (note) out.push(note);
  out.push(`the estimates describe the population in CELLS CONTAINING BOTH ARMS, not the cohort. That restriction is forced: a cell with one arm has no mean to standardize for the other, and there is no defensible value to put there. The support rows say how many subjects it drops`);
  out.push(`this is a DIFFERENT population from the one an IPTW outcome model reports on. Weighting carries single-arm subjects along at weight 1 and produces a number for a population that includes people with no comparison group; standardization cannot, so the two estimates can differ substantially on the same data and both be computed correctly`);
  out.push(`the outcome model is SATURATED over the cells - a mean per cell per arm. It cannot be misspecified in the usual sense, which is why "doubly robust" buys nothing extra here: both models are exactly right by construction, and AIPW reduces to the g-formula`);
  out.push(`the variance is the influence-function form and treats the cell means as estimated, but the CELL PROPORTIONS as fixed. That is standard and is a small understatement at these sample sizes`);
  out.push(`NO continuous covariate: standardization here is over cells, and a continuous covariate has none. It would need a fitted outcome model, which is a different estimator than the one this module implements and checks`);
  out.push(`the outcome is a BINARY indicator over a fixed horizon, with nobody censored - a subject who leaves the data early is counted event-free`);
  return out;
}

export const G_FORMULA_METHOD_NOTES = [
  `READ THE SUPPORT ROWS FIRST. The g-formula cannot be computed in a covariate cell holding only one arm: the missing arm's mean is an UNDEFINED TERM, not a small number. So these estimates describe the population in cells with both arms, which is narrower than the cohort`,
  `that restriction is the difference from an IPTW outcome model on the same data. Weighting does not exclude single-arm subjects - it carries them at weight 1 - so the two estimators can differ substantially and both be computed correctly. Report which population you mean`,
  `the outcome model is the SATURATED one: a mean per cell per arm, which is exactly what a fully interacted regression would fit. Both it and the score are exact by construction, which is why "doubly robust" buys nothing extra here`,
  `THE IDENTITY: with both models saturated over the same cells, the augmentation term cancels the weighting exactly and AIPW IS the g-formula. They are computed by different expressions - one over cells, one over subjects - and the module emits their difference as a checked row rather than assuming it`,
  `the interval uses the influence-function variance INCLUDING the covariance between arms. Every subject contributes to both influence functions, so treating the arms as independent would overstate it`,
  `a standard error of ZERO is a BOUNDARY, not precision: it means every subject in an arm had the same outcome, which at small samples is an accident. The module flags it rather than letting a zero be read as an exact estimate`,
  `SAS-PRIMARY: nothing`,
];

export function gFormulaParity(
  an: GFormulaAnalysis,
  consumed: { referenceLevel: string; treatedLevel: string; cellAxes: string[]; settingFilter: string },
): GFormulaParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    horizonDays: an.horizonDays,
    washout: { start: an.washout.start, end: an.washout.end, includesIndex: an.washout.includesIndex },
    settingFilter: consumed.settingFilter,
    referenceLevel: consumed.referenceLevel,
    treatedLevel: consumed.treatedLevel,
    cellAxes: consumed.cellAxes,
    outcomeModel: "saturated_cell_means",
    scoreModel: "saturated_cell_fraction",
    population: "cells_with_both_arms",
    variance: "influence_function_with_covariance",
    sasPrimary: "none",
  };
}

/* ------------------------------------------------------------------ *
 *  Adherence and persistence
 * ------------------------------------------------------------------ */

export interface AdherenceParity {
  id: string;
  drugCodeListId: string;
  windowStart: number;
  windowEnd: number;
  /** the DENOMINATOR. Both twins must divide by the same number of days, and an
   *  off-by-one here moves every PDC and MPR in the study by the same amount —
   *  which is exactly the kind of error that looks like a real finding. */
  windowDays: number;
  permissibleGapDays: number;
  adherenceThreshold: number;
  intervalEnd: "start_plus_supply_minus_one";
  merge: "running_max_islands";
  stockpiling: "closed_form_running_max";
  sasPrimary: "none";
  /* ---- FEEDER FACTS ------------------------------------------------------
   * Without these the stamp CANNOT catch the divergence that matters most
   * here. The SQL twin reads one long fills table and selects its drug with a
   * code_list_id predicate; the SAS twin reads a per-code-list event table and
   * so carries no predicate at all. Those are different contracts, and a stamp
   * that recorded only the method would be IDENTICAL across them — the parity
   * check would pass over two programs measuring different fills. Recording the
   * resolved source and the selection rule is what makes that visible. */
  /** How each twin narrows the feeder to the measured drug. ONE shared value,
   *  not a per-twin one: the stamp is compared for strict equality, so a value
   *  that legitimately differs by language would fail parity forever. Stating
   *  the asymmetry in a constant both twins emit at least puts it in front of a
   *  reader; the check that can actually FAIL is the emitted-text assertion in
   *  verify/run.ts verifyGoldF, which reads the source table out of each
   *  twin's own program. */
  fillSelection: "sql_filters_code_list_id__sas_reads_the_per_list_table";
  /** the grain both twins must agree on, stated so a change to either is loud */
  fillGrain: "distinct_enrolid_date_ndc_supply";
  dropMissingSupply: boolean;
  dropZeroNegativeSupply: boolean;
  maxDaysSupplyCap: number;
}

export function adherenceLimitations(an: AdherenceAnalysis): string[] {
  const out: string[] = [];
  out.push(`PDC and MPR are computed over a FIXED window for everyone. A patient who disenrolls partway through still gets the full window as a denominator, which understates their adherence. Restrict the cohort to members enrolled throughout, or read these beside the persistence rows`);
  out.push(`DAYS SUPPLY IS TAKEN AS DISPENSED. It is a pharmacy field, not an observation of consumption, and it is missing or implausible often enough in claims that a study should describe how it was cleaned. This program does not clean it`);
  out.push(`NO dose changes and NO partial adherence: a fill covers its days-supply completely or not at all`);
  out.push(`the STOCKPILING variant assumes a patient finishes the current supply before starting a new one. That is an assumption about behaviour, and the module reports how many patients it reclassifies rather than adopting it silently`);
  out.push(`persistence here is a fixed-window mean, and censored patients contribute the FULL window. With censoring present that is biased downward as an estimate of true persistence - the survival module on the same discontinuation event is the unbiased treatment`);
  out.push(`NO grace-period variant of persistence, and no restart/re-initiation after a gap: the FIRST qualifying gap ends the persistence episode`);
  if (an.permissibleGapDays < 15)
    out.push(`a permissible gap of ${an.permissibleGapDays} days is short relative to typical 30-day dispensings, so ordinary refill timing will register as discontinuation`);
  return out;
}

export const ADHERENCE_METHOD_NOTES = [
  `PDC counts DISTINCT DAYS COVERED; MPR counts DAYS DISPENSED. PDC <= MPR always, with equality exactly when no two fills overlap, so the difference between them measures early refilling directly`,
  `that relation is emitted as a CHECKED ROW. It is an identity about the interval merge, not a property of the population - a violation means the merge is broken, not that the patients are unusual`,
  `a fill's supply ends at start + days_supply - 1: a 30-day supply dispensed on day 0 covers days 0 through 29. The off-by-one is worth one day of PDC per fill and compounds across a year`,
  `overlapping fills are merged into islands by comparing each fill's start against the RUNNING MAXIMUM of all prior ends, never against the previous row's end - a fill nested inside an earlier one would otherwise open a spurious new island`,
  `STOCKPILING (assuming an early refill is started only when the current supply runs out) is computed alongside the plain measure. Its definition is sequential, but it reduces to a running max plus a running sum, so both twins compute it in closed form`,
  `stockpiling can move a patient across the adherence threshold on identical fills. The module reports how many patients it reclassifies, because that count is the honest measure of how much the conclusion depends on an assumption rather than on data`,
  `DISCONTINUATION IS AN EVENT; reaching the end of the window still covered is CENSORING. The two are reported separately, because merging them turns "still on treatment when we stopped looking" into "never stopped"`,
  `SAS-PRIMARY: nothing`,
];

export function adherenceParity(
  an: AdherenceAnalysis,
  consumed: { windowStart: number; windowEnd: number; windowDays: number },
): AdherenceParity {
  const clean = daysSupplyCleaningFor(an);
  return {
    id: an.id,
    drugCodeListId: an.drugCodeListId,
    windowStart: consumed.windowStart,
    windowEnd: consumed.windowEnd,
    windowDays: consumed.windowDays,
    permissibleGapDays: an.permissibleGapDays,
    adherenceThreshold: an.adherenceThreshold,
    intervalEnd: "start_plus_supply_minus_one",
    merge: "running_max_islands",
    stockpiling: "closed_form_running_max",
    sasPrimary: "none",
    fillSelection: "sql_filters_code_list_id__sas_reads_the_per_list_table",
    fillGrain: "distinct_enrolid_date_ndc_supply",
    dropMissingSupply: clean.dropMissing,
    dropZeroNegativeSupply: clean.dropZeroNegative,
    maxDaysSupplyCap: clean.maxDaysSupplyCap,
  };
}
