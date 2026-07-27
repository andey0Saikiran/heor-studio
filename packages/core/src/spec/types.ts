/**
 * HEOR Studio study specification — the single source of truth.
 *
 * The LLM's ONLY job is to produce this structure from a protocol/SAP.
 * All code (SAS, SQL) is generated deterministically from it by emitters.
 * The analyst reviews and edits THIS, never raw generated code.
 *
 * Conventions (per HEOR practice):
 *  - Baseline period always INCLUDES the index date and runs backward from it.
 *  - Follow-up period always EXCLUDES the index date and runs forward from it.
 *  - Windows are expressed in days relative to index date (negative = before).
 */

export type DatabaseId = "marketscan_ccae" | "marketscan_mdcr" | "marketscan_medicaid";

export type CodeSystem =
  | "icd9cm"
  | "icd10cm"
  | "cpt_hcpcs"   // procedure codes as found in PROC1..PROCn (CPT, HCPCS, ICD proc)
  | "ndc"
  | "drug_name";  // generic/brand name patterns resolved against Redbook-style lookups

export type CodeSource = "ai_suggested" | "vocabulary_lookup" | "user_entered" | "imported";

export interface CodeEntry {
  code: string;            // e.g. "L40.0" | "696.1" | NDC | name pattern "ADALIMUMAB|HUMIRA"
  description?: string;
  source: CodeSource;
  verified: boolean;       // analyst has signed off on this exact code
}

export interface CodeList {
  id: string;              // slug, e.g. "pso_dx"
  label: string;           // e.g. "Psoriasis diagnosis"
  system: CodeSystem;
  codes: CodeEntry[];
  notes?: string;
  /** Optional (V1): role in the study — lets P2-P4 causal work reference lists
   *  by purpose without a breaking migration. */
  role?: "outcome" | "exposure" | "comparator" | "covariate" | "negative_control" | "other";
  /** Optional free tag for the P3 line-of-therapy / switching family. */
  drugCategory?: string;
}

/** Where a clinical event may be looked for. */
export type CareSetting = "any" | "inpatient" | "outpatient" | "pharmacy";

/**
 * Time window relative to index date, in days.
 * start/end are inclusive day offsets; negative = before index.
 * "anytime" extends the bound to the observable data limit.
 */
export interface RelativeWindow {
  start: number | "anytime_before";
  end: number | "anytime_after";
  includesIndex: boolean;
}

export type CriterionKind = "inclusion" | "exclusion";

export interface Criterion {
  id: string;
  kind: CriterionKind;
  /** Verbatim text from the protocol/SAP — never lose the source language. */
  sourceText: string;
  /** What the criterion tests. */
  test:
    | { type: "diagnosis"; codeListId: string; minClaims: number; claimSeparationDays?: number; setting: CareSetting; window: RelativeWindow }
    | { type: "procedure"; codeListId: string; minClaims: number; setting: CareSetting; window: RelativeWindow }
    | { type: "drug"; codeListId: string; minClaims: number; window: RelativeWindow }
    | { type: "age_at_index"; min?: number; max?: number }
    | { type: "sex"; value: "M" | "F" }
    | { type: "continuous_enrollment"; baselineDays: number; followupDays: number; requiresRxCoverage: boolean }
    | { type: "unmapped" };   // extractor could not map — must be resolved by analyst
  /** Extractor's confidence; anything below "high" is flagged for review. */
  confidence: "high" | "medium" | "low";
  reviewed: boolean;
}

export interface IndexEventRule {
  /** What defines the index event. */
  type: "first_drug_claim" | "first_diagnosis" | "first_procedure";
  codeListId: string;
  /** Index date must fall inside this absolute period. */
  indexPeriod: { start: string; end: string };   // ISO dates
  description?: string;
}

export interface EnrollmentRule {
  baselineDays: number;        // continuous enrollment required before index (incl. index)
  followupDays: number;        // continuous enrollment required after index
  /** Merge adjacent enrollment segments separated by <= this many days (stitching). */
  gapAllowanceDays: number;
  requiresRxCoverage: boolean; // RX = '1' (CCAE/MDCR) / drugcovg (Medicaid)
}

