/**
 * Analysis-module contract. Every analysis (incidence, prevalence, HCRU, ...)
 * lands as ONE file in this directory exporting an AnalysisModule, plus one
 * registration line in registry.ts — no edits to the emitter cores. That is
 * what makes parallel module development safe: modules never touch shared
 * files, and each one is gated by the verification harness before it merges.
 *
 * Contract every module MUST honor (see modules/incidence.ts, the reference):
 *  - sql() and sas() are TWINS: same spec parameters consumed, same arithmetic,
 *    byte-identical output labels — enforced by a shared PARITY stamp
 *    (emitters/parity.ts) that the harness deep-compares across languages.
 *  - Spec options the module does not implement yet are emitted as visible
 *    REVIEW notes in both languages, never silently ignored.
 *  - Output statistics are labeled with the method actually computed, never
 *    the merely-requested one.
 *  - New modules add a gold case to verify/fixture.ts with HAND-COMPUTED
 *    ground truth and register expectations in verify/run.ts.
 */
import type { Analysis } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { Ctx as SqlCtx } from "../sql-base";
import type { Ctx as SasCtx } from "../sas-base";

export type { SqlCtx, SasCtx };

/** What a module's sql() returns; the emitter core wraps it in the standard
 *  numbered-file header via mk(). */
export interface SqlModuleFile {
  /** file slug, e.g. "incidence" (suffix already applied by the module) */
  slug: string;
  /** BARE title (no file number) — the emitter prepends the NN so the displayed
   *  title always matches the actual NN_slug filename */
  title: string;
  subtitle: string;
  /** extra CONFIGURE header lines */
  extra: string[];
  body: string;
}

export interface AnalysisModule<A extends Analysis = Analysis> {
  /** discriminant this module handles, e.g. "incidence_rate" */
  analysisKind: A["kind"];
  /** PARITY stamp kind, e.g. "incidence" */
  stampKind: string;
  /** Base name of the result table/file, e.g. "incidence" / "pointprev".
   *  Declared once so BOTH emitters (and the suppression pass, which must find
   *  every table carrying patient counts) derive the same name — a module whose
   *  results the suppression pass cannot locate would ship unmasked cells. */
  resultSlug: string;
  /** SQL twin. `suffix` disambiguates when a spec has several analyses of the
   *  same kind (applies to slug AND output table names). */
  sql(ctx: SqlCtx, an: A, suffix: string): SqlModuleFile;
  /** SAS twin. `num` is the program number ("080", "090", ...). */
  sas(ctx: SasCtx, an: A, num: string, suffix: string): GeneratedFile;
}
