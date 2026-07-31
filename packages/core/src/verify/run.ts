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
import { GOLD_C_SPEC, GOLD_C_OPTS, EXPECTED_C, fixtureCSeedSql } from "./fixture-c";
import { GOLD_D_SPEC, GOLD_D_OPTS, EXPECTED_D, fixtureDSeedSql } from "./fixture-d";
import { GOLD_E_SPEC, GOLD_E_OPTS, EXPECTED_E, fixtureESeedSql } from "./fixture-e";
import { GOLD_F_SPEC, GOLD_F_OPTS, EXPECTED_F, fixtureFSeedSql } from "./fixture-f";
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

/**
 * Gold Case C — the tie fixture.
 *
 * Three pieces of arithmetic are unreachable on Gold Cases A and B, because on
 * both of them every subject fails on a different day: the Kaplan-Meier (n-d)/n
 * factor with d > 1, the log-rank's (n-d)/(n-1) tie correction, and the gap
 * between Cox's Breslow information and the log-rank variance — which is
 * exactly that correction and is therefore INVISIBLE without a tie.
 *
 * This case makes all three numbers. It also, unexpectedly, has a closed-form
 * Cox coefficient: every risk set here is half exposed, and under a constant
 * exposure share the partial likelihood is binomial.
 */
export async function verifyGoldC(): Promise<Check[]> {
  const { db, ok, steps } = await seedAndRun(GOLD_C_SPEC, GOLD_C_OPTS, fixtureCSeedSql());
  const out: Check[] = [];
  if (!ok) {
    return [{
      name: "Gold Case C executes",
      status: "fail",
      detail: steps.filter((x) => !x.ok).map((x) => `${x.path}: ${x.error}`).join(" | "),
    }];
  }
  const eq = (name: string, got: number | null | undefined, want: number) =>
    out.push({ name, status: got === want ? "pass" : "fail", detail: `expected ${want}, got ${got}` });
  const approx = (name: string, got: number, want: number, tol: number) =>
    out.push({ name, status: Math.abs(got - want) <= tol ? "pass" : "fail", detail: `expected ${want}±${tol}, got ${got}` });

  eq("C: cohort N = 6", await scalar<number>(db, "SELECT count(*)::int FROM tz_c_cohort"), EXPECTED_C.cohortN);

  /* ---- Kaplan-Meier with a TIED event time ---- */
  const kmRow = async (stratum: string, t: number) =>
    (
      await rows<{ n_risk: number; n_event: number; estimate: number; se: number; ci_low: number; ci_high: number }>(
        db,
        `SELECT n_risk, n_event, estimate::float8, se::float8, ci_low::float8, ci_high::float8
           FROM tz_c_km
          WHERE component = 'life_table' AND stratum = '${stratum}' AND time_days = ${t}`,
      )
    )[0];
  for (const want of EXPECTED_C.km.overall) {
    const r = await kmRow("Overall", want.t);
    const tag = `C: km Overall @${want.t}d`;
    if (!r) { out.push({ name: tag, status: "fail", detail: "row missing" }); continue; }
    eq(`${tag}: at risk = ${want.nRisk}`, Number(r.n_risk), want.nRisk);
    /* d = 2 HERE. This is the number no other fixture produces, and the factor
     * (n-d)/n it drives: a life table that removed one member per event time
     * would report 5/6 = 0.83333 instead of 4/6. */
    eq(`${tag}: events = ${want.nEvent}${want.nEvent > 1 ? " (TIED — unreachable on Gold A/B)" : ""}`, Number(r.n_event), want.nEvent);
    approx(`${tag}: S = ${want.surv}`, Number(r.estimate), want.surv, 0.00001);
    approx(`${tag}: Greenwood se = ${want.se}`, Number(r.se), want.se, 0.00001);
    approx(`${tag}: CI low = ${want.ci[0]}`, Number(r.ci_low), want.ci[0], 0.00001);
    approx(`${tag}: CI high = ${want.ci[1]}`, Number(r.ci_high), want.ci[1], 0.00001);
  }
  const medRow = async (stratum: string) =>
    (
      await rows<{ estimate: number | null }>(
        db,
        `SELECT estimate::float8 FROM tz_c_km WHERE component = 'median' AND stratum = '${stratum}'`,
      )
    )[0];
  eq("C: median Overall = 200", Number((await medRow("Overall"))?.estimate), EXPECTED_C.km.medianOverall);
  eq("C: median DRUG_X = 200", Number((await medRow("DRUG_X"))?.estimate), EXPECTED_C.km.medianX);
  out.push({
    name: "C: median DRUG_Y is NOT REACHED",
    status: (await medRow("DRUG_Y"))?.estimate === null ? "pass" : "fail",
    detail: `got ${(await medRow("DRUG_Y"))?.estimate}`,
  });

  /* ---- the log-rank, with the tie correction ACTIVE ---- */
  const lrRow = async (statistic: string) =>
    (
      await rows<{ estimate: number | null }>(
        db,
        `SELECT estimate::float8 FROM tz_c_km WHERE component = 'logrank' AND statistic = '${statistic}'`,
      )
    )[0];
  eq("C: log-rank observed = 1", Number((await lrRow("observed_exposed"))?.estimate), EXPECTED_C.logRank.observed);
  approx("C: log-rank expected = 3/2", Number((await lrRow("expected_exposed"))?.estimate), EXPECTED_C.logRank.expected, 0.00001);
  /* (n-d)/(n-1) = 4/5 at the tied time. Without the correction the variance
   * would be 0.75 + 0.25 = 1.0 rather than 13/20 — which is exactly the Cox
   * information below, and is how the two could be confused. */
  approx("C: log-rank variance = 13/20, the TIE CORRECTION applied", Number((await lrRow("variance"))?.estimate), EXPECTED_C.logRank.variance, 0.00001);
  approx("C: log-rank chi-square = 5/13", Number((await lrRow("chi_square"))?.estimate), EXPECTED_C.logRank.chiSquare, 0.00001);

  /* ---- Cox: the closed forms, and the difference a tie makes ---- */
  const cxRow = async (statistic: string) =>
    (
      await rows<{ estimate: number | null; se: number | null; ci_low: number | null; ci_high: number | null; method: string }>(
        db,
        `SELECT estimate::float8, se::float8, ci_low::float8, ci_high::float8, method
           FROM tz_c_cox WHERE statistic = '${statistic}'`,
      )
    )[0];
  eq("C: 1 tied event time", Number((await cxRow("tied_event_times"))?.estimate), EXPECTED_C.cox.tiedEventTimes);
  approx("C: partial logL(0) = -(2 ln 6 + ln 4)", Number((await cxRow("partial_loglik_0"))?.estimate), EXPECTED_C.cox.partialLogLik0, 0.00001);
  approx("C: -2 logL(0) = 9.93963 (compare PHREG's null fit statistic)", Number((await cxRow("minus_2_loglik_0"))?.estimate), EXPECTED_C.cox.minusTwoLogLik0, 0.00001);
  /* The SCORE is the same statistic as the log-rank numerator even here. */
  approx("C: Cox score U(0) = -1/2", Number((await cxRow("score_u0"))?.estimate), EXPECTED_C.cox.score, 0.00001);
  const lrN = Number((await lrRow("observed_exposed"))?.estimate) - Number((await lrRow("expected_exposed"))?.estimate);
  approx("C: the Cox score EQUALS the log-rank numerator O - E", Number((await cxRow("score_u0"))?.estimate), lrN, 0.00001);

  /* THE HEADLINE OF THIS FIXTURE. Breslow information and log-rank variance are
   * the SAME number on Gold A and DIFFERENT here — 3/4 against 13/20. An
   * implementation that reused one for the other passes every check on A. */
  const info = Number((await cxRow("information_0"))?.estimate);
  const lrv = Number((await cxRow("logrank_variance"))?.estimate);
  approx("C: Cox information I(0) = 3/4", info, EXPECTED_C.cox.information, 0.00001);
  approx("C: log-rank variance beside it = 13/20", lrv, EXPECTED_C.cox.logRankVariance, 0.00001);
  out.push({
    name: "C: information and log-rank variance DIFFER, because an event time is tied",
    status: Math.abs(info - lrv) > 0.0001 ? "pass" : "fail",
    detail: `I(0) = ${info} vs log-rank V = ${lrv} (they are equal on Gold Case A, which is the point)`,
  });
  approx("C: score chi-square = 1/3", Number((await cxRow("score_chi_square"))?.estimate), EXPECTED_C.cox.scoreChiSquare, 0.00001);

  /* ---- THE ANCHOR: a closed-form Cox coefficient ---- */
  const share = await cxRow("risk_set_exposed_share");
  approx("C: every risk set is HALF exposed", Number(share?.estimate), EXPECTED_C.cox.riskSetProportion, 0.00001);
  out.push({
    name: "C: the program recognises the share as CONSTANT",
    status: (share?.method ?? "").startsWith("CONSTANT") ? "pass" : "fail",
    detail: share?.method ?? "no row",
  });
  approx("C: exposed share of EVENTS q = 1/3", Number((await cxRow("event_share_exposed"))?.estimate), EXPECTED_C.cox.eventShareExposed, 0.00001);
  /* HR = [q/(1-q)] / [p/(1-p)] = (1/2)/(1) = 1/2, and an independent Newton
   * solve of the partial likelihood agrees to ten decimals. This is the only
   * place a Cox coefficient is checkable against anything but itself. */
  approx("C: closed-form Cox HR = 1/2 EXACTLY (constant-proportion anchor)", Number((await cxRow("closed_form_hazard_ratio"))?.estimate), EXPECTED_C.cox.closedFormHr, 0.00001);
  const one = await cxRow("hazard_ratio_one_step");
  approx("C: one-step HR = exp(-2/3) = 0.51342", Number(one?.estimate), EXPECTED_C.cox.oneStepHr, 0.00001);
  approx("C: one-step se = 1/sqrt(3/4)", Number(one?.se), EXPECTED_C.cox.oneStepSe, 0.00001);
  /* The one-step is NOT the maximum, and here the gap is visible: 0.51342
   * against the exact 0.5. A module that reported the one-step as "the hazard
   * ratio" would be wrong by that much and look right. */
  out.push({
    name: "C: the one-step estimate DIFFERS from the exact maximum, as it must",
    status: Math.abs(Number(one?.estimate) - EXPECTED_C.cox.closedFormHr) > 0.001 ? "pass" : "fail",
    detail: `one-step ${one?.estimate} vs closed form ${EXPECTED_C.cox.closedFormHr}`,
  });

  // parity for C's own emission, not just A's
  out.push(...sasSqlParityChecks(GOLD_C_SPEC, GOLD_C_OPTS));
  out.push(...sasStructureChecks(emitSas(GOLD_C_SPEC, GOLD_C_OPTS)));
  return out;
}

