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
  kind: "age" | "sex" | "region" | "plan_type" | "year" | "comorbidity" | "medication" | "utilization" | "comorbidity_index";
  codeListId?: string;         // for comorbidity/medication kinds
  /** for kind "comorbidity_index": the ComorbidityIndexAnalysis whose score this
   *  characteristic reports. Referenced by id rather than redefined, so the
   *  index has ONE definition in the spec and Table 1, the balance table and the
   *  index analysis itself cannot disagree about what it is. */
  comorbidityIndexAnalysisId?: string;
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
    | { kind: "named"; name: "us_2000" | "who_world" | "esp_2013" }
    | { kind: "custom"; weights: Array<{ cellKey: string; weight: number }> };
  ciMethod: "fay_feuer" | "dobson" | "normal_approx";
  /** Age bands used for STANDARDIZATION ONLY, independent of the bands the
   *  study reports elsewhere.
   *
   *  Direct standardization is only defined when each band is a union of whole
   *  reference bands — a boundary falling inside a reference band would need an
   *  assumed within-band age distribution, which is an invented number. But a
   *  study's own reporting bands are chosen for clinical meaning and routinely
   *  do NOT align: the default banding here puts a boundary at 18, which cuts
   *  US 2000's 15-24 band in half.
   *
   *  Rather than force the study to re-band everything it reports, this field
   *  carries the aligned bands used for the standardized rate alone. The study
   *  keeps its own bands in every other table; only the DSR is computed on
   *  these. Omitted = use the analysis's reporting bands, which are then
   *  checked for alignment and REFUSED if they do not align. */
  standardizationBands?: number[];
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

/* ----- Resource use and cost (claim-line ledger) ----- */

/** The four encounter classes the ledger recognizes. `ed` is carved out of
 *  outpatient by place of service — MarketScan has no ED table. */
export type LedgerSetting = "inpatient" | "ed" | "outpatient" | "pharmacy";

/**
 * Healthcare resource use and cost over a window relative to index.
 *
 * Counts and payments come from the SAME encounter ledger, which is why they
 * are one analysis rather than two: an encounter count and a cost total that
 * disagree about what an encounter IS are worse than either alone.
 *
 * Ref: Manning & Mullahy JHE 2001;20:461 (cost distributions); Hanley et al.
 * on the classic inpatient double-count (admission totals and service lines are
 * not additive).
 */
export interface ResourceUseAnalysis extends AnalysisCommon {
  kind: "resource_use";
  /** window relative to index, INCLUSIVE of both endpoints (so a 365-day
   *  follow-up is {start: 0, end: 364}) */
  ascertainmentWindow: RelativeWindow;
  settings: LedgerSetting[];
  /** payment column treated as "cost" — MarketScan carries several */
  costField: "paytot" | "netpay";
  /** also emit a combined row across the chosen settings */
  includeCombined: boolean;
  /** place-of-service codes classified as an emergency department
   *  (default ["23"], the standard ED POS) */
  edPlaceOfService?: string[];
}

/* ----- Survival / time-to-event ----- */

/**
 * WHAT the event is.
 *
 * A discriminated union rather than a string, because one of these arms is
 * REFUSED and a refusal that keys on a typed field cannot be evaded by
 * rephrasing the analysis label. See specReadiness's "survival" case for the
 * mortality argument in full.
 */
export type SurvivalEndpoint =
  | { kind: "claims_event"; outcomeDefinition: OutcomeDefinition }
  | { kind: "death"; source: "dstatus" | "ssa_master_file" | "linked_registry" };

/** Survival-curve interval.
 *  `log_log` transforms to ln(-ln S), so its limits are inside [0,1] by
 *  construction; `linear` is Greenwood on the raw scale and needs clamping.
 *  Both are closed form, so unlike a p-value both are executable.
 *  Ref: Kalbfleisch & Prentice 2e (2002) §1.4; Greenwood 1926. */
export type SurvivalCiMethod = "log_log" | "linear";

/**
 * Kaplan-Meier survival, optionally with a two-group log-rank test.
 *
 * Almost all of this is executable, which makes it unusual here: the
 * product-limit estimator, Greenwood's variance, both interval forms, the
 * median and the log-rank statistic itself are ALL closed form. Only the
 * chi-square tail probability is not, so only the p-value is SAS-primary — a
 * much smaller carve-out than the regression family needs.
 *
 * Ref: Kaplan & Meier JASA 1958;53:457; Mantel Cancer Chemother Rep 1966;50:163;
 * Peto & Peto JRSS-A 1972;135:185.
 */
export interface SurvivalAnalysis extends AnalysisCommon {
  kind: "survival";
  endpoint: SurvivalEndpoint;
  /** prevalent-case washout, so the curve starts from a genuinely at-risk cohort */
  washout: RelativeWindow;
  /** the clock. MUST censor at "outcome" — see readiness. */
  personTimeRule: PersonTimeRule;
  /** day marks at which S(t) is reported, ascending */
  horizonDays: number[];
  ciMethod: SurvivalCiMethod;
  /** two-level exposure compared with the log-rank test; omitted = one curve */
  groupVarId?: string;
  /** emit the per-event-time life table. It is the most disclosive table this
   *  project produces — most of its rows have n_event = 1, which is one
   *  patient's event date — so it exists behind an explicit opt-in. */
  emitLifeTable: boolean;
}

/**
 * THE MORTALITY REFUSAL, written once and used by every time-to-event kind.
 *
 * It lives here rather than inline in one readiness case because the argument is
 * about the DATA, not about any particular analysis: the moment a second kind
 * accepted a `death` endpoint, a refusal copied into one switch arm and not the
 * other would be a gate with a hole in it. Survival and Cox both read this.
 */
export const MORTALITY_REFUSAL =
  `overall survival is REFUSED, not approximated. MarketScan's only native death signal is DSTATUS, which records IN-HOSPITAL death only and is masked from data year 2016 — so this analysis would silently become "time to in-hospital death before 2016, with every other death censored". Censoring by death is exactly the informative censoring Kaplan-Meier and Cox both assume away, and it biases survival UPWARD. Use a claims_event endpoint (an observable diagnosis or procedure), or bring linked mortality data and a design that states its ascertainment.`;

/** The outcome definition a time-to-event endpoint carries, or null for the
 *  refused mortality endpoint. Callers that reach the emitters never see null:
 *  readiness blocks the death arm before any code is generated. */
export function survivalOutcome(an: { endpoint: SurvivalEndpoint }): OutcomeDefinition | null {
  return an.endpoint.kind === "claims_event" ? an.endpoint.outcomeDefinition : null;
}

/** One competing cause: an event that makes the event of interest impossible.
 *  It carries its own ascertainment, because "died of something else" and "had
 *  the outcome" are read from different code lists. */
export interface CompetingEvent {
  id: string;
  label: string;
  outcomeDefinition: OutcomeDefinition;
}

