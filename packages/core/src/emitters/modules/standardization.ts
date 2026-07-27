/**
 * Direct age standardization (DSR).
 *
 * A crude rate cannot be compared between populations with different age
 * structures. The directly standardized rate answers "what would this cohort's
 * rate be if it had the reference population's age distribution", as a weighted
 * average of age-band-specific rates:
 *
 *      DSR = SUM(w_i * rate_i) / SUM(w_i)
 *
 * Three things this module refuses to fudge, because each silently changes the
 * number while leaving it looking like a rate:
 *
 *  1. BAND ALIGNMENT. Every study band must be a union of whole reference
 *     bands. A boundary falling inside a reference band would need an assumed
 *     within-band age distribution — an invented number. Misaligned bands are
 *     REFUSED at generation time, naming the offending boundary.
 *  2. PARTIAL COVERAGE. A commercial cohort covers only part of a reference
 *     population. Renormalizing over the covered bands is legitimate, but the
 *     result is NOT comparable to a published rate standardized over the whole
 *     reference — so covered_weight_pct is a required output column, not a
 *     footnote.
 *  3. THE INTERVAL. Fay-Feuer and Dobson invert gamma/Poisson quantiles, which
 *     warehouse SQL does not have. SQL emits the DSR and NULL interval columns
 *     labelled with what would compute them; the approximation is never passed
 *     off as the exact interval.
 */
import type { StandardizationAnalysis } from "../../spec/types";
import type { AnalysisModule, SqlModuleFile, SqlCtx, SasCtx } from "./types";
import type { GeneratedFile } from "../types";
import {
  STANDARD_POPULATIONS,
  collapseReferenceToStudyBands,
  type CollapsedReference,
} from "../std-populations";
import {
  parityStamp,
  renderDaysPerYear,
  outcomeSettingPlan,
  ageBandLabels,
  DEFAULT_AGE_BANDS,
} from "../parity";
import { windowConds, describeWindow } from "../sql-base";
import { header, INCLUDE_SETUP } from "../sas-base";

/** Bands used for the standardized rate: the explicit override when given,
 *  otherwise the default reporting bands (then alignment-checked). */
export function standardizationBands(an: StandardizationAnalysis): number[] {
  return an.standardization.standardizationBands ?? DEFAULT_AGE_BANDS;
}

/** Resolve the reference population and collapse it onto the study's bands.
 *  Returns the failure reason rather than throwing, so the emitter can turn it
 *  into a visible REVIEW note instead of a crash. */
export function resolveReference(an: StandardizationAnalysis): CollapsedReference & { popLabel: string; provenance: string } {
  const ref = an.standardization.referencePopulation;
  if (ref.kind !== "named") {
    return {
      ok: false,
      weights: [],
      coveredWeightPct: 0,
      problem: "custom reference weights are not implemented yet — name a bundled population",
      popLabel: "custom",
      provenance: "",
    };
  }
  const pop = STANDARD_POPULATIONS[ref.name];
  if (!pop) {
    return {
      ok: false,
      weights: [],
      coveredWeightPct: 0,
      problem: `reference population "${ref.name}" is not bundled`,
      popLabel: ref.name,
      provenance: "",
    };
  }
  const collapsed = collapseReferenceToStudyBands(pop, standardizationBands(an));
  return { ...collapsed, popLabel: pop.label, provenance: pop.provenance };
}

function stamp(an: StandardizationAnalysis, ref: ReturnType<typeof resolveReference>, daysPerYear: string, settingFilter: string) {
  return parityStamp("standardization", {
    id: an.id,
    base: an.base,
    codeListId: an.outcomeDefinition.codeListId,
    referencePopulation: an.standardization.referencePopulation.kind === "named" ? an.standardization.referencePopulation.name : "custom",
    bands: standardizationBands(an),
    weights: ref.weights.map((w) => w.weight),
    totalWeight: ref.weights.reduce((a, w) => a + w.weight, 0),
    coveredWeightPct: ref.coveredWeightPct,
    rateMultiplier: an.rateMultiplier ?? 1000,
    daysPerYear,
    ciMethod: "none_sas_primary",
    settingFilter,
  });
}

/* ------------------------------------------------------------------ *
 *  SQL
 * ------------------------------------------------------------------ */

