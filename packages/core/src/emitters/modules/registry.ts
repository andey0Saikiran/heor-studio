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
import { EMITTABLE_ANALYSIS_KINDS } from "../../spec/types";
import type { AnalysisModule } from "./types";
import { shapeFor } from "../suppression";
import { incidenceModule } from "./incidence";
import { pointPrevalenceModule } from "./point_prevalence";
import { periodPrevalenceModule } from "./period_prevalence";
import { cumulativeIncidenceModule } from "./cumulative_incidence";
import { standardizationModule } from "./standardization";
import { statisticalEngineModule } from "./statistical_engine";
import { calendarTrendModule } from "./calendar_trend";
import { resourceUseModule } from "./resource_use";
import { comorbidityIndexModule } from "./comorbidity_index";
import { regressionModule } from "./regression";

export const ANALYSIS_MODULES: Partial<Record<Analysis["kind"], AnalysisModule<never>>> = {
  incidence_rate: incidenceModule as AnalysisModule<never>,
  point_prevalence: pointPrevalenceModule as AnalysisModule<never>,
  period_prevalence: periodPrevalenceModule as AnalysisModule<never>,
  cumulative_incidence: cumulativeIncidenceModule as AnalysisModule<never>,
  standardization: standardizationModule as AnalysisModule<never>,
  statistical_engine: statisticalEngineModule as AnalysisModule<never>,
  calendar_trend: calendarTrendModule as AnalysisModule<never>,
  resource_use: resourceUseModule as AnalysisModule<never>,
  comorbidity_index: comorbidityIndexModule as AnalysisModule<never>,
  regression: regressionModule as AnalysisModule<never>,
};

/* Readiness (spec/types.ts EMITTABLE_ANALYSIS_KINDS) blocks enabled analyses
 * whose kind cannot be emitted. Fail LOUDLY at module load if that list and
 * this registry ever disagree — registering a module means adding its kind
 * there in the same commit (and vice versa). attrition/table1 are emitted by
 * the cohort spine, not by modules. */
const SPINE_EMITTED_KINDS = new Set<Analysis["kind"]>(["attrition", "table1"]);
{
  const registered = new Set(Object.keys(ANALYSIS_MODULES) as Array<Analysis["kind"]>);
  for (const kind of registered) {
    if (!EMITTABLE_ANALYSIS_KINDS.has(kind))
      throw new Error(
        `modules/registry: "${kind}" has a registered module but is missing from EMITTABLE_ANALYSIS_KINDS in spec/types.ts — readiness would block a working analysis.`
      );
  }
  for (const kind of EMITTABLE_ANALYSIS_KINDS) {
    if (!SPINE_EMITTED_KINDS.has(kind) && !registered.has(kind))
      throw new Error(
        `modules/registry: "${kind}" is declared emittable in spec/types.ts but has no registered module — readiness would approve an analysis the emitters silently drop.`
      );
  }
}

/* Every registered module produces a result table with patient counts, so every
 * module's stamp kind MUST have a suppression shape — otherwise its results
 * would be emitted with no disclosure control and nothing would say so. Same
 * fail-loudly-at-load principle as the readiness check above, applied to
 * compliance instead of correctness. */
{
  for (const [kind, mod] of Object.entries(ANALYSIS_MODULES)) {
    const stamp = (mod as AnalysisModule).stampKind;
    if (!shapeFor(stamp))
      throw new Error(
        `modules/registry: "${kind}" (stamp "${stamp}") has no entry in SUPPRESSION_SHAPES (emitters/suppression.ts) — its results would ship without small-cell suppression (BR-DEL-004).`
      );
  }
}

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