/**
 * Gold Case D — competing risks.
 *
 * Gold Cases A, B and C all have a SINGLE kind of event, which makes the
 * Aalen-Johansen CIF and the naive 1 - Kaplan-Meier the same number there. An
 * implementation that had quietly built PER-CAUSE risk sets — the standard way
 * to get this wrong — agrees with every one of them. Here one subject fails
 * from a competing cause and the two estimators come apart by an exact
 * fraction.
 */
export async function verifyGoldD(): Promise<Check[]> {
  const { db, ok, steps } = await seedAndRun(GOLD_D_SPEC, GOLD_D_OPTS, fixtureDSeedSql());
  const out: Check[] = [];
  if (!ok) {
    return [{
      name: "Gold Case D executes",
      status: "fail",
      detail: steps.filter((x) => !x.ok).map((x) => `${x.path}: ${x.error}`).join(" | "),
    }];
  }
  const eq = (name: string, got: number | null | undefined, want: number) =>
    out.push({ name, status: got === want ? "pass" : "fail", detail: `expected ${want}, got ${got}` });
  const approx = (name: string, got: number, want: number, tol: number) =>
    out.push({ name, status: Math.abs(got - want) <= tol ? "pass" : "fail", detail: `expected ${want}±${tol}, got ${got}` });

  eq("D: cohort N = 6", await scalar<number>(db, "SELECT count(*)::int FROM tz_d_cohort"), EXPECTED_D.cohortN);

  const INTEREST = "Event of interest (cause 1)";
  const COMPETING = "Lung malignancy (competing, cause 2)";
  const cell = async (component: string, cause: string, atLabel: string) =>
    (
      await rows<{ estimate: number | null; se: number | null; ci_low: number | null; ci_high: number | null; method: string; n_risk: number | null; n_event: number | null }>(
        db,
        `SELECT estimate::float8, se::float8, ci_low::float8, ci_high::float8, method, n_risk, n_event
           FROM tz_d_cif WHERE component = '${component}' AND cause = '${cause}' AND at_label = '${atLabel}'`,
      )
    )[0];

  /* ---- the all-cause Kaplan-Meier, which is the WEIGHT the estimator uses ---- */
  for (const w of EXPECTED_D.survAll) {
    const r = await cell("life_table", INTEREST, `event time ${w.t}d`);
    eq(`D: at risk at ${w.t}d = ${w.nRisk}`, Number(r?.n_risk), w.nRisk);
  }

  /* ---- the CIF ---- */
  approx("D: CIF of the event of interest at 365d = 1/3", Number((await cell("cif", INTEREST, "horizon 365d"))?.estimate), EXPECTED_D.cif.interest.at300, 0.00001);
  approx("D: CIF of the competing cause at 365d = 1/6", Number((await cell("cif", COMPETING, "horizon 365d"))?.estimate), EXPECTED_D.cif.competing.at300, 0.00001);
  /* day 150 falls between the first and second event: only P1 has failed, so
   * the competing CIF is still exactly zero — the flat-curve case that an
   * inner join to the life table would have dropped entirely. */
  approx("D: CIF of interest at 150d = 1/6 (before the competing event)", Number((await cell("cif", INTEREST, "horizon 150d"))?.estimate), EXPECTED_D.horizons[150].interest, 0.00001);
  eq("D: CIF of the competing cause at 150d = 0, and the row still EXISTS", Number((await cell("cif", COMPETING, "horizon 150d"))?.estimate), EXPECTED_D.horizons[150].competing);
  approx("D: delta-method se of the interest CIF = sqrt(1/27)", Number((await cell("cif", INTEREST, "horizon 365d"))?.se), EXPECTED_D.cif.interest.se, 0.00001);
  approx("D: delta-method se of the competing CIF = sqrt(5/216)", Number((await cell("cif", COMPETING, "horizon 365d"))?.se), EXPECTED_D.cif.competing.se, 0.00001);

  /* ---- THE PARTITION IDENTITY ---- */
  const idRow = await cell("identity", "All causes", "horizon 365d");
  approx("D: the CIFs sum to 1/2", Number(idRow?.estimate), EXPECTED_D.identity.sumCif, 0.00001);
  approx("D: 1 - S(t) from the all-cause KM = 1/2", Number((await cell("identity", "All-cause survival", "horizon 365d"))?.estimate), EXPECTED_D.identity.oneMinusSurv, 0.00001);
  out.push({
    name: "D: the program declares the partition identity HOLDS",
    status: (idRow?.method ?? "").startsWith("HOLDS") ? "pass" : "fail",
    detail: (idRow?.method ?? "no row").slice(0, 90),
  });

  /* ---- THE BIAS: the reason this analysis exists ---- */
  approx("D: naive 1-KM for the event of interest = 3/8", Number((await cell("naive_km", INTEREST, "horizon 365d"))?.estimate), EXPECTED_D.naive.interest, 0.00001);
  const biasI = await cell("bias", INTEREST, "horizon 365d");
  approx("D: 1-KM OVERSTATES the risk of interest by exactly 1/24", Number(biasI?.estimate), EXPECTED_D.naive.biasInterest, 0.00001);
  out.push({
    name: "D: the program names the difference an OVERSTATEMENT",
    status: (biasI?.method ?? "").startsWith("OVERSTATEMENT") ? "pass" : "fail",
    detail: (biasI?.method ?? "no row").slice(0, 90),
  });
  approx("D: naive 1-KM for the competing cause = 1/5", Number((await cell("naive_km", COMPETING, "horizon 365d"))?.estimate), EXPECTED_D.naive.competing, 0.00001);
  approx("D: 1-KM overstates the competing risk by exactly 1/30", Number((await cell("bias", COMPETING, "horizon 365d"))?.estimate), EXPECTED_D.naive.biasCompeting, 0.00001);

  /* ---- THE PATHOLOGY: naive risks that cannot be a set of probabilities ---- */
  const diag = await cell("diagnostic", "All causes", "horizon 365d");
  approx("D: the naive risks sum to 23/40", Number(diag?.estimate), EXPECTED_D.naive.naiveSum, 0.00001);
  out.push({
    name: "D: the program flags the naive pair as IMPOSSIBLE AS A SET (23/40 > 1/2)",
    status: (diag?.method ?? "").startsWith("IMPOSSIBLE AS A SET") ? "pass" : "fail",
    detail: (diag?.method ?? "no row").slice(0, 100),
  });
  out.push({
    name: "D: two mutually exclusive outcomes, naive probabilities summing ABOVE the chance of either",
    status: Number(diag?.estimate) > EXPECTED_D.identity.oneMinusSurv + 1e-9 ? "pass" : "fail",
    detail: `naive sum ${diag?.estimate} vs total event probability ${EXPECTED_D.identity.oneMinusSurv}`,
  });

  /* ---- Fine-Gray on Gold D: COMPLETE SEPARATION, and the retained subject ---- *
   * Every cause-1 event on Gold D is in arm X, so the maximum likelihood
   * estimate is INFINITE. The one-step and the closed form must both return
   * NULL rather than the large finite number that would read as a very strong
   * effect. And the risk-set totals show what the model is actually doing:
   * 11 weighted against 10 cause-specific, the difference being P2, retained
   * after its competing event. */
  const fgD = async (statistic: string) =>
    (
      await rows<{ estimate: number | null; se: number | null; method: string }>(
        db,
        `SELECT estimate::float8, se::float8, method FROM tz_d_fgray WHERE statistic = '${statistic}'`,
      )
    )[0];
  eq("D: subdistribution denominator = 11 (6 + 5)", Number((await fgD("subdistribution_risk_total"))?.estimate), 11);
  eq("D: cause-specific denominator = 10 (6 + 4)", Number((await fgD("cause_specific_risk_total"))?.estimate), 10);
  const retD = await fgD("retained_by_subdistribution");
  eq("D: exactly ONE subject-time retained by the subdistribution risk set", Number(retD?.estimate), 1);
  out.push({
    name: "D: the program names the retained contribution as the difference from Cox",
    status: /RETAINED/.test(retD?.method ?? "") ? "pass" : "fail",
    detail: (retD?.method ?? "no row").slice(0, 100),
  });
  const oneD = await fgD("subdistribution_hr_one_step");
  out.push({
    name: "D: with every event in one arm the one-step is NOT ESTIMABLE, not a large number",
    status: oneD?.estimate === null && /NOT ESTIMABLE/.test(oneD?.method ?? "") ? "pass" : "fail",
    detail: `estimate=${oneD?.estimate}, method="${(oneD?.method ?? "").slice(0, 80)}"`,
  });
  const anchorD = await fgD("closed_form_subdistribution_hr");
  out.push({
    name: "D: and the closed form refuses too, naming complete separation",
    status: anchorD?.estimate === null && /complete separation/.test(anchorD?.method ?? "") ? "pass" : "fail",
    detail: (anchorD?.method ?? "no row").slice(0, 100),
  });

  // parity for D's own emission, not just A's
  out.push(...sasSqlParityChecks(GOLD_D_SPEC, GOLD_D_OPTS));
  out.push(...sasStructureChecks(emitSas(GOLD_D_SPEC, GOLD_D_OPTS)));
  return out;
}

