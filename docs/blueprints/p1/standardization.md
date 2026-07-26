# standardization module blueprint

Module for `kind: "standardization"` — direct age standardization of a rate
(`base: "incidence_rate"`). Twin `sql()`/`sas()` generators in
`src/emitters/modules/standardization.ts`, registered as `standardization` in the
module registry, stamp kind `standardization`, SQL output table
`${wp}_stdrate${suffix}`, SAS program `${num}_stdrate${suffix}.sas`.

Scope decisions made in this blueprint (each is honestly labeled, never silent):

| Decision | Rationale |
|---|---|
| V1 implements `base: "incidence_rate"` ONLY | point/period prevalence modules do not exist yet (COVERAGE-MATRIX: declared-not-emitted); standardizing a measure whose machinery is unbuilt would mean inventing it here. Prevalence bases emit an EMPTY (zero-row, correctly-typed) output table + a loud REVIEW limitation in both twins — never a wrong number. |
| V1 standardizes over AGE BANDS only (`strataIds` must be exactly `["age_band"]` to be fully honored) | all three named reference populations are age-only standards (both sexes combined); age-sex weights do not exist in the named sources. Any other `strataIds` → REVIEW limitation, age-only result produced and labeled. |
| CI actually computed = closed-form **normal approximation**, labeled `normal_approx` on both sides regardless of the requested `ciMethod` | Fay–Feuer/Dobson need gamma quantiles (data-dependent inverse CDF) — no closed form, not emittable in stock Postgres/Snowflake (COVERAGE-MATRIX "warehouse-SQL statistical ceiling"). SAS *could* do `QUANTILE('GAMMA',…)` in a DATA step, but then the twins would disagree, which violates the twin contract. Both twins therefore compute the identical normal-approx closed form; the SAS program carries a **commented-out** `PROC STDRATE … CL=GAMMA` cross-check block, clearly marked as NOT the machine-verified number. |
| Per-cell crude rates carry **Byar** CIs (`poisson_byar`) | reuses the already-machine-verified closed form from the incidence module, byte-identical arithmetic. |
| Washout = **all-available lookback** (any qualifying event on or before index ⇒ prevalent ⇒ excluded from numerator AND denominator) | `StandardizationAnalysis` carries NO `washout` field (see §2); the widest lookback is the epidemiologically safest deterministic choice for "incident" (DOMAIN-RULES §3). It is pinned in the parity stamp and stated in both program headers. |
| Empty cell (standard-population age band with 0 person-time) ⇒ **rebased out**: contributes nothing to the numerator AND its weight is removed from Σw; `covered_weight_pct` column reports how much of the standard was actually covered | dividing by the full Σw would silently deflate the DSR; 0/0 cell rates would crash. Rebasing over covered cells is the PROC STDRATE / Fay–Feuer convention, and the covered-weight percentage makes the rebasing visible instead of silent. |

---

## 1. Method — precise definition + literature refs

**Directly standardized rate (DSR).** Partition the at-risk cohort into age cells
`i = 1..K` defined by the reference population's own age bands. Per cell:
`d_i` = incident first events, `T_i` = person-days at risk, and the scaled cell rate

```
r_i = d_i / T_i × M × Y          M = rateMultiplier (default 1000), Y = daysPerYear (spec.meta.daysPerYear, default 365.25)
```

With reference weights `w_i`, over the **covered** cells `C = { i : T_i > 0 }`:

```
DSR = Σ_{i∈C} w_i · r_i / Σ_{i∈C} w_i
```

**Variance / CI (normal approximation).** Treating each `d_i` as Poisson with
variance estimated by `d_i` (Var(r_i) = d_i · (M·Y/T_i)²):

```
Var(DSR) = Σ_{i∈C} w_i² · d_i · (M·Y/T_i)²  /  ( Σ_{i∈C} w_i )²
SE = sqrt(Var(DSR))
CI = [ max(0, DSR − 1.96·SE),  DSR + 1.96·SE ]      (lower bound floored at 0, documented)
```

Both twins compute the weighted sum in the **scaled** space (rates already
per-M-PY) from **unrounded** cell rates; rounding (2 dp rates/CIs, 4 dp
person-years) happens only on output columns. Rounding a cell rate before
weighting is a defect.

**Per-cell / crude CIs.** Byar's exact-Poisson approximation, the identical
closed form the incidence module ships (0 ⇒ lower bound 0; upper uses d+1).

**Small-N honesty.** The normal approximation degenerates to CI (0, 0) at zero
total cases and is anti-conservative below ~10 observed cases; a static REVIEW
note in both programs says to use the gamma interval (PROC STDRATE `CL=GAMMA`)
for delivery tables when total cases < 10. The statistic is still labeled
`normal_approx` — the method actually computed.

References (page/edition level):

- Rothman KJ, Greenland S, Lash TL. *Modern Epidemiology*, 3rd ed. Lippincott
  2008 — ch. 3 (measures of occurrence), ch. 15 "Introduction to Stratified
  Analysis", standardization pp. 262–267 (direct standardization as a weighted
  average of stratum-specific rates).
- Breslow NE, Day NE. *Statistical Methods in Cancer Research, Vol. II — The
  Design and Analysis of Cohort Studies.* IARC Scientific Publications No. 82,
  Lyon 1987 — §2.2–2.3 (directly standardized rates; the Σw²·Var(r) variance
  used here).
- Fay MP, Feuer EJ. "Confidence intervals for directly standardized rates: a
  method based on the gamma distribution." *Stat Med* 1997;16(7):791–801 —
  the gamma CI the spec can request; NOT closed form (gamma quantiles), hence
  deferred with honest labeling.
- Dobson AJ, Kuulasmaa K, Eberle E, Scherer J. "Confidence intervals for
  weighted sums of Poisson parameters." *Stat Med* 1991;10(3):457–462 — the
  `dobson` option; also requires exact-Poisson (chi-square/gamma) quantiles.
- Ulm K. "A simple method to calculate the confidence interval of a standardized
  mortality ratio (SMR)." *Am J Epidemiol* 1990;131(2):373–375 — Byar
  approximation used for per-cell and crude CIs (already the incidence twins'
  cited form).
- SAS Institute. *SAS/STAT User's Guide* (14.3/15.1), "The STDRATE Procedure",
  "Direct Standardization" section — `METHOD=DIRECT STAT=RATE(MULT=) CL=NORMAL`
  computes exactly the DSR + normal CI above; `CL=GAMMA` is the Fay–Feuer
  interval. Used as the commented cross-check block, not as the twin.

**Reference populations (exact vintages + code constants).** These constants
live beside `SEX_LABELS`/`REGION_LABELS` in `src/emitters/parity.ts` as
`STD_REF_POPS` so BOTH twins are generated from one source of truth, and the
band bounds + weights are stamped into the parity record (a diverging edit
fails verification).

