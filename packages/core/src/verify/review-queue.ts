/**
 * Review-queue guards.
 *
 * The queue turns the review gate from a wall of checkboxes into one question
 * at a time. Two properties make that a real review rather than a ritual, and
 * both are easy to lose in a refactor that looks harmless:
 *
 *   - EVIDENCE travels with every question. Without the verbatim protocol
 *     sentence beside the derived rule, "is this right?" is a request for a
 *     yes rather than a question.
 *   - ORDER is by risk. Attention runs out before the list does, so the item
 *     asked last gets the least of it. An unmapped criterion must never sit
 *     behind thirty routine codes.
 */
import type { StudySpec } from "../spec/types";
import { reviewQueue, reviewProgress, confirmItem, describeCriterion } from "../spec/review-queue";
import { specReadiness } from "../spec/types";
import { GOLD_A_SPEC } from "./fixture";
import type { Check } from "./run";

const clone = (s: StudySpec): StudySpec => JSON.parse(JSON.stringify(s)) as StudySpec;

/** Gold A with nothing signed off yet, which is the state after extraction. */
function unreviewed(): StudySpec {
  const s = clone(GOLD_A_SPEC);
  s.criteria = s.criteria.map((c) => ({ ...c, reviewed: false }));
  s.codeLists = s.codeLists.map((l) => ({ ...l, codes: l.codes.map((c) => ({ ...c, verified: false })) }));
  return s;
}

