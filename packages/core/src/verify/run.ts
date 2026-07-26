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

/** Negative control for the outcome care-setting filter: the gold analysis
 *  (setting "outpatient") must EXCLUDE P05's planted inpatient AE (asserted in
 *  verifyGoldA: 3 cases / 2425 pd); this clone with setting "any" must INCLUDE
 *  it. If the filter were silently dropped, verifyGoldA would fail; if it were
 *  over-applied, this check would. */
export async function verifySettingFilterControl(): Promise<Check[]> {
  const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
  const an = spec.analyses.find((a) => a.kind === "incidence_rate");
  if (an && an.kind === "incidence_rate") an.outcomeDefinition.setting = "any";
  const { db, ok } = await seedAndRun(spec, GOLD_A_OPTS);
  const out: Check[] = [];
  if (!ok) return [{ name: "setting=any control executes", status: "fail", detail: "execution failed" }];
  const row = (
    await rows<{ patients: number; person_days: number; rate_per_1000py: number; ci_low: number; ci_high: number }>(
      db,
      "SELECT patients, person_days::float8, rate_per_1000py::float8, ci_low::float8, ci_high::float8 FROM tz_study_incidence WHERE stratum = 'Overall'",
    )
  )[0];
  const want = EXPECTED.settingAny;
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });
  if (!row) return [{ name: "setting=any control row", status: "fail", detail: "no Overall row" }];
  push(`setting=any -> cases ${want.cases} (inpatient AE included)`, Number(row.patients) === want.cases, `got ${row.patients}`);
  push(`setting=any -> person-days ${want.personDays}`, Number(row.person_days) === want.personDays, `got ${row.person_days}`);
  push(`setting=any -> rate ${want.rate}`, Math.abs(Number(row.rate_per_1000py) - want.rate) <= 0.01, `got ${row.rate_per_1000py}`);
  push(`setting=any -> Byar CI (${want.ci[0]}, ${want.ci[1]})`,
    Math.abs(Number(row.ci_low) - want.ci[0]) <= 0.05 && Math.abs(Number(row.ci_high) - want.ci[1]) <= 0.05,
    `got (${row.ci_low}, ${row.ci_high})`);
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

    // ---- point prevalence (executed vs hand-computed Wilson ground truth) ----
    const pp = EXPECTED.pointPrevalence;
    eq(
      `point-prevalence rows = ${pp.main.rowCount} (Overall + strata)`,
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_pointprev_a_pp_main"),
      pp.main.rowCount,
    );
    const ppRow = async (table: string, stratifier: string, stratum: string) =>
      (
        await rows<{ patients: number; denominator: number; prevalence: number; prevalence_pct: number; ci_low: number; ci_high: number }>(
          db,
          `SELECT patients, denominator, prevalence::float8, prevalence_pct::float8, ci_low::float8, ci_high::float8
           FROM ${table} WHERE stratifier = '${stratifier}' AND stratum = '${stratum}'`,
        )
      )[0];
    const checkPp = (tag: string, r: Awaited<ReturnType<typeof ppRow>>, w: { patients: number; denominator: number; prevalence: number; pct: number; ci: [number, number] }) => {
      if (!r) { checks.push({ name: tag, status: "fail", detail: "row missing" }); return; }
      eq(`${tag}: cases = ${w.patients}`, Number(r.patients), w.patients);
      eq(`${tag}: denominator = ${w.denominator}`, Number(r.denominator), w.denominator);
      approx(`${tag}: prevalence = ${w.prevalence}`, Number(r.prevalence), w.prevalence, 0.00001);
      approx(`${tag}: pct = ${w.pct}`, Number(r.prevalence_pct), w.pct, 0.01);
      approx(`${tag}: Wilson CI low = ${w.ci[0]}`, Number(r.ci_low), w.ci[0], 0.00001);
      approx(`${tag}: Wilson CI high = ${w.ci[1]}`, Number(r.ci_high), w.ci[1], 0.00001);
    };
    checkPp("pp_main Overall", await ppRow("tz_study_pointprev_a_pp_main", "Overall", "Overall"), pp.main.overall);
    for (const [stratifier, levels] of Object.entries(pp.main.strata)) {
      for (const [stratum, want] of Object.entries(levels)) {
        checkPp(`pp_main ${stratifier}/${stratum}`, await ppRow("tz_study_pointprev_a_pp_main", stratifier, stratum), want);
      }
    }
    // index anchor reproduces the frozen baseline prevalence (0.2) via a distinct path
    checkPp("pp_idx Overall", await ppRow("tz_study_pointprev_a_pp_idx", "Overall", "Overall"), pp.idx);
    // end-of-study anchor: after every episode → zero denominator, NULL statistics
    eq("pp_eos rows = 1", await scalar<number>(db, "SELECT count(*)::int FROM tz_study_pointprev_a_pp_eos"), 1);
    const eos = await ppRow("tz_study_pointprev_a_pp_eos", "Overall", "Overall");
    eq("pp_eos cases = 0", Number(eos?.patients), pp.eos.patients);
    eq("pp_eos denominator = 0", Number(eos?.denominator), pp.eos.denominator);
    eq(
      "pp_eos prevalence/CI all NULL",
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_pointprev_a_pp_eos WHERE prevalence IS NULL AND ci_low IS NULL AND ci_high IS NULL"),
      1,
    );

    // ---- period prevalence (executed vs hand-computed Wilson ground truth) ----
    const perp = EXPECTED.periodPrevalence;
    eq(
      `period-prevalence rows = ${perp.p2019.rowCount} (Overall + strata)`,
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_periodprev_a_perp_2019"),
      perp.p2019.rowCount,
    );
    checkPp("perp_2019 Overall", await ppRow("tz_study_periodprev_a_perp_2019", "Overall", "Overall"), perp.p2019.overall);
    for (const [stratifier, levels] of Object.entries(perp.p2019.strata)) {
      for (const [stratum, want] of Object.entries(levels)) {
        checkPp(`perp_2019 ${stratifier}/${stratum}`, await ppRow("tz_study_periodprev_a_perp_2019", stratifier, stratum), want);
      }
    }
    // empty period (after every episode) → zero denominator, NULL statistics
    eq("perp_empty rows = 1", await scalar<number>(db, "SELECT count(*)::int FROM tz_study_periodprev_a_perp_empty"), 1);
    const perpEmpty = await ppRow("tz_study_periodprev_a_perp_empty", "Overall", "Overall");
    eq("perp_empty cases = 0", Number(perpEmpty?.patients), perp.empty.patients);
    eq("perp_empty denominator = 0", Number(perpEmpty?.denominator), perp.empty.denominator);
    eq(
      "perp_empty prevalence/CI all NULL",
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_periodprev_a_perp_empty WHERE prevalence IS NULL AND ci_low IS NULL AND ci_high IS NULL"),
      1,
    );

    invariants.push(...(await runInvariants(db, "tz_study")));
  }

  // SAS↔SQL twin parity: the SAS twin inherits this run's ground truth only if
  // it consumed identical parameters and carries the same arithmetic.
  checks.push(...sasSqlParityChecks(GOLD_A_SPEC, GOLD_A_OPTS));

  const anyFail = !ok || checks.some((c) => c.status === "fail") || invariants.some((i) => i.status === "fail");
  return { status: anyFail ? "failed" : "passed", execution: steps, checks, invariants };
}
