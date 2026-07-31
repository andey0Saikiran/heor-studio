/**
 * interval-core — the drug-supply interval algebra.
 *
 * Every adherence and persistence measure is arithmetic on the same object: a
 * set of [start, end] intervals, one per pharmacy fill, and the questions asked
 * of them are "how many distinct days are covered", "where are the gaps", and
 * "what happens if we assume a patient finishes one supply before starting the
 * next". Those three answers are what separate PDC from MPR from persistence,
 * and getting the interval handling wrong moves all of them at once.
 *
 * THREE OPERATIONS, and each has a trap.
 *
 * 1. MERGE overlapping fills into islands. The island boundary must be found by
 *    comparing each fill's start against the RUNNING MAXIMUM of all prior ends,
 *    not against the PREVIOUS row's end. A fill wholly nested inside an earlier
 *    one has a small end, and LAG would compare against that and wrongly open a
 *    new island. This project already paid for that lesson once, in enrollment
 *    stitching (fixture patient P13 exists precisely to pin it), and the same
 *    shape recurs here.
 *
 * 2. CLIP to the measurement window. A fill dispensed on the last day of the
 *    window supplies days beyond it; those days are not covered time in this
 *    window and counting them inflates PDC above 1.
 *
 * 3. STOCKPILE — the assumption that a patient who refills early finishes the
 *    current supply first. Its definition is SEQUENTIAL:
 *
 *        start_k  = max(s_k, cursor_{k-1})
 *        cursor_k = start_k + supply_k
 *
 *    which reads like something warehouse SQL cannot do. It can. Unrolling the
 *    recursion:
 *
 *        cursor_k = max over j <= k of ( s_j + SUM(supply_j..supply_k) )
 *                 = max over j <= k of ( s_j - T_{j-1} ) + T_k
 *
 *    with T the cumulative supply. So it is a running MAX of (start minus prior
 *    cumulative supply), plus the running SUM — two window functions, no loop.
 *    Verified against the sequential definition on ragged supplies, same-day
 *    double fills and real gaps.
 *
 * WHY STOCKPILING IS NOT A DETAIL. On Gold Case F, patient P2 refills every 20
 * days on a 30-day supply. Without stockpiling PDC is 13/18 = 0.722; with it,
 * 1.000. The conventional adherence threshold is 0.8, so one unstated
 * methodological choice moves that patient from non-adherent to adherent. The
 * emitter therefore computes BOTH and labels which is which, rather than
 * picking one silently.
 *
 * Ref: Andrade et al. Pharmacoepidemiol Drug Saf 2006;15:565 (PDC vs MPR);
 * Canfield et al. J Manag Care Spec Pharm 2019;25:1073 (stockpiling and the
 * measurement choices that move it).
 */
import type { Ctx as SqlCtx } from "./sql-base";

/** The conventional PDC cut-point for "adherent". Pinned as a named constant
 *  because it is a CONVENTION, not a fact, and a study that uses a different
 *  one should have to say so rather than silently inherit this. */
export const ADHERENT_PDC_THRESHOLD = "0.8";

export interface IntervalSqlInput {
  /** CTE with one row per fill: enrolid, fill_start (DATE), days_supply (INT) */
  fillsCte: string;
  /** measurement window, as day offsets from index (inclusive both ends) */
  windowStartDay: number;
  windowEndDay: number;
  prefix?: string;
}

/**
 * `<p>iv`, `<p>ivm`, `<p>ivs` — raw intervals, MERGED islands, and the
 * STOCKPILED shift, all clipped to the measurement window.
 *
 * `<p>ivm` answers "distinct days covered" (PDC's numerator). `<p>ivs` answers
 * the same question under the stockpiling assumption. Both are emitted because
 * their difference is a study design decision, not a rounding difference.
 */
