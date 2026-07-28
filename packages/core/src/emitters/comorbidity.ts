/**
 * Comorbidity scoring — the shared chain, extracted so the index has exactly ONE
 * implementation across every consumer.
 *
 * Three places need a per-patient comorbidity score and they run at different
 * points in the bundle: the comorbidity-index analysis itself, the Table 1 row,
 * and the SMD balance table. Table 1 is emitted by the cohort spine, BEFORE any
 * analysis module, so it cannot read the index module's output table — which
 * leaves either three copies of the scoring logic, or one shared emitter.
 *
 * Three copies would be the same correctness hazard rate-core and the ledger
 * were extracted to remove, and worse here: a Table 1 that scored P03 as 3 while
 * the index analysis scored them 2 would put two different comorbidity means in
 * one deliverable, each internally consistent, with nothing to flag the
 * disagreement.
 *
 * The extraction is behaviour-preserving BY CONSTRUCTION: with the default empty
 * prefix these helpers emit the strings the module already emitted, and the
 * refactor was gated on a byte-identity diff of all 62 generated files.
 */
import type { ComorbidityIndexAnalysis, StudySpec } from "../spec/types";
import { q, windowConds } from "./sql-base";
import type { Ctx as SqlCtx } from "./sql-base";
import { sq, windowConds as sasWindowConds } from "./sas-base";
import type { Ctx as SasCtx } from "./sas-base";

/** winner -> loser pairs, flattened from every condition's `supersedes`. */
export function supersessionPairs(an: ComorbidityIndexAnalysis): Array<{ winner: string; loser: string }> {
  const out: Array<{ winner: string; loser: string }> = [];
  for (const c of an.conditions) for (const loser of c.supersedes ?? []) out.push({ winner: c.id, loser });
  return out;
}

/**
 * The comorbidity-index analysis a baseline characteristic points at.
 *
 * Returns null rather than throwing when the reference is missing or disabled,
 * so the consumer can emit a visible SKIPPED note instead of a broken program —
 * the spec validator is where a dangling reference is refused.
 */
export function indexAnalysisFor(spec: StudySpec, analysisId: string | undefined): ComorbidityIndexAnalysis | null {
  if (!analysisId) return null;
  const a = spec.analyses.find((x) => x.id === analysisId && x.kind === "comorbidity_index");
  return a && a.kind === "comorbidity_index" ? a : null;
}

/* ================================================================== *
 *  SQL
 * ================================================================== */

export interface ComorbidityScoreSqlInput {
  wp: string;
  an: ComorbidityIndexAnalysis;
  /** name of the already-defined CTE holding (enrolid, index_date) */
  cohortCte: string;
  /** prefix for every emitted CTE name, so several consumers can coexist in one
   *  WITH clause without colliding. Empty preserves the original emission. */
  prefix?: string;
}

/**
 * CTE chain from the condition definitions through a per-patient `score`.
 * Returns the lines (each ending in `,` so the caller keeps appending) plus the
 * name of the CTE that holds `(enrolid, score)`.
 */
export function comorbidityScoreSqlCtes(
  ctx: SqlCtx,
  i: ComorbidityScoreSqlInput,
): { lines: string[]; scoreCte: string } {
  const { d } = ctx;
  const { an, cohortCte } = i;
  const p = i.prefix ?? "";
  const cond = `${p}cond`;
  const sup = `${p}sup`;
  const has = `${p}has`;
  const applied = `${p}applied`;
  const perPt = `${p}per_pt`;
  const pairs = supersessionPairs(an);
  const L: string[] = [];

  L.push(`${cond} AS (   -- condition definitions, as declared in the spec`);
  an.conditions.forEach((c, n) => {
    const head = n === 0 ? `  ` : `  UNION ALL `;
    // Aliases repeated on every branch: redundant to SQL, but it makes the row
    // unambiguously scrapeable by the fingerprint (a label containing a comma
    // otherwise looks exactly like the next column).
    L.push(`${head}SELECT '${q(c.id)}' AS cond_id, '${q(c.label)}' AS cond_label, ${c.weight} AS weight, ${n} AS cond_ord`);
  });
  L.push(`),`);
  L.push(`${sup} AS (   -- hierarchy: the winner's presence withholds the loser's WEIGHT`);
  if (pairs.length === 0) {
    L.push(`  -- no supersession declared for this index`);
    L.push(`  SELECT CAST(NULL AS VARCHAR) AS winner, CAST(NULL AS VARCHAR) AS loser WHERE 1 = 0`);
  } else {
    pairs.forEach((pr, n) => {
      const head = n === 0 ? `  ` : `  UNION ALL `;
      L.push(`${head}SELECT '${q(pr.winner)}' AS winner, '${q(pr.loser)}' AS loser`);
    });
  }
  L.push(`),`);
  L.push(`${has} AS (   -- one row per member per condition present in the lookback`);
  an.conditions.forEach((c, n) => {
    const w = windowConds(an.lookback, "e.event_date", "c.index_date", d);
    const head = n === 0 ? `  ` : `  UNION ALL `;
    L.push(`${head}SELECT DISTINCT c.enrolid, '${q(c.id)}'${n === 0 ? ` AS cond_id` : ``}`);
    L.push(`  FROM ${cohortCte} c JOIN ${i.wp}_events e ON e.enrolid = c.enrolid`);
    L.push(`   AND e.code_list_id = '${q(c.codeListId)}'`);
    for (const cd of w) L.push(`   AND ${cd}`);
  });
  L.push(`),`);
  L.push(`${applied} AS (   -- weight actually contributed, after the hierarchy`);
  L.push(`  SELECT h.enrolid, h.cond_id, cd.weight,`);
  L.push(`         CASE WHEN EXISTS (`);
  L.push(`                SELECT 1 FROM ${sup} s`);
  L.push(`                JOIN ${has} h2 ON h2.enrolid = h.enrolid AND h2.cond_id = s.winner`);
  L.push(`                WHERE s.loser = h.cond_id)`);
  L.push(`              THEN 0 ELSE cd.weight END AS weight_applied`);
  L.push(`  FROM ${has} h JOIN ${cond} cd ON cd.cond_id = h.cond_id`);
  L.push(`),`);
  L.push(`${perPt} AS (   -- every cohort member scores, including the zeros`);
  L.push(`  SELECT c.enrolid, COALESCE(SUM(a.weight_applied), 0) AS score`);
  L.push(`  FROM ${cohortCte} c LEFT JOIN ${applied} a ON a.enrolid = c.enrolid`);
  L.push(`  GROUP BY c.enrolid`);
  L.push(`),`);
  return { lines: L, scoreCte: perPt };
}

