/**
 * Statistical engine — covariate BALANCE between exposure arms (SMD table).
 *
 * This is the one inferential-adjacent quantity that is fully SQL-computable:
 * means, variances and proportions by group, combined in closed form. No PROC,
 * no CDF, no iteration — so the SAS and SQL twins compute the same number and
 * the harness can execute the SQL side against hand-computed truth.
 *
 * Method (Austin, Stat Med 2009;28:3083; Austin & Stuart 2015):
 *   continuous: SMD = (mean_ref - mean_other) / sqrt((var_ref + var_other) / 2)
 *   binary:     SMD = (p_ref - p_other)       / sqrt((p_ref(1-p_ref) + p_other(1-p_other)) / 2)
 * with SAMPLE variance (n-1) in both arms, and the sign taken as
 * reference-minus-comparator so a negative SMD reads "reference arm is lower".
 *
 * SMD is a DESCRIPTIVE balance diagnostic, not a test: it has no p-value and is
 * deliberately insensitive to sample size, which is exactly why it is preferred
 * over t-tests for checking baseline comparability. The emitted table says so.
 *
 * EXPOSURE ARMS. A GroupVariable with source {kind:"exposure_cohort"} partitions
 * the final cohort by the index code each subject matched — the standard
 * active-comparator new-user design, where both drugs sit in one index code list
 * and the cohort spine already records index_code. No spine change is needed for
 * that shape; arms defined by SEPARATE code lists (a drug CLASS per arm) are a
 * different partition and are reported as a limitation rather than guessed at.
 *
 * Verified vs Gold Case A: DRUG_X (P01-05, ages 40/45/50/55/60) vs DRUG_Y
 * (P06-10, ages 45/50/55/60/65) gives means 50 vs 55, sample variance 62.5 in
 * both arms, so SMD = -5 / sqrt(62.5) = -0.632456 — reproducing the frozen
 * EXPECTED.smdAge. Hand-derived, asserted in verify/run.ts.
 */
import type { StatisticalEngineAnalysis, GroupVariable, StudySpec } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine } from "../sql-base";
import { cmt, header, levelCheck, sq, INCLUDE_SETUP } from "../sas-base";
import {
  balanceCovariates,
  parityStamp,
  smdParity,
  stratLabel,
  SMD_METHOD_NOTES,
  type BalanceCovariate,
} from "../parity";

