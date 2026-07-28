/**
 * GLM module — the analytic dataset and the crude effect in both twins, the
 * fitted coefficients in SAS, and a saturated-design anchor tying them together.
 *
 * The build plan is blunt about the constraint: fitted coefficients need
 * IRLS/Newton, warehouse SQL has neither, and "the saturated anchor is the only
 * real check available". So the work here is deciding what is genuinely
 * verifiable and refusing to dress up the rest.
 *
 * WHAT BOTH TWINS COMPUTE, and the harness executes:
 *   - the analytic dataset: one row per at-risk subject, with the incident
 *     outcome inside the horizon, the exposure arm, and every covariate;
 *   - the 2x2 of exposure by outcome;
 *   - from it, in closed form, the odds ratio, risk ratio and risk difference,
 *     plus the Woolf log-odds standard error and its Wald interval.
 *
 * WHAT ONLY SAS COMPUTES: the adjusted coefficients. SQL emits them NULL beside
 * a label naming the procedure, under the same SAS-primary contract as the
 * exact Poisson interval and the trend p-value.
 *
 * THE ANCHOR. A logistic model whose only predictor is the two-level exposure is
 * SATURATED for a 2x2: it has as many parameters as cells to fit, so its
 * maximum-likelihood estimate is not an approximation of the closed-form log
 * odds ratio — it IS that number. The emitted SAS therefore fits that model,
 * recomputes the closed form from its own data, and prints whether they agree.
 * No reference value travels with the program; the check is self-contained, and
 * it is the one place a site can see the fitting machinery validated rather than
 * trusted.
 *
 * Verified vs Gold Case A: at-risk 8, split 4/4 by arm, with 2 events under
 * DRUG_X and 1 under DRUG_Y. Reference DRUG_X, so the reported effect is for
 * DRUG_Y: OR = (1/3)/(2/2) = 1/3 EXACTLY, RR = 0.25/0.5 = 0.5, RD = -0.25.
 * Woolf SE = sqrt(1 + 1/3 + 1/2 + 1/2) = sqrt(7/3). Hand-derived, asserted in
 * verify/run.ts.
 */
import type { RegressionAnalysis } from "../../spec/types";
import { findCodeList } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine, q, describeWindow, windowConds } from "../sql-base";
import { cmt, header, levelCheck, sq, windowConds as sasWindowConds, INCLUDE_SETUP } from "../sas-base";
import { rateCoreSqlCtes } from "../rate-core";
import { comorbidityScoreSasScore, comorbidityScoreSasSteps, comorbidityScoreSqlCtes, indexAnalysisFor } from "../comorbidity";
import {
  balanceCovariates,
  outcomeSettingPlan,
  parityStamp,
  regressionLimitations,
  regressionParity,
  stratLabel,
  REGRESSION_METHOD_NOTES,
  type BalanceCovariate,
} from "../parity";

const MEASURE = "regression";
/** Label on the adjusted rows, naming what produces them. */
const ADJ_METHOD = "sas_proc_logistic";

/** Resolve exposure levels and the covariates the model can actually build. */
function plan(ctx: SqlCtx | SasCtx, an: RegressionAnalysis) {
  const spec = ctx.spec;
  const gv = spec.groupVars.find((g) => g.id === an.groupVarId);
  const referenceLevel = gv?.referenceLevel ?? gv?.levels[0] ?? "";
  const exposedLevel = gv?.levels.find((l) => l !== referenceLevel) ?? "";
  const { supported, unsupported } = balanceCovariates(
    spec.baseline,
    an.covariateIds,
    new Set(spec.analyses.filter((x) => x.kind === "comorbidity_index" && x.enabled).map((x) => x.id)),
  );
  return {
    gv,
    referenceLevel,
    exposedLevel,
    covariates: supported,
    droppedCovs: unsupported.map((u) => u.id),
    emittable: Boolean(gv && referenceLevel && exposedLevel),
  };
}

