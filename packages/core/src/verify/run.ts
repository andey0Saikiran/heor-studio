/**
 * Verification orchestrator — the reusable body behind `npm run verify` and the
 * MCP run_verification tool. Emits the Postgres SQL for a spec, executes it in
 * PGlite against the synthetic fixture, checks any provided ground-truth values,
 * and runs the invariant catalog. Returns a compact structured verdict (never
 * row-level data — safe to return over MCP).
 */
import { seedAndRun, scalar, rows } from "./engine";
import { emitSql } from "../emitters/sql";
import { parseParityStamps } from "../emitters/parity";
import { fingerprint } from "./fingerprint";
import { runInvariants, type InvariantResult } from "./invariants";
import { sasSqlParityChecks } from "./parity";
import { mutationChecks } from "./mutation";
import { sasStructureChecks } from "./sas-lint";
import { emitSas } from "../emitters/sas";
import { GOLD_A_SPEC, GOLD_A_OPTS, EXPECTED } from "./fixture";
import { GOLD_B_SPEC, GOLD_B_OPTS, EXPECTED_B, fixtureBSeedSql } from "./fixture-b";
import { EMITTABLE_ANALYSIS_KINDS } from "../spec/types";
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
  // derived, not hard-coded: adding a module must not require editing this
  const expectedTables =
    (spec.analyses.some((a) => a.enabled && a.kind === "table1") ? 1 : 0) +
    spec.analyses.filter((a) => a.enabled && EMITTABLE_ANALYSIS_KINDS.has(a.kind) && a.kind !== "table1" && a.kind !== "attrition").length;
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

/** Prevalent-case washout: the incidence<->prevalence TOGGLE test.
 *
 *  The coverage matrix asks for exactly this and it had never been built: run
 *  the SAME outcome definition as an INCIDENCE measure (washout applied, at-risk
 *  denominator) and as a PERIOD-PREVALENCE measure (no washout, enrolled-anytime
 *  denominator), and assert the only thing that moves is the denominator — by
 *  precisely the number of prevalent cases the washout removed.
 *
 *  On the gold fixture: cohort 10, prevalent-in-baseline 2 (P01, P06), at-risk 8.
 *  So prevalence denominator (10) - incidence denominator (8) = 2 = prevalent.
 *  If the washout silently stopped applying, the two denominators would collapse
 *  to the same number and this check fails — which no other check would catch,
 *  because the incidence gold numbers would still be internally consistent. */
export async function verifyWashoutToggle(): Promise<Check[]> {
  const out: Check[] = [];
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });

  const { db, ok } = await seedAndRun(GOLD_A_SPEC, GOLD_A_OPTS);
  if (!ok) return [{ name: "washout toggle executes", status: "fail", detail: "execution failed" }];

  const incDenom = await scalar<number>(db, "SELECT denominator FROM tz_study_incidence WHERE stratum = 'Overall'");
  const prevDenom = await scalar<number>(db, "SELECT denominator FROM tz_study_periodprev_a_perp_2019 WHERE stratum = 'Overall'");
  const cohortN = await scalar<number>(db, "SELECT count(*)::int FROM tz_study_cohort");

  push("washout toggle: prevalence denominator = whole cohort (no washout)",
    Number(prevDenom) === Number(cohortN), `prevalence ${prevDenom} vs cohort ${cohortN}`);
  push("washout toggle: incidence denominator = cohort MINUS prevalent cases",
    Number(incDenom) === Number(cohortN) - EXPECTED.prevalentM,
    `incidence ${incDenom}, cohort ${cohortN}, prevalent ${EXPECTED.prevalentM}`);
  push(`washout toggle: the ONLY difference is the ${EXPECTED.prevalentM} washed-out prevalent cases`,
    Number(prevDenom) - Number(incDenom) === EXPECTED.prevalentM,
    `difference ${Number(prevDenom) - Number(incDenom)}, expected ${EXPECTED.prevalentM}`);

  /* Zero-check invariant the matrix names: no subject may be counted BOTH as
   * washed-out-prevalent and as an incident case. The at-risk set is built by
   * anti-join, so this is structural — but asserting it is what turns "we think
   * the anti-join is right" into "the executed result says so". */
  const overlap = await scalar<number>(
    db,
    `WITH prevalent AS (
       SELECT DISTINCT c.enrolid
       FROM tz_study_cohort c
       JOIN tz_study_events e ON e.enrolid = c.enrolid AND e.code_list_id = 'ae_dx' AND e.setting = 'outpatient'
       WHERE e.event_date >= (c.index_date - 365) AND e.event_date <= c.index_date
     ),
     incident AS (
       SELECT DISTINCT c.enrolid
       FROM tz_study_cohort c
       JOIN tz_study_events e ON e.enrolid = c.enrolid AND e.code_list_id = 'ae_dx' AND e.setting = 'outpatient'
       WHERE e.event_date > c.index_date
     )
     SELECT count(*)::int FROM prevalent p JOIN incident i ON i.enrolid = p.enrolid`,
  );
  /* Washout ATTRITION ADDENDUM: the matrix asks for "N excluded-as-prevalent"
   * to be reported, not merely applied. An analyst cannot defend a denominator
   * they cannot see the derivation of. */
  const add = await rows<{ step: number; description: string; n: number }>(
    db, "SELECT step, description, n FROM tz_study_incidence_washout ORDER BY step");
  push("washout addendum: reports cohort -> excluded -> at-risk",
    add.length === 3 && Number(add[0].n) === Number(cohortN) &&
      Number(add[1].n) === EXPECTED.prevalentM && Number(add[2].n) === EXPECTED.atRiskDenominator,
    add.map((r) => `${r.description}=${r.n}`).join("; "));
  push("washout addendum: the three counts reconcile",
    add.length === 3 && Number(add[0].n) - Number(add[1].n) === Number(add[2].n),
    add.length === 3 ? `${add[0].n} - ${add[1].n} = ${add[2].n}` : "addendum missing");

  push("washout toggle: (washed-out prevalent AND counted incident) = 0",
    Number(overlap) === 0, `${overlap} subjects in both sets`);
  return out;
}

/** studyPeriod must NOT truncate the washout lookback.
 *
 *  The event pull was bounded to meta.studyPeriod, but baseline lookbacks and
 *  prevalent-case washouts reach outside it. A protocol whose "study period"
 *  means the IDENTIFICATION window — a very common reading — therefore lost its
 *  entire washout: excluded-as-prevalent fell from 2 to 0 and the at-risk
 *  denominator rose from 8 to 10, while the code ran cleanly and reported
 *  success. Silent and plausible, so nothing else would have caught it.
 *
 *  Both readings of studyPeriod must now give the SAME cohort numbers. */
/**
 * The DELIVERY's observation limit must reach BOTH twins.
 *
 * This guard exists because it did not. `meta.dataCutDate` was applied by the
 * SQL builder and ignored by the SAS builder, so a study declaring a cut got
 * two different person-times from one bundle — and nothing failed: the PARITY
 * stamp recorded `censorAt` (which both read from the same field), the
 * fingerprints scraped the max-follow-up offset rather than the bound, and Gold
 * Case A does not declare a cut, so no fixture ever ran the path.
 *
 * The censoring plan now lives in rate-core and each language only renders it,
 * which makes the divergence structurally impossible. This asserts it anyway,
 * ON A SPEC THAT DECLARES A CUT — the condition the original defect needed.
 */
