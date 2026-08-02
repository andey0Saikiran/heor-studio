/**
 * Calendar-trend module — per-bucket prevalence over calendar time plus the
 * Cochran-Armitage test for a monotone linear trend in those proportions.
 *
 * Method (Cochran Biometrics 1954;10:417; Armitage Biometrics 1955;11:375):
 *   with bucket scores w_i (the 0-based ordinals), case counts r_i and bucket
 *   denominators n_i, N = SUM(n_i), R = SUM(r_i), pbar = R/N:
 *
 *     T   = SUM(w_i * r_i) - pbar * SUM(w_i * n_i)
 *     Var = pbar * (1 - pbar) * ( SUM(w_i^2 * n_i) - (SUM(w_i * n_i))^2 / N )
 *     z   = T / sqrt(Var)
 *
 * Every term is a sum over the bucket table, so **z is closed form and BOTH
 * twins compute it** — it is executed against the fixture and checked against a
 * hand-derived value, not merely fingerprinted. Only the two-sided p-value
 * inverts the normal CDF, so only THAT is SAS-primary (emitters/sas-primary.ts).
 *
 * This split is the point. The obvious move was to declare "the trend test" a
 * SAS-primary statistic wholesale and verify none of it. But the test statistic
 * and its p-value have different verifiability, and collapsing them would have
 * put a perfectly checkable number permanently outside execution verification.
 *
 * Bucket boundaries are generated in TypeScript (parity.trendBuckets) and
 * emitted as literals into both languages, so a SQL calendar generator and a SAS
 * macro loop can never disagree by a day.
 *
 * Verified vs Gold Case A: a_trend over 2018/2019/2020 gives 2/10, 3/10, 0/10;
 * scores 0,1,2 -> T = 3 - (1/6)(30) = -2, Var = (5/36)(50 - 900/30) = 25/9,
 * z = -2 / (5/3) = -1.2 EXACTLY. Hand-derived, asserted in verify/run.ts.
 */
import type { CalendarTrendAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, sasDate, sq, INCLUDE_SETUP } from "../sas-base";
import {
  calendarTrendLimitations,
  calendarTrendParity,
  outcomeSettingPlan,
  parityStamp,
  trendBuckets,
  CALENDAR_TREND_METHOD_NOTES,
} from "../parity";
import { SAS_PRIMARY_BY_KIND, methodColumnFor } from "../sas-primary";