/**
 * Cumulative incidence with competing risks (Aalen-Johansen).
 *
 * Kaplan-Meier treats a competing event as censoring, which asserts that the
 * subject who died of something else would have gone on to have the event of
 * interest at the same rate as everyone still at risk. They cannot have it at
 * all, so 1 - KM OVERSTATES the probability — always, and by more as the
 * competing risk grows.
 *
 * Everything here is closed form and both twins compute it, including the
 * delta-method variance. See emitters/cif-core.ts for what makes it checkable:
 * the causes partition, so SUM_k CIF_k(t) = 1 - S_allcause(t) exactly.
 *
 * Ref: Aalen & Johansen Scand J Statist 1978;5:141; Klein & Moeschberger 2e
 * §4.9; Andersen et al. Int J Epidemiol 2012;41:861.
 */
export interface CompetingRisksAnalysis extends AnalysisCommon {
  kind: "competing_risks";
  /** the event of interest */
  endpoint: SurvivalEndpoint;
  /** at least one competing cause — otherwise this is just cumulative incidence */
  competingEvents: CompetingEvent[];
  washout: RelativeWindow;
  personTimeRule: PersonTimeRule;
  horizonDays: number[];
  /** emit the naive 1 - KM beside the CIF, and their difference. Default on:
   *  the bias is the reason the analysis exists, and a reader who cannot see
   *  it has to take the estimator on faith. */
  emitNaiveComparison: boolean;
  emitLifeTable: boolean;
}

/**
 * Propensity-score adjustment.
 *
 * The score is a fitted logistic probability, so by the rule this project
 * settled on in Wave 6.4 the coefficients would be SAS-primary. But unlike Cox,
 * everything downstream DEPENDS on the score — carve it out and the SQL twin is
 * empty. The SATURATED design resolves it: with only categorical covariates the
 * maximum-likelihood fitted probability in each cell IS the observed treated
 * fraction, so the score is closed form and the whole pipeline executes. See
 * emitters/ps-core.ts.
 *
 * `method` is where the refusals live — nearest-neighbour matching is
 * order-dependent and cannot be byte-stable, which is a property of the
 * algorithm and not of this implementation.
 *
 * Ref: Rosenbaum & Rubin Biometrika 1983;70:41; Austin & Stuart Stat Med
 * 2015;34:3661.
 */
export interface PropensityScoreAnalysis extends AnalysisCommon {
  kind: "propensity_score";
  groupVarId: string;
  /** the PS model's covariates. Must ALL be categorical — see readiness. */
  psCovariateIds: string[];
  /** what balance is reported on; may include continuous covariates */
  balanceCovariateIds: string[];
  method: "iptw" | "stratification" | "nearest_neighbour" | "optimal";
  estimand: "ate" | "att";
  stabilized: boolean;
  /** symmetric trim on the score, e.g. 0.05 keeps [0.05, 0.95]. 0 = none. */
  trim: number;
}

/**
 * An OUTCOME model on the inverse-probability-weighted pseudo-population.
 *
 * The propensity module produces weights and balance; this one produces the
 * effect estimate. It is a separate analysis rather than an option on that one
 * because the two answer different questions and fail differently: a beautifully
 * balanced weighted sample can still be a population in which the effect is not
 * identified, and that is exactly the case this module is built to surface.
 *
 * Everything is closed form — the Hajek weighted risk and its sandwich variance
 * (emitters/ps-core.ts) — so nothing is deferred to SAS.
 *
 * Ref: Hajek (1971); Lunceford & Davidian Stat Med 2004;23:2937 (the sandwich,
 * and why treating the weights as known is conservative).
 */
export interface IptwOutcomeAnalysis extends AnalysisCommon {
  kind: "iptw_outcome";
  groupVarId: string;
  /** the score's covariates. Must ALL be categorical — same gate as propensity_score. */
  psCovariateIds: string[];
  estimand: "ate" | "att";
  stabilized: boolean;
  trim: number;
  /** the outcome, ascertained on the at-risk set the washout defines */
  outcomeDefinition: OutcomeDefinition;
  washout: RelativeWindow;
  horizonDays: number;
  /** augmented / doubly-robust estimation — refused, with the reason */
  doublyRobust: boolean;
}

/**
 * Standardization (g-formula) and the doubly-robust AIPW estimator.
 *
 * Both models saturated over the same categorical cells, so both are closed
 * form — and under double saturation AIPW is algebraically IDENTICAL to the
 * g-formula, which the module checks rather than assumes.
 *
 * The distinguishing property, and the reason this exists beside iptw_outcome:
 * the g-formula CANNOT be computed in a cell holding one arm. That is an
 * undefined term, not a small number, so the estimator is forced to restrict
 * itself to where the contrast exists and to say how many people that drops —
 * where weighting silently carries them along.
 *
 * Ref: Robins Math Modelling 1986;7:1393; Robins, Rotnitzky & Zhao JASA
 * 1994;89:846; Hernan & Robins, Causal Inference (2020) ch.13.
 */
export interface GFormulaAnalysis extends AnalysisCommon {
  kind: "g_formula";
  groupVarId: string;
  /** cell axes. Must ALL be categorical — same gate as the other causal kinds. */
  covariateIds: string[];
  outcomeDefinition: OutcomeDefinition;
  washout: RelativeWindow;
  horizonDays: number;
}

/**
 * Adherence and persistence to a dispensed drug.
 *
 * Everything is arithmetic on drug-supply intervals (emitters/interval-core.ts),
 * so nothing is deferred to SAS. The measures deliberately come in pairs whose
 * DIFFERENCE is the finding:
 *
 *   - PDC counts distinct days covered; MPR counts days dispensed. PDC <= MPR
 *     always, with equality exactly when no fill overlaps another.
 *   - PDC with and without STOCKPILING (the assumption that an early refill is
 *     started only after the current supply runs out) can land on opposite sides
 *     of the conventional 0.8 threshold on the same fills.
 *   - Persistence separates "stopped" from "kept taking it irregularly", which
 *     the adherence measures cannot.
 *
 * Ref: Andrade et al. Pharmacoepidemiol Drug Saf 2006;15:565; Canfield et al.
 * J Manag Care Spec Pharm 2019;25:1073.
 */
export interface AdherenceAnalysis extends AnalysisCommon {
  kind: "adherence";
  /** the drug whose fills are measured */
  drugCodeListId: string;
  /** measurement window relative to index, INCLUSIVE both ends */
  window: RelativeWindow;
  /** a gap of at least this many uncovered days counts as discontinuation */
  permissibleGapDays: number;
  /** PDC cut-point for "adherent". 0.8 is conventional, not a fact. */
  adherenceThreshold: number;
  /** how implausible DAYSUPP values are handled. Omitted = DEFAULT_DAYS_SUPPLY_CLEANING. */
  daysSupplyCleaning?: DaysSupplyCleaning;
}