export interface BaselineCharacteristic {
  id: string;
  label: string;
  kind: "age" | "sex" | "region" | "plan_type" | "year" | "comorbidity" | "medication" | "utilization";
  codeListId?: string;         // for comorbidity/medication kinds
  window?: RelativeWindow;     // default: the baseline period
  /** Optional (V1): drives Table 1 formatting, SMD, and covariate adjustment.
   *  Readiness WARNS (not blocks) when absent for a variable used as a covariate. */
  dataType?: "continuous" | "binary" | "count" | "categorical";
  /** Optional (V1): drives causal-model covariate sets in P2-P4. */
  role?: "confounder" | "descriptor" | "effect_modifier";
}

/* =========================================================================
 *  ANALYSIS LAYER (verified against adversarial review; primary-source cited).
 *  Every inferential analysis is SAS-PRIMARY: SQL emits only deterministic
 *  feeder aggregates (counts, person-time, means/SDs, cross-tabs, crude rates,
 *  Wald/Wilson/Byar closed-form CIs, closed-form SMD). Wilson-vs-exact,
 *  Poisson-exact, Fay-Feuer, Shapiro-Wilk, rank/Fisher tests, regression
 *  coefficients, and log-rank p-values require SAS PROCs.
 * ========================================================================= */

/** Common header on every analysis; rendered verbatim as the review-UI card. */
export interface AnalysisCommon {
  id: string;                 // stable snake_case slug, UNIQUE within analyses[]
  label: string;              // human title shown in the review UI
  enabled: boolean;
  notes?: string;             // verbatim protocol/SAP text — never paraphrase
}

/** How a clinical event is ascertained from claims. Ref: Modern Epidemiology 3e ch.3. */
export interface OutcomeDefinition {
  codeListId: string;         // -> CodeList.id (may be an empty list awaiting lookup)
  minClaims: number;          // >= 1 qualifying claims to count as a case
  claimSeparationDays?: number; // required when minClaims >= 2
  setting: CareSetting;
  diagnosisPosition: "any" | "primary"; // DX1/principal vs any DXn
}

export type CaseStatus = "incident" | "prevalent";

/** Denominator construction, pinned per measure. Ref: Modern Epi 3e ch.3. */
export type DenominatorRule =
  | "enrolled_midperiod" // point prevalence: enrolled & alive on the anchor date
  | "enrolled_anytime"   // period prevalence: enrolled anytime in the window
  | "at_risk_start"      // cumulative incidence (risk): event-free & at-risk at t0
  | "person_time";       // incidence density: sum of at-risk person-time

export type AnchorDate =
  | { kind: "fixed"; date: string } // ISO date, e.g. "2022-07-01"
  | { kind: "index" };              // each subject's own index date (day 0)

export type Recurrence = "first_only" | "all_events";

/** Person-time / at-risk clock. Enrollment gaps honored via EnrollmentRule. */
export interface PersonTimeRule {
  start: "index" | "enrollment_start" | "washout_end";
  censorAt: Array<"outcome" | "disenrollment" | "death" | "study_end" | "max_followup">;
  maxFollowupDays?: number;
}

/** Proportion CI. Wilson (SQL-native) default; Clopper-Pearson (SAS-only) exact.
 *  Ref: Wilson JASA 1927;22:209; Clopper-Pearson Biometrika 1934;26:404. */
export type ProportionCiMethod = "wilson" | "clopper_pearson" | "wald";

/** Rate CI. poisson_byar (SQL-native closed form) default; poisson_exact SAS-only.
 *  Ref: Ulm AJE 1990;131:373; Breslow-Day 1987. */
export type RateCiMethod = "poisson_byar" | "poisson_exact" | "wald_log";

export interface Stratifier {
  id: string;
  label: string;
  source:
    | { kind: "baseline"; baselineId: string }
    | { kind: "demographic"; axis: "age_band" | "sex" | "region" | "plan_type" | "year" };
  ageBandLowerBounds?: number[]; // inclusive lower bounds, e.g. [0,18,45,65,75]
}

/** Direct age-sex standardization.
 *  Ref: Modern Epi 3e ch.3; Fay & Feuer Stat Med 1997;16:791 (gamma CI). */
export interface StandardizationSpec {
  method: "direct";
  strataIds: string[];
  referencePopulation:
    | { kind: "named"; name: "us_2000_standard" | "who_world_2000" | "esp_2013" }
    | { kind: "custom"; weights: Array<{ cellKey: string; weight: number }> };
  ciMethod: "fay_feuer" | "dobson" | "normal_approx";
}

