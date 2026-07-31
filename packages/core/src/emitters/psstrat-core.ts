/**
 * Propensity-score STRATIFICATION, and the reason it cannot use NTILE.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ NOT WIRED, NOT VERIFIED, NOT EMITTED BY ANYTHING.                     │
 * │                                                                       │
 * │ This file is the algebra and the argument, written down while they    │
 * │ were fresh. `modules/propensity_score.ts` still emits only IPTW, and  │
 * │ readiness still declines method:"stratification".                     │
 * │                                                                       │
 * │ Nothing below has been executed against hand-derived truth, no        │
 * │ fingerprint scrapes it, and no mutation proves the harness would      │
 * │ notice if it were wrong. Do not describe it as built. Landing it      │
 * │ means: a numStrata field on the analysis, a second output path in     │
 * │ both twins of a 607-line module built around weights, gold truth on   │
 * │ Gold A's region cells, fingerprints, a constant profile, and          │
 * │ mutations - the same work adherence and switching each took.          │
 * │                                                                       │
 * │ It is left unregistered on purpose. Registering a module before its   │
 * │ verification exists is how readiness comes to approve an analysis the │
 * │ emitters cannot produce, which is the failure this project spent      │
 * │ Wave 0 eliminating.                                                   │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * The conventional recipe is: sort by the propensity score, cut into five equal
 * groups, estimate the treatment effect inside each, pool. Every piece of that
 * is closed form, so this was filed as "unbuilt" rather than refused. Building
 * it turns up one problem the recipe hides.
 *
 * WHY NOT NTILE. The score here is SATURATED: a logistic model over categorical
 * cells has fitted probability equal to the observed treated fraction in each
 * cell, so the score takes exactly as many DISTINCT VALUES as there are cells.
 * Everyone in a cell shares a score. NTILE(5) over that does not cut a smooth
 * distribution into fifths; it cuts through the middle of tied groups, and
 * WHICH subjects land on each side depends on the order rows happen to arrive
 * in. That is order-dependence, and it is precisely the property that got
 * greedy nearest-neighbour matching refused in this project: the same data in a
 * different row order gives a different estimate.
 *
 * THE RULE USED INSTEAD. Strata boundaries are placed BETWEEN distinct score
 * values, never inside one. Order the distinct scores ascending; let
 * `share_below` be the fraction of subjects with a strictly smaller score; put
 * that whole score group in stratum FLOOR(share_below * K) + 1, capped at K.
 * It is a running sum and a division, it never splits tied subjects, and it is
 * independent of row order.
 *
 * THE CONSEQUENCE, WHICH IS REPORTED RATHER THAN HIDDEN. You cannot always form
 * K strata. With four covariate cells and K = 5, at most four strata exist, and
 * a program that reported "quintiles" would be describing something it did not
 * build. Both twins emit `strata_requested` beside `strata_formed`.
 *
 * AND THE ONE THAT MATTERS MORE: a stratum containing only treated subjects, or
 * only controls, HAS NO EFFECT TO ESTIMATE. Its subjects have no counterpart to
 * be compared against. The pooled estimate therefore drops them, and the
 * program counts and names them, because a pooled number computed over 60% of
 * the cohort is not the effect in the cohort. This is the same positivity
 * finding the IPTW and g-formula pair already surfaces from a different angle.
 *
 * Ref: Rosenbaum & Rubin Biometrika 1983;70:41 (stratification on the score,
 * and the five-strata convention); Austin Stat Med 2011;30:1292.
 */

/** The conventional number of strata. A CONVENTION, from Rosenbaum & Rubin's
 *  observation that five subclasses remove about 90% of the bias due to a
 *  continuous confounder — not a property of any particular study. */
export const CONVENTIONAL_STRATA = 5;

export interface PsStratSqlInput {
  /** CTE with one row per subject: enrolid, treated, cell, ps, and the outcome */
  scoredCte: string;
  /** 0/1 outcome column on that CTE */
  outcomeCol: string;
  strata: number;
  prefix?: string;
}

/**
 * `<p>stv`, `<p>sta`, `<p>sts`, `<p>stp` — distinct score values, stratum
 * assignment, per-stratum effects, and the pooled estimate.
 */
