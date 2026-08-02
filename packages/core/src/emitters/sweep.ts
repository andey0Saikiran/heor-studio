/**
 * SUBGROUP AND SENSITIVITY SWEEPS — the same machinery, two different claims.
 *
 * A SUBGROUP re-runs an analysis inside a slice of the cohort. A SENSITIVITY
 * ARM re-runs it on the whole cohort with one methodological knob moved. They
 * share every line of code below and they are NOT interchangeable as evidence,
 * so every emitted row carries its arm's KIND beside its id and label, and the
 * two are never merged into one undifferentiated table of numbers.
 *
 * WHY THIS NEEDS A CONTRACT AT ALL. Run an analysis eight ways, report the one
 * that reached significance, and you have multiplied your own false-positive
 * rate while every individual run stayed defensible. That is the most common
 * way an observational claims study misleads, and it does not feel like
 * misconduct from the inside.
 *
 * Three properties make a sweep honest, and the emitted program enforces all
 * three rather than describing them:
 *
 *   1. EVERY ARM IS DECLARED UP FRONT. The arms come from the spec, before any
 *      estimate exists.
 *   2. EVERY ARM IS REPORTED. The arm rows are a PROJECTION of the arms table —
 *      one row per arm per statistic, produced set-wise — so a dropped arm is a
 *      deleted line rather than an omission, and the program additionally
 *      counts what it reported against what was declared and says so when they
 *      differ.
 *   3. THE PRIMARY ARM IS NAMED IN ADVANCE. It is a spec field, read into a
 *      literal in both twins, so "the primary analysis" cannot become whichever
 *      arm came out best.
 *
 * The program also reports the RANGE across arms and, when the arms fall on
 * BOTH sides of the null, says plainly that the effect's sign flips under a
 * different analysis choice and is therefore not robust under any threshold.
 *
 * THE ARM IS THE SAME EMITTER, NOT A COPY OF IT. A sensitivity arm is a spec
 * transform: clone the analysis, apply exactly one override, hand it back to
 * the module registry. A subgroup arm is a cohort transform: build the sliced
 * cohort as a table, repoint the module's cohort READ at it (`ctx.cohortT` in
 * SQL, `ctx.finalCohort` in SAS), and emit the module unchanged. Neither path
 * re-implements an analysis, so an arm cannot drift away from the primary
 * result for any reason other than the one difference it declares.
 *
 * Ref: Wang et al. Value Health 2017;20:1009 (pre-specification in database
 * studies); Rothwell Lancet 2005;365:176 (subgroup analysis, and why the
 * direction of a subgroup effect is the claim most often overstated).
 */
import type {
  Analysis,
  StudySpec,
  SweepArm,
  SweepPlan,
  SweepVariation,
} from "../spec/types";
import {
  SWEEP_SUBGROUP_CATEGORICAL_KINDS,
  SWEEP_SUBGROUP_CONTINUOUS_KINDS,
  SWEEP_TARGET_STATISTICS,
  findBaseline,
} from "../spec/types";
import type { AnalysisModule } from "./modules/types";
import { ANALYSIS_MODULES } from "./modules/registry";
import { bandedValueSql, cellAssignSas, cellExprSql, SAS_BANDED_VALUE, sasBandedValueStep, type CellAxis } from "./banding-core";
import { oneLine, q } from "./sql-base";
import type { Ctx as SqlCtx } from "./sql-base";
import { cmt, sasName, sq } from "./sas-base";

/* ================================================================== *
 *  Resolution — one plan of record, shared by both twins
 * ================================================================== */

/** The concrete statistic one sweep compares its arms on. */
export interface ResolvedSweepStat {
  component?: string;
  statistic?: string;
  stratum?: string;
  valueCol: string;
  nullValue: number | null;
  scale: "difference" | "ratio" | "level";
  /** what the number is called in the result table */
  statName: string;
  /** what the number IS, in prose */
  label: string;
}

/** The crude closed-form effect a regression family produces. Resolved here
 *  because it is the family, not the kind, that decides both the row name and
 *  whether the quantity has a null of 0 or of 1. */
function regressionCrudeStat(family: string): { statistic: string; nullValue: number; scale: "difference" | "ratio" } | null {
  switch (family) {
    case "logistic": return { statistic: "odds_ratio", nullValue: 1, scale: "ratio" };
    case "poisson":
    case "negative_binomial": return { statistic: "rate_ratio", nullValue: 1, scale: "ratio" };
    case "gamma_log": return { statistic: "cost_ratio", nullValue: 1, scale: "ratio" };
    case "ols": return { statistic: "mean_difference", nullValue: 0, scale: "difference" };
    default: return null;
  }
}

/** The statistic a given analysis exposes to a sweep, or null when the kind
 *  declares none (which readiness refuses as a sweep target). */
export function sweepStatisticFor(an: Analysis): ResolvedSweepStat | null {
  const base = SWEEP_TARGET_STATISTICS[an.kind];
  if (!base) return null;
  if (an.kind === "regression") {
    const c = regressionCrudeStat(an.family);
    if (!c) return null;
    return {
      component: base.component,
      statistic: c.statistic,
      valueCol: base.valueCol,
      nullValue: c.nullValue,
      scale: c.scale,
      statName: c.statistic,
      label: base.label,
    };
  }
  return {
    component: base.component,
    statistic: base.statistic,
    stratum: base.stratum,
    valueCol: base.valueCol,
    nullValue: base.nullValue,
    scale: base.scale,
    statName: base.statistic ?? base.valueCol,
    label: base.label,
  };
}

/** How a subgroup arm slices the cohort, spelled once for both twins. */
export interface SlicePlan {
  baselineId: string;
  baselineLabel: string;
  kind: string;
  level?: string;
  min?: number;
  max?: number;
  /** human phrasing, printed into the emitted note */
  text: string;
  /** stamp/fingerprint phrasing — no commas, so lists stay parseable */
  stamped: string;
}

export interface ResolvedArm {
  id: string;
  kind: "subgroup" | "sensitivity";
  label: string;
  /** 1-based, the order the spec declared */
  ord: number;
  isPrimary: boolean;
  /** the analysis this arm runs: a clone with a unique id and, for a
   *  sensitivity arm, exactly one parameter overridden */
  analysis: Analysis;
  /** sensitivity arms only */
  vary: SweepVariation | null;
  /** subgroup arms only */
  slice: SlicePlan | null;
  /** table/file suffix, e.g. "_s1_fem" */
  suffix: string;
  /** the sentence this arm's `varied_parameter` row carries */
  note: string;
}

