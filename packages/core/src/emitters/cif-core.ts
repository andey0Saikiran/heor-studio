/**
 * cif-core — the Aalen-Johansen cumulative incidence function, and the number
 * it exists to replace.
 *
 * THE PROBLEM. Kaplan-Meier treats a competing event as censoring, which asserts
 * that the subject who died of something else would have gone on to have the
 * event of interest at the same rate as everyone still at risk. That is false by
 * construction — they cannot have it at all — so 1 - KM OVERSTATES the
 * probability of the event, always, and by more as the competing risk grows.
 *
 * THE ESTIMATOR. Aalen-Johansen weights each cause-k hazard by the probability
 * of having survived EVERYTHING up to that point:
 *
 *     CIF_k(t) = SUM over event times t_i <= t of  S(t_{i-1}) * d_{k,i} / n_i
 *
 * with S the ALL-CAUSE Kaplan-Meier. It is a cumulative sum over the same risk
 * sets km-core already builds, so it is entirely closed form and both twins
 * compute it.
 *
 * THREE THINGS MAKE IT CHECKABLE, and all three are executed:
 *
 *  1. THE PARTITION IDENTITY. The causes are exhaustive and mutually exclusive,
 *     so SUM_k CIF_k(t) = 1 - S_allcause(t) EXACTLY, at every t. Not
 *     approximately: the sums telescope. Any error in a single cause's
 *     accumulation breaks it.
 *
 *  2. THE BIAS IS A NUMBER. The naive 1 - KM per cause is computed beside the
 *     CIF and their difference reported. On Gold Case D that difference is
 *     1/24 for the cause of interest — the exact amount an analyst who reached
 *     for KM would have overstated the risk by.
 *
 *  3. THE NAIVE ESTIMATES CAN SUM ABOVE ONE EVENT. Because each naive curve
 *     assumes the other causes away, their complements need not sum to
 *     1 - S — and on Gold Case D they sum to 23/40 against a true 1/2. A set of
 *     probabilities for mutually exclusive outcomes that adds up to more than
 *     the probability of ANY outcome is not a rounding problem, and the module
 *     says so in the output rather than leaving it to be noticed.
 *
 * THE VARIANCE is the delta-method form (Klein & Moeschberger 2e §4.9), three
 * sums over the same risk sets:
 *
 *   Var[CIF_k(t)] = SUM [CIF_k(t) - CIF_k(t_i)]^2 * d_i / (n_i (n_i - d_i))
 *                 + SUM S(t_{i-1})^2 * ((n_i - d_ki)/n_i) * (d_ki / n_i^2)
 *                 - 2 SUM [CIF_k(t) - CIF_k(t_i)] * S(t_{i-1}) * (d_ki / n_i^2)
 *
 * It is closed form, so it is executed rather than deferred — but it is also
 * three interacting terms and easy to get subtly wrong, which is why it ships
 * with a REDUCTION CHECK rather than on trust: with no competing events at all,
 * d_i = d_ki throughout and the whole expression must collapse to Greenwood's
 * variance of 1 - KM. Gold Case A has no competing events, and both come out at
 * 15/512 there. A variance that did not reduce would be wrong in a way no single
 * fixture could otherwise show.
 *
 * Note the term structure: CIF_k(t) appears INSIDE sums indexed by t_i <= t, so
 * the variance at each evaluation time needs the CIF at that time held fixed
 * while walking every earlier event time. That is a correlated aggregate, and it
 * is why this joins the life table to itself rather than using a window
 * function.
 *
 * Ref: Aalen & Johansen Scand J Statist 1978;5:141; Klein & Moeschberger,
 * Survival Analysis 2e (2003) §4.9; Andersen et al. Int J Epidemiol
 * 2012;41:861 (why 1-KM is the wrong number).
 */

export interface CifSqlInput {
  /** CTE with one row per subject per stratum: enrolid, stratum, t, cause
   *  (cause 0 = censored, 1..K = the cause that occurred) */
  subjectsCte: string;
  /** cause codes in reporting order, e.g. [1, 2] */
  causes: number[];
  prefix?: string;
}

/**
 * `<p>ajr`, `<p>aj` — the all-cause risk sets and the per-cause CIF.
 *
 * The risk set is ALL-CAUSE on purpose: a competing event removes a subject
 * from the denominator of every cause, including its own. Building per-cause
 * risk sets instead is the single most natural way to write this wrong, and it
 * reproduces exactly the 1 - KM bias the estimator exists to remove.
 */
