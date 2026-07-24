/**
 * Verification orchestrator — the reusable body behind `npm run verify` and the
 * MCP run_verification tool. Emits the Postgres SQL for a spec, executes it in
 * PGlite against the synthetic fixture, checks any provided ground-truth values,
 * and runs the invariant catalog. Returns a compact structured verdict (never
 * row-level data — safe to return over MCP).
 */
import { seedAndRun, scalar } from "./engine";
import { runInvariants, type InvariantResult } from "./invariants";
import { GOLD_A_SPEC, GOLD_A_OPTS, EXPECTED } from "./fixture";
import type { StudySpec, EmitOptions } from "../index";

export interface Check {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface VerificationResult {
  status: "passed" | "failed";
  execution: { path: string; ok: boolean; error?: string }[];
  checks: Check[];
  invariants: InvariantResult[];
}

/** Verify an arbitrary spec against the fixture: execute + invariants only
 *  (no gold-value checks unless it is a known gold case). */
export async function verifySpec(spec: StudySpec, opts: EmitOptions): Promise<VerificationResult> {
  const { db, steps, ok } = await seedAndRun(spec, opts);
  const invariants = ok ? await runInvariants(db, opts.tag.toLowerCase()) : [];
  const anyInvariantFail = invariants.some((i) => i.status === "fail");
  return {
    status: ok && !anyInvariantFail ? "passed" : "failed",
    execution: steps,
    checks: [],
    invariants,
  };
}

/** Full Gold Case A verification: execute + assert the hand-computed spine
 *  ground truth + invariants. (Descriptive-epi value checks activate once the
 *  incidence module lands in Step 4.) */
export async function verifyGoldA(): Promise<VerificationResult> {
  const { db, steps, ok } = await seedAndRun(GOLD_A_SPEC, GOLD_A_OPTS);
  const checks: Check[] = [];
  const invariants: InvariantResult[] = [];

  if (ok) {
    const eq = (name: string, got: number | undefined, want: number) =>
      checks.push({ name, status: got === want ? "pass" : "fail", detail: `expected ${want}, got ${got}` });

    eq("indexed cohort = 12", await scalar<number>(db, "SELECT count(*)::int FROM tz_study_index"), EXPECTED.indexed);
    eq("continuously enrolled = 11", await scalar<number>(db, "SELECT count(*)::int FROM tz_study_enrolled"), EXPECTED.continuouslyEnrolled);
    eq("final cohort N = 10", await scalar<number>(db, "SELECT count(*)::int FROM tz_study_cohort"), EXPECTED.finalCohortN);

    invariants.push(...(await runInvariants(db, "tz_study")));
  }

  const anyFail = !ok || checks.some((c) => c.status === "fail") || invariants.some((i) => i.status === "fail");
  return { status: anyFail ? "failed" : "passed", execution: steps, checks, invariants };
}
