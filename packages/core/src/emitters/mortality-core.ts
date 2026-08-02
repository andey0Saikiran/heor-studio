/**
 * mortality-core — the ascertainment scaffolding an EXTERNAL MORTALITY LINKAGE
 * needs before a survival curve drawn on it can be honest.
 *
 * DSTATUS stays refused, permanently, for the reason MORTALITY_REFUSAL gives.
 * This file is about the other arm: a declared linkage to the SSA Master Death
 * File, the NDI, or Merative's own MarketScan Mortality Detail file. That
 * question IS answerable, and a substantial published literature answers it.
 *
 * THE HAZARD MOVES RATHER THAN DISAPPEARING, and two things follow that are
 * STRUCTURAL here rather than advisory:
 *
 * 1. THE LINKED SUBSET IS A SUBSET. Linkage is never complete — one published
 *    HCC study reports survival for 758 of 1459 members — so the program emits
 *    an ATTRITION ROW saying mortality was ascertained in N of M. A curve whose
 *    denominator nobody can see is a curve nobody can check.
 *
 * 2. THE RISK SET IS THE LINKED SUBSET ONLY. A member outside the linkage
 *    CANNOT BE OBSERVED TO DIE. Leaving them in the risk set makes them
 *    immortal by construction: they contribute person-time and never an event,
 *    so survival is biased UPWARD — the same destination as the DSTATUS bias,
 *    reached by a different route. So the program restricts, and SAYS it
 *    restricted, in a row that travels with the numbers.
 *
 * 3. ASCERTAINMENT HAS A DATE. Deaths are complete only through
 *    `ascertainedThrough`; beyond it a death would not appear even if it
 *    happened. Follow-up past that date is ADMINISTRATIVE CENSORING, and a
 *    study that runs past its own ascertainment date silently reports its tail
 *    as survival. The date is folded into the administrative censor in both
 *    twins and named in the emitted method text.
 *
 * WHAT THIS FILE DOES NOT DO. It does not validate the linkage. Whether the
 * site's match rate is 60% or 95%, whether it matched on SSN or on a
 * probabilistic key, and whether the unlinked complement differs from the
 * linked subset in ways that matter are all questions about the DELIVERY, and
 * no amount of arithmetic here can answer them. The vintage label is stamped so
 * that at least the version of the linkage travels with the result: linkages
 * are revised and re-released, and two runs a year apart can produce different
 * curves from identical claims.
 */
import type { MortalityLinkage } from "../spec/types";

/**
 * Encodings treated as "this member IS in the linked set".
 *
 * Deliveries encode the flag as 1, 'Y' or a real boolean, so all three are
 * accepted. An encoding NOT on this list yields ZERO linked members — which is
 * loud rather than silent, because the attrition row then reads "ascertained in
 * 0 of M" and no curve can be drawn at all. That is the intended failure mode:
 * a flag this program cannot read must not quietly become "nobody died".
 */
export const LINKED_TRUE_VALUES = ["1", "Y", "y", "T", "t", "true", "TRUE", "True"];

/** The linked-flag predicate, per language. Written once so the two twins
 *  cannot disagree about which members the linkage covers — a disagreement
 *  there moves the denominator of every survival probability. */
export function linkedFlagSql(alias: string, col: string): string {
  return `CAST(${alias}.${col} AS VARCHAR) IN (${LINKED_TRUE_VALUES.map((v) => `'${v}'`).join(", ")})`;
}

export function linkedFlagSas(alias: string, col: string): string {
  return `strip(vvalue(${alias}.${col})) in (${LINKED_TRUE_VALUES.map((v) => `'${v}'`).join(", ")})`;
}

/** Method text for the attrition row, built from the declared linkage so the
 *  vintage and the ascertainment date travel WITH the number rather than
 *  sitting in a stamp nobody reads. */
export function linkageAttritionMethod(lk: MortalityLinkage): string {
  return (
    `LINKED SUBSET. Mortality is ascertained only for members the linkage covers (${lk.vintageLabel}, ` +
    `flagged by ${lk.linkedFlagColumn} in ${lk.tableHandle}). Linkage is never complete - one published HCC study ` +
    `reports survival for 758 of 1459 members - so read this beside every survival probability below`
  );
}

export function linkageRestrictionMethod(lk: MortalityLinkage): string {
  return (
    `THE RISK SET IS THE LINKED SUBSET ONLY, and that is not a convenience. A member outside the linkage ` +
    `CANNOT BE OBSERVED TO DIE, so including them would make them immortal by construction: person-time with no ` +
    `possible event, and survival biased UPWARD - the same destination as the DSTATUS bias by a different route. ` +
    `These members are excluded from the denominator, not censored inside it. Whether the linked subset resembles ` +
    `the unlinked complement is a question about the delivery (${lk.vintageLabel}) that no arithmetic here can answer`
  );
}

