/**
 * Treatment switching, add-on therapy, and line of therapy.
 *
 * THE WHOLE MODULE TURNS ON ONE QUESTION: when a patient on drug A is dispensed
 * drug B, did they STOP A or KEEP TAKING IT?
 *
 *   - Stopped A, started B  -> a SWITCH.
 *   - Kept A, added B       -> COMBINATION therapy.
 *
 * Claims cannot distinguish those without a rule, because a pharmacy file
 * records dispensings and not intent. The only signal available is whether A's
 * supply was still running when B began, and by how much. A day or two of
 * overlap is a refill boundary; three months of overlap is combination therapy.
 * Where the line falls is a study decision.
 *
 * So `permissibleOverlapDays` is explicit, and the module reports HOW MANY
 * PATIENTS THE THRESHOLD RECLASSIFIES. That count is the same device the
 * adherence module uses for stockpiling: the honest measure of how much a
 * conclusion rests on an assumption rather than on data. A study that reports
 * "38% switched" without it has reported one arbitrary point on a curve.
 *
 * LINE OF THERAPY IS DEFINITIONAL, AND THAT IS DIFFERENT IN KIND.
 *
 * Every other number in this project can be checked against arithmetic: a PDC
 * either counts the right days or it does not, and Gold Case F says which. A
 * line number cannot be checked that way. Real protocols advance a line on a
 * switch, or on an add-on, or after a gap of N days, or only within a drug
 * class, or on documented clinical intent that claims never record. The same
 * patient legitimately carries a different line number under each rule.
 *
 * Execution can therefore prove that the SAS and SQL twins implement the SAME
 * rule. It can NEVER prove the rule matches a given protocol. Both twins say so
 * in the emitted output, beside the number, because a line-of-therapy column
 * that travels without its definition is the most quietly wrong thing this
 * module can produce.
 *
 * Verified vs Gold Case G, executed by verify/run.ts.
 */
import type { TreatmentSwitchingAnalysis } from "../../spec/types";
import { daysSupplyCleaningFor } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, INCLUDE_SETUP } from "../sas-base";
import { cleaningKeepClause } from "../interval-core";
import {
  parityStamp,
  switchingLimitations,
  switchingParity,
  SWITCHING_METHOD_NOTES,
} from "../parity";

const MEASURE = "treatment_switching";
const ORD_DESIGN = 0;
const ORD_SWITCH = 10;
const ORD_RULE = 20;
const ORD_LINE = 30;

