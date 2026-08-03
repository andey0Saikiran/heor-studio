/**
 * LLM extraction — prompt + tool schema.
 *
 * SPEC_JSON_SCHEMA is a JSON Schema mirror of StudySpec (src/spec/types.ts).
 * It is passed as the `input_schema` of the forced `submit_study_spec` tool so
 * the model can ONLY answer by emitting a structured spec.
 *
 * The enum arrays below are checked at compile time against the exported
 * union types, so this file cannot silently drift from src/spec/types.ts.
 */

import type {
  LegacyAnalysisType,
  BaselineCharacteristic,
  CareSetting,
  CodeEntry,
  CodeList,
  Criterion,
  DatabaseId,
  IndexEventRule,
  OutcomeDefinition,
  ProportionCiMethod,
  RateCiMethod,
  Recurrence,
  PersonTimeRule,
  FutureAnalysisKind,
} from "../spec/types";

/**
 * Exhaustive, membership-checked enum array. `Record<T, true>` fails to
 * compile if a union member is missing (not exhaustive) or an extra key is
 * present (not a member) — keeping these arrays in exact sync with the
 * union types in src/spec/types.ts.
 */
function enumValues<T extends string>(record: Record<T, true>): readonly T[] {
  return Object.keys(record) as T[];
}

export const DATABASE_IDS = enumValues<DatabaseId>({
  marketscan_ccae: true,
  marketscan_mdcr: true,
  marketscan_medicaid: true,
});

export const CODE_SYSTEMS = enumValues<CodeList["system"]>({
  icd9cm: true,
  icd10cm: true,
  cpt_hcpcs: true,
  ndc: true,
  drug_name: true,
});

export const CODE_SOURCES = enumValues<CodeEntry["source"]>({
  ai_suggested: true,
  vocabulary_lookup: true,
  user_entered: true,
  imported: true,
});

export const CARE_SETTINGS = enumValues<CareSetting>({
  any: true,
  inpatient: true,
  outpatient: true,
  pharmacy: true,
});

export const CRITERION_KINDS = enumValues<Criterion["kind"]>({
  inclusion: true,
  exclusion: true,
});

export const CONFIDENCE_LEVELS = enumValues<Criterion["confidence"]>({
  high: true,
  medium: true,
  low: true,
});

export const CRITERION_TEST_TYPES = enumValues<Criterion["test"]["type"]>({
  diagnosis: true,
  procedure: true,
  drug: true,
  age_at_index: true,
  sex: true,
  continuous_enrollment: true,
  unmapped: true,
});

export const INDEX_EVENT_TYPES = enumValues<IndexEventRule["type"]>({
  first_drug_claim: true,
  first_diagnosis: true,
  first_procedure: true,
});

export const BASELINE_KINDS = enumValues<BaselineCharacteristic["kind"]>({
  age: true,
  sex: true,
  region: true,
  plan_type: true,
  year: true,
  comorbidity: true,
  medication: true,
  utilization: true,
  /* Emitted by Table 1 and the balance table from a comorbidity_index ANALYSIS,
   * referenced by id. The extractor may propose it, and readiness refuses it if
   * the reference does not resolve — the coupling is checked, not assumed. */
  comorbidity_index: true,
});

export const ANALYSIS_TYPES = enumValues<LegacyAnalysisType>({
  attrition: true,
  table1: true,
  treatment_patterns: true,
  incidence_prevalence: true,
  hcru_cost: true,
  km_survival: true,
  cox_model: true,
});

/* ---------- analysis-layer enums (P1 descriptive-epi, emittable today) ---------- */

export const OUTCOME_DX_POSITIONS = enumValues<OutcomeDefinition["diagnosisPosition"]>({
  any: true,
  primary: true,
});

export const PROPORTION_CI_METHODS = enumValues<ProportionCiMethod>({
  wilson: true,
  clopper_pearson: true,
  wald: true,
});

export const RATE_CI_METHODS = enumValues<RateCiMethod>({
  poisson_byar: true,
  poisson_exact: true,
  wald_log: true,
});

export const RECURRENCE_KINDS = enumValues<Recurrence>({
  first_only: true,
  all_events: true,
});

export const PERSON_TIME_STARTS = enumValues<PersonTimeRule["start"]>({
  index: true,
  enrollment_start: true,
  washout_end: true,
});

export const PERSON_TIME_CENSORS = enumValues<PersonTimeRule["censorAt"][number]>({
  outcome: true,
  disenrollment: true,
  death: true,
  study_end: true,
  max_followup: true,
});

