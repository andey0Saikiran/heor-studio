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
        'an 11-digit NDC, or a drug-name pattern like "ADALIMUMAB|HUMIRA".',
    },
    description: {
      type: "string",
      description: "Human-readable meaning of the code, if the document gives one.",
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
      description: "Which analyses the protocol requests.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ANALYSIS_TYPES },
          enabled: { type: "boolean" },
          notes: {
            type: "string",
            description:
              "Free-text detail carried from the protocol (e.g. outcome " +
              "definitions, discontinuation gap, PDC threshold).",
          },
        },
        required: ["type", "enabled"],
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
7. Requested analyses — attrition, Table 1, treatment patterns, incidence/prevalence, HCRU & cost, KM survival, Cox models — with protocol notes (e.g. discontinuation gap definition, PDC threshold, outcome definitions).

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

If the document is not a study protocol/SAP or contains no extractable study design, still call the tool with your best-effort skeleton: empty code lists with explanatory notes, criteria as unmapped with confidence "low", and the verbatim text you did find.`;
