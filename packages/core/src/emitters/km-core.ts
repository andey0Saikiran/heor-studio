/**
 * km-core — the Kaplan-Meier life-table primitive, shared by every
 * time-to-event measure.
 *
 * The build plan lists this as an L-sized substrate unlocking ~15 analyses, and
 * the reason it is a substrate rather than module-local code is the same reason
 * rate-core is: the risk set at each event time is the one object that survival,
 * competing risks, the log-rank test and (eventually) the Cox score all read.
 * Two independent constructions of a risk set is two places for the twins to
 * disagree about who was still being observed at day 200.
 *
 * WHAT IS EXECUTABLE HERE, and this is unusual for this project: nearly all of
 * it. The product-limit estimator, Greenwood's variance, both interval forms,
 * the median and the log-rank statistic are ALL closed form. Only the
 * chi-square tail probability is not — so unlike the regression family, where
 * every fitted coefficient is SAS-primary, survival hands SAS exactly one job:
 * turning a statistic the SQL already computed into a p-value.
 *
 * Ref: Kaplan & Meier JASA 1958;53:457 (product-limit); Greenwood, Reports on
 * Public Health and Medical Subjects 1926;33:1 (the variance); Kalbfleisch &
 * Prentice 2e (2002) §1.4 (log-log transform); Mantel Cancer Chemother Rep
 * 1966;50:163 and Peto & Peto JRSS-A 1972;135:185 (the log-rank test).
 */

/**
 * Tolerance on the median comparison.
 *
 * The median is the smallest t with S(t) <= 0.5 — an inequality evaluated AT a
 * boundary. SQL has no product aggregate, so S is accumulated as
 * exp(sum(ln(...))) (see kmSqlCtes), and a survival that is EXACTLY one half
 * can land a few ulps either side of it. Gold Case A's reference arm reaches
 * exactly 1/2 at day 200, on purpose, which is where this stopped being
 * theoretical: without a tolerance the SQL twin reports the median as undefined
 * while the SAS twin, whose DATA step multiplies the factors directly and hits
 * 0.5 exactly, reports 200.
 *
 * So this constant is not a fudge covering up imprecision — it is what makes
 * the two languages agree at the boundary, and it is small enough that no real
 * survival curve has two distinct values inside it.
 */
export const MEDIAN_EPS = 1e-9;

/**
 * The chi-square critical value used for the log-rank DECISION at alpha = 0.05.
 *
 * SQL cannot invert a chi-square CDF, so the p-value is SAS-primary. But a
 * DECISION at a fixed alpha needs only a comparison against a constant, and for
 * one degree of freedom that constant is z^2 — which this repo already pins as
 * 3.8416 for the Wilson interval. Reusing it is deliberate: the build plan's
 * code-truth review specifically refused a second 95% constant in one bundle.
 *
 * The honest caveat, emitted with the result: 3.8416 is 1.96^2, and the exact
 * chi-square quantile is 3.841459. A statistic landing between those two values
 * would be called significant here and not significant by SAS. That band is
 * about four parts in 100,000 wide, and the emitted program says so rather than
 * leaving a reader to discover it.
 */
export const CHI2_CRIT_95_DF1 = "3.8416";
export const CHI2_CRIT_95_DF1_EXACT = "3.841459";

/* ------------------------------------------------------------------ *
 *  SQL
 * ------------------------------------------------------------------ */

export interface KmSqlInput {
  /** CTE with one row per subject PER STRATUM: enrolid, stratum, t, ev */
  subjectsCte: string;
  /** prefix for the CTEs defined here, so several curves can coexist */
  prefix?: string;
}