/**
 * DAYSUPP cleaning — the rules that decide which dispensings are measurable.
 *
 * DAYSUPP is a pharmacy billing field, not an observation of consumption, and
 * it arrives dirty: missing, zero, negative, and occasionally a year of supply
 * on a single fill. Every one of those has to be given a rule, because the
 * alternative is not "no rule" — it is an ARITHMETIC ACCIDENT:
 *
 *   - a NULL days supply makes the interval's end NULL, so the row fails the
 *     window predicate and vanishes. The patient looks less adherent, and
 *     nothing anywhere says a fill was dropped.
 *   - a NEGATIVE days supply gives an interval that ends before it starts. The
 *     covered-days and stockpiled-days sums are clamped at zero, but the MPR
 *     numerator is a plain sum, so a negative supply SUBTRACTS from days
 *     dispensed and can pull MPR below PDC. The program's own identity row then
 *     reports "BROKEN: the interval merge is wrong" — blaming the merge for
 *     what is really a data problem, which is the worst kind of wrong answer:
 *     it sends the analyst to debug correct code.
 *
 * So the rules are explicit, defaulted, stamped into the emitted code, and every
 * drop is COUNTED in a fill-attrition table beside the results.
 */
export interface DaysSupplyCleaning {
  /** drop fills whose DAYSUPP is NULL. */
  dropMissing: boolean;
  /** drop fills whose DAYSUPP is <= 0. */
  dropZeroNegative: boolean;
  /** drop fills whose DAYSUPP exceeds this. A year on one dispensing is a
   *  keying error far more often than a real supply. */
  maxDaysSupplyCap: number;
}

export const DEFAULT_DAYS_SUPPLY_CLEANING: DaysSupplyCleaning = {
  dropMissing: true,
  dropZeroNegative: true,
  maxDaysSupplyCap: 365,
};

/** Every analysis that reads the fills feeder cleans DAYSUPP the same way, so
 *  this takes the field rather than a specific analysis kind — otherwise each
 *  new fills consumer would need its own copy, and two copies of a cleaning
 *  rule are two rules that can drift apart. */
export function daysSupplyCleaningFor(an: { daysSupplyCleaning?: DaysSupplyCleaning }): DaysSupplyCleaning {
  return { ...DEFAULT_DAYS_SUPPLY_CLEANING, ...(an.daysSupplyCleaning ?? {}) };
}

/**
 * The drug code lists that need the per-fill feeder (`<prefix>_fills`), in
 * stable order.
 *
 * The feeder is emitted ONLY when this is non-empty. That is what makes adding
 * it to the cohort spine safe: a spec that asks for no fills-consuming analysis
 * emits byte-identical SQL to before the feeder existed, so all 19 previously
 * shipped kinds are provably untouched (verify/snapshot.ts checks exactly this).
 *
 * Adherence is the first consumer. Switching and line-of-therapy join it here.
 */
export function fillsCodeListIds(spec: StudySpec): string[] {
  const ids = new Set<string>();
  for (const a of spec.analyses) {
    if (!a.enabled) continue;
    if (a.kind === "adherence") ids.add(a.drugCodeListId);
    if (a.kind === "treatment_switching") {
      ids.add(a.fromCodeListId);
      for (const to of a.toCodeListIds) ids.add(to);
    }
  }
  return [...ids].sort();
}

/**
 * Treatment switching — and the overlap rule that decides what a switch IS.
 *
 * A patient dispensed drug B after starting on drug A has done one of two very
 * different things, and claims cannot tell them apart without a rule:
 *
 *   - STOPPED A and started B. That is a switch.
 *   - KEPT TAKING A and added B. That is combination therapy, and counting it
 *     as a switch overstates how many patients abandoned the index drug.
 *
 * The only thing distinguishing them in a claims file is whether A's supply was
 * still running when B began, and by how much. A day or two of overlap is a
 * refill boundary; three months of overlap is combination therapy. Where the
 * line falls is a study decision, not a fact, so `permissibleOverlapDays` is an
 * explicit parameter and the module reports HOW MANY PATIENTS THE CHOICE MOVES
 * rather than adopting one silently. That count is the honest measure of how
 * much the conclusion rests on the rule.
 *
 * LINE OF THERAPY is derived from the same events, under the SIMPLEST possible
 * rule: a new line begins at each switch. That rule is DECLARED, not discovered
 * — see the caveat on `lineRule`.
 *
 * Ref: Hess et al. J Manag Care Pharm 2006;12:565 (switching definitions and
 * how much they move estimates).
 */
export interface TreatmentSwitchingAnalysis extends AnalysisCommon {
  kind: "treatment_switching";
  /** the index drug the patient starts on */
  fromCodeListId: string;
  /** the drugs a patient can switch TO. Each is followed separately. */
  toCodeListIds: string[];
  /** observation window relative to index, INCLUSIVE both ends */
  window: RelativeWindow;
  /** Days of remaining `from`-supply at the moment `to` starts that still count
   *  as a switch. Beyond this the patient is treated as being on BOTH drugs. */
  permissibleOverlapDays: number;
  /** how DAYSUPP is cleaned. Omitted = DEFAULT_DAYS_SUPPLY_CLEANING. */
  daysSupplyCleaning?: DaysSupplyCleaning;
  /**
   * The line-of-therapy rule. Only one is emitted, and it is the simplest one:
   * a new line begins at each switch.
   *
   * THIS IS DEFINITIONAL, and the distinction matters more here than anywhere
   * else in this project. Every other module can be checked against arithmetic:
   * a PDC either counts the right days or it does not. A line of therapy cannot
   * be. Real protocols advance a line on a switch, or on an add-on, or after a
   * gap of N days, or only for drugs in the same class, or on a physician's
   * documented intent that claims do not record at all — and the same patient
   * legitimately has a different line number under each.
   *
   * So execution can prove that the SAS and SQL twins implement the SAME rule.
   * It can never prove the rule is the one a given protocol meant. The emitted
   * code says so, in both languages, next to the number.
   */
  lineRule: "new_line_on_switch";
}

/**
 * Fine-Gray subdistribution hazard model.
 *
 * The one thing that differs from Cox is the RISK SET: a subject who fails from
 * a competing cause STAYS in it, at a weight that decays as censoring
 * accumulates. That is what makes the coefficient an effect on the CUMULATIVE
 * INCIDENCE rather than on the rate among survivors — the two answer different
 * questions and routinely point in different directions.
 *
 * Structurally it IS a Cox model, so it takes exactly the Cox carve-out: beta
 * is SAS-primary, everything around it is closed form and executed. See
 * emitters/finegray-core.ts, including the reduction that makes it checkable —
 * with no competing events this collapses to Cox identically.
 *
 * Ref: Fine & Gray JASA 1999;94:496; Austin & Fine Stat Med 2017;36:4391.
 */
export interface FineGrayAnalysis extends AnalysisCommon {
  kind: "fine_gray";
  /** the event of interest — the cause whose cumulative incidence is modelled */
  endpoint: SurvivalEndpoint;
  /** at least one competing cause; with none this is just a Cox model */
  competingEvents: CompetingEvent[];
  washout: RelativeWindow;
  personTimeRule: PersonTimeRule;
  groupVarId: string;
  covariateIds: string[];
}

/**
 * Cox proportional hazards.
 *
 * The one family whose coefficient genuinely needs Newton — and, it turns out,
 * not the family with the least verification. See emitters/cox-core.ts: the
 * partial log-likelihood at the null, the score, the information and the
 * one-step estimator are all closed form and run in both twins, and the emitted
 * SAS checks PROC PHREG against three of them rather than trusting it.
 *
 * `ties` is deliberately not a free choice — see readiness.
 *
 * Ref: Cox JRSS-B 1972;34:187; Breslow Biometrics 1974;30:89.
 */
