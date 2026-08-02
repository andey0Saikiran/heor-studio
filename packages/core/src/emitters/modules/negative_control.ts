/**
 * NEGATIVE CONTROL OUTCOMES — interrogating the assumption no data can check.
 *
 * Every observational estimate in this tool rests on one thing the data cannot
 * verify: that the measured covariates captured the confounding. A negative
 * control is the closest available test. Pick an outcome the exposure CANNOT
 * plausibly cause, run it through the IDENTICAL adjustment, and look at what
 * comes out. There is no causal path, so any association is something else —
 * and residual confounding is the most likely something else.
 *
 * THE ASYMMETRY IS THE WHOLE POINT, and it is the part most easily lost:
 *
 *   A NULL control is WEAK reassurance. It says this particular pathway showed
 *   nothing. It cannot say the adjustment worked, because a control is only
 *   sensitive to confounders it happens to share with the primary outcome.
 *
 *   A NON-NULL control is STRONG evidence of residual confounding. Something
 *   produced an association where no causal path exists, and the same something
 *   is in the primary estimate.
 *
 * SAME PIPELINE, NOT AN EASIER ONE. Each control runs through the same
 * saturated closed-form score over the same cells, the same ATE weights and the
 * same Hajek ratio the primary analysis uses. A control estimated crudely, or
 * on a smaller covariate set, tests a different claim — and a null result would
 * then be reassurance about an analysis nobody ran. This analysis declares no
 * estimand, stabilization or trim, so the module fixes them at ATE /
 * unstabilized / no-trim and STAMPS all three: three unstated defaults deciding
 * every control's number is exactly the silence this project exists to remove.
 *
 * THE THRESHOLD IS DECLARED IN ADVANCE. A risk ratio outside [1/t, t] is called
 * residual confounding. It lives in the spec because a threshold chosen after
 * seeing the estimate is not a test, and it is stamped into both twins because
 * it is the only number here that decides an answer.
 *
 * NO CONFIDENCE INTERVAL is reported on a control. The declared threshold IS
 * the test, and an interval invites "not significant, therefore fine" — which
 * on a small control is a statement about power, and is the direction in which
 * a negative-control suite is most often over-trusted.
 *
 * THE RATIONALE IS EMITTED BESIDE EVERY CONTROL. A negative control whose
 * rationale nobody wrote down is an arbitrary outcome; a reader cannot tell the
 * difference, and neither can the analyst who chose it, six months later.
 *
 * Ref: Lipsitch, Tchetgen Tchetgen & Cohen Epidemiology 2010;21:383.
 */
import type { NegativeControlAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, sq, INCLUDE_SETUP } from "../sas-base";
import { psSqlCtes, psSasSteps, hajekSqlCtes, hajekSasSteps } from "../ps-core";
import {
  axisStamp,
  bandOccupancySasSteps,
  bandOccupancySqlCte,
  bandSlots,
  bandingStamp,
  cellAssignSas,
  cellExprSql,
  coarseningNotes,
  cutLit,
  oneArmBandCountSas,
  oneArmBandCountSql,
  resolveCellAxes,
  sasBandedValueStep,
  type CellAxis,
} from "../banding-core";
import {
  outcomeSettingPlan,
  parityStamp,
  negativeControlLimitations,
  negativeControlParity,
  stratLabel,
  NEGATIVE_CONTROL_METHOD_NOTES,
} from "../parity";

const MEASURE = "negative_control";
const ORD_DESIGN = 0;
const ORD_CONTROL = 10;
const ORD_COARSEN = 500;
const ORD_VERDICT = 900;

function plan(ctx: SqlCtx | SasCtx, an: NegativeControlAnalysis) {
  const spec = ctx.spec;
  const gv = spec.groupVars.find((g) => g.id === an.groupVarId);
  const referenceLevel = gv?.referenceLevel ?? gv?.levels[0] ?? "";
  const treatedLevel = gv?.levels.find((l) => l !== referenceLevel) ?? "";
  const cellAxes: CellAxis[] = resolveCellAxes(spec.baseline, an.covariateIds, an.bandings);
  const controls = an.controls.map((c) => {
    const system = findCodeList(spec, c.outcomeDefinition.codeListId)?.system ?? "icd10cm";
    return { ...c, setting: outcomeSettingPlan(c.outcomeDefinition, system) };
  });
  return {
    gv, referenceLevel, treatedLevel, cellAxes,
    slots: bandSlots(cellAxes),
    bandings: bandingStamp(an.bandings, spec.baseline),
    controls,
    comparison: `${treatedLevel} vs ${referenceLevel}`,
    emittable: Boolean(gv && referenceLevel && treatedLevel && cellAxes.length > 0 && controls.length > 0),
  };
}

