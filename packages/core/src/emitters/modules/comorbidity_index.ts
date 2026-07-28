/**
 * Weighted comorbidity index — Charlson, Elixhauser, or a protocol's own.
 *
 * Deliberately NOT a Charlson module. Two things are true at once:
 *
 *  - the SCORING is where the errors are, and it is identical across indices:
 *    ascertain conditions in a lookback, apply a hierarchy so that a severe
 *    condition's weight replaces rather than adds to its milder form, sum;
 *  - the WEIGHTS and CODES are published research that a code generator has no
 *    business inventing. Charlson's ICD-10 sets run to hundreds of codes and
 *    differ by published algorithm, and even the weights are not agreed across
 *    secondary sources — a survey of them puts "uncontrolled diabetes" at 3
 *    while the Deyo/Quan administrative implementations score diabetes WITH
 *    CHRONIC COMPLICATIONS at 2. Bundling either would be a plausible-looking
 *    constant that silently shifts every adjusted estimate downstream.
 *
 * So the conditions, weights and hierarchy all come from the reviewed spec, and
 * this module implements the algebra. `supersedes` makes the hierarchy DECLARED
 * rather than hardcoded, which is what turns a Charlson module into an index
 * engine: severe liver replaces mild, complicated diabetes replaces
 * uncomplicated, metastatic tumour replaces any malignancy — and a bespoke
 * index states its own rules the same way.
 *
 * A superseded condition still reports its PREVALENCE. Only its weight is
 * withheld. Suppressing the prevalence too would hide a real clinical fact
 * behind a scoring convention.
 *
 * Verified vs Gold Case A: five planted conditions exercising BOTH hierarchy
 * directions — P03 has uncomplicated AND complicated diabetes and scores 2 (not
 * 3); P05 has mild AND severe liver disease and scores 3 (not 4). Cohort scores
 * are 1,1,2,1,3,3,0,0,0,0 -> mean 1.1, median 1, max 3. Hand-derived, asserted
 * in verify/run.ts.
 */
import type { ComorbidityIndexAnalysis } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, sq, INCLUDE_SETUP } from "../sas-base";
import {
  comorbidityScoreSasScore,
  comorbidityScoreSasSteps,
  comorbidityScoreSqlCtes,
  supersessionPairs,
} from "../comorbidity";
import {
  comorbidityIndexLimitations,
  comorbidityIndexParity,
  parityStamp,
  scoreBandLabels,
  COMORBIDITY_INDEX_METHOD_NOTES,
} from "../parity";