/* ================================================================== *
 *  SAS
 * ================================================================== */

export interface ComorbidityScoreSasInput {
  an: ComorbidityIndexAnalysis;
  /** work-table stem, e.g. the program number */
  num: string;
  /** final-cohort table reference */
  cohT: string;
  /** resolve a code-list id to its pulled events table */
  evOf: (listId: string) => string;
}

/** SAS twin: statements producing a per-patient score dataset. */
export function comorbidityScoreSasSteps(
  _ctx: SasCtx,
  i: ComorbidityScoreSasInput,
): { lines: string[]; scoreTable: string; hasTable: string; condTable: string } {
  const { an, num, cohT } = i;
  const pairs = supersessionPairs(an);
  const L: string[] = [];

  L.push(
    `/*-------------------- condition definitions (from the spec) -----------------*/`,
    `data work._${num}_cond;`,
    `  length cond_id $32 cond_label $60;`,
    ...an.conditions.map(
      (c, n) => `  cond_id = "${sq(c.id)}"; cond_label = "${sq(c.label)}"; weight = ${c.weight}; cond_ord = ${n}; output;`,
    ),
    `run;`,
    ``,
    `/*-------------------- supersession hierarchy --------------------------------*/`,
    `/* A winner's presence withholds the loser's WEIGHT. The loser's prevalence is`,
    `   still reported - a scoring convention must not hide a clinical fact. */`,
    `data work._${num}_sup;`,
    `  length winner $32 loser $32;`,
    ...(pairs.length === 0
      ? [`  /* no supersession declared for this index */`, `  stop;`]
      : pairs.map((p) => `  winner = "${sq(p.winner)}"; loser = "${sq(p.loser)}"; output;`)),
    `run;`,
    ``,
    `/*-------------------- conditions present in the lookback --------------------*/`,
    `proc datasets lib=work nolist nowarn; delete _${num}_has; quit;`,
    ``,
    ...an.conditions.flatMap((c) => [
      `proc sql;`,
      `  create table work._${num}_h as`,
      `  select distinct a.enrolid, "${sq(c.id)}" as cond_id length=32`,
      `  from ${cohT} as a`,
      `  inner join ${i.evOf(c.codeListId)} as e`,
      `    on  e.enrolid = a.enrolid`,
      ...sasWindowConds(an.lookback, "e").map((l) => `    ${l}`),
      `  ;`,
      `quit;`,
      ``,
      `proc append base=work._${num}_has data=work._${num}_h force;`,
      `run;`,
      ``,
    ]),
  );
  return {
    lines: L,
    scoreTable: `work._${num}_perpt`,
    hasTable: `work._${num}_has`,
    condTable: `work._${num}_cond`,
  };
}

/** The scoring step itself (hierarchy + sum), separated so callers can insert
 *  their own level checks between the pull and the score. */
export function comorbidityScoreSasScore(num: string, cohT: string): string[] {
  return [
    `/*-------------------- apply the hierarchy, then score ------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_applied as`,
    `  select h.enrolid, h.cond_id, cd.weight,`,
    `         case when exists (`,
    `                select 1 from work._${num}_sup as s`,
    `                inner join work._${num}_has as h2`,
    `                  on  h2.enrolid = h.enrolid`,
    `                  and h2.cond_id = s.winner`,
    `                where s.loser = h.cond_id)`,
    `              then 0 else cd.weight end as weight_applied`,
    `  from work._${num}_has as h`,
    `  inner join work._${num}_cond as cd`,
    `    on cd.cond_id = h.cond_id;`,
    `quit;`,
    ``,
    `/* every cohort member scores, including the zeros */`,
    `proc sql;`,
    `  create table work._${num}_perpt as`,
    `  select a.enrolid, coalesce(sum(b.weight_applied), 0) as score`,
    `  from ${cohT} as a`,
    `  left join work._${num}_applied as b`,
    `    on b.enrolid = a.enrolid`,
    `  group by a.enrolid;`,
    `quit;`,
    ``,
  ];
}
