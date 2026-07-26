/**
 * Point-prevalence module — proportion of the cohort that is a prevalent case
 * on an anchor date, with a Wilson score CI (closed form, both twins).
 *
 * Method (Modern Epi 3e ch.3; Wilson JASA 1927;22:209):
 *   - denominator: final analysis cohort members whose stitched enrollment
 *     episode COVERS the anchor date (enrollment = "under observation / alive"
 *     proxy; MarketScan has no population denominator — BR-LIM-002);
 *   - numerator: denominator members with >= 1 qualifying outcome event
 *     on-or-BEFORE the anchor date (all-available lookback — the spec carries
 *     no activeLookbackWindow field);
 *   - anchorDate: a fixed calendar date, or each subject's own index date;
 *   - Wilson score interval (z = 1.96), computed closed-form identically in
 *     SQL and SAS; k=0 ⇒ low 0 exactly, k=n ⇒ high 1 exactly.
 *
 * The outcome care-setting filter is APPLIED (shared outcomeSettingPlan), so
 * setting="outpatient" excludes inpatient events, exactly like incidence.
 *
 * Verified vs Gold Case A: a_pp_main (fixed 2019-07-20) 4/10 = 0.40, Wilson
 * (0.16818, 0.68733) + 7 stratum rows; a_pp_idx (index anchor) 2/10 = 0.20,
 * reproducing the frozen baselinePrevalence from an independent path;
 * a_pp_eos (anchor after every episode) 0/0 zero-denominator NULLs — all hand-
 * derived and asserted in verify/run.ts.
 */
