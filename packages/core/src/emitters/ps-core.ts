/**
 * ps-core — propensity scores, and the one design where the score itself is
 * closed form.
 *
 * THE PROBLEM THIS FAMILY POSES, which is different from Cox's. A propensity
 * score is a fitted logistic probability, so by the rule this project settled
 * on in Wave 6.4 — "needs Newton" carves out the coefficient, it does not
 * refuse the model — the coefficients are SAS-primary. But unlike Cox, where
 * everything AROUND the coefficient is closed form, here everything downstream
 * DEPENDS on the coefficient: the weights, the balance, the pseudo-population.
 * Carve out the score and the SQL twin is empty.
 *
 * THE SATURATED PROPENSITY SCORE resolves it. A logistic model whose covariates
 * are all CATEGORICAL and which includes every cell is saturated: it has as many
 * free parameters as cells to fit, so its maximum-likelihood fitted probability
 * in each cell IS the observed treated fraction there. Not an approximation —
 * that number. So:
 *
 *     ps(cell) = treated in cell / members of cell
 *
 * is the exact MLE, computable in SQL, and every weight, diagnostic and balance
 * statistic downstream of it executes. It is the same device as the saturated
 * 2x2 in the regression family and the constant-proportion anchor in Cox, and it
 * is the third time that trick has been what makes a family verifiable.
 *
 * A CONTINUOUS covariate breaks saturation, and then the score genuinely is
 * SAS-primary. Readiness refuses that configuration rather than emitting a
 * pipeline whose every number would be NULL — see the message there.
 *
 * WHAT IS EXECUTED, all of it, in both twins: the score, ATE and ATT weights,
 * stabilization, trimming, the effective sample size, the positivity
 * diagnostics, and the standardized differences before and after weighting.
 *
 * THE POSITIVITY DIAGNOSTIC IS THE INTERESTING ONE. Inverse-probability
 * weighting builds two pseudo-populations, one from the treated and one from the
 * controls, and both are supposed to represent the SAME population. Under a
 * saturated score their sizes are exact integers:
 *
 *     SUM over treated of 1/ps    = total membership of cells CONTAINING a treated subject
 *     SUM over controls of 1/(1-ps) = total membership of cells CONTAINING a control
 *
 * so a DIFFERENCE between them is proof of a positivity violation: it can only
 * arise from cells that are entirely one arm. On Gold Case A that gap is 2 —
 * region 4 holds two treated subjects and no control.
 *
 * THE CONVERSE DOES NOT HOLD, and this file claimed it did until Gold Case A's
 * second propensity analysis was added. Scored on region x sex there are seven
 * cells, FOUR of them single-arm, and both sums still come to exactly 8: the
 * cells containing treated members and the cells containing controls happened
 * to hold the same number of people. A zero gap is therefore not evidence of
 * anything. `subjects_off_support`, which counts the members of one-arm cells
 * directly, is the authoritative row, and the gap is a corroborating one.
 *
 * Ref: Rosenbaum & Rubin Biometrika 1983;70:41; Austin Stat Med 2009;28:3083
 * (the standardized difference); Austin & Stuart Stat Med 2015;34:3661 (IPTW);
 * Kish, Survey Sampling (1965) — the effective sample size.
 */

/** Trimming is symmetric on the score. 0 disables it. */
export const NO_TRIM = 0;

export interface PsSqlInput {
  /** CTE with one row per subject: enrolid, treated (0/1), cell (VARCHAR), plus
   *  one column per balance covariate */
  subjectsCte: string;
  estimand: "ate" | "att";
  stabilized: boolean;
  /** symmetric trim, e.g. 0.05 keeps scores in [0.05, 0.95] */
  trim: number;
  prefix?: string;
}

/**
 * `<p>pscell`, `<p>psw` — the saturated score and every weight on it.
 *
 * The score is computed from the SAME cell definition both twins build, and the
 * cell is a concatenation of the categorical covariates in a FIXED order. That
 * order is part of the parity contract: two twins that agreed on the covariates
 * but disagreed on how to spell a cell would produce different scores from the
 * same data and no numeric comparison would say so.
 */
