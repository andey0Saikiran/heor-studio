# period_prevalence module blueprint

Module: `src/emitters/modules/period-prevalence.ts` · analysisKind `"period_prevalence"` · stampKind `"period_prevalence"`
Shape: exact twin of the reference module `modules/incidence.ts` (twin sql()/sas(), PARITY stamp,
REVIEW limitation notes, shared stratum labels from `emitters/parity.ts`, gold truth in `verify/fixture.ts`,
assertions in `verify/run.ts`).

---

## 1. Method — precise definition + literature refs

**Period prevalence** = the proportion of a defined population that has the condition at any time
during a fixed calendar interval `[start, end]`:

```
period prevalence = m / N
  m = members of the denominator with >= 1 qualifying outcome claim DATED inside [start, end]
  N = members enrolled at ANY time inside [start, end]  (denominatorRule "enrolled_anytime")
```

- Rothman KJ, Greenland S, Lash TL. *Modern Epidemiology*, 3rd ed., Lippincott 2008 — ch. 3
  "Measures of Occurrence", prevalence §pp. 45–48 (prevalence pool; period prevalence mixes point
  prevalence at the period start with incidence during the period).
- CDC. *Principles of Epidemiology in Public Health Practice*, 3rd ed. (2012), Lesson 3 §2:
  period prevalence = cases present during an interval ÷ population during the interval.
- Wilson EB. Probable inference, the law of succession, and statistical inference.
  *JASA* 1927;22(158):209–212 — the score interval computed here.
- Newcombe RG. Two-sided confidence intervals for the single proportion: comparison of seven
  methods. *Stat Med* 1998;17(8):857–872 — Wilson recommended over Wald (boundary degeneracy)
  and over exact (over-coverage); the basis for making Wilson the closed-form default.
- Brown LD, Cai TT, DasGupta A. Interval estimation for a binomial proportion.
  *Statist Sci* 2001;16(2):101–133 — Wald coverage failure at small n / extreme p.
- DOMAIN-RULES.md §3 — practitioner rule: for **prevalence**, patients with the condition during
  baseline **are included** in the denominator (no washout, no at-risk removal). This module keeps
  baseline-prevalent cohort members in the denominator (fixture: P01/P06 stay in N).

### Three pinned design decisions (each labeled in the output, stamped in PARITY)

**D1 — Denominator = final study cohort ∩ enrolled-anytime-in-period (`denominator_rule = 'enrolled_anytime'`).**
A member contributes to N iff any *stitched* enrollment episode overlaps the period by >= 1 day
(`episode_start <= period_end AND episode_end >= period_start`). The universe is the **final
analysis cohort** (`{wp}_cohort` / `ctx.finalCohort`) — not all plan members — because the spine
pulls enrollment only for indexed patients (040 inner-joins to 030_index), so a whole-plan
denominator is not constructible from the spine in either language; a cohort-conditional
denominator is the only parity-safe choice, and it is what a protocol targeting an indexed cohort
means. **Panel-churn warning (loud, always emitted):** MarketScan is an open employer panel with
annual turnover (COVERAGE-MATRIX "Honest gaps": convenience-sample denominator). Under
`enrolled_anytime`, partial-period enrollees enter N with < full-period claims observation; less
observation time means fewer chances to observe a qualifying claim, so the estimate is
**conservative (biased down)** versus a fully-enrolled denominator, and the estimate moves whenever
the denominator rule moves. The rule actually used is a column in every output row.
(A `minEnrollmentDaysInPeriod` floor is a planned V2 spec field — see §6.)

**D2 — Numerator = event dated inside the period; NO carry-in (`numerator_rule = 'event_in_period'`).**
A case must have >= 1 qualifying claim with `event_date`/`svcdate` inside `[start, end]`. A member
whose only qualifying claims predate the period is NOT counted, even though clinically they may
remain prevalent. Justification: (a) claims can only ascertain disease when care is observed —
counting carry-in requires an active-lookback window and chronicity assumption the V1
`PeriodPrevalenceAnalysis` schema does not carry (no `countCarryInFromBefore` /
`activeLookbackWindow` field exists to consume); (b) "claims-observed period prevalence" is the
standard administrative-data estimand; (c) it is deterministic and hand-verifiable. The choice is
labeled in the `numerator_rule` output column, stamped in PARITY, and re-stated in an always-on
REVIEW note (undercount of true clinical prevalence). Fixture patients P01/P06 (baseline-only
events) are denominator-only — the vectors in §7 pin this behavior.

**D3 — CI = Wilson score, 95%, z = 1.96, computed identically in both twins (`ci_method = 'wilson'`).**
With n = denominator, x = patients (cases), p̂ = x/n, z = 1.96 (z² = 3.8416, z²/2 = 1.9208,
z²/4 = 0.9604):

```
adj    = 1 + 3.8416/n
center = p̂ + 1.9208/n
half   = 1.96 * sqrt( p̂(1-p̂)/n + 0.9604/n² )
low    = max(0, (center - half) / adj)        high = min(1, (center + half) / adj)
```

Wilson is exactly closed-form (SQL-native per spec/types.ts §ANALYSIS LAYER), never degenerate:
at x = 0 it gives low = 0 with a valid positive upper bound; at x = n it gives high = 1. The
max/min clamps are mathematical no-ops that guard float dust only, applied identically in both
languages. Requested `clopper_pearson` (needs a beta inverse — SAS-only) or `wald` are NOT
computed; Wilson is produced and the output says `wilson` (honest labeling), with a REVIEW note.

**Small-N / degenerate behavior (both twins, byte-equivalent):**
- x = 0 in a stratum → prevalence 0.0000, CI (0.0000, upper > 0). No division error (Wilson never
  divides by x).
- n = 0 (nobody enrolled in the period) → the Overall row is still emitted with
  patients = 0 (COALESCE/coalesce over the empty SUM), denominator = 0, and prevalence/ci_low/ci_high
  NULL (SQL) / `.` (SAS) via an explicit `denominator = 0` guard — no divide-by-zero on either side.