/** Model terms, exposure first — the order both twins must emit. */
function terms(p: { exposedLevel: string; covariates: BalanceCovariate[] }, gvLabel: string): string[] {
  return [stratLabel(gvLabel), ...p.covariates.map((c) => stratLabel(c.label))];
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlRegression(ctx: SqlCtx, an: RegressionAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_glm${suffix}`;
  const clid = an.outcomeDefinition.codeListId;
  const listSystem = findCodeList(spec, clid)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const p = plan(ctx, an);
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const wc = windowConds(an.washout, "a.event_date", "c.index_date", d);
  const washoutPred = wc.length > 0 ? wc.join("\n      AND ") : "TRUE";
  const horizonEnd = d.offset("s.index_date", an.horizonDays);

  const L: string[] = [];
  L.push(
    `-- ${parityStamp(
      "regression",
      regressionParity(an, { referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms, settingFilter: setting.stamped }),
    )}`,
  );
  const limits = regressionLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  for (const note of REGRESSION_METHOD_NOTES) L.push(`--   * ${note}`);
  L.push(`-- SAS-PRIMARY: the adjusted estimates are NULL here BY CONTRACT - fitting a`);
  L.push(`-- GLM needs iteratively reweighted least squares, which warehouse SQL has no`);
  L.push(`-- way to run. They are computed by PROC LOGISTIC in the SAS twin.`);

  if (!p.emittable) {
    L.push(`-- No model emitted: the exposure variable did not resolve to two levels.`);
    return {
      slug: `glm${suffix}`,
      title: `Regression${suffix ? ` (${an.label})` : ""}`,
      subtitle: "not emitted - exposure unresolved",
      extra: [`Analysis: ${oneLine(an.label)} (id ${an.id}).`],
      body: L.join("\n"),
    };
  }

  const cciCov = p.covariates.find((c) => c.axis === "comorbidity_index");
  const cciAn = indexAnalysisFor(spec, cciCov?.analysisId);
  /* The cohort stores index_code. When the index list is a DRUG-NAME list that
   * code is the resolved NDC, not the arm label, so the arm has to come back
   * through the same lookup 01_ndc_lookup built — exactly as the balance table
   * does. Comparing index_code to 'DRUG_X' directly would match nothing and
   * emit an empty, perfectly well-formed model. */
  const indexListId = spec.indexEvent.codeListId;
  const viaNdc = findCodeList(spec, indexListId)?.system === "drug_name";
  const armExpr = viaNdc ? `nl.pattern` : `ch.index_code`;

  L.push(d.createTableAs(out));
  // The at-risk chain is rate-core's, not a second copy: same cohort, same
  // washout, same "first event strictly after index" as the incidence twins.
  L.push(
    ...rateCoreSqlCtes(ctx, {
      wp,
      codeListId: clid,
      settingEnforce: setting.enforce,
      washoutDescription: describeWindow(an.washout),
      washoutPredicate: washoutPred,
      needDemo: true,
    }),
  );
  if (cciCov && cciAn) {
    const sc = comorbidityScoreSqlCtes(ctx, { wp, an: cciAn, cohortCte: "atrisk", prefix: "cci_" });
    L.push(...sc.lines);
  }
  L.push(`subj AS (   -- the ANALYTIC DATASET: one row per at-risk subject`);
  L.push(`  SELECT s.enrolid,`);
  L.push(`         CASE WHEN s.arm = '${q(p.exposedLevel)}' THEN 1 ELSE 0 END AS exposed,`);
  L.push(`         -- incident event INSIDE the horizon; a subject counts once`);
  L.push(`         CASE WHEN f.fu_date IS NOT NULL AND f.fu_date <= ${horizonEnd} THEN 1 ELSE 0 END AS y,`);
  L.push(`         CAST(${d.year("s.index_date")} - dm.dobyr AS NUMERIC) AS age_val,`);
  L.push(`         CASE WHEN dm.sex = '1' THEN 1.0 ELSE 0.0 END AS sex_male${cciCov && cciAn ? `,` : ``}`);
  if (cciCov && cciAn) L.push(`         CAST(COALESCE(cs.score, 0) AS NUMERIC) AS cci_val`);
  L.push(`  FROM (SELECT a.enrolid, a.index_date, ${armExpr} AS arm FROM atrisk a`);
  L.push(`        JOIN ${wp}_cohort ch ON ch.enrolid = a.enrolid`);
  if (viaNdc) {
    L.push(`        JOIN ${wp}_ndc_lookup nl`);
    L.push(`          ON nl.code_list_id = '${q(indexListId)}' AND nl.ndcnum = ch.index_code`);
  }
  L.push(`       ) s`);
  L.push(`  LEFT JOIN first_fu f ON f.enrolid = s.enrolid`);
  L.push(`  LEFT JOIN demo1 dm ON dm.enrolid = s.enrolid`);
  if (cciCov && cciAn) L.push(`  LEFT JOIN cci_per_pt cs ON cs.enrolid = s.enrolid`);
  L.push(`  WHERE s.arm IN ('${q(p.referenceLevel)}', '${q(p.exposedLevel)}')`);
  L.push(`),`);
  L.push(`cells AS (   -- the 2x2 the closed form is computed from`);
  L.push(`  SELECT SUM(CASE WHEN exposed = 1 AND y = 1 THEN 1 ELSE 0 END) AS a_ee,`);
  L.push(`         SUM(CASE WHEN exposed = 1 AND y = 0 THEN 1 ELSE 0 END) AS b_en,`);
  L.push(`         SUM(CASE WHEN exposed = 0 AND y = 1 THEN 1 ELSE 0 END) AS c_ue,`);
  L.push(`         SUM(CASE WHEN exposed = 0 AND y = 0 THEN 1 ELSE 0 END) AS d_un`);
  L.push(`  FROM subj`);
  L.push(`),`);
  /* A zero cell makes the log-odds interval undefined. The program returns
   * NULL rather than adding a continuity correction: a correction changes the
   * estimand, and doing it silently is how a study reports a number nobody
   * chose. */
  L.push(`eff AS (`);
  L.push(`  SELECT a_ee, b_en, c_ue, d_un,`);
  L.push(`         (a_ee + b_en) AS n_exp, (c_ue + d_un) AS n_unexp,`);
  L.push(`         CASE WHEN b_en > 0 AND c_ue > 0 AND a_ee > 0 AND d_un > 0`);
  L.push(`              THEN LN((a_ee * 1.0 * d_un) / (b_en * 1.0 * c_ue)) END AS log_or,`);
  L.push(`         CASE WHEN a_ee > 0 AND b_en > 0 AND c_ue > 0 AND d_un > 0`);
  L.push(`              THEN SQRT(1.0/a_ee + 1.0/b_en + 1.0/c_ue + 1.0/d_un) END AS se_log_or`);
  L.push(`  FROM cells`);
  L.push(`)`);
  L.push(`SELECT '${MEASURE}' AS measure, component, term, statistic, ord,`);
  L.push(`       estimate, ci_low, ci_high, se_log, method`);
  L.push(`FROM (`);
  // 1. the design: cell counts, so the closed form can be re-derived by hand
  const designRow = (ord: number, term: string, stat: string, expr: string) =>
    `  SELECT 'design' AS component, '${term}' AS term, '${stat}' AS statistic, ${ord} AS ord,` +
    ` CAST(${expr} AS NUMERIC) AS estimate, CAST(NULL AS NUMERIC) AS ci_low, CAST(NULL AS NUMERIC) AS ci_high,` +
    ` CAST(NULL AS NUMERIC) AS se_log, CAST('observed' AS VARCHAR) AS method FROM eff`;
  L.push(designRow(0, q(p.exposedLevel), "n", "n_exp"));
  L.push(`  UNION ALL`);
  L.push(designRow(1, q(p.exposedLevel), "events", "a_ee"));
  L.push(`  UNION ALL`);
  L.push(designRow(2, q(p.referenceLevel), "n", "n_unexp"));
  L.push(`  UNION ALL`);
  L.push(designRow(3, q(p.referenceLevel), "events", "c_ue"));
  // 2. the crude effect, closed form, in BOTH twins
  const crude = (ord: number, stat: string, est: string, lo: string, hi: string, se: string) =>
    `  SELECT 'crude', '${q(stratLabel(gvLabel))}', '${stat}', ${ord},` +
    ` ${est}, ${lo}, ${hi}, ${se}, CAST('closed_form_2x2' AS VARCHAR) FROM eff`;
  L.push(`  UNION ALL`);
  L.push(crude(10, "odds_ratio",
    d.roundN(`EXP(log_or)`, 5),
    d.roundN(`EXP(log_or - 1.96 * se_log_or)`, 5),
    d.roundN(`EXP(log_or + 1.96 * se_log_or)`, 5),
    d.roundN(`se_log_or`, 5)));
  L.push(`  UNION ALL`);
  L.push(crude(11, "risk_ratio",
    d.roundN(`(a_ee * 1.0 / NULLIF(n_exp, 0)) / NULLIF(c_ue * 1.0 / NULLIF(n_unexp, 0), 0)`, 5),
    `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`));
  L.push(`  UNION ALL`);
  L.push(crude(12, "risk_difference",
    d.roundN(`a_ee * 1.0 / NULLIF(n_exp, 0) - c_ue * 1.0 / NULLIF(n_unexp, 0)`, 5),
    `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`, `CAST(NULL AS NUMERIC)`));
  // 3. the adjusted model — SAS-primary, declared and NULL
  modelTerms.forEach((t, i) => {
    L.push(`  UNION ALL`);
    L.push(
      `  SELECT 'adjusted', '${q(t)}', 'odds_ratio', ${20 + i},` +
        ` CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),` +
        ` CAST('${ADJ_METHOD}' AS VARCHAR) FROM eff`,
    );
  });
  L.push(`) u`);
  L.push(`ORDER BY ord;`);
  L.push("");
  L.push(`-- REVIEW: 2x2 design, the closed-form crude effect, and the adjusted model`);
  L.push(`-- whose estimates the SAS twin fills in.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY ord;`);

  return {
    slug: `glm${suffix}`,
    title: `Regression${suffix ? ` (${an.label})` : ""}`,
    subtitle: `${an.family}: 2x2 design + closed-form crude effect (adjusted model is SAS-primary)`,
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); outcome code list "${clid}", horizon ${an.horizonDays}d.`,
      `Exposure ${p.exposedLevel} vs reference ${p.referenceLevel}; adjusted terms: ${modelTerms.join(", ")}.`,
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasRegression(ctx: SasCtx, an: RegressionAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_glm${suffix}`);
  const cohT = ctx.finalCohort;
  const evT = ctx.evOf(an.outcomeDefinition.codeListId);
  const enrT = ctx.tbl("040_enroll");
  const listSystem = findCodeList(spec, an.outcomeDefinition.codeListId)?.system ?? "icd10cm";
  const setting = outcomeSettingPlan(an.outcomeDefinition, listSystem);
  const sasSettingCond =
    setting.enforce === "outpatient" ? `and e.setting = 'OP'` : setting.enforce === "inpatient" ? `and e.setting = 'IP'` : null;
  const p = plan(ctx, an);
  const gvLabel = p.gv?.label ?? an.groupVarId;
  const modelTerms = terms(p, gvLabel);
  const limits = regressionLimitations(an, listSystem, p.covariates.map((c) => c.label), p.droppedCovs);
  const label = an.label.replace(/"/g, "'");
  const cciCov = p.covariates.find((c) => c.axis === "comorbidity_index");
  const cciAn = indexAnalysisFor(spec, cciCov?.analysisId);
  const cciScore = cciCov && cciAn ? comorbidityScoreSasSteps(ctx, { an: cciAn, num, cohT, evOf: ctx.evOf }) : null;
  const indexListIdS = spec.indexEvent.codeListId;
  const viaNdcS = findCodeList(spec, indexListIdS)?.system === "drug_name";
  const ndcT = ctx.ndcOf(indexListIdS);
  const sasVar = (c: BalanceCovariate) => (c.axis === "age" ? "age_val" : c.axis === "sex" ? "sex_male" : "cci_val");

  const lines: string[] = [
    ...header(spec, `${num}_glm${suffix}.sas`, [
      `${an.family} regression for "${an.label}".`,
      `The analytic dataset and the CRUDE effect are computed here AND in the SQL`,
      `twin; the ADJUSTED coefficients are SAS-primary (SQL emits them NULL).`,
      `SATURATED ANCHOR: the unadjusted model is saturated for a 2x2, so its MLE`,
      `must equal the closed-form log odds ratio computed below from the same`,
      `data. This program checks that itself and prints the verdict.`,
      `Twin of the SQL glm program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp(
      "regression",
      regressionParity(an, { referenceLevel: p.referenceLevel, exposedLevel: p.exposedLevel, terms: modelTerms, settingFilter: setting.stamped }),
    )} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...REGRESSION_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
  );
  if (!p.emittable) {
    lines.push(`/* No model emitted: the exposure variable did not resolve to two levels. */`);
    return { path: `sas/${num}_glm${suffix}.sas`, language: "sas", title: `${num} Regression`, content: lines.join("\n") };
  }

  lines.push(
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/*-------------------- prevalent-case washout -> at risk ---------------------*/`,
    `proc sql;`,
    `  create table work._${num}_prev as`,
    `  select distinct a.enrolid`,
    `  from ${cohT} as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    ...sasWindowConds(an.washout, "e").map((l) => `    ${l}`),
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  ;`,
    ``,
    `  create table work._${num}_atrisk as`,
    ...(viaNdcS
      ? [
          `  /* the index list is a DRUG-NAME list, so index_code is the resolved NDC`,
          `     and the arm label comes back through the NDC lookup */`,
          `  select a.*, n.pattern as arm length=40`,
          `  from ${cohT} as a`,
          `  inner join ${ndcT} as n on n.ndcnum = a.index_code`,
          `  where a.enrolid not in (select enrolid from work._${num}_prev)`,
          `    and n.pattern in ('${sq(p.referenceLevel)}', '${sq(p.exposedLevel)}');`,
        ]
      : [
          `  select a.*, a.index_code as arm length=40`,
          `  from ${cohT} as a`,
          `  where a.enrolid not in (select enrolid from work._${num}_prev)`,
          `    and a.index_code in ('${sq(p.referenceLevel)}', '${sq(p.exposedLevel)}');`,
        ]),
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_atrisk`, "at-risk subjects"),
    ``,
    `/*-------------------- first incident event inside the horizon ---------------*/`,
    `proc sql;`,
    `  create table work._${num}_fu as`,
    `  select a.enrolid, min(e.svcdate) as fu_date format=date9.`,
    `  from work._${num}_atrisk as a`,
    `  inner join ${evT} as e`,
    `    on  e.enrolid = a.enrolid`,
    `    and e.svcdate >  a.index_date`,
    `    and e.svcdate <= a.index_date + ${an.horizonDays}`,
    ...(sasSettingCond ? [`    ${sasSettingCond}`] : []),
    `  group by a.enrolid;`,
    `quit;`,
    ``,
    ...(cciScore ? [...cciScore.lines, ...comorbidityScoreSasScore(num, cohT)] : []),
    `/*-------------------- the ANALYTIC DATASET ----------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_subj as`,
    `  select a.enrolid,`,
    `         (case when a.arm = '${sq(p.exposedLevel)}' then 1 else 0 end) as exposed,`,
    `         (case when f.enrolid is not null then 1 else 0 end) as y,`,
    `         (year(a.index_date) - b.dobyr) as age_val,`,
    `         (case when b.sex = '1' then 1 else 0 end) as sex_male${cciScore ? "," : ""}`,
    ...(cciScore ? [`         coalesce(s.score, 0) as cci_val`] : []),
    `  from work._${num}_atrisk as a`,
    `  left join work._${num}_fu as f on f.enrolid = a.enrolid`,
    `  left join (select enrolid, min(dobyr) as dobyr, min(sex) as sex`,
    `             from ${enrT} group by enrolid) as b`,
    `    on b.enrolid = a.enrolid`,
    ...(cciScore ? [`  left join ${cciScore.scoreTable} as s on s.enrolid = a.enrolid`] : []),
    `  ;`,
    `quit;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  The 2x2 and the CLOSED FORM - the same arithmetic as the SQL twin.`,
    `  A zero cell leaves the interval undefined; this returns missing rather than`,
    `  applying a continuity correction, which would change the estimand silently.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${num}_cells as`,
    `  select sum(case when exposed = 1 and y = 1 then 1 else 0 end) as a_ee,`,
    `         sum(case when exposed = 1 and y = 0 then 1 else 0 end) as b_en,`,
    `         sum(case when exposed = 0 and y = 1 then 1 else 0 end) as c_ue,`,
    `         sum(case when exposed = 0 and y = 0 then 1 else 0 end) as d_un`,
    `  from work._${num}_subj;`,
    `quit;`,
    ``,
    `data work._${num}_eff;`,
    `  set work._${num}_cells;`,
    `  n_exp   = a_ee + b_en;`,
    `  n_unexp = c_ue + d_un;`,
    `  if a_ee > 0 and b_en > 0 and c_ue > 0 and d_un > 0 then do;`,
    `    log_or     = log((a_ee * d_un) / (b_en * c_ue));`,
    `    se_log_or  = sqrt(1/a_ee + 1/b_en + 1/c_ue + 1/d_un);`,
    `  end;`,
    `run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  SATURATED-DESIGN ANCHOR.`,
    `  The model below has ONE predictor - the exposure - which makes it saturated`,
    `  for a 2x2: as many free parameters as cells to fit. Its maximum-likelihood`,
    `  estimate is therefore not an approximation of the closed-form log odds`,
    `  ratio, it IS that number. Comparing the two is the only check on the`,
    `  fitting machinery that does not require trusting it.`,
    `  descending: model the probability that y = 1, not y = 0.`,
    `----------------------------------------------------------------------------*/`,
    `ods output ParameterEstimates = work._${num}_anchor_pe;`,
    `proc logistic data=work._${num}_subj descending;`,
    `  model y = exposed;`,
    `run;`,
    ``,
    `data work._${num}_anchor;`,
    `  merge work._${num}_anchor_pe (where=(upcase(Variable) = 'EXPOSED') rename=(Estimate = fitted_log_or))`,
    `        work._${num}_eff (keep=log_or);`,
    `  length anchor_verdict $48;`,
    `  _gap = abs(fitted_log_or - log_or);`,
    `  if log_or = . then anchor_verdict = 'NOT CHECKABLE (a zero cell)';`,
    `  else if _gap < 1e-6 then anchor_verdict = 'PASS: saturated MLE = closed form';`,
    `  else anchor_verdict = 'FAIL: saturated MLE differs from closed form';`,
    `  drop _gap;`,
    `run;`,
    ``,
    `title "Saturated-design anchor: fitted vs closed-form log odds ratio";`,
    `proc print data=work._${num}_anchor noobs;`,
    `  var fitted_log_or log_or anchor_verdict;`,
    `run;`,
    ``,
    `/*-------------------- the ADJUSTED model (SAS-primary) ----------------------*/`,
    `/* These estimates exist ONLY here: the SQL twin emits them NULL because`,
    `   fitting needs iteratively reweighted least squares. */`,
    `ods output ParameterEstimates = work._${num}_adj_pe;`,
    `proc logistic data=work._${num}_subj descending;`,
    `  model y = exposed${p.covariates.length > 0 ? " " + p.covariates.map(sasVar).join(" ") : ""};`,
    `run;`,
    ``,
    `title "Adjusted ${cmt(an.family)} model: ${label}";`,
    `proc print data=work._${num}_adj_pe noobs;`,
    `run;`,
    `title;`,
    ``,
    `/*-------------------- assemble the result table -----------------------------*/`,
    `data ${outT};`,
    `  set work._${num}_eff;`,
    `  length measure $20 component $10 term $40 statistic $16 method $24;`,
    `  measure = "${MEASURE}";`,
    `  /* design */`,
    `  component='design'; term="${sq(p.exposedLevel)}";    statistic='n';      ord=0; estimate=n_exp;   method='observed'; ci_low=.; ci_high=.; se_log=.; output;`,
    `  component='design'; term="${sq(p.exposedLevel)}";    statistic='events'; ord=1; estimate=a_ee;    method='observed'; output;`,
    `  component='design'; term="${sq(p.referenceLevel)}";  statistic='n';      ord=2; estimate=n_unexp; method='observed'; output;`,
    `  component='design'; term="${sq(p.referenceLevel)}";  statistic='events'; ord=3; estimate=c_ue;    method='observed'; output;`,
    `  /* crude, closed form - identical arithmetic to the SQL twin */`,
    `  component='crude'; term="${sq(stratLabel(gvLabel))}"; method='closed_form_2x2';`,
    `  statistic='odds_ratio'; ord=10;`,
    `  if log_or ne . then do;`,
    `    estimate = round(exp(log_or), 0.00001);`,
    `    ci_low   = round(exp(log_or - 1.96 * se_log_or), 0.00001);`,
    `    ci_high  = round(exp(log_or + 1.96 * se_log_or), 0.00001);`,
    `    se_log   = round(se_log_or, 0.00001);`,
    `  end;`,
    `  output;`,
    `  ci_low=.; ci_high=.; se_log=.;`,
    `  statistic='risk_ratio'; ord=11;`,
    `  if n_exp > 0 and n_unexp > 0 and c_ue > 0`,
    `    then estimate = round((a_ee / n_exp) / (c_ue / n_unexp), 0.00001);`,
    `    else estimate = .;`,
    `  output;`,
    `  statistic='risk_difference'; ord=12;`,
    `  if n_exp > 0 and n_unexp > 0`,
    `    then estimate = round(a_ee / n_exp - c_ue / n_unexp, 0.00001);`,
    `    else estimate = .;`,
    `  output;`,
    `  /* adjusted - the estimates PROC LOGISTIC above produced */`,
    `  estimate=.; ci_low=.; ci_high=.; se_log=.;`,
    `  component='adjusted'; statistic='odds_ratio'; method="${ADJ_METHOD}";`,
    ...modelTerms.map((t, i) => `  term="${sq(t)}"; ord=${20 + i}; output;`),
    `  keep measure component term statistic ord estimate ci_low ci_high se_log method;`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by ord;`,
    `run;`,
    ``,
    `title "Regression: ${label}";`,
    `proc print data=${outT} noobs;`,
    `run;`,
    `title;`,
    ``,
  );

  return {
    path: `sas/${num}_glm${suffix}.sas`,
    language: "sas",
    title: `${num} Regression${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

export const regressionModule: AnalysisModule<RegressionAnalysis> = {
  analysisKind: "regression",
  stampKind: "regression",
  resultSlug: "glm",
  sql: sqlRegression,
  sas: sasRegression,
};
