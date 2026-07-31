/**
 * Adherence and persistence.
 *
 * The largest gap in the roadmap, and the one a real HEOR study is most likely
 * to hit. Everything here is arithmetic on drug-supply intervals
 * (emitters/interval-core.ts), so nothing is deferred to SAS.
 *
 * THE MEASURES COME IN PAIRS, AND THE DIFFERENCE IS THE FINDING.
 *
 *   PDC vs MPR. PDC counts DISTINCT DAYS COVERED; MPR counts DAYS DISPENSED.
 *   PDC <= MPR always, with equality exactly when nothing overlaps — so their
 *   difference is a direct measure of early refilling. The module emits the
 *   relation as a CHECKED ROW, not as a claim: it is an identity, and if it ever
 *   fails the interval merge is broken.
 *
 *   PDC with vs without STOCKPILING. Refilling early does not mean taking double
 *   doses, so a common assumption is that a new supply starts only when the last
 *   runs out. On Gold Case F, patient P2 has PDC 13/18 = 0.722 without it and
 *   1.000 with it — opposite sides of the conventional 0.8 cut-point, from one
 *   unstated choice. Both are computed and labelled.
 *
 *   PERSISTENCE vs adherence. A patient who takes half their doses evenly and a
 *   patient who stops after two months can have the SAME PDC. On Gold Case F,
 *   P3's PDC equals its MPR exactly (2/3, nothing overlaps) and only the
 *   persistence measure reveals that they stopped on day 60.
 *
 * DISCONTINUATION IS AN EVENT; RUNNING OUT OF WINDOW IS NOT. A patient still
 * covered when the window closes is CENSORED, not persistent-forever, and the
 * result keeps the two apart. Collapsing them turns "still on treatment when we
 * stopped looking" into "never stopped".
 *
 * Verified vs Gold Case F: coverage 180 / 130 / 120 / 30 days over a 180-day
 * window, giving PDC 1, 13/18, 2/3, 1/6 against MPR 1, 1, 2/3, 1/6; one patient
 * adherent at 0.8 without stockpiling and two with it; three discontinuations
 * (days 130, 60, 30) and one censored.
 */
import type { AdherenceAnalysis } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, INCLUDE_SETUP } from "../sas-base";
import { intervalSqlCtes, gapSqlCtes, intervalSasSteps } from "../interval-core";
import {
  parityStamp,
  adherenceLimitations,
  adherenceParity,
  ADHERENCE_METHOD_NOTES,
} from "../parity";

const MEASURE = "adherence";
const ORD_DESIGN = 0;
const ORD_ADH = 10;
const ORD_STOCK = 20;
const ORD_PERSIST = 30;
const ORD_IDENT = 40;