export const STRATIFIER_AXES = ["age_band", "sex", "region", "plan_type", "year"] as const;

/** The four descriptive-epi kinds the emitters can generate code for today. */
export const EMITTABLE_ANALYSIS_KINDS_EXTRACT = [
  "incidence_rate",
  "point_prevalence",
  "period_prevalence",
  "cumulative_incidence",
] as const;

export const FUTURE_ANALYSIS_KINDS = enumValues<FutureAnalysisKind>({
  hcru: true,
  cost: true,
  line_of_therapy: true,
  ps_matching: true,
  iptw: true,
  km_survival: true,
  cox_model: true,
  competing_risks: true,
});

/* ---------- reusable sub-schemas ---------- */

const ISO_DATE = {
  type: "string",
  description: "ISO 8601 calendar date, YYYY-MM-DD.",
};

const RELATIVE_WINDOW_SCHEMA = {
  type: "object",
  description:
    "Time window in days relative to the index date (day 0). Negative = " +
    "before index. start/end are INCLUSIVE day offsets. Baseline windows " +
    "include the index date (e.g. -365..0); follow-up windows exclude it " +
    '(e.g. 1..365). Use "anytime_before" / "anytime_after" when the ' +
    "protocol places no bound.",
  properties: {
    start: {
      anyOf: [
        { type: "number", description: "Inclusive start day offset relative to index." },
        { type: "string", enum: ["anytime_before"] },
      ],
      description:
        'Inclusive start offset in days, or "anytime_before" for an unbounded lookback.',
    },
    end: {
      anyOf: [
        { type: "number", description: "Inclusive end day offset relative to index." },
        { type: "string", enum: ["anytime_after"] },
      ],
      description:
        'Inclusive end offset in days, or "anytime_after" for an unbounded follow-up.',
    },
    includesIndex: {
      type: "boolean",
      description:
        "True when day 0 (the index date) falls inside the window. Baseline " +
        "windows include the index date; follow-up windows exclude it.",
    },
  },
  required: ["start", "end", "includesIndex"],
  additionalProperties: false,
};

const CODE_ENTRY_SCHEMA = {
  type: "object",
  description:
    "One medical code (or drug-name pattern). NEVER invent codes: only " +
    "include codes that appear verbatim in the source document.",
  properties: {
    code: {
      type: "string",
      description:
        'The code exactly as written in the document, e.g. "L40.0", "696.1", ' +
        'an 11-digit NDC, or a drug-name pattern like "ADALIMUMAB|HUMIRA". For a ' +
        'code FAMILY written with a placeholder ("E11.x", "K85.xx", "250.x0", ' +
        '"E10.x"), record the STEM WITHOUT the placeholder ("E11", "K85", "250", ' +
        '"E10") and set match:"prefix". Do NOT paste the literal x; a code with an ' +
        'x in it matches no real claim.',
    },
    description: {
      type: "string",
      description: "Human-readable meaning of the code, if the document gives one.",
    },
    match: {
      type: "string",
      enum: ["exact", "prefix"],
      description:
        'How the code matches a claim. Omit or "exact" for a single leaf code. ' +
        'Use "prefix" ONLY for a diagnosis FAMILY, so the stem matches every code ' +
        'beneath it: "K85" (prefix) matches K850, K8590, K859; "E11" (prefix) ' +
        'matches every type-2 diabetes code. Diagnosis lists only.',
    },
    source: {
      type: "string",
      enum: CODE_SOURCES,
      description: 'Always "ai_suggested" for extracted codes.',
    },
    verified: {
      type: "boolean",
      description: "Always false — the analyst verifies codes in the workbench.",
    },
  },
  required: ["code", "source", "verified"],
  additionalProperties: false,
};

const CODE_LIST_SCHEMA = {
  type: "object",
  description:
    "A named list of codes referenced by criteria / the index event. When " +
    "the protocol names a clinical concept WITHOUT listing its codes, still " +
    "create the list — with an EMPTY codes array — and say in notes exactly " +
    "what needs to be looked up. Never fabricate codes to fill a list.",
  properties: {
    id: {
      type: "string",
      description:
        'Stable slug in snake_case, e.g. "pso_dx", "index_biologics". ' +
        "Criteria reference lists by this id.",
    },
    label: { type: "string", description: 'Display label, e.g. "Psoriasis diagnosis".' },
    system: {
      type: "string",
      enum: CODE_SYSTEMS,
      description:
        "Code system: icd9cm / icd10cm diagnosis codes, cpt_hcpcs procedure " +
        "codes, ndc drug codes, or drug_name generic/brand name patterns.",
    },
    codes: { type: "array", items: CODE_ENTRY_SCHEMA },
    notes: {
      type: "string",
      description:
        "Caveats, era handling, or — for empty lists — precisely what codes " +
        "must be looked up and from which vocabulary.",
    },
  },
  required: ["id", "label", "system", "codes"],
  additionalProperties: false,
};