import type { PointPrevalenceAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine, q } from "../sql-base";
import { cmt, header, levelCheck, sasDate, sq, INCLUDE_SETUP } from "../sas-base";
import {
  ageBandLabels,
  outcomeSettingPlan,
  parityStamp,
  pointPrevalenceLimitations,
  pointPrevalenceParity,
  splitStratifiers,
  stratLabel,
  POINT_PREVALENCE_METHOD_NOTES,
  REGION_LABELS,
  SEX_LABELS,
  type SupportedStratifier,
} from "../parity";

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlPointPrevalence(ctx: SqlCtx, an: PointPrevalenceAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_pointprev${suffix}`;
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const anchorSql = an.anchorDate.kind === "fixed" ? `DATE '${an.anchorDate.date}'` : `c.index_date`;

  // demographic strata — labels/tie-break shared with the SAS twin (parity.ts),
  // age/year computed AT THE ANCHOR DATE, from the enrollment segment in force.
  const { supported: strata } = splitStratifiers(an.stratifyBy);
  const needDemo = strata.some((s) => s.axis !== "year");
  const ageExpr = `${d.year("anchor_date")} - dobyr`;
  const stratExpr = (s: SupportedStratifier): string => {
    switch (s.axis) {
      case "sex":
        return `CASE CAST(sex AS VARCHAR) ${Object.entries(SEX_LABELS)
          .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
          .join(" ")} ELSE 'Unknown' END`;
      case "region":
        return `CASE CAST(region AS VARCHAR) ${Object.entries(REGION_LABELS)
          .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
          .join(" ")} ELSE 'Unknown' END`;
      case "plan_type":
        return `COALESCE(CAST(plantyp AS VARCHAR), 'Unknown')`;
      case "year":
        return `CAST(${d.year("anchor_date")} AS VARCHAR)`;
      case "age_band": {
        const bands = s.bands ?? [];
        const labels = ageBandLabels(bands);
        const arms: string[] = [`WHEN ${ageExpr} IS NULL THEN 'Unknown'`];
        if (bands[0] > 0) arms.push(`WHEN ${ageExpr} < ${bands[0]} THEN '<${bands[0]}'`);
        for (let i = bands.length - 1; i >= 1; i--)
          arms.push(`WHEN ${ageExpr} >= ${bands[i]} THEN '${labels[i]}'`);
        return `CASE ${arms.join(" ")} ELSE '${labels[0]}' END`;
      }
    }
  };

  const L: string[] = [];
  L.push(`-- ${parityStamp("point_prevalence", pointPrevalenceParity(an, { settingFilter: setting.stamped, strata }))}`);
  const limits = pointPrevalenceLimitations(an, listSystem);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of POINT_PREVALENCE_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(d.createTableAs(out));
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${wp}_cohort),`);
  L.push(
    `ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${q(clid)}'` +
      (setting.enforce ? ` AND setting = '${setting.enforce}'` : ``) +
      `),`
  );
  L.push(`den AS (   -- denominator: cohort members whose stitched episode covers the anchor date`);
  L.push(`  SELECT c.enrolid, c.index_date, ${anchorSql} AS anchor_date`);
  L.push(`  FROM cohort c`);
  L.push(`  JOIN ${wp}_enroll_episodes ep`);
  L.push(`    ON ep.enrolid = c.enrolid`);
  L.push(`   AND ${anchorSql} BETWEEN ep.episode_start AND ep.episode_end`);
  L.push(`),`);
  L.push(`cases AS (   -- prevalent case: >= 1 qualifying event on-or-BEFORE the anchor date`);
  L.push(`  SELECT DISTINCT den.enrolid`);
  L.push(`  FROM den JOIN ae e ON e.enrolid = den.enrolid AND e.event_date <= den.anchor_date`);
  L.push(`),`);
  if (needDemo) {
    L.push(`demo AS (   -- enrollment segment in force at (or latest before) the anchor; rn=1 wins`);
    L.push(`  SELECT den.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
    L.push(`         ROW_NUMBER() OVER (PARTITION BY den.enrolid`);
    L.push(`                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
    L.push(`  FROM den`);
    L.push(`  JOIN ${ctx.t("enrollment_detail")} en`);
    L.push(`    ON en.enrolid = den.enrolid`);
    L.push(`   AND en.dtstart <= den.anchor_date`);
    L.push(`),`);
    L.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  }
  L.push(`pp AS (`);
  L.push(
    `  SELECT den.enrolid, den.anchor_date,` +
      `\n         CASE WHEN cs.enrolid IS NOT NULL THEN 1 ELSE 0 END AS is_case` +
      (needDemo ? `,` : ``)
  );
  if (needDemo) L.push(`         dm.dobyr, dm.sex, dm.region, dm.plantyp`);
  L.push(`  FROM den`);
  L.push(`  LEFT JOIN cases cs ON cs.enrolid = den.enrolid`);
  if (needDemo) L.push(`  LEFT JOIN demo1 dm ON dm.enrolid = den.enrolid`);
  L.push(`),`);
  L.push(`pp2 AS (`);
  L.push(`  SELECT is_case${strata.length > 0 ? "," : ""}`);
  strata.forEach((s, i) => {
    L.push(`         ${stratExpr(s)} AS strat_${i}${i < strata.length - 1 ? "," : ""}`);
  });
  L.push(`  FROM pp`);
  L.push(`),`);
  L.push(`summ AS (`);
  L.push(`  SELECT 'point_prevalence' AS measure, 'Overall' AS stratifier, 'Overall' AS stratum,`);
  L.push(`         COALESCE(SUM(is_case), 0) AS patients, COUNT(*) AS denominator`);
  L.push(`  FROM pp2`);
  strata.forEach((s, i) => {
    L.push(`  UNION ALL`);
    L.push(`  SELECT 'point_prevalence', '${q(stratLabel(s.label))}', strat_${i},`);
    L.push(`         COALESCE(SUM(is_case), 0), COUNT(*)`);
    L.push(`  FROM pp2 GROUP BY strat_${i}`);
  });
  L.push(`)`);
  // Wilson score interval, z = 1.96: z^2=3.8416, z^2/2=1.9208, z^2/4=0.9604.
  // Every division carries a decimal factor so Postgres never integer-divides.
  L.push(`SELECT measure, stratifier, stratum, patients, denominator,`);
  L.push(`       ${d.roundN(`patients * 1.0 / NULLIF(denominator, 0)`, 5)} AS prevalence,`);
  L.push(`       ${d.roundN(`patients * 100.0 / NULLIF(denominator, 0)`, 2)} AS prevalence_pct,`);
  L.push(`       CASE WHEN denominator = 0 THEN NULL ELSE`);
  L.push(`         ${d.roundN(
    `GREATEST(0.0, (patients + 1.9208 - 1.96*SQRT(1.0*patients*(denominator-patients)/NULLIF(denominator,0) + 0.9604)) / (denominator + 3.8416))`,
    5
  )} END AS ci_low,`);
  L.push(`       CASE WHEN denominator = 0 THEN NULL ELSE`);
  L.push(`         ${d.roundN(
    `LEAST(1.0, (patients + 1.9208 + 1.96*SQRT(1.0*patients*(denominator-patients)/NULLIF(denominator,0) + 0.9604)) / (denominator + 3.8416))`,
    5
  )} END AS ci_high,`);
  // labeled with the method actually computed (Wilson), never the merely-requested one
  L.push(`       'wilson' AS ci_method`);
  L.push(`FROM summ;`);
  L.push("");
  L.push(`-- REVIEW: point prevalence on the anchor date, Overall + per stratum.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY stratifier, stratum;`);

  return {
    slug: `pointprev${suffix}`,
    title: `Point prevalence${suffix ? ` (${an.label})` : ""}`,
    subtitle: "point prevalence on the anchor date + Wilson CI",
    extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}); outcome code list "${an.outcomeDefinition.codeListId}".`],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasPointPrevalence(ctx: SasCtx, an: PointPrevalenceAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_pointprev${suffix}`);
  const cohT = ctx.finalCohort;
  const evT = ctx.evOf(an.outcomeDefinition.codeListId);
  const epiT = ctx.tbl("050_epi");
  const listSystem = findCodeList(spec, an.outcomeDefinition.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` :
    setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
  const anchorSas = an.anchorDate.kind === "fixed" ? sasDate(an.anchorDate.date) : `a.index_date`;

  const { supported: strata } = splitStratifiers(an.stratifyBy);
  const needDemo = strata.some((s) => s.axis !== "year");
  const needAge = strata.some((s) => s.axis === "age_band");
  const stratAssign = (s: SupportedStratifier, v: string): string[] => {
    switch (s.axis) {
      case "sex": {
        const arms = Object.entries(SEX_LABELS).map(
          ([k, lab], j) => `${j === 0 ? "if" : "else if"} sex = '${k}' then ${v} = '${lab}';`
        );
        return [...arms, `else ${v} = 'Unknown';`];
      }
      case "region": {
        const arms = Object.entries(REGION_LABELS).map(
          ([k, lab], j) => `${j === 0 ? "if" : "else if"} region = '${k}' then ${v} = '${lab}';`
        );
        return [...arms, `else ${v} = 'Unknown';`];
      }
      case "plan_type":
        return [`${v} = strip(vvalue(plantyp));`, `if ${v} in ('', '.') then ${v} = 'Unknown';`];
      case "year":
        return [`${v} = strip(put(year(anchor_date), 4.));`];
      case "age_band": {
        const bands = s.bands ?? [];
        const labels = ageBandLabels(bands);
        const arms: string[] = [`if age_at_anchor = . then ${v} = 'Unknown';`];
        if (bands[0] > 0) arms.push(`else if age_at_anchor < ${bands[0]} then ${v} = '<${bands[0]}';`);
        for (let j = bands.length - 1; j >= 1; j--)
          arms.push(`else if age_at_anchor >= ${bands[j]} then ${v} = '${labels[j]}';`);
        arms.push(`else ${v} = '${labels[0]}';`);
        return arms;
      }
    }
  };

  const limits = pointPrevalenceLimitations(an, listSystem);
  const label = an.label.replace(/"/g, "'");

  const lines: string[] = [
    ...header(spec, `${num}_pointprev${suffix}.sas`, [
      `Point prevalence on the anchor date for "${an.label}":`,
      `denominator = final-cohort members enrolled (stitched episode) on the`,
      `anchor date; numerator = members with >= 1 qualifying outcome event`,
      `on-or-before the anchor date; Wilson 95% CI (closed form).`,
      `Twin of the machine-verified SQL 07_pointprev; keep both in sync.`,
    ]),
    `/* ${parityStamp("point_prevalence", pointPrevalenceParity(an, { settingFilter: setting.stamped, strata }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(
      `/* REVIEW - spec options this program does not implement yet:`,
      ...limits.map((l) => `   * ${cmt(l)}`),
      `*/`
    );
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...POINT_PREVALENCE_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- denominator: enrolled on the anchor date --------------*/`,
    `proc sql;`,
    `  create table work._${num}_den as`,
    `  select a.enrolid, a.index_date,`,
    `         ${anchorSas} as anchor_date format=date9.`,
    `  from ${cohT} as a`,
    `  inner join ${epiT} as ep`,
    `    on  ep.enrolid = a.enrolid`,
    `    and ${anchorSas} between ep.dtstart and ep.dtend;`,
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_den`, "denominator: enrolled on anchor date"),
    ``,
    `/*-------------------- prevalent cases on the anchor date --------------------*/`,
    `proc sql;`,
    `  create table work._${num}_cases as`,
    `  select distinct a.enrolid`,
    `  from work._${num}_den as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    `    and e.svcdate <= a.anchor_date   /* on-or-BEFORE: an event ON the anchor counts */`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  ;`,
    `quit;`,
    ``,
    ...(needDemo
      ? [
          `/*-------------------- stratum demographics at the ANCHOR date ---------------*/`,
          `/* enrollment segment in force at (or latest before) the anchor date - the`,
          `   SAME source and tie-break as the SQL twin, so stratum values cannot drift. */`,
          `proc sql;`,
          `  create table work._${num}_dm0 as`,
          `  select a.enrolid, b.dobyr, b.sex, b.region, b.plantyp,`,
          `         b.dtstart as seg_start, b.dtend as seg_end`,
          `  from work._${num}_den as a`,
          `  left join ${ctx.tbl("040_enroll")} as b`,
          `    on  b.enrolid = a.enrolid`,
          `    and b.dtstart <= a.anchor_date;`,
          `quit;`,
          ``,
          `proc sort data=work._${num}_dm0;`,
          `  by enrolid descending seg_start descending seg_end;`,
          `run;`,
          ``,
          `data work._${num}_dm;`,
          `  set work._${num}_dm0;`,
          `  by enrolid;`,
          `  if first.enrolid;`,
          `  drop seg_start seg_end;`,
          `run;`,
          ``,
        ]
      : []),
    `/*-------------------- per-member case flag + strata -------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_pp as`,
    `  select a.enrolid, a.anchor_date,`,
    `         case when b.enrolid is not null then 1 else 0 end as is_case${needDemo ? "," : ""}`,
    ...(needDemo ? [`         dm.dobyr, dm.sex, dm.region, dm.plantyp`] : []),
    `  from work._${num}_den as a`,
    `  left join work._${num}_cases as b`,
    `    on b.enrolid = a.enrolid`,
    ...(needDemo ? [`  left join work._${num}_dm as dm`, `    on dm.enrolid = a.enrolid`] : []),
    `  ;`,
    `quit;`,
    ``,
    `data work._${num}_pp2;`,
    `  set work._${num}_pp;`,
    ...(strata.length > 0 ? [`  length ${strata.map((_, j) => `strat_${j}`).join(" ")} $40;`] : []),
    ...(needAge
      ? [`  /* enrollment-derived age at the ANCHOR date, matching the SQL twin */`,
         `  age_at_anchor = year(anchor_date) - dobyr;`]
      : []),
    ...strata.flatMap((s, j) => [
      `  /* stratifier: ${cmt(stratLabel(s.label))} (${s.axis}) */`,
      ...stratAssign(s, `strat_${j}`).map((l) => `  ${l}`),
    ]),
    `run;`,
    ``,
    ...levelCheck(`work._${num}_pp2`, "denominator members", [`sum(is_case) as cases`]),
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Point prevalence + Wilson 95% CI - the SAME closed form as the SQL twin`,
    `  (Wilson JASA 1927;22:209; z = 1.96, z^2 = 3.8416), so both languages agree`,
    `  to the last rounded digit:`,
    `    low  = max(0, (k + 1.9208 - 1.96*sqrt(k(n-k)/n + 0.9604)) / (n + 3.8416))`,
    `    high = min(1, (k + 1.9208 + 1.96*sqrt(k(n-k)/n + 0.9604)) / (n + 3.8416))`,
    `  (low = 0 exactly when k = 0; high = 1 exactly when k = n.)`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_summ as`,
    `  select 'Overall' as stratifier length=40,`,
    `         'Overall' as stratum length=40,`,
    `         count(*) as denominator,`,
    `         sum(is_case) as patients`,
    `  from work._${num}_pp2`,
    ...strata.flatMap((s, j) => [
      `  union all`,
      `  select '${sq(stratLabel(s.label))}', strat_${j},`,
      `         count(*), sum(is_case)`,
      `  from work._${num}_pp2 group by strat_${j}`,
    ]),
    `  ;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_summ;`,
    `  length measure $20 ci_method $16;`,
    `  measure   = 'point_prevalence';`,
    `  /* labeled with the method actually computed, never the merely-requested one */`,
    `  ci_method = 'wilson';`,
    `  /* ungrouped SQL aggregate over an empty table gives count 0 / sum missing -`,
    `     pin patients = 0 to match the SQL twin's COALESCE */`,
    `  if patients = . then patients = 0;`,
    `  if denominator > 0 then do;`,
    `    prevalence     = round(patients / denominator, 0.00001);`,
    `    prevalence_pct = round(100 * patients / denominator, 0.01);`,
    `    _rad   = 1.96 * sqrt( (patients * (denominator - patients)) / denominator + 0.9604 );`,
    `    ci_low  = round(max(0, (patients + 1.9208 - _rad) / (denominator + 3.8416)), 0.00001);`,
    `    ci_high = round(min(1, (patients + 1.9208 + _rad) / (denominator + 3.8416)), 0.00001);`,
    `  end;`,
    `  else do;`,
    `    prevalence = .; prevalence_pct = .; ci_low = .; ci_high = .;`,
    `  end;`,
    `  drop _rad;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by stratifier stratum;`,
    `run;`,
    ``,
    `title "Point prevalence on the anchor date: ${label}";`,
    `proc print data=${outT} noobs;`,
    `  var measure stratifier stratum patients denominator prevalence prevalence_pct`,
    `      ci_low ci_high ci_method;`,
    `run;`,
    ``,
  );

  return {
    path: `sas/${num}_pointprev${suffix}.sas`,
    language: "sas",
    title: `${num} Point prevalence${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const pointPrevalenceModule: AnalysisModule<PointPrevalenceAnalysis> = {
  analysisKind: "point_prevalence",
  stampKind: "point_prevalence",
  sql: sqlPointPrevalence,
  sas: sasPointPrevalence,
};
