/**
 * lot-core — FULL LINE-OF-THERAPY CONSTRUCTION, shared by both twins.
 *
 * A line is a REGIMEN: the set of agents a patient is on together. Building one
 * from dispensings is interval work, so this file reuses the algebra
 * interval-core.ts already pins (merge by RUNNING MAX of prior ends, clip to the
 * window, gaps as the complement of the merged islands) rather than inventing a
 * second one. What is new here is only the SEQUENCING: which agents belong to
 * the regimen, when the regimen ends, and where the next one begins.
 *
 * THE RULE, stated once, implemented twice.
 *
 *   OPEN.  Line 1 opens at the first dispensing of any agent inside the window.
 *
 *   REGIMEN.  Every agent whose first dispensing AT OR AFTER the line's opening
 *   falls within `combinationWindowDays` of it joins THAT line. This is the
 *   parameter that decides whether a planned doublet is one line or two, and it
 *   is the reason Gold Case K carries a matched pair of patients differing only
 *   in whether the second agent lands inside the window.
 *
 *   CLOSE.  The line closes at the EARLIEST of
 *     - a gap: an uncovered stretch of `gapDays` or more in the union of the
 *       regimen agents' supply, measured from the line's opening;
 *     - a SUBSTITUTION: a dispensing of an agent NOT in the regimen on a day
 *       when at least one regimen agent has already run out;
 *     - an ADDITION: a dispensing of an agent not in the regimen while EVERY
 *       regimen agent is still covered — which advances the line only when
 *       `advanceTrigger` is "addition_or_substitution".
 *   A line that never closes is OPEN AT THE WINDOW END, which is censoring and
 *   is reported as such rather than as a completed line.
 *
 *   NEXT.  The next line opens at the first dispensing AT OR AFTER the close.
 *   For a substitution or addition that is the triggering dispensing itself;
 *   for a gap it is whatever restarts therapy after the gap. One rule covers
 *   both, so the two close reasons cannot drift apart.
 *
 *   STOP.  Construction stops after `maxLines`. Patients who would have gone
 *   further are COUNTED and reported, never dropped: a line distribution that
 *   silently truncates its own tail understates late-line burden and looks
 *   exactly like a cohort that simply did not progress.
 *
 * WHY THE CONSTRUCTION IS UNROLLED RATHER THAN RECURSIVE. `maxLines` is a
 * declared bound, so the whole construction is a fixed number of steps known at
 * emit time. Unrolling it means the SQL twin needs no recursive CTE and the SAS
 * twin needs no macro loop, and the two are then the SAME sequence of set
 * operations rather than two different control structures that happen to agree
 * on this fixture. That is the same argument interval-core makes for computing
 * stockpiling in closed form on BOTH sides.
 *
 * WHAT NONE OF THIS CAN FIX. Claims record dispensings, not intent. Every
 * number this file produces is a consequence of three declared parameters, and
 * two protocols applying different ones to identical claims will both be
 * correct and disagree. The module that consumes these CTEs says so, in both
 * languages, beside the count.
 */
import type { Ctx as SqlCtx } from "./sql-base";
import { q } from "./sql-base";
import type { LineConstruction } from "../spec/types";

/** Everything the construction consumes, resolved by the caller. */
export interface LotInput {
  lc: LineConstruction;
  /** measurement window as day offsets from index, inclusive both ends */
  windowStartDay: number;
  windowEndDay: number;
}

/** A trigger day counts when this predicate holds.
 *
 *  Written so that BOTH variants reference `is_sub`: the "substitution" rule
 *  needs it, and the wider rule states it as an explicit `IN (0, 1)` rather
 *  than dropping the column. A trigger that stopped referencing the flag would
 *  be indistinguishable from one that never computed it, and the fingerprint
 *  below is what turns a silent flip of this parameter into a failure. */
export function lotTriggerPredicateSql(t: LineConstruction["advanceTrigger"]): string {
  return t === "substitution" ? `is_sub = 1` : `is_sub IN (0, 1)`;
}

export function lotTriggerPredicateSas(t: LineConstruction["advanceTrigger"]): string {
  return t === "substitution" ? `is_sub = 1` : `is_sub in (0, 1)`;
}

