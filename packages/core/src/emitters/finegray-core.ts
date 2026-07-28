/**
 * finegray-core — the subdistribution hazard model, and a correction to this
 * repo's own refusal of it.
 *
 * Wave 6.3 filed Fine-Gray beside Gray's test under "refused, not
 * approximated". Half of that was right and half was not, and the half that was
 * wrong is worth stating plainly: GRAY'S TEST is refused because it is a
 * different and more intricate statistic than the log-rank, where a
 * close-enough version would be a mislabeled test. FINE-GRAY is not that. It
 * has EXACTLY the Cox structure — a partial likelihood over risk sets, whose
 * coefficient needs Newton and whose everything-else is closed form — so it
 * takes exactly the Cox carve-out and nothing more. Refusing it "plus the usual
 * reason" lumped a buildable model in with an unbuildable statistic.
 *
 * WHAT MAKES IT DIFFERENT FROM COX, and it is one thing: the RISK SET. Under a
 * cause-specific Cox model a subject who fails from a competing cause LEAVES
 * the risk set. Under Fine-Gray they STAY in it, with a weight that decays as
 * censoring accumulates. That is what makes the coefficient an effect on the
 * CUMULATIVE INCIDENCE rather than on the rate among survivors.
 *
 *     R~(t) = {j : t_j >= t}  UNION  {j : t_j < t and j failed from a competing cause}
 *     w_j(t) = G(t) / G(t_j)     for the second group, and 1 for the first
 *
 * with G the Kaplan-Meier estimate of the CENSORING distribution — censoring
 * treated as the event, which is the one place in this codebase where that is
 * the correct thing to do rather than the classic error.
 *
 * CLOSED FORM, and therefore executed in both twins: G itself, every weight,
 * the modified risk set, the partial log-likelihood at the null, the score, the
 * information, the score test and the one-step estimator. SAS-PRIMARY: beta,
 * exactly as in Cox.
 *
 * THE REDUCTION THAT MAKES THIS CHECKABLE. With NO competing events the second
 * group of R~ is empty, every weight is 1, and Fine-Gray becomes Cox
 * identically. Not approximately — the same number. Gold Case A has a competing
 * cause that never occurs, so the harness asserts that this module's score,
 * information, null log-likelihood, score chi-square and one-step estimate all
 * EQUAL the Cox module's, digit for digit: U = -31/42, I = 1265/1764,
 * logL(0) = -5.8171112. A weighting bug, a wrong G, or a risk set that kept the
 * wrong people all break that equality, and no single-model check would notice.
 *
 * Verified vs Gold Case D: at the second event time the modified risk set is 5
 * where the cause-specific one is 4 — the competing-event subject is still in
 * the denominator, which IS the model. Verified vs Gold Case E, built so a
 * weight is genuinely fractional: G drops to 2/3 at day 300, so the
 * competing-event subject enters the day-400 risk set at weight 2/3 and the
 * weighted denominator is 8/3 rather than 3.
 *
 * Ref: Fine & Gray JASA 1999;94:496; Geskus Biometrics 2011;67:39 (the weights
 * as inverse probability of censoring); Austin & Fine Stat Med 2017;36:4391.
 */

/** Shared with cox-core: the tolerance on "every weighted risk-set share is the
 *  same". See PROPORTION_EPS there for why this value. */
export const FG_PROPORTION_EPS = "1e-12";

export interface FineGraySqlInput {
  /** per-subject CTE: enrolid, t, cause (0 censored, 1 interest, 2+ competing), exposed */
  subjectsCte: string;
  prefix?: string;
}

/**
 * `<p>fgg`, `<p>fgm`, `<p>fgr`, `<p>fg` — the censoring curve, the weighted
 * modified risk set, and every closed form on it.
 *
 * G is built by the SAME product-limit accumulation the survival module uses,
 * with the event indicator inverted. It is worth being explicit that this is
 * deliberate: treating censoring as the event is the error the competing-risks
 * module exists to correct, and it is the correct thing to do here, for a
 * different quantity. The two are one line apart in the SQL and would be easy
 * to confuse.
 */