export function cifSqlCtes(i: CifSqlInput): string[] {
  const p = i.prefix ?? "";
  const s = i.subjectsCte;
  const win = `OVER (PARTITION BY stratum ORDER BY t)`;
  const L: string[] = [];
  L.push(`${p}ajt AS (   -- distinct times at which ANY cause occurred`);
  L.push(`  SELECT DISTINCT stratum, t FROM ${s} WHERE cause > 0`);
  L.push(`),`);
  L.push(`${p}ajr AS (   -- ALL-CAUSE risk set: a competing event removes the`);
  L.push(`           -- subject from every cause's denominator, including its own`);
  L.push(`  SELECT e.stratum, e.t,`);
  L.push(`         SUM(CASE WHEN s.t >= e.t THEN 1 ELSE 0 END) AS n_risk,`);
  L.push(`         SUM(CASE WHEN s.t = e.t AND s.cause > 0 THEN 1 ELSE 0 END) AS d_all,`);
  for (const k of i.causes) {
    L.push(`         SUM(CASE WHEN s.t = e.t AND s.cause = ${k} THEN 1 ELSE 0 END) AS d_${k},`);
  }
  L.push(`         SUM(CASE WHEN s.t = e.t AND s.cause = 0 THEN 1 ELSE 0 END) AS n_censor`);
  L.push(`  FROM ${p}ajt e`);
  L.push(`  JOIN ${s} s ON s.stratum = e.stratum`);
  L.push(`  GROUP BY e.stratum, e.t`);
  L.push(`),`);
  L.push(`${p}aj0 AS (`);
  L.push(`  -- S is the ALL-CAUSE Kaplan-Meier, accumulated as exp(sum(ln(.)))`);
  L.push(`  -- because SQL has no product aggregate. s_prev is S at the PREVIOUS`);
  L.push(`  -- event time, which is the weight Aalen-Johansen applies: the`);
  L.push(`  -- probability of having survived everything up to just before t_i.`);
  L.push(`  SELECT stratum, t, n_risk, d_all, n_censor,`);
  for (const k of i.causes) L.push(`         d_${k},`);
  L.push(`         EXP(SUM(LN(CASE WHEN n_risk > d_all`);
  L.push(`                        THEN (n_risk - d_all) * 1.0 / n_risk ELSE 1 END)) ${win}) AS surv_all,`);
  L.push(`         COALESCE(EXP(SUM(LN(CASE WHEN n_risk > d_all`);
  L.push(`                             THEN (n_risk - d_all) * 1.0 / n_risk ELSE 1 END))`);
  L.push(`                      ${win.replace(")", " ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)")}), 1.0) AS s_prev,`);
  L.push(`         MAX(CASE WHEN n_risk = d_all THEN 1 ELSE 0 END) ${win} AS surv_zero`);
  L.push(`  FROM ${p}ajr`);
  L.push(`),`);
  L.push(`${p}aj AS (`);
  L.push(`  SELECT stratum, t, n_risk, d_all, n_censor, s_prev,`);
  for (const k of i.causes) L.push(`         d_${k},`);
  L.push(`         CASE WHEN surv_zero = 1 THEN 0.0 ELSE surv_all END AS surv_all,`);
  for (const k of i.causes) {
    L.push(`         SUM(s_prev * d_${k} * 1.0 / NULLIF(n_risk, 0)) ${win} AS cif_${k},`);
  }
  L.push(`         -- Greenwood's sum on the ALL-CAUSE curve, for the identity check`);
  L.push(`         SUM(CASE WHEN n_risk > d_all`);
  L.push(`                  THEN d_all * 1.0 / (n_risk * (n_risk - d_all)) ELSE 0 END) ${win} AS gw_all`);
  L.push(`  FROM ${p}aj0`);
  L.push(`),`);
  return L;
}

/**
 * `<p>ajv_<k>` — the delta-method variance of CIF_k, evaluated at every event
 * time.
 *
 * A self-join, not a window function: CIF_k(t) sits INSIDE sums indexed by
 * t_i <= t, so each evaluation row needs its own CIF held fixed while walking
 * every earlier row. `a` is the evaluation time, `b` the summation index.
 */