/** Calendar-trend test. Ref: Cochran Biometrics 1954;10:417; Armitage 1955;11:375. */
export interface TrendSpec {
  bucket: "calendar_year" | "calendar_quarter" | "calendar_month";
  method: "cochran_armitage" | "poisson_rate_trend" | "linear_slope";
  reportPerBucket: boolean;
}

/* ----- P1: descriptive epidemiology ----- */

export interface PointPrevalenceAnalysis extends AnalysisCommon {
  kind: "point_prevalence";
  outcomeDefinition: OutcomeDefinition;
  caseStatus: "prevalent";
  anchorDate: AnchorDate;
  denominatorRule: "enrolled_midperiod";
  ciMethod: ProportionCiMethod;
  stratifyBy: Stratifier[];
  referenceStratum?: string;
}

export interface PeriodPrevalenceAnalysis extends AnalysisCommon {
  kind: "period_prevalence";
  outcomeDefinition: OutcomeDefinition;
  caseStatus: "prevalent";
  prevalencePeriod: { start: string; end: string }; // ISO dates
  denominatorRule: "enrolled_anytime";
  ciMethod: ProportionCiMethod;
  stratifyBy: Stratifier[];
  referenceStratum?: string;
}

export interface CumulativeIncidenceAnalysis extends AnalysisCommon {
  kind: "cumulative_incidence";
  outcomeDefinition: OutcomeDefinition;
  caseStatus: "incident";
  /** Prevalent-case washout: an outcome anywhere in this pre-index window removes
   *  the subject so only INCIDENT (new-onset) events count. */
  washout: RelativeWindow;
  incidentWithRespectTo: "cohort_entry" | "first_ever";
  denominatorRule: "at_risk_start";
  horizonDays: number; // e.g. 365 for 1-year risk
  personTimeRule: PersonTimeRule;
  /** "ignore"/"censor" (1-KM) OVERESTIMATE risk when death is common;
   *  "aalen_johansen" is the competing-risk CIF (SAS-only, no SQL feeder). */
  competingRiskDeath: "ignore" | "censor" | "aalen_johansen";
  recurrence: "first_only";
  ciMethod: ProportionCiMethod;
  stratifyBy: Stratifier[];
  referenceStratum?: string;
}

export interface IncidenceRateAnalysis extends AnalysisCommon {
  kind: "incidence_rate";
  outcomeDefinition: OutcomeDefinition;
  caseStatus: "incident";
  washout: RelativeWindow;
  denominatorRule: "person_time";
  personTimeRule: PersonTimeRule;
  recurrence: Recurrence; // first_only = incidence density; all_events = recurrent-event rate
  rateMultiplier: number; // 1000 => per 1,000 PY
  ciMethod: RateCiMethod;
  stratifyBy: Stratifier[];
  referenceStratum?: string;
}

export interface StandardizationAnalysis extends AnalysisCommon {
  kind: "standardization";
  base: "incidence_rate" | "point_prevalence" | "period_prevalence";
  outcomeDefinition: OutcomeDefinition;
  personTimeRule?: PersonTimeRule; // required when base === "incidence_rate"
  rateMultiplier?: number;
  standardization: StandardizationSpec;
}

export interface CalendarTrendAnalysis extends AnalysisCommon {
  kind: "calendar_trend";
  base: "point_prevalence" | "period_prevalence" | "incidence_rate";
  outcomeDefinition: OutcomeDefinition;
  personTimeRule?: PersonTimeRule; // required when base === "incidence_rate"
  rateMultiplier?: number;
  denominatorRule: DenominatorRule;
  trend: TrendSpec;
  ciMethod: ProportionCiMethod | RateCiMethod;
  stratifyBy: Stratifier[];
}

/* ----- P1 engine: first-class StudySpec sibling entities (referenced by id) ----- */

/** Ref: Manning & Mullahy JHE 2001;20:461 (gamma-log for cost). */
export interface CostMeasurement {
  costField: "paytot" | "pay" | "net_pay" | "allowed";
  components: Array<"inpatient" | "outpatient" | "pharmacy" | "total">;
  inflationAdjustment?: { toYear: number; index: "cpi_medical" | "gdp_deflator" | "none" };
  annualize: boolean;
}