export interface ResolvedSweep {
  plan: SweepPlan;
  /** plan ordinal tag, e.g. "s1" — part of every table name this plan creates */
  tag: string;
  target: Analysis;
  mod: AnalysisModule;
  stat: ResolvedSweepStat;
  arms: ResolvedArm[];
  primaryArmId: string;
  primaryArmLabel: string;
  /** false when the plan cannot be emitted; `reason` says why, in the file */
  emittable: boolean;
  reason: string;
}

/** The one override a sensitivity arm applies. Returns null when the parameter
 *  is not a knob the target analysis has — readiness refuses that spec, and the
 *  emitter refuses to invent an arm for it. */
function applySweepVariation(an: Analysis, v: SweepVariation): Analysis | null {
  const clone = JSON.parse(JSON.stringify(an)) as Analysis;
  switch (v.param) {
    case "lookback_days":
      if (clone.kind !== "comorbidity_index") return null;
      clone.lookback = { ...clone.lookback, start: -v.value };
      return clone;
    case "washout_days":
      if (clone.kind !== "regression" && clone.kind !== "iptw_outcome" && clone.kind !== "incidence_rate" && clone.kind !== "cumulative_incidence") return null;
      clone.washout = { ...clone.washout, start: -v.value };
      return clone;
    case "followup_days":
      if (clone.kind === "regression" || clone.kind === "iptw_outcome" || clone.kind === "cumulative_incidence") {
        clone.horizonDays = v.value;
        return clone;
      }
      if (clone.kind === "incidence_rate") {
        clone.personTimeRule = { ...clone.personTimeRule, maxFollowupDays: v.value };
        return clone;
      }
      return null;
    /* Declared in the type, read by no emitter. Refused here rather than
     * silently returning the unmodified analysis, which would produce an arm
     * whose code is identical to the primary arm's. */
    case "grace_period_days":
    case "permissible_gap_days":
    case "exposure_definition":
      return null;
  }
}

function slicePlanFor(spec: StudySpec, arm: Extract<SweepArm, { kind: "subgroup" }>): SlicePlan | null {
  const b = findBaseline(spec, arm.baselineId);
  if (!b) return null;
  const isCat = SWEEP_SUBGROUP_CATEGORICAL_KINDS.has(b.kind);
  const isCont = SWEEP_SUBGROUP_CONTINUOUS_KINDS.has(b.kind);
  if (isCat) {
    if (arm.level === undefined) return null;
    return {
      baselineId: b.id, baselineLabel: b.label, kind: b.kind, level: arm.level,
      text: `${b.label} = ${arm.level}`,
      stamped: `${b.kind}=${arm.level}`,
    };
  }
  if (isCont) {
    if (arm.min === undefined && arm.max === undefined) return null;
    const lo = arm.min === undefined ? "-inf" : String(arm.min);
    const hi = arm.max === undefined ? "inf" : String(arm.max);
    return {
      baselineId: b.id, baselineLabel: b.label, kind: b.kind, min: arm.min, max: arm.max,
      text: `${b.label} in [${lo}, ${hi}) (left-closed, right-open, so a value never lands in two slices)`,
      stamped: `${b.kind}=[${lo}..${hi})`,
    };
  }
  return null;
}

/** Resolve every declared sweep into the plan of record both emitters follow.
 *
 *  A plan that cannot be resolved is returned with `emittable: false` and a
 *  reason rather than dropped — a sweep the bundle silently omits is exactly
 *  the failure the whole contract exists to prevent. */
export function resolveSweeps(spec: StudySpec): ResolvedSweep[] {
  const plans = spec.sweeps ?? [];
  return plans.map((plan, pi) => {
    const tag = `s${pi + 1}`;
    const target = spec.analyses.find((a) => a.id === plan.analysisId && a.enabled);
    const mod = target ? (ANALYSIS_MODULES[target.kind] as AnalysisModule | undefined) : undefined;
    const stat = target ? sweepStatisticFor(target) : null;
    const shell: ResolvedSweep = {
      plan, tag,
      target: target as Analysis,
      mod: mod as AnalysisModule,
      stat: stat as ResolvedSweepStat,
      arms: [],
      primaryArmId: plan.primaryArmId,
      primaryArmLabel: "",
      emittable: false,
      reason: "",
    };
    if (!target) return { ...shell, reason: `analysisId "${plan.analysisId}" does not name an enabled analysis` };
    if (!mod) return { ...shell, reason: `analysis "${target.id}" is kind "${target.kind}", which has no registered emitter` };
    if (!stat) return { ...shell, reason: `analysis kind "${target.kind}" declares no designated sweep statistic, so the arms would have nothing comparable to report` };
    if (plan.arms.length === 0) return { ...shell, reason: `the plan declares no arms` };

    const arms: ResolvedArm[] = [];
    for (let i = 0; i < plan.arms.length; i++) {
      const arm = plan.arms[i];
      const suffix = `_${tag}_${sasName(arm.id).toLowerCase()}`;
      const cloneId = `${target.id}_${tag}_${arm.id}`;
      if (arm.kind === "subgroup") {
        const slice = slicePlanFor(spec, arm);
        if (!slice) return { ...shell, reason: `subgroup arm "${arm.id}" does not resolve to a cohort slice the spine can build` };
        const clone = JSON.parse(JSON.stringify(target)) as Analysis;
        clone.id = cloneId;
        clone.label = `${target.label} — ${arm.label}`;
        arms.push({
          id: arm.id, kind: "subgroup", label: arm.label, ord: i + 1,
          isPrimary: arm.id === plan.primaryArmId,
          analysis: clone, vary: null, slice, suffix,
          note: `SUBGROUP SLICE: ${slice.text}. A subgroup is a claim about a POPULATION, not a robustness check on the method - the analysis below is the primary arm's, unchanged, run on fewer people`,
        });
      } else {
        const varied = applySweepVariation(target, arm.vary);
        if (!varied) return { ...shell, reason: `sensitivity arm "${arm.id}" varies "${arm.vary.param}", which is not a parameter a ${target.kind} analysis reads` };
        varied.id = cloneId;
        varied.label = `${target.label} — ${arm.label}`;
        arms.push({
          id: arm.id, kind: "sensitivity", label: arm.label, ord: i + 1,
          isPrimary: arm.id === plan.primaryArmId,
          analysis: varied, vary: arm.vary, slice: null, suffix,
          note: `SENSITIVITY: ${arm.vary.param} = ${arm.vary.value}. Exactly ONE knob moved on the WHOLE cohort - an arm that moved two could not attribute a difference to either of them. This is the same emitter as the primary arm with a different input, not a second implementation`,
        });
      }
    }
    const primary = arms.find((a) => a.isPrimary);
    if (!primary) return { ...shell, arms, reason: `primaryArmId "${plan.primaryArmId}" is not one of the declared arms` };
    return { ...shell, arms, primaryArmLabel: primary.label, emittable: true, reason: "" };
  });
}

