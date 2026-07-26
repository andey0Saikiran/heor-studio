/**
 * Incidence-rate module — THE REFERENCE MODULE. Every other analysis module
 * copies this shape: twin sql()/sas() generators consuming identical spec
 * parameters, a shared PARITY stamp, visible REVIEW notes for unimplemented
 * options, shared stratum-label constants, and hand-computed gold truth in
 * verify/fixture.ts (machine-verified for SQL; inherited by SAS via parity).
 *
 * Method: person-time incidence density with prevalent-case washout.
 *   - washout: any qualifying outcome in the pre-index window ⇒ prevalent ⇒
 *     excluded, so only new-onset cases count (Modern Epi 3e ch.3);
 *   - person-time: index → earliest of first outcome / episode end /
 *     study end / index + max follow-up (death unascertainable in
 *     MarketScan — BR-LIM-002);
 *   - crude rate per `rateMultiplier` person-years, daysPerYear configurable
 *     (spec.meta.daysPerYear, default 365.25);
 *   - Byar exact-Poisson approximation CI, closed form (Ulm AJE 1990;131:373).
 *
 * Verified vs Gold Case A: 3 cases / 8 at-risk / 2425 person-days /
 * 451.86 per 1,000 PY / CI (90.82, 1320.24) + 6 stratum rows (sex, age band,
 * index year) — all hand-derived, all asserted in verify/run.ts.
 */