export interface OutcomeVariable {
  id: string;
  label: string;
  dataType:
    | "binary"        // -> chi-sq/Fisher; logistic (OR)
    | "count"         // -> Poisson/NB (rate ratio)
    | "continuous"    // -> t/Wilcoxon; OLS
    | "cost"          // -> gamma-log / two-part (DEFERRED to P2)
    | "time_to_event" // -> log-rank
    | "categorical";  // -> chi-sq
  codeListId?: string;
  outcomeDefinition?: OutcomeDefinition;
  ascertainmentWindow: RelativeWindow;
  personTimeRule?: PersonTimeRule; // required for time_to_event
  cost?: CostMeasurement;          // required for cost
}

export interface GroupVariable {
  id: string;
  label: string;
  source:
    | { kind: "exposure_cohort" }
    | { kind: "baseline"; baselineId: string }
    | { kind: "codelist"; codeListId: string; window: RelativeWindow };
  levels: string[];
  referenceLevel?: string;
}

export type ComparisonDesign =
  | "two_group_independent"
  | "multi_group_independent"
  | "paired"
  | "survival_logrank";

/** Distribution diagnostics forking parametric vs non-parametric.
 *  Ref: Shapiro & Wilk 1965; Levene 1960; Cameron & Trivedi 1990; Welch 1947. */
export interface DistributionPolicy {
  normalityTest: "shapiro_wilk" | "anderson_darling" | "assume_normal";
  dispersionTest: "deviance_ratio" | "cameron_trivedi" | "none";
  varianceTest: "levene" | "assume_unequal";
  allowNonparametricFallback: boolean;
}

export type ReportStat =
  | "mean_difference" | "median_difference" | "risk_difference"
  | "risk_ratio" | "odds_ratio" | "rate_ratio"
  | "hazard_ratio_logrank" | "smd";

export type RegressionFamily =
  | "logistic"          // binary — logit — OR
  | "poisson"           // count — log link — offset=log PT — rate ratio
  | "negative_binomial" // overdispersed count — Ref: Hilbe NB Regression 2e (2011)
  | "gamma_log"         // cost — log-link GLM — Ref: Manning & Mullahy 2001
  | "ols";              // continuous — identity

export interface RegressionSpec {
  family: RegressionFamily;
  offsetVar?: "log_person_time"; // required for poisson/negative_binomial
  overdispersionPolicy: "test_then_nb" | "force_nb" | "force_poisson" | "quasi_poisson" | "none";
  robustSe: boolean;
  twoPart?: boolean;
  covariateIds: string[]; // -> BaselineCharacteristic.id
}

export interface Comparison {
  id: string;
  dependentOutcomeId: string; // -> OutcomeVariable.id
  independentVarId: string;   // -> GroupVariable.id
  design: ComparisonDesign;
  adjusted: boolean;
  covariateIds: string[];     // -> BaselineCharacteristic.id (used when adjusted)
  role: "primary" | "secondary" | "exploratory" | "descriptive_only";
  distributionPolicy: DistributionPolicy;
  reportStat: ReportStat;
  regression?: RegressionSpec; // required when adjusted === true
}

/** SMD balance. Denominator = sqrt of AVERAGE of the two group variances (NOT
 *  n-weighted pooled) — for denominator stability under weighting/matching.
 *  Ref: Austin Stat Med 2009;28:3083; Yang & Dalton SGF 2012 Paper 335-2012. */
export interface SmdBalanceConfig {
  groupVarId: string;
  covariateIds: string[];
  imbalanceThreshold: number; // convention |SMD| > 0.1
  reportWeighted: boolean;    // activated in P2 PS/IPTW
}

/** Ref: Holm Scand J Stat 1979;6:65; Benjamini & Hochberg JRSS-B 1995;57:289. */
export interface MultiplicityGovernance {
  method: "none" | "bonferroni" | "holm" | "benjamini_hochberg";
  alpha: number; // two-sided, in (0,1)
  appliesToRoles: Array<"primary" | "secondary" | "exploratory">;
}

/** Governance wrapper: references top-level comparisons[] by id. */
export interface StatisticalEngineAnalysis extends AnalysisCommon {
  kind: "statistical_engine";
  comparisonIds: string[];   // -> StudySpec.comparisons[].id
  smdBalance?: SmdBalanceConfig;
  multiplicity: MultiplicityGovernance;
}

/* ----- cohort-spine deliverables (already emitted) ----- */

