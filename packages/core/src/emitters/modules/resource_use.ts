/**
 * Resource-use and cost module — encounter counts and payments over a window
 * relative to index, both drawn from ONE claim-line ledger (emitters/ledger.ts).
 *
 * Counts and costs are one analysis rather than two on purpose. They are the
 * same denominator, the same window and the same definition of an encounter; a
 * utilization table and a cost table that quietly disagree about what an
 * admission IS are worse than either alone, and that disagreement is invisible
 * in the output.
 *
 * WHAT IS VERIFIED BY EXECUTION, and why the median is here but quartiles are
 * not: SQL's PERCENTILE_CONT(0.5) and SAS's PCTLDEF=5 median agree EXACTLY for
 * every n. With n = 2m, PERCENTILE_CONT interpolates at position (n-1)/2 =
 * m-0.5, giving (x_m + x_{m+1})/2, which is what PCTLDEF=5 returns when np is an
 * integer. With n = 2m+1 both return x_{m+1}. Away from p = 0.5 they diverge —
 * PCTLDEF=5 steps on np while PERCENTILE_CONT interpolates on (n-1)p — so no
 * quartile is emitted rather than emitting two numbers that would disagree in
 * the field and agree in no test.
 *
 * Verified vs Gold Case A over [index, index+364]: 19 encounters across 10
 * members (11 RX, 5 OP, 1 ED, 2 IP) and $18,600 of payments, mean $1,860 against
 * a median of $350 — the right-skew that makes reporting both mandatory. The
 * inpatient total is $15,000; a ledger that summed admission totals WITH their
 * own service lines would report $22,000. Hand-derived, asserted in
 * verify/run.ts.
 */
import type { ResourceUseAnalysis } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine } from "../sql-base";
import { cmt, header, levelCheck, INCLUDE_SETUP } from "../sas-base";
import {
  parityStamp,
  renderDaysPerYear,
  resourceUseLimitations,
  resourceUseParity,
  RESOURCE_USE_METHOD_NOTES,
} from "../parity";
import {
  DEFAULT_ED_PLACE_OF_SERVICE,
  ledgerSasSteps,
  ledgerSqlCtes,
  orderedSettings,
  windowDays,
  SETTING_LABEL,
} from "../ledger";

const MEASURE = "resource_use";

/** Row order in the output: the combined row first, then the ledger order. */
function settingRows(an: ResourceUseAnalysis): string[] {
  const labels = orderedSettings(an.settings).map((s) => SETTING_LABEL[s]);
  return an.includeCombined ? ["ALL", ...labels] : labels;
}

