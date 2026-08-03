/**
 * The review queue — turning a gate into a conversation.
 *
 * Code generation is blocked until every criterion is marked reviewed and every
 * code verified. That gate is the product: the AI disclosure in every exported
 * bundle reports those counts as evidence of human oversight, and a spec chat
 * can never set them (see spec/diff.ts sanitizeProposal).
 *
 * As a FORM, the gate is a wall of checkboxes, and a wall of checkboxes gets
 * cleared without being read. This module presents the same gate as a queue of
 * one question at a time, each carrying the EVIDENCE needed to answer it.
 *
 * TWO THINGS MAKE THE DIFFERENCE BETWEEN A REAL REVIEW AND A RITUAL.
 *
 * 1. EVIDENCE TRAVELS WITH THE QUESTION. Asking "is this criterion right?" is
 *    not a review; it is a request for a yes. Each item carries the verbatim
 *    protocol sentence the extractor read, AND the plain-English restatement of
 *    the rule it produced, so the analyst is comparing two things rather than
 *    recalling one. Nearly every extraction error is visible in that comparison
 *    and invisible without it.
 *
 * 2. ORDER IS BY RISK, NOT BY POSITION. Attention is finite and runs out before
 *    the list does, so whatever sits at the bottom gets the least of it. Items
 *    are therefore ordered by how likely they are to be WRONG: an unmapped
 *    criterion first (the extractor could not read it at all), then low and
 *    medium confidence, then AI-suggested codes, and only then the things a
 *    human already typed. Alphabetical order would spend the analyst's best
 *    attention on whatever happened to start with "a".
 *
 * Nothing here writes a review flag on its own. `confirmItem` returns a NEW
 * spec and is only ever called from an explicit human answer.
 */
import type { StudySpec, Criterion, CodeEntry, CodeList } from "./types";
import { findCodeList } from "./types";

export type ReviewItemKind = "criterion" | "code";

export interface ReviewItem {
  kind: ReviewItemKind;
  /** criterion id, or `${listId}:${code}` for a code */
  id: string;
  /** the question to put to the analyst, in their language not the schema's */
  question: string;
  /** what the extractor READ — verbatim, never paraphrased */
  evidence: string;
  /** what the emitters will DO with it, in plain English */
  derived: string;
  /** why this one is near the front of the queue, when there is a reason */
  concern?: string;
  /** ordering key; lower is riskier and asked sooner */
  risk: number;
}

/* ------------------------------------------------------------------ *
 *  Plain-English restatement of a criterion's rule
 * ------------------------------------------------------------------ */

function windowPhrase(w: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean }): string {
  const start = w.start === "anytime_before" ? "any time before index" : w.start === 0 ? "the index date" : w.start < 0 ? `${-w.start} days before index` : `${w.start} days after index`;
  const end = w.end === "anytime_after" ? "any time after" : w.end === 0 ? "the index date" : w.end < 0 ? `${-w.end} days before index` : `${w.end} days after index`;
  return `from ${start} through ${end}${w.includesIndex ? ", including the index date" : ""}`;
}

function listLabel(spec: StudySpec, id: string): string {
  const l = findCodeList(spec, id);
  return l ? `"${l.label}"` : `an UNKNOWN code list ("${id}")`;
}

/** What the generated code will actually test. Deliberately concrete. */
export function describeCriterion(spec: StudySpec, c: Criterion): string {
  const t = c.test;
  switch (t.type) {
    case "diagnosis":
      return (
        `at least ${t.minClaims} diagnosis claim${t.minClaims === 1 ? "" : "s"} from ${listLabel(spec, t.codeListId)}` +
        (t.claimSeparationDays ? `, at least ${t.claimSeparationDays} day${t.claimSeparationDays === 1 ? "" : "s"} apart` : "") +
        (t.setting === "any" ? "" : `, ${t.setting} only`) +
        `, ${windowPhrase(t.window)}`
      );
    case "procedure":
      return `at least ${t.minClaims} procedure claim${t.minClaims === 1 ? "" : "s"} from ${listLabel(spec, t.codeListId)}${t.setting === "any" ? "" : `, ${t.setting} only`}, ${windowPhrase(t.window)}`;
    case "drug":
      return `at least ${t.minClaims} pharmacy claim${t.minClaims === 1 ? "" : "s"} for ${listLabel(spec, t.codeListId)}, ${windowPhrase(t.window)}`;
    case "age_at_index":
      if (t.min !== undefined && t.max !== undefined) return `age between ${t.min} and ${t.max} on the index date`;
      if (t.min !== undefined) return `age ${t.min} or older on the index date`;
      if (t.max !== undefined) return `age ${t.max} or younger on the index date`;
      return `an age rule with NO bound set, which excludes nobody`;
    case "sex":
      return `sex recorded as ${t.value === "M" ? "male" : "female"}`;
    case "continuous_enrollment":
      return `continuous enrollment for ${t.baselineDays} days of baseline (backward from and including index) and ${t.followupDays} days of follow-up (after index)${t.requiresRxCoverage ? ", with drug coverage throughout" : ", medical coverage only"}`;
    case "unmapped":
      return `NOTHING. The extractor could not turn this sentence into a rule, so no code will be generated for it`;
  }
}

/* ------------------------------------------------------------------ *
 *  The queue
 * ------------------------------------------------------------------ */

/* Risk bands. Lower is asked first. The gaps leave room to insert without
 * renumbering, and the ordering WITHIN a band is spec order, which is the
 * protocol's own order and therefore the one the analyst is thinking in. */