/** Every sweep-arm ANALYSIS program a spec will emit, and every sweep SUMMARY
 *  program, as stamp counts. verify/parity.ts needs this: the stamped-program
 *  total is otherwise "one per enabled analysis", which a sweep breaks. */
export function sweepStampCounts(spec: StudySpec): { armStamps: number; summaryStamps: number } {
  let armStamps = 0;
  let summaryStamps = 0;
  for (const s of resolveSweeps(spec)) {
    summaryStamps += 1;
    if (s.emittable) armStamps += s.arms.length;
  }
  return { armStamps, summaryStamps };
}

/* ================================================================== *
 *  The parity stamp
 * ================================================================== */

export interface SweepParity {
  id: string;
  analysisId: string;
  analysisKind: string;
  /** the one quantity every arm reports, as a reader would name it */
  statistic: string;
  statisticComponent: string;
  /** the result-table COLUMN the value is read from */
  valueColumn: string;
  /** the result-table `statistic` value used to SELECT the row, or "" when the
   *  row is identified some other way (a stratified table selects on stratum,
   *  and a single-row component needs no statistic at all) */
  selectorStatistic: string;
  /** the value at which the quantity means "no effect", or "none" */
  nullValue: string;
  scale: string;
  primaryArmId: string;
  /** declaration order, which is the order both twins emit the arms in */
  armIds: string[];
  armKinds: string[];
  /** "" for a subgroup arm */
  armParams: string[];
  armParamValues: string[];
  /** "" for a sensitivity arm */
  armSlices: string[];
  /** what the program is required to report, so the stamp cannot claim more
   *  than the code does */
  reportsEveryArm: true;
  reportsRange: true;
  reportsMultiplicity: true;
  reportsDirection: "yes" | "no_null_value";
}

export function sweepParity(s: ResolvedSweep): SweepParity {
  return {
    id: `${s.target.id}_${s.tag}`,
    analysisId: s.target.id,
    analysisKind: s.target.kind,
    statistic: s.stat.statName,
    statisticComponent: s.stat.component ?? s.stat.stratum ?? "",
    valueColumn: s.stat.valueCol,
    selectorStatistic: s.stat.statistic ?? "",
    nullValue: s.stat.nullValue === null ? "none" : String(s.stat.nullValue),
    scale: s.stat.scale,
    primaryArmId: s.primaryArmId,
    armIds: s.arms.map((a) => a.id),
    armKinds: s.arms.map((a) => a.kind),
    armParams: s.arms.map((a) => a.vary?.param ?? ""),
    armParamValues: s.arms.map((a) => (a.vary ? String(a.vary.value) : "")),
    armSlices: s.arms.map((a) => a.slice?.stamped ?? ""),
    reportsEveryArm: true,
    reportsRange: true,
    reportsMultiplicity: true,
    reportsDirection: s.stat.nullValue === null ? "no_null_value" : "yes",
  };
}

/** Notes ALWAYS emitted by every sweep program, in both languages. */
export const SWEEP_METHOD_NOTES = [
  `A SWEEP MULTIPLIES THE FALSE-POSITIVE RATE. Each arm below is a separate look at the same data, and none of them is corrected for the others. With k arms tested at a 5% level, the chance of at least one spurious "significant" result under the null is about 1 - 0.95^k - the program computes that number for this sweep rather than leaving it as a caution`,
  `THE PRIMARY ARM WAS NAMED IN THE SPEC BEFORE ANY ESTIMATE EXISTED. That is the only thing separating a sensitivity analysis from choosing the answer afterwards, and it is why the contract requires primaryArmId rather than inferring it`,
  `EVERY DECLARED ARM IS REPORTED, including arms that disagree with the primary one. The arm rows are a projection of the arm table, so an arm cannot be omitted, and the program counts what it reported against what was declared`,
  `A SUBGROUP AND A SENSITIVITY ARM ARE NOT THE SAME CLAIM. A subgroup says the effect differs between POPULATIONS; a sensitivity arm says the effect is stable under a different METHODOLOGICAL choice. Every row carries its arm's kind so the two can never be read as one list of numbers`,
  `THE RANGE ACROSS ARMS IS NOT A CONFIDENCE INTERVAL. It has no coverage property: it widens when arms are added and narrows when they are not, and it describes the spread produced by analysis CHOICES rather than by sampling`,
];

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

/** Where clause selecting the ONE row an arm's result table exposes. */
function statWhereSql(stat: ResolvedSweepStat): string {
  const conds: string[] = [];
  if (stat.component) conds.push(`component = '${q(stat.component)}'`);
  if (stat.statistic) conds.push(`statistic = '${q(stat.statistic)}'`);
  if (stat.stratum) conds.push(`stratum = '${q(stat.stratum)}'`);
  return conds.join(" AND ");
}

/* SINGLE-quoted SAS literals throughout the twin below, not double-quoted ones.
 * Two reasons, both load-bearing: an & or % inside a double-quoted string is
 * resolved as a macro reference (labels are analyst text and may contain
 * either), and the emitted prose is full of apostrophes ("the arm's estimate"),
 * which sq() escapes correctly for a single-quoted literal and INCORRECTLY for
 * a double-quoted one — `''` inside double quotes is two apostrophes. */
function statWhereSas(stat: ResolvedSweepStat): string {
  const conds: string[] = [];
  if (stat.component) conds.push(`component = '${sq(stat.component)}'`);
  if (stat.statistic) conds.push(`statistic = '${sq(stat.statistic)}'`);
  if (stat.stratum) conds.push(`stratum = '${sq(stat.stratum)}'`);
  return conds.join(" and ");
}

/** The arm's cohort table name (SQL). The plan tag is already inside the arm's
 *  suffix, so two plans on one analysis cannot collide. */
export function sqlArmCohortTable(ctx: SqlCtx, arm: ResolvedArm): string {
  return `${ctx.wp}_swcoh${arm.suffix}`;
}

/** The SQL program that builds every arm's cohort for one plan.
 *
 *  Both arm kinds land here, and the ONLY difference between them is the WHERE
 *  clause — which is the point: a sensitivity arm keeps the whole cohort by
 *  construction, so nothing but the declared knob can differ between it and
 *  the primary arm. */
