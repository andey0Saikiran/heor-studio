/**
 * Spec diffing, and the rule that keeps a chat honest.
 *
 * WHY A CHAT EDITS THE SPEC AND NEVER THE CODE. Generated SAS and SQL are a
 * pure function of the reviewed spec, and every verification guarantee in this
 * project stands on that: the PARITY stamps compare two twins derived from one
 * spec, the fingerprints scrape values out of emitted text and check them
 * against the spec's parameters, and the mutation tests prove corruption of the
 * emitted code turns the suite red. A chat that edited generated code would
 * break all three at once, and the "regenerate rather than hand-edit" line in
 * every file header would become false. So natural language goes in, a PROPOSED
 * SPEC comes out, and the emitters run again from it.
 *
 * THE RULE THIS FILE EXISTS FOR: A MODEL MAY NEVER MARK ITS OWN WORK REVIEWED.
 *
 * `reviewed: true` on a criterion and `verified: true` on a code are the two
 * flags the whole product is gated on — `specReadiness` refuses to generate
 * code without them, and the AI disclosure in every bundle reports them as
 * evidence of human oversight. They are assertions ABOUT A HUMAN, so a model
 * emitting them is not a bug in the model, it is a forged signature.
 *
 * A language model asked to "add a psoriasis code" will very reasonably return
 * the whole spec back with every flag exactly as it found it, including the
 * true ones. That is the dangerous case, because it looks like cooperation:
 * nothing is obviously wrong, the analyst accepts a diff about one code, and a
 * criterion they never re-read is still carrying their approval.
 *
 * So `sanitizeProposal` is applied to every proposal before a human sees it:
 *
 *   - a criterion whose CONTENT changed comes back `reviewed: false`, whatever
 *     the model said;
 *   - a code that is new or whose text changed comes back `verified: false`;
 *   - anything UNCHANGED keeps the flag the human already gave it.
 *
 * That last clause is not a detail. A sanitizer that reset everything would be
 * trivially safe and completely useless: one chat message would discard an
 * afternoon of review, and analysts would stop using the chat, or worse, start
 * re-ticking boxes without reading. The invalidation has to be surgical to be
 * survivable.
 */
import type { StudySpec, Criterion, CodeList, CodeEntry, Analysis } from "./types";

/** One reviewable change between two specs. */
export interface SpecChange {
  /** dotted path, e.g. `criteria.inc_pso_dx.test.minClaims` */
  path: string;
  kind: "added" | "removed" | "changed";
  /** what a person needs to re-do because of this change */
  invalidates: "criterion_review" | "code_verification" | "none";
  before?: string;
  after?: string;
  /** one plain sentence, for the review UI */
  summary: string;
}

/* ------------------------------------------------------------------ *
 *  Value rendering
 * ------------------------------------------------------------------ */

/** Stable, readable rendering of a spec value for a diff row. */
function show(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (v === null) return "(null)";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  return JSON.stringify(v);
}

/** Deep equality over plain JSON values, key order independent. */
function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/* ------------------------------------------------------------------ *
 *  The criterion identity question
 * ------------------------------------------------------------------ */

/**
 * Everything about a criterion EXCEPT the review flag itself.
 *
 * This is what decides whether a human's approval still applies. Comparing the
 * whole object would be circular — flipping `reviewed` would count as a change
 * that invalidates `reviewed` — and comparing only `test` would miss a rewrite
 * of `sourceText`, which is the verbatim protocol language the analyst read
 * when they ticked the box. If the quoted protocol text changes, the thing they
 * approved is not the thing that is now in the spec.
 */
function criterionSubstance(c: Criterion): string {
  return stable({ id: c.id, kind: c.kind, sourceText: c.sourceText, test: c.test, confidence: c.confidence });
}

/** A code's substance, likewise excluding its own verification flag. */
function codeSubstance(c: CodeEntry): string {
  return stable({ code: c.code, description: c.description ?? "", source: c.source });
}

/* ------------------------------------------------------------------ *
 *  sanitizeProposal — the load-bearing function
 * ------------------------------------------------------------------ */

