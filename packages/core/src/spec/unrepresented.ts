/**
 * "I CANNOT REPRESENT THIS."
 *
 * The audit's single highest-leverage finding: a real protocol routinely asks
 * for something the StudySpec schema cannot hold (a confirmatory outcome, a
 * pooled two-vendor analysis, an as-treated clock, lab covariates), and the tool
 * silently dropped it, marked the spec "ready", and exported it. It shipped a
 * green study that answered a different question.
 *
 * The fix is a gate, not a hundred schema extensions. When a construct cannot be
 * expressed, the tool must SAY SO and refuse to go ready until the analyst has
 * explicitly acknowledged that the generated code does not do it.
 *
 * There are two detection channels, because you cannot see what the schema
 * dropped by inspecting the schema-conformant spec:
 *
 *   1. THE MODEL (primary). Extraction reads the full protocol text and records
 *      what it could not express into `spec.unrepresented`. Only the model sees
 *      "the primary analysis is a fixed-effects meta-analysis pooling MarketScan
 *      and Optum", because that fact does not survive into any spec field.
 *
 *   2. THIS DETECTOR (deterministic safety net). It scans the text the spec DOES
 *      carry (criterion source sentences, outcome labels, code-list notes, the
 *      title) for the signatures of the known-dangerous constructs, so a hand-
 *      authored or chat-edited spec is gated too, and a construct the model
 *      forgot is still caught. It is deliberately conservative: a false refusal
 *      wastes a minute, a false "ready" ships a wrong study.
 *
 * Both feed one place: specReadiness refuses while any construct is
 * unacknowledged, and code generation and export are already gated on readiness.
 */
import type { StudySpec } from "./types";
import { stableHash } from "../provenance";

export type UnrepresentedCategory =
  | "outcome_algorithm"   // dx AND a lab/procedure within N days; composite/compound case definitions
  | "database"            // a non-MarketScan source, or a pooled / meta-analytic primary estimate
  | "censoring"           // as-treated / on-treatment / grace-period follow-up
  | "covariate"           // laboratory-value baseline covariates (LOINC)
  | "exposure"            // multi-level or pooled exposure the arm model cannot hold
  | "other";

export interface UnrepresentedConstruct {
  /** stable across re-detection, so an acknowledgement sticks to the right one */
  key: string;
  category: UnrepresentedCategory;
  /** short human label */
  label: string;
  /** the verbatim protocol text that triggered it (never paraphrased) */
  sourceText: string;
  /** what the schema cannot do and what the generated code does INSTEAD */
  detail: string;
  /** the analyst has explicitly accepted that the code does not do this */
  acknowledged: boolean;
  /** where it came from, for the disclosure */
  origin: "model" | "detector";
}

/** One piece of scannable text and where it lives, for the messages. */
interface TextBit { where: string; text: string }

function textBits(spec: StudySpec): TextBit[] {
  const bits: TextBit[] = [];
  if (spec.meta.title) bits.push({ where: "the study title", text: spec.meta.title });
  if (spec.meta.description) bits.push({ where: "the study description", text: spec.meta.description });
  for (const c of spec.criteria) if (c.sourceText) bits.push({ where: `criterion "${c.id}"`, text: c.sourceText });
  for (const o of spec.outcomes) {
    if (o.label) bits.push({ where: `outcome "${o.id}"`, text: o.label });
  }
  for (const l of spec.codeLists) {
    if (l.label) bits.push({ where: `code list "${l.id}"`, text: l.label });
    if (l.notes) bits.push({ where: `code list "${l.id}" notes`, text: l.notes });
  }
  for (const b of spec.baseline) if (b.label) bits.push({ where: `baseline covariate "${b.id}"`, text: b.label });
  return bits;
}

/* A temporal co-occurrence window: "within 7 days", "+/- 7 days", "within +/-7 days". */
const TEMPORAL = /(?:within\s*(?:\+\/?-|±)?\s*\d+\s*days?)|(?:(?:\+\/?-|±)\s*\d+\s*days?)/i;
/* A CONFIRMATORY second modality beside a diagnosis (labs, imaging, a second class of claim). */
const MODALITY = /\b(lipase|amylase|lab(?:oratory)?|loinc|ultrasound|imaging|radiograph|biopsy|culture|antivir\w*|antibiotic|dispensing|second\s+(?:diagnosis|claim|prescription)|confirmed\s+by|accompanied\s+by)\b/i;
/* Optum, a pool, or a meta-analytic estimate: DatabaseId is a MarketScan-only enum. */
const MULTI_DB = /\b(optum|clinformatics|pooled\s+(?:analysis|estimate|cohort|result)|meta[-\s]?analys[ie]s|fixed[-\s]?effects?|random[-\s]?effects?|across\s+(?:both\s+)?databases|two\s+databases)\b/i;
/* Laboratory-value baseline covariates. */
const LAB_COVAR = /\b(loinc|hba1c|a1c\b|triglycerid\w*|creatinine|(?:ldl|hdl)\b|c-?reactive)\b/i;
/* As-treated / grace-period follow-up: PersonTimeRule cannot express it. */
const AS_TREATED = /\b(as[-\s]?treated|on[-\s]?treatment|grace[-\s]?period|treatment\s+discontinuation|censor\w*\s+at\s+(?:treatment|drug|discontinuation|switch))\b/i;