/** Resolve the exposure GroupVariable and the covariates the table can compute. */
function plan(spec: StudySpec, an: StatisticalEngineAnalysis) {
  const cfg = an.smdBalance;
  const gv: GroupVariable | undefined = cfg
    ? spec.groupVars.find((g) => g.id === cfg.groupVarId)
    : undefined;
  const { supported, unsupported } = balanceCovariates(
    spec.baseline,
    cfg?.covariateIds ?? [],
  );
  const levels = gv?.levels ?? [];
  const referenceLevel = gv?.referenceLevel ?? levels[0] ?? "";
  const limitations: string[] = [];

  if (!cfg) limitations.push(`smdBalance is not configured on this analysis - no balance table can be produced`);
  else if (!gv) limitations.push(`groupVarId "${cfg.groupVarId}" does not resolve to a GroupVariable - no balance table can be produced`);
  else if (gv.source.kind !== "exposure_cohort")
    limitations.push(
      `groupVar "${gv.id}" has source "${gv.source.kind}"; only "exposure_cohort" (partition by the matched index code) is implemented - ` +
        `arms defined by separate code lists or by a baseline flag are NOT emitted`,
    );
  else if (levels.length !== 2)
    limitations.push(
      `groupVar "${gv.id}" declares ${levels.length} level(s); the balance table implements the TWO-arm comparison only - ` +
        `multi-arm balance is not emitted`,
    );
  for (const u of unsupported)
    limitations.push(
      `covariate "${u.id}" (kind "${u.kind}") is NOT in the balance table - only age (continuous) and sex (binary) are derivable from the cohort spine today`,
    );
  if (an.comparisonIds.length > 0)
    limitations.push(
      `comparisonIds ${JSON.stringify(an.comparisonIds)} are recorded but NOT emitted - hypothesis tests need SAS PROCs; this program emits the SMD balance diagnostic only`,
    );
  if (cfg?.reportWeighted)
    limitations.push(`reportWeighted=true is NOT implemented - unweighted (crude) balance is produced; PS/IPTW weighting arrives with P3`);

  const emittable = !!cfg && !!gv && gv.source.kind === "exposure_cohort" && levels.length === 2 && supported.length > 0;
  return { cfg, gv, levels, referenceLevel, covariates: supported, limitations, emittable };
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlStatisticalEngine(ctx: SqlCtx, an: StatisticalEngineAnalysis, suffix: string): SqlModuleFile {
  const { wp, spec, d } = ctx;
  const out = `${wp}_balance${suffix}`;
  const p = plan(spec, an);
  const body: string[] = [];

  body.push(`-- ${parityStamp("smd_balance", smdParity(an.id, {
    groupVarId: p.cfg?.groupVarId ?? "",
    levels: p.levels,
    referenceLevel: p.referenceLevel,
    covariates: p.covariates,
    imbalanceThreshold: p.cfg?.imbalanceThreshold ?? 0.1,
  }))}`);

  if (p.limitations.length > 0) {
    body.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const l of p.limitations) body.push(`--   * ${l}`);
  }
  for (const n of SMD_METHOD_NOTES) body.push(`-- ${n}`);
  body.push(``);

  if (!p.emittable) {
    body.push(`-- No balance table emitted: see the REVIEW notes above.`);
    return { slug: `balance${suffix}`, title: "Covariate balance (SMD)", subtitle: "not emitted — see REVIEW notes", extra: [], body: body.join("\n") };
  }

  const [refLevel, othLevel] = [p.referenceLevel, p.levels.find((l) => l !== p.referenceLevel) as string];
  const indexListId = spec.indexEvent.codeListId;
  const indexSystem = findCodeList(spec, indexListId)?.system;
  // drug-NAME lists resolve to NDCs in 01_ndc_lookup, so the arm LABEL is the
  // pattern, not the code stored on the cohort row
  const viaNdc = indexSystem === "drug_name";
  const ageExpr = `${d.year("c.index_date")} - dm.dobyr`;
  const thr = p.cfg?.imbalanceThreshold ?? 0.1;

  body.push(`DROP TABLE IF EXISTS ${out};`);
  body.push(`CREATE TABLE ${out} AS`);
  body.push(`WITH arms AS (`);
  body.push(`  -- Exposure arm = the index event the subject matched. The cohort spine`);
  body.push(`  -- already records index_code, so an active-comparator new-user design`);
  body.push(`  -- needs no extra partition step.`);
  if (viaNdc) {
    body.push(`  -- The index list is a DRUG-NAME list, so index_code holds the resolved`);
    body.push(`  -- NDC. The arm label is the drug-name PATTERN, recovered through the`);
    body.push(`  -- same lookup 01_ndc_lookup built.`);
    body.push(`  SELECT c.enrolid, c.index_date, nl.pattern AS arm`);
    body.push(`  FROM ${wp}_cohort c`);
    body.push(`  JOIN ${wp}_ndc_lookup nl`);
    body.push(`    ON nl.code_list_id = '${sqlLit(indexListId)}' AND nl.ndcnum = c.index_code`);
    body.push(`  WHERE nl.pattern IN ('${sqlLit(refLevel)}', '${sqlLit(othLevel)}')`);
  } else {
    body.push(`  SELECT c.enrolid, c.index_date, c.index_code AS arm`);
    body.push(`  FROM ${wp}_cohort c`);
    body.push(`  WHERE c.index_code IN ('${sqlLit(refLevel)}', '${sqlLit(othLevel)}')`);
  }
  body.push(`),`);
  body.push(`demo AS (`);
  body.push(`  -- one enrollment row per subject, same source and tie-break as Table 1`);
  body.push(`  SELECT enrolid, MIN(dobyr) AS dobyr, MIN(sex) AS sex`);
  body.push(`  FROM ${ctx.t("enrollment_detail")}`);
  body.push(`  WHERE enrolid IS NOT NULL`);
  body.push(`  GROUP BY enrolid`);
  body.push(`),`);
  body.push(`sub AS (`);
  body.push(`  SELECT a.enrolid, a.arm,`);
  body.push(`         CAST(${ageExpr} AS NUMERIC) AS age_val,`);
  body.push(`         CASE WHEN dm.sex = '1' THEN 1.0 ELSE 0.0 END AS sex_male`);
  body.push(`  FROM arms a JOIN ${wp}_cohort c ON c.enrolid = a.enrolid`);
  body.push(`              LEFT JOIN demo dm ON dm.enrolid = a.enrolid`);
  body.push(`)`);

  const blocks = p.covariates.map((c) => {
    const col = c.measure === "continuous" ? "age_val" : "sex_male";
    // AVG/VAR_SAMP per arm, pivoted to reference vs comparator
    return [
      `SELECT '${sqlLit(stratLabel(c.label))}' AS characteristic,`,
      `       '${c.measure}' AS measure,`,
      `       n_ref, n_oth,`,
      c.measure === "continuous"
        ? `       ROUND(CAST(m_ref AS NUMERIC), 4) AS value_ref, ROUND(CAST(m_oth AS NUMERIC), 4) AS value_oth,`
        : `       ROUND(CAST(p_ref AS NUMERIC), 4) AS value_ref, ROUND(CAST(p_oth AS NUMERIC), 4) AS value_oth,`,
      `       ROUND(CAST(${smdExprSql(c)} AS NUMERIC), 5) AS smd,`,
      `       CASE WHEN ABS(${smdExprSql(c)}) > ${thr} THEN 1 ELSE 0 END AS imbalanced`,
      `FROM (`,
      `  SELECT`,
      `    SUM(CASE WHEN arm = '${sqlLit(refLevel)}' THEN 1 ELSE 0 END) AS n_ref,`,
      `    SUM(CASE WHEN arm = '${sqlLit(othLevel)}' THEN 1 ELSE 0 END) AS n_oth,`,
      `    AVG(CASE WHEN arm = '${sqlLit(refLevel)}' THEN ${col} END) AS m_ref,`,
      `    AVG(CASE WHEN arm = '${sqlLit(othLevel)}' THEN ${col} END) AS m_oth,`,
      `    VAR_SAMP(CASE WHEN arm = '${sqlLit(refLevel)}' THEN ${col} END) AS v_ref,`,
      `    VAR_SAMP(CASE WHEN arm = '${sqlLit(othLevel)}' THEN ${col} END) AS v_oth,`,
      `    AVG(CASE WHEN arm = '${sqlLit(refLevel)}' THEN ${col} END) AS p_ref,`,
      `    AVG(CASE WHEN arm = '${sqlLit(othLevel)}' THEN ${col} END) AS p_oth`,
      `  FROM sub`,
      `) s_${c.id}`,
    ].join("\n");
  });
  body.push(blocks.join("\nUNION ALL\n"));
  body.push(`;`);
  body.push(``);
  body.push(`-- REVIEW: reference arm = '${sqlLit(refLevel)}', comparator = '${sqlLit(othLevel)}'.`);
  body.push(`-- |SMD| > ${thr} is flagged as imbalanced (imbalanced = 1).`);

  return {
    slug: `balance${suffix}`,
    title: `Covariate balance (SMD): ${oneLine(an.label)}`,
    subtitle: `standardized mean differences, ${refLevel} vs ${othLevel}`,
    extra: [`Reads ${wp}_cohort (index_code = exposure arm) and enrollment demographics.`],
    body: body.join("\n"),
  };
}