export function fineGraySqlCtes(i: FineGraySqlInput): string[] {
  const p = i.prefix ?? "";
  const s = i.subjectsCte;
  const L: string[] = [];
  L.push(`${p}fgct AS (SELECT DISTINCT t FROM ${s} WHERE cause = 0),`);
  L.push(`${p}fgcr AS (   -- risk sets for the CENSORING distribution`);
  L.push(`  SELECT c.t,`);
  L.push(`         SUM(CASE WHEN x.t >= c.t THEN 1 ELSE 0 END) AS n,`);
  L.push(`         SUM(CASE WHEN x.t = c.t AND x.cause = 0 THEN 1 ELSE 0 END) AS d`);
  L.push(`  FROM ${p}fgct c CROSS JOIN ${s} x`);
  L.push(`  GROUP BY c.t`);
  L.push(`),`);
  L.push(`${p}fgg AS (`);
  L.push(`  -- G(t): Kaplan-Meier of the CENSORING distribution. Treating`);
  L.push(`  -- censoring as the event is the classic error everywhere else in`);
  L.push(`  -- this bundle and is exactly right here - it is a different`);
  L.push(`  -- quantity. The two differ by one predicate, so the distinction is`);
  L.push(`  -- worth stating rather than leaving to be inferred.`);
  L.push(`  SELECT t, EXP(SUM(LN(CASE WHEN n > d THEN (n - d) * 1.0 / n ELSE 1 END))`);
  L.push(`                OVER (ORDER BY t)) AS g`);
  L.push(`  FROM ${p}fgcr`);
  L.push(`),`);
  L.push(`${p}fgm AS (   -- the MODIFIED RISK SET, with inverse-probability-of-censoring weights`);
  L.push(`  SELECT e.t AS et, x.enrolid, x.exposed,`);
  L.push(`         CASE WHEN x.t >= e.t THEN 1.0`);
  L.push(`              -- a COMPETING-event subject stays in the denominator, at a`);
  L.push(`              -- weight that decays as censoring accumulates. This single`);
  L.push(`              -- CASE arm is the whole difference from a Cox model.`);
  L.push(`              ELSE COALESCE((SELECT g.g FROM ${p}fgg g WHERE g.t <= e.t ORDER BY g.t DESC LIMIT 1), 1.0)`);
  L.push(`                 / NULLIF(COALESCE((SELECT g.g FROM ${p}fgg g WHERE g.t <= x.t ORDER BY g.t DESC LIMIT 1), 1.0), 0)`);
  L.push(`         END AS w,`);
  L.push(`         -- CAUSE-SPECIFIC membership, carried EXPLICITLY rather than`);
  L.push(`         -- inferred from the weight. "Weight = 1" is not the same`);
  L.push(`         -- predicate: a retained competing-event subject also has`);
  L.push(`         -- weight 1 whenever G has not yet dropped, which is the usual`);
  L.push(`         -- case early in follow-up. Inferring it made the`);
  L.push(`         -- retained_by_subdistribution diagnostic report ZERO on a`);
  L.push(`         -- fixture where a subject WAS retained - so the check that`);
  L.push(`         -- exists to say "this is a Cox model by another name" said it`);
  L.push(`         -- about a genuine Fine-Gray fit.`);
  L.push(`         CASE WHEN x.t >= e.t THEN 1 ELSE 0 END AS at_risk`);
  L.push(`  FROM (SELECT DISTINCT t FROM ${s} WHERE cause = 1) e`);
  L.push(`  CROSS JOIN ${s} x`);
  L.push(`  WHERE x.t >= e.t OR x.cause >= 2`);
  L.push(`),`);
  L.push(`${p}fgr AS (   -- weighted risk set at each cause-1 event time`);
  L.push(`  SELECT m.et AS t,`);
  L.push(`         SUM(m.w) AS wn,`);
  L.push(`         SUM(CASE WHEN m.exposed = 1 THEN m.w ELSE 0 END) AS wn1,`);
  L.push(`         -- the CAUSE-SPECIFIC risk set, beside it. This is what a Cox`);
  L.push(`         -- model would use, and the difference between the two columns`);
  L.push(`         -- IS the model.`);
  L.push(`         SUM(m.at_risk) AS n_cause_specific,`);
  L.push(`         (SELECT COUNT(*) FROM ${s} y WHERE y.t = m.et AND y.cause = 1) AS d,`);
  L.push(`         (SELECT COUNT(*) FROM ${s} y WHERE y.t = m.et AND y.cause = 1 AND y.exposed = 1) AS d1`);
  L.push(`  FROM ${p}fgm m`);
  L.push(`  GROUP BY m.et`);
  L.push(`),`);
  L.push(`${p}fgs AS (`);
  L.push(`  SELECT SUM(d1) - SUM(d * wn1 / NULLIF(wn, 0)) AS score_u0,`);
  L.push(`         SUM(d * (wn1 / NULLIF(wn, 0)) * (1 - wn1 / NULLIF(wn, 0))) AS information0,`);
  L.push(`         -SUM(d * LN(NULLIF(wn, 0))) AS loglik0,`);
  L.push(`         SUM(d) AS d_total, SUM(d1) AS d1_exposed,`);
  L.push(`         COUNT(*) AS n_event_times,`);
  L.push(`         MIN(wn1 / NULLIF(wn, 0)) AS p_min,`);
  L.push(`         MAX(wn1 / NULLIF(wn, 0)) AS p_max,`);
  L.push(`         SUM(wn) AS wn_total,`);
  L.push(`         SUM(n_cause_specific) AS n_cs_total`);
  L.push(`  FROM ${p}fgr`);
  L.push(`),`);
  L.push(`${p}fg AS (`);
  L.push(`  SELECT c.*,`);
  L.push(`         -- The SAME anchor as Cox, with weights: under a constant`);
  L.push(`         -- WEIGHTED exposed share the partial likelihood is binomial and`);
  L.push(`         -- its maximum is closed form. No fixture here satisfies it, so`);
  L.push(`         -- it reports NOT APPLICABLE - see the module's coverage note.`);
  L.push(`         CASE WHEN c.n_event_times > 0`);
  L.push(`               AND ABS(c.p_max - c.p_min) < ${FG_PROPORTION_EPS}`);
  L.push(`               AND c.p_min > 0 AND c.p_min < 1`);
  L.push(`               AND c.d1_exposed > 0 AND c.d1_exposed < c.d_total`);
  L.push(`              THEN ((c.d1_exposed * 1.0 / c.d_total) / (1 - c.d1_exposed * 1.0 / c.d_total))`);
  L.push(`                   / (c.p_min / (1 - c.p_min))`);
  L.push(`         END AS closed_form_hr`);
  L.push(`  FROM ${p}fgs c`);
  L.push(`),`);
  return L;
}