/**
 * The life table: `<p>etimes`, `<p>risk`, `<p>km0`, `<p>km`.
 *
 * `<p>km` carries stratum, t, n_risk, n_event, n_censor, surv, gw — where `gw`
 * is Greenwood's running sum d/(n(n-d)), not the variance: the variance is
 * S(t)^2 * gw, and keeping the sum separate is what lets the log-log interval
 * (which needs sqrt(gw) alone) share one accumulation with the linear one.
 *
 * Two degeneracies are handled explicitly rather than left to the engine:
 *
 *  - n_event = n_risk. Every remaining subject has the event at the same
 *    instant, the curve drops to exactly zero, and both ln((n-d)/n) and the
 *    Greenwood denominator become ln(0) and 0. Postgres raises on ln(0), so
 *    the curve would not merely be wrong, the program would abort. Survival is
 *    pinned to 0 from that point and Greenwood is NULL, because the variance of
 *    an estimate at the boundary genuinely is undefined — reporting 0 there
 *    would claim certainty.
 *
 *  - the empty life table. A stratum with no events at all produces no rows
 *    here, which is correct: there is no event time to tabulate. The horizon
 *    and median helpers below therefore drive off the STRATA list, not off this
 *    table, so a curve of "nobody had the event" still reports S(t) = 1 instead
 *    of vanishing.
 */
export function kmSqlCtes(i: KmSqlInput): string[] {
  const p = i.prefix ?? "";
  const s = i.subjectsCte;
  const win = `OVER (PARTITION BY stratum ORDER BY t)`;
  return [
    `${p}etimes AS (   -- distinct event times, per stratum`,
    `  SELECT DISTINCT stratum, t FROM ${s} WHERE ev = 1`,
    `),`,
    `${p}risk AS (   -- the RISK SET at each event time: still being observed at t`,
    `  SELECT e.stratum, e.t,`,
    `         SUM(CASE WHEN s.t >= e.t THEN 1 ELSE 0 END) AS n_risk,`,
    `         SUM(CASE WHEN s.t = e.t AND s.ev = 1 THEN 1 ELSE 0 END) AS n_event,`,
    `         SUM(CASE WHEN s.t = e.t AND s.ev = 0 THEN 1 ELSE 0 END) AS n_censor`,
    `  FROM ${p}etimes e`,
    `  JOIN ${s} s ON s.stratum = e.stratum`,
    `  GROUP BY e.stratum, e.t`,
    `),`,
    `${p}km0 AS (`,
    `  -- The product-limit estimator is a PRODUCT and SQL has no product`,
    `  -- aggregate, so it is accumulated as exp(sum(ln(.))). The ELSE 1 arm is`,
    `  -- never a real factor: it only keeps ln() away from zero on the row where`,
    `  -- the curve hits 0, which gw_undef then handles.`,
    `  SELECT stratum, t, n_risk, n_event, n_censor,`,
    `         EXP(SUM(LN(CASE WHEN n_risk > n_event`,
    `                         THEN (n_risk - n_event) * 1.0 / n_risk ELSE 1 END)) ${win}) AS surv_raw,`,
    `         SUM(CASE WHEN n_risk > n_event`,
    `                  THEN n_event * 1.0 / (n_risk * (n_risk - n_event)) ELSE 0 END) ${win} AS gw_raw,`,
    `         MAX(CASE WHEN n_risk = n_event THEN 1 ELSE 0 END) ${win} AS gw_undef`,
    `  FROM ${p}risk`,
    `),`,
    `${p}km AS (`,
    `  SELECT stratum, t, n_risk, n_event, n_censor,`,
    `         CASE WHEN gw_undef = 1 THEN 0.0 ELSE surv_raw END AS surv,`,
    `         -- Greenwood is genuinely UNDEFINED once the curve reaches zero;`,
    `         -- emitting 0 there would report certainty the data cannot support.`,
    `         CASE WHEN gw_undef = 1 THEN NULL ELSE gw_raw END AS gw`,
    `  FROM ${p}km0`,
    `),`,
  ];
}

/** Standard error of S(t): S(t) * sqrt(Greenwood sum). */
export function kmSeSql(survExpr = "surv", gwExpr = "gw"): string {
  return `(${survExpr} * SQRT(${gwExpr}))`;
}