/**
 * Gold Case E — fractional inverse-probability-of-censoring weights.
 *
 * Gold Case D exercises the Fine-Gray RISK SET (a competing-event subject is
 * retained where Cox would drop them) but not its WEIGHTS: nobody in D is
 * censored before the last event of interest, so G is 1 throughout and every
 * weight is exactly 1. The weight expression could be deleted and D would not
 * move. Here one subject disenrolls between the competing event and the second
 * event of interest, so G drops to 2/3 and the retained subject enters the
 * later risk set at that weight.
 */
export async function verifyGoldE(): Promise<Check[]> {
  const { db, ok, steps } = await seedAndRun(GOLD_E_SPEC, GOLD_E_OPTS, fixtureESeedSql());
  const out: Check[] = [];
  if (!ok) {
    return [{
      name: "Gold Case E executes",
      status: "fail",
      detail: steps.filter((x) => !x.ok).map((x) => `${x.path}: ${x.error}`).join(" | "),
    }];
  }
  const eq = (name: string, got: number | null | undefined, want: number) =>
    out.push({ name, status: got === want ? "pass" : "fail", detail: `expected ${want}, got ${got}` });
  const approx = (name: string, got: number, want: number, tol: number) =>
    out.push({ name, status: Math.abs(got - want) <= tol ? "pass" : "fail", detail: `expected ${want}±${tol}, got ${got}` });

  eq("E: cohort N = 5", await scalar<number>(db, "SELECT count(*)::int FROM tz_e_cohort"), EXPECTED_E.cohortN);
  const r = async (statistic: string) =>
    (
      await rows<{ estimate: number | null; se: number | null; ci_low: number | null; ci_high: number | null; method: string }>(
        db,
        `SELECT estimate::float8, se::float8, ci_low::float8, ci_high::float8, method FROM tz_e_fgray WHERE statistic = '${statistic}'`,
      )
    )[0];

  eq("E: 2 event times for the cause of interest", Number((await r("event_times"))?.estimate), EXPECTED_E.eventTimes);
  eq("E: 1 of the 2 events is in the exposed arm (so the MLE is FINITE)", Number((await r("events_exposed"))?.estimate), EXPECTED_E.eventsExposed);

  /* THE WEIGHT. 5 at day 100 plus 8/3 at day 400 = 23/3 = 7.66667, against a
   * cause-specific 5 + 2 = 7. The retained subject contributes exactly 2/3 —
   * NOT 1, which is what every earlier fixture would have produced. */
  approx("E: subdistribution denominator = 5 + 8/3 = 7.66667",
    Number((await r("subdistribution_risk_total"))?.estimate), EXPECTED_E.subdistributionRiskTotal, 0.00001);
  eq("E: cause-specific denominator = 7 (5 + 2)", Number((await r("cause_specific_risk_total"))?.estimate), EXPECTED_E.causeSpecificRiskTotal);
  approx("E: the retained subject enters at weight 2/3, NOT 1 — G dropped to 2/3 at day 300",
    Number((await r("retained_by_subdistribution"))?.estimate), EXPECTED_E.retained, 0.00001);

  approx("E: score U(0) = 1/40", Number((await r("score_u0"))?.estimate), EXPECTED_E.scoreU0, 0.00001);
  approx("E: information I(0) = 759/1600", Number((await r("information_0"))?.estimate), EXPECTED_E.information0, 0.00001);
  approx("E: partial logL(0) = -(ln 5 + ln(8/3))", Number((await r("partial_loglik_0"))?.estimate), EXPECTED_E.partialLogLik0, 0.00001);
  approx("E: -2 logL(0) = 5.18053", Number((await r("minus_2_loglik_0"))?.estimate), EXPECTED_E.minusTwoLogLik0, 0.00001);
  approx("E: score chi-square = 1/759", Number((await r("score_chi_square"))?.estimate), EXPECTED_E.scoreChiSquare, 0.00001);
  eq("E: does NOT reject at alpha 0.05", Number((await r("reject_at_0.05"))?.estimate), EXPECTED_E.reject);

  const one = await r("subdistribution_hr_one_step");
  approx("E: one-step subdistribution HR = exp(40/759) = 1.05411", Number(one?.estimate), EXPECTED_E.oneStepHr, 0.00001);
  approx("E: one-step se = 1/sqrt(759/1600) = 1.45191", Number(one?.se), EXPECTED_E.oneStepSe, 0.00001);
  out.push({
    name: "E: the one-step IS estimable here, unlike Gold Case D",
    status: one?.estimate !== null && /FIRST NEWTON STEP/.test(one?.method ?? "") ? "pass" : "fail",
    detail: (one?.method ?? "no row").slice(0, 80),
  });

  /* The anchor's NOT-APPLICABLE branch: the weighted shares are 3/5 and 3/8. */
  const share = await r("weighted_exposed_share");
  out.push({
    name: "E: the weighted exposed share VARIES (3/5 then 3/8), so no closed form",
    status: share?.estimate === null && /VARIES/.test(share?.method ?? "") ? "pass" : "fail",
    detail: `estimate=${share?.estimate}, method="${(share?.method ?? "").slice(0, 60)}"`,
  });
  approx("E: exposed share of EVENTS q = 1/2", Number((await r("event_share_exposed"))?.estimate), EXPECTED_E.eventShareExposed, 0.00001);

  out.push(...sasSqlParityChecks(GOLD_E_SPEC, GOLD_E_OPTS));
  out.push(...sasStructureChecks(emitSas(GOLD_E_SPEC, GOLD_E_OPTS)));
  return out;
}

/**
 * Gold Case F — adherence, persistence, and the choice that moves a patient
 * across the threshold.
 *
 * This case exists because three comments in this repo claimed adherence was
 * "verified vs Gold Case F" while nothing imported the fixture at all. The
 * claims are now either backed by what runs below, or they are gone.
 */