/** Human sentence for the advance trigger, used in both twins' method text. */
export function lotTriggerLabel(t: LineConstruction["advanceTrigger"]): string {
  return t === "substitution"
    ? `only a SUBSTITUTION advances the line: an agent starting while a regimen agent has already stopped. Adding an agent to a fully covered regimen is intensification WITHIN the line`
    : `either a SUBSTITUTION or an ADDITION advances the line. This is the stricter reading and produces MORE lines on identical claims than the substitution-only rule`;
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

/**
 * CTEs from `lot_ag` through `lot_lines` / `lot_reg` / `lot_trunc`.
 *
 * The caller owns the `WITH` keyword and must already have defined a `cohort`
 * CTE carrying (enrolid, index_date). Every emitted CTE keeps its trailing
 * comma, matching rate-core and interval-core.
 */
export function lotSqlCtes(
  ctx: SqlCtx,
  i: LotInput & { wp: string; keepClause: string; cohortCte: string },
): string[] {
  const { d } = ctx;
  const { combinationWindowDays: CW, gapDays: GD, maxLines: ML, agentCodeListIds } = i.lc;
  const w0 = i.windowStartDay;
  const w1 = i.windowEndDay;
  /* One day past the window end, used as the "did not close" sentinel so that
   * LEAST() can be taken over both close reasons without a three-way CASE. It
   * is converted back to NULL immediately, because a close day of w1+1 read as
   * a real close would give every uncensored line a phantom successor. */
  const NONE = w1 + 1;
  const agents = agentCodeListIds.map((a) => `'${q(a)}'`).join(", ");
  const win = `PARTITION BY enrolid ORDER BY d_start, d_end`;
  const L: string[] = [];

  L.push(`lot_ag AS (   -- agent dispensings, as day offsets from each patient's OWN index`);
  L.push(`  SELECT c.enrolid, f.code_list_id AS agent,`);
  L.push(`         ${d.daysBetween("f.fill_date", "c.index_date")} AS d_start,`);
  L.push(`         -- start + supply - 1: a 30-day supply on day 0 covers days 0..29.`);
  L.push(`         -- The same off-by-one the adherence and switching modules use.`);
  L.push(`         ${d.daysBetween("f.fill_date", "c.index_date")} + f.days_supply - 1 AS d_end`);
  L.push(`  FROM ${i.cohortCte} c`);
  L.push(`  JOIN ${i.wp}_fills f ON f.enrolid = c.enrolid AND f.code_list_id IN (${agents})`);
  L.push(`  WHERE ${i.keepClause}`);
  L.push(`),`);
  L.push(`lot_agw AS (   -- dispensings INSIDE the window; supply clipped at the window end`);
  L.push(`  -- A dispensing before the window does not open a line here, and supply`);
  L.push(`  -- running past the window end is not coverage this study observed.`);
  L.push(`  SELECT enrolid, agent, d_start, LEAST(d_end, ${w1}) AS d_end`);
  L.push(`  FROM lot_ag WHERE d_start >= ${w0} AND d_start <= ${w1}`);
  L.push(`),`);
  L.push(`lot_l1 AS (   -- LINE 1 opens at the first dispensing of any agent`);
  L.push(`  SELECT enrolid, MIN(d_start) AS t FROM lot_agw GROUP BY enrolid`);
  L.push(`),`);

  for (let k = 1; k <= ML; k++) {
    const open = `lot_l${k}`;
    L.push(`/* ---- line ${k} ---------------------------------------------------- */`);
    L.push(`lot_r${k}0 AS (   -- each agent's FIRST dispensing at or after line ${k}'s opening`);
    L.push(`  SELECT o.enrolid, a.agent, MIN(a.d_start) AS agent_first`);
    L.push(`  FROM ${open} o`);
    L.push(`  JOIN lot_agw a ON a.enrolid = o.enrolid AND a.d_start >= o.t`);
    L.push(`  GROUP BY o.enrolid, a.agent`);
    L.push(`),`);
    L.push(`lot_r${k} AS (   -- THE REGIMEN: agents starting within ${CW} days of the opening`);
    L.push(`  -- This is the combination window. Too short and a planned doublet reads`);
    L.push(`  -- as an immediate progression; too long and a genuine next line is`);
    L.push(`  -- absorbed into this one. Neither is more correct - it is declared.`);
    L.push(`  SELECT r.enrolid, r.agent, r.agent_first`);
    L.push(`  FROM lot_r${k}0 r JOIN ${open} o ON o.enrolid = r.enrolid`);
    L.push(`  WHERE r.agent_first <= o.t + ${CW}`);
    L.push(`),`);
    L.push(`lot_c${k} AS (   -- the regimen's supply intervals, from the opening onward`);
    L.push(`  SELECT a.enrolid, a.agent, a.d_start, a.d_end`);
    L.push(`  FROM lot_agw a`);
    L.push(`  JOIN lot_r${k} r ON r.enrolid = a.enrolid AND r.agent = a.agent`);
    L.push(`  JOIN ${open} o ON o.enrolid = a.enrolid AND a.d_start >= o.t`);
    L.push(`),`);
    L.push(`lot_m${k}mark AS (   -- island break against the RUNNING MAX of prior ends`);
    L.push(`  -- Never against the previous row's end: an interval nested inside an`);
    L.push(`  -- earlier one has a small end, and LAG would open a spurious island -`);
    L.push(`  -- which here would invent a treatment gap and close the line early.`);
    L.push(`  SELECT *,`);
    L.push(`         CASE WHEN d_start > COALESCE(`);
    L.push(`                MAX(d_end) OVER (${win} ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),`);
    L.push(`                d_start - 1)`);
    L.push(`              THEN 1 ELSE 0 END AS new_island`);
    L.push(`  FROM lot_c${k}`);
    L.push(`),`);
    L.push(`lot_m${k}grp AS (`);
    L.push(`  SELECT *, SUM(new_island) OVER (${win} ROWS UNBOUNDED PRECEDING) AS island`);
    L.push(`  FROM lot_m${k}mark`);
    L.push(`),`);
    L.push(`lot_m${k} AS (`);
    L.push(`  SELECT enrolid, island, MIN(d_start) AS m_start, MAX(d_end) AS m_end`);
    L.push(`  FROM lot_m${k}grp GROUP BY enrolid, island`);
    L.push(`),`);
    L.push(`lot_g${k}0 AS (   -- the uncovered stretch FOLLOWING each island`);
    L.push(`  SELECT enrolid, m_end + 1 AS g_start,`);
    L.push(`         COALESCE(LEAD(m_start) OVER (PARTITION BY enrolid ORDER BY m_start) - 1, ${w1}) - m_end AS g_len`);
    L.push(`  FROM lot_m${k}`);
    L.push(`),`);
    L.push(`lot_g${k} AS (   -- the first gap of at least ${GD} uncovered days`);
    L.push(`  SELECT enrolid, MIN(g_start) AS gap_day FROM lot_g${k}0`);
    L.push(`  WHERE g_len >= ${GD} GROUP BY enrolid`);
    L.push(`),`);
    L.push(`lot_n${k}0 AS (   -- dispensings of an agent NOT in the regimen, after the opening`);
    L.push(`  SELECT DISTINCT a.enrolid, a.d_start AS s`);
    L.push(`  FROM lot_agw a`);
    L.push(`  JOIN ${open} o ON o.enrolid = a.enrolid AND a.d_start > o.t`);
    L.push(`  LEFT JOIN lot_r${k} r ON r.enrolid = a.enrolid AND r.agent = a.agent`);
    L.push(`  WHERE r.agent IS NULL`);
    L.push(`),`);
    L.push(`lot_n${k}c AS (   -- how many regimen agents are STILL COVERED on that day`);
    L.push(`  SELECT n.enrolid, n.s, COUNT(DISTINCT c.agent) AS n_cov`);
    L.push(`  FROM lot_n${k}0 n`);
    L.push(`  LEFT JOIN lot_c${k} c`);
    L.push(`    ON c.enrolid = n.enrolid AND n.s >= c.d_start AND n.s <= c.d_end`);
    L.push(`  GROUP BY n.enrolid, n.s`);
    L.push(`),`);
    L.push(`lot_n${k}z AS (SELECT enrolid, COUNT(*) AS n_reg FROM lot_r${k} GROUP BY enrolid),`);
    L.push(`lot_n${k} AS (   -- SUBSTITUTION vs ADDITION, which is the whole of advanceTrigger`);
    L.push(`  -- A new agent arriving while every regimen agent is still covered is an`);
    L.push(`  -- ADDITION; one arriving after a regimen agent has run out is a`);
    L.push(`  -- SUBSTITUTION. Claims cannot see intent, so this is the only signal.`);
    L.push(`  SELECT v.enrolid, v.s,`);
    L.push(`         CASE WHEN v.n_cov < z.n_reg THEN 1 ELSE 0 END AS is_sub`);
    L.push(`  FROM lot_n${k}c v JOIN lot_n${k}z z ON z.enrolid = v.enrolid`);
    L.push(`),`);
    L.push(`lot_t${k}0 AS (   -- the first ADVANCING dispensing under the declared trigger`);
    L.push(`  SELECT enrolid, MIN(s) AS trig_day FROM lot_n${k}`);
    L.push(`  WHERE ${lotTriggerPredicateSql(i.lc.advanceTrigger)} GROUP BY enrolid`);
    L.push(`),`);
    L.push(`lot_t${k} AS (`);
    L.push(`  SELECT t.enrolid, t.trig_day, MAX(n.is_sub) AS trig_is_sub`);
    L.push(`  FROM lot_t${k}0 t JOIN lot_n${k} n ON n.enrolid = t.enrolid AND n.s = t.trig_day`);
    L.push(`  GROUP BY t.enrolid, t.trig_day`);
    L.push(`),`);
    L.push(`lot_x${k}0 AS (   -- the line closes at the EARLIEST of gap and trigger`);
    L.push(`  SELECT o.enrolid, o.t, g.gap_day, tr.trig_day, tr.trig_is_sub,`);
    L.push(`         LEAST(COALESCE(g.gap_day, ${NONE}), COALESCE(tr.trig_day, ${NONE})) AS close_raw`);
    L.push(`  FROM ${open} o`);
    L.push(`  LEFT JOIN lot_g${k} g ON g.enrolid = o.enrolid`);
    L.push(`  LEFT JOIN lot_t${k} tr ON tr.enrolid = o.enrolid`);
    L.push(`),`);
    L.push(`lot_x${k} AS (`);
    L.push(`  SELECT enrolid, t, gap_day, trig_day, trig_is_sub,`);
    L.push(`         CASE WHEN close_raw > ${w1} THEN NULL ELSE close_raw END AS close_day`);
    L.push(`  FROM lot_x${k}0`);
    L.push(`),`);
    /* The next opening, or - at the bound - the truncation count. ONE shape for
     * both, so a patient who would have reached line ML+1 is found by exactly
     * the same query that would have opened it. */
    const nextName = k === ML ? `lot_trunc` : `lot_l${k + 1}`;
    L.push(`${nextName} AS (   -- ${k === ML ? `patients who WOULD have opened line ${ML + 1}: the truncation count` : `line ${k + 1} opens at the first dispensing at or after the close`}`);
    L.push(`  SELECT x.enrolid, MIN(a.d_start) AS t`);
    L.push(`  FROM lot_x${k} x`);
    L.push(`  JOIN lot_agw a ON a.enrolid = x.enrolid AND a.d_start >= x.close_day`);
    L.push(`  WHERE x.close_day IS NOT NULL`);
    L.push(`  GROUP BY x.enrolid`);
    L.push(`),`);
  }

  /* One row per (patient, line), and one per (patient, line, agent). Stacking
   * the unrolled steps HERE rather than reporting each separately is what lets
   * every downstream aggregate be written once instead of maxLines times. */
  L.push(`lot_lines AS (   -- one row per patient per line reached`);
  for (let k = 1; k <= ML; k++) {
    if (k > 1) L.push(`  UNION ALL`);
    const nx = k === ML ? `lot_trunc` : `lot_l${k + 1}`;
    L.push(`  SELECT ${k} AS line_no, x.enrolid, x.t AS line_start,`);
    L.push(`         COALESCE(x.close_day - 1, ${w1}) AS line_end,`);
    L.push(`         nx.t AS next_line_start,`);
    L.push(`         CASE WHEN x.close_day IS NULL THEN 'open_at_window_end'`);
    L.push(`              WHEN x.gap_day IS NOT NULL AND x.gap_day <= COALESCE(x.trig_day, ${NONE}) THEN 'gap'`);
    L.push(`              WHEN x.trig_is_sub = 1 THEN 'substitution'`);
    L.push(`              ELSE 'addition' END AS closed_by`);
    L.push(`  FROM lot_x${k} x LEFT JOIN ${nx} nx ON nx.enrolid = x.enrolid`);
  }
  L.push(`),`);
  L.push(`lot_reg AS (   -- one row per patient per line per agent IN that line's regimen`);
  for (let k = 1; k <= ML; k++) {
    if (k > 1) L.push(`  UNION ALL`);
    L.push(`  SELECT ${k} AS line_no, enrolid, agent FROM lot_r${k}`);
  }
  L.push(`),`);
  return L;
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

/**
 * The SAME sequence of set operations as DATA steps and PROC SQL.
 *
 * Written step-for-step against the SQL above rather than in whatever idiom SAS
 * makes shortest, for the reason interval-core states about stockpiling: two
 * different-but-correct implementations absorb each other's defects, and the
 * point of a twin is that they do not.
 */
export function lotSasSteps(
  o: LotInput & { num: string; cohortT: string; evOf: (id: string) => string; keepClause: string },
): string[] {
  const { combinationWindowDays: CW, gapDays: GD, maxLines: ML, agentCodeListIds } = o.lc;
  const w0 = o.windowStartDay;
  const w1 = o.windowEndDay;
  const NONE = w1 + 1;
  const n = o.num;
  const L: string[] = [];

  L.push(
    `/*----------------------------------------------------------------------------`,
    `  LINE OF THERAPY, constructed. A line is a REGIMEN: the set of agents active`,
    `  together. The construction is UNROLLED to the declared maxLines (${ML}) rather`,
    `  than written as a macro loop, so this program is the same sequence of set`,
    `  operations the SQL twin performs and not a second control structure that`,
    `  happens to agree on one fixture.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${n}_lot_ag as`,
  );
  agentCodeListIds.forEach((id, k) => {
    L.push(
      `${k === 0 ? "  " : "  union all\n  "}select a.enrolid, "${id}" as agent length=64,`,
      `         f.svcdate - a.index_date as d_start,`,
      `         /* start + supply - 1: a 30-day supply on day 0 covers days 0..29 */`,
      `         f.svcdate - a.index_date + f.daysupp - 1 as d_end`,
      `  from ${o.evOf(id)} as f`,
      `  inner join ${o.cohortT} as a on a.enrolid = f.enrolid`,
      `  where ${o.keepClause}${k === agentCodeListIds.length - 1 ? ";" : ""}`,
    );
  });
  L.push(
    ``,
    `  /* inside the window; supply clipped at the window end */`,
    `  create table work._${n}_lot_agw as`,
    `  select enrolid, agent, d_start, min(d_end, ${w1}) as d_end`,
    `  from work._${n}_lot_ag`,
    `  where d_start >= ${w0} and d_start <= ${w1};`,
    ``,
    `  /* LINE 1 opens at the first dispensing of any agent */`,
    `  create table work._${n}_lot_l1 as`,
    `  select enrolid, min(d_start) as t from work._${n}_lot_agw group by enrolid;`,
    `quit;`,
    ``,
  );

  for (let k = 1; k <= ML; k++) {
    const open = `work._${n}_lot_l${k}`;
    L.push(
      `/*-------------------- line ${k} ----------------------------------------------*/`,
      `proc sql;`,
      `  create table work._${n}_lot_r${k}0 as`,
      `  select o.enrolid, a.agent, min(a.d_start) as agent_first`,
      `  from ${open} as o`,
      `  inner join work._${n}_lot_agw as a`,
      `    on a.enrolid = o.enrolid and a.d_start >= o.t`,
      `  group by o.enrolid, a.agent;`,
      ``,
      `  /* THE REGIMEN: agents starting within ${CW} days of the opening. This is`,
      `     the combination window, and it decides whether a planned doublet is one`,
      `     line or two. */`,
      `  create table work._${n}_lot_r${k} as`,
      `  select r.enrolid, r.agent, r.agent_first`,
      `  from work._${n}_lot_r${k}0 as r`,
      `  inner join ${open} as o on o.enrolid = r.enrolid`,
      `  where r.agent_first <= o.t + ${CW};`,
      ``,
      `  create table work._${n}_lot_c${k} as`,
      `  select a.enrolid, a.agent, a.d_start, a.d_end`,
      `  from work._${n}_lot_agw as a`,
      `  inner join work._${n}_lot_r${k} as r`,
      `    on r.enrolid = a.enrolid and r.agent = a.agent`,
      `  inner join ${open} as o on o.enrolid = a.enrolid and a.d_start >= o.t;`,
      `quit;`,
      ``,
      `proc sort data=work._${n}_lot_c${k}; by enrolid d_start d_end; run;`,
      ``,
      `/* island break against the RUNNING MAXIMUM of prior ends, never the previous`,
      `   row's end: a nested interval would otherwise invent a treatment gap and`,
      `   close the line early. */`,
      `data work._${n}_lot_mg${k};`,
      `  set work._${n}_lot_c${k};`,
      `  by enrolid;`,
      `  retain _maxend island;`,
      `  if first.enrolid then do; _maxend = .; island = 0; end;`,
      `  if _maxend = . or d_start > _maxend then island + 1;`,
      `  _maxend = max(_maxend, d_end);`,
      `run;`,
      ``,
      `proc sql;`,
      `  create table work._${n}_lot_m${k} as`,
      `  select enrolid, island, min(d_start) as m_start, max(d_end) as m_end`,
      `  from work._${n}_lot_mg${k}`,
      `  group by enrolid, island;`,
      `quit;`,
      ``,
      `proc sort data=work._${n}_lot_m${k}; by enrolid m_start; run;`,
      ``,
      `/* the uncovered stretch following each island; the last island's runs to the`,
      `   window end */`,
      `data work._${n}_lot_g${k}0;`,
      `  set work._${n}_lot_m${k};`,
      `  by enrolid;`,
      `  set work._${n}_lot_m${k} (firstobs=2 keep=m_start rename=(m_start=lead_start))`,
      `      work._${n}_lot_m${k} (obs=1 drop=_all_);`,
      `  g_start = m_end + 1;`,
      `  g_end   = ifn(last.enrolid, ${w1}, lead_start - 1);`,
      `  g_len   = g_end - m_end;`,
      `  keep enrolid g_start g_len;`,
      `run;`,
      ``,
      `proc sql;`,
      `  create table work._${n}_lot_g${k} as`,
      `  select enrolid, min(g_start) as gap_day`,
      `  from work._${n}_lot_g${k}0 where g_len >= ${GD} group by enrolid;`,
      ``,
      `  /* dispensings of an agent NOT in the regimen, after the opening */`,
      `  create table work._${n}_lot_n${k}0 as`,
      `  select distinct a.enrolid, a.d_start as s`,
      `  from work._${n}_lot_agw as a`,
      `  inner join ${open} as o on o.enrolid = a.enrolid and a.d_start > o.t`,
      `  left join work._${n}_lot_r${k} as r`,
      `    on r.enrolid = a.enrolid and r.agent = a.agent`,
      `  where r.agent = '';`,
      ``,
      `  /* how many regimen agents are STILL COVERED on that day */`,
      `  create table work._${n}_lot_n${k}c as`,
      `  select n.enrolid, n.s, count(distinct c.agent) as n_cov`,
      `  from work._${n}_lot_n${k}0 as n`,
      `  left join work._${n}_lot_c${k} as c`,
      `    on c.enrolid = n.enrolid and n.s >= c.d_start and n.s <= c.d_end`,
      `  group by n.enrolid, n.s;`,
      ``,
      `  create table work._${n}_lot_n${k}z as`,
      `  select enrolid, count(*) as n_reg from work._${n}_lot_r${k} group by enrolid;`,
      ``,
      `  /* SUBSTITUTION vs ADDITION - the whole of advanceTrigger. A new agent`,
      `     arriving while every regimen agent is still covered is an ADDITION; one`,
      `     arriving after a regimen agent ran out is a SUBSTITUTION. */`,
      `  create table work._${n}_lot_n${k} as`,
      `  select v.enrolid, v.s,`,
      `         (case when v.n_cov < z.n_reg then 1 else 0 end) as is_sub`,
      `  from work._${n}_lot_n${k}c as v`,
      `  inner join work._${n}_lot_n${k}z as z on z.enrolid = v.enrolid;`,
      ``,
      `  create table work._${n}_lot_t${k}0 as`,
      `  select enrolid, min(s) as trig_day from work._${n}_lot_n${k}`,
      `  where ${lotTriggerPredicateSas(o.lc.advanceTrigger)} group by enrolid;`,
      ``,
      `  create table work._${n}_lot_t${k} as`,
      `  select t.enrolid, t.trig_day, max(n.is_sub) as trig_is_sub`,
      `  from work._${n}_lot_t${k}0 as t`,
      `  inner join work._${n}_lot_n${k} as n`,
      `    on n.enrolid = t.enrolid and n.s = t.trig_day`,
      `  group by t.enrolid, t.trig_day;`,
      ``,
      `  /* the line closes at the EARLIEST of gap and trigger */`,
      `  create table work._${n}_lot_x${k}0 as`,
      `  select o.enrolid, o.t, g.gap_day, tr.trig_day, tr.trig_is_sub,`,
      `         min(coalesce(g.gap_day, ${NONE}), coalesce(tr.trig_day, ${NONE})) as close_raw`,
      `  from ${open} as o`,
      `  left join work._${n}_lot_g${k} as g on g.enrolid = o.enrolid`,
      `  left join work._${n}_lot_t${k} as tr on tr.enrolid = o.enrolid;`,
      `quit;`,
      ``,
      `data work._${n}_lot_x${k};`,
      `  set work._${n}_lot_x${k}0;`,
      `  if close_raw > ${w1} then close_day = .;`,
      `  else close_day = close_raw;`,
      `run;`,
      ``,
      `proc sql;`,
      `  create table work._${n}_${k === ML ? `lot_trunc` : `lot_l${k + 1}`} as`,
      `  select x.enrolid, min(a.d_start) as t`,
      `  from work._${n}_lot_x${k} as x`,
      `  inner join work._${n}_lot_agw as a`,
      `    on a.enrolid = x.enrolid and a.d_start >= x.close_day`,
      `  where x.close_day ne .`,
      `  group by x.enrolid;`,
      `quit;`,
      ``,
    );
  }

  L.push(
    `/*-------------------- stack the lines ---------------------------------------*/`,
    `proc sql;`,
    `  create table work._${n}_lot_lines as`,
  );
  for (let k = 1; k <= ML; k++) {
    const nx = k === ML ? `lot_trunc` : `lot_l${k + 1}`;
    L.push(
      `${k === 1 ? "  " : "  union all\n  "}select ${k} as line_no, x.enrolid, x.t as line_start,`,
      `         coalesce(x.close_day - 1, ${w1}) as line_end,`,
      `         nx.t as next_line_start,`,
      `         (case when x.close_day = . then 'open_at_window_end'`,
      `               when x.gap_day ne . and x.gap_day <= coalesce(x.trig_day, ${NONE}) then 'gap'`,
      `               when x.trig_is_sub = 1 then 'substitution'`,
      `               else 'addition' end) as closed_by length=20`,
      `  from work._${n}_lot_x${k} as x`,
      `  left join work._${n}_${nx} as nx on nx.enrolid = x.enrolid${k === ML ? ";" : ""}`,
    );
  }
  L.push(``, `  create table work._${n}_lot_reg as`);
  for (let k = 1; k <= ML; k++) {
    L.push(
      `${k === 1 ? "  " : "  union all\n  "}select ${k} as line_no, enrolid, agent`,
      `  from work._${n}_lot_r${k}${k === ML ? ";" : ""}`,
    );
  }
  L.push(`quit;`, ``);
  return L;
}