export function intervalSqlCtes(ctx: SqlCtx, i: IntervalSqlInput): string[] {
  const p = i.prefix ?? "";
  const f = i.fillsCte;
  const w0 = i.windowStartDay;
  const w1 = i.windowEndDay;
  const win = `PARTITION BY enrolid ORDER BY d_start, d_end`;
  const L: string[] = [];

  L.push(`${p}iv AS (   -- fills as day offsets from index, [start, end] inclusive`);
  L.push(`  SELECT enrolid,`);
  L.push(`         ${ctx.d.daysBetween("fill_start", "index_date")} AS d_start,`);
  L.push(`         -- end is start + supply - 1: a 30-day supply dispensed on day 0`);
  L.push(`         -- covers days 0..29, not 0..30. The off-by-one here is worth`);
  L.push(`         -- one day of PDC per fill, which compounds.`);
  L.push(`         ${ctx.d.daysBetween("fill_start", "index_date")} + days_supply - 1 AS d_end,`);
  L.push(`         days_supply`);
  L.push(`  FROM ${f}`);
  L.push(`),`);
  L.push(`${p}ivw AS (   -- keep only fills that touch the window [${w0}, ${w1}]`);
  L.push(`  SELECT * FROM ${p}iv WHERE d_end >= ${w0} AND d_start <= ${w1}`);
  L.push(`),`);

  /* --- MERGE: islands via the RUNNING MAX of prior ends --- */
  L.push(`${p}ivmark AS (`);
  L.push(`  -- A new island starts when this fill begins after EVERY prior fill has`);
  L.push(`  -- ended. Compare against the RUNNING MAXIMUM of prior ends, never`);
  L.push(`  -- against the previous row's end: a fill nested inside an earlier one`);
  L.push(`  -- has a small end, and LAG would see it and wrongly split the island.`);
  L.push(`  -- The enrollment-stitching defect this repo already fixed was exactly`);
  L.push(`  -- this shape.`);
  L.push(`  SELECT *,`);
  L.push(`         CASE WHEN d_start > COALESCE(`);
  L.push(`                MAX(d_end) OVER (${win} ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),`);
  L.push(`                d_start - 1)`);
  L.push(`              THEN 1 ELSE 0 END AS new_island`);
  L.push(`  FROM ${p}ivw`);
  L.push(`),`);
  L.push(`${p}ivgrp AS (`);
  L.push(`  SELECT *, SUM(new_island) OVER (${win} ROWS UNBOUNDED PRECEDING) AS island`);
  L.push(`  FROM ${p}ivmark`);
  L.push(`),`);
  L.push(`${p}ivm AS (   -- merged islands, CLIPPED to the window`);
  L.push(`  SELECT enrolid, island,`);
  L.push(`         GREATEST(MIN(d_start), ${w0}) AS m_start,`);
  L.push(`         LEAST(MAX(d_end), ${w1}) AS m_end`);
  L.push(`  FROM ${p}ivgrp GROUP BY enrolid, island`);
  L.push(`),`);

  /* --- STOCKPILE: the sequential rule, as two window functions --- */
  L.push(`${p}ivcum AS (`);
  L.push(`  -- STOCKPILING, closed form. The rule is sequential -`);
  L.push(`  --   start_k = max(s_k, cursor_{k-1});  cursor_k = start_k + supply_k`);
  L.push(`  -- but unrolls to`);
  L.push(`  --   cursor_k = MAX over j<=k of (s_j - T_{j-1}) + T_k`);
  L.push(`  -- with T the cumulative supply. Two window functions, no loop.`);
  L.push(`  SELECT *,`);
  L.push(`         SUM(days_supply) OVER (${win} ROWS UNBOUNDED PRECEDING) AS t_cum`);
  L.push(`  FROM ${p}ivw`);
  L.push(`),`);
  L.push(`${p}ivsm AS (`);
  L.push(`  SELECT *,`);
  L.push(`         MAX(d_start - (t_cum - days_supply)) OVER (${win} ROWS UNBOUNDED PRECEDING) AS u_max`);
  L.push(`  FROM ${p}ivcum`);
  L.push(`),`);
  L.push(`${p}ivs AS (   -- stockpiled intervals, clipped to the window`);
  L.push(`  SELECT enrolid,`);
  L.push(`         GREATEST(u_max + t_cum - days_supply, ${w0}) AS s_start,`);
  L.push(`         LEAST(u_max + t_cum - 1, ${w1}) AS s_end`);
  L.push(`  FROM ${p}ivsm`);
  L.push(`),`);
  return L;
}

/** Distinct days covered by the merged islands, within the window. */
export const COVERED_DAYS_SQL = `SUM(GREATEST(m_end - m_start + 1, 0))`;

/**
 * `<p>gap` — the FIRST gap of at least `permissibleGap` days, per patient.
 *
 * Persistence is the time to that gap; discontinuation is where the last supply
 * before it ran out. A patient with no such gap is PERSISTENT THROUGH THE
 * WINDOW, which is administrative censoring rather than an event — a
 * distinction the emitted result keeps, because collapsing it turns "still on
 * treatment when we stopped looking" into "never discontinued".
 */