export interface AttritionAnalysis extends AnalysisCommon { kind: "attrition"; }
export interface Table1Analysis extends AnalysisCommon {
  kind: "table1";
  includeBaselineIds?: string[]; // omitted/empty => all baseline characteristics
  stratifyByGroupVarId?: string; // -> GroupVariable.id (e.g. treatment arm)
}

/* ----- P2-P4 extension point ----- */

export type FutureAnalysisKind =
  | "hcru" | "cost" | "adherence" | "line_of_therapy" | "treatment_switching"
  | "ps_matching" | "iptw" | "km_survival" | "cox_model" | "competing_risks";

export interface FutureAnalysisStub extends AnalysisCommon {
  kind: "future_stub";
  plannedKind: FutureAnalysisKind;
  params?: Record<string, unknown>; // NOT emitted until the concrete schema lands
}

/* ----- the union ----- */

export type Analysis =
  | AttritionAnalysis
  | Table1Analysis
  | PointPrevalenceAnalysis
  | PeriodPrevalenceAnalysis
  | CumulativeIncidenceAnalysis
  | IncidenceRateAnalysis
  | StandardizationAnalysis
  | CalendarTrendAnalysis
  | StatisticalEngineAnalysis
  | FutureAnalysisStub;

export type AnalysisKind = Analysis["kind"];

/** Analysis kinds the emitters can actually generate code for TODAY: the
 *  cohort-spine pair (attrition, table1) plus every kind registered in
 *  emitters/modules/registry.ts. Readiness BLOCKS any enabled analysis whose
 *  kind is not listed here — otherwise it would be silently omitted from the
 *  bundle while the export banner said "ready (no open problems)".
 *  registry.ts asserts at load time that it and this list agree, so the gate
 *  and the emitters cannot drift apart. */
export const EMITTABLE_ANALYSIS_KINDS: ReadonlySet<AnalysisKind> = new Set<AnalysisKind>([
  "attrition",
  "table1",
  "incidence_rate",
  "point_prevalence",
  "period_prevalence",
  "cumulative_incidence",
]);

export type DescriptiveAnalysis =
  | PointPrevalenceAnalysis
  | PeriodPrevalenceAnalysis
  | CumulativeIncidenceAnalysis
  | IncidenceRateAnalysis
  | StandardizationAnalysis
  | CalendarTrendAnalysis;

/* ----- backward-compat + migration (the extractor still emits the legacy 7 names) ----- */

export type LegacyAnalysisType =
  | "attrition" | "table1" | "treatment_patterns" | "incidence_prevalence"
  | "hcru_cost" | "km_survival" | "cox_model";

export interface LegacyAnalysisRequest { type: LegacyAnalysisType; enabled: boolean; notes?: string; }

/** Up-migration: concrete homes get a SHELL with empty codeListId ("") so
 *  readiness FORCES the analyst to parameterize — never a fabricated default.
 *  Ambiguous / P2-P4 requests become a FutureAnalysisStub; notes preserved. */
export function migrateLegacyAnalyses(old: LegacyAnalysisRequest[]): Analysis[] {
  const shellOutcome: OutcomeDefinition = { codeListId: "", minClaims: 1, setting: "any", diagnosisPosition: "any" };
  return old.map((r, i): Analysis => {
    const base = { id: `legacy_${r.type}_${i}`, label: r.type, enabled: r.enabled, notes: r.notes };
    switch (r.type) {
      case "attrition": return { ...base, kind: "attrition" };
      case "table1": return { ...base, kind: "table1" };
      case "incidence_prevalence":
        return { ...base, kind: "period_prevalence", outcomeDefinition: shellOutcome, caseStatus: "prevalent",
                 prevalencePeriod: { start: "", end: "" }, denominatorRule: "enrolled_anytime", ciMethod: "wilson", stratifyBy: [] };
      case "treatment_patterns": return { ...base, kind: "future_stub", plannedKind: "treatment_switching" };
      case "hcru_cost": return { ...base, kind: "future_stub", plannedKind: "cost" };
      case "km_survival": return { ...base, kind: "future_stub", plannedKind: "km_survival" };
      case "cox_model": return { ...base, kind: "future_stub", plannedKind: "cox_model" };
    }
  });
}

