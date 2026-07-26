# cumulative_incidence module blueprint

Module for `kind: "cumulative_incidence"` — risk (incidence proportion) at a fixed
horizon, built to the exact shape of the reference module
`src/emitters/modules/incidence.ts` (twin `sql()`/`sas()`, shared PARITY stamp,
loud REVIEW limitations, shared stratum labels, hand-computed gold vectors).

**Headline design decision (the "CRITICAL DESIGN QUESTION"):** this module computes
**complete-follow-up risk** — the denominator is restricted to at-risk (post-washout)
patients whose *administrative* observation reaches `index + horizonDays`. That is the
one definition that is (a) exactly SQL-computable in closed form, (b) the setting in
which the spec's `ProportionCiMethod` (Wilson on k/n) is statistically valid, and
(c) exactly reconciles with the already-pinned `EXPECTED.cumulativeIncidence = 0.375`
and `EXPECTED.wilsonCi = [0.13684, 0.69426]` (§7). 1-minus-KM and Aalen-Johansen are
**declared, not emitted** (§1.3) — never faked, never mislabeled.

---

## 1. Method — precise definition + literature refs

### 1.1 Estimand and estimator

**Cumulative incidence (incidence proportion, "risk") at horizon T = `horizonDays`.**

The risk parameter is defined on a closed cohort followed for the full risk period:
the proportion of an event-free-at-t0 population that experiences a first event in
(t0, t0+T]. (Rothman, Greenland & Lash, *Modern Epidemiology*, 3rd ed., ch. 3
"Measures of Occurrence", §"Incidence proportion" — risk requires that every
denominator member be observable over the whole period; with unequal follow-up one
must move to survival methods.)

Operational definition, per at-risk patient (all dates from the spine work tables):

```
fu_date      = MIN(qualifying outcome event_date) with event_date > index_date
               (follow-up EXCLUDES the index date — repo convention, identical
                to the incidence twin's strictly-after-index predicate)
admin_censor = earliest of the personTimeRule.censorAt ADMINISTRATIVE terms:
                 disenrollment -> stitched episode_end
                 study_end     -> spec.meta.studyPeriod.end
                 max_followup  -> index + maxFollowupDays
               ("outcome" never participates: outcome censoring shortens
                person-time, not observability; if it did participate every case
                would flunk the completeness test. Empty term set falls back to
                study_end, exactly as the incidence twin does.)
horizon_date = index_date + horizonDays          (calendar-day offset, never years)

has_full = (admin_censor >= horizon_date)                          -- risk-evaluable
is_case  = has_full AND fu_date IS NOT NULL AND fu_date <= horizon_date
```

**Denominator** `n` = Σ has_full ("complete follow-up through the horizon").
**Numerator** `k` = Σ is_case (first event in day 1..T among evaluable patients).
**Risk** = k / n. Patients with `has_full = 0` are excluded from BOTH numerator and
denominator and surfaced in an `n_incomplete` output column plus a REVIEW note —
this is the standard claims-study "requires ≥T days continuous enrollment
post-index" design, applied uniformly to cases and non-cases so every denominator
member has the identical opportunity window \[0, T] (unbiased binomial sampling
frame; excluding only event-free early-censored patients would overestimate risk).

**At-risk construction (washout) is byte-for-byte the incidence module's semantics:**
any qualifying outcome event inside `an.washout` (a `RelativeWindow` around index,
rendered via the shared `windowConds` helpers in `sql-base.ts` / `sas-base.ts`)
marks the patient PREVALENT and removes them from numerator AND denominator
(DOMAIN-RULES §3; *Modern Epi* 3e ch. 3 first-occurrence "incident case" definition).

### 1.2 Confidence interval