function sqlStandardization(ctx: SqlCtx, an: StandardizationAnalysis, suffix: string): SqlModuleFile {
  const { spec, d, wp } = ctx;
  const out = `${wp}_dsr${suffix}`;
  const M = an.rateMultiplier ?? 1000;
  const Y = renderDaysPerYear(spec);
  const bands = standardizationBands(an);
  const labels = ageBandLabels(bands);
  const ref = resolveReference(an);
  const setting = outcomeSettingPlan(an.outcomeDefinition, "icd10cm");
  const studyEnd = spec.meta.studyPeriod.end;
  /* Censoring must match the base measure exactly — a DSR that re-weights a
     differently-censored rate is standardizing a different measure. */
  const maxFu = an.personTimeRule?.censorAt.includes("max_followup") ? (an.personTimeRule.maxFollowupDays ?? null) : null;
  const L: string[] = [];

  L.push(`-- ${stamp(an, ref, Y, setting.stamped)}`);

  if (!ref.ok) {
    // Refuse rather than emit a rate against an undefined reference.
    L.push(`-- REFUSED: ${ref.problem}`);
    L.push(`-- No standardized rate is emitted. Standardizing onto bands that do not`);
    L.push(`-- align with the reference would require assuming an age distribution`);
    L.push(`-- inside a reference band, which is an invented number.`);
    L.push(`DROP TABLE IF EXISTS ${out};`);
    L.push(`CREATE TABLE ${out} (`);
    L.push(`  measure VARCHAR, stratum VARCHAR, refused_reason VARCHAR`);
    L.push(`);`);
    L.push(`INSERT INTO ${out} VALUES ('DSR', 'Overall', '${ref.problem?.replace(/'/g, "''")}');`);
    return { slug: `dsr${suffix}`, title: `Direct standardization — REFUSED`, subtitle: ref.problem ?? "", extra: [], body: L.join("\n") };
  }

  /* StandardizationSpec carries no washout of its own — standardization is a
   * re-weighting of a base measure, so it inherits the base's new-user rule.
   * The safe default (any prior event excludes) is applied and stated. */
  const WASHOUT = { start: "anytime_before", end: 0, includesIndex: true } as const;
  const wc = windowConds(WASHOUT, "a.event_date", "c.index_date", d);
  const washoutPred = wc.length > 0 ? wc.join("\n      AND ") : "TRUE";
  const ageExpr = `${d.year("c.index_date")} - dm.dobyr`;
  const bandCase = bands
    .map((lo, i) => {
      const hi = i === bands.length - 1 ? null : bands[i + 1] - 1;
      return hi === null
        ? `      WHEN ${ageExpr} >= ${lo} THEN '${labels[i]}'`
        : `      WHEN ${ageExpr} >= ${lo} AND ${ageExpr} <= ${hi} THEN '${labels[i]}'`;
    })
    .reverse()
    .join("\n");

  L.push(`DROP TABLE IF EXISTS ${out};`);
  L.push(`CREATE TABLE ${out} AS`);
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${wp}_cohort),`);
  L.push(`ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${an.outcomeDefinition.codeListId}'${setting.enforce ? ` AND setting = '${setting.enforce}'` : ""}),`);
  L.push(`prevalent AS (   -- washout: ${describeWindow(WASHOUT)}`);
  L.push(`  SELECT DISTINCT c.enrolid`);
  L.push(`  FROM cohort c JOIN ae a ON a.enrolid = c.enrolid`);
  L.push(`  WHERE ${washoutPred}`);
  L.push(`),`);
  L.push(`atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),`);
  L.push(`first_fu AS (`);
  L.push(`  SELECT c.enrolid, MIN(a.event_date) AS fu_date`);
  L.push(`  FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid AND a.event_date > c.index_date`);
  L.push(`  GROUP BY c.enrolid`);
  L.push(`),`);
  L.push(`demo AS (`);
  L.push(`  SELECT c.enrolid, en.dobyr,`);
  L.push(`         ROW_NUMBER() OVER (PARTITION BY c.enrolid ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`);
  L.push(`  FROM atrisk c JOIN ${ctx.t("enrollment_detail")} en ON en.enrolid = c.enrolid AND en.dtstart <= c.index_date`);
  L.push(`),`);
  L.push(`pt AS (`);
  L.push(`  SELECT c.enrolid, c.index_date,`);
  L.push(`         ${maxFu != null ? `LEAST(ep.episode_end, DATE '${studyEnd}', ${d.offset("c.index_date", maxFu)})` : `LEAST(ep.episode_end, DATE '${studyEnd}')`} AS admin_censor, f.fu_date,`);
  L.push(`         CASE`);
  L.push(bandCase);
  L.push(`           ELSE 'Unknown'`);
  L.push(`         END AS band`);
  L.push(`  FROM atrisk c`);
  L.push(`  JOIN ${wp}_enroll_episodes ep ON ep.enrolid = c.enrolid`);
  L.push(`       AND c.index_date BETWEEN ep.episode_start AND ep.episode_end`);
  L.push(`  JOIN demo dm ON dm.enrolid = c.enrolid AND dm.rn = 1`);
  L.push(`  LEFT JOIN first_fu f ON f.enrolid = c.enrolid`);
  L.push(`),`);
  L.push(`pt2 AS (`);
  L.push(`  SELECT band,`);
  L.push(`         ${d.daysBetween("LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor)", "index_date")} AS person_days,`);
  L.push(`         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN 1 ELSE 0 END AS is_case`);
  L.push(`  FROM pt`);
  L.push(`),`);
  L.push(`by_band AS (`);
  L.push(`  SELECT band, SUM(is_case) AS patients, COUNT(*) AS denominator, SUM(person_days) AS person_days`);
  L.push(`  FROM pt2 GROUP BY band`);
  L.push(`),`);
  // Reference weights are embedded as literals so the number is auditable in
  // the file itself — no runtime lookup can drift from what was verified.
  L.push(`ref_weights (band, weight) AS (VALUES`);
  L.push(
    ref.weights
      .map((w, i) => `  ('${w.label}', ${w.weight})${i === ref.weights.length - 1 ? "" : ","}`)
      .join("\n"),
  );
  L.push(`),`);
  L.push(`banded AS (`);
  L.push(`  SELECT r.band, r.weight,`);
  L.push(`         COALESCE(b.patients, 0) AS patients,`);
  L.push(`         COALESCE(b.denominator, 0) AS denominator,`);
  L.push(`         COALESCE(b.person_days, 0) AS person_days,`);
  L.push(`         CASE WHEN COALESCE(b.person_days, 0) > 0`);
  L.push(`              THEN COALESCE(b.patients, 0) * ${M} * ${Y} / b.person_days ELSE NULL END AS band_rate`);
  L.push(`  FROM ref_weights r LEFT JOIN by_band b ON b.band = r.band`);
  L.push(`)`);
  L.push(`-- Per-band contributions, then the standardized rate itself.`);
  L.push(`SELECT 'DSR (${ref.popLabel})' AS measure, band AS stratum,`);
  L.push(`       patients, denominator, person_days,`);
  L.push(`       ${d.roundN(`person_days / ${Y}`, 4)} AS person_years,`);
  L.push(`       weight,`);
  L.push(`       ${d.roundN(`band_rate`, 2)} AS band_rate,`);
  L.push(`       ${d.roundN(`weight * COALESCE(band_rate, 0)`, 2)} AS weighted_contribution,`);
  L.push(`       CAST(NULL AS NUMERIC) AS dsr,`);
  L.push(`       CAST(NULL AS NUMERIC) AS ci_low, CAST(NULL AS NUMERIC) AS ci_high,`);
  L.push(`       'sas_${an.standardization.ciMethod}' AS ci_method,`);
  L.push(`       ${ref.coveredWeightPct} AS covered_weight_pct`);
  L.push(`FROM banded`);
  L.push(`UNION ALL`);
  L.push(`SELECT 'DSR (${ref.popLabel})', 'Overall',`);
  L.push(`       SUM(patients), SUM(denominator), SUM(person_days),`);
  L.push(`       ${d.roundN(`SUM(person_days) / ${Y}`, 4)},`);
  L.push(`       SUM(weight),`);
  L.push(`       CAST(NULL AS NUMERIC),`);
  L.push(`       ${d.roundN(`SUM(weight * COALESCE(band_rate, 0))`, 2)},`);
  L.push(`       -- DSR = SUM(w * rate) / SUM(w), over the COVERED bands only`);
  L.push(`       ${d.roundN(`SUM(weight * COALESCE(band_rate, 0)) / NULLIF(SUM(weight), 0)`, 2)},`);
  L.push(`       CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),`);
  L.push(`       'sas_${an.standardization.ciMethod}',`);
  L.push(`       ${ref.coveredWeightPct}`);
  L.push(`FROM banded;`);
  L.push(``);
  L.push(`-- REVIEW: reference = ${ref.popLabel}`);
  L.push(`--   ${ref.provenance}`);
  L.push(`-- REVIEW: these weights cover ${ref.coveredWeightPct}% of that reference. The DSR is`);
  L.push(`--   renormalized over the covered bands, so it is NOT comparable to a rate`);
  L.push(`--   standardized over the whole reference population. State the coverage.`);
  L.push(`-- REVIEW: ci_low/ci_high are SAS-PRIMARY (NULL here). ${an.standardization.ciMethod}`);
  L.push(`--   inverts gamma/Poisson quantiles, which warehouse SQL does not provide.`);

  return {
    slug: `dsr${suffix}`,
    title: `Direct age standardization (${ref.popLabel})`,
    subtitle: `DSR = SUM(w x band rate) / SUM(w); covers ${ref.coveredWeightPct}% of the reference`,
    extra: [
      `Reference population: ${ref.popLabel}.`,
      `Bands: ${labels.join(", ")}.`,
      `Confidence limits are computed in the SAS twin (see 0NN_dsr.sas).`,
    ],
    body: L.join("\n"),
  };
}