export function sweepArmCohortsSql(ctx: SqlCtx, s: ResolvedSweep): string {
  const { d, wp } = ctx;
  const L: string[] = [];
  L.push(`-- ARM COHORTS for sweep "${q(s.tag)}" over analysis "${q(s.target.id)}" (${s.target.kind}).`);
  L.push(`-- One table per declared arm. A SENSITIVITY arm's table is the whole cohort`);
  L.push(`-- by construction, so nothing but its one declared parameter can differ from`);
  L.push(`-- the primary arm; a SUBGROUP arm's table is a slice, and the analysis run`);
  L.push(`-- over it is byte-identical apart from the table it reads.`);
  L.push(``);
  for (const arm of s.arms) {
    const t = sqlArmCohortTable(ctx, arm);
    L.push(`-- ${arm.kind === "subgroup" ? "SUBGROUP" : "SENSITIVITY"} arm "${q(arm.id)}": ${oneLine(arm.label)}`);
    L.push(`-- ${oneLine(arm.note)}`);
    L.push(d.createTableAs(t));
    if (arm.kind === "sensitivity" || !arm.slice) {
      L.push(`SELECT c.enrolid, c.index_date, c.index_code`);
      L.push(`FROM ${wp}_cohort c;`);
    } else {
      const slice = arm.slice;
      L.push(`WITH cohort AS (SELECT enrolid, index_date, index_code FROM ${wp}_cohort),`);
      L.push(`demo AS (   -- enrollment segment in force at (or latest before) index; rn=1 wins`);
      L.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
      L.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid`);
      L.push(`                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
      L.push(`  FROM cohort c`);
      L.push(`  JOIN ${ctx.t("enrollment_detail")} en`);
      L.push(`    ON en.enrolid = c.enrolid`);
      L.push(`   AND en.dtstart <= c.index_date`);
      L.push(`),`);
      L.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1)`);
      L.push(`SELECT c.enrolid, c.index_date, c.index_code`);
      L.push(`FROM cohort c LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid`);
      L.push(`WHERE ${sliceExprSql(ctx, slice)};`);
    }
    L.push(``);
    L.push(`-- REVIEW: how many members this arm actually runs on.`);
    L.push(`SELECT '${q(arm.id)}' AS arm_id, '${q(arm.kind)}' AS arm_kind, COUNT(*) AS members FROM ${t};`);
    L.push(``);
  }
  return L.join("\n");
}

/** The slice predicate, spelled through the SAME cell-axis helpers the
 *  propensity modules use, so "Female" means one thing across the bundle. */
function sliceExprSql(ctx: SqlCtx, slice: SlicePlan): string {
  if (slice.level !== undefined) {
    const axis: CellAxis = { id: slice.baselineId, label: slice.baselineLabel, kind: slice.kind as CellAxis["kind"] };
    return `${cellExprSql(axis, ctx)} = '${q(slice.level)}'`;
  }
  const v = bandedValueSql(ctx);
  const conds: string[] = [];
  if (slice.min !== undefined) conds.push(`${v} >= ${slice.min}`);
  if (slice.max !== undefined) conds.push(`${v} < ${slice.max}`);
  return conds.join(" AND ");
}

/** The SQL sweep summary: every arm's estimate, the range, and the direction
 *  verdict, in one table whose every row names its arm and that arm's KIND. */
export function sweepSummarySql(ctx: SqlCtx, s: ResolvedSweep, armTables: string[]): string {
  const { d, wp } = ctx;
  const out = `${wp}_sweep_${s.tag}`;
  const nv = s.stat.nullValue;
  const hasNull = nv !== null;
  const k = s.arms.length;
  const L: string[] = [];

  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const NUM = (e: string) => `CAST(${e} AS NUMERIC)`;
  const NULLN = `CAST(NULL AS NUMERIC)`;

  L.push(d.createTableAs(out));
  L.push(`WITH arms AS (   -- ONE ROW PER DECLARED ARM, in the order the spec declared them.`);
  L.push(`  -- One LINE per arm, with the column aliases repeated on every branch:`);
  L.push(`  -- redundant to SQL, and it makes a dropped arm a single visible deletion`);
  L.push(`  -- rather than something that hides in a reflow.`);
  s.arms.forEach((arm, i) => {
    const t = armTables[i];
    const coh = sqlArmCohortTable(ctx, arm);
    const head = i === 0 ? `  ` : `  UNION ALL\n  `;
    L.push(
      `${head}SELECT ${STR(`'${q(arm.id)}'`)} AS sw_arm_id, ${STR(`'${q(arm.kind)}'`)} AS sw_arm_kind, ${STR(`'${q(oneLine(arm.label))}'`)} AS sw_arm_label, ${NUM(String(arm.ord))} AS sw_arm_ord, ${STR(`'${q(arm.vary?.param ?? "")}'`)} AS sw_param, ${arm.vary ? NUM(String(arm.vary.value)) : NULLN} AS sw_param_value, ${STR(`'${q(arm.slice?.stamped ?? "")}'`)} AS sw_slice, ${STR(`'${q(oneLine(arm.note))}'`)} AS sw_note, (SELECT ${s.stat.valueCol} FROM ${t} WHERE ${statWhereSql(s.stat)}) AS sw_est, (SELECT COUNT(*) FROM ${coh}) AS sw_n`,
    );
  });
  L.push(`),`);
  L.push(`agg AS (   -- the cross-arm summary. MIN/MAX ignore a missing arm, so the`);
  L.push(`  -- missing count below is what says the range is incomplete.`);
  L.push(`  SELECT ${NUM(`COUNT(*)`)} AS n_reported,`);
  L.push(`         ${NUM(`SUM(CASE WHEN sw_est IS NULL THEN 1 ELSE 0 END)`)} AS n_missing,`);
  L.push(`         MIN(sw_est) AS est_min, MAX(sw_est) AS est_max,`);
  if (hasNull) {
    L.push(`         ${NUM(`SUM(CASE WHEN sw_est IS NOT NULL AND sw_est > ${nv} THEN 1 ELSE 0 END)`)} AS n_above,`);
    L.push(`         ${NUM(`SUM(CASE WHEN sw_est IS NOT NULL AND sw_est < ${nv} THEN 1 ELSE 0 END)`)} AS n_below`);
  } else {
    L.push(`         ${NULLN} AS n_above,`);
    L.push(`         ${NULLN} AS n_below`);
  }
  L.push(`  FROM arms`);
  L.push(`),`);
  L.push(`prim AS (SELECT sw_est AS primary_est FROM arms WHERE sw_arm_id = '${q(s.primaryArmId)}'),`);
  L.push(`summary AS (SELECT a.*, p.primary_est FROM agg a LEFT JOIN prim p ON 1 = 1)`);
  L.push(`SELECT '${MEASURE}' AS measure, arm_id, arm_kind, arm_label, component, statistic, ord, estimate, method`);
  L.push(`FROM (`);

  const parts: string[][] = [];
  const planRow = (component: string, statistic: string, ord: number, est: string, method: string, from: string) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${q(s.tag)}'`)} AS arm_id,`,
    `         ${STR(`'plan'`)} AS arm_kind, ${STR(`'${q(oneLine(`all ${k} arms of ${s.target.id}`))}'`)} AS arm_label,`,
    `         ${STR(`'${statistic}'`)} AS statistic, ${NUM(String(ord))} AS ord,`,
    `         ${est} AS estimate, ${STR(method)} AS method`,
    `  FROM ${from}`,
  ];
  const armRow = (statistic: string, ordExpr: string, est: string, method: string) => [
    `  SELECT ${STR(`'arm'`)}, sw_arm_id, sw_arm_kind, sw_arm_label,`,
    `         ${STR(`'${statistic}'`)}, ${ordExpr},`,
    `         ${est}, ${method}`,
    `  FROM arms`,
  ];

  /* ---- the design of the sweep itself ---- */
  parts.push(planRow("design", "arms_declared", 0, NUM(String(k)),
    `'${q(`${k} arm(s) DECLARED IN THE SPEC before any estimate existed: ${s.arms.map((a) => `${a.id} (${a.kind})`).join(", ")}. Every one of them is reported below`)}'`, "summary"));
  parts.push(planRow("design", "arms_reported", 1, `n_reported`,
    `'arm rows actually produced. The arm rows are a PROJECTION of the arm table, so this is a count of what the program emitted rather than of what it intended to emit'`, "summary"));
  parts.push(planRow("design", "arms_missing", 2, `n_missing`,
    `CASE WHEN n_missing > 0 THEN 'AN ARM PRODUCED NO ESTIMATE. Its analysis ran but the row this sweep reads was absent - an empty slice, or a cell the closed form leaves undefined. The range below is over the arms that DID report, so it is not the range across the declared sweep and must not be presented as one' ELSE 'every declared arm produced an estimate' END`, "summary"));
  parts.push(planRow("design", "primary_arm", 3, NULLN,
    `'${q(`THE PRIMARY ARM IS "${s.primaryArmId}" (${s.primaryArmLabel}). It was named in the spec before the estimates existed, which is the only thing that stops "the primary analysis" from being whichever arm came out best. Every other arm below is exploratory and carries no declared error rate`)}'`, "summary"));
  parts.push(planRow("design", "familywise_error_if_uncorrected", 4, d.roundN(`1 - POWER(0.95, ${k})`, 5),
    `'${q(`A SWEEP MULTIPLIES THE FALSE-POSITIVE RATE. With ${k} arm(s) each read at a 5% level and none corrected for the others, this is the approximate chance of at least one spurious "significant" result when nothing is going on. It is reported as a number so it cannot be read past`)}'`, "summary"));
  parts.push(planRow("design", "target_analysis", 5, NULLN,
    `'${q(`every arm re-runs analysis "${s.target.id}" (${s.target.kind}) and reports ${s.stat.statName} - ${oneLine(s.stat.label)}. ${hasNull ? `Its null value is ${nv}, so an arm on the other side of ${nv} from the primary arm has the OPPOSITE SIGN` : `It is a level, not a contrast, so it has NO null value and this program makes no direction claim about it`}`)}'`, "summary"));

  /* ---- one block per statistic, ACROSS all arms at once ---- */
  parts.push(armRow("estimate", `${NUM(`100 + sw_arm_ord * 10`)}`, `sw_est`,
    `CASE WHEN sw_arm_kind = 'subgroup' THEN '${q(`${s.stat.statName} from this arm's own run of the analysis on a SLICE of the cohort. The METHOD is identical to the primary arm's; only the population differs`)}' ELSE '${q(`${s.stat.statName} from this arm's own run of the analysis on the WHOLE cohort with ONE parameter overridden. Same emitter, different input - not a second implementation that could drift`)}' END`));
  parts.push(armRow("arm_n", `${NUM(`100 + sw_arm_ord * 10 + 1`)}`, `sw_n`,
    `CASE WHEN sw_arm_kind = 'subgroup' THEN 'members in the slice this arm ran on. A subgroup arm is smaller than the cohort BY CONSTRUCTION, so its interval is wider and its estimate less stable - which is why a subgroup that reaches significance where the primary arm does not is the least trustworthy result a sweep can produce' ELSE 'members in the COHORT this arm ran on, which for a sensitivity arm is the whole cohort by construction. The knob it moves acts INSIDE the analysis - a longer washout excludes prevalent cases from the at-risk set, not from this count - so read the arm program''s own design rows for the analysed n' END`));
  parts.push(armRow("is_primary", `${NUM(`100 + sw_arm_ord * 10 + 2`)}`, `${NUM(`CASE WHEN sw_arm_id = '${q(s.primaryArmId)}' THEN 1 ELSE 0 END`)}`,
    `CASE WHEN sw_arm_id = '${q(s.primaryArmId)}' THEN 'THE PRIMARY ARM, named in the spec in advance' ELSE 'not the primary arm. Presenting this arm as the study result would be choosing the primary analysis after seeing the estimates' END`));
  parts.push(armRow("varied_parameter", `${NUM(`100 + sw_arm_ord * 10 + 3`)}`, `sw_param_value`, `sw_note`));
  if (hasNull) {
    parts.push(armRow("direction", `${NUM(`100 + sw_arm_ord * 10 + 4`)}`,
      `${NUM(`CASE WHEN sw_est IS NULL THEN NULL WHEN sw_est > ${nv} THEN 1 WHEN sw_est < ${nv} THEN -1 ELSE 0 END`)}`,
      `CASE WHEN sw_est IS NULL THEN 'no estimate, so no direction' WHEN sw_est > ${nv} THEN '${q(`above the null (${s.stat.statName} > ${nv})`)}' WHEN sw_est < ${nv} THEN '${q(`BELOW the null (${s.stat.statName} < ${nv}) - the opposite direction to an arm above it`)}' ELSE '${q(`exactly at the null (${s.stat.statName} = ${nv})`)}' END`));
  } else {
    parts.push(armRow("direction", `${NUM(`100 + sw_arm_ord * 10 + 4`)}`, NULLN,
      `'${q(`${s.stat.statName} is a LEVEL, not a contrast: it has no null value, so there is no direction to agree or disagree about and this program claims none. Compare the arms on magnitude and read the range below`)}'`));
  }

  /* ---- the range ---- */
  parts.push(planRow("range", "estimate_min", 800, `est_min`, `'smallest ${q(s.stat.statName)} across the reported arms'`, "summary"));
  parts.push(planRow("range", "estimate_max", 801, `est_max`, `'largest ${q(s.stat.statName)} across the reported arms'`, "summary"));
  parts.push(planRow("range", "estimate_span", 802, `est_max - est_min`,
    `'${q(`THE RANGE ACROSS ARMS, on the ${s.stat.scale} scale. Read it as the spread the analysis CHOICES produce. It is NOT a confidence interval and has no coverage property - it widens when arms are added and narrows when they are not`)}'`, "summary"));
  parts.push(planRow("range", "primary_estimate", 803, `primary_est`,
    `'${q(`the pre-declared primary arm's estimate ("${s.primaryArmId}"). Report it as the study result; report the span above beside it`)}'`, "summary"));

  /* ---- direction agreement ---- */
  parts.push(planRow("direction", "arms_above_null", 900, `n_above`,
    hasNull ? `'${q(`arms with ${s.stat.statName} above ${nv}`)}'` : `'no null value, so no arm is above or below one'`, "summary"));
  parts.push(planRow("direction", "arms_below_null", 901, `n_below`,
    hasNull ? `'${q(`arms with ${s.stat.statName} below ${nv}`)}'` : `'no null value, so no arm is above or below one'`, "summary"));
  if (hasNull) {
    parts.push(planRow("direction", "direction_disagreement", 902,
      `${NUM(`CASE WHEN n_above > 0 AND n_below > 0 THEN 1 ELSE 0 END`)}`,
      `CASE WHEN n_above > 0 AND n_below > 0 THEN '${q(`ARMS DISAGREE IN DIRECTION. At least one arm falls above the null (${s.stat.statName} > ${nv}) and at least one below it. AN EFFECT WHOSE SIGN FLIPS UNDER A DIFFERENT ANALYSIS CHOICE IS NOT ROBUST UNDER ANY THRESHOLD, and reporting the primary arm alone would assert a direction these data do not support. Report the disagreeing arm beside the primary estimate`)}' ELSE '${q(`every reported arm falls on the same side of the null (${s.stat.statName} = ${nv}). That is agreement in DIRECTION only, and says nothing about magnitude - read the span above`)}' END`, "summary"));
  } else {
    parts.push(planRow("direction", "direction_disagreement", 902, NULLN,
      `'${q(`NO DIRECTION VERDICT IS POSSIBLE. ${s.stat.statName} is a level rather than a contrast, so it has no null value and "the same direction" is not defined for it. Claiming agreement here would be an assertion about nothing`)}'`, "summary"));
  }

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push(``);
  L.push(`-- REVIEW: read the DESIGN rows first (what was declared, and by whom, and`);
  L.push(`-- when), then every arm, then the range and the direction verdict. An arm`);
  L.push(`-- that disagrees with the primary one is a finding, not a nuisance.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);
  return L.join("\n");
}