/** The risk ratio of one control, as a SQL expression over its arms CTE. */
const rrSql = (p: string) => `${p}.mu1 / NULLIF(${p}.mu0, 0)`;
/** Outside [1/t, t] — the DECLARED threshold, spelled the same way in both twins. */
const breachSql = (rr: string, t: number) =>
  `CASE WHEN ${rr} IS NULL THEN 0 WHEN ${rr} < 1.0 / ${t} OR ${rr} > ${t} THEN 1 ELSE 0 END`;

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlNegativeControl(ctx: SqlCtx, an: NegativeControlAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_negctl${suffix}`;
  const p = plan(ctx, an);
  const L: string[] = [];

  L.push(`-- ${parityStamp("negative_control", negativeControlParity(an, {
    referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
    cellAxes: p.cellAxes.map(axisStamp), bandings: p.bandings,
    controls: p.controls.map((c) => ({
      id: c.id, codeListId: c.outcomeDefinition.codeListId,
      settingFilter: c.setting.stamped, rationale: c.rationale,
    })),
  }))}`);
  const limits = negativeControlLimitations(an);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of NEGATIVE_CONTROL_METHOD_NOTES) L.push(`--   * ${note}`);
  const coarse = coarseningNotes(p.cellAxes);
  if (coarse.length > 0) {
    L.push(`-- REVIEW - DECLARED COARSENING (always emitted when a covariate is banded):`);
    for (const note of coarse) L.push(`--   * ${note}`);
  }
  /* THE RATIONALES, in the header as well as in the result table. A reader who
   * only ever sees the generated program still sees the argument for every
   * control it estimates. */
  L.push(`-- NEGATIVE CONTROLS and the argument for each (threshold ${an.biasThreshold}, so [${(1 / an.biasThreshold).toFixed(5)}, ${an.biasThreshold}]):`);
  for (const c of p.controls) L.push(`--   * ${oneLine(c.id)} "${oneLine(c.label)}": ${oneLine(c.rationale)}`);

  if (!p.emittable) {
    L.push(`-- NOT EMITTED: the exposure, the adjustment covariates or the control list did not resolve.`);
    return {
      slug: `negctl${suffix}`, title: `Negative controls${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted", extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`], body: L.join("\n"),
    };
  }

  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `c.index_code`;

  const C: string[] = [];
  C.push(`WITH cohort AS (SELECT enrolid, index_date, index_code FROM ${wp}_cohort),`);
  C.push(`demo AS (   -- enrollment segment in force at (or latest before) index`);
  C.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
  C.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
  C.push(`  FROM cohort c`);
  C.push(`  JOIN ${ctx.t("enrollment_detail")} en ON en.enrolid = c.enrolid AND en.dtstart <= c.index_date`);
  C.push(`),`);
  C.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  p.controls.forEach((c, i) => {
    C.push(`ae${i} AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${q(c.outcomeDefinition.codeListId)}'` +
      (c.setting.enforce ? ` AND setting = '${c.setting.enforce}'` : ``) + `),`);
    C.push(`cs${i} AS (   -- control "${q(c.id)}": first qualifying event in (index, index + ${an.horizonDays}d]`);
    C.push(`  SELECT DISTINCT c.enrolid FROM cohort c JOIN ae${i} a ON a.enrolid = c.enrolid`);
    C.push(`   AND a.event_date > c.index_date AND a.event_date <= ${d.offset("c.index_date", an.horizonDays)}`);
    C.push(`),`);
  });
  /* One subject row carrying the cell and EVERY control's indicator, so all of
   * them are scored by the same score built once — which is what "the same
   * pipeline" has to mean if it is to mean anything. */
  const axisCols = p.slots.length > 0;
  C.push(`subj0 AS (`);
  C.push(`  SELECT c.enrolid,`);
  C.push(`         CASE WHEN ${armExpr} = '${q(p.treatedLevel)}' THEN 1 ELSE 0 END AS treated,`);
  if (axisCols) {
    p.cellAxes.forEach((a, j) => C.push(`         ${cellExprSql(a, ctx)} AS ax${j},`));
  } else {
    C.push(`         ${p.cellAxes.map((a) => cellExprSql(a, ctx)).join(` || '|' || `)} AS cell,`);
  }
  p.controls.forEach((_c, i) =>
    C.push(`         CASE WHEN k${i}.enrolid IS NOT NULL THEN 1.0 ELSE 0.0 END AS y${i}${i === p.controls.length - 1 ? `` : `,`}`));
  C.push(`  FROM cohort c`);
  C.push(`  LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid`);
  p.controls.forEach((_c, i) => C.push(`  LEFT JOIN cs${i} k${i} ON k${i}.enrolid = c.enrolid`));
  if (viaNdc) {
    C.push(`  JOIN ${wp}_ndc_lookup nl`);
    C.push(`    ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = c.index_code`);
  }
  C.push(`  WHERE ${armExpr} IN ('${q(p.referenceLevel)}', '${q(p.treatedLevel)}')`);
  C.push(`),`);
  C.push(`subj AS (   -- THE CELL, in a FIXED axis order the parity stamp records`);
  C.push(`  SELECT s.*${axisCols ? `, ${p.cellAxes.map((_a, j) => `ax${j}`).join(` || '|' || `)} AS cell` : ``} FROM subj0 s`);
  C.push(`),`);
  /* ATE weights, unstabilized, no trim - the fixed choices the stamp records. */
  C.push(...psSqlCtes({ subjectsCte: "subj", estimand: "ate", stabilized: false, trim: 0 }));
  C.push(`support AS (`);
  C.push(`  SELECT SUM(CASE WHEN n_control_cell = 0 OR n_treated_cell = 0 THEN n_cell ELSE 0 END) AS off_support,`);
  C.push(`         COUNT(*) AS n_cells, SUM(n_cell) AS n_total,`);
  C.push(`         SUM(n_treated_cell) AS n_treated, SUM(n_control_cell) AS n_control`);
  C.push(`  FROM pscell`);
  C.push(`),`);
  p.controls.forEach((_c, i) => {
    C.push(...hajekSqlCtes({ subjectsCte: "psk", outcomeCol: `y${i}`, prefix: `k${i}` }));
  });
  /* How many controls breached, counted once so the verdict row is a number
   * rather than something a reader has to tally by eye. */
  C.push(`verdict AS (`);
  C.push(`  SELECT ${p.controls.map((_c, i) => breachSql(rrSql(`v${i}`), an.biasThreshold)).join(`\n         + `)} AS n_breach,`);
  C.push(`         ${p.controls.length} AS n_controls`);
  C.push(`  FROM ${p.controls.map((_c, i) => `k${i}arms v${i}`).join(` CROSS JOIN `)}`);
  C.push(`)${p.slots.length > 0 ? `,` : ``}`);
  if (p.slots.length > 0) {
    C.push(...bandOccupancySqlCte({ from: "psk", slots: p.slots, alias: "bocc" }));
    C[C.length - 1] = C[C.length - 1].replace(/,\s*$/, "");
  }

  const NULLN = `CAST(NULL AS NUMERIC)`;
  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;

  L.push(d.createTableAs(out));
  L.push(...C);
  L.push(`SELECT '${MEASURE}' AS measure, component, term, statistic, ord, estimate, method`);
  L.push(`FROM (`);
  const parts: string[][] = [];
  const row = (component: string, term: string, statistic: string, ord: number, est: string, method: string, from: string) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${q(term)}'`)} AS term,`,
    `         ${STR(`'${statistic}'`)} AS statistic, ${INT(String(ord))} AS ord,`,
    `         ${est} AS estimate, ${STR(method)} AS method`,
    `  FROM ${from}`,
  ];
  const cmp = p.comparison;

  parts.push(row("design", cmp, "n_treated", ORD_DESIGN, `CAST(n_treated AS NUMERIC)`, `'observed'`, "support"));
  parts.push(row("design", cmp, "n_control", ORD_DESIGN + 1, `CAST(n_control AS NUMERIC)`, `'observed'`, "support"));
  parts.push(row("design", cmp, "n_cells", ORD_DESIGN + 2, `CAST(n_cells AS NUMERIC)`,
    `'covariate cells. Every control below is adjusted on THIS score - the same saturated closed form, the same cells, the same ATE weights the primary analysis uses. A control run through an easier pipeline would be testing a different claim'`, "support"));
  parts.push(row("design", cmp, "subjects_off_support", ORD_DESIGN + 3, `CAST(off_support AS NUMERIC)`,
    `CASE WHEN off_support > 0` +
    ` THEN 'subjects in cells that are entirely one arm. They have no counterpart at ANY weight, so every control ratio below describes a population that does not exist - exactly as it would in the primary analysis, which is the point of using the same pipeline'` +
    ` ELSE 'every covariate cell contains both arms' END`, "support"));
  /* THE DECLARED THRESHOLD, emitted as a number so it cannot be read off a
   * sentence and mis-transcribed. */
  parts.push(row("design", cmp, "bias_threshold", ORD_DESIGN + 4, `CAST(${an.biasThreshold} AS NUMERIC)`,
    `'DECLARED IN ADVANCE. A control risk ratio outside [1/${an.biasThreshold}, ${an.biasThreshold}] is called residual confounding. A threshold chosen after seeing the estimate is not a test, which is why this one is a spec field and is stamped into both twins'`, "support"));

  p.controls.forEach((c, i) => {
    const base = ORD_CONTROL + i * 10;
    const a = `k${i}arms`;
    const rr = rrSql(a);
    parts.push(row("control", c.id, "events_treated", base, `CAST(${a}.e1 AS NUMERIC)`,
      `'${q(oneLine(c.label))} - observed, unweighted'`, a));
    parts.push(row("control", c.id, "events_control", base + 1, `CAST(${a}.e0 AS NUMERIC)`,
      `'observed, unweighted'`, a));
    parts.push(row("control", c.id, "weighted_risk_treated", base + 2, d.roundN(`${a}.mu1`, 5),
      `'Hajek ratio SUM(wY)/SUM(w) on the ATE-weighted pseudo-population'`, a));
    parts.push(row("control", c.id, "weighted_risk_control", base + 3, d.roundN(`${a}.mu0`, 5),
      `'Hajek ratio'`, a));
    parts.push(row("control", c.id, "adjusted_risk_ratio", base + 4, d.roundN(rr, 5),
      `'the adjusted association with an outcome the exposure CANNOT cause. NO confidence interval is reported: the DECLARED threshold is the test, and an interval here invites reading low power as reassurance'`, a));
    parts.push(row("control", c.id, "breaches_threshold", base + 5, `CAST(${breachSql(rr, an.biasThreshold)} AS NUMERIC)`,
      `CASE WHEN ${breachSql(rr, an.biasThreshold)} = 1` +
      ` THEN 'BREACH. This ratio is outside the declared [1/${an.biasThreshold}, ${an.biasThreshold}]. There is no causal path from the exposure to this outcome, so an association of this size is evidence of RESIDUAL CONFOUNDING in the adjustment the primary estimate also uses. It does not say which way the primary estimate is biased, or by how much'` +
      ` ELSE 'within the declared threshold. WEAK reassurance only: it says this pathway showed nothing, not that the adjustment worked - a control is only sensitive to confounders it shares with the primary outcome' END`, a));
    /* THE RATIONALE, beside the number. Estimate NULL because it is not a
     * measurement: a control without a written argument is an arbitrary
     * outcome, and nothing else in this table can tell the difference. */
    parts.push(row("control", c.id, "rationale", base + 6, NULLN,
      `'WHY THE EXPOSURE CANNOT CAUSE THIS: ${q(oneLine(c.rationale))}'`, a));
  });

  if (p.slots.length > 0) {
    const bandedAxes = p.cellAxes.filter((x) => x.kind === "banded");
    parts.push(row("coarsening", cmp, "bands_declared", ORD_COARSEN, `CAST(${p.slots.length} AS NUMERIC)`,
      `'${q(bandedAxes.map((x) => `${stratLabel(x.label)} cut at ${(x.cutPoints ?? []).map(cutLit).join("/")}`).join("; "))}. CONFOUNDING WITHIN A BAND IS UNCONTROLLED, and a WIDER band controls LESS - the controls below inherit exactly that residual confounding, which is the point of running them through the same pipeline'`, "bocc"));
    p.slots.forEach((s) => {
      parts.push(row("coarsening", s.label, `band_${s.ord}_treated`, ORD_COARSEN + s.ord * 2 - 1,
        `CAST(b${s.ord}_t AS NUMERIC)`, `'treated subjects in band ${q(s.label)} of ${q(stratLabel(s.covariateLabel))}'`, "bocc"));
      parts.push(row("coarsening", s.label, `band_${s.ord}_control`, ORD_COARSEN + s.ord * 2,
        `CAST(b${s.ord}_c AS NUMERIC)`,
        `CASE WHEN (b${s.ord}_t + b${s.ord}_c) > 0 AND (b${s.ord}_t = 0 OR b${s.ord}_c = 0)` +
        ` THEN 'THIS BAND HOLDS ONE ARM ONLY - a positivity violation a balance table will not show'` +
        ` ELSE 'both arms occupy this band' END`, "bocc"));
    });
    parts.push(row("coarsening", cmp, "bands_with_one_arm", ORD_COARSEN + p.slots.length * 2 + 1,
      `CAST(${oneArmBandCountSql(p.slots)} AS NUMERIC)`,
      `CASE WHEN (${oneArmBandCountSql(p.slots)}) > 0 THEN 'BANDS WITH NO COUNTERPART' ELSE 'every non-empty band holds both arms' END`, "bocc"));
  }

  parts.push(row("verdict", cmp, "controls_tested", ORD_VERDICT, `CAST(n_controls AS NUMERIC)`,
    `'negative control outcomes, each with a written rationale above'`, "verdict"));
  parts.push(row("verdict", cmp, "controls_breaching", ORD_VERDICT + 1, `CAST(n_breach AS NUMERIC)`,
    `CASE WHEN n_breach > 0` +
    ` THEN 'RESIDUAL CONFOUNDING IS EVIDENCED. At least one outcome the exposure cannot cause is associated with it after the same adjustment the primary estimate uses. Report this beside the primary estimate; it is not a reason to adjust the threshold'` +
    ` ELSE 'no control breached. That is WEAK reassurance and not a clean bill of health: controls are only sensitive to confounders they share with the primary outcome, and with several controls at a fixed threshold none breaching is also what low power looks like' END`, "verdict"));

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: a BREACH is strong evidence of residual confounding; a pass is weak`);
  L.push(`-- reassurance. Read every rationale row before reading any ratio.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `negctl${suffix}`,
    title: `Negative controls${suffix ? ` (${an.label})` : ""}`,
    subtitle: `${p.controls.length} control outcome(s) through the SAME adjustment, against a declared threshold of ${an.biasThreshold}`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); horizon ${an.horizonDays}d.`,
      `Treated ${p.treatedLevel} vs reference ${p.referenceLevel}; adjustment cells: ${p.cellAxes.map((c) => c.label).join(" x ")}.`,
      `Breach interval: outside [1/${an.biasThreshold}, ${an.biasThreshold}], declared in advance.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasNegativeControl(ctx: SasCtx, an: NegativeControlAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_negctl${suffix}`);
  const cohT = ctx.finalCohort;
  const p = plan(ctx, an);
  const lbl = an.label.replace(/"/g, "'");
  const limits = negativeControlLimitations(an);

  const lines: string[] = [
    ...header(spec, `${num}_negctl${suffix}.sas`, [
      `Negative control outcomes for "${an.label}".`,
      `Each control is an outcome the exposure CANNOT plausibly cause, run through`,
      `the IDENTICAL adjustment the primary analysis uses - the same saturated`,
      `score over the same cells, the same ATE weights, the same Hajek ratio.`,
      `A NULL result is WEAK reassurance. A BREACH of the declared threshold is`,
      `STRONG evidence of residual confounding, because something produced an`,
      `association where no causal path exists.`,
      `SAS-PRIMARY: nothing.`,
      `Twin of the SQL negctl program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("negative_control", negativeControlParity(an, {
      referenceLevel: p.referenceLevel, treatedLevel: p.treatedLevel,
      cellAxes: p.cellAxes.map(axisStamp), bandings: p.bandings,
      controls: p.controls.map((c) => ({
        id: c.id, codeListId: c.outcomeDefinition.codeListId,
        settingFilter: c.setting.stamped, rationale: c.rationale,
      })),
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...NEGATIVE_CONTROL_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
  );
  const coarseSas = coarseningNotes(p.cellAxes);
  if (coarseSas.length > 0) {
    lines.push(`/* REVIEW - DECLARED COARSENING (always emitted when a covariate is banded):`, ...coarseSas.map((n) => `   * ${cmt(n)}`), `*/`);
  }
  lines.push(
    `/* NEGATIVE CONTROLS and the argument for each (threshold ${an.biasThreshold}):`,
    ...p.controls.map((c) => `   * ${cmt(c.id)} "${cmt(c.label)}": ${cmt(c.rationale)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
  );
  if (!p.emittable) {
    lines.push(`/* NOT EMITTED: the exposure, the adjustment covariates or the control list did not resolve. */`, ``);
    return { path: `sas/${num}_negctl${suffix}.sas`, language: "sas", title: `${num} Negative controls (not emitted)`, content: lines.join("\n") };
  }

  const enrT = ctx.tbl("040_enroll");
  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const cmp = sq(p.comparison);
  const axisCols = p.slots.length > 0;

  lines.push(
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- one row per member, with every control's indicator ------*/`,
    `proc sql;`,
  );
  p.controls.forEach((c, i) => {
    const evT = ctx.evOf(c.outcomeDefinition.codeListId);
    const cond = c.setting.enforce === "outpatient" ? `and e.setting = 'OP'` : c.setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
    lines.push(
      `  /* control "${cmt(c.id)}" */`,
      `  create table work._${num}_cs${i} as`,
      `  select distinct a.enrolid`,
      `  from ${cohT} as a`,
      `  inner join ${evT} as e`,
      `    on  e.enrolid = a.enrolid`,
      `    and e.svcdate > a.index_date`,
      `    and e.svcdate <= a.index_date + ${an.horizonDays}`,
      ...(cond ? [`    ${cond}`] : []),
      `  ;`,
      ``,
    );
  });
  lines.push(
    `  create table work._${num}_s0 as`,
    `  select a.enrolid, a.index_date,`,
    ...(viaNdcS ? [`         n.pattern as arm length=40,`] : [`         a.index_code as arm length=40,`]),
    `         b.dobyr, b.sex, b.region, b.plantyp,`,
    `         b.dtstart as seg_start, b.dtend as seg_end,`,
    ...p.controls.map((_c, i) => `         case when k${i}.enrolid is not null then 1 else 0 end as y${i},`),
    `         1 as _keep`,
    `  from ${cohT} as a`,
    ...(viaNdcS ? [`  left join ${ndcT} as n on n.ndcnum = a.index_code`] : []),
    ...p.controls.map((_c, i) => `  left join work._${num}_cs${i} as k${i} on k${i}.enrolid = a.enrolid`),
    `  left join ${enrT} as b`,
    `    on  b.enrolid = a.enrolid`,
    `    and b.dtstart <= a.index_date;`,
    `quit;`,
    ``,
    `proc sort data=work._${num}_s0;`,
    `  by enrolid descending seg_start descending seg_end;`,
    `run;`,
    ``,
    `data work._${num}_subj;`,
    `  set work._${num}_s0;`,
    `  by enrolid;`,
    `  if first.enrolid;`,
    `  length cell $200 ${p.cellAxes.map((_a, j) => `_c${j}`).join(" ")} $40;`,
    ...(axisCols ? [`  length ${p.cellAxes.map((_a, j) => `ax${j}`).join(" ")} $40;`] : []),
    `  treated = (arm = "${sq(p.treatedLevel)}");`,
    ...(axisCols ? sasBandedValueStep().map((l) => `  ${l}`) : []),
    ...p.cellAxes.flatMap((a, j) => [
      `  /* cell axis: ${cmt(a.label)} (${a.kind}) */`,
      ...cellAssignSas(a, `_c${j}`).map((l) => `  ${l}`),
    ]),
    `  cell = ${p.cellAxes.map((_a, j) => `strip(_c${j})`).join(` || '|' || `)};`,
    ...(axisCols ? p.cellAxes.map((_a, j) => `  ax${j} = _c${j};`) : []),
    `  if arm not in ("${sq(p.referenceLevel)}", "${sq(p.treatedLevel)}") then delete;`,
    `  keep enrolid treated cell ${p.controls.map((_c, i) => `y${i}`).join(" ")}${axisCols ? ` ${p.cellAxes.map((_a, j) => `ax${j}`).join(" ")}` : ""};`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_subj`, "cohort members scored", [`sum(treated) as treated`]),
    ``,
    /* ATE weights, unstabilized, no trim - the fixed choices the stamp records. */
    ...psSasSteps({ num, subjT: `work._${num}_subj`, estimand: "ate", stabilized: false, trim: 0 }),
    ``,
  );
  p.controls.forEach((_c, i) => {
    lines.push(...hajekSasSteps({ num: `${num}_k${i}`, subjT: `work._${num}_psk`, outcomeCol: `y${i}` }), ``);
  });
  if (p.slots.length > 0) lines.push(...bandOccupancySasSteps({ num, from: `work._${num}_psk`, slots: p.slots }));

  lines.push(
    `proc sql;`,
    `  create table work._${num}_support as`,
    `  select sum(case when n_control_cell = 0 or n_treated_cell = 0 then n_cell else 0 end) as off_support,`,
    `         count(*) as n_cells, sum(n_cell) as n_total,`,
    `         sum(n_treated_cell) as n_treated, sum(n_control_cell) as n_control`,
    `  from work._${num}_pscell;`,
    `quit;`,
    ``,
    `/*-------------------- design rows --------------------------------------------*/`,
    `data work._${num}_dsg;`,
    `  length measure $20 component $12 term $60 statistic $32 method $700;`,
    `  set work._${num}_support;`,
    `  measure = "${MEASURE}"; component = 'design'; term = "${cmp}";`,
    `  statistic='n_treated'; ord=${ORD_DESIGN}; estimate=n_treated; method='observed'; output;`,
    `  statistic='n_control'; ord=${ORD_DESIGN + 1}; estimate=n_control; output;`,
    `  statistic='n_cells'; ord=${ORD_DESIGN + 2}; estimate=n_cells;`,
    `  method='covariate cells. Every control below is adjusted on THIS score - the same saturated closed form, the same cells, the same ATE weights the primary analysis uses. A control run through an easier pipeline would be testing a different claim'; output;`,
    `  statistic='subjects_off_support'; ord=${ORD_DESIGN + 3}; estimate=off_support;`,
    `  if off_support > 0 then method='subjects in cells that are entirely one arm. They have no counterpart at ANY weight, so every control ratio below describes a population that does not exist - exactly as it would in the primary analysis, which is the point of using the same pipeline';`,
    `  else method='every covariate cell contains both arms'; output;`,
    `  statistic='bias_threshold'; ord=${ORD_DESIGN + 4}; estimate=${an.biasThreshold};`,
    `  method='DECLARED IN ADVANCE. A control risk ratio outside [1/${an.biasThreshold}, ${an.biasThreshold}] is called residual confounding. A threshold chosen after seeing the estimate is not a test, which is why this one is a spec field and is stamped into both twins'; output;`,
    `  keep measure component term statistic ord estimate method;`,
    `run;`,
    ``,
  );

  p.controls.forEach((c, i) => {
    const base = ORD_CONTROL + i * 10;
    lines.push(
      `/*-------------------- control "${cmt(c.id)}" ---------------------------------*/`,
      `data work._${num}_r${i};`,
      `  length measure $20 component $12 term $60 statistic $32 method $700;`,
      `  set work._${num}_k${i}_arms;`,
      `  measure = "${MEASURE}"; component = 'control'; term = "${sq(c.id)}";`,
      `  if mu0 > 0 then _rr = mu1 / mu0; else _rr = .;`,
      `  _breach = (_rr ne . and (_rr < 1 / ${an.biasThreshold} or _rr > ${an.biasThreshold}));`,
      `  statistic='events_treated'; ord=${base}; estimate=e1;`,
      `  method='${sq(oneLine(c.label))} - observed, unweighted'; output;`,
      `  statistic='events_control'; ord=${base + 1}; estimate=e0; method='observed, unweighted'; output;`,
      `  statistic='weighted_risk_treated'; ord=${base + 2}; estimate=round(mu1, 0.00001);`,
      `  method='Hajek ratio SUM(wY)/SUM(w) on the ATE-weighted pseudo-population'; output;`,
      `  statistic='weighted_risk_control'; ord=${base + 3}; estimate=round(mu0, 0.00001); method='Hajek ratio'; output;`,
      `  statistic='adjusted_risk_ratio'; ord=${base + 4}; estimate=round(_rr, 0.00001);`,
      `  method='the adjusted association with an outcome the exposure CANNOT cause. NO confidence interval is reported: the DECLARED threshold is the test, and an interval here invites reading low power as reassurance'; output;`,
      `  statistic='breaches_threshold'; ord=${base + 5}; estimate=_breach;`,
      `  if _breach then method='BREACH. This ratio is outside the declared [1/${an.biasThreshold}, ${an.biasThreshold}]. There is no causal path from the exposure to this outcome, so an association of this size is evidence of RESIDUAL CONFOUNDING in the adjustment the primary estimate also uses. It does not say which way the primary estimate is biased, or by how much';`,
      `  else method='within the declared threshold. WEAK reassurance only: it says this pathway showed nothing, not that the adjustment worked - a control is only sensitive to confounders it shares with the primary outcome'; output;`,
      `  statistic='rationale'; ord=${base + 6}; estimate=.;`,
      `  method='WHY THE EXPOSURE CANNOT CAUSE THIS: ${sq(oneLine(c.rationale))}'; output;`,
      `  keep measure component term statistic ord estimate method;`,
      `run;`,
      ``,
    );
  });

  const extraSets: string[] = [`work._${num}_dsg`, ...p.controls.map((_c, i) => `work._${num}_r${i}`)];

  if (p.slots.length > 0) {
    const bandedAxes = p.cellAxes.filter((x) => x.kind === "banded");
    lines.push(
      `data work._${num}_co;`,
      `  length measure $20 component $12 term $60 statistic $32 method $700;`,
      `  set work._${num}_bocc;`,
      `  measure = "${MEASURE}"; component = 'coarsening';`,
      `  term = "${cmp}"; statistic='bands_declared'; ord=${ORD_COARSEN}; estimate=${p.slots.length};`,
      `  method='${sq(bandedAxes.map((x) => `${stratLabel(x.label)} cut at ${(x.cutPoints ?? []).map(cutLit).join("/")}`).join("; "))}. CONFOUNDING WITHIN A BAND IS UNCONTROLLED, and a WIDER band controls LESS - the controls below inherit exactly that residual confounding, which is the point of running them through the same pipeline'; output;`,
      ...p.slots.flatMap((s) => [
        `  term = "${sq(s.label)}"; statistic='band_${s.ord}_treated'; ord=${ORD_COARSEN + s.ord * 2 - 1}; estimate=b${s.ord}_t;`,
        `  method='treated subjects in band ${sq(s.label)} of ${sq(stratLabel(s.covariateLabel))}'; output;`,
        `  statistic='band_${s.ord}_control'; ord=${ORD_COARSEN + s.ord * 2}; estimate=b${s.ord}_c;`,
        `  if (b${s.ord}_t + b${s.ord}_c) > 0 and (b${s.ord}_t = 0 or b${s.ord}_c = 0) then method='THIS BAND HOLDS ONE ARM ONLY - a positivity violation a balance table will not show';`,
        `  else method='both arms occupy this band'; output;`,
      ]),
      `  term = "${cmp}"; statistic='bands_with_one_arm'; ord=${ORD_COARSEN + p.slots.length * 2 + 1};`,
      `  estimate = ${oneArmBandCountSas(p.slots)};`,
      `  if estimate > 0 then method='BANDS WITH NO COUNTERPART';`,
      `  else method='every non-empty band holds both arms'; output;`,
      `  keep measure component term statistic ord estimate method;`,
      `run;`,
      ``,
    );
    extraSets.push(`work._${num}_co`);
  }

  lines.push(
    `/*-------------------- the verdict over the whole suite -----------------------*/`,
    `proc sql;`,
    `  create table work._${num}_vd as`,
    `  select ${p.controls.map((_c, i) => `(v${i}.mu0 > 0 and (v${i}.mu1 / v${i}.mu0 < 1 / ${an.biasThreshold} or v${i}.mu1 / v${i}.mu0 > ${an.biasThreshold}))`).join(`\n       + `)} as n_breach,`,
    `         ${p.controls.length} as n_controls`,
    `  from ${p.controls.map((_c, i) => `work._${num}_k${i}_arms as v${i}`).join(", ")};`,
    `quit;`,
    ``,
    `data work._${num}_vr;`,
    `  length measure $20 component $12 term $60 statistic $32 method $700;`,
    `  set work._${num}_vd;`,
    `  measure = "${MEASURE}"; component = 'verdict'; term = "${cmp}";`,
    `  statistic='controls_tested'; ord=${ORD_VERDICT}; estimate=n_controls;`,
    `  method='negative control outcomes, each with a written rationale above'; output;`,
    `  statistic='controls_breaching'; ord=${ORD_VERDICT + 1}; estimate=n_breach;`,
    `  if n_breach > 0 then method='RESIDUAL CONFOUNDING IS EVIDENCED. At least one outcome the exposure cannot cause is associated with it after the same adjustment the primary estimate uses. Report this beside the primary estimate; it is not a reason to adjust the threshold';`,
    `  else method='no control breached. That is WEAK reassurance and not a clean bill of health: controls are only sensitive to confounders they share with the primary outcome, and with several controls at a fixed threshold none breaching is also what low power looks like'; output;`,
    `  keep measure component term statistic ord estimate method;`,
    `run;`,
    ``,
    `data ${outT};`,
    `  set ${[...extraSets, `work._${num}_vr`].join(" ")};`,
    `run;`,
    ``,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Negative control outcomes: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_negctl${suffix}.sas`,
    language: "sas",
    title: `${num} Negative controls${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const negativeControlModule: AnalysisModule<NegativeControlAnalysis> = {
  analysisKind: "negative_control",
  stampKind: "negative_control",
  resultSlug: "negctl",
  sql: sqlNegativeControl,
  sas: sasNegativeControl,
};