export function psStratSqlCtes(i: PsStratSqlInput): string[] {
  const p = i.prefix ?? "";
  const s = i.scoredCte;
  const K = i.strata;
  const y = i.outcomeCol;
  const L: string[] = [];

  L.push(`${p}stn AS (SELECT COUNT(*) AS n_all FROM ${s}),`);
  L.push(`${p}stv AS (   -- one row per DISTINCT score value, with how many sit below it`);
  L.push(`  -- Boundaries are placed BETWEEN score values, never inside one. The`);
  L.push(`  -- score is saturated, so everyone in a covariate cell shares it, and`);
  L.push(`  -- NTILE would cut through tied groups - which subjects fell on each`);
  L.push(`  -- side would then depend on row order. That is the same`);
  L.push(`  -- order-dependence that makes greedy matching unusable here.`);
  L.push(`  SELECT ps, COUNT(*) AS n_ps,`);
  L.push(`         COALESCE(SUM(COUNT(*)) OVER (ORDER BY ps ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS n_below`);
  L.push(`  FROM ${s} GROUP BY ps`);
  L.push(`),`);
  L.push(`${p}sta AS (   -- stratum for each score value: FLOOR(share_below * K) + 1`);
  L.push(`  SELECT v.ps, v.n_ps,`);
  L.push(`         LEAST(${K}, FLOOR(v.n_below * ${K}.0 / NULLIF(t.n_all, 0)) + 1) AS stratum`);
  L.push(`  FROM ${p}stv v CROSS JOIN ${p}stn t`);
  L.push(`),`);
  L.push(`${p}sts AS (   -- per stratum: arm sizes and arm means`);
  L.push(`  SELECT a.stratum,`);
  L.push(`         COUNT(*) AS n_stratum,`);
  L.push(`         SUM(s.treated) AS n_treated,`);
  L.push(`         COUNT(*) - SUM(s.treated) AS n_control,`);
  L.push(`         SUM(CASE WHEN s.treated = 1 THEN s.${y} ELSE 0 END) AS y_treated,`);
  L.push(`         SUM(CASE WHEN s.treated = 0 THEN s.${y} ELSE 0 END) AS y_control`);
  L.push(`  FROM ${s} s JOIN ${p}sta a ON a.ps = s.ps`);
  L.push(`  GROUP BY a.stratum`);
  L.push(`),`);
  L.push(`${p}stm AS (`);
  L.push(`  SELECT *,`);
  /* A one-arm stratum has no contrast. NULL, not zero: zero is a real effect
   * estimate and would be pooled as though it had been measured. */
  L.push(`         CASE WHEN n_treated > 0 AND n_control > 0`);
  L.push(`              THEN y_treated * 1.0 / n_treated - y_control * 1.0 / n_control`);
  L.push(`              ELSE NULL END AS diff,`);
  L.push(`         CASE WHEN n_treated = 0 OR n_control = 0 THEN 1 ELSE 0 END AS one_arm_only`);
  L.push(`  FROM ${p}sts`);
  L.push(`),`);
  L.push(`${p}stp AS (   -- pooled over strata that HAVE both arms`);
  L.push(`  -- Weighting by stratum size gives the ATE over the subjects actually`);
  L.push(`  -- contrastable. n_pooled below is how many that is, and it is emitted`);
  L.push(`  -- beside the estimate because a pooled effect over part of a cohort`);
  L.push(`  -- is not the effect in that cohort.`);
  L.push(`  SELECT SUM(CASE WHEN diff IS NOT NULL THEN n_stratum ELSE 0 END) AS n_pooled,`);
  L.push(`         SUM(CASE WHEN diff IS NULL THEN n_stratum ELSE 0 END) AS n_dropped,`);
  L.push(`         SUM(CASE WHEN diff IS NOT NULL THEN diff * n_stratum ELSE 0 END) AS num,`);
  L.push(`         COUNT(*) AS strata_formed,`);
  L.push(`         SUM(one_arm_only) AS strata_one_arm`);
  L.push(`  FROM ${p}stm`);
  L.push(`),`);
  return L;
}

/** SAS twin of the same construction. */
export function psStratSasSteps(o: {
  num: string; subjT: string; outcomeCol: string; strata: number;
}): string[] {
  const { num, subjT, outcomeCol: y, strata: K } = o;
  return [
    `/*----------------------------------------------------------------------------`,
    `  PROPENSITY-SCORE STRATIFICATION.`,
    `  Boundaries fall BETWEEN distinct score values, never inside one. The`,
    `  saturated score is constant within a covariate cell, so PROC RANK with`,
    `  GROUPS= would split tied subjects and the split would depend on row order.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql noprint;`,
    `  select count(*) into :_n_all trimmed from ${subjT};`,
    ``,
    `  create table work._${num}_stv as`,
    `  select ps, count(*) as n_ps`,
    `  from ${subjT} group by ps;`,
    `quit;`,
    ``,
    `proc sort data=work._${num}_stv; by ps; run;`,
    ``,
    `data work._${num}_sta;`,
    `  set work._${num}_stv;`,
    `  retain n_below 0;`,
    `  /* share of subjects STRICTLY below this score decides the stratum */`,
    `  stratum = min(${K}, floor(n_below * ${K} / &_n_all.) + 1);`,
    `  output;`,
    `  n_below = n_below + n_ps;`,
    `  keep ps n_ps stratum;`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_sts as`,
    `  select a.stratum,`,
    `         count(*) as n_stratum,`,
    `         sum(s.treated) as n_treated,`,
    `         count(*) - sum(s.treated) as n_control,`,
    `         sum(ifn(s.treated = 1, s.${y}, 0)) as y_treated,`,
    `         sum(ifn(s.treated = 0, s.${y}, 0)) as y_control`,
    `  from ${subjT} as s inner join work._${num}_sta as a on a.ps = s.ps`,
    `  group by a.stratum;`,
    `quit;`,
    ``,
    `data work._${num}_stm;`,
    `  set work._${num}_sts;`,
    `  /* MISSING, not zero: a one-arm stratum has no contrast, and zero is a`,
    `     real effect estimate that would be pooled as though measured */`,
    `  if n_treated > 0 and n_control > 0`,
    `    then diff = y_treated / n_treated - y_control / n_control;`,
    `    else diff = .;`,
    `  one_arm_only = (n_treated = 0 or n_control = 0);`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_stp as`,
    `  select sum(ifn(diff ne ., n_stratum, 0)) as n_pooled,`,
    `         sum(ifn(diff = ., n_stratum, 0)) as n_dropped,`,
    `         sum(ifn(diff ne ., diff * n_stratum, 0)) as num,`,
    `         count(*) as strata_formed,`,
    `         sum(one_arm_only) as strata_one_arm`,
    `  from work._${num}_stm;`,
    `quit;`,
    ``,
  ];
}