/**
 * Confidence limits for a survival probability, both forms closed.
 *
 * log_log transforms to ln(-ln S), whose limits map back through
 * S^exp(±z*sigma) and are therefore inside [0,1] BY CONSTRUCTION. The linear
 * form is Greenwood on the raw scale and is not: on Gold Case A the per-arm
 * upper limit at day 100 comes out at 1.174, which is why it is clamped and why
 * log_log is the default. The clamp is visible in the emitted SQL rather than
 * hidden in a formatting step, because a limit that was truncated is a
 * different statement than one that landed there.
 *
 * Both are NULL when S is 0 or 1: ln(-ln 1) is ln(0), and neither transform has
 * anything to say at the boundary.
 */
export function kmCiSql(
  method: "log_log" | "linear",
  survExpr = "surv",
  gwExpr = "gw",
): { low: string; high: string } {
  const se = kmSeSql(survExpr, gwExpr);
  if (method === "linear") {
    return {
      low: `CASE WHEN ${gwExpr} IS NULL THEN NULL ELSE GREATEST(0.0, ${survExpr} - 1.96 * ${se}) END`,
      high: `CASE WHEN ${gwExpr} IS NULL THEN NULL ELSE LEAST(1.0, ${survExpr} + 1.96 * ${se}) END`,
    };
  }
  const guard = `${survExpr} > 0 AND ${survExpr} < 1 AND ${gwExpr} IS NOT NULL`;
  const sigma = `(SQRT(${gwExpr}) / ABS(LN(${survExpr})))`;
  return {
    // a LARGER exponent on a number below 1 gives a SMALLER value, so +z is the
    // LOWER limit here — the sign that reads backwards and is therefore worth
    // saying out loud
    low: `CASE WHEN ${guard} THEN POWER(${survExpr}, EXP(1.96 * ${sigma})) END`,
    high: `CASE WHEN ${guard} THEN POWER(${survExpr}, EXP(-1.96 * ${sigma})) END`,
  };
}

export interface KmHorizonSqlInput extends KmSqlInput {
  /** the life-table CTE built by kmSqlCtes */
  kmCte: string;
  /** day marks at which S(t) is reported */
  horizons: number[];
}

/**
 * `<p>strata`, `<p>horizons`, `<p>hz0`, `<p>hz` — S(t) at fixed day marks.
 *
 * Driven off the STRATA list and LEFT JOINed to the life table, so a stratum
 * with no events (or a horizon before the first event) reports S = 1 rather
 * than disappearing. A horizon table built by inner-joining the life table
 * would silently drop exactly the curves that are flat, which are the ones a
 * reader is most likely to misread as missing data.
 */
export function kmHorizonSqlCtes(i: KmHorizonSqlInput): string[] {
  const p = i.prefix ?? "";
  const L: string[] = [];
  L.push(`${p}strata AS (SELECT DISTINCT stratum FROM ${i.subjectsCte}),`);
  L.push(`${p}horizons AS (`);
  i.horizons.forEach((h, k) => {
    L.push(`  SELECT ${h} AS horizon${k < i.horizons.length - 1 ? `` : ``}`);
    if (k < i.horizons.length - 1) L.push(`  UNION ALL`);
  });
  L.push(`),`);
  L.push(`${p}hz0 AS (   -- the last life-table row at or before each horizon`);
  L.push(`  SELECT st.stratum, h.horizon, k.surv, k.gw,`);
  L.push(`         ROW_NUMBER() OVER (PARTITION BY st.stratum, h.horizon ORDER BY k.t DESC) AS rn`);
  L.push(`  FROM ${p}strata st`);
  L.push(`  CROSS JOIN ${p}horizons h`);
  L.push(`  LEFT JOIN ${i.kmCte} k ON k.stratum = st.stratum AND k.t <= h.horizon`);
  L.push(`),`);
  L.push(`${p}riskat AS (   -- how many are still being observed AT the horizon`);
  L.push(`  SELECT st.stratum, h.horizon,`);
  L.push(`         SUM(CASE WHEN sv.t >= h.horizon THEN 1 ELSE 0 END) AS n_risk_at`);
  L.push(`  FROM ${p}strata st`);
  L.push(`  CROSS JOIN ${p}horizons h`);
  L.push(`  LEFT JOIN ${i.subjectsCte} sv ON sv.stratum = st.stratum`);
  L.push(`  GROUP BY st.stratum, h.horizon`);
  L.push(`),`);
  L.push(`${p}hz AS (`);
  L.push(`  -- COALESCE(surv, 1.0): no event at or before the horizon means nobody`);
  L.push(`  -- had it yet, so survival is 1 — not missing.`);
  L.push(`  SELECT h.stratum, h.horizon, COALESCE(h.surv, 1.0) AS surv, h.gw, r.n_risk_at`);
  L.push(`  FROM ${p}hz0 h`);
  L.push(`  JOIN ${p}riskat r ON r.stratum = h.stratum AND r.horizon = h.horizon`);
  L.push(`  WHERE h.rn = 1`);
  L.push(`),`);
  return L;
}

