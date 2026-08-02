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
import type { TreatmentSwitchingAnalysis, LineConstruction } from "../../spec/types";
import { daysSupplyCleaningFor } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, sq, INCLUDE_SETUP } from "../sas-base";
import { cleaningKeepClause } from "../interval-core";
import { lotSqlCtes, lotSasSteps, lotTriggerLabel } from "../lot-core";
import {
  DEFAULT_CAPITATED_PLAN_TYPES,
  DEFAULT_ED_PLACE_OF_SERVICE,
  ledgerSqlCtes,
  ledgerSasSteps,
  type MemberMonthOptions,
} from "../ledger";
import {
  parityStamp,
  renderDaysPerMonth,
  switchingLimitations,
  switchingParity,
  lineConstructionMethodNotes,
  SWITCHING_METHOD_NOTES,
} from "../parity";

const MEASURE = "treatment_switching";
const ORD_DESIGN = 0;
const ORD_SWITCH = 10;
const ORD_RULE = 20;
const ORD_LINE = 30;
/** The regimen-construction block. Its own ord band, well clear of the switch
 *  block above it, so a per-line row can carry `line_no * 100 + offset` without
 *  ever colliding with a switch statistic. */
const ORD_LOT = 1000;

/** Cost by line reads the SAME claim-line ledger the resource-use module reads,
 *  at ALL-CAUSE and with no ED carve-out: the deliverable is total cost per line,
 *  and re-deriving the inpatient double-count rule here would be a second
 *  implementation of the one piece of this repo that is easiest to get quietly
 *  wrong. */
const LOT_COST_SETTINGS = ["inpatient", "outpatient", "pharmacy"] as const;

/** The member-month denominator PPPM-by-line divides by.
 *
 *  `observed_member_months` is not a choice here, it is a correctness
 *  requirement: a line ENDS at next-line initiation, so follow-up is unequal by
 *  construction and a fixed-window denominator would understate cost for exactly
 *  the patients who advanced fastest. `LineConstruction` carries no cost fields,
 *  so the options that DO have legitimate alternatives (attribution, CPI
 *  restatement, quantiles) are not offered here at all rather than being
 *  guessed - resource_use is where they live. */
function lotMemberMonths(spec: { enrollment: { requiresRxCoverage: boolean }; meta: { database: string } }): MemberMonthOptions {
  return {
    excludeCapitated: true,
    capitatedPlanTypes: DEFAULT_CAPITATED_PLAN_TYPES,
    requiresRxCoverage: spec.enrollment.requiresRxCoverage,
    rxColumn: spec.meta.database === "marketscan_medicaid" ? "drugcovg" : "rx",
  };
}

/** The construction, or undefined when the two-line approximation is in force.
 *  Resolved through ONE function so the emitters, the stamp and the notes
 *  cannot disagree about whether it is running. */