export function psSqlCtes(i: PsSqlInput): string[] {
  const p = i.prefix ?? "";
  const s = i.subjectsCte;
  const L: string[] = [];
  L.push(`${p}pscell AS (   -- the SATURATED propensity score, in closed form`);
  L.push(`  -- A logistic model with only categorical covariates and every cell`);
  L.push(`  -- present is saturated, so its maximum-likelihood fitted probability`);
  L.push(`  -- in each cell IS the observed treated fraction. That is why this is`);
  L.push(`  -- arithmetic and not a fit.`);
  L.push(`  SELECT cell,`);
  L.push(`         COUNT(*) AS n_cell,`);
  L.push(`         SUM(treated) AS n_treated_cell,`);
  L.push(`         COUNT(*) - SUM(treated) AS n_control_cell,`);
  L.push(`         SUM(treated) * 1.0 / COUNT(*) AS ps`);
  L.push(`  FROM ${s}`);
  L.push(`  GROUP BY cell`);
  L.push(`),`);
  L.push(`${p}psp AS (   -- treated prevalence, for stabilized weights`);
  L.push(`  SELECT SUM(treated) * 1.0 / COUNT(*) AS p_treated, COUNT(*) AS n_total,`);
  L.push(`         SUM(treated) AS n_treated, COUNT(*) - SUM(treated) AS n_control`);
  L.push(`  FROM ${s}`);
  L.push(`),`);
  const lo = i.trim > 0 ? String(i.trim) : null;
  const hi = i.trim > 0 ? String(1 - i.trim) : null;
  L.push(`${p}psw AS (`);
  L.push(`  SELECT s.*, c.ps, c.n_cell, c.n_treated_cell, c.n_control_cell,`);
  L.push(`         pp.p_treated,`);
  if (lo) {
    L.push(`         -- TRIMMING is applied to the SCORE and reported as an exclusion,`);
    L.push(`         -- never silently: a trimmed analysis estimates an effect in a`);
    L.push(`         -- DIFFERENT population than the one the cohort describes.`);
    L.push(`         CASE WHEN c.ps < ${lo} OR c.ps > ${hi} THEN 1 ELSE 0 END AS trimmed,`);
  } else {
    L.push(`         0 AS trimmed,   -- no trimming requested`);
  }
  /* A weight of 1/0 is not a large number, it is undefined — and it arises
   * exactly when a cell is all-control (ps = 0) or all-treated (ps = 1). NULLIF
   * makes it NULL so it cannot be summed into a total that looks finite. */
  const wTreated = i.estimand === "ate" ? `1.0 / NULLIF(c.ps, 0)` : `1.0`;
  const wControl = i.estimand === "ate" ? `1.0 / NULLIF(1 - c.ps, 0)` : `c.ps / NULLIF(1 - c.ps, 0)`;
  L.push(`         -- ${i.estimand.toUpperCase()} weights. A zero denominator is NULL, not a large`);
  L.push(`         -- number: it means a cell is entirely one arm, and no finite`);
  L.push(`         -- weight represents a counterpart that does not exist.`);
  L.push(`         CASE WHEN s.treated = 1 THEN ${wTreated} ELSE ${wControl} END AS w_raw,`);
  if (i.stabilized) {
    L.push(`         -- STABILIZED: multiply by the marginal probability of the arm the`);
    L.push(`         -- subject is actually in. Changes the scale, not the balance.`);
    L.push(`         CASE WHEN s.treated = 1`);
    L.push(`              THEN pp.p_treated * (${wTreated})`);
    L.push(`              ELSE (1 - pp.p_treated) * (${wControl}) END AS w`);
  } else {
    L.push(`         CASE WHEN s.treated = 1 THEN ${wTreated} ELSE ${wControl} END AS w`);
  }
  L.push(`  FROM ${s} s`);
  L.push(`  JOIN ${p}pscell c ON c.cell = s.cell`);
  L.push(`  CROSS JOIN ${p}psp pp`);
  L.push(`),`);
  L.push(`${p}psk AS (SELECT * FROM ${p}psw WHERE trimmed = 0),`);
  return L;
}