export async function verifyGoldF(): Promise<Check[]> {
  const { db, ok, steps } = await seedAndRun(GOLD_F_SPEC, GOLD_F_OPTS, fixtureFSeedSql());
  const out: Check[] = [];
  if (!ok) {
    return [{
      name: "Gold Case F executes",
      status: "fail",
      detail: steps.filter((x) => !x.ok).map((x) => `${x.path}: ${x.error}`).join(" | "),
    }];
  }
  const eq = (name: string, got: number | null | undefined, want: number) =>
    out.push({ name, status: got === want ? "pass" : "fail", detail: `expected ${want}, got ${got}` });
  const approx = (name: string, got: number, want: number, tol: number) =>
    out.push({ name, status: Math.abs(got - want) <= tol ? "pass" : "fail", detail: `expected ${want}±${tol}, got ${got}` });

  eq("F: cohort N = 5", await scalar<number>(db, "SELECT count(*)::int FROM tz_f_cohort"), EXPECTED_F.cohortN);

  /* THE FEEDER ITSELF. If <prefix>_fills were missing, wrongly grained, or
   * fanned out by the NDC lookup, every number below would still LOOK
   * plausible — so the feeder is asserted directly, before anything reads it. */
  eq("F: the fills feeder exists and holds one row per dispensing (19)",
    await scalar<number>(db, "SELECT count(*)::int FROM tz_f_fills"), EXPECTED_F.fillsFound);
  eq("F: the feeder did NOT fan out — 19 rows over 19 distinct (patient, date) pairs",
    await scalar<number>(db, "SELECT count(*)::int FROM (SELECT DISTINCT enrolid, fill_date FROM tz_f_fills) u"),
    EXPECTED_F.fillsFound);
  eq("F: the feeder carries days supply, and exactly one is NULL",
    await scalar<number>(db, "SELECT count(*)::int FROM tz_f_fills WHERE days_supply IS NULL"), 1);

  const r = async (statistic: string) =>
    (
      await rows<{ estimate: number | null; method: string }>(
        db,
        `SELECT estimate::float8, method FROM tz_f_adh WHERE statistic = '${statistic}'`,
      )
    )[0];

  /* FILL ATTRITION — the drop is counted, not silent. */
  eq("F: 19 dispensings found before cleaning", Number((await r("fills_found"))?.estimate), EXPECTED_F.fillsFound);
  eq("F: 1 dropped for a missing days supply", Number((await r("dropped_rule_1"))?.estimate), EXPECTED_F.fillsDroppedMissing);
  eq("F: 18 measurable fills remain", Number((await r("fills_measured"))?.estimate), EXPECTED_F.fillsMeasured);
  const measured = await r("fills_measured");
  out.push({
    name: "F: and the program SAYS fills were dropped rather than reporting the loss silently",
    status: /FILLS WERE DROPPED/.test(measured?.method ?? "") ? "pass" : "fail",
    detail: (measured?.method ?? "no row").slice(0, 90),
  });

  eq("F: window denominator = 180 days", Number((await r("window_days"))?.estimate), EXPECTED_F.windowDays);
  approx("F: mean PDC = 49/90 = 0.54444", Number((await r("mean_pdc"))?.estimate), EXPECTED_F.meanPdc, 0.00001);
  approx("F: mean MPR = 3/5 = 0.6", Number((await r("mean_mpr"))?.estimate), EXPECTED_F.meanMpr, 0.00001);

  /* THE HEADLINE. Same fills, one unstated assumption, and P2 crosses 0.8. */
  eq("F: 1 patient adherent at 0.8 WITHOUT stockpiling", Number((await r("n_adherent"))?.estimate), EXPECTED_F.adherentCount);
  eq("F: 2 patients adherent WITH stockpiling", Number((await r("n_adherent_stockpiled"))?.estimate), EXPECTED_F.adherentCountStock);
  const recl = await r("reclassified_by_stockpiling");
  eq("F: exactly 1 patient is reclassified by the stockpiling assumption alone", Number(recl?.estimate), 1);
  out.push({
    name: "F: and the program NAMES that as an assumption deciding the answer, not a finding",
    status: /DEPENDS ENTIRELY ON THIS ASSUMPTION/.test(recl?.method ?? "") ? "pass" : "fail",
    detail: (recl?.method ?? "no row").slice(0, 90),
  });

  /* PERSISTENCE vs CENSORING kept apart. */
  eq("F: 4 discontinuations", Number((await r("n_discontinued"))?.estimate), EXPECTED_F.discontinuedCount);
  eq("F: 1 CENSORED — P1 was still covered when the window closed", Number((await r("n_censored"))?.estimate), EXPECTED_F.censoredCount);

  /* THE IDENTITY. PDC <= MPR is a theorem about the merge. */
  const ident = await r("patients_with_pdc_above_mpr");
  eq("F: no patient has PDC above MPR", Number(ident?.estimate), 0);
  out.push({
    name: "F: the identity row reports HOLDS, so the merge is sound",
    status: /^HOLDS/.test(ident?.method ?? "") ? "pass" : "fail",
    detail: (ident?.method ?? "no row").slice(0, 80),
  });
  /* FOUR, not three — and the fourth is P1, which is the whole point of P1.
   * Its six 30-day fills at days 0, 30, 60 ... TILE the window exactly:
   * 0..29, 30..59, and so on. Tiling is not overlapping, so P1 sits in the
   * PDC = MPR group alongside the sparse patients. That makes this count a
   * check on the off-by-one: if a fill's end were start + supply rather than
   * start + supply - 1, P1's fills WOULD overlap by a day each, P1 would drop
   * out of this group, and the count would read 3. My first hand-derivation
   * said 3 for exactly that reason, and executing it is what caught me. */
  eq("F: 4 patients whose fills never overlap — P1 TILES the window, which is not overlap",
    Number((await r("patients_with_pdc_equal_mpr"))?.estimate), 4);

  out.push(...sasSqlParityChecks(GOLD_F_SPEC, GOLD_F_OPTS));
  out.push(...sasStructureChecks(emitSas(GOLD_F_SPEC, GOLD_F_OPTS)));
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

    /* ---- OLS on a continuous response ----
     * The one family whose STANDARD ERROR is closed form too, so both halves of
     * the saturated result are executed rather than deferred to SAS. */
    const ro = EXPECTED.regressionOls;
    const O_T = "tz_study_glm_a_glm_ols";
    eq(
      `ols rows = ${ro.rowCount} (6 design + 1 crude + 1 diagnostic + 3 adjusted)`,
      await scalar<number>(db, `SELECT count(*)::int FROM ${O_T}`),
      ro.rowCount,
    );
    const oRow = async (component: string, term: string, statistic: string) =>
      (
        await rows<{ estimate: number | null; ci_low: number | null; ci_high: number | null; se_log: number | null; method: string }>(
          db,
          `SELECT estimate::float8, ci_low::float8, ci_high::float8, se_log::float8, method
             FROM ${O_T} WHERE component = '${component}' AND term = '${term}' AND statistic = '${statistic}'`,
        )
      )[0];
    for (const [arm, want] of [["DRUG_Y", ro.design.exposed], ["DRUG_X", ro.design.reference]] as const) {
      eq(`ols ${arm}: n = ${want.n}`, Number((await oRow("design", arm, "n"))?.estimate), want.n);
      approx(`ols ${arm}: mean = ${want.mean}`, Number((await oRow("design", arm, "mean"))?.estimate), want.mean, 0.00001);
      approx(`ols ${arm}: sd = ${want.sd}`, Number((await oRow("design", arm, "sd"))?.estimate), want.sd, 0.00001);
    }
    const md = await oRow("crude", "Index drug", "mean_difference");
    approx("ols mean difference = -1.75 EXACTLY (the saturated coefficient)", Number(md?.estimate), ro.meanDifference.estimate, 0.00001);
    approx("ols pooled SE = 0.47871 (closed form, unlike every other family)", Number(md?.se_log), ro.meanDifference.se, 0.00001);
    approx(`ols CI low = ${ro.meanDifference.ciLow}`, Number(md?.ci_low), ro.meanDifference.ciLow, 0.00001);
    approx(`ols CI high = ${ro.meanDifference.ciHigh}`, Number(md?.ci_high), ro.meanDifference.ciHigh, 0.00001);
    /* One arm has ZERO variance. The pooled estimator has to fall back on the
     * other arm rather than divide by nothing — an edge case worth pinning. */
    checks.push({
      name: "ols: a zero-variance arm does not break the pooled standard error",
      status: Number((await oRow("design", "DRUG_Y", "sd"))?.estimate) === 0 && Number(md?.se_log) > 0 ? "pass" : "fail",
      detail: `DRUG_Y sd = 0, pooled SE = ${md?.se_log} (falls back on DRUG_X's variance)`,
    });
    checks.push({
      name: "ols: the interval is labeled a NORMAL approximation, not the model's own",
      status: md?.method === "wald_normal_approx_pooled_sd" ? "pass" : "fail",
      detail: `method "${md?.method}"`,
    });
    const rdf = await oRow("diagnostic", "interval", "residual_df");
    eq("ols: residual df = 6, so the exact interval is t(6)", Number(rdf?.estimate), ro.residualDf);

    /* ---- Survival: Kaplan-Meier, median, log-rank ----
     * Almost all of this is EXECUTED, which is unusual here. Only the p-value
     * is SAS-primary, so only the p-value is asserted as absent rather than as
     * a number. */
    const sv = EXPECTED.survival;
    const K_T = "tz_study_km_a_km";
    eq(
      `survival rows = ${sv.rowCount} (life table + horizons + medians + log-rank + HR)`,
      await scalar<number>(db, `SELECT count(*)::int FROM ${K_T}`),
      sv.rowCount,
    );
    const kRow = async (table: string, component: string, stratum: string, statistic: string, timeDays: number | null) =>
      (
        await rows<{ n_risk: number | null; n_event: number | null; estimate: number | null; se: number | null; ci_low: number | null; ci_high: number | null; method: string }>(
          db,
          `SELECT n_risk, n_event, estimate::float8, se::float8, ci_low::float8, ci_high::float8, method
             FROM ${table}
            WHERE component = '${component}' AND stratum = '${stratum}' AND statistic = '${statistic}'
              AND time_days IS NOT DISTINCT FROM ${timeDays === null ? "NULL" : timeDays}`,
        )
      )[0];

    for (const [stratum, pts] of Object.entries(sv.lifeTable)) {
      for (const want of pts) {
        const tag = `km ${stratum} @${want.t}d`;
        const r = await kRow(K_T, "life_table", stratum, "survival", want.t);
        if (!r) {
          checks.push({ name: tag, status: "fail", detail: "row missing" });
          continue;
        }
        /* The RISK SET is asserted directly. Every classic way to get a KM
         * curve wrong is a wrong risk set, and it produces a perfectly
         * monotone curve for a different question. */
        eq(`${tag}: at risk = ${want.nRisk}`, Number(r.n_risk), want.nRisk);
        eq(`${tag}: events = ${want.nEvent}`, Number(r.n_event), want.nEvent);
        approx(`${tag}: S = ${want.surv}`, Number(r.estimate), want.surv, 0.00001);
        approx(`${tag}: Greenwood se = ${want.se}`, Number(r.se), want.se, 0.00001);
        approx(`${tag}: CI low = ${want.ci[0]}`, Number(r.ci_low), want.ci[0], 0.00001);
        approx(`${tag}: CI high = ${want.ci[1]}`, Number(r.ci_high), want.ci[1], 0.00001);
      }
    }

    for (const [stratum, pts] of Object.entries(sv.horizons)) {
      for (const want of pts) {
        const tag = `km horizon ${stratum} S(${want.t})`;
        const r = await kRow(K_T, "horizon", stratum, "survival", want.t);
        if (!r) {
          checks.push({ name: tag, status: "fail", detail: "row missing" });
          continue;
        }
        eq(`${tag}: at risk = ${want.nRisk}`, Number(r.n_risk), want.nRisk);
        approx(`${tag} = ${want.surv}`, Number(r.estimate), want.surv, 0.00001);
      }
    }

    /* THE CROSS-MODULE CHECK. Nobody is censored before the last event, so the
     * product-limit estimator and the naive at-risk risk MUST agree exactly.
     * Two modules, two algorithms, one number - asserted rather than left as a
     * coincidence a reader might notice. */
    const s365 = await kRow(K_T, "horizon", "Overall", "survival", 365);
    approx(
      "km: 1 - S(365) equals the cumulative-incidence module's 3/8",
      1 - Number(s365?.estimate),
      EXPECTED.cumulativeIncidence.ci365.overall.risk,
      0.00001,
    );

    for (const [stratum, want] of Object.entries(sv.median)) {
      const r = await kRow(K_T, "median", stratum, "median_survival_days", want);
      const tag = `km median ${stratum}`;
      if (!r) {
        checks.push({ name: tag, status: "fail", detail: "row missing" });
        continue;
      }
      if (want === null) {
        /* A NULL median is a RESULT. The row must EXIST and say so, because an
         * omitted row reads as a computation that failed. */
        checks.push({
          name: `${tag}: NOT REACHED, and the row says so`,
          status: r.estimate === null && /NOT REACHED/.test(r.method) ? "pass" : "fail",
          detail: `estimate=${r.estimate}, method="${r.method}"`,
        });
      } else {
        /* The BOUNDARY case: this curve lands on EXACTLY one half, which is
         * where the median's "S(t) <= 0.5" is evaluated. Without the tolerance
         * in km-core the SQL twin reports NULL here while SAS reports 200. */
        eq(`${tag} = ${want} (the curve lands exactly on one half)`, Number(r.estimate), want);
      }
    }

    const lr = sv.logRank;
    const lrRow = (statistic: string) => kRow(K_T, "logrank", lr.comparison, statistic, null);
    eq("log-rank: observed events in the exposed arm = 1", Number((await lrRow("observed_exposed"))?.estimate), lr.observed);
    approx("log-rank: expected = 73/42 = 1.7381", Number((await lrRow("expected_exposed"))?.estimate), lr.expected, 0.00001);
    approx("log-rank: variance = 1265/1764 = 0.71712", Number((await lrRow("variance"))?.estimate), lr.variance, 0.00001);
    approx("log-rank: chi-square = 961/1265 = 0.75968", Number((await lrRow("chi_square"))?.estimate), lr.chiSquare, 0.00001);
    eq("log-rank: does NOT reject at alpha 0.05 (0.75968 < 3.8416)", Number((await lrRow("reject_at_0.05"))?.estimate), lr.reject);
    /* The ONE SAS-primary column, asserted as ABSENT. A p-value here would mean
     * something approximated a chi-square tail rather than deferring it. */
    const pv = await lrRow("p_value");
    checks.push({
      name: "log-rank: the p-value is NULL and names PROC LIFETEST",
      status: pv !== undefined && pv.estimate === null && /sas_proc_lifetest/.test(pv.method) ? "pass" : "fail",
      detail: `estimate=${pv?.estimate}, method="${pv?.method}"`,
    });

    const hr = await kRow(K_T, "hazard_ratio", lr.comparison, "hazard_ratio_peto", null);
    approx("peto HR = exp((O-E)/V) = 0.35728", Number(hr?.estimate), sv.petoHr.estimate, 0.00001);
    approx("peto HR se = 1/sqrt(V) = 1.18088", Number(hr?.se), sv.petoHr.se, 0.00001);
    approx("peto HR CI low = 0.0353", Number(hr?.ci_low), sv.petoHr.ci[0], 0.00001);
    approx("peto HR CI high = 3.61563", Number(hr?.ci_high), sv.petoHr.ci[1], 0.00001);
    checks.push({
      name: "peto HR is LABELED as a one-step estimator, not as the Cox fit",
      status: /peto_one_step/.test(hr?.method ?? "") && /Cox/.test(hr?.method ?? "") ? "pass" : "fail",
      detail: hr?.method ?? "no method label",
    });
    /* DIRECTION. The logistic module reports OR = 1/3 for the same arm on the
     * same data; a hazard ratio pointing the other way would mean the log-rank
     * accumulated against the reference arm instead of the exposed one. */
    checks.push({
      name: "peto HR and the logistic OR agree on DIRECTION (both < 1 for DRUG_Y)",
      status: Number(hr?.estimate) < 1 && EXPECTED.regression.oddsRatio.estimate < 1 ? "pass" : "fail",
      detail: `HR ${hr?.estimate} vs OR ${EXPECTED.regression.oddsRatio.estimate}`,
    });

    /* ---- the LINEAR interval, and the clamp that argues for log_log ---- */
    const L_T = "tz_study_km_a_km_lin";
    eq(`km linear rows = ${sv.linear.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${L_T}`), sv.linear.rowCount);
    for (const want of sv.linear.clamped) {
      const r = await kRow(L_T, "life_table", "Overall", "survival", want.t);
      approx(`km linear @${want.t}d: CI low = ${want.ciLow}`, Number(r?.ci_low), want.ciLow, 0.00001);
      /* Greenwood on the raw scale exceeded 1 here and was CLAMPED. The log-log
       * transform cannot leave [0,1] at all, which is why it is the default. */
      eq(`km linear @${want.t}d: CI high CLAMPED to 1 (raw limit exceeded it)`, Number(r?.ci_high), want.ciHigh);
    }
    const unc = await kRow(L_T, "life_table", "Overall", "survival", sv.linear.unclamped.t);
    approx(`km linear @${sv.linear.unclamped.t}d: CI high = ${sv.linear.unclamped.ciHigh} (NOT clamped)`,
      Number(unc?.ci_high), sv.linear.unclamped.ciHigh, 0.00001);

    /* ---- a curve with NO events: every empty-set and divide-by-zero path ---- */
    const N_T = "tz_study_km_a_km_none";
    const nv = sv.noEvents;
    eq(`km no-events rows = ${nv.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${N_T}`), nv.rowCount);
    eq(
      "km no-events: the life table is EMPTY (no event time to tabulate)",
      await scalar<number>(db, `SELECT count(*)::int FROM ${N_T} WHERE component = 'life_table'`),
      nv.lifeTableRows,
    );
    const nh = await kRow(N_T, "horizon", "Overall", "survival", 365);
    eq("km no-events: S(365) = 1, not missing", Number(nh?.estimate), nv.survAtHorizon);
    eq("km no-events: 8 still at risk at 365d", Number(nh?.n_risk), nv.nRiskOverall);
    const nullLr = await rows<{ statistic: string; estimate: number | null }>(
      db,
      `SELECT statistic, estimate::float8 FROM ${N_T} WHERE component IN ('logrank', 'hazard_ratio')`,
    );
    checks.push({
      name: "km no-events: EVERY log-rank term is NULL together (no test exists)",
      status: nullLr.length === 7 && nullLr.every((r) => r.estimate === null) ? "pass" : "fail",
      detail: nullLr.map((r) => `${r.statistic}=${r.estimate}`).join(", "),
    });
    const nMed = await kRow(N_T, "median", "Overall", "median_survival_days", null);
    checks.push({
      name: "km no-events: the median row EXISTS and says NOT REACHED",
      status: nMed !== undefined && nMed.estimate === null && /NOT REACHED/.test(nMed.method) ? "pass" : "fail",
      detail: nMed?.method ?? "row missing",
    });

    /* ---- competing risks: the DEGENERATE branch, and the variance reduction ---- */
    const crx = EXPECTED.competingRisks;
    const CR_T = "tz_study_cif";
    const CR_INTEREST = "Event of interest (cause 1)";
    const CR_COMPETING = "Severe liver disease (competing, cause 2)";
    eq(`competing risks rows = ${crx.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${CR_T}`), crx.rowCount);
    const crCell = async (component: string, cause: string, atLabel: string) =>
      (
        await rows<{ estimate: number | null; se: number | null; method: string }>(
          db,
          `SELECT estimate::float8, se::float8, method FROM ${CR_T}
            WHERE component = '${component}' AND cause = '${cause}' AND at_label = '${atLabel}'`,
        )
      )[0];

    /* THREE INDEPENDENT CODE PATHS, ONE NUMBER. The cumulative-incidence module
     * computes 3/8 directly, the survival module reaches it as 1 - S(365), and
     * the Aalen-Johansen accumulation reaches it as a weighted sum. They agree
     * here only because nothing competes; Gold Case D is where they must not. */
    approx("cif: CIF at 365d = 3/8, the SAME number cumulative_incidence and KM report",
      Number((await crCell("cif", CR_INTEREST, "horizon 365d"))?.estimate), crx.cifInterest365, 0.00001);
    approx("cif: and it equals the cumulative-incidence module's pinned risk",
      Number((await crCell("cif", CR_INTEREST, "horizon 365d"))?.estimate), EXPECTED.cumulativeIncidence.ci365.overall.risk, 0.00001);
    approx("cif: CIF at 180d = 1/8, matching the 180-day cumulative-incidence clone",
      Number((await crCell("cif", CR_INTEREST, "horizon 180d"))?.estimate), crx.cifInterest180, 0.00001);
    eq("cif: the competing cause never occurs, so its CIF is 0",
      Number((await crCell("cif", CR_COMPETING, "horizon 365d"))?.estimate), crx.cifCompeting365);

    /* THE VARIANCE REDUCTION. This is the only check on the three-term
     * delta-method formula that a single fixture can make: with no competing
     * event it must collapse to Greenwood, and Greenwood's value here is
     * already pinned independently by the survival module. */
    const crSe = Number((await crCell("cif", CR_INTEREST, "horizon 365d"))?.se);
    approx("cif: the delta-method variance REDUCES to Greenwood's sqrt(15/512)", crSe, crx.seInterest365, 0.00001);
    /* The SAME number the survival module pins for the last life-table row —
     * S(300) = 0.625 with Greenwood se 0.17116 — reached here by a completely
     * different three-term expression. */
    approx("cif: and that is the SAME standard error the survival life table pins at t=300",
      crSe, EXPECTED.survival.lifeTable.Overall[2].se, 0.00001);
    /* Compared on the SE scale, not the variance scale. The emitted standard
     * error is rounded to five decimals, so squaring it reintroduces that
     * rounding as ~1e-6 of variance — an earlier version of this check squared
     * and demanded 1e-6, and failed a correct program. The tolerance has to
     * match the precision the number was emitted at. */
    checks.push({
      name: "cif: the emitted se IS sqrt(Greenwood 15/512), at the precision it was emitted",
      status: Math.abs(crSe - Math.sqrt(crx.greenwoodVariance)) < 1e-5 ? "pass" : "fail",
      detail: `se = ${crSe}, sqrt(15/512) = ${Math.sqrt(crx.greenwoodVariance).toFixed(9)}`,
    });

    /* THE BIAS IS EXACTLY ZERO HERE, and the program says which case it is in.
     * A module that reported "OVERSTATEMENT" on a fixture with no competing
     * event would be describing a difference it had invented. */
    const crBias = await crCell("bias", CR_INTEREST, "horizon 365d");
    eq("cif: the bias against 1-KM is EXACTLY zero when nothing competes", Number(crBias?.estimate), crx.biasInterest365);
    checks.push({
      name: "cif: the program names this the DEGENERATE case, not a validation",
      status: /DEGENERATE case, not a validation/.test(crBias?.method ?? "") ? "pass" : "fail",
      detail: (crBias?.method ?? "no row").slice(0, 100),
    });
    approx("cif: naive 1-KM equals the CIF here", Number((await crCell("naive_km", CR_INTEREST, "horizon 365d"))?.estimate), crx.naiveInterest365, 0.00001);
    const crId = await crCell("identity", "All causes", "horizon 365d");
    approx("cif: the partition identity sums to 3/8", Number(crId?.estimate), crx.identitySum, 0.00001);
    checks.push({
      name: "cif: the identity HOLDS on Gold A too",
      status: (crId?.method ?? "").startsWith("HOLDS") ? "pass" : "fail",
      detail: (crId?.method ?? "no row").slice(0, 80),
    });
    const crDiag = await crCell("diagnostic", "All causes", "horizon 365d");
    checks.push({
      name: "cif: with nothing competing, the naive risks do NOT exceed the total",
      status: /do not exceed/.test(crDiag?.method ?? "") ? "pass" : "fail",
      detail: (crDiag?.method ?? "no row").slice(0, 80),
    });

    /* ---- Cox: what is closed form, and what is deferred ---- */
    const cx = EXPECTED.cox;
    const X_T = "tz_study_cox";
    eq(`cox rows = ${cx.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${X_T}`), cx.rowCount);
    const xRow = async (statistic: string) =>
      (
        await rows<{ estimate: number | null; se: number | null; ci_low: number | null; ci_high: number | null; method: string }>(
          db,
          `SELECT estimate::float8, se::float8, ci_low::float8, ci_high::float8, method FROM ${X_T} WHERE statistic = '${statistic}'`,
        )
      )[0];
    eq("cox: 3 distinct event times", Number((await xRow("event_times"))?.estimate), cx.eventTimes);
    eq("cox: NO tied event times on Gold A", Number((await xRow("tied_event_times"))?.estimate), cx.tiedEventTimes);
    approx("cox: partial logL(0) = -(ln8 + ln7 + ln6)", Number((await xRow("partial_loglik_0"))?.estimate), cx.partialLogLik0, 0.00001);
    approx("cox: -2 logL(0) = 11.63422 (compare PHREG's null fit statistic)", Number((await xRow("minus_2_loglik_0"))?.estimate), cx.minusTwoLogLik0, 0.00001);
    approx("cox: score U(0) = -31/42", Number((await xRow("score_u0"))?.estimate), cx.scoreU0, 0.00001);
    approx("cox: information I(0) = 1265/1764", Number((await xRow("information_0"))?.estimate), cx.information0, 0.00001);

    /* TWO IDENTITIES, both only checkable where nothing is tied.
     * The log-rank test IS the Cox score test at the null, so the survival
     * module and this one must produce the same two numbers from different
     * expressions over different CTEs. Gold Case C shows the information and
     * the variance coming apart the moment a tie exists. */
    approx(
      "cox: the score EQUALS the survival module's log-rank numerator O - E",
      Number((await xRow("score_u0"))?.estimate),
      EXPECTED.survival.logRank.observed - EXPECTED.survival.logRank.expected,
      0.00001,
    );
    approx(
      "cox: with NO ties, the information EQUALS the log-rank variance",
      Number((await xRow("information_0"))?.estimate),
      EXPECTED.survival.logRank.variance,
      0.00001,
    );
    approx(
      "cox: the score chi-square EQUALS the log-rank chi-square",
      Number((await xRow("score_chi_square"))?.estimate),
      EXPECTED.survival.logRank.chiSquare,
      0.00001,
    );
    eq("cox: does NOT reject at alpha 0.05", Number((await xRow("reject_at_0.05"))?.estimate), cx.reject);

    const os = await xRow("hazard_ratio_one_step");
    approx("cox: one-step HR = exp(U/I) = 0.35728", Number(os?.estimate), cx.oneStep.hr, 0.00001);
    approx("cox: one-step se = 1/sqrt(I) = 1.18088", Number(os?.se), cx.oneStep.se, 0.00001);
    approx("cox: one-step CI low = 0.0353", Number(os?.ci_low), cx.oneStep.ci[0], 0.00001);
    approx("cox: one-step CI high = 3.61563", Number(os?.ci_high), cx.oneStep.ci[1], 0.00001);
    checks.push({
      name: "cox: the one-step is LABELLED a Newton step, not the maximum",
      status: /FIRST NEWTON STEP/.test(os?.method ?? "") ? "pass" : "fail",
      detail: os?.method ?? "no row",
    });

    /* THE ANCHOR'S OTHER BRANCH. The risk-set exposed share here runs
     * 1/2, 4/7, 2/3, so there is no closed-form maximum and the program must
     * say NOT APPLICABLE rather than print the number Gold Case C gets. A
     * check that only ever saw the applicable branch would not notice an
     * anchor that fired unconditionally. */
    const shareRow = await xRow("risk_set_exposed_share");
    checks.push({
      name: "cox: the exposed share VARIES, so no share is reported",
      status: shareRow?.estimate === null && /VARIES/.test(shareRow?.method ?? "") ? "pass" : "fail",
      detail: `estimate=${shareRow?.estimate}, method="${shareRow?.method}"`,
    });
    approx("cox: exposed share of EVENTS q = 1/3", Number((await xRow("event_share_exposed"))?.estimate), cx.eventShareExposed, 0.00001);
    const cf = await xRow("closed_form_hazard_ratio");
    checks.push({
      name: "cox: the closed-form anchor is NOT APPLICABLE here, and says so",
      status: cf?.estimate === null && /NOT APPLICABLE/.test(cf?.method ?? "") ? "pass" : "fail",
      detail: cf?.method ?? "no row",
    });

    /* SAS-PRIMARY, asserted as ABSENT. A number in any adjusted row would mean
     * something approximated a partial-likelihood maximum. */
    const fitted = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${X_T} WHERE component = 'adjusted' AND estimate IS NOT NULL`);
    eq("cox: every fitted coefficient is NULL in SQL", Number(fitted[0]?.n), 0);
    const scorePv = await xRow("score_p_value");
    checks.push({
      name: "cox: the score p-value is NULL and names PROC PHREG",
      status: scorePv?.estimate === null && /sas_proc_phreg/.test(scorePv?.method ?? "") ? "pass" : "fail",
      detail: scorePv?.method ?? "no row",
    });

    /* ---- Fine-Gray: THE REDUCTION TO COX ---- *
     * Gold A's competing cause never occurs, so the modified risk set has
     * nothing extra to hold and every weight is 1. The subdistribution model
     * must therefore become Cox IDENTICALLY — the same numbers, not similar
     * ones. That equality needs TWO modules to state, which is why it is the
     * strongest check available on the weighting machinery: a wrong G, a
     * mis-built risk set or a dropped weight all break it, and none of them is
     * visible from inside either module alone. */
    const fgx = EXPECTED.fineGray;
    const FG_T = "tz_study_fgray";
    eq(`fine-gray rows = ${fgx.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${FG_T}`), fgx.rowCount);
    const fgRow = async (statistic: string) =>
      (
        await rows<{ estimate: number | null; se: number | null; ci_low: number | null; ci_high: number | null; method: string }>(
          db,
          `SELECT estimate::float8, se::float8, ci_low::float8, ci_high::float8, method FROM ${FG_T} WHERE statistic = '${statistic}'`,
        )
      )[0];

    approx("fine-gray: score U(0) = -31/42", Number((await fgRow("score_u0"))?.estimate), fgx.scoreU0, 0.00001);
    approx("fine-gray: information I(0) = 1265/1764", Number((await fgRow("information_0"))?.estimate), fgx.information0, 0.00001);
    approx("fine-gray: partial logL(0) = -5.81711", Number((await fgRow("partial_loglik_0"))?.estimate), fgx.partialLogLik0, 0.00001);
    approx("fine-gray: score chi-square = 0.75968", Number((await fgRow("score_chi_square"))?.estimate), fgx.scoreChiSquare, 0.00001);
    approx("fine-gray: one-step HR = 0.35728", Number((await fgRow("subdistribution_hr_one_step"))?.estimate), fgx.oneStepHr, 0.00001);

    /* The cross-module equalities, stated against the COX table rather than
     * against a constant — so a change to either module surfaces as a
     * disagreement between two live numbers. */
    for (const [stat, coxStat, label] of [
      ["score_u0", "score_u0", "score"],
      ["information_0", "information_0", "information"],
      ["partial_loglik_0", "partial_loglik_0", "null log-likelihood"],
      ["score_chi_square", "score_chi_square", "score chi-square"],
    ] as const) {
      const fgv = Number((await fgRow(stat))?.estimate);
      const coxv = Number(
        (await rows<{ estimate: number | null }>(db, `SELECT estimate::float8 FROM ${X_T} WHERE statistic = '${coxStat}'`))[0]?.estimate,
      );
      checks.push({
        name: `fine-gray: with NOTHING competing, the ${label} EQUALS the Cox module's`,
        status: Math.abs(fgv - coxv) < 1e-9 ? "pass" : "fail",
        detail: `fine-gray ${fgv} vs cox ${coxv}`,
      });
    }
    const fgOne = Number((await fgRow("subdistribution_hr_one_step"))?.estimate);
    const coxOne = Number(
      (await rows<{ estimate: number | null }>(db, `SELECT estimate::float8 FROM ${X_T} WHERE statistic = 'hazard_ratio_one_step'`))[0]?.estimate,
    );
    checks.push({
      name: "fine-gray: and so does the one-step estimate",
      status: Math.abs(fgOne - coxOne) < 1e-9 ? "pass" : "fail",
      detail: `fine-gray ${fgOne} vs cox ${coxOne}`,
    });

    /* THE ROWS THAT SAY WHY. With nothing retained the two denominators are
     * the same 21 = 8 + 7 + 6, and the program says plainly that this is a Cox
     * model by another name — which on THIS fixture is the correct verdict and
     * not a defect. */
    eq("fine-gray: subdistribution denominator = 21", Number((await fgRow("subdistribution_risk_total"))?.estimate), fgx.subdistributionRiskTotal);
    eq("fine-gray: cause-specific denominator = 21, the SAME", Number((await fgRow("cause_specific_risk_total"))?.estimate), fgx.causeSpecificRiskTotal);
    const ret = await fgRow("retained_by_subdistribution");
    eq("fine-gray: nothing was retained, because nothing competed", Number(ret?.estimate), fgx.retained);
    checks.push({
      name: "fine-gray: the program SAYS this is a Cox model by another name here",
      status: /Cox model by another name/.test(ret?.method ?? "") ? "pass" : "fail",
      detail: (ret?.method ?? "no row").slice(0, 100),
    });

    const fgFitted = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${FG_T} WHERE component = 'adjusted' AND estimate IS NOT NULL`);
    eq("fine-gray: every fitted coefficient is NULL in SQL", Number(fgFitted[0]?.n), 0);

    /* ---- Propensity score: the saturated score, positivity, and balance ---- */
    const psx = EXPECTED.propensityScore;
    const PS_T = "tz_study_ps_a_ps";
    eq(`propensity rows = ${psx.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${PS_T}`), psx.rowCount);
    const psRow = async (statistic: string, term?: string) =>
      (
        await rows<{ estimate: number | null; method: string }>(
          db,
          `SELECT estimate::float8, method FROM ${PS_T} WHERE statistic = '${statistic}'${term ? ` AND term = '${term}'` : ``}`,
        )
      )[0];

    eq("ps: 4 region cells", Number((await psRow("n_cells"))?.estimate), psx.nCells);
    approx("ps: minimum saturated score = 1/3", Number((await psRow("min_score"))?.estimate), psx.minScore, 0.00001);
    eq("ps: maximum saturated score = 1 (region 4 is entirely treated)", Number((await psRow("max_score"))?.estimate), psx.maxScore);

    /* POSITIVITY — the rows this module exists to produce. */
    eq("ps: 1 cell has no control at all", Number((await psRow("cells_with_no_control"))?.estimate), psx.cellsWithNoControl);
    eq("ps: 0 cells have no treated subject", Number((await psRow("cells_with_no_treated"))?.estimate), psx.cellsWithNoTreated);
    eq("ps: 2 subjects are off support", Number((await psRow("subjects_off_support"))?.estimate), psx.subjectsOffSupport);
    eq("ps: treated pseudo-population = 10", Number((await psRow("pseudo_population_treated"))?.estimate), psx.pseudoTreated);
    eq("ps: control pseudo-population = 8", Number((await psRow("pseudo_population_control"))?.estimate), psx.pseudoControl);
    const gap = await psRow("pseudo_population_gap");
    eq("ps: the gap is exactly 2 — the region-4 subjects", Number(gap?.estimate), psx.pseudoGap);
    checks.push({
      name: "ps: and the program says the two pseudo-populations differ in size",
      status: /DIFFERENT SIZES/.test(gap?.method ?? "") ? "pass" : "fail",
      detail: (gap?.method ?? "no row").slice(0, 90),
    });
    /* On THIS configuration the gap happens to equal the off-support count.
     * It is not an identity — see the ps2 counterexample below, where the gap
     * is zero and four subjects are off support. Pinned here as the value it
     * takes, not as a law. */
    checks.push({
      name: "ps: here the gap coincides with the off-support count (NOT an identity — see ps2)",
      status: Number(gap?.estimate) === Number((await psRow("subjects_off_support"))?.estimate) ? "pass" : "fail",
      detail: `gap ${gap?.estimate} vs off-support ${(await psRow("subjects_off_support"))?.estimate}`,
    });

    eq("ps: largest weight = 3", Number((await psRow("max_weight"))?.estimate), psx.maxWeight);
    approx("ps: effective n (treated) = 25/6", Number((await psRow("effective_n_treated"))?.estimate), psx.essTreated, 0.00001);
    approx("ps: effective n (control) = 64/13", Number((await psRow("effective_n_control"))?.estimate), psx.essControl, 0.00001);
    /* Kish's ESS is never above n, and equals it only when every weight is the
     * same. Both arms are weighted here, so both must come in strictly below 5. */
    for (const [arm, stat] of [["treated", "effective_n_treated"], ["control", "effective_n_control"]] as const) {
      const e = Number((await psRow(stat))?.estimate);
      checks.push({
        name: `ps: the ${arm} effective n is strictly below its actual n of 5`,
        status: e < 5 && e > 0 ? "pass" : "fail",
        detail: `${e} vs n = 5`,
      });
    }

    /* BALANCE, before and after — including the two cases that matter most. */
    for (const [term, want] of Object.entries(psx.balance)) {
      approx(`ps: ${term} SMD before weighting = ${want.unweighted}`, Number((await psRow("smd_unweighted", term))?.estimate), want.unweighted, 0.00001);
      approx(`ps: ${term} SMD after weighting = ${want.weighted}`, Number((await psRow("smd_weighted", term))?.estimate), want.weighted, 0.00001);
      const ch = await psRow("abs_smd_change", term);
      checks.push({
        name: `ps: weighting on region made ${term} WORSE, and the program says so`,
        status: Number(ch?.estimate) > 0 && /WORSE/.test(ch?.method ?? "") ? "pass" : "fail",
        detail: `change ${ch?.estimate}; ${(ch?.method ?? "").slice(0, 60)}`,
      });
    }
    /* SEX WAS PERFECTLY BALANCED and weighting broke it. That is the sharpest
     * version of the point: an SMD of exactly 0 is not a number weighting can
     * be trusted to preserve, and a module reporting only the after-value would
     * present 0.045 as though it were an achievement. */
    checks.push({
      name: "ps: sex was EXACTLY balanced before weighting (SMD 0) and is not after",
      status: Number((await psRow("smd_unweighted", "Sex"))?.estimate) === 0
        && Number((await psRow("smd_weighted", "Sex"))?.estimate) !== 0 ? "pass" : "fail",
      detail: `before ${(await psRow("smd_unweighted", "Sex"))?.estimate}, after ${(await psRow("smd_weighted", "Sex"))?.estimate}`,
    });

    /* THE COUNTEREXAMPLE, from the second propensity analysis (region x sex).
     *
     * Seven cells, FOUR of them single-arm, so positivity plainly fails — and
     * both pseudo-populations still come to exactly 8, so the gap is ZERO. This
     * module used to claim the two sums "agree if and only if every cell
     * contains both arms". The "if" is right; the "only if" is not, and the
     * sums can coincide by arithmetic accident. A nonzero gap PROVES a
     * violation; a zero gap proves nothing, and subjects_off_support is the
     * authoritative row. */
    const PS2_T = "tz_study_ps_a_ps2";
    const ps2 = async (statistic: string) =>
      (
        await rows<{ estimate: number | null; method: string }>(
          db, `SELECT estimate::float8, method FROM ${PS2_T} WHERE statistic = '${statistic}'`,
        )
      )[0];
    eq("ps2: region x sex gives 7 cells", Number((await ps2("n_cells"))?.estimate), 7);
    eq("ps2: 2 cells have no control", Number((await ps2("cells_with_no_control"))?.estimate), 2);
    eq("ps2: 2 cells have no treated subject", Number((await ps2("cells_with_no_treated"))?.estimate), 2);
    eq("ps2: 4 subjects are off support", Number((await ps2("subjects_off_support"))?.estimate), 4);
    eq("ps2: treated pseudo-population = 8", Number((await ps2("pseudo_population_treated"))?.estimate), 8);
    eq("ps2: control pseudo-population = 8, the SAME", Number((await ps2("pseudo_population_control"))?.estimate), 8);
    const g2 = await ps2("pseudo_population_gap");
    checks.push({
      name: "ps2: the gap is ZERO even though positivity fails for 4 subjects — a zero gap proves nothing",
      status: Number(g2?.estimate) === 0 && Number((await ps2("subjects_off_support"))?.estimate) === 4 ? "pass" : "fail",
      detail: `gap ${g2?.estimate}, off-support 4`,
    });
    checks.push({
      name: "ps2: and the gap row does NOT claim positivity holds when it is zero",
      status: !/every cell contains both arms/.test(g2?.method ?? "") ? "pass" : "fail",
      detail: (g2?.method ?? "no row").slice(0, 110),
    });

    /* ---- IPTW outcome model: the estimate, and whether it exists ---- */
    const iw = EXPECTED.iptwOutcome;
    const IW_T = "tz_study_iptw";
    eq(`iptw rows = ${iw.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${IW_T}`), iw.rowCount);
    const iwRow = async (statistic: string, component?: string) =>
      (
        await rows<{ estimate: number | null; se: number | null; ci_low: number | null; ci_high: number | null; method: string }>(
          db,
          `SELECT estimate::float8, se::float8, ci_low::float8, ci_high::float8, method FROM ${IW_T}
            WHERE statistic = '${statistic}'${component ? ` AND component = '${component}'` : ``}`,
        )
      )[0];

    /* IDENTIFICATION FIRST — and it is emitted first, which is itself pinned.
     * Every number after it is arithmetic that succeeds whether or not the
     * estimand exists, so the order is part of the contract. */
    eq("iptw: 3 of 8 subjects are off support", Number((await iwRow("subjects_off_support"))?.estimate), iw.offSupport);
    eq("iptw: the analysis set is the AT-RISK 8, not the cohort of 10", Number((await iwRow("analysis_set_n"))?.estimate), iw.analysisSetN);
    const ident = await iwRow("identified");
    eq("iptw: the effect is NOT identified", Number(ident?.estimate), iw.identified);
    checks.push({
      name: "iptw: the identification row is ord 0, ahead of every estimate",
      status: (await rows<{ statistic: string }>(db, `SELECT statistic FROM ${IW_T} ORDER BY ord LIMIT 1`))[0]?.statistic === "subjects_off_support" ? "pass" : "fail",
      detail: `first row is ${(await rows<{ statistic: string }>(db, `SELECT statistic FROM ${IW_T} ORDER BY ord LIMIT 1`))[0]?.statistic}`,
    });
    checks.push({
      name: "iptw: and it says the estimate describes a population that does not exist",
      status: /NOT IDENTIFIED/.test((await iwRow("subjects_off_support"))?.method ?? "") ? "pass" : "fail",
      detail: ((await iwRow("subjects_off_support"))?.method ?? "").slice(0, 90),
    });

    eq("iptw: weighted n treated = 7", Number((await iwRow("weighted_n_treated"))?.estimate), iw.weightedNTreated);
    eq("iptw: weighted n control = 6", Number((await iwRow("weighted_n_control"))?.estimate), iw.weightedNControl);
    approx("iptw: Hajek weighted risk (treated) = 1/7", Number((await iwRow("weighted_risk_treated"))?.estimate), iw.riskTreated, 0.00001);
    approx("iptw: Hajek weighted risk (control) = 7/12", Number((await iwRow("weighted_risk_control"))?.estimate), iw.riskControl, 0.00001);
    /* The sandwich SEs. sqrt(50/2401) and sqrt(631/10368) — NOT what
     * p(1-p)/n_effective would give, which is the wrong estimator's variance. */
    approx("iptw: sandwich se (treated) = sqrt(50/2401)", Number((await iwRow("weighted_risk_treated"))?.se), iw.seTreated, 0.00001);
    approx("iptw: sandwich se (control) = sqrt(631/10368)", Number((await iwRow("weighted_risk_control"))?.se), iw.seControl, 0.00001);

    const rdw = await iwRow("risk_difference", "effect");
    approx("iptw: risk difference = -37/84", Number(rdw?.estimate), iw.riskDifference, 0.00001);
    approx("iptw: its sandwich se", Number(rdw?.se), iw.rdSe, 0.00001);
    approx("iptw: RD CI low", Number(rdw?.ci_low), iw.rdCi[0], 0.00001);
    approx("iptw: RD CI high", Number(rdw?.ci_high), iw.rdCi[1], 0.00001);
    checks.push({
      name: "iptw: the interval is labelled weights_treated_as_known, not simply robust",
      status: /weights_treated_as_known/.test(rdw?.method ?? "") ? "pass" : "fail",
      detail: (rdw?.method ?? "").slice(0, 80),
    });
    approx("iptw: risk ratio = 12/49", Number((await iwRow("risk_ratio"))?.estimate), iw.riskRatio, 0.00001);
    approx("iptw: odds ratio = 5/42", Number((await iwRow("odds_ratio"))?.estimate), iw.oddsRatio, 0.00001);

    /* THE CRUDE CONTRAST BESIDE IT. Weighting is a claim that the crude number
     * is wrong, and it cannot be judged without both. */
    approx("iptw: crude risk difference = -1/4", Number((await iwRow("risk_difference", "unadjusted"))?.estimate), iw.crudeRiskDifference, 0.00001);
    approx("iptw: weighting moved it by -0.19048", Number((await iwRow("weighting_shift"))?.estimate), iw.weightingShift, 0.00001);

    /* THE INTERVAL LEFT THE RANGE, and is reported unclamped. A clamped -1.0
     * would look like a boundary rather than a broken approximation. */
    const rng = await iwRow("rd_interval_within_range");
    eq("iptw: the RD interval does NOT stay inside [-1, 1]", Number(rng?.estimate), iw.intervalWithinRange);
    checks.push({
      name: "iptw: the lower limit is reported UNCLAMPED at -1.00066, below what a risk difference can be",
      status: Number(rdw?.ci_low) < -1 && /UNCLAMPED/.test(rng?.method ?? "") ? "pass" : "fail",
      detail: `ci_low ${rdw?.ci_low}; ${(rng?.method ?? "").slice(0, 70)}`,
    });

    /* ---- Standardization (g-formula + AIPW) ---- */
    const gx = EXPECTED.gFormula;
    const GF_T = "tz_study_gform";
    eq(`g-formula rows = ${gx.rowCount}`, await scalar<number>(db, `SELECT count(*)::int FROM ${GF_T}`), gx.rowCount);
    const gfRow = async (statistic: string, component?: string) =>
      (
        await rows<{ estimate: number | null; se: number | null; ci_low: number | null; method: string }>(
          db,
          `SELECT estimate::float8, se::float8, ci_low::float8, method FROM ${GF_T}
            WHERE statistic = '${statistic}'${component ? ` AND component = '${component}'` : ``}`,
        )
      )[0];

    /* THE RESTRICTION, which defines what population every estimate describes. */
    eq("gform: 4 cells, 2 with both arms", Number((await gfRow("cells_with_both_arms"))?.estimate), gx.cellsWithBothArms);
    eq("gform: 5 subjects in the analysis", Number((await gfRow("subjects_in_analysis"))?.estimate), gx.subjectsInAnalysis);
    const exc = await gfRow("subjects_excluded");
    eq("gform: 3 excluded — their cell holds one arm", Number(exc?.estimate), gx.subjectsExcluded);
    checks.push({
      name: "gform: the exclusion row says these estimates describe a DIFFERENT population",
      status: /DIFFERENT population/.test(exc?.method ?? "") ? "pass" : "fail",
      detail: (exc?.method ?? "").slice(0, 90),
    });

    approx("gform: standardized risk (treated) = 0", Number((await gfRow("standardized_risk_treated"))?.estimate), gx.g1, 0.00001);
    approx("gform: standardized risk (control) = 7/10", Number((await gfRow("standardized_risk_control"))?.estimate), gx.g0, 0.00001);
    approx("gform: risk difference = -7/10", Number((await gfRow("risk_difference", "g_formula"))?.estimate), gx.riskDifference, 0.00001);

    /* THE IDENTITY. Two expressions — one over cells, one over subjects — that
     * must agree exactly under double saturation. Nothing is shipped to compare
     * against; each checks the other. */
    const idr = await gfRow("aipw_minus_g_formula");
    checks.push({
      name: "gform: AIPW EQUALS the g-formula exactly (double saturation)",
      status: Number(idr?.estimate) === 0 && /HOLDS/.test(idr?.method ?? "") ? "pass" : "fail",
      detail: `residual ${idr?.estimate}`,
    });
    approx("gform: AIPW risk difference agrees", Number((await gfRow("risk_difference", "aipw"))?.estimate), gx.riskDifference, 0.00001);
    approx("gform: AIPW se includes the between-arm covariance", Number((await gfRow("risk_difference", "aipw"))?.se), gx.aipwRdSe, 0.00001);

    /* A ZERO VARIANCE IS A BOUNDARY. Every treated subject in the restricted
     * cells is event-free, so the influence function is identically zero. A
     * standard error of 0 must not read as an exact estimate. */
    const zv = await gfRow("zero_variance_arm");
    eq("gform: an arm has zero estimated variance", Number(zv?.estimate), gx.zeroVarianceArm);
    checks.push({
      name: "gform: and it is called a BOUNDARY, not precision",
      status: /BOUNDARY, not precision/.test(zv?.method ?? "") ? "pass" : "fail",
      detail: (zv?.method ?? "").slice(0, 80),
    });

    /* THE CROSS-MODULE COMPARISON this fixture pair exists to make. Same data,
     * same score, same outcome — and 0.25952 apart, entirely because weighting
     * carries the off-support subjects and standardization cannot. Asserted
     * against the LIVE iptw table, so neither number can drift alone. */
    {
      const gRd = Number((await gfRow("risk_difference", "g_formula"))?.estimate);
      const iRd = Number(
        (await rows<{ estimate: number | null }>(db, `SELECT estimate::float8 FROM ${IW_T} WHERE component = 'effect' AND statistic = 'risk_difference'`))[0]?.estimate,
      );
      approx("gform: the IPTW risk difference on the same data is -37/84", iRd, gx.iptwRiskDifference, 0.00001);
      approx("gform: the two estimators are 0.25952 apart", Math.abs(gRd - iRd), gx.gapVsIptw, 0.00001);
      checks.push({
        name: "gform: the gap is LARGER than half either estimate — the positivity violation, quantified",
        status: Math.abs(gRd - iRd) > Math.abs(gRd) / 2 || Math.abs(gRd - iRd) > Math.abs(iRd) / 2 ? "pass" : "fail",
        detail: `g-formula ${gRd} over 5 subjects vs IPTW ${iRd} over 8; gap ${Math.abs(gRd - iRd).toFixed(5)}`,
      });
    }

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
