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
import type {
  CodeSystem,
  IncidenceRateAnalysis,
  OutcomeDefinition,
  RelativeWindow,
  Stratifier,
} from "../spec/types";
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
  /** the care-setting filter ACTUALLY applied to outcome events */
  settingFilter: string;
  /** strata the twin actually emitted (id/axis/bands), in spec order */
  strata: SupportedStratifier[];
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

/* ------------------------------------------------------------------ *
 *  Stratification — shared between the twins so stratum LABELS are
 *  byte-identical across languages (a label mismatch breaks any
 *  downstream join/report comparing SAS output to SQL output).
 * ------------------------------------------------------------------ */

/** Default age-band lower bounds when a Stratifier omits ageBandLowerBounds
 *  (mirrors the Table-1 grouping: <18, 18-34, 35-44, 45-54, 55-64, 65+). */
export const DEFAULT_AGE_BANDS = [0, 18, 35, 45, 55, 65];

/** MarketScan coded values → the display labels BOTH twins must emit. */
export const SEX_LABELS: Record<string, string> = { "1": "Male", "2": "Female" };
export const REGION_LABELS: Record<string, string> = {
  "1": "Northeast", "2": "North Central", "3": "South", "4": "West", "5": "Unknown",
};

/** Band labels from inclusive lower bounds, e.g. [0,18,65] → ["0-17","18-64","65+"]. */
export function ageBandLabels(bounds: number[]): string[] {
  const b = [...bounds].sort((x, y) => x - y);
  return b.map((lo, i) => (i === b.length - 1 ? `${lo}+` : `${lo}-${b[i + 1] - 1}`));
}

/** Stratifier display label as stored in the output tables. Capped at 40 chars
 *  because the SAS twin declares stratifier/stratum as $40 — SQL applies the
 *  SAME cap so both languages store byte-identical values. */
export function stratLabel(label: string): string {
  return label.slice(0, 40);
}

export type DemographicAxis = "age_band" | "sex" | "region" | "plan_type" | "year";

export interface SupportedStratifier {
  id: string;
  label: string;
  axis: DemographicAxis;
  /** sorted ascending; present only for age_band */
  bands?: number[];
}

/** Split stratifiers into the demographic axes the incidence twins implement
 *  vs the ones they don't (baseline-source strata need the flag machinery). */
export function splitStratifiers(stratifyBy: Stratifier[]): {
  supported: SupportedStratifier[];
  unsupported: Stratifier[];
} {
  const supported: SupportedStratifier[] = [];
  const unsupported: Stratifier[] = [];
  for (const s of stratifyBy) {
    if (s.source.kind === "demographic") {
      supported.push({
        id: s.id,
        label: s.label,
        axis: s.source.axis,
        ...(s.source.axis === "age_band"
          ? { bands: [...(s.ageBandLowerBounds ?? DEFAULT_AGE_BANDS)].sort((a, b) => a - b) }
          : {}),
      });
    } else {
      unsupported.push(s);
    }
  }
  return { supported, unsupported };
}

/* ------------------------------------------------------------------ *
 *  Outcome care-setting enforcement — shared so both twins apply (and
 *  stamp) exactly the same filter.
 * ------------------------------------------------------------------ */

export interface SettingPlan {
  /** the setting filter both twins enforce; null = no filter */
  enforce: "outpatient" | "inpatient" | null;
  /** stamped value: the filter ACTUALLY applied ("any" when none) */
  stamped: string;
  /** REVIEW note when the requested setting cannot be enforced */
  note: string | null;
}

/** Decide how an OutcomeDefinition's care setting is enforced for a given
 *  code-list system. Drug/NDC events are inherently pharmacy claims: a
 *  "pharmacy" filter on them is a no-op, and inpatient/outpatient filters on
 *  pharmacy events are unsatisfiable — surfaced, never silently applied. */
export function outcomeSettingPlan(od: OutcomeDefinition, listSystem: CodeSystem): SettingPlan {
  const isDrugList = listSystem === "drug_name" || listSystem === "ndc";
  if (od.setting === "any") return { enforce: null, stamped: "any", note: null };
  if (isDrugList) {
    if (od.setting === "pharmacy")
      return { enforce: null, stamped: "pharmacy_all", note: null }; // all drug events ARE pharmacy
    return {
      enforce: null,
      stamped: "any",
      note: `outcome care-setting "${od.setting}" cannot apply to pharmacy (drug) events - no filter applied; review the outcome definition`,
    };
  }
  if (od.setting === "pharmacy")
    return {
      enforce: null,
      stamped: "any",
      note: `outcome care-setting "pharmacy" cannot apply to a diagnosis/procedure code list - no filter applied; review the outcome definition`,
    };
  return { enforce: od.setting, stamped: od.setting, note: null };
}

/**
 * Spec options the incidence twins do NOT yet implement. Emitted as visible
 * review notes in BOTH languages so a generated program never silently claims
 * behavior it doesn't have; the modules land these one by one.
 */
export function incidenceLimitations(an: IncidenceRateAnalysis, listSystem: CodeSystem): string[] {
  const out: string[] = [];
  const od = an.outcomeDefinition;
  if (od.minClaims > 1)
    out.push(`outcome minClaims=${od.minClaims} is NOT yet enforced - any single qualifying claim counts as the outcome`);
  const settingNote = outcomeSettingPlan(od, listSystem).note;
  if (settingNote) out.push(settingNote);
  if (od.diagnosisPosition !== "any")
    out.push(`diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count (the events spine does not record claim position yet)`);
  if (an.recurrence !== "first_only")
    out.push(`recurrence="all_events" is NOT implemented - FIRST-event incidence is produced`);
  if (an.ciMethod !== "poisson_byar")
    out.push(`ciMethod "${an.ciMethod}" is NOT implemented - the Byar exact-Poisson approximation is produced and labeled poisson_byar`);
  for (const s of splitStratifiers(an.stratifyBy).unsupported)
    out.push(`stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted - demographic axes only for now`);
  return out;
}

/** The parity record for an incidence twin, from values the caller consumed. */
export function incidenceParity(
  an: IncidenceRateAnalysis,
  consumed: { daysPerYear: string; censorTerms: string[]; settingFilter: string; strata: SupportedStratifier[] }
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
    settingFilter: consumed.settingFilter,
    strata: consumed.strata,
  };
}

export type { RelativeWindow };
