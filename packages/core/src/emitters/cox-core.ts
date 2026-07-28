/**
 * cox-core — the Cox partial likelihood, and what of it is closed form.
 *
 * The build plan is categorical: "Fitted coefficients are unverifiable except at
 * a saturated design. Logistic, Poisson, NB, gamma-log, Cox all need
 * IRLS/Newton." That is true of the coefficient. It is NOT true of everything
 * around it, and the gap between those two statements is most of this file.
 *
 * WHAT IS CLOSED FORM, and therefore executed in both twins:
 *
 *   - the partial log-likelihood at beta = 0. Under Breslow it is just
 *     -SUM(d_i * ln(n_i)) over event times, which PROC PHREG prints as its
 *     "without covariates" -2 LOG L. A site can compare the two directly.
 *   - the SCORE at beta = 0. It is exactly O - E, the log-rank numerator: the
 *     log-rank test IS the Cox score test at the null.
 *   - the INFORMATION at beta = 0, SUM(d_i * p_i * (1 - p_i)) with p the
 *     exposed share of the risk set. This is where Cox and the log-rank part
 *     company: with no ties it equals the log-rank variance exactly, and with
 *     ties it does not, because the log-rank carries a (n-d)/(n-1) correction
 *     that Breslow's information does not. Gold Case C exists to make that
 *     difference a number rather than a claim.
 *   - the one-step estimator exp(U(0)/I(0)) — the first Newton step from the
 *     null, which is also Peto's estimator.
 *
 * WHAT IS NOT: beta itself, in general. Newton has to run, and it runs in SAS.
 *
 * EXCEPT AT A CONSTANT RISK-SET PROPORTION, which is this file's one genuinely
 * new result and the Cox analogue of the saturated 2x2. If every risk set has
 * the same exposed share p, then with r = exp(beta):
 *
 *     l(b) = b*D1 - SUM(d_i ln n_i) - D*ln(1 - p + p*r)
 *     U(b) = D1 - D * (p*r)/(1 - p + p*r)
 *
 * and U = 0 has a closed solution. Writing q = D1/D for the exposed share of
 * EVENTS:
 *
 *     HR = [q/(1-q)] / [p/(1-p)]
 *
 * — an odds ratio of "share of events exposed" over "share at risk exposed".
 * The partial likelihood has collapsed to a binomial one.
 *
 * On real data the proportion drifts as members fail and are censored, so this
 * almost never applies, and the emitted program says NOT APPLICABLE when it
 * does not. That is exactly the status of the saturated 2x2 in the regression
 * family: a verification device, not a production estimator. What it buys is
 * that the Cox coefficient stops being checkable only against itself.
 *
 * Gold Case C is built to satisfy it: p = 1/2 at both event times, q = 1/3, so
 * HR = (1/3 / 2/3) / (1/2 / 1/2) = 1/2 and beta = -ln 2 EXACTLY. An independent
 * Newton solve agrees to ten decimal places.
 *
 * Ref: Cox JRSS-B 1972;34:187; Breslow Biometrics 1974;30:89 (the tie
 * approximation); Peto & Peto JRSS-A 1972;135:185 (the one-step estimator).
 */

/** Absolute tolerance on "every risk set has the same exposed share".
 *  The shares are ratios of small integers, so a genuine constant is exact in
 *  floating point and anything else differs by far more than this. */
export const PROPORTION_EPS = "1e-12";

/** Tolerance on the SAS self-check |U(beta_hat)| = 0. PROC PHREG converges on
 *  the gradient, so a correct fit lands many orders below this; a fit that has
 *  not solved its own equation misses by a visible amount. */
export const SCORE_ZERO_EPS = "1e-6";

export interface CoxSqlInput {
  /** UNGROUPED per-subject CTE: enrolid, t, ev, exposed (0/1) */
  subjectsCte: string;
  prefix?: string;
}

/**
 * `<p>cxr` and `<p>cxsum` — risk sets and every closed-form quantity on them.
 *
 * The risk-set CTE is deliberately the same shape as km-core's log-rank one:
 * both are "at each event time, how many are still being observed and how many
 * of those are exposed". Keeping the shape identical is what lets the harness
 * assert that the Cox score and the log-rank numerator are the SAME number,
 * which they must be, rather than two numbers that happen to agree.
 */
