/**
 * Competing-risks cumulative incidence (Aalen-Johansen).
 *
 * This module has an unusual amount of executable content and one unusual job:
 * most of what it emits is the estimator, and the rest is EVIDENCE THAT THE
 * ESTIMATOR WAS NEEDED. The naive 1 - Kaplan-Meier is computed beside the CIF
 * and their difference reported, so the reason for using this analysis is a
 * subtraction in the output rather than a claim in a method note.
 *
 * EXECUTED IN BOTH TWINS, all of it:
 *   - the ALL-CAUSE Kaplan-Meier, which is the weight the estimator applies;
 *   - CIF_k(t) for the event of interest and every competing cause;
 *   - the delta-method variance and its Wald interval;
 *   - the naive 1 - KM per cause, and the bias;
 *   - the PARTITION IDENTITY, SUM_k CIF_k(t) = 1 - S(t), as a checked row.
 *
 * SAS-PRIMARY: nothing. There is no p-value here and no fitted coefficient, so
 * unlike every other family in this repo the SQL twin is complete. Gray's test
 * — the competing-risks analogue of the log-rank — is NOT emitted rather than
 * approximated; see the limitations.
 *
 * THE IDENTITY IS THE REASON THIS IS TRUSTWORTHY. The causes are exhaustive and
 * mutually exclusive, so the CIFs must sum to exactly 1 - S at every event
 * time. It is not a tolerance check: the sums telescope, and any error in one
 * cause's accumulation — a wrong weight, a per-cause risk set, a dropped term —
 * breaks it. The module emits the residual as a row so the check travels with
 * the result instead of living only in this repo's harness.
 *
 * Verified vs Gold Case D: CIF 1/3 for the event of interest against a naive
 * 1 - KM of 3/8, so the naive estimate OVERSTATES by exactly 1/24; competing
 * CIF 1/6 against a naive 1/5, overstating by 1/30; the two CIFs sum to 1/2,
 * which is exactly 1 - S(300). The naive pair sums to 23/40 — two mutually
 * exclusive outcomes whose probabilities add to more than the probability of
 * either happening. Verified vs Gold Case A, which has NO competing events:
 * the CIF equals 1 - KM equals the cumulative-incidence module's 3/8, the bias
 * is exactly zero, and the delta-method variance reduces to Greenwood's 15/512.
 */