export interface CoxAnalysis extends AnalysisCommon {
  kind: "cox";
  endpoint: SurvivalEndpoint;
  washout: RelativeWindow;
  /** the clock. MUST censor at "outcome", same as survival. */
  personTimeRule: PersonTimeRule;
  /** REQUIRED two-level exposure — the coefficient this model is about */
  groupVarId: string;
  /** adjusted terms; the adjusted fit is SAS-primary in full */
  covariateIds: string[];
  /** Breslow only. Efron is refused, with its reason, in readiness. */
  ties: "breslow" | "efron";
}

/* ----- Regression (one GLM emitter) ----- */

/**
 * A generalized linear model over the cohort.
 *
 * The split that makes this honest: the ANALYTIC DATASET and the CRUDE effect
 * are deterministic and both twins compute them; the FITTED coefficients need
 * IRLS/Newton, which warehouse SQL has no way to run, so they are SAS-primary.
 *
 * The one real check available is the SATURATED DESIGN. A model whose only
 * predictor is the two-level exposure is saturated for a 2x2 table, and its
 * maximum-likelihood estimate is EXACTLY the closed-form log odds ratio. That
 * gives the generated SAS something to validate itself against at the site,
 * from its own data, with no reference value shipped alongside it.
 *
 * Ref: McCullagh & Nelder, Generalized Linear Models 2e (1989); Woolf,
 * Ann Hum Genet 1955;19:251 (the log-odds standard error).
 */
export interface RegressionAnalysis extends AnalysisCommon {
  kind: "regression";
  family: RegressionFamily;
  /** binary outcome: a qualifying event inside `horizonDays` after index */
  outcomeDefinition: OutcomeDefinition;
  /** prevalent-case washout, so the outcome is INCIDENT */
  washout: RelativeWindow;
  horizonDays: number;
  /** two-level exposure -> GroupVariable.id; its referenceLevel is the baseline
   *  category, so the reported effect is for the OTHER level */
  groupVarId: string;
  /** "first_only" (default) makes the response a 0/1 indicator; "all_events"
   *  makes it a COUNT of qualifying events in the horizon.
   *
   *  This is not cosmetic. A negative binomial fitted to a 0/1 response is
   *  degenerate — a Bernoulli variance is always BELOW its mean, so the
   *  dispersion parameter is not identified and the model collapses to Poisson.
   *  NB therefore requires "all_events". */
  recurrence?: Recurrence;
  /** REQUIRED for ols: where the continuous response comes from. Only a
   *  comorbidity-index score is derivable today; other sources are refused by
   *  name rather than silently modelled as zero. */
  continuousResponse?: { source: "comorbidity_index"; comorbidityIndexAnalysisId: string };
  /** REQUIRED for gamma_log: where the per-subject COST response comes from.
   *  Read through the shared claim-line ledger, so the model's response is the
   *  same quantity the resource-use table reports — including the inpatient
   *  double-count rule. */
  costResponse?: { window: RelativeWindow; settings: LedgerSetting[]; costField: "paytot" | "netpay" };
  /** REQUIRED for count families: how each subject's person-time (the model's
   *  log offset) is accrued. Shared with the rate modules via rate-core's
   *  censoring plan, so the offset cannot disagree with the incidence table. */
  personTimeRule?: PersonTimeRule;
  /** baseline characteristics entering the ADJUSTED model (SAS-primary) */
  covariateIds: string[];
}

/* ----- Weighted comorbidity index ----- */

/** One condition in a weighted comorbidity index. */
export interface ComorbidityCondition {
  id: string;
  label: string;
  /** -> CodeList.id. The CODES are the analyst's, verified per code, never the
   *  emitter's: Charlson's ICD-10 sets run to hundreds of codes and differ by
   *  published algorithm. */
  codeListId: string;
  weight: number;
  /** ids of conditions whose weight is NOT added when this one is present.
   *
   *  The hierarchy is DECLARED here rather than hardcoded, which is what makes
   *  this a general index engine instead of a Charlson-only one: severe liver
   *  disease supersedes mild, complicated diabetes supersedes uncomplicated,
   *  metastatic tumour supersedes any malignancy — and an Elixhauser-style or
   *  bespoke index declares its own rules the same way.
   *
   *  A superseded condition still reports its PREVALENCE; only its weight is
   *  withheld. Suppressing the prevalence too would hide a real clinical fact. */
  supersedes?: string[];
}

/**
 * Weighted comorbidity index over a pre-index lookback.
 *
 * Deliberately NOT "the Charlson analysis". The scoring algebra and the
 * hierarchy are the error-prone part and are implemented here; the conditions,
 * weights and code lists come from the reviewed spec, so a study can run
 * Charlson (Deyo 1992 / Quan 2005), Elixhauser, or a protocol-specific index
 * without a new emitter — and so no weight is ever supplied by a machine that
 * did not read the paper.
 */