export function cifVarianceSqlCtes(o: { ajCte: string; cause: number; prefix?: string }): string[] {
  const p = o.prefix ?? "";
  const k = o.cause;
  return [
    `${p}ajv_${k} AS (`,
    `  -- Klein & Moeschberger 2e (4.9): three sums over the SAME risk sets.`,
    `  -- With no competing events (d_all = d_${k} throughout) this must collapse`,
    `  -- to Greenwood's variance of 1 - KM. That reduction is asserted by the`,
    `  -- harness on Gold Case A, where both come out at 15/512.`,
    `  SELECT a.stratum, a.t,`,
    `         SUM( POWER(a.cif_${k} - b.cif_${k}, 2)`,
    `              * CASE WHEN b.n_risk > b.d_all`,
    `                     THEN b.d_all * 1.0 / (b.n_risk * (b.n_risk - b.d_all)) ELSE 0 END )`,
    `       + SUM( POWER(b.s_prev, 2) * ((b.n_risk - b.d_${k}) * 1.0 / b.n_risk)`,
    `              * (b.d_${k} * 1.0 / (b.n_risk * b.n_risk)) )`,
    `       - 2 * SUM( (a.cif_${k} - b.cif_${k}) * b.s_prev`,
    `                  * (b.d_${k} * 1.0 / (b.n_risk * b.n_risk)) ) AS var_${k}`,
    `  FROM ${o.ajCte} a`,
    `  JOIN ${o.ajCte} b ON b.stratum = a.stratum AND b.t <= a.t`,
    `  GROUP BY a.stratum, a.t, a.cif_${k}`,
    `),`,
  ];
}

/**
 * The NAIVE cause-specific Kaplan-Meier — the number this module exists to
 * argue against, computed so the argument is a subtraction rather than a claim.
 *
 * Competing events are treated as CENSORING here, which is precisely the wrong
 * assumption; that is the point. `<p>nv_<k>` carries 1 - KM_k at each event
 * time of cause k.
 */
export function naiveKmSqlCtes(o: { subjectsCte: string; cause: number; prefix?: string }): string[] {
  const p = o.prefix ?? "";
  const k = o.cause;
  const win = `OVER (PARTITION BY stratum ORDER BY t)`;
  return [
    `${p}nvt_${k} AS (SELECT DISTINCT stratum, t FROM ${o.subjectsCte} WHERE cause = ${k}),`,
    `${p}nvr_${k} AS (   -- competing events counted as CENSORED, which is the error`,
    `  SELECT e.stratum, e.t,`,
    `         SUM(CASE WHEN s.t >= e.t THEN 1 ELSE 0 END) AS n_risk,`,
    `         SUM(CASE WHEN s.t = e.t AND s.cause = ${k} THEN 1 ELSE 0 END) AS d_k`,
    `  FROM ${p}nvt_${k} e`,
    `  JOIN ${o.subjectsCte} s ON s.stratum = e.stratum`,
    `  GROUP BY e.stratum, e.t`,
    `),`,
    `${p}nv_${k} AS (`,
    `  SELECT stratum, t,`,
    `         1.0 - EXP(SUM(LN(CASE WHEN n_risk > d_k`,
    `                              THEN (n_risk - d_k) * 1.0 / n_risk ELSE 1 END)) ${win}) AS naive_${k}`,
    `  FROM ${p}nvr_${k}`,
    `),`,
  ];
}

/* ------------------------------------------------------------------ *
 *  SAS
 * ------------------------------------------------------------------ */

/** The same estimator, in a DATA step. SAS has a running product, so the
 *  accumulation is direct rather than exp(sum(ln)) — the one place the twins
 *  express the same quantity differently, which is why the harness compares
 *  the NUMBERS through the parity fingerprint rather than the text. */
