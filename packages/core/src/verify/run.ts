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
import { mutationChecks } from "./mutation";
import { sasStructureChecks } from "./sas-lint";
import { emitSas } from "../emitters/sas";
import { GOLD_A_SPEC, GOLD_A_OPTS, EXPECTED } from "./fixture";
import type { StudySpec, EmitOptions } from "../index";

export interface Check {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface VerificationResult {
  /** "inconclusive" = the generated SQL executed cleanly but matched ZERO
   *  fixture patients, so every invariant was vacuously satisfied. Nothing
   *  numeric was actually exercised — do not present this as verification. */
  status: "passed" | "failed" | "inconclusive";
  execution: { path: string; ok: boolean; error?: string }[];
  checks: Check[];
  invariants: InvariantResult[];
  note?: string;
}

/** Verify an arbitrary spec against the fixture: execute + invariants only
 *  (no gold-value checks unless it is a known gold case). */
export async function verifySpec(spec: StudySpec, opts: EmitOptions): Promise<VerificationResult> {
  const { db, steps, ok } = await seedAndRun(spec, opts);
  const invariants = ok ? await runInvariants(db, opts.tag.toLowerCase()) : [];
  const checks = sasSqlParityChecks(spec, opts);
  const anyFail = invariants.some((i) => i.status === "fail") || checks.some((c) => c.status === "fail");
  // Zero-cohort gate: an empty cohort satisfies every count-of-violations
  // invariant, so "passed" would be a vacuous claim. Real-world specs are
  // EXPECTED to land here (the synthetic fixture only contains the gold
  // study's codes) — the honest verdict is inconclusive, not passed.
  const cohortN = ok
    ? Number((await scalar<number>(db, `SELECT count(*)::int FROM ${opts.tag.toLowerCase()}_cohort`)) ?? 0)
    : 0;
  const vacuous = ok && !anyFail && cohortN === 0;
  return {
    status: !ok || anyFail ? "failed" : vacuous ? "inconclusive" : "passed",
    execution: steps,
    checks,
    invariants,
    note: vacuous
      ? "Generated SQL executed without error, but the spec matched 0 patients in the synthetic fixture, so all invariants were vacuously satisfied. This proves the code RUNS — it does not verify any numbers. (Expected for real-world specs: the fixture only contains the gold study's codes.)"
      : undefined,
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

/** Small-cell suppression (BR-DEL-004), executed end to end.
 *
 *  Runs the gold spec with threshold 3 and asserts the RELEASED table masks
 *  exactly the cells it should — including the derivation-aware complementary
 *  mask, which is the part that is easy to get subtly wrong and impossible to
 *  notice by eye. Also asserts the originals are left intact for QC, so the
 *  analyst can still see real numbers while only the *_released table travels. */
export async function verifySuppression(): Promise<Check[]> {
  const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
  spec.suppression = { enabled: true, threshold: 3 };
  const { db, ok } = await seedAndRun(spec, GOLD_A_OPTS);
  const out: Check[] = [];
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });
  if (!ok) return [{ name: "suppression pass executes", status: "fail", detail: "execution failed" }];

  const released = await rows<{ stratifier: string; stratum: string; patients: number | null; denominator: number | null; suppressed: number; suppression_rule: string }>(
    db,
    "SELECT stratifier, stratum, patients, denominator, suppressed, suppression_rule FROM tz_study_incidence_released ORDER BY stratifier, stratum",
  );
  const want = EXPECTED.suppressionThreshold3;
  push("suppression: released table has every source row", released.length === EXPECTED.incidenceRowCount,
    `expected ${EXPECTED.incidenceRowCount}, got ${released.length}`);

  const find = (s: string, st: string) => released.find((r) => r.stratifier === s && r.stratum === st);
  for (const [s, st] of want.masked) {
    const r = find(s, st);
    push(`suppression: ${s}/${st} is masked`,
      !!r && r.suppressed === 1 && r.patients === null && r.denominator === null,
      r ? `suppressed=${r.suppressed} patients=${r.patients} denominator=${r.denominator}` : "row missing");
  }
  for (const [s, st] of want.visible) {
    const r = find(s, st);
    push(`suppression: ${s}/${st} stays visible`,
      !!r && r.suppressed === 0 && r.patients !== null,
      r ? `suppressed=${r.suppressed} patients=${r.patients}` : "row missing");
  }
  push("suppression: every released row carries the rule label",
    released.every((r) => typeof r.suppression_rule === "string" && r.suppression_rule.includes("3")),
    released[0]?.suppression_rule ?? "none");

  // the unsuppressed original must survive untouched for the analyst's QC
  const raw = await scalar<number>(db, "SELECT count(*)::int FROM tz_study_incidence WHERE patients IS NULL");
  push("suppression: original table is left intact for QC", raw === 0, `${raw} NULL patient counts in the source table`);

  /* A masked group must not be reconstructible: at least TWO cells masked in any
   * group that has a masked cell (or the whole group is a single row). This is
   * the property complementary suppression exists to guarantee. */
  const weak = await rows<{ stratifier: string; n_masked: number; n_cells: number }>(
    db,
    `SELECT stratifier, SUM(suppressed)::int AS n_masked, COUNT(*)::int AS n_cells
     FROM tz_study_incidence_released GROUP BY stratifier
     HAVING SUM(suppressed) = 1 AND COUNT(*) > 1`,
  );
  push("suppression: no group is left with exactly one masked cell (derivation-aware)",
    weak.length === 0,
    weak.length === 0 ? "every masked group has >= 2 masked cells" : weak.map((w) => `${w.stratifier}: 1 of ${w.n_cells}`).join(", "));

  /* Results contract — one tidy long-format table over every released result,
   * so a table shell reads ONE shape. The property that matters: it is built
   * from the RELEASED tables, so no masked value can reach a deliverable. */
  const tables = await rows<{ table_id: string; c: number }>(
    db,
    "SELECT table_id, count(*)::int AS c FROM tz_study_results GROUP BY table_id",
  );
  const expectedTables = 1 /* table1 */ + 8 /* module analyses in the gold spec */;
  push("results contract: every result table is represented", tables.length === expectedTables,
    `expected ${expectedTables} tables, got ${tables.length}`);

  const leak = await scalar<number>(db, "SELECT count(*)::int FROM tz_study_results WHERE suppressed = 1 AND value IS NOT NULL");
  push("results contract: no masked cell leaks a value into the deliverable", leak === 0, `${leak} suppressed rows carry a value`);

  const shape = await scalar<number>(
    db,
    `SELECT count(*)::int FROM tz_study_results
     WHERE table_id IS NULL OR row_group IS NULL OR row_level IS NULL OR stat IS NULL OR suppression_rule IS NULL`,
  );
  push("results contract: every row is fully labeled", shape === 0, `${shape} rows missing an identifying column`);

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

    /* Enrollment stitching with NESTED segments (P13; see fixture).
     * Comparing a segment's start against only the PREVIOUS row's end splits
     * an episode that a running MAX of all prior ends correctly continues.
     * P13 has no index claim, so this asserts the stitching step directly. */
    const p13 = await rows<{ episode_start: string; episode_end: string }>(
      db,
      "SELECT episode_start::text, episode_end::text FROM tz_study_enroll_episodes WHERE enrolid = 13 ORDER BY episode_start",
    );
    eq("nested segments stitch into ONE episode (P13)", p13.length, 1);
    checks.push({
      name: "nested-segment episode spans the full coverage (P13)",
      status: p13[0]?.episode_start === "2018-01-01" && p13[0]?.episode_end === "2020-06-30" ? "pass" : "fail",
      detail: `expected 2018-01-01..2020-06-30, got ${p13[0]?.episode_start ?? "none"}..${p13[0]?.episode_end ?? "none"}`,
    });

    /* One multi-day inpatient stay must yield ONE event, not one per source
     * table (P14; see fixture). Inpatient diagnoses appear on both the service
     * lines and the admission record; dating the two differently double-counts
     * a single stay and can satisfy a minClaims>=2 rule on its own. */
    const p14 = await rows<{ event_date: string }>(
      db,
      "SELECT event_date::text FROM tz_study_events WHERE enrolid = 14 ORDER BY event_date",
    );
    eq("one inpatient stay = one event row (P14)", p14.length, 1);
    checks.push({
      name: "inpatient event is dated at admission (P14)",
      status: p14[0]?.event_date === "2019-05-01" ? "pass" : "fail",
      detail: `expected 2019-05-01 (admission), got ${p14.map((r) => r.event_date).join(", ") || "none"}`,
    });

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

    // ---- cumulative incidence (executed vs hand-computed Wilson ground truth) ----
    const ci = EXPECTED.cumulativeIncidence;
    const ciRow = async (table: string, stratifier: string, stratum: string) =>
      (
        await rows<{ patients: number; denominator: number; risk: number; risk_pct: number; ci_low: number; ci_high: number }>(
          db,
          `SELECT patients, denominator, risk::float8, risk_pct::float8, ci_low::float8, ci_high::float8
           FROM ${table} WHERE stratifier = '${stratifier}' AND stratum = '${stratum}'`,
        )
      )[0];
    const checkCi = (tag: string, r: Awaited<ReturnType<typeof ciRow>>, w: { patients: number; denominator: number; risk: number; pct: number; ci: [number, number] }) => {
      if (!r) { checks.push({ name: tag, status: "fail", detail: "row missing" }); return; }
      eq(`${tag}: cases = ${w.patients}`, Number(r.patients), w.patients);
      eq(`${tag}: denominator = ${w.denominator}`, Number(r.denominator), w.denominator);
      approx(`${tag}: risk = ${w.risk}`, Number(r.risk), w.risk, 0.00001);
      approx(`${tag}: pct = ${w.pct}`, Number(r.risk_pct), w.pct, 0.01);
      approx(`${tag}: Wilson CI low = ${w.ci[0]}`, Number(r.ci_low), w.ci[0], 0.00001);
      approx(`${tag}: Wilson CI high = ${w.ci[1]}`, Number(r.ci_high), w.ci[1], 0.00001);
    };
    eq(
      `cumulative-incidence rows = ${ci.ci365.rowCount} (Overall + strata)`,
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_cuminc_a_ci_365"),
      ci.ci365.rowCount,
    );
    checkCi("ci365 Overall", await ciRow("tz_study_cuminc_a_ci_365", "Overall", "Overall"), ci.ci365.overall);
    for (const [stratifier, levels] of Object.entries(ci.ci365.strata)) {
      for (const [stratum, want] of Object.entries(levels)) {
        checkCi(`ci365 ${stratifier}/${stratum}`, await ciRow("tz_study_cuminc_a_ci_365", stratifier, stratum), want);
      }
    }
    // shorter horizon: only P02's day-100 event is within 180d → 1/8
    checkCi("ci180 Overall", await ciRow("tz_study_cuminc_a_ci_180", "Overall", "Overall"), ci.ci180);

    invariants.push(...(await runInvariants(db, "tz_study")));
  }

  // SAS↔SQL twin parity: the SAS twin inherits this run's ground truth only if
  // it consumed identical parameters and carries the same arithmetic.
  checks.push(...sasSqlParityChecks(GOLD_A_SPEC, GOLD_A_OPTS));

  // Mutation tests: corrupt the emitted code and assert the parity checks above
  // actually go red. Without this, a green suite proves nothing about its own
  // sensitivity — which is exactly how the stamp-only checks stayed green while
  // being incapable of failing.
  checks.push(...mutationChecks());

  // The SAS twin is never executed, so at minimum it must be well-formed:
  // balanced comments/parens, closed procs and data steps, no undefined macros.
  checks.push(...sasStructureChecks(emitSas(GOLD_A_SPEC, GOLD_A_OPTS)));

  const anyFail = !ok || checks.some((c) => c.status === "fail") || invariants.some((i) => i.status === "fail");
  return { status: anyFail ? "failed" : "passed", execution: steps, checks, invariants };
}
