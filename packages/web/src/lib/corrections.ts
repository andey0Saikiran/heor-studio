/**
 * Correction capture — browser side of the learning protocol.
 *
 * The record itself is built by @heor-studio/core (newCorrection throws without
 * a reason; the id is deterministic). This module only decides WHERE the record
 * goes in the browser: localStorage, plus downloads the analyst triggers.
 * Nothing is transmitted.
 */
import type {
  Correction,
  CorrectionClass,
  CorrectionStatus,
  CorrectionTarget,
  CorrectionTargetKind,
} from "@heor-studio/core";
import { formatCorrectionMarkdown } from "@heor-studio/core";
import { downloadBlob } from "./exportZip";

const CORRECTIONS_KEY = "heor-studio.corrections";

/** Plain-words names for the target kinds, used in the modal and the inbox. */
export const CORRECTION_KIND_LABELS: Record<CorrectionTargetKind, string> = {
  generated_code: "Generated program",
  business_rule: "Business rule",
  spec_field: "Study spec value",
  code_list: "Code or code list",
  statistic: "Computed number",
  terminology: "Wording or label",
  other: "Something else",
};

/** What kind of disagreement this is. Drives how a correction gets triaged. */
export const CORRECTION_CLASS_LABELS: Record<CorrectionClass, string> = {
  unclassified: "Not sure yet",
  correctness_bug: "The output is simply wrong",
  methodological_choice: "A defensible choice I would make differently",
  site_preference: "Specific to my site or environment",
  data_vintage: "A MarketScan vintage or delivery difference",
  terminology: "The naming or wording is off",
  misunderstanding: "The output may be right, the interface is unclear",
};

const KINDS = Object.keys(CORRECTION_KIND_LABELS) as CorrectionTargetKind[];
const CLASSES = Object.keys(CORRECTION_CLASS_LABELS) as CorrectionClass[];
const STATUSES: CorrectionStatus[] = ["open", "under_review", "accepted", "declined", "deferred"];

/**
 * What an anchor hands to the modal. `label` and `context` are display only;
 * `target` is what actually lands in the record.
 */
export interface FlagRequest {
  /** One line naming exactly what the analyst clicked. */
  label: string;
  /** Supporting lines, e.g. the contested sentence or a code's provenance. */
  context?: string[];
  target: CorrectionTarget;
  /** Starting point for the classification select; always editable. */
  classification?: CorrectionClass;
  /** Placeholder text for the reason box. Never a prefilled value. */
  reasonHint?: string;
}

function isCorrection(v: unknown): v is Correction {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<Correction>;
  if (typeof c.id !== "string" || !c.id) return false;
  if (typeof c.createdAt !== "string" || !c.createdAt) return false;
  if (typeof c.claim !== "string" || !c.claim) return false;
  if (typeof c.reason !== "string" || !c.reason) return false;
  if (typeof c.classification !== "string" || !CLASSES.includes(c.classification)) return false;
  if (typeof c.status !== "string" || !STATUSES.includes(c.status)) return false;
  const t = c.target as Partial<CorrectionTarget> | undefined;
  if (typeof t !== "object" || t === null) return false;
  if (typeof t.kind !== "string" || !KINDS.includes(t.kind)) return false;
  if (typeof t.ref !== "string" || !t.ref) return false;
  if (t.specVersion !== undefined && typeof t.specVersion !== "string") return false;
  if (t.artifactPath !== undefined && typeof t.artifactPath !== "string") return false;
  return true;
}

/** Reads the stored corrections, dropping anything that no longer parses. */
export function loadCorrections(): Correction[] {
  try {
    const raw = localStorage.getItem(CORRECTIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCorrection);
  } catch {
    return [];
  }
}

export function saveCorrections(list: Correction[]): void {
  try {
    localStorage.setItem(CORRECTIONS_KEY, JSON.stringify(list));
  } catch {
    /* storage full/unavailable — corrections stay in memory for this session */
  }
}

/* ---------- downloads (the analyst chooses to share; nothing auto-sends) ---------- */

function fileStem(c: Correction): string {
  return `heor-studio_correction_${c.id}`;
}

export function downloadCorrectionJson(c: Correction): void {
  const blob = new Blob([JSON.stringify(c, null, 2) + "\n"], { type: "application/json" });
  downloadBlob(blob, `${fileStem(c)}.json`);
}

export function downloadCorrectionMarkdown(c: Correction): void {
  const blob = new Blob([formatCorrectionMarkdown(c) + "\n"], { type: "text/markdown" });
  downloadBlob(blob, `${fileStem(c)}.md`);
}

export function downloadAllCorrectionsJson(list: Correction[]): void {
  const blob = new Blob([JSON.stringify(list, null, 2) + "\n"], { type: "application/json" });
  downloadBlob(blob, "heor-studio_corrections.json");
}

export function downloadAllCorrectionsMarkdown(list: Correction[]): void {
  const body = list.map((c) => formatCorrectionMarkdown(c)).join("\n\n");
  const blob = new Blob([body + "\n"], { type: "text/markdown" });
  downloadBlob(blob, "heor-studio_corrections.md");
}
