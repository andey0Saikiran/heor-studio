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
}

export type AnalysisType =
  | "attrition"                // CONSORT-style sequential cohort counts
  | "table1"                   // baseline characteristics
  | "treatment_patterns"       // switching / discontinuation / adherence (PDC)
  | "incidence_prevalence"
  | "hcru_cost"                // healthcare resource utilization + cost
  | "km_survival"
  | "cox_model";

export interface AnalysisRequest {
  type: AnalysisType;
  enabled: boolean;
  /** Free-text notes carried from the protocol (e.g. outcome definition details). */
  notes?: string;
}

export interface StudySpec {
  meta: {
    title: string;
    version: string;             // spec version, bump on every edit
    database: DatabaseId;
    studyPeriod: { start: string; end: string };  // ISO dates, absolute claim window
    description?: string;
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
  analyses: AnalysisRequest[];
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
  return { ready: problems.length === 0, problems };
}
