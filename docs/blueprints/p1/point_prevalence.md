# point_prevalence module blueprint

Module for `PointPrevalenceAnalysis` (`kind: "point_prevalence"`), built to the exact
shape of the reference module `src/emitters/modules/incidence.ts`: twin `sql()`/`sas()`
generators, one shared PARITY stamp built from consumed values, visible REVIEW
limitations in both languages, shared stratum labels from `emitters/parity.ts`, and
hand-computed gold truth pinned in `verify/fixture.ts` + `verify/run.ts`.

---

## 1. Method — precise definition + literature refs

**Point prevalence** at anchor time *t* is the proportion of the population at risk
that is a case at *t*:

```
prevalence(t) = (cases at t) / (population under observation at t)
```

Ref: Rothman, Greenland & Lash, *Modern Epidemiology*, 3rd ed. (2008), ch. 3
("Measures of Occurrence", point-prevalence definition and the prevalence-pool
construction, pp. 45–47). The spec's own doc comment on `DenominatorRule`
(`"enrolled_midperiod"` — "point prevalence: enrolled & alive on the anchor date")
and `docs/DOMAIN-RULES.md` §3 ("Prevalence: incident patients **are included** in the
denominator; population at risk is normally the entire analysed population") pin the
HEOR operationalization.

### Claims operationalization (what this module actually computes)

**Denominator — COHORT-based, "enrolled on the anchor date"** (decision + justification):

- Denominator = members of the **final analysis cohort** (`{wp}_cohort` /
  `ctx.finalCohort`) whose **stitched enrollment episode covers the anchor date**
  (`episode_start <= anchor <= episode_end` on `{wp}_enroll_episodes` / `050_epi`).
- *Why cohort-based, not whole-enrollment-based:* (a) DOMAIN-RULES §3 defines the
  denominator as "the entire **analysed** population" — in HEOR Studio the analysed
  population **is** the spine cohort; every other module (incidence) works on
  `{wp}_cohort`, and the review UI presents analyses as cohort deliverables.
  (b) Whole-enrollment (all MarketScan members) is **structurally impossible from the
  spine**: the SAS enrollment pull (`040_enroll_pull.sas`) inner-joins enrollment
  detail to the index table, so no work table on either side contains non-indexed
  members; emitting a population denominator would require a new raw pull the module
  contract forbids. The cohort basis is stated loudly as a standing REVIEW note in
  both twins (§6) so nobody mistakes this for population prevalence.
- *"alive on the anchor date"*: mortality is unascertainable in core MarketScan
  (BR-LIM-002; DSTATUS masked from 2016, in-hospital only). Enrollment on the anchor
  date is the operational proxy for "alive & under observation" — stated as a standing
  method note in both twins.
- **`anchorDate` kind changes the denominator as follows:**
  - `{ kind: "fixed", date: D }` — one calendar date for everyone; denominator =
    cohort members whose stitched episode covers `D`. Cohort members indexed after
    `D` remain in the denominator if enrolled on `D` (they are analysed-population
    members under observation at `t`); this is stated in the generated header.
  - `{ kind: "index" }` — each subject's own index date; the enrollment-episode
    join keeps everyone whose episode covers their index date. When the spec carries
    a continuous-enrollment criterion (the normal case) this is the **whole cohort**
    by construction, so point prevalence at index = the cohort's **baseline
    prevalence** of the outcome. The episode join is still emitted (belt +
    suspenders): in a spec without a CE criterion, a member indexed on a claim that
    falls in a coverage gap is correctly excluded from an "enrolled on anchor"
    denominator.

**Numerator — "case on date D"** (decision + justification):

- A denominator member is a **prevalent case on the anchor date** iff they have
  **>= 1 qualifying event (outcomeDefinition.codeListId) with event date on-or-BEFORE
  their anchor date** — an *ever/all-available-lookback* definition, bounded in
  practice by `{wp}_events`' study-period filter (02_events keeps only
  `studyPeriod.start <= event_date <= studyPeriod.end`).
- *Why ever-before rather than a bounded "active disease" lookback:*
  `PointPrevalenceAnalysis` has **no lookback field** (the COVERAGE-MATRIX row lists
  `activeLookbackWindow` as a *future* spec field; it was not shipped in
  `spec/types.ts`). Fabricating a 12-month default would violate the "never a
  fabricated default" rule; silently using one would violate honest labeling. The
  chosen rule matches DOMAIN-RULES §3/§4 practice, where prevalent status is "had
  the condition on or before the reference point within available data". The exact
  rule actually computed is stamped in the parity record
  (`caseRule: "ever_on_or_before_anchor"`) and printed in the generated header, so
  the analyst sees precisely what "case" means. The on-or-**before** boundary is
  inclusive of the anchor date itself (an event ON D counts) — the gold fixture pins
  this boundary (§7, P03).
- The numerator is computed **within the denominator** (a case not enrolled on D does
  not count), which enforces the `numerator <= denominator` invariant by
  construction.

**Interval estimate — Wilson score interval** (the method actually computed, both
twins, closed form, z = 1.96):

```
low  = max(0, (k + z²/2 − z·sqrt(k(n−k)/n + z²/4)) / (n + z²))
high = min(1, (k + z²/2 + z·sqrt(k(n−k)/n + z²/4)) / (n + z²))
```