/** Label carried in the `measure` column of every row this module emits. */
const MEASURE = "period_prevalence_trend";

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlCalendarTrend(ctx: SqlCtx, an: CalendarTrendAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_trend${suffix}`;
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const buckets = trendBuckets(spec, an.trend.bucket);
  const span = { start: buckets[0]?.start ?? spec.meta.studyPeriod.start, end: buckets[buckets.length - 1]?.end ?? spec.meta.studyPeriod.end };
  const primary = SAS_PRIMARY_BY_KIND.calendar_trend ?? [];

  const L: string[] = [];
  L.push(`-- ${parityStamp("calendar_trend", calendarTrendParity(an, { settingFilter: setting.stamped, buckets }))}`);
  const limits = calendarTrendLimitations(an, listSystem, buckets);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of CALENDAR_TREND_METHOD_NOTES) L.push(`--   * ${note}`);
  for (const c of primary) L.push(`-- SAS-PRIMARY: ${c.column} is NULL here BY CONTRACT - ${c.why}`);

  L.push(d.createTableAs(out));
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${ctx.cohortT}),`);
  L.push(
    `ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${q(clid)}'` +
      (setting.enforce ? ` AND setting = '${setting.enforce}'` : ``) +
      `),`,
  );
  L.push(`buckets AS (   -- ${an.trend.bucket} buckets, emitted as LITERALS so the SAS twin cannot generate different ones`);
  buckets.forEach((b, i) => {
    const head = i === 0 ? `  ` : `  UNION ALL `;
    const cols =
      i === 0
        ? `SELECT ${b.ord} AS bucket_ord, '${q(b.label)}' AS bucket, DATE '${b.start}' AS b_start, DATE '${b.end}' AS b_end, ${b.isPartial ? 1 : 0} AS is_partial`
        : `SELECT ${b.ord}, '${q(b.label)}', DATE '${b.start}', DATE '${b.end}', ${b.isPartial ? 1 : 0}`;
    L.push(`${head}${cols}`);
  });
  L.push(`),`);
  L.push(`den AS (   -- enrolled_anytime, bucket by bucket: stitched episode overlaps the bucket`);
  L.push(`  SELECT DISTINCT b.bucket_ord, b.bucket, c.enrolid`);
  L.push(`  FROM buckets b`);
  L.push(`  CROSS JOIN cohort c`);
  L.push(`  JOIN ${wp}_enroll_episodes ep`);
  L.push(`    ON ep.enrolid = c.enrolid`);
  L.push(`   AND ep.episode_start <= b.b_end`);
  L.push(`   AND ep.episode_end   >= b.b_start`);
  L.push(`),`);
  L.push(`cases AS (   -- >= 1 qualifying event DATED inside the bucket (no carry-in)`);
  L.push(`  SELECT DISTINCT dn.bucket_ord, dn.enrolid`);
  L.push(`  FROM den dn`);
  L.push(`  JOIN buckets b ON b.bucket_ord = dn.bucket_ord`);
  L.push(`  JOIN ae e ON e.enrolid = dn.enrolid`);
  L.push(`   AND e.event_date BETWEEN b.b_start AND b.b_end`);
  L.push(`),`);
  L.push(`per_bucket AS (`);
  L.push(`  SELECT dn.bucket_ord, dn.bucket, COUNT(*) AS denominator,`);
  L.push(`         COALESCE(SUM(CASE WHEN cs.enrolid IS NOT NULL THEN 1 ELSE 0 END), 0) AS patients`);
  L.push(`  FROM den dn`);
  L.push(`  LEFT JOIN cases cs ON cs.bucket_ord = dn.bucket_ord AND cs.enrolid = dn.enrolid`);
  L.push(`  GROUP BY dn.bucket_ord, dn.bucket`);
  L.push(`),`);
  L.push(`ca AS (   -- Cochran-Armitage sums; scores = the 0-based bucket ordinals`);
  L.push(`  SELECT SUM(patients) AS r_tot, SUM(denominator) AS n_tot,`);
  L.push(`         SUM(bucket_ord * patients) AS s_rw,`);
  L.push(`         SUM(bucket_ord * denominator) AS s_nw,`);
  L.push(`         SUM(bucket_ord * bucket_ord * denominator) AS s_nw2`);
  L.push(`  FROM per_bucket`);
  L.push(`),`);
  L.push(`ca2 AS (`);
  L.push(`  SELECT r_tot, n_tot,`);
  L.push(`         r_tot * 1.0 / NULLIF(n_tot, 0) AS pbar,`);
  L.push(`         s_rw - (r_tot * 1.0 / NULLIF(n_tot, 0)) * s_nw AS t_stat,`);
  L.push(`         (r_tot * 1.0 / NULLIF(n_tot, 0)) * (1 - r_tot * 1.0 / NULLIF(n_tot, 0))`);
  L.push(`           * (s_nw2 - s_nw * s_nw * 1.0 / NULLIF(n_tot, 0)) AS var_t`);
  L.push(`  FROM ca`);
  L.push(`)`);
  // Per-bucket rows carry the Wilson interval (identical closed form to the
  // prevalence modules, z = 1.96); the Trend row carries the statistic.
  L.push(`SELECT measure, bucket, bucket_ord, b_start, b_end, is_partial,`);
  L.push(`       patients, denominator, prevalence, prevalence_pct, ci_low, ci_high, ci_method,`);
  L.push(`       trend_method, trend_z, trend_p, ${methodColumnFor("trend_p")}`);
  L.push(`FROM (`);
  L.push(`  SELECT '${MEASURE}' AS measure, pb.bucket, pb.bucket_ord, b.b_start, b.b_end, b.is_partial,`);
  L.push(`         pb.patients, pb.denominator,`);
  L.push(`         ${d.roundN(`pb.patients * 1.0 / NULLIF(pb.denominator, 0)`, 5)} AS prevalence,`);
  L.push(`         ${d.roundN(`pb.patients * 100.0 / NULLIF(pb.denominator, 0)`, 2)} AS prevalence_pct,`);
  L.push(`         ${d.roundN(
    `GREATEST(0.0, (pb.patients + 1.9208 - 1.96*SQRT(1.0*pb.patients*(pb.denominator-pb.patients)/NULLIF(pb.denominator,0) + 0.9604)) / (pb.denominator + 3.8416))`,
    5,
  )} AS ci_low,`);
  L.push(`         ${d.roundN(
    `LEAST(1.0, (pb.patients + 1.9208 + 1.96*SQRT(1.0*pb.patients*(pb.denominator-pb.patients)/NULLIF(pb.denominator,0) + 0.9604)) / (pb.denominator + 3.8416))`,
    5,
  )} AS ci_high,`);
  L.push(`         CAST('wilson' AS VARCHAR) AS ci_method,`);
  L.push(`         CAST(NULL AS VARCHAR) AS trend_method,`);
  L.push(`         CAST(NULL AS NUMERIC) AS trend_z,`);
  L.push(`         CAST(NULL AS NUMERIC) AS trend_p,`);
  L.push(`         CAST(NULL AS VARCHAR) AS ${methodColumnFor("trend_p")}`);
  L.push(`  FROM per_bucket pb JOIN buckets b ON b.bucket_ord = pb.bucket_ord`);
  L.push(`  UNION ALL`);
  L.push(`  -- Trend row. Its counts are person-BUCKET sums (see the method note);`);
  L.push(`  -- trend_p is NULL BY CONTRACT and computed in the SAS twin.`);
  L.push(`  SELECT '${MEASURE}', 'Trend', ${buckets.length}, DATE '${span.start}', DATE '${span.end}', 0,`);
  L.push(`         r_tot, n_tot,`);
  L.push(`         ${d.roundN(`pbar`, 5)}, ${d.roundN(`pbar * 100.0`, 2)},`);
  L.push(`         CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS VARCHAR),`);
  L.push(`         CAST('cochran_armitage' AS VARCHAR),`);
  L.push(`         ${d.roundN(`t_stat / NULLIF(SQRT(var_t), 0)`, 5)},`);
  L.push(`         CAST(NULL AS NUMERIC),`);
  L.push(`         CAST('${primary[0]?.methodLabel ?? "sas_normal_cdf"}' AS VARCHAR)`);
  L.push(`  FROM ca2`);
  L.push(`) u`);
  L.push(`ORDER BY bucket_ord;`);
  L.push("");
  L.push(`-- REVIEW: per-bucket prevalence + the Cochran-Armitage trend row (bucket = 'Trend').`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY bucket_ord;`);

  return {
    slug: `trend${suffix}`,
    title: `Calendar trend${suffix ? ` (${an.label})` : ""}`,
    subtitle: `per-${an.trend.bucket.replace("calendar_", "")} prevalence + Cochran-Armitage trend test`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); outcome code list "${clid}".`,
      `${buckets.length} ${an.trend.bucket.replace("calendar_", "")} bucket(s) from ${span.start} to ${span.end}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasCalendarTrend(ctx: SasCtx, an: CalendarTrendAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_trend${suffix}`);
  const cohT = ctx.finalCohort;
  const evT = ctx.evOf(an.outcomeDefinition.codeListId);
  const epiT = ctx.tbl("050_epi");
  const listSystem = findCodeList(spec, an.outcomeDefinition.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` : setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
  const buckets = trendBuckets(spec, an.trend.bucket);
  const span = { start: buckets[0]?.start ?? spec.meta.studyPeriod.start, end: buckets[buckets.length - 1]?.end ?? spec.meta.studyPeriod.end };
  const limits = calendarTrendLimitations(an, listSystem, buckets);
  const label = an.label.replace(/"/g, "'");
  const primary = SAS_PRIMARY_BY_KIND.calendar_trend ?? [];

  const lines: string[] = [
    ...header(spec, `${num}_trend${suffix}.sas`, [
      `Calendar trend for "${an.label}": per-${an.trend.bucket.replace("calendar_", "")}`,
      `prevalence (Wilson 95% CI) plus the Cochran-Armitage test for a monotone`,
      `linear trend across ${buckets.length} bucket(s), ${span.start} to ${span.end}.`,
      `The trend statistic z is computed in BOTH twins; only the p-value is`,
      `SAS-primary (it inverts the normal CDF, which warehouse SQL lacks).`,
      `Twin of the SQL trend program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("calendar_trend", calendarTrendParity(an, { settingFilter: setting.stamped, buckets }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...CALENDAR_TREND_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- calendar buckets --------------------------------------`,
    `  Emitted as LITERALS by the same generator that produced the SQL twin's`,
    `  bucket rows. A %do loop here and a recursive CTE there would be two`,
    `  implementations of one intent, and a bucket one day off still produces a`,
    `  complete, plausible-looking trend table. */`,
    `data work._${num}_buckets;`,
    `  length bucket $16;`,
    `  format b_start b_end date9.;`,
    ...buckets.map(
      (b) =>
        `  bucket_ord = ${b.ord}; bucket = "${sq(b.label)}"; b_start = ${sasDate(b.start)}; b_end = ${sasDate(b.end)}; is_partial = ${b.isPartial ? 1 : 0}; output;`,
    ),
    `run;`,
    ``,
    `/*-------------------- per-bucket denominator: enrolled anytime in bucket ----*/`,
    `proc sql;`,
    `  create table work._${num}_den as`,
    `  select distinct b.bucket_ord, b.bucket, a.enrolid`,
    `  from work._${num}_buckets as b, ${cohT} as a, ${epiT} as ep`,
    `  where ep.enrolid = a.enrolid`,
    `    and ep.dtstart <= b.b_end`,
    `    and ep.dtend   >= b.b_start;`,
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_den`, "per-bucket denominator (person-bucket rows)"),
    ``,
    `/*-------------------- cases: event dated inside the bucket ------------------*/`,
    `proc sql;`,
    `  create table work._${num}_cases as`,
    `  select distinct dn.bucket_ord, dn.enrolid`,
    `  from work._${num}_den as dn`,
    `  inner join work._${num}_buckets as b`,
    `    on b.bucket_ord = dn.bucket_ord`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = dn.enrolid`,
    `    and e.svcdate between b.b_start and b.b_end`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  ;`,
    `quit;`,
    ``,
    `/*-------------------- per-bucket counts -------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_pb as`,
    `  select dn.bucket_ord, dn.bucket,`,
    `         count(*) as denominator,`,
    `         sum(case when cs.enrolid is not null then 1 else 0 end) as patients`,
    `  from work._${num}_den as dn`,
    `  left join work._${num}_cases as cs`,
    `    on  cs.bucket_ord = dn.bucket_ord`,
    `    and cs.enrolid    = dn.enrolid`,
    `  group by dn.bucket_ord, dn.bucket;`,
    `quit;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Cochran-Armitage sums, scores = the 0-based bucket ordinals (Cochran 1954;`,
    `  Armitage 1955). Identical algebra to the SQL twin's ca / ca2 CTEs:`,
    `    T   = sum(w*r) - pbar * sum(w*n)`,
    `    Var = pbar*(1-pbar) * ( sum(w*w*n) - (sum(w*n))**2 / N )`,
    `    z   = T / sqrt(Var)`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_ca0 as`,
    `  select sum(patients) as r_tot, sum(denominator) as n_tot,`,
    `         sum(bucket_ord * patients) as s_rw,`,
    `         sum(bucket_ord * denominator) as s_nw,`,
    `         sum(bucket_ord * bucket_ord * denominator) as s_nw2`,
    `  from work._${num}_pb;`,
    `quit;`,
    ``,
    `data work._${num}_ca;`,
    `  set work._${num}_ca0;`,
    `  length trend_method $20 ${methodColumnFor("trend_p")} $20;`,
    `  trend_method = 'cochran_armitage';`,
    `  if n_tot > 0 then do;`,
    `    pbar   = r_tot / n_tot;`,
    `    t_stat = s_rw - pbar * s_nw;`,
    `    var_t  = pbar * (1 - pbar) * ( s_nw2 - (s_nw * s_nw) / n_tot );`,
    `    if var_t > 0 then trend_z = round(t_stat / sqrt(var_t), 0.00001);`,
    `  end;`,
    `  /* SAS-PRIMARY: the two-sided p-value. SQL emits it NULL by contract -`,
    ...primary.map((c) => `     ${cmt(c.why)}. */`),
    `  trend_p = .;`,
    `  if trend_z ne . then trend_p = round(2 * (1 - probnorm(abs(trend_z))), 0.000001);`,
    `  ${methodColumnFor("trend_p")} = "${primary[0]?.methodLabel ?? "sas_normal_cdf"}";`,
    `run;`,
    ``,
    `/*-------------------- assemble: bucket rows + the Trend row -----------------*/`,
    `proc sql;`,
    `  create table work._${num}_bkt as`,
    `  select pb.bucket_ord, pb.bucket, b.b_start, b.b_end, b.is_partial,`,
    `         pb.patients, pb.denominator`,
    `  from work._${num}_pb as pb`,
    `  inner join work._${num}_buckets as b`,
    `    on b.bucket_ord = pb.bucket_ord;`,
    `quit;`,
    ``,
    `data work._${num}_bkt2;`,
    `  set work._${num}_bkt;`,
    `  length measure $28 ci_method $16 trend_method $20 ${methodColumnFor("trend_p")} $20;`,
    `  measure = "${MEASURE}";`,
    `  if patients = . then patients = 0;`,
    `  /* Wilson 95% CI - the SAME closed form as every other prevalence twin`,
    `     (Wilson JASA 1927;22:209; z = 1.96, z^2 = 3.8416). */`,
    `  if denominator > 0 then do;`,
    `    prevalence     = round(patients / denominator, 0.00001);`,
    `    prevalence_pct = round(100 * patients / denominator, 0.01);`,
    `    _rad    = 1.96 * sqrt( (patients * (denominator - patients)) / denominator + 0.9604 );`,
    `    ci_low  = round(max(0, (patients + 1.9208 - _rad) / (denominator + 3.8416)), 0.00001);`,
    `    ci_high = round(min(1, (patients + 1.9208 + _rad) / (denominator + 3.8416)), 0.00001);`,
    `    ci_method = 'wilson';`,
    `  end;`,
    `  else do;`,
    `    prevalence = .; prevalence_pct = .; ci_low = .; ci_high = .;`,
    `  end;`,
    `  drop _rad;`,
    `run;`,
    ``,
    `data work._${num}_trendrow;`,
    `  set work._${num}_ca;`,
    `  length measure $28 bucket $16 ci_method $16;`,
    `  measure     = "${MEASURE}";`,
    `  bucket      = 'Trend';`,
    `  bucket_ord  = ${buckets.length};`,
    `  b_start     = ${sasDate(span.start)};`,
    `  b_end       = ${sasDate(span.end)};`,
    `  is_partial  = 0;`,
    `  format b_start b_end date9.;`,
    `  /* person-BUCKET sums, not distinct patients - see the method notes */`,
    `  patients    = r_tot;`,
    `  denominator = n_tot;`,
    `  if n_tot > 0 then do;`,
    `    prevalence     = round(pbar, 0.00001);`,
    `    prevalence_pct = round(100 * pbar, 0.01);`,
    `  end;`,
    `  ci_low = .; ci_high = .; ci_method = '';`,
    `  keep measure bucket bucket_ord b_start b_end is_partial patients denominator`,
    `       prevalence prevalence_pct ci_low ci_high ci_method`,
    `       trend_method trend_z trend_p ${methodColumnFor("trend_p")};`,
    `run;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_bkt2 work._${num}_trendrow;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by bucket_ord;`,
    `run;`,
    ``,
    `title "Calendar trend (${an.trend.bucket.replace("calendar_", "")}): ${label}";`,
    `proc print data=${outT} noobs;`,
    `  var measure bucket b_start b_end is_partial patients denominator prevalence`,
    `      prevalence_pct ci_low ci_high ci_method trend_method trend_z trend_p ${methodColumnFor("trend_p")};`,
    `run;`,
    ``,
  );

  return {
    path: `sas/${num}_trend${suffix}.sas`,
    language: "sas",
    title: `${num} Calendar trend${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const calendarTrendModule: AnalysisModule<CalendarTrendAnalysis> = {
  analysisKind: "calendar_trend",
  stampKind: "calendar_trend",
  resultSlug: "trend",
  sql: sqlCalendarTrend,
  sas: sasCalendarTrend,
};
