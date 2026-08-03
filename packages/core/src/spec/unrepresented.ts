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

/** Where a piece of text lives, so a detector fires only where it makes sense.
 *  The regex-scan approach leaks both ways unless it is scoped: an incidental
 *  "creatinine" in a diagnosis criterion is not a lab covariate, and a drug
 *  washout is not a confirmatory outcome. Role scoping is what stops the
 *  fail-closed noise that trains blanket acknowledge-click-through. */
type BitRole = "meta" | "inclusion" | "exclusion" | "outcome" | "codelist" | "baseline" | "analysis";
interface TextBit { where: string; text: string; role: BitRole }

function textBits(spec: StudySpec): TextBit[] {
  const bits: TextBit[] = [];
  if (spec.meta.title) bits.push({ where: "the study title", text: spec.meta.title, role: "meta" });
  if (spec.meta.description) bits.push({ where: "the study description", text: spec.meta.description, role: "meta" });
  for (const c of spec.criteria)
    if (c.sourceText) bits.push({ where: `criterion "${c.id}"`, text: c.sourceText, role: c.kind === "exclusion" ? "exclusion" : "inclusion" });
  for (const o of spec.outcomes) if (o.label) bits.push({ where: `outcome "${o.id}"`, text: o.label, role: "outcome" });
  for (const l of spec.codeLists) {
    const role: BitRole = l.role === "outcome" ? "outcome" : l.role === "covariate" ? "baseline" : "codelist";
    if (l.label) bits.push({ where: `code list "${l.id}"`, text: l.label, role });
    if (l.notes) bits.push({ where: `code list "${l.id}" notes`, text: l.notes, role });
  }
  for (const b of spec.baseline) if (b.label) bits.push({ where: `baseline covariate "${b.id}"`, text: b.label, role: "baseline" });
  /* analyses[].notes is documented as verbatim SAP text, and it was the ONE
   * un-paraphrased field the net did not scan, so an as-treated clause parked
   * there sailed through. */
  for (const a of spec.analyses) {
    if (a.label) bits.push({ where: `analysis "${a.id}"`, text: a.label, role: "analysis" });
    const notes = (a as { notes?: string }).notes;
    if (notes) bits.push({ where: `analysis "${a.id}" notes`, text: notes, role: "analysis" });
  }
  return bits;
}

/* A temporal co-occurrence window: "within 7 days", "+/- 7 days", "within one week". */
const TEMPORAL = /(?:within\s*(?:\+\/?-|±)?\s*(?:\d+\s*(?:days?|d\b|weeks?|wks?)|(?:one|two|three|a)\s+(?:days?|weeks?)))|(?:(?:\+\/?-|±)\s*\d+\s*(?:days?|d\b))/i;
/* A LABORATORY or imaging confirmation beside a diagnosis. Deliberately NOT drug
 * dispensing or antibiotics: those are ordinary washouts the schema CAN express,
 * and including them fired on every day-phrased drug exclusion (fail-closed). */
const CONFIRM_MODALITY = /\b(lipase|amylase|troponin|hba1c|glucose|creatinine|elevated\s+(?:serum|blood)?\s*\w+|lab(?:oratory)?\s+(?:value|result|confirm\w*|test)|biopsy|culture|ultrasound|imaging|radiograph|endoscop\w*)\b/i;
/* An explicit confirmatory conjunction, so a composite case definition is caught
 * even when it names no day count ("confirmed by an elevated lipase", "> 3x ULN"). */
const CONFIRM_PHRASE = /\b(confirmed\s+by|accompanied\s+by|defined\s+by|in\s+the\s+presence\s+of|together\s+with|(?:greater\s+than|>|≥|>=)\s*\d+\s*(?:x|times)\s*(?:the\s+)?(?:upper\s+limit|uln)|x\s*uln)\b/i;
/* Optum, another vendor, a pool, or a meta-analytic estimate: DatabaseId is a
 * MarketScan-only enum and there is no meta-analysis analysis kind. */
const MULTI_DB = /\b(optum|clinformatics|truven|merative|pharmetrics|ibm\s+watson|marketscan\s+and\s+\w|pooled?\s+(?:analysis|estimate|cohort|result|across|data)|pooling|meta[-\s]?analy\w+|fixed[-\s]?effects?|random[-\s]?effects?|(?:across|both|two|second|multiple)\s+(?:us\s+)?(?:commercial\s+)?(?:claims\s+)?(?:databases?|data\s+sources?))\b/i;
/* Laboratory-value baseline covariates. Broadened past named analytes to the
 * generic phrasings a protocol uses, but scanned ONLY in baseline-role text so
 * an incidental analyte in a diagnosis criterion does not trip it. */