/** Small-cell suppression policy (BR-DEL-004).
 *
 *  The "suppress below 11" rule is a CMS Data Use Agreement requirement; no
 *  equivalent published Merative threshold exists for MarketScan, where the
 *  constraint is contractual and journal-driven. So the threshold is a study
 *  CHOICE, and every released table states which rule was applied. */
export interface SuppressionSpec {
  /** default true — suppression must be opted OUT of, never into */
  enabled?: boolean;
  /** cells with 1..threshold-1 patients are masked (default 11) */
  threshold?: number;
  /** footnote text; defaults to a description of the threshold actually used */
  ruleLabel?: string;
}

export interface StudySpec {
  meta: {
    title: string;
    version: string;             // spec version, bump on every edit
    database: DatabaseId;
    studyPeriod: { start: string; end: string };  // ISO dates, absolute claim window
    description?: string;
    /** Days per person-year for rate/person-year/CI arithmetic. The analyst's
     *  methodological choice — default 365.25 (mean Gregorian year, internally
     *  consistent); some shops use 365 (e.g. a common AE-rate convention AE-rate convention).
     *  It changes reported rates, so it lives in the spec for reproducibility. */
    daysPerYear?: number;
    /** Provenance: how this spec was produced. */
    provenance: {
      method: "llm_extraction" | "manual";
      model?: string;            // e.g. "claude-sonnet-5"
      extractedAt?: string;      // ISO timestamp
      sourceDocumentName?: string;
    };
  };
  codeLists: CodeList[];
  indexEvent: IndexEventRule;
  enrollment: EnrollmentRule;
  criteria: Criterion[];         // ordered — attrition applies them in sequence
  baseline: BaselineCharacteristic[];
  /** Engine dependent-variable catalog (referenced by comparisons[] by id). */
  outcomes: OutcomeVariable[];
  /** Engine grouping/exposure catalog. */
  groupVars: GroupVariable[];
  /** Engine comparison definitions (reference outcomes/groupVars by id). */
  comparisons: Comparison[];
  /** The analysis request list; references the catalogs above by id. */
  analyses: Analysis[];
  /** Small-cell suppression policy for released tables (BR-DEL-004). Omitted
   *  means ON at the default threshold — a disclosure control that has to be
   *  switched on is one that gets forgotten. */
  suppression?: SuppressionSpec;
}

/* ---------- helpers ---------- */

export function findCodeList(spec: StudySpec, id: string): CodeList | undefined {
  return spec.codeLists.find((c) => c.id === id);
}

export function unverifiedCodeCount(spec: StudySpec): number {
  return spec.codeLists.reduce(
    (n, cl) => n + cl.codes.filter((c) => !c.verified).length,
    0
  );
}

export function unreviewedCriteria(spec: StudySpec): Criterion[] {
  return spec.criteria.filter((c) => !c.reviewed || c.test.type === "unmapped");
}

/** A spec is "emit-ready" when every criterion is reviewed and mapped. */
export function specReadiness(spec: StudySpec): { ready: boolean; problems: string[] } {
  const problems: string[] = [];
  const unrev = unreviewedCriteria(spec);
  if (unrev.length > 0)
    problems.push(`${unrev.length} criteria not yet reviewed/mapped`);
  const uncode = unverifiedCodeCount(spec);
  if (uncode > 0) problems.push(`${uncode} codes not yet verified`);
  for (const c of spec.criteria) {
    const t = c.test as { codeListId?: string; type: string };
    if (t.codeListId && !findCodeList(spec, t.codeListId))
      problems.push(`Criterion "${c.id}" references missing code list "${t.codeListId}"`);
  }
  if (!findCodeList(spec, spec.indexEvent.codeListId))
    problems.push(`Index event references missing code list "${spec.indexEvent.codeListId}"`);
  problems.push(...validateAnalyses(spec));
  return { ready: problems.length === 0, problems };
}

/* ---------- analysis-layer validation (closes the emit-gate hole) ---------- */

export function findBaseline(spec: StudySpec, id: string): BaselineCharacteristic | undefined {
  return spec.baseline.find((b) => b.id === id);
}

function familyMatchesDataType(f: RegressionFamily, dt: OutcomeVariable["dataType"]): boolean {
  switch (f) {
    case "logistic": return dt === "binary";
    case "poisson":
    case "negative_binomial": return dt === "count";
    case "gamma_log": return dt === "cost";
    case "ols": return dt === "continuous";
  }
}

