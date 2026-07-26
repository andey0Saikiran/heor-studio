/**
 * Verification orchestrator — the reusable body behind `npm run verify` and the
 * MCP run_verification tool. Emits the Postgres SQL for a spec, executes it in
 * PGlite against the synthetic fixture, checks any provided ground-truth values,
 * and runs the invariant catalog. Returns a compact structured verdict (never
 * row-level data — safe to return over MCP).
 */
import { seedAndRun, scalar, rows } from "./engine";
import { runInvariants, type InvariantResult } from "./invariants";
import { sasSqlParityChecks } from "./parity";
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
  const checks = sasSqlParityChecks(spec, opts);
  const anyFail = invariants.some((i) => i.status === "fail") || checks.some((c) => c.status === "fail");
  return {
    status: ok && !anyFail ? "passed" : "failed",
    execution: steps,
    checks,
    invariants,
  };
}

/** Regression guard for the analyst-configurable person-time constant
 *  (spec.meta.daysPerYear). Asserts 365.25 -> 451.86 and 365 -> 451.55, locking
 *  in the fix for the integer-division bug the config first exposed. */
export async function verifyDaysPerYearChoice(): Promise<Check[]> {
  const out: Check[] = [];
  for (const [days, wantRate] of [[365.25, 451.86], [365, 451.55]] as const) {
    const spec: StudySpec = { ...GOLD_A_SPEC, meta: { ...GOLD_A_SPEC.meta, daysPerYear: days } };
    const { db, ok } = await seedAndRun(spec, GOLD_A_OPTS);
    const rate = ok ? await scalar<number>(db, "SELECT rate_per_1000py::float8 FROM tz_study_incidence WHERE stratum='Overall'") : undefined;
    const got = rate == null ? NaN : Number(rate);
    out.push({ name: `daysPerYear=${days} -> rate ${wantRate}`, status: Math.abs(got - wantRate) <= 0.01 ? "pass" : "fail", detail: `got ${got}` });
  }
  return out;
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

    // incidence-rate module (executed vs hand-computed ground truth)
    const approx = (name: string, got: number, want: number, tol: number) =>
      checks.push({ name, status: Math.abs(got - want) <= tol ? "pass" : "fail", detail: `expected ${want}±${tol}, got ${got}` });
    const inc = await rows<{ patients: number; denominator: number; person_days: number; person_years: number; rate_per_1000py: number; ci_low: number; ci_high: number }>(
      db, "SELECT patients, denominator, person_days::float8, person_years::float8, rate_per_1000py::float8, ci_low::float8, ci_high::float8 FROM tz_study_incidence WHERE stratum = 'Overall'",
    );
    const r0 = inc[0];
    if (!r0) {
      checks.push({ name: "incidence result row", status: "fail", detail: "tz_study_incidence has no Overall row" });
    } else {
      eq("incident cases = 3", Number(r0.patients), EXPECTED.incidentCases);
      eq("at-risk denominator = 8", Number(r0.denominator), EXPECTED.atRiskDenominator);
      eq("person-days = 2425", Number(r0.person_days), EXPECTED.personDays);
      approx("person-years = 6.6393", Number(r0.person_years), EXPECTED.personYears, 0.001);
      approx("crude rate = 451.86/1000PY", Number(r0.rate_per_1000py), EXPECTED.crudeRatePer1000PY, 0.01);
      approx("Byar CI low = 90.82", Number(r0.ci_low), EXPECTED.byarCiPer1000PY[0], 0.05);
      approx("Byar CI high = 1320.24", Number(r0.ci_high), EXPECTED.byarCiPer1000PY[1], 0.05);
    }

    // stratified incidence rows (executed vs hand-computed per-stratum truth)
    eq(
      `incidence rows = ${EXPECTED.incidenceRowCount} (Overall + strata)`,
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_incidence"),
      EXPECTED.incidenceRowCount,
    );
    for (const [stratifier, levels] of Object.entries(EXPECTED.incidenceStrata)) {
      for (const [stratum, want] of Object.entries(levels)) {
        const row = (
          await rows<{ patients: number; denominator: number; person_days: number; rate_per_1000py: number; ci_low: number; ci_high: number }>(
            db,
            `SELECT patients, denominator, person_days::float8, rate_per_1000py::float8, ci_low::float8, ci_high::float8
             FROM tz_study_incidence WHERE stratifier = '${stratifier}' AND stratum = '${stratum}'`,
          )
        )[0];
        const tag = `stratum ${stratifier}/${stratum}`;
        if (!row) {
          checks.push({ name: tag, status: "fail", detail: "row missing" });
          continue;
        }
        eq(`${tag}: cases = ${want.cases}`, Number(row.patients), want.cases);
        eq(`${tag}: denominator = ${want.denominator}`, Number(row.denominator), want.denominator);
        eq(`${tag}: person-days = ${want.personDays}`, Number(row.person_days), want.personDays);
        approx(`${tag}: rate = ${want.rate}`, Number(row.rate_per_1000py), want.rate, 0.01);
        approx(`${tag}: CI low = ${want.ci[0]}`, Number(row.ci_low), want.ci[0], 0.05);
        approx(`${tag}: CI high = ${want.ci[1]}`, Number(row.ci_high), want.ci[1], 0.05);
      }
    }

    invariants.push(...(await runInvariants(db, "tz_study")));
  }

  // SAS↔SQL twin parity: the SAS twin inherits this run's ground truth only if
  // it consumed identical parameters and carries the same arithmetic.
  checks.push(...sasSqlParityChecks(GOLD_A_SPEC, GOLD_A_OPTS));

  const anyFail = !ok || checks.some((c) => c.status === "fail") || invariants.some((i) => i.status === "fail");
  return { status: anyFail ? "failed" : "passed", execution: steps, checks, invariants };
}
