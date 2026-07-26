# calendar_trend module blueprint

Module file: `packages/core/src/emitters/modules/caltrend.ts` — `analysisKind: "calendar_trend"`, `stampKind: "caltrend"`.
Shape contract: twin `sql()`/`sas()` per `modules/types.ts`, PARITY stamp + REVIEW limitations per `modules/incidence.ts` (the reference module).

---

## 1. Method — precise definition + literature refs

### 1.1 The panel-churn problem this module exists to solve

MarketScan is a convenience panel: contributing employers/plans enter and exit every year, so
raw per-year case COUNTS are meaningless as trends (COVERAGE-MATRIX "Calendar-time trends
(panel-churn safeguard)"; DOMAIN-RULES §3). The safeguard is that every calendar bucket gets a
**mandatory denominator** and the measure is a **rate/proportion**, never a count. This module
therefore ALWAYS emits the per-bucket denominator table, even when `trend.reportPerBucket=false`
(forced on, with a REVIEW note — see §6).

### 1.2 Population, buckets, and the per-bucket denominator (pinned definitions)

* **Population** = the final analysis cohort (`{wp}_cohort` / `ctx.finalCohort`) — the spine's
  attrition survivors. A surveillance study that wants "all enrollees" expresses that by making
  the spine cohort the enrolled population; the module never invents a second population.
* **Buckets** are derived at **generation time** from `spec.meta.studyPeriod` and
  `trend.bucket`, clipped to the study period, and embedded as literal dates in BOTH twins
  (no runtime `date_trunc`, so the twins cannot drift):
  * `calendar_year`: one bucket per calendar year touched by the study period; label `"2018"`.
  * `calendar_quarter`: label `"2018Q1"`; `calendar_month`: label `"2018-01"`.
  * `bucket_ord` = 0-based chronological index; bucket bounds are
    `[max(bucket calendar start, studyPeriod.start), min(bucket calendar end, studyPeriod.end)]`.
  * Scores for the trend tests are `x_b = bucket_ord` (see §1.4 invariance note). If the first or
    last bucket is truncated by the study period, equal-spacing scores are retained and a REVIEW
    note is emitted.
* **Per-bucket denominator (the panel-churn-safe denominator)**, for bucket `b`:
  * **person-days** `t_b = Σ_{i∈cohort} Σ_{episodes e of i} max(0, min(e.end, b.end) − max(e.start, b.start) + 1)`
    — stitched enrollment episodes (`{wp}_enroll_episodes` / `050_epi`) intersected with the
    bucket window, counted **inclusively** on both ends (MarketScan DTSTART/DTEND are both
    covered days). Stitched episodes include allowed gaps (≤ `gapAllowanceDays`), consistent
    with the spine's own definition of continuous coverage.
  * **person-years** `t_b / daysPerYear` (`spec.meta.daysPerYear` via `renderDaysPerYear`, default 365.25).
  * **enrolled patients** `N_b` = distinct cohort members with ≥1 episode overlapping `b`.
  * Parity note: the SQL spine builds `{wp}_enroll_episodes` from ALL members in the raw
    enrollment table while SAS `040_enroll` pulls only indexed patients — both twins therefore
    JOIN episodes to the final cohort first, which restricts both sides to the identical set.
* **Per-bucket numerator**:
  * **events** `c_b` = distinct (patient, event_date) pairs with a qualifying outcome event
    (from `{wp}_events` / `ctx.evOf(codeListId)`) whose date falls inside `b` AND inside one of
    that patient's stitched episodes (an event recorded outside enrolled time never counts,
    matching the denominator's coverage definition). This counts qualifying **event-days**, so a
    same-day duplicate across settings/codes counts once.
  * **case patients** `r_b` = distinct patients with ≥1 such event in `b`.

### 1.3 Per-bucket measure by `base`

* `base = "incidence_rate"` → **open-cohort surveillance event rate**, labeled `calendar_rate`:
  `rate_b = c_b · M · Y / t_b` per `rateMultiplier` (M) person-years, with the **Byar
  exact-Poisson approximation CI** — the identical closed form as the incidence module
  (Ulm, *Am J Epidemiol* 1990;131:373–375; Breslow & Day, *Statistical Methods in Cancer
  Research Vol II*, IARC Sci Pub 82, 1987, Ch. 2 — Byar's approximation):
  `low = (1 − 1/(9c) − 1.96/(3√c))³ · c` (0 when c=0), `high = (1 − 1/(9(c+1)) + 1.96/(3√(c+1)))³ · (c+1)`,
  both scaled by `M·Y/t_b`. NOTE (honest label): this is NOT index-anchored at-risk incidence —
  no washout, no first-only restriction, no `personTimeRule` censoring; it is the classic
  per-period surveillance rate. All of that is disclosed via REVIEW notes (§6) and the
  `measure`/`ci_method` labels record what was actually computed.
* `base = "period_prevalence"` (and, in V1, `"point_prevalence"` — see §6) → **per-bucket period
  prevalence**, labeled `calendar_period_prevalence`: `p_b = r_b / N_b` with the **Wilson score
  CI** (Wilson, *JASA* 1927;22:209–212; Newcombe, *Stat Med* 1998;17:857–872, method 3):
  `low,high = (p̂ + z²/2n ∓ z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)`, z = 1.96.

### 1.4 Trend statistics — closed forms, null distributions, SQL-computability

All three statistics reduce to **single-pass sums/products** over the per-bucket table — verified
SQL-computable (one aggregate pass + scalar arithmetic; no inverse-CDF, no iteration).

**(a) Cochran–Armitage trend in proportions** (Cochran, *Biometrics* 1954;10:417–451, §6;
Armitage, *Biometrics* 1955;11:375–386, eqs. 2–4; Agresti, *Categorical Data Analysis* 2e, 2002,
§5.3.5 pp. 179–182). With buckets i, scores x_i, cases r_i, denominators n_i,
`N = Σn_i`, `R = Σr_i`, `p̄ = R/N`:

```
T   = Σ x_i r_i − p̄ · Σ x_i n_i
Var = p̄(1−p̄) · [ Σ n_i x_i² − (Σ n_i x_i)²/N ]
Z   = T/√Var        ~  N(0,1) under H0;   Z² ~ χ²(1)
```

Invariance: Z is invariant to affine transformations of the scores, so `x_i = bucket_ord`
(0-based integers) is a pinned, loss-free convention. Caveat (emitted as a fixed comment in both
twins): buckets are repeated cross-sections of an open cohort — the same member contributes to
several buckets, so the independent-binomial assumption is approximate.

**(b) Poisson rate-trend score test** (Breslow & Day Vol II, 1987, Ch. 4 — grouped cohort
data, test for trend with person-years; Clayton & Hills, *Statistical Models in Epidemiology*,
OUP 1993, Ch. 24 — Poisson likelihood). Log-linear model `c_i ~ Poisson(λ_i t_i)`,
`log λ_i = α + β x_i`; score test of β=0 with α profiled out. With `C = Σc_i`, `T = Σt_i`,
`λ̂ = C/T`:

```
U = Σ x_i c_i − λ̂ · Σ x_i t_i
V = λ̂ · [ Σ t_i x_i² − (Σ t_i x_i)²/T ]
Z = U/√V            ~  N(0,1) under H0;   Z² ~ χ²(1)
```

Time-unit invariance (why the statistic is computed on person-DAYS, with no `daysPerYear`
inside it): scaling every t_i by a constant k scales λ̂ by 1/k, leaving λ̂·t_i, U, and V
unchanged — so days-vs-years cannot cause twin drift. Score-shift invariance holds because
`U(x+a) = U(x) + a(C − λ̂T) = U(x)`.

**(c) linear_slope — weighted least squares** (Draper & Smith, *Applied Regression Analysis* 3e,
1998, Ch. 9 — weighted least squares). y_i = per-bucket estimate recomputed **unrounded** from the
raw integer columns (rate per M PY for the rate base; proportion for the prevalence base),
weights w_i = person-years t_i/Y (rate base) or n_i (prevalence base), restricted to buckets
with w_i > 0 (k_eff of them):

```
Sw=Σw, Sx=Σwx, Sy=Σwy, Sxx=Σwx²−Sx²/Sw, Sxy=Σwxy−SxSy/Sw, Syy=Σwy²−Sy²/Sw
slope β̂  = Sxy/Sxx
SE(β̂)   = √( max(0, Syy − Sxy²/Sxx) / (k_eff−2) / Sxx )     [working variance Var(y_i) ∝ 1/w_i]
t        = β̂/SE,   df = k_eff − 2
```

The single-pass identity `RSS_w = Syy − Sxy²/Sxx` avoids a residual second pass. The SE is a
*working-variance* WLS SE (weights treated as known up to a constant) — labeled as such.

### 1.5 P-value strategy (decided + justified)

* **CA and Poisson trend** (both Z² ~ χ²(1)): the χ²(1) tail is exactly the two-sided normal
  tail, `p = 2(1 − Φ(|Z|))`, and Φ has a published uniformly-accurate closed form —
  **Abramowitz & Stegun, *Handbook of Mathematical Functions* (1964), formula 26.2.17, p. 932**
  (polynomial × exp, |error| < 7.5×10⁻⁸, far below the 4-dp display precision). This is NOT a
  data-dependent inverse-CDF (the warehouse-SQL ceiling in COVERAGE-MATRIX bans quantile
  functions, not forward CDFs), so **BOTH twins compute the identical A&S closed form** — SAS
  deliberately does NOT call PROBCHI, so the twins are arithmetic-identical; a comment in the SAS
  program invites a PROBCHI cross-check (agrees to <1e-7). The p column is honestly labeled
  `p_method = 'chi2_1df_normal_cdf_as26_2_17'`. Additionally, exact fixed-alpha flags
  `sig_alpha_05`/`sig_alpha_01` compare |Z| against the exact normal critical values
  1.959964 / 2.575829 (constants, no CDF needed).
* **linear_slope**: the Student-t CDF for arbitrary small df has no comparable closed form —
  `p_value` is **NULL in BOTH twins** with `p_method = 'none_t_cdf'` and a loud comment; the
  emitted `t_statistic` + `t_df` let a SAS analyst run `PROBT` as a supplementary check.
  Significance flags use **exact two-sided t critical values embedded at generation time** as a
  df-indexed CASE table (df 1–30; df>30 falls back to 1.9600/2.5758 with a note) — constants
  from standard t tables (equal to R's `qt(0.975,df)`/`qt(0.995,df)` to 4 dp), listed in §3.4.

### 1.6 Small-N / degenerate behavior (both twins, no errors)

| Condition | Behavior |
|---|---|
| bucket with `t_b = 0` (or `N_b = 0`) | bucket row still emitted (mandatory disclosure) with denominator 0 and `estimate`/`ci_low`/`ci_high` NULL (`NULLIF` in SQL; `if … > 0 then … else` missing in SAS); the bucket contributes exactly 0 to every trend sum (all terms carry t_i or n_i) |
| `c_b = 0` with `t_b > 0` | rate 0.00, Byar low 0 (guarded CASE), Byar high from c+1=1 — no division error |
| `r_b = 0` or `r_b = n_b` (Wilson) | exact closed values (e.g. 0/n → low 0, high z²/(n+z²)) — no error |
| C = 0 (no cases anywhere) or p̄ ∈ {0,1} | V = 0 → Z, chisq, p, sig flags all NULL via `NULLIF(SQRT(V),0)` / SAS missing |
| k_eff < 2 | Sxx = 0 → slope NULL; CA/Poisson V = 0 → NULL |
| k_eff = 2 (slope) | df = 0 → SE/t NULL via `NULLIF(k_eff−2,0)`; slope itself still reported |
| float noise making RSS < 0 | `GREATEST(0, …)` / `max(0, …)` clamp |

---

## 2. Spec consumption — the analysis interface verbatim + field-by-field mapping

From `packages/core/src/spec/types.ts` (verbatim):

```ts
/** Calendar-trend test. Ref: Cochran Biometrics 1954;10:417; Armitage 1955;11:375. */
export interface TrendSpec {
  bucket: "calendar_year" | "calendar_quarter" | "calendar_month";
  method: "cochran_armitage" | "poisson_rate_trend" | "linear_slope";
  reportPerBucket: boolean;
}
```

```ts
export interface CalendarTrendAnalysis extends AnalysisCommon {
  kind: "calendar_trend";
  base: "point_prevalence" | "period_prevalence" | "incidence_rate";
  outcomeDefinition: OutcomeDefinition;
  personTimeRule?: PersonTimeRule; // required when base === "incidence_rate"
  rateMultiplier?: number;
  denominatorRule: DenominatorRule;
  trend: TrendSpec;
  ciMethod: ProportionCiMethod | RateCiMethod;
  stratifyBy: Stratifier[];
}
```

(Also consumed: `OutcomeDefinition { codeListId, minClaims, claimSeparationDays?, setting,
diagnosisPosition }`, `DenominatorRule`, `ProportionCiMethod`, `RateCiMethod`, `Stratifier`,
`AnalysisCommon { id, label, enabled, notes? }`, and `spec.meta.daysPerYear` /
`spec.meta.studyPeriod` — all defined in the same file.)

Field-by-field:

| Field | V1 consumption |
|---|---|
| `id`, `label` | file titles, output-table suffix (when several calendar_trend analyses exist), parity `id` |
| `base` | selects the per-bucket measure: `incidence_rate` → `calendar_rate`; `period_prevalence` → `calendar_period_prevalence`; `point_prevalence` → computed as per-bucket PERIOD prevalence + REVIEW note (§6) |
| `outcomeDefinition.codeListId` | event source: `{wp}_events WHERE code_list_id = …` / `ctx.evOf(codeListId)` |
| `outcomeDefinition.minClaims / claimSeparationDays / setting / diagnosisPosition` | NOT enforced in V1 → REVIEW notes (identical policy + wording family as `incidenceLimitations`) |
| `personTimeRule` | NOT applied (open-cohort denominator) → loud REVIEW note; still spec-required for rate base (validator) |
| `rateMultiplier` | M in the rate scale; when absent on the rate base, defaults to 1000 + REVIEW note; stamped as consumed |
| `denominatorRule` | compared against the rule actually computed (`person_time` for rate base, `enrolled_anytime` for proportion bases); mismatch → REVIEW note; BOTH requested and computed values stamped |
| `trend.bucket` | generation-time bucket enumeration (§1.2) |
| `trend.method` | computed when base-compatible; `cochran_armitage` on a rate base → Poisson trend computed instead (and vice versa), with REVIEW note; `methodComputed` stamped and written into the output row |
| `trend.reportPerBucket` | forced `true` (mandatory panel-churn disclosure) — `false` → REVIEW note |
| `ciMethod` | `wilson` (proportion) / `poisson_byar` (rate) computed; any other request → REVIEW note; output `ci_method` column carries the method actually computed |
| `stratifyBy` | NOT implemented in V1 — each stratifier becomes a REVIEW note; `strata: []` stamped |
| `spec.meta.daysPerYear` | via `renderDaysPerYear(spec)` (SQL) / `&days_per_year.` + `ctx.daysPerYearLit` (SAS); never hard-coded |
| `spec.meta.studyPeriod` | bucket clipping bounds |

---

## 3. SQL twin — complete CTE chain (Postgres; Snowflake via Dialect helpers only)

Two tables per analysis: `${wp}_caltrend${suffix}` (per-bucket) and
`${wp}_caltrend_test${suffix}` (one trend row). `${wp}`/`${suffix}` from ctx; `${Y}` =
`renderDaysPerYear(spec)` (decimal literal — avoids integer division); `${M}` = rateMultiplier;
`${clid}` = codeListId. `LEAST/GREATEST/POWER/SQRT/EXP/ABS`, CTE column lists, and `VALUES` are
native in both Postgres 16/PGlite and Snowflake; date arithmetic goes through `d.daysBetween`,
rounding through `d.roundN`, table creation through `d.createTableAs`. The bucket VALUES list
below is the Gold-A rendering (calendar_year over 2018-01-01..2020-12-31).

### 3.1 Per-bucket table (shown for base = incidence_rate; §3.3 gives the proportion deltas)

```sql
-- PARITY caltrend {…}                          (see §5 for the exact record)
-- REVIEW - spec options this program does not implement yet:
--   * …                                        (see §6)
DROP TABLE IF EXISTS ${wp}_caltrend${suffix};
CREATE TABLE ${wp}_caltrend${suffix} AS
WITH cohort AS (SELECT enrolid FROM ${wp}_cohort),
buckets (bucket_ord, bucket, bucket_start, bucket_end) AS (
  VALUES (0, '2018', DATE '2018-01-01', DATE '2018-12-31'),
         (1, '2019', DATE '2019-01-01', DATE '2019-12-31'),
         (2, '2020', DATE '2020-01-01', DATE '2020-12-31')
),
epi AS (   -- stitched enrollment episodes of FINAL-COHORT members only (twin-parity anchor)
  SELECT ep.enrolid, ep.episode_start, ep.episode_end
  FROM ${wp}_enroll_episodes ep
  JOIN cohort c ON c.enrolid = ep.enrolid
),
denom AS (   -- panel-churn-safe denominator: episode ∩ bucket, inclusive day count
  SELECT b.bucket_ord,
         SUM((LEAST(e.episode_end, b.bucket_end) - GREATEST(e.episode_start, b.bucket_start)) + 1) AS person_days,
         COUNT(DISTINCT e.enrolid) AS denominator
  FROM buckets b
  JOIN epi e ON e.episode_start <= b.bucket_end
            AND e.episode_end   >= b.bucket_start
  GROUP BY b.bucket_ord
),
ae AS (SELECT enrolid, event_date FROM ${wp}_events WHERE code_list_id = '${clid}'),
ev AS (   -- qualifying event-DAYS of cohort members during enrolled time
  SELECT DISTINCT a.enrolid, a.event_date
  FROM ae a
  JOIN epi e ON e.enrolid = a.enrolid
            AND a.event_date BETWEEN e.episode_start AND e.episode_end
),
numer AS (
  SELECT b.bucket_ord, COUNT(*) AS events, COUNT(DISTINCT v.enrolid) AS case_patients
  FROM buckets b
  JOIN ev v ON v.event_date BETWEEN b.bucket_start AND b.bucket_end
  GROUP BY b.bucket_ord
),
pb AS (   -- LEFT JOIN from buckets: an empty bucket still gets its mandatory denominator row
  SELECT b.bucket_ord, b.bucket, b.bucket_start, b.bucket_end,
         COALESCE(d.denominator, 0)  AS denominator,
         COALESCE(d.person_days, 0)  AS person_days,
         COALESCE(n.events, 0)       AS events,
         COALESCE(n.case_patients, 0) AS case_patients
  FROM buckets b
  LEFT JOIN denom d ON d.bucket_ord = b.bucket_ord
  LEFT JOIN numer n ON n.bucket_ord = b.bucket_ord
)
SELECT 'calendar_rate' AS measure,
       bucket_ord, bucket, bucket_start, bucket_end,
       denominator, person_days,
       ROUND(CAST(person_days / ${Y} AS NUMERIC), 4) AS person_years,
       events, case_patients,
       events AS cases,                      -- the numerator the measure actually uses
       ROUND(CAST(events * ${M} * ${Y} / NULLIF(person_days, 0) AS NUMERIC), 2) AS estimate,
       ROUND(CAST((CASE WHEN events = 0 THEN 0
                        ELSE POWER(1 - 1.0/(9*events) - 1.96/(3*SQRT(events)), 3) * events END)
                  * ${M} * ${Y} / NULLIF(person_days, 0) AS NUMERIC), 2) AS ci_low,
       ROUND(CAST(POWER(1 - 1.0/(9*(events+1)) + 1.96/(3*SQRT(events+1)), 3) * (events+1)
                  * ${M} * ${Y} / NULLIF(person_days, 0) AS NUMERIC), 2) AS ci_high,
       'poisson_byar' AS ci_method           -- labeled with the method actually computed
FROM pb;

-- REVIEW: per-bucket denominator + measure (mandatory panel-churn disclosure).
SELECT * FROM ${wp}_caltrend${suffix} ORDER BY bucket_ord;
```

### 3.2 Trend-test table (method = poisson_rate_trend; reads RAW integer columns, never rounded ones)

```sql
DROP TABLE IF EXISTS ${wp}_caltrend_test${suffix};
CREATE TABLE ${wp}_caltrend_test${suffix} AS
WITH pb AS (
  SELECT bucket_ord AS x, events AS c, person_days AS t
  FROM ${wp}_caltrend${suffix}
),
s AS (   -- ALL trend inputs are single-pass sums; zero-denominator buckets add exactly 0
  SELECT SUM(c) AS cc, SUM(t) AS tt,
         SUM(x * c) AS sxc, SUM(x * t) AS sxt, SUM(x * x * t) AS sxxt,
         COUNT(*) AS k, SUM(CASE WHEN t > 0 THEN 1 ELSE 0 END) AS k_used
  FROM pb
),
uv AS (   -- score test: U = Σxc − λ̂Σxt; V = λ̂[Σx²t − (Σxt)²/T]; λ̂ = C/T
          -- computed on person-DAYS: the statistic is invariant to the time unit (§1.4b)
  SELECT k, k_used,
         sxc - (CAST(cc AS NUMERIC) / NULLIF(tt, 0)) * sxt                            AS u,
         (CAST(cc AS NUMERIC) / NULLIF(tt, 0)) * (sxxt - (sxt * CAST(sxt AS NUMERIC)) / NULLIF(tt, 0)) AS v
  FROM s
),
z AS (SELECT k, k_used, u / NULLIF(SQRT(v), 0) AS z_stat FROM uv)
SELECT 'calendar_trend_test' AS measure,
       'poisson_rate_trend'  AS method,          -- the method actually computed
       'bucket_index_0based' AS score_type,
       k AS n_buckets, k_used AS n_buckets_used,
       ROUND(CAST(z_stat AS NUMERIC), 4)          AS z_statistic,
       ROUND(CAST(z_stat * z_stat AS NUMERIC), 4) AS chisq_1df,
       -- two-sided p under the chi-square(1) null = 2*(1 - Phi(|z|));
       -- Abramowitz-Stegun 26.2.17 closed form, |error| < 7.5e-8 (§1.5) -- NOT an exact CDF
       ROUND(CAST(
         2 * (EXP(-(z_stat*z_stat)/2) / 2.5066282746310002)
           * (0.319381530 * (1/(1+0.2316419*ABS(z_stat)))
            - 0.356563782 * POWER(1/(1+0.2316419*ABS(z_stat)), 2)
            + 1.781477937 * POWER(1/(1+0.2316419*ABS(z_stat)), 3)
            - 1.821255978 * POWER(1/(1+0.2316419*ABS(z_stat)), 4)
            + 1.330274429 * POWER(1/(1+0.2316419*ABS(z_stat)), 5)) AS NUMERIC), 4) AS p_value,
       'chi2_1df_normal_cdf_as26_2_17' AS p_method,
       CASE WHEN z_stat IS NULL THEN NULL WHEN ABS(z_stat) >= 1.959964 THEN 1 ELSE 0 END AS sig_alpha_05,
       CASE WHEN z_stat IS NULL THEN NULL WHEN ABS(z_stat) >= 2.575829 THEN 1 ELSE 0 END AS sig_alpha_01,
       CAST(NULL AS NUMERIC) AS slope, CAST(NULL AS NUMERIC) AS slope_se,
       CAST(NULL AS NUMERIC) AS t_statistic, CAST(NULL AS INT) AS t_df
FROM z;

-- REVIEW: trend test. CAVEAT - the same member contributes to several buckets (repeated
-- cross-sections of an open cohort); the null assumes independent buckets, so treat the
-- p-value as approximate.
SELECT * FROM ${wp}_caltrend_test${suffix};
```

### 3.3 Method/base variants (only the deltas)

* **Proportion base per-bucket table**: `measure = 'calendar_period_prevalence'`;
  `cases = case_patients`; `estimate = ROUND(CAST(case_patients AS NUMERIC)/NULLIF(denominator,0), 4)`;
  Wilson CI with z=1.96, z²=3.8416 (both twins render the identical expression shape):

```sql
ROUND(CAST(( (case_patients/NULLIF(CAST(denominator AS NUMERIC),0)) + 3.8416/(2*denominator)
           - 1.96 * SQRT( (case_patients/NULLIF(CAST(denominator AS NUMERIC),0))
                          * (1 - case_patients/NULLIF(CAST(denominator AS NUMERIC),0)) / denominator
                        + 3.8416/(4*CAST(denominator AS NUMERIC)*denominator) ) )
           / (1 + 3.8416/NULLIF(CAST(denominator AS NUMERIC),0)) AS NUMERIC), 4) AS ci_low
-- ci_high: same with '+ 1.96 * SQRT(…)'; ci_method = 'wilson'
-- person_days / person_years still populated (supplementary churn disclosure)
```

* **cochran_armitage test** (proportion base): in `pb` select `case_patients AS c,
  denominator AS n`; sums `SUM(c) AS rr, SUM(n) AS nn, SUM(x*c) AS sxr, SUM(x*n) AS sxn,
  SUM(x*x*n) AS sxxn`; then

```sql
u = sxr - (CAST(rr AS NUMERIC)/NULLIF(nn,0)) * sxn
v = (CAST(rr AS NUMERIC)/NULLIF(nn,0)) * (1 - CAST(rr AS NUMERIC)/NULLIF(nn,0))
    * (sxxn - (sxn * CAST(sxn AS NUMERIC))/NULLIF(nn,0))
-- z/p/sig columns identical to §3.2; method = 'cochran_armitage'
```

* **linear_slope test** (either base): in `pb` recompute the UNROUNDED y from raw integers and
  filter to positive weights:

```sql
pb AS (SELECT bucket_ord AS x,
              CAST(person_days AS NUMERIC) / ${Y} AS w,                      -- rate base
              CAST(events AS NUMERIC) * ${M} * ${Y} / person_days AS y      -- rate base
       FROM ${wp}_caltrend${suffix} WHERE person_days > 0)
-- proportion base: w = denominator, y = case_patients::numeric/denominator, WHERE denominator > 0
s AS (SELECT SUM(w) sw, SUM(w*x) sx, SUM(w*x*x) sxx, SUM(w*y) sy, SUM(w*x*y) sxy,
             SUM(w*y*y) syy, COUNT(*) AS k_used FROM pb),
fit AS (SELECT k_used,
        (sxy - sx*sy/sw)                    AS sxy_c,
        (sxx - sx*sx/sw)                    AS sxx_c,
        (syy - sy*sy/sw)                    AS syy_c FROM s),
sl AS (SELECT k_used,
        sxy_c / NULLIF(sxx_c, 0) AS slope,
        SQRT( GREATEST(0, syy_c - (sxy_c*sxy_c)/NULLIF(sxx_c,0))
              / NULLIF(k_used - 2, 0) / NULLIF(sxx_c, 0) ) AS se FROM fit)
SELECT …, 'linear_slope' AS method,
       CAST(NULL AS NUMERIC) AS z_statistic, CAST(NULL AS NUMERIC) AS chisq_1df,
       CAST(NULL AS NUMERIC) AS p_value, 'none_t_cdf' AS p_method,   -- t CDF: no SQL closed form
       ROUND(CAST(slope AS NUMERIC), 4)      AS slope,
       ROUND(CAST(se AS NUMERIC), 4)         AS slope_se,
       ROUND(CAST(slope / NULLIF(se, 0) AS NUMERIC), 4) AS t_statistic,
       k_used - 2 AS t_df,
       CASE WHEN slope/NULLIF(se,0) IS NULL THEN NULL
            WHEN ABS(slope/NULLIF(se,0)) >= (CASE k_used - 2
              WHEN 1 THEN 12.7062 WHEN 2 THEN 4.3027 WHEN 3 THEN 3.1824 WHEN 4 THEN 2.7764
              WHEN 5 THEN 2.5706 WHEN 6 THEN 2.4469 WHEN 7 THEN 2.3646 WHEN 8 THEN 2.3060
              WHEN 9 THEN 2.2622 WHEN 10 THEN 2.2281 /* … df 11-30 per §3.4 … */
              ELSE 1.9600 END) THEN 1 ELSE 0 END AS sig_alpha_05
       -- sig_alpha_01 analogous with the α=.01 column of §3.4
FROM sl;
```

* **Method/base mismatch** (e.g. `cochran_armitage` requested on `incidence_rate`): the module
  computes the base-compatible score test, stamps + labels the computed method, and emits the
  REVIEW substitution note (§6). `linear_slope` runs on either base.

### 3.4 Generation-time t critical values (two-sided; = R `qt(0.975,df)` / `qt(0.995,df)`, 4 dp)

| df | α=.05 | α=.01 | | df | α=.05 | α=.01 | | df | α=.05 | α=.01 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 12.7062 | 63.6567 | | 11 | 2.2010 | 3.1058 | | 21 | 2.0796 | 2.8314 |
| 2 | 4.3027 | 9.9248 | | 12 | 2.1788 | 3.0545 | | 22 | 2.0739 | 2.8188 |
| 3 | 3.1824 | 5.8409 | | 13 | 2.1604 | 3.0123 | | 23 | 2.0687 | 2.8073 |
| 4 | 2.7764 | 4.6041 | | 14 | 2.1448 | 2.9768 | | 24 | 2.0639 | 2.7969 |
| 5 | 2.5706 | 4.0321 | | 15 | 2.1315 | 2.9467 | | 25 | 2.0595 | 2.7874 |
| 6 | 2.4469 | 3.7074 | | 16 | 2.1199 | 2.9208 | | 26 | 2.0555 | 2.7787 |
| 7 | 2.3646 | 3.4995 | | 17 | 2.1098 | 2.8982 | | 27 | 2.0518 | 2.7707 |
| 8 | 2.3060 | 3.3554 | | 18 | 2.1009 | 2.8784 | | 28 | 2.0484 | 2.7633 |
| 9 | 2.2622 | 3.2498 | | 19 | 2.0930 | 2.8609 | | 29 | 2.0452 | 2.7564 |
| 10 | 2.2281 | 3.1693 | | 20 | 2.0860 | 2.8453 | | 30 | 2.0423 | 2.7500 |

df > 30 → 1.9600 / 2.5758 (normal fallback, noted in a comment). The table lives in
`emitters/parity.ts` as shared constants so both twins render identical literals.

---

## 4. SAS twin — complete program mirroring the SQL arithmetic

Rendered for base = incidence_rate / poisson_rate_trend (Gold `a_ct_rate`); variant deltas mirror
§3.3 exactly. `${cohT}` = `ctx.finalCohort`, `${epiT}` = `ctx.tbl("050_epi")` (columns enrolid,
episode, dtstart, dtend), `${evT}` = `ctx.evOf(clid)` (enrolid, svcdate, …), `${outT}` =
`ctx.tbl(`${num}_caltrend${suffix}`)`, `${tstT}` = `ctx.tbl(`${num}_ctest${suffix}`)` (short
member name — ctx.tbl's 32-char name pool truncates/dedupes deterministically).

```sas
/* header(…) — house header via sas-base */
/* PARITY caltrend {…}   — byte-identical stableJson to the SQL twin (§5) */

/* REVIEW - spec options this program does not implement yet:
   * …                     (same list as the SQL twin, §6)
*/

%include "00_setup.sas";   /* EDIT: use the full site path to 00_setup.sas */

proc datasets lib=tz nolist nowarn;
  delete <outT-member> <tstT-member>;
quit;

/*-------------------- calendar buckets (generation-time constants) ----------*/
data work._<num>_buckets;
  length bucket $10;
  bucket_ord = 0; bucket = '2018'; bucket_start = '01JAN2018'd; bucket_end = '31DEC2018'd; output;
  bucket_ord = 1; bucket = '2019'; bucket_start = '01JAN2019'd; bucket_end = '31DEC2019'd; output;
  bucket_ord = 2; bucket = '2020'; bucket_start = '01JAN2020'd; bucket_end = '31DEC2020'd; output;
  format bucket_start bucket_end date9.;
run;

/*-------------------- episodes of final-cohort members ----------------------*/
proc sql;
  create table work._<num>_epi as
  select distinct e.enrolid, e.dtstart, e.dtend
  from ${epiT} as e
  inner join ${cohT} as a on a.enrolid = e.enrolid;
quit;

/*----------------------------------------------------------------------------
  Panel-churn-safe denominator: stitched episode ∩ bucket, inclusive day count
  min(e.dtend, b.bucket_end) - max(e.dtstart, b.bucket_start) + 1
  — the SAME closed form as the SQL twin (LEAST/GREATEST + 1).
----------------------------------------------------------------------------*/
proc sql;
  create table work._<num>_denom as
  select b.bucket_ord,
         sum(min(e.dtend, b.bucket_end) - max(e.dtstart, b.bucket_start) + 1) as person_days,
         count(distinct e.enrolid) as denominator
  from work._<num>_buckets as b
  inner join work._<num>_epi as e
    on  e.dtstart <= b.bucket_end
    and e.dtend   >= b.bucket_start
  group by b.bucket_ord;
quit;

/*-------------------- qualifying event-days during enrolled time ------------*/
proc sql;
  create table work._<num>_ev as
  select distinct a.enrolid, a.svcdate
  from ${evT} as a
  inner join work._<num>_epi as e
    on  e.enrolid = a.enrolid
    and a.svcdate between e.dtstart and e.dtend;

  create table work._<num>_numer as
  select b.bucket_ord,
         count(*) as events,
         count(distinct v.enrolid) as case_patients
  from work._<num>_buckets as b
  inner join work._<num>_ev as v
    on v.svcdate between b.bucket_start and b.bucket_end
  group by b.bucket_ord;
quit;

/*-------------------- per-bucket table (empty buckets kept) -----------------*/
proc sql;
  create table work._<num>_pb as
  select b.bucket_ord, b.bucket, b.bucket_start, b.bucket_end,
         coalesce(d.denominator, 0)   as denominator,
         coalesce(d.person_days, 0)   as person_days,
         coalesce(n.events, 0)        as events,
         coalesce(n.case_patients, 0) as case_patients
  from work._<num>_buckets as b
  left join work._<num>_denom as d on d.bucket_ord = b.bucket_ord
  left join work._<num>_numer as n on n.bucket_ord = b.bucket_ord;
quit;

data ${outT};
  set work._<num>_pb;
  length measure $30 ci_method $16;
  measure   = 'calendar_rate';
  /* labeled with the method actually computed, never the merely-requested one */
  ci_method = 'poisson_byar';
  cases = events;
  person_years = round(person_days / &days_per_year., 0.0001);
  if person_days > 0 then do;
    estimate = round(events * ${M} * &days_per_year. / person_days, 0.01);
    if events = 0 then _byar_low = 0;
    else _byar_low = ((1 - 1/(9*events) - 1.96/(3*sqrt(events)))**3) * events;
    _byar_high = ((1 - 1/(9*(events+1)) + 1.96/(3*sqrt(events+1)))**3) * (events+1);
    ci_low  = round(_byar_low  * ${M} * &days_per_year. / person_days, 0.01);
    ci_high = round(_byar_high * ${M} * &days_per_year. / person_days, 0.01);
  end;
  else do; estimate = .; ci_low = .; ci_high = .; end;
  drop _byar_low _byar_high;
run;

title "Calendar trend of ${label}: per-bucket denominator + rate (mandatory panel disclosure)";
proc sort data=${outT}; by bucket_ord; run;
proc print data=${outT} noobs;
  var measure bucket_ord bucket bucket_start bucket_end denominator person_days
      person_years events case_patients cases estimate ci_low ci_high ci_method;
run;

/*----------------------------------------------------------------------------
  Poisson rate-trend score test on person-DAYS (time-unit invariant):
    U = Σxc − (C/T)Σxt;  V = (C/T)[Σx²t − (Σxt)²/T];  Z = U/√V;  Z² ~ χ²(1).
  p = 2(1−Φ(|Z|)) via the Abramowitz-Stegun 26.2.17 closed form — the SAME
  arithmetic as the SQL twin (deliberately NOT probchi, so the twins are
  arithmetic-identical; probchi(z**2,1) agrees to < 1e-7 — cross-check freely).
  CAVEAT: members contribute to several buckets (repeated cross-sections);
  the null assumes independent buckets — treat p as approximate.
----------------------------------------------------------------------------*/
proc sql;
  create table work._<num>_sums as
  select sum(events) as cc, sum(person_days) as tt,
         sum(bucket_ord * events) as sxc,
         sum(bucket_ord * person_days) as sxt,
         sum(bucket_ord * bucket_ord * person_days) as sxxt,
         count(*) as k,
         sum(case when person_days > 0 then 1 else 0 end) as k_used
  from ${outT};
quit;

data ${tstT};
  set work._<num>_sums;
  length measure $20 method $20 score_type $20 p_method $32;
  measure    = 'calendar_trend_test';
  method     = 'poisson_rate_trend';
  score_type = 'bucket_index_0based';
  n_buckets = k; n_buckets_used = k_used;
  if tt > 0 then do;
    _lam = cc / tt;
    _u = sxc - _lam * sxt;
    _v = _lam * (sxxt - (sxt * sxt) / tt);
  end;
  if _v > 0 then do;
    _z = _u / sqrt(_v);
    z_statistic = round(_z, 0.0001);
    chisq_1df   = round(_z * _z, 0.0001);
    _za = abs(_z);
    _kk = 1 / (1 + 0.2316419 * _za);
    _ph = exp(-(_za*_za)/2) / 2.5066282746310002;
    p_value = round(2 * _ph * (0.319381530*_kk - 0.356563782*_kk**2 + 1.781477937*_kk**3
                             - 1.821255978*_kk**4 + 1.330274429*_kk**5), 0.0001);
    sig_alpha_05 = (_za >= 1.959964);
    sig_alpha_01 = (_za >= 2.575829);
  end;
  else do;
    z_statistic = .; chisq_1df = .; p_value = .; sig_alpha_05 = .; sig_alpha_01 = .;
  end;
  p_method = 'chi2_1df_normal_cdf_as26_2_17';
  slope = .; slope_se = .; t_statistic = .; t_df = .;
  drop cc tt sxc sxt sxxt k k_used _lam _u _v _z _za _kk _ph;
run;

title "Calendar trend test: ${label}";
proc print data=${tstT} noobs;
  var measure method score_type n_buckets n_buckets_used z_statistic chisq_1df
      p_value p_method sig_alpha_05 sig_alpha_01 slope slope_se t_statistic t_df;
run;
```

Variant deltas (mirror §3.3 exactly):

* **Proportion base**: `measure = 'calendar_period_prevalence'`; `cases = case_patients`;
  Wilson in the DATA step (identical expression shape to SQL):

```sas
  if denominator > 0 then do;
    _p  = case_patients / denominator;
    _wd = 1 + 3.8416 / denominator;
    _wc = _p + 3.8416 / (2 * denominator);
    _wr = 1.96 * sqrt(_p * (1 - _p) / denominator + 3.8416 / (4 * denominator * denominator));
    estimate = round(_p, 0.0001);
    ci_low   = round((_wc - _wr) / _wd, 0.0001);
    ci_high  = round((_wc + _wr) / _wd, 0.0001);
  end;
  else do; estimate = .; ci_low = .; ci_high = .; end;
  /* ci_method = 'wilson' */
```

* **cochran_armitage**: sums over `case_patients`/`denominator`; `_pb = rr/nn;
  _u = sxr − _pb*sxn; _v = _pb*(1−_pb)*(sxxn − sxn*sxn/nn)`; z/p/sig identical.
* **linear_slope**: sums of `w, w*x, w*x*x, w*y, w*x*y, w*y*y` over positive-weight buckets
  (y recomputed unrounded from raw integers; weight per §1.4c); `slope = Sxy/Sxx;
  slope_se = sqrt(max(0, Syy − Sxy²/Sxx) / (k_used−2) / Sxx)` guarded by `k_used > 2` /
  `Sxx > 0`; `t_statistic = slope/slope_se; t_df = k_used − 2`; sig flags via a
  `select(t_df)`/if-chain rendering the §3.4 constants; `p_value = .` with
  `p_method = 'none_t_cdf'` and a loud comment (PROBT invitation).

---

## 5. Parity record — exact stamped fields

Added to `emitters/parity.ts` (both twins call `parityStamp("caltrend", caltrendParity(an, consumed))`
with the values they ACTUALLY consumed; `stableJson` sorts keys → byte-identical):

```ts
export interface CaltrendParity {
  id: string;
  codeListId: string;
  base: string;                        // as requested in the spec
  measure: string;                     // computed: "calendar_rate" | "calendar_period_prevalence"
  bucketKind: string;                  // trend.bucket
  /** generation-time bucket list, clipped to the study period — the twins must embed
   *  the identical literals, so the whole list is stamped */
  buckets: Array<{ ord: number; label: string; start: string; end: string }>;
  scoreType: "bucket_index_0based";
  methodRequested: string;             // trend.method
  methodComputed: string;              // what both twins actually compute (§3.3 mismatch rule)
  denominatorRuleRequested: string;    // an.denominatorRule
  denominatorRuleComputed: string;     // "person_time" | "enrolled_anytime"
  rateMultiplier: number | null;       // consumed M (default 1000 on rate base); null on proportion bases
  daysPerYear: string;                 // the rendered literal each twin embedded (string compare)
  ciMethod: string;                    // computed: "poisson_byar" | "wilson"
  pMethod: string;                     // "chi2_1df_normal_cdf_as26_2_17" | "none_t_cdf"
  reportPerBucket: true;               // forced on (mandatory disclosure)
  strata: SupportedStratifier[];       // [] in V1
}
```

Gold `a_ct_rate` stamp (identical in `08_caltrend_a_ct_rate.sql` and `090_caltrend_a_ct_rate.sas`):

```
PARITY caltrend {"base":"incidence_rate","bucketKind":"calendar_year","buckets":[{"end":"2018-12-31","label":"2018","ord":0,"start":"2018-01-01"},{"end":"2019-12-31","label":"2019","ord":1,"start":"2019-01-01"},{"end":"2020-12-31","label":"2020","ord":2,"start":"2020-01-01"}],"ciMethod":"poisson_byar","codeListId":"ae_dx","daysPerYear":"365.25","denominatorRuleComputed":"person_time","denominatorRuleRequested":"person_time","id":"a_ct_rate","measure":"calendar_rate","methodComputed":"poisson_rate_trend","methodRequested":"poisson_rate_trend","pMethod":"chi2_1df_normal_cdf_as26_2_17","rateMultiplier":1000,"reportPerBucket":true,"scoreType":"bucket_index_0based","strata":[]}
```

Arithmetic signatures for `verify/parity.ts` `SIGNATURES.caltrend` (fragments present in EVERY
caltrend emission regardless of base/method — the panel-denominator closed form and the
event-during-enrollment predicate; method-specific arithmetic is protected by the executed SQL
gold plus the stamped `methodComputed`):

```ts
caltrend: {
  sql: [
    "LEAST(e.episode_end, b.bucket_end)",
    "GREATEST(e.episode_start, b.bucket_start)",
    ") + 1",                                     // inclusive day count
    "BETWEEN e.episode_start AND e.episode_end", // events restricted to enrolled time
  ],
  sas: [
    "min(e.dtend, b.bucket_end)",
    "max(e.dtstart, b.bucket_start)",
    "+ 1",
    "between e.dtstart and e.dtend",
  ],
},
```

---

## 6. Limitations — every unimplemented option + its REVIEW wording

Emitted by `caltrendLimitations(an)` (parity.ts) into BOTH languages, incidence-style:

| Trigger | REVIEW wording |
|---|---|
| `outcomeDefinition.minClaims > 1` | `outcome minClaims=N is NOT yet enforced - any single qualifying claim counts as an event` |
| `outcomeDefinition.setting !== "any"` | `outcome care-setting filter "X" is NOT yet applied - events from all settings count` |
| `outcomeDefinition.diagnosisPosition !== "any"` | `diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count` |
| `base === "point_prevalence"` | `base "point_prevalence" is computed as per-bucket PERIOD prevalence (enrolled-anytime denominator, >=1 qualifying event in the bucket) - anchor-date point prevalence per bucket is NOT implemented` |
| `base === "incidence_rate"` (always) | `personTimeRule censoring (censorAt/maxFollowupDays) and prevalent-case washout are NOT applied - the denominator is TOTAL enrolled person-time per bucket among the final cohort (open-cohort surveillance rate) and ALL qualifying event-days count (not first-only, no incident/prevalent distinction)` |
| `base === "incidence_rate"` and `rateMultiplier` absent | `rateMultiplier not set - defaulting to 1000 per HEOR convention` |
| `denominatorRule !==` computed rule | `denominatorRule "X" is NOT implemented for this base - "Y" is produced and stamped` |
| method/base mismatch | `trend.method "cochran_armitage" applies to proportions - base "incidence_rate" produces the Poisson rate-trend score test instead, labeled poisson_rate_trend` (and the mirror-image wording for poisson_rate_trend on a proportion base) |
| `ciMethod` ≠ computed (`wilson`/`poisson_byar`) | `ciMethod "X" is NOT implemented - the {Wilson score / Byar exact-Poisson approximation} CI is produced and labeled {wilson / poisson_byar}` |
| `trend.reportPerBucket === false` | `reportPerBucket=false is overridden - the per-bucket denominator table is a MANDATORY panel-churn disclosure and is always emitted` |
| each `stratifyBy[i]` | `stratifier "ID" is NOT yet emitted - overall trend only` |
| `trend.method === "linear_slope"` (always) | `linear_slope p-value is NOT computed (Student-t CDF has no SQL closed form) - t statistic and df are emitted for a SAS-side PROBT cross-check; significance flags use exact t critical values embedded at generation time` |
| first/last bucket clipped by studyPeriod | `first/last bucket is truncated by the study period - equal-spacing trend scores are retained` |

Fixed comments (not limitations, always emitted next to the test table in both languages):
the repeated-cross-section independence caveat (§1.4a) and, for CA/Poisson, the A&S-26.2.17
p-value provenance note.

---

## 7. Fixture vectors — patient-by-patient hand derivation of every asserted number

Frozen fixture (verify/fixture.ts — UNCHANGED). Study period 2018-01-01..2020-12-31 →
calendar_year buckets: ord 0 = 2018 [2018-01-01, 2018-12-31], ord 1 = 2019, ord 2 = 2020.
Final cohort = P01–P10 (P11 fails continuous enrollment, P12 fails age — both excluded from
EVERY denominator below; this is the definitional population choice of §1.2).

### 7.1 Episodes and per-bucket person-days, patient by patient

Every cohort member's stitched episode is 2018-01-01..2020-06-30:
P01–P06, P08, P09, P10 each have a single raw span 2018-01-01..2020-06-30; P07 has spans
2018-01-01..2019-06-10 and 2019-06-30..2020-06-30 with a 20-day lapse ≤ gapAllowance 31 →
stitched into ONE episode 2018-01-01..2020-06-30 (the 19 gap days 2019-06-11..2019-06-29 count
as covered — the stitched-episode semantic the spine itself uses for continuous enrollment).

Inclusive overlap `min(ep_end, b_end) − max(ep_start, b_start) + 1` per patient:

| Bucket | overlap window | days/patient | × 10 patients | person_days |
|---|---|---|---|---|
| 2018 | 2018-01-01..2018-12-31 | 364 + 1 = 365 | 10 | **3650** |
| 2019 | 2019-01-01..2019-12-31 | 364 + 1 = 365 | 10 | **3650** |
| 2020 | 2020-01-01..2020-06-30 | 181 + 1 = 182 (leap: 31+29+31+30+31+30) | 10 | **1820** |

`denominator` (distinct patients) = **10 / 10 / 10**. person_years (Y = 365.25):
3650/365.25 = 9.99315537… → **9.9932**; 2020: 1820/365.25 = 4.98288843… → **4.9829**.
(P11's 2018 enrollment does NOT count — not in the cohort.)

### 7.2 Events per bucket, patient by patient

All five ae_dx events belong to cohort members and fall inside their stitched episodes:

| Patient | event_date | bucket | in episode? |
|---|---|---|---|
| P01 | 2018-06-01 | 2018 | ✓ 2018-01-01..2020-06-30 |
| P06 | 2018-09-01 | 2018 | ✓ |
| P02 | 2019-04-11 | 2019 | ✓ |
| P03 | 2019-07-20 | 2019 | ✓ |
| P07 | 2019-10-28 | 2019 | ✓ (span 2, inside the stitched episode) |

→ events = **2 / 3 / 0**; case_patients = **2 / 3 / 0** (one event-day each; no same-day dups).

### 7.3 `a_ct_rate` per-bucket rates + Byar CIs (M = 1000, Y = 365.25)

Scale factor per count = M·Y/person_days. 2018 & 2019: 365250/3650 = 100.0684932;
2020: 365250/1820 = 200.6868132.

* **2018 (c=2)**: rate = 2 × 100.0684932 = 200.136986 → **200.14**.
  Byar low = (1 − 1/18 − 1.96/(3√2))³·2: 1/18 = 0.0555556; 3√2 = 4.2426407;
  1.96/4.2426407 = 0.4619770; inner = 0.4824674; cube = 0.1123063; ×2 = 0.2246126;
  ×100.0684932 = 22.477 → **22.48**.
  Byar high = (1 − 1/27 + 1.96/(3√3))³·3: 1/27 = 0.0370370; 3√3 = 5.1961524;
  1.96/5.1961524 = 0.3772030; inner = 1.3401660; cube = 2.4069983; ×3 = 7.2209949;
  ×100.0684932 = 722.594 → **722.59**.
  (Cross-checks against already-verified gold: 0.2246126 × 323.2301 [=365250/1130] = 72.60 and
  7.2209949 × 323.2301 = 2334.04 — exactly the pinned Sex/Female incidence stratum CI.)
* **2019 (c=3)**: rate = 3 × 100.0684932 = 300.205479 → **300.21**.
  Byar low = (1 − 1/27 − 0.3772030)³·3 = (0.5857600)³·3 = 0.2009831×3 = 0.6029494;
  ×100.0684932 = 60.337 → **60.34**. Byar high = (1 − 1/36 + 1.96/6)³·4
  = (1.2988889)³·4 = 2.1913715×4 = 8.7654860; ×100.0684932 = 877.149 → **877.15**.
  (Cross-check: 0.6029494 × 150.6186 = 90.82 and 8.7654860 × 150.6186 = 1320.25 — the pinned
  Overall incidence CI (90.82, 1320.24) within its 0.05 tolerance.)
* **2020 (c=0)**: rate = **0.00**; Byar low = **0** (guarded branch).
  Byar high = (1 − 1/9 + 1.96/3)³·1 = (1.5422222)³ = 3.6680975; ×200.6868132 = 736.139 →
  **736.14**. (Cross-check: 3.6680975 × 1000.6849 [=365250/365] = 3670.61 — the pinned 65+
  incidence stratum upper bound.)

### 7.4 `a_ct_rate` Poisson trend test (x = 0,1,2; person-DAYS)

```
C = 2+3+0 = 5          T = 3650+3650+1820 = 9120       λ̂ = 5/9120 = 0.000548246
Σxc = 0·2 + 1·3 + 2·0 = 3
Σxt = 0·3650 + 1·3650 + 2·1820 = 3650 + 3640 = 7290
Σx²t = 1·3650 + 4·1820 = 10930
U = 3 − (5/9120)·7290 = 3 − 36450/9120 = 3 − 3.9967105 = −0.9967105
V = (5/9120)·(10930 − 7290²/9120) = (5/9120)·(10930 − 53144100/9120)
  = (5/9120)·(10930 − 5827.2039) = 5102.7961/1824 = 2.7975855
Z = −0.9967105/√2.7975855 = −0.9967105/1.6725984 = −0.5959055  → z_statistic −0.5959
Z² = 0.3551034                                                  → chisq_1df    0.3551
p  = 2(1 − Φ(0.5959055)); Φ(0.5959055) = 0.7243785 → p = 0.5512430 → p_value  0.5512
sig_alpha_05 = 0 (0.5959 < 1.959964), sig_alpha_01 = 0; n_buckets = 3, n_buckets_used = 3.
```

### 7.5 `a_ct_prev` per-bucket proportions + Wilson CIs (z = 1.96, z² = 3.8416)

p̂ = case_patients/denominator = 0.2 / 0.3 / 0.0 → estimate **0.2000 / 0.3000 / 0.0000**.
Wilson with n = 10: denom = 1 + 0.38416 = 1.38416; center = p̂ + 0.19208.

* **2018 (2/10)**: rad = 1.96·√(0.2·0.8/10 + 3.8416/400) = 1.96·√0.025604 = 1.96×0.1600125
  = 0.3136245. low = (0.39208 − 0.3136245)/1.38416 = 0.0784555/1.38416 = 0.056681 → **0.0567**;
  high = 0.7057045/1.38416 = 0.509843 → **0.5098**. (Matches the published Wilson 2/10 interval.)
* **2019 (3/10)**: rad = 1.96·√(0.021 + 0.009604) = 1.96×0.1749400 = 0.3428824.
  low = (0.49208 − 0.3428824)/1.38416 = 0.1491976/1.38416 = 0.107789 → **0.1078**;
  high = 0.8349624/1.38416 = 0.603227 → **0.6032**.
* **2020 (0/10)**: rad = 1.96·√(0 + 0.009604) = 1.96×0.098 = 0.19208 = center →
  low = **0.0000** exactly; high = 0.38416/1.38416 = z²/(n+z²) = 3.8416/13.8416 = 0.277540 →
  **0.2775**.

### 7.6 `a_ct_prev` Cochran–Armitage test (x = 0,1,2)

```
r = (2,3,0), n = (10,10,10):  R = 5, N = 30, p̄ = 1/6
Σxr = 3;  Σxn = 30;  Σx²n = 50
T   = 3 − (1/6)·30 = −2
Var = (1/6)(5/6)·(50 − 30²/30) = (5/36)·20 = 100/36 = 2.7777778
Z   = −2/√2.7777778 = −2/(5/3) = −1.2 EXACTLY     → z_statistic −1.2000
Z²  = 1.44 EXACTLY                                 → chisq_1df    1.4400
p   = 2(1 − Φ(1.2)) = 2(1 − 0.8849303) = 0.2301394 → p_value      0.2301
sig_alpha_05 = 0, sig_alpha_01 = 0; n_buckets = 3, n_buckets_used = 3.
```

### 7.7 `a_ct_slope` WLS slope (proportion base; w = n = (10,10,10), y = (0.2, 0.3, 0.0), x = 0,1,2)

```
Sw = 30;  Σwx = 30;  Σwx² = 50;  Σwy = 5;  Σwxy = 3;  Σwy² = 10(0.04+0.09+0) = 1.3
Sxx = 50 − 30²/30 = 20
Sxy = 3 − 30·5/30 = −2
Syy = 1.3 − 25/30 = 0.4666667
slope = −2/20 = −0.1 EXACTLY                       → slope       −0.1000
RSS   = Syy − Sxy²/Sxx = 0.4666667 − 4/20 = 0.2666667
k_used = 3 → df = 1;  SE = √(0.2666667/1/20) = √0.0133333 = 0.1154701 → slope_se 0.1155
t = −0.1/0.1154701 = −0.8660254  (= −√3/2 exactly) → t_statistic −0.8660,  t_df 1
sig_alpha_05 = 0 (0.866 < 12.7062), sig_alpha_01 = 0;  p_value NULL, p_method 'none_t_cdf'.
(Bucket rows of a_ct_slope are byte-identical to a_ct_prev's §7.5 rows — same measure.)
```

### 7.8 EXPECTED additions (verify/fixture.ts) and assertions (verify/run.ts)

```ts
caltrend: {
  rate: {   // tz_study_caltrend_a_ct_rate / _test_a_ct_rate
    rows: 3,
    buckets: {
      "2018": { denominator: 10, personDays: 3650, personYears: 9.9932, events: 2, casePatients: 2, estimate: 200.14, ci: [22.48, 722.59] },
      "2019": { denominator: 10, personDays: 3650, personYears: 9.9932, events: 3, casePatients: 3, estimate: 300.21, ci: [60.34, 877.15] },
      "2020": { denominator: 10, personDays: 1820, personYears: 4.9829, events: 0, casePatients: 0, estimate: 0,      ci: [0, 736.14] },
    },
    test: { method: "poisson_rate_trend", z: -0.5959, chisq: 0.3551, p: 0.5512, sig05: 0, sig01: 0, nBuckets: 3, nUsed: 3 },
    totalPersonDays: 9120,
  },
  prev: {   // tz_study_caltrend_a_ct_prev / _test_a_ct_prev
    buckets: {
      "2018": { denominator: 10, cases: 2, estimate: 0.2, ci: [0.0567, 0.5098] },
      "2019": { denominator: 10, cases: 3, estimate: 0.3, ci: [0.1078, 0.6032] },
      "2020": { denominator: 10, cases: 0, estimate: 0,   ci: [0, 0.2775] },
    },
    test: { method: "cochran_armitage", z: -1.2, chisq: 1.44, p: 0.2301, sig05: 0, sig01: 0 },
  },
  slope: {  // tz_study_caltrend_test_a_ct_slope
    test: { method: "linear_slope", slope: -0.1, se: 0.1155, t: -0.866, tDf: 1, sig05: 0, sig01: 0 },
  },
} as const,
```

run.ts assertion style (mirrors the incidence-strata loop): exact `eq` on integer columns
(denominator, person_days, events, case_patients, row counts, n_buckets, sig flags, t_df);
`approx` with tolerance 0.001 on person_years; 0.01 on rate estimates; 0.05 on Byar CI bounds;
0.0005 on proportions/Wilson bounds/slope/SE; 0.001 on z, chisq, p, t. Plus the invariant
`SUM(person_days) = 9120` on the rate bucket table, and `p_value IS NULL` on the slope test row.

### 7.9 Gold-spec analysis entries (appended to GOLD_A_SPEC.analyses — see §8 ordering note)

```ts
{ id: "a_ct_rate", label: "Calendar trend of AE rate", kind: "calendar_trend", enabled: true,
  base: "incidence_rate",
  outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
  personTimeRule: { start: "index", censorAt: ["disenrollment", "study_end"] },  // spec-required; not applied (REVIEW)
  rateMultiplier: 1000, denominatorRule: "person_time",
  trend: { bucket: "calendar_year", method: "poisson_rate_trend", reportPerBucket: true },
  ciMethod: "poisson_byar", stratifyBy: [] },
{ id: "a_ct_prev", label: "Calendar trend of AE period prevalence", kind: "calendar_trend", enabled: true,
  base: "period_prevalence",
  outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
  denominatorRule: "enrolled_anytime",
  trend: { bucket: "calendar_year", method: "cochran_armitage", reportPerBucket: true },
  ciMethod: "wilson", stratifyBy: [] },
{ id: "a_ct_slope", label: "Calendar slope of AE period prevalence", kind: "calendar_trend", enabled: true,
  base: "period_prevalence",
  outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
  denominatorRule: "enrolled_anytime",
  trend: { bucket: "calendar_year", method: "linear_slope", reportPerBucket: true },
  ciMethod: "wilson", stratifyBy: [] },
```

Three same-kind analyses → `multi = true` → suffixes `_a_ct_rate` / `_a_ct_prev` /
`_a_ct_slope` on slugs and table names (ids kept short so SAS member names stay inside the
32-char pool without truncation: `TZ_STUDY_090_caltrend_a_ct_rate` = 31 chars;
`TZ_STUDY_090_ctest_a_ct_rate` = 28 chars).

---

## 8. Fixture extension — **none**

No new rows are needed: the frozen data already yields a meaningful multi-bucket vector — AE
events span 2018 (2) and 2019 (3), enrollment spans 2018–2020, giving three calendar_year
buckets with counts (2, 3, 0): non-degenerate trend statistics in both directions of the
measure family AND a zero-case bucket that exercises the small-N branches (Byar at c=0, Wilson
at 0/n) for free.

Non-interference proof for the spec-side change (three analyses APPENDED to
`GOLD_A_SPEC.analyses`):

1. The 12 patients, their events, and their enrollment rows are byte-identical — every
   existing pinned number derives from unchanged builders over unchanged data.
2. Appending (never inserting before `a_incidence`) keeps the incidence module at SQL file
   `07` / SAS `080`, so no existing path, program number, or title shifts.
3. `incidence_rate` remains single-of-kind → its suffix stays `""` → `tz_study_incidence` and
   `tz.&tag._080_incidence` keep their names; every existing gold query in run.ts resolves to
   the same table and the same rows.
4. The new module only CREATEs new tables (`…_caltrend_*`); it reads spine tables and never
   writes them. SAS name-pool assignments for existing tables are made before module dispatch
   in emit order and are therefore unchanged.

---

## 9. Output table schema

### 9.1 `${wp}_caltrend${suffix}` (SQL) / `tz.&tag._<num>_caltrend<suffix>` (SAS) — one row per bucket, ordered by `bucket_ord`

| column | type | notes |
|---|---|---|
| measure | VARCHAR / $30 | `calendar_rate` \| `calendar_period_prevalence` (actually computed) |
| bucket_ord | INT | 0-based chronological score used by the trend tests |
| bucket | VARCHAR / $10 | `2018`, `2019Q1`, `2019-07` |
| bucket_start, bucket_end | DATE | clipped bounds (full disclosure of partial buckets) |
| denominator | BIGINT | distinct cohort patients enrolled in bucket — **never NULL, mandatory** |
| person_days | BIGINT | enrolled person-days in bucket (mandatory churn disclosure; both bases) |
| person_years | NUMERIC(·,4) | person_days / daysPerYear |
| events | BIGINT | qualifying event-days in bucket during enrolled time |
| case_patients | BIGINT | distinct patients with ≥1 event in bucket |
| cases | BIGINT | the numerator the measure uses: events (rate) \| case_patients (proportion) |
| estimate | NUMERIC | rate per M PY (2 dp) \| proportion (4 dp); NULL when denominator empty |
| ci_low, ci_high | NUMERIC | Byar (2 dp) \| Wilson (4 dp); NULL when denominator empty |
| ci_method | VARCHAR / $16 | `poisson_byar` \| `wilson` (actually computed) |

### 9.2 `${wp}_caltrend_test${suffix}` (SQL) / `tz.&tag._<num>_ctest<suffix>` (SAS) — exactly one row

| column | type | notes |
|---|---|---|
| measure | VARCHAR / $20 | `calendar_trend_test` |
| method | VARCHAR / $20 | actually computed: `cochran_armitage` \| `poisson_rate_trend` \| `linear_slope` |
| score_type | VARCHAR / $20 | `bucket_index_0based` |
| n_buckets | INT | buckets in the study period (k) |
| n_buckets_used | INT | buckets with a positive denominator (k_eff) |
| z_statistic | NUMERIC(·,4) | CA/Poisson only; NULL for linear_slope or degenerate data |
| chisq_1df | NUMERIC(·,4) | z²; NULL as above |
| p_value | NUMERIC(·,4) | CA/Poisson: A&S 26.2.17 two-sided; linear_slope: NULL |
| p_method | VARCHAR / $32 | `chi2_1df_normal_cdf_as26_2_17` \| `none_t_cdf` |
| sig_alpha_05, sig_alpha_01 | INT (0/1/NULL) | exact critical-value comparisons (§1.5) |
| slope, slope_se | NUMERIC(·,4) | linear_slope only; NULL otherwise |
| t_statistic | NUMERIC(·,4) | slope/SE; t_df = k_eff − 2 |
| t_df | INT | NULL for CA/Poisson |

---

## 10. Integration checklist — files to touch, in order

1. `packages/core/src/emitters/parity.ts` — add `CaltrendParity`, `caltrendParity()`,
   `caltrendLimitations()`, the bucket-enumeration helper (`caltrendBuckets(spec, trend.bucket)`
   → `{ord,label,start,end}[]`, clipped), and shared constants: A&S 26.2.17 coefficients
   (incl. `2.5066282746310002`), normal critical values `1.959964`/`2.575829`, and the §3.4
   t-critical-value table — single source so both twins render identical literals.
2. `packages/core/src/emitters/modules/caltrend.ts` — the module (twin `sql()`/`sas()` per
   §3/§4; `analysisKind: "calendar_trend"`, `stampKind: "caltrend"`), importing only
   `sql-base` / `sas-base` / `parity` (no emitter cores — no cycles).
3. `packages/core/src/emitters/modules/registry.ts` — one line:
   `calendar_trend: caltrendModule as AnalysisModule<never>` (auto-enrolls parity checking).
4. `packages/core/src/verify/parity.ts` — add `SIGNATURES.caltrend` (§5 fragments).
5. `packages/core/src/verify/fixture.ts` — APPEND the three §7.9 analyses to
   `GOLD_A_SPEC.analyses`; add `EXPECTED.caltrend` (§7.8). **No data rows change.**
6. `packages/core/src/verify/run.ts` — Gold-A assertions per §7.8 (bucket loops + test rows +
   the 9120 person-day invariant + `p_value IS NULL` on the slope row).
7. `docs/COVERAGE-MATRIX.md` — flip the calendar-trends row from `absent` to
   `done (V1: overall trend, forced per-bucket denominator; strata/EAPC/std-rates deferred)`.
8. Run `npm run verify` — Gold A must pass every §7 number, the stamp deep-compare, and the
   §5 signature checks before merge.
