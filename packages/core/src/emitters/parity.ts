/**
 * SAS↔SQL parity layer.
 *
 * Each emitter stamps a machine-readable `PARITY <kind> <json>` header into the
 * generated program for every analysis it emits, built from the values it
 * ACTUALLY CONSUMED at the point of code generation (not from the spec object
 * directly). The verification harness parses the headers out of both language
 * outputs and deep-compares them, so a twin that silently defaults, ignores, or
 * mis-renders a parameter fails verification instead of shipping drift.
 *
 * SAS cannot be executed in the harness (no free SAS runtime), so parity — the
 * same consumed parameters plus matching arithmetic signatures — is how the SAS
 * twin inherits the SQL twin's machine-verified ground truth.
 */
import type { IncidenceRateAnalysis, RelativeWindow } from "../spec/types";
import type { StudySpec } from "../spec/types";

/** Default mean days per year — internally consistent (rate/person-years/CI all
 *  agree). Overridable per study via spec.meta.daysPerYear (e.g. 365 for the HEOR
 *  Handbook AE-rate convention) so the analyst decides per their requirements. */
export const DEFAULT_DAYS_PER_YEAR = 365.25;

/** Render the person-time constant as a DECIMAL literal (e.g. "365.0") so SQL
 *  arithmetic is numeric — an integer constant would trigger integer division
 *  (451 vs 451.55; see corrections/2026-07-24-incidence-integer-division.md). */
export function renderDaysPerYear(spec: StudySpec): string {
  const y = spec.meta.daysPerYear ?? DEFAULT_DAYS_PER_YEAR;
  return Number.isInteger(y) ? y.toFixed(1) : String(y);
}

/** The parameter set an incidence-rate twin must consume identically. */
export interface IncidenceParity {
  id: string;
  codeListId: string;
  rateMultiplier: number;
  /** the rendered literal each twin embedded, compared as a string */
  daysPerYear: string;
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
  censorAt: string[]; // sorted
  maxFollowupDays: number | null;
  ciMethod: string;   // the method actually computed (not merely requested)
  recurrence: string; // the recurrence actually produced
}

/** Stable-key JSON so both languages serialize byte-identically. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** One-line parity stamp; caller wraps in its language's comment syntax. */
export function parityStamp(kind: string, values: object): string {
  return `PARITY ${kind} ${stableJson(values)}`;
}

/** Parse every parity stamp out of a generated file's content. */
export function parseParityStamps(content: string): Array<{ kind: string; values: Record<string, unknown> }> {
  const out: Array<{ kind: string; values: Record<string, unknown> }> = [];
  for (const m of content.matchAll(/PARITY (\w+) (\{[^\n]*\})/g)) {
    try {
      out.push({ kind: m[1], values: JSON.parse(m[2]) as Record<string, unknown> });
    } catch {
      out.push({ kind: m[1], values: { __unparseable: m[2] } });
    }
  }
  return out;
}

/**
 * Spec options the incidence twins do NOT yet implement. Emitted as visible
 * review notes in BOTH languages so a generated program never silently claims
 * behavior it doesn't have; the modules land these one by one.
 */
export function incidenceLimitations(an: IncidenceRateAnalysis): string[] {
  const out: string[] = [];
  const od = an.outcomeDefinition;
  if (od.minClaims > 1)
    out.push(`outcome minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts as the outcome`);
  if (od.setting !== "any")
    out.push(`outcome care-setting filter "${od.setting}" is NOT yet applied - events from all settings count`);
  if (od.diagnosisPosition !== "any")
    out.push(`diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count`);
  if (an.recurrence !== "first_only")
    out.push(`recurrence="all_events" is NOT implemented - FIRST-event incidence is produced`);
  if (an.ciMethod !== "poisson_byar")
    out.push(`ciMethod "${an.ciMethod}" is NOT implemented - the Byar exact-Poisson approximation is produced and labeled poisson_byar`);
  if (an.stratifyBy.length > 0)
    out.push(`stratifyBy is NOT yet emitted - Overall row only`);
  return out;
}

/** The parity record for an incidence twin, from values the caller consumed. */
export function incidenceParity(
  an: IncidenceRateAnalysis,
  consumed: { daysPerYear: string; censorTerms: string[] }
): IncidenceParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    rateMultiplier: an.rateMultiplier,
    daysPerYear: consumed.daysPerYear,
    washout: {
      start: an.washout.start,
      end: an.washout.end,
      includesIndex: an.washout.includesIndex,
    },
    censorAt: [...consumed.censorTerms].sort(),
    maxFollowupDays: an.personTimeRule.maxFollowupDays ?? null,
    // what the twins actually compute today (limitations above make this loud)
    ciMethod: "poisson_byar",
    recurrence: "first_only",
  };
}

export type { RelativeWindow };