const LAB_COVAR = /\b(loinc|hba1c|a1c\b|glycated\s+h[ae]moglobin|triglycerid\w*|creatinine|egfr|estimated\s+gfr|(?:ldl|hdl)\b|c-?reactive|lipase|amylase|serum\s+\w+|lab(?:oratory)?\s+(?:value|result|test|panel|measure)s?)\b/i;
/* As-treated / grace-period follow-up: PersonTimeRule cannot express it. */
const AS_TREATED = /\b(as[-\s]?treated|on[-\s]?(?:treatment|drug)|grace[-\s]?period|treatment\s+(?:discontinuation|cessation)|discontinu\w*\s+(?:plus|\+)\s*\d+|censor\w*\s+at\s+(?:treatment|drug|discontinuation|switch|cessation))\b/i;

function makeKey(category: string, sourceText: string): string {
  /* Keyed on the category and the FULL normalized text (not a 200-char prefix:
   * two clauses differing only past char 200 — a 30-day vs a 90-day grace — used
   * to collapse to one key, so an acknowledgement of one silently cleared the
   * other). */
  const norm = sourceText.trim().toLowerCase().replace(/\s+/g, " ");
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

  /* STRUCTURAL, not textual: a group variable with more than two levels cannot
   * be an active-comparator arm axis, and the descriptive rate emitters pool all
   * levels. This one is reliable because it reads a TYPED field, not prose, so it
   * neither evades on a paraphrase nor false-fires on an incidental word. */
  for (const g of spec.groupVars) {
    if (g.levels.length > 2) {
      const key = `exposure:${stableHash(`${g.id}:${g.levels.join("|")}`)}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({
          key, category: "exposure",
          label: "Exposure with more than two levels",
          sourceText: snippet(`${g.label}: ${g.levels.join(", ")}`),
          detail:
            `Group variable "${g.id}" declares ${g.levels.length} levels. Inferential models are held to a two-level ` +
            `contrast, and the descriptive rate emitters carry no arm axis at all, so they pool every level into one ` +
            `number. A three-arm or pooled-comparator design is not produced as such.`,
          acknowledged: false, origin: "detector",
        });
      }
    }
  }

  for (const bit of textBits(spec)) {
    const t = bit.text;

    /* Confirmatory / composite outcome: a condition PLUS a lab/imaging
     * confirmation the single-code-list OutcomeDefinition cannot express.
     *
     * NOT role-scoped. An earlier version fired only on outcome/inclusion text,
     * which REGRESSED coverage: the confirmatory case definition parked in a
     * code-list note, an analysis note, or the study description sailed through.
     * It now scans every role, held off exclusions and washouts by the lead-word
     * guard alone (CONFIRM_MODALITY already excludes drug dispensing).
     *
     * The trigger is a confirmatory LINK, not merely a lab word beside a date.
     * "At least one HbA1c test within 90 days" names a lab and a window and is
     * perfectly representable as a procedure-presence criterion, so lab + date
     * used to false-fire on it. A composite case definition instead carries a
     * conjunction between two clinical events ("... AND a lipase within 7 days")
     * or an explicit confirmatory phrase ("confirmed by an elevated lipase",
     * "> 3x ULN"). Require one of those. */
    if (!/^\s*(no|without|exclud|absence of)\b/i.test(t) &&
        CONFIRM_MODALITY.test(t) &&
        (CONFIRM_PHRASE.test(t) || (TEMPORAL.test(t) && /\b(and|plus|as well as|together with|accompanied)\b/i.test(t)))) {
      add("outcome_algorithm", "Confirmatory / composite case definition", bit,
        `This reads as a case definition that requires a diagnosis together with a lab or procedure (in ${bit.where}). ` +
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

    /* Lab covariates only in BASELINE text. An incidental "creatinine clearance"
     * in a renal exclusion or a T2DM criterion is representable and must not fire. */
    if ((bit.role === "baseline") && LAB_COVAR.test(t)) {
      add("covariate", "Laboratory-value baseline covariate", bit,
        `This names a laboratory value used as a covariate (in ${bit.where}). Baseline characteristics have no lab-result ` +
        `kind and there is no LOINC code system, so a lab covariate is dropped or mis-mapped. Table 1 and any adjusted ` +
        `model differ from the protocol, with the lab block silently absent.`);
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
  /* STRICT boolean: only a literal `true` counts as acknowledged. `!c.acknowledged`
   * would treat the string "false" (or any truthy non-boolean that slipped past
   * an un-validated restore path) as acknowledged and clear the block. */
  return [...byKey.values()].filter((c) => c.acknowledged !== true);
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