export function linkageAscertainmentMethod(lk: MortalityLinkage): string {
  return (
    `ADMINISTRATIVE CENSORING AT THE ASCERTAINMENT DATE ${lk.ascertainedThrough}. Beyond it a death would not appear ` +
    `in ${lk.tableHandle} even if it happened, so follow-up past that date is not evidence of survival. A study that ` +
    `runs past its own ascertainment date reports its whole tail as survival and nothing in the output says so`
  );
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

/**
 * `cohort` -> `mlink` -> `mcov` -> `mattr` -> `atrisk` / `first_fu`.
 *
 * Deliberately the SAME output CTE names rate-core produces (`atrisk`,
 * `first_fu`), so the survival module's downstream chain is byte-identical
 * whichever endpoint it was given. A second downstream would be a second place
 * for the two endpoint kinds to drift apart.
 */
export function mortalityLinkageSqlCtes(
  i: { lk: MortalityLinkage; cohortT: string },
): string[] {
  const lk = i.lk;
  const L: string[] = [];
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${i.cohortT}),`);
  L.push(`mlink AS (   -- the site's linked mortality table, ${lk.vintageLabel}`);
  L.push(`  SELECT enrolid, ${lk.deathDateColumn} AS death_date, ${lk.linkedFlagColumn} AS linked_flag`);
  L.push(`  FROM ${lk.tableHandle}`);
  L.push(`),`);
  L.push(`mcov AS (   -- THE LINKED SUBSET: members the linkage COVERS, dead or alive`);
  L.push(`  -- ${lk.linkedFlagColumn} is what separates "did not die" from "could not be`);
  L.push(`  -- observed to die". Without it those two are the same row.`);
  L.push(`  SELECT c.enrolid, c.index_date, m.death_date`);
  L.push(`  FROM cohort c`);
  L.push(`  JOIN mlink m ON m.enrolid = c.enrolid`);
  L.push(`  WHERE ${linkedFlagSql("m", "linked_flag")}`);
  L.push(`),`);
  L.push(`mattr AS (   -- ascertained in N of M. Emitted beside the curve, never instead of it.`);
  L.push(`  SELECT COUNT(*) AS n_cohort,`);
  L.push(`         SUM(CASE WHEN k.enrolid IS NOT NULL THEN 1 ELSE 0 END) AS n_linked,`);
  L.push(`         SUM(CASE WHEN k.enrolid IS NULL THEN 1 ELSE 0 END) AS n_unlinked,`);
  L.push(`         SUM(CASE WHEN k.death_date IS NOT NULL`);
  L.push(`                   AND k.death_date <= DATE '${lk.ascertainedThrough}' THEN 1 ELSE 0 END) AS n_deaths,`);
  L.push(`         SUM(CASE WHEN k.death_date IS NOT NULL`);
  L.push(`                   AND k.death_date >  DATE '${lk.ascertainedThrough}' THEN 1 ELSE 0 END) AS n_after_ascert`);
  L.push(`  FROM cohort c LEFT JOIN mcov k ON k.enrolid = c.enrolid`);
  L.push(`),`);
  L.push(`atrisk AS (   -- THE RISK SET IS THE LINKED SUBSET. Unlinked members are EXCLUDED,`);
  L.push(`  -- not censored: a member who cannot be observed to die is immortal by`);
  L.push(`  -- construction, and immortal members bias survival upward.`);
  L.push(`  SELECT enrolid, index_date FROM mcov`);
  L.push(`),`);
  L.push(`first_fu AS (   -- date of death, from the linkage`);
  L.push(`  SELECT enrolid, death_date AS fu_date FROM mcov WHERE death_date IS NOT NULL`);
  L.push(`),`);
  return L;
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

/** The same chain as PROC SQL steps, producing `work._<num>_atrisk`,
 *  `work._<num>_first_fu` and `work._<num>_mattr`. */
export function mortalityLinkageSasSteps(
  o: { lk: MortalityLinkage; num: string; cohT: string },
): string[] {
  const lk = o.lk;
  const n = o.num;
  return [
    `/*----------------------------------------------------------------------------`,
    `  EXTERNAL MORTALITY LINKAGE (${lk.vintageLabel}).`,
    `  The linked table is a SITE asset: point the libref at it in 00_setup.`,
    `  ${lk.linkedFlagColumn} is what separates "did not die" from "could not be observed`,
    `  to die". The risk set below is the LINKED SUBSET ONLY - a member outside the`,
    `  linkage is immortal by construction, and immortal members bias survival up.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${n}_mcov as`,
    `  select a.enrolid, a.index_date, m.${lk.deathDateColumn} as death_date format=date9.`,
    `  from ${o.cohT} as a`,
    `  inner join ${lk.tableHandle} as m`,
    `    on m.enrolid = a.enrolid`,
    `  where ${linkedFlagSas("m", lk.linkedFlagColumn)};`,
    ``,
    `  /* ascertained in N of M - emitted beside the curve, never instead of it */`,
    `  create table work._${n}_mattr as`,
    `  select count(*) as n_cohort,`,
    `         sum(k.enrolid ne .) as n_linked,`,
    `         sum(k.enrolid = .) as n_unlinked,`,
    `         sum(k.death_date ne . and k.death_date <= ${sasDate(lk.ascertainedThrough)}) as n_deaths,`,
    `         sum(k.death_date ne . and k.death_date >  ${sasDate(lk.ascertainedThrough)}) as n_after_ascert`,
    `  from ${o.cohT} as a`,
    `  left join work._${n}_mcov as k on k.enrolid = a.enrolid;`,
    ``,
    `  /* THE RISK SET: the linked subset. Unlinked members are EXCLUDED, not`,
    `     censored inside the denominator. */`,
    `  create table work._${n}_atrisk as`,
    `  select * from work._${n}_mcov;`,
    ``,
    `  create table work._${n}_first_fu as`,
    `  select enrolid, death_date as fu_date format=date9.`,
    `  from work._${n}_mcov where death_date ne .;`,
    `quit;`,
  ];
}

const SAS_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** ISO date -> SAS date literal. Local rather than imported so this file has no
 *  dependency on the SAS emitter's context object. */
export function sasDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `'${d}${SAS_MONTHS[Number(m) - 1]}${y}'d`;
}