export function cifSasSteps(o: { num: string; subjT: string; causes: number[] }): string[] {
  const L: string[] = [
    `/*----------------------------------------------------------------------------`,
    `  Aalen-Johansen cumulative incidence.`,
    `  The risk set is ALL-CAUSE: a competing event removes the subject from every`,
    `  cause's denominator, including its own. Building per-cause risk sets is the`,
    `  most natural way to write this wrong, and it reproduces exactly the 1 - KM`,
    `  bias the estimator exists to remove.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_ajr as`,
    `  select e.stratum, e.t,`,
    `         sum(case when s.t >= e.t then 1 else 0 end) as n_risk,`,
    `         sum(case when s.t = e.t and s.cause > 0 then 1 else 0 end) as d_all,`,
  ];
  for (const k of o.causes) {
    L.push(`         sum(case when s.t = e.t and s.cause = ${k} then 1 else 0 end) as d_${k},`);
  }
  L.push(
    `         sum(case when s.t = e.t and s.cause = 0 then 1 else 0 end) as n_censor`,
    `  from (select distinct stratum, t from ${o.subjT} where cause > 0) as e,`,
    `       ${o.subjT} as s`,
    `  where s.stratum = e.stratum`,
    `  group by e.stratum, e.t;`,
    `quit;`,
    ``,
    `proc sort data=work._${o.num}_ajr; by stratum t; run;`,
    ``,
    `data work._${o.num}_aj;`,
    `  set work._${o.num}_ajr;`,
    `  by stratum;`,
    `  retain surv_all ${o.causes.map((k) => `cif_${k}`).join(" ")} gw_all;`,
    `  if first.stratum then do;`,
    `    surv_all = 1; gw_all = 0;`,
    ...o.causes.map((k) => `    cif_${k} = 0;`),
    `  end;`,
    `  /* s_prev is S at the PREVIOUS event time - the probability of having`,
    `     survived EVERYTHING up to just before t, which is the weight`,
    `     Aalen-Johansen applies to this time's cause-specific hazard. */`,
    `  s_prev = surv_all;`,
    ...o.causes.map((k) => `  cif_${k} = cif_${k} + s_prev * d_${k} / n_risk;`),
    `  if n_risk > d_all then do;`,
    `    surv_all = surv_all * (n_risk - d_all) / n_risk;`,
    `    gw_all   = gw_all + d_all / (n_risk * (n_risk - d_all));`,
    `  end;`,
    `  else do;`,
    `    /* the all-cause curve has reached zero; Greenwood is genuinely`,
    `       undefined there and 0 would claim certainty the data cannot support */`,
    `    surv_all = 0; gw_all = .;`,
    `  end;`,
    `run;`,
  );
  return L;
}

/** The delta-method variance, per cause — the SAS twin of cifVarianceSqlCtes.
 *  A self-join for the same reason: CIF_k(t) sits inside sums indexed by
 *  t_i <= t, so each evaluation row needs its own CIF held fixed. */
export function cifSasVarianceSteps(o: { num: string; causes: number[] }): string[] {
  const L: string[] = [
    `/* Delta-method variance (Klein & Moeschberger 2e 4.9). With no competing`,
    `   events this must collapse to Greenwood's variance of 1 - KM; the harness`,
    `   asserts that reduction on a fixture with a single cause. */`,
    `proc sql;`,
  ];
  o.causes.forEach((k, i) => {
    L.push(
      `  create table work._${o.num}_ajv_${k} as`,
      `  select a.t,`,
      `         sum( (a.cif_${k} - b.cif_${k})**2`,
      `              * case when b.n_risk > b.d_all`,
      `                     then b.d_all / (b.n_risk * (b.n_risk - b.d_all)) else 0 end )`,
      `       + sum( (b.s_prev**2) * ((b.n_risk - b.d_${k}) / b.n_risk)`,
      `              * (b.d_${k} / (b.n_risk * b.n_risk)) )`,
      `       - 2 * sum( (a.cif_${k} - b.cif_${k}) * b.s_prev`,
      `                  * (b.d_${k} / (b.n_risk * b.n_risk)) ) as var_${k}`,
      `  from work._${o.num}_aj as a, work._${o.num}_aj as b`,
      `  where b.t <= a.t`,
      `  group by a.t, a.cif_${k};`,
      ...(i < o.causes.length - 1 ? [``] : []),
    );
  });
  L.push(`quit;`);
  return L;
}

/** The NAIVE cause-specific Kaplan-Meier in SAS — competing events treated as
 *  censoring, which is the error this module quantifies. */
export function naiveKmSasSteps(o: { num: string; subjT: string; causes: number[] }): string[] {
  const L: string[] = [];
  for (const k of o.causes) {
    L.push(
      `proc sql;`,
      `  create table work._${o.num}_nvr_${k} as`,
      `  select e.t,`,
      `         sum(case when s.t >= e.t then 1 else 0 end) as n_risk,`,
      `         sum(case when s.t = e.t and s.cause = ${k} then 1 else 0 end) as d_k`,
      `  from (select distinct t from ${o.subjT} where cause = ${k}) as e,`,
      `       ${o.subjT} as s`,
      `  group by e.t;`,
      `quit;`,
      ``,
      `proc sort data=work._${o.num}_nvr_${k}; by t; run;`,
      ``,
      `data work._${o.num}_nv_${k};`,
      `  set work._${o.num}_nvr_${k} end=_l;`,
      `  retain _s 1;`,
      `  if n_risk > d_k then _s = _s * (n_risk - d_k) / n_risk;`,
      `  else _s = 0;`,
      `  naive_${k} = 1 - _s;`,
      `  keep t naive_${k};`,
      `run;`,
      ``,
    );
  }
  return L;
}