const CRITERION_TEST_SCHEMA = {
  description:
    "What the criterion tests, mapped to one executable form. If the " +
    'criterion cannot be mapped confidently, use {"type": "unmapped"} — ' +
    "never guess a mapping.",
  oneOf: [
    {
      type: "object",
      description: "Diagnosis-code requirement.",
      properties: {
        type: { type: "string", enum: ["diagnosis"] },
        codeListId: { type: "string", description: "id of a list in codeLists." },
        minClaims: {
          type: "number",
          description: "Minimum number of qualifying claims (>= 1).",
        },
        claimSeparationDays: {
          type: "number",
          description:
            "If >= 2 claims are required, minimum days between two qualifying claims.",
        },
        setting: { type: "string", enum: CARE_SETTINGS },
        window: RELATIVE_WINDOW_SCHEMA,
      },
      required: ["type", "codeListId", "minClaims", "setting", "window"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Procedure-code requirement.",
      properties: {
        type: { type: "string", enum: ["procedure"] },
        codeListId: { type: "string", description: "id of a list in codeLists." },
        minClaims: { type: "number", description: "Minimum number of qualifying claims (>= 1)." },
        setting: { type: "string", enum: CARE_SETTINGS },
        window: RELATIVE_WINDOW_SCHEMA,
      },
      required: ["type", "codeListId", "minClaims", "setting", "window"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Drug-exposure requirement (pharmacy claims).",
      properties: {
        type: { type: "string", enum: ["drug"] },
        codeListId: { type: "string", description: "id of a list in codeLists." },
        minClaims: { type: "number", description: "Minimum number of qualifying claims (>= 1)." },
        window: RELATIVE_WINDOW_SCHEMA,
      },
      required: ["type", "codeListId", "minClaims", "window"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Age requirement evaluated at the index date.",
      properties: {
        type: { type: "string", enum: ["age_at_index"] },
        min: { type: "number", description: "Minimum age in years, inclusive." },
        max: { type: "number", description: "Maximum age in years, inclusive." },
      },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Sex requirement.",
      properties: {
        type: { type: "string", enum: ["sex"] },
        value: { type: "string", enum: ["M", "F"] },
      },
      required: ["type", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Continuous-enrollment requirement. baselineDays counts backward " +
        "from and INCLUDES the index date; followupDays counts forward from " +
        "and EXCLUDES the index date.",
      properties: {
        type: { type: "string", enum: ["continuous_enrollment"] },
        baselineDays: { type: "number" },
        followupDays: { type: "number" },
        requiresRxCoverage: {
          type: "boolean",
          description: "True when the protocol requires pharmacy/drug coverage.",
        },
      },
      required: ["type", "baselineDays", "followupDays", "requiresRxCoverage"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Use when the criterion cannot be mapped to any of the forms above " +
        "with reasonable confidence. The analyst resolves it later.",
      properties: {
        type: { type: "string", enum: ["unmapped"] },
      },
      required: ["type"],
      additionalProperties: false,
    },
  ],
};

const CRITERION_SCHEMA = {
  type: "object",
  description:
    "One inclusion or exclusion criterion. Order matters: criteria are " +
    "applied in sequence to build the attrition (CONSORT) table, so list " +
    "them in the order the protocol applies them.",
  properties: {
    id: { type: "string", description: 'Stable snake_case slug, e.g. "inc_age".' },
    kind: { type: "string", enum: CRITERION_KINDS },
    sourceText: {
      type: "string",
      description:
        "The criterion text VERBATIM from the protocol/SAP. Never paraphrase " +
        "here — the source language must be preserved exactly.",
    },
    test: CRITERION_TEST_SCHEMA,
    confidence: {
      type: "string",
      enum: CONFIDENCE_LEVELS,
      description:
        "Honest self-assessment of the mapping. Anything below high is " +
        "flagged for analyst review — do not inflate.",
    },
    reviewed: {
      type: "boolean",
      description: "Always false — the analyst reviews in the workbench.",
    },
  },
  required: ["id", "kind", "sourceText", "test", "confidence", "reviewed"],
  additionalProperties: false,
};

/* ---------- analysis-layer sub-schemas ---------- */

const OUTCOME_DEFINITION_SCHEMA = {
  type: "object",
  description:
    "How the clinical OUTCOME event is ascertained from claims (distinct from " +
    "the cohort's index event). Reference a code list in codeLists by id; when " +
    "the protocol names the outcome concept without codes, create an EMPTY list " +
    "and reference it — never fabricate codes.",
  properties: {
    codeListId: { type: "string", description: "id of the code list defining the outcome." },
    minClaims: {
      type: "number",
      description: "Qualifying claims to count as a case (>= 1). Use 1 unless the protocol requires confirmation.",
    },
    claimSeparationDays: {
      type: "number",
      description: "Required when minClaims >= 2: minimum days between two qualifying claims.",
    },
    setting: {
      type: "string",
      enum: CARE_SETTINGS,
      description: 'Care setting the outcome must appear in ("any" unless the protocol restricts it).',
    },
    diagnosisPosition: {
      type: "string",
      enum: OUTCOME_DX_POSITIONS,
      description: '"primary"/principal diagnosis only, or "any" position. Use "any" unless the protocol says principal.',
    },
  },
  required: ["codeListId", "minClaims", "setting", "diagnosisPosition"],
  additionalProperties: false,
};

const STRATIFIER_SCHEMA = {
  type: "object",
  description:
    "A subgroup axis to report the measure by. Only include stratifiers the " +
    "protocol explicitly asks for (e.g. by age band, by sex).",
  properties: {
    id: { type: "string", description: 'Stable snake_case slug, e.g. "by_sex".' },
    label: { type: "string" },
    source: {
      type: "object",
      description: "Demographic axis (age_band/sex/region/plan_type/year) or a baseline characteristic.",
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["demographic"] },
            axis: { type: "string", enum: [...STRATIFIER_AXES] },
          },
          required: ["kind", "axis"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["baseline"] },
            baselineId: { type: "string", description: "id of a baseline characteristic." },
          },
          required: ["kind", "baselineId"],
          additionalProperties: false,
        },
      ],
    },
    ageBandLowerBounds: {
      type: "array",
      items: { type: "number" },
      description: 'Inclusive lower bounds for an age_band axis, e.g. [0,18,45,65]. Only for axis "age_band".',
    },
  },
  required: ["id", "label", "source"],
  additionalProperties: false,
};