function bounds(an: TreatmentSwitchingAnalysis): { w0: number; w1: number; len: number } {
  const w0 = typeof an.window.start === "number" ? an.window.start : 0;
  const w1 = typeof an.window.end === "number" ? an.window.end : 364;
  return { w0, w1, len: w1 - w0 + 1 };
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlSwitching(ctx: SqlCtx, an: TreatmentSwitchingAnalysis, suffix: string): SqlModuleFile {
  const { d, wp } = ctx;
  const out = `${wp}_switch${suffix}`;
  const { w0, w1, len } = bounds(an);
  const clean = daysSupplyCleaningFor(an);
  const keep = cleaningKeepClause(clean, "days_supply", "sql");
  const toList = an.toCodeListIds.map((id) => `'${q(id)}'`).join(", ");
  const L: string[] = [];

  L.push(`-- ${parityStamp("treatment_switching", switchingParity(an, { windowStart: w0, windowEnd: w1, windowDays: len }))}`);
  const limits = switchingLimitations(an);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of SWITCHING_METHOD_NOTES) L.push(`--   * ${note}`);

  const C: string[] = [];
  C.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${ctx.cohortT}),`);
  /* THE FROM-DRUG's coverage. Only its LAST covered day matters here, so the
   * full island merge is unnecessary: the maximum of (start + supply - 1) over
   * all its fills IS the last covered day, whatever the overlap structure. */
  C.push(`from_fills AS (`);
  C.push(`  SELECT c.enrolid,`);
  C.push(`         ${d.daysBetween("f.fill_date", "c.index_date")} AS d_start,`);
  C.push(`         ${d.daysBetween("f.fill_date", "c.index_date")} + f.days_supply - 1 AS d_end`);
  C.push(`  FROM cohort c`);
  C.push(`  JOIN ${wp}_fills f ON f.enrolid = c.enrolid AND f.code_list_id = '${q(an.fromCodeListId)}'`);
  C.push(`  WHERE ${keep}`);
  C.push(`),`);
  C.push(`from_cov AS (   -- last day the index drug's supply reaches, inside the window`);
  C.push(`  SELECT enrolid, MAX(LEAST(d_end, ${w1})) AS from_last_day`);
  C.push(`  FROM from_fills WHERE d_end >= ${w0} AND d_start <= ${w1}`);
  C.push(`  GROUP BY enrolid`);
  C.push(`),`);
  /* THE TO-DRUGS. Per (patient, drug), the first dispensing strictly AFTER the
   * index date. A to-drug dispensed ON day 0 is not a switch: it is the
   * patient's starting regimen, and counting it as one would report a switch
   * for every combination initiator on their first day. */
  C.push(`to_fills AS (`);
  C.push(`  SELECT c.enrolid, f.code_list_id,`);
  C.push(`         ${d.daysBetween("f.fill_date", "c.index_date")} AS d_start`);
  C.push(`  FROM cohort c`);
  C.push(`  JOIN ${wp}_fills f ON f.enrolid = c.enrolid AND f.code_list_id IN (${toList})`);
  C.push(`  WHERE ${keep}`);
  C.push(`),`);
  C.push(`to_first AS (`);
  C.push(`  SELECT enrolid, code_list_id, MIN(d_start) AS to_day`);
  C.push(`  FROM to_fills WHERE d_start > 0 AND d_start >= ${w0} AND d_start <= ${w1}`);
  C.push(`  GROUP BY enrolid, code_list_id`);
  C.push(`),`);
  C.push(`first_to AS (   -- the EARLIEST to-drug, one row per patient`);
  C.push(`  SELECT enrolid, MIN(to_day) AS to_day FROM to_first GROUP BY enrolid`);
  C.push(`),`);
  /* THE CLASSIFICATION. overlap_days = how much of the index drug's supply is
   * still unconsumed on the day the new drug starts. */
  C.push(`pt AS (`);
  C.push(`  SELECT c.enrolid, t.to_day, fc.from_last_day,`);
  C.push(`         CASE WHEN t.to_day IS NULL THEN NULL`);
  C.push(`              ELSE GREATEST(COALESCE(fc.from_last_day, t.to_day - 1) - t.to_day + 1, 0) END AS overlap_days`);
  C.push(`  FROM cohort c`);
  C.push(`  LEFT JOIN first_to t ON t.enrolid = c.enrolid`);
  C.push(`  LEFT JOIN from_cov fc ON fc.enrolid = c.enrolid`);
  C.push(`),`);
  C.push(`pt2 AS (`);
  C.push(`  SELECT enrolid, to_day, overlap_days,`);
  C.push(`         CASE WHEN to_day IS NULL THEN 0 ELSE 1 END AS started_new_drug,`);
  C.push(`         CASE WHEN to_day IS NOT NULL AND overlap_days <= ${an.permissibleOverlapDays}`);
  C.push(`              THEN 1 ELSE 0 END AS switched,`);
  C.push(`         CASE WHEN to_day IS NOT NULL AND overlap_days > ${an.permissibleOverlapDays}`);
  C.push(`              THEN 1 ELSE 0 END AS add_on,`);
  /* THE SENSITIVITY. Same events under a zero-overlap rule (ANY remaining
   * supply means combination) and under an unbounded one (any new drug is a
   * switch). The gap between them is the whole discretion in the definition. */
  C.push(`         CASE WHEN to_day IS NOT NULL AND overlap_days <= 0 THEN 1 ELSE 0 END AS switched_strict,`);
  C.push(`         CASE WHEN to_day IS NULL THEN 0 ELSE 1 END AS switched_loose,`);
  /* LINE OF THERAPY under the declared rule: line 1 from index, line 2 from the
   * switch. Reported with its definition attached. */
  C.push(`         CASE WHEN to_day IS NOT NULL AND overlap_days <= ${an.permissibleOverlapDays}`);
  C.push(`              THEN 2 ELSE 1 END AS lines_reached`);
  C.push(`  FROM pt`);
  C.push(`),`);
  C.push(`agg AS (`);
  C.push(`  SELECT COUNT(*) AS n,`);
  C.push(`         SUM(started_new_drug) AS n_started_new,`);
  C.push(`         SUM(switched) AS n_switched,`);
  C.push(`         SUM(add_on) AS n_add_on,`);
  C.push(`         SUM(switched_strict) AS n_switched_strict,`);
  C.push(`         SUM(switched_loose) AS n_switched_loose,`);
  C.push(`         AVG(CASE WHEN switched = 1 THEN to_day * 1.0 END) AS mean_days_to_switch,`);
  C.push(`         MIN(CASE WHEN switched = 1 THEN to_day END) AS min_days_to_switch,`);
  C.push(`         SUM(CASE WHEN lines_reached = 2 THEN 1 ELSE 0 END) AS n_line2,`);
  C.push(`         AVG(lines_reached * 1.0) AS mean_lines`);
  C.push(`  FROM pt2`);
  C.push(`)`);

  const STR = (e: string) => `CAST(${e} AS VARCHAR)`;
  const INT = (e: string) => `CAST(${e} AS INT)`;

  L.push(d.createTableAs(out));
  L.push(...C);
  L.push(`SELECT '${MEASURE}' AS measure, component, statistic, ord, estimate, method`);
  L.push(`FROM (`);
  const parts: string[][] = [];
  const row = (component: string, statistic: string, ord: number, est: string, method: string) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${statistic}'`)} AS statistic,`,
    `         ${INT(String(ord))} AS ord, ${est} AS estimate, ${STR(method)} AS method`,
    `  FROM agg`,
  ];

  parts.push(row("design", "patients", ORD_DESIGN, `CAST(n AS NUMERIC)`, `'cohort members followed'`));
  parts.push(row("design", "window_days", ORD_DESIGN + 1, `CAST(${len} AS NUMERIC)`,
    `'observation window: days ${w0} through ${w1} inclusive'`));
  parts.push(row("design", "permissible_overlap_days", ORD_DESIGN + 2, `CAST(${an.permissibleOverlapDays} AS NUMERIC)`,
    `'remaining index-drug supply, on the day the new drug starts, that still counts as a SWITCH rather than combination therapy. This is a STUDY DECISION, not a property of the data'`));

  parts.push(row("switching", "n_started_new_drug", ORD_SWITCH, `CAST(n_started_new AS NUMERIC)`,
    `'patients dispensed any drug on the to-list after the index date. Includes BOTH switches and add-ons - the split below is what the overlap rule decides'`));
  parts.push(row("switching", "n_switched", ORD_SWITCH + 1, `CAST(n_switched AS NUMERIC)`,
    `'started a new drug with at most ${an.permissibleOverlapDays} days of index supply remaining'`));
  parts.push(row("switching", "n_add_on", ORD_SWITCH + 2, `CAST(n_add_on AS NUMERIC)`,
    `'started a new drug with MORE index supply remaining than the rule allows - treated as COMBINATION therapy, not a switch. Reporting these as switches would overstate abandonment of the index drug'`));
  parts.push(row("switching", "pct_switched", ORD_SWITCH + 3, d.roundN(`n_switched * 100.0 / NULLIF(n, 0)`, 2),
    `'switches as a percentage of the followed cohort'`));
  parts.push(row("switching", "mean_days_to_switch", ORD_SWITCH + 4, d.roundN(`mean_days_to_switch`, 5),
    `'mean days from index to the switching dispensing, among switchers only. NULL when nobody switched'`));
  parts.push(row("switching", "min_days_to_switch", ORD_SWITCH + 5, `CAST(min_days_to_switch AS NUMERIC)`,
    `'earliest switch observed'`));

  /* THE SENSITIVITY BAND. */
  parts.push(row("rule_sensitivity", "n_switched_strict", ORD_RULE, `CAST(n_switched_strict AS NUMERIC)`,
    `'switches under a ZERO-overlap rule: any remaining index supply makes it combination therapy. This is the LOWEST defensible switch count'`));
  parts.push(row("rule_sensitivity", "n_switched_loose", ORD_RULE + 1, `CAST(n_switched_loose AS NUMERIC)`,
    `'switches under an UNBOUNDED-overlap rule: any new drug counts, regardless of remaining supply. This is the HIGHEST defensible switch count'`));
  parts.push(row("rule_sensitivity", "reclassified_by_overlap_rule", ORD_RULE + 2,
    `CAST(n_switched_loose - n_switched_strict AS NUMERIC)`,
    `CASE WHEN n_switched_loose <> n_switched_strict` +
    ` THEN 'PATIENTS WHOSE CLASSIFICATION DEPENDS ENTIRELY ON THE OVERLAP RULE. For these the answer is decided by a study decision rather than by the data, and a switch rate quoted without the rule is one arbitrary point in this band. State the rule'` +
    ` ELSE 'no patient changes classification across the full range of overlap rules here' END`));

  /* LINE OF THERAPY, with its definition attached to the number. */
  parts.push(row("line_of_therapy", "n_reaching_line_2", ORD_LINE, `CAST(n_line2 AS NUMERIC)`,
    `'patients advancing to a second line under the DECLARED rule (${an.lineRule}): a new line begins at each switch'`));
  parts.push(row("line_of_therapy", "mean_lines_reached", ORD_LINE + 1, d.roundN(`mean_lines`, 5),
    `'mean lines reached under the same declared rule'`));
  parts.push(row("line_of_therapy", "rule_is_definitional", ORD_LINE + 2, `CAST(NULL AS NUMERIC)`,
    `'DEFINITIONAL, NOT MEASURED. A line of therapy is whatever the protocol says it is - real definitions advance a line on a switch, on an add-on, after a gap, only within a drug class, or on clinical intent claims never record, and the same patient carries a different line number under each. This program implements ONE declared rule (${an.lineRule}) and both twins are verified to implement THE SAME ONE. That is all execution can establish here: it cannot tell you the rule matches your protocol. Do not report a line number without the definition beside it'`));

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: read n_switched beside the rule_sensitivity band. If the band`);
  L.push(`-- is wide, the switch rate is a statement about the DEFINITION at least`);
  L.push(`-- as much as about the patients.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `switch${suffix}`,
    title: `Treatment switching${suffix ? ` (${an.label})` : ""}`,
    subtitle: `switch vs add-on over ${len} days, with the overlap-rule sensitivity band`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); from "${an.fromCodeListId}" to ${an.toCodeListIds.map((s) => `"${s}"`).join(", ")}.`,
      `Window ${describeWindow(an.window)}; permissible overlap ${an.permissibleOverlapDays}d; line rule ${an.lineRule}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasSwitching(ctx: SasCtx, an: TreatmentSwitchingAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_switch${suffix}`);
  const cohT = ctx.finalCohort;
  const { w0, w1, len } = bounds(an);
  const lbl = an.label.replace(/"/g, "'");
  const limits = switchingLimitations(an);
  const clean = daysSupplyCleaningFor(an);
  const keep = cleaningKeepClause(clean, "daysupp", "sas");
  /* Per-code-list event tables, exactly as the adherence twin resolves them.
   * The SAS spine writes one table per drug code list, so the table name IS the
   * drug selection and no predicate is needed. */
  const fromT = ctx.evOf(an.fromCodeListId);
  const toTs = an.toCodeListIds.map((id) => ({ id, t: ctx.evOf(id) }));

  const lines: string[] = [
    ...header(spec, `${num}_switch${suffix}.sas`, [
      `Treatment switching, add-on therapy and line of therapy for "${an.label}".`,
      `A patient dispensed a new drug either STOPPED the index drug (a switch) or`,
      `KEPT taking it (combination therapy). Claims cannot tell those apart`,
      `without a rule, so the overlap threshold is explicit and the program`,
      `reports how many patients it reclassifies.`,
      `LINE OF THERAPY IS DEFINITIONAL - see the rule_is_definitional row.`,
      `SAS-PRIMARY: nothing.`,
      `Twin of the SQL switch program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("treatment_switching", switchingParity(an, { windowStart: w0, windowEnd: w1, windowDays: len }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...SWITCHING_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_cohort as`,
    `  select enrolid, index_date from ${cohT};`,
    ``,
    `/*-------------------- index drug: last covered day ---------------------------*/`,
    `  create table work._${num}_fromcov as`,
    `  select a.enrolid,`,
    `         max(min(f.svcdate - a.index_date + f.daysupp - 1, ${w1})) as from_last_day`,
    `  from ${fromT} as f`,
    `  inner join work._${num}_cohort as a on a.enrolid = f.enrolid`,
    `  where ${keep}`,
    `    and f.svcdate - a.index_date + f.daysupp - 1 >= ${w0}`,
    `    and f.svcdate - a.index_date <= ${w1}`,
    `  group by a.enrolid;`,
    ``,
    `/*-------------------- new drugs: first dispensing AFTER index ----------------*/`,
    `/* strictly after index: a to-drug dispensed ON day 0 is the patient's`,
    `   starting regimen, not a switch */`,
    `  create table work._${num}_tofirst as`,
  );
  toTs.forEach((t, i) => {
    lines.push(
      `${i === 0 ? "  " : "  union all\n  "}select a.enrolid, "${cmt(t.id)}" as code_list_id length=64,`,
      `         min(f.svcdate - a.index_date) as to_day`,
      `  from ${t.t} as f`,
      `  inner join work._${num}_cohort as a on a.enrolid = f.enrolid`,
      `  where ${keep}`,
      `    and f.svcdate - a.index_date > 0`,
      `    and f.svcdate - a.index_date between ${w0} and ${w1}`,
      `  group by a.enrolid${i === toTs.length - 1 ? ";" : ""}`,
    );
  });
  lines.push(
    ``,
    `  create table work._${num}_firstto as`,
    `  select enrolid, min(to_day) as to_day from work._${num}_tofirst group by enrolid;`,
    ``,
    `/*-------------------- classification -----------------------------------------*/`,
    `  create table work._${num}_pt as`,
    `  select c.enrolid, t.to_day, fc.from_last_day`,
    `  from work._${num}_cohort as c`,
    `  left join work._${num}_firstto as t on t.enrolid = c.enrolid`,
    `  left join work._${num}_fromcov as fc on fc.enrolid = c.enrolid;`,
    `quit;`,
    ``,
    `data work._${num}_pt2;`,
    `  set work._${num}_pt;`,
    `  if to_day = . then overlap_days = .;`,
    `  else overlap_days = max(coalesce(from_last_day, to_day - 1) - to_day + 1, 0);`,
    `  started_new_drug = (to_day ne .);`,
    `  switched  = (to_day ne . and overlap_days <= ${an.permissibleOverlapDays});`,
    `  add_on    = (to_day ne . and overlap_days > ${an.permissibleOverlapDays});`,
    `  /* the sensitivity band: the same events under the two extreme rules */`,
    `  switched_strict = (to_day ne . and overlap_days <= 0);`,
    `  switched_loose  = (to_day ne .);`,
    `  /* line of therapy under the DECLARED rule (${an.lineRule}) */`,
    `  lines_reached = ifn(to_day ne . and overlap_days <= ${an.permissibleOverlapDays}, 2, 1);`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_pt2`, "patients followed", [`sum(switched) as n_switched`]),
    ``,
    `proc sql;`,
    `  create table work._${num}_agg as`,
    `  select count(*) as n,`,
    `         sum(started_new_drug) as n_started_new,`,
    `         sum(switched) as n_switched,`,
    `         sum(add_on) as n_add_on,`,
    `         sum(switched_strict) as n_switched_strict,`,
    `         sum(switched_loose) as n_switched_loose,`,
    `         mean(ifn(switched, to_day, .)) as mean_days_to_switch,`,
    `         min(ifn(switched, to_day, .)) as min_days_to_switch,`,
    `         sum(lines_reached = 2) as n_line2,`,
    `         mean(lines_reached) as mean_lines`,
    `  from work._${num}_pt2;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  length measure $24 component $18 statistic $32 method $600;`,
    `  set work._${num}_agg;`,
    `  measure = "${MEASURE}";`,
    `  component='design'; statistic='patients'; ord=${ORD_DESIGN}; estimate=n;`,
    `  method='cohort members followed'; output;`,
    `  statistic='window_days'; ord=${ORD_DESIGN + 1}; estimate=${len};`,
    `  method='observation window: days ${w0} through ${w1} inclusive'; output;`,
    `  statistic='permissible_overlap_days'; ord=${ORD_DESIGN + 2}; estimate=${an.permissibleOverlapDays};`,
    `  method='remaining index-drug supply, on the day the new drug starts, that still counts as a SWITCH rather than combination therapy. This is a STUDY DECISION, not a property of the data'; output;`,
    `  component='switching'; statistic='n_started_new_drug'; ord=${ORD_SWITCH}; estimate=n_started_new;`,
    `  method='patients dispensed any drug on the to-list after the index date. Includes BOTH switches and add-ons'; output;`,
    `  statistic='n_switched'; ord=${ORD_SWITCH + 1}; estimate=n_switched;`,
    `  method='started a new drug with at most ${an.permissibleOverlapDays} days of index supply remaining'; output;`,
    `  statistic='n_add_on'; ord=${ORD_SWITCH + 2}; estimate=n_add_on;`,
    `  method='started a new drug with MORE index supply remaining than the rule allows - treated as COMBINATION therapy, not a switch'; output;`,
    `  statistic='pct_switched'; ord=${ORD_SWITCH + 3}; estimate=round(100 * n_switched / n, 0.01);`,
    `  method='switches as a percentage of the followed cohort'; output;`,
    `  statistic='mean_days_to_switch'; ord=${ORD_SWITCH + 4}; estimate=round(mean_days_to_switch, 0.00001);`,
    `  method='mean days from index to the switching dispensing, among switchers only'; output;`,
    `  statistic='min_days_to_switch'; ord=${ORD_SWITCH + 5}; estimate=min_days_to_switch;`,
    `  method='earliest switch observed'; output;`,
    `  component='rule_sensitivity'; statistic='n_switched_strict'; ord=${ORD_RULE}; estimate=n_switched_strict;`,
    `  method='switches under a ZERO-overlap rule: any remaining index supply makes it combination therapy. The LOWEST defensible switch count'; output;`,
    `  statistic='n_switched_loose'; ord=${ORD_RULE + 1}; estimate=n_switched_loose;`,
    `  method='switches under an UNBOUNDED-overlap rule: any new drug counts. The HIGHEST defensible switch count'; output;`,
    `  statistic='reclassified_by_overlap_rule'; ord=${ORD_RULE + 2}; estimate=n_switched_loose - n_switched_strict;`,
    `  if n_switched_loose ne n_switched_strict then method='PATIENTS WHOSE CLASSIFICATION DEPENDS ENTIRELY ON THE OVERLAP RULE. For these the answer is decided by a study decision rather than by the data. State the rule';`,
    `  else method='no patient changes classification across the full range of overlap rules here'; output;`,
    `  component='line_of_therapy'; statistic='n_reaching_line_2'; ord=${ORD_LINE}; estimate=n_line2;`,
    `  method='patients advancing to a second line under the DECLARED rule (${an.lineRule})'; output;`,
    `  statistic='mean_lines_reached'; ord=${ORD_LINE + 1}; estimate=round(mean_lines, 0.00001);`,
    `  method='mean lines reached under the same declared rule'; output;`,
    `  statistic='rule_is_definitional'; ord=${ORD_LINE + 2}; estimate=.;`,
    `  method='DEFINITIONAL, NOT MEASURED. A line of therapy is whatever the protocol says it is, and the same patient carries a different line number under each definition. This program implements ONE declared rule (${an.lineRule}) and both twins implement THE SAME ONE. Execution cannot tell you the rule matches your protocol. Do not report a line number without the definition beside it'; output;`,
    `  keep measure component statistic ord estimate method;`,
    `run;`,
    ``,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Treatment switching and line of therapy: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_switch${suffix}.sas`,
    language: "sas",
    title: `${num} Treatment switching${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const treatmentSwitchingModule: AnalysisModule<TreatmentSwitchingAnalysis> = {
  analysisKind: "treatment_switching",
  stampKind: "treatment_switching",
  resultSlug: "switch",
  sql: sqlSwitching,
  sas: sasSwitching,
};