**Wilson score interval** (Wilson, *JASA* 1927;22(158):209–212), z = 1.96 (95%
two-sided, the same hard-coded z as the incidence twin's Byar form):

```
p       = k / n
center  = p + z²/(2n)
half    = z * sqrt( p(1-p)/n + z²/(4n²) )
wdenom  = 1 + z²/n
CI      = [ (center - half)/wdenom , (center + half)/wdenom ]
```

Closed form, division/sqrt only ⇒ identical arithmetic on both sides. Chosen as the
sole computed method because it is the spec default, is closed-form SQL-native
(spec/types.ts: "Wilson (SQL-native) default"), has exact behavior at k = 0 and
k = n (bounds hit 0 and 1 with valid one-sided widths), and dominates Wald in
small samples (Newcombe, *Stat Med* 1998;17:857–872; Brown, Cai & DasGupta,
*Statist. Sci.* 2001;16(2):101–133). `clopper_pearson` (Clopper & Pearson,
*Biometrika* 1934;26:404–413) needs the beta inverse — no closed form in stock
Postgres/Snowflake (COVERAGE-MATRIX "warehouse-SQL statistical ceiling") — and
`wald` is strictly inferior; both are substituted by Wilson **with an honest label
(`ci_method = 'wilson'`) and a REVIEW limitation**, mirroring the incidence twin's
`poisson_byar` policy.

### 1.3 What is deliberately NOT computed (declared, with rationale)

- **1-minus-KM at the horizon** (`Π(1 - d_i/n_i)` over event times ≤ T; Kaplan &
  Meier, *JASA* 1958;53:457–481). SQL-feasible via the
  `EXP(SUM(LN(1 - d/n)))` window identity, BUT: (a) its honest CI is Greenwood/
  log-log, which is outside the spec's `ProportionCiMethod` vocabulary — emitting
  a KM point estimate with a Wilson CI would be a mislabeled statistic; (b) the
  FROZEN fixture has **no at-risk patient censored before any horizon ≤ 546 days
  with an event pattern that discriminates KM from the complete-case proportion**
  (every existing at-risk patient's episode runs to 2020-06-30), and no
  discriminating patient can be added without changing pinned attrition/Table-1
  golds — a KM path would ship without discriminating machine verification,
  which violates the product's core claim. Declared in the program body REVIEW
  note as the censoring-robust alternative (SAS `PROC LIFETEST` route).
- **Aalen–Johansen CIF** (`competingRiskDeath: "aalen_johansen"`; Aalen & Johansen,
  *Scand J Stat* 1978;5:141–150): doubly infeasible — SAS-only per the spec
  comment, and MarketScan cannot ascertain death at all (BR-LIM-002 /
  COVERAGE-MATRIX "Honest gaps": DSTATUS masked from 2016, in-hospital only).
  REVIEW limitation; risk is computed and labeled `complete_followup`.
- **`competingRiskDeath: "censor"`**: with no death signal in MarketScan there is
  nothing to censor on; operationally identical to `"ignore"`, and said so out
  loud (REVIEW limitation, and the parity stamp records the APPLIED value
  `"ignore"`).

### 1.4 daysPerYear (hard rule 7)

This module performs **no person-time arithmetic**: the horizon is consumed in
days (`horizonDays`) and risk is dimensionless. `renderDaysPerYear` is therefore
*not consumed* and nothing year-related is hard-coded — the parity stamp
deliberately omits `daysPerYear`. (Rule 7 satisfied vacuously; documented here so
a reviewer does not read the omission as an oversight.)

---

## 2. Spec consumption — the analysis interface verbatim + field-by-field mapping

From `src/spec/types.ts` (verbatim):

```ts
export interface CumulativeIncidenceAnalysis extends AnalysisCommon {
  kind: "cumulative_incidence";
  outcomeDefinition: OutcomeDefinition;
  caseStatus: "incident";
  /** Prevalent-case washout: an outcome anywhere in this pre-index window removes
   *  the subject so only INCIDENT (new-onset) events count. */
  washout: RelativeWindow;
  incidentWithRespectTo: "cohort_entry" | "first_ever";
  denominatorRule: "at_risk_start";
  horizonDays: number; // e.g. 365 for 1-year risk
  personTimeRule: PersonTimeRule;
  /** "ignore"/"censor" (1-KM) OVERESTIMATE risk when death is common;
   *  "aalen_johansen" is the competing-risk CIF (SAS-only, no SQL feeder). */
  competingRiskDeath: "ignore" | "censor" | "aalen_johansen";
  recurrence: "first_only";
  ciMethod: ProportionCiMethod;
  stratifyBy: Stratifier[];
  referenceStratum?: string;
}
```

Supporting shapes consumed (also verbatim-relevant): `OutcomeDefinition
{ codeListId, minClaims, claimSeparationDays?, setting, diagnosisPosition }`,
`PersonTimeRule { start, censorAt[], maxFollowupDays? }`, `RelativeWindow`,
`Stratifier`.

| Spec field | Consumption |
|---|---|
| `id`, `label`, `notes` (AnalysisCommon) | `id` → parity stamp + file suffix when multiple analyses of this kind exist; `label` → titles/headers (quote-escaped). `enabled` gates emission upstream (registry). |
| `outcomeDefinition.codeListId` | The ONLY event filter: SQL `{wp}_events WHERE code_list_id = '<id>'`; SAS `ctx.evOf(codeListId)`. Stamped. |
| `outcomeDefinition.minClaims` | **Not yet enforced** (>1 ⇒ REVIEW limitation; single claim counts) — same debt as the incidence twin. |
| `outcomeDefinition.setting` | **Not yet applied** (≠ "any" ⇒ REVIEW limitation) — same as incidence twin. |
| `outcomeDefinition.diagnosisPosition` | **Not yet applied** (= "primary" ⇒ REVIEW limitation) — same as incidence twin. |
| `caseStatus` | Type-fixed `"incident"`; realized by the washout. Nothing to branch on. |
| `washout` | Prevalent-exclusion window, rendered by the SHARED `windowConds(washout, event, index, d)` (SQL) / `windowConds(washout, "e")` (SAS) — byte-identical semantics to the incidence module, including the empty-window "any prior event counts" fallback. Stamped `{start,end,includesIndex}`. |
| `incidentWithRespectTo` | Recorded in the parity stamp. `"cohort_entry"` is the washout-window semantics implemented. `"first_ever"` with a *bounded* washout ⇒ REVIEW limitation (the washout window is the operative exclusion; set `washout.start = "anytime_before"` to realize first-ever within observable data). |
| `denominatorRule` | Type-fixed `"at_risk_start"`; realized by washout + complete-follow-up restriction. |
| `horizonDays` | T. `horizon_date = index + T` via `d.offset` (SQL) / `index_date + T` (SAS). Emitted as constant output column `horizon_days`. Stamped. Validation already guarantees > 0. |
| `personTimeRule.start` | Only `"index"` implemented (risk clock starts at index; events strictly after index). Other values ⇒ REVIEW limitation. |
| `personTimeRule.censorAt` | Builds `admin_censor` exactly like the incidence twin: `disenrollment → episode end`, `study_end → DATE study end`, `max_followup → index + maxFollowupDays`; `"outcome"` intentionally excluded from the ADMIN censor (§1.1); empty ⇒ study-end fallback. Full array stamped (sorted). Omitting `"disenrollment"` ⇒ REVIEW note (claims are unobservable after disenrollment — completeness would ignore enrollment end). |
| `personTimeRule.maxFollowupDays` | Participates in `admin_censor` when `"max_followup"` requested. Stamped (null when absent). `maxFollowupDays < horizonDays` ⇒ REVIEW limitation: the denominator is provably EMPTY (risk NULL). |
| `competingRiskDeath` | `"ignore"` implemented; `"censor"`/`"aalen_johansen"` ⇒ REVIEW limitations (§1.3); stamp records the APPLIED value `"ignore"`. |
| `recurrence` | Type-fixed `"first_only"`; numerator is first-event by construction (`MIN(event_date)`). Stamped. |
| `ciMethod` | Wilson computed always; ≠ `"wilson"` ⇒ REVIEW limitation; output column `ci_method` = the method ACTUALLY computed (`'wilson'`). Stamped as `"wilson"`. |
| `stratifyBy` | `splitStratifiers()` from `parity.ts`: demographic axes emitted with the SHARED label constants (`SEX_LABELS`, `REGION_LABELS`, `ageBandLabels`, `stratLabel` 40-char cap, enrollment-segment demographics with the same `dtstart DESC, dtend DESC` tie-break); unsupported (baseline-sourced) ⇒ REVIEW limitation. Emitted strata stamped. |
| `referenceStratum` | **Not consumed** (no rate-ratio-vs-reference output in this module) ⇒ REVIEW limitation when set. |
| `spec.meta.studyPeriod.end` | The `study_end` censor term (SQL literal / SAS `&study_end.`). |
| `spec.meta.daysPerYear` | **Not consumed** — no person-time arithmetic (§1.4). |

---

## 3. SQL twin — the COMPLETE CTE chain

Generator: `function sqlCuminc(ctx: SqlCtx, an: CumulativeIncidenceAnalysis, suffix: string): SqlModuleFile`.
Output table `${wp}_cuminc${suffix}`; slug `cuminc${suffix}`; title
`07/08 Cumulative incidence (risk)`; subtitle
`complete-follow-up risk at horizon with washout + Wilson CI`.

Spine tables read (and ONLY these): `${wp}_cohort (enrolid, index_date, index_code)`
from build05, `${wp}_events (enrolid, event_date, event_type, setting, code_list_id,
code)` from build02, `${wp}_enroll_episodes (enrolid, episode_id, episode_start,
episode_end, n_segments)` from build04, plus raw `ctx.t("enrollment_detail")
(enrolid, dtstart, dtend, dobyr, sex, region, plantyp, …)` for stratum demographics
— the identical source-and-tie-break as the incidence twin.

Generation-time parameters (Gold-A instantiation shown in the SQL below):

| placeholder | meaning | Gold A value |
|---|---|---|
| `${wp}` | work prefix | `tz_study` |
| `${clid}` | `an.outcomeDefinition.codeListId` | `ae_dx` |
| `${H}` | `an.horizonDays` | `365` |
| `${washoutPred}` | `windowConds(an.washout, "a.event_date", "c.index_date", d)` AND-joined, `TRUE` when empty | `a.event_date >= (c.index_date - 365) AND a.event_date <= c.index_date` |
| `${adminCensor}` | LEAST of the censorAt admin terms (fallback `DATE '<studyEnd>'`) | `LEAST(ep.episode_end, DATE '2020-12-31', (c.index_date + 365))` |
| `${stratExpr(s)}` | identical `stratExpr` switch as incidence.ts (SEX_LABELS / REGION_LABELS / plantyp / year / age-band CASE off `d.year(index_date) - dobyr`) | 3 strata: sex, age band, year |

Emitted Postgres (Gold A; Snowflake portability ONLY through `d.offset`,
`d.daysBetween`, `d.year`, `d.roundN`, `d.createTableAs` — no raw dialect syntax):

```sql
-- PARITY cuminc {"censorAt":["disenrollment","max_followup","outcome","study_end"],"ciMethod":"wilson","codeListId":"ae_dx","competingRiskDeath":"ignore","horizonDays":365,"id":"a_cuminc","incidentWithRespectTo":"cohort_entry","maxFollowupDays":365,"recurrence":"first_only","riskMethod":"complete_followup","strata":[{"axis":"sex","id":"s_sex","label":"Sex"},{"axis":"age_band","bands":[0,18,35,45,55,65],"id":"s_age","label":"Age band"},{"axis":"year","id":"s_year","label":"Index year"}],"washout":{"end":0,"includesIndex":true,"start":-365}}
-- REVIEW - spec options this program does not implement yet:
--   * outcome care-setting filter "outpatient" is NOT yet applied - events from all settings count
DROP TABLE IF EXISTS tz_study_cuminc;
CREATE TABLE tz_study_cuminc AS
WITH cohort AS (SELECT enrolid, index_date FROM tz_study_cohort),
ae AS (SELECT enrolid, event_date FROM tz_study_events WHERE code_list_id = 'ae_dx'),
prevalent AS (   -- washout: day -365 .. day 0 relative to index (includes index date)
  SELECT DISTINCT c.enrolid
  FROM cohort c JOIN ae a ON a.enrolid = c.enrolid
  WHERE a.event_date >= (c.index_date - 365)
      AND a.event_date <= c.index_date
),
atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),
first_fu AS (   -- first qualifying outcome strictly after index
  SELECT c.enrolid, MIN(a.event_date) AS fu_date
  FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid AND a.event_date > c.index_date
  GROUP BY c.enrolid
),
demo AS (   -- enrollment segment in force at (or latest before) index; rn=1 wins
  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,
         ROW_NUMBER() OVER (PARTITION BY c.enrolid
                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn
  FROM atrisk c
  JOIN ccaet_all en
    ON en.enrolid = c.enrolid
   AND en.dtstart <= c.index_date
),
demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),
pt AS (
  SELECT c.enrolid, c.index_date,
         LEAST(ep.episode_end, DATE '2020-12-31', (c.index_date + 365)) AS admin_censor,
         (c.index_date + 365) AS horizon_date,
         f.fu_date,
         dm.dobyr, dm.sex, dm.region, dm.plantyp
  FROM atrisk c
  JOIN tz_study_enroll_episodes ep
    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end
  LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid
  LEFT JOIN first_fu f ON f.enrolid = c.enrolid
),
pt2 AS (
  SELECT
         -- complete follow-up: ADMIN censoring (never the outcome) reaches the horizon
         CASE WHEN admin_censor >= horizon_date THEN 1 ELSE 0 END AS has_full,
         -- a case = first outcome within the horizon among complete-follow-up rows
         CASE WHEN admin_censor >= horizon_date
               AND fu_date IS NOT NULL AND fu_date <= horizon_date THEN 1 ELSE 0 END AS is_case,
         CASE CAST(sex AS VARCHAR) WHEN '1' THEN 'Male' WHEN '2' THEN 'Female' ELSE 'Unknown' END AS strat_0,
         CASE WHEN CAST(EXTRACT(YEAR FROM index_date) AS INT) - dobyr IS NULL THEN 'Unknown'
              WHEN CAST(EXTRACT(YEAR FROM index_date) AS INT) - dobyr >= 65 THEN '65+'
              WHEN CAST(EXTRACT(YEAR FROM index_date) AS INT) - dobyr >= 55 THEN '55-64'
              WHEN CAST(EXTRACT(YEAR FROM index_date) AS INT) - dobyr >= 45 THEN '45-54'
              WHEN CAST(EXTRACT(YEAR FROM index_date) AS INT) - dobyr >= 35 THEN '35-44'
              WHEN CAST(EXTRACT(YEAR FROM index_date) AS INT) - dobyr >= 18 THEN '18-34'
              ELSE '0-17' END AS strat_1,
         CAST(CAST(EXTRACT(YEAR FROM index_date) AS INT) AS VARCHAR) AS strat_2
  FROM pt
),
summ AS (
  SELECT 'cumulative_incidence' AS measure, 'Overall' AS stratifier, 'Overall' AS stratum,
         SUM(is_case) AS patients, COUNT(*) AS at_risk, SUM(has_full) AS denominator
  FROM pt2
  UNION ALL
  SELECT 'cumulative_incidence', 'Sex', strat_0,
         SUM(is_case), COUNT(*), SUM(has_full)
  FROM pt2 GROUP BY strat_0
  UNION ALL
  SELECT 'cumulative_incidence', 'Age band', strat_1,
         SUM(is_case), COUNT(*), SUM(has_full)
  FROM pt2 GROUP BY strat_1
  UNION ALL
  SELECT 'cumulative_incidence', 'Index year', strat_2,
         SUM(is_case), COUNT(*), SUM(has_full)
  FROM pt2 GROUP BY strat_2
)
SELECT measure, stratifier, stratum, patients, at_risk, denominator,
       at_risk - denominator AS n_incomplete,
       ROUND(CAST((1.0 * patients / NULLIF(denominator, 0)) AS NUMERIC), 5) AS risk,
       ROUND(CAST(((1.0 * patients / NULLIF(denominator, 0)) + 1.96*1.96/(2*NULLIF(denominator, 0))
              - 1.96 * SQRT((1.0 * patients / NULLIF(denominator, 0)) * (1 - 1.0 * patients / NULLIF(denominator, 0)) / NULLIF(denominator, 0)
                            + 1.96*1.96/(4*NULLIF(denominator, 0)*NULLIF(denominator, 0))))
             / (1 + 1.96*1.96/NULLIF(denominator, 0)) AS NUMERIC), 5) AS ci_low,
       ROUND(CAST(((1.0 * patients / NULLIF(denominator, 0)) + 1.96*1.96/(2*NULLIF(denominator, 0))
              + 1.96 * SQRT((1.0 * patients / NULLIF(denominator, 0)) * (1 - 1.0 * patients / NULLIF(denominator, 0)) / NULLIF(denominator, 0)
                            + 1.96*1.96/(4*NULLIF(denominator, 0)*NULLIF(denominator, 0))))
             / (1 + 1.96*1.96/NULLIF(denominator, 0)) AS NUMERIC), 5) AS ci_high,
       -- labeled with the method actually computed, never the merely-requested one
       'wilson' AS ci_method,
       'complete_followup' AS risk_method,
       365 AS horizon_days
FROM summ;

-- REVIEW: complete-follow-up risk at 365 days, Overall + per stratum.
-- Patients censored before the horizon WITHOUT an event are EXCLUDED from both
-- numerator and denominator (n_incomplete counts them). When n_incomplete > 0
-- the complete-case risk can be biased if censoring is outcome-associated;
-- 1-minus-KM at the horizon (SAS PROC LIFETEST) is the censoring-robust
-- alternative and is NOT computed here.
SELECT * FROM tz_study_cuminc
ORDER BY stratifier, stratum;
```

Generator notes (all mandatory):

- `p` MUST be rendered `1.0 * patients / NULLIF(denominator, 0)` — an
  `INT/INT` division would truncate to 0 (the exact class of bug the repo already
  fixed once for daysPerYear; see `corrections/2026-07-24-incidence-integer-division.md`).
- Every `denominator` appearing as a divisor is wrapped `NULLIF(denominator, 0)`
  so a zero denominator yields NULL (never a division-by-zero error) and NULL
  propagates through risk/ci uniformly.
- `horizon_date` via `d.offset("c.index_date", an.horizonDays)`; `admin_censor`
  term list built exactly as `sqlIncidence` builds `terms` (same order, same
  fallback), so the two modules can never disagree about censoring semantics.
- Strata expressions, `demo/demo1` CTE, `stratLabel()` 40-char cap, and the
  `q()` escaping are copied from the incidence twin verbatim (shared helpers).
- Rounding: `d.roundN(expr, 5)` on risk/ci_low/ci_high (5 dp matches the pinned
  `EXPECTED.wilsonCi` precision).

## 4. SAS twin — the COMPLETE program mirroring the SQL arithmetic

Generator: `function sasCuminc(ctx: SasCtx, an: CumulativeIncidenceAnalysis, num: string, suffix: string): GeneratedFile`,
path `sas/${num}_cuminc${suffix}.sas`. Spine tables: `ctx.finalCohort`
(= `tz.&tag._060_coh2` for Gold A), `ctx.evOf(codeListId)` (`tz.&tag._ev_ae_dx`,
columns `enrolid, svcdate`), `ctx.tbl("050_epi")` (`enrolid, episode, dtstart, dtend`),
`ctx.tbl("040_enroll")` (`enrolid, dtstart, dtend, rx, plantyp, sex, region, dobyr`).

Emitted program (Gold A, num = `090`; header via the shared `header()` scaffold):

```sas
/*=============================================================================
| Project  : Gold Case A - new-user AE incidence
| Program  : 090_cuminc.sas
| Author   : HEOR Studio deterministic emitter (machine-generated; analyst review required)
| ...standard header lines (header())...
| Purpose  : Cumulative incidence (complete-follow-up risk) at 365 days for
|          : "1-year cumulative incidence of AE (E11.9)": prevalent-case
|          : washout, at-risk denominator RESTRICTED to patients whose
|          : administrative censoring reaches index + 365, Wilson 95% CI.
|          : Twin of the machine-verified SQL 08_cuminc; keep both in sync.
=============================================================================*/

/* PARITY cuminc {"censorAt":["disenrollment","max_followup","outcome","study_end"],"ciMethod":"wilson","codeListId":"ae_dx","competingRiskDeath":"ignore","horizonDays":365,"id":"a_cuminc","incidentWithRespectTo":"cohort_entry","maxFollowupDays":365,"recurrence":"first_only","riskMethod":"complete_followup","strata":[{"axis":"sex","id":"s_sex","label":"Sex"},{"axis":"age_band","bands":[0,18,35,45,55,65],"id":"s_age","label":"Age band"},{"axis":"year","id":"s_year","label":"Index year"}],"washout":{"end":0,"includesIndex":true,"start":-365}} */

/* REVIEW - spec options this program does not implement yet:
   * outcome care-setting filter "outpatient" is NOT yet applied - events from all settings count
*/

%include "00_setup.sas";   /* EDIT: use the full site path to 00_setup.sas */

proc datasets lib=tz nolist nowarn;
  delete &tag._090_cuminc;
quit;

/*----------------------------------------------------------------------------
  Prevalent-case washout: any qualifying outcome event inside the washout
  window (day -365 .. day 0 relative to index (includes the index date))
  marks the patient PREVALENT - excluded so only new-onset cases count.
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_prev as
  select distinct a.enrolid
  from tz.&tag._060_coh2 as a
  inner join tz.&tag._ev_ae_dx as e
    on e.enrolid = a.enrolid
  where 1 = 1
    and e.svcdate >= a.index_date - 365
    and e.svcdate <= a.index_date;
quit;

title "Washout: prevalent patients excluded (1-year cumulative incidence of AE (E11.9))";
proc sql;
  select count(distinct enrolid) as prevalent_pat
  from work._090_prev;
quit;

/*-------------------- at-risk denominator ----------------------------------*/
proc sql;
  create table work._090_atrisk as
  select a.*
  from tz.&tag._060_coh2 as a
  where a.enrolid not in (select enrolid from work._090_prev);
quit;

title "Level check: work._090_atrisk (at-risk cohort)";
proc sql;
  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt
  from work._090_atrisk;
quit;

/*-------------------- first outcome strictly after index -------------------*/
proc sql;
  create table work._090_first_fu as
  select a.enrolid,
         min(e.svcdate) as fu_date format=date9.
  from work._090_atrisk as a
  inner join tz.&tag._ev_ae_dx as e
    on  e.enrolid = a.enrolid
    and e.svcdate > a.index_date
  group by a.enrolid;
quit;

/*----------------------------------------------------------------------------
  Stratum demographics from the enrollment segment in force at (or latest
  before) the index date - the SAME source and tie-break as the SQL twin,
  so stratum values cannot drift between languages.
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_dm0 as
  select a.enrolid, b.dobyr, b.sex, b.region, b.plantyp,
         b.dtstart as seg_start, b.dtend as seg_end
  from work._090_atrisk as a
  left join tz.&tag._040_enroll as b
    on  b.enrolid = a.enrolid
    and b.dtstart <= a.index_date;
quit;

proc sort data=work._090_dm0;
  by enrolid descending seg_start descending seg_end;
run;

data work._090_dm;
  set work._090_dm0;
  by enrolid;
  if first.enrolid;
  drop seg_start seg_end;
run;

/*----------------------------------------------------------------------------
  Administrative censor = earliest of
    - ep.dtend
    - &study_end.
    - a.index_date + 365
  taken on the stitched enrollment episode covering the index date. The
  outcome NEVER participates (it shortens person-time, not observability).
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_pt as
  select a.enrolid, a.index_date,
         min(ep.dtend, &study_end., a.index_date + 365) as admin_censor format=date9.,
         b.fu_date,
         dm.dobyr, dm.sex, dm.region, dm.plantyp
  from work._090_atrisk as a
  inner join tz.&tag._050_epi as ep
    on  ep.enrolid = a.enrolid
    and a.index_date between ep.dtstart and ep.dtend
  left join work._090_dm as dm
    on dm.enrolid = a.enrolid
  left join work._090_first_fu as b
    on b.enrolid = a.enrolid;
quit;

data work._090_pt2;
  set work._090_pt;
  length strat_0 strat_1 strat_2 $40;
  /* risk horizon: index + 365 days (spec horizonDays; clock starts at index) */
  horizon_date = index_date + 365;
  /* complete follow-up: ADMIN censoring (never the outcome) reaches the horizon */
  has_full = (admin_censor >= horizon_date);
  /* a case = first outcome within the horizon among complete-follow-up rows */
  is_case = (has_full and fu_date ne . and fu_date <= horizon_date);
  /* enrollment-derived age (year - DOBYR), matching the SQL twin */
  age_at_index = year(index_date) - dobyr;
  /* stratifier: Sex (sex) */
  if sex = '1' then strat_0 = 'Male';
  else if sex = '2' then strat_0 = 'Female';
  else strat_0 = 'Unknown';
  /* stratifier: Age band (age_band) */
  if age_at_index = . then strat_1 = 'Unknown';
  else if age_at_index >= 65 then strat_1 = '65+';
  else if age_at_index >= 55 then strat_1 = '55-64';
  else if age_at_index >= 45 then strat_1 = '45-54';
  else if age_at_index >= 35 then strat_1 = '35-44';
  else if age_at_index >= 18 then strat_1 = '18-34';
  else strat_1 = '0-17';
  /* stratifier: Index year (year) */
  strat_2 = strip(put(year(index_date), 4.));
  format horizon_date date9.;
run;

title "Level check: work._090_pt2 (risk rows)";
proc sql;
  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt,
         sum(is_case) as cases,
         sum(has_full) as complete_fu
  from work._090_pt2;
quit;

/*----------------------------------------------------------------------------
  Complete-follow-up risk + Wilson 95% CI - the SAME closed form as the SQL
  twin (Wilson JASA 1927;22:209), so both languages agree to the last rounded
  digit:
    p      = patients / denominator
    center = p + z^2/(2n);  half = z*sqrt(p(1-p)/n + z^2/(4n^2));  w = 1 + z^2/n
    CI     = [(center - half)/w, (center + half)/w]         (z = 1.96)
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_summ as
  select 'Overall' as stratifier length=40,
         'Overall' as stratum length=40,
         count(*) as at_risk,
         sum(has_full) as denominator,
         sum(is_case) as patients
  from work._090_pt2
  union all
  select 'Sex', strat_0, count(*), sum(has_full), sum(is_case)
  from work._090_pt2 group by strat_0
  union all
  select 'Age band', strat_1, count(*), sum(has_full), sum(is_case)
  from work._090_pt2 group by strat_1
  union all
  select 'Index year', strat_2, count(*), sum(has_full), sum(is_case)
  from work._090_pt2 group by strat_2
  ;
quit;

data tz.&tag._090_cuminc;
  set work._090_summ;
  length measure $20 ci_method $16 risk_method $20;
  measure      = 'cumulative_incidence';
  /* labeled with the method actually computed, never the merely-requested one */
  ci_method    = 'wilson';
  risk_method  = 'complete_followup';
  horizon_days = 365;
  n_incomplete = at_risk - denominator;
  if denominator > 0 then do;
    _p = patients / denominator;
    _c = _p + 1.96*1.96/(2*denominator);
    _h = 1.96 * sqrt(_p*(1 - _p)/denominator + 1.96*1.96/(4*denominator*denominator));
    _w = 1 + 1.96*1.96/denominator;
    risk    = round(_p, 0.00001);
    ci_low  = round((_c - _h)/_w, 0.00001);
    ci_high = round((_c + _h)/_w, 0.00001);
  end;
  else do;
    risk = .; ci_low = .; ci_high = .;
  end;
  drop _p _c _h _w;
run;

/* same presentation order as the SQL twin's REVIEW query */
proc sort data=tz.&tag._090_cuminc;
  by stratifier stratum;
run;

title "Cumulative incidence (complete-follow-up risk) at 365 days: 1-year cumulative incidence of AE (E11.9)";
/* REVIEW: patients censored before the horizon WITHOUT an event are EXCLUDED
   (n_incomplete). When n_incomplete > 0 the complete-case risk can be biased
   if censoring is outcome-associated; 1-minus-KM at the horizon
   (PROC LIFETEST) is the censoring-robust alternative - NOT computed here. */
proc print data=tz.&tag._090_cuminc noobs;
  var measure stratifier stratum patients at_risk denominator n_incomplete
      risk ci_low ci_high ci_method risk_method horizon_days;
run;
```

Twin-parity mechanics (what the harness leans on):

- Same closed-form Wilson arithmetic (`1.96*1.96/(2*n)`, `1.96*1.96/(4*n*n)`),
  same `admin_censor >= horizon_date` completeness predicate, same
  strictly-after-index case predicate, same 5-dp rounding — recommend adding a
  `cuminc` entry to `SIGNATURES` in `src/verify/parity.ts`:
  - sql: `["1.96*1.96/(2*", "1.96*1.96/(4*", "admin_censor >= horizon_date", "fu_date <= horizon_date", "> c.index_date"]`
  - sas: `["1.96*1.96/(2*denominator)", "1.96*1.96/(4*denominator*denominator)", "admin_censor >= horizon_date", "fu_date <= horizon_date", "> a.index_date"]`
- Stratum labels/order, `$40` cap, `sq()`/`q()` escaping: shared helpers only.
- No clamping of the CI (Wilson is closed in [0,1]; both twins round to 5 dp,
  which absorbs any last-ulp FP dust identically because the pre-rounding values
  agree to ~1e-15 and the asserted tolerance is 1e-5).

---

## 5. Parity record — exact stamped fields

`stampKind: "cuminc"`. Both twins stamp
`parityStamp("cuminc", cumincParity(an, { censorTerms, strata }))` built from the
values THE BUILDER CONSUMED (parity.ts doctrine), where:

```ts
export interface CumincParity {
  id: string;                    // an.id
  codeListId: string;            // an.outcomeDefinition.codeListId
  horizonDays: number;           // an.horizonDays (days; never converted)
  washout: { start: number | "anytime_before";
             end: number | "anytime_after";
             includesIndex: boolean };            // an.washout, field-by-field
  incidentWithRespectTo: string; // an.incidentWithRespectTo (consumed for the
                                 // bounded-window REVIEW branch)
  censorAt: string[];            // consumed personTimeRule.censorAt, SORTED
  maxFollowupDays: number | null;// an.personTimeRule.maxFollowupDays ?? null
  riskMethod: "complete_followup"; // the estimator ACTUALLY computed
  ciMethod: "wilson";            // the CI ACTUALLY computed (requested method
                                 // visible via the REVIEW limitation)
  competingRiskDeath: "ignore";  // the handling ACTUALLY applied (requested
                                 // value visible via the REVIEW limitation)
  recurrence: "first_only";      // the recurrence actually produced
  strata: SupportedStratifier[]; // strata actually emitted (id/axis/bands), spec order
}
```

Deliberate omissions: `daysPerYear` (not consumed — no person-time arithmetic,
§1.4) and `referenceStratum` (not consumed — limitation instead). The stamp is
serialized by the shared `stableJson` (sorted keys) so both languages emit a
byte-identical `PARITY cuminc {...}` line; `sasSqlParityChecks` deep-compares
them automatically once the module is in the registry.

---

## 6. Limitations — every unimplemented option + its REVIEW wording

`cumincLimitations(an: CumulativeIncidenceAnalysis): string[]` — defined IN THE
MODULE FILE (imports `splitStratifiers` from parity.ts; keeps the "modules never
touch shared files" contract of modules/types.ts; incidence's helpers predate
that contract). Rendered exactly like the reference module: SQL as
`-- REVIEW - spec options this program does not implement yet:` + `--   * ...`,
SAS as the `/* REVIEW ... */` block, in BOTH twins, from the same function.

| Condition | Exact REVIEW wording |
|---|---|
| `outcomeDefinition.minClaims > 1` | `outcome minClaims=<n> is NOT yet enforced - any single qualifying claim counts as the outcome` |
| `outcomeDefinition.setting !== "any"` | `outcome care-setting filter "<setting>" is NOT yet applied - events from all settings count` |
| `outcomeDefinition.diagnosisPosition !== "any"` | `diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count` |
| `ciMethod === "clopper_pearson"` | `ciMethod "clopper_pearson" is NOT implemented - the Wilson score interval is produced and labeled wilson (exact Clopper-Pearson needs the beta inverse: SAS PROC FREQ BINOMIAL CL=CLOPPERPEARSON; no SQL closed form)` |
| `ciMethod === "wald"` | `ciMethod "wald" is NOT implemented - the Wilson score interval is produced and labeled wilson` |
| `competingRiskDeath === "censor"` | `competingRiskDeath="censor" cannot be honored - MarketScan does not ascertain death (BR-LIM-002); computed as "ignore"; risk is overestimated where death is common` |
| `competingRiskDeath === "aalen_johansen"` | `competingRiskDeath="aalen_johansen" (Aalen-Johansen CIF) is NOT implemented - SAS-only method requiring death ascertainment MarketScan lacks (BR-LIM-002); complete-follow-up risk is produced and labeled complete_followup` |
| `personTimeRule.start !== "index"` | `personTimeRule.start="<start>" is NOT implemented - the risk clock starts at index` |
| `incidentWithRespectTo === "first_ever" && washout.start !== "anytime_before"` | `incidentWithRespectTo="first_ever" but the washout window is bounded (starts day <start>) - prevalent exclusion applies the washout window only; set washout.start="anytime_before" for all-observable-history washout` |
| `maxFollowupDays != null && maxFollowupDays < horizonDays` | `maxFollowupDays=<m> < horizonDays=<T>: NO patient can have complete follow-up through the horizon - the risk denominator will be empty and risk/CI will be NULL` |
| `!censorAt.includes("disenrollment")` | `censorAt omits "disenrollment": follow-up completeness ignores enrollment end - claims are unobservable after disenrollment, so events inside the horizon may be missed for disenrolled patients` |
| `referenceStratum` set | `referenceStratum="<id>" is NOT consumed - no risk-ratio-vs-reference output is produced yet` |
| each unsupported (baseline-sourced) stratifier | `stratifier "<id>" (<kind>-sourced) is NOT yet emitted - demographic axes only for now` |

Plus one ALWAYS-emitted method note in the program body (not a limitation — a
statement of the computed method, present in both twins; wording in §3/§4):
patients censored before the horizon without an event are EXCLUDED
(`n_incomplete`); 1-minus-KM is the censoring-robust alternative, NOT computed.

---

## 7. Fixture vectors — patient-by-patient hand derivation

Analysis added to `GOLD_A_SPEC.analyses` (see §8): `a_cuminc`, codeList `ae_dx`,
washout `{start:-365, end:0, includesIndex:true}` (identical to `a_incidence`),
`horizonDays: 365`, `personTimeRule {start:"index", censorAt:["outcome",
"disenrollment","study_end","max_followup"], maxFollowupDays:365}`,
`competingRiskDeath:"ignore"`, `ciMethod:"wilson"`, stratifiers = the same three
as `a_incidence` (sex; age bands [0,18,35,45,55,65]; index year).

### 7.1 Disposition of all 12 patients (frozen fixture)

All indexed patients have `index_date = 2019-01-01`. Study end 2020-12-31.

| Pt | In cohort? | Washout event? | Disposition |
|---|---|---|---|
| P01 | yes | AE 2018-06-01 = day −214 ∈ [−365, 0] | PREVALENT — excluded |
| P02 | yes | no (AE 2019-04-11 is post-index) | at-risk |
| P03 | yes | no (AE 2019-07-20 post-index) | at-risk |
| P04 | yes | no events | at-risk |
| P05 | yes | no events | at-risk |
| P06 | yes | AE 2018-09-01 = day −122 ∈ [−365, 0] | PREVALENT — excluded |
| P07 | yes | no (AE 2019-10-28 post-index) | at-risk |
| P08 | yes | no events | at-risk |
| P09 | yes | no events | at-risk |
| P10 | yes | no events | at-risk |
| P11 | NO — enrollment gap 61d > 31 fails continuous enrollment | — | not in cohort |
| P12 | NO — age 10 fails age ≥ 18 | — | not in cohort |

At-risk = 8 (P02–P05, P07–P10) = `EXPECTED.atRiskDenominator` — the SAME at-risk
set the incidence module verifies (same washout ⇒ cross-module invariant).

### 7.2 Per-patient horizon/censor walk (at-risk patients)

`horizon_date = 2019-01-01 + 365 = 2020-01-01` (2019 has 365 days).
`admin_censor = LEAST(episode_end, 2020-12-31, 2019-01-01 + 365)`.
Episode end is 2020-06-30 for every at-risk patient (P07's two spans,
2018-01-01..2019-06-10 and 2019-06-30..2020-06-30, stitch across the 20-day ≤ 31
gap into one episode 2018-01-01..2020-06-30). So for ALL 8:
`admin_censor = LEAST(2020-06-30, 2020-12-31, 2020-01-01) = 2020-01-01`.

| Pt | sex | age (2019−dobyr) | fu_date (day) | admin_censor | has_full (censor ≥ 2020-01-01) | is_case (fu ≤ 2020-01-01) |
|---|---|---|---|---|---|---|
| P02 | Female | 45 | 2019-04-11 (+100) | 2020-01-01 | 1 | **1** |
| P03 | Male | 50 | 2019-07-20 (+200) | 2020-01-01 | 1 | **1** |
| P04 | Female | 55 | — | 2020-01-01 | 1 | 0 |
| P05 | Male | 60 | — | 2020-01-01 | 1 | 0 |
| P07 | Female | 50 | 2019-10-28 (+300) | 2020-01-01 | 1 | **1** |
| P08 | Male | 55 | — | 2020-01-01 | 1 | 0 |
| P09 | Female | 60 | — | 2020-01-01 | 1 | 0 |
| P10 | Male | 65 | — | 2020-01-01 | 1 | 0 |

Every at-risk patient completes the horizon ⇒ `denominator = at_risk = 8`,
`n_incomplete = 0`. **This is exactly why the pinned naive 3/8 reconciles with the
complete-follow-up definition: on this fixture the two definitions (and 1-KM)
coincide, because there is no censoring before the horizon.** The pinned
`EXPECTED.cumulativeIncidence = 0.375` and `EXPECTED.wilsonCi = [0.13684, 0.69426]`
become LIVE assertions for the first time — no new Overall vectors needed.

### 7.3 Wilson arithmetic for every asserted row (z = 1.96, z² = 3.8416)

Formula: p = k/n; center = p + z²/(2n); half = z·√(p(1−p)/n + z²/(4n²));
w = 1 + z²/n; CI = [(center−half)/w, (center+half)/w]. All values shown to 7 dp;
asserted at 5 dp (tolerance ±0.00001).

**Overall (and Index year/2019 — identical membership): k = 3, n = 8.**
- p = 0.375 → risk = **0.37500**
- center = 0.375 + 3.8416/16 = 0.375 + 0.2401000 = 0.6151000
- p(1−p)/n = 0.375·0.625/8 = 0.0292969; z²/(4n²) = 3.8416/256 = 0.0150063
- half = 1.96·√0.0443031 = 1.96·0.2104831 = 0.4125468
- w = 1 + 3.8416/8 = 1.4802000
- ci_low = (0.6151000 − 0.4125468)/1.4802 = 0.2025532/1.4802 = 0.1368417 → **0.13684**
- ci_high = (0.6151000 + 0.4125468)/1.4802 = 1.0276468/1.4802 = 0.6942621 → **0.69426**
- ✓ equals pinned `EXPECTED.cumulativeIncidence` / `EXPECTED.wilsonCi` exactly.

**Sex/Male: k = 1 (P03), n = 4 (P03, P05, P08, P10).**
- p = 0.25 → risk = **0.25000**
- center = 0.25 + 3.8416/8 = 0.7302000
- p(1−p)/n = 0.1875/4 = 0.0468750; z²/(4n²) = 3.8416/64 = 0.0600250
- half = 1.96·√0.1069000 = 1.96·0.3269557 = 0.6408332
- w = 1 + 3.8416/4 = 1.9604000
- ci_low = (0.7302 − 0.6408332)/1.9604 = 0.0893668/1.9604 = 0.0455860 → **0.04559**
- ci_high = (0.7302 + 0.6408332)/1.9604 = 1.3710332/1.9604 = 0.6993640 → **0.69936**

**Sex/Female: k = 2 (P02, P07), n = 4 (P02, P04, P07, P09).**
- p = 0.5 → risk = **0.50000**
- center = 0.5 + 0.4802 = 0.9802000
- p(1−p)/n = 0.25/4 = 0.0625000; + 0.0600250 = 0.1225250
- half = 1.96·√0.1225250 = 1.96·0.3500357 = 0.6860700
- w = 1.9604000
- ci_low = (0.9802 − 0.68607)/1.9604 = 0.2941300/1.9604 = 0.1500357 → **0.15004**
- ci_high = (0.9802 + 0.68607)/1.9604 = 1.6662700/1.9604 = 0.8499643 → **0.84996**
  (check: p = 0.5 ⇒ low + high = 2·center/w = 1.9604/1.9604 = 1 ✓)

**Age band/45-54: k = 3 (P02 45, P03 50, P07 50), n = 3.**
- p = 1 → risk = **1.00000**  (k = n boundary case)
- center = 1 + 3.8416/6 = 1.6402667
- p(1−p)/n = 0; z²/(4n²) = 3.8416/36 = 0.1067111; half = 1.96·√0.1067111 = 1.96·(1.96/6) = 0.6402667
- w = 1 + 3.8416/3 = 2.2805333
- ci_low = (1.6402667 − 0.6402667)/2.2805333 = 1/2.2805333 = 0.4384939 → **0.43849**
- ci_high = (1.6402667 + 0.6402667)/2.2805333 = 2.2805334/2.2805333 = 1.0000000 → **1.00000**

**Age band/55-64: k = 0, n = 4 (P04 55, P05 60, P08 55, P09 60).**
- p = 0 → risk = **0.00000**  (k = 0 boundary case)
- center = 0.4802000; half = 1.96·√(0 + 0.0600250) = 1.96·0.2450000 = 0.4802000
- ci_low = 0/1.9604 = 0.0000000 → **0.00000** (exact: center = half when p = 0)
- ci_high = 0.9604/1.9604 = 0.4899000 → **0.48990**  (= (z²/n)/(1 + z²/n) = 2401/4901)

**Age band/65+: k = 0, n = 1 (P10 65).**
- p = 0 → risk = **0.00000**
- center = 3.8416/2 = 1.9208000; half = 1.96·√(3.8416/4) = 1.96·0.98 = 1.9208000
- w = 4.8416000
- ci_low = 0 → **0.00000**; ci_high = 3.8416/4.8416 = 0.7934567 → **0.79346**

**Index year/2019: k = 3, n = 8** — same members as Overall:
risk **0.37500**, CI (**0.13684**, **0.69426**).

### 7.4 Gold table (the new EXPECTED block + run.ts assertions)

Row count = 7 (1 Overall + 2 sex + 3 age bands + 1 year), `ORDER BY stratifier,
stratum`. Every row also asserts `at_risk`, `denominator`, `n_incomplete = 0`,
`ci_method = 'wilson'`, `risk_method = 'complete_followup'`, `horizon_days = 365`.

| stratifier | stratum | patients | at_risk | denominator | n_incomplete | risk | ci_low | ci_high |
|---|---|---|---|---|---|---|---|---|
| Overall | Overall | 3 | 8 | 8 | 0 | 0.37500 | 0.13684 | 0.69426 |
| Sex | Male | 1 | 4 | 4 | 0 | 0.25000 | 0.04559 | 0.69936 |
| Sex | Female | 2 | 4 | 4 | 0 | 0.50000 | 0.15004 | 0.84996 |
| Age band | 45-54 | 3 | 3 | 3 | 0 | 1.00000 | 0.43849 | 1.00000 |
| Age band | 55-64 | 0 | 4 | 4 | 0 | 0.00000 | 0.00000 | 0.48990 |
| Age band | 65+ | 0 | 1 | 1 | 0 | 0.00000 | 0.00000 | 0.79346 |
| Index year | 2019 | 3 | 8 | 8 | 0 | 0.37500 | 0.13684 | 0.69426 |

Cross-checks worth asserting as invariants: per-stratifier Σat_risk = Overall
at_risk (Sex 4+4 = 8; Age 3+4+1 = 8; Year 8); patients ≤ denominator ≤ at_risk on
every row; Overall at_risk = the incidence module's Overall `denominator` (8) —
same washout, same at-risk set, cross-module consistency.

### 7.5 Zero-denominator guard vectors (modified-spec check, §8)

`verifyCumincIncompleteGuard()` runs a COPY of Gold A with only the cuminc
analysis mutated: `horizonDays: 730`, `censorAt: ["outcome","disenrollment",
"study_end"]`, no `maxFollowupDays`. Hand derivation:
`horizon_date = 2019-01-01 + 730 = 2020-12-31` (365 + 365; 2020 is a leap year);
`admin_censor = LEAST(2020-06-30, 2020-12-31) = 2020-06-30 < horizon` for ALL 8
⇒ `has_full = 0` everywhere ⇒ every row (Overall + 6 strata, still 7 rows):

| quantity | value | what it proves |
|---|---|---|
| at_risk (Overall) | 8 | washout unaffected by horizon |
| denominator | 0 | completeness restriction bites |
| patients | 0 | strict rule: P02/P03/P07's OBSERVED events do NOT count when follow-up is incomplete (is_case requires has_full) — the strictness is loud, not hidden |
| n_incomplete | 8 | exclusion surfaced |
| risk, ci_low, ci_high | NULL (SQL) / `.` (SAS) | NULLIF/`if denominator > 0` guards: no division error, no fake 0 |

---

## 8. Fixture extension — additive rows needed: **none (zero data rows)**

The 12 patients, their events, enrollment spans, drug claims, and the redbook
rows are all UNTOUCHED — `fixtureSeedSql()` stays byte-identical. The extension
is spec + expectation only:

1. Append `a_cuminc` (§7 parameters) to `GOLD_A_SPEC.analyses` **after**
   `a_incidence`.
2. Add an `EXPECTED.cuminc` block carrying §7.4 (Overall row references the
   existing pinned `EXPECTED.cumulativeIncidence` / `EXPECTED.wilsonCi`
   constants rather than re-typing them).
3. Add run.ts assertions + `verifyCumincIncompleteGuard()` (§7.5), modeled on
   the existing `verifyDaysPerYearChoice()` modified-spec pattern.

Non-interference proof:

- **No seeded table changes** ⇒ every number derived from data is unchanged by
  construction.
- **Emission is append-only.** Both emitters dispatch modules in spec order:
  SQL numbers module files `String(7 + i)` ⇒ `07_incidence.sql` keeps its path
  and `08_cuminc.sql` is new; SAS numbers `(8 + i) * 10` ⇒ `080_incidence.sas`
  keeps its path and `090_cuminc.sas` is new. Files 01–06 / 000–070 do not read
  `spec.analyses` beyond the module loop, so they are byte-identical.
- **No table-name collisions.** Per-kind `multi` counts stay 1 for both kinds ⇒
  no suffixes; `tz_study_incidence` untouched; `tz_study_cuminc` is written only
  by the new file, and no existing file references it.
- **Every existing gold assertion reads a table the new module does not write**
  (`tz_study_index/enrolled/cohort/incidence`); the parity harness's
  expected-stamp count derives from the registry, so it grows in lockstep on
  both languages.
- **The guard check runs a spec COPY in a fresh PGlite instance** (same as
  `verifyDaysPerYearChoice`) — no shared state with the Gold A run.
- Empirical seal: run `npm run verify` with ONLY the registry + fixture + run.ts
  changes staged — all pre-existing checks must stay green before the new
  assertions are trusted.

---

## 9. Output table schema — one row per stratum incl. Overall

SQL `${wp}_cuminc${suffix}` / SAS `tz.&tag._<num>_cuminc${suffix}`; presentation
order `stratifier, stratum` in both languages.

| column | SQL type | SAS type | contents |
|---|---|---|---|
| `measure` | VARCHAR | char $20 | constant `'cumulative_incidence'` |
| `stratifier` | VARCHAR | char $40 | `'Overall'` or `stratLabel(s.label)` (40-char cap, shared) |
| `stratum` | VARCHAR | char $40 | `'Overall'` or shared-label stratum value (`Male`, `45-54`, `2019`, …) |
| `patients` | BIGINT | num | incident cases in (index, index+T] among complete-follow-up patients (Σ is_case) |
| `at_risk` | BIGINT | num | post-washout at-risk N (COUNT(*)) |
| `denominator` | BIGINT | num | complete-follow-up N = the risk/CI denominator (Σ has_full) |
| `n_incomplete` | BIGINT | num | `at_risk − denominator` (censored before horizon; excluded, surfaced) |
| `risk` | NUMERIC, 5 dp | num, round 1e-5 | k/n; NULL/`.` when denominator = 0 |
| `ci_low` | NUMERIC, 5 dp | num | Wilson lower bound; NULL/`.` when denominator = 0 |
| `ci_high` | NUMERIC, 5 dp | num | Wilson upper bound; NULL/`.` when denominator = 0 |
| `ci_method` | VARCHAR | char $16 | `'wilson'` — the method ACTUALLY computed |
| `risk_method` | VARCHAR | char $20 | `'complete_followup'` — the estimator ACTUALLY computed |
| `horizon_days` | INT | num | `an.horizonDays`, stamped into every row |

Small-N / degenerate behavior (both sides, no errors, no NULL surprises):

| situation | behavior |
|---|---|
| denominator = 0, at_risk > 0 | patients = 0 (is_case ⊆ has_full); risk/ci NULL (SQL `NULLIF`) / `.` (SAS `if denominator > 0` guard). Verified by §7.5. |
| at_risk = 0 (everyone prevalent) | Overall row still exists: at_risk = 0; patients/denominator NULL (SUM over zero rows) ⇒ risk/ci NULL — the same convention the incidence twin exhibits; stratum branches emit no rows (GROUP BY over empty). |
| k = 0 | risk 0.00000; ci_low exactly 0 (center = half when p = 0); ci_high = (z²/n)/(1+z²/n) > 0 — valid one-sided width. Verified by strata 55-64 and 65+. |
| k = n | risk 1.00000; ci_high 1.00000; ci_low > 0. Verified by stratum 45-54. |
| empty stratum level | no row (GROUP BY semantics, both languages — identical row sets). |
| `maxFollowupDays < horizonDays` | denominator provably 0 ⇒ NULL risk + the §6 REVIEW limitation announcing it. |

---

## 10. Integration checklist — files to touch, in order

1. **`packages/core/src/emitters/modules/cumulative-incidence.ts`** (new): export
   `cumulativeIncidenceModule: AnalysisModule<CumulativeIncidenceAnalysis>` with
   `analysisKind: "cumulative_incidence"`, `stampKind: "cuminc"`, twin
   `sqlCuminc`/`sasCuminc` (§3/§4), and module-local `CumincParity`,
   `cumincParity()`, `cumincLimitations()` (§5/§6). Imports ONLY from
   `../../spec/types`, `../types`, `./types`, `../sql-base`, `../sas-base`,
   `../parity` — zero edits to shared emitter files.
2. **`packages/core/src/emitters/modules/registry.ts`**: one line —
   `cumulative_incidence: cumulativeIncidenceModule as AnalysisModule<never>`.
   (This alone wires SQL file 08+, SAS program 090+, and parity-stamp
   enrollment.)
3. **`packages/core/src/verify/parity.ts`**: add the `cuminc` `SIGNATURES` entry
   (§4) so a rewritten Wilson/horizon formula fails verification even with
   matching stamps.
4. **`packages/core/src/verify/fixture.ts`**: append `a_cuminc` to
   `GOLD_A_SPEC.analyses` (after `a_incidence`); add the `EXPECTED.cuminc` block
   (§7.4) referencing the pre-pinned `cumulativeIncidence`/`wilsonCi` constants.
   NO changes to DDL, ENROLL, DRUG, AE, or redbook rows.
5. **`packages/core/src/verify/run.ts`**: in `verifyGoldA()` assert the Overall
   row (patients/at_risk/denominator/n_incomplete/risk/ci vs EXPECTED, risk & CI
   tol 0.00001), all 6 stratum rows, row count 7, and the §7.4 cross-module
   invariant (cuminc Overall at_risk = incidence Overall denominator); add
   `verifyCumincIncompleteGuard()` (§7.5) and call it wherever
   `verifyDaysPerYearChoice()` is called.
6. **Run `npm run verify` twice**: once with only steps 1–3 staged (all existing
   golds must stay green with the new module emitting — non-interference seal),
   then with steps 4–5 (new golds + guard + parity stamps all green).
7. Update `docs/COVERAGE-MATRIX.md` row "Cumulative incidence (risk)" status
   → done (complete-follow-up route; KM/CIF routes still declared-not-emitted).