export interface SanitizeResult {
  spec: StudySpec;
  /** flags the model set that were stripped, for the UI to show plainly */
  forged: string[];
  /** flags reset because the thing they applied to changed */
  invalidated: string[];
}

/**
 * Force a proposed spec's review state to be earned rather than asserted.
 *
 * Returns the corrected spec plus what was corrected, because a UI that
 * silently fixed this would be hiding the one thing worth telling the analyst:
 * that the model tried to hand back their signature.
 */
export function sanitizeProposal(before: StudySpec, proposed: StudySpec): SanitizeResult {
  const forged: string[] = [];
  const invalidated: string[] = [];

  const priorCrit = new Map(before.criteria.map((c) => [c.id, c]));
  const criteria: Criterion[] = proposed.criteria.map((c) => {
    const old = priorCrit.get(c.id);
    if (!old) {
      /* A brand-new criterion cannot carry approval: nobody has read it. */
      if (c.reviewed) forged.push(`criteria.${c.id}.reviewed (new criterion, proposed as already reviewed)`);
      return { ...c, reviewed: false };
    }
    if (criterionSubstance(old) !== criterionSubstance(c)) {
      /* Changed. The approval was for the OLD wording or the OLD test. */
      if (c.reviewed) invalidated.push(`criteria.${c.id}.reviewed (its content changed)`);
      return { ...c, reviewed: false };
    }
    /* Unchanged. Keep exactly what the human said, and ignore the model
     * entirely — including a model that helpfully tried to set it to true. */
    if (c.reviewed !== old.reviewed) {
      forged.push(`criteria.${c.id}.reviewed (unchanged criterion, flag altered from ${old.reviewed} to ${c.reviewed})`);
    }
    return { ...c, reviewed: old.reviewed };
  });

  const priorLists = new Map(before.codeLists.map((l) => [l.id, l]));
  const codeLists: CodeList[] = proposed.codeLists.map((l) => {
    const oldList = priorLists.get(l.id);
    const priorCodes = new Map((oldList?.codes ?? []).map((c) => [c.code, c]));
    const codes: CodeEntry[] = l.codes.map((c) => {
      const old = priorCodes.get(c.code);
      if (!old) {
        if (c.verified) forged.push(`codeLists.${l.id}.${c.code}.verified (new code, proposed as already verified)`);
        return { ...c, verified: false };
      }
      if (codeSubstance(old) !== codeSubstance(c)) {
        if (c.verified) invalidated.push(`codeLists.${l.id}.${c.code}.verified (its definition changed)`);
        return { ...c, verified: false };
      }
      if (c.verified !== old.verified) {
        forged.push(`codeLists.${l.id}.${c.code}.verified (unchanged code, flag altered from ${old.verified} to ${c.verified})`);
      }
      return { ...c, verified: old.verified };
    });
    return { ...l, codes };
  });

  /* Provenance: a spec touched by a model is no longer "manual", and the AI
   * disclosure in the exported bundle reads this field. Left alone, a chat-
   * edited spec would ship a disclosure saying no model was involved. */
  const meta = { ...proposed.meta };
  if (meta.provenance?.method === "manual") {
    meta.provenance = { ...meta.provenance, method: "llm_assisted" };
    invalidated.push(`meta.provenance.method (a model edited this spec, so the AI disclosure must say so)`);
  }

  return { spec: { ...proposed, meta, criteria, codeLists }, forged, invalidated };
}

/* ------------------------------------------------------------------ *
 *  diffSpecs
 * ------------------------------------------------------------------ */

function analysisLabel(a: Analysis): string {
  return `${a.label || a.id} (${a.kind})`;
}

