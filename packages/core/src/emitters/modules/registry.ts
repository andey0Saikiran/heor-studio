/**
 * Analysis-module registry — the ONLY place a new analysis module is wired in.
 * emitSql/emitSas dispatch through this map, and verify/parity.ts derives the
 * stamped-kind map from it, so registering a module automatically:
 *   - emits its SQL file (07, 08, ...) and SAS program (080, 090, ...),
 *   - enrolls it in the SAS↔SQL parity check.
 *
 * To land a new analysis: add modules/<kind>.ts (copy the shape of
 * modules/incidence.ts), register it here, add gold truth to verify/fixture.ts
 * + assertions in verify/run.ts, and run `npm run verify`.
 */
import type { Analysis } from "../../spec/types";
import type { AnalysisModule } from "./types";
import { incidenceModule } from "./incidence";

export const ANALYSIS_MODULES: Partial<Record<Analysis["kind"], AnalysisModule<never>>> = {
  incidence_rate: incidenceModule as AnalysisModule<never>,
};

/** analysis kind → PARITY stamp kind, for the verification harness. */
export const STAMP_KIND_BY_ANALYSIS: Record<string, string> = Object.fromEntries(
  Object.entries(ANALYSIS_MODULES).map(([kind, mod]) => [kind, (mod as AnalysisModule).stampKind])
);

/** The enabled analyses a spec wants that have a registered module, in spec
 *  order, with the per-kind suffix rule both emitters share (suffix only when
 *  a spec has several analyses of the same kind). */
export function moduleAnalyses(analyses: Analysis[]): Array<{ an: Analysis; mod: AnalysisModule; multi: boolean }> {
  const enabled = analyses.filter((a) => a.enabled && ANALYSIS_MODULES[a.kind]);
  const counts = new Map<string, number>();
  for (const a of enabled) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  return enabled.map((an) => ({
    an,
    mod: ANALYSIS_MODULES[an.kind] as AnalysisModule,
    multi: (counts.get(an.kind) ?? 0) > 1,
  }));
}