/**
 * Weighted mean, weighted variance and the standardized difference.
 *
 * The variance is the frequency-weighted sample form (Austin Stat Med
 * 2009;28:3083):
 *
 *     s2_w = [ SUM(w) / ( SUM(w)^2 - SUM(w^2) ) ] * SUM( w (x - xbar_w)^2 )
 *
 * NOT the naive SUM(w (x-xbar)^2)/SUM(w). The two differ by exactly the factor
 * that makes the estimator unbiased under weighting, and the naive one shrinks
 * the denominator of every standardized difference — which makes a weighted
 * analysis look better balanced than it is, in the direction nobody checks.
 */
export function weightedSmdSql(o: { cte: string; col: string; alias: string }): string[] {
  const { cte, col } = o;
  return [
    `  SELECT`,
    `    SUM(CASE WHEN treated = 1 THEN w ELSE 0 END) AS sw_t,`,
    `    SUM(CASE WHEN treated = 0 THEN w ELSE 0 END) AS sw_c,`,
    `    SUM(CASE WHEN treated = 1 THEN w * w ELSE 0 END) AS sw2_t,`,
    `    SUM(CASE WHEN treated = 0 THEN w * w ELSE 0 END) AS sw2_c,`,
    `    SUM(CASE WHEN treated = 1 THEN w * ${col} ELSE 0 END) AS swx_t,`,
    `    SUM(CASE WHEN treated = 0 THEN w * ${col} ELSE 0 END) AS swx_c`,
    `  FROM ${cte}`,
  ];
}

/* ------------------------------------------------------------------ *
 *  SAS
 * ------------------------------------------------------------------ */

export function psSasSteps(o: {
  num: string; subjT: string; estimand: "ate" | "att"; stabilized: boolean; trim: number;
}): string[] {
  const wTreated = o.estimand === "ate" ? `1 / ps` : `1`;
  const wControl = o.estimand === "ate" ? `1 / (1 - ps)` : `ps / (1 - ps)`;
  const L: string[] = [
    `/*----------------------------------------------------------------------------`,
    `  The SATURATED propensity score, in closed form.`,
    `  A logistic model with only categorical covariates and every cell present is`,
    `  saturated: its maximum-likelihood fitted probability in each cell IS the`,
    `  observed treated fraction. This is arithmetic, not a fit - and the PROC`,
    `  LOGISTIC anchor below checks that claim against SAS's own fitting machinery.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_pscell as`,
    `  select cell,`,
    `         count(*) as n_cell,`,
    `         sum(treated) as n_treated_cell,`,
    `         count(*) - sum(treated) as n_control_cell,`,
    `         sum(treated) / count(*) as ps`,
    `  from ${o.subjT}`,
    `  group by cell;`,
    ``,
    `  create table work._${o.num}_psp as`,
    `  select sum(treated) / count(*) as p_treated, count(*) as n_total,`,
    `         sum(treated) as n_treated, count(*) - sum(treated) as n_control`,
    `  from ${o.subjT};`,
    ``,
    `  create table work._${o.num}_psw as`,
    `  select s.*, c.ps, c.n_cell, c.n_treated_cell, c.n_control_cell`,
    `  from ${o.subjT} as s`,
    `  inner join work._${o.num}_pscell as c`,
    `    on c.cell = s.cell;`,
    `quit;`,
    ``,
    `data work._${o.num}_psw;`,
    `  if _n_ = 1 then set work._${o.num}_psp (keep=p_treated);`,
    `  set work._${o.num}_psw;`,
  ];
  if (o.trim > 0) {
    L.push(
      `  /* TRIMMING is reported as an exclusion, never applied silently: a trimmed`,
      `     analysis estimates an effect in a DIFFERENT population. */`,
      `  trimmed = (ps < ${o.trim} or ps > ${1 - o.trim});`,
    );
  } else {
    L.push(`  trimmed = 0;   /* no trimming requested */`);
  }
  L.push(
    `  /* A zero denominator is MISSING, not a large number: it means the cell is`,
    `     entirely one arm, and no finite weight represents a counterpart that`,
    `     does not exist. */`,
    `  if treated = 1 then do;`,
    `    if ${o.estimand === "ate" ? "ps > 0" : "1"} then w_raw = ${wTreated}; else w_raw = .;`,
    `  end;`,
    `  else do;`,
    `    if 1 - ps > 0 then w_raw = ${wControl}; else w_raw = .;`,
    `  end;`,
    ...(o.stabilized
      ? [
          `  /* STABILIZED: scaled by the marginal probability of the subject's own`,
          `     arm. Changes the scale, not the balance. */`,
          `  if treated = 1 then w = p_treated * w_raw;`,
          `  else w = (1 - p_treated) * w_raw;`,
        ]
      : [`  w = w_raw;`]),
    `run;`,
    ``,
    `data work._${o.num}_psk;`,
    `  set work._${o.num}_psw;`,
    `  if trimmed = 0;`,
    `run;`,
  );
  return L;
}

