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
import { detectUnrepresented, openLimitations, acknowledgeLimitation } from "../spec/unrepresented";
import { GOLD_A_SPEC } from "./fixture";
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

  return out;
}