const MEASURE = "sweep";

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

/** The arm's cohort data set (SAS). */
export function sasArmCohortTable(tbl: (s: string) => string, num: string, arm: ResolvedArm): string {
  return tbl(`${num}_coh${arm.suffix}`);
}

export function sweepArmCohortsSas(o: {
  spec: StudySpec;
  s: ResolvedSweep;
  num: string;
  finalCohort: string;
  enrollTable: string;
  tbl: (s: string) => string;
}): string[] {
  const { s, num, finalCohort, enrollTable, tbl } = o;
  const L: string[] = [];
  L.push(
    `/*----------------------------------------------------------------------------`,
    `  ARM COHORTS for sweep "${cmt(s.tag)}" over analysis "${cmt(s.target.id)}" (${s.target.kind}).`,
    `  One data set per declared arm. A SENSITIVITY arm's data set is the whole`,
    `  cohort by construction, so nothing but its one declared parameter can differ`,
    `  from the primary arm; a SUBGROUP arm's is a slice, and the analysis run over`,
    `  it is the same program apart from the data set it reads.`,
    `----------------------------------------------------------------------------*/`,
    ``,
  );
  const deleteList = s.arms.map((a) => sasArmCohortTable(tbl, num, a).replace("tz.", "")).join(" ");
  L.push(`proc datasets lib=tz nolist nowarn;`, `  delete ${deleteList};`, `quit;`, ``);
  for (const arm of s.arms) {
    const t = sasArmCohortTable(tbl, num, arm);
    L.push(`/* ${arm.kind === "subgroup" ? "SUBGROUP" : "SENSITIVITY"} arm "${cmt(arm.id)}": ${cmt(arm.label)}`);
    L.push(`   ${cmt(arm.note)} */`);
    if (arm.kind === "sensitivity" || !arm.slice) {
      L.push(`data ${t};`, `  set ${finalCohort};`, `run;`, ``);
    } else {
      const slice = arm.slice;
      const w = `work._${num}_${sasName(arm.id)}`;
      /* The demographic pull selects the cohort's key and index date EXPLICITLY
       * rather than a.*: the cohort already carries a `sex` of its own (from the
       * index event), and a duplicate column name in PROC SQL is resolved
       * silently in favour of whichever side came first. Which `sex` a slice
       * compared against would then depend on emission order. */
      L.push(
        `proc sql;`,
        `  create table ${w}_dm as`,
        `  select a.enrolid, a.index_date, b.dobyr, b.sex, b.region, b.plantyp,`,
        `         b.dtstart as seg_start, b.dtend as seg_end`,
        `  from ${finalCohort} as a`,
        `  left join ${enrollTable} as b`,
        `    on  b.enrolid = a.enrolid`,
        `    and b.dtstart <= a.index_date;`,
        `quit;`,
        ``,
        `proc sort data=${w}_dm;`,
        `  by enrolid descending seg_start descending seg_end;`,
        `run;`,
        ``,
        `data ${w}_pick;`,
        `  set ${w}_dm;`,
        `  by enrolid;`,
        `  if first.enrolid;   /* the segment in force at (or latest before) index */`,
        ...sliceStepSas(slice).map((l) => `  ${l}`),
        `  keep enrolid;`,
        `run;`,
        ``,
        `/* the SLICE, taken as a subset of the cohort itself, so the arm's cohort`,
        `   has exactly the columns every analysis module expects to find */`,
        `proc sql;`,
        `  create table ${t} as`,
        `  select * from ${finalCohort}`,
        `  where enrolid in (select enrolid from ${w}_pick);`,
        `quit;`,
        ``,
      );
    }
    L.push(
      `title "Sweep arm ${cmt(arm.id)} (${arm.kind}): members";`,
      `proc sql;`,
      `  select '${sq(arm.id)}' as arm_id length=32, '${sq(arm.kind)}' as arm_kind length=12,`,
      `         count(*) as members`,
      `  from ${t};`,
      `quit;`,
      `title;`,
      ``,
    );
  }
  return L;
}