/**
 * The horizon table: the last life-table row at or before each day mark, with
 * every cause's CIF, variance and naive estimate carried across.
 *
 * Driven off the HORIZON list rather than the life table, so a mark before the
 * first event reports a cumulative incidence of ZERO rather than vanishing —
 * the same reasoning as km-core's horizon helper, and the same failure it
 * avoids: an inner join drops exactly the curves that are flat, which are the
 * ones a reader most easily misreads as missing data.
 */
export function cifSasHorizonSteps(o: {
  num: string; causes: number[]; horizons: number[]; naive: boolean;
}): string[] {
  const L: string[] = [
    `data work._${o.num}_hzlist;`,
    ...o.horizons.map((h) => `  horizon = ${h}; output;`),
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${o.num}_hz as`,
    `  select h.horizon,`,
    `         coalesce((select max(a.surv_all) from work._${o.num}_aj as a`,
    `                   where a.t = (select max(t) from work._${o.num}_aj where t <= h.horizon)), 1) as surv_all,`,
  ];
  for (const k of o.causes) {
    L.push(
      `         coalesce((select max(a.cif_${k}) from work._${o.num}_aj as a`,
      `                   where a.t = (select max(t) from work._${o.num}_aj where t <= h.horizon)), 0) as cif_${k},`,
      `         coalesce((select max(v.var_${k}) from work._${o.num}_ajv_${k} as v`,
      `                   where v.t = (select max(t) from work._${o.num}_aj where t <= h.horizon)), 0) as var_${k}${o.naive ? "," : k === o.causes[o.causes.length - 1] ? "" : ","}`,
    );
    if (o.naive) {
      L.push(
        `         coalesce((select max(n.naive_${k}) from work._${o.num}_nv_${k} as n`,
        `                   where n.t = (select max(t) from work._${o.num}_nv_${k} where t <= h.horizon)), 0) as naive_${k}${k === o.causes[o.causes.length - 1] ? "" : ","}`,
      );
    }
  }
  L.push(`  from work._${o.num}_hzlist as h;`, `quit;`);
  return L;
}

/**
 * PROC LIFETEST with `eventcode=` is SAS's own Aalen-Johansen, so the emitted
 * program runs it beside the closed form and compares them — the same anchor
 * shape the Kaplan-Meier module uses. No reference value travels with the
 * program; the check is against the site's own data through a second
 * implementation.
 */
export function cifSasAnchor(o: { num: string; subjT: string; cause: number }): string[] {
  return [
    `/*----------------------------------------------------------------------------`,
    `  ANCHOR: PROC LIFETEST computes the SAME estimator when given eventcode=,`,
    `  so the closed form above is checked against SAS's own implementation on the`,
    `  site's own data. Nothing is shipped alongside to compare against.`,
    `----------------------------------------------------------------------------*/`,
    `ods output CIF = work._${o.num}_lt_cif;`,
    `proc lifetest data=${o.subjT} plots=none;`,
    `  time t*cause(0) / eventcode=${o.cause};`,
    `  strata stratum;`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${o.num}_anchor as`,
    `  select a.stratum, a.t, a.cif_${o.cause} as closed_form, l.CIF as lifetest_cif,`,
    `         abs(a.cif_${o.cause} - l.CIF) as gap`,
    `  from work._${o.num}_aj as a`,
    `  inner join work._${o.num}_lt_cif as l`,
    `    on l.stratum = a.stratum and l.t = a.t;`,
    `quit;`,
    ``,
    `data work._${o.num}_anchor_v;`,
    `  set work._${o.num}_anchor end=_last;`,
    `  retain worst 0;`,
    `  length cif_anchor_verdict $56;`,
    `  worst = max(worst, gap);`,
    `  if _last then do;`,
    `    if worst < 1e-9 then cif_anchor_verdict = 'PASS: closed form = PROC LIFETEST CIF';`,
    `    else cif_anchor_verdict = 'FAIL: closed form differs from PROC LIFETEST';`,
    `    output;`,
    `  end;`,
    `  keep worst cif_anchor_verdict;`,
    `run;`,
    ``,
    `title "Cumulative incidence anchor: closed form vs PROC LIFETEST";`,
    `proc print data=work._${o.num}_anchor_v noobs; run;`,
    `title;`,
  ];
}