function bounds(an: AdherenceAnalysis): { w0: number; w1: number; len: number } {
  const w0 = typeof an.window.start === "number" ? an.window.start : 0;
  const w1 = typeof an.window.end === "number" ? an.window.end : 364;
  return { w0, w1, len: w1 - w0 + 1 };
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlAdherence(ctx: SqlCtx, an: AdherenceAnalysis, suffix: string): SqlModuleFile {
  const { d, wp } = ctx;
  const out = `${wp}_adh${suffix}`;
  const { w0, w1, len } = bounds(an);
  const L: string[] = [];

  L.push(`-- ${parityStamp("adherence", adherenceParity(an, { windowStart: w0, windowEnd: w1, windowDays: len }))}`);
  const limits = adherenceLimitations(an);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of ADHERENCE_METHOD_NOTES) L.push(`--   * ${note}`);

  const C: string[] = [];
  C.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${wp}_cohort),`);
  C.push(`fills AS (   -- dispensings of the measured drug, per cohort member`);
  C.push(`  SELECT c.enrolid, c.index_date, f.fill_date AS fill_start, f.days_supply`);
  C.push(`  FROM cohort c`);
  C.push(`  JOIN ${wp}_fills f ON f.enrolid = c.enrolid AND f.code_list_id = '${q(an.drugCodeListId)}'`);
  C.push(`),`);
  C.push(...intervalSqlCtes(ctx, { fillsCte: "fills", windowStartDay: w0, windowEndDay: w1 }));
  C.push(...gapSqlCtes({ mergedCte: "ivm", windowStartDay: w0, windowEndDay: w1, permissibleGap: an.permissibleGapDays }));

  /* Per patient: covered days (merged), dispensed days (raw), stockpiled days. */
  C.push(`pt AS (`);
  C.push(`  SELECT c.enrolid,`);
  C.push(`         COALESCE(cov.covered, 0) AS covered,`);
  C.push(`         COALESCE(sup.dispensed, 0) AS dispensed,`);
  C.push(`         COALESCE(stk.stocked, 0) AS stocked,`);
  C.push(`         g.disc_day`);
  C.push(`  FROM cohort c`);
  C.push(`  LEFT JOIN (SELECT enrolid, SUM(GREATEST(m_end - m_start + 1, 0)) AS covered`);
  C.push(`             FROM ivm GROUP BY enrolid) cov ON cov.enrolid = c.enrolid`);
  /* MPR's numerator is days DISPENSED inside the window, clipped so a fill near`
   * the window edge cannot contribute supply that falls outside it. Without the
   * clip MPR can exceed 1 for a reason that has nothing to do with overlap. */
  C.push(`  LEFT JOIN (SELECT enrolid, SUM(LEAST(d_end, ${w1}) - GREATEST(d_start, ${w0}) + 1) AS dispensed`);
  C.push(`             FROM ivw GROUP BY enrolid) sup ON sup.enrolid = c.enrolid`);
  C.push(`  LEFT JOIN (SELECT enrolid, SUM(GREATEST(s_end - s_start + 1, 0)) AS stocked`);
  C.push(`             FROM ivs GROUP BY enrolid) stk ON stk.enrolid = c.enrolid`);
  C.push(`  LEFT JOIN firstgap g ON g.enrolid = c.enrolid`);
  C.push(`),`);
  C.push(`pt2 AS (`);
  C.push(`  SELECT enrolid, covered, dispensed, stocked, disc_day,`);
  C.push(`         covered * 1.0 / ${len} AS pdc,`);
  C.push(`         dispensed * 1.0 / ${len} AS mpr,`);
  C.push(`         stocked * 1.0 / ${len} AS pdc_stock,`);
  /* Persistence: days to discontinuation, or the whole window when the patient
   * is still covered at the end — which is CENSORING, kept distinct below. */
  C.push(`         COALESCE(disc_day - ${w0}, ${len}) AS persistence_days,`);
  C.push(`         CASE WHEN disc_day IS NULL THEN 0 ELSE 1 END AS discontinued`);
  C.push(`  FROM pt`);
  C.push(`),`);
  C.push(`agg AS (`);
  C.push(`  SELECT COUNT(*) AS n,`);
  C.push(`         AVG(pdc) AS mean_pdc, AVG(mpr) AS mean_mpr, AVG(pdc_stock) AS mean_pdc_stock,`);
  C.push(`         SUM(CASE WHEN pdc >= ${an.adherenceThreshold} THEN 1 ELSE 0 END) AS n_adherent,`);
  C.push(`         SUM(CASE WHEN pdc_stock >= ${an.adherenceThreshold} THEN 1 ELSE 0 END) AS n_adherent_stock,`);
  C.push(`         SUM(discontinued) AS n_discontinued,`);
  C.push(`         COUNT(*) - SUM(discontinued) AS n_censored,`);
  C.push(`         AVG(persistence_days) AS mean_persistence,`);
  C.push(`         SUM(CASE WHEN pdc > mpr + 1e-9 THEN 1 ELSE 0 END) AS n_pdc_gt_mpr,`);
  C.push(`         SUM(CASE WHEN ABS(pdc - mpr) < 1e-9 THEN 1 ELSE 0 END) AS n_pdc_eq_mpr`);
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

  parts.push(row("design", "patients", ORD_DESIGN, `CAST(n AS NUMERIC)`, `'cohort members measured'`));
  parts.push(row("design", "window_days", ORD_DESIGN + 1, `CAST(${len} AS NUMERIC)`,
    `'denominator for PDC and MPR: days ${w0} through ${w1} inclusive'`));

  parts.push(row("adherence", "mean_pdc", ORD_ADH, d.roundN(`mean_pdc`, 5),
    `'proportion of days covered - DISTINCT days, so overlapping fills are counted once'`));
  parts.push(row("adherence", "mean_mpr", ORD_ADH + 1, d.roundN(`mean_mpr`, 5),
    `'medication possession ratio - days DISPENSED, so overlap is counted twice. Always >= PDC'`));
  parts.push(row("adherence", "n_adherent", ORD_ADH + 2, `CAST(n_adherent AS NUMERIC)`,
    `'patients with PDC >= ${an.adherenceThreshold}. That cut-point is a CONVENTION, not a fact'`));
  parts.push(row("adherence", "pct_adherent", ORD_ADH + 3, d.roundN(`n_adherent * 100.0 / NULLIF(n, 0)`, 2),
    `'as above, as a percentage'`));

  /* STOCKPILING, beside the same measure without it. */
  parts.push(row("stockpiled", "mean_pdc_stockpiled", ORD_STOCK, d.roundN(`mean_pdc_stock`, 5),
    `'PDC assuming an early refill is started only when the current supply runs out. The difference from mean_pdc above is entirely early refilling'`));
  parts.push(row("stockpiled", "n_adherent_stockpiled", ORD_STOCK + 1, `CAST(n_adherent_stock AS NUMERIC)`,
    `'patients clearing the same threshold under stockpiling'`));
  parts.push(row("stockpiled", "reclassified_by_stockpiling", ORD_STOCK + 2,
    `CAST(n_adherent_stock - n_adherent AS NUMERIC)`,
    `CASE WHEN n_adherent_stock <> n_adherent` +
    ` THEN 'PATIENTS WHOSE ADHERENCE CLASSIFICATION DEPENDS ENTIRELY ON THIS ASSUMPTION. Stockpiling is a modelling choice, not a property of the data, and for these patients it decides the answer. State which convention the study used'` +
    ` ELSE 'no patient changes classification under stockpiling here' END`));

  /* PERSISTENCE, with censoring kept distinct from discontinuation. */
  parts.push(row("persistence", "n_discontinued", ORD_PERSIST, `CAST(n_discontinued AS NUMERIC)`,
    `'patients with a gap of at least ${an.permissibleGapDays} uncovered days'`));
  parts.push(row("persistence", "n_censored", ORD_PERSIST + 1, `CAST(n_censored AS NUMERIC)`,
    `'STILL COVERED when the window closed. This is censoring, NOT persistence forever - a table that merged these two would report "never stopped" for patients we simply stopped watching'`));
  parts.push(row("persistence", "mean_persistence_days", ORD_PERSIST + 2, d.roundN(`mean_persistence`, 5),
    `'mean days to discontinuation, with censored patients contributing the full window. Read it beside n_censored: with censoring present this is a BIASED estimate of true persistence, and a survival analysis on the same event is the unbiased one'`));

  /* THE IDENTITY. PDC <= MPR is a theorem about the merge, not a finding. */
  parts.push(row("identity", "patients_with_pdc_above_mpr", ORD_IDENT, `CAST(n_pdc_gt_mpr AS NUMERIC)`,
    `CASE WHEN n_pdc_gt_mpr = 0` +
    ` THEN 'HOLDS: PDC <= MPR for every patient. This is an identity, not a finding - distinct days covered cannot exceed days dispensed - so a nonzero count here would mean the interval merge is broken, not that the population is unusual'` +
    ` ELSE 'BROKEN: some patient has PDC above MPR, which is impossible. The interval merge is wrong - do not report these numbers' END`));
  parts.push(row("identity", "patients_with_pdc_equal_mpr", ORD_IDENT + 1, `CAST(n_pdc_eq_mpr AS NUMERIC)`,
    `'patients whose fills never overlap. For them the two measures agree exactly, and the adherence figures carry no information the other does not'`));

  parts.forEach((rowsOut, i) => {
    if (i > 0) L.push(`  UNION ALL`);
    L.push(...rowsOut);
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: read the 'stockpiled' rows beside the 'adherence' ones. Their`);
  L.push(`-- difference is a modelling choice, not a property of the data.`);
  L.push(`SELECT * FROM ${out} ORDER BY ord;`);

  return {
    slug: `adh${suffix}`,
    title: `Adherence${suffix ? ` (${an.label})` : ""}`,
    subtitle: `PDC / MPR / persistence over ${len} days (nothing deferred to SAS)`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); drug list "${an.drugCodeListId}".`,
      `Window ${describeWindow(an.window)}; permissible gap ${an.permissibleGapDays}d; threshold ${an.adherenceThreshold}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasAdherence(ctx: SasCtx, an: AdherenceAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_adh${suffix}`);
  const cohT = ctx.finalCohort;
  const { w0, w1, len } = bounds(an);
  const lbl = an.label.replace(/"/g, "'");
  const limits = adherenceLimitations(an);
  const rxT = ctx.tbl("020_rx");

  const lines: string[] = [
    ...header(spec, `${num}_adh${suffix}.sas`, [
      `Adherence and persistence for "${an.label}".`,
      `PDC counts DISTINCT days covered; MPR counts days DISPENSED. PDC <= MPR`,
      `always, and their difference is a direct measure of early refilling.`,
      `STOCKPILING is computed alongside, because on the same fills it can move a`,
      `patient across the adherence threshold - it is a modelling choice, not a`,
      `property of the data.`,
      `SAS-PRIMARY: nothing.`,
      `Twin of the SQL adh program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("adherence", adherenceParity(an, { windowStart: w0, windowEnd: w1, windowDays: len }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...ADHERENCE_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
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
    `quit;`,
    ``,
    ...intervalSasSteps({ num, fillsT: rxT, windowStartDay: w0, windowEndDay: w1 }),
    ``,
    `/*-------------------- gaps and discontinuation -------------------------------*/`,
    `proc sort data=work._${num}_ivm; by enrolid m_start; run;`,
    ``,
    `data work._${num}_gaps;`,
    `  set work._${num}_ivm;`,
    `  by enrolid;`,
    `  /* a gap runs from the day after an island ends to the day before the next`,
    `     begins; the last island's gap runs to the window end */`,
    `  next_start = ifn(last.enrolid, ${w1} + 1, lead_start);`,
    `  set work._${num}_ivm (firstobs=2 keep=m_start rename=(m_start=lead_start))`,
    `      work._${num}_ivm (obs=1 drop=_all_);`,
    `  g_start = m_end + 1;`,
    `  g_end   = ifn(last.enrolid, ${w1}, lead_start - 1);`,
    `  g_len   = g_end - m_end;`,
    `  if g_len >= ${an.permissibleGapDays};`,
    `  keep enrolid g_start;`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_firstgap as`,
    `  select enrolid, min(g_start) as disc_day from work._${num}_gaps group by enrolid;`,
    ``,
    `/*-------------------- per-patient measures -----------------------------------*/`,
    `  create table work._${num}_pt as`,
    `  select c.enrolid,`,
    `         coalesce(cov.covered, 0) as covered,`,
    `         coalesce(sup.dispensed, 0) as dispensed,`,
    `         coalesce(stk.stocked, 0) as stocked,`,
    `         g.disc_day`,
    `  from work._${num}_cohort as c`,
    `  left join (select enrolid, sum(max(m_end - m_start + 1, 0)) as covered`,
    `             from work._${num}_ivm group by enrolid) as cov on cov.enrolid = c.enrolid`,
    `  left join (select enrolid, sum(min(d_end, ${w1}) - max(d_start, ${w0}) + 1) as dispensed`,
    `             from work._${num}_ivw group by enrolid) as sup on sup.enrolid = c.enrolid`,
    `  left join (select enrolid, sum(max(s_end - s_start + 1, 0)) as stocked`,
    `             from work._${num}_ivs group by enrolid) as stk on stk.enrolid = c.enrolid`,
    `  left join work._${num}_firstgap as g on g.enrolid = c.enrolid;`,
    `quit;`,
    ``,
    `data work._${num}_pt2;`,
    `  set work._${num}_pt;`,
    `  pdc       = covered / ${len};`,
    `  mpr       = dispensed / ${len};`,
    `  pdc_stock = stocked / ${len};`,
    `  /* still covered at the window end is CENSORING, not persistence forever */`,
    `  persistence_days = ifn(disc_day = ., ${len}, disc_day - ${w0});`,
    `  discontinued     = (disc_day ne .);`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_pt2`, "patients measured", [`mean(pdc) as mean_pdc`]),
    ``,
    `proc sql;`,
    `  create table work._${num}_agg as`,
    `  select count(*) as n,`,
    `         mean(pdc) as mean_pdc, mean(mpr) as mean_mpr, mean(pdc_stock) as mean_pdc_stock,`,
    `         sum(pdc >= ${an.adherenceThreshold}) as n_adherent,`,
    `         sum(pdc_stock >= ${an.adherenceThreshold}) as n_adherent_stock,`,
    `         sum(discontinued) as n_discontinued,`,
    `         count(*) - sum(discontinued) as n_censored,`,
    `         mean(persistence_days) as mean_persistence,`,
    `         sum(pdc > mpr + 1e-9) as n_pdc_gt_mpr,`,
    `         sum(abs(pdc - mpr) < 1e-9) as n_pdc_eq_mpr`,
    `  from work._${num}_pt2;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  length measure $20 component $12 statistic $32 method $340;`,
    `  set work._${num}_agg;`,
    `  measure = "${MEASURE}";`,
    `  component='design'; statistic='patients'; ord=${ORD_DESIGN}; estimate=n;`,
    `  method='cohort members measured'; output;`,
    `  statistic='window_days'; ord=${ORD_DESIGN + 1}; estimate=${len};`,
    `  method='denominator for PDC and MPR: days ${w0} through ${w1} inclusive'; output;`,
    `  component='adherence'; statistic='mean_pdc'; ord=${ORD_ADH}; estimate=round(mean_pdc, 0.00001);`,
    `  method='proportion of days covered - DISTINCT days, so overlapping fills are counted once'; output;`,
    `  statistic='mean_mpr'; ord=${ORD_ADH + 1}; estimate=round(mean_mpr, 0.00001);`,
    `  method='medication possession ratio - days DISPENSED, so overlap is counted twice. Always >= PDC'; output;`,
    `  statistic='n_adherent'; ord=${ORD_ADH + 2}; estimate=n_adherent;`,
    `  method='patients with PDC >= ${an.adherenceThreshold}. That cut-point is a CONVENTION, not a fact'; output;`,
    `  statistic='pct_adherent'; ord=${ORD_ADH + 3}; estimate=round(100 * n_adherent / n, 0.01);`,
    `  method='as above, as a percentage'; output;`,
    `  component='stockpiled'; statistic='mean_pdc_stockpiled'; ord=${ORD_STOCK}; estimate=round(mean_pdc_stock, 0.00001);`,
    `  method='PDC assuming an early refill is started only when the current supply runs out'; output;`,
    `  statistic='n_adherent_stockpiled'; ord=${ORD_STOCK + 1}; estimate=n_adherent_stock;`,
    `  method='patients clearing the same threshold under stockpiling'; output;`,
    `  statistic='reclassified_by_stockpiling'; ord=${ORD_STOCK + 2}; estimate=n_adherent_stock - n_adherent;`,
    `  if n_adherent_stock ne n_adherent then method='PATIENTS WHOSE ADHERENCE CLASSIFICATION DEPENDS ENTIRELY ON THIS ASSUMPTION. Stockpiling is a modelling choice, not a property of the data';`,
    `  else method='no patient changes classification under stockpiling here'; output;`,
    `  component='persistence'; statistic='n_discontinued'; ord=${ORD_PERSIST}; estimate=n_discontinued;`,
    `  method='patients with a gap of at least ${an.permissibleGapDays} uncovered days'; output;`,
    `  statistic='n_censored'; ord=${ORD_PERSIST + 1}; estimate=n_censored;`,
    `  method='STILL COVERED when the window closed. This is censoring, NOT persistence forever'; output;`,
    `  statistic='mean_persistence_days'; ord=${ORD_PERSIST + 2}; estimate=round(mean_persistence, 0.00001);`,
    `  method='mean days to discontinuation, with censored patients contributing the full window. With censoring present this is BIASED; a survival analysis on the same event is the unbiased one'; output;`,
    `  component='identity'; statistic='patients_with_pdc_above_mpr'; ord=${ORD_IDENT}; estimate=n_pdc_gt_mpr;`,
    `  if n_pdc_gt_mpr = 0 then method='HOLDS: PDC <= MPR for every patient. This is an identity, not a finding, so a nonzero count would mean the interval merge is broken';`,
    `  else method='BROKEN: some patient has PDC above MPR, which is impossible. The interval merge is wrong - do not report these numbers'; output;`,
    `  statistic='patients_with_pdc_equal_mpr'; ord=${ORD_IDENT + 1}; estimate=n_pdc_eq_mpr;`,
    `  method='patients whose fills never overlap. For them the two measures agree exactly'; output;`,
    `  keep measure component statistic ord estimate method;`,
    `run;`,
    ``,
    `proc sort data=${outT}; by ord; run;`,
    ``,
    `title "Adherence and persistence: ${lbl}";`,
    `proc print data=${outT} noobs; run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_adh${suffix}.sas`,
    language: "sas",
    title: `${num} Adherence${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const adherenceModule: AnalysisModule<AdherenceAnalysis> = {
  analysisKind: "adherence",
  stampKind: "adherence",
  resultSlug: "adh",
  sql: sqlAdherence,
  sas: sasAdherence,
};