/** SAS twin of the slice predicate, through the SAME cell-axis helpers. */
function sliceStepSas(slice: SlicePlan): string[] {
  if (slice.level !== undefined) {
    const axis: CellAxis = { id: slice.baselineId, label: slice.baselineLabel, kind: slice.kind as CellAxis["kind"] };
    return [
      `length _slice $40;`,
      ...cellAssignSas(axis, "_slice"),
      `if _slice = '${sq(slice.level)}';`,
    ];
  }
  const conds: string[] = [];
  if (slice.min !== undefined) conds.push(`${SAS_BANDED_VALUE} >= ${slice.min}`);
  if (slice.max !== undefined) conds.push(`${SAS_BANDED_VALUE} < ${slice.max}`);
  return [...sasBandedValueStep(), `if ${conds.join(" and ")};`];
}

/** SAS twin of the sweep summary. Same rows, same numbers, same prose. */
export function sweepSummarySas(o: {
  s: ResolvedSweep;
  num: string;
  cohNum: string;
  outT: string;
  armTables: string[];
  tbl: (t: string) => string;
}): string[] {
  const { s, num, cohNum, outT, armTables, tbl } = o;
  const nv = s.stat.nullValue;
  const hasNull = nv !== null;
  const k = s.arms.length;
  const L: string[] = [];

  L.push(`/*-------------------- one row per DECLARED arm -------------------------------*/`);
  L.push(`proc sql;`);
  s.arms.forEach((arm, i) => {
    L.push(
      `  create table work._${num}_e${i} as`,
      `  select ${s.stat.valueCol} as sw_est`,
      `  from ${armTables[i]}`,
      `  where ${statWhereSas(s.stat)};`,
      ``,
      `  create table work._${num}_c${i} as`,
      `  select count(*) as sw_n`,
      `  from ${sasArmCohortTable(tbl, cohNum, arm)};`,
      ``,
    );
  });
  L.push(`quit;`, ``);
  s.arms.forEach((arm, i) => {
    L.push(
      `data work._${num}_a${i};`,
      `  merge work._${num}_e${i} work._${num}_c${i};`,
      `  length sw_arm_id $32 sw_arm_kind $12 sw_arm_label $120 sw_param $32 sw_slice $60 sw_note $700;`,
      `  sw_arm_id = '${sq(arm.id)}'; sw_arm_kind = '${sq(arm.kind)}'; sw_arm_label = '${sq(oneLine(arm.label))}';`,
      `  sw_arm_ord = ${arm.ord}; sw_param = '${sq(arm.vary?.param ?? "")}';`,
      `  sw_param_value = ${arm.vary ? String(arm.vary.value) : "."};`,
      `  sw_slice = '${sq(arm.slice?.stamped ?? "")}'; sw_note = '${sq(oneLine(arm.note))}';`,
      `run;`,
      ``,
    );
  });
  L.push(
    `data work._${num}_arms;`,
    `  set ${s.arms.map((_a, i) => `work._${num}_a${i}`).join(" ")};`,
    `run;`,
    ``,
    `/*-------------------- the cross-arm summary ----------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_agg as`,
    `  select count(*) as n_reported,`,
    `         sum(sw_est = .) as n_missing,`,
    `         min(sw_est) as est_min, max(sw_est) as est_max,`,
  );
  if (hasNull) {
    L.push(
      `         sum(sw_est ne . and sw_est > ${nv}) as n_above,`,
      `         sum(sw_est ne . and sw_est < ${nv}) as n_below`,
    );
  } else {
    L.push(`         . as n_above,`, `         . as n_below`);
  }
  L.push(
    `  from work._${num}_arms;`,
    ``,
    `  create table work._${num}_prim as`,
    `  select sw_est as primary_est from work._${num}_arms where sw_arm_id = '${sq(s.primaryArmId)}';`,
    `quit;`,
    ``,
    `data work._${num}_summary;`,
    `  merge work._${num}_agg work._${num}_prim;`,
    `run;`,
    ``,
  );

  const planLbl = sq(oneLine(`all ${k} arms of ${s.target.id}`));
  L.push(
    `/*-------------------- plan-level rows ----------------------------------------*/`,
    `data work._${num}_plan;`,
    `  length measure $20 arm_id $32 arm_kind $12 arm_label $120 component $12 statistic $40 method $900;`,
    `  set work._${num}_summary;`,
    `  measure = "${MEASURE}"; arm_id = '${sq(s.tag)}'; arm_kind = 'plan'; arm_label = '${planLbl}';`,
    `  component = 'design';`,
    `  statistic = 'arms_declared'; ord = 0; estimate = ${k};`,
    `  method = '${sq(`${k} arm(s) DECLARED IN THE SPEC before any estimate existed: ${s.arms.map((a) => `${a.id} (${a.kind})`).join(", ")}. Every one of them is reported below`)}'; output;`,
    `  statistic = 'arms_reported'; ord = 1; estimate = n_reported;`,
    `  method = 'arm rows actually produced. The arm rows are a PROJECTION of the arm table, so this is a count of what the program emitted rather than of what it intended to emit'; output;`,
    `  statistic = 'arms_missing'; ord = 2; estimate = n_missing;`,
    `  if n_missing > 0 then method = 'AN ARM PRODUCED NO ESTIMATE. Its analysis ran but the row this sweep reads was absent - an empty slice, or a cell the closed form leaves undefined. The range below is over the arms that DID report, so it is not the range across the declared sweep and must not be presented as one';`,
    `  else method = 'every declared arm produced an estimate'; output;`,
    `  statistic = 'primary_arm'; ord = 3; estimate = .;`,
    `  method = '${sq(`THE PRIMARY ARM IS "${s.primaryArmId}" (${s.primaryArmLabel}). It was named in the spec before the estimates existed, which is the only thing that stops "the primary analysis" from being whichever arm came out best. Every other arm below is exploratory and carries no declared error rate`)}'; output;`,
    `  statistic = 'familywise_error_if_uncorrected'; ord = 4; estimate = round(1 - 0.95**${k}, 0.00001);`,
    `  method = '${sq(`A SWEEP MULTIPLIES THE FALSE-POSITIVE RATE. With ${k} arm(s) each read at a 5% level and none corrected for the others, this is the approximate chance of at least one spurious "significant" result when nothing is going on. It is reported as a number so it cannot be read past`)}'; output;`,
    `  statistic = 'target_analysis'; ord = 5; estimate = .;`,
    `  method = '${sq(`every arm re-runs analysis "${s.target.id}" (${s.target.kind}) and reports ${s.stat.statName} - ${oneLine(s.stat.label)}. ${hasNull ? `Its null value is ${nv}, so an arm on the other side of ${nv} from the primary arm has the OPPOSITE SIGN` : `It is a level, not a contrast, so it has NO null value and this program makes no direction claim about it`}`)}'; output;`,
    `  keep measure arm_id arm_kind arm_label component statistic ord estimate method;`,
    `run;`,
    ``,
    `/*-------------------- per-arm rows, across EVERY arm at once -----------------*/`,
    `data work._${num}_armrows;`,
    `  length measure $20 arm_id $32 arm_kind $12 arm_label $120 component $12 statistic $40 method $900;`,
    `  set work._${num}_arms;`,
    `  measure = "${MEASURE}"; component = 'arm';`,
    `  arm_id = sw_arm_id; arm_kind = sw_arm_kind; arm_label = sw_arm_label;`,
    `  statistic = 'estimate'; ord = 100 + sw_arm_ord * 10; estimate = sw_est;`,
    `  if sw_arm_kind = 'subgroup' then method = '${sq(`${s.stat.statName} from this arm's own run of the analysis on a SLICE of the cohort. The METHOD is identical to the primary arm's; only the population differs`)}';`,
    `  else method = '${sq(`${s.stat.statName} from this arm's own run of the analysis on the WHOLE cohort with ONE parameter overridden. Same emitter, different input - not a second implementation that could drift`)}'; output;`,
    `  statistic = 'arm_n'; ord = 100 + sw_arm_ord * 10 + 1; estimate = sw_n;`,
    `  if sw_arm_kind = 'subgroup' then method = 'members in the slice this arm ran on. A subgroup arm is smaller than the cohort BY CONSTRUCTION, so its interval is wider and its estimate less stable - which is why a subgroup that reaches significance where the primary arm does not is the least trustworthy result a sweep can produce';`,
    `  else method = 'members in the COHORT this arm ran on, which for a sensitivity arm is the whole cohort by construction. The knob it moves acts INSIDE the analysis - a longer washout excludes prevalent cases from the at-risk set, not from this count - so read the arm program''s own design rows for the analysed n'; output;`,
    `  statistic = 'is_primary'; ord = 100 + sw_arm_ord * 10 + 2; estimate = (sw_arm_id = '${sq(s.primaryArmId)}');`,
    `  if sw_arm_id = '${sq(s.primaryArmId)}' then method = 'THE PRIMARY ARM, named in the spec in advance';`,
    `  else method = 'not the primary arm. Presenting this arm as the study result would be choosing the primary analysis after seeing the estimates'; output;`,
    `  statistic = 'varied_parameter'; ord = 100 + sw_arm_ord * 10 + 3; estimate = sw_param_value;`,
    `  method = sw_note; output;`,
  );
  if (hasNull) {
    L.push(
      `  statistic = 'direction'; ord = 100 + sw_arm_ord * 10 + 4;`,
      `  if sw_est = . then do; estimate = .; method = 'no estimate, so no direction'; end;`,
      `  else if sw_est > ${nv} then do; estimate = 1; method = '${sq(`above the null (${s.stat.statName} > ${nv})`)}'; end;`,
      `  else if sw_est < ${nv} then do; estimate = -1; method = '${sq(`BELOW the null (${s.stat.statName} < ${nv}) - the opposite direction to an arm above it`)}'; end;`,
      `  else do; estimate = 0; method = '${sq(`exactly at the null (${s.stat.statName} = ${nv})`)}'; end;`,
      `  output;`,
    );
  } else {
    L.push(
      `  statistic = 'direction'; ord = 100 + sw_arm_ord * 10 + 4; estimate = .;`,
      `  method = '${sq(`${s.stat.statName} is a LEVEL, not a contrast: it has no null value, so there is no direction to agree or disagree about and this program claims none. Compare the arms on magnitude and read the range below`)}'; output;`,
    );
  }
  L.push(
    `  keep measure arm_id arm_kind arm_label component statistic ord estimate method;`,
    `run;`,
    ``,
    `/*-------------------- the range and the direction verdict --------------------*/`,
    `data work._${num}_verdict;`,
    `  length measure $20 arm_id $32 arm_kind $12 arm_label $120 component $12 statistic $40 method $900;`,
    `  set work._${num}_summary;`,
    `  measure = "${MEASURE}"; arm_id = '${sq(s.tag)}'; arm_kind = 'plan'; arm_label = '${planLbl}';`,
    `  component = 'range';`,
    `  statistic = 'estimate_min'; ord = 800; estimate = est_min;`,
    `  method = 'smallest ${sq(s.stat.statName)} across the reported arms'; output;`,
    `  statistic = 'estimate_max'; ord = 801; estimate = est_max;`,
    `  method = 'largest ${sq(s.stat.statName)} across the reported arms'; output;`,
    `  statistic = 'estimate_span'; ord = 802; estimate = est_max - est_min;`,
    `  method = '${sq(`THE RANGE ACROSS ARMS, on the ${s.stat.scale} scale. Read it as the spread the analysis CHOICES produce. It is NOT a confidence interval and has no coverage property - it widens when arms are added and narrows when they are not`)}'; output;`,
    `  statistic = 'primary_estimate'; ord = 803; estimate = primary_est;`,
    `  method = '${sq(`the pre-declared primary arm's estimate ("${s.primaryArmId}"). Report it as the study result; report the span above beside it`)}'; output;`,
    `  component = 'direction';`,
    `  statistic = 'arms_above_null'; ord = 900; estimate = n_above;`,
    `  method = '${hasNull ? sq(`arms with ${s.stat.statName} above ${nv}`) : `no null value, so no arm is above or below one`}'; output;`,
    `  statistic = 'arms_below_null'; ord = 901; estimate = n_below;`,
    `  method = '${hasNull ? sq(`arms with ${s.stat.statName} below ${nv}`) : `no null value, so no arm is above or below one`}'; output;`,
  );
  if (hasNull) {
    L.push(
      `  statistic = 'direction_disagreement'; ord = 902; estimate = (n_above > 0 and n_below > 0);`,
      `  if n_above > 0 and n_below > 0 then method = '${sq(`ARMS DISAGREE IN DIRECTION. At least one arm falls above the null (${s.stat.statName} > ${nv}) and at least one below it. AN EFFECT WHOSE SIGN FLIPS UNDER A DIFFERENT ANALYSIS CHOICE IS NOT ROBUST UNDER ANY THRESHOLD, and reporting the primary arm alone would assert a direction these data do not support. Report the disagreeing arm beside the primary estimate`)}';`,
      `  else method = '${sq(`every reported arm falls on the same side of the null (${s.stat.statName} = ${nv}). That is agreement in DIRECTION only, and says nothing about magnitude - read the span above`)}';`,
      `  output;`,
    );
  } else {
    L.push(
      `  statistic = 'direction_disagreement'; ord = 902; estimate = .;`,
      `  method = '${sq(`NO DIRECTION VERDICT IS POSSIBLE. ${s.stat.statName} is a level rather than a contrast, so it has no null value and "the same direction" is not defined for it. Claiming agreement here would be an assertion about nothing`)}'; output;`,
    );
  }
  L.push(
    `  keep measure arm_id arm_kind arm_label component statistic ord estimate method;`,
    `run;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_plan work._${num}_armrows work._${num}_verdict;`,
    `run;`,
    ``,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Sweep ${sq(s.tag)} over ${sq(s.target.id)}: every declared arm";`,
    `proc print data=${outT} noobs;`,
    `  var measure arm_id arm_kind arm_label component statistic estimate method;`,
    `run;`,
    `title;`,
    ``,
  );
  return L;
}