export function verifyDataCutReachesBothTwins(): Check[] {
  const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
  spec.meta.dataCutDate = "2020-03-31";
  spec.meta.claimsRunoutMonths = 3; // effective bound: 2019-12-31
  const EFFECTIVE = "2019-12-31";
  const out: Check[] = [];

  const sqlProg = emitSql(spec, "postgres", GOLD_A_OPTS).find((f) => /incidence/.test(f.path))?.content ?? "";
  const sasFiles = emitSas(spec, GOLD_A_OPTS);
  const sasProg = sasFiles.find((f) => /incidence/.test(f.path))?.content ?? "";
  const setup = sasFiles.find((f) => /setup/i.test(f.path))?.content ?? "";

  const fpSql = fingerprint("incidence", "sql", sqlProg);
  const fpSas = fingerprint("incidence", "sas", sasProg, setup);
  out.push({
    name: "data cut: both twins bound follow-up at the SAME dates",
    status: fpSql.censor_bounds === fpSas.censor_bounds ? "pass" : "fail",
    detail: fpSql.censor_bounds === fpSas.censor_bounds
      ? `censor bounds ${fpSql.censor_bounds} in both languages`
      : `sql bounds [${fpSql.censor_bounds}] vs sas bounds [${fpSas.censor_bounds}] — one twin is censoring somewhere the other is not`,
  });
  for (const [lang, fp] of [["sql", fpSql], ["sas", fpSas]] as const) {
    out.push({
      name: `data cut: the ${lang} twin actually applies the ${EFFECTIVE} bound`,
      status: (fp.censor_bounds ?? "").split(",").includes(EFFECTIVE) ? "pass" : "fail",
      detail: (fp.censor_bounds ?? "").split(",").includes(EFFECTIVE)
        ? `cut applied (data cut 2020-03-31 minus 3 months run-out)`
        : `bounds are [${fp.censor_bounds}] — the immature tail would be counted as event-free person-time`,
    });
  }
  /* PROOF THE GUARD CAN FAIL. Strip the cut from the SAS twin — reproducing
   * the exact defect this guard was written for — and assert the comparison
   * goes red. A guard that has only ever been green is an unproven guard. */
  {
    const broken = sasProg.replace(/,\s*'31DEC2019'd/g, "");
    const changed = broken !== sasProg;
    const fpBroken = fingerprint("incidence", "sas", broken, setup);
    out.push({
      name: "data cut: the guard DETECTS a twin that drops the cut (self-test)",
      status: changed && fpBroken.censor_bounds !== fpSql.censor_bounds ? "pass" : "fail",
      detail: !changed
        ? "mutation pattern did not match — the self-test is vacuous"
        : fpBroken.censor_bounds !== fpSql.censor_bounds
          ? `stripping the cut from SAS yields [${fpBroken.censor_bounds}] vs sql [${fpSql.censor_bounds}] — detected`
          : "NOT DETECTED — the guard would have missed the original defect",
    });
  }

  // and the stamp must say so, in both languages
  for (const [lang, prog] of [["sql", sqlProg], ["sas", sasProg]] as const) {
    const stamp = parseParityStamps(prog).find((s) => s.kind === "incidence")?.values ?? {};
    out.push({
      name: `data cut: the ${lang} PARITY stamp records it`,
      status: stamp.dataCut === EFFECTIVE ? "pass" : "fail",
      detail: `stamp dataCut = ${JSON.stringify(stamp.dataCut)}`,
    });
  }
  return out;
}

export async function verifyAscertainmentWindow(): Promise<Check[]> {
  const out: Check[] = [];
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });

  const measure = async (start: string, end: string) => {
    const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    spec.meta.studyPeriod = { start, end };
    const { db, ok } = await seedAndRun(spec, GOLD_A_OPTS);
    if (!ok) return null;
    return {
      denom: Number(await scalar<number>(db, "SELECT denominator FROM tz_study_incidence WHERE stratum='Overall'")),
      excluded: Number(await scalar<number>(db, "SELECT n FROM tz_study_incidence_washout WHERE step = 2")),
    };
  };

  const wide = await measure("2018-01-01", "2020-12-31");
  const narrow = await measure("2019-01-01", "2019-12-31"); // identification-window reading
  if (!wide || !narrow) return [{ name: "ascertainment window executes", status: "fail", detail: "execution failed" }];

  push("ascertainment: narrow studyPeriod still finds the prevalent cases",
    narrow.excluded === EXPECTED.prevalentM, `excluded ${narrow.excluded}, expected ${EXPECTED.prevalentM}`);
  push("ascertainment: narrow studyPeriod gives the same at-risk denominator",
    narrow.denom === EXPECTED.atRiskDenominator, `at-risk ${narrow.denom}, expected ${EXPECTED.atRiskDenominator}`);
  push("ascertainment: the two studyPeriod readings agree",
    wide.denom === narrow.denom && wide.excluded === narrow.excluded,
    `wide ${wide.denom}/${wide.excluded} vs narrow ${narrow.denom}/${narrow.excluded}`);
  return out;
}

/** Full Gold Case A verification: execute + assert the hand-computed spine
 *  ground truth + invariants. (Descriptive-epi value checks activate once the
 *  incidence module lands in Step 4.) */
/**
 * Gold Case B — recurrent events and overdispersion, in its own PGlite.
 *
 * Its whole reason to exist is a condition Gold Case A cannot produce: on A no
 * at-risk subject has more than one qualifying event, so the response is
 * Bernoulli, its variance is necessarily below its mean, and the negative
 * binomial dispersion parameter is not identified. B is seeded so it IS.
 *
 * A separate seed rather than an append, because an extra indexed patient in A
 * would move attrition, the at-risk count, the 2425 person-days and every rate,
 * prevalence, SMD and regression estimate at once.
 */
