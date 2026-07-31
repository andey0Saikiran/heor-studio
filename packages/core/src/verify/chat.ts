/**
 * Spec-chat guards — the proof that a model cannot mark its own work reviewed.
 *
 * `reviewed: true` and `verified: true` are the two flags code generation is
 * gated on, and the AI disclosure in every exported bundle reports them as
 * evidence of human oversight. A model emitting them is a forged signature, so
 * `sanitizeProposal` strips them. This file is the standing proof that it does,
 * written adversarially: each case is a proposal a cooperative, well-meaning
 * model would plausibly return.
 *
 * The last group is the one that matters most. A sanitizer that reset EVERY
 * flag would pass every safety test here and be useless in practice: one chat
 * message would discard an afternoon of review, analysts would either stop
 * using the chat or start re-ticking boxes without reading, and the flags would
 * mean less than before the feature existed. Surgical invalidation is a safety
 * property, not a convenience.
 */
import type { StudySpec, Criterion } from "../spec/types";
import { sanitizeProposal, diffSpecs, changesRequiringRereview } from "../spec/diff";
import { GOLD_A_SPEC } from "./fixture";
import type { Check } from "./run";

const clone = (s: StudySpec): StudySpec => JSON.parse(JSON.stringify(s)) as StudySpec;

/** Gold A with a human's review already recorded, which is the state worth protecting. */
function reviewedBase(): StudySpec {
  const s = clone(GOLD_A_SPEC);
  s.criteria = s.criteria.map((c) => ({ ...c, reviewed: true }));
  s.codeLists = s.codeLists.map((l) => ({ ...l, codes: l.codes.map((c) => ({ ...c, verified: true })) }));
  s.meta = { ...s.meta, provenance: { method: "manual" } };
  return s;
}

