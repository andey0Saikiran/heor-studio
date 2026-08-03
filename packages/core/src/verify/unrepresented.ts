/**
 * THE "I CANNOT REPRESENT THIS" GATE, verified.
 *
 * This is the check that the product keeps its central promise: when the schema
 * cannot express a construct, the tool refuses to go ready rather than shipping a
 * green study that answers a different question. Proven three ways:
 *
 *   1. The detector fires on the real protocol's constructs (a confirmatory
 *      pancreatitis outcome, an Optum/meta-analysis, a lab covariate).
 *   2. It does NOT fire on any clean gold spec, so it does not cry wolf.
 *   3. Readiness REFUSES while a construct is open, and CLEARS the moment the
 *      analyst acknowledges it. Acknowledgement survives because it is keyed.
 */
import type { StudySpec } from "../spec/types";
import { specReadiness } from "../spec/types";
import { detectUnrepresented, openLimitations, acknowledgeLimitation, mergeUnrepresented } from "../spec/unrepresented";
import { sanitizeProposal } from "../spec/diff";
import { planBundle } from "../bundle";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import { GOLD_B_SPEC } from "./fixture-b";
import { GOLD_F_SPEC } from "./fixture-f";
import { GOLD_H_SPEC } from "./fixture-h";
import { GOLD_K_SPEC } from "./fixture-k";
import type { Check } from "./run";

/** A clean gold spec with the empagliflozin protocol's real unrepresentable
 *  constructs grafted into the text the extractor would carry. */
function protocolLikeSpec(): StudySpec {
  const s = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as StudySpec;
  s.criteria.push({
    id: "c_outcome", kind: "inclusion", reviewed: true, confidence: "high",
    sourceText: "Acute pancreatitis: an ICD diagnosis (577.0 or K85) AND a lipase measure within +/-7 days of the diagnosis.",
    test: { type: "unmapped", raw: "x" },
  } as never);
  s.meta.description =
    "Separate analysis of the two databases; if underpowered, a fixed-effects meta-analysis pooling MarketScan and Optum will be conducted.";
  s.baseline.push({ id: "b_hba1c", label: "Baseline HbA1c (LOINC)", kind: "utilization", dataType: "continuous" } as never);
  return s;
}