/**
 * `<p>med` — median survival, one row per stratum, NULL when the curve never
 * reaches one half.
 *
 * A NULL median is a RESULT, not a gap: "more than half were still event-free
 * when follow-up ended" is the finding, and a table that omitted the row would
 * read as a curve that failed to compute. So this LEFT JOINs from the strata
 * list rather than grouping the life table.
 */
export function kmMedianSqlCtes(i: KmHorizonSqlInput): string[] {
  const p = i.prefix ?? "";
  return [
    `${p}med0 AS (`,
    `  -- MEDIAN_EPS: S is accumulated as exp(sum(ln)), so a curve landing`,
    `  -- exactly on one half can miss a bare "<= 0.5" by a few ulps while the`,
    `  -- SAS twin's running product hits it exactly. The tolerance is what makes`,
    `  -- the two languages agree at the boundary.`,
    `  SELECT stratum, MIN(t) AS median_days FROM ${i.kmCte}`,
    `  WHERE surv <= 0.5 + ${MEDIAN_EPS}`,
    `  GROUP BY stratum`,
    `),`,
    `${p}med AS (`,
    `  SELECT st.stratum, m.median_days`,
    `  FROM ${p}strata st LEFT JOIN ${p}med0 m ON m.stratum = st.stratum`,
    `),`,
  ];
}

export interface LogRankSqlInput {
  /** UNGROUPED per-subject CTE: enrolid, t, ev, exposed (0/1) */
  subjectsCte: string;
  prefix?: string;
}

/**
 * `<p>lrt`, `<p>lr`, `<p>lrsum` — the log-rank test, in closed form.
 *
 * At each event time the number of events in the exposed arm is hypergeometric
 * given the margins, so E = d*n1/n and V = d(n-d)n1n0 / (n^2 (n-1)). Summing O,
 * E and V over event times gives (O-E)^2/V, chi-square on 1 df. Every term is
 * arithmetic on counts, so the STATISTIC is fully executable — only its tail
 * probability is not.
 *
 * The (n-d)/(n-1) factor is the tie correction. It is 1 when d = 1, so no
 * fixture with distinct event times can tell a correct implementation from one
 * that dropped it — which is precisely why it is fingerprinted in both
 * languages instead of being left to a gold number to catch.
 *
 * The n = 1 guard matters at the tail of a curve: with one subject left at
 * risk, the variance denominator contains (n-1) = 0. The contribution is
 * genuinely zero there (a single subject cannot vary), so the guard is the
 * correct value and not a patch.
 */