function construction(an: TreatmentSwitchingAnalysis): LineConstruction | undefined {
  return an.lineRule === "declared_regimen" ? an.lineConstruction : undefined;
}

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

  const lc = construction(an);
  const mm = lotMemberMonths(ctx.spec);
  const dpm = renderDaysPerMonth(ctx.spec);

  L.push(`-- ${parityStamp("treatment_switching", switchingParity(an, {
    windowStart: w0, windowEnd: w1, windowDays: len,
    ...(lc ? { daysPerMonth: dpm, excludeCapitatedMonths: mm.excludeCapitated } : {}),
  }))}`);
  const limits = switchingLimitations(an);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of SWITCHING_METHOD_NOTES) L.push(`--   * ${note}`);
  if (lc) for (const note of lineConstructionMethodNotes(lc)) L.push(`--   * ${oneLine(note)}`);

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
  /* ================= THE FULL LINE CONSTRUCTION ==================== *
   * Everything below this point is emitted ONLY under lineRule
   * "declared_regimen". A spec on the two-line approximation produces the
   * byte-identical program it produced before this wave, which is what the
   * snapshot gate checks. */
  if (lc) {
    /* The claim-line ledger, for cost BY LINE. Read with cohortCte 'cohort' so
     * it joins the cohort this program already defined rather than opening a
     * second WITH, and with its own prefix so its CTE names cannot collide with
     * the switch chain above. */
    C.push(
      ...ledgerSqlCtes(ctx, {
        wp,
        window: an.window,
        settings: [...LOT_COST_SETTINGS],
        costField: "paytot",
        edPlaces: DEFAULT_ED_PLACE_OF_SERVICE,
        memberMonths: mm,
        cohortCte: "cohort",
        prefix: "lc",
      }),
    );
    C.push(
      ...lotSqlCtes(ctx, {
        lc,
        windowStartDay: w0,
        windowEndDay: w1,
        wp,
        keepClause: keep,
        cohortCte: "cohort",
      }),
    );
    /* A ROW PER LINE EVEN WHEN NOBODY REACHES IT. Without this the output table
     * would lose rows on a cohort where no patient got to line 3, and a table
     * whose SHAPE depends on the data cannot be diffed against another run. */
    C.push(`lot_nums AS (`);
    for (let k = 1; k <= lc.maxLines; k++) {
      C.push(`  ${k === 1 ? "  " : "UNION ALL "}SELECT ${k} AS line_no`);
    }
    C.push(`),`);
    C.push(`lot_agents AS (`);
    lc.agentCodeListIds.forEach((a, j) => {
      C.push(`  ${j === 0 ? "  " : "UNION ALL "}SELECT '${q(a)}' AS agent`);
    });
    C.push(`),`);
    /* ELIGIBLE MEMBER-MONTHS INSIDE EACH LINE'S OWN SPAN. Not the window's:
     * a line ends at next-line initiation, so dividing by the window would give
     * the fastest-progressing patients the largest denominator and the smallest
     * apparent cost. */
    C.push(`lot_mm AS (`);
    C.push(`  SELECT l.line_no, l.enrolid,`);
    C.push(`         COALESCE(SUM(GREATEST(0,`);
    C.push(`           LEAST(l.line_end, ${d.daysBetween("s.seg_end", "c.index_date")})`);
    C.push(`           - GREATEST(l.line_start, ${d.daysBetween("s.seg_start", "c.index_date")}) + 1)), 0) AS eligible_days`);
    C.push(`  FROM lot_lines l`);
    C.push(`  JOIN cohort c ON c.enrolid = l.enrolid`);
    C.push(`  LEFT JOIN lcmm_seg s ON s.enrolid = l.enrolid`);
    C.push(`  GROUP BY l.line_no, l.enrolid`);
    C.push(`),`);
    C.push(`lot_paid AS (   -- payments made INSIDE the line, on eligible member-time`);
    C.push(`  -- A payment in a month the denominator excludes would inflate PPPM:`);
    C.push(`  -- real dollars over fewer months. Excluded encounters are COUNTED.`);
    C.push(`  SELECT l.line_no, l.enrolid,`);
    C.push(`         COALESCE(SUM(CASE WHEN e.elig = 1 THEN e.paid ELSE 0 END), 0) AS paid_elig,`);
    C.push(`         COALESCE(SUM(CASE WHEN e.elig = 0 THEN 1 ELSE 0 END), 0) AS enc_excluded`);
    C.push(`  FROM lot_lines l`);
    C.push(`  JOIN cohort c ON c.enrolid = l.enrolid`);
    C.push(`  LEFT JOIN lcencounters_kept e`);
    C.push(`    ON e.enrolid = l.enrolid`);
    C.push(`   AND ${d.daysBetween("e.encounter_date", "c.index_date")} BETWEEN l.line_start AND l.line_end`);
    C.push(`  GROUP BY l.line_no, l.enrolid`);
    C.push(`),`);
    C.push(`lot_agg0 AS (`);
    C.push(`  SELECT l.line_no, COUNT(*) AS n_pts,`);
    C.push(`         SUM(m.eligible_days) AS elig_days,`);
    C.push(`         SUM(k.paid_elig) AS paid_elig,`);
    C.push(`         SUM(k.enc_excluded) AS enc_excluded,`);
    C.push(`         AVG(CAST(l.next_line_start - l.line_start AS DOUBLE PRECISION)) AS mean_to_next,`);
    C.push(`         SUM(CASE WHEN l.next_line_start IS NOT NULL THEN 1 ELSE 0 END) AS n_advancing,`);
    C.push(`         SUM(CASE WHEN l.closed_by = 'gap' THEN 1 ELSE 0 END) AS n_gap,`);
    C.push(`         SUM(CASE WHEN l.closed_by = 'substitution' THEN 1 ELSE 0 END) AS n_sub,`);
    C.push(`         SUM(CASE WHEN l.closed_by = 'addition' THEN 1 ELSE 0 END) AS n_add,`);
    C.push(`         SUM(CASE WHEN l.closed_by = 'open_at_window_end' THEN 1 ELSE 0 END) AS n_open`);
    C.push(`  FROM lot_lines l`);
    C.push(`  JOIN lot_mm m ON m.line_no = l.line_no AND m.enrolid = l.enrolid`);
    C.push(`  JOIN lot_paid k ON k.line_no = l.line_no AND k.enrolid = l.enrolid`);
    C.push(`  GROUP BY l.line_no`);
    C.push(`),`);
    C.push(`lot_rsz AS (`);
    C.push(`  SELECT line_no, COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT enrolid), 0) AS mean_size`);
    C.push(`  FROM lot_reg GROUP BY line_no`);
    C.push(`),`);
    C.push(`lot_out AS (   -- one row per line, whether or not anyone reached it`);
    C.push(`  SELECT n.line_no,`);
    C.push(`         COALESCE(a.n_pts, 0) AS n_pts,`);
    C.push(`         COALESCE(a.elig_days, 0) AS elig_days,`);
    C.push(`         COALESCE(a.paid_elig, 0) AS paid_elig,`);
    C.push(`         COALESCE(a.enc_excluded, 0) AS enc_excluded,`);
    C.push(`         a.mean_to_next,`);
    C.push(`         COALESCE(a.n_advancing, 0) AS n_advancing,`);
    C.push(`         COALESCE(a.n_gap, 0) AS n_gap,`);
    C.push(`         COALESCE(a.n_sub, 0) AS n_sub,`);
    C.push(`         COALESCE(a.n_add, 0) AS n_add,`);
    C.push(`         COALESCE(a.n_open, 0) AS n_open,`);
    C.push(`         z.mean_size`);
    C.push(`  FROM lot_nums n`);
    C.push(`  LEFT JOIN lot_agg0 a ON a.line_no = n.line_no`);
    C.push(`  LEFT JOIN lot_rsz z ON z.line_no = n.line_no`);
    C.push(`),`);
    C.push(`lot_regout AS (   -- THE REGIMEN COMPOSITION: which agents, per line`);
    C.push(`  SELECT n.line_no, g.agent, COALESCE(r.n_pts, 0) AS n_pts`);
    C.push(`  FROM lot_nums n`);
    C.push(`  CROSS JOIN lot_agents g`);
    C.push(`  LEFT JOIN (SELECT line_no, agent, COUNT(*) AS n_pts FROM lot_reg GROUP BY line_no, agent) r`);
    C.push(`    ON r.line_no = n.line_no AND r.agent = g.agent`);
    C.push(`),`);
    C.push(`lot_tr AS (SELECT COUNT(*) AS n_truncated FROM lot_trunc),`);
  }
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
  /* The same row shape over a DIFFERENT source. The per-line block reads one
   * row of `lot_out` at a time rather than the single `agg` row, so it needs
   * its own FROM and its own WHERE - written once here so twelve call sites
   * cannot each pick a slightly different one. */
  const rowFrom = (component: string, statistic: string, ord: number, est: string, method: string, from: string) => [
    `  SELECT ${STR(`'${component}'`)} AS component, ${STR(`'${statistic}'`)} AS statistic,`,
    `         ${INT(String(ord))} AS ord, ${est} AS estimate, ${STR(method)} AS method`,
    `  FROM ${from}`,
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
  /* THE CAVEAT, and why it gets STRONGER rather than weaker once the full
   * construction runs. The two-line approximation has one thing to declare;
   * the regimen construction has THREE, and those three move the line count
   * more than anything else in the analysis. A richer output makes the caveat
   * more necessary, not less: a line 4 PPPM figure looks like a measurement in
   * a way that "n reaching line 2" never did. */
  parts.push(row("line_of_therapy", "rule_is_definitional", ORD_LINE + 2, `CAST(NULL AS NUMERIC)`,
    lc
      ? `'DEFINITIONAL, NOT MEASURED, AND THIS RULE HAS THREE DECLARED PARAMETERS: a COMBINATION WINDOW of ${lc.combinationWindowDays} days (agents starting within it join the same line), a GAP of ${lc.gapDays} days (uncovered days that close a line), and an ADVANCE TRIGGER of "${lc.advanceTrigger}" (whether adding an agent to a covered regimen starts a new line). Those three move the line count more than anything else here, none has a defensible default, and none is discoverable from claims - a clinician deciding to call something second line leaves no trace in a dispensing record. Two protocols applying different values to identical claims will BOTH be correct and disagree. This program implements ONE declared rule and both twins are verified to implement THE SAME ONE. That is all execution can establish: it cannot tell you the rule matches your protocol. Do not report a line number, a line-${lc.maxLines} count or a PPPM by line without all three parameters beside it'`
      : `'DEFINITIONAL, NOT MEASURED. A line of therapy is whatever the protocol says it is - real definitions advance a line on a switch, on an add-on, after a gap, only within a drug class, or on clinical intent claims never record, and the same patient carries a different line number under each. This program implements ONE declared rule (${an.lineRule}) and both twins are verified to implement THE SAME ONE. That is all execution can establish here: it cannot tell you the rule matches your protocol. Do not report a line number without the definition beside it'`));

  /* ================= THE LINE-CONSTRUCTION ROWS ==================== */
  if (lc) {
    /* THE THREE DECLARED PARAMETERS, emitted as rows rather than only stamped.
     * A stamp is for the harness; these are for the reader of the RESULT, who
     * otherwise has a line distribution with no way to see what produced it. */
    parts.push(row("line_construction", "combination_window_days", ORD_LOT, `CAST(${lc.combinationWindowDays} AS NUMERIC)`,
      `'agents whose first dispensing falls within this many days of a line opening join THAT line rather than starting a new one. This is the parameter that decides whether a planned doublet is one line or two, and it has no defensible default - it is DECLARED'`));
    parts.push(row("line_construction", "gap_days", ORD_LOT + 1, `CAST(${lc.gapDays} AS NUMERIC)`,
      `'uncovered days that CLOSE the current line. 60, 90 and 180 all appear in the published literature and they do not agree with each other'`));
    parts.push(row("line_construction", "advance_on_addition", ORD_LOT + 2,
      `CAST(${lc.advanceTrigger === "addition_or_substitution" ? 1 : 0} AS NUMERIC)`,
      `'${q(lotTriggerLabel(lc.advanceTrigger))}'`));
    parts.push(row("line_construction", "max_lines", ORD_LOT + 3, `CAST(${lc.maxLines} AS NUMERIC)`,
      `'construction stops here. Deep lines are rare and thin, and an unbounded count invites reporting a line 9 estimated from two patients'`));
    parts.push(row("line_construction", "agent_lists", ORD_LOT + 4, `CAST(${lc.agentCodeListIds.length} AS NUMERIC)`,
      `'a line is named by which of these agents are active, so the GRANULARITY of this list IS the granularity of the line definition: ${q(lc.agentCodeListIds.join(", "))}'`));
    parts.push(rowFrom("line_construction", "patients_truncated_at_max_lines", ORD_LOT + 5,
      `CAST(n_truncated AS NUMERIC)`,
      `CASE WHEN n_truncated > 0` +
      ` THEN 'PATIENTS WHO WOULD HAVE OPENED LINE ${lc.maxLines + 1}. They are COUNTED here, not dropped: a line distribution that silently truncates its own tail understates late-line burden and looks exactly like a cohort that did not progress. Every mean line count in this table is bounded above by ${lc.maxLines}'` +
      ` ELSE 'no patient reached the maxLines bound, so the line distribution below is complete under this rule' END`,
      `lot_tr`));

    /* PER LINE. `line_no * 100 + offset` keeps each line's block contiguous and
     * ordered, and leaves room for the per-agent composition rows. */
    for (let k = 1; k <= lc.maxLines; k++) {
      const base = ORD_LOT + 100 * k;
      const where = `lot_out WHERE line_no = ${k}`;
      parts.push(rowFrom("line_of_therapy", `line${k}_n_patients`, base, `CAST(n_pts AS NUMERIC)`,
        `'patients REACHING line ${k} under the declared rule'`, where));
      parts.push(rowFrom("line_of_therapy", `line${k}_regimen_size_mean`, base + 1, d.roundN(`mean_size`, 5),
        `'mean number of agents in the line ${k} regimen. Above 1 means combination therapy is being read as ONE line, which is what the combination window is for'`, where));
      parts.push(rowFrom("line_of_therapy", `line${k}_n_advancing`, base + 2, `CAST(n_advancing AS NUMERIC)`,
        `'patients who went on to open line ${k + 1}'`, where));
      parts.push(rowFrom("line_of_therapy", `line${k}_mean_days_to_next_line`, base + 3, d.roundN(`mean_to_next`, 5),
        `'mean days from line ${k} opening to line ${k + 1} opening, among those who advanced. NULL when nobody did'`, where));
      parts.push(rowFrom("line_of_therapy", `line${k}_closed_by_gap`, base + 4, `CAST(n_gap AS NUMERIC)`,
        `'line ${k} ended at an uncovered gap of ${lc.gapDays} days or more. A planned treatment holiday longer than the gap is indistinguishable from discontinuation here'`, where));
      parts.push(rowFrom("line_of_therapy", `line${k}_closed_by_substitution`, base + 5, `CAST(n_sub AS NUMERIC)`,
        `'line ${k} ended because an agent outside the regimen started while a regimen agent had already run out'`, where));
      parts.push(rowFrom("line_of_therapy", `line${k}_closed_by_addition`, base + 6, `CAST(n_add AS NUMERIC)`,
        `'an agent outside the regimen started while EVERY regimen agent was still covered. Under advanceTrigger "${lc.advanceTrigger}" this ${lc.advanceTrigger === "addition_or_substitution" ? "CLOSED the line" : "did NOT close the line, so this count is zero by construction and is emitted so the choice is visible"}'`, where));
      parts.push(rowFrom("line_of_therapy", `line${k}_open_at_window_end`, base + 7, `CAST(n_open AS NUMERIC)`,
        `'still on the line ${k} regimen when the window closed. This is CENSORING, not a completed line - merging it into the completed counts would turn "still on this regimen when we stopped looking" into "finished it"'`, where));
      /* PPPM BY LINE, with its denominator emitted beside it. */
      parts.push(rowFrom("line_cost", `line${k}_member_months`, base + 8,
        d.roundN(`elig_days / ${dpm}`, 5),
        `'ELIGIBLE member-months inside line ${k} spans, at ${dpm} days per month. Built from the enrollment SEGMENTS, capitated months excluded - not from the window length, which would be wrong here by construction'`, where));
      parts.push(rowFrom("line_cost", `line${k}_pppm`, base + 9,
        d.roundN(`paid_elig / NULLIF(elig_days / ${dpm}, 0)`, 2),
        `'all-cause paid per member per month on line ${k}. Follow-up is UNEQUAL by construction here - a line ends at next-line initiation - which is exactly why the denominator is observed member-months and not the window'`, where));
      parts.push(rowFrom("line_cost", `line${k}_encounters_outside_eligible_time`, base + 10,
        `CAST(enc_excluded AS NUMERIC)`,
        `'encounters inside the line span but OUTSIDE eligible member-time. Their payments are excluded from the numerator, because real dollars over fewer months inflate PPPM. A large count here means the denominator and the claims disagree about who was covered'`, where));
      /* THE REGIMEN COMPOSITION. One row per agent per line: the answer to
       * "which drugs was this line", which a mean regimen size cannot give. */
      lc.agentCodeListIds.forEach((a, j) => {
        parts.push(rowFrom("line_regimen", `line${k}_agent_${a}`, base + 20 + j, `CAST(n_pts AS NUMERIC)`,
          `'patients whose line ${k} regimen includes "${q(a)}"'`,
          `lot_regout WHERE line_no = ${k} AND agent = '${q(a)}'`));
      });
    }
  }

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
  if (lc) {
    L.push(`-- REVIEW: the line block is a consequence of THREE declared parameters`);
    L.push(`-- (combination window ${lc.combinationWindowDays}d, gap ${lc.gapDays}d, trigger ${lc.advanceTrigger}). Change any one`);
    L.push(`-- and the same patients carry different line numbers. Report them with it.`);
  }
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `switch${suffix}`,
    title: `Treatment switching${suffix ? ` (${an.label})` : ""}`,
    subtitle: lc
      ? `switch vs add-on over ${len} days, plus the FULL line-of-therapy construction and PPPM by line`
      : `switch vs add-on over ${len} days, with the overlap-rule sensitivity band`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); from "${an.fromCodeListId}" to ${an.toCodeListIds.map((s) => `"${s}"`).join(", ")}.`,
      `Window ${describeWindow(an.window)}; permissible overlap ${an.permissibleOverlapDays}d; line rule ${an.lineRule}.`,
      ...(lc
        ? [`Line construction: combination window ${lc.combinationWindowDays}d, gap ${lc.gapDays}d, trigger ${lc.advanceTrigger}, max ${lc.maxLines} lines over agents ${lc.agentCodeListIds.map((a) => `"${a}"`).join(", ")}.`]
        : []),
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

/**
 * The line-construction RESULT ROWS, as SAS DATA steps.
 *
 * Unrolled per line rather than built with cats(), so every statistic name and
 * every method string is a LITERAL that reads the same in both twins. Building
 * them by concatenation would work and would make the two programs impossible
 * to compare by eye — and by regex, which is what verify/fingerprint.ts does.
 */
function sasLineRows(num: string, outT: string, lc: LineConstruction, dpm: string): string[] {
  const L: string[] = [];
  const LEN = `  length measure $24 component $18 statistic $64 method $1400;`;
  const NUMS = `  ord = .; estimate = .;`;

  /* THE THREE DECLARED PARAMETERS plus the truncation count, from lot_tr (one
   * row), so the reader of the RESULT can see what produced the distribution. */
  L.push(
    `data work._${num}_rows1;`,
    LEN,
    `  set work._${num}_lot_tr;`,
    `  measure = "${MEASURE}"; component = 'line_construction';`,
    NUMS,
    `  statistic = 'combination_window_days'; ord = ${ORD_LOT}; estimate = ${lc.combinationWindowDays};`,
    `  method = 'agents whose first dispensing falls within this many days of a line opening join THAT line rather than starting a new one. This is the parameter that decides whether a planned doublet is one line or two, and it has no defensible default - it is DECLARED'; output;`,
    `  statistic = 'gap_days'; ord = ${ORD_LOT + 1}; estimate = ${lc.gapDays};`,
    `  method = 'uncovered days that CLOSE the current line. 60, 90 and 180 all appear in the published literature and they do not agree with each other'; output;`,
    `  statistic = 'advance_on_addition'; ord = ${ORD_LOT + 2}; estimate = ${lc.advanceTrigger === "addition_or_substitution" ? 1 : 0};`,
    `  method = '${sq(cmt(lotTriggerLabel(lc.advanceTrigger)))}'; output;`,
    `  statistic = 'max_lines'; ord = ${ORD_LOT + 3}; estimate = ${lc.maxLines};`,
    `  method = 'construction stops here. Deep lines are rare and thin, and an unbounded count invites reporting a line 9 estimated from two patients'; output;`,
    `  statistic = 'agent_lists'; ord = ${ORD_LOT + 4}; estimate = ${lc.agentCodeListIds.length};`,
    `  method = 'a line is named by which of these agents are active, so the GRANULARITY of this list IS the granularity of the line definition: ${sq(cmt(lc.agentCodeListIds.join(", ")))}'; output;`,
    `  statistic = 'patients_truncated_at_max_lines'; ord = ${ORD_LOT + 5}; estimate = n_truncated;`,
    `  if n_truncated > 0 then method = 'PATIENTS WHO WOULD HAVE OPENED LINE ${lc.maxLines + 1}. They are COUNTED here, not dropped: a line distribution that silently truncates its own tail understates late-line burden and looks exactly like a cohort that did not progress. Every mean line count in this table is bounded above by ${lc.maxLines}';`,
    `  else method = 'no patient reached the maxLines bound, so the line distribution below is complete under this rule';`,
    `  output;`,
    `  keep measure component statistic ord estimate method;`,
    `run;`,
    ``,
  );

  /* PER LINE, unrolled to the declared bound exactly as the SQL twin unrolls it. */
  L.push(`data work._${num}_rows2;`, LEN, `  set work._${num}_lot_out;`, `  measure = "${MEASURE}";`, NUMS);
  for (let k = 1; k <= lc.maxLines; k++) {
    const base = ORD_LOT + 100 * k;
    L.push(
      `  if line_no = ${k} then do;`,
      `    component = 'line_of_therapy';`,
      `    statistic = 'line${k}_n_patients'; ord = ${base}; estimate = n_pts;`,
      `    method = 'patients REACHING line ${k} under the declared rule'; output;`,
      `    statistic = 'line${k}_regimen_size_mean'; ord = ${base + 1}; estimate = round(mean_size, 0.00001);`,
      `    method = 'mean number of agents in the line ${k} regimen. Above 1 means combination therapy is being read as ONE line, which is what the combination window is for'; output;`,
      `    statistic = 'line${k}_n_advancing'; ord = ${base + 2}; estimate = n_advancing;`,
      `    method = 'patients who went on to open line ${k + 1}'; output;`,
      `    statistic = 'line${k}_mean_days_to_next_line'; ord = ${base + 3}; estimate = round(mean_to_next, 0.00001);`,
      `    method = 'mean days from line ${k} opening to line ${k + 1} opening, among those who advanced. NULL when nobody did'; output;`,
      `    statistic = 'line${k}_closed_by_gap'; ord = ${base + 4}; estimate = n_gap;`,
      `    method = 'line ${k} ended at an uncovered gap of ${lc.gapDays} days or more. A planned treatment holiday longer than the gap is indistinguishable from discontinuation here'; output;`,
      `    statistic = 'line${k}_closed_by_substitution'; ord = ${base + 5}; estimate = n_sub;`,
      `    method = 'line ${k} ended because an agent outside the regimen started while a regimen agent had already run out'; output;`,
      `    statistic = 'line${k}_closed_by_addition'; ord = ${base + 6}; estimate = n_add;`,
      `    method = 'an agent outside the regimen started while EVERY regimen agent was still covered. Under advanceTrigger "${lc.advanceTrigger}" this ${lc.advanceTrigger === "addition_or_substitution" ? "CLOSED the line" : "did NOT close the line, so this count is zero by construction and is emitted so the choice is visible"}'; output;`,
      `    statistic = 'line${k}_open_at_window_end'; ord = ${base + 7}; estimate = n_open;`,
      `    method = 'still on the line ${k} regimen when the window closed. This is CENSORING, not a completed line - merging it into the completed counts would turn "still on this regimen when we stopped looking" into "finished it"'; output;`,
      `    component = 'line_cost';`,
      `    statistic = 'line${k}_member_months'; ord = ${base + 8}; estimate = round(elig_days / ${dpm}, 0.00001);`,
      `    method = 'ELIGIBLE member-months inside line ${k} spans, at ${dpm} days per month. Built from the enrollment SEGMENTS, capitated months excluded - not from the window length, which would be wrong here by construction'; output;`,
      `    statistic = 'line${k}_pppm'; ord = ${base + 9};`,
      `    if elig_days > 0 then estimate = round(paid_elig / (elig_days / ${dpm}), 0.01); else estimate = .;`,
      `    method = 'all-cause paid per member per month on line ${k}. Follow-up is UNEQUAL by construction here - a line ends at next-line initiation - which is exactly why the denominator is observed member-months and not the window'; output;`,
      `    statistic = 'line${k}_encounters_outside_eligible_time'; ord = ${base + 10}; estimate = enc_excluded;`,
      `    method = 'encounters inside the line span but OUTSIDE eligible member-time. Their payments are excluded from the numerator, because real dollars over fewer months inflate PPPM. A large count here means the denominator and the claims disagree about who was covered'; output;`,
      `  end;`,
    );
  }
  L.push(`  keep measure component statistic ord estimate method;`, `run;`, ``);

  /* THE REGIMEN COMPOSITION. "Which agents was this line" is the question a mean
   * regimen size cannot answer, and it is the one an oncology reader asks first. */
  L.push(`data work._${num}_rows3;`, LEN, `  set work._${num}_lot_regout;`, `  measure = "${MEASURE}"; component = 'line_regimen';`, NUMS);
  for (let k = 1; k <= lc.maxLines; k++) {
    lc.agentCodeListIds.forEach((a, j) => {
      L.push(
        `  if line_no = ${k} and agent = "${sq(a)}" then do;`,
        `    statistic = 'line${k}_agent_${a}'; ord = ${ORD_LOT + 100 * k + 20 + j}; estimate = n_pts;`,
        `    method = 'patients whose line ${k} regimen includes "${sq(a)}"'; output;`,
        `  end;`,
      );
    });
  }
  L.push(`  keep measure component statistic ord estimate method;`, `run;`, ``);

  L.push(
    `data ${outT};`,
    `  set work._${num}_rows0 work._${num}_rows1 work._${num}_rows2 work._${num}_rows3;`,
    `run;`,
    ``,
  );
  return L;
}


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
  const lc = construction(an);
  const mm = lotMemberMonths(spec);
  const dpm = renderDaysPerMonth(spec);
  const ledger = lc
    ? ledgerSasSteps(ctx, {
        wp: "",
        num,
        cohT,
        epiT: ctx.tbl("050_epi"),
        enrT: ctx.tbl("040_enroll"),
        window: an.window,
        settings: [...LOT_COST_SETTINGS],
        costField: "paytot",
        edPlaces: DEFAULT_ED_PLACE_OF_SERVICE,
        memberMonths: mm,
      })
    : null;

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
    `/* ${parityStamp("treatment_switching", switchingParity(an, {
      windowStart: w0, windowEnd: w1, windowDays: len,
      ...(lc ? { daysPerMonth: dpm, excludeCapitatedMonths: mm.excludeCapitated } : {}),
    }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...SWITCHING_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    ...(lc ? lineConstructionMethodNotes(lc).map((n) => `   * ${cmt(n)}`) : []),
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
    /* ============ THE FULL LINE CONSTRUCTION (declared_regimen only) ======= *
       Emitted only under lineRule "declared_regimen", so a spec on the two-line
       approximation gets the byte-identical program it got before this wave. */
    ...(lc && ledger
      ? [
          ...ledger.lines,
          ...lotSasSteps({
            lc,
            windowStartDay: w0,
            windowEndDay: w1,
            num,
            cohortT: cohT,
            evOf: ctx.evOf,
            keepClause: keep,
          }),
          `/*-------------------- per-line denominators and cost ------------------------*/`,
          `data work._${num}_lot_nums;`,
          `  /* one row per line WHETHER OR NOT anyone reached it: a result table whose`,
          `     shape depends on the data cannot be diffed against another run */`,
          `  do line_no = 1 to ${lc.maxLines}; output; end;`,
          `run;`,
          ``,
          `data work._${num}_lot_agents;`,
          `  length agent $64;`,
          ...lc.agentCodeListIds.flatMap((a, j) => [`  agent_no = ${j + 1}; agent = "${sq(a)}"; output;`]),
          `run;`,
          ``,
          `proc sql;`,
          `  /* ELIGIBLE MEMBER-MONTHS INSIDE EACH LINE'S OWN SPAN - never the window's.`,
          `     A line ends at next-line initiation, so a window denominator would give`,
          `     the fastest-progressing patients the largest denominator and the`,
          `     smallest apparent cost. */`,
          `  create table work._${num}_lot_mm as`,
          `  select l.line_no, l.enrolid,`,
          `         coalesce(sum(max(0, min(l.line_end, s.seg_end - a.index_date)`,
          `                         - max(l.line_start, s.seg_start - a.index_date) + 1)), 0) as eligible_days`,
          `  from work._${num}_lot_lines as l`,
          `  inner join ${cohT} as a on a.enrolid = l.enrolid`,
          `  left join work._${num}_mseg as s on s.enrolid = l.enrolid`,
          `  group by l.line_no, l.enrolid;`,
          ``,
          `  /* payments made INSIDE the line, on ELIGIBLE member-time. A payment in a`,
          `     month the denominator excludes would inflate PPPM: real dollars over`,
          `     fewer months. Excluded encounters are counted rather than dropped. */`,
          `  create table work._${num}_lot_paid as`,
          `  select l.line_no, l.enrolid,`,
          `         coalesce(sum(case when e.elig = 1 then e.paid else 0 end), 0) as paid_elig,`,
          `         coalesce(sum(case when e.elig = 0 then 1 else 0 end), 0) as enc_excluded`,
          `  from work._${num}_lot_lines as l`,
          `  inner join ${cohT} as a on a.enrolid = l.enrolid`,
          `  left join ${ledger.encounters} as e`,
          `    on  e.enrolid = l.enrolid`,
          `    and (e.encounter_date - a.index_date) between l.line_start and l.line_end`,
          `  group by l.line_no, l.enrolid;`,
          ``,
          `  create table work._${num}_lot_agg0 as`,
          `  select l.line_no, count(*) as n_pts,`,
          `         sum(m.eligible_days) as elig_days,`,
          `         sum(k.paid_elig) as paid_elig,`,
          `         sum(k.enc_excluded) as enc_excluded,`,
          `         mean(l.next_line_start - l.line_start) as mean_to_next,`,
          `         sum(l.next_line_start ne .) as n_advancing,`,
          `         sum(l.closed_by = 'gap') as n_gap,`,
          `         sum(l.closed_by = 'substitution') as n_sub,`,
          `         sum(l.closed_by = 'addition') as n_add,`,
          `         sum(l.closed_by = 'open_at_window_end') as n_open`,
          `  from work._${num}_lot_lines as l`,
          `  inner join work._${num}_lot_mm as m`,
          `    on m.line_no = l.line_no and m.enrolid = l.enrolid`,
          `  inner join work._${num}_lot_paid as k`,
          `    on k.line_no = l.line_no and k.enrolid = l.enrolid`,
          `  group by l.line_no;`,
          ``,
          `  create table work._${num}_lot_rsz as`,
          `  select line_no, count(*) / count(distinct enrolid) as mean_size`,
          `  from work._${num}_lot_reg group by line_no;`,
          ``,
          `  create table work._${num}_lot_out as`,
          `  select n.line_no,`,
          `         coalesce(a.n_pts, 0) as n_pts,`,
          `         coalesce(a.elig_days, 0) as elig_days,`,
          `         coalesce(a.paid_elig, 0) as paid_elig,`,
          `         coalesce(a.enc_excluded, 0) as enc_excluded,`,
          `         a.mean_to_next,`,
          `         coalesce(a.n_advancing, 0) as n_advancing,`,
          `         coalesce(a.n_gap, 0) as n_gap,`,
          `         coalesce(a.n_sub, 0) as n_sub,`,
          `         coalesce(a.n_add, 0) as n_add,`,
          `         coalesce(a.n_open, 0) as n_open,`,
          `         z.mean_size`,
          `  from work._${num}_lot_nums as n`,
          `  left join work._${num}_lot_agg0 as a on a.line_no = n.line_no`,
          `  left join work._${num}_lot_rsz as z on z.line_no = n.line_no;`,
          ``,
          `  create table work._${num}_lot_regagg as`,
          `  select line_no, agent, count(*) as n_pts`,
          `  from work._${num}_lot_reg group by line_no, agent;`,
          ``,
          `  create table work._${num}_lot_cross as`,
          `  select n.line_no, g.agent_no, g.agent`,
          `  from work._${num}_lot_nums as n, work._${num}_lot_agents as g;`,
          ``,
          `  create table work._${num}_lot_regout as`,
          `  select c.line_no, c.agent_no, c.agent, coalesce(r.n_pts, 0) as n_pts`,
          `  from work._${num}_lot_cross as c`,
          `  left join work._${num}_lot_regagg as r`,
          `    on r.line_no = c.line_no and r.agent = c.agent;`,
          ``,
          `  create table work._${num}_lot_tr as`,
          `  select count(*) as n_truncated from work._${num}_lot_trunc;`,
          `quit;`,
          ``,
        ]
      : []),
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
    `data ${lc ? `work._${num}_rows0` : outT};`,
    /* WIDER COLUMNS ONLY ON THE CONSTRUCTED ARM. SAS truncates a character
       variable silently at its declared length, and the strengthened caveat
       plus the per-line statistic names both overrun the two-line widths. The
       arm that does not need the room emits the identical LENGTH statement it
       emitted before. */
    lc
      ? `  length measure $24 component $18 statistic $64 method $1400;`
      : `  length measure $24 component $18 statistic $32 method $600;`,
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
    /* THE CAVEAT GETS STRONGER, not weaker, once the full construction runs:
       three declared parameters instead of one, and a per-line PPPM figure that
       looks like a measurement in a way "n reaching line 2" never did. */
    lc
      ? `  method='DEFINITIONAL, NOT MEASURED, AND THIS RULE HAS THREE DECLARED PARAMETERS: a COMBINATION WINDOW of ${lc.combinationWindowDays} days (agents starting within it join the same line), a GAP of ${lc.gapDays} days (uncovered days that close a line), and an ADVANCE TRIGGER of "${lc.advanceTrigger}" (whether adding an agent to a covered regimen starts a new line). Those three move the line count more than anything else here, none has a defensible default, and none is discoverable from claims. Two protocols applying different values to identical claims will BOTH be correct and disagree. This program implements ONE declared rule and both twins implement THE SAME ONE. Do not report a line number, a line-${lc.maxLines} count or a PPPM by line without all three parameters beside it'; output;`
      : `  method='DEFINITIONAL, NOT MEASURED. A line of therapy is whatever the protocol says it is, and the same patient carries a different line number under each definition. This program implements ONE declared rule (${an.lineRule}) and both twins implement THE SAME ONE. Execution cannot tell you the rule matches your protocol. Do not report a line number without the definition beside it'; output;`,
    `  keep measure component statistic ord estimate method;`,
    `run;`,
    ``,
    ...(lc ? sasLineRows(num, outT, lc, dpm) : []),
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