/* ------------------------------------------------------------------ *
 *  SAS
 * ------------------------------------------------------------------ */

export function fineGraySasSteps(o: { num: string; subjT: string }): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  G(t): Kaplan-Meier of the CENSORING distribution.`,
    `  Treating censoring as the event is the classic error everywhere else in`,
    `  this bundle, and is exactly right here - it is a different quantity. The`,
    `  two differ by one predicate, so the distinction is stated rather than left`,
    `  to be inferred.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_fgcr as`,
    `  select c.t,`,
    `         sum(case when x.t >= c.t then 1 else 0 end) as n,`,
    `         sum(case when x.t = c.t and x.cause = 0 then 1 else 0 end) as d`,
    `  from (select distinct t from ${o.subjT} where cause = 0) as c,`,
    `       ${o.subjT} as x`,
    `  group by c.t;`,
    `quit;`,
    ``,
    `proc sort data=work._${o.num}_fgcr; by t; run;`,
    ``,
    `data work._${o.num}_fgg;`,
    `  set work._${o.num}_fgcr;`,
    `  retain g 1;`,
    `  if n > d then g = g * (n - d) / n;`,
    `  else g = 0;`,
    `  keep t g;`,
    `run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  The MODIFIED RISK SET. A subject who failed from a COMPETING cause stays in`,
    `  the denominator, at a weight that decays as censoring accumulates. That one`,
    `  rule is the whole difference from a Cox model, and it is what makes the`,
    `  coefficient an effect on the CUMULATIVE INCIDENCE rather than on the rate`,
    `  among survivors.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_fgm as`,
    `  select e.t as et, x.enrolid, x.exposed,`,
    `         case when x.t >= e.t then 1 else 0 end as at_risk,`,
    `         case when x.t >= e.t then 1`,
    `              else coalesce((select g from work._${o.num}_fgg`,
    `                              where t = (select max(t) from work._${o.num}_fgg where t <= e.t)), 1)`,
    `                 / coalesce((select g from work._${o.num}_fgg`,
    `                              where t = (select max(t) from work._${o.num}_fgg where t <= x.t)), 1)`,
    `         end as w`,
    `  from (select distinct t from ${o.subjT} where cause = 1) as e,`,
    `       ${o.subjT} as x`,
    `  where x.t >= e.t or x.cause >= 2;`,
    ``,
    `  create table work._${o.num}_fgr as`,
    `  select m.et as t,`,
    `         sum(m.w) as wn,`,
    `         sum(case when m.exposed = 1 then m.w else 0 end) as wn1,`,
    `         /* the CAUSE-SPECIFIC risk set beside it: what a Cox model would use.`,
    `            Carried explicitly - "weight = 1" is a DIFFERENT predicate, since a`,
    `            retained competing-event subject also has weight 1 until G drops. */`,
    `         sum(m.at_risk) as n_cause_specific,`,
    `         (select count(*) from ${o.subjT} y where y.t = m.et and y.cause = 1) as d,`,
    `         (select count(*) from ${o.subjT} y where y.t = m.et and y.cause = 1 and y.exposed = 1) as d1`,
    `  from work._${o.num}_fgm as m`,
    `  group by m.et;`,
    ``,
    `  create table work._${o.num}_fgs as`,
    `  select sum(d1) - sum(d * wn1 / wn) as score_u0,`,
    `         sum(d * (wn1 / wn) * (1 - wn1 / wn)) as information0,`,
    `         -sum(d * log(wn)) as loglik0,`,
    `         sum(d) as d_total, sum(d1) as d1_exposed,`,
    `         count(*) as n_event_times,`,
    `         min(wn1 / wn) as p_min,`,
    `         max(wn1 / wn) as p_max,`,
    `         sum(wn) as wn_total,`,
    `         sum(n_cause_specific) as n_cs_total`,
    `  from work._${o.num}_fgr;`,
    `quit;`,
    ``,
    `data work._${o.num}_fg;`,
    `  set work._${o.num}_fgs;`,
    `  /* the SAME anchor as Cox, with weights */`,
    `  if n_event_times > 0 and abs(p_max - p_min) < ${FG_PROPORTION_EPS}`,
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
 * The self-checks on PROC PHREG's subdistribution fit.
 *
 * Two of the three are the Cox ones, because the likelihood has the same shape:
 * the null -2 LOG L, and U(beta_hat) = 0 — closed form here too, because the
 * exposure is binary so the score at any beta depends only on the WEIGHTED
 * risk-set totals.
 *
 * The third is new and is the one this model most needs: PROC PHREG must have
 * been given `eventcode=`. Without it PHREG fits a CAUSE-SPECIFIC Cox model
 * instead — which runs cleanly, converges, and answers a different question.
 * That is the single most likely way for a Fine-Gray analysis to be silently
 * wrong, so the program checks that the fitted coefficient is NOT the
 * cause-specific one by comparing its own two risk-set totals.
 */
export function fineGraySasSelfChecks(o: { num: string; peT: string; fitT: string }): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  SELF-CHECK 1: the null -2 LOG L against the closed form.`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_fgchk1;`,
    `  if _n_ = 1 then set work._${o.num}_fg (keep=loglik0);`,
    `  set ${o.fitT} (where=(upcase(Criterion) = '-2 LOG L'));`,
    `  length null_ll_verdict $56;`,
    `  closed_form_m2ll = -2 * loglik0;`,
    `  phreg_m2ll       = WithoutCovariates;`,
    `  if abs(closed_form_m2ll - phreg_m2ll) < 1e-6`,
    `    then null_ll_verdict = 'PASS: PHREG null -2logL = closed form';`,
    `    else null_ll_verdict = 'FAIL: PHREG null -2logL differs from closed form';`,
    `  keep closed_form_m2ll phreg_m2ll null_ll_verdict;`,
    `run;`,
    ``,
    `title "Fine-Gray self-check 1: null -2 LOG L";`,
    `proc print data=work._${o.num}_fgchk1 noobs; run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  SELF-CHECK 2: U(beta_hat) = 0 on the WEIGHTED risk sets.`,
    `  Same defining equation as Cox, over a different denominator.`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_fgchk2;`,
    `  if _n_ = 1 then set ${o.peT} (where=(upcase(Parameter) = 'EXPOSED') keep=Parameter Estimate rename=(Estimate = beta_hat));`,
    `  set work._${o.num}_fgr end=_last;`,
    `  retain u_at_bhat 0;`,
    `  length score_verdict $60;`,
    `  _r = exp(beta_hat);`,
    `  u_at_bhat = u_at_bhat + d1 - d * (wn1 * _r) / ((wn - wn1) + wn1 * _r);`,
    `  if _last then do;`,
    `    if abs(u_at_bhat) < 1e-6`,
    `      then score_verdict = 'PASS: U(beta_hat) = 0 on the subdistribution risk sets';`,
    `      else score_verdict = 'FAIL: the fitted coefficient does not zero the score';`,
    `    output;`,
    `  end;`,
    `  keep beta_hat u_at_bhat score_verdict;`,
    `run;`,
    ``,
    `title "Fine-Gray self-check 2: the score at the fitted coefficient";`,
    `proc print data=work._${o.num}_fgchk2 noobs; run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  SELF-CHECK 3: THE MODEL THAT WAS ACTUALLY FITTED.`,
    `  Without eventcode= on the MODEL statement, PROC PHREG fits a CAUSE-SPECIFIC`,
    `  Cox model: it runs cleanly, it converges, it prints a hazard ratio, and it`,
    `  answers a different question. That is the single most likely way for a`,
    `  Fine-Gray analysis to be silently wrong.`,
    `  If the two risk-set totals below are EQUAL then no competing-event subject`,
    `  was ever retained, and whatever was fitted was cause-specific whether or not`,
    `  it was asked to be.`,
    `----------------------------------------------------------------------------*/`,
    `data work._${o.num}_fgchk3;`,
    `  set work._${o.num}_fg;`,
    `  length subdist_verdict $132;`,
    `  if wn_total > n_cs_total + 1e-9 then`,
    `    subdist_verdict = 'PASS: the risk sets are genuinely subdistribution - competing-event subjects were retained and weighted';`,
    `  else`,
    `    subdist_verdict = 'NOT DISTINGUISHABLE: no competing-event subject was ever retained, so these risk sets are the cause-specific ones and this fit is a Cox model by another name';`,
    `  keep wn_total n_cs_total subdist_verdict;`,
    `run;`,
    ``,
    `title "Fine-Gray self-check 3: was a subdistribution model actually fitted?";`,
    `proc print data=work._${o.num}_fgchk3 noobs; run;`,
    `title;`,
  ];
}