export async function verifyGoldB(): Promise<Check[]> {
  const { db, ok, steps } = await seedAndRun(GOLD_B_SPEC, GOLD_B_OPTS, fixtureBSeedSql());
  const out: Check[] = [];
  if (!ok) {
    return [{
      name: "Gold Case B executes",
      status: "fail",
      detail: steps.filter((x) => !x.ok).map((x) => `${x.path}: ${x.error}`).join(" | "),
    }];
  }
  const eq = (name: string, got: number | undefined, want: number) =>
    out.push({ name, status: got === want ? "pass" : "fail", detail: `expected ${want}, got ${got}` });
  const approx = (name: string, got: number, want: number, tol: number) =>
    out.push({ name, status: Math.abs(got - want) <= tol ? "pass" : "fail", detail: `expected ${want}±${tol}, got ${got}` });

  eq("B: cohort N = 8", await scalar<number>(db, "SELECT count(*)::int FROM tz_b_cohort"), EXPECTED_B.cohortN);
  const row = async (component: string, term: string, statistic: string) =>
    (
      await rows<{ estimate: number | null; ci_low: number | null; ci_high: number | null; se_log: number | null; method: string }>(
        db,
        `SELECT estimate::float8, ci_low::float8, ci_high::float8, se_log::float8, method
           FROM tz_b_glm WHERE component = '${component}' AND term = '${term}' AND statistic = '${statistic}'`,
      )
    )[0];
  for (const [arm, want] of [["DRUG_Y", EXPECTED_B.design.exposed], ["DRUG_X", EXPECTED_B.design.reference]] as const) {
    eq(`B ${arm}: subjects = ${want.n}`, Number((await row("design", arm, "n"))?.estimate), want.n);
    eq(`B ${arm}: RECURRENT event count = ${want.events}`, Number((await row("design", arm, "events"))?.estimate), want.events);
    eq(`B ${arm}: person-days = ${EXPECTED_B.personDaysPerArm}`, Number((await row("design", arm, "person_days"))?.estimate), EXPECTED_B.personDaysPerArm);
    approx(`B ${arm}: rate = ${want.ratePer1000py}/1000PY`, Number((await row("design", arm, "rate_per_1000py"))?.estimate), want.ratePer1000py, 0.00001);
  }
  const rr = await row("crude", "Index drug", "rate_ratio");
  approx("B: rate ratio = 2.0 EXACTLY (equal person-time cancels)", Number(rr?.estimate), EXPECTED_B.rateRatio.estimate, 0.00001);
  approx(`B: RR CI low = ${EXPECTED_B.rateRatio.ciLow}`, Number(rr?.ci_low), EXPECTED_B.rateRatio.ciLow, 0.00001);
  approx(`B: RR CI high = ${EXPECTED_B.rateRatio.ciHigh}`, Number(rr?.ci_high), EXPECTED_B.rateRatio.ciHigh, 0.00001);
  approx("B: SE(log RR) = sqrt(0.375)", Number(rr?.se_log), EXPECTED_B.rateRatio.seLog, 0.00001);
  approx("B: rate difference = 1000.68493/1000PY", Number((await row("crude", "Index drug", "rate_difference_per_1000py"))?.estimate), EXPECTED_B.rateDifference, 0.00001);
  out.push({
    name: "B: the saturated anchor value is ln(2)",
    status: Math.abs(Math.log(Number(rr?.estimate)) - EXPECTED_B.logRr) < 0.0001 ? "pass" : "fail",
    detail: `ln(${rr?.estimate}) = ${Math.log(Number(rr?.estimate)).toFixed(7)}`,
  });

  /* THE POINT OF THIS CASE. On Gold A the ratio is 0.71 and the program reports
   * the dispersion parameter as unidentified; here it is 3.62 and the program
   * says NB is warranted. Same emitter, opposite verdicts, both from data. */
  const vm = await row("diagnostic", "overdispersion", "variance_to_mean_ratio");
  approx("B: variance-to-mean ratio = 3.61905 (counts 1,1,2,0,0,0,1,7)", Number(vm?.estimate), EXPECTED_B.varianceToMeanRatio, 0.00001);
  out.push({
    name: "B: the program declares OVERDISPERSION, so negative binomial is warranted",
    status: (vm?.method ?? "").startsWith("OVERDISPERSED") ? "pass" : "fail",
    detail: vm?.method ?? "no diagnostic row",
  });
  const mx = await row("diagnostic", "overdispersion", "max_events_per_subject");
  eq("B: max events per subject = 7 (the recurrence Gold A lacks)", Number(mx?.estimate), EXPECTED_B.maxEventsPerSubject);
  out.push({
    name: "B: dispersion is ESTIMABLE here, unlike Gold Case A",
    status: (mx?.method ?? "") === "dispersion is estimable" ? "pass" : "fail",
    detail: mx?.method ?? "no diagnostic row",
  });
  // parity for B's own emission, not just A's
  out.push(...sasSqlParityChecks(GOLD_B_SPEC, GOLD_B_OPTS));
  out.push(...sasStructureChecks(emitSas(GOLD_B_SPEC, GOLD_B_OPTS)));
  return out;
}

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

    /* ---- covariate balance (SMD), executed vs hand-computed ground truth ----
     * The gold arms are DELIBERATELY imbalanced on age and balanced on sex, so
     * the imbalance flag is exercised in both directions. smdAge has been
     * pinned in the fixture since long before the module existed. */
    const bal = EXPECTED.balance;
    const balRows = await rows<{ characteristic: string; measure: string; n_ref: number; n_oth: number; value_ref: number; value_oth: number; smd: number; imbalanced: number }>(
      db,
      `SELECT characteristic, measure, n_ref, n_oth, value_ref::float8, value_oth::float8, smd::float8, imbalanced
       FROM tz_study_balance ORDER BY characteristic`,
    );
    eq(`balance rows = ${bal.rowCount}`, balRows.length, bal.rowCount);
    const checkBal = (tag: string, r: (typeof balRows)[number] | undefined, w: { nRef: number; nOth: number; valueRef: number; valueOth: number; smd: number; imbalanced: number }) => {
      if (!r) { checks.push({ name: `balance ${tag}`, status: "fail", detail: "row missing" }); return; }
      eq(`balance ${tag}: n reference arm = ${w.nRef}`, Number(r.n_ref), w.nRef);
      eq(`balance ${tag}: n comparator arm = ${w.nOth}`, Number(r.n_oth), w.nOth);
      approx(`balance ${tag}: reference value = ${w.valueRef}`, Number(r.value_ref), w.valueRef, 0.0001);
      approx(`balance ${tag}: comparator value = ${w.valueOth}`, Number(r.value_oth), w.valueOth, 0.0001);
      approx(`balance ${tag}: SMD = ${w.smd}`, Number(r.smd), w.smd, 0.00001);
      eq(`balance ${tag}: imbalance flag = ${w.imbalanced}`, Number(r.imbalanced), w.imbalanced);
    };
    /* Rows are located by CHARACTERISTIC, not by measure. They were found by
     * measure until a second CONTINUOUS covariate (the comorbidity index)
     * joined the table, at which point "the continuous row" stopped naming one
     * row — it kept working only because "Age at index" sorts before
     * "Comorbidity index". Accidentally correct is not correct. */
    const byName = (name: string) => balRows.find((r) => r.characteristic === name);
    checkBal("age (imbalanced by construction)", byName("Age at index"), bal.age);
    checkBal("sex (balanced by construction)", byName("Sex"), bal.sex);
    checkBal("comorbidity index (imbalanced by construction)", byName("Comorbidity index"), bal.cci);
    // the pinned fixture constant and the executed module must agree
    approx("balance: executed SMD reproduces the frozen EXPECTED.smdAge",
      Number(byName("Age at index")?.smd ?? NaN), EXPECTED.smdAge, 0.00001);
    /* The index SMD must be computed from the SAME per-patient scores the index
     * analysis reports. Recomputing 1.6 vs 0.6 from those scores by hand is the
     * check; that both come from ONE shared scorer is why it holds. */
    checks.push({
      name: "balance: the comorbidity SMD is scored by the SAME engine as the index analysis",
      status: Math.abs(Number(byName("Comorbidity index")?.value_ref ?? NaN) - bal.cci.valueRef) < 0.0001
        && Math.abs(Number(byName("Comorbidity index")?.value_oth ?? NaN) - bal.cci.valueOth) < 0.0001 ? "pass" : "fail",
      detail: `arm means ${byName("Comorbidity index")?.value_ref} vs ${byName("Comorbidity index")?.value_oth}; cohort mean ${EXPECTED.comorbidityIndex.index.mean} = (5*${bal.cci.valueRef} + 5*${bal.cci.valueOth})/10`,
    });

    /* ---- direct age standardization (executed vs hand-computed) ----
     * Bands [45,55,65] cover the whole at-risk cohort, so the DSR is exact:
     *   45-54: rate 3 x 1000 x 365.25 / 600 = 1826.25, w = 134,834
     *   55-64: rate 0,                                 w =  87,247
     *   65+  : rate 0,                                 w = 126,387
     *   DSR = 134,834 x 1826.25 / 348,468 = 706.64 per 1000 PY
     * The band person-days must ALSO reproduce the incidence module's strata
     * (600 + 1460 + 365 = 2425) — an independent path to the same person-time,
     * which is what proves the DSR re-weights the SAME measure rather than a
     * differently-censored one. */
    const dsrRow = async (stratum: string) =>
      (await rows<{ patients: number; person_days: number; weight: number; dsr: number; covered_weight_pct: number }>(
        db,
        `SELECT patients, person_days, weight, dsr::float8, covered_weight_pct::float8 FROM tz_study_dsr WHERE stratum = '${stratum}'`,
      ))[0];
    const dsrOverall = await dsrRow("Overall");
    eq("DSR: total weight = 348,468 (US 2000 collapsed onto 45/55/65)", Number(dsrOverall?.weight), 348_468);
    eq("DSR: person-days reproduce the incidence module's 2425", Number(dsrOverall?.person_days), EXPECTED.personDays);
    approx("DSR = 706.64 per 1000 PY (hand-computed)", Number(dsrOverall?.dsr), 706.64, 0.01);
    approx("DSR: covered weight = 34.85% of US 2000", Number(dsrOverall?.covered_weight_pct), 34.85, 0.01);
    const dsr4554 = await dsrRow("45-54");
    eq("DSR band 45-54: weight = 134,834", Number(dsr4554?.weight), 134_834);
    eq("DSR band 45-54: person-days = 600 (matches the incidence stratum)", Number(dsr4554?.person_days), 600);

    /* ---- calendar trend (executed vs hand-computed Cochran-Armitage) ----
     * Per-bucket: 2018 = 2/10, 2019 = 3/10, 2020 = 0/10 (see EXPECTED).
     * The statistic is what makes this worth executing rather than merely
     * fingerprinting: with scores 0,1,2 the algebra collapses to clean
     * fractions, T = -2 and Var = 25/9, so z = -1.2 EXACTLY — a value a
     * floating-point slip or a mis-scored bucket cannot land on by accident. */
    const ct = EXPECTED.calendarTrend;
    eq(
      `calendar-trend rows = ${ct.rowCount} (3 year buckets + the Trend row)`,
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_trend"),
      ct.rowCount,
    );
    const trendRow = async (bucket: string) =>
      (
        await rows<{ patients: number; denominator: number; prevalence: number; prevalence_pct: number; ci_low: number; ci_high: number; trend_z: number | null; trend_p: number | null; trend_method: string | null; trend_p_method: string | null }>(
          db,
          `SELECT patients, denominator, prevalence::float8, prevalence_pct::float8, ci_low::float8, ci_high::float8,
                  trend_z::float8, trend_p::float8, trend_method, trend_p_method
             FROM tz_study_trend WHERE bucket = '${bucket}'`,
        )
      )[0];
    for (const [bucket, want] of Object.entries(ct.buckets)) {
      const r = await trendRow(bucket);
      const tag = `trend bucket ${bucket}`;
      if (!r) {
        checks.push({ name: tag, status: "fail", detail: "row missing" });
        continue;
      }
      eq(`${tag}: cases = ${want.patients}`, Number(r.patients), want.patients);
      eq(`${tag}: denominator = ${want.denominator}`, Number(r.denominator), want.denominator);
      approx(`${tag}: prevalence = ${want.prevalence}`, Number(r.prevalence), want.prevalence, 0.00001);
      approx(`${tag}: Wilson CI low = ${want.ci[0]}`, Number(r.ci_low), want.ci[0], 0.00001);
      approx(`${tag}: Wilson CI high = ${want.ci[1]}`, Number(r.ci_high), want.ci[1], 0.00001);
      checks.push({
        name: `${tag}: carries no trend statistic (only the Trend row does)`,
        status: r.trend_z === null ? "pass" : "fail",
        detail: r.trend_z === null ? "trend_z NULL on bucket rows" : `bucket row has trend_z = ${r.trend_z}`,
      });
    }
    const tr = await trendRow("Trend");
    if (!tr) {
      checks.push({ name: "trend: Trend row exists", status: "fail", detail: "no row with bucket = 'Trend'" });
    } else {
      eq("trend: person-bucket cases = 5 (2+3+0)", Number(tr.patients), ct.trend.patients);
      eq("trend: person-bucket denominator = 30 (10 per year)", Number(tr.denominator), ct.trend.denominator);
      approx("trend: pooled proportion = 1/6", Number(tr.prevalence), ct.trend.prevalence, 0.00001);
      approx("trend: Cochran-Armitage z = -1.2 EXACTLY (hand-computed)", Number(tr.trend_z), ct.trend.z, 0.00001);
      checks.push({
        name: "trend: the statistic is labeled with the test actually computed",
        status: tr.trend_method === ct.trend.method ? "pass" : "fail",
        detail: `expected ${ct.trend.method}, got ${tr.trend_method ?? "NULL"}`,
      });
      /* SAS-PRIMARY, asserted by EXECUTION rather than by reading the text: the
       * p-value column must arrive NULL out of a real Postgres run, while the
       * label beside it names what produces it. A SQL twin that quietly filled
       * this in with a normal approximation would fail here. */
      checks.push({
        name: "trend: p-value is NULL in executed SQL, with its source labeled",
        status: tr.trend_p === null && tr.trend_p_method === "sas_normal_cdf" ? "pass" : "fail",
        detail:
          tr.trend_p === null
            ? `trend_p NULL, method label "${tr.trend_p_method}" (SAS PROBNORM computes it)`
            : `SQL populated trend_p = ${tr.trend_p} — the SAS-primary contract is broken`,
      });
    }

    /* ---- resource use and cost (executed vs hand-derived ledger truth) ----
     * Every value below was derived claim by claim before the module ran; see
     * EXPECTED.resourceUse for the derivation. */
    const ru = EXPECTED.resourceUse;
    eq(
      `resource-use rows = ${ru.rowCount} (ALL + IP + ED + OP + RX)`,
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_hcru"),
      ru.rowCount,
    );
    const hcruRow = async (setting: string) =>
      (
        await rows<{ users: number; denominator: number; encounters: number; enc_per_patient: number; enc_sd: number; enc_median: number; enc_max: number; observed_days: number; paid_total: number; paid_per_patient: number; paid_sd: number; paid_median: number; paid_max: number }>(
          db,
          `SELECT users, denominator, encounters, enc_per_patient::float8, enc_sd::float8, enc_median::float8,
                  enc_max, observed_days, paid_total::float8, paid_per_patient::float8, paid_sd::float8,
                  paid_median::float8, paid_max::float8
             FROM tz_study_hcru WHERE setting = '${setting}'`,
        )
      )[0];
    for (const [setting, want] of Object.entries(ru.bySetting)) {
      const r = await hcruRow(setting);
      const tag = `hcru ${setting}`;
      if (!r) {
        checks.push({ name: tag, status: "fail", detail: "row missing" });
        continue;
      }
      eq(`${tag}: users = ${want.users}`, Number(r.users), want.users);
      eq(`${tag}: denominator = whole cohort (10)`, Number(r.denominator), EXPECTED.finalCohortN);
      eq(`${tag}: encounters = ${want.encounters}`, Number(r.encounters), want.encounters);
      approx(`${tag}: encounters per member = ${want.encMean}`, Number(r.enc_per_patient), want.encMean, 0.00001);
      approx(`${tag}: encounter SD = ${want.encSd}`, Number(r.enc_sd), want.encSd, 0.00001);
      approx(`${tag}: encounter median = ${want.encMedian}`, Number(r.enc_median), want.encMedian, 0.00001);
      eq(`${tag}: max encounters = ${want.encMax}`, Number(r.enc_max), want.encMax);
      eq(`${tag}: observed days = ${ru.observedDaysTotal}`, Number(r.observed_days), ru.observedDaysTotal);
      approx(`${tag}: paid total = ${want.paidTotal}`, Number(r.paid_total), want.paidTotal, 0.01);
      approx(`${tag}: paid per member = ${want.paidMean}`, Number(r.paid_per_patient), want.paidMean, 0.01);
      approx(`${tag}: paid SD = ${want.paidSd}`, Number(r.paid_sd), want.paidSd, 0.01);
      approx(`${tag}: paid median = ${want.paidMedian}`, Number(r.paid_median), want.paidMedian, 0.01);
      approx(`${tag}: paid max = ${want.paidMax}`, Number(r.paid_max), want.paidMax, 0.01);
    }

    /* The single most consequential number in the ledger, called out on its own
     * because getting it wrong is silent, plausible, and inflates the largest
     * cost component in most studies. */
    const ipPaid = Number((await hcruRow("IP"))?.paid_total);
    checks.push({
      name: "hcru: inpatient cost takes the ADMISSION total, not admission + its own service lines",
      status: Math.abs(ipPaid - ru.bySetting.IP.paidTotal) < 0.01 ? "pass" : "fail",
      detail:
        Math.abs(ipPaid - ru.bySetting.IP.paidTotal) < 0.01
          ? `$${ipPaid.toLocaleString()} = P04's $10,000 stay + P05's $5,000 orphan line; a double-counting ledger would report $${ru.ipDoubleCountWouldBe.toLocaleString()}`
          : `got $${ipPaid.toLocaleString()}, expected $${ru.bySetting.IP.paidTotal.toLocaleString()}${Math.abs(ipPaid - ru.ipDoubleCountWouldBe) < 0.01 ? " — this is EXACTLY the double count (admission totals summed with their own service lines)" : ""}`,
    });
    /* P05 is the orphan-line case: a service line whose admission record is
     * absent. Dropping every unmatched line would lose the stay entirely and
     * would still look like a working ledger. */
    checks.push({
      name: "hcru: an inpatient service line with NO admission record still counts as a stay (P05)",
      status: Number((await hcruRow("IP"))?.users) === 2 ? "pass" : "fail",
      detail: `IP users = ${(await hcruRow("IP"))?.users} (P04 via its admission record, P05 via an orphan line)`,
    });
    /* Skew is the reason both statistics are reported. If a change ever made
     * them agree on this fixture, the fixture stopped exercising cost data. */
    const all = await hcruRow("ALL");
    checks.push({
      name: "hcru: the cost distribution is right-skewed, so mean and median disagree by design",
      status: Number(all?.paid_per_patient) > Number(all?.paid_median) * 2 ? "pass" : "fail",
      detail: `mean $${Number(all?.paid_per_patient).toLocaleString()} vs median $${Number(all?.paid_median).toLocaleString()}`,
    });

    /* ---- logistic regression: the 2x2 and the closed-form crude effect ----
     * The adjusted coefficients are SAS-primary and cannot be executed here.
     * What CAN be executed is everything they are anchored to: the design, the
     * closed form, and the fact that SQL leaves the fitted estimates NULL. */
    const rg = EXPECTED.regression;
    /* Two regression analyses now exist, so the module is "multi" and BOTH
     * tables carry their analysis-id suffix. */
    const GLM_T = "tz_study_glm_a_glm";
    eq(
      `regression rows = ${rg.rowCount} (4 design + 3 crude + ${rg.adjustedTerms.length} adjusted)`,
      await scalar<number>(db, `SELECT count(*)::int FROM ${GLM_T}`),
      rg.rowCount,
    );
    const glmRow = async (component: string, term: string, statistic: string) =>
      (
        await rows<{ estimate: number | null; ci_low: number | null; ci_high: number | null; se_log: number | null; method: string }>(
          db,
          `SELECT estimate::float8, ci_low::float8, ci_high::float8, se_log::float8, method
             FROM ${GLM_T} WHERE component = '${component}' AND term = '${term}' AND statistic = '${statistic}'`,
        )
      )[0];
    eq("glm design: exposed arm n = 4", Number((await glmRow("design", "DRUG_Y", "n"))?.estimate), rg.design.exposedN);
    eq("glm design: exposed arm events = 1", Number((await glmRow("design", "DRUG_Y", "events"))?.estimate), rg.design.exposedEvents);
    eq("glm design: reference arm n = 4", Number((await glmRow("design", "DRUG_X", "n"))?.estimate), rg.design.referenceN);
    eq("glm design: reference arm events = 2", Number((await glmRow("design", "DRUG_X", "events"))?.estimate), rg.design.referenceEvents);
    const orRow = await glmRow("crude", "Index drug", "odds_ratio");
    approx("glm crude OR = 1/3 EXACTLY (hand-computed from the 2x2)", Number(orRow?.estimate), rg.oddsRatio.estimate, 0.00001);
    approx(`glm crude OR CI low = ${rg.oddsRatio.ciLow}`, Number(orRow?.ci_low), rg.oddsRatio.ciLow, 0.00001);
    approx(`glm crude OR CI high = ${rg.oddsRatio.ciHigh}`, Number(orRow?.ci_high), rg.oddsRatio.ciHigh, 0.00001);
    approx("glm Woolf SE(log OR) = sqrt(7/3)", Number(orRow?.se_log), rg.oddsRatio.seLog, 0.00001);
    approx("glm crude RR = 0.5 EXACTLY", Number((await glmRow("crude", "Index drug", "risk_ratio"))?.estimate), rg.riskRatio, 0.00001);
    approx("glm crude RD = -0.25 EXACTLY", Number((await glmRow("crude", "Index drug", "risk_difference"))?.estimate), rg.riskDifference, 0.00001);
    /* The SATURATED-DESIGN ANCHOR, from this side. A logistic model whose only
     * predictor is the exposure has as many parameters as the 2x2 has cells, so
     * its MLE must be exactly ln(1/3). The SAS twin checks itself against the
     * closed form; the harness pins what that closed form has to be. */
    checks.push({
      name: "glm: the saturated-design anchor value is ln(1/3) — what the SAS MLE must reproduce",
      status: Math.abs(Math.log(Number(orRow?.estimate)) - rg.logOr) < 0.0001 ? "pass" : "fail",
      detail: `ln(${orRow?.estimate}) = ${Math.log(Number(orRow?.estimate)).toFixed(7)}, expected ${rg.logOr}`,
    });
    /* SAS-primary, asserted by EXECUTION: every adjusted estimate must arrive
     * NULL from a real Postgres run, with the procedure that produces it named.
     * A SQL twin that quietly filled these in with the crude estimate would be
     * reporting an unadjusted number under an adjusted label. */
    const adj = await rows<{ term: string; estimate: number | null; method: string }>(
      db,
      `SELECT term, estimate::float8, method FROM ${GLM_T} WHERE component = 'adjusted' ORDER BY ord`,
    );
    checks.push({
      name: "glm: every ADJUSTED estimate is NULL in executed SQL, with its source labeled",
      status: adj.length === rg.adjustedTerms.length && adj.every((r) => r.estimate === null && r.method === "sas_proc_logistic") ? "pass" : "fail",
      detail:
        adj.every((r) => r.estimate === null)
          ? `${adj.length} terms declared and NULL: ${adj.map((r) => r.term).join(", ")}`
          : `SQL populated an adjusted estimate — the SAS-primary contract is broken`,
    });
    checks.push({
      name: "glm: the adjusted model carries the exposure AND every resolved covariate",
      status: JSON.stringify(adj.map((r) => r.term)) === JSON.stringify(rg.adjustedTerms) ? "pass" : "fail",
      detail: `terms ${adj.map((r) => r.term).join(", ")}`,
    });

    /* ---- POISSON regression: the same exposure, a person-time denominator ----
     * The offset is the load-bearing part. It must reconcile to the person-time
     * every rate module already pins (1395 + 1030 = 2425) — a feeder that
     * disagrees with the incidence table cannot pass. */
    const rp = EXPECTED.regressionPoisson;
    const T = "tz_study_glm_a_glm_pois";
    eq(
      `poisson regression rows = ${rp.rowCount} (8 design + 2 crude + ${rp.adjustedTerms.length} adjusted)`,
      await scalar<number>(db, `SELECT count(*)::int FROM ${T}`),
      rp.rowCount,
    );
    const poisRow = async (component: string, term: string, statistic: string) =>
      (
        await rows<{ estimate: number | null; ci_low: number | null; ci_high: number | null; se_log: number | null; method: string }>(
          db,
          `SELECT estimate::float8, ci_low::float8, ci_high::float8, se_log::float8, method
             FROM ${T} WHERE component = '${component}' AND term = '${term}' AND statistic = '${statistic}'`,
        )
      )[0];
    for (const [arm, want] of [["DRUG_Y", rp.design.exposed], ["DRUG_X", rp.design.reference]] as const) {
      eq(`poisson design ${arm}: n = ${want.n}`, Number((await poisRow("design", arm, "n"))?.estimate), want.n);
      eq(`poisson design ${arm}: events = ${want.events}`, Number((await poisRow("design", arm, "events"))?.estimate), want.events);
      eq(`poisson design ${arm}: person-days = ${want.personDays}`, Number((await poisRow("design", arm, "person_days"))?.estimate), want.personDays);
      approx(`poisson design ${arm}: rate = ${want.ratePer1000py}/1000PY`, Number((await poisRow("design", arm, "rate_per_1000py"))?.estimate), want.ratePer1000py, 0.00001);
    }
    /* The cross-check that makes the offset trustworthy: the model's own
     * person-time must add up to the incidence module's pinned total. */
    const ptSum = rp.design.exposed.personDays + rp.design.reference.personDays;
    checks.push({
      name: "poisson: the model's person-time reconciles to the incidence module's 2425",
      status:
        Number((await poisRow("design", "DRUG_Y", "person_days"))?.estimate) +
          Number((await poisRow("design", "DRUG_X", "person_days"))?.estimate) === EXPECTED.personDays
          ? "pass" : "fail",
      detail: `1395 + 1030 = ${ptSum}, and the rate table pins ${EXPECTED.personDays}`,
    });
    const rrRow = await poisRow("crude", "Index drug", "rate_ratio");
    approx("poisson crude RR = 103/279 EXACTLY (hand-computed)", Number(rrRow?.estimate), rp.rateRatio.estimate, 0.00001);
    approx(`poisson RR CI low = ${rp.rateRatio.ciLow}`, Number(rrRow?.ci_low), rp.rateRatio.ciLow, 0.00001);
    approx(`poisson RR CI high = ${rp.rateRatio.ciHigh}`, Number(rrRow?.ci_high), rp.rateRatio.ciHigh, 0.00001);
    approx("poisson SE(log RR) = sqrt(1.5) — event counts only", Number(rrRow?.se_log), rp.rateRatio.seLog, 0.00001);
    approx("poisson rate difference = -447.39534/1000PY", Number((await poisRow("crude", "Index drug", "rate_difference_per_1000py"))?.estimate), rp.rateDifference, 0.00001);
    checks.push({
      name: "poisson: the saturated anchor value is ln(103/279) — what the SAS MLE must reproduce",
      status: Math.abs(Math.log(Number(rrRow?.estimate)) - rp.logRr) < 0.0001 ? "pass" : "fail",
      detail: `ln(${rrRow?.estimate}) = ${Math.log(Number(rrRow?.estimate)).toFixed(7)}, expected ${rp.logRr}`,
    });
    /* A Poisson coefficient labelled "odds_ratio" reads as correct and is not.
     * The label follows the FAMILY, and this pins it. */
    const adjP = await rows<{ term: string; statistic: string; estimate: number | null; method: string }>(
      db, `SELECT term, statistic, estimate::float8, method FROM ${T} WHERE component = 'adjusted' ORDER BY ord`,
    );
    checks.push({
      name: "poisson: adjusted rows are labeled rate_ratio (NOT odds_ratio) and sourced to PROC GENMOD",
      status: adjP.length > 0 && adjP.every((r) => r.statistic === "rate_ratio" && r.method === "sas_proc_genmod" && r.estimate === null) ? "pass" : "fail",
      detail: `${adjP.length} terms, statistic "${adjP[0]?.statistic}", method "${adjP[0]?.method}", all NULL in SQL`,
    });

    /* ---- NEGATIVE BINOMIAL on a recurrent-event count ----
     * The response is a COUNT, and follow-up no longer stops at the first event
     * — counting every event while censoring at the first is incoherent. That
     * makes the denominator 8 x 365 = 2920, DIFFERENT from the Poisson model's
     * 2425, and the difference is the methodological point rather than a bug. */
    const rn = EXPECTED.regressionNegBin;
    const NB_T = "tz_study_glm_a_glm_nb";
    eq(
      `negative-binomial rows = ${rn.rowCount} (8 design + 2 crude + 2 diagnostic + 4 adjusted)`,
      await scalar<number>(db, `SELECT count(*)::int FROM ${NB_T}`),
      rn.rowCount,
    );
    const nbRow = async (component: string, term: string, statistic: string) =>
      (
        await rows<{ estimate: number | null; ci_low: number | null; ci_high: number | null; se_log: number | null; method: string }>(
          db,
          `SELECT estimate::float8, ci_low::float8, ci_high::float8, se_log::float8, method
             FROM ${NB_T} WHERE component = '${component}' AND term = '${term}' AND statistic = '${statistic}'`,
        )
      )[0];
    for (const [arm, want] of [["DRUG_Y", rn.design.exposed], ["DRUG_X", rn.design.reference]] as const) {
      eq(`negbin design ${arm}: subjects = ${want.n}`, Number((await nbRow("design", arm, "n"))?.estimate), want.n);
      eq(`negbin design ${arm}: EVENT COUNT = ${want.events}`, Number((await nbRow("design", arm, "events"))?.estimate), want.events);
      eq(`negbin design ${arm}: person-days = ${rn.personDaysPerArm} (full follow-up, no censoring at outcome)`,
        Number((await nbRow("design", arm, "person_days"))?.estimate), rn.personDaysPerArm);
      approx(`negbin design ${arm}: rate = ${want.ratePer1000py}/1000PY`, Number((await nbRow("design", arm, "rate_per_1000py"))?.estimate), want.ratePer1000py, 0.00001);
    }
    /* The denominator MUST differ from the Poisson model's. If a change ever
     * made them agree, follow-up stopped at the first event and later events
     * became uncountable. */
    checks.push({
      name: "negbin: recurrent follow-up runs to the admin censor (2920 person-days, NOT the 2425 of a first-event model)",
      status:
        Number((await nbRow("design", "DRUG_Y", "person_days"))?.estimate) +
          Number((await nbRow("design", "DRUG_X", "person_days"))?.estimate) === rn.personDaysTotal
          ? "pass" : "fail",
      detail: `1460 + 1460 = ${rn.personDaysTotal} = 8 at-risk x 365 days; the first-event models pin ${EXPECTED.personDays}`,
    });
    const nbRR = await nbRow("crude", "Index drug", "rate_ratio");
    approx("negbin crude RR = 0.5 EXACTLY (equal person-time cancels)", Number(nbRR?.estimate), rn.rateRatio.estimate, 0.00001);
    approx(`negbin RR CI low = ${rn.rateRatio.ciLow}`, Number(nbRR?.ci_low), rn.rateRatio.ciLow, 0.00001);
    approx(`negbin RR CI high = ${rn.rateRatio.ciHigh}`, Number(nbRR?.ci_high), rn.rateRatio.ciHigh, 0.00001);
    approx("negbin SE(log RR) = sqrt(1.5)", Number(nbRR?.se_log), rn.rateRatio.seLog, 0.00001);
    approx("negbin rate difference = -250.17123/1000PY", Number((await nbRow("crude", "Index drug", "rate_difference_per_1000py"))?.estimate), rn.rateDifference, 0.00001);
    checks.push({
      name: "negbin: the saturated anchor value is ln(0.5) — the NB point estimate is anchored even though its dispersion is not",
      status: Math.abs(Math.log(Number(nbRR?.estimate)) - rn.logRr) < 0.0001 ? "pass" : "fail",
      detail: `ln(${nbRR?.estimate}) = ${Math.log(Number(nbRR?.estimate)).toFixed(7)}, expected ${rn.logRr}`,
    });
    /* THE HONEST ROW. On this fixture no subject exceeds one event, so the
     * response is Bernoulli and the dispersion parameter is not identified.
     * The program reports that rather than printing a dispersion estimate.
     * When Gold Case B adds real recurrence this assertion changes — which is
     * the point of asserting it. */
    /* The closed-form dispersion statistic, executed. On THIS fixture it is
     * below 1 — Gold Case B is the seed where it exceeds 1 and the same emitter
     * reaches the opposite verdict. */
    const vmA = await nbRow("diagnostic", "overdispersion", "variance_to_mean_ratio");
    approx("negbin: variance-to-mean ratio = 0.71429 (below 1, so NOT overdispersed)", Number(vmA?.estimate), rn.varianceToMeanRatio, 0.00001);
    checks.push({
      name: "negbin: the program declares NOT overdispersed on this fixture",
      status: (vmA?.method ?? "").startsWith("NOT overdispersed") ? "pass" : "fail",
      detail: vmA?.method ?? "no diagnostic row",
    });
    const diag = await nbRow("diagnostic", "overdispersion", "max_events_per_subject");
    eq("negbin: max events per subject = 1 on this fixture", Number(diag?.estimate), rn.maxEventsPerSubject);
    checks.push({
      name: "negbin: the program REPORTS that dispersion is not identified, rather than estimating it",
      status: (diag?.method ?? "").startsWith(rn.dispersionVerdict) ? "pass" : "fail",
      detail: diag?.method ?? "no diagnostic row",
    });

    /* ---- GAMMA-LOG cost model ----
     * The response comes through the SHARED ledger, so the model's costs are
     * the resource-use table's costs — including the inpatient double-count
     * rule. And the zero-cost subjects are the methodological point: a gamma
     * response must be strictly positive. */
    const rgm = EXPECTED.regressionGamma;
    const G_T = "tz_study_glm_a_glm_cost";
    eq(
      `gamma-log rows = ${rgm.rowCount} (8 design + 2 crude + 1 diagnostic + 3 adjusted)`,
      await scalar<number>(db, `SELECT count(*)::int FROM ${G_T}`),
      rgm.rowCount,
    );
    const gRow = async (component: string, term: string, statistic: string) =>
      (
        await rows<{ estimate: number | null; ci_low: number | null; ci_high: number | null; se_log: number | null; method: string }>(
          db,
          `SELECT estimate::float8, ci_low::float8, ci_high::float8, se_log::float8, method
             FROM ${G_T} WHERE component = '${component}' AND term = '${term}' AND statistic = '${statistic}'`,
        )
      )[0];
    for (const [arm, want] of [["DRUG_Y", rgm.design.exposed], ["DRUG_X", rgm.design.reference]] as const) {
      eq(`gamma ${arm}: subjects = ${want.n}`, Number((await gRow("design", arm, "n"))?.estimate), want.n);
      eq(`gamma ${arm}: with POSITIVE cost = ${want.nPositive}`, Number((await gRow("design", arm, "n_positive_cost"))?.estimate), want.nPositive);
      approx(`gamma ${arm}: total cost = ${want.totalCost}`, Number((await gRow("design", arm, "total_cost"))?.estimate), want.totalCost, 0.01);
      approx(`gamma ${arm}: mean cost = ${want.meanCost}`, Number((await gRow("design", arm, "mean_cost"))?.estimate), want.meanCost, 0.01);
    }
    /* The ledger's inpatient rule reaching the MODEL, not just the cost table:
     * P04's stay contributes its $10,000 admission total. A double-counting
     * ledger would put DRUG_X's total at 22,900 instead of 15,900. */
    checks.push({
      name: "gamma: the model's costs come through the ledger (P04's stay is $10,000, not $17,000)",
      status: Math.abs(Number((await gRow("design", "DRUG_X", "total_cost"))?.estimate) - rgm.design.reference.totalCost) < 0.01 ? "pass" : "fail",
      detail: `DRUG_X total ${(await gRow("design", "DRUG_X", "total_cost"))?.estimate} = 600 + 300 + 10000 + 5000`,
    });
    const cr = await gRow("crude", "Index drug", "cost_ratio");
    approx("gamma cost ratio = 34/159 (hand-computed from the arm means)", Number(cr?.estimate), rgm.costRatio.estimate, 0.00001);
    approx(`gamma cost-ratio CI low = ${rgm.costRatio.ciLow}`, Number(cr?.ci_low), rgm.costRatio.ciLow, 0.00001);
    approx(`gamma cost-ratio CI high = ${rgm.costRatio.ciHigh}`, Number(cr?.ci_high), rgm.costRatio.ciHigh, 0.00001);
    approx("gamma delta-method SE on the log ratio", Number(cr?.se_log), rgm.costRatio.seLog, 0.00001);
    /* The interval is the DELTA METHOD, not the fitted model's — labelling it
     * as the model's would be the mislabeling this project refuses. */
    checks.push({
      name: "gamma: the crude interval is labeled delta_method_ratio_of_means, NOT the fitted model's",
      status: cr?.method === "delta_method_ratio_of_means" ? "pass" : "fail",
      detail: `method "${cr?.method}"`,
    });
    approx("gamma mean cost difference = -3125", Number((await gRow("crude", "Index drug", "mean_cost_difference"))?.estimate), rgm.meanCostDifference, 0.01);
    checks.push({
      name: "gamma: the saturated anchor value is ln(34/159) — what the SAS MLE must reproduce",
      status: Math.abs(Math.log(Number(cr?.estimate)) - rgm.logCr) < 0.0001 ? "pass" : "fail",
      detail: `ln(${cr?.estimate}) = ${Math.log(Number(cr?.estimate)).toFixed(5)}`,
    });
    /* ZERO COST. P09 and P10 have no post-index claims; a gamma response cannot
     * take them. Counted and reported, never dropped silently and never rescued
     * by adding a constant. */
    const zc = await gRow("diagnostic", "zero_cost", "subjects_excluded_from_fit");
    eq("gamma: zero-cost subjects excluded from the fit = 2 (P09, P10)", Number(zc?.estimate), rgm.zeroCostExcluded);
    checks.push({
      name: "gamma: the exclusion is REPORTED, and named as the second part of a two-part model",
      status: (zc?.method ?? "").includes("two-part") ? "pass" : "fail",
      detail: zc?.method ?? "no diagnostic row",
    });

    /* ---- Table 1 comorbidity-index row (executed) ----
     * The row is scored by the SAME shared engine as the index analysis and the
     * balance table, so this asserts the wiring rather than the arithmetic:
     * Table 1 must agree with tz_study_cci to the rounding Table 1 applies. */
    const t1cci = (
      await rows<{ n_patients: number; mean_val: number; sd_val: number; median_val: number }>(
        db,
        `SELECT n_patients, mean_val::float8, sd_val::float8, median_val::float8
           FROM tz_study_table1 WHERE characteristic = 'Comorbidity index'`,
      )
    )[0];
    if (!t1cci) {
      checks.push({ name: "table1: comorbidity-index row exists", status: "fail", detail: "no 'Comorbidity index' row in tz_study_table1" });
    } else {
      eq("table1 comorbidity index: scored over the whole cohort", Number(t1cci.n_patients), EXPECTED.finalCohortN);
      approx("table1 comorbidity index: mean = 1.1 (agrees with the index analysis)", Number(t1cci.mean_val), EXPECTED.comorbidityIndex.index.mean, 0.05);
      approx("table1 comorbidity index: median = 1", Number(t1cci.median_val), EXPECTED.comorbidityIndex.index.median, 0.05);
      /* The point of the shared scorer, asserted directly: Table 1 and the
       * index analysis are two independently-emitted programs reading two
       * different tables, and they must not disagree about the same cohort. */
      const cciMean = Number(
        (await rows<{ score_mean: number }>(db, `SELECT score_mean::float8 FROM tz_study_cci WHERE component = 'index'`))[0]?.score_mean,
      );
      checks.push({
        name: "table1 and the index analysis report the SAME comorbidity mean (one shared scorer)",
        status: Math.abs(Number(t1cci.mean_val) - Number(cciMean.toFixed(1))) < 0.001 ? "pass" : "fail",
        detail: `Table 1 ${t1cci.mean_val} vs index analysis ${cciMean} (Table 1 rounds to 1dp)`,
      });
    }

    /* ---- weighted comorbidity index (executed vs hand-derived) ----
     * The hierarchy is the whole point: without it P03 scores 3 instead of 2
     * and P05 scores 4 instead of 3, and the cohort mean reads 1.3 instead of
     * 1.1 — a plausible number, uniformly wrong, on every adjusted estimate
     * downstream. */
    const cix = EXPECTED.comorbidityIndex;
    eq(
      `comorbidity-index rows = ${cix.rowCount} (5 conditions + 3 bands + index)`,
      await scalar<number>(db, "SELECT count(*)::int FROM tz_study_cci"),
      cix.rowCount,
    );
    const cciRow = async (component: string, category: string) =>
      (
        await rows<{ patients: number; denominator: number; pct: number; weight: number | null; score_mean: number | null; score_sd: number | null; score_median: number | null; score_max: number | null }>(
          db,
          `SELECT patients, denominator, pct::float8, weight::float8, score_mean::float8, score_sd::float8,
                  score_median::float8, score_max::float8
             FROM tz_study_cci WHERE component = '${component}' AND category = '${category.replace(/'/g, "''")}'`,
        )
      )[0];
    for (const [label, want] of Object.entries(cix.conditions)) {
      const r = await cciRow("condition", label);
      const tag = `cci condition ${label}`;
      if (!r) {
        checks.push({ name: tag, status: "fail", detail: "row missing" });
        continue;
      }
      eq(`${tag}: patients = ${want.patients}`, Number(r.patients), want.patients);
      approx(`${tag}: weight = ${want.weight} (from the spec, not the emitter)`, Number(r.weight), want.weight, 0.00001);
    }
    /* Superseded conditions must still report prevalence. P03 contributed 0 for
     * uncomplicated diabetes, but they still HAVE it — a scoring convention
     * must not erase a clinical fact. */
    checks.push({
      name: "cci: a SUPERSEDED condition still reports its prevalence (P03 has uncomplicated diabetes)",
      status: Number((await cciRow("condition", "Diabetes, uncomplicated"))?.patients) === 2 ? "pass" : "fail",
      detail: `uncomplicated diabetes = ${(await cciRow("condition", "Diabetes, uncomplicated"))?.patients} patients (P02 and P03), though P03 contributed 0 weight for it`,
    });
    for (const [band, want] of Object.entries(cix.bands)) {
      const r = await cciRow("score_band", band);
      if (!r) {
        checks.push({ name: `cci band ${band}`, status: "fail", detail: "row missing" });
        continue;
      }
      eq(`cci band ${band}: patients = ${want}`, Number(r.patients), want);
    }
    const idx = await cciRow("index", "Overall");
    if (!idx) {
      checks.push({ name: "cci: index row exists", status: "fail", detail: "no index row" });
    } else {
      eq("cci: every cohort member is scored (zeros included)", Number(idx.patients), EXPECTED.finalCohortN);
      approx(`cci: mean score = ${cix.index.mean}`, Number(idx.score_mean), cix.index.mean, 0.00001);
      approx(`cci: score SD = ${cix.index.sd}`, Number(idx.score_sd), cix.index.sd, 0.00001);
      approx(`cci: median score = ${cix.index.median}`, Number(idx.score_median), cix.index.median, 0.00001);
      approx(`cci: max score = ${cix.index.max}`, Number(idx.score_max), cix.index.max, 0.00001);
      /* Named explicitly, because a hierarchy that silently stops applying
       * produces a number that looks entirely reasonable. */
      checks.push({
        name: "cci: the supersession hierarchy IS applied (mean 1.1, not the 1.3 of a flat sum)",
        status: Math.abs(Number(idx.score_mean) - cix.index.mean) < 0.00001 ? "pass" : "fail",
        detail:
          Math.abs(Number(idx.score_mean) - cix.withoutHierarchy.mean) < 0.00001
            ? `mean ${idx.score_mean} — this is EXACTLY the flat sum: severe/complicated forms are being ADDED to their milder forms instead of replacing them`
            : `mean ${idx.score_mean} (P03 scores 2 not ${cix.withoutHierarchy.p03}; P05 scores 3 not ${cix.withoutHierarchy.p05})`,
      });
    }

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