const RISK_UNMAPPED = 0;
const RISK_LOW_CONF = 10;
const RISK_MED_CONF = 20;
const RISK_EXCLUSION = 30;
const RISK_HIGH_CONF = 40;
const RISK_CODE_AI = 50;
const RISK_CODE_LOOKUP = 60;
const RISK_CODE_HUMAN = 70;

function criterionItem(spec: StudySpec, c: Criterion): ReviewItem {
  const derived = describeCriterion(spec, c);
  let risk = RISK_HIGH_CONF;
  let concern: string | undefined;

  const boundlessAge =
    c.test.type === "age_at_index" && c.test.min === undefined && c.test.max === undefined;

  if (c.test.type === "unmapped") {
    risk = RISK_UNMAPPED;
    concern = "The extractor could not map this sentence to a rule at all. Until it is mapped, this criterion does nothing and the cohort is larger than the protocol describes.";
  } else if (boundlessAge) {
    /* A mapped-but-inert rule is worse than an unmapped one: it looks like a
     * working age gate and excludes nobody. "adults with T2DM" with no numeric
     * bound lets pediatric members into the cohort while the panel calls it
     * routine. Surface it, do not bury it. */
    risk = RISK_LOW_CONF;
    concern = "This age rule has NO lower or upper bound, so it excludes nobody. If the protocol says 'adults' or names an age, set the bound; otherwise the cohort includes ages the protocol did not intend.";
  } else if (c.confidence === "low") {
    risk = RISK_LOW_CONF;
    concern = "The extractor was NOT confident about this one.";
  } else if (c.confidence === "medium") {
    risk = RISK_MED_CONF;
    concern = "The extractor was only moderately confident about this one.";
  } else if (c.kind === "exclusion") {
    /* An exclusion read too broadly removes patients silently, and the
     * attrition table shows the drop without saying it was wrong. */
    risk = RISK_EXCLUSION;
    concern = "This is an EXCLUSION. Read too broadly it quietly removes patients who belong in the study, and the attrition table will show the drop without flagging it as a mistake.";
  }

  return {
    kind: "criterion",
    id: c.id,
    question: `Does this ${c.kind} match your protocol?`,
    evidence: c.sourceText,
    derived,
    concern,
    risk,
  };
}

function codeItem(list: CodeList, code: CodeEntry): ReviewItem {
  let risk = RISK_CODE_HUMAN;
  let concern: string | undefined;
  if (code.source === "ai_suggested") {
    risk = RISK_CODE_AI;
    concern = "A model suggested this code. Nothing has checked it against a vocabulary.";
  } else if (code.source === "vocabulary_lookup") {
    risk = RISK_CODE_LOOKUP;
    concern = "This came from a vocabulary search, so the code exists. Whether it belongs in THIS list is still your call.";
  }
  return {
    kind: "code",
    id: `${list.id}:${code.code}`,
    question: `Does ${code.code} belong in "${list.label}"?`,
    evidence: code.description ? `${code.code} — ${code.description}` : code.code,
    derived: `Every patient with a claim carrying ${code.code} will match "${list.label}" wherever this list is used.`,
    concern,
    risk,
  };
}

/**
 * Everything still needing human sign-off, riskiest first.
 *
 * Empty means the gate is clear, which is exactly the condition
 * `specReadiness` checks for these two things.
 */
export function reviewQueue(spec: StudySpec): ReviewItem[] {
  const items: ReviewItem[] = [];
  spec.criteria.forEach((c) => { if (!c.reviewed) items.push(criterionItem(spec, c)); });
  spec.codeLists.forEach((l) => l.codes.forEach((c) => { if (!c.verified) items.push(codeItem(l, c)); }));
  /* Stable: equal risk keeps spec order, which is the protocol's order. A sort
   * that reordered equal items would make the queue jump around between
   * renders for no reason the analyst could see. */
  return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.risk - b.it.risk || a.i - b.i).map((x) => x.it);
}

/** How much is left, split the way the AI disclosure reports it. */
export function reviewProgress(spec: StudySpec): {
  criteriaTotal: number; criteriaDone: number;
  codesTotal: number; codesDone: number;
  remaining: number; clear: boolean;
} {
  const criteriaTotal = spec.criteria.length;
  const criteriaDone = spec.criteria.filter((c) => c.reviewed).length;
  const codesTotal = spec.codeLists.reduce((n, l) => n + l.codes.length, 0);
  const codesDone = spec.codeLists.reduce((n, l) => n + l.codes.filter((c) => c.verified).length, 0);
  const remaining = (criteriaTotal - criteriaDone) + (codesTotal - codesDone);
  return { criteriaTotal, criteriaDone, codesTotal, codesDone, remaining, clear: remaining === 0 };
}

/**
 * Record an answer. Returns a NEW spec; never mutates.
 *
 * `ok: false` is not the same as leaving it alone. It means the analyst LOOKED
 * and says it is wrong, so the flag stays false and the caller is expected to
 * do something about it (edit it, or ask the chat to). This function does not
 * silently drop the item from the queue, because an item that reappears is the
 * correct behaviour for something known to be wrong and not yet fixed.
 */
export function confirmItem(spec: StudySpec, itemId: string, kind: ReviewItemKind, ok: boolean): StudySpec {
  if (kind === "criterion") {
    return {
      ...spec,
      criteria: spec.criteria.map((c) => (c.id === itemId ? { ...c, reviewed: ok } : c)),
    };
  }
  const sep = itemId.indexOf(":");
  const listId = itemId.slice(0, sep);
  const code = itemId.slice(sep + 1);
  return {
    ...spec,
    codeLists: spec.codeLists.map((l) =>
      l.id !== listId ? l : { ...l, codes: l.codes.map((c) => (c.code === code ? { ...c, verified: ok } : c)) },
    ),
  };
}