export function gapSqlCtes(o: {
  mergedCte: string; windowStartDay: number; windowEndDay: number;
  permissibleGap: number; prefix?: string;
}): string[] {
  const p = o.prefix ?? "";
  return [
    `${p}gapc AS (   -- the gap FOLLOWING each island (or from the window start)`,
    `  SELECT enrolid, m_start, m_end,`,
    `         LEAD(m_start) OVER (PARTITION BY enrolid ORDER BY m_start) AS next_start`,
    `  FROM ${o.mergedCte}`,
    `),`,
    `${p}gaps AS (`,
    `  -- a gap runs from the day after an island ends to the day before the next`,
    `  -- one begins; the last island's gap runs to the window end.`,
    `  SELECT enrolid, m_end + 1 AS g_start,`,
    `         COALESCE(next_start - 1, ${o.windowEndDay}) AS g_end,`,
    `         COALESCE(next_start - 1, ${o.windowEndDay}) - m_end AS g_len`,
    `  FROM ${p}gapc`,
    `),`,
    `${p}firstgap AS (`,
    `  SELECT enrolid, MIN(g_start) AS disc_day`,
    `  FROM ${p}gaps`,
    `  WHERE g_len >= ${o.permissibleGap}`,
    `  GROUP BY enrolid`,
    `),`,
  ];
}

/* ------------------------------------------------------------------ *
 *  SAS
 * ------------------------------------------------------------------ */

/** The same three operations as DATA steps. SAS has a natural sequential idiom
 *  (RETAIN), so the stockpiling closed form is not needed here — but it is used
 *  anyway, deliberately, so that both twins compute the SAME expression and a
 *  divergence in one shows up as a divergence in the numbers rather than being
 *  absorbed by two different-but-correct implementations. */
export function intervalSasSteps(o: {
  num: string; fillsT: string; windowStartDay: number; windowEndDay: number;
}): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  Drug-supply intervals. A 30-day supply dispensed on day 0 covers days 0..29,`,
    `  so the end is start + supply - 1. That off-by-one is worth one day of PDC`,
    `  per fill and compounds across a year.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_iv as`,
    `  select a.enrolid,`,
    `         f.svcdate - a.index_date as d_start,`,
    `         f.svcdate - a.index_date + f.daysupp - 1 as d_end,`,
    `         f.daysupp as days_supply`,
    `  from ${o.fillsT} as f`,
    `  inner join work._${o.num}_cohort as a on a.enrolid = f.enrolid;`,
    ``,
    `  create table work._${o.num}_ivw as`,
    `  select * from work._${o.num}_iv`,
    `  where d_end >= ${o.windowStartDay} and d_start <= ${o.windowEndDay};`,
    `quit;`,
    ``,
    `proc sort data=work._${o.num}_ivw; by enrolid d_start d_end; run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  MERGE into islands. The island boundary is found against the RUNNING MAXIMUM`,
    `  of prior ends, not the previous row's end: a fill nested inside an earlier`,
    `  one has a small end, and comparing against it would wrongly split the`,
    `  island. This repo already fixed that exact defect in enrollment stitching.`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_ivgrp;`,
    `  set work._${o.num}_ivw;`,
    `  by enrolid;`,
    `  retain _maxend island;`,
    `  if first.enrolid then do; _maxend = .; island = 0; end;`,
    `  if _maxend = . or d_start > _maxend then island + 1;`,
    `  _maxend = max(_maxend, d_end);`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${o.num}_ivm as`,
    `  select enrolid, island,`,
    `         max(min(d_start), ${o.windowStartDay}) as m_start,`,
    `         min(max(d_end), ${o.windowEndDay}) as m_end`,
    `  from work._${o.num}_ivgrp`,
    `  group by enrolid, island;`,
    `quit;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  STOCKPILING, by the same CLOSED FORM the SQL twin uses rather than by the`,
    `  RETAIN loop SAS would make easy. Using the natural idiom here would mean the`,
    `  two twins computed the same quantity by different routes, and a defect in`,
    `  one would be absorbed rather than shown.`,
    `    cursor_k = MAX over j<=k of (s_j - T_{j-1}) + T_k`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_ivs;`,
    `  set work._${o.num}_ivw;`,
    `  by enrolid;`,
    `  retain t_cum u_max;`,
    `  if first.enrolid then do; t_cum = 0; u_max = .; end;`,
    `  t_cum = t_cum + days_supply;`,
    `  u_max = max(u_max, d_start - (t_cum - days_supply));`,
    `  s_start = max(u_max + t_cum - days_supply, ${o.windowStartDay});`,
    `  s_end   = min(u_max + t_cum - 1, ${o.windowEndDay});`,
    `  keep enrolid s_start s_end;`,
    `run;`,
  ];
}