- Empty stratum level (no members) → the row is simply absent (GROUP BY over zero rows), matching
  the incidence module's behavior (fixture row counts pin this).
- `patients <= denominator` holds **by construction** (cases are selected FROM the denominator set),
  satisfying the num<=den invariant.

`spec.meta.daysPerYear` is **not consumed** — there is no person-time in this measure — so it does
not appear in the PARITY stamp (the stamp records only values actually consumed).

---

## 2. Spec consumption — the analysis interface verbatim + field-by-field mapping

From `src/spec/types.ts` (verbatim):

```ts
export interface PeriodPrevalenceAnalysis extends AnalysisCommon {
  kind: "period_prevalence";
  outcomeDefinition: OutcomeDefinition;
  caseStatus: "prevalent";
  prevalencePeriod: { start: string; end: string }; // ISO dates
  denominatorRule: "enrolled_anytime";
  ciMethod: ProportionCiMethod;
  stratifyBy: Stratifier[];
  referenceStratum?: string;
}
```

Supporting types consumed (verbatim):

```ts
export interface AnalysisCommon {
  id: string;                 // stable snake_case slug, UNIQUE within analyses[]
  label: string;              // human title shown in the review UI
  enabled: boolean;
  notes?: string;             // verbatim protocol/SAP text — never paraphrase
}

export interface OutcomeDefinition {
  codeListId: string;         // -> CodeList.id (may be an empty list awaiting lookup)
  minClaims: number;          // >= 1 qualifying claims to count as a case
  claimSeparationDays?: number; // required when minClaims >= 2
  setting: CareSetting;
  diagnosisPosition: "any" | "primary"; // DX1/principal vs any DXn
}

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

| Spec field | How the twins consume it |
|---|---|
| `id` | PARITY stamp `id`; suffix source when several period_prevalence analyses exist |
| `label` | file titles, SAS `title`, header comments (quote-escaped) |
| `enabled` | registry filter (`moduleAnalyses`) — disabled analyses never emit |
| `notes` | review-UI only; not emitted (matches incidence) |
| `outcomeDefinition.codeListId` | SQL: `WHERE code_list_id = '<id>'` on `{wp}_events`; SAS: `ctx.evOf(codeListId)` |
| `outcomeDefinition.minClaims` | V1: NOT enforced when > 1 → REVIEW limitation (matches incidence) |
| `outcomeDefinition.claimSeparationDays` | V1: NOT enforced (only meaningful with minClaims >= 2) → covered by the minClaims limitation |
| `outcomeDefinition.setting` | V1: NOT applied when != "any" → REVIEW limitation |
| `outcomeDefinition.diagnosisPosition` | V1: NOT applicable — dx position is not preserved in the spine event tables → REVIEW limitation when "primary" |
| `caseStatus` | pinned `"prevalent"` by the type; stamped; drives D1 (no washout, prevalent members stay in N per DOMAIN-RULES §3) |
| `prevalencePeriod.start/end` | SQL `DATE '<iso>'` literals; SAS `'ddMONyyyy'd` literals (module-local ISO→SAS-date helper); stamped verbatim; generation-time REVIEW warning if the period extends outside `spec.meta.studyPeriod` (events outside the study period are unobservable — build02 bounds `{wp}_events`) |
| `denominatorRule` | pinned `"enrolled_anytime"`; rendered as the episode-overlap join (D1); stamped; emitted as the `denominator_rule` output column |
| `ciMethod` | `"wilson"` → computed; `"clopper_pearson"`/`"wald"` → Wilson computed anyway, labeled `wilson`, REVIEW limitation emitted |
| `stratifyBy` | `splitStratifiers()` — demographic axes emitted with shared `SEX_LABELS`/`REGION_LABELS`/`ageBandLabels`/`stratLabel`; baseline-sourced strata → REVIEW limitation (matches incidence) |
| `referenceStratum` | V1: NOT implemented (no prevalence-ratio/difference output) → REVIEW limitation when set |

Validation already enforced upstream (`validateAnalyses`): codeListId exists, `minClaims >= 1`,
`minClaims >= 2` requires `claimSeparationDays`, stratifier ids unique, `referenceStratum` ∈
`stratifyBy`, and `prevalencePeriod.start/end` non-empty.

---

## 3. SQL twin — the COMPLETE CTE chain (Postgres-16/PGlite-executable)

Reads ONLY spine work tables: `{wp}_cohort` (build05: enrolid, index_date, index_code),
`{wp}_events` (build02: enrolid, event_date, event_type, setting, code_list_id, code),
`{wp}_enroll_episodes` (build04: enrolid, episode_id, episode_start, episode_end, n_segments),
plus raw enrollment via `ctx.t("enrollment_detail")` for stratum demographics (same rn=1 pattern
as incidence). Snowflake portability ONLY through Dialect helpers: `d.createTableAs`, `d.roundN`,
`d.year` (`DATE '<iso>'` literals, `CASE`, `LEAST`/`GREATEST`, `SQRT` are portable in both
dialects). Placeholders: `${wp}` work prefix, `${suffix}` multi-analysis suffix, `${clid}` =
`an.outcomeDefinition.codeListId`, `${PP_START}`/`${PP_END}` = `an.prevalencePeriod`, `${Y? }` none
(no daysPerYear). `strat_i` blocks repeat per supported stratifier exactly as in incidence
(`stratExpr` reused verbatim from the incidence pattern: sex/region/plan_type/year/age_band with
`ageExpr = ${d.year("index_date")} - dobyr`).

```sql
-- PARITY period_prevalence {"caseStatus":"prevalent","ciMethod":"wilson","codeListId":"${clid}",...}
-- REVIEW - spec options this program does not implement yet:        (conditional; see §6)
--   * ...
-- REVIEW - method notes (read before interpreting):                 (ALWAYS emitted; see §6)
--   * DENOMINATOR (enrolled_anytime): ... panel churn ...
--   * NUMERATOR (event_in_period): ... no carry-in ...
--   * STRATA anchored at the INDEX date ...
DROP TABLE IF EXISTS ${wp}_period_prev${suffix};
CREATE TABLE ${wp}_period_prev${suffix} AS
WITH cohort AS (SELECT enrolid, index_date FROM ${wp}_cohort),
enrolled AS (   -- denominator: >= 1 stitched enrollment day inside ${PP_START}..${PP_END}
  SELECT DISTINCT c.enrolid, c.index_date
  FROM cohort c
  JOIN ${wp}_enroll_episodes ep
    ON ep.enrolid = c.enrolid
   AND ep.episode_start <= DATE '${PP_END}'
   AND ep.episode_end   >= DATE '${PP_START}'
),
ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${q(clid)}'),
cases AS (   -- numerator: >= 1 qualifying event DATED inside the period (no carry-in)
  SELECT DISTINCT d.enrolid
  FROM enrolled d
  JOIN ae a ON a.enrolid = d.enrolid
  WHERE a.event_date >= DATE '${PP_START}'
    AND a.event_date <= DATE '${PP_END}'
),
demo AS (   -- [only when a non-'year' stratifier exists] enrollment segment in force at
            -- (or latest before) index; rn=1 wins — SAME source + tie-break as incidence
  SELECT c.enrolid, en.dobyr, en.sex, en.region, en.plantyp,
         ROW_NUMBER() OVER (PARTITION BY c.enrolid
                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn
  FROM enrolled c
  JOIN ${ctx.t("enrollment_detail")} en
    ON en.enrolid = c.enrolid
   AND en.dtstart <= c.index_date
),
demo1 AS (SELECT enrolid, dobyr, sex, region, plantyp FROM demo WHERE rn = 1),
flags0 AS (
  SELECT d.enrolid, d.index_date,
         CASE WHEN k.enrolid IS NOT NULL THEN 1 ELSE 0 END AS is_case,
         dm.dobyr, dm.sex, dm.region, dm.plantyp          -- [when needDemo]
  FROM enrolled d
  LEFT JOIN cases k ON k.enrolid = d.enrolid
  LEFT JOIN demo1 dm ON dm.enrolid = d.enrolid            -- [when needDemo]
),
flags AS (
  SELECT is_case,
         ${stratExpr(s0)} AS strat_0,                     -- [repeat per supported stratifier]
         ${stratExpr(s1)} AS strat_1
  FROM flags0
),
summ AS (
  SELECT 'period_prevalence' AS measure, 'Overall' AS stratifier, 'Overall' AS stratum,
         COALESCE(SUM(is_case), 0) AS patients, COUNT(*) AS denominator
  FROM flags
  UNION ALL                                               -- [repeat per supported stratifier]
  SELECT 'period_prevalence', '${q(stratLabel(s.label))}', strat_i,
         COALESCE(SUM(is_case), 0), COUNT(*)
  FROM flags GROUP BY strat_i
)
SELECT measure, stratifier, stratum, patients, denominator,
       CASE WHEN denominator = 0 THEN NULL
            ELSE ${d.roundN(`patients * 1.0 / denominator`, 4)} END AS prevalence,
       -- Wilson 95% score interval (Wilson JASA 1927;22:209): z=1.96, z^2=3.8416,
       -- z^2/2=1.9208, z^2/4=0.9604. Clamps are float-dust guards (mathematical no-ops).
       CASE WHEN denominator = 0 THEN NULL
            ELSE ${d.roundN(
              `GREATEST(0.0, ((patients * 1.0 / denominator) + 1.9208 / denominator
                 - 1.96 * SQRT((patients * 1.0 / denominator) * (1 - patients * 1.0 / denominator) / denominator
                               + 0.9604 / (denominator * denominator)))
                 / (1 + 3.8416 / denominator))`, 4)} END AS ci_low,
       CASE WHEN denominator = 0 THEN NULL
            ELSE ${d.roundN(
              `LEAST(1.0, ((patients * 1.0 / denominator) + 1.9208 / denominator
                 + 1.96 * SQRT((patients * 1.0 / denominator) * (1 - patients * 1.0 / denominator) / denominator
                               + 0.9604 / (denominator * denominator)))
                 / (1 + 3.8416 / denominator))`, 4)} END AS ci_high,
       -- labeled with the method actually computed, never the merely-requested one
       'wilson' AS ci_method,
       'event_in_period' AS numerator_rule,
       'enrolled_anytime' AS denominator_rule
FROM summ;

-- REVIEW: period prevalence over ${PP_START}..${PP_END}, Overall + per stratum.
SELECT * FROM ${wp}_period_prev${suffix}
ORDER BY stratifier, stratum;
```

Notes for the implementer:
- `patients * 1.0 / denominator` — the `* 1.0` is mandatory: SUM/COUNT are integers and bare
  `patients / denominator` is integer division in Postgres (the exact bug class recorded in
  `renderDaysPerYear`'s doc comment). This token is also a parity arithmetic signature (§5).
- `CASE WHEN denominator = 0` short-circuits before any division — no divide-by-zero in PG or
  Snowflake.
- `SqlModuleFile`: slug `period_prev${suffix}`, title `NN Period prevalence`, subtitle
  `"period prevalence (enrolled-anytime denominator) + Wilson CI"`, extra line naming the analysis
  id, code list, and period.

---

## 4. SAS twin — the COMPLETE program mirroring the SQL arithmetic

Reads the SAS spine equivalents: `ctx.finalCohort` (enrolid, index_date, …), `ctx.evOf(clid)`
(enrolid, svcdate, setting, …), `ctx.tbl("050_epi")` (enrolid, episode, dtstart, dtend),
`ctx.tbl("040_enroll")` (enrolid, dtstart, dtend, rx, plantyp, sex, region, dobyr).
`${outT}` = `ctx.tbl(`${num}_period_prev${suffix}`)`. Period dates rendered by a module-local
ISO→`'ddMONyyyy'd` helper (kept local so the module touches no shared emitter core).
`stratAssign` reused verbatim from the incidence pattern (shared SEX_LABELS/REGION_LABELS/
ageBandLabels — byte-identical stratum values across languages).

```sas
/*  header(spec, "${num}_period_prev${suffix}.sas", [
      Period prevalence over ${PP_START}..${PP_END} for "${an.label}":
      denominator = final-cohort members enrolled ANYTIME in the period,
      numerator = >= 1 qualifying claim DATED inside the period (no carry-in),
      Wilson 95% score CI. Twin of the machine-verified SQL period_prev;
      keep both in sync. ])  */
/* PARITY period_prevalence {...same stableJson as the SQL twin...} */

/* REVIEW - spec options this program does not implement yet:   (conditional; §6) */
/* REVIEW - method notes: denominator churn / no carry-in / index-anchored strata (ALWAYS; §6) */

%include "00_setup.sas";   /* EDIT: use the full site path to 00_setup.sas */

proc datasets lib=tz nolist nowarn;
  delete ${outT minus "tz."};
quit;

/*----------------------------------------------------------------------------
  Denominator (enrolled_anytime): >= 1 day of stitched enrollment inside
  ${PP_START}..${PP_END}. Cohort-conditional - see the method notes above.
----------------------------------------------------------------------------*/
proc sql;
  create table work._${num}_den as
  select distinct a.enrolid, a.index_date
  from ${cohT} as a
  inner join ${epiT} as ep
    on  ep.enrolid = a.enrolid
    and ep.dtstart <= '${sasDate(PP_END)}'d
    and ep.dtend   >= '${sasDate(PP_START)}'d;
quit;

title "Level check: work._${num}_den (period denominator)";
proc sql;
  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt
  from work._${num}_den;
quit;

/*-------------------- numerator: event DATED inside the period --------------*/
proc sql;
  create table work._${num}_cases as
  select distinct a.enrolid
  from work._${num}_den as a
  inner join ${evT} as e
    on  e.enrolid = a.enrolid
    and e.svcdate >= '${sasDate(PP_START)}'d
    and e.svcdate <= '${sasDate(PP_END)}'d;
quit;

/* [when needDemo] stratum demographics from the enrollment segment in force at
   (or latest before) index - SAME source and tie-break as the SQL twin */
proc sql;
  create table work._${num}_dm0 as
  select a.enrolid, b.dobyr, b.sex, b.region, b.plantyp,
         b.dtstart as seg_start, b.dtend as seg_end
  from work._${num}_den as a
  left join ${ctx.tbl("040_enroll")} as b
    on  b.enrolid = a.enrolid
    and b.dtstart <= a.index_date;
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

/*-------------------- case flag + strata ------------------------------------*/
proc sql;
  create table work._${num}_fl0 as
  select a.enrolid, a.index_date,
         case when k.enrolid is not null then 1 else 0 end as is_case
         [, dm.dobyr, dm.sex, dm.region, dm.plantyp]      /* when needDemo */
  from work._${num}_den as a
  left join work._${num}_cases as k on k.enrolid = a.enrolid
  [left join work._${num}_dm as dm on dm.enrolid = a.enrolid];
quit;

data work._${num}_fl;
  set work._${num}_fl0;
  length strat_0 strat_1 ... $40;
  /* enrollment-derived age (year - DOBYR), matching the SQL twin  [when age_band] */
  age_at_index = year(index_date) - dobyr;
  /* stratifier: <label> (<axis>) — stratAssign(), shared labels */
  ...
run;

...levelCheck(work._${num}_fl, "denominator rows", ["sum(is_case) as cases"])...

/*----------------------------------------------------------------------------
  Period prevalence + Wilson 95% score CI - the SAME closed form as the SQL
  twin (Wilson JASA 1927;22:209), so both languages agree to the last rounded
  digit:  z = 1.96, z^2 = 3.8416, z^2/2 = 1.9208, z^2/4 = 0.9604
    low  = max(0, (p + 1.9208/n - 1.96*sqrt(p(1-p)/n + 0.9604/n^2)) / (1 + 3.8416/n))
    high = min(1, (p + 1.9208/n + 1.96*sqrt(p(1-p)/n + 0.9604/n^2)) / (1 + 3.8416/n))
----------------------------------------------------------------------------*/
proc sql;
  create table work._${num}_summ as
  select 'Overall' as stratifier length=40,
         'Overall' as stratum length=40,
         count(*) as denominator,
         coalesce(sum(is_case), 0) as patients
  from work._${num}_fl
  union all                                    /* repeat per supported stratifier */
  select '${sq(stratLabel(s.label))}', strat_j,
         count(*), coalesce(sum(is_case), 0)
  from work._${num}_fl group by strat_j
  ;
quit;

data ${outT};
  set work._${num}_summ;
  length measure $20 ci_method $16 numerator_rule $20 denominator_rule $20;
  measure          = 'period_prevalence';
  /* labeled with the method actually computed, never the merely-requested one */
  ci_method        = 'wilson';
  numerator_rule   = 'event_in_period';
  denominator_rule = 'enrolled_anytime';
  if denominator > 0 then do;
    phat = patients / denominator;
    _w_half = 1.96 * sqrt(phat * (1 - phat) / denominator + 0.9604 / (denominator * denominator));
    prevalence = round(phat, 0.0001);
    ci_low  = round(max(0, (phat + 1.9208 / denominator - _w_half) / (1 + 3.8416 / denominator)), 0.0001);
    ci_high = round(min(1, (phat + 1.9208 / denominator + _w_half) / (1 + 3.8416 / denominator)), 0.0001);
  end;
  else do;
    prevalence = .;
    ci_low  = .;
    ci_high = .;
  end;
  drop phat _w_half;
run;

/* same presentation order as the SQL twin's REVIEW query */
proc sort data=${outT};
  by stratifier stratum;
run;

title "Period prevalence ${PP_START}..${PP_END}: ${label}";
proc print data=${outT} noobs;
  var measure stratifier stratum patients denominator prevalence
      ci_low ci_high ci_method numerator_rule denominator_rule;
run;
```

Arithmetic-mirror notes: SAS `/` is float division natively, so `patients / denominator` matches
SQL's `patients * 1.0 / denominator` exactly; `coalesce(sum(is_case), 0)` mirrors SQL `COALESCE`
for the empty-denominator Overall row; the `denominator > 0` guard mirrors the SQL `CASE`;
`round(x, 0.0001)` mirrors `d.roundN(x, 4)`.

---

## 5. Parity record — exact stamped fields

Add to `emitters/parity.ts` (alongside `incidenceParity`; no edits to existing code):

```ts
/** The parameter set a period-prevalence twin must consume identically. */
export interface PeriodPrevalenceParity {
  id: string;
  codeListId: string;
  period: { start: string; end: string }; // prevalencePeriod, verbatim ISO
  denominatorRule: "enrolled_anytime";    // the rule actually rendered (D1)
  numeratorRule: "event_in_period";       // the rule actually rendered (D2)
  caseStatus: "prevalent";
  ciMethod: string;                       // the method actually computed = "wilson"
  /** strata the twin actually emitted (id/axis/bands), in spec order */
  strata: SupportedStratifier[];
}

export function periodPrevalenceParity(
  an: PeriodPrevalenceAnalysis,
  consumed: { strata: SupportedStratifier[] }
): PeriodPrevalenceParity {
  return {
    id: an.id,
    codeListId: an.outcomeDefinition.codeListId,
    period: { start: an.prevalencePeriod.start, end: an.prevalencePeriod.end },
    denominatorRule: "enrolled_anytime",
    numeratorRule: "event_in_period",
    caseStatus: "prevalent",
    ciMethod: "wilson", // what the twins actually compute (limitations make this loud)
    strata: consumed.strata,
  };
}
```

`daysPerYear` is deliberately absent (not consumed — no person-time). Example stamp for Gold-A
`pp_2019` (stableJson, both languages byte-identical):

```
PARITY period_prevalence {"caseStatus":"prevalent","ciMethod":"wilson","codeListId":"ae_dx","denominatorRule":"enrolled_anytime","id":"pp_2019","numeratorRule":"event_in_period","period":{"end":"2019-12-31","start":"2019-01-01"},"strata":[{"axis":"sex","id":"s_sex","label":"Sex"},{"axis":"age_band","bands":[0,18,35,45,55,65],"id":"s_age","label":"Age band"},{"axis":"year","id":"s_year","label":"Index year"}]}
```

Arithmetic signatures for `verify/parity.ts` `SIGNATURES` (formula-tamper detection; the module
must render these tokens verbatim):

```ts
period_prevalence: {
  sql: [
    "patients * 1.0 / denominator",          // float division, not integer
    "1.9208 / denominator",                  // z^2/2 term
    "0.9604 / (denominator * denominator)",  // z^2/4 / n^2 term
    "1 + 3.8416 / denominator",              // 1 + z^2/n adjuster
    "1.96 * SQRT(",                          // z * score half-width
  ],
  sas: [
    "patients / denominator",
    "1.9208 / denominator",
    "0.9604 / (denominator * denominator)",
    "1 + 3.8416 / denominator",
    "1.96 * sqrt(",
  ],
},
```

---

## 6. Limitations — every unimplemented option + its REVIEW wording

`periodPrevalenceLimitations(an)` in `emitters/parity.ts` (emitted in BOTH languages, incidence
style — `-- REVIEW - spec options this program does not implement yet:` / `/* REVIEW - ... */`):

| Trigger | Exact wording |
|---|---|
| `od.minClaims > 1` | `outcome minClaims=${n} is NOT yet enforced - any single qualifying claim in the period counts as a case` |
| `od.setting !== "any"` | `outcome care-setting filter "${setting}" is NOT yet applied - events from all settings count` |
| `od.diagnosisPosition !== "any"` | `diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count` |
| `an.ciMethod !== "wilson"` | `ciMethod "${m}" is NOT implemented - the Wilson score interval is produced and labeled wilson` |
| each unsupported (baseline-sourced) stratifier | `stratifier "${s.id}" (${s.source.kind}-sourced) is NOT yet emitted - demographic axes only for now` |
| `an.referenceStratum` set | `referenceStratum "${id}" comparative output (prevalence ratio/difference) is NOT yet produced - per-stratum estimates only` |
| period outside study window (generation-time ISO string compare) | `prevalencePeriod extends outside the study period ${study.start}..${study.end} - events outside the study period are NOT in the event table, so prevalence in the overhang is structurally zero` |

**ALWAYS-emitted method notes** (not conditional — this is the loud panel-churn documentation the
measure requires; same text in both languages, `--`/block-comment wrapped):

```
REVIEW - method notes (read before interpreting):
  * DENOMINATOR (enrolled_anytime): final-cohort members with >= 1 day of stitched
    enrollment inside <start>..<end>. MarketScan is an open employer panel - membership
    turns over every year, so partial-period enrollees enter the denominator with less
    claims-observation time and fewer chances to show a qualifying claim: the estimate
    is conservative (biased DOWN) versus a fully-enrolled denominator, and it MOVES when
    the denominator rule moves. The rule used is stamped in every output row
    (denominator_rule column). A minimum-enrollment-days floor is a planned V2 option.
  * NUMERATOR (event_in_period): a case must have a qualifying claim DATED inside the
    period. Prevalent patients whose condition generates no claim inside the period are
    NOT counted (no carry-in from earlier claims) - this is claims-OBSERVED period
    prevalence, an undercount of true clinical prevalence.
  * STRATA are anchored at the INDEX date (age at index, index calendar year), not at
    the prevalence period.
```

---

## 7. Fixture vectors — patient-by-patient hand derivation

Gold Case A additions (§8): analysis `pp_2019` = period_prevalence of `ae_dx` over
**2019-01-01..2019-12-31**, stratified by the same three demographic stratifiers as the incidence
analysis (Sex; Age band [0,18,35,45,55,65]; Index year); and analysis `pp_h2_2020` over
**2020-07-01..2020-12-31** with `stratifyBy: []` (zero-denominator gold).

### 7.1 Patient walk (final cohort = P01..P10; P11 fails continuous enrollment, P12 fails age >= 18 — not in `{wp}_cohort`, therefore never in this module's denominator)

All cohort members index 2019-01-01. Stitched episodes from the fixture (rx='1' everywhere):

| Pt | Stitched episode | Overlaps 2019? | AE event (ae_dx) | Event in 2019? | is_case | Sex | dobyr | age@idx | Age band |
|---|---|---|---|---|---|---|---|---|---|
| P01 | 2018-01-01..2020-06-30 | yes | 2018-06-01 | **no** (before period) | 0 | Male | 1979 | 40 | 35-44 |
| P02 | 2018-01-01..2020-06-30 | yes | 2019-04-11 | yes | 1 | Female | 1974 | 45 | 45-54 |
| P03 | 2018-01-01..2020-06-30 | yes | 2019-07-20 | yes | 1 | Male | 1969 | 50 | 45-54 |
| P04 | 2018-01-01..2020-06-30 | yes | — | — | 0 | Female | 1964 | 55 | 55-64 |
| P05 | 2018-01-01..2020-06-30 | yes | — | — | 0 | Male | 1959 | 60 | 55-64 |
| P06 | 2018-01-01..2020-06-30 | yes | 2018-09-01 | **no** (before period) | 0 | Male | 1974 | 45 | 45-54 |
| P07 | 2018-01-01..2020-06-30 (2 segments, 20d gap <= 31 → ONE stitched episode) | yes | 2019-10-28 | yes | 1 | Female | 1969 | 50 | 45-54 |
| P08 | 2018-01-01..2020-06-30 | yes | — | — | 0 | Male | 1964 | 55 | 55-64 |
| P09 | 2018-01-01..2020-06-30 | yes | — | — | 0 | Female | 1959 | 60 | 55-64 |
| P10 | 2018-01-01..2020-06-30 | yes | — | — | 0 | Male | 1954 | 65 | 65+ |

- Denominator overlap check (every member): `episode_start 2018-01-01 <= 2019-12-31` ✓ and
  `episode_end 2020-06-30 >= 2019-01-01` ✓ → **N = 10** (all cohort members). Note this is the
  D1 contrast with incidence: P01/P06 (baseline-prevalent) are IN this denominator (DOMAIN-RULES
  §3), while the incidence at-risk denominator was 8.
- Numerator: events dated in 2019 → P02, P03, P07 → **m = 3**. P01/P06's 2018 events are the
  planted no-carry-in probes (D2): they contribute NOTHING to the numerator.
- P07 appears once despite two enrollment segments (DISTINCT + stitching probe).
- Age = index year − dobyr (2019 − dobyr), enrollment-derived — matches both twins' stratum source.
- Bands 0-17 and 18-34 have no members → rows absent. Row count = 1 Overall + 2 sex + 4 age bands
  + 1 year = **8 rows**.

### 7.2 Wilson arithmetic (z = 1.96, z² = 3.8416, z²/2 = 1.9208, z²/4 = 0.9604; every stored value rounded to 4dp)

Shared form: `adj = 1 + 3.8416/n`; `center = p̂ + 1.9208/n`;
`half = 1.96·sqrt(p̂(1−p̂)/n + 0.9604/n²)`; `low = (center−half)/adj`; `high = (center+half)/adj`.

**Overall — x=3, n=10, p̂ = 0.3 → prevalence 0.3000**
- adj = 1 + 0.38416 = 1.38416
- center = 0.3 + 0.19208 = 0.49208
- inside sqrt = 0.3·0.7/10 + 0.9604/100 = 0.021 + 0.009604 = 0.030604 → sqrt = 0.1749400
- half = 1.96 × 0.1749400 = 0.3428824
- low  = (0.49208 − 0.3428824)/1.38416 = 0.1491976/1.38416 = 0.1077893 → **0.1078**
- high = (0.49208 + 0.3428824)/1.38416 = 0.8349624/1.38416 = 0.6032268 → **0.6032**

**Sex / Male — x=1, n=6, p̂ = 0.1666667 → prevalence 0.1667**
- adj = 1 + 0.6402667 = 1.6402667
- center = 0.1666667 + 0.3201333 = 0.4868000
- inside sqrt = (0.1666667·0.8333333)/6 + 0.9604/36 = 0.0231481 + 0.0266778 = 0.0498259 → sqrt = 0.2232172
- half = 1.96 × 0.2232172 = 0.4375057
- low  = (0.4868000 − 0.4375057)/1.6402667 = 0.0492943/1.6402667 = 0.0300526 → **0.0301**
- high = (0.4868000 + 0.4375057)/1.6402667 = 0.9243057/1.6402667 = 0.5635094 → **0.5635**

**Sex / Female — x=2, n=4, p̂ = 0.5 → prevalence 0.5000**
- adj = 1 + 0.9604 = 1.9604
- center = 0.5 + 0.4802 = 0.9802
- inside sqrt = 0.25/4 + 0.9604/16 = 0.0625 + 0.060025 = 0.122525 → sqrt = 0.3500357
- half = 1.96 × 0.3500357 = 0.6860700
- low  = (0.9802 − 0.6860700)/1.9604 = 0.2941300/1.9604 = 0.1500357 → **0.1500**
- high = (0.9802 + 0.6860700)/1.9604 = 1.6662700/1.9604 = 0.8499643 → **0.8500**

**Age band / 35-44 — x=0, n=1, p̂ = 0 → prevalence 0.0000**
- adj = 4.8416; center = 0 + 1.9208 = 1.9208
- inside sqrt = 0 + 0.9604/1 = 0.9604 → sqrt = 0.98 (exact); half = 1.96 × 0.98 = 1.9208
- low  = (1.9208 − 1.9208)/4.8416 = 0 → **0.0000** (clamp is a no-op)
- high = (1.9208 + 1.9208)/4.8416 = 3.8416/4.8416 = 0.7934567 → **0.7935**

**Age band / 45-54 — x=3, n=4, p̂ = 0.75 → prevalence 0.7500**
- adj = 1.9604; center = 0.75 + 0.4802 = 1.2302
- inside sqrt = 0.75·0.25/4 + 0.9604/16 = 0.046875 + 0.060025 = 0.106900 → sqrt = 0.3269557
- half = 1.96 × 0.3269557 = 0.6408332
- low  = (1.2302 − 0.6408332)/1.9604 = 0.5893668/1.9604 = 0.3006360 → **0.3006**
- high = (1.2302 + 0.6408332)/1.9604 = 1.8710332/1.9604 = 0.9544140 → **0.9544**

**Age band / 55-64 — x=0, n=4, p̂ = 0 → prevalence 0.0000**
- adj = 1.9604; center = 0.4802
- inside sqrt = 0 + 0.9604/16 = 0.060025 → sqrt = 0.245 (exact); half = 1.96 × 0.245 = 0.4802
- low  = (0.4802 − 0.4802)/1.9604 = 0 → **0.0000**
- high = (0.4802 + 0.4802)/1.9604 = 0.9604/1.9604 = 0.4899000 → **0.4899**
  (equals z²/(n+z²) = 3.8416/7.8416 — closed-form cross-check)

**Age band / 65+ — x=0, n=1** → identical arithmetic to 35-44 → **0.0000, (0.0000, 0.7935)**

**Index year / 2019 — x=3, n=10** → identical arithmetic to Overall → **0.3000, (0.1078, 0.6032)**

### 7.3 Gold table for `tz_study_period_prev_pp_2019` (assert every cell; approx tol 0.0001 on 4dp columns)

| stratifier | stratum | patients | denominator | prevalence | ci_low | ci_high | ci_method | numerator_rule | denominator_rule |
|---|---|---|---|---|---|---|---|---|---|
| Overall | Overall | 3 | 10 | 0.3000 | 0.1078 | 0.6032 | wilson | event_in_period | enrolled_anytime |
| Sex | Male | 1 | 6 | 0.1667 | 0.0301 | 0.5635 | wilson | event_in_period | enrolled_anytime |
| Sex | Female | 2 | 4 | 0.5000 | 0.1500 | 0.8500 | wilson | event_in_period | enrolled_anytime |
| Age band | 35-44 | 0 | 1 | 0.0000 | 0.0000 | 0.7935 | wilson | event_in_period | enrolled_anytime |
| Age band | 45-54 | 3 | 4 | 0.7500 | 0.3006 | 0.9544 | wilson | event_in_period | enrolled_anytime |
| Age band | 55-64 | 0 | 4 | 0.0000 | 0.0000 | 0.4899 | wilson | event_in_period | enrolled_anytime |
| Age band | 65+ | 0 | 1 | 0.0000 | 0.0000 | 0.7935 | wilson | event_in_period | enrolled_anytime |
| Index year | 2019 | 3 | 10 | 0.3000 | 0.1078 | 0.6032 | wilson | event_in_period | enrolled_anytime |

Row count = 8. Cross-row invariants asserted: patients <= denominator on every row; sex
denominators sum to Overall (6+4=10); age-band denominators sum to Overall (1+4+4+1=10); sex cases
sum to Overall (1+2=3); age-band cases sum to Overall (0+3+0+0=3).

### 7.4 Gold table for `tz_study_period_prev_pp_h2_2020` (zero-denominator path)

Every cohort episode ends 2020-06-30 < 2020-07-01 → the overlap predicate
(`episode_end >= DATE '2020-07-01'`) fails for all 10 members → denominator set empty:

| stratifier | stratum | patients | denominator | prevalence | ci_low | ci_high |
|---|---|---|---|---|---|---|
| Overall | Overall | 0 | 0 | NULL | NULL | NULL |

Exactly 1 row (no stratifiers). Asserts: COALESCE forces patients = 0 (not NULL); the
`denominator = 0` guard yields NULL statistics (SAS twin: `.`), no division error.

---

## 8. Fixture extension — additive rows needed: **none** (spec-side additions only)

**No data rows change and none are added.** ENROLL / DRUG / AE / redbook stay byte-identical, so
every existing gold number (attrition 12→11→10, incidence 3/8/2425/451.86/(90.82, 1320.24), all 7
incidence stratum rows, SMD, Wilson 3/8 for cumulative incidence) is untouched by construction.

What IS added (additive-only):

1. `GOLD_A_SPEC.analyses` gains two entries **appended after** `a_incidence`:
   ```ts
   { id: "pp_2019", label: "Period prevalence of AE (E11.9), CY2019", kind: "period_prevalence",
     enabled: true,
     outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
     caseStatus: "prevalent",
     prevalencePeriod: { start: "2019-01-01", end: "2019-12-31" },
     denominatorRule: "enrolled_anytime", ciMethod: "wilson",
     stratifyBy: [ /* s_sex, s_age [0,18,35,45,55,65], s_year — same three as a_incidence */ ] },
   { id: "pp_h2_2020", label: "Period prevalence of AE (E11.9), H2-2020 (empty-denominator gold)",
     kind: "period_prevalence", enabled: true,
     outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
     caseStatus: "prevalent",
     prevalencePeriod: { start: "2020-07-01", end: "2020-12-31" },
     denominatorRule: "enrolled_anytime", ciMethod: "wilson", stratifyBy: [] },
   ```
   (`setting: "outpatient"` deliberately mirrors `a_incidence`, exercising the care-setting
   limitation note in both twins.)
2. `EXPECTED` gains `periodPrevalence` (the §7.3 table), `periodPrevalenceRowCount: 8`, and
   `periodPrevalenceEmpty: { rows: 1, patients: 0, denominator: 0 }`.
3. `verify/run.ts` gains the §7 assertions.

**Non-interference proof:**
- Emitters are pure functions of (spec, dialect, options); the spine builders 01–06 / 010–070
  never read `spec.analyses`, so every spine artifact and table is byte-identical.
- `moduleAnalyses` processes enabled analyses **in spec order**; the two new entries are appended,
  so `a_incidence` keeps index 0 → still `07_incidence.sql` / `080_incidence.sas` with unchanged
  content and output table `tz_study_incidence` → every pinned incidence gold value still reads
  from the same table produced by the same SQL.
- The suffix rule is per-kind: incidence_rate still has count 1 → `multi=false` → no suffix change.
  The two period_prevalence analyses (count 2) get suffixes `_pp_2019` / `_pp_h2_2020` on their OWN
  new files (08/09, 090/100) and OWN new tables only.
- New tables `tz_study_period_prev_pp_2019` / `_pp_h2_2020` are written by CREATE TABLE from
  spine tables (read-only); no existing table is written or altered.
- `validateAnalyses` stays green: `ae_dx` exists, minClaims 1, stratifier ids unique, both
  prevalencePeriods non-empty; unique analysis ids.
- Generic invariants (num<=den etc.) hold on the new tables by construction (§1 small-N notes).

---

## 9. Output table schema — one row per stratum incl. Overall

SQL table `${wp}_period_prev${suffix}` / SAS dataset `tz.&tag._${num}_period_prev${suffix}`:

| column | SQL type | SAS | value / semantics |
|---|---|---|---|
| measure | VARCHAR | $20 | constant `'period_prevalence'` |
| stratifier | VARCHAR | $40 | `'Overall'` or `stratLabel(s.label)` (40-char cap shared with SAS) |
| stratum | VARCHAR | $40 | `'Overall'` / shared level labels (SEX_LABELS, REGION_LABELS, ageBandLabels, year, plantyp) |
| patients | BIGINT | num | numerator m (cases with an in-period event); 0 when denominator = 0 (COALESCE) |
| denominator | BIGINT | num | N enrolled anytime in the period (cohort-conditional) |
| prevalence | NUMERIC(·,4) | num, round 0.0001 | m/N; NULL (SQL) / `.` (SAS) when denominator = 0 |
| ci_low | NUMERIC(·,4) | num, round 0.0001 | Wilson 95% lower, clamped >= 0; NULL/`.` when denominator = 0 |
| ci_high | NUMERIC(·,4) | num, round 0.0001 | Wilson 95% upper, clamped <= 1; NULL/`.` when denominator = 0 |
| ci_method | VARCHAR | $16 | `'wilson'` — the method actually computed |
| numerator_rule | VARCHAR | $20 | `'event_in_period'` — D2, honest labeling |
| denominator_rule | VARCHAR | $20 | `'enrolled_anytime'` — D1, honest labeling |

Ordering (both twins' REVIEW/print): `ORDER BY stratifier, stratum`. Empty stratum levels are
absent (no zero-fill rows); the Overall row is always present (even at N = 0).

---

## 10. Integration checklist — files to touch, in order

1. `packages/core/src/emitters/parity.ts` — ADD `PeriodPrevalenceParity`,
   `periodPrevalenceParity()`, `periodPrevalenceLimitations()` (import
   `PeriodPrevalenceAnalysis`); do not touch any incidence code.
2. `packages/core/src/emitters/modules/period-prevalence.ts` — NEW module file: twin
   `sqlPeriodPrev()` / `sasPeriodPrev()` per §3–§4, module-local ISO→SAS-date helper, `stratExpr`/
   `stratAssign` blocks copied from the incidence pattern (shared label constants), export
   `periodPrevalenceModule: AnalysisModule<PeriodPrevalenceAnalysis>` with
   `analysisKind: "period_prevalence"`, `stampKind: "period_prevalence"`.
3. `packages/core/src/emitters/modules/registry.ts` — register
   `period_prevalence: periodPrevalenceModule as AnalysisModule<never>` (auto-enrolls SQL 08+/SAS
   090+ emission AND the parity harness).
4. `packages/core/src/verify/parity.ts` — ADD the `period_prevalence` entry to `SIGNATURES` (§5).
5. `packages/core/src/verify/fixture.ts` — APPEND `pp_2019` + `pp_h2_2020` to
   `GOLD_A_SPEC.analyses`; ADD `EXPECTED.periodPrevalence`, `EXPECTED.periodPrevalenceRowCount`,
   `EXPECTED.periodPrevalenceEmpty` (§7). **No data-row edits.**
6. `packages/core/src/verify/run.ts` — ADD the gold assertions: Overall + all 7 stratum rows
   (eq on patients/denominator, approx tol 0.0001 on prevalence/ci_low/ci_high), row count 8,
   `ci_method='wilson'` on every row, the empty-period table (1 row, patients 0, denominator 0,
   prevalence IS NULL), and the §7.3 sum-to-Overall cross-checks.
7. Run `npm run verify` — must show: all pre-existing spine + incidence checks green (proves
   non-interference), new period-prevalence gold checks green, parity stamp count now 3 with
   deep-equal stamps + arithmetic signatures in both languages.
8. `docs/COVERAGE-MATRIX.md` — flip "Period prevalence" status to done, noting the V1 deltas
   (no carry-in option, no minEnrollmentDaysInPeriod floor, no equal-length multi-period series —
   single period per analysis object; all surfaced as REVIEW notes).