export function verifyUnrepresentedGate(): Check[] {
  const out: Check[] = [];
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });

  /* 1. Fires on the real protocol's constructs. */
  const spec = protocolLikeSpec();
  const hits = detectUnrepresented(spec);
  const cats = new Set(hits.map((h) => h.category));
  push("detector: the confirmatory pancreatitis outcome is caught",
    cats.has("outcome_algorithm"), `categories detected: ${[...cats].join(", ") || "none"}`);
  push("detector: the Optum / meta-analysis primary estimate is caught",
    cats.has("database"), `categories: ${[...cats].join(", ")}`);
  push("detector: the LOINC lab covariate is caught",
    cats.has("covariate"), `categories: ${[...cats].join(", ")}`);

  /* 2. Does not cry wolf on clean specs. */
  for (const [name, gold] of [["A", GOLD_A_SPEC], ["B", GOLD_B_SPEC], ["F", GOLD_F_SPEC], ["H", GOLD_H_SPEC], ["K", GOLD_K_SPEC]] as Array<[string, StudySpec]>) {
    const n = detectUnrepresented(gold).length;
    push(`detector: no false positive on Gold ${name}`, n === 0, `${n} constructs detected (expected 0)`);
  }

  /* 3. Readiness refuses while open, clears on acknowledgement. */
  const before = specReadiness(spec);
  const blockers = before.problems.filter((p) => p.startsWith("CANNOT REPRESENT"));
  push("readiness: refuses while a construct is unacknowledged",
    !before.ready && blockers.length === 3, `ready=${before.ready}, ${blockers.length} CANNOT REPRESENT problems`);

  let acked = spec;
  for (const c of openLimitations(acked)) acked = acknowledgeLimitation(acked, c.key);
  const openAfter = openLimitations(acked).length;
  const afterProblems = specReadiness(acked).problems.filter((p) => p.startsWith("CANNOT REPRESENT")).length;
  push("acknowledgement: clears every open limitation",
    openAfter === 0, `${openAfter} still open after acknowledging all (expected 0)`);
  push("acknowledgement: removes the readiness block (the gate is not a dead end)",
    afterProblems === 0, `${afterProblems} CANNOT REPRESENT problems remain (expected 0)`);

  /* 4. Acknowledgement is durable: acknowledging ONE leaves the others blocking,
   *    so the gate cannot be cleared by acknowledging a single item. */
  const one = acknowledgeLimitation(spec, detectUnrepresented(spec)[0].key);
  const stillOpen = openLimitations(one).length;
  push("acknowledgement: keyed per item — clearing one leaves the rest blocking",
    stillOpen === 2, `${stillOpen} still open after acknowledging one (expected 2)`);

  /* ---- the adversarial regressions (each pins a reproduced bypass) ---- */

  /* 5. FORGED ACKNOWLEDGEMENT. A model in the spec chat cannot clear the gate by
   *    setting acknowledged:true. sanitizeProposal resets any acknowledgement not
   *    already present in the prior spec, and reports it as forged. */
  {
    const before = mergeUnrepresented(spec);                 // open limitations, none acknowledged
    const proposed = JSON.parse(JSON.stringify(before)) as StudySpec;
    for (const u of proposed.unrepresented ?? []) u.acknowledged = true;   // the forgery
    const { spec: clean, forged } = sanitizeProposal(before, proposed);
    const cleanOpen = openLimitations(clean).length;
    push("forged-ack: a model cannot acknowledge a limitation — the flags are reset",
      cleanOpen === before.unrepresented!.length && forged.some((f) => f.includes("acknowledged")),
      `${cleanOpen} still open after the forgery (expected ${before.unrepresented!.length}), forged reported: ${forged.filter((f) => f.includes("acknowledged")).length}`);

    /* And a genuine prior acknowledgement SURVIVES a chat edit (the gate is not a
     * ratchet that re-blocks everything on every edit). */
    let human = mergeUnrepresented(spec);
    const firstKey = (human.unrepresented ?? [])[0].key;
    human = acknowledgeLimitation(human, firstKey);
    const kept = sanitizeProposal(human, JSON.parse(JSON.stringify(human)) as StudySpec).spec;
    push("forged-ack: a real prior acknowledgement survives a chat edit",
      (kept.unrepresented ?? []).find((u) => u.key === firstKey)?.acknowledged === true,
      "prior human ack preserved");
  }

  /* 6. STRICT BOOLEAN. A non-boolean acknowledged (a "false" string from an
   *    un-validated restore path) must NOT clear the block. */
  {
    const s = mergeUnrepresented(spec);
    const poisoned = JSON.parse(JSON.stringify(s)) as StudySpec;
    for (const u of poisoned.unrepresented ?? []) (u as { acknowledged: unknown }).acknowledged = "false";
    push("strict-boolean: a non-boolean acknowledged does not clear the block",
      openLimitations(poisoned).length === (s.unrepresented ?? []).length,
      `${openLimitations(poisoned).length} open with string "false" (expected ${(s.unrepresented ?? []).length})`);
  }

  /* 7. ENFORCEMENT CHOKEPOINT. planBundle itself refuses an unready spec, so no
   *    export path can ship a deliverable past an open limitation. */
  {
    let threw = "";
    try { planBundle(spec, GOLD_A_OPTS, "2026-01-01T00:00:00.000Z"); } catch (e) { threw = (e as Error).message; }
    push("enforcement: planBundle refuses a spec that is not ready",
      /not ready/i.test(threw), threw ? threw.slice(0, 80) : "planBundle EMITTED a bundle from an unready spec");
  }

  /* 8. FAIL-CLOSED FIX. A day-phrased drug washout is representable and must NOT
   *    be flagged as a confirmatory outcome (the noise that trained click-through). */
  {
    const s = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as StudySpec;
    s.criteria.push({
      id: "c_washout", kind: "exclusion", reviewed: true, confidence: "high",
      sourceText: "No antibiotic dispensing within 30 days prior to index.",
      test: { type: "unmapped", raw: "x" },
    } as never);
    push("fail-closed: a day-phrased drug washout is NOT flagged as unrepresentable",
      detectUnrepresented(s).length === 0, `${detectUnrepresented(s).length} constructs on a plain washout (expected 0)`);
  }

  /* 9. STRUCTURAL EXPOSURE. A group variable with more than two levels is caught
   *    from the TYPED field, so it cannot evade on a paraphrase. */
  {
    const s = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as StudySpec;
    s.groupVars.push({ id: "g_arm", label: "Treatment line", source: { kind: "exposure_cohort" }, levels: ["EMPA", "SU", "TZD"] } as never);
    const hits = detectUnrepresented(s);
    push("structural: a 3-level exposure is caught from the typed field, not its prose",
      hits.some((h) => h.category === "exposure"), `categories: ${hits.map((h) => h.category).join(", ") || "none"}`);
  }

  /* 10. analyses[].notes is scanned (the un-paraphrased SAP field the net missed). */
  {
    const s = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as StudySpec;
    (s.analyses[0] as { notes?: string }).notes = "Follow-up uses a modified as-treated approach with a 30-day grace period.";
    push("coverage: an as-treated clause in analyses[].notes is caught",
      detectUnrepresented(s).some((h) => h.category === "censoring"), "censoring detected in analysis notes");
  }

  return out;
}