function sqlLit(s: string): string {
  return s.replace(/'/g, "''");
}

/** SQL SMD expression with NULLIF guarding a zero denominator. */
function smdExprSql(c: BalanceCovariate): string {
  if (c.measure === "continuous") return `(m_ref - m_oth) / NULLIF(SQRT((v_ref + v_oth) / 2.0), 0)`;
  return `(p_ref - p_oth) / NULLIF(SQRT((p_ref * (1 - p_ref) + p_oth * (1 - p_oth)) / 2.0), 0)`;
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasStatisticalEngine(ctx: SasCtx, an: StatisticalEngineAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const p = plan(spec, an);
  const outT = ctx.tbl(`${num}_balance${suffix}`);
  const cohT = ctx.finalCohort;
  const enrT = ctx.tbl("040_enroll");

  const lines: string[] = [
    ...header(spec, `${num}_balance${suffix}.sas`, [
      `Covariate balance between exposure arms for "${cmt(an.label)}":`,
      `standardized mean differences with a pooled SAMPLE-variance denominator.`,
      `Twin of SQL balance${suffix} (SQL twin is execution-verified; this SAS twin`,
      `is parity-checked, not executed). Keep both in sync.`,
    ]),
    ...INCLUDE_SETUP,
    `/* ${parityStamp("smd_balance", smdParity(an.id, {
      groupVarId: p.cfg?.groupVarId ?? "",
      levels: p.levels,
      referenceLevel: p.referenceLevel,
      covariates: p.covariates,
      imbalanceThreshold: p.cfg?.imbalanceThreshold ?? 0.1,
    }))} */`,
    ``,
  ];

  if (p.limitations.length > 0) {
    lines.push(`/*--------------------------------------------------------------------------`);
    lines.push(`  REVIEW - spec options this program does not implement yet:`);
    for (const l of p.limitations) lines.push(`    * ${cmt(l)}`);
    lines.push(`--------------------------------------------------------------------------*/`, ``);
  }
  lines.push(`/*--------------------------------------------------------------------------`);
  for (const n of SMD_METHOD_NOTES) lines.push(`  ${cmt(n)}`);
  lines.push(`--------------------------------------------------------------------------*/`, ``);

  if (!p.emittable) {
    lines.push(`/* No balance table emitted: see the REVIEW notes above. */`);
    return { path: `sas/${num}_balance${suffix}.sas`, language: "sas", title: `${num} Covariate balance (SMD)`, content: lines.join("\n") };
  }

  const refLevel = p.referenceLevel;
  const othLevel = p.levels.find((l) => l !== p.referenceLevel) as string;
  const thr = p.cfg?.imbalanceThreshold ?? 0.1;
  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListId);

  lines.push(
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/* exposure arm = the index event the subject matched (same as the SQL twin)`,
    ...(viaNdc
      ? [`   The index list is a DRUG-NAME list, so index_code holds the resolved NDC`,
         `   and the arm label is the drug-name PATTERN from the NDC lookup. */`]
      : [`   (the index code is used directly; no NDC resolution needed) */`]),
    `proc sql;`,
    `  create table work._${num}_sub as`,
    `  select a.enrolid,`,
    ...(viaNdc ? [`         n.pattern as arm length=40,`] : [`         a.index_code as arm length=40,`]),
    `         (year(a.index_date) - b.dobyr) as age_val,`,
    `         (case when b.sex = '1' then 1 else 0 end) as sex_male`,
    `  from ${cohT} as a`,
    ...(viaNdc ? [`  inner join ${ndcT} as n on n.ndcnum = a.index_code`] : []),
    `  left join (select enrolid, min(dobyr) as dobyr, min(sex) as sex`,
    `             from ${enrT} group by enrolid) as b`,
    `    on b.enrolid = a.enrolid`,
    ...(viaNdc
      ? [`  where n.pattern in ('${sq(refLevel)}', '${sq(othLevel)}');`]
      : [`  where a.index_code in ('${sq(refLevel)}', '${sq(othLevel)}');`]),
    `quit;`,
    ``,
    ...levelCheck("work._" + num + "_sub", "balance subjects"),
    ``,
    `/* per-arm moments; VAR is the SAMPLE variance (n-1), matching the SQL twin */`,
    `proc sql;`,
    `  create table work._${num}_mom as`,
    `  select`,
    `    sum(case when arm = '${sq(refLevel)}' then 1 else 0 end) as n_ref,`,
    `    sum(case when arm = '${sq(othLevel)}' then 1 else 0 end) as n_oth,`,
    `    mean(case when arm = '${sq(refLevel)}' then age_val else . end) as age_m_ref,`,
    `    mean(case when arm = '${sq(othLevel)}' then age_val else . end) as age_m_oth,`,
    `    var (case when arm = '${sq(refLevel)}' then age_val else . end) as age_v_ref,`,
    `    var (case when arm = '${sq(othLevel)}' then age_val else . end) as age_v_oth,`,
    `    mean(case when arm = '${sq(refLevel)}' then sex_male else . end) as sex_p_ref,`,
    `    mean(case when arm = '${sq(othLevel)}' then sex_male else . end) as sex_p_oth`,
    `  from work._${num}_sub;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  set work._${num}_mom;`,
    `  length characteristic $40 measure $12;`,
  );

  for (const c of p.covariates) {
    const pre = c.measure === "continuous" ? "age" : "sex";
    lines.push(
      ``,
      `  /* ${cmt(c.label)} */`,
      `  characteristic = "${sq(stratLabel(c.label))}";`,
      `  measure = "${c.measure}";`,
      c.measure === "continuous"
        ? `  value_ref = round(${pre}_m_ref, 0.0001); value_oth = round(${pre}_m_oth, 0.0001);`
        : `  value_ref = round(${pre}_p_ref, 0.0001); value_oth = round(${pre}_p_oth, 0.0001);`,
      c.measure === "continuous"
        ? `  _den = sqrt((age_v_ref + age_v_oth) / 2);`
        : `  _den = sqrt((sex_p_ref*(1-sex_p_ref) + sex_p_oth*(1-sex_p_oth)) / 2);`,
      c.measure === "continuous"
        ? `  if _den > 0 then smd = round((age_m_ref - age_m_oth) / _den, 0.00001); else smd = .;`
        : `  if _den > 0 then smd = round((sex_p_ref - sex_p_oth) / _den, 0.00001); else smd = .;`,
      `  imbalanced = (smd ne . and abs(smd) > ${thr});`,
      `  output;`,
    );
  }
  lines.push(
    `  keep characteristic measure n_ref n_oth value_ref value_oth smd imbalanced;`,
    `run;`,
    ``,
    `title "Covariate balance (SMD): ${sq(oneLine(an.label))} - ${sq(refLevel)} vs ${sq(othLevel)}";`,
    `proc print data=${outT} noobs;`,
    `run;`,
    `title;`,
  );

  return {
    path: `sas/${num}_balance${suffix}.sas`,
    language: "sas",
    title: `${num} Covariate balance (SMD)`,
    content: lines.join("\n"),
  };
}

export const statisticalEngineModule: AnalysisModule<StatisticalEngineAnalysis> = {
  analysisKind: "statistical_engine",
  stampKind: "smd_balance",
  resultSlug: "balance",
  sql: sqlStatisticalEngine,
  sas: sasStatisticalEngine,
};