/** Every reviewable difference between two specs, in a stable order. */
export function diffSpecs(before: StudySpec, after: StudySpec): SpecChange[] {
  const out: SpecChange[] = [];
  const add = (c: SpecChange) => out.push(c);

  /* ---- meta ---- */
  const metaFields: Array<[string, unknown, unknown]> = [
    ["meta.title", before.meta.title, after.meta.title],
    ["meta.database", before.meta.database, after.meta.database],
    ["meta.studyPeriod.start", before.meta.studyPeriod.start, after.meta.studyPeriod.start],
    ["meta.studyPeriod.end", before.meta.studyPeriod.end, after.meta.studyPeriod.end],
    ["meta.description", before.meta.description, after.meta.description],
  ];
  for (const [path, b, a] of metaFields) {
    if (sameValue(b, a)) continue;
    add({ path, kind: "changed", invalidates: "none", before: show(b), after: show(a),
      summary: `${path.split(".").slice(1).join(" ")} changes from ${show(b)} to ${show(a)}` });
  }

  /* ---- index event and enrollment: whole-object compare, since every field
   *      here changes who is in the cohort ---- */
  if (!sameValue(before.indexEvent, after.indexEvent)) {
    add({ path: "indexEvent", kind: "changed", invalidates: "none",
      before: show(before.indexEvent), after: show(after.indexEvent),
      summary: `the index event changes - this moves day zero, so EVERY window in the study shifts with it` });
  }
  if (!sameValue(before.enrollment, after.enrollment)) {
    add({ path: "enrollment", kind: "changed", invalidates: "none",
      before: show(before.enrollment), after: show(after.enrollment),
      summary: `the enrollment requirement changes - this changes who qualifies, so every count downstream moves` });
  }

  /* ---- criteria ---- */
  const bCrit = new Map(before.criteria.map((c) => [c.id, c]));
  const aCrit = new Map(after.criteria.map((c) => [c.id, c]));
  for (const c of after.criteria) {
    const old = bCrit.get(c.id);
    if (!old) {
      add({ path: `criteria.${c.id}`, kind: "added", invalidates: "criterion_review",
        after: c.sourceText, summary: `NEW criterion "${c.id}" (${c.kind}): ${c.sourceText}. It arrives unreviewed` });
      continue;
    }
    if (criterionSubstance(old) === criterionSubstance(c)) continue;
    const what: string[] = [];
    if (old.sourceText !== c.sourceText) what.push("its quoted protocol text");
    if (!sameValue(old.test, c.test)) what.push("the rule it maps to");
    if (old.kind !== c.kind) what.push(`its direction (${old.kind} -> ${c.kind})`);
    if (old.confidence !== c.confidence) what.push("the extractor's confidence");
    add({
      path: `criteria.${c.id}`, kind: "changed",
      invalidates: old.reviewed ? "criterion_review" : "none",
      before: stable(old.test) !== stable(c.test) ? show(old.test) : old.sourceText,
      after: stable(old.test) !== stable(c.test) ? show(c.test) : c.sourceText,
      summary:
        `criterion "${c.id}" changes: ${what.join(", ")}` +
        (old.reviewed ? `. It was REVIEWED, so accepting this returns it to unreviewed and it must be read again` : ``),
    });
  }
  for (const c of before.criteria) {
    if (aCrit.has(c.id)) continue;
    add({ path: `criteria.${c.id}`, kind: "removed", invalidates: "none",
      before: c.sourceText,
      summary: `criterion "${c.id}" is REMOVED: ${c.sourceText}. The cohort gets larger, and the attrition table loses a step` });
  }

  /* ---- code lists ---- */
  const bList = new Map(before.codeLists.map((l) => [l.id, l]));
  const aList = new Map(after.codeLists.map((l) => [l.id, l]));
  for (const l of after.codeLists) {
    const old = bList.get(l.id);
    if (!old) {
      add({ path: `codeLists.${l.id}`, kind: "added", invalidates: "code_verification",
        after: `${l.label} (${l.codes.length} codes)`,
        summary: `NEW code list "${l.id}" (${l.label}) with ${l.codes.length} code(s), all unverified` });
      continue;
    }
    const oldCodes = new Map(old.codes.map((c) => [c.code, c]));
    const newCodes = new Map(l.codes.map((c) => [c.code, c]));
    for (const c of l.codes) {
      const prev = oldCodes.get(c.code);
      if (!prev) {
        add({ path: `codeLists.${l.id}.${c.code}`, kind: "added", invalidates: "code_verification",
          after: c.description ? `${c.code} - ${c.description}` : c.code,
          summary: `code ${c.code} added to "${l.id}"${c.description ? ` (${c.description})` : ""}. It arrives UNVERIFIED and must be checked before code can be generated` });
      } else if (codeSubstance(prev) !== codeSubstance(c)) {
        add({ path: `codeLists.${l.id}.${c.code}`, kind: "changed",
          invalidates: prev.verified ? "code_verification" : "none",
          before: prev.description ?? prev.code, after: c.description ?? c.code,
          summary: `code ${c.code} in "${l.id}" changes` + (prev.verified ? `. It was VERIFIED, so it returns to unverified` : ``) });
      }
    }
    for (const c of old.codes) {
      if (newCodes.has(c.code)) continue;
      add({ path: `codeLists.${l.id}.${c.code}`, kind: "removed", invalidates: "none",
        before: c.code, summary: `code ${c.code} REMOVED from "${l.id}"` });
    }
  }
  for (const l of before.codeLists) {
    if (aList.has(l.id)) continue;
    add({ path: `codeLists.${l.id}`, kind: "removed", invalidates: "none",
      before: l.label, summary: `code list "${l.id}" (${l.label}) is REMOVED` });
  }

  /* ---- analyses ---- */
  const bAn = new Map(before.analyses.map((a) => [a.id, a]));
  const aAn = new Map(after.analyses.map((a) => [a.id, a]));
  for (const a of after.analyses) {
    const old = bAn.get(a.id);
    if (!old) {
      add({ path: `analyses.${a.id}`, kind: "added", invalidates: "none",
        after: analysisLabel(a), summary: `NEW analysis: ${analysisLabel(a)}` });
      continue;
    }
    if (sameValue(old, a)) continue;
    if (old.kind !== a.kind) {
      add({ path: `analyses.${a.id}`, kind: "changed", invalidates: "none",
        before: analysisLabel(old), after: analysisLabel(a),
        summary: `analysis "${a.id}" changes KIND from ${old.kind} to ${a.kind} - a different method, not a different parameter` });
      continue;
    }
    if (old.enabled !== a.enabled) {
      add({ path: `analyses.${a.id}.enabled`, kind: "changed", invalidates: "none",
        before: show(old.enabled), after: show(a.enabled),
        summary: `analysis "${a.id}" is ${a.enabled ? "ENABLED" : "DISABLED"}` });
    }
    /* Parameter-level detail, so a changed threshold is not reported as a
     * vague "the analysis changed". */
    const ob = old as unknown as Record<string, unknown>;
    const nb = a as unknown as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(ob), ...Object.keys(nb)])].sort()) {
      if (k === "enabled" || k === "kind" || k === "id") continue;
      if (sameValue(ob[k], nb[k])) continue;
      add({ path: `analyses.${a.id}.${k}`, kind: "changed", invalidates: "none",
        before: show(ob[k]), after: show(nb[k]),
        summary: `analysis "${a.id}": ${k} changes from ${show(ob[k])} to ${show(nb[k])}` });
    }
  }
  for (const a of before.analyses) {
    if (aAn.has(a.id)) continue;
    add({ path: `analyses.${a.id}`, kind: "removed", invalidates: "none",
      before: analysisLabel(a), summary: `analysis REMOVED: ${analysisLabel(a)}` });
  }

  /* ---- baseline characteristics ---- */
  if (!sameValue(before.baseline, after.baseline)) {
    const b = new Set(before.baseline.map((x) => x.id));
    const a = new Set(after.baseline.map((x) => x.id));
    for (const x of after.baseline) if (!b.has(x.id))
      add({ path: `baseline.${x.id}`, kind: "added", invalidates: "none", after: x.label,
        summary: `NEW baseline characteristic: ${x.label} (${x.kind})` });
    for (const x of before.baseline) if (!a.has(x.id))
      add({ path: `baseline.${x.id}`, kind: "removed", invalidates: "none", before: x.label,
        summary: `baseline characteristic REMOVED: ${x.label}` });
  }

  return out;
}

/** True when a proposal would take review state away from the analyst. */
export function changesRequiringRereview(changes: SpecChange[]): SpecChange[] {
  return changes.filter((c) => c.invalidates !== "none");
}