export function reviewQueueGuards(): Check[] {
  const out: Check[] = [];
  const ok = (name: string, pass: boolean, detail: string) =>
    out.push({ name, status: pass ? "pass" : "fail", detail });

  const base = unreviewed();

  /* ---- the queue covers exactly what readiness blocks on ---- */
  {
    const q = reviewQueue(base);
    const p = reviewProgress(base);
    ok("review: the queue holds every unreviewed criterion and unverified code",
      q.length === p.remaining && p.remaining === base.criteria.length + base.codeLists.reduce((n, l) => n + l.codes.length, 0),
      `${q.length} queued, ${p.remaining} outstanding`);
    ok("review: a fully signed-off spec has an EMPTY queue",
      reviewQueue(GOLD_A_SPEC).length === 0 && reviewProgress(GOLD_A_SPEC).clear,
      `${reviewQueue(GOLD_A_SPEC).length} left on the reviewed gold spec`);
  }

  /* ---- EVIDENCE: every question carries what it is asking about ---- */
  {
    const q = reviewQueue(base);
    const missingEvidence = q.filter((i) => !i.evidence || i.evidence.trim().length === 0);
    ok("review: every item carries its own evidence, so confirming means comparing rather than recalling",
      missingEvidence.length === 0,
      missingEvidence.length === 0 ? `all ${q.length} items` : missingEvidence.map((i) => i.id).join(", "));
    const missingDerived = q.filter((i) => !i.derived || i.derived.trim().length === 0);
    ok("review: and the plain-English restatement of what the code will DO",
      missingDerived.length === 0,
      missingDerived.length === 0 ? `all ${q.length} items` : missingDerived.map((i) => i.id).join(", "));
    /* The criterion evidence must be the PROTOCOL's words, not ours. A
     * paraphrase on both sides of the comparison would agree with itself. */
    const crit = q.filter((i) => i.kind === "criterion");
    const verbatim = crit.every((i) => base.criteria.some((c) => c.id === i.id && c.sourceText === i.evidence));
    ok("review: criterion evidence is the VERBATIM protocol sentence, not a paraphrase of our own rule",
      verbatim, verbatim ? `${crit.length} criteria` : "some evidence did not match sourceText");
  }

  /* ---- ORDER: risk first, and the riskiest thing there is goes first ---- */
  {
    const s = unreviewed();
    /* An unmapped criterion is the worst case: the extractor read a sentence
     * and produced no rule, so the criterion silently does nothing. */
    s.criteria.push({
      id: "z_unmapped", kind: "inclusion", sourceText: "Patients must have documented moderate-to-severe disease",
      test: { type: "unmapped" }, confidence: "low", reviewed: false,
    });
    s.criteria.push({
      id: "z_lowconf", kind: "inclusion", sourceText: "Some ambiguous requirement",
      test: { type: "age_at_index", min: 18 }, confidence: "low", reviewed: false,
    });
    const q = reviewQueue(s);
    ok("review: the UNMAPPED criterion is asked FIRST, ahead of everything",
      q[0]?.id === "z_unmapped", `first item is "${q[0]?.id}"`);
    ok("review: and it says plainly that it currently does nothing",
      /could not/i.test(q[0]?.concern ?? "") && /NOTHING/.test(q[0]?.derived ?? ""),
      (q[0]?.derived ?? "").slice(0, 80));

    const iLow = q.findIndex((i) => i.id === "z_lowconf");
    const iCode = q.findIndex((i) => i.kind === "code");
    ok("review: low-confidence criteria come before routine code checks",
      iLow >= 0 && iCode >= 0 && iLow < iCode, `low-confidence at ${iLow}, first code at ${iCode}`);
  }
  {
    /* AI-suggested codes ahead of ones a human typed: nothing has checked the
     * former against a vocabulary. */
    const s = unreviewed();
    s.codeLists[0].codes = [
      { code: "H00.0", source: "user_entered", verified: false },
      { code: "A99.9", source: "ai_suggested", verified: false },
    ];
    const q = reviewQueue(s).filter((i) => i.kind === "code" && i.id.startsWith(`${s.codeLists[0].id}:`));
    ok("review: an AI-suggested code is asked before one a human typed",
      q[0]?.id.endsWith("A99.9"), q.map((i) => i.id).join(" then "));
    ok("review: and the AI-suggested one says nothing has checked it",
      /model suggested/i.test(q[0]?.concern ?? ""), q[0]?.concern?.slice(0, 70) ?? "(no concern)");
  }
  {
    /* Exclusions ahead of high-confidence inclusions: read too broadly they
     * remove patients silently and the attrition table shows only the drop. */
    const s = unreviewed();
    s.criteria = [
      { id: "inc_hi", kind: "inclusion", sourceText: "Adults 18+", test: { type: "age_at_index", min: 18 }, confidence: "high", reviewed: false },
      { id: "exc_hi", kind: "exclusion", sourceText: "No prior biologic", test: { type: "age_at_index", max: 200 }, confidence: "high", reviewed: false },
    ];
    const q = reviewQueue(s).filter((i) => i.kind === "criterion");
    ok("review: a high-confidence EXCLUSION is asked before a high-confidence inclusion",
      q[0]?.id === "exc_hi", q.map((i) => i.id).join(" then "));
  }

  /* ---- ORDER IS STABLE: equal risk keeps the protocol's own order ---- */
  {
    const q1 = reviewQueue(base).map((i) => i.id).join("|");
    const q2 = reviewQueue(base).map((i) => i.id).join("|");
    ok("review: the queue is stable across calls, so it does not reshuffle under the analyst",
      q1 === q2, q1 === q2 ? "identical" : "ORDER MOVED between two calls on the same spec");
  }

  /* ---- CONFIRMING: one item at a time, and it actually moves the gate ---- */
  {
    const q = reviewQueue(base);
    const first = q[0];
    const after = confirmItem(base, first.id, first.kind, true);
    const q2 = reviewQueue(after);
    ok("review: confirming one item removes exactly that item",
      q2.length === q.length - 1 && !q2.some((i) => i.id === first.id),
      `${q.length} -> ${q2.length}`);
    ok("review: and nothing else changed its answer",
      JSON.stringify(q.slice(1).map((i) => i.id)) === JSON.stringify(q2.map((i) => i.id)),
      "remaining order preserved");
    /* The original spec must be untouched: the caller holds it and a mutation
     * here would flip a review flag nobody answered. */
    ok("review: confirming does NOT mutate the spec it was given",
      reviewQueue(base).length === q.length, `original still has ${reviewQueue(base).length}`);
  }
  {
    /* Answering NO is not the same as skipping. The item is known-wrong and
     * must keep coming back until something is done about it. */
    const q = reviewQueue(base);
    const first = q[0];
    const after = confirmItem(base, first.id, first.kind, false);
    ok("review: answering NO leaves the item in the queue, because it is now known to be wrong",
      reviewQueue(after).some((i) => i.id === first.id), `"${first.id}" still queued`);
  }

  /* ---- CLEARING THE QUEUE CLEARS THE GATE ---- */
  {
    let s = unreviewed();
    let guard = 0;
    for (;;) {
      const q = reviewQueue(s);
      if (q.length === 0 || guard++ > 500) break;
      s = confirmItem(s, q[0].id, q[0].kind, true);
    }
    const r = specReadiness(s);
    ok("review: clearing the queue one answer at a time makes the spec READY",
      reviewQueue(s).length === 0 && r.ready,
      r.ready ? `queue empty after ${guard} answers, readiness ready` : `readiness still blocked: ${r.problems.slice(0, 2).join("; ")}`);
  }

  /* ---- the derived sentence is concrete enough to disagree with ---- */
  {
    const s = unreviewed();
    const dx = s.criteria.find((c) => c.test.type === "continuous_enrollment");
    if (dx) {
      const d = describeCriterion(s, dx);
      ok("review: an enrollment rule is restated with its actual day counts, not as 'continuous enrollment'",
        /\d+ days of baseline/.test(d) && /\d+ days of follow-up/.test(d), d.slice(0, 110));
    } else {
      ok("review: an enrollment rule is restated with its actual day counts", false,
        "no continuous_enrollment criterion in the fixture — this check is vacuous, fix the fixture");
    }
  }

  return out;
}