export function logRankSqlCtes(i: LogRankSqlInput): string[] {
  const p = i.prefix ?? "";
  const s = i.subjectsCte;
  return [
    `${p}lrt AS (SELECT DISTINCT t FROM ${s} WHERE ev = 1),`,
    `${p}lr AS (   -- pooled risk set at each event time, split by arm`,
    `  SELECT e.t,`,
    `         SUM(CASE WHEN s.t >= e.t THEN 1 ELSE 0 END) AS n,`,
    `         SUM(CASE WHEN s.t >= e.t AND s.exposed = 1 THEN 1 ELSE 0 END) AS n1,`,
    `         SUM(CASE WHEN s.t = e.t AND s.ev = 1 THEN 1 ELSE 0 END) AS d,`,
    `         SUM(CASE WHEN s.t = e.t AND s.ev = 1 AND s.exposed = 1 THEN 1 ELSE 0 END) AS d1`,
    `  FROM ${p}lrt e CROSS JOIN ${s} s`,
    `  GROUP BY e.t`,
    `),`,
    `${p}lrsum AS (`,
    `  -- No COALESCE on the observed count. With no event times there is no test,`,
    `  -- and "0 observed" beside a NULL expectation would read as a result rather`,
    `  -- than as an absence - so every term of an undefined test is NULL together.`,
    `  SELECT SUM(d1) AS o_exp,`,
    `         SUM(d * 1.0 * n1 / NULLIF(n, 0)) AS e_exp,`,
    `         -- (n-d)/(n-1) is the TIE correction; it equals 1 whenever d = 1, so`,
    `         -- no fixture with distinct event times can miss its removal.`,
    `         SUM(CASE WHEN n > 1`,
    `                  THEN d * 1.0 * (n - d) * n1 * (n - n1) / (n * 1.0 * n * (n - 1))`,
    `                  ELSE 0 END) AS v_exp,`,
    `         COUNT(*) AS n_event_times`,
    `  FROM ${p}lr`,
    `),`,
  ];
}

/* ------------------------------------------------------------------ *
 *  SAS
 * ------------------------------------------------------------------ */

/**
 * The SAS life table — the SAME algebra the SQL twin runs, in PROC SQL and a
 * DATA step.
 *
 * A deliberate choice worth stating: the REPORTED numbers come from this closed
 * form in both languages, and PROC LIFETEST is run alongside it as a check
 * (kmSasLifetestAnchor) rather than as the source. The alternative — LIFETEST
 * produces the SAS numbers, SQL produces its own — would leave the twins
 * agreeing by hope, with no way to tell a genuine divergence from a procedure
 * option nobody noticed. This way the twins compute the same quantity by the
 * same route, and a THIRD implementation confirms it.
 *
 * The running product here is a genuine multiplication, where SQL accumulates
 * exp(sum(ln)) because it has no product aggregate. Two routes to one number is
 * not an inconsistency to reconcile; it is what makes the anchor worth running.
 */
export function kmSasLifeTableSteps(o: {
  num: string;
  /** stratum-expanded per-subject dataset: stratum, t, ev */
  survsT: string;
}): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  Life table: the risk set at each event time, then the product-limit`,
    `  estimator and Greenwood's variance - the SAME closed form as the SQL twin.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_risk as`,
    `  select e.stratum, e.t,`,
    `         sum(case when s.t >= e.t then 1 else 0 end) as n_risk,`,
    `         sum(case when s.t = e.t and s.ev = 1 then 1 else 0 end) as n_event,`,
    `         sum(case when s.t = e.t and s.ev = 0 then 1 else 0 end) as n_censor`,
    `  from (select distinct stratum, t from ${o.survsT} where ev = 1) as e`,
    `  inner join ${o.survsT} as s`,
    `    on s.stratum = e.stratum`,
    `  group by e.stratum, e.t;`,
    `quit;`,
    ``,
    `proc sort data=work._${o.num}_risk; by stratum t; run;`,
    ``,
    `data work._${o.num}_km;`,
    `  set work._${o.num}_risk;`,
    `  by stratum t;`,
    `  retain _s _g _undef;`,
    `  if first.stratum then do; _s = 1; _g = 0; _undef = 0; end;`,
    `  /* n_event = n_risk: every remaining subject has the event at once, the`,
    `     curve reaches exactly zero, and Greenwood's denominator vanishes. The`,
    `     variance there is genuinely UNDEFINED - reporting 0 would claim a`,
    `     certainty the data cannot support. */`,
    `  if n_risk > n_event then do;`,
    `    _s = _s * (n_risk - n_event) / n_risk;`,
    `    _g = _g + n_event / (n_risk * (n_risk - n_event));`,
    `  end;`,
    `  else do;`,
    `    _s = 0;`,
    `    _undef = 1;`,
    `  end;`,
    `  surv = _s;`,
    `  if _undef = 1 then gw = .; else gw = _g;`,
    `  drop _s _g _undef;`,
    `run;`,
  ];
}