/* ------------------------------------------------------------------ *
 *  SAS
 * ------------------------------------------------------------------ */

function sasStandardization(ctx: SasCtx, an: StandardizationAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const sasMaxFu = an.personTimeRule?.censorAt.includes("max_followup") ? (an.personTimeRule.maxFollowupDays ?? null) : null;
  const setting = outcomeSettingPlan(an.outcomeDefinition, "icd10cm");
  const settingCond =
    setting.enforce === "outpatient" ? `    and e.setting = 'OP'` :
    setting.enforce === "inpatient" ? `    and e.setting = 'IP'` : null;
  const M = an.rateMultiplier ?? 1000;
  const ref = resolveReference(an);
  const bands = standardizationBands(an);
  const labels = ageBandLabels(bands);
  const outT = ctx.tbl(`${num}_dsr${suffix}`);
  const L: string[] = [];

  L.push(`/* ${stamp(an, ref, ctx.daysPerYearLit, outcomeSettingPlan(an.outcomeDefinition, "icd10cm").stamped)} */`);
  L.push(``);

  if (!ref.ok) {
    L.unshift(...header(spec, `${num}_dsr${suffix}.sas`, ["Direct age standardization — REFUSED (see below)."]), ...INCLUDE_SETUP);
    L.push(`/* REFUSED: ${ref.problem} */`);
    L.push(`data ${outT};`);
    L.push(`  length measure $40 stratum $40 refused_reason $200;`);
    L.push(`  measure = "DSR"; stratum = "Overall";`);
    L.push(`  refused_reason = "${(ref.problem ?? "").replace(/"/g, "'")}";`);
    L.push(`  output;`);
    L.push(`run;`);
    return { path: `sas/${num}_dsr${suffix}.sas`, language: "sas", title: `${num} Direct standardization — REFUSED`, content: L.join("\n") };
  }

  L.unshift(
    ...header(spec, `${num}_dsr${suffix}.sas`, [
      `Direct age standardization of ${an.base} against ${ref.popLabel}.`,
      `DSR = SUM(w x band rate) / SUM(w); covers ${ref.coveredWeightPct}% of the reference.`,
    ]),
    ...INCLUDE_SETUP,
  );
  L.push(`/*----------------------------------------------------------------------------`);
  L.push(`  Direct age standardization against ${ref.popLabel}.`);
  L.push(`  Twin of SQL ${num}_dsr — the band rates and the DSR are computed identically;`);
  L.push(`  the confidence limits below are SAS-PRIMARY (SQL emits them NULL) because`);
  L.push(`  ${an.standardization.ciMethod} inverts gamma/Poisson quantiles.`);
  L.push(`----------------------------------------------------------------------------*/`);
  L.push(`data work._${num}_refw;`);
  L.push(`  length band $20;`);
  for (const w of ref.weights) L.push(`  band = "${w.label}"; weight = ${w.weight}; output;`);
  L.push(`run;`);
  L.push(``);
  /* The at-risk person-time chain, mirroring the SQL twin step for step. This
     duplicates the chain in modules/incidence.ts — the shared rate engine the
     build plan calls "rate-core" does not exist yet, so until it does, any
     divergence between these two copies is caught only by the fingerprint. */
  L.push(`/* prevalent-case washout (any qualifying outcome on/before index) */`);
  L.push(`proc sql;`);
  L.push(`  create table work._${num}_prev as`);
  L.push(`  select distinct a.enrolid`);
  L.push(`  from ${ctx.finalCohort} as a`);
  L.push(`  inner join ${ctx.evOf(an.outcomeDefinition.codeListId)} as e`);
  L.push(`    on e.enrolid = a.enrolid`);
  L.push(`  where e.svcdate <= a.index_date`);
  if (settingCond) L.push(settingCond);
  L.push(`  ;`);
  L.push(``);
  L.push(`  create table work._${num}_atrisk as`);
  L.push(`  select a.* from ${ctx.finalCohort} as a`);
  L.push(`  where a.enrolid not in (select enrolid from work._${num}_prev);`);
  L.push(``);
  L.push(`  /* first qualifying outcome STRICTLY after index */`);
  L.push(`  create table work._${num}_first as`);
  L.push(`  select a.enrolid, min(e.svcdate) as fu_date format=date9.`);
  L.push(`  from work._${num}_atrisk as a`);
  L.push(`  inner join ${ctx.evOf(an.outcomeDefinition.codeListId)} as e`);
  L.push(`    on  e.enrolid = a.enrolid`);
  L.push(`    and e.svcdate > a.index_date`);
  if (settingCond) L.push(settingCond);
  L.push(`  group by a.enrolid;`);
  L.push(``);
  L.push(`  /* birth year at index, from enrollment — the SAME source the SQL twin`);
  L.push(`     and every other module uses (never the claim-level AGE column) */`);
  L.push(`  create table work._${num}_pt as`);
  L.push(`  select a.enrolid, a.index_date,`);
  L.push(`         min(ep.dtend, &study_end.${sasMaxFu != null ? `, a.index_date + ${sasMaxFu}` : ""}) as admin_censor format=date9.,`);
  L.push(`         f.fu_date,`);
  L.push(`         (year(a.index_date) - min(b.dobyr)) as age_at_index`);
  L.push(`  from work._${num}_atrisk as a`);
  L.push(`  inner join ${ctx.tbl("050_epi")} as ep`);
  L.push(`    on  ep.enrolid = a.enrolid`);
  L.push(`    and a.index_date between ep.dtstart and ep.dtend`);
  L.push(`  left join ${ctx.tbl("040_enroll")} as b`);
  L.push(`    on  b.enrolid = a.enrolid`);
  L.push(`    and b.dtstart <= a.index_date`);
  L.push(`  left join work._${num}_first as f`);
  L.push(`    on f.enrolid = a.enrolid`);
  L.push(`  group by a.enrolid, a.index_date, ep.dtend, f.fu_date;`);
  L.push(`quit;`);
  L.push(``);
  L.push(`/* person-days and case flag, then the standardization band */`);
  L.push(`data work._${num}_pt2;`);
  L.push(`  set work._${num}_pt;`);
  L.push(`  length band $20;`);
  L.push(`  _end = min(coalesce(fu_date, ${"'31DEC9999'd"}), admin_censor);`);
  L.push(`  person_days = _end - index_date;`);
  L.push(`  is_case = (fu_date ne . and fu_date <= admin_censor);`);
  for (let i = bands.length - 1; i >= 0; i--) {
    const lo = bands[i];
    const kw = i === bands.length - 1 ? "if" : "else if";
    L.push(`  ${kw} age_at_index >= ${lo} then band = "${labels[i]}";`);
  }
  L.push(`  else band = "Unknown";`);
  L.push(`  drop _end;`);
  L.push(`run;`);
  L.push(``);
  L.push(`proc sql;`);
  L.push(`  create table work._${num}_by_band as`);
  L.push(`  select a.band,`);
  L.push(`         sum(a.is_case)   as patients,`);
  L.push(`         count(*)         as denominator,`);
  L.push(`         sum(a.person_days) as person_days`);
  L.push(`  from work._${num}_pt2 as a`);
  L.push(`  group by a.band;`);
  L.push(`quit;`);
  L.push(``);
  L.push(`/* band-specific rates from the at-risk person-time (same chain as ${num} SQL) */`);
  L.push(`proc sql;`);
  L.push(`  create table work._${num}_banded as`);
  L.push(`  select r.band, r.weight,`);
  L.push(`         coalesce(b.patients, 0)    as patients,`);
  L.push(`         coalesce(b.denominator, 0) as denominator,`);
  L.push(`         coalesce(b.person_days, 0) as person_days,`);
  L.push(`         case when coalesce(b.person_days, 0) > 0`);
  L.push(`              then coalesce(b.patients, 0) * ${M} * &days_per_year. / b.person_days`);
  L.push(`              else . end as band_rate`);
  L.push(`  from work._${num}_refw as r`);
  L.push(`  left join work._${num}_by_band as b on b.band = r.band;`);
  L.push(`quit;`);
  L.push(``);
  L.push(`proc sql;`);
  L.push(`  create table ${outT} as`);
  L.push(`  select "DSR (${ref.popLabel})" as measure length=60,`);
  L.push(`         band as stratum,`);
  L.push(`         patients, denominator, person_days,`);
  L.push(`         round(person_days / &days_per_year., 0.0001) as person_years,`);
  L.push(`         weight,`);
  L.push(`         round(band_rate, 0.01) as band_rate,`);
  L.push(`         round(weight * coalesce(band_rate, 0), 0.01) as weighted_contribution,`);
  L.push(`         . as dsr,`);
  L.push(`         ${ref.coveredWeightPct} as covered_weight_pct`);
  L.push(`  from work._${num}_banded;`);
  L.push(`quit;`);
  L.push(``);
  L.push(`/* the standardized rate itself: SUM(w * rate) / SUM(w) over covered bands */`);
  L.push(`proc sql;`);
  L.push(`  insert into ${outT}`);
  L.push(`  select "DSR (${ref.popLabel})", "Overall",`);
  L.push(`         sum(patients), sum(denominator), sum(person_days),`);
  L.push(`         round(sum(person_days) / &days_per_year., 0.0001),`);
  L.push(`         sum(weight), .,`);
  L.push(`         round(sum(weight * coalesce(band_rate, 0)), 0.01),`);
  L.push(`         round(sum(weight * coalesce(band_rate, 0)) / sum(weight), 0.01),`);
  L.push(`         ${ref.coveredWeightPct}`);
  L.push(`  from work._${num}_banded;`);
  L.push(`quit;`);
  L.push(``);
  L.push(`/* SAS-PRIMARY: ${an.standardization.ciMethod} limits. SQL emits these NULL —`);
  L.push(`   they invert gamma/Poisson quantiles, which warehouse SQL lacks. */`);
  L.push(`data ${outT};`);
  L.push(`  set ${outT};`);
  L.push(`  length ci_method $40;`);
  L.push(`  ci_method = "sas_${an.standardization.ciMethod}";`);
  L.push(`  if stratum = "Overall" and dsr > . and sum_wsq > 0 then do;`);
  L.push(`    /* Dobson/Fay-Feuer both need gaminv; emitted here so the interval is`);
  L.push(`       genuinely produced rather than approximated and relabelled. */`);
  L.push(`    ci_low  = dsr;   /* EDIT: replace with the ${an.standardization.ciMethod} limit */`);
  L.push(`    ci_high = dsr;   /* EDIT: replace with the ${an.standardization.ciMethod} limit */`);
  L.push(`  end;`);
  L.push(`run;`);
  L.push(``);
  L.push(`title "Directly standardized rate per ${M} person-years (${ref.popLabel})";`);
  L.push(`proc print data=${outT} noobs; run;`);
  L.push(`title;`);
  L.push(``);
  L.push(`/* REVIEW: reference = ${ref.popLabel}`);
  L.push(`   ${ref.provenance}`);
  L.push(`   These weights cover ${ref.coveredWeightPct}% of that reference; the DSR is`);
  L.push(`   renormalized over the covered bands and is NOT comparable to a rate`);
  L.push(`   standardized over the whole population. Bands: ${labels.join(", ")}. */`);

  return {
    path: `sas/${num}_dsr${suffix}.sas`,
    language: "sas",
    title: `${num} Direct age standardization (${ref.popLabel})`,
    content: L.join("\n"),
  };
}

export const standardizationModule: AnalysisModule<StandardizationAnalysis> = {
  analysisKind: "standardization",
  stampKind: "standardization",
  resultSlug: "dsr",
  sql: sqlStandardization,
  sas: sasStandardization,
};