export function specChatGuards(): Check[] {
  const out: Check[] = [];
  const ok = (name: string, pass: boolean, detail: string) =>
    out.push({ name, status: pass ? "pass" : "fail", detail });

  const base = reviewedBase();
  const firstCrit = base.criteria[0] as Criterion;
  const firstList = base.codeLists[0];

  /* ---- 1. THE FORGERY: a model marks a NEW criterion reviewed ---- */
  {
    const p = clone(base);
    p.criteria.push({
      id: "chat_added", kind: "inclusion", sourceText: "Age 65 or older",
      test: { type: "age_at_index", min: 65 },
      confidence: "high",
      reviewed: true,        // <- the forgery
    });
    const r = sanitizeProposal(base, p);
    const added = r.spec.criteria.find((c) => c.id === "chat_added");
    ok("chat: a NEW criterion proposed as already-reviewed comes back UNREVIEWED",
      added?.reviewed === false, `reviewed=${added?.reviewed}`);
    ok("chat: and the forgery is REPORTED rather than quietly fixed",
      r.forged.some((f) => f.includes("chat_added")), r.forged.join(" | ") || "(nothing reported)");
  }

  /* ---- 2. THE FORGERY: a model marks a NEW code verified ---- */
  {
    const p = clone(base);
    p.codeLists[0].codes.push({ code: "Z99.9", description: "invented", source: "ai_suggested", verified: true });
    const r = sanitizeProposal(base, p);
    const added = r.spec.codeLists[0].codes.find((c) => c.code === "Z99.9");
    ok("chat: a NEW code proposed as already-verified comes back UNVERIFIED",
      added?.verified === false, `verified=${added?.verified}`);
    ok("chat: and that forgery is reported too",
      r.forged.some((f) => f.includes("Z99.9")), r.forged.join(" | ") || "(nothing reported)");
  }

  /* ---- 3. THE SUBTLE ONE: content changes, approval must not survive ----
   * This is the case that looks like cooperation. The model returns the spec
   * with every flag exactly as it found it - including the true ones - having
   * rewritten a criterion in between. Nothing looks wrong, and an analyst who
   * accepts a diff about one thing is left with approval on something they
   * never re-read. */
  {
    const p = clone(base);
    p.criteria[0] = { ...p.criteria[0], sourceText: "REWRITTEN protocol wording", reviewed: true };
    const r = sanitizeProposal(base, p);
    ok("chat: a criterion whose PROTOCOL TEXT was rewritten loses its review, even though the model left the flag true",
      r.spec.criteria[0].reviewed === false, `reviewed=${r.spec.criteria[0].reviewed}`);
    ok("chat: the invalidation names the criterion and says why",
      r.invalidated.some((i) => i.includes(firstCrit.id) && /content changed/.test(i)),
      r.invalidated.join(" | ") || "(nothing reported)");
  }
  {
    /* The test criterion is CONSTRUCTED rather than searched for. The first
     * version of this check looked for an existing criterion with a minClaims
     * field, and Gold A has none — every criterion there is
     * continuous_enrollment or age_at_index — so the search returned undefined,
     * the assertion short-circuited to `true`, and the check passed while
     * testing nothing. It reported "reviewed=undefined", which is what gave it
     * away. Building the fixture here means the check cannot go vacuous when a
     * gold spec changes shape underneath it. */
    const b = clone(base);
    b.criteria.push({
      id: "dx_rule", kind: "inclusion", sourceText: "At least 2 diagnosis claims",
      test: { type: "diagnosis", codeListId: b.codeLists[0].id, minClaims: 2, setting: "any",
              window: { start: -365, end: 0, includesIndex: true } },
      confidence: "high", reviewed: true,
    });
    const p = clone(b);
    const t = p.criteria.find((c) => c.id === "dx_rule");
    if (t && t.test.type === "diagnosis") t.test.minClaims = 99;
    const r = sanitizeProposal(b, p);
    const after = r.spec.criteria.find((c) => c.id === "dx_rule");
    ok("chat: a criterion whose TEST changed (minClaims 2 -> 99) loses its review",
      after !== undefined && after.reviewed === false,
      after === undefined ? "criterion not found — the check would be vacuous" : `reviewed=${after.reviewed}`);
    ok("chat: and the untouched criteria beside it keep theirs",
      r.spec.criteria.filter((c) => c.id !== "dx_rule").every((c) => c.reviewed),
      `${r.spec.criteria.filter((c) => c.id !== "dx_rule" && c.reviewed).length} of ${r.spec.criteria.length - 1} kept`);
  }

  /* ---- 4. THE SURGICAL PROPERTY: untouched review must SURVIVE ----
   * Without this the feature is unusable, and an unusable safety control is
   * one people route around. */
  {
    const p = clone(base);
    p.meta = { ...p.meta, title: "A new title, nothing else touched" };
    const r = sanitizeProposal(base, p);
    const allKept = r.spec.criteria.every((c) => c.reviewed) &&
      r.spec.codeLists.every((l) => l.codes.every((c) => c.verified));
    ok("chat: editing only the TITLE leaves every criterion reviewed and every code verified",
      allKept, `criteria reviewed=${r.spec.criteria.filter((c) => c.reviewed).length}/${r.spec.criteria.length}`);
    ok("chat: and nothing is reported as invalidated, because nothing was",
      r.invalidated.filter((i) => !i.startsWith("meta.provenance")).length === 0,
      r.invalidated.join(" | ") || "(none)");
  }
  {
    /* One added code must not cost the OTHER codes in the same list their
     * verification - the blast radius is the item, not the list. */
    const p = clone(base);
    const n = p.codeLists[0].codes.length;
    p.codeLists[0].codes.push({ code: "A00.0", source: "ai_suggested", verified: false });
    const r = sanitizeProposal(base, p);
    const kept = r.spec.codeLists[0].codes.filter((c) => c.verified).length;
    ok("chat: adding ONE code to a list leaves the list's other codes verified",
      kept === n, `${kept} of the original ${n} still verified`);
  }

  /* ---- 5. A model cannot silently GRANT approval on an untouched item ---- */
  {
    const b = clone(base);
    b.criteria[0] = { ...b.criteria[0], reviewed: false };   // human has NOT reviewed it
    const p = clone(b);
    p.criteria[0] = { ...p.criteria[0], reviewed: true };    // model flips it, changing nothing else
    const r = sanitizeProposal(b, p);
    ok("chat: a model flipping reviewed=true on an OTHERWISE UNCHANGED criterion is overruled",
      r.spec.criteria[0].reviewed === false, `reviewed=${r.spec.criteria[0].reviewed}`);
    ok("chat: and that attempt is reported as a forgery",
      r.forged.some((f) => /flag altered from false to true/.test(f)),
      r.forged.join(" | ") || "(nothing reported)");
  }

  /* ---- 6. PROVENANCE: the disclosure must stop saying "no model" ---- */
  {
    const p = clone(base);
    p.meta = { ...p.meta, title: "edited" };
    const r = sanitizeProposal(base, p);
    ok("chat: a chat-edited spec is no longer provenance 'manual', so the AI disclosure cannot claim no model was involved",
      r.spec.meta.provenance.method === "llm_assisted", `method=${r.spec.meta.provenance.method}`);
  }

  /* ---- 7. THE DIFF an analyst actually reads ---- */
  {
    const p = clone(base);
    p.criteria[0] = { ...p.criteria[0], sourceText: "REWRITTEN" };
    p.codeLists[0].codes.push({ code: "B01.1", source: "ai_suggested", verified: false });
    const r = sanitizeProposal(base, p);
    const changes = diffSpecs(base, r.spec);
    ok("chat: the diff reports BOTH the criterion rewrite and the added code",
      changes.some((c) => c.path === `criteria.${firstCrit.id}`) &&
      changes.some((c) => c.path === `codeLists.${firstList.id}.B01.1`),
      changes.map((c) => c.path).join(", "));
    const needing = changesRequiringRereview(changes);
    ok("chat: both are flagged as needing re-review, so the cost of accepting is visible BEFORE accepting",
      needing.length === 2, needing.map((c) => `${c.path}:${c.invalidates}`).join(" | "));
    ok("chat: and the criterion's summary says plainly that it must be read again",
      changes.some((c) => c.path === `criteria.${firstCrit.id}` && /must be read again/.test(c.summary)),
      changes.find((c) => c.path === `criteria.${firstCrit.id}`)?.summary.slice(0, 90) ?? "(no row)");
  }

  /* ---- 8. An identical spec is a NO-OP, not a wall of noise ---- */
  {
    const changes = diffSpecs(base, clone(base));
    ok("chat: an unchanged spec produces an EMPTY diff", changes.length === 0,
      changes.length === 0 ? "no rows" : changes.map((c) => c.path).join(", "));
  }

  /* ---- 9. Removals are surfaced, because they make a cohort LARGER ----
   * A dropped exclusion is the easiest change to accept without noticing and
   * the one most likely to move every number in the study. */
  {
    const p = clone(base);
    const dropped = p.criteria[p.criteria.length - 1];
    p.criteria = p.criteria.slice(0, -1);
    const changes = diffSpecs(base, p);
    ok("chat: a REMOVED criterion appears in the diff, and says the cohort gets larger",
      changes.some((c) => c.path === `criteria.${dropped.id}` && c.kind === "removed" && /larger/.test(c.summary)),
      changes.filter((c) => c.kind === "removed").map((c) => c.path).join(", ") || "(none)");
  }

  /* ---- 10. Index event and enrollment changes are called out as global ---- */
  {
    const p = clone(base);
    p.enrollment = { ...p.enrollment, baselineDays: p.enrollment.baselineDays + 1 };
    const changes = diffSpecs(base, p);
    ok("chat: an enrollment change is reported as moving every count downstream",
      changes.some((c) => c.path === "enrollment" && /every count downstream/.test(c.summary)),
      changes.find((c) => c.path === "enrollment")?.summary.slice(0, 80) ?? "(no row)");
  }

  return out;
}