/** Greenwood SE + the chosen interval, as DATA-step statements. Shared by the
 *  life table and the horizon step so one edit moves both. */
export function kmSasCiLines(method: "log_log" | "linear"): string[] {
  const common = [`  if gw ne . then se = surv * sqrt(gw); else se = .;`];
  if (method === "linear") {
    return [
      ...common,
      `  /* the LINEAR interval is not bounded by [0,1] and needs clamping - which`,
      `     is exactly why log_log is the default */`,
      `  if gw ne . then do;`,
      `    ci_low  = max(0, surv - 1.96 * se);`,
      `    ci_high = min(1, surv + 1.96 * se);`,
      `  end;`,
      `  else do; ci_low = .; ci_high = .; end;`,
    ];
  }
  return [
    ...common,
    `  /* log-log: limits map back through S**exp(+/-z*sigma), so they are inside`,
    `     [0,1] by construction. A LARGER exponent on a number below 1 gives a`,
    `     SMALLER value, so +z is the LOWER limit - the sign that reads backwards. */`,
    `  if surv > 0 and surv < 1 and gw ne . then do;`,
    `    _sig    = sqrt(gw) / abs(log(surv));`,
    `    ci_low  = surv ** exp(1.96 * _sig);`,
    `    ci_high = surv ** exp(-1.96 * _sig);`,
    `  end;`,
    `  else do; ci_low = .; ci_high = .; end;`,
    `  drop _sig;`,
  ];
}

/**
 * PROC LIFETEST, run as an independent check on the life table above.
 *
 * "Trust the procedure" is the posture this project refuses everywhere else,
 * and unlike a GLM's iteratively reweighted least squares the product-limit
 * estimator HAS a closed form — so the machinery can be checked rather than
 * trusted, the same way the saturated design anchors the regression family.
 * No reference value travels with the program: the comparison is against the
 * procedure's own output, on the site's own data.
 */
export function kmSasLifetestAnchor(o: { num: string; subjT: string; conftype: "loglog" | "linear" }): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  KAPLAN-MEIER ANCHOR: PROC LIFETEST against the closed form computed above.`,
    `  Run on the Overall curve; every stratum walks the same code path, so a`,
    `  disagreement anywhere would show here.`,
    `----------------------------------------------------------------------------*/`,
    `proc lifetest data=${o.subjT} method=km conftype=${o.conftype} outsurv=work._${o.num}_ls noprint;`,
    `  time t*ev(0);`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${o.num}_acmp as`,
    `  select a.t, a.surv as closed_form, b.survival as lifetest_surv,`,
    `         abs(a.surv - b.survival) as gap`,
    `  from work._${o.num}_km as a`,
    `  inner join work._${o.num}_ls as b`,
    `    on b.t = a.t`,
    `  where a.stratum = 'Overall' and b.survival ne .;`,
    `quit;`,
    ``,
    `data work._${o.num}_averdict;`,
    `  set work._${o.num}_acmp end=_last;`,
    `  retain _worst 0 _n 0;`,
    `  length anchor_verdict $56;`,
    `  _worst = max(_worst, gap);`,
    `  _n = _n + 1;`,
    `  if _last then do;`,
    `    worst_gap = _worst;`,
    `    compared  = _n;`,
    `    if _n = 0 then anchor_verdict = 'NOT CHECKABLE (no event times)';`,
    `    else if _worst < 1e-9 then anchor_verdict = 'PASS: LIFETEST = closed-form product limit';`,
    `    else anchor_verdict = 'FAIL: LIFETEST differs from the closed form';`,
    `    output;`,
    `  end;`,
    `  keep anchor_verdict worst_gap compared;`,
    `run;`,
    ``,
    `title "Kaplan-Meier anchor: PROC LIFETEST vs the closed-form product limit";`,
    `proc print data=work._${o.num}_averdict noobs;`,
    `  var compared worst_gap anchor_verdict;`,
    `run;`,
    `title;`,
  ];
}
