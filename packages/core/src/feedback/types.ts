/**
 * Learning protocol — the correction record.
 *
 * How HEOR Studio absorbs "this is wrong" without becoming rigid and without
 * sacrificing correctness. See docs/LEARNING-PROTOCOL.md. Core rules:
 *   - a correction NEVER silently changes generation; it routes to a gold case,
 *     a spec option, or a doc/label change — always human-reviewed.
 *   - capture is LOCAL; nothing is transmitted (privacy). The analyst chooses to
 *     share via formatCorrectionMarkdown().
 *   - a reason is REQUIRED — the tool always asks WHY (newCorrection throws
 *     without one). The stance is never "you're wrong", it is "tell us why".
 */

export type CorrectionTargetKind =
  | "generated_code" // a generated SAS/SQL program
  | "business_rule"  // a BRD rule (BR-...)
  | "spec_field"     // a value in the study spec
  | "code_list"      // a code or code list
  | "statistic"      // a computed number (rate, CI, count)
  | "terminology"    // a label / wording
  | "other";

export type CorrectionClass =
  | "correctness_bug"       // output is wrong -> gold case + emitter fix
  | "methodological_choice" // legitimately contestable -> spec option
  | "site_preference"       // licensee/environment-specific -> config
  | "data_vintage"          // MarketScan vintage difference -> confirm/config
  | "terminology"           // naming/label -> doc/label update
  | "misunderstanding"      // output correct, UI/doc unclear -> clarify
  | "unclassified";

export type CorrectionStatus = "open" | "under_review" | "accepted" | "declined" | "deferred";

export type CorrectionOutcome =
  | "emitter_fix_with_gold_case"
  | "new_spec_option"
  | "brd_update"
  | "doc_or_ui_clarification"
  | "no_change_explained"
  | "deferred";

export interface CorrectionTarget {
  kind: CorrectionTargetKind;
  /** What is being contested, e.g. "07_incidence.sql", "BR-FIN-001", "451.55". */
  ref: string;
  specVersion?: string;
  artifactPath?: string;
}

export interface CorrectionResolution {
  outcome: CorrectionOutcome;
  notes: string;
  goldCaseId?: string; // regression test that now guards the fix
  specField?: string;  // spec option added (methodological choice)
  brdRuleId?: string;  // BRD rule updated
  commit?: string;
}

export interface Correction {
  id: string;
  /** ISO timestamp, supplied by the caller — core never reads the clock. */
  createdAt: string;
  target: CorrectionTarget;
  /** What the analyst says is wrong. */
  claim: string;
  /** REQUIRED — why they believe so. The "always ask why". */
  reason: string;
  /** What they think it should be. */
  suggestedCorrect?: string;
  /** Optional; no PII required. */
  reporter?: { role?: string; org?: string };
  classification: CorrectionClass;
  status: CorrectionStatus;
  resolution?: CorrectionResolution;
}

export interface NewCorrectionInput {
  createdAt: string; // ISO — caller supplies (deterministic core)
  target: CorrectionTarget;
  claim: string;
  reason: string;
  suggestedCorrect?: string;
  reporter?: { role?: string; org?: string };
  classification?: CorrectionClass;
}

/** Deterministic short id from stable fields (no clock/random). */
function correctionId(input: NewCorrectionInput): string {
  const basis = `${input.createdAt}|${input.target.kind}|${input.target.ref}|${input.claim}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  const slug = input.target.ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "correction";
  return `${slug}-${h.toString(36)}`;
}

/**
 * Build a correction. THROWS if no reason is given — the protocol always asks
 * why, and a reasonless "this is wrong" is not actionable. Never mutates
 * generation; it only records.
 */
export function newCorrection(input: NewCorrectionInput): Correction {
  const claim = input.claim?.trim();
  const reason = input.reason?.trim();
  if (!claim) throw new Error("A correction needs a claim (what is wrong).");
  if (!reason)
    throw new Error(
      "A correction needs a reason (why). HEOR Studio always asks why before recording — a bare 'this is wrong' cannot be routed to a fix, an option, or a clarification.",
    );
  return {
    id: correctionId(input),
    createdAt: input.createdAt,
    target: input.target,
    claim,
    reason,
    suggestedCorrect: input.suggestedCorrect?.trim() || undefined,
    reporter: input.reporter,
    classification: input.classification ?? "unclassified",
    status: "open",
  };
}

/**
 * Format a correction as a shareable Markdown record (e.g. a GitHub issue body).
 * The analyst chooses whether to send it — nothing is transmitted automatically.
 */
export function formatCorrectionMarkdown(c: Correction): string {
  const L: string[] = [];
  L.push(`## HEOR Studio correction: ${c.target.kind} — ${c.target.ref}`);
  L.push("");
  L.push(`- **id:** \`${c.id}\``);
  L.push(`- **when:** ${c.createdAt}`);
  L.push(`- **target:** ${c.target.kind} \`${c.target.ref}\`${c.target.specVersion ? ` (spec v${c.target.specVersion})` : ""}`);
  if (c.reporter?.role || c.reporter?.org) L.push(`- **reporter:** ${[c.reporter.role, c.reporter.org].filter(Boolean).join(", ")}`);
  L.push("");
  L.push(`**What looks wrong**`);
  L.push("");
  L.push(c.claim);
  L.push("");
  L.push(`**Why (reason given)**`);
  L.push("");
  L.push(c.reason);
  if (c.suggestedCorrect) {
    L.push("");
    L.push(`**Suggested correct value / behavior**`);
    L.push("");
    L.push(c.suggestedCorrect);
  }
  L.push("");
  L.push(`---`);
  L.push(`_Captured locally by HEOR Studio. Shared only because you chose to. It will be triaged`);
  L.push(`into a gold-case fix, a spec option, or a doc change — see docs/LEARNING-PROTOCOL.md._`);
  return L.join("\n");
}