export function coxSqlCtes(i: CoxSqlInput): string[] {
  const p = i.prefix ?? "";
  const s = i.subjectsCte;
  return [
    `${p}cxr AS (   -- risk set at each event time, split by exposure`,
    `  SELECT e.t,`,
    `         SUM(CASE WHEN s.t >= e.t THEN 1 ELSE 0 END) AS n,`,
    `         SUM(CASE WHEN s.t >= e.t AND s.exposed = 1 THEN 1 ELSE 0 END) AS n1,`,
    `         SUM(CASE WHEN s.t = e.t AND s.ev = 1 THEN 1 ELSE 0 END) AS d,`,
    `         SUM(CASE WHEN s.t = e.t AND s.ev = 1 AND s.exposed = 1 THEN 1 ELSE 0 END) AS d1`,
    `  FROM (SELECT DISTINCT t FROM ${s} WHERE ev = 1) e`,
    `  CROSS JOIN ${s} s`,
    `  GROUP BY e.t`,
    `),`,
    `${p}cxsum AS (`,
    `  SELECT`,
    `         -- SCORE at beta = 0. This IS the log-rank numerator O - E; the`,
    `         -- log-rank test is the Cox score test at the null.`,
    `         SUM(d1) - SUM(d * 1.0 * n1 / NULLIF(n, 0)) AS score_u0,`,
    `         -- INFORMATION at beta = 0, Breslow. Equals the log-rank variance`,
    `         -- when no event time is tied, and differs when one is: the`,
    `         -- log-rank carries a (n-d)/(n-1) correction this does not.`,
    `         SUM(d * 1.0 * n1 * (n - n1) / NULLIF(n * 1.0 * n, 0)) AS information0,`,
    `         -- partial log-likelihood at beta = 0. PROC PHREG prints -2 times`,
    `         -- this as its "without covariates" fit statistic, so a site can`,
    `         -- compare the two directly with nothing shipped alongside.`,
    `         -SUM(d * LN(n)) AS loglik0,`,
    `         -- the LOG-RANK variance, from the SAME risk-set table rather than`,
    `         -- from a second construction of one. It differs from the`,
    `         -- information above by exactly the (n-d)/(n-1) tie correction, so`,
    `         -- computing them side by side is what makes the difference`,
    `         -- attributable to ties and nothing else.`,
    `         SUM(CASE WHEN n > 1`,
    `                  THEN d * 1.0 * (n - d) * n1 * (n - n1) / (n * 1.0 * n * (n - 1))`,
    `                  ELSE 0 END) AS logrank_v,`,
    `         SUM(CASE WHEN d > 1 THEN 1 ELSE 0 END) AS tied_event_times,`,
    `         SUM(d) AS d_total,`,
    `         SUM(d1) AS d1_exposed,`,
    `         MIN(n1 * 1.0 / NULLIF(n, 0)) AS p_min,`,
    `         MAX(n1 * 1.0 / NULLIF(n, 0)) AS p_max,`,
    `         COUNT(*) AS n_event_times`,
    `  FROM ${p}cxr`,
    `),`,
    `${p}cx AS (`,
    `  SELECT c.*,`,
    `         -- THE ANCHOR. Under a CONSTANT risk-set exposure share the partial`,
    `         -- likelihood collapses to a binomial and its maximum is closed`,
    `         -- form: HR = [q/(1-q)] / [p/(1-p)]. Real risk sets drift, so this`,
    `         -- is usually NULL and the result says NOT APPLICABLE - it is a`,
    `         -- verification device, the way the saturated 2x2 is.`,
    `         CASE WHEN c.n_event_times > 0`,
    `               AND ABS(c.p_max - c.p_min) < ${PROPORTION_EPS}`,
    `               AND c.p_min > 0 AND c.p_min < 1`,
    `               -- q = 0 or 1 is COMPLETE SEPARATION: every event in one arm,`,
    `               -- so the likelihood is monotone and the MLE is infinite. NULL`,
    `               -- is the answer; a finite number here would be invented.`,
    `               AND c.d1_exposed > 0 AND c.d1_exposed < c.d_total`,
    `              THEN ((c.d1_exposed * 1.0 / c.d_total) / (1 - c.d1_exposed * 1.0 / c.d_total))`,
    `                   / (c.p_min / (1 - c.p_min))`,
    `         END AS closed_form_hr`,
    `  FROM ${p}cxsum c`,
    `),`,
  ];
}