import type { CompetingRisksAnalysis, OutcomeDefinition } from "../../spec/types";
import { findCodeList, survivalOutcome } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import { cmt, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import { censorPlan, renderCensorSql, renderCensorSas } from "../rate-core";
import {
  cifSqlCtes, cifVarianceSqlCtes, naiveKmSqlCtes,
  cifSasSteps, cifSasVarianceSteps, naiveKmSasSteps, cifSasHorizonSteps, cifSasAnchor,
} from "../cif-core";
import {
  outcomeSettingPlan,
  parityStamp,
  competingRisksLimitations,
  competingRisksParity,
  COMPETING_RISKS_METHOD_NOTES,
} from "../parity";

const MEASURE = "competing_risks";

const ORD_LIFE = 0;
const ORD_CIF = 1000;
const ORD_NAIVE = 2000;
const ORD_IDENTITY = 3000;

/** Cause 1 is always the event of interest; competing causes follow in spec
 *  order. The mapping is fixed rather than derived so both twins, the
 *  fingerprint and the harness all mean the same thing by "cause 2". */
function causePlan(an: CompetingRisksAnalysis) {
  const od = survivalOutcome(an);
  const causes: Array<{ code: number; id: string; label: string; od: OutcomeDefinition; isInterest: boolean }> = [];
  if (od) causes.push({ code: 1, id: "interest", label: "Event of interest", od, isInterest: true });
  an.competingEvents.forEach((ce, i) =>
    causes.push({ code: 2 + i, id: ce.id, label: ce.label, od: ce.outcomeDefinition, isInterest: false }),
  );
  return causes;
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlCompetingRisks(ctx: SqlCtx, an: CompetingRisksAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_cif${suffix}`;
  const od = survivalOutcome(an);
  const L: string[] = [];

  if (!od) {
    L.push(`-- NOT EMITTED: the event of interest is a MORTALITY endpoint, which is refused`);
    L.push(`-- (DSTATUS is in-hospital only and masked from 2016). A competing cause read`);
    L.push(`-- from a claims code list is a different matter and belongs in competingEvents[].`);
    return {
      slug: `cif${suffix}`, title: `Competing risks${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted", extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`], body: L.join("\n"),
    };
  }

  const causes = causePlan(an);
  const codes = causes.map((c) => c.code);
  const censor = censorPlan(spec, an.personTimeRule);
  const listSystem = findCodeList(spec, od.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(od, listSystem);

  L.push(`-- ${parityStamp("competing_risks", competingRisksParity(an, {
    censorTerms: censor.applied, dataCut: censor.dataCut, settingFilter: setting.stamped,
    causes: causes.map((c) => ({ code: c.code, id: c.id, codeListId: c.od.codeListId })),
  }))}`);
  const limits = competingRisksLimitations(an, listSystem, spec);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of COMPETING_RISKS_METHOD_NOTES) L.push(`--   * ${note}`);

  const C: string[] = [];
  C.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${ctx.cohortT}),`);
  /* Every cause's events, from its OWN code list, tagged with its cause code.
   * A single UNION so the "first event of ANY cause" is one MIN over one set —
   * computing per-cause firsts and combining them afterwards is how a subject
   * ends up contributing to two causes at once. */
  causes.forEach((c, i) => {
    const cSetting = outcomeSettingPlan(c.od, findCodeList(spec, c.od.codeListId)?.system ?? "icd10cm");
    C.push(`${i === 0 ? `ev AS (` : `  UNION ALL`}`);
    C.push(`  SELECT enrolid, event_date, ${c.code} AS cause`);
    C.push(`  FROM ${wp}_events WHERE code_list_id = '${q(c.od.codeListId)}'` +
      (cSetting.enforce ? ` AND setting = '${cSetting.enforce}'` : ``));
  });
  C.push(`),`);
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  C.push(`prevalent AS (   -- washout on the EVENT OF INTEREST: ${describeWindow(an.washout)}`);
  C.push(`  SELECT DISTINCT c.enrolid`);
  C.push(`  FROM cohort c JOIN ev a ON a.enrolid = c.enrolid AND a.cause = 1`);
  C.push(`  WHERE ${wc.length > 0 ? wc.join("\n      AND ") : "TRUE"}`);
  C.push(`),`);
  C.push(`atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),`);
  C.push(`first_any AS (   -- the FIRST event of ANY cause, and which cause it was`);
  C.push(`  SELECT enrolid, event_date AS fu_date, cause FROM (`);
  C.push(`    SELECT c.enrolid, a.event_date, a.cause,`);
  C.push(`           ROW_NUMBER() OVER (PARTITION BY c.enrolid`);
  C.push(`                              -- cause ASC breaks a same-day tie toward the`);
  C.push(`                              -- event of interest, DETERMINISTICALLY. Some`);
  C.push(`                              -- rule is required and an arbitrary one would`);
  C.push(`                              -- make the estimate depend on row order.`);
  C.push(`                              ORDER BY a.event_date, a.cause) AS rn`);
  C.push(`    FROM atrisk c JOIN ev a ON a.enrolid = c.enrolid AND a.event_date > c.index_date`);
  C.push(`  ) z WHERE rn = 1`);
  C.push(`),`);
  C.push(`s0 AS (   -- censoring: ${censor.applied.join(" / ")}${censor.dataCut ? ` / data cut ${censor.dataCut}` : ``}`);
  C.push(`  SELECT c.enrolid, c.index_date, ${renderCensorSql(ctx, censor)} AS admin_censor,`);
  C.push(`         f.fu_date, f.cause`);
  C.push(`  FROM atrisk c`);
  C.push(`  JOIN ${wp}_enroll_episodes ep`);
  C.push(`    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end`);
  C.push(`  LEFT JOIN first_any f ON f.enrolid = c.enrolid`);
  C.push(`),`);
  C.push(`subj AS (   -- one row per subject: time, and WHICH cause ended it (0 = censored)`);
  C.push(`  SELECT enrolid, 'Overall' AS stratum,`);
  C.push(`         ${d.daysBetween(`LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor)`, "index_date")} AS t,`);
  C.push(`         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN cause ELSE 0 END AS cause`);
  C.push(`  FROM s0`);
  C.push(`),`);
  C.push(...cifSqlCtes({ subjectsCte: "subj", causes: codes }));
  for (const c of codes) C.push(...cifVarianceSqlCtes({ ajCte: "aj", cause: c }));
  if (an.emitNaiveComparison) for (const c of codes) C.push(...naiveKmSqlCtes({ subjectsCte: "subj", cause: c }));

  /* Horizon rows: the last life-table row at or before each day mark, driven
   * off the horizon list so a mark before the first event reports 0 rather
   * than vanishing. */
  C.push(`horizons AS (`);
  an.horizonDays.forEach((h, k) => {
    C.push(`  SELECT ${h} AS horizon`);
    if (k < an.horizonDays.length - 1) C.push(`  UNION ALL`);
  });
  C.push(`),`);
  C.push(`hz0 AS (`);
  C.push(`  SELECT h.horizon, a.t, a.surv_all,`);
  for (const c of codes) C.push(`         a.cif_${c}, v${c}.var_${c},`);
  C.push(`         ROW_NUMBER() OVER (PARTITION BY h.horizon ORDER BY a.t DESC) AS rn`);
  C.push(`  FROM horizons h`);
  C.push(`  LEFT JOIN aj a ON a.t <= h.horizon`);
  for (const c of codes) C.push(`  LEFT JOIN ajv_${c} v${c} ON v${c}.t = a.t`);
  C.push(`),`);
  C.push(`hz AS (`);
  C.push(`  -- COALESCE to 0/1: no event at or before the mark means the cumulative`);
  C.push(`  -- incidence is zero and all-cause survival is one, not missing.`);
  C.push(`  SELECT horizon, COALESCE(surv_all, 1.0) AS surv_all,`);
  for (const c of codes) C.push(`         COALESCE(cif_${c}, 0.0) AS cif_${c}, COALESCE(var_${c}, 0.0) AS var_${c},`);
  C.push(`         1 AS one FROM hz0 WHERE rn = 1`);
  C.push(`),`);
  if (an.emitNaiveComparison) {
    C.push(`nvhz AS (   -- the NAIVE 1 - KM at the same marks, for the comparison`);
    C.push(`  SELECT h.horizon,`);
    for (const c of codes) {
      C.push(`         COALESCE((SELECT n.naive_${c} FROM nv_${c} n WHERE n.t <= h.horizon ORDER BY n.t DESC LIMIT 1), 0.0) AS naive_${c}${c === codes[codes.length - 1] ? `` : `,`}`);
    }
    C.push(`  FROM horizons h`);
    C.push(`),`);
  }
  C[C.length - 1] = C[C.length - 1].replace(/,\s*$/, "");

  const NULLN = `CAST(NULL AS NUMERIC)`;
  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const label = (c: { code: number; label: string; isInterest: boolean }) =>
    c.isInterest ? `${c.label} (cause 1)` : `${c.label} (competing, cause ${c.code})`;

  L.push(d.createTableAs(out));
  L.push(...C);
  /* ONE point identifier, not two mutually exclusive ones.
   * The life table is indexed by EVENT TIME and the estimates by HORIZON, and
   * carrying both as separate columns left every row with one of them NULL —
   * which broke the results contract's "every row is fully labeled" rule and,
   * worse, would have let a horizon that happens to equal an event time
   * collide with it in the tidy table. at_label is unique by construction. */
  L.push(`SELECT '${MEASURE}' AS measure, component, cause, at_kind, at_days, at_label,`);
  L.push(`       n_risk, n_event, estimate, se, ci_low, ci_high, method`);
  L.push(`FROM (`);

  const parts: string[][] = [];

  // 1. the life table, opt-in (per-event-time rows are the most disclosive here)
  if (an.emitLifeTable) {
    for (const c of causes) {
      parts.push([
        `  SELECT ${STR(`'life_table'`)} AS component, ${STR(`'${q(label(c))}'`)} AS cause,`,
        `         ${STR(`'event_time'`)} AS at_kind, CAST(a.t AS INT) AS at_days,`,
        `         ${STR(`'event time ' || CAST(a.t AS VARCHAR) || 'd'`)} AS at_label,`,
        `         CAST(a.n_risk AS INT) AS n_risk, CAST(a.d_${c.code} AS INT) AS n_event,`,
        `         ${d.roundN(`a.cif_${c.code}`, 5)} AS estimate,`,
        `         ${d.roundN(`SQRT(GREATEST(v.var_${c.code}, 0))`, 5)} AS se,`,
        `         ${NULLN} AS ci_low, ${NULLN} AS ci_high,`,
        `         ${STR(`'aalen_johansen'`)} AS method`,
        `  FROM aj a LEFT JOIN ajv_${c.code} v ON v.t = a.t`,
      ]);
    }
  }

  // 2. the CIF at each horizon, with its Wald interval
  for (const c of causes) {
    const est = `cif_${c.code}`;
    const se = `SQRT(GREATEST(var_${c.code}, 0))`;
    parts.push([
      `  SELECT ${STR(`'cif'`)}, ${STR(`'${q(label(c))}'`)},`,
      `         ${STR(`'horizon'`)}, CAST(horizon AS INT), ${STR(`'horizon ' || CAST(horizon AS VARCHAR) || 'd'`)},`,
      `         CAST(NULL AS INT), CAST(NULL AS INT),`,
      `         ${d.roundN(est, 5)}, ${d.roundN(se, 5)},`,
      /* Clamped to [0,1] and SAID so. The delta-method interval is on the raw
       * scale, so near 0 or 1 it runs outside the range a probability can take;
       * a limit that was truncated is a different statement than one that
       * landed there, so the clamp is visible rather than hidden downstream. */
      `         ${d.roundN(`GREATEST(0.0, ${est} - 1.96 * ${se})`, 5)},`,
      `         ${d.roundN(`LEAST(1.0, ${est} + 1.96 * ${se})`, 5)},`,
      `         ${STR(`'aalen_johansen, delta-method Wald interval clamped to [0,1]'`)}`,
      `  FROM hz`,
    ]);
  }

  // 3. the naive comparison — the reason the analysis exists
  if (an.emitNaiveComparison) {
    for (const c of causes) {
      parts.push([
        `  SELECT ${STR(`'naive_km'`)}, ${STR(`'${q(label(c))}'`)},`,
        `         ${STR(`'horizon'`)}, CAST(hz.horizon AS INT), ${STR(`'horizon ' || CAST(hz.horizon AS VARCHAR) || 'd'`)},`,
        `         CAST(NULL AS INT), CAST(NULL AS INT),`,
        `         ${d.roundN(`n.naive_${c.code}`, 5)}, ${NULLN}, ${NULLN}, ${NULLN},`,
        `         ${STR(`'1 - Kaplan-Meier, competing events treated as CENSORED. This is the number Aalen-Johansen replaces, computed here so the difference is visible'`)}`,
        `  FROM hz JOIN nvhz n ON n.horizon = hz.horizon`,
      ]);
      parts.push([
        `  SELECT ${STR(`'bias'`)}, ${STR(`'${q(label(c))}'`)},`,
        `         ${STR(`'horizon'`)}, CAST(hz.horizon AS INT), ${STR(`'horizon ' || CAST(hz.horizon AS VARCHAR) || 'd'`)},`,
        `         CAST(NULL AS INT), CAST(NULL AS INT),`,
        `         ${d.roundN(`n.naive_${c.code} - hz.cif_${c.code}`, 5)}, ${NULLN}, ${NULLN}, ${NULLN},`,
        `         CASE WHEN n.naive_${c.code} - hz.cif_${c.code} > 1e-9`,
        `              THEN ${STR(`'OVERSTATEMENT: this is how much 1 - Kaplan-Meier exaggerates the risk of this cause, because it treats the competing events as if those subjects could still have had it'`)}`,
        `              ELSE ${STR(`'no competing event occurred before this mark, so the two estimators coincide here - which is the DEGENERATE case, not a validation of either'`)} END`,
        `  FROM hz JOIN nvhz n ON n.horizon = hz.horizon`,
      ]);
    }
    /* THE PATHOLOGY. Naive complements need not sum to 1 - S, and when they
     * exceed it the set of probabilities is not merely biased, it is
     * impossible: mutually exclusive outcomes adding to more than the chance of
     * any outcome at all. */
    const naiveSum = codes.map((c) => `n.naive_${c}`).join(" + ");
    parts.push([
      `  SELECT ${STR(`'diagnostic'`)}, ${STR(`'All causes'`)},`,
      `         ${STR(`'horizon'`)}, CAST(hz.horizon AS INT), ${STR(`'horizon ' || CAST(hz.horizon AS VARCHAR) || 'd'`)},`,
        `         CAST(NULL AS INT), CAST(NULL AS INT),`,
      `         ${d.roundN(naiveSum, 5)}, ${NULLN}, ${NULLN}, ${NULLN},`,
      `         CASE WHEN (${naiveSum}) > (1.0 - hz.surv_all) + 1e-9`,
      `              THEN ${STR(`'IMPOSSIBLE AS A SET: the naive per-cause risks sum to MORE than the probability of any event at all. They are mutually exclusive outcomes, so this cannot be a rounding artefact - it is what treating competing events as censoring produces'`)}`,
      `              ELSE ${STR(`'the naive risks do not exceed the total event probability at this mark'`)} END`,
      `  FROM hz JOIN nvhz n ON n.horizon = hz.horizon`,
    ]);
  }

  // 4. THE PARTITION IDENTITY, emitted as a checked row
  const cifSum = codes.map((c) => `cif_${c}`).join(" + ");
  parts.push([
    `  SELECT ${STR(`'identity'`)}, ${STR(`'All causes'`)},`,
    `         ${STR(`'horizon'`)}, CAST(horizon AS INT), ${STR(`'horizon ' || CAST(horizon AS VARCHAR) || 'd'`)},`,
      `         CAST(NULL AS INT), CAST(NULL AS INT),`,
    `         ${d.roundN(`${cifSum}`, 5)}, ${NULLN}, ${NULLN}, ${NULLN},`,
    `         CASE WHEN ABS((${cifSum}) - (1.0 - surv_all)) < 1e-9`,
    `              THEN ${STR(`'HOLDS: the causes partition, so the cumulative incidences sum to exactly 1 - S(t). This is not a tolerance check - the sums telescope, and any error in one cause accumulation breaks it'`)}`,
    `              ELSE ${STR(`'BROKEN: the cumulative incidences do not sum to 1 - S(t). Something is wrong with the estimator or the causes are not mutually exclusive - do not report these numbers'`)} END`,
    `  FROM hz`,
  ]);
  parts.push([
    `  SELECT ${STR(`'identity'`)}, ${STR(`'All-cause survival'`)},`,
    `         ${STR(`'horizon'`)}, CAST(horizon AS INT), ${STR(`'horizon ' || CAST(horizon AS VARCHAR) || 'd'`)},`,
      `         CAST(NULL AS INT), CAST(NULL AS INT),`,
    `         ${d.roundN(`1.0 - surv_all`, 5)}, ${NULLN}, ${NULLN}, ${NULLN},`,
    `         ${STR(`'1 - S(t) from the ALL-CAUSE Kaplan-Meier: the quantity the cumulative incidences must sum to'`)}`,
    `  FROM hz`,
  ]);

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY component, cause, at_kind, at_days;`);
  L.push("");
  L.push(`-- REVIEW: the cumulative incidence, the naive estimate it replaces, and the`);
  L.push(`-- difference between them. Check the 'identity' rows first.`);
  L.push(`SELECT * FROM ${out} ORDER BY component, cause, at_kind, at_days;`);

  void ORD_LIFE; void ORD_CIF; void ORD_NAIVE; void ORD_IDENTITY;
  return {
    slug: `cif${suffix}`,
    title: `Competing risks${suffix ? ` (${an.label})` : ""}`,
    subtitle: `Aalen-Johansen cumulative incidence + the naive 1-KM it replaces`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); endpoint "${od.codeListId}".`,
      `Competing causes: ${an.competingEvents.map((c) => `${c.label} ("${c.outcomeDefinition.codeListId}")`).join(", ") || "none"}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasCompetingRisks(ctx: SasCtx, an: CompetingRisksAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_cif${suffix}`);
  const cohT = ctx.finalCohort;
  const od = survivalOutcome(an);
  const lbl = an.label.replace(/"/g, "'");

  if (!od) {
    return {
      path: `sas/${num}_cif${suffix}.sas`, language: "sas", title: `${num} Competing risks (not emitted)`,
      content: [...header(spec, `${num}_cif${suffix}.sas`, [
        `NOT EMITTED: the event of interest is a mortality endpoint, which is refused`,
        `(DSTATUS is in-hospital only, masked from 2016).`,
      ]), ``].join("\n"),
    };
  }

  const causes = causePlan(an);
  const codes = causes.map((c) => c.code);
  const censorS = censorPlan(spec, an.personTimeRule);
  const listSystem = findCodeList(spec, od.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(od, listSystem);
  const limits = competingRisksLimitations(an, listSystem, spec);
  const epiT = ctx.tbl("050_epi");
  const label = (c: { code: number; label: string; isInterest: boolean }) =>
    c.isInterest ? `${c.label} (cause 1)` : `${c.label} (competing, cause ${c.code})`;

  const lines: string[] = [
    ...header(spec, `${num}_cif${suffix}.sas`, [
      `Competing-risks cumulative incidence (Aalen-Johansen) for "${an.label}".`,
      `Kaplan-Meier treats a competing event as CENSORING, which asserts the`,
      `subject who failed from another cause would have gone on to have this one.`,
      `They cannot, so 1 - KM OVERSTATES the risk. Both numbers are computed here`,
      `and their difference reported.`,
      `SAS-PRIMARY: nothing. There is no p-value and no fitted coefficient in this`,
      `analysis, so the SQL twin is complete - unusually for this project.`,
      `Twin of the SQL cif program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("competing_risks", competingRisksParity(an, {
      censorTerms: censorS.applied, dataCut: censorS.dataCut, settingFilter: setting.stamped,
      causes: causes.map((c) => ({ code: c.code, id: c.id, codeListId: c.od.codeListId })),
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...COMPETING_RISKS_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- every cause's events, tagged ---------------------------*/`,
    `/* ONE union, so "the first event of ANY cause" is one MIN over one set.`,
    `   Per-cause firsts combined afterwards is how a subject contributes twice. */`,
    `proc sql;`,
    `  create table work._${num}_ev as`,
  );
  causes.forEach((c, i) => {
    const evT = ctx.evOf(c.od.codeListId);
    const cs = outcomeSettingPlan(c.od, findCodeList(spec, c.od.codeListId)?.system ?? "icd10cm");
    const cond = cs.enforce === "outpatient" ? ` and e.setting = 'OP'` : cs.enforce === "inpatient" ? ` and e.setting = 'IP'` : ``;
    lines.push(
      `${i === 0 ? "  " : "  union all\n  "}select e.enrolid, e.svcdate, ${c.code} as cause`,
      `  from ${evT} as e where 1 = 1${cond}`,
    );
  });
  lines.push(
    `  ;`,
    ``,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join work._${num}_ev as e`,
    `    on e.enrolid = a.enrolid and e.cause = 1`,
    `  where 1 = 1`,
    ...sasWindowConds(an.washout, "e").map((l, i, arr) => `    ${l}${i === arr.length - 1 ? ";" : ""}`),
    ...(sasWindowConds(an.washout, "e").length === 0 ? [`  ;`] : []),
    ``,
    `  create table work._${num}_atrisk as`,
    `  select a.* from ${cohT} as a`,
    `  where a.enrolid not in (select enrolid from work._${num}_prev);`,
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_atrisk`, "at-risk cohort"),
    ``,
    `/*-------------------- first event of ANY cause -------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_fa0 as`,
    `  select a.enrolid, e.svcdate, e.cause`,
    `  from work._${num}_atrisk as a`,
    `  inner join work._${num}_ev as e`,
    `    on e.enrolid = a.enrolid and e.svcdate > a.index_date;`,
    `quit;`,
    ``,
    `/* cause ASC breaks a same-day tie toward the event of interest,`,
    `   DETERMINISTICALLY - some rule is required, and an arbitrary one would make`,
    `   the estimate depend on row order. */`,
    `proc sort data=work._${num}_fa0; by enrolid svcdate cause; run;`,
    ``,
    `data work._${num}_first_any;`,
    `  set work._${num}_fa0;`,
    `  by enrolid;`,
    `  if first.enrolid;`,
    `  rename svcdate = fu_date;`,
    `run;`,
    ``,
    `/*-------------------- the analytic dataset -----------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_s0 as`,
    `  select a.enrolid, a.index_date,`,
    `         ${renderCensorSas(censorS)} as admin_censor format=date9.,`,
    `         f.fu_date, f.cause`,
    `  from work._${num}_atrisk as a`,
    `  inner join ${epiT} as ep`,
    `    on  ep.enrolid = a.enrolid`,
    `    and a.index_date between ep.dtstart and ep.dtend`,
    `  left join work._${num}_first_any as f`,
    `    on f.enrolid = a.enrolid;`,
    `quit;`,
    ``,
    `data work._${num}_subj;`,
    `  set work._${num}_s0;`,
    `  length stratum $40;`,
    `  stratum = 'Overall';`,
    `  t = min(coalesce(fu_date, '31DEC9999'd), admin_censor) - index_date;`,
    `  if fu_date ne . and fu_date <= admin_censor then cause = cause;`,
    `  else cause = 0;`,
    `  keep enrolid stratum t cause;`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "subjects at risk", [`sum(cause > 0) as events_any`]),
    ``,
    ...cifSasSteps({ num, subjT: `work._${num}_subj`, causes: codes }),
    ``,
    ...cifSasVarianceSteps({ num, causes: codes }),
    ``,
    ...(an.emitNaiveComparison ? [...naiveKmSasSteps({ num, subjT: `work._${num}_subj`, causes: codes }), ``] : []),
    ...cifSasHorizonSteps({ num, causes: codes, horizons: an.horizonDays, naive: an.emitNaiveComparison }),
    ``,
    ...cifSasAnchor({ num, subjT: `work._${num}_subj`, cause: 1 }),
    ``,
    `/*-------------------- assemble the result table ------------------------------*/`,
  );

  /* The LIFE TABLE rows, per cause and per event time. Opt-in: these are the
   * most disclosive rows the analysis produces, exactly as in the survival
   * module — most carry a single patient's failure date. */
  if (an.emitLifeTable) {
    lines.push(
      `data work._${num}_lt;`,
      `  set work._${num}_aj;`,
      `  length measure $20 component $12 cause $60 method $300;`,
      `  length at_kind $10 at_label $32;`,
      `  measure = "${MEASURE}"; component = 'life_table'; method = 'aalen_johansen';`,
      `  at_kind = 'event_time'; at_days = t; at_label = 'event time ' || strip(put(t, 8.)) || 'd';`,
      `  ci_low = .; ci_high = .;`,
    );
    for (const c of causes) {
      lines.push(
        `  cause = "${sq(label(c))}"; n_event = d_${c.code};`,
        `  estimate = round(cif_${c.code}, 0.00001); se = .; output;`,
      );
    }
    lines.push(
      `  keep measure component cause at_kind at_days at_label n_risk n_event estimate se ci_low ci_high method;`,
      `run;`,
      ``,
    );
  }

  /* The HORIZON rows: the estimate, the naive number it replaces, the bias,
   * and the partition identity — the same rows, in the same order, as the SQL
   * twin emits. */
  lines.push(
    `data work._${num}_hzrows;`,
    `  set work._${num}_hz;`,
    `  length measure $20 component $12 cause $60 method $300;`,
    `  length at_kind $10 at_label $32;`,
    `  measure = "${MEASURE}"; n_risk = .; n_event = .;`,
    `  at_kind = 'horizon'; at_days = horizon;`,
    `  at_label = 'horizon ' || strip(put(horizon, 8.)) || 'd';`,
  );
  for (const c of causes) {
    const k = c.code;
    lines.push(
      `  component='cif'; cause="${sq(label(c))}";`,
      `  _se = sqrt(max(var_${k}, 0));`,
      `  estimate = round(cif_${k}, 0.00001); se = round(_se, 0.00001);`,
      `  /* clamped to [0,1] and SAID so: the delta-method interval is on the raw`,
      `     scale, so near the boundary it runs outside what a probability can be */`,
      `  ci_low  = round(max(0, cif_${k} - 1.96 * _se), 0.00001);`,
      `  ci_high = round(min(1, cif_${k} + 1.96 * _se), 0.00001);`,
      `  method='aalen_johansen, delta-method Wald interval clamped to [0,1]'; output;`,
    );
    if (an.emitNaiveComparison) {
      lines.push(
        `  se=.; ci_low=.; ci_high=.;`,
        `  component='naive_km'; estimate = round(naive_${k}, 0.00001);`,
        `  method='1 - Kaplan-Meier, competing events treated as CENSORED. This is the number Aalen-Johansen replaces, computed here so the difference is visible'; output;`,
        `  component='bias'; estimate = round(naive_${k} - cif_${k}, 0.00001);`,
        `  if naive_${k} - cif_${k} > 1e-9 then method='OVERSTATEMENT: this is how much 1 - Kaplan-Meier exaggerates the risk of this cause, because it treats the competing events as if those subjects could still have had it';`,
        `  else method='no competing event occurred before this mark, so the two estimators coincide here - which is the DEGENERATE case, not a validation of either';`,
        `  output;`,
      );
    }
  }
  const cifSumS = codes.map((k) => `cif_${k}`).join(" + ");
  if (an.emitNaiveComparison) {
    const naiveSumS = codes.map((k) => `naive_${k}`).join(" + ");
    lines.push(
      `  se=.; ci_low=.; ci_high=.;`,
      `  component='diagnostic'; cause='All causes'; estimate = round(${naiveSumS}, 0.00001);`,
      `  if (${naiveSumS}) > (1 - surv_all) + 1e-9 then`,
      `    method='IMPOSSIBLE AS A SET: the naive per-cause risks sum to MORE than the probability of any event at all. They are mutually exclusive outcomes, so this cannot be a rounding artefact - it is what treating competing events as censoring produces';`,
      `  else method='the naive risks do not exceed the total event probability at this mark';`,
      `  output;`,
    );
  }
  lines.push(
    `  se=.; ci_low=.; ci_high=.;`,
    `  component='identity'; cause='All causes'; estimate = round(${cifSumS}, 0.00001);`,
    `  if abs((${cifSumS}) - (1 - surv_all)) < 1e-9 then`,
    `    method='HOLDS: the causes partition, so the cumulative incidences sum to exactly 1 - S(t). This is not a tolerance check - the sums telescope, and any error in one cause accumulation breaks it';`,
    `  else method='BROKEN: the cumulative incidences do not sum to 1 - S(t). Something is wrong with the estimator or the causes are not mutually exclusive - do not report these numbers';`,
    `  output;`,
    `  component='identity'; cause='All-cause survival'; estimate = round(1 - surv_all, 0.00001);`,
    `  method='1 - S(t) from the ALL-CAUSE Kaplan-Meier: the quantity the cumulative incidences must sum to'; output;`,
    `  keep measure component cause at_kind at_days at_label n_risk n_event estimate se ci_low ci_high method;`,
    `run;`,
    ``,
    `data ${outT};`,
    `  set ${an.emitLifeTable ? `work._${num}_lt work._${num}_hzrows` : `work._${num}_hzrows`};`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT}; by component cause at_kind at_days; run;`,
    ``,
    `title "Competing-risks cumulative incidence: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_cif${suffix}.sas`,
    language: "sas",
    title: `${num} Competing risks${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const competingRisksModule: AnalysisModule<CompetingRisksAnalysis> = {
  analysisKind: "competing_risks",
  stampKind: "competing_risks",
  resultSlug: "cif",
  sql: sqlCompetingRisks,
  sas: sasCompetingRisks,
};
