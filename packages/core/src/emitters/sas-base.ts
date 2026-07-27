/**
 * SAS emitter base — the shared context type, house-style program scaffolding
 * (header / include / level checks), and window helpers that both the cohort
 * spine (sas.ts) and the per-analysis modules (modules/*.ts) depend on. Lives
 * in its own file so analysis modules never import sas.ts (no cycles):
 * sas.ts → modules/registry → modules/* → here.
 */
import { EMITTER_VERSION, stableHash } from "../provenance";
import type { CodeList, RelativeWindow, StudySpec } from "../spec/types";
import type { EmitOptions } from "./types";

/* ------------------------------------------------------------------ *
 *  small utilities
 * ------------------------------------------------------------------ */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** ISO date → SAS date literal, e.g. "2016-01-01" → '01JAN2016'd */
export function sasDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `'${String(d).padStart(2, "0")}${MONTHS[(m ?? 1) - 1]}${y}'d`;
}

/** make an arbitrary id safe as (part of) a SAS name */
export function sasName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/** sanitize free text for use inside a SAS block comment */
export function cmt(s: string): string {
  return s.replace(/\*\//g, "* /");
}

/** escape single quotes for a single-quoted SAS string literal */
export function sq(s: string): string {
  return s.replace(/'/g, "''");
}

/* ------------------------------------------------------------------ *
 *  site naming + emitter context (types only; construction in sas.ts)
 * ------------------------------------------------------------------ */

export interface SiteNaming {
  /** whether the event/enrollment pulls loop over calendar years */
  yearLoop: boolean;
  /** libname statements for 00_setup */
  libnameLines: string[];
  /** naming-configuration block for 00_setup (per family letter used) */
  namingLines: (letters: string[]) => string[];
  /** SAS-side reference to a family table, e.g. "%tab_o(&yr.)" */
  tab: (letter: string) => string;
  /** where the Redbook-style NDC reference lives by default */
  ndcRefDefault: string;
}

export type ListKind = "dx" | "px" | "drug_name" | "ndc";

export interface PulledList {
  list: CodeList;
  kind: ListKind;
  /** dx/px only: which care-setting sources to scan */
  op: boolean;
  ip: boolean;
}

/** Shared emitter context threaded through every SAS program builder. */
export interface Ctx {
  spec: StudySpec;
  opts: EmitOptions;
  site: SiteNaming;
  /** persistent project-library table reference, e.g. "tz.&tag._ev_pso_dx" */
  tbl: (suffix: string) => string;
  /** macro-variable name (<=32 chars, collision-free) */
  mvar: (name: string) => string;
  /** macro name for pull drivers */
  mname: (name: string) => string;
  evOf: (listId: string) => string;
  ndcOf: (listId: string) => string;
  pulled: PulledList[];
  drugNameLists: CodeList[];
  indexList: CodeList;
  lettersUsed: string[];
  finalCohort: string;
  /** the person-time constant literal 00_setup embeds in %let days_per_year —
   *  analysis programs stamp exactly this value into their parity headers */
  daysPerYearLit: string;
}

/* ------------------------------------------------------------------ *
 *  shared SAS fragments
 * ------------------------------------------------------------------ */

export function idxExpr(n: number): string {
  if (n === 0) return "a.index_date";
  return n > 0 ? `a.index_date + ${n}` : `a.index_date - ${-n}`;
}

/** "and <alias>.svcdate ..." lines for a RelativeWindow vs index date */
export function windowConds(w: RelativeWindow, alias: string): string[] {
  const out: string[] = [];
  if (w.start !== "anytime_before") out.push(`and ${alias}.svcdate >= ${idxExpr(w.start)}`);
  if (w.end !== "anytime_after") out.push(`and ${alias}.svcdate <= ${idxExpr(w.end)}`);
  const startsAtOrBefore = w.start === "anytime_before" || w.start <= 0;
  const endsAtOrAfter = w.end === "anytime_after" || w.end >= 0;
  if (startsAtOrBefore && endsAtOrAfter && !w.includesIndex)
    out.push(`and ${alias}.svcdate ne a.index_date`);
  return out;
}

export function describeWin(w: RelativeWindow): string {
  const s = w.start === "anytime_before" ? "anytime before" : `day ${w.start}`;
  const e = w.end === "anytime_after" ? "anytime after" : `day ${w.end}`;
  return `${s} .. ${e} relative to index (${w.includesIndex ? "includes" : "excludes"} the index date)`;
}

export function levelCheck(tableRef: string, note: string, extraCols: string[] = []): string[] {
  return [
    `title "Level check: ${tableRef}${note ? ` (${note})` : ""}";`,
    `proc sql;`,
    `  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt${extraCols.length ? "," : ""}`,
    ...extraCols.map((c, i) => `         ${c}${i === extraCols.length - 1 ? "" : ","}`),
    `  from ${tableRef};`,
    `quit;`,
  ];
}

export function header(spec: StudySpec, program: string, purpose: string[]): string[] {
  const bar = "=".repeat(77);
  const prov = spec.meta.provenance;
  // cmt() every interpolated field: model/sourceDocumentName are user/LLM text
  // and an un-escaped "*/" would close this block comment and turn the rest of
  // the header into live SAS. (title/version/purpose are already cmt()-wrapped.)
  const provTxt =
    prov.method === "llm_extraction"
      ? `extracted by ${cmt(prov.model ?? "LLM")}${prov.sourceDocumentName ? ` from ${cmt(prov.sourceDocumentName)}` : ""}`
      : "manually specified";
  return [
    `/*${bar}`,
    `| Project  : ${cmt(spec.meta.title)}`,
    `| Program  : ${program}`,
    `| Author   : HEOR Studio deterministic emitter (machine-generated; analyst review required)`,
    `| Date     : run date &sysdate. / spec v${cmt(spec.meta.version)} (${provTxt})`,
    `| Emitter  : HEOR Studio ${EMITTER_VERSION} | spec hash ${stableHash(spec)}`,
    `| Database : ${spec.meta.database} | study period ${spec.meta.studyPeriod.start} to ${spec.meta.studyPeriod.end}`,
    ...purpose.map((p, i) => `| ${i === 0 ? "Purpose " : "        "} : ${cmt(p)}`),
    `| Note     : Generated by HEOR Studio. Regenerate from the reviewed StudySpec`,
    `|            rather than hand-editing derivation logic; every site-specific`,
    `|            name is configured in 00_setup.sas (lines marked EDIT).`,
    `${bar}*/`,
    ``,
  ];
}

export const INCLUDE_SETUP = [
  `%include "00_setup.sas";   /* EDIT: use the full site path to 00_setup.sas */`,
  ``,
];