```ts
/** Reference standard populations for direct standardization.
 *  bands = inclusive lower bounds; labels = emitted stratum values;
 *  weights = the published standard-population counts, band-aligned. */
export const STD_REF_POPS = {
  /** US 2000 projected population, "standard million", Distribution #1
   *  (11 groups). Source: Klein RJ, Schoenborn CA. "Age adjustment using the
   *  2000 projected U.S. population." Healthy People 2010 Statistical Notes
   *  No. 20, NCHS, January 2001, Table 1 (Census Bureau P25-1130 projections
   *  as adopted by DHHS for data year 1999+). Sums to exactly 1,000,000. */
  us_2000_standard: {
    bands:  [0,     1,     5,      15,     25,     35,     45,     55,    65,    75,    85],
    labels: ["<1",  "1-4", "5-14", "15-24","25-34","35-44","45-54","55-64","65-74","75-84","85+"],
    weights:[13818, 55317, 145565, 138646, 135573, 162613, 134834, 87247, 66037, 44842, 15508],
  },
  /** WHO World Standard Population 2000-2025. Source: Ahmad OB, Boschi-Pinto C,
   *  Lopez AD, Murray CJL, Lozano R, Inoue M. "Age standardization of rates:
   *  a new WHO standard." GPE Discussion Paper Series No. 31, WHO 2001,
   *  Table 1, expressed per 100,000. The published 85-89/90-94/95-99/100+
   *  tail (0.44+0.15+0.04+0.005 %) is collapsed to 85+ = 635 because
   *  MarketScan age is calendar-year precision (DOBYR) and CCAE/MDCR cells
   *  above 85 are near-empty. Sums to 100,035 (rounding in the WHO source);
   *  the DSR normalizes by Σw so the excess 35 is harmless and documented. */
  who_world_2000: {
    bands:  [0,   5,   10,  15,  20,  25,  30,  35,  40,  45,  50,  55,  60,  65,  70,  75,  80,  85],
    labels: ["0-4","5-9","10-14","15-19","20-24","25-29","30-34","35-39","40-44","45-49","50-54","55-59","60-64","65-69","70-74","75-79","80-84","85+"],
    weights:[8860, 8690, 8600, 8470, 8220, 7930, 7610, 7150, 6590, 6040, 5370, 4550, 3720, 2960, 2210, 1520, 910, 635],
  },
  /** European Standard Population 2013. Source: Eurostat, "Revision of the
   *  European Standard Population — Report of Eurostat's task force", 2013
   *  edition (KS-RA-13-028), Publications Office of the EU, Luxembourg 2013.
   *  Per 100,000; the official <1 (1,000) + 1-4 (4,000) split is emitted as
   *  a combined 0-4 = 5,000 cell (calendar-year age precision). Sums to
   *  exactly 100,000. */
  esp_2013: {
    bands:  [0,    5,    10,   15,   20,   25,   30,   35,   40,   45,   50,   55,   60,   65,   70,   75,   80,   85,   90],
    labels: ["0-4","5-9","10-14","15-19","20-24","25-29","30-34","35-39","40-44","45-49","50-54","55-59","60-64","65-69","70-74","75-79","80-84","85-89","90+"],
    weights:[5000, 5500, 5500, 5500, 6000, 6000, 6500, 7000, 7000, 7000, 7000, 6500, 6000, 5500, 5000, 4000, 2500, 1500, 1000],
  },
} as const;
```