import type { IncidenceRateAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { describeWindow, oneLine, q, windowConds } from "../sql-base";
import {
  cmt,
  describeWin,
  header,
  levelCheck,
  sq,
  windowConds as sasWindowConds,
  INCLUDE_SETUP,
} from "../sas-base";
import {
  ageBandLabels,
  incidenceLimitations,
  incidenceParity,
  outcomeSettingPlan,
  parityStamp,
  renderDaysPerYear,
  splitStratifiers,
  stratLabel,
  REGION_LABELS,
  SEX_LABELS,
  type SupportedStratifier,
} from "../parity";

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlIncidence(ctx: SqlCtx, an: IncidenceRateAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_incidence${suffix}`;
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const M = an.rateMultiplier;
  // Rendered as a DECIMAL literal (e.g. "365.0") so the rate arithmetic is
  // numeric — an integer constant would trigger integer division (451 vs 451.55).
  const Y = renderDaysPerYear(spec);
  const maxFu = an.personTimeRule.maxFollowupDays;
  const studyEnd = spec.meta.studyPeriod.end;

  // prevalent-case washout predicate (an outcome anywhere in this pre-index window)
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  const washoutPred = wc.length > 0 ? wc.join("\n      AND ") : "TRUE";

  // administrative-censoring terms from personTimeRule.censorAt (death omitted:
  // MarketScan mortality is unascertainable — BR-LIM-002)
  const terms: string[] = [];
  const cens = an.personTimeRule.censorAt;
  if (cens.includes("disenrollment")) terms.push("ep.episode_end");
  if (cens.includes("study_end")) terms.push(`DATE '${studyEnd}'`);
  if (cens.includes("max_followup") && maxFu != null) terms.push(d.offset("c.index_date", maxFu));
  if (terms.length === 0) terms.push(`DATE '${studyEnd}'`); // always bound follow-up
  const adminCensor = terms.length === 1 ? terms[0] : `LEAST(${terms.join(", ")})`;
  const censorFinal = cens.includes("outcome")
    ? `LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor)`
    : `admin_censor`;

  const byarLow = `(CASE WHEN patients = 0 THEN 0 ELSE POWER(1 - 1.0/(9*patients) - 1.96/(3*SQRT(patients)), 3) * patients END)`;
  const byarHigh = `POWER(1 - 1.0/(9*(patients+1)) + 1.96/(3*SQRT(patients+1)), 3) * (patients+1)`;
  const scale = `* ${M} * ${Y} / NULLIF(person_days, 0)`;

  // demographic strata — labels shared with the SAS twin (parity.ts) so both
  // languages emit byte-identical stratum values. Strata are derived from the
  // enrollment segment (dobyr/sex/region/plantyp), never claim-level AGE, so
  // SAS and SQL cannot drift around birthday timing.
  const { supported: strata } = splitStratifiers(an.stratifyBy);
  const needDemo = strata.some((s) => s.axis !== "year");
  const ageExpr = `${d.year("index_date")} - dobyr`;
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
        return `CAST(${d.year("index_date")} AS VARCHAR)`;
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
  // machine-readable twin contract: the harness compares this stamp against the
  // SAS twin's — built from the values THIS builder consumed (see parity.ts)
  L.push(`-- ${parityStamp("incidence", incidenceParity(an, { daysPerYear: Y, censorTerms: cens, settingFilter: setting.stamped, strata }))}`);
  const limits = incidenceLimitations(an, listSystem);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
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
  L.push(`first_fu AS (   -- first qualifying outcome strictly after index`);
  L.push(`  SELECT c.enrolid, MIN(a.event_date) AS fu_date`);
  L.push(`  FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid AND a.event_date > c.index_date`);
  L.push(`  GROUP BY c.enrolid`);
  L.push(`),`);
  if (needDemo) {
    L.push(`demo AS (   -- enrollment segment in force at (or latest before) index; rn=1 wins`);
    L.push(`  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,`);
    L.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid`);
    L.push(`                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
    L.push(`  FROM atrisk c`);
    L.push(`  JOIN ${ctx.t("enrollment_detail")} en`);
    L.push(`    ON en.enrolid = c.enrolid`);
    L.push(`   AND en.dtstart <= c.index_date`);
    L.push(`),`);
    L.push(`demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),`);
  }
  L.push(`pt AS (`);
  L.push(
    `  SELECT c.enrolid, c.index_date, ${adminCensor} AS admin_censor, f.fu_date` +
      (needDemo ? `,` : ``)
  );
  if (needDemo) L.push(`         dm.dobyr, dm.sex, dm.region, dm.plantyp`);
  L.push(`  FROM atrisk c`);
  L.push(`  JOIN ${wp}_enroll_episodes ep`);
  L.push(`    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end`);
  if (needDemo) L.push(`  LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid`);
  L.push(`  LEFT JOIN first_fu f ON f.enrolid = c.enrolid`);
  L.push(`),`);
  L.push(`pt2 AS (`);
  L.push(`  SELECT ${d.daysBetween(censorFinal, "index_date")} AS person_days,`);
  L.push(
    `         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN 1 ELSE 0 END AS is_case` +
      (strata.length > 0 ? "," : "")
  );
  strata.forEach((s, i) => {
    L.push(`         ${stratExpr(s)} AS strat_${i}${i < strata.length - 1 ? "," : ""}`);
  });
  L.push(`  FROM pt`);
  L.push(`),`);
  L.push(`summ AS (`);
  L.push(`  SELECT 'incidence' AS measure, 'Overall' AS stratifier, 'Overall' AS stratum,`);
  L.push(`         SUM(is_case) AS patients, COUNT(*) AS denominator, SUM(person_days) AS person_days`);
  L.push(`  FROM pt2`);
  strata.forEach((s, i) => {
    L.push(`  UNION ALL`);
    L.push(`  SELECT 'incidence', '${q(stratLabel(s.label))}', strat_${i},`);
    L.push(`         SUM(is_case), COUNT(*), SUM(person_days)`);
    L.push(`  FROM pt2 GROUP BY strat_${i}`);
  });
  L.push(`)`);
  L.push(`SELECT measure, stratifier, stratum, patients, denominator, person_days,`);
  L.push(`       ${d.roundN(`person_days / ${Y}`, 4)} AS person_years,`);
  L.push(`       ${d.roundN(`patients * ${M} * ${Y} / NULLIF(person_days, 0)`, 2)} AS rate_per_1000py,`);
  L.push(`       ${d.roundN(`${byarLow} ${scale}`, 2)} AS ci_low,`);
  L.push(`       ${d.roundN(`${byarHigh} ${scale}`, 2)} AS ci_high,`);
  // labeled with the method actually computed (Byar), never the merely-requested
  // one — a mislabeled statistic is worse than a visibly-substituted one
  L.push(`       'poisson_byar' AS ci_method`);
  L.push(`FROM summ;`);
  L.push("");
  L.push(`-- REVIEW: incidence rate per ${M} person-years, Overall + per stratum.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY stratifier, stratum;`);

  return {
    slug: `incidence${suffix}`,
    title: `07 Incidence rate${suffix ? ` (${an.label})` : ""}`,
    subtitle: "person-time incidence rate with washout + Byar CI",
    extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}); outcome code list "${an.outcomeDefinition.codeListId}".`],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasIncidence(ctx: SasCtx, an: IncidenceRateAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_incidence${suffix}`);
  const cohT = ctx.finalCohort;
  const evT = ctx.evOf(an.outcomeDefinition.codeListId);
  const epiT = ctx.tbl("050_epi");
  const listSystem = findCodeList(spec, an.outcomeDefinition.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  // SAS event tables store setting as 'OP'/'IP' (SQL stores 'outpatient'/'inpatient')
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` :
    setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
  const M = an.rateMultiplier;
  const cens = an.personTimeRule.censorAt;
  const maxFu = an.personTimeRule.maxFollowupDays;

  // administrative-censoring terms — mirrors the SQL twin exactly (death
  // omitted: MarketScan mortality is unascertainable — BR-LIM-002)
  const terms: string[] = [];
  if (cens.includes("disenrollment")) terms.push("ep.dtend");
  if (cens.includes("study_end")) terms.push("&study_end.");
  if (cens.includes("max_followup") && maxFu != null) terms.push(`a.index_date + ${maxFu}`);
  if (terms.length === 0) terms.push("&study_end."); // always bound follow-up
  const adminExpr = terms.length === 1 ? terms[0] : `min(${terms.join(", ")})`;
  const censorsAtOutcome = cens.includes("outcome");

  // demographic strata — labels shared with the SQL twin (parity.ts) so both
  // languages emit byte-identical stratum values. Derived from the enrollment
  // segment (dobyr/sex/region/plantyp), never claim-level AGE, so the twins
  // cannot drift around birthday timing.
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
        return [`${v} = strip(put(year(index_date), 4.));`];
      case "age_band": {
        const bands = s.bands ?? [];
        const labels = ageBandLabels(bands);
        const arms: string[] = [`if age_at_index = . then ${v} = 'Unknown';`];
        if (bands[0] > 0) arms.push(`else if age_at_index < ${bands[0]} then ${v} = '<${bands[0]}';`);
        for (let j = bands.length - 1; j >= 1; j--)
          arms.push(`else if age_at_index >= ${bands[j]} then ${v} = '${labels[j]}';`);
        arms.push(`else ${v} = '${labels[0]}';`);
        return arms;
      }
    }
  };

  const censorWords = [
    ...(censorsAtOutcome ? ["first outcome"] : []),
    ...(cens.includes("disenrollment") ? ["disenrollment (episode end)"] : []),
    ...(cens.includes("study_end") || terms.includes("&study_end.") ? ["study end"] : []),
    ...(cens.includes("max_followup") && maxFu != null ? [`index + ${maxFu}d max follow-up`] : []),
  ].join(" / ");

  const washLines = [
    ...(sasSettingCond ? [sasSettingCond] : []),
    ...sasWindowConds(an.washout, "e"),
  ];
  const limits = incidenceLimitations(an, listSystem);
  const label = an.label.replace(/"/g, "'");

  const lines: string[] = [
    ...header(spec, `${num}_incidence${suffix}.sas`, [
      `Incidence rate (person-time) for "${an.label}":`,
      `prevalent-case washout, at-risk denominator, follow-up censored`,
      `at the earliest of ${censorWords},`,
      `crude rate per ${M} person-years with a Byar exact-Poisson CI.`,
      `Twin of the machine-verified SQL 07_incidence; keep both in sync.`,
    ]),
    // machine-readable twin contract: the harness compares this stamp against
    // the SQL twin's — built from the values THIS program consumed
    `/* ${parityStamp("incidence", incidenceParity(an, { daysPerYear: ctx.daysPerYearLit, censorTerms: cens, settingFilter: setting.stamped, strata }))} */`,
    ``,
  ];

  if (limits.length > 0) {
    lines.push(
      `/* REVIEW - spec options this program does not implement yet:`,
      ...limits.map((l) => `   * ${cmt(l)}`),
      `*/`,
      ``
    );
  }

  lines.push(
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Prevalent-case washout: any qualifying outcome event inside the washout`,
    `  window (${cmt(describeWin(an.washout))})`,
    `  marks the patient PREVALENT - excluded so only new-onset cases count.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join ${evT} as e`,
    `    on e.enrolid = a.enrolid`,
    `  where 1 = 1`,
    ...washLines.map((l, idx) => `    ${l}${idx === washLines.length - 1 ? ";" : ""}`),
    ...(washLines.length === 0 ? [`  ;   /* washout window is unbounded - any prior event counts */`] : []),
    `quit;`,
    ``,
    `title "Washout: prevalent patients excluded (${label})";`,
    `proc sql;`,
    `  select count(distinct enrolid) as prevalent_pat`,
    `  from work._${num}_prev;`,
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
    `/*-------------------- first outcome strictly after index -------------------*/`,
    `proc sql;`,
    `  create table work._${num}_first_fu as`,
    `  select a.enrolid,`,
    `         min(e.svcdate) as fu_date format=date9.`,
    `  from work._${num}_atrisk as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    `    and e.svcdate > a.index_date`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  group by a.enrolid;`,
    `quit;`,
    ``,
    ...(needDemo
      ? [
          `/*----------------------------------------------------------------------------`,
          `  Stratum demographics from the enrollment segment in force at (or latest`,
          `  before) the index date - the SAME source and tie-break as the SQL twin,`,
          `  so stratum values cannot drift between languages.`,
          `----------------------------------------------------------------------------*/`,
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
    `/*----------------------------------------------------------------------------`,
    `  Person-time: administrative censor = earliest of`,
    ...terms.map((t) => `    - ${cmt(t)}`),
    `  taken on the stitched enrollment episode covering the index date.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_pt as`,
    `  select a.enrolid, a.index_date,`,
    `         ${adminExpr} as admin_censor format=date9.,`,
    `         b.fu_date${needDemo ? "," : ""}`,
    ...(needDemo ? [`         dm.dobyr, dm.sex, dm.region, dm.plantyp`] : []),
    `  from work._${num}_atrisk as a`,
    `  inner join ${epiT} as ep`,
    `    on  ep.enrolid = a.enrolid`,
    `    and a.index_date between ep.dtstart and ep.dtend`,
    ...(needDemo
      ? [`  left join work._${num}_dm as dm`, `    on dm.enrolid = a.enrolid`]
      : []),
    `  left join work._${num}_first_fu as b`,
    `    on b.enrolid = a.enrolid;`,
    `quit;`,
    ``,
    `data work._${num}_pt2;`,
    `  set work._${num}_pt;`,
    ...(strata.length > 0
      ? [`  length ${strata.map((_, j) => `strat_${j}`).join(" ")} $40;`]
      : []),
    `  /* a case = first outcome on or before the administrative censor date */`,
    `  is_case = (fu_date ne . and fu_date <= admin_censor);`,
    ...(censorsAtOutcome
      ? [`  /* follow-up stops at the earliest of outcome and admin censoring */`,
         `  censor_date = min(coalesce(fu_date, '31DEC9999'd), admin_censor);`]
      : [`  /* follow-up runs to the admin censor date (no censoring at outcome) */`,
         `  censor_date = admin_censor;`]),
    `  person_days = censor_date - index_date;`,
    ...(needAge
      ? [`  /* enrollment-derived age (year - DOBYR), matching the SQL twin */`,
         `  age_at_index = year(index_date) - dobyr;`]
      : []),
    ...strata.flatMap((s, j) => [
      `  /* stratifier: ${cmt(stratLabel(s.label))} (${s.axis}) */`,
      ...stratAssign(s, `strat_${j}`).map((l) => `  ${l}`),
    ]),
    `  format censor_date date9.;`,
    `run;`,
    ``,
    ...levelCheck(`work._${num}_pt2`, "person-time rows", [
      `sum(is_case) as cases`,
      `sum(person_days) as person_days`,
    ]),
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Crude rate per ${M} person-years + Byar exact-Poisson CI - the SAME closed`,
    `  form as the SQL twin (Ulm AJE 1990;131:373), so both languages agree to`,
    `  the last rounded digit:`,
    `    low  = (1 - 1/(9x) - 1.96/(3*sqrt(x)))^3 * x          (0 when x = 0)`,
    `    high = (1 - 1/(9(x+1)) + 1.96/(3*sqrt(x+1)))^3 * (x+1)`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_summ as`,
    `  select 'Overall' as stratifier length=40,`,
    `         'Overall' as stratum length=40,`,
    `         count(*) as denominator,`,
    `         sum(is_case) as patients,`,
    `         sum(person_days) as person_days`,
    `  from work._${num}_pt2`,
    ...strata.flatMap((s, j) => [
      `  union all`,
      `  select '${sq(stratLabel(s.label))}', strat_${j},`,
      `         count(*), sum(is_case), sum(person_days)`,
      `  from work._${num}_pt2 group by strat_${j}`,
    ]),
    `  ;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_summ;`,
    `  length measure $20 ci_method $16;`,
    `  measure   = 'incidence';`,
    `  /* labeled with the method actually computed, never the merely-requested one */`,
    `  ci_method = 'poisson_byar';`,
    `  person_years = round(person_days / &days_per_year., 0.0001);`,
    `  if person_days > 0 then do;`,
    `    rate_per_1000py = round(patients * ${M} * &days_per_year. / person_days, 0.01);`,
    `    if patients = 0 then _byar_low = 0;`,
    `    else _byar_low = ((1 - 1/(9*patients) - 1.96/(3*sqrt(patients)))**3) * patients;`,
    `    _byar_high = ((1 - 1/(9*(patients+1)) + 1.96/(3*sqrt(patients+1)))**3) * (patients+1);`,
    `    ci_low  = round(_byar_low  * ${M} * &days_per_year. / person_days, 0.01);`,
    `    ci_high = round(_byar_high * ${M} * &days_per_year. / person_days, 0.01);`,
    `  end;`,
    `  else do;`,
    `    rate_per_1000py = .;`,
    `    ci_low  = .;`,
    `    ci_high = .;`,
    `  end;`,
    `  drop _byar_low _byar_high;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by stratifier stratum;`,
    `run;`,
    ``,
    `title "Incidence rate per ${M} person-years: ${label}";`,
    `proc print data=${outT} noobs;`,
    `  var measure stratifier stratum patients denominator person_days person_years`,
    `      rate_per_1000py ci_low ci_high ci_method;`,
    `run;`,
    ``
  );

  return {
    path: `sas/${num}_incidence${suffix}.sas`,
    language: "sas",
    title: `${num} Incidence rate${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const incidenceModule: AnalysisModule<IncidenceRateAnalysis> = {
  analysisKind: "incidence_rate",
  stampKind: "incidence",
  sql: sqlIncidence,
  sas: sasIncidence,
};
