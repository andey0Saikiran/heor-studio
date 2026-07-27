/**
 * Cumulative-incidence (risk) module — proportion of the at-risk cohort that
 * experiences a first event within a fixed horizon, Wilson score CI.
 *
 * Method (Modern Epi 3e ch.3; Wilson JASA 1927;22:209):
 *   - denominator (at_risk_start): final-cohort members event-free at index
 *     after the washout window (the SAME prevalent-exclusion as incidence);
 *   - numerator: members with a first qualifying event in (index, index +
 *     horizonDays] — strictly after index, within the horizon;
 *   - risk = cases / at-risk (NAIVE, complete-follow-up assumption); Wilson CI.
 *
 * competingRiskDeath="censor"/"aalen_johansen" (1-KM / CIF) are SAS-only and
 * surfaced as REVIEW limitations — this V1 emits the naive at-risk risk, which
 * the spec's denominatorRule "at_risk_start" names exactly.
 *
 * Verified vs Gold Case A: a_ci_365 (horizon 365) 3/8 = 0.375, Wilson
 * (0.13684, 0.69426) — reproducing the frozen EXPECTED.wilsonCi — + sex strata;
 * a_ci_180 (horizon 180) 1/8 = 0.125 (only P02's day-100 event is within 180d,
 * pinning the horizon bound). Hand-derived, asserted in verify/run.ts.
 */