const MEASURE = "comorbidity_index";

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlComorbidityIndex(ctx: SqlCtx, an: ComorbidityIndexAnalysis, suffix: string): SqlModuleFile {
  const { d, wp } = ctx;
  const out = `${wp}_cci${suffix}`;
  const pairs = supersessionPairs(an);
  const bands = scoreBandLabels(an.scoreBands);

  const L: string[] = [];
  L.push(`-- ${parityStamp("comorbidity_index", comorbidityIndexParity(an, { pairs, bands }))}`);
  const limits = comorbidityIndexLimitations(an);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of COMORBIDITY_INDEX_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(`-- The weights and code lists below come from the REVIEWED SPEC, not from`);
  L.push(`-- this generator. "${q(an.indexName)}" is the label the analyst attached to them.`);

  L.push(d.createTableAs(out));
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${wp}_cohort),`);
  // ONE implementation of the scoring, shared with Table 1 and the SMD table
  // (emitters/comorbidity.ts) — three copies would be three chances to disagree.
  const score = comorbidityScoreSqlCtes(ctx, { wp, an, cohortCte: "cohort" });
  L.push(...score.lines);
  const bandCase = (val: (b: { lower: number; label: string }, i: number) => string): string => {
    const arms = bands
      .map((b, i) => ({ b, i }))
      .slice(1)
      .reverse()
      .map(({ b, i }) => `WHEN score >= ${b.lower} THEN ${val(b, i)}`);
    return `CASE ${arms.join(" ")} ELSE ${val(bands[0], 0)} END`;
  };
  L.push(`banded AS (`);
  L.push(`  SELECT enrolid, score,`);
  L.push(`         ${bandCase((b) => `'${q(b.label)}'`)} AS band,`);
  L.push(`         ${bandCase((_b, i) => String(i))} AS band_ord`);
  L.push(`  FROM ${score.scoreCte}`);
  L.push(`),`);
  L.push(`n AS (SELECT COUNT(*) AS denominator FROM cohort)`);
  L.push(`SELECT '${MEASURE}' AS measure, component, category, ord, patients, denominator,`);
  L.push(`       ${d.roundN(`patients * 100.0 / NULLIF(denominator, 0)`, 2)} AS pct,`);
  L.push(`       weight, score_mean, score_sd, score_median, score_max, index_name`);
  L.push(`FROM (`);
  // 1. one row per condition — PREVALENCE, reported even when superseded
  L.push(`  SELECT 'condition' AS component, cd.cond_label AS category, cd.cond_ord AS ord,`);
  L.push(`         COUNT(h.enrolid) AS patients, (SELECT denominator FROM n) AS denominator,`);
  L.push(`         CAST(cd.weight AS DOUBLE PRECISION) AS weight,`);
  L.push(`         CAST(NULL AS DOUBLE PRECISION) AS score_mean, CAST(NULL AS DOUBLE PRECISION) AS score_sd,`);
  L.push(`         CAST(NULL AS DOUBLE PRECISION) AS score_median, CAST(NULL AS DOUBLE PRECISION) AS score_max,`);
  L.push(`         '${q(an.indexName)}' AS index_name`);
  L.push(`  FROM cond cd LEFT JOIN has h ON h.cond_id = cd.cond_id`);
  L.push(`  GROUP BY cd.cond_label, cd.cond_ord, cd.weight`);
  L.push(`  UNION ALL`);
  // 2. score-band distribution
  L.push(`  SELECT 'score_band', band, 100 + band_ord,`);
  L.push(`         COUNT(*), (SELECT denominator FROM n),`);
  L.push(`         CAST(NULL AS DOUBLE PRECISION),`);
  L.push(`         CAST(NULL AS DOUBLE PRECISION), CAST(NULL AS DOUBLE PRECISION),`);
  L.push(`         CAST(NULL AS DOUBLE PRECISION), CAST(NULL AS DOUBLE PRECISION),`);
  L.push(`         '${q(an.indexName)}'`);
  L.push(`  FROM banded GROUP BY band, band_ord`);
  L.push(`  UNION ALL`);
  // 3. the index itself. Median only — see the resource-use module for why no
  //    quartile is ever emitted (PERCENTILE_CONT and PCTLDEF=5 agree at p=0.5).
  L.push(`  SELECT 'index', 'Overall', 200,`);
  L.push(`         COUNT(*), (SELECT denominator FROM n),`);
  L.push(`         CAST(NULL AS DOUBLE PRECISION),`);
  L.push(`         AVG(CAST(score AS DOUBLE PRECISION)),`);
  L.push(`         STDDEV_SAMP(CAST(score AS DOUBLE PRECISION)),`);
  L.push(`         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(score AS DOUBLE PRECISION)),`);
  L.push(`         MAX(CAST(score AS DOUBLE PRECISION)),`);
  L.push(`         '${q(an.indexName)}'`);
  L.push(`  FROM ${score.scoreCte}`);
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: condition prevalence, score-band distribution, and the index itself.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY ord;`);

  return {
    slug: `cci${suffix}`,
    title: `Comorbidity index${suffix ? ` (${an.label})` : ""}`,
    subtitle: `${an.indexName}: condition prevalence, score bands, and the weighted index`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); index "${an.indexName}".`,
      `${an.conditions.length} condition(s), ${pairs.length} supersession rule(s), weights and codes from the reviewed spec.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasComorbidityIndex(ctx: SasCtx, an: ComorbidityIndexAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_cci${suffix}`);
  const cohT = ctx.finalCohort;
  const pairs = supersessionPairs(an);
  const bands = scoreBandLabels(an.scoreBands);
  const limits = comorbidityIndexLimitations(an);
  const label = an.label.replace(/"/g, "'");
  // same shared scorer the SQL twin and (later) Table 1 / SMD use
  const score = comorbidityScoreSasSteps(ctx, { an, num, cohT, evOf: ctx.evOf });

  const lines: string[] = [
    ...header(spec, `${num}_cci${suffix}.sas`, [
      `Weighted comorbidity index "${an.indexName}" for "${an.label}":`,
      `condition prevalence, the score-band distribution, and the index.`,
      `Weights, code lists and the supersession hierarchy all come from the`,
      `REVIEWED SPEC - this program implements the algebra, not the research.`,
      `Twin of the SQL cci program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("comorbidity_index", comorbidityIndexParity(an, { pairs, bands }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...COMORBIDITY_INDEX_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    ...score.lines,
    ...levelCheck(`work._${num}_has`, "member x condition rows"),
    ``,
    ...comorbidityScoreSasScore(num, cohT),
    `data work._${num}_banded;`,
    `  set work._${num}_perpt;`,
    `  length band $16;`,
    ...bands
      .map((b, i) => ({ b, i }))
      .slice(1)
      .reverse()
      .map(({ b, i }, k) => `  ${k === 0 ? "if" : "else if"} score >= ${b.lower} then do; band = "${sq(b.label)}"; band_ord = ${i}; end;`),
    `  else do; band = "${sq(bands[0].label)}"; band_ord = 0; end;`,
    `run;`,
    ``,
    `/*-------------------- assemble the three row groups -------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_denom as select count(*) as denominator from ${cohT};`,
    ``,
    `  create table work._${num}_r1 as`,
    `  select 'condition' as component length=12, cd.cond_label as category length=60,`,
    `         cd.cond_ord as ord, count(h.enrolid) as patients, cd.weight`,
    `  from work._${num}_cond as cd`,
    `  left join work._${num}_has as h on h.cond_id = cd.cond_id`,
    `  group by cd.cond_label, cd.cond_ord, cd.weight;`,
    ``,
    `  create table work._${num}_r2 as`,
    `  select 'score_band' as component length=12, band as category length=60,`,
    `         100 + band_ord as ord, count(*) as patients`,
    `  from work._${num}_banded group by band, band_ord;`,
    `quit;`,
    ``,
    `/* PCTLDEF=5 stated explicitly - it is the definition that reproduces the SQL`,
    `   twin's PERCENTILE_CONT at p = 0.5 (see the resource-use module header). */`,
    `proc univariate data=work._${num}_perpt pctldef=5 noprint;`,
    `  var score;`,
    `  output out=work._${num}_r3`,
    `    n=patients mean=score_mean std=score_sd median=score_median max=score_max;`,
    `run;`,
    ``,
    `data work._${num}_r3b;`,
    `  set work._${num}_r3;`,
    `  length component $12 category $60;`,
    `  component = 'index';`,
    `  category  = 'Overall';`,
    `  ord       = 200;`,
    `run;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_r1 work._${num}_r2 work._${num}_r3b;`,
    `  length measure $20 index_name $40;`,
    `  measure    = "${MEASURE}";`,
    `  index_name = "${sq(an.indexName)}";`,
    `  if _n_ = 1 then set work._${num}_denom;`,
    `  if denominator > 0 then pct = round(100 * patients / denominator, 0.01);`,
    `  score_mean   = round(score_mean, 0.00001);`,
    `  score_sd     = round(score_sd, 0.00001);`,
    `  score_median = round(score_median, 0.00001);`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by ord;`,
    `run;`,
    ``,
    `title "Comorbidity index (${sq(an.indexName)}): ${label}";`,
    `proc print data=${outT} noobs;`,
    `  var measure component category patients denominator pct weight`,
    `      score_mean score_sd score_median score_max index_name;`,
    `run;`,
    ``,
  );

  return {
    path: `sas/${num}_cci${suffix}.sas`,
    language: "sas",
    title: `${num} Comorbidity index${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const comorbidityIndexModule: AnalysisModule<ComorbidityIndexAnalysis> = {
  analysisKind: "comorbidity_index",
  stampKind: "comorbidity_index",
  resultSlug: "cci",
  sql: sqlComorbidityIndex,
  sas: sasComorbidityIndex,
};