export interface ComorbidityIndexAnalysis extends AnalysisCommon {
  kind: "comorbidity_index";
  /** the index this claims to be — a LABEL carried into the output, never a
   *  lookup key. The conditions below ARE the definition. */
  indexName: string;
  /** pre-index lookback the conditions are ascertained over */
  lookback: RelativeWindow;
  conditions: ComorbidityCondition[];
  /** inclusive lower bounds for the reported score bands, e.g. [0,1,3] */
  scoreBands: number[];
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
  | "hcru" | "cost" | "line_of_therapy"
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
  | ResourceUseAnalysis
  | ComorbidityIndexAnalysis
  | RegressionAnalysis
  | SurvivalAnalysis
  | CoxAnalysis
  | CompetingRisksAnalysis
  | FineGrayAnalysis
  | PropensityScoreAnalysis
  | IptwOutcomeAnalysis
  | GFormulaAnalysis
  | AdherenceAnalysis
  | TreatmentSwitchingAnalysis
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
  "standardization",
  "statistical_engine",
  "calendar_trend",
  "resource_use",
  "comorbidity_index",
  "regression",
  "survival",
  "cox",
  "competing_risks",
  "fine_gray",
  "propensity_score",
  "iptw_outcome",
  "g_formula",
  "adherence",
  "treatment_switching",
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
      /* A protocol section about treatment patterns becomes a REAL switching
       * analysis with its code lists left blank, exactly as incidence_prevalence
       * does above. Readiness then blocks generation until an analyst fills them
       * in, which is louder than a stub the extractor quietly parks. */
      case "treatment_patterns":
        return { ...base, kind: "treatment_switching", fromCodeListId: "", toCodeListIds: [],
                 window: { start: 0, end: 364, includesIndex: true }, permissibleOverlapDays: 30,
                 lineRule: "new_line_on_switch" };
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
    /** Date the licensed extract was cut. Claims accrue for MONTHS after
     *  service, so the last stretch of any delivery is incomplete and every
     *  member's final DTEND is truncated at the cut — without this term the
     *  entire tail cohort reads as DISENROLLED and person-time is overstated
     *  for anyone still enrolled at the end. Omitted = not declared, which the
     *  emitters surface as a REVIEW note rather than assuming a value. */
    dataCutDate?: string;        // ISO date
    /** Months of claims run-out assumed complete before the cut. Follow-up is
     *  censored at (dataCutDate - runout) so the immature tail is excluded
     *  rather than counted as event-free. */
    claimsRunoutMonths?: number;
    description?: string;
    /** Days per person-year for rate/person-year/CI arithmetic. The analyst's
     *  methodological choice — default 365.25 (mean Gregorian year, internally
     *  consistent); some shops use 365 (e.g. a common AE-rate convention AE-rate convention).
     *  It changes reported rates, so it lives in the spec for reproducibility. */
    daysPerYear?: number;
    /** Provenance: how this spec was produced. */
    provenance: {
      /* "llm_assisted" is a spec a human authored (or a model extracted and a
       * human then edited) which a model has since REVISED through the spec
       * chat. It is a third case, not a rounding of the other two: reporting a
       * chat-edited spec as "manual" would make the AI disclosure false, and
       * reporting it as "llm_extraction" would credit the model with work a
       * person did. */
      method: "llm_extraction" | "llm_assisted" | "manual";
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

  /* A comorbidity-index characteristic must name an ENABLED index analysis.
   * The reference is what keeps ONE definition of the index in the spec — a
   * dangling one would leave Table 1 and the balance table silently without
   * the row rather than loudly without a target. */
  const enabledIndexIds = new Set(
    spec.analyses.filter((a) => a.kind === "comorbidity_index" && a.enabled).map((a) => a.id)
  );
  for (const b of spec.baseline) {
    if (b.kind !== "comorbidity_index") continue;
    if (!b.comorbidityIndexAnalysisId)
      problems.push(`Baseline "${b.id}": kind "comorbidity_index" requires comorbidityIndexAnalysisId naming the index analysis to score.`);
    else if (!enabledIndexIds.has(b.comorbidityIndexAnalysisId))
      problems.push(
        `Baseline "${b.id}": comorbidityIndexAnalysisId "${b.comorbidityIndexAnalysisId}" does not name an ENABLED comorbidity_index analysis — Table 1 and the balance table would have no index to score.`
      );
  }

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
        /* Only the PROPORTION trend is built. Refused loudly rather than
         * approximated, because both alternatives would emit a complete,
         * plausible-looking table off the wrong denominator: a rate trend needs
         * person-time SPLIT across calendar buckets (nothing builds that yet),
         * and a point-prevalence trend needs a per-bucket anchor date. */
        if (a.base !== "period_prevalence")
          problems.push(
            `${w}: calendar-trend base "${a.base}" is not emitted yet — only "period_prevalence" buckets are built. ` +
              `A rate trend needs person-time split across calendar buckets; a point-prevalence trend needs a per-bucket anchor. ` +
              `Set base:"period_prevalence", or disable the analysis to keep it visible as planned work.`
          );
        if (a.base === "incidence_rate" && !a.personTimeRule) problems.push(`${w}: rate trend requires personTimeRule.`);
        if (a.trend.bucket === "calendar_month" && a.trend.method === "cochran_armitage")
          problems.push(`${w}: monthly buckets with a Cochran-Armitage trend are usually a mistake — the test scores buckets 0,1,2,... and assumes equal spacing, so dozens of sparse monthly cells give it almost no power. Use calendar_year or calendar_quarter, or state the intent explicitly.`);
        checkStratifiers(a.stratifyBy, w);
        break;
      }
      case "resource_use": {
        if (a.settings.length === 0) problems.push(`${w}: settings[] is empty — nothing would be counted.`);
        const win = a.ascertainmentWindow;
        if (typeof win.start === "number" && typeof win.end === "number" && win.end < win.start)
          problems.push(`${w}: ascertainmentWindow ends (day ${win.end}) before it starts (day ${win.start}).`);
        if (win.start === "anytime_before" || win.end === "anytime_after")
          problems.push(
            `${w}: an unbounded resource-use window cannot be costed — the per-patient denominator is the observed days INSIDE the window, and "anytime" has no length. Give the window explicit day bounds.`
          );
        break;
      }
      case "comorbidity_index": {
        if (a.conditions.length === 0) problems.push(`${w}: conditions[] is empty — the index would be zero for everyone.`);
        const ids = new Set(a.conditions.map((c) => c.id));
        for (const c of a.conditions) {
          requireCodeList(c.codeListId, `${w} condition "${c.id}"`);
          if (!(c.weight > 0)) problems.push(`${w}: condition "${c.id}" has weight ${c.weight} — a weight must be > 0 or the condition contributes nothing.`);
          for (const sup of c.supersedes ?? []) {
            if (!ids.has(sup)) problems.push(`${w}: condition "${c.id}" supersedes "${sup}", which is not one of conditions[].`);
            if (sup === c.id) problems.push(`${w}: condition "${c.id}" supersedes itself.`);
          }
        }
        /* A cycle would make the score depend on evaluation order, which is
         * exactly the kind of silent non-determinism this project refuses. */
        for (const c of a.conditions) {
          for (const sup of c.supersedes ?? []) {
            const other = a.conditions.find((x) => x.id === sup);
            if (other?.supersedes?.includes(c.id))
              problems.push(`${w}: conditions "${c.id}" and "${sup}" supersede EACH OTHER — the score would depend on evaluation order.`);
          }
        }
        if (a.scoreBands.length === 0) problems.push(`${w}: scoreBands[] is empty — no distribution would be reported.`);
        if (a.scoreBands.some((b, i) => i > 0 && b <= a.scoreBands[i - 1]))
          problems.push(`${w}: scoreBands must be strictly increasing lower bounds.`);
        break;
      }
      case "regression": {
        requireCodeList(a.outcomeDefinition.codeListId, `${w} outcome`);
        if (a.horizonDays <= 0) problems.push(`${w}: horizonDays must be > 0.`);
        /* ONE family is built. The others are refused BY NAME rather than
         * half-emitted, because each needs a feeder this emitter does not
         * construct and would otherwise produce a complete-looking model of the
         * wrong thing. */
        const COUNT_FAMILIES = ["poisson", "negative_binomial"];
        if (a.family === "ols") {
          if (!a.continuousResponse)
            problems.push(`${w}: an ols regression requires continuousResponse — without it there is no response to model.`);
          else {
            const src = a.continuousResponse.comorbidityIndexAnalysisId;
            if (!spec.analyses.some((x) => x.id === src && x.kind === "comorbidity_index" && x.enabled))
              problems.push(`${w}: continuousResponse names "${src}", which is not an ENABLED comorbidity_index analysis.`);
            if (a.covariateIds.some((c) => findBaseline(spec, c)?.comorbidityIndexAnalysisId === src))
              problems.push(`${w}: the comorbidity index is both the RESPONSE and a covariate — the model would regress a variable on itself.`);
          }
          if (a.personTimeRule) problems.push(`${w}: an ols model takes no person-time offset.`);
        }
        if (a.family === "gamma_log") {
          if (!a.costResponse)
            problems.push(`${w}: a gamma_log regression requires costResponse — without it there is no continuous response to model.`);
          else if (a.costResponse.settings.length === 0)
            problems.push(`${w}: costResponse.settings[] is empty, so every subject's cost would be zero.`);
          if (a.personTimeRule)
            problems.push(`${w}: a gamma_log cost model takes no person-time offset — costs are totals over the window, not rates. Remove personTimeRule or choose a count family.`);
        }
        /* A count model without person-time would silently become a model of
         * the COUNT rather than the RATE — same coefficients, different
         * estimand, no way to tell from the output. */
        if (COUNT_FAMILIES.includes(a.family) && !a.personTimeRule)
          problems.push(`${w}: a ${a.family} regression requires personTimeRule — without it the log offset is undefined and the model would fit counts, not rates.`);
        /* NB on a 0/1 response is degenerate: a Bernoulli variance is always
         * BELOW its mean, so the dispersion parameter is not identified and the
         * fit collapses to Poisson while still reporting a dispersion estimate. */
        if (a.family === "negative_binomial" && (a.recurrence ?? "first_only") !== "all_events")
          problems.push(
            `${w}: a negative_binomial regression requires recurrence:"all_events". With "first_only" the response is a 0/1 indicator, whose variance is always below its mean — the dispersion parameter is not identified and the model degenerates to Poisson while still printing a dispersion estimate.`
          );
        /* Counting every event while stopping the clock at the first one is
         * incoherent: events after the first could never be observed. */
        if ((a.recurrence ?? "first_only") === "all_events" && a.personTimeRule?.censorAt.includes("outcome"))
          problems.push(
            `${w}: recurrence:"all_events" with personTimeRule censoring at "outcome" is contradictory — follow-up would stop at the first event, so no later event could ever be counted. Remove "outcome" from censorAt for a recurrent-event model.`
          );
        const gv = groupVars.find((g) => g.id === a.groupVarId);
        if (!gv) problems.push(`${w}: groupVarId "${a.groupVarId}" is not in groupVars[].`);
        else {
          if (gv.levels.length !== 2)
            problems.push(`${w}: exposure "${gv.id}" has ${gv.levels.length} levels — the closed-form anchor this model is checked against is only defined for a 2x2, so exactly 2 are required.`);
          if (!gv.referenceLevel)
            problems.push(`${w}: exposure "${gv.id}" has no referenceLevel — without one the sign of every coefficient is arbitrary.`);
        }
        a.covariateIds.forEach((b) => requireBaseline(b, `${w} covariate`));
        break;
      }
      case "survival": {
        /* THE MORTALITY REFUSAL.
         *
         * This gate ships BEFORE any survival module, which is the whole point:
         * the tool must be unable to accept a request for overall survival
         * during the window in which overall survival is unbuildable. The
         * failure it prevents is not a crash — it is a complete, publishable
         * curve that answers a question nobody asked.
         *
         * MarketScan's only native death signal is DSTATUS on the inpatient,
         * services and facility-header tables. It records discharge status, so
         * it captures IN-HOSPITAL death only: a member who dies at home, in
         * hospice or in an ED that does not admit them is indistinguishable
         * from a member who disenrolled. And it is masked from data year 2016
         * onward, so on any recent delivery the signal is not merely partial —
         * it is absent.
         *
         * An "overall survival" curve built on it is therefore a curve of
         * "time to in-hospital death, among deaths occurring before 2016,
         * treating every other death as censoring". Non-informative censoring
         * — the assumption Kaplan-Meier rests on — is violated in the exact
         * direction that flatters survival, because dying is the most
         * censoring-like thing a person can do. */
        if (a.endpoint.kind === "death") {
          problems.push(`${w}: ${MORTALITY_REFUSAL}`);
          break;
        }
        requireCodeList(a.endpoint.outcomeDefinition.codeListId, `${w} endpoint`);
        if (a.endpoint.outcomeDefinition.minClaims < 1) problems.push(`${w}: minClaims must be >= 1.`);
        if (a.endpoint.outcomeDefinition.minClaims >= 2 && a.endpoint.outcomeDefinition.claimSeparationDays == null)
          problems.push(`${w}: minClaims>=2 requires claimSeparationDays.`);
        if (a.horizonDays.length === 0) problems.push(`${w}: horizonDays[] is empty — no survival probability would be reported.`);
        if (a.horizonDays.some((h) => !(h > 0))) problems.push(`${w}: every horizonDays entry must be > 0.`);
        if (a.horizonDays.some((h, i) => i > 0 && h <= a.horizonDays[i - 1]))
          problems.push(`${w}: horizonDays must be strictly increasing.`);
        /* A time-to-event clock that does not stop at the event is not measuring
         * time to the event. Follow-up would run to the administrative censor
         * for everyone while the event indicator stayed set, so every survival
         * time would be the administrative one and the curve would be a
         * description of enrollment. */
        if (!a.personTimeRule.censorAt.includes("outcome"))
          problems.push(
            `${w}: personTimeRule.censorAt must include "outcome" for a survival analysis — otherwise follow-up runs to the administrative censor for everyone, every survival time becomes the administrative one, and the curve describes enrollment rather than the endpoint.`,
          );
        if (a.groupVarId) {
          const gvS = groupVars.find((g) => g.id === a.groupVarId);
          if (!gvS) problems.push(`${w}: groupVarId "${a.groupVarId}" is not in groupVars[].`);
          else {
            if (gvS.levels.length !== 2)
              problems.push(`${w}: exposure "${gvS.id}" has ${gvS.levels.length} levels — the log-rank statistic emitted here is the two-group form, so exactly 2 are required.`);
            if (!gvS.referenceLevel)
              problems.push(`${w}: exposure "${gvS.id}" has no referenceLevel — without one the sign of the log-rank statistic, and therefore the direction of the hazard ratio, is arbitrary.`);
          }
        }
        break;
      }
      case "cox": {
        /* The SAME mortality gate as survival, from the SAME constant. A second
         * time-to-event kind is exactly how a refusal quietly stops covering
         * everything it was written for. */
        if (a.endpoint.kind === "death") {
          problems.push(`${w}: ${MORTALITY_REFUSAL}`);
          break;
        }
        requireCodeList(a.endpoint.outcomeDefinition.codeListId, `${w} endpoint`);
        if (a.endpoint.outcomeDefinition.minClaims < 1) problems.push(`${w}: minClaims must be >= 1.`);
        if (!a.personTimeRule.censorAt.includes("outcome"))
          problems.push(
            `${w}: personTimeRule.censorAt must include "outcome" for a Cox model — otherwise every survival time is the administrative one and the partial likelihood is built on risk sets that never lose anyone to the event.`,
          );
        /* BRESLOW ONLY, and the reason matters more than the rule.
         *
         * Efron's approximation is usually the better one when ties are common,
         * and PROC PHREG will happily fit it. But every closed form the SQL twin
         * computes — the null log-likelihood, the score, the information, the
         * one-step estimator — is Breslow's. If SAS maximized Efron's likelihood
         * instead, the emitted program's own self-check "U(beta_hat) = 0" would
         * be testing the fitted coefficient against the WRONG score function and
         * would fail on a correct fit. A twin pair that disagrees about which
         * likelihood is being maximized is worse than one that only offers one. */
        if (a.ties !== "breslow")
          problems.push(
            `${w}: ties:"${a.ties}" is not emitted — both twins compute Breslow's closed forms, and a SAS fit maximizing Efron's likelihood would fail this program's own U(beta_hat)=0 self-check even when correct. Efron is generally preferable when tied event times are COMMON, so if that is the case here, treat this model as approximate and say so. Set ties:"breslow".`,
          );
        const gvC = groupVars.find((g) => g.id === a.groupVarId);
        if (!gvC) problems.push(`${w}: groupVarId "${a.groupVarId}" is not in groupVars[].`);
        else {
          if (gvC.levels.length !== 2)
            problems.push(`${w}: exposure "${gvC.id}" has ${gvC.levels.length} levels — the closed forms this model is checked against are the two-group ones, so exactly 2 are required.`);
          if (!gvC.referenceLevel)
            problems.push(`${w}: exposure "${gvC.id}" has no referenceLevel — without one the sign of the coefficient, and so the direction of the hazard ratio, is arbitrary.`);
        }
        a.covariateIds.forEach((b) => requireBaseline(b, `${w} covariate`));
        break;
      }
      case "competing_risks": {
        /* The SAME mortality gate, from the SAME constant, for the THIRD
         * time-to-event kind. Note the shape of the trap here: this analysis is
         * ABOUT competing mortality, so it reads as the one place a death
         * endpoint should be allowed. It is not — the endpoint is what the CIF
         * estimates, and DSTATUS cannot ascertain it. A competing cause read
         * from a claims code list is fine and is what competingEvents carries. */
        if (a.endpoint.kind === "death") {
          problems.push(`${w}: ${MORTALITY_REFUSAL} (this is the CIF's event of INTEREST; a competing cause read from a claims code list is a different matter and belongs in competingEvents[])`);
          break;
        }
        requireCodeList(a.endpoint.outcomeDefinition.codeListId, `${w} endpoint`);
        if (a.competingEvents.length === 0)
          problems.push(
            `${w}: no competing events declared. With none, the Aalen-Johansen estimator IS 1 - Kaplan-Meier and this analysis adds nothing over a survival or cumulative_incidence one — declare the competing cause, or use the simpler analysis and say why competing risk was ruled out.`,
          );
        const seenCr = new Set<string>();
        for (const ce of a.competingEvents) {
          if (seenCr.has(ce.id)) problems.push(`${w}: duplicate competing event id "${ce.id}".`);
          seenCr.add(ce.id);
          requireCodeList(ce.outcomeDefinition.codeListId, `${w} competing event "${ce.id}"`);
          /* A competing cause read from the SAME code list as the endpoint
           * makes every subject fail from both at once, and the estimator would
           * silently split its own numerator. */
          if (ce.outcomeDefinition.codeListId === a.endpoint.outcomeDefinition.codeListId)
            problems.push(
              `${w}: competing event "${ce.id}" uses the SAME code list as the endpoint ("${ce.outcomeDefinition.codeListId}"). The causes must be mutually exclusive — sharing a list means every event counts as both, and the partition identity SUM(CIF) = 1 - S would be satisfied by an estimator that is double-counting.`,
            );
        }
        if (!a.personTimeRule.censorAt.includes("outcome"))
          problems.push(`${w}: personTimeRule.censorAt must include "outcome" — the CIF clock stops at whichever cause occurs first.`);
        if (a.horizonDays.length === 0) problems.push(`${w}: horizonDays[] is empty.`);
        for (const h of a.horizonDays) if (h <= 0) problems.push(`${w}: horizonDays entry ${h} must be positive.`);
        break;
      }
      case "fine_gray": {
        /* The FOURTH time-to-event kind, and the same constant. */
        if (a.endpoint.kind === "death") {
          problems.push(`${w}: ${MORTALITY_REFUSAL} (a competing cause read from a claims code list belongs in competingEvents[])`);
          break;
        }
        requireCodeList(a.endpoint.outcomeDefinition.codeListId, `${w} endpoint`);
        if (a.competingEvents.length === 0)
          problems.push(
            `${w}: no competing events declared. The subdistribution risk set differs from the cause-specific one ONLY by the competing-event subjects it retains — with none, this model IS a Cox model, and calling it Fine-Gray claims an adjustment it is not making.`,
          );
        const seenFg = new Set<string>();
        for (const ce of a.competingEvents) {
          if (seenFg.has(ce.id)) problems.push(`${w}: duplicate competing event id "${ce.id}".`);
          seenFg.add(ce.id);
          requireCodeList(ce.outcomeDefinition.codeListId, `${w} competing event "${ce.id}"`);
          if (ce.outcomeDefinition.codeListId === a.endpoint.outcomeDefinition.codeListId)
            problems.push(
              `${w}: competing event "${ce.id}" uses the SAME code list as the endpoint. The causes must be mutually exclusive — sharing a list puts every subject in the risk set twice, once at full weight and once weighted, and the fit would converge on a denominator that counts people who are still at risk as though they had also already failed.`,
            );
        }
        if (!a.personTimeRule.censorAt.includes("outcome"))
          problems.push(`${w}: personTimeRule.censorAt must include "outcome" — the clock stops at whichever cause occurs first.`);
        const gvF = groupVars.find((g) => g.id === a.groupVarId);
        if (!gvF) problems.push(`${w}: groupVarId "${a.groupVarId}" is not in groupVars[].`);
        else {
          if (gvF.levels.length !== 2)
            problems.push(`${w}: exposure "${gvF.id}" has ${gvF.levels.length} levels — the closed forms this model is checked against are the two-group ones, so exactly 2 are required.`);
          if (!gvF.referenceLevel)
            problems.push(`${w}: exposure "${gvF.id}" has no referenceLevel — without one the direction of the subdistribution hazard ratio is arbitrary.`);
        }
        a.covariateIds.forEach((b) => requireBaseline(b, `${w} covariate`));
        break;
      }
      case "propensity_score": {
        const gvP = groupVars.find((g) => g.id === a.groupVarId);
        if (!gvP) problems.push(`${w}: groupVarId "${a.groupVarId}" is not in groupVars[].`);
        else {
          if (gvP.levels.length !== 2) problems.push(`${w}: exposure "${gvP.id}" has ${gvP.levels.length} levels — a propensity score is the probability of ONE treatment, so exactly 2 are required.`);
          if (!gvP.referenceLevel) problems.push(`${w}: exposure "${gvP.id}" has no referenceLevel, so which arm the score is the probability OF is undefined.`);
        }
        /* THE MATCHING REFUSALS. Both are properties of the algorithm, not of
         * this implementation, and both would produce a result that looks
         * perfectly ordinary. */
        if (a.method === "nearest_neighbour")
          problems.push(
            `${w}: greedy nearest-neighbour matching is NOT emitted. It is ORDER-DEPENDENT — the match a treated subject gets depends on how many controls earlier treated subjects already consumed, so the same data in a different row order produces a different matched set and a different estimate. This project's contract is byte-stable emission and reproducible results, and greedy matching cannot satisfy the second even when the code is identical. Use method:"iptw", or run the matching in your own environment and bring the matched pairs in as a cohort.`,
          );
        if (a.method === "optimal")
          problems.push(
            `${w}: optimal matching is NOT emitted. Minimizing total distance across all pairs is an assignment problem — it needs the Hungarian algorithm or a min-cost flow, neither of which warehouse SQL can express, and ties between equally-good assignments have to be broken by a rule the method itself does not specify. Use method:"iptw".`,
          );
        if (a.method === "stratification")
          problems.push(
            `${w}: propensity-score STRATIFICATION is not built yet. It is deterministic and closed form, so this is an unbuilt feature and not a refusal, and the algebra is written down in emitters/psstrat-core.ts. Worth knowing before you reach for it elsewhere: the conventional NTILE-into-quintiles recipe does NOT work on this score. A saturated score is constant within a covariate cell, so NTILE cuts through tied groups and which subjects fall on each side depends on row order - the same order-dependence that makes greedy matching unusable here. Boundaries have to fall BETWEEN distinct score values, which also means K strata cannot always be formed. method:"iptw" is available now.`,
          );
        if (a.psCovariateIds.length === 0)
          problems.push(`${w}: psCovariateIds[] is empty, so there is no propensity model.`);
        /* SATURATION IS THE WHOLE BASIS of the closed form. One continuous
         * covariate and the model is no longer saturated, its MLE is not the
         * cell fraction, and every number downstream would be wrong while
         * looking entirely reasonable. */
        for (const id of a.psCovariateIds) {
          const b = spec.baseline.find((x) => x.id === id);
          if (!b) { problems.push(`${w}: psCovariateIds references "${id}", which is not in baseline[].`); continue; }
          if (!["sex", "region", "plan_type", "year"].includes(b.kind))
            problems.push(
              `${w}: propensity covariate "${id}" is kind "${b.kind}", which is not categorical. The score here is closed form ONLY because a logistic model over categorical cells is SATURATED — its fitted probability in each cell IS the observed treated fraction. A continuous covariate breaks that, the maximum-likelihood score becomes something only iteratively reweighted least squares can produce, and every weight, diagnostic and balance number downstream would be computed from a score that is not the MLE. Use a banded version of it, or fit the score in SAS and bring it in.`,
            );
        }
        a.balanceCovariateIds.forEach((b) => requireBaseline(b, `${w} balance covariate`));
        if (a.trim < 0 || a.trim >= 0.5) problems.push(`${w}: trim must be in [0, 0.5); got ${a.trim}.`);
        break;
      }
      case "iptw_outcome": {
        const gvI = groupVars.find((g) => g.id === a.groupVarId);
        if (!gvI) problems.push(`${w}: groupVarId "${a.groupVarId}" is not in groupVars[].`);
        else {
          if (gvI.levels.length !== 2) problems.push(`${w}: exposure "${gvI.id}" has ${gvI.levels.length} levels — exactly 2 are required.`);
          if (!gvI.referenceLevel) problems.push(`${w}: exposure "${gvI.id}" has no referenceLevel, so the direction of the effect is undefined.`);
        }
        requireCodeList(a.outcomeDefinition.codeListId, `${w} outcome`);
        if (a.horizonDays <= 0) problems.push(`${w}: horizonDays must be positive.`);
        if (a.psCovariateIds.length === 0) problems.push(`${w}: psCovariateIds[] is empty, so there is no propensity model.`);
        /* THE SAME SATURATION GATE as propensity_score, for the same reason —
         * and it matters more here, because a score that is not the MLE
         * produces an EFFECT ESTIMATE that is wrong rather than a diagnostic
         * that is wrong. */
        for (const id of a.psCovariateIds) {
          const b = spec.baseline.find((x) => x.id === id);
          if (!b) { problems.push(`${w}: psCovariateIds references "${id}", which is not in baseline[].`); continue; }
          if (!["sex", "region", "plan_type", "year"].includes(b.kind))
            problems.push(
              `${w}: propensity covariate "${id}" is kind "${b.kind}", which is not categorical. The weighted effect estimate here is closed form ONLY because a logistic score over categorical cells is SATURATED. A continuous covariate makes the score something only iteratively reweighted least squares can produce, and the effect estimate would then be computed from weights that are not the maximum-likelihood ones — a wrong number rather than a missing one.`,
            );
        }
        if (a.doublyRobust)
          problems.push(
            `${w}: doubly-robust (augmented IPTW) estimation is not built yet. With categorical covariates the outcome regression would ALSO be saturated, so this is closed form and buildable — it is a gap, not a refusal. What it needs beyond what is here is the augmentation term's own influence function, since the AIPW variance is not the Hajek sandwich.`,
          );
        if (a.trim < 0 || a.trim >= 0.5) problems.push(`${w}: trim must be in [0, 0.5); got ${a.trim}.`);
        break;
      }
      case "g_formula": {
        const gvG = groupVars.find((g) => g.id === a.groupVarId);
        if (!gvG) problems.push(`${w}: groupVarId "${a.groupVarId}" is not in groupVars[].`);
        else if (gvG.levels.length !== 2) problems.push(`${w}: exposure "${gvG.id}" has ${gvG.levels.length} levels — exactly 2 are required.`);
        requireCodeList(a.outcomeDefinition.codeListId, `${w} outcome`);
        if (a.horizonDays <= 0) problems.push(`${w}: horizonDays must be positive.`);
        if (a.covariateIds.length === 0) problems.push(`${w}: covariateIds[] is empty, so there is nothing to standardize over.`);
        for (const id of a.covariateIds) {
          const b = spec.baseline.find((x) => x.id === id);
          if (!b) { problems.push(`${w}: covariateIds references "${id}", which is not in baseline[].`); continue; }
          if (!["sex", "region", "plan_type", "year"].includes(b.kind))
            problems.push(
              `${w}: covariate "${id}" is kind "${b.kind}", which is not categorical. The g-formula here standardizes over CELLS, and a continuous covariate has no cells — it would need a fitted outcome model, which is a different estimator than the one this module implements and checks.`,
            );
        }
        break;
      }
      case "adherence": {
        requireCodeList(a.drugCodeListId, `${w} drug`);
        if (typeof a.window.start !== "number" || typeof a.window.end !== "number")
          problems.push(`${w}: the measurement window must have numeric day bounds — "anytime" has no length to divide by.`);
        else if (a.window.end < a.window.start)
          problems.push(`${w}: window end (${a.window.end}) is before its start (${a.window.start}).`);
        if (a.permissibleGapDays <= 0)
          problems.push(`${w}: permissibleGapDays must be positive — a gap of zero days would discontinue every patient at their first uncovered day.`);
        if (a.adherenceThreshold <= 0 || a.adherenceThreshold > 1)
          problems.push(`${w}: adherenceThreshold must be in (0, 1]; got ${a.adherenceThreshold}.`);
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