/** Observed-day length the window implies (both ends inclusive). */
function windowLength(an: ResourceUseAnalysis): number | null {
  const { start, end } = windowDays(an.ascertainmentWindow);
  if (typeof an.ascertainmentWindow.start !== "number" || typeof an.ascertainmentWindow.end !== "number") return null;
  return end - start + 1;
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlResourceUse(ctx: SqlCtx, an: ResourceUseAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_hcru${suffix}`;
  const edPlaces = an.edPlaceOfService ?? DEFAULT_ED_PLACE_OF_SERVICE;
  const dpy = renderDaysPerYear(spec);
  const rows = settingRows(an);
  const labels = orderedSettings(an.settings).map((s) => SETTING_LABEL[s]);

  const L: string[] = [];
  L.push(
    `-- ${parityStamp(
      "resource_use",
      resourceUseParity(an, { settings: labels, edPlaces, windowDays: windowLength(an), daysPerYear: dpy }),
    )}`,
  );
  const limits = resourceUseLimitations(an);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of RESOURCE_USE_METHOD_NOTES) L.push(`--   * ${note}`);

  L.push(d.createTableAs(out));
  L.push(...ledgerSqlCtes(ctx, { wp, window: an.ascertainmentWindow, settings: an.settings, costField: an.costField, edPlaces }));

  L.push(`settings_list AS (`);
  labels.forEach((s, i) => {
    L.push(`  ${i === 0 ? "  " : "UNION ALL "}SELECT '${s}' AS setting`);
  });
  L.push(`),`);
  L.push(`by_pt AS (   -- encounters and payments per member per class`);
  L.push(`  SELECT enrolid, setting, COUNT(*) AS n_enc, SUM(paid) AS paid`);
  L.push(`  FROM encounters_kept GROUP BY enrolid, setting`);
  L.push(`),`);
  L.push(`per_pt AS (   -- the WHOLE cohort x every class: a non-user contributes a zero,`);
  L.push(`  -- so the means below are per-member and not per-user`);
  L.push(`  SELECT sl.setting, c.enrolid,`);
  L.push(`         COALESCE(b.n_enc, 0) AS n_enc,`);
  L.push(`         COALESCE(b.paid, 0) AS paid,`);
  L.push(`         ob.observed_days`);
  L.push(`  FROM cohort c`);
  L.push(`  CROSS JOIN settings_list sl`);
  L.push(`  LEFT JOIN by_pt b ON b.enrolid = c.enrolid AND b.setting = sl.setting`);
  L.push(`  JOIN obs ob ON ob.enrolid = c.enrolid`);
  L.push(`),`);
  if (an.includeCombined) {
    L.push(`per_pt_all AS (   -- combined across the chosen classes, still per member`);
    L.push(`  SELECT 'ALL' AS setting, enrolid, SUM(n_enc) AS n_enc, SUM(paid) AS paid,`);
    L.push(`         MAX(observed_days) AS observed_days`);
    L.push(`  FROM per_pt GROUP BY enrolid`);
    L.push(`),`);
  }
  L.push(`stacked AS (`);
  L.push(`  SELECT setting, enrolid, n_enc, paid, observed_days FROM per_pt`);
  if (an.includeCombined) {
    L.push(`  UNION ALL`);
    L.push(`  SELECT setting, enrolid, n_enc, paid, observed_days FROM per_pt_all`);
  }
  L.push(`),`);
  L.push(`summ AS (`);
  L.push(`  SELECT setting,`);
  L.push(`         COUNT(*) AS denominator,`);
  L.push(`         SUM(CASE WHEN n_enc > 0 THEN 1 ELSE 0 END) AS users,`);
  L.push(`         SUM(n_enc) AS encounters,`);
  L.push(`         AVG(CAST(n_enc AS DOUBLE PRECISION)) AS enc_mean,`);
  L.push(`         STDDEV_SAMP(CAST(n_enc AS DOUBLE PRECISION)) AS enc_sd,`);
  // PERCENTILE_CONT at p=0.5 only — see the module header for why no quartile.
  L.push(`         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(n_enc AS DOUBLE PRECISION)) AS enc_median,`);
  L.push(`         MAX(n_enc) AS enc_max,`);
  L.push(`         SUM(paid) AS paid_total,`);
  L.push(`         AVG(CAST(paid AS DOUBLE PRECISION)) AS paid_mean,`);
  L.push(`         STDDEV_SAMP(CAST(paid AS DOUBLE PRECISION)) AS paid_sd,`);
  L.push(`         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(paid AS DOUBLE PRECISION)) AS paid_median,`);
  L.push(`         MAX(paid) AS paid_max,`);
  L.push(`         SUM(observed_days) AS observed_days`);
  L.push(`  FROM stacked GROUP BY setting`);
  L.push(`)`);
  L.push(`SELECT '${MEASURE}' AS measure, s.setting,`);
  L.push(`       s.users, s.denominator,`);
  L.push(`       ${d.roundN(`s.users * 100.0 / NULLIF(s.denominator, 0)`, 2)} AS users_pct,`);
  L.push(`       s.encounters,`);
  L.push(`       ${d.roundN(`s.enc_mean`, 5)} AS enc_per_patient,`);
  L.push(`       ${d.roundN(`s.enc_sd`, 5)} AS enc_sd,`);
  L.push(`       ${d.roundN(`s.enc_median`, 5)} AS enc_median,`);
  L.push(`       s.enc_max,`);
  L.push(`       s.observed_days,`);
  L.push(`       ${d.roundN(`s.encounters * ${dpy} / NULLIF(s.observed_days, 0)`, 5)} AS enc_per_person_year,`);
  L.push(`       ${d.roundN(`s.paid_total`, 2)} AS paid_total,`);
  L.push(`       ${d.roundN(`s.paid_mean`, 2)} AS paid_per_patient,`);
  L.push(`       ${d.roundN(`s.paid_sd`, 2)} AS paid_sd,`);
  L.push(`       ${d.roundN(`s.paid_median`, 2)} AS paid_median,`);
  L.push(`       ${d.roundN(`s.paid_max`, 2)} AS paid_max,`);
  L.push(`       ${d.roundN(`s.paid_total * ${dpy} / NULLIF(s.observed_days, 0)`, 2)} AS paid_per_person_year,`);
  L.push(`       '${an.costField}' AS cost_field,`);
  L.push(`       ord.setting_ord`);
  L.push(`FROM summ s`);
  L.push(`JOIN (`);
  rows.forEach((s, i) => {
    L.push(`  ${i === 0 ? "  " : "UNION ALL "}SELECT '${s}' AS setting, ${i} AS setting_ord`);
  });
  L.push(`) ord ON ord.setting = s.setting`);
  L.push(`ORDER BY ord.setting_ord;`);
  L.push("");
  L.push(`-- REVIEW: resource use and cost per member over the window, by care setting.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY setting_ord;`);

  const { start, end } = windowDays(an.ascertainmentWindow);
  return {
    slug: `hcru${suffix}`,
    title: `Resource use and cost${suffix ? ` (${an.label})` : ""}`,
    subtitle: "encounter counts and payments per member, by care setting",
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); payment column ${an.costField}.`,
      `Window: day ${start} to day ${end} relative to index, inclusive (${windowLength(an) ?? "?"} days).`,
      `Settings: ${labels.join(", ")}${an.includeCombined ? " (+ combined ALL row)" : ""}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasResourceUse(ctx: SasCtx, an: ResourceUseAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_hcru${suffix}`);
  const cohT = ctx.finalCohort;
  const epiT = ctx.tbl("050_epi");
  const edPlaces = an.edPlaceOfService ?? DEFAULT_ED_PLACE_OF_SERVICE;
  const dpy = renderDaysPerYear(spec);
  const rows = settingRows(an);
  const labels = orderedSettings(an.settings).map((s) => SETTING_LABEL[s]);
  const limits = resourceUseLimitations(an);
  const label = an.label.replace(/"/g, "'");
  const { start, end } = windowDays(an.ascertainmentWindow);

  const ledger = ledgerSasSteps(ctx, {
    wp: "",
    num,
    cohT,
    epiT,
    window: an.ascertainmentWindow,
    settings: an.settings,
    costField: an.costField,
    edPlaces,
  });

  const lines: string[] = [
    ...header(spec, `${num}_hcru${suffix}.sas`, [
      `Resource use and cost for "${an.label}": encounter counts and payments`,
      `per member over day ${start} to day ${end} relative to index, by care`,
      `setting, from the shared claim-line ledger.`,
      `Inpatient stays take the ADMISSION total and drop their own service`,
      `lines - summing both is the classic double count.`,
      `Twin of the SQL hcru program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp(
      "resource_use",
      resourceUseParity(an, { settings: labels, edPlaces, windowDays: windowLength(an), daysPerYear: dpy }),
    )} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...RESOURCE_USE_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    ...ledger.lines,
    `/*-------------------- per-member x class grid (zeros included) --------------*/`,
    `data work._${num}_settings;`,
    `  length setting $3;`,
    ...labels.map((s) => `  setting = "${s}"; output;`),
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_perpt as`,
    `  select s.setting, a.enrolid,`,
    `         coalesce(b.n_enc, 0) as n_enc,`,
    `         coalesce(b.paid, 0)  as paid,`,
    `         o.observed_days`,
    `  from ${cohT} as a`,
    `  cross join work._${num}_settings as s`,
    `  left join (select enrolid, setting, count(*) as n_enc, sum(paid) as paid`,
    `             from ${ledger.encounters} group by enrolid, setting) as b`,
    `    on  b.enrolid = a.enrolid`,
    `    and b.setting = s.setting`,
    `  inner join ${ledger.obs} as o`,
    `    on o.enrolid = a.enrolid;`,
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_perpt`, "member x class rows"),
    ``,
  );
  if (an.includeCombined) {
    lines.push(
      `/* combined across the chosen classes, still per member */`,
      `proc sql;`,
      `  create table work._${num}_all as`,
      `  select 'ALL' as setting length=3, enrolid,`,
      `         sum(n_enc) as n_enc, sum(paid) as paid,`,
      `         max(observed_days) as observed_days`,
      `  from work._${num}_perpt group by enrolid;`,
      `quit;`,
      ``,
      `data work._${num}_stack;`,
      `  set work._${num}_perpt work._${num}_all;`,
      `run;`,
      ``,
    );
  } else {
    lines.push(`data work._${num}_stack; set work._${num}_perpt; run;`, ``);
  }
  lines.push(
    `proc sort data=work._${num}_stack; by setting; run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  PCTLDEF=5 is stated EXPLICITLY rather than left to the site default.`,
    `  At p = 0.5 it agrees with the SQL twin's PERCENTILE_CONT for every n: with`,
    `  n even both return the average of the two central order statistics, with n`,
    `  odd both return the central one. That equality is why a median is emitted`,
    `  at all - away from 0.5 the two estimators genuinely differ, which is why no`,
    `  quartile is emitted by either twin.`,
    `----------------------------------------------------------------------------*/`,
    `proc univariate data=work._${num}_stack pctldef=5 noprint;`,
    `  by setting;`,
    `  var n_enc paid;`,
    `  output out=work._${num}_stats`,
    `    sum    = encounters paid_total`,
    `    mean   = enc_mean   paid_mean`,
    `    std    = enc_sd     paid_sd`,
    `    median = enc_median paid_median`,
    `    max    = enc_max    paid_max;`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_extra as`,
    `  select setting,`,
    `         count(*) as denominator,`,
    `         sum(case when n_enc > 0 then 1 else 0 end) as users,`,
    `         sum(observed_days) as observed_days`,
    `  from work._${num}_stack group by setting;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  merge work._${num}_stats work._${num}_extra;`,
    `  by setting;`,
    `  length measure $20 cost_field $8;`,
    `  measure    = "${MEASURE}";`,
    `  cost_field = "${an.costField}";`,
    `  if encounters = . then encounters = 0;`,
    `  if paid_total = . then paid_total = 0;`,
    `  if denominator > 0 then users_pct = round(100 * users / denominator, 0.01);`,
    `  enc_per_patient = round(enc_mean, 0.00001);`,
    `  enc_sd          = round(enc_sd, 0.00001);`,
    `  enc_median      = round(enc_median, 0.00001);`,
    `  paid_per_patient = round(paid_mean, 0.01);`,
    `  paid_sd          = round(paid_sd, 0.01);`,
    `  paid_median      = round(paid_median, 0.01);`,
    `  paid_max         = round(paid_max, 0.01);`,
    `  paid_total       = round(paid_total, 0.01);`,
    `  /* same person-time constant the incidence twins use, from 00_setup */`,
    `  if observed_days > 0 then do;`,
    `    enc_per_person_year  = round(encounters * ${dpy} / observed_days, 0.00001);`,
    `    paid_per_person_year = round(paid_total * ${dpy} / observed_days, 0.01);`,
    `  end;`,
    ...rows.map((s, i) => `  ${i === 0 ? "if" : "else if"} setting = "${s}" then setting_ord = ${i};`),
    `  drop enc_mean paid_mean;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by setting_ord;`,
    `run;`,
    ``,
    `title "Resource use and cost: ${label}";`,
    `proc print data=${outT} noobs;`,
    `  var measure setting users denominator users_pct encounters enc_per_patient`,
    `      enc_sd enc_median enc_max observed_days enc_per_person_year`,
    `      paid_total paid_per_patient paid_sd paid_median paid_max`,
    `      paid_per_person_year cost_field;`,
    `run;`,
    ``,
  );

  return {
    path: `sas/${num}_hcru${suffix}.sas`,
    language: "sas",
    title: `${num} Resource use and cost${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const resourceUseModule: AnalysisModule<ResourceUseAnalysis> = {
  analysisKind: "resource_use",
  stampKind: "resource_use",
  resultSlug: "hcru",
  sql: sqlResourceUse,
  sas: sasResourceUse,
};