/** Walks analyses[]/outcomes[]/groupVars[]/comparisons[] for dangling references,
 *  parameter gaps, and family/data-type mismatches. Disabled analyses are skipped
 *  (recorded but non-blocking). */
export function validateAnalyses(spec: StudySpec): string[] {
  const problems: string[] = [];
  const outcomes = spec.outcomes ?? [];
  const groupVars = spec.groupVars ?? [];
  const comparisons = spec.comparisons ?? [];
  const outIds = new Set(outcomes.map((o) => o.id));
  const groupIds = new Set(groupVars.map((g) => g.id));
  const compIds = new Set(comparisons.map((c) => c.id));

  const requireCodeList = (cid: string, where: string) => {
    if (!cid) problems.push(`${where}: code list not yet chosen (empty codeListId).`);
    else if (!findCodeList(spec, cid)) problems.push(`${where}: references missing code list "${cid}".`);
  };
  const requireBaseline = (bid: string, where: string) => {
    if (!findBaseline(spec, bid)) problems.push(`${where}: references missing baseline characteristic "${bid}".`);
  };
  const checkStratifiers = (strat: Stratifier[], where: string) => {
    const ids = new Set<string>();
    for (const s of strat) {
      if (ids.has(s.id)) problems.push(`${where}: duplicate stratifier id "${s.id}".`);
      ids.add(s.id);
      if (s.source.kind === "baseline") requireBaseline(s.source.baselineId, `${where} stratifier "${s.id}"`);
    }
    return ids;
  };

  const seenOut = new Set<string>();
  for (const o of outcomes) {
    if (seenOut.has(o.id)) problems.push(`Duplicate outcome id "${o.id}".`);
    seenOut.add(o.id);
    if (o.codeListId) requireCodeList(o.codeListId, `Outcome "${o.id}"`);
    if (o.outcomeDefinition) requireCodeList(o.outcomeDefinition.codeListId, `Outcome "${o.id}"`);
    if (o.dataType === "time_to_event" && !o.personTimeRule) problems.push(`Outcome "${o.id}": time_to_event requires personTimeRule.`);
    if (o.dataType === "cost" && !o.cost) problems.push(`Outcome "${o.id}": cost outcome requires cost measurement params.`);
  }
  const seenG = new Set<string>();
  for (const g of groupVars) {
    if (seenG.has(g.id)) problems.push(`Duplicate group variable id "${g.id}".`);
    seenG.add(g.id);
    if (g.source.kind === "baseline") requireBaseline(g.source.baselineId, `Group "${g.id}"`);
    if (g.source.kind === "codelist") requireCodeList(g.source.codeListId, `Group "${g.id}"`);
    if (g.levels.length < 2) problems.push(`Group "${g.id}": needs >= 2 levels.`);
    if (g.referenceLevel && !g.levels.includes(g.referenceLevel)) problems.push(`Group "${g.id}": referenceLevel not in levels[].`);
  }
  const seenC = new Set<string>();
  for (const c of comparisons) {
    if (seenC.has(c.id)) problems.push(`Duplicate comparison id "${c.id}".`);
    seenC.add(c.id);
    const cw = `Comparison "${c.id}"`;
    if (!outIds.has(c.dependentOutcomeId)) problems.push(`${cw}: dependentOutcomeId "${c.dependentOutcomeId}" not in outcomes[].`);
    if (!groupIds.has(c.independentVarId)) problems.push(`${cw}: independentVarId "${c.independentVarId}" not in groupVars[].`);
    c.covariateIds.forEach((b) => requireBaseline(b, cw));
    const out = outcomes.find((o) => o.id === c.dependentOutcomeId);
    if (c.design === "survival_logrank" && out && out.dataType !== "time_to_event") problems.push(`${cw}: survival_logrank requires a time_to_event outcome.`);
    if (c.adjusted) {
      if (!c.regression) problems.push(`${cw}: adjusted comparison requires a regression spec.`);
      else {
        c.regression.covariateIds.forEach((b) => requireBaseline(b, `${cw} regression`));
        if (out && !familyMatchesDataType(c.regression.family, out.dataType)) problems.push(`${cw}: regression family "${c.regression.family}" does not match outcome dataType "${out.dataType}".`);
        if ((c.regression.family === "poisson" || c.regression.family === "negative_binomial") && c.regression.offsetVar !== "log_person_time") problems.push(`${cw}: rate model should set offsetVar "log_person_time".`);
      }
    }
  }

  const seenIds = new Set<string>();
  for (const a of spec.analyses) {
    if (seenIds.has(a.id)) problems.push(`Duplicate analysis id "${a.id}".`);
    seenIds.add(a.id);
    if (!a.enabled) continue;
    const w = `Analysis "${a.id}" (${a.kind})`;
    // HARD GATE: an enabled analysis with no registered emitter must BLOCK
    // readiness — the alternative is a bundle that silently omits it while
    // reporting "ready (no open problems)". future_stub carries its own
    // message in the switch below.
    if (a.kind !== "future_stub" && !EMITTABLE_ANALYSIS_KINDS.has(a.kind)) {
      problems.push(
        `${w}: no code generator is registered for "${a.kind}" yet — an export would silently omit it. ` +
          `Set enabled:false to keep it visible as planned work, or remove it.`
      );
    }
    switch (a.kind) {
      case "attrition": break;
      case "table1":
        (a.includeBaselineIds ?? []).forEach((b) => requireBaseline(b, w));
        if (a.stratifyByGroupVarId && !groupIds.has(a.stratifyByGroupVarId)) problems.push(`${w}: stratifyByGroupVarId not in groupVars[].`);
        break;
      case "point_prevalence":
      case "period_prevalence":
      case "cumulative_incidence":
      case "incidence_rate": {
        requireCodeList(a.outcomeDefinition.codeListId, `${w} outcome`);
        if (a.outcomeDefinition.minClaims < 1) problems.push(`${w}: minClaims must be >= 1.`);
        if (a.outcomeDefinition.minClaims >= 2 && a.outcomeDefinition.claimSeparationDays == null) problems.push(`${w}: minClaims>=2 requires claimSeparationDays.`);
        const ids = checkStratifiers(a.stratifyBy, w);
        if ("referenceStratum" in a && a.referenceStratum && !ids.has(a.referenceStratum)) problems.push(`${w}: referenceStratum "${a.referenceStratum}" is not one of stratifyBy[].`);
        if (a.kind === "period_prevalence" && (!a.prevalencePeriod.start || !a.prevalencePeriod.end)) problems.push(`${w}: prevalencePeriod start/end not set.`);
        if (a.kind === "cumulative_incidence" && a.horizonDays <= 0) problems.push(`${w}: horizonDays must be > 0.`);
        if (a.kind === "incidence_rate" && a.rateMultiplier <= 0) problems.push(`${w}: rateMultiplier must be > 0.`);
        break;
      }
      case "standardization": {
        requireCodeList(a.outcomeDefinition.codeListId, `${w} outcome`);
        if (a.base === "incidence_rate" && !a.personTimeRule) problems.push(`${w}: rate standardization requires personTimeRule.`);
        if (a.standardization.strataIds.length === 0) problems.push(`${w}: standardization needs at least one stratum.`);
        if (a.standardization.referencePopulation.kind === "custom") {
          const sum = a.standardization.referencePopulation.weights.reduce((n, x) => n + x.weight, 0);
          if (sum <= 0) problems.push(`${w}: custom standard-population weights must sum > 0.`);
        }
        break;
      }
      case "calendar_trend": {
        requireCodeList(a.outcomeDefinition.codeListId, `${w} outcome`);
        if (a.base === "incidence_rate" && !a.personTimeRule) problems.push(`${w}: rate trend requires personTimeRule.`);
        checkStratifiers(a.stratifyBy, w);
        break;
      }
      case "statistical_engine": {
        for (const cid of a.comparisonIds) if (!compIds.has(cid)) problems.push(`${w}: comparisonId "${cid}" not in comparisons[].`);
        if (a.smdBalance) {
          if (!groupIds.has(a.smdBalance.groupVarId)) problems.push(`${w} smdBalance: groupVarId not in groupVars[].`);
          a.smdBalance.covariateIds.forEach((b) => requireBaseline(b, `${w} smdBalance`));
        }
        if (a.multiplicity.alpha <= 0 || a.multiplicity.alpha >= 1) problems.push(`${w}: multiplicity alpha must be in (0,1).`);
        break;
      }
      case "future_stub":
        problems.push(`${w}: planned "${a.plannedKind}" analysis is a P2-P4 stub and cannot be emitted yet.`);
        break;
    }
  }
  return problems;
}