/* ------------------------------------------------------------------ *
 *  SAS
 * ------------------------------------------------------------------ */

/** The same risk sets and closed forms, in PROC SQL. */
export function coxSasSteps(o: { num: string; subjT: string }): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  Risk sets and every CLOSED-FORM Cox quantity - the same arithmetic the SQL`,
    `  twin runs. Only beta itself needs Newton, and only beta comes from PHREG.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_cxr as`,
    `  select e.t,`,
    `         sum(case when s.t >= e.t then 1 else 0 end) as n,`,
    `         sum(case when s.t >= e.t and s.exposed = 1 then 1 else 0 end) as n1,`,
    `         sum(case when s.t = e.t and s.ev = 1 then 1 else 0 end) as d,`,
    `         sum(case when s.t = e.t and s.ev = 1 and s.exposed = 1 then 1 else 0 end) as d1`,
    `  from (select distinct t from ${o.subjT} where ev = 1) as e,`,
    `       ${o.subjT} as s`,
    `  group by e.t;`,
    ``,
    `  /* An SQL aggregate with no GROUP BY returns ONE row of missings on an`,
    `     empty input, which is what the SQL twin does. A retain-and-output DATA`,
    `     step would emit nothing at all and the two twins would differ in SHAPE`,
    `     on exactly the input built to test the empty case. */`,
    `  create table work._${o.num}_cxsum as`,
    `  select sum(d1) - sum(d * n1 / n) as score_u0,`,
    `         sum(d * n1 * (n - n1) / (n * n)) as information0,`,
    `         -sum(d * log(n)) as loglik0,`,
    `         sum(case when n > 1 then d * (n - d) * n1 * (n - n1) / (n * n * (n - 1))`,
    `                  else 0 end) as logrank_v,`,
    `         sum(case when d > 1 then 1 else 0 end) as tied_event_times,`,
    `         sum(d) as d_total,`,
    `         sum(d1) as d1_exposed,`,
    `         min(n1 / n) as p_min,`,
    `         max(n1 / n) as p_max,`,
    `         count(*) as n_event_times`,
    `  from work._${o.num}_cxr;`,
    `quit;`,
    ``,
    `data work._${o.num}_cx;`,
    `  set work._${o.num}_cxsum;`,
    `  /* THE ANCHOR: closed-form MLE under a constant risk-set exposure share.`,
    `     q = 0 or 1 is complete separation and the estimate is infinite, so the`,
    `     answer is missing rather than a finite invention. */`,
    `  if n_event_times > 0 and abs(p_max - p_min) < ${PROPORTION_EPS}`,
    `     and p_min > 0 and p_min < 1`,
    `     and d1_exposed > 0 and d1_exposed < d_total then do;`,
    `    _q = d1_exposed / d_total;`,
    `    closed_form_hr = (_q / (1 - _q)) / (p_min / (1 - p_min));`,
    `  end;`,
    `  else closed_form_hr = .;`,
    `  drop _q;`,
    `run;`,
  ];
}

/**
 * THE THREE SELF-CHECKS the emitted SAS runs on PROC PHREG's own output.
 *
 * None of them ships a reference value. Each compares the procedure against a
 * closed form recomputed from the site's own data, which is the only kind of
 * check on a fitted coefficient that does not reduce to trusting the fit.
 *
 *   1. the null -2 LOG L. PHREG's "without covariates" fit statistic must be
 *      -2 * loglik0, which the step above computed in closed form.
 *   2. U(beta_hat) = 0. This is the DEFINING EQUATION of the estimate, and
 *      because the covariate is binary the score at any beta is closed form in
 *      the risk-set counts alone - no per-subject sums needed. A fit that has
 *      not solved its own equation fails here even if it printed a plausible
 *      number.
 *   3. the closed-form MLE, when the risk-set proportion is constant. Usually
 *      NOT APPLICABLE, and it says so rather than passing vacuously.
 */
export function coxSasSelfChecks(o: { num: string; peT: string; fitT: string }): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  SELF-CHECK 1: the null model's -2 LOG L.`,
    `  PHREG's "without covariates" statistic must equal -2 * the closed-form`,
    `  partial log-likelihood at beta = 0 computed above.`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_chk1;`,
    `  if _n_ = 1 then set work._${o.num}_cx (keep=loglik0);`,
    `  set ${o.fitT} (where=(upcase(Criterion) = '-2 LOG L'));`,
    `  length null_ll_verdict $56;`,
    `  closed_form_m2ll = -2 * loglik0;`,
    `  phreg_m2ll       = WithoutCovariates;`,
    `  _gap = abs(closed_form_m2ll - phreg_m2ll);`,
    `  if _gap < 1e-6 then null_ll_verdict = 'PASS: PHREG null -2logL = closed form';`,
    `  else null_ll_verdict = 'FAIL: PHREG null -2logL differs from closed form';`,
    `  keep closed_form_m2ll phreg_m2ll null_ll_verdict;`,
    `run;`,
    ``,
    `title "Cox self-check 1: null -2 LOG L against the closed form";`,
    `proc print data=work._${o.num}_chk1 noobs; run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  SELF-CHECK 2: U(beta_hat) = 0, the DEFINING EQUATION of the estimate.`,
    `  With a binary exposure the score at any beta is closed form in the`,
    `  risk-set counts, so this needs nothing but the fitted number and the table`,
    `  built above. It is the strongest statement available about a coefficient`,
    `  with no closed form: not "the fit looks right" but "the fit solves the`,
    `  equation that defines it".`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_chk2;`,
    `  if _n_ = 1 then set ${o.peT} (where=(upcase(Parameter) = 'EXPOSED') keep=Parameter Estimate rename=(Estimate = beta_hat));`,
    `  set work._${o.num}_cxr end=_last;`,
    `  retain u_at_bhat 0;`,
    `  length score_verdict $60;`,
    `  _r = exp(beta_hat);`,
    `  u_at_bhat = u_at_bhat + d1 - d * (n1 * _r) / ((n - n1) + n1 * _r);`,
    `  if _last then do;`,
    `    if abs(u_at_bhat) < ${SCORE_ZERO_EPS}`,
    `      then score_verdict = 'PASS: U(beta_hat) = 0, the fit solves its own equation';`,
    `      else score_verdict = 'FAIL: the fitted coefficient does not zero the score';`,
    `    output;`,
    `  end;`,
    `  keep beta_hat u_at_bhat score_verdict;`,
    `run;`,
    ``,
    `title "Cox self-check 2: the score at the fitted coefficient";`,
    `proc print data=work._${o.num}_chk2 noobs; run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  SELF-CHECK 3: the CLOSED-FORM MLE, when every risk set has the same`,
    `  exposed share. Then the partial likelihood is binomial and`,
    `  HR = [q/(1-q)] / [p/(1-p)]. Real risk sets drift, so this is usually NOT`,
    `  APPLICABLE - and says so, rather than passing because it checked nothing.`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_chk3;`,
    `  if _n_ = 1 then set ${o.peT} (where=(upcase(Parameter) = 'EXPOSED') keep=Parameter Estimate rename=(Estimate = beta_hat));`,
    `  set work._${o.num}_cx (keep=closed_form_hr);`,
    `  length anchor_verdict $64;`,
    `  if closed_form_hr = . then anchor_verdict = 'NOT APPLICABLE: risk-set exposure share is not constant';`,
    `  else if abs(exp(beta_hat) - closed_form_hr) < 1e-6`,
    `    then anchor_verdict = 'PASS: fitted HR = closed-form binomial maximum';`,
    `    else anchor_verdict = 'FAIL: fitted HR differs from the closed form';`,
    `  fitted_hr = exp(beta_hat);`,
    `  keep fitted_hr closed_form_hr anchor_verdict;`,
    `run;`,
    ``,
    `title "Cox self-check 3: the constant-proportion closed form";`,
    `proc print data=work._${o.num}_chk3 noobs; run;`,
    `title;`,
  ];
}