Refs: Wilson E.B., *JASA* 1927;22(158):209–212 (the score interval);
Newcombe R.G., *Stat Med* 1998;17(8):857–872 (seven-method comparison — Wilson
recommended over Wald, Table II/III); Brown, Cai & DasGupta, *Statistical Science*
2001;16(2):101–133 (Wald coverage collapse; Wilson/score recommended for small n).
Clopper & Pearson, *Biometrika* 1934;26:404–413 is the exact alternative — it needs a
beta-inverse, which stock Postgres/PGlite lacks (COVERAGE-MATRIX: "Clopper-Pearson
(beta inverse) defers"), so it is **SAS-only** and handled by the honest-labeling
rule: when requested, the twins still compute Wilson, **label the column `wilson`**,
and emit a loud REVIEW note (§6). The closed form's algebraic edge behavior at
`k = 0` (low = 0 exactly) and `k = n` (high = 1 exactly) is exercised by the gold
strata (§7); `max(0,·)`/`min(1,·)` clamps are mathematically inert and exist only to
kill floating-point dust at those boundaries (applied identically in both twins).

**No person-time is consumed.** Point prevalence is a pure proportion:
`spec.meta.daysPerYear` / `renderDaysPerYear` is *not consumed*, *not stamped*, and no
365-flavored constant appears anywhere in either twin (rule 7 honored by having zero
person-time arithmetic to configure).

---

## 2. Spec consumption — the analysis interface verbatim + field-by-field mapping

From `src/spec/types.ts` (verbatim):

```ts
export interface PointPrevalenceAnalysis extends AnalysisCommon {
  kind: "point_prevalence";
  outcomeDefinition: OutcomeDefinition;
  caseStatus: "prevalent";
  anchorDate: AnchorDate;
  denominatorRule: "enrolled_midperiod";
  ciMethod: ProportionCiMethod;
  stratifyBy: Stratifier[];
  referenceStratum?: string;
}
```

with the referenced supporting types (verbatim):

```ts
export interface OutcomeDefinition {
  codeListId: string;         // -> CodeList.id (may be an empty list awaiting lookup)
  minClaims: number;          // >= 1 qualifying claims to count as a case
  claimSeparationDays?: number; // required when minClaims >= 2
  setting: CareSetting;
  diagnosisPosition: "any" | "primary"; // DX1/principal vs any DXn
}

export type AnchorDate =
  | { kind: "fixed"; date: string } // ISO date, e.g. "2022-07-01"
  | { kind: "index" };              // each subject's own index date (day 0)

export type ProportionCiMethod = "wilson" | "clopper_pearson" | "wald";

export interface Stratifier {
  id: string;
  label: string;
  source:
    | { kind: "baseline"; baselineId: string }
    | { kind: "demographic"; axis: "age_band" | "sex" | "region" | "plan_type" | "year" };
  ageBandLowerBounds?: number[]; // inclusive lower bounds, e.g. [0,18,45,65,75]
}
```

Field-by-field mapping:

| Spec field | Consumption |
|---|---|
| `id`, `label`, `notes` (AnalysisCommon) | file titles/headers, PARITY `id`, `suffix` disambiguation; `notes` rendered verbatim in the header extra lines |
| `enabled` | registry-level gate (module never sees disabled analyses) |
| `outcomeDefinition.codeListId` | numerator event source: `{wp}_events WHERE code_list_id = clid` (SQL) / `ctx.evOf(clid)` (SAS); stamped |
| `outcomeDefinition.minClaims` | **implemented for `minClaims = 1` only**; `> 1` → REVIEW limitation (identical policy to the reference module) |
| `outcomeDefinition.claimSeparationDays` | not consumed (only meaningful with `minClaims >= 2`, which is a limitation) |
| `outcomeDefinition.setting` | **not applied** when != "any" → REVIEW limitation (reference-module policy) |
| `outcomeDefinition.diagnosisPosition` | **not applied** when "primary" → REVIEW limitation (the spine events table carries no dx-position column) |
| `caseStatus` | fixed `"prevalent"` by the type; documented in the header (no branching) |
| `anchorDate` | `kind:"fixed"` → SQL `DATE '<date>'` / SAS `'ddMONyyyy'd` literal; `kind:"index"` → per-row `index_date`. Materialized as an `anchor_date` column so numerator/demographics/strata share ONE expression; stamped as `{kind, date|null}` |
| `denominatorRule` | fixed `"enrolled_midperiod"` by the type; operationalized as the cohort × episode-covers-anchor join; the basis actually computed is stamped (`denominator: "cohort_enrolled_on_anchor"`) |
| `ciMethod` | `"wilson"` → computed; `"clopper_pearson"` / `"wald"` → **Wilson still computed and labeled `wilson`** + REVIEW limitation (honest labeling) |
| `stratifyBy` | `splitStratifiers()` — demographic axes emitted with the shared `SEX_LABELS` / `REGION_LABELS` / `ageBandLabels` / `stratLabel` machinery; baseline-sourced stratifiers → REVIEW limitation (reference-module policy). Age and calendar-year strata are computed **at the anchor date** (`year(anchor_date) − dobyr`; `year(anchor_date)`), from the enrollment segment in force at (or latest before) the anchor date with the reference module's exact tie-break (`ORDER BY dtstart DESC, dtend DESC` / `by enrolid descending seg_start descending seg_end; if first.enrolid`) |
| `referenceStratum` | **not consumed** (no prevalence-ratio column in V1) → REVIEW limitation when set |

---

## 3. SQL twin — the COMPLETE CTE chain

Postgres-16/PGlite-executable; Snowflake portability exclusively through the Dialect
helpers actually used: `d.createTableAs`, `d.year`, `d.roundN`. (`d.offset` /
`d.daysBetween` / `windowConds` are genuinely unused — there is no relative window and
no person-time in this measure.) Placeholders: `${wp}` work prefix, `${clid}` =
`an.outcomeDefinition.codeListId` through `q()`, `${out}` = `${wp}_pointprev${suffix}`,
`${anchorSql}` = `DATE '<an.anchorDate.date>'` (fixed) or `c.index_date` (index),
`${studyStart}/${studyEnd}` from `spec.meta.studyPeriod`. Reads ONLY the spine work
tables: `${wp}_cohort` (build05: `enrolid, index_date, index_code`), `${wp}_events`
(build02: `enrolid, event_date, event_type, setting, code_list_id, code`),
`${wp}_enroll_episodes` (build04: `enrolid, episode_id, episode_start, episode_end,
n_segments`), plus raw enrollment via `ctx.t("enrollment_detail")` for stratum
demographics (same source and tie-break as the reference module). Stratum CASE
expressions (`stratExpr`) are the reference module's verbatim, except the age/year
inputs are `anchor_date` instead of `index_date`.

```sql
-- PARITY point_prevalence {"anchor":{"date":"2019-07-20","kind":"fixed"},"caseRule":"ever_on_or_before_anchor","ciMethod":"wilson","codeListId":"ae_dx","denominator":"cohort_enrolled_on_anchor","id":"a_pp_main","strata":[...]}
-- REVIEW - spec options this program does not implement yet:
--   * <pointPrevalenceLimitations(an) lines, when any>
-- REVIEW - method notes (always emitted):
--   * denominator is COHORT-based (final analysis cohort enrolled on the anchor
--     date), not a population denominator - MarketScan carries no general-
--     population denominator and the spine pulls enrollment for indexed members only
--   * "alive on the anchor date" is proxied by enrollment on the anchor date;
--     mortality is unascertainable in core MarketScan (BR-LIM-002)
--   * case = >= 1 qualifying event on-or-BEFORE the anchor date within the study
--     period (all-available lookback; the spec has no activeLookbackWindow field)
DROP TABLE IF EXISTS ${out};
CREATE TABLE ${out} AS                              -- d.createTableAs(out)
WITH cohort AS (SELECT enrolid, index_date FROM ${wp}_cohort),
ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${clid}'),
den AS (   -- denominator: cohort members whose stitched episode covers the anchor
           -- date. Episodes are disjoint by construction (stitching merges any
           -- overlap/within-gap segments), so this join is at most 1:1.
  SELECT c.enrolid, c.index_date, ${anchorSql} AS anchor_date
  FROM cohort c
  JOIN ${wp}_enroll_episodes ep
    ON ep.enrolid = c.enrolid
   AND ${anchorSql} BETWEEN ep.episode_start AND ep.episode_end
),
cases AS (   -- prevalent case: >= 1 qualifying event on-or-BEFORE the anchor date
  SELECT DISTINCT d.enrolid
  FROM den d
  JOIN ae e ON e.enrolid = d.enrolid AND e.event_date <= d.anchor_date
),
-- [only when needDemo := strata.some(s => s.axis !== "year")]
demo AS (   -- enrollment segment in force at (or latest before) the ANCHOR date;
            -- rn=1 wins - the SAME source and tie-break as the reference module
  SELECT d.enrolid, en.dobyr, en.sex, en.region, en.plantyp,
         ROW_NUMBER() OVER (PARTITION BY d.enrolid
                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn
  FROM den d
  JOIN ${ctx.t("enrollment_detail")} en
    ON en.enrolid = d.enrolid
   AND en.dtstart <= d.anchor_date
),
demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),
-- [end needDemo]
pp AS (
  SELECT d.enrolid, d.anchor_date,
         CASE WHEN cs.enrolid IS NOT NULL THEN 1 ELSE 0 END AS is_case
         -- [, dm.dobyr, dm.sex, dm.region, dm.plantyp  when needDemo]
  FROM den d
  LEFT JOIN cases cs ON cs.enrolid = d.enrolid
  -- [LEFT JOIN demo1 dm ON dm.enrolid = d.enrolid  when needDemo]
),
pp2 AS (
  SELECT is_case
         -- one line per stratifier i, stratExpr with:
         --   ageExpr := CAST(EXTRACT(YEAR FROM anchor_date) AS INT) - dobyr   (d.year)
         --   year    := CAST(CAST(EXTRACT(YEAR FROM anchor_date) AS INT) AS VARCHAR)
         --   sex/region/plan_type: reference-module CASE over SEX_LABELS/REGION_LABELS
         -- , ${stratExpr(s)} AS strat_i
  FROM pp
),
summ AS (
  SELECT 'point_prevalence' AS measure, 'Overall' AS stratifier, 'Overall' AS stratum,
         COALESCE(SUM(is_case), 0) AS patients, COUNT(*) AS denominator
  FROM pp2
  -- per stratifier i:
  -- UNION ALL
  -- SELECT 'point_prevalence', '${q(stratLabel(s.label))}', strat_i,
  --        COALESCE(SUM(is_case), 0), COUNT(*)
  -- FROM pp2 GROUP BY strat_i
)
SELECT measure, stratifier, stratum, patients, denominator,
       ROUND(CAST(patients * 1.0 / NULLIF(denominator, 0) AS NUMERIC), 5)  AS prevalence,      -- d.roundN(...,5)
       ROUND(CAST(patients * 100.0 / NULLIF(denominator, 0) AS NUMERIC), 2) AS prevalence_pct, -- d.roundN(...,2)
       CASE WHEN denominator = 0 THEN NULL ELSE
         ROUND(CAST(GREATEST(0.0,
           (patients + 1.9208 - 1.96*SQRT(1.0*patients*(denominator-patients)/NULLIF(denominator,0) + 0.9604))
           / (denominator + 3.8416)) AS NUMERIC), 5) END AS ci_low,
       CASE WHEN denominator = 0 THEN NULL ELSE
         ROUND(CAST(LEAST(1.0,
           (patients + 1.9208 + 1.96*SQRT(1.0*patients*(denominator-patients)/NULLIF(denominator,0) + 0.9604))
           / (denominator + 3.8416)) AS NUMERIC), 5) END AS ci_high,
       -- labeled with the method actually computed (Wilson), never the merely-
       -- requested one - a mislabeled statistic is worse than a substituted one
       'wilson' AS ci_method
FROM summ;

-- REVIEW: point prevalence on the anchor date, Overall + per stratum.
SELECT * FROM ${out}
ORDER BY stratifier, stratum;
```

Arithmetic notes (the twin contract):

- z = 1.96 and its derived constants are written as the **decimal literals**
  `1.9208` (z²/2), `3.8416` (z²), `0.9604` (z²/4) in BOTH twins — identical
  arithmetic, and the harness's arithmetic signatures (§10) grep for these exact
  literals.
- Every division carries a decimal factor (`* 1.0`, `* 100.0`) or a decimal
  operand so Postgres never integer-divides — the exact bug class the repo's
  `corrections/2026-07-24-incidence-integer-division.md` memo documents.
- `COALESCE(SUM(is_case), 0)`: an ungrouped aggregate over an empty `pp2` yields one
  row with `COUNT(*) = 0` and `SUM = NULL`; COALESCE pins `patients = 0` (the SAS
  twin applies the mirror fix, §4/§8).

`SqlModuleFile` return: `slug: "pointprev" + suffix`, title
`"NN Point prevalence"`, subtitle `"point prevalence on the anchor date + Wilson CI"`,
extra: analysis id/label + outcome code list line (reference-module format).

---

## 4. SAS twin — the COMPLETE program mirroring the SQL arithmetic

Reads only the spine equivalents: `ctx.finalCohort` (enrolid, index_date, …),
`ctx.evOf(clid)` (enrolid, svcdate, setting, …), `ctx.tbl("050_epi")` (enrolid,
episode, dtstart, dtend), `ctx.tbl("040_enroll")` (enrolid, dtstart, dtend, rx,
plantyp, sex, region, dobyr). `${anchorSas}` = `'20JUL2019'd` (fixed, via the
emitter's `sasDate()` convention) or `a.index_date` (index). `${outT}` =
`ctx.tbl(`${num}_pointprev${suffix}`)`. Stratum assignment blocks are the reference
module's `stratAssign` verbatim, except `age_at_anchor = year(anchor_date) - dobyr`
and the year stratum uses `year(anchor_date)`.

```sas
/* header(spec, "${num}_pointprev${suffix}.sas", [
     Point prevalence on the anchor date for "<label>":
     denominator = final-cohort members enrolled (stitched episode) on the
     anchor date; numerator = members with >= 1 qualifying outcome event
     on-or-before the anchor date; Wilson 95% CI (closed form).
     Twin of the machine-verified SQL NN_pointprev; keep both in sync. ]) */
/* PARITY point_prevalence {...same stableJson as the SQL twin...} */

/* REVIEW - spec options this program does not implement yet:
   * <pointPrevalenceLimitations(an) lines, when any>
*/
/* REVIEW - method notes (always emitted):
   * denominator is COHORT-based (final analysis cohort enrolled on the anchor
     date), not a population denominator
   * "alive on the anchor date" proxied by enrollment on the anchor date
     (mortality unascertainable in core MarketScan - BR-LIM-002)
   * case = >= 1 qualifying event on-or-BEFORE the anchor date (all-available
     lookback; the spec has no activeLookbackWindow field)
*/

%include "00_setup.sas";   /* EDIT: use the full site path to 00_setup.sas */

proc datasets lib=tz nolist nowarn;
  delete <outT-member>;
quit;

/*-------------------- denominator: enrolled on the anchor date --------------*/
proc sql;
  create table work._${num}_den as
  select a.enrolid, a.index_date,
         ${anchorSas} as anchor_date format=date9.
  from ${cohT} as a
  inner join ${epiT} as ep
    on  ep.enrolid = a.enrolid
    and ${anchorSas} between ep.dtstart and ep.dtend;
quit;

/* levelCheck(work._${num}_den, "denominator: enrolled on anchor date") */

/*-------------------- prevalent cases on the anchor date --------------------*/
proc sql;
  create table work._${num}_cases as
  select distinct a.enrolid
  from work._${num}_den as a
  inner join ${evT} as e
    on  e.enrolid = a.enrolid
    and e.svcdate <= a.anchor_date;   /* on-or-BEFORE: an event ON the anchor counts */
quit;

/*---- [needDemo only] stratum demographics at the ANCHOR date ---------------*/
/* enrollment segment in force at (or latest before) the anchor date - the
   SAME source and tie-break as the SQL twin, so stratum values cannot drift. */
proc sql;
  create table work._${num}_dm0 as
  select a.enrolid, b.dobyr, b.sex, b.region, b.plantyp,
         b.dtstart as seg_start, b.dtend as seg_end
  from work._${num}_den as a
  left join ${ctx.tbl("040_enroll")} as b
    on  b.enrolid = a.enrolid
    and b.dtstart <= a.anchor_date;
quit;

proc sort data=work._${num}_dm0;
  by enrolid descending seg_start descending seg_end;
run;

data work._${num}_dm;
  set work._${num}_dm0;
  by enrolid;
  if first.enrolid;
  drop seg_start seg_end;
run;
/*---- [end needDemo] --------------------------------------------------------*/

/*-------------------- per-member case flag + strata -------------------------*/
proc sql;
  create table work._${num}_pp as
  select a.enrolid, a.anchor_date,
         case when b.enrolid is not null then 1 else 0 end as is_case
         /* [, dm.dobyr, dm.sex, dm.region, dm.plantyp  when needDemo] */
  from work._${num}_den as a
  left join work._${num}_cases as b
    on b.enrolid = a.enrolid
  /* [left join work._${num}_dm as dm on dm.enrolid = a.enrolid  when needDemo] */;
quit;

data work._${num}_pp2;
  set work._${num}_pp;
  /* [when strata] length strat_0 ... $40; */
  /* [when age_band strata] enrollment-derived age at the ANCHOR date,
     matching the SQL twin: */
  age_at_anchor = year(anchor_date) - dobyr;
  /* per stratifier j: reference-module stratAssign(s, strat_j), with
     age_at_anchor in place of age_at_index and
     strip(put(year(anchor_date), 4.)) for the year axis */
run;

/* levelCheck(work._${num}_pp2, "denominator members", [sum(is_case) as cases]) */

/*----------------------------------------------------------------------------
  Point prevalence + Wilson 95% CI - the SAME closed form as the SQL twin
  (Wilson JASA 1927;22:209; z = 1.96, z^2 = 3.8416), so both languages agree
  to the last rounded digit:
    low  = max(0, (k + 1.9208 - 1.96*sqrt(k(n-k)/n + 0.9604)) / (n + 3.8416))
    high = min(1, (k + 1.9208 + 1.96*sqrt(k(n-k)/n + 0.9604)) / (n + 3.8416))
  (low = 0 exactly when k = 0; high = 1 exactly when k = n.)
----------------------------------------------------------------------------*/
proc sql;
  create table work._${num}_summ as
  select 'Overall' as stratifier length=40,
         'Overall' as stratum length=40,
         count(*) as denominator,
         sum(is_case) as patients
  from work._${num}_pp2
  /* per stratifier j:
  union all
  select '<sq(stratLabel(s.label))>', strat_j,
         count(*), sum(is_case)
  from work._${num}_pp2 group by strat_j
  */
  ;
quit;

data ${outT};
  set work._${num}_summ;
  length measure $20 ci_method $16;
  measure   = 'point_prevalence';
  /* labeled with the method actually computed, never the merely-requested one */
  ci_method = 'wilson';
  /* ungrouped SQL aggregate over an empty table gives count 0 / sum missing -
     pin patients = 0 to match the SQL twin's COALESCE */
  if patients = . then patients = 0;
  if denominator > 0 then do;
    prevalence     = round(patients / denominator, 0.00001);
    prevalence_pct = round(100 * patients / denominator, 0.01);
    _rad   = 1.96 * sqrt( (patients * (denominator - patients)) / denominator + 0.9604 );
    ci_low  = round(max(0, (patients + 1.9208 - _rad) / (denominator + 3.8416)), 0.00001);
    ci_high = round(min(1, (patients + 1.9208 + _rad) / (denominator + 3.8416)), 0.00001);
  end;
  else do;
    prevalence = .; prevalence_pct = .; ci_low = .; ci_high = .;
  end;
  drop _rad;
run;

/* same presentation order as the SQL twin's REVIEW query */
proc sort data=${outT};
  by stratifier stratum;
run;

title "Point prevalence on the anchor date: <label>";
proc print data=${outT} noobs;
  var measure stratifier stratum patients denominator prevalence prevalence_pct
      ci_low ci_high ci_method;
run;
```

If the analyst genuinely needs Clopper-Pearson, the limitation note (§6) names the
manual escape hatch (`PROC FREQ ... / BINOMIAL(CL=CLOPPERPEARSON)`) as a comment —
it is **never** wired into the output table, because the SQL twin cannot reproduce
it and the twins must publish identical numbers.

Rounding parity: Postgres `ROUND(numeric)` and SAS `round()` both round half away
from zero — the twins agree at rounding boundaries.

---

## 5. Parity record — exact stamped fields

Added to `emitters/parity.ts` (reference-module style — built from values the
builder CONSUMED, not from the spec object):

```ts
/** The parameter set a point-prevalence twin must consume identically. */
export interface PointPrevalenceParity {
  id: string;
  codeListId: string;
  /** the anchor actually rendered: fixed date literal, or per-subject index */
  anchor: { kind: "fixed" | "index"; date: string | null };
  /** denominator basis actually computed (cohort-based, enrolled-on-anchor) */
  denominator: "cohort_enrolled_on_anchor";
  /** case definition actually computed */
  caseRule: "ever_on_or_before_anchor";
  ciMethod: string;   // the method actually computed ("wilson"), never the requested one
  /** strata the twin actually emitted (id/axis/bands), in spec order */
  strata: SupportedStratifier[];
}

export function pointPrevalenceParity(
  an: PointPrevalenceAnalysis,
  consumed: { strata: SupportedStratifier[] }
): PointPrevalenceParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    anchor: {
      kind: an.anchorDate.kind,
      date: an.anchorDate.kind === "fixed" ? an.anchorDate.date : null,
    },
    denominator: "cohort_enrolled_on_anchor",
    caseRule: "ever_on_or_before_anchor",
    // what the twins actually compute today (limitations make this loud)
    ciMethod: "wilson",
    strata: consumed.strata,
  };
}
```

Both twins emit `parityStamp("point_prevalence", pointPrevalenceParity(an, { strata }))`
(SQL as a `--` comment, SAS inside `/* */`), and `stableJson` guarantees byte-identical
serialization. Deliberately **absent** from the stamp: `daysPerYear` (not consumed — no
person-time), `rateMultiplier` (field does not exist on this analysis), washout/censor
fields (not part of this measure). The harness's deep-compare plus the arithmetic
signatures (§10) make a twin that drifts on any consumed value fail verification.

---

## 6. Limitations — every unimplemented option + its REVIEW wording

`pointPrevalenceLimitations(an: PointPrevalenceAnalysis): string[]` in
`emitters/parity.ts` (same shape as `incidenceLimitations`); rendered by BOTH twins
under `REVIEW - spec options this program does not implement yet:`. Conditional
notes:

| Trigger | Exact REVIEW wording |
|---|---|
| `outcomeDefinition.minClaims > 1` | `outcome minClaims=${n} is NOT yet enforced - any single qualifying claim counts as a prevalent case` |
| `outcomeDefinition.setting !== "any"` | `outcome care-setting filter "${setting}" is NOT yet applied - events from all settings count` |
| `outcomeDefinition.diagnosisPosition !== "any"` | `diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count` |
| `ciMethod === "clopper_pearson"` | `ciMethod "clopper_pearson" is NOT implemented (needs an exact beta inverse, SAS-only: proc freq ... / binomial(cl=clopperpearson)) - the Wilson score interval is produced and labeled wilson` |
| `ciMethod === "wald"` | `ciMethod "wald" is NOT implemented (poor small-sample coverage; Newcombe 1998) - the Wilson score interval is produced and labeled wilson` |
| baseline-sourced stratifier `s` (from `splitStratifiers().unsupported`) | `stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted - demographic axes only for now` |
| `referenceStratum` set | `referenceStratum "${id}" is NOT used - no prevalence-ratio column is produced in V1` |

Standing method notes (ALWAYS emitted, in both twins — not conditional, because they
describe what IS computed): cohort-based denominator; enrollment-on-anchor as the
"alive" proxy (BR-LIM-002); the ever-on-or-before-anchor case rule (no
`activeLookbackWindow` field exists in the spec). Nothing is silently ignored.

---

## 7. Fixture vectors — patient-by-patient hand derivation of every asserted number

Three gold analyses are added to `GOLD_A_SPEC.analyses` (§8 — zero data-row changes;
`multi = true` for the kind, so suffixes apply):

- `a_pp_main` — `anchorDate {kind:"fixed", date:"2019-07-20"}`, `ciMethod:"wilson"`,
  `outcomeDefinition {codeListId:"ae_dx", minClaims:1, setting:"outpatient",
  diagnosisPosition:"any"}` (setting note exercises the limitation path; all fixture
  AE events are outpatient anyway, so numbers are unaffected), `stratifyBy` = Sex /
  Age band `[0,18,35,45,55,65]` / Anchor year (the reference module's three axes) →
  table `tz_study_pointprev_a_pp_main`.
- `a_pp_idx` — `anchorDate {kind:"index"}`, `ciMethod:"wilson"`, same outcome, no
  strata → `tz_study_pointprev_a_pp_idx`.
- `a_pp_eos` — `anchorDate {kind:"fixed", date:"2020-12-31"}`,
  `ciMethod:"clopper_pearson"` (exercises honest labeling), same outcome, no strata →
  `tz_study_pointprev_a_pp_eos`.

Fixture facts used (frozen — `verify/fixture.ts`): final cohort = P01–P10 (P11 fails
CE, P12 fails age — both outside every denominator here); all index dates 2019-01-01;
stitched episodes: P01–P06, P08–P10 = 2018-01-01..2020-06-30; P07 = one stitched
episode 2018-01-01..2020-06-30 (20d gap ≤ 31 bridged); AE (`ae_dx`, E119) events:
P01 2018-06-01, P06 2018-09-01, P02 2019-04-11, P03 2019-07-20, P07 2019-10-28.

### a_pp_main — anchor D = 2019-07-20 (fixed)

Patient walk (cohort members only):

| Pt | episode covers D? | dobyr → age at D (2019−dobyr) | sex | AE event | event ≤ D? | is_case |
|---|---|---|---|---|---|---|
| P01 | 2018-01-01..2020-06-30 ✓ | 1979 → 40 | 1 Male | 2018-06-01 | ✓ | 1 |
| P02 | ✓ | 1974 → 45 | 2 Female | 2019-04-11 | ✓ | 1 |
| P03 | ✓ | 1969 → 50 | 1 Male | 2019-07-20 | **= D ✓ (on-or-before boundary)** | 1 |
| P04 | ✓ | 1964 → 55 | 2 Female | — | — | 0 |
| P05 | ✓ | 1959 → 60 | 1 Male | — | — | 0 |
| P06 | ✓ | 1974 → 45 | 1 Male | 2018-09-01 | ✓ | 1 |
| P07 | stitched ✓ (D in span2 2019-06-30..2020-06-30) | 1969 → 50 | 2 Female | 2019-10-28 | ✗ (after D) | 0 |
| P08 | ✓ | 1964 → 55 | 1 Male | — | — | 0 |
| P09 | ✓ | 1959 → 60 | 2 Female | — | — | 0 |
| P10 | ✓ | 1954 → 65 | 1 Male | — | — | 0 |

Denominator n = 10; numerator k = 4 (P01, P02, P03, P06). Age bands from
`ageBandLabels([0,18,35,45,55,65])` = 0-17, 18-34, 35-44, 45-54, 55-64, 65+.

Wilson arithmetic, z = 1.96 (z² = 3.8416, z²/2 = 1.9208, z²/4 = 0.9604), every step
shown; rounding to 5dp (prevalence, CI) and 2dp (pct):

**Overall (and Anchor year "2019"), k=4, n=10:**
p̂ = 4/10 = **0.40000** (pct **40.00**). n+z² = 13.8416; k+z²/2 = 5.9208.
k(n−k)/n = 4·6/10 = 2.4; +0.9604 = 3.3604; √3.3604 = 1.8331394; ×1.96 = 3.5929532.
low = (5.9208 − 3.5929532)/13.8416 = 2.3278468/13.8416 = 0.1681776 → **0.16818**.
high = (5.9208 + 3.5929532)/13.8416 = 9.5137532/13.8416 = 0.6873305 → **0.68733**.

**Sex / Male, k=3 (P01,P03,P06), n=6 (P01,P03,P05,P06,P08,P10):**
p̂ = **0.50000** (pct **50.00**). n+z² = 9.8416; k+z²/2 = 4.9208.
3·3/6 = 1.5; +0.9604 = 2.4604; √ = 1.5685662; ×1.96 = 3.0743898.
low = (4.9208 − 3.0743898)/9.8416 = 1.8464102/9.8416 = 0.1876128 → **0.18761**.
high = (4.9208 + 3.0743898)/9.8416 = 7.9951898/9.8416 = 0.8123872 → **0.81239**.
(Sanity: p̂ = 0.5 ⇒ Wilson symmetric: 0.18761 + 0.81239 = 1. ✓)

**Sex / Female, k=1 (P02), n=4 (P02,P04,P07,P09):**
p̂ = **0.25000** (pct **25.00**). n+z² = 7.8416; k+z²/2 = 2.9208.
1·3/4 = 0.75; +0.9604 = 1.7104; √ = 1.3078226; ×1.96 = 2.5633323.
low = (2.9208 − 2.5633323)/7.8416 = 0.3574677/7.8416 = 0.0455861 → **0.04559**.
high = (2.9208 + 2.5633323)/7.8416 = 5.4841323/7.8416 = 0.6993639 → **0.69936**.

**Age band / 35-44, k=1 (P01), n=1:**  *(k = n edge: Wilson high = 1 exactly)*
p̂ = **1.00000** (pct **100.00**). n+z² = 4.8416; k+z²/2 = 2.9208.
1·0/1 = 0; +0.9604 = 0.9604; √ = 0.98; ×1.96 = 1.9208.
low = (2.9208 − 1.9208)/4.8416 = 1.0/4.8416 = 0.2065433 → **0.20654**.
high = (2.9208 + 1.9208)/4.8416 = 4.8416/4.8416 = **1.00000** exactly.

**Age band / 45-54, k=3 (P02,P03,P06), n=4 (P02,P03,P06,P07):**
p̂ = **0.75000** (pct **75.00**). Same radical as Female (3·1/4 = 0.75): 2.5633323.
low = (4.9208 − 2.5633323)/7.8416 = 2.3574677/7.8416 = 0.3006361 → **0.30064**.
high = (4.9208 + 2.5633323)/7.8416 = 7.4841323/7.8416 = 0.9544139 → **0.95441**.
(Sanity: mirror of 1/4 — 1−0.69936 = 0.30064, 1−0.04559 = 0.95441. ✓)

**Age band / 55-64, k=0, n=4 (P04,P05,P08,P09):**  *(k = 0 edge: Wilson low = 0 exactly)*
p̂ = **0.00000** (pct **0.00**). 0·4/4 = 0; √0.9604 = 0.98; ×1.96 = 1.9208.
low = (1.9208 − 1.9208)/7.8416 = **0.00000** exactly.
high = (1.9208 + 1.9208)/7.8416 = 3.8416/7.8416 = 0.4899000 → **0.48990**.

**Age band / 65+, k=0, n=1 (P10):**
p̂ = **0.00000** (pct **0.00**). low = 0/4.8416 = **0.00000** exactly.
high = 3.8416/4.8416 = 0.7934567 → **0.79346**.

**Anchor year / 2019, k=4, n=10:** identical to Overall (every anchor is 2019-07-20):
**0.40000**, pct **40.00**, CI (**0.16818**, **0.68733**).

Row count = 1 Overall + 2 sex + 4 age bands + 1 year = **8** (bands 0-17 and 18-34
are empty → rows ABSENT by GROUP BY semantics, both languages — §see small-N in §9).
`ci_method = 'wilson'` on every row.

### a_pp_idx — anchor = each subject's index date (all 2019-01-01)

Every cohort member's episode covers their index (CE criterion) → n = 10. Case iff
AE event ≤ 2019-01-01: P01 (2018-06-01 ✓), P06 (2018-09-01 ✓); P02/P03/P07 events are
after index → k = 2. This reproduces the frozen spine truth
`EXPECTED.prevalentM = 2` / `EXPECTED.baselinePrevalence = 0.2` from an independent
code path — a deliberate cross-check.

**Overall, k=2, n=10:** p̂ = 2/10 = **0.20000** (pct **20.00**). n+z² = 13.8416;
k+z²/2 = 3.9208. 2·8/10 = 1.6; +0.9604 = 2.5604; √ = 1.6001250; ×1.96 = 3.1362450.
low = (3.9208 − 3.1362450)/13.8416 = 0.7845550/13.8416 = 0.0566810 → **0.05668**.
high = (3.9208 + 3.1362450)/13.8416 = 7.0570450/13.8416 = 0.5098432 → **0.50984**.
Row count = **1**. `ci_method = 'wilson'`.

### a_pp_eos — anchor D = 2020-12-31 (fixed; after every episode end)

Every stitched episode ends 2020-06-30 < D → the episode join excludes ALL 10 cohort
members: denominator = **0**, patients = **0** (COALESCE/`.`→0 fix), prevalence =
**NULL**, prevalence_pct = **NULL**, ci_low = **NULL**, ci_high = **NULL**,
`ci_method = 'wilson'` (requested clopper_pearson → REVIEW limitation + honest
label). Row count = **1** (the ungrouped Overall aggregate over an empty input
yields exactly one row in both Postgres and SAS PROC SQL). This pins the
zero-denominator arm AND proves the enrolled-on-anchor join actually excludes.

All values above are the gold assertions for `EXPECTED.pointPrevalence` and
`verify/run.ts` (exact equality for patients/denominator/row counts; tolerance
±0.00001 for prevalence/CI, ±0.01 for pct; IS NULL checks for the eos rows).
Cross-validation: this same closed form evaluated at the repo's existing frozen gold
(3/8) reproduces `EXPECTED.wilsonCi = [0.13684, 0.69426]` exactly — the formula shape
is the one already proven feasible in SQL.

---

## 8. Fixture extension — none

**No new rows. No changed rows. No new constants.** The frozen 12-patient fixture
already exercises every arm of this module:

- numerator on-or-before boundary: P03's event lands exactly ON the fixed anchor;
- Wilson k=0 (low = 0 exactly), k=n (high = 1 exactly), n=1 strata, p̂=0.5 symmetry;
- stitched-episode denominator (P07's bridged gap covers the anchor);
- fixed-vs-index anchor (a_pp_main vs a_pp_idx, the latter reconciling with the
  frozen `baselinePrevalence = 0.2`);
- zero-denominator / empty-output behavior (a_pp_eos anchors after every episode).

The only fixture-file edits are **additive spec entries** (three analyses appended to
`GOLD_A_SPEC.analyses`) and a new `EXPECTED.pointPrevalence` block. Non-interference
proof: analyses drive only the numbered analysis outputs (07+/080+); the spine
builders (01–06 SQL, 010–070 SAS) never read `spec.analyses`, so every existing work
table and every existing gold number is bit-identical. The incidence analysis remains
the only `incidence_rate` entry (count 1 ⇒ its suffix stays "" ⇒ its table stays
`tz_study_incidence` and file numbers 07/080); the three point-prevalence analyses
sit after it in spec order, taking 08/09/10 and 090/100/110. Existing raw tables and
seeded rows are untouched, so `indexed=12`, `continuouslyEnrolled=11`,
`finalCohortN=10`, all incidence numbers, and all stratified incidence rows are
provably unchanged.

---

## 9. Output table schema — one row per stratum incl. Overall

Table `${wp}_pointprev${suffix}` (SQL) / `tz.&tag._${num}_pointprev${suffix}` (SAS):

| column | SQL type | SAS type | meaning |
|---|---|---|---|
| `measure` | VARCHAR | char $20 | constant `'point_prevalence'` |
| `stratifier` | VARCHAR | char $40 | `'Overall'` or `stratLabel(s.label)` (40-char cap shared with SAS) |
| `stratum` | VARCHAR | char $40 | `'Overall'` or the shared stratum label (SEX_LABELS / REGION_LABELS / ageBandLabels / year / plantyp; `'Unknown'` fallback) |
| `patients` | BIGINT/INT | num | numerator k — prevalent cases in the denominator on the anchor date |
| `denominator` | BIGINT/INT | num | cohort members enrolled on the anchor date |
| `prevalence` | NUMERIC(·,5) | num | `round(k/n, 5dp)`; NULL/. when n = 0 |
| `prevalence_pct` | NUMERIC(·,2) | num | `round(100·k/n, 2dp)`; NULL/. when n = 0 |
| `ci_low` | NUMERIC(·,5) | num | Wilson lower bound, 5dp; = 0 exactly at k = 0; NULL/. when n = 0 |
| `ci_high` | NUMERIC(·,5) | num | Wilson upper bound, 5dp; = 1 exactly at k = n; NULL/. when n = 0 |
| `ci_method` | VARCHAR | char $16 | constant `'wilson'` — the method actually computed |

Row set: exactly one `Overall/Overall` row (present even when the denominator is
empty), plus one row per OBSERVED stratum value per supported stratifier.
**Small-N contract (both languages, identical):** n = 0 overall → the single Overall
row carries `patients=0, denominator=0`, NULL/missing statistics — no division error
(SQL: `CASE denominator=0` + `NULLIF`; SAS: `if denominator > 0` branch; SQL
`COALESCE(SUM(is_case),0)` ↔ SAS `if patients=. then patients=0`). k = 0 stratum →
prevalence 0, CI (0, high) with low = 0 exactly. k = n → CI (low, 1) with high = 1
exactly. Empty stratum value (no members) → row ABSENT (GROUP BY semantics — absent,
not zero-filled — identical in Postgres and PROC SQL). Presentation order:
`ORDER BY stratifier, stratum` / `proc sort; by stratifier stratum`.

---

## 10. Integration checklist — files to touch, in order

1. `src/emitters/parity.ts` — add `PointPrevalenceParity`, `pointPrevalenceParity()`,
   `pointPrevalenceLimitations()` (§5, §6); import `PointPrevalenceAnalysis` type.
   No changes to existing exports.
2. `src/emitters/modules/point_prevalence.ts` — NEW file: `sqlPointPrevalence` (§3),
   `sasPointPrevalence` (§4), `export const pointPrevalenceModule:
   AnalysisModule<PointPrevalenceAnalysis> = { analysisKind: "point_prevalence",
   stampKind: "point_prevalence", sql, sas }`. Imports only from `../sql-base`,
   `../sas-base`, `../parity`, `./types` (module contract: no emitter-core edits).
3. `src/emitters/modules/registry.ts` — one registration line:
   `point_prevalence: pointPrevalenceModule as AnalysisModule<never>` (auto-enrolls
   SQL 08+/SAS 090+ emission AND the parity check).
4. `src/verify/parity.ts` — add `SIGNATURES["point_prevalence"]`:
   `sql: ["1.9208", "3.8416", "0.9604", "e.event_date <= d.anchor_date"]`,
   `sas: ["1.9208", "3.8416", "0.9604", "e.svcdate <= a.anchor_date"]`
   (Wilson constants + the on-or-before-anchor case predicate in each twin).
5. `src/verify/fixture.ts` — append the three analyses (§7) to
   `GOLD_A_SPEC.analyses` (after `a_incidence`); add the `EXPECTED.pointPrevalence`
   gold block with every §7 number. NO data-row or DDL changes (§8).
6. `src/verify/run.ts` — in `verifyGoldA()`: read
   `tz_study_pointprev_a_pp_main` (assert row count 8; Overall + all 7 stratum rows:
   patients/denominator exact, prevalence/ci ±0.00001, pct ±0.01, ci_method =
   'wilson'), `tz_study_pointprev_a_pp_idx` (row count 1; 2/10; CI 0.05668/0.50984),
   `tz_study_pointprev_a_pp_eos` (row count 1; 0/0; prevalence, pct and both CI
   bounds IS NULL; ci_method = 'wilson').
7. `docs/COVERAGE-MATRIX.md` — flip the "Point prevalence" row status from
   `declared-not-emitted` to `done`.
8. `npm run verify` — gates the merge: PGlite executes the emitted SQL against the
   frozen fixture, gold assertions + invariants (numerator<=denominator) + SAS↔SQL
   parity stamps/signatures must all pass. (Node-version gotcha: run
   `npm rebuild better-sqlite3`-style native rebuilds only if the harness demands —
   PGlite itself is pure WASM.)