/**
 * THE ANCHOR: PROC LOGISTIC against the closed form.
 *
 * The saturated claim is exactly the kind of statement that is easy to assert
 * and easy to get wrong — it holds only if the model really is saturated, which
 * means every covariate categorical AND every cell represented. So the emitted
 * program fits the model SAS would fit and compares its predicted probabilities
 * to the cell fractions computed above, on the site's own data, with no
 * reference value shipped alongside.
 *
 * A cell that is entirely one arm makes PROC LOGISTIC's coefficient infinite and
 * it will say so in the log (quasi-complete separation). Its PREDICTED
 * probability is still 0 or 1, which is still the cell fraction, so the anchor
 * holds there — and the positivity rows in the result table are where that
 * situation is actually reported.
 */
export function psSasAnchor(o: { num: string; subjT: string }): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  ANCHOR: the SATURATED claim, checked against PROC LOGISTIC.`,
    `  If the model is genuinely saturated, its predicted probabilities ARE the`,
    `  cell fractions. Comparing them is the only check on that claim that does`,
    `  not consist of repeating it.`,
    `  A cell that is entirely one arm produces quasi-complete separation and an`,
    `  infinite coefficient - SAS will note it in the log. The PREDICTED value is`,
    `  still 0 or 1 and still equals the cell fraction, so this check holds; the`,
    `  positivity rows in the result table are where that is reported as a finding.`,
    `----------------------------------------------------------------------------*/`,
    `proc logistic data=${o.subjT} noprint descending;`,
    `  class cell / param=glm;`,
    `  model treated = cell;`,
    `  output out=work._${o.num}_psfit p=ps_fitted;`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${o.num}_anchor as`,
    `  select f.cell, max(abs(f.ps_fitted - c.ps)) as gap`,
    `  from work._${o.num}_psfit as f`,
    `  inner join work._${o.num}_pscell as c on c.cell = f.cell`,
    `  group by f.cell;`,
    `quit;`,
    ``,
    `data work._${o.num}_anchor_v;`,
    `  set work._${o.num}_anchor end=_last;`,
    `  retain worst 0;`,
    `  length ps_anchor_verdict $64;`,
    `  worst = max(worst, gap);`,
    `  if _last then do;`,
    `    if worst < 1e-9 then ps_anchor_verdict = 'PASS: saturated closed form = PROC LOGISTIC fitted probability';`,
    `    else ps_anchor_verdict = 'FAIL: the model is not saturated, so the closed form is not the MLE';`,
    `    output;`,
    `  end;`,
    `  keep worst ps_anchor_verdict;`,
    `run;`,
    ``,
    `title "Propensity-score anchor: saturated closed form vs PROC LOGISTIC";`,
    `proc print data=work._${o.num}_anchor_v noobs; run;`,
    `title;`,
  ];
}