const ANCHOR_DATE_SCHEMA = {
  description: "Point-prevalence anchor: a fixed calendar date, or each subject's own index date.",
  oneOf: [
    {
      type: "object",
      properties: { kind: { type: "string", enum: ["fixed"] }, date: ISO_DATE },
      required: ["kind", "date"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { type: "string", enum: ["index"] } },
      required: ["kind"],
      additionalProperties: false,
    },
  ],
};

/** Analysis common header fields shared by every kind. */
const ANALYSIS_COMMON_PROPS = {
  id: { type: "string", description: "Stable snake_case slug, UNIQUE within analyses[]." },
  label: { type: "string", description: "Human title shown in the review UI." },
  enabled: { type: "boolean", description: "Whether to generate code for this analysis." },
  notes: {
    type: "string",
    description: "Verbatim protocol/SAP text for this analysis — never paraphrase.",
  },
};

const ANALYSIS_SCHEMA = {
  description:
    "One requested analysis. Choose the KIND that matches the protocol. The four " +
    "descriptive-epi kinds (incidence_rate, point_prevalence, period_prevalence, " +
    "cumulative_incidence) generate SAS+SQL today; attrition and table1 come from " +
    "the cohort spine; anything else (HCRU, cost, survival, PS/IPTW, switching) is " +
    'a future_stub carrying its plannedKind and notes. Leave methodological choices ' +
    "you cannot read from the protocol OUT — the analyst sets defaults in review.",
  oneOf: [
    {
      type: "object",
      description: "CONSORT attrition table (from the cohort spine). No parameters.",
      properties: { ...ANALYSIS_COMMON_PROPS, kind: { type: "string", enum: ["attrition"] } },
      required: ["id", "label", "enabled", "kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Baseline Table 1 (from the cohort spine).",
      properties: {
        ...ANALYSIS_COMMON_PROPS,
        kind: { type: "string", enum: ["table1"] },
        includeBaselineIds: {
          type: "array",
          items: { type: "string" },
          description: "Baseline characteristic ids to include; omit for all.",
        },
      },
      required: ["id", "label", "enabled", "kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Incidence rate / density: new (incident) cases per person-time at risk. " +
        "Use for 'incidence rate', 'per 1,000 person-years', 'IR'.",
      properties: {
        ...ANALYSIS_COMMON_PROPS,
        kind: { type: "string", enum: ["incidence_rate"] },
        outcomeDefinition: OUTCOME_DEFINITION_SCHEMA,
        washout: {
          ...RELATIVE_WINDOW_SCHEMA,
          description:
            "Prevalent-case washout window BEFORE index: an outcome anywhere in it removes the " +
            "subject so only new-onset cases count. E.g. 12-month washout = {start:-365,end:0,includesIndex:true}.",
        },
        rateMultiplier: {
          type: "number",
          description: "Person-years scaling: 1000 for 'per 1,000 PY', 100000 for 'per 100,000 PY'. Default 1000.",
        },
        recurrence: {
          type: "string",
          enum: RECURRENCE_KINDS,
          description: '"first_only" = incidence density (first event); "all_events" = recurrent-event rate. Default first_only.',
        },
        stratifyBy: { type: "array", items: STRATIFIER_SCHEMA },
      },
      required: ["id", "label", "enabled", "kind", "outcomeDefinition"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Point prevalence: share of the enrolled population with the condition ON a specific date " +
        "(the anchor). Use for 'prevalence on <date>', 'point prevalence'.",
      properties: {
        ...ANALYSIS_COMMON_PROPS,
        kind: { type: "string", enum: ["point_prevalence"] },
        outcomeDefinition: OUTCOME_DEFINITION_SCHEMA,
        anchorDate: ANCHOR_DATE_SCHEMA,
        stratifyBy: { type: "array", items: STRATIFIER_SCHEMA },
      },
      required: ["id", "label", "enabled", "kind", "outcomeDefinition", "anchorDate"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Period prevalence: share of the population with the condition at any time DURING a calendar " +
        "window. Use for 'annual prevalence', 'prevalence during <period>'.",
      properties: {
        ...ANALYSIS_COMMON_PROPS,
        kind: { type: "string", enum: ["period_prevalence"] },
        outcomeDefinition: OUTCOME_DEFINITION_SCHEMA,
        prevalencePeriod: {
          type: "object",
          description: "Absolute calendar window (ISO dates) the prevalence is measured over.",
          properties: { start: ISO_DATE, end: ISO_DATE },
          required: ["start", "end"],
          additionalProperties: false,
        },
        stratifyBy: { type: "array", items: STRATIFIER_SCHEMA },
      },
      required: ["id", "label", "enabled", "kind", "outcomeDefinition", "prevalencePeriod"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Cumulative incidence (risk): proportion of at-risk subjects with a first event within a " +
        "fixed horizon after index. Use for '1-year risk', 'cumulative incidence', 'X% by N months'.",
      properties: {
        ...ANALYSIS_COMMON_PROPS,
        kind: { type: "string", enum: ["cumulative_incidence"] },
        outcomeDefinition: OUTCOME_DEFINITION_SCHEMA,
        washout: {
          ...RELATIVE_WINDOW_SCHEMA,
          description: "Prevalent-case washout window BEFORE index (see incidence_rate).",
        },
        horizonDays: {
          type: "number",
          description: "Risk horizon in days after index, e.g. 365 for 1-year risk, 180 for 6-month.",
        },
        stratifyBy: { type: "array", items: STRATIFIER_SCHEMA },
      },
      required: ["id", "label", "enabled", "kind", "outcomeDefinition", "horizonDays"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Any analysis NOT in the descriptive-epi set above: HCRU, cost, adherence, line of therapy, " +
        "treatment switching, PS matching / IPTW, Kaplan-Meier, Cox, competing risks. Recorded as a " +
        "planned stub (no code generated yet) so the request stays visible for the analyst.",
      properties: {
        ...ANALYSIS_COMMON_PROPS,
        kind: { type: "string", enum: ["future_stub"] },
        plannedKind: { type: "string", enum: FUTURE_ANALYSIS_KINDS },
      },
      required: ["id", "label", "enabled", "kind", "plannedKind"],
      additionalProperties: false,
    },
  ],
};

/* ---------- top-level schema ---------- */

/**
 * JSON Schema for the `submit_study_spec` tool input — a precise mirror of
 * StudySpec in src/spec/types.ts.
 */
export const SPEC_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "A complete HEOR Studio study specification extracted from a clinical " +
    "protocol or statistical analysis plan (SAP), targeting a MarketScan " +
    "claims database.",
  properties: {
    meta: {
      type: "object",
      properties: {
        title: { type: "string", description: "Study title from the document." },
        version: {
          type: "string",
          description: 'Spec version; use "0.1.0" for a fresh extraction.',
        },
        database: {
          type: "string",
          enum: DATABASE_IDS,
          description:
            "Target database: marketscan_ccae (commercial), marketscan_mdcr " +
            "(Medicare supplemental), marketscan_medicaid.",
        },
        studyPeriod: {
          type: "object",
          description: "Absolute claim window for the whole study (ISO dates).",
          properties: { start: ISO_DATE, end: ISO_DATE },
          required: ["start", "end"],
          additionalProperties: false,
        },
        description: {
          type: "string",
          description: "One-paragraph summary of the study design.",
        },
        provenance: {
          type: "object",
          description: "How this spec was produced.",
          properties: {
            method: { type: "string", enum: ["llm_extraction", "manual"] },
            model: { type: "string" },
            extractedAt: { type: "string", description: "ISO 8601 timestamp." },
            sourceDocumentName: { type: "string" },
          },
          required: ["method"],
          additionalProperties: false,
        },
      },
      required: ["title", "version", "database", "studyPeriod", "provenance"],
      additionalProperties: false,
    },
    codeLists: {
      type: "array",
      description:
        "Every code list referenced by the index event, criteria, or " +
        "baseline characteristics. Include concept lists WITHOUT codes (empty " +
        "codes array + notes) when the protocol names a concept but lists no codes.",
      items: CODE_LIST_SCHEMA,
    },
    indexEvent: {
      type: "object",
      description:
        "The rule that assigns each patient their index date (day 0).",
      properties: {
        type: { type: "string", enum: INDEX_EVENT_TYPES },
        codeListId: {
          type: "string",
          description: "id of the code list that defines the index event.",
        },
        indexPeriod: {
          type: "object",
          description:
            "Absolute period the index date must fall inside (ISO dates).",
          properties: { start: ISO_DATE, end: ISO_DATE },
          required: ["start", "end"],
          additionalProperties: false,
        },
        description: { type: "string" },
      },
      required: ["type", "codeListId", "indexPeriod"],
      additionalProperties: false,
    },
    enrollment: {
      type: "object",
      description:
        "Continuous-enrollment requirements. baselineDays runs backward from " +
        "and INCLUDES the index date; followupDays runs forward from and " +
        "EXCLUDES the index date.",
      properties: {
        baselineDays: {
          type: "number",
          description:
            "Continuous enrollment required before index, including the index date.",
        },
        followupDays: {
          type: "number",
          description: "Continuous enrollment required after index (index date excluded).",
        },
        gapAllowanceDays: {
          type: "number",
          description:
            "Merge adjacent enrollment segments separated by <= this many " +
            "days (gap stitching). Use 0 if the protocol allows no gaps.",
        },
        requiresRxCoverage: {
          type: "boolean",
          description: "True when pharmacy/drug coverage is required.",
        },
      },
      required: ["baselineDays", "followupDays", "gapAllowanceDays", "requiresRxCoverage"],
      additionalProperties: false,
    },
    criteria: {
      type: "array",
      description:
        "Ordered inclusion/exclusion criteria, in the sequence the protocol " +
        "applies them (drives the attrition table).",
      items: CRITERION_SCHEMA,
    },
    baseline: {
      type: "array",
      description: "Baseline (Table 1) characteristics to report.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: 'Stable snake_case slug, e.g. "b_age".' },
          label: { type: "string" },
          kind: { type: "string", enum: BASELINE_KINDS },
          codeListId: {
            type: "string",
            description:
              "For comorbidity/medication kinds: id of the defining code list.",
          },
          window: RELATIVE_WINDOW_SCHEMA,
        },
        required: ["id", "label", "kind"],
        additionalProperties: false,
      },
    },
    analyses: {
      type: "array",
      description:
        "Every analysis the protocol requests, as a per-KIND object (see the " +
        "kinds in the item schema). Always include attrition and table1. Add a " +
        "descriptive-epi analysis (incidence_rate / point_prevalence / " +
        "period_prevalence / cumulative_incidence) for each incidence/prevalence/" +
        "risk endpoint the protocol asks for, with its outcomeDefinition pointing " +
        "at an outcome code list. Record every other requested analysis as a " +
        "future_stub with the right plannedKind.",
      items: ANALYSIS_SCHEMA,
    },
    unrepresented: {
      type: "array",
      description:
        "Constructs the protocol REQUIRES that this schema cannot express. Record " +
        "them here instead of dropping or approximating them silently; the analyst " +
        "must acknowledge each before code is generated. Add an entry whenever the " +
        "protocol needs: a compound/confirmatory case definition (a diagnosis AND a " +
        "lab or procedure within N days); a database other than MarketScan (e.g. " +
        "Optum) or a pooled / meta-analytic primary estimate; an as-treated or " +
        "grace-period follow-up clock; a laboratory-value baseline covariate; an " +
        "exposure with more than two levels or a pooled comparator; or anything else " +
        "you cannot faithfully place in the fields above.",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["outcome_algorithm", "database", "censoring", "covariate", "exposure", "other"],
          },
          label: { type: "string", description: "Short name of the construct, e.g. 'Confirmatory pancreatitis algorithm'." },
          sourceText: { type: "string", description: "The verbatim protocol sentence that requires it." },
          detail: { type: "string", description: "What the schema cannot do and what the generated code will do instead." },
        },
        required: ["category", "label", "sourceText", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "meta",
    "codeLists",
    "indexEvent",
    "enrollment",
    "criteria",
    "baseline",
    "analyses",
  ],
  additionalProperties: false,
};

/* ---------- system prompt ---------- */

export const SYSTEM_PROMPT = `You are an expert HEOR (health economics and outcomes research) analyst who specializes in translating clinical-trial protocols and statistical analysis plans (SAPs) into executable retrospective claims-database study specifications for MarketScan (CCAE / MDCR / Medicaid).

Your ONLY job is to read the provided document and call the submit_study_spec tool exactly once with a complete, faithful StudySpec. Do not write prose. Everything you extract will be reviewed and edited by a human analyst before any code is generated, so precision and honesty about uncertainty matter more than completeness.

WHAT TO EXTRACT
1. Study metadata — title, target database, absolute study period, a short design summary.
2. Index event rule — what defines day 0 (first drug claim / first diagnosis / first procedure), which code list defines it, and the absolute index-identification period.
3. Enrollment requirements — continuous-enrollment days before and after index, any allowed coverage gap (stitching), and whether pharmacy (Rx) coverage is required.
4. Inclusion/exclusion criteria — every criterion, IN THE ORDER the protocol applies them (this order drives the attrition/CONSORT table).
5. Code lists — every diagnosis, procedure, drug, or NDC list the criteria and index event reference.
6. Baseline (Table 1) characteristics — demographics, plan/region/year, comorbidities, medications, utilization.
7. Requested analyses — one object per analysis, choosing the KIND that matches the endpoint (see ANALYSIS LAYER below). Always include attrition and table1. Emit a descriptive-epi analysis for each incidence / prevalence / risk endpoint; record everything else (HCRU, cost, adherence, line of therapy, switching, KM, Cox, PS/IPTW, competing risks) as a future_stub with the correct plannedKind and the protocol notes.

8. What you CANNOT express — the unrepresented[] list. This schema is deliberately narrow. When the protocol requires something you cannot faithfully place in the fields above, DO NOT force it into the closest field, drop it, or approximate it. Record it in unrepresented[] with the verbatim sentence and what the generated code will do instead. The most common cases: a compound/confirmatory case definition (a diagnosis AND a lab or procedure within N days, like acute pancreatitis confirmed by a lipase value); a non-MarketScan database such as Optum, or a pooled/meta-analytic primary estimate; an as-treated or grace-period follow-up clock; laboratory-value baseline covariates; a multi-level or pooled exposure. A tool that says "I cannot represent this" is doing its job; a tool that silently ships a study answering a different question is the failure this whole product exists to prevent.

HARD RULES
- NEVER invent, infer, or "complete" medical codes. Only include a code if it appears in the document. When the protocol names a clinical concept without listing codes (e.g. "patients with type 2 diabetes" with no ICD codes given), still create the code list — with an EMPTY codes array — and state in its notes exactly what must be looked up (concept, vocabulary, and any qualifiers the protocol gives). An empty list the analyst fills in is correct; a fabricated code is a critical failure.
- Preserve each criterion's text VERBATIM in sourceText — copy the protocol language exactly, including thresholds and qualifiers. Never paraphrase in that field.
- Set confidence honestly per criterion: "high" only when the mapping is unambiguous and fully supported by the document; "medium" when you had to interpret; "low" when you are unsure. Anything below high is flagged for review — an inflated confidence hides errors from the analyst.
- When a criterion cannot be mapped to diagnosis / procedure / drug / age_at_index / sex / continuous_enrollment, use test {"type": "unmapped"} with confidence "low". Do not force a wrong mapping.
- For every extracted code entry set source "ai_suggested" and verified false. For every criterion set reviewed false.

TIME CONVENTIONS (follow exactly)
- Windows are day offsets relative to the index date (day 0); negative = before index; start/end are inclusive.
- The BASELINE period INCLUDES the index date and runs backward: a 12-month baseline is {start: -365, end: 0, includesIndex: true}.
- The FOLLOW-UP period EXCLUDES the index date and runs forward: a 12-month follow-up is {start: 1, end: 365, includesIndex: false}.
- "Any time on or before index" is {start: "anytime_before", end: 0, includesIndex: true}.
- All absolute dates are ISO format (YYYY-MM-DD). Convert any other date format you encounter.

CODE SYSTEM NOTES
- ICD-9-CM vs ICD-10-CM era is handled downstream via DXVER; put ICD-9 and ICD-10 codes for the same concept in ONE list and note the era split in notes.
- Drug lists given as generic/brand names use system "drug_name" with patterns like "ADALIMUMAB|HUMIRA"; NDC lists use system "ndc"; CPT/HCPCS/ICD procedure codes use "cpt_hcpcs".

ANALYSIS LAYER (pick the KIND per endpoint; extract facts, not methodology)
- attrition and table1 always go in. For table1, list the baseline ids in includeBaselineIds only if the protocol reports a subset; otherwise omit it (all baselines).
- Map each incidence/prevalence/risk endpoint to a descriptive-epi kind:
  - incidence_rate  → "incidence rate", "incidence density", "per 1,000 (or 100,000) person-years", "IR". Set rateMultiplier from the stated denominator (1000 / 100000); default 1000.
  - point_prevalence → "prevalence on <date>", "point prevalence". anchorDate = {kind:"fixed",date} for a calendar date, or {kind:"index"} if measured at each subject's index.
  - period_prevalence → "annual/period prevalence", "prevalence during <period>". prevalencePeriod = the stated calendar window.
  - cumulative_incidence → "1-year risk", "cumulative incidence", "X% by N months". horizonDays = the stated horizon in days (1 year = 365).
- Every descriptive-epi analysis needs an outcomeDefinition pointing at an OUTCOME code list (separate from the index-event list). If the protocol names the outcome concept without codes, create an EMPTY outcome code list and reference it — same no-fabrication rule as everywhere else. Set the outcome's minClaims (default 1), setting ("any" unless restricted), and diagnosisPosition ("any" unless the protocol says principal/primary).
- For incidence_rate and cumulative_incidence, set the washout window ONLY if the protocol specifies a prevalent-case/new-user washout (e.g. "no diagnosis in the 12 months before index" → {start:-365,end:0,includesIndex:true}). If it does not, OMIT washout — the analyst chooses.
- Add a stratifyBy entry ONLY for subgroups the protocol explicitly reports (by sex, by age band, etc.). Do NOT invent strata. Omit CI method, person-time rule, and denominator rule entirely — those are methodological defaults the analyst confirms in review, not protocol facts.
- Covariate BALANCE between exposure arms (SMD tables) is emittable but is NOT extracted: it needs an exposure GroupVariable the analyst defines in review, so do not invent one. If the protocol asks for a balance/Table-1-by-arm comparison, note it in the table1 or attrition analysis notes and let the analyst add it.
- Anything that is NOT one of the four descriptive-epi kinds — HCRU, cost, adherence/PDC/MPR, line of therapy, treatment switching/persistence, Kaplan-Meier, Cox, PS matching, IPTW, competing risks — is a future_stub. Set plannedKind to the closest value and put the protocol's definition (discontinuation gap, PDC threshold, cost components, etc.) in notes. These are not generated yet but must stay visible.

If the document is not a study protocol/SAP or contains no extractable study design, still call the tool with your best-effort skeleton: empty code lists with explanatory notes, criteria as unmapped with confidence "low", attrition+table1 analyses, and the verbatim text you did find.`;