import type { CumulativeIncidenceAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import { cmt, describeWin, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import {
  ageBandLabels,
  cumulativeIncidenceLimitations,
  cumulativeIncidenceParity,
  outcomeSettingPlan,
  parityStamp,
  splitStratifiers,
  stratLabel,
  CUMULATIVE_INCIDENCE_METHOD_NOTES,
  REGION_LABELS,
  SEX_LABELS,
  type SupportedStratifier,
} from "../parity";

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlCumulativeIncidence(ctx: SqlCtx, an: CumulativeIncidenceAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_cuminc${suffix}`;
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const horizonEnd = d.offset("c.index_date", an.horizonDays);

  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  const washoutPred = wc.length > 0 ? wc.join("\n      AND ") : "TRUE";

  const { supported: strata } = splitStratifiers(an.stratifyBy);
  const needDemo = strata.some((s) => s.axis !== "year");
  const ageExpr = `${d.year("index_date")} - dobyr`;
  const stratExpr = (s: SupportedStratifier): string => {
    switch (s.axis) {
      case "sex":
        return `CASE CAST(sex AS VARCHAR) ${Object.entries(SEX_LABELS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE 'Unknown' END`;
      case "region":
        return `CASE CAST(region AS VARCHAR) ${Object.entries(REGION_LABELS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE 'Unknown' END`;
      case "plan_type":
        return `COALESCE(CAST(plantyp AS VARCHAR), 'Unknown')`;
      case "year":
        return `CAST(${d.year("index_date")} AS VARCHAR)`;
      case "age_band": {
        const bands = s.bands ?? [];
        const labels = ageBandLabels(bands);
        const arms: string[] = [`WHEN ${ageExpr} IS NULL THEN 'Unknown'`];
        if (bands[0] > 0) arms.push(`WHEN ${ageExpr} < ${bands[0]} THEN '<${bands[0]}'`);
        for (let i = bands.length - 1; i >= 1; i--) arms.push(`WHEN ${ageExpr} >= ${bands[i]} THEN '${labels[i]}'`);
        return `CASE ${arms.join(" ")} ELSE '${labels[0]}' END`;
      }
    }
  };

  const L: string[] = [];
  L.push(`-- ${parityStamp("cumulative_incidence", cumulativeIncidenceParity(an, { settingFilter: setting.stamped, strata }))}`);
  const limits = cumulativeIncidenceLimitations(an, listSystem);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of CUMULATIVE_INCIDENCE_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(d.createTableAs(out));
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${wp}_cohort),`);
  L.push(
    `ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${q(clid)}'` +
      (setting.enforce ? ` AND setting = '${setting.enforce}'` : ``) +
      `),`
  );
  L.push(`prevalent AS (   -- washout: ${describeWindow(an.washout)}`);
  L.push(`  SELECT DISTINCT c.enrolid`);
  L.push(`  FROM cohort c JOIN ae a ON a.enrolid = c.enrolid`);
  L.push(`  WHERE ${washoutPred}`);
  L.push(`),`);
  L.push(`atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),`);
  L.push(`cases AS (   -- first qualifying event in (index, index + ${an.horizonDays}d]`);
  L.push(`  SELECT DISTINCT c.enrolid`);
  L.push(`  FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid`);
  L.push(`   AND a.event_date > c.index_date`);
  L.push(`   AND a.event_date <= ${horizonEnd}`);
  L.push(`),`);
  if (needDemo) {
    L.push(`demo AS (   -- enrollment segment in force at (or latest before) index; rn=1 wins`);
    L.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
    L.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
    L.push(`  FROM atrisk c`);
    L.push(`  JOIN ${ctx.t("enrollment_detail")} en ON en.enrolid = c.enrolid AND en.dtstart <= c.index_date`);
    L.push(`),`);
    L.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  }
  L.push(`ci AS (`);
  L.push(
    `  SELECT c.enrolid,` +
      `\n         CASE WHEN cs.enrolid IS NOT NULL THEN 1 ELSE 0 END AS is_case` +
      (needDemo ? `,` : ``)
  );
  if (needDemo) L.push(`         dm.dobyr, dm.sex, dm.region, dm.plantyp`);
  L.push(`  FROM atrisk c`);
  L.push(`  LEFT JOIN cases cs ON cs.enrolid = c.enrolid`);
  if (needDemo) L.push(`  LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid`);
  L.push(`),`);
  L.push(`ci2 AS (`);
  L.push(`  SELECT is_case${strata.length > 0 ? "," : ""}`);
  strata.forEach((s, i) => {
    L.push(`         ${stratExpr(s)} AS strat_${i}${i < strata.length - 1 ? "," : ""}`);
  });
  L.push(`  FROM ci`);
  L.push(`),`);
  L.push(`summ AS (`);
  L.push(`  SELECT 'cumulative_incidence' AS measure, 'Overall' AS stratifier, 'Overall' AS stratum,`);
  L.push(`         COALESCE(SUM(is_case), 0) AS patients, COUNT(*) AS denominator`);
  L.push(`  FROM ci2`);
  strata.forEach((s, i) => {
    L.push(`  UNION ALL`);
    L.push(`  SELECT 'cumulative_incidence', '${q(stratLabel(s.label))}', strat_${i},`);
    L.push(`         COALESCE(SUM(is_case), 0), COUNT(*)`);
    L.push(`  FROM ci2 GROUP BY strat_${i}`);
  });
  L.push(`)`);
  L.push(`SELECT measure, stratifier, stratum, patients, denominator,`);
  L.push(`       ${d.roundN(`patients * 1.0 / NULLIF(denominator, 0)`, 5)} AS risk,`);
  L.push(`       ${d.roundN(`patients * 100.0 / NULLIF(denominator, 0)`, 2)} AS risk_pct,`);
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
  L.push(`       'wilson' AS ci_method`);
  L.push(`FROM summ;`);
  L.push("");
  L.push(`-- REVIEW: cumulative incidence at ${an.horizonDays} days, Overall + per stratum.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY stratifier, stratum;`);

  return {
    slug: `cuminc${suffix}`,
    title: `Cumulative incidence${suffix ? ` (${an.label})` : ""}`,
    subtitle: `cumulative incidence (risk) at ${an.horizonDays}d + Wilson CI`,
    extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}); outcome code list "${an.outcomeDefinition.codeListId}".`],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasCumulativeIncidence(ctx: SasCtx, an: CumulativeIncidenceAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_cuminc${suffix}`);
  const cohT = ctx.finalCohort;
  const evT = ctx.evOf(an.outcomeDefinition.codeListId);
  const listSystem = findCodeList(spec, an.outcomeDefinition.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` :
    setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;

  const washLines = [
    ...(sasSettingCond ? [sasSettingCond] : []),
    ...sasWindowConds(an.washout, "e"),
  ];

  const { supported: strata } = splitStratifiers(an.stratifyBy);
  const needDemo = strata.some((s) => s.axis !== "year");
  const needAge = strata.some((s) => s.axis === "age_band");
  const stratAssign = (s: SupportedStratifier, v: string): string[] => {
    switch (s.axis) {
      case "sex": {
        const arms = Object.entries(SEX_LABELS).map(([k, lab], j) => `${j === 0 ? "if" : "else if"} sex = '${k}' then ${v} = '${lab}';`);
        return [...arms, `else ${v} = 'Unknown';`];
      }
      case "region": {
        const arms = Object.entries(REGION_LABELS).map(([k, lab], j) => `${j === 0 ? "if" : "else if"} region = '${k}' then ${v} = '${lab}';`);
        return [...arms, `else ${v} = 'Unknown';`];
      }
      case "plan_type":
        return [`${v} = strip(vvalue(plantyp));`, `if ${v} in ('', '.') then ${v} = 'Unknown';`];
      case "year":
        return [`${v} = strip(put(year(index_date), 4.));`];
      case "age_band": {
        const bands = s.bands ?? [];
        const labels = ageBandLabels(bands);
        const arms: string[] = [`if age_at_index = . then ${v} = 'Unknown';`];
        if (bands[0] > 0) arms.push(`else if age_at_index < ${bands[0]} then ${v} = '<${bands[0]}';`);
        for (let j = bands.length - 1; j >= 1; j--) arms.push(`else if age_at_index >= ${bands[j]} then ${v} = '${labels[j]}';`);
        arms.push(`else ${v} = '${labels[0]}';`);
        return arms;
      }
    }
  };

  const limits = cumulativeIncidenceLimitations(an, listSystem);
  const label = an.label.replace(/"/g, "'");

  const lines: string[] = [
    ...header(spec, `${num}_cuminc${suffix}.sas`, [
      `Cumulative incidence (risk) at ${an.horizonDays} days for "${an.label}":`,
      `at-risk denominator (event-free at index after washout), numerator =`,
      `first qualifying event within the horizon; naive risk + Wilson 95% CI.`,
      `Twin of the SQL cuminc program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp("cumulative_incidence", cumulativeIncidenceParity(an, { settingFilter: setting.stamped, strata }))} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...CUMULATIVE_INCIDENCE_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- washout: prevalent (event-free) exclusion -------------*/`,
    `/* washout window: ${cmt(describeWin(an.washout))} */`,
    `proc sql;`,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join ${evT} as e`,
    `    on e.enrolid = a.enrolid`,
    `  where 1 = 1`,
    ...washLines.map((l, idx) => `    ${l}${idx === washLines.length - 1 ? ";" : ""}`),
    ...(washLines.length === 0 ? [`  ;`] : []),
    `quit;`,
    ``,
    `/*-------------------- at-risk denominator ----------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_atrisk as`,
    `  select a.*`,
    `  from ${cohT} as a`,
    `  where a.enrolid not in (select enrolid from work._${num}_prev);`,
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_atrisk`, "at-risk cohort"),
    ``,
    `/*-------------------- cases: first event within the horizon -----------------*/`,
    `proc sql;`,
    `  create table work._${num}_cases as`,
    `  select distinct a.enrolid`,
    `  from work._${num}_atrisk as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    `    and e.svcdate > a.index_date`,
    `    and e.svcdate <= a.index_date + ${an.horizonDays}`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  ;`,
    `quit;`,
    ``,
    ...(needDemo
      ? [
          `/*-------------------- stratum demographics at index -------------------------*/`,
          `proc sql;`,
          `  create table work._${num}_dm0 as`,
          `  select a.enrolid, b.dobyr, b.sex, b.region, b.plantyp,`,
          `         b.dtstart as seg_start, b.dtend as seg_end`,
          `  from work._${num}_atrisk as a`,
          `  left join ${ctx.tbl("040_enroll")} as b`,
          `    on  b.enrolid = a.enrolid`,
          `    and b.dtstart <= a.index_date;`,
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
    `  create table work._${num}_ci as`,
    `  select a.enrolid, a.index_date,`,
    `         case when b.enrolid is not null then 1 else 0 end as is_case${needDemo ? "," : ""}`,
    ...(needDemo ? [`         dm.dobyr, dm.sex, dm.region, dm.plantyp`] : []),
    `  from work._${num}_atrisk as a`,
    `  left join work._${num}_cases as b`,
    `    on b.enrolid = a.enrolid`,
    ...(needDemo ? [`  left join work._${num}_dm as dm`, `    on dm.enrolid = a.enrolid`] : []),
    `  ;`,
    `quit;`,
    ``,
    `data work._${num}_ci2;`,
    `  set work._${num}_ci;`,
    ...(strata.length > 0 ? [`  length ${strata.map((_, j) => `strat_${j}`).join(" ")} $40;`] : []),
    ...(needAge ? [`  age_at_index = year(index_date) - dobyr;`] : []),
    ...strata.flatMap((s, j) => [
      `  /* stratifier: ${cmt(stratLabel(s.label))} (${s.axis}) */`,
      ...stratAssign(s, `strat_${j}`).map((l) => `  ${l}`),
    ]),
    `run;`,
    ``,
    ...levelCheck(`work._${num}_ci2`, "at-risk members", [`sum(is_case) as cases`]),
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Cumulative incidence + Wilson 95% CI - the SAME closed form as the SQL twin`,
    `  (Wilson JASA 1927;22:209; z = 1.96, z^2 = 3.8416):`,
    `    low  = max(0, (k + 1.9208 - 1.96*sqrt(k(n-k)/n + 0.9604)) / (n + 3.8416))`,
    `    high = min(1, (k + 1.9208 + 1.96*sqrt(k(n-k)/n + 0.9604)) / (n + 3.8416))`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_summ as`,
    `  select 'Overall' as stratifier length=40,`,
    `         'Overall' as stratum length=40,`,
    `         count(*) as denominator,`,
    `         sum(is_case) as patients`,
    `  from work._${num}_ci2`,
    ...strata.flatMap((s, j) => [
      `  union all`,
      `  select '${sq(stratLabel(s.label))}', strat_${j},`,
      `         count(*), sum(is_case)`,
      `  from work._${num}_ci2 group by strat_${j}`,
    ]),
    `  ;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_summ;`,
    `  length measure $22 ci_method $16;`,
    `  measure   = 'cumulative_incidence';`,
    `  ci_method = 'wilson';`,
    `  if patients = . then patients = 0;`,
    `  if denominator > 0 then do;`,
    `    risk     = round(patients / denominator, 0.00001);`,
    `    risk_pct = round(100 * patients / denominator, 0.01);`,
    `    _rad   = 1.96 * sqrt( (patients * (denominator - patients)) / denominator + 0.9604 );`,
    `    ci_low  = round(max(0, (patients + 1.9208 - _rad) / (denominator + 3.8416)), 0.00001);`,
    `    ci_high = round(min(1, (patients + 1.9208 + _rad) / (denominator + 3.8416)), 0.00001);`,
    `  end;`,
    `  else do;`,
    `    risk = .; risk_pct = .; ci_low = .; ci_high = .;`,
    `  end;`,
    `  drop _rad;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by stratifier stratum;`,
    `run;`,
    ``,
    `title "Cumulative incidence at ${an.horizonDays} days: ${label}";`,
    `proc print data=${outT} noobs;`,
    `  var measure stratifier stratum patients denominator risk risk_pct`,
    `      ci_low ci_high ci_method;`,
    `run;`,
    ``,
  );

  return {
    path: `sas/${num}_cuminc${suffix}.sas`,
    language: "sas",
    title: `${num} Cumulative incidence${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const cumulativeIncidenceModule: AnalysisModule<CumulativeIncidenceAnalysis> = {
  analysisKind: "cumulative_incidence",
  stampKind: "cumulative_incidence",
  sql: sqlCumulativeIncidence,
  sas: sasCumulativeIncidence,
};
