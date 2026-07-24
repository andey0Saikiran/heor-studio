import type { StudySpec } from "@heor-studio/core";

/**
 * Demo fixture: new-user cohort of IL-17/IL-23/IL-12/23 biologics in
 * psoriasis (PsO) on MarketScan CCAE — a realistic treatment-pattern study
 * of the kind HEOR consultancies run every week. Codes below are the
 * standard published PsO code set and on-label biologic names; they are
 * illustrative and still require analyst verification in the workbench.
 */
export const PSO_DEMO_SPEC: StudySpec = {
  meta: {
    title: "PsO index biologics — new-user treatment patterns (demo)",
    version: "0.1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2016-01-01", end: "2021-09-30" },
    description:
      "Adults newly initiating an IL-17, IL-23, or IL-12/23 inhibitor for psoriasis; 12-month baseline and follow-up; attrition, Table 1, treatment patterns.",
    provenance: { method: "manual" },
  },
  codeLists: [
    {
      id: "pso_dx",
      label: "Psoriasis diagnosis",
      system: "icd10cm",
      codes: [
        { code: "L40.0", description: "Psoriasis vulgaris", source: "user_entered", verified: true },
        { code: "L40.1", description: "Generalized pustular psoriasis", source: "user_entered", verified: true },
        { code: "L40.2", description: "Acrodermatitis continua", source: "user_entered", verified: true },
        { code: "L40.3", description: "Pustulosis palmaris et plantaris", source: "user_entered", verified: true },
        { code: "L40.4", description: "Guttate psoriasis", source: "user_entered", verified: true },
        { code: "L40.8", description: "Other psoriasis", source: "user_entered", verified: true },
        { code: "L40.9", description: "Psoriasis, unspecified", source: "user_entered", verified: true },
        { code: "696.1", description: "Other psoriasis (ICD-9)", source: "user_entered", verified: true },
      ],
      notes: "ICD-9 696.1 retained for pre-2015 lookback; DXVER handles the era split.",
    },
    {
      id: "index_biologics",
      label: "Index biologics (IL-17 / IL-23 / IL-12/23)",
      system: "drug_name",
      codes: [
        { code: "SECUKINUMAB|COSENTYX", description: "IL-17", source: "user_entered", verified: true },
        { code: "IXEKIZUMAB|TALTZ", description: "IL-17", source: "user_entered", verified: true },
        { code: "BRODALUMAB|SILIQ", description: "IL-17", source: "user_entered", verified: true },
        { code: "GUSELKUMAB|TREMFYA", description: "IL-23", source: "user_entered", verified: true },
        { code: "TILDRAKIZUMAB|ILUMYA", description: "IL-23", source: "user_entered", verified: true },
        { code: "RISANKIZUMAB|SKYRIZI", description: "IL-23", source: "user_entered", verified: true },
        { code: "USTEKINUMAB|STELARA", description: "IL-12/23", source: "user_entered", verified: true },
      ],
      notes: "Resolved to NDCs at runtime via a Redbook-style lookup (generated NDC-pull step).",
    },
    {
      id: "baseline_excl_drugs",
      label: "Baseline biologics & apremilast (exclusion)",
      system: "drug_name",
      codes: [
        { code: "ADALIMUMAB|HUMIRA", description: "TNFi", source: "user_entered", verified: true },
        { code: "ETANERCEPT|ENBREL", description: "TNFi", source: "user_entered", verified: true },
        { code: "INFLIXIMAB|REMICADE|INFLECTRA|RENFLEXIS|IXIFI", description: "TNFi", source: "user_entered", verified: true },
        { code: "CERTOLIZUMAB PEGOL|CIMZIA", description: "TNFi", source: "user_entered", verified: true },
        { code: "APREMILAST|OTEZLA", description: "PDE4 inhibitor", source: "user_entered", verified: true },
      ],
    },
  ],
  indexEvent: {
    type: "first_drug_claim",
    codeListId: "index_biologics",
    indexPeriod: { start: "2017-01-01", end: "2020-09-30" },
    description: "First claim of any index biologic in the index period; drug at first claim defines the index drug.",
  },
  enrollment: {
    baselineDays: 365,
    followupDays: 365,
    gapAllowanceDays: 31,
    requiresRxCoverage: true,
  },
  criteria: [
    {
      id: "inc_index_rx",
      kind: "inclusion",
      sourceText: ">=1 prescription of IL-23 or IL-17 or IL-12/23 inhibitor in the index period",
      test: {
        type: "drug", codeListId: "index_biologics", minClaims: 1,
        window: { start: 0, end: 0, includesIndex: true },
      },
      confidence: "high", reviewed: true,
    },
    {
      id: "inc_pso_dx",
      kind: "inclusion",
      sourceText: "At least 2 claims of PsO separated by >=1 days anytime on or before index date",
      test: {
        type: "diagnosis", codeListId: "pso_dx", minClaims: 2, claimSeparationDays: 1,
        setting: "any", window: { start: "anytime_before", end: 0, includesIndex: true },
      },
      confidence: "high", reviewed: true,
    },
    {
      id: "inc_enroll",
      kind: "inclusion",
      sourceText: "Continuous medical and pharmacy enrollment for at least 12 months prior to or on the index date and 12 months after",
      test: { type: "continuous_enrollment", baselineDays: 365, followupDays: 365, requiresRxCoverage: true },
      confidence: "high", reviewed: true,
    },
    {
      id: "inc_age",
      kind: "inclusion",
      sourceText: "Age >= 18 on index date",
      test: { type: "age_at_index", min: 18 },
      confidence: "high", reviewed: true,
    },
    {
      id: "exc_baseline_bio",
      kind: "exclusion",
      sourceText: "Exclude patients with exposure to biologics or apremilast in baseline",
      test: {
        type: "drug", codeListId: "baseline_excl_drugs", minClaims: 1,
        window: { start: -365, end: 0, includesIndex: true },
      },
      confidence: "high", reviewed: true,
    },
  ],
  baseline: [
    { id: "b_age", label: "Age at index", kind: "age" },
    { id: "b_sex", label: "Sex", kind: "sex" },
    { id: "b_region", label: "Region", kind: "region" },
    { id: "b_plan", label: "Plan type", kind: "plan_type" },
    { id: "b_year", label: "Index year", kind: "year" },
  ],
  outcomes: [],
  groupVars: [],
  comparisons: [],
  analyses: [
    { id: "a_attrition", label: "Attrition", kind: "attrition", enabled: true },
    { id: "a_table1", label: "Baseline characteristics", kind: "table1", enabled: true },
    // Recorded but disabled until their emitters land (P2+): visible in review, non-blocking.
    {
      id: "a_treatment_patterns", label: "Treatment patterns", kind: "future_stub",
      plannedKind: "treatment_switching", enabled: false,
      notes: "Switching, discontinuation (60-day gap), adherence (PDC) over 12-month follow-up.",
    },
    { id: "a_hcru_cost", label: "HCRU & cost", kind: "future_stub", plannedKind: "cost", enabled: false },
    { id: "a_km", label: "Kaplan-Meier survival", kind: "future_stub", plannedKind: "km_survival", enabled: false },
  ],
};