**Custom weights** (`referencePopulation.kind === "custom"`): `cellKey` strings
must use the emitted-label grammar `"<N"` | `"N-M"` | `"N+"`. The generator
parses lower bounds from the keys, sorts ascending, and validates: contiguous
(`M+1` = next lower bound), exactly one terminal `"N+"` cell, all weights ≥ 0,
Σw > 0 (the > 0 sum is already enforced by `validateAnalyses`). A malformed
cellKey set is a generation-time error (module throws, precedented by
`buildCtx`'s missing-index-list throw) — and the integration checklist adds the
same check to `validateAnalyses` so readiness catches it before emission.

**Age.** `age_at_index = year(index_date) − DOBYR` from the enrollment segment
in force at (or latest before) index — the same source and tie-break as the
incidence twins, so age can never drift between languages or against the
incidence output. Patients with NULL DOBYR (or, for custom pops, an age below
the lowest band) belong to **no** cell: they are excluded from every cell and
from the DSR, and a REVIEW query derives their count from the output table
itself (`crude denominator − Σ cell denominators`).

---

## 2. Spec consumption — the analysis interface verbatim + field-by-field mapping

From `src/spec/types.ts` (verbatim):

```ts
export interface StandardizationAnalysis extends AnalysisCommon {
  kind: "standardization";
  base: "incidence_rate" | "point_prevalence" | "period_prevalence";
  outcomeDefinition: OutcomeDefinition;
  personTimeRule?: PersonTimeRule; // required when base === "incidence_rate"
  rateMultiplier?: number;
  standardization: StandardizationSpec;
}
```

```ts
/** Direct age-sex standardization.
 *  Ref: Modern Epi 3e ch.3; Fay & Feuer Stat Med 1997;16:791 (gamma CI). */
export interface StandardizationSpec {
  method: "direct";
  strataIds: string[];
  referencePopulation:
    | { kind: "named"; name: "us_2000_standard" | "who_world_2000" | "esp_2013" }
    | { kind: "custom"; weights: Array<{ cellKey: string; weight: number }> };
  ciMethod: "fay_feuer" | "dobson" | "normal_approx";
}
```

Supporting interfaces consumed (verbatim):

```ts
export interface OutcomeDefinition {
  codeListId: string;         // -> CodeList.id (may be an empty list awaiting lookup)
  minClaims: number;          // >= 1 qualifying claims to count as a case
  claimSeparationDays?: number; // required when minClaims >= 2
  setting: CareSetting;
  diagnosisPosition: "any" | "primary"; // DX1/principal vs any DXn
}

export interface PersonTimeRule {
  start: "index" | "enrollment_start" | "washout_end";
  censorAt: Array<"outcome" | "disenrollment" | "death" | "study_end" | "max_followup">;
  maxFollowupDays?: number;
}
```

Field-by-field mapping:

| Field | How the module consumes it |
|---|---|
| `id`, `label`, `notes` | header comments, table titles, parity `id`; `suffix` from the registry when several standardization analyses exist |
| `enabled` | registry filters disabled analyses (module never sees them) |
| `base` | `"incidence_rate"` → full emission. `"point_prevalence"` / `"period_prevalence"` → REVIEW limitation + EMPTY typed output table in BOTH twins; parity stamps `base` (requested) + `resultEmitted:false` |
| `outcomeDefinition.codeListId` | event source: SQL `${wp}_events WHERE code_list_id = '…'`; SAS `ctx.evOf(codeListId)` |
| `outcomeDefinition.minClaims` | NOT enforced (>1 ⇒ REVIEW limitation, single-claim outcome produced — identical to the incidence module's limitation) |
| `outcomeDefinition.setting` | NOT applied (≠ `"any"` ⇒ REVIEW limitation) |
| `outcomeDefinition.claimSeparationDays` | only meaningful with minClaims ≥ 2, which is unimplemented — covered by the minClaims limitation |
| `outcomeDefinition.diagnosisPosition` | NOT applied (`"primary"` ⇒ REVIEW limitation) |
| `personTimeRule.start` | `"index"` semantics emitted (person-time from index). Other values ⇒ REVIEW limitation, index-start produced |
| `personTimeRule.censorAt` | builds the admin-censor `LEAST(...)` exactly as the incidence module: `disenrollment` → episode end, `study_end` → study-period end, `max_followup` → index + maxFollowupDays; `death` omitted (MarketScan mortality unascertainable — BR-LIM-002, same as incidence); empty term list falls back to study end; `outcome` toggles censoring follow-up at the first event. Sorted consumed terms stamped |
| `personTimeRule.maxFollowupDays` | the `max_followup` offset; stamped (null when absent) |
| `personTimeRule` **missing** (readiness should block; defensive) | censor at disenrollment + study end, follow-up NOT censored at outcome is wrong for rates — so the defensive default is `censorAt: ["outcome","disenrollment","study_end"]` + REVIEW limitation |
| `rateMultiplier` | `M = an.rateMultiplier ?? 1000`; consumed value stamped |
| `standardization.method` | `"direct"` is the only union member; stamped implicitly via kind |
| `standardization.strataIds` | must be exactly `["age_band"]` to be fully honored; anything else ⇒ REVIEW limitation, age-band-only standardization produced; parity stamps `strata: ["age_band"]` (what was computed) |
| `standardization.referencePopulation` | named → `STD_REF_POPS[name]` bands/labels/weights; custom → bands/labels parsed from cellKeys, weights verbatim. Stamped: `refPopulation` (name or `"custom"`), `refBands`, `refWeights` |
| `standardization.ciMethod` | `normal_approx` computed always; `fay_feuer`/`dobson` ⇒ REVIEW limitation. Output + stamp carry `ciMethod: "normal_approx"` — the method actually computed |
| *(no `washout` field exists)* | fixed all-available lookback `{ start: "anytime_before", end: 0, includesIndex: true }` (module constant `STD_WASHOUT`), rendered through the existing `windowConds` helpers on both sides; stamped |
| *(no `recurrence` field exists)* | first-event-only always; stamped `recurrence: "first_only"` |
| `spec.meta.daysPerYear` | `Y = renderDaysPerYear(spec)` (SQL literal) / `&days_per_year.` + `ctx.daysPerYearLit` (SAS) — never hard-coded; stamped as the rendered string |
| `spec.meta.studyPeriod.end` | the `study_end` censor term |

---

## 3. SQL twin — the COMPLETE CTE chain (Postgres; Snowflake only via Dialect helpers)

Placeholders: `${wp}` work-table prefix, `${out}` = `${wp}_stdrate${suffix}`,
`${clid}` = outcomeDefinition.codeListId, `${M}` rateMultiplier, `${Y}` =
`renderDaysPerYear(spec)` (decimal literal — integer division trap), `${studyEnd}`
= spec.meta.studyPeriod.end, `${adminCensor}` built from `censorAt` exactly as in
the incidence module (`d.offset`, `LEAST(...)`), `${K}` = band count, cell CASE
arms generated descending from `STD_REF_POPS[...]` (or parsed custom bands).
Dialect helpers used: `d.createTableAs`, `d.offset`, `d.daysBetween`, `d.year`,
`d.roundN`; the fixed washout renders through `windowConds(STD_WASHOUT, "a.event_date", "c.index_date", d)`.
No `FILTER (WHERE …)` aggregates (Snowflake lacks them) — `SUM(CASE WHEN … END)`
throughout; `GREATEST` only reached under a `w_cov > 0` guard because
`GREATEST(0, NULL)` is 0 in Postgres but NULL in Snowflake.

Rendered for Gold Case A (`base: incidence_rate`, `us_2000_standard`,
`normal_approx`, M=1000, Y=365.25, censorAt `[outcome, disenrollment,
study_end, max_followup]`, maxFu 365):

```sql
-- PARITY standardization {"base":"incidence_rate","cellCiMethod":"poisson_byar","censorAt":["disenrollment","max_followup","outcome","study_end"],"ciMethod":"normal_approx","codeListId":"ae_dx","daysPerYear":"365.25","id":"a_std","maxFollowupDays":365,"rateMultiplier":1000,"recurrence":"first_only","refBands":[0,1,5,15,25,35,45,55,65,75,85],"refPopulation":"us_2000_standard","refWeights":[13818,55317,145565,138646,135573,162613,134834,87247,66037,44842,15508],"resultEmitted":true,"strata":["age_band"],"washout":{"end":0,"includesIndex":true,"start":"anytime_before"}}
-- REVIEW: washout is ALL-AVAILABLE lookback (any qualifying event on or before
-- index marks the patient prevalent) - StandardizationAnalysis has no washout
-- window field; this is the widest, safest incident-case rule.
-- REVIEW: the normal-approximation CI degenerates at 0 cases and is
-- anti-conservative below ~10 observed cases - prefer the gamma interval
-- (SAS PROC STDRATE CL=GAMMA cross-check block) for delivery tables.
DROP TABLE IF EXISTS tz_study_stdrate;
CREATE TABLE tz_study_stdrate AS
WITH cohort AS (SELECT enrolid, index_date FROM tz_study_cohort),
ae AS (SELECT enrolid, event_date FROM tz_study_events WHERE code_list_id = 'ae_dx'),
prevalent AS (   -- washout: anytime before .. day 0 relative to index (includes index date)
  SELECT DISTINCT c.enrolid
  FROM cohort c JOIN ae a ON a.enrolid = c.enrolid
  WHERE a.event_date <= c.index_date
),
atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),
first_fu AS (   -- first qualifying outcome strictly after index
  SELECT c.enrolid, MIN(a.event_date) AS fu_date
  FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid AND a.event_date > c.index_date
  GROUP BY c.enrolid
),
demo AS (   -- enrollment segment in force at (or latest before) index; rn=1 wins
  SELECT c.enrolid, en.dobyr,
         ROW_NUMBER() OVER (PARTITION BY c.enrolid
                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn
  FROM atrisk c
  JOIN ccaet_all en                          -- ${ctx.t("enrollment_detail")}
    ON en.enrolid = c.enrolid
   AND en.dtstart <= c.index_date
),
demo1 AS (SELECT enrolid, dobyr FROM demo WHERE rn = 1),
pt AS (
  SELECT c.enrolid, c.index_date,
         LEAST(ep.episode_end, DATE '2020-12-31', (c.index_date + 365)) AS admin_censor,
         f.fu_date, dm.dobyr
  FROM atrisk c
  JOIN tz_study_enroll_episodes ep
    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end
  LEFT JOIN demo1 dm ON dm.enrolid = c.enrolid
  LEFT JOIN first_fu f ON f.enrolid = c.enrolid
),
pt2 AS (
  SELECT (LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor) - index_date) AS person_days,
         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN 1 ELSE 0 END AS is_case,
         CAST(EXTRACT(YEAR FROM index_date) AS INT) - dobyr AS age_at_index
  FROM pt
),
std_pop AS (   -- US 2000 standard million, NCHS Distribution #1
               -- (Klein & Schoenborn 2001, Table 1); sums to 1,000,000
  SELECT * FROM (VALUES
    (1,  '<1',    13818),
    (2,  '1-4',   55317),
    (3,  '5-14',  145565),
    (4,  '15-24', 138646),
    (5,  '25-34', 135573),
    (6,  '35-44', 162613),
    (7,  '45-54', 134834),
    (8,  '55-64', 87247),
    (9,  '65-74', 66037),
    (10, '75-84', 44842),
    (11, '85+',   15508)
  ) AS v (ord, stratum, w)
),
cells AS (   -- band assignment: NULL age -> no cell; arms descend like the incidence twin
  SELECT CASE
           WHEN age_at_index IS NULL THEN NULL
           WHEN age_at_index >= 85 THEN 11
           WHEN age_at_index >= 75 THEN 10
           WHEN age_at_index >= 65 THEN 9
           WHEN age_at_index >= 55 THEN 8
           WHEN age_at_index >= 45 THEN 7
           WHEN age_at_index >= 35 THEN 6
           WHEN age_at_index >= 25 THEN 5
           WHEN age_at_index >= 15 THEN 4
           WHEN age_at_index >= 5  THEN 3
           WHEN age_at_index >= 1  THEN 2
           ELSE 1
         END AS ord,
         is_case, person_days
  FROM pt2
),
agg AS (
  SELECT ord, SUM(is_case) AS patients, COUNT(*) AS denominator, SUM(person_days) AS person_days
  FROM cells
  WHERE ord IS NOT NULL
  GROUP BY ord
),
cell_rates AS (   -- every standard cell, observed or empty; the UNROUNDED
                  -- cell_rate feeds the DSR (rounding only on output columns)
  SELECT s.ord, s.stratum, s.w,
         COALESCE(a.patients, 0)    AS patients,
         COALESCE(a.denominator, 0) AS denominator,
         COALESCE(a.person_days, 0) AS person_days,
         CASE WHEN COALESCE(a.person_days, 0) > 0
              THEN a.patients * 1000 * 365.25 / a.person_days END AS cell_rate
  FROM std_pop s
  LEFT JOIN agg a ON a.ord = s.ord
),
overall AS (
  SELECT SUM(is_case) AS patients, COUNT(*) AS denominator, SUM(person_days) AS person_days
  FROM pt2
),
dsr AS (   -- EMPTY cells (person_days = 0) are rebased OUT of the weight
           -- denominator; covered_weight_pct reports the rebasing
  SELECT SUM(CASE WHEN person_days > 0 THEN w ELSE 0 END) AS w_cov,
         SUM(w) AS w_tot,
         SUM(CASE WHEN person_days > 0 THEN w * cell_rate ELSE 0 END) AS dsr_num,
         SUM(CASE WHEN person_days > 0
                  THEN w * w * patients * POWER(1000 * 365.25 / person_days, 2)
                  ELSE 0 END) AS var_num
  FROM cell_rates
)
SELECT ord, 'std_cell' AS measure, 'Age band' AS stratifier, stratum,
       patients, denominator, person_days,
       ROUND(CAST(person_days / 365.25 AS NUMERIC), 4) AS person_years,
       CAST(w AS NUMERIC) AS std_weight,
       ROUND(CAST(cell_rate AS NUMERIC), 2) AS rate_per_1000py,
       ROUND(CAST((CASE WHEN patients = 0 THEN 0 ELSE POWER(1 - 1.0/(9*patients) - 1.96/(3*SQRT(patients)), 3) * patients END)
                  * 1000 * 365.25 / NULLIF(person_days, 0) AS NUMERIC), 2) AS ci_low,
       ROUND(CAST(POWER(1 - 1.0/(9*(patients+1)) + 1.96/(3*SQRT(patients+1)), 3) * (patients+1)
                  * 1000 * 365.25 / NULLIF(person_days, 0) AS NUMERIC), 2) AS ci_high,
       CASE WHEN person_days > 0 THEN 'poisson_byar' END AS ci_method,
       'us_2000_standard' AS ref_population,
       CAST(NULL AS NUMERIC) AS covered_weight_pct
FROM cell_rates
UNION ALL
SELECT 98, 'crude', 'Overall', 'Overall',
       patients, denominator, person_days,
       ROUND(CAST(person_days / 365.25 AS NUMERIC), 4),
       CAST(NULL AS NUMERIC),
       ROUND(CAST(patients * 1000 * 365.25 / NULLIF(person_days, 0) AS NUMERIC), 2),
       ROUND(CAST((CASE WHEN patients = 0 THEN 0 ELSE POWER(1 - 1.0/(9*patients) - 1.96/(3*SQRT(patients)), 3) * patients END)
                  * 1000 * 365.25 / NULLIF(person_days, 0) AS NUMERIC), 2),
       ROUND(CAST(POWER(1 - 1.0/(9*(patients+1)) + 1.96/(3*SQRT(patients+1)), 3) * (patients+1)
                  * 1000 * 365.25 / NULLIF(person_days, 0) AS NUMERIC), 2),
       'poisson_byar',
       CAST(NULL AS VARCHAR),
       CAST(NULL AS NUMERIC)
FROM overall
UNION ALL
-- labeled with the method actually computed (normal_approx), never the
-- merely-requested one; lower bound floored at 0 (documented)
SELECT 99, 'standardized', 'Overall', 'Overall',
       o.patients, o.denominator, o.person_days,
       ROUND(CAST(o.person_days / 365.25 AS NUMERIC), 4),
       CAST(NULL AS NUMERIC),
       ROUND(CAST(d.dsr_num / NULLIF(d.w_cov, 0) AS NUMERIC), 2),
       CASE WHEN d.w_cov > 0 THEN
         ROUND(CAST(GREATEST(0, d.dsr_num / d.w_cov - 1.96 * SQRT(d.var_num) / d.w_cov) AS NUMERIC), 2)
       END,
       CASE WHEN d.w_cov > 0 THEN
         ROUND(CAST(d.dsr_num / d.w_cov + 1.96 * SQRT(d.var_num) / d.w_cov AS NUMERIC), 2)
       END,
       'normal_approx',
       'us_2000_standard',
       ROUND(CAST(100.0 * d.w_cov / NULLIF(d.w_tot, 0) AS NUMERIC), 2)
FROM overall o CROSS JOIN dsr d;

-- REVIEW: direct age standardization to the US 2000 standard million,
-- per 1000 person-years. covered_weight_pct < 100 means age bands with zero
-- person-time were rebased out of the standard - review before delivery.
SELECT * FROM tz_study_stdrate
ORDER BY ord;

-- REVIEW: at-risk patients assignable to NO standard cell (unknown DOBYR or,
-- for custom weights, age outside every cellKey). Must be 0 or explained.
SELECT (SELECT denominator FROM tz_study_stdrate WHERE measure = 'crude')
     - (SELECT SUM(denominator) FROM tz_study_stdrate WHERE measure = 'std_cell')
       AS unassigned_patients;
```

`1000 * 365.25` above is `${M} * ${Y}` — `${Y}` is the `renderDaysPerYear`
DECIMAL literal (never an integer, never hard-coded). The `prevalent`/`atrisk`/
`first_fu`/`demo`/`pt`/`pt2` chain is **the incidence module's chain**, emitted
by the shared `rate-core` helpers (§10) — not a re-implementation.

**Prevalence-base variant** (`base` ≠ `"incidence_rate"`): after the parity
stamp + REVIEW limitations, emit only a correctly-typed EMPTY table so
downstream tooling sees "no result", never a wrong number:

```sql
DROP TABLE IF EXISTS ${out};
CREATE TABLE ${out} AS
SELECT CAST(NULL AS INT) AS ord, CAST(NULL AS VARCHAR) AS measure,
       CAST(NULL AS VARCHAR) AS stratifier, CAST(NULL AS VARCHAR) AS stratum,
       CAST(NULL AS INT) AS patients, CAST(NULL AS INT) AS denominator,
       CAST(NULL AS NUMERIC) AS person_days, CAST(NULL AS NUMERIC) AS person_years,
       CAST(NULL AS NUMERIC) AS std_weight, CAST(NULL AS NUMERIC) AS rate_per_1000py,
       CAST(NULL AS NUMERIC) AS ci_low, CAST(NULL AS NUMERIC) AS ci_high,
       CAST(NULL AS VARCHAR) AS ci_method, CAST(NULL AS VARCHAR) AS ref_population,
       CAST(NULL AS NUMERIC) AS covered_weight_pct
WHERE 1 = 0;
```

---

## 4. SAS twin — the COMPLETE program mirroring the SQL arithmetic

Rendered for Gold Case A (`num` = "090", `${ctx.finalCohort}` =
`tz.&tag._060_coh2`, `${ctx.evOf("ae_dx")}` = `tz.&tag._ev_ae_dx`,
`${ctx.tbl("050_epi")}` = `tz.&tag._050_epi`, `${ctx.tbl("040_enroll")}` =
`tz.&tag._040_enroll`). Uses `header(...)`, `INCLUDE_SETUP`, `levelCheck(...)`,
`sasWindowConds(STD_WASHOUT, "e")` from sas-base, and `&days_per_year.` from
00_setup (stamped via `ctx.daysPerYearLit`).

```sas
/* [standard header(spec, "090_stdrate.sas", [...]) block:
   Direct age standardization (US 2000 standard million) of the person-time
   incidence rate for "<label>": all-available prevalent-case washout,
   at-risk denominator, per-cell crude rates with Byar CIs, DSR with a
   closed-form normal-approximation CI. Twin of the machine-verified SQL
   08_stdrate; keep both in sync. ] */

/* PARITY standardization {"base":"incidence_rate", ... identical stamp to the SQL twin ... } */

/* REVIEW - washout is ALL-AVAILABLE lookback (any qualifying event on or
   before index marks the patient prevalent) - StandardizationAnalysis has
   no washout window field.
   REVIEW - the normal-approximation CI degenerates at 0 cases and is
   anti-conservative below ~10 observed cases - prefer the gamma interval
   (PROC STDRATE CL=GAMMA block at the bottom) for delivery tables. */

%include "00_setup.sas";   /* EDIT: use the full site path to 00_setup.sas */

proc datasets lib=tz nolist nowarn;
  delete &tag._090_stdrate;
quit;

/*----------------------------------------------------------------------------
  Prevalent-case washout: ALL-AVAILABLE lookback (anytime before .. day 0
  relative to index, includes the index date). Prevalent patients leave both
  the numerator and the denominator (DOMAIN-RULES section 3).
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_prev as
  select distinct a.enrolid
  from tz.&tag._060_coh2 as a
  inner join tz.&tag._ev_ae_dx as e
    on e.enrolid = a.enrolid
  where 1 = 1
    and e.svcdate <= a.index_date;
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
  DOBYR from the enrollment segment in force at (or latest before) index -
  the SAME source and tie-break as the SQL twin and the incidence module,
  so age can never drift between languages.
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_dm0 as
  select a.enrolid, b.dobyr, b.dtstart as seg_start, b.dtend as seg_end
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
  Person-time: administrative censor = earliest of episode end, study end,
  index + 365d - identical censor arithmetic to the incidence twin.
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_pt as
  select a.enrolid, a.index_date,
         min(ep.dtend, &study_end., a.index_date + 365) as admin_censor format=date9.,
         b.fu_date, dm.dobyr
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
  /* a case = first outcome on or before the administrative censor date */
  is_case = (fu_date ne . and fu_date <= admin_censor);
  /* follow-up stops at the earliest of outcome and admin censoring */
  censor_date = min(coalesce(fu_date, '31DEC9999'd), admin_censor);
  person_days = censor_date - index_date;
  /* enrollment-derived age (year - DOBYR), matching the SQL twin */
  age_at_index = year(index_date) - dobyr;
  format censor_date date9.;
run;

title "Level check: work._090_pt2 (person-time rows)";
proc sql;
  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt,
         sum(is_case) as cases,
         sum(person_days) as person_days
  from work._090_pt2;
quit;

/*----------------------------------------------------------------------------
  Standard population: US 2000 standard million, NCHS Distribution #1
  (Klein & Schoenborn 2001, Table 1); sums to 1,000,000.
----------------------------------------------------------------------------*/
data work._090_stdpop;
  length stratum $40;
  ord = 1;  stratum = '<1';    w = 13818;  output;
  ord = 2;  stratum = '1-4';   w = 55317;  output;
  ord = 3;  stratum = '5-14';  w = 145565; output;
  ord = 4;  stratum = '15-24'; w = 138646; output;
  ord = 5;  stratum = '25-34'; w = 135573; output;
  ord = 6;  stratum = '35-44'; w = 162613; output;
  ord = 7;  stratum = '45-54'; w = 134834; output;
  ord = 8;  stratum = '55-64'; w = 87247;  output;
  ord = 9;  stratum = '65-74'; w = 66037;  output;
  ord = 10; stratum = '75-84'; w = 44842;  output;
  ord = 11; stratum = '85+';   w = 15508;  output;
run;

/* band assignment - descending arms, the same shape as the SQL CASE */
data work._090_cells0;
  set work._090_pt2;
  if age_at_index = . then ord = .;
  else if age_at_index >= 85 then ord = 11;
  else if age_at_index >= 75 then ord = 10;
  else if age_at_index >= 65 then ord = 9;
  else if age_at_index >= 55 then ord = 8;
  else if age_at_index >= 45 then ord = 7;
  else if age_at_index >= 35 then ord = 6;
  else if age_at_index >= 25 then ord = 5;
  else if age_at_index >= 15 then ord = 4;
  else if age_at_index >= 5  then ord = 3;
  else if age_at_index >= 1  then ord = 2;
  else ord = 1;
run;

proc sql;
  create table work._090_agg as
  select ord, sum(is_case) as patients, count(*) as denominator,
         sum(person_days) as person_days
  from work._090_cells0
  where ord is not missing
  group by ord;
quit;

/* every standard cell, observed or empty */
proc sql;
  create table work._090_cells as
  select s.ord, s.stratum, s.w,
         coalesce(a.patients, 0)    as patients,
         coalesce(a.denominator, 0) as denominator,
         coalesce(a.person_days, 0) as person_days
  from work._090_stdpop as s
  left join work._090_agg as a
    on a.ord = s.ord;
quit;

/*----------------------------------------------------------------------------
  Per-cell crude rate (UNROUNDED cell_rate feeds the DSR) + Byar CI - the
  SAME closed form as the incidence twin (Ulm AJE 1990;131:373).
----------------------------------------------------------------------------*/
data work._090_cells2;
  set work._090_cells;
  length ci_method $16;
  if person_days > 0 then do;
    cell_rate = patients * 1000 * &days_per_year. / person_days;
    if patients = 0 then _byar_low = 0;
    else _byar_low = ((1 - 1/(9*patients) - 1.96/(3*sqrt(patients)))**3) * patients;
    _byar_high = ((1 - 1/(9*(patients+1)) + 1.96/(3*sqrt(patients+1)))**3) * (patients+1);
    ci_low  = round(_byar_low  * 1000 * &days_per_year. / person_days, 0.01);
    ci_high = round(_byar_high * 1000 * &days_per_year. / person_days, 0.01);
    ci_method = 'poisson_byar';
  end;
  else do;
    cell_rate = .; ci_low = .; ci_high = .; ci_method = '';
  end;
  drop _byar_low _byar_high;
run;

/*----------------------------------------------------------------------------
  DSR accumulators. EMPTY cells (person_days = 0) are rebased OUT of the
  weight denominator; covered_weight_pct makes the rebasing visible.
    DSR      = sum(w * cell_rate) / sum(w)            over covered cells
    Var(DSR) = sum(w * w * patients * (M*Y/T)**2) / sum(w)**2
----------------------------------------------------------------------------*/
proc sql;
  create table work._090_dsr as
  select sum(case when person_days > 0 then w else 0 end) as w_cov,
         sum(w) as w_tot,
         sum(case when person_days > 0 then w * cell_rate else 0 end) as dsr_num,
         sum(case when person_days > 0
                  then w * w * patients * ((1000 * &days_per_year. / person_days)**2)
                  else 0 end) as var_num
  from work._090_cells2;
quit;

proc sql;
  create table work._090_overall as
  select sum(is_case) as patients, count(*) as denominator,
         sum(person_days) as person_days
  from work._090_pt2;
quit;

/*-------------------- assemble the output table ----------------------------*/
data work._090_out_cells;
  set work._090_cells2;
  length measure $20 stratifier $40 ref_population $20;
  measure         = 'std_cell';
  stratifier      = 'Age band';
  person_years    = round(person_days / &days_per_year., 0.0001);
  std_weight      = w;
  rate_per_1000py = round(cell_rate, 0.01);
  ref_population  = 'us_2000_standard';
  covered_weight_pct = .;
  keep ord measure stratifier stratum patients denominator person_days
       person_years std_weight rate_per_1000py ci_low ci_high ci_method
       ref_population covered_weight_pct;
run;

data work._090_out_summ;
  merge work._090_overall work._090_dsr;   /* both single-row */
  length measure $20 stratifier $40 stratum $40 ci_method $16 ref_population $20;
  stratifier   = 'Overall';
  stratum      = 'Overall';
  person_years = round(person_days / &days_per_year., 0.0001);
  std_weight   = .;

  /* crude row - Byar, the same closed form as the incidence twin */
  ord = 98; measure = 'crude'; ref_population = ''; covered_weight_pct = .;
  if person_days > 0 then do;
    rate_per_1000py = round(patients * 1000 * &days_per_year. / person_days, 0.01);
    if patients = 0 then _bl = 0;
    else _bl = ((1 - 1/(9*patients) - 1.96/(3*sqrt(patients)))**3) * patients;
    _bh = ((1 - 1/(9*(patients+1)) + 1.96/(3*sqrt(patients+1)))**3) * (patients+1);
    ci_low  = round(_bl * 1000 * &days_per_year. / person_days, 0.01);
    ci_high = round(_bh * 1000 * &days_per_year. / person_days, 0.01);
    ci_method = 'poisson_byar';
  end;
  else do;
    rate_per_1000py = .; ci_low = .; ci_high = .; ci_method = '';
  end;
  output;

  /* standardized row - labeled with the method actually computed
     (normal_approx), never the merely-requested one; lower bound floored
     at 0 (documented) */
  ord = 99; measure = 'standardized'; ref_population = 'us_2000_standard';
  if w_cov > 0 then do;
    dsr = dsr_num / w_cov;
    se  = sqrt(var_num) / w_cov;
    rate_per_1000py = round(dsr, 0.01);
    ci_low  = round(max(0, dsr - 1.96*se), 0.01);
    ci_high = round(dsr + 1.96*se, 0.01);
  end;
  else do;
    rate_per_1000py = .; ci_low = .; ci_high = .;
  end;
  ci_method = 'normal_approx';
  covered_weight_pct = round(100 * w_cov / w_tot, 0.01);
  output;
  drop _bl _bh dsr se w_cov w_tot dsr_num var_num;
run;

data tz.&tag._090_stdrate;
  set work._090_out_cells work._090_out_summ;
run;

/* same presentation order as the SQL twin's REVIEW query */
proc sort data=tz.&tag._090_stdrate;
  by ord;
run;

title "Direct age standardization (US 2000 standard million) per 1000 PY: <label>";
proc print data=tz.&tag._090_stdrate noobs;
  var ord measure stratifier stratum patients denominator person_days
      person_years std_weight rate_per_1000py ci_low ci_high ci_method
      ref_population covered_weight_pct;
run;

/* REVIEW: at-risk patients assignable to NO standard cell (unknown DOBYR).
   Must be 0 or explained. */
title "REVIEW: patients outside every standard-population cell";
proc sql;
  select (select denominator from tz.&tag._090_stdrate where measure = 'crude')
       - (select sum(denominator) from tz.&tag._090_stdrate where measure = 'std_cell')
         as unassigned_patients;
quit;

/*----------------------------------------------------------------------------
  REVIEW cross-check ONLY - NOT the machine-verified number. PROC STDRATE
  with CL=GAMMA produces the Fay-Feuer gamma interval the spec can request
  (this program computes and labels normal_approx). Uncomment to run against
  a cell-level dataset; expect the DSR point estimate to match this program
  and the gamma CI to be wider at small case counts.

proc stdrate data=work._090_cells2 refdata=work._090_stdpop
             method=direct stat=rate (mult=1000)
             cl=gamma;
  population event=patients total=person_years_unrounded;
  reference  total=w;
  strata stratum;
run;
----------------------------------------------------------------------------*/
```

For the prevalence-base variant the SAS twin mirrors the SQL twin: header +
identical parity stamp + REVIEW limitation block + an empty
`tz.&tag._090_stdrate` created with the full column set (`length`/`format`
declarations, `stop;` before any `output;`) — zero rows, never a number.

Arithmetic-parity notes (pinned by verify/parity.ts SIGNATURES, §10):

| Fragment | SQL | SAS |
|---|---|---|
| Byar low kernel | `1.0/(9*patients)` + `1.96/(3*SQRT(patients))` | `1/(9*patients)` + `1.96/(3*sqrt(patients))` + `**3` |
| Byar high kernel | `1.0/(9*(patients+1))` + `1.96/(3*SQRT(patients+1))` | `1/(9*(patients+1))` + `1.96/(3*sqrt(patients+1))` |
| strictly-after-index case predicate | `> c.index_date` | `> a.index_date` |
| DSR variance kernel | `w * w * patients` | `w * w * patients` |
| CI floor at 0 | `GREATEST(0,` | `max(0, dsr - 1.96*se)` |

---

## 5. Parity record — exact stamped fields

`standardizationParity(an, consumed)` in `src/emitters/parity.ts`, serialized
through the existing `parityStamp`/`stableJson` (stable key order, byte-identical
across twins). Every field is a value the builder ACTUALLY CONSUMED:

```ts
export interface StandardizationParity {
  id: string;                     // an.id
  base: string;                   // an.base as requested
  resultEmitted: boolean;         // false when base != "incidence_rate" (empty table emitted)
  codeListId: string;             // an.outcomeDefinition.codeListId
  rateMultiplier: number;         // the consumed M (default 1000 applied)
  daysPerYear: string;            // the rendered literal each twin embedded ("365.25")
  washout: { start: number | "anytime_before"; end: number | "anytime_after"; includesIndex: boolean };
                                  // the fixed STD_WASHOUT constant: {"anytime_before", 0, true}
  censorAt: string[];             // sorted censor terms actually built into LEAST()/min()
  maxFollowupDays: number | null;
  ciMethod: string;               // "normal_approx" - the method actually computed
  cellCiMethod: string;           // "poisson_byar"  - per-cell/crude CI actually computed
  recurrence: string;             // "first_only"    - what is actually produced
  refPopulation: string;          // "us_2000_standard" | "who_world_2000" | "esp_2013" | "custom"
  refBands: number[];             // inclusive lower bounds actually emitted, ascending
  refWeights: number[];           // weights actually embedded, band-aligned
  strata: string[];               // ["age_band"] - the axes actually standardized
}
```

Stamping `refBands` + `refWeights` means an edit to the weight constants (or a
custom-weight parse divergence) in ONE twin fails the deep-compare instead of
shipping two different standardized rates.

---

## 6. Limitations — every unimplemented option + its REVIEW wording

`standardizationLimitations(an: StandardizationAnalysis): string[]` in
`parity.ts`, rendered as the standard `REVIEW - spec options this program does
not implement yet:` block in BOTH languages (same strings):

| Condition | Emitted wording |
|---|---|
| `base !== "incidence_rate"` | `base "<base>" is NOT implemented - NO standardized result is produced (the output table is created EMPTY); only rate standardization (base "incidence_rate") is emitted in this version` |
| `outcomeDefinition.minClaims > 1` | `outcome minClaims=<n> is NOT yet enforced - any single qualifying claim counts as the outcome` |
| `outcomeDefinition.setting !== "any"` | `outcome care-setting filter "<setting>" is NOT yet applied - events from all settings count` |
| `outcomeDefinition.diagnosisPosition !== "any"` | `diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count` |
| `base === "incidence_rate" && !an.personTimeRule` | `personTimeRule is MISSING (spec readiness should have blocked this) - defensive censoring at first outcome, disenrollment, and study end applied` |
| `personTimeRule.start !== "index"` | `personTimeRule.start="<start>" is NOT implemented - person-time starts at the index date` |
| `strataIds` not exactly `["age_band"]` | `standardization strata [<ids>] are NOT implemented as requested - AGE-band-only direct standardization is produced (the named reference populations are age-only standards)` |
| `standardization.ciMethod !== "normal_approx"` | `ciMethod "<ciMethod>" is NOT implemented (gamma quantiles have no closed form in SQL, and the twins must agree) - the closed-form normal approximation is produced and labeled normal_approx; the commented PROC STDRATE CL=GAMMA block in the SAS program is the cross-check path` |

Always-on REVIEW notes (module behavior, not spec options — emitted outside the
limitations block, in both languages):

- `washout is ALL-AVAILABLE lookback (any qualifying event on or before index marks the patient prevalent) - StandardizationAnalysis has no washout window field`
- `the normal-approximation CI degenerates at 0 cases and is anti-conservative below ~10 observed cases - prefer the gamma interval (PROC STDRATE CL=GAMMA) for delivery tables`
- `covered_weight_pct < 100 means age bands with zero person-time were rebased out of the standard - review before delivery` (attached to the REVIEW select)

Nothing is ever silently ignored: every consumed-vs-requested divergence above
is either a limitation line or an honest output label (`ci_method`,
`resultEmitted`).

---

## 7. Fixture vectors — patient-by-patient hand derivation

Spec: the Gold-A extension analysis of §8 (`base: incidence_rate`, outcome list
`ae_dx`, `us_2000_standard`, `normal_approx`, M = 1000, Y = 365.25, censorAt
`[outcome, disenrollment, study_end, max_followup]`, maxFu 365). All 12 fixture
patients index on 2019-01-01.

**Spine disposition (unchanged, already gold):** indexed 12 → continuous
enrollment drops P11 (61-day gap > 31) → age ≥ 18 drops P12 (age 10) → final
cohort N = 10 = {P01..P10}.

**Washout (all-available lookback: event_date ≤ 2019-01-01):**

| pt | AE event | ≤ index? | disposition |
|---|---|---|---|
| P01 | 2018-06-01 | yes | PREVALENT — excluded |
| P06 | 2018-09-01 | yes | PREVALENT — excluded |
| P02 | 2019-04-11 | no | at risk |
| P03 | 2019-07-20 | no | at risk |
| P07 | 2019-10-28 | no | at risk |
| P04, P05, P08, P09, P10 | (none) | — | at risk |

At-risk denominator = **8** (identical to the incidence gold: the fixture's
baseline events both fall within 365 days of index, so all-available lookback
and the incidence analysis's −365..0 window catch the same two patients).

**Person-time per at-risk patient.** Admin censor = LEAST(episode_end,
2020-12-31, index + 365 = 2020-01-01) = **2020-01-01** for all 8 (episode end
2020-06-30 for everyone at risk, including P07 whose two spans stitch across the
20-day ≤ 31 gap; P07's second segment starts 2019-06-30 > index, so `demo`
rn = 1 picks the first segment — DOBYR 1969 either way). Follow-up censors at
the first outcome (`outcome` ∈ censorAt): person_days = min(fu_date, admin)
− index.

| pt | dobyr | age = 2019−dobyr | US-2000 cell | fu_date | is_case | person_days |
|---|---|---|---|---|---|---|
| P02 | 1974 | 45 | 45-54 (ord 7) | 2019-04-11 | 1 | 31+28+31+10 = **100** |
| P03 | 1969 | 50 | 45-54 (ord 7) | 2019-07-20 | 1 | 181+19 = **200** |
| P07 | 1969 | 50 | 45-54 (ord 7) | 2019-10-28 | 1 | 273+27 = **300** |
| P04 | 1964 | 55 | 55-64 (ord 8) | — | 0 | **365** |
| P05 | 1959 | 60 | 55-64 (ord 8) | — | 0 | **365** |
| P08 | 1964 | 55 | 55-64 (ord 8) | — | 0 | **365** |
| P09 | 1959 | 60 | 55-64 (ord 8) | — | 0 | **365** |
| P10 | 1954 | 65 | 65-74 (ord 9) | — | 0 | **365** |

Totals: cases 3, person_days 100+200+300+5×365 = **2425** (= pinned
`EXPECTED.personDays`).

**Cell aggregates (the three covered cells):**

| cell | d | n | T (days) | person_years = T/365.25 | w |
|---|---|---|---|---|---|
| 45-54 | 3 | 3 | 600 | 600/365.25 = 1.64271 → **1.6427** | 134,834 |
| 55-64 | 0 | 4 | 1460 | 1460/365.25 = 3.99726 → **3.9973** | 87,247 |
| 65-74 | 0 | 1 | 365 | 365/365.25 = 0.99932 → **0.9993** | 66,037 |

All 8 remaining US-2000 cells (<1, 1-4, 5-14, 15-24, 25-34, 35-44, 75-84, 85+)
are EMPTY: patients 0, denominator 0, person_days 0, person_years 0.0000,
rate/CI NULL, ci_method NULL. Σ(cell denominators) = 3+4+1 = 8 = crude
denominator ⇒ `unassigned_patients` REVIEW query returns **0**.

**Per-cell crude rates** (scale factor M·Y/T = 365,250/T):

- 45-54: scale = 365250/600 = 608.75. rate = 3 × 608.75 = **1826.25**.
- 55-64: rate = 0 × 250.17123 = **0.00**. 65-74: rate = 0 × 1000.68493 = **0.00**.

**Byar factors** (z = 1.96):

- d = 3, low: 1 − 1/27 − 1.96/(3√3) = 1 − 0.0370370 − 0.3772022 = 0.5857608;
  cubed = 0.2009837; × 3 = **0.6029511**.
- d = 3, high (d+1 = 4): 1 − 1/36 + 1.96/6 = 1.2988889; cubed = 2.1913715;
  × 4 = **8.7654860**.
- d = 0, low = **0** (by the CASE/if guard). d = 0, high (d+1 = 1):
  1 − 1/9 + 1.96/3 = 1.5422222; cubed = 3.6680942; × 1 = **3.6680942**.

Per-cell CIs:

| cell | ci_low | ci_high |
|---|---|---|
| 45-54 | 0.6029511 × 608.75 = 367.0465 → **367.05** | 8.7654860 × 608.75 = 5335.9896 → **5335.99** |
| 55-64 | **0.00** | 3.6680942 × 250.17123 = 917.6525 → **917.65** |
| 65-74 | **0.00** | 3.6680942 × 1000.68493 = 3670.6099 → **3670.61** |

(45-54 and 55-64 equal the pinned incidence "Age band" gold strata; 65-74 equals
the pinned "65+" stratum — same members, independent cross-validation of the
pinned fixture.)

**Crude Overall row:** rate = 3 × 365250/2425 = 3 × 150.61856 = 451.8557 →
**451.86**; ci_low = 0.6029511 × 150.61856 = 90.8156 → **90.82**; ci_high =
8.7654860 × 150.61856 = 1320.2448 → **1320.24**; person_years = 2425/365.25 =
6.63929 → **6.6393**. Identical to `EXPECTED` incidence Overall — asserted by
referencing the same constants.

**DSR (covered cells rebased):**

- Σw over covered cells: w_cov = 134,834 + 87,247 + 66,037 = **288,118**;
  w_tot = 1,000,000; covered_weight_pct = 100 × 288118/1000000 = 28.8118 →
  **28.81**.
- Numerator: Σ w·r = 134,834 × 1826.25 + 87,247 × 0 + 66,037 × 0
  = **246,240,592.5**.
- DSR = 246,240,592.5 / 288,118 = 854.651887 → **854.65** per 1,000 PY.
  (Sanity: 0 ≤ 854.65 ≤ 1826.25 — the DSR lies between the min and max covered
  cell rates, the COVERAGE-MATRIX invariant.)
- Variance numerator: only the 45-54 cell has d > 0:
  w² · d · (M·Y/T)² = 134,834² × 3 × 608.75² = 18,180,207,556 × 3 × 370,576.5625.
  √(var_num) = w·√d·scale = 134,834 × 1.7320508 × 608.75 = 142,167,081.9
  (√ of the product; carried unrounded by both engines).
- SE = √(var_num)/w_cov = 142,167,081.9 / 288,118 = **493.4335**.
- 1.96 × SE = 967.1297.
- ci_low_raw = 854.6519 − 967.1297 = **−112.4778** → floored → **0.00**
  (this fixture deliberately exercises the floor path).
- ci_high = 854.6519 + 967.1297 = 1821.7815 → **1821.78**.

**Gold assertions to register in `verify/run.ts`** (tolerances follow the
incidence precedent: exact for counts, ±0.01 rates, ±0.05 CIs, ±0.001 PY;
`EXPECTED.standardization` block added to `verify/fixture.ts`):

| assertion | value |
|---|---|
| row count of `tz_study_stdrate` | **13** (11 cells + crude + standardized) |
| standardized row: rate_per_1000py | **854.65** |
| standardized row: ci_low / ci_high | **0.00** / **1821.78** |
| standardized row: ci_method | **'normal_approx'** |
| standardized row: covered_weight_pct | **28.81** |
| standardized row: patients / denominator / person_days | **3 / 8 / 2425** |
| crude row: rate / ci_low / ci_high | **451.86 / 90.82 / 1320.24** (same constants as `EXPECTED.crudeRatePer1000PY` / `byarCiPer1000PY`) |
| cell 45-54: patients/denominator/person_days/std_weight | **3 / 3 / 600 / 134834** |
| cell 45-54: rate / ci | **1826.25 / (367.05, 5335.99)** |
| cell 55-64: patients/denominator/person_days/std_weight | **0 / 4 / 1460 / 87247** |
| cell 55-64: rate / ci | **0.00 / (0.00, 917.65)** |
| cell 65-74: patients/denominator/person_days/std_weight | **0 / 1 / 365 / 66037** |
| cell 65-74: rate / ci | **0.00 / (0.00, 3670.61)** |
| empty-cell probe 35-44: patients/denominator/person_days | **0 / 0 / 0**, rate_per_1000py **IS NULL**, ci_method **IS NULL** |
| Σ cell denominators = crude denominator | **8 = 8** (unassigned = 0) |
| parity | stamps identical across twins; SIGNATURES fragments (§4 table) present in both |

---

## 8. Fixture extension — additive rows needed: **none** (spec-entry only)

No new patients, events, enrollment rows, or reference rows are needed —
`fixtureSeedSql()` is untouched. The existing 12 patients already exercise:
three covered cells (one multi-case, one zero-case-with-person-time, one
single-patient), eight empty cells (rebasing + NULL-rate path), the CI floor at
0, covered-weight < 100 %, and the washout/censoring machinery.

The only change is ONE appended entry in `GOLD_A_SPEC.analyses`:

```ts
{
  id: "a_std", label: "Age-standardized AE incidence (US 2000)", kind: "standardization", enabled: true,
  base: "incidence_rate",
  outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "any", diagnosisPosition: "any" },
  personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
  rateMultiplier: 1000,
  standardization: {
    method: "direct", strataIds: ["age_band"],
    referencePopulation: { kind: "named", name: "us_2000_standard" },
    ciMethod: "normal_approx",
  },
},
```

Non-interference proof (why NO existing gold value can move):

1. **Data:** `fixtureSeedSql()` is byte-identical, so every number that is a
   function of the seeded tables + previously emitted SQL is unchanged.
2. **Spine files (01–06) are analysis-blind:** `build01..build06` never read
   `spec.analyses`, so their emitted bytes are identical.
3. **Incidence file/table unchanged:** `moduleAnalyses` preserves spec order;
   `a_incidence` keeps index 0 → path `sql/postgres/07_incidence.sql` and SAS
   `080_incidence.sas`, and `multi` stays false for both kinds (one analysis
   each) → suffixes unchanged → byte-identical emission. The new files are
   `08_stdrate.sql` / `090_stdrate.sas`, strictly appended; the engine's
   path-sort runs 08 after 07.
4. **New SQL writes only new objects:** `tz_study_stdrate` (all other names are
   CTEs inside one statement). No existing work table is created, dropped, or
   written, so every existing gold SELECT returns identical rows.
5. **Harness bookkeeping is derived, not pinned:** the parity check counts
   enabled analyses with registered stamp kinds (now 2 — both twins stamp);
   invariants are table-scoped with skip-if-absent semantics, so the new table
   cannot fail an existing invariant; `verifyDaysPerYearChoice` queries only
   `tz_study_incidence`.
6. **Readiness:** the new entry passes `validateAnalyses` (ae_dx exists,
   personTimeRule present, strataIds non-empty), so `specReadiness` still
   reports ready.

---

## 9. Output table schema — `${wp}_stdrate${suffix}` / `tz.&tag._<num>_stdrate`

One row per reference-population cell (observed or empty) + crude + standardized.

| column | SQL type | SAS | contents |
|---|---|---|---|
| `ord` | INT | num | deterministic sort key: cells 1..K in band order, crude 98, standardized 99 |
| `measure` | VARCHAR | $20 | `'std_cell'` \| `'crude'` \| `'standardized'` |
| `stratifier` | VARCHAR | $40 | `'Age band'` for cells; `'Overall'` for summary rows |
| `stratum` | VARCHAR | $40 | band label from the reference constant/cellKey (`'<1'`, `'45-54'`, `'85+'`, …); `'Overall'` |
| `patients` | INT | num | incident cases in the cell; cohort totals on summary rows |
| `denominator` | INT | num | at-risk patients in the cell; total at-risk on summary rows |
| `person_days` | NUMERIC | num | person-days at risk (0 for empty cells) |
| `person_years` | NUMERIC(4dp) | num | person_days / `${Y}`, rounded 4 dp |
| `std_weight` | NUMERIC | num | reference weight w_i on cell rows; NULL/. on summary rows |
| `rate_per_1000py` | NUMERIC(2dp) | num | cell/crude rate per M PY; DSR on the standardized row; NULL/. when person_days = 0 (or w_cov = 0) |
| `ci_low`, `ci_high` | NUMERIC(2dp) | num | Byar bounds on cell/crude rows; normal-approx bounds (low floored at 0) on the standardized row; NULL/. when undefined |
| `ci_method` | VARCHAR | $16 | `'poisson_byar'` (cells/crude, NULL/. for empty cells) \| `'normal_approx'` (standardized) — the method actually computed |
| `ref_population` | VARCHAR | $20 | `'us_2000_standard'` \| `'who_world_2000'` \| `'esp_2013'` \| `'custom'` on cell + standardized rows; NULL/'' on crude |
| `covered_weight_pct` | NUMERIC(2dp) | num | 100·Σw_covered/Σw_total, standardized row only (NULL/. elsewhere) |

Small-N / degenerate behavior (both sides, no division errors, no NULL
surprises): empty cell → zeros + NULL rate/CI/ci_method; zero cases with
person-time → rate 0.00, Byar (0, upper); zero covered weight (w_cov = 0, e.g.
empty cohort) → standardized rate/CI NULL, covered_weight_pct 0.00; crude with
person_days = 0 → NULL rate/CI. All divisions are guarded (`NULLIF` in SQL,
`if … > 0` in SAS); `GREATEST`/`max` floors run only under the `w_cov > 0`
guard (Postgres and Snowflake disagree on `GREATEST(0, NULL)`).

---

## 10. Integration checklist — files to touch, in order

1. **`src/emitters/modules/rate-core.ts` (NEW, shared).** Extract the at-risk
   person-time engine from `incidence.ts` into parameterized emit helpers so
   standardization composes with the incidence machinery instead of duplicating
   it: `rateEngineSqlCtes(ctx, p)` (cohort/ae/prevalent/atrisk/first_fu/demo/
   demo1/pt/pt2 CTE lines) and `rateEngineSasSteps(ctx, p, num)` (the matching
   PROC SQL/DATA steps), with `p = { codeListId, washout, censorAt,
   maxFollowupDays, needDemo | demoCols, extraPt2Cols }`; move the Byar
   low/high expression builders here too (emitting the exact strings the
   SIGNATURES pin, column name `patients`).
2. **Refactor `src/emitters/modules/incidence.ts`** to delegate to rate-core.
   Gate: emit Gold Case A (both languages) before and after — the diff must be
   EMPTY (byte-stable emission is the product guarantee), then `npm run verify`
   green. If byte-identity cannot be preserved, stop and re-plan; do not ship a
   changed incidence file under this blueprint.
3. **`src/emitters/parity.ts`** — add `STD_REF_POPS` (§1 constants, with the
   vintage citations as comments), `STD_WASHOUT`, `parseCustomCells(weights)`
   (cellKey grammar + contiguity validation), `standardizationLimitations()`
   (§6 wording), `StandardizationParity` + `standardizationParity()` (§5).
4. **`src/emitters/modules/standardization.ts` (NEW)** — twin `sql()`/`sas()`
   per §3/§4, consuming rate-core; export
   `standardizationModule: AnalysisModule<StandardizationAnalysis>` with
   `analysisKind: "standardization"`, `stampKind: "standardization"`, slug
   `stdrate`.
5. **`src/emitters/modules/registry.ts`** — one line:
   `standardization: standardizationModule as AnalysisModule<never>`.
6. **`src/verify/parity.ts`** — add `SIGNATURES.standardization` with the §4
   fragment table (SQL: `1.0/(9*patients)`, `1.96/(3*SQRT(patients))`,
   `w * w * patients`, `GREATEST(0,`, `> c.index_date`; SAS: `1/(9*patients)`,
   `1.96/(3*sqrt(patients))`, `**3`, `w * w * patients`,
   `max(0, dsr - 1.96*se)`, `> a.index_date`).
7. **`src/verify/fixture.ts`** — append the `a_std` analysis entry (§8) to
   `GOLD_A_SPEC.analyses` and add the `EXPECTED.standardization` block (§7
   values). ADDITIVE ONLY — no data rows, no edits to existing constants.
8. **`src/verify/run.ts`** — register the §7 assertion table against
   `tz_study_stdrate` (row count, standardized/crude rows, the three covered
   cells, the 35-44 empty-cell probe, Σ cell denominators = crude denominator).
9. **`src/verify/invariants.ts` (optional but recommended)** — table-scoped,
   skip-if-absent `stdrate` invariants for ANY study: num ≤ den per row,
   CI ordering where non-NULL, DSR between min and max covered cell rate,
   Σ cell person_days = crude person_days.
10. **`src/spec/types.ts` (validation only, no schema change)** — extend the
    `case "standardization"` branch of `validateAnalyses`: custom-weight cellKey
    grammar/contiguity problems; warn when `strataIds` ≠ `["age_band"]`; warn
    when `rateMultiplier` ≤ 0.
11. **Run `npm run verify`** — all pre-existing gold checks must pass untouched
    (non-interference §8), plus the new standardization checks and twin parity.
12. **`docs/COVERAGE-MATRIX.md`** — flip "Age/sex direct & indirect
    standardization" from `absent` to `done` for the direct/age slice, with the
    honest residuals noted: indirect (SIR/SMR), sex-stratified weights,
    prevalence bases, and gamma/Fay-Feuer CIs remain unemitted and are
    REVIEW-labeled.