function makeKey(category: string, sourceText: string): string {
  /* Keyed on the category and a normalized snippet, so the same construct keeps
   * the same key across re-detection and the acknowledgement holds. */
  const norm = sourceText.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
  return `${category}:${stableHash(norm)}`;
}

function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 240 ? t.slice(0, 237) + "…" : t;
}

/**
 * Deterministically detect constructs the schema cannot express, from the text
 * the spec carries. Conservative by design. Never mutates.
 */
export function detectUnrepresented(spec: StudySpec): UnrepresentedConstruct[] {
  const found: UnrepresentedConstruct[] = [];
  const seen = new Set<string>();
  const add = (category: UnrepresentedCategory, label: string, bit: TextBit, detail: string) => {
    const key = makeKey(category, bit.text);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ key, category, label, sourceText: snippet(bit.text), detail, acknowledged: false, origin: "detector" });
  };

  for (const bit of textBits(spec)) {
    const t = bit.text;

    /* Confirmatory / composite outcome: a diagnosis PLUS a lab or procedure in a
     * co-occurrence window. OutcomeDefinition holds ONE code list and no second
     * component or window, so the confirmation is silently dropped and every
     * coded mention counts as a case. Scoped to the case definition, not to a
     * washout (a washout says "within N days" too but names no lab modality). */
    if (TEMPORAL.test(t) && MODALITY.test(t)) {
      add("outcome_algorithm", "Confirmatory / composite case definition", bit,
        `This reads as a case definition that requires more than one event in a time window (in ${bit.where}). ` +
        `The schema binds an outcome to a single code list with no confirmatory component and no co-occurrence window, ` +
        `so the generated code counts EVERY coded mention as a case and drops the confirmation. That inflates the numerator ` +
        `in exactly the direction the algorithm exists to prevent.`);
    }

    if (MULTI_DB.test(t)) {
      add("database", "Non-MarketScan source or a pooled / meta-analytic estimate", bit,
        `This names a database or analysis (in ${bit.where}) that the schema cannot hold: meta.database is a single ` +
        `MarketScan value and there is no meta-analysis analysis kind. The generated code runs against ONE MarketScan ` +
        `database only; any Optum arm and any pooled or meta-analytic primary estimate is not produced.`);
    }

    if (LAB_COVAR.test(t)) {
      add("covariate", "Laboratory-value baseline covariate", bit,
        `This names a laboratory value (in ${bit.where}). Baseline characteristics have no lab-result kind and there is ` +
        `no LOINC code system, so a lab covariate is dropped or mis-mapped. Table 1 and any adjusted model differ from ` +
        `the protocol, with the lab block silently absent.`);
    }

    if (AS_TREATED.test(t)) {
      add("censoring", "As-treated / grace-period follow-up", bit,
        `This describes an as-treated or grace-period follow-up clock (in ${bit.where}). PersonTimeRule can only censor at ` +
        `outcome, disenrollment, death, study end or a fixed maximum, with no drug-discontinuation or switch term, so ` +
        `person-time is computed for a follow-up definition the protocol rejected. Person-time is the denominator of every rate.`);
    }
  }
  return found;
}

/**
 * The open (unacknowledged) constructs, from BOTH channels: the model-recorded
 * `spec.unrepresented` and a fresh deterministic detection, deduped by key. This
 * is what readiness gates on and what the UI shows.
 */
export function openLimitations(spec: StudySpec): UnrepresentedConstruct[] {
  const stored = spec.unrepresented ?? [];
  const byKey = new Map<string, UnrepresentedConstruct>();
  for (const c of stored) byKey.set(c.key, c);
  for (const d of detectUnrepresented(spec)) if (!byKey.has(d.key)) byKey.set(d.key, d);
  return [...byKey.values()].filter((c) => !c.acknowledged);
}

/**
 * Fold freshly-detected constructs into `spec.unrepresented` (unacknowledged, and
 * without disturbing an existing acknowledgement) so they can be persisted and
 * acknowledged in the UI. Call after extraction and after every chat edit. Pure.
 */
export function mergeUnrepresented(spec: StudySpec): StudySpec {
  const stored = spec.unrepresented ?? [];
  const byKey = new Map<string, UnrepresentedConstruct>();
  for (const c of stored) byKey.set(c.key, c);
  for (const d of detectUnrepresented(spec)) if (!byKey.has(d.key)) byKey.set(d.key, d);
  return { ...spec, unrepresented: [...byKey.values()] };
}

/** Record the analyst's explicit acknowledgement of one limitation. Pure. */
export function acknowledgeLimitation(spec: StudySpec, key: string): StudySpec {
  const merged = mergeUnrepresented(spec);
  return {
    ...merged,
    unrepresented: (merged.unrepresented ?? []).map((c) => (c.key === key ? { ...c, acknowledged: true } : c)),
  };
}
