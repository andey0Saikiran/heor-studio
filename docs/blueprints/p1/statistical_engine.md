# statistical_engine module blueprint

Deterministic bivariate test-selection engine + comparison tables. One module file
(`src/emitters/modules/statengine.ts`), twin `sql()`/`sas()` generators in the exact
shape of `modules/incidence.ts` (the reference module), a shared `PARITY statengine`
stamp, visible REVIEW limitations, and hand-computed gold truth on the frozen
12-patient fixture — **zero new fixture rows required**.

Scope pledge (honest-labeling contract, restated up front):

- Every number in the parity-governed output table is **closed-form arithmetic
  implemented identically in both languages** — no PROC is mirrored, no PROC is
  approximated silently.
- Tail probabilities (p-values) have **no closed form in portable SQL** (they need
  t/normal/chi-square CDFs or exact hypergeometric enumeration). Per the module
  contract they are emitted **SAS-side only**, the SQL column is `NULL` with a loud
  comment, and BOTH twins label the source in `p_method`. The machine-verified
  significance decision is `reject_at_05` (statistic vs pinned critical bound),
  which IS closed form and identical in both twins.
- Test **selection** is a deterministic, total rule table — stamped into the parity
  record — never model-chosen, never data-"smart" beyond the one classical
  data-driven rule (Cochran's expected-cell<5 → Fisher), which is itself a pinned
  deterministic rule evaluated identically at run time in both languages.

---

## 1. Method — precise definitions + literature refs

### 1.1 Deterministic test selection (the ledger)

Selection is a **total function** of
`(dependent dataType) × (group level count) × (design) × (DistributionPolicy)`,
resolved at **generation time** except for one classical run-time rule (R-B1a).
Seed: DOMAIN-RULES.md §10 (the practitioner selection matrix); Cochran,
*Biometrics* 1954;10(4):417–451, §5 (working rule: expected cell < 5 → exact test).

| Rule id | Condition | Emitted rows | Selected |
|---|---|---|---|
| R-C1a | continuous dep × 2 independent groups × (`normalityTest="assume_normal"` OR `allowNonparametricFallback=false`) | `t_welch` + `wilcoxon_rank_sum_normal_cc` | `t_welch` selected, Wilcoxon `supporting` |
| R-C1b | continuous dep × 2 independent groups × (`normalityTest∈{shapiro_wilk,anderson_darling}` AND `allowNonparametricFallback=true`) | same two rows | `wilcoxon_rank_sum_normal_cc` selected (normality diagnostic is SAS-only and NOT implemented in V1; the rank test is valid regardless of normality), `t_welch` `supporting` + REVIEW note |
| R-C1bal | continuous **balance covariate** (`smdBalance.covariateIds`; `SmdBalanceConfig` carries no `DistributionPolicy`) | same two rows | `t_welch` selected (assume-normal default, documented), Wilcoxon `supporting` |
| R-B1 | binary dep × 2 independent groups, run-time `min_expected >= 5` | `chi_square` + `fisher_exact` | `chi_square` selected; fisher row role `not_required` |
| R-B1a | binary dep × 2 independent groups, run-time `min_expected < 5` | same two rows | `fisher_exact` selected (SAS-only p; SQL feeder + NULL statistic); chi row role `invalid_small_cells` (its statistic stays populated, honestly named — it is the Pearson feeder value, visibly marked invalid) |
| R-X | everything else (k>2 groups, paired, survival_logrank, count/cost/time_to_event/categorical dep, adjusted regressions, non-`exposure_cohort` group sources) | none | skipped with a REVIEW limitation naming the row and the reason |

Both candidate rows are ALWAYS emitted for an implemented variable (2 rows per
variable, deterministic row count at generation time); `test_role` says which one
the ledger selects. This is deliberately more visible than emitting only the
winner: an analyst can always see the alternative statistic.

### 1.2 Two-sample t — **Welch** (pick + justification)

Statistic and degrees of freedom (Welch, *Biometrika* 1947;34(1–2):28–35, eq. 6;
Satterthwaite, *Biometrics Bulletin* 1946;2(6):110–114):

```
t  = (m1 − m0) / sqrt(s1²/n1 + s0²/n0)
df = (s1²/n1 + s0²/n0)² / [ (s1²/n1)²/(n1−1) + (s0²/n0)²/(n0−1) ]     (fractional)
```

**Why Welch and not pooled:** (a) the spec's own vocabulary decides it —
`DistributionPolicy.varianceTest` offers only `"levene"` (a SAS PROC, not
implemented in V1) and `"assume_unequal"`; there is no `"assume_equal"` member, so
the schema's only closed-form-honorable option is the unequal-variance test.
(b) Welch controls type-I error under variance heterogeneity and converges to the
pooled t when variances and group sizes are equal (our fixture is exactly this
degenerate case: both give t=−1.0, df=8 — noted in §7). (c) It is fully closed
form on both sides; no folded-F pre-test branch (a second data-driven fork) is
needed. Labeled `t_welch` — the method actually computed, never just "t-test".

Critical bound: two-sided α=0.05 Student-t quantile from a **pinned constant
table** (`T_CRIT_05` in `parity.ts`, single source for both twins): exact 4-dp
values for df 1..30 plus {40, 50, 60, 80, 100, 120}; lookup key =
`floor(df_welch)`; between tabulated points the **next-lower tabulated df wins**
(t-quantiles decrease in df, so stepping down gives a *larger* bound —
conservative: the flag can only under-reject inside a band gap, never over-reject).
Rule stamped as `critDfRule:"floor_step_down"`. df ≤ 0 or NULL → bound NULL.
Values (df: crit): 1:12.7062, 2:4.3027, 3:3.1824, 4:2.7764, 5:2.5706, 6:2.4469,
7:2.3646, 8:2.3060, 9:2.2622, 10:2.2281, 11:2.2010, 12:2.1788, 13:2.1604,
14:2.1448, 15:2.1314, 16:2.1199, 17:2.1098, 18:2.1009, 19:2.0930, 20:2.0860,
21:2.0796, 22:2.0739, 23:2.0687, 24:2.0639, 25:2.0595, 26:2.0555, 27:2.0518,
28:2.0484, 29:2.0452, 30:2.0423, 40:2.0211, 50:2.0086, 60:2.0003, 80:1.9901,
100:1.9840, 120:1.9799 (df>120 keeps 1.9799 — conservative, never 1.96).

### 1.3 Wilcoxon rank-sum — normal approximation with tie correction (derived)

Wilcoxon, *Biometrics Bulletin* 1945;1(6):80–83; Mann & Whitney, *Ann Math Stat*
1947;18(1):50–60. Tie-corrected large-sample variance: Lehmann, *Nonparametrics:
Statistical Methods Based on Ranks* (Holden-Day 1975), ch. 1 §4; Hollander,
Wolfe & Chicken, *Nonparametric Statistical Methods* 3e (Wiley 2014), §4.1
(eq. 4.5–4.6). Continuity correction 0.5 per the SAS/STAT User's Guide,
PROC NPAR1WAY, "Simple Linear Rank Tests for Two-Sample Data" (so analysts
diffing against NPAR1WAY's "Normal Approximation Z" reconcile).

Derivation (as implemented, both twins):

- Rank the N = n1+n0 non-missing values jointly; tied values receive the
  **midrank**: `RANK() + (tie_count − 1)/2` in SQL ≡ `PROC RANK TIES=MEAN` in SAS.
- `W` = sum of g1's midranks. Under H0, `E[W] = n1(N+1)/2`.
- With tie groups of sizes t_j, the variance shrinks by the tie term:

```
Var[W] = (n1·n0/12) · [ (N+1) − Σ_j (t_j³ − t_j) / (N(N−1)) ]
z      = (W − E[W] − sign(W − E[W])·0.5) / sqrt(Var[W])      (|W−E|≤0.5 ⇒ z=0)
```

The `|W−E|≤0.5 ⇒ 0` clamp prevents the continuity correction from overshooting
past the null. Labeled `wilcoxon_rank_sum_normal_cc` — the normal approximation
actually computed, never "exact Wilcoxon". Critical bound: z₀.₉₇₅ = 1.9600.
Sign convention: z carries the same g1−g0 orientation as t and SMD.

### 1.4 Pearson chi-square (2×2) + the Fisher routing rule

Pearson, *Phil Mag* Ser. 5 1900;50:157–175. For the 2×2 with cells
a=x1, b=n1−x1, c=x0, d=n0−x0 (rows = groups, cols = event/non-event) the
closed form used by both twins (algebraically ≡ Σ(O−E)²/E):

```
chisq        = N·(ad − bc)² / [ (a+b)(c+d)(a+c)(b+d) ]          df = 1
min_expected = min over the 4 cells of (row total × col total)/N
```

Critical bound χ²₀.₉₅,₁ = 3.8415 (upper tail — chi-square is one-sided by
construction). When `min_expected < 5` (Cochran 1954 rule; the matrix in
DOMAIN-RULES §10 and coverage row 73 both pin **EXPECTED**, not observed, counts)
the selected test flips to Fisher's exact.

### 1.5 Fisher exact — SAS-only, honestly labeled

Fisher, *Statistical Methods for Research Workers* 5e (1934) §21.02; Agresti,
*Categorical Data Analysis* 3e (Wiley 2013) §3.5.1. The two-sided p sums
hypergeometric table probabilities ≤ the observed table's probability. Factorials
explode and there is no closed form ⇒ **no SQL emission**: the SQL twin emits the
feeder 2×2 counts + `min_expected`, sets `statistic/df/crit/reject` NULL on the
fisher row, and stamps `p_method='sas_fisher_exact'`. The SAS twin computes it
with `PROC FREQ ... EXACT FISHER` (ODS `FishersExact`, `XP2_FISH`) — a PROC used
*only* for this sanctioned SAS-only statistic, called out in the header.

### 1.6 SMD — pinned Austin average-of-variances convention

Austin, *Stat Med* 2009;28(25):3083–3107 (eqs. 1–2); Yang & Dalton, SAS Global
Forum 2012, Paper 335-2012. Denominator = sqrt of the **simple average of the two
group variances**, NOT the n-weighted pooled variance (spec/types.ts pins this on
`SmdBalanceConfig`; the fixture pins it numerically: `EXPECTED.smdAge = −0.63246 =
(50−55)/sqrt((62.5+62.5)/2)`).

```
continuous: SMD = (m1 − m0) / sqrt( (s1² + s0²) / 2 )
binary:     SMD = (p1 − p0) / sqrt( (p1(1−p1) + p0(1−p0)) / 2 )
```

Imbalance flag (balance rows only): |SMD| > `smdBalance.imbalanceThreshold`
(convention 0.1 — Austin 2009; Normand et al., *J Clin Epidemiol* 2001;54:387).
Binary event level is deterministic and stamped: for `kind:"sex"` the event is
Male (MarketScan `'1'`); for codelist-flag covariates/outcomes the event is
"≥ minClaims qualifying claims in window".

### 1.7 Group (arm) assignment — deterministic and byte-identical across twins

`GroupVariable.source = {kind:"exposure_cohort"}`: arm label = **MIN over the
generated drug labels of every index-code-list drug claim on the patient's own
index date**. The label of a `drug_name` pattern is its **first alternation**
(e.g. `"ADALIMUMAB|HUMIRA"` → `ADALIMUMAB`) — exactly what the SAS 010 NDC-pull
CASE emits into `drug`, so `030_index.index_drug = min(drug)` implements this rule
natively on the SAS side. The SQL side rebuilds the identical labels with a
generation-time `CASE pattern → label` map (from the same spec code list) over
`{wp}_ndc_lookup` — no string splitting at run time, no dialect extension needed.
Patients whose label is not in `levels[]` are excluded from every engine row and
counted in a QC query. g1 = first level ≠ `referenceLevel` (in `levels[]` order);
g0 = `referenceLevel` if set, else `levels[1]`. Direction (g1, g0) is stamped.

Demographics (age/sex) come from the enrollment segment in force at (or latest
before) index — same source and `dtstart DESC, dtend DESC` tie-break as the
incidence module, **never claim-level AGE** — so the twins cannot drift around
birthday timing. Age = index year − DOBYR (calendar-year precision, the only DOB
field MarketScan has). Missing covariate values are excluded per covariate
(complete-case per row; `nmiss1/nmiss0` reported).

### 1.8 What is deliberately NOT computed

No person-time is consumed anywhere in this module, so `daysPerYear` /
`renderDaysPerYear` is intentionally **absent from the parity stamp** (the stamp
records only values actually consumed — stamping an unconsumed constant would be
a false claim). Multiplicity adjustment (Holm 1979; Benjamini–Hochberg 1995)
operates on p-values, which are SAS-only ⇒ V1 applies **none** and says so
(§6). α for the critical bounds is pinned at 0.05; a different
`multiplicity.alpha` triggers a REVIEW note, never a silent recompute.

---

## 2. Spec consumption — interfaces verbatim + field-by-field mapping

From `src/spec/types.ts` (verbatim):

```ts
/** Governance wrapper: references top-level comparisons[] by id. */
export interface StatisticalEngineAnalysis extends AnalysisCommon {
  kind: "statistical_engine";
  comparisonIds: string[];   // -> StudySpec.comparisons[].id
  smdBalance?: SmdBalanceConfig;
  multiplicity: MultiplicityGovernance;
}
```

```ts
export interface Comparison {
  id: string;
  dependentOutcomeId: string; // -> OutcomeVariable.id
  independentVarId: string;   // -> GroupVariable.id
  design: ComparisonDesign;
  adjusted: boolean;
  covariateIds: string[];     // -> BaselineCharacteristic.id (used when adjusted)
  role: "primary" | "secondary" | "exploratory" | "descriptive_only";
  distributionPolicy: DistributionPolicy;
  reportStat: ReportStat;
  regression?: RegressionSpec; // required when adjusted === true
}
```

```ts
export interface GroupVariable {
  id: string;
  label: string;
  source:
    | { kind: "exposure_cohort" }
    | { kind: "baseline"; baselineId: string }
    | { kind: "codelist"; codeListId: string; window: RelativeWindow };
  levels: string[];
  referenceLevel?: string;
}
```

```ts
export interface OutcomeVariable {
  id: string;
  label: string;
  dataType:
    | "binary"        // -> chi-sq/Fisher; logistic (OR)
    | "count"         // -> Poisson/NB (rate ratio)
    | "continuous"    // -> t/Wilcoxon; OLS
    | "cost"          // -> gamma-log / two-part (DEFERRED to P2)
    | "time_to_event" // -> log-rank
    | "categorical";  // -> chi-sq
  codeListId?: string;
  outcomeDefinition?: OutcomeDefinition;
  ascertainmentWindow: RelativeWindow;
  personTimeRule?: PersonTimeRule; // required for time_to_event
  cost?: CostMeasurement;          // required for cost
}
```

```ts
export interface DistributionPolicy {
  normalityTest: "shapiro_wilk" | "anderson_darling" | "assume_normal";
  dispersionTest: "deviance_ratio" | "cameron_trivedi" | "none";
  varianceTest: "levene" | "assume_unequal";
  allowNonparametricFallback: boolean;
}
```

```ts
export interface SmdBalanceConfig {
  groupVarId: string;
  covariateIds: string[];
  imbalanceThreshold: number; // convention |SMD| > 0.1
  reportWeighted: boolean;    // activated in P2 PS/IPTW
}
```

```ts
export interface MultiplicityGovernance {
  method: "none" | "bonferroni" | "holm" | "benjamini_hochberg";
  alpha: number; // two-sided, in (0,1)
  appliesToRoles: Array<"primary" | "secondary" | "exploratory">;
}
```

Field-by-field consumption:

| Field | Consumed as |
|---|---|
| `id`, `label`, `notes` | file header + `analysis_id` column + stamp `id` |
| `comparisonIds[]` | resolved via `spec.comparisons` → one row-pair per implemented comparison, in `comparisonIds` order |
| `Comparison.dependentOutcomeId` | resolved via `spec.outcomes`; V1 derivable dataTypes: `binary` (codelist flag in `ascertainmentWindow`), `continuous` is **not claims-derivable** in V1 → R-X limitation |
| `Comparison.independentVarId` | resolved via `spec.groupVars`; V1: `exposure_cohort` source, exactly 2 levels |
| `Comparison.design` | V1: `two_group_independent` only; others → R-X limitation |
| `Comparison.adjusted` / `regression` | adjusted=true → the **unadjusted** bivariate row is still emitted, note `unadjusted_only` + REVIEW (regression is SAS/R, P3) |
| `Comparison.covariateIds` | unused in V1 (adjustment not implemented) → covered by the same REVIEW note |
| `Comparison.role` | emitted verbatim as `comp_role` (future multiplicity families) |
| `Comparison.distributionPolicy` | R-C1a vs R-C1b selection; `varianceTest` documents the Welch pick; `dispersionTest≠none` → REVIEW note |
| `Comparison.reportStat` | `"smd"` honored (SMD column); any other value → REVIEW note (SMD still reported, honestly labeled) |
| `OutcomeVariable.outcomeDefinition` | `codeListId` (event source), `minClaims=1` honored; `minClaims>1` / `setting≠any` / `diagnosisPosition≠any` → REVIEW notes (same wording family as `incidenceLimitations`) |
| `OutcomeVariable.ascertainmentWindow` | `windowConds()` (both languages' helpers) around index |
| `GroupVariable.levels`, `referenceLevel` | g1/g0 assignment (§1.7), stamped |
| `smdBalance.groupVarId` | arm for balance rows (fixture: same var as comparisons) |
| `smdBalance.covariateIds[]` | resolved via `spec.baseline`; V1 derivable kinds: `age` (continuous), `sex` (binary); others → R-X limitation |
| `smdBalance.imbalanceThreshold` | `imbalance_flag` cut (balance rows only) |
| `smdBalance.reportWeighted` | `true` → REVIEW note (weights are P2) |
| `multiplicity.method` | `≠"none"` → REVIEW note; never silently applied |
| `multiplicity.alpha` | `≠0.05` → REVIEW note; bounds stay at the pinned 0.05 table |
| `multiplicity.appliesToRoles` | recorded in the REVIEW note text only (V1) |
| `spec.meta.daysPerYear` | **not consumed** (no person-time) — documented, not stamped |

---

## 3. SQL twin — complete CTE chain (Postgres, PGlite-executable)

Emitted body (shown instantiated for Gold Case A: `${wp}`=`tz_study`,
g1=`DRUG_X`, g0=`DRUG_Y`, index list `index_drug`, AE outcome `ae_dx`, window
day 1..365). Spec-driven fragments are marked `-- <—`. Dialect helpers used:
`d.createTableAs`, `d.offset` (window bounds), `d.year` (age), `d.roundN`
(all rounding); everything else is portable SQL (CASE-sum aggregates — no
`FILTER`, no `SPLIT_PART`; `VAR_SAMP`, `RANK() OVER`, `POWER`, `SQRT`, `SIGN`,
`LEAST`, `NULLIF` exist in both Postgres 16 and Snowflake). All divisions are
guarded by `NULLIF` and forced numeric (`::NUMERIC` casts / `.0` literals) — the
integer-division trap that produced the 451-vs-451.55 incidence correction
cannot recur here.

```sql
-- PARITY statengine {...}                                   (see §5 for exact fields)
-- (REVIEW block here when statengineLimitations(an, spec) is non-empty — §6)

DROP TABLE IF EXISTS tz_study_statengine;
CREATE TABLE tz_study_statengine AS
WITH cohort AS (
  SELECT enrolid, index_date FROM tz_study_cohort
),
-- Arm label = MIN over the drug labels of every index-list claim on the
-- patient's OWN index date. Labels are generated at emission time from the
-- spec code list (first alternation of each drug_name pattern) so they
-- byte-match the SAS 010 CASE labels and 030's index_drug = min(drug).
arm AS (
  SELECT c.enrolid, c.index_date,
         MIN(CASE n.pattern
               WHEN 'DRUG_X' THEN 'DRUG_X'                    -- <— per code entry
               WHEN 'DRUG_Y' THEN 'DRUG_Y'
             END) AS arm_label
  FROM cohort c
  JOIN tz_study_events ev
    ON ev.enrolid = c.enrolid
   AND ev.event_type = 'drug'
   AND ev.code_list_id = 'index_drug'                         -- <— indexEvent.codeListId
   AND ev.event_date = c.index_date
  JOIN tz_study_ndc_lookup n
    ON n.ndcnum = ev.code
   AND n.code_list_id = 'index_drug'
  GROUP BY c.enrolid, c.index_date
),
grp AS (   -- keep only the two configured levels; g = 1 (g1) / 0 (g0=reference)
  SELECT enrolid, index_date,
         CASE arm_label WHEN 'DRUG_X' THEN 1 ELSE 0 END AS g  -- <— levels/referenceLevel
  FROM arm
  WHERE arm_label IN ('DRUG_X', 'DRUG_Y')
),
-- Demographics from the enrollment segment in force at (or latest before)
-- index — SAME source and tie-break as the incidence twin (never claim AGE).
demo AS (
  SELECT gr.enrolid, en.dobyr, en.sex,
         ROW_NUMBER() OVER (PARTITION BY gr.enrolid
                            ORDER BY en.dtstart DESC, en.dtend DESC) AS rn
  FROM grp gr
  JOIN ccaet_all en                                           -- <— ctx.t("enrollment_detail")
    ON en.enrolid = gr.enrolid
   AND en.dtstart <= gr.index_date
),
demo1 AS (SELECT enrolid, dobyr, sex FROM demo WHERE rn = 1),
base AS (
  SELECT gr.enrolid, gr.g, gr.index_date,
         CAST(EXTRACT(YEAR FROM gr.index_date) AS INT) - dm.dobyr AS age,   -- d.year()
         CAST(dm.sex AS VARCHAR) AS sex
  FROM grp gr
  LEFT JOIN demo1 dm ON dm.enrolid = gr.enrolid
),

/* ============ comparison c_ae: binary outcome ae_dx vs arm ============ */
o_c_ae AS (   -- outcome flag: >= 1 qualifying claim, day 1..365 after index
  SELECT b2.enrolid, b2.g,
         CASE WHEN EXISTS (
                SELECT 1 FROM tz_study_events e
                WHERE e.enrolid = b2.enrolid
                  AND e.code_list_id = 'ae_dx'                -- <— outcomeDefinition.codeListId
                  AND e.event_date >= (b2.index_date + 1)     -- <— windowConds(ascertainmentWindow)
                  AND e.event_date <= (b2.index_date + 365)
              ) THEN 1 ELSE 0 END AS y
  FROM base b2
),
v_c_ae AS (
  SELECT SUM(CASE WHEN g = 1 THEN 1 ELSE 0 END) AS n1,
         SUM(CASE WHEN g = 0 THEN 1 ELSE 0 END) AS n0,
         SUM(CASE WHEN g = 1 AND y = 1 THEN 1 ELSE 0 END) AS x1,
         SUM(CASE WHEN g = 0 AND y = 1 THEN 1 ELSE 0 END) AS x0
  FROM o_c_ae
),
c_c_ae AS (
  SELECT n1, n0, x1, x0,
         CAST(x1 AS NUMERIC) / NULLIF(n1, 0) AS p1,
         CAST(x0 AS NUMERIC) / NULLIF(n0, 0) AS p0,
         -- Pearson 2x2 closed form N(ad-bc)^2 / (r1*r0*c1*c0); NUMERIC casts
         -- prevent both int overflow and integer division
         CAST(n1 + n0 AS NUMERIC)
           * POWER(CAST(x1 AS NUMERIC) * (n0 - x0) - CAST(x0 AS NUMERIC) * (n1 - x1), 2)
           / NULLIF(CAST(n1 AS NUMERIC) * n0 * (x1 + x0) * (n1 + n0 - x1 - x0), 0) AS chisq,
         LEAST(CAST(n1 AS NUMERIC) * (x1 + x0), CAST(n1 AS NUMERIC) * (n1 + n0 - x1 - x0),
               CAST(n0 AS NUMERIC) * (x1 + x0), CAST(n0 AS NUMERIC) * (n1 + n0 - x1 - x0))
           / NULLIF(n1 + n0, 0) AS min_expected,
         (CAST(x1 AS NUMERIC) / NULLIF(n1, 0) - CAST(x0 AS NUMERIC) / NULLIF(n0, 0))
           / NULLIF(SQRT(((CAST(x1 AS NUMERIC) / NULLIF(n1, 0)) * (1 - CAST(x1 AS NUMERIC) / NULLIF(n1, 0))
                        + (CAST(x0 AS NUMERIC) / NULLIF(n0, 0)) * (1 - CAST(x0 AS NUMERIC) / NULLIF(n0, 0))) / 2.0), 0) AS smd
  FROM v_c_ae
),

/* ============ balance covariate b_age: continuous ============ */
v_b_age AS (
  SELECT SUM(CASE WHEN g = 1 AND age IS NOT NULL THEN 1 ELSE 0 END) AS n1,
         SUM(CASE WHEN g = 0 AND age IS NOT NULL THEN 1 ELSE 0 END) AS n0,
         SUM(CASE WHEN g = 1 AND age IS NULL THEN 1 ELSE 0 END) AS nmiss1,
         SUM(CASE WHEN g = 0 AND age IS NULL THEN 1 ELSE 0 END) AS nmiss0,
         AVG(CASE WHEN g = 1 THEN CAST(age AS NUMERIC) END) AS mean1,
         AVG(CASE WHEN g = 0 THEN CAST(age AS NUMERIC) END) AS mean0,
         VAR_SAMP(CASE WHEN g = 1 THEN CAST(age AS NUMERIC) END) AS var1,   -- n-1 (matches SAS var())
         VAR_SAMP(CASE WHEN g = 0 THEN CAST(age AS NUMERIC) END) AS var0
  FROM base
),
t_b_age AS (
  SELECT n1, n0, nmiss1, nmiss0, mean1, mean0, var1, var0,
         (mean1 - mean0) / NULLIF(SQRT(var1 / NULLIF(n1, 0) + var0 / NULLIF(n0, 0)), 0) AS t_stat,
         POWER(var1 / NULLIF(n1, 0) + var0 / NULLIF(n0, 0), 2)
           / NULLIF(POWER(var1 / NULLIF(n1, 0), 2) / NULLIF(n1 - 1, 0)
                  + POWER(var0 / NULLIF(n0, 0), 2) / NULLIF(n0 - 1, 0), 0) AS df_welch,
         -- Austin average-of-variances SMD (NOT n-weighted pooled)
         (mean1 - mean0) / NULLIF(SQRT((var1 + var0) / 2.0), 0) AS smd
  FROM v_b_age
),
r_b_age AS (   -- joint midranks: RANK() + (tie block size - 1)/2  ==  PROC RANK TIES=MEAN
  SELECT g,
         RANK() OVER (ORDER BY age) + (COUNT(*) OVER (PARTITION BY age) - 1) / 2.0 AS midrank
  FROM base
  WHERE age IS NOT NULL
),
w_b_age AS (
  SELECT SUM(CASE WHEN g = 1 THEN midrank END) AS w1,
         SUM(CASE WHEN g = 1 THEN 1 ELSE 0 END) AS n1,
         SUM(CASE WHEN g = 0 THEN 1 ELSE 0 END) AS n0,
         COUNT(*) AS nn
  FROM r_b_age
),
tie_b_age AS (   -- tie-correction term Sum(t^3 - t) over tie groups
  SELECT COALESCE(SUM(POWER(cnt, 3) - cnt), 0) AS tie_sum
  FROM (SELECT COUNT(*) AS cnt FROM base WHERE age IS NOT NULL GROUP BY age) tg
),
z_b_age AS (
  SELECT w.w1, w.nn,
         w.n1 * (w.nn + 1) / 2.0 AS e_w,
         (CAST(w.n1 AS NUMERIC) * w.n0 / 12.0)
           * ((w.nn + 1) - t.tie_sum / NULLIF(CAST(w.nn AS NUMERIC) * (w.nn - 1), 0)) AS var_w
  FROM w_b_age w CROSS JOIN tie_b_age t
),
z2_b_age AS (
  SELECT w1, e_w, var_w,
         -- continuity correction 0.5, clamped so it can never overshoot past 0
         CASE WHEN ABS(w1 - e_w) <= 0.5 THEN 0
              ELSE (w1 - e_w - SIGN(w1 - e_w) * 0.5) END
           / NULLIF(SQRT(var_w), 0) AS z_stat
  FROM z_b_age
),

/* ============ balance covariate b_sex: binary (event = Male, '1') ============ */
v_b_sex AS (
  SELECT SUM(CASE WHEN g = 1 AND sex IS NOT NULL THEN 1 ELSE 0 END) AS n1,
         SUM(CASE WHEN g = 0 AND sex IS NOT NULL THEN 1 ELSE 0 END) AS n0,
         SUM(CASE WHEN g = 1 AND sex IS NULL THEN 1 ELSE 0 END) AS nmiss1,
         SUM(CASE WHEN g = 0 AND sex IS NULL THEN 1 ELSE 0 END) AS nmiss0,
         SUM(CASE WHEN g = 1 AND sex = '1' THEN 1 ELSE 0 END) AS x1,
         SUM(CASE WHEN g = 0 AND sex = '1' THEN 1 ELSE 0 END) AS x0
  FROM base
),
c_b_sex AS (
  SELECT n1, n0, nmiss1, nmiss0, x1, x0,
         CAST(x1 AS NUMERIC) / NULLIF(n1, 0) AS p1,
         CAST(x0 AS NUMERIC) / NULLIF(n0, 0) AS p0,
         CAST(n1 + n0 AS NUMERIC)
           * POWER(CAST(x1 AS NUMERIC) * (n0 - x0) - CAST(x0 AS NUMERIC) * (n1 - x1), 2)
           / NULLIF(CAST(n1 AS NUMERIC) * n0 * (x1 + x0) * (n1 + n0 - x1 - x0), 0) AS chisq,
         LEAST(CAST(n1 AS NUMERIC) * (x1 + x0), CAST(n1 AS NUMERIC) * (n1 + n0 - x1 - x0),
               CAST(n0 AS NUMERIC) * (x1 + x0), CAST(n0 AS NUMERIC) * (n1 + n0 - x1 - x0))
           / NULLIF(n1 + n0, 0) AS min_expected,
         (CAST(x1 AS NUMERIC) / NULLIF(n1, 0) - CAST(x0 AS NUMERIC) / NULLIF(n0, 0))
           / NULLIF(SQRT(((CAST(x1 AS NUMERIC) / NULLIF(n1, 0)) * (1 - CAST(x1 AS NUMERIC) / NULLIF(n1, 0))
                        + (CAST(x0 AS NUMERIC) / NULLIF(n0, 0)) * (1 - CAST(x0 AS NUMERIC) / NULLIF(n0, 0))) / 2.0), 0) AS smd
  FROM v_b_sex
),

/* pinned alpha=0.05 two-sided critical bounds (T_CRIT_05 in parity.ts) */
tcrit (df, crit) AS (VALUES
  (1, 12.7062), (2, 4.3027), (3, 3.1824), (4, 2.7764), (5, 2.5706),
  (6, 2.4469), (7, 2.3646), (8, 2.3060), (9, 2.2622), (10, 2.2281),
  (11, 2.2010), (12, 2.1788), (13, 2.1604), (14, 2.1448), (15, 2.1314),
  (16, 2.1199), (17, 2.1098), (18, 2.1009), (19, 2.0930), (20, 2.0860),
  (21, 2.0796), (22, 2.0739), (23, 2.0687), (24, 2.0639), (25, 2.0595),
  (26, 2.0555), (27, 2.0518), (28, 2.0484), (29, 2.0452), (30, 2.0423),
  (40, 2.0211), (50, 2.0086), (60, 2.0003), (80, 1.9901), (100, 1.9840),
  (120, 1.9799)
),

rows_out AS (
  /* -------- c_ae / chi_square (feeder; role decided by run-time R-B1 rule) -------- */
  SELECT 'a_stat' AS analysis_id, 'comparison' AS row_source, 'c_ae' AS row_id,
         'AE (E11.9) within 365d' AS variable, 'binary' AS data_type,
         'DRUG_X' AS group_1, 'DRUG_Y' AS group_0, 'primary' AS comp_role,
         c.n1, c.n0, 0 AS nmiss1, 0 AS nmiss0,
         c.p1 AS stat1, c.p0 AS stat0,
         CAST(NULL AS NUMERIC) AS sd1, CAST(NULL AS NUMERIC) AS sd0,
         c.x1, c.x0,
         'chi_square' AS test_selected,
         CASE WHEN c.min_expected >= 5 THEN 'selected' ELSE 'invalid_small_cells' END AS test_role,
         'R-B1: binary x 2 independent groups; chi-square unless min expected cell < 5 (Cochran 1954)' AS selection_rule,
         c.chisq AS statistic, 1.0 AS df, 3.8415 AS crit_value_05,
         CASE WHEN c.chisq IS NULL THEN NULL
              WHEN c.chisq > 3.8415 THEN 1 ELSE 0 END AS reject_at_05,
         CAST(NULL AS NUMERIC) AS p_value, 'sas_probchi' AS p_method,
         c.smd, 'austin_avg_var' AS smd_method, CAST(NULL AS INT) AS imbalance_flag,
         c.min_expected,
         CAST(NULL AS NUMERIC) AS rank_sum_g1, CAST(NULL AS NUMERIC) AS e_rank_sum,
         CAST(NULL AS NUMERIC) AS var_rank_sum,
         CASE WHEN c.n1 = 0 OR c.n0 = 0 THEN 'empty_group' ELSE '' END AS note
  FROM c_c_ae c
  UNION ALL
  /* -------- c_ae / fisher_exact (SAS-only p; feeder counts only here) -------- */
  SELECT 'a_stat', 'comparison', 'c_ae', 'AE (E11.9) within 365d', 'binary',
         'DRUG_X', 'DRUG_Y', 'primary',
         c.n1, c.n0, 0, 0, c.p1, c.p0, NULL, NULL, c.x1, c.x0,
         'fisher_exact',
         CASE WHEN c.min_expected < 5 THEN 'selected' ELSE 'not_required' END,
         'R-B1a: fisher selected when min expected cell < 5; exact p has no closed form in SQL',
         CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),
         CAST(NULL AS INT),
         CAST(NULL AS NUMERIC), 'sas_fisher_exact',
         c.smd, 'austin_avg_var', CAST(NULL AS INT),
         c.min_expected, NULL, NULL, NULL,
         CASE WHEN c.n1 = 0 OR c.n0 = 0 THEN 'empty_group' ELSE '' END
  FROM c_c_ae c
  UNION ALL
  /* -------- b_age / t_welch (selected: R-C1bal) -------- */
  SELECT 'a_stat', 'balance', 'b_age', 'Age at index', 'continuous',
         'DRUG_X', 'DRUG_Y', CAST(NULL AS VARCHAR),
         t.n1, t.n0, t.nmiss1, t.nmiss0,
         t.mean1, t.mean0, SQRT(t.var1), SQRT(t.var0),
         CAST(NULL AS INT), CAST(NULL AS INT),
         't_welch', 'selected',
         'R-C1bal: continuous balance covariate; Welch t (assume-normal default; no distribution policy exists on smdBalance)',
         t.t_stat, t.df_welch,
         (SELECT crit FROM tcrit WHERE df <= FLOOR(t.df_welch) ORDER BY df DESC LIMIT 1),
         CASE WHEN t.t_stat IS NULL THEN NULL
              WHEN ABS(t.t_stat) >
                   (SELECT crit FROM tcrit WHERE df <= FLOOR(t.df_welch) ORDER BY df DESC LIMIT 1)
              THEN 1 ELSE 0 END,
         CAST(NULL AS NUMERIC), 'sas_probt',
         t.smd, 'austin_avg_var',
         CASE WHEN t.smd IS NULL THEN NULL
              WHEN ABS(t.smd) > 0.1 THEN 1 ELSE 0 END,          -- <— smdBalance.imbalanceThreshold
         CAST(NULL AS NUMERIC), NULL, NULL, NULL,
         CASE WHEN t.n1 = 0 OR t.n0 = 0 THEN 'empty_group'
              WHEN t.var1 = 0 AND t.var0 = 0 THEN 'zero_variance' ELSE '' END
  FROM t_b_age t
  UNION ALL
  /* -------- b_age / wilcoxon (supporting: R-C1bal) -------- */
  SELECT 'a_stat', 'balance', 'b_age', 'Age at index', 'continuous',
         'DRUG_X', 'DRUG_Y', CAST(NULL AS VARCHAR),
         t.n1, t.n0, t.nmiss1, t.nmiss0, t.mean1, t.mean0, SQRT(t.var1), SQRT(t.var0),
         CAST(NULL AS INT), CAST(NULL AS INT),
         'wilcoxon_rank_sum_normal_cc', 'supporting',
         'R-C1bal: rank-sum normal approximation, midranks + tie correction + 0.5 continuity correction',
         z.z_stat, CAST(NULL AS NUMERIC), 1.9600,
         CASE WHEN z.z_stat IS NULL THEN NULL
              WHEN ABS(z.z_stat) > 1.9600 THEN 1 ELSE 0 END,
         CAST(NULL AS NUMERIC), 'sas_probnorm',
         t.smd, 'austin_avg_var',
         CASE WHEN t.smd IS NULL THEN NULL WHEN ABS(t.smd) > 0.1 THEN 1 ELSE 0 END,
         CAST(NULL AS NUMERIC), z.w1, z.e_w, z.var_w,
         CASE WHEN t.n1 = 0 OR t.n0 = 0 THEN 'empty_group'
              WHEN z.var_w = 0 THEN 'all_tied' ELSE '' END
  FROM t_b_age t CROSS JOIN z2_b_age z
  UNION ALL
  /* -------- b_sex / chi_square -------- */
  SELECT 'a_stat', 'balance', 'b_sex', 'Sex', 'binary',
         'DRUG_X', 'DRUG_Y', CAST(NULL AS VARCHAR),
         s.n1, s.n0, s.nmiss1, s.nmiss0, s.p1, s.p0, NULL, NULL, s.x1, s.x0,
         'chi_square',
         CASE WHEN s.min_expected >= 5 THEN 'selected' ELSE 'invalid_small_cells' END,
         'R-B1: binary x 2 independent groups; event level = Male (sex=''1'')',
         s.chisq, 1.0, 3.8415,
         CASE WHEN s.chisq IS NULL THEN NULL WHEN s.chisq > 3.8415 THEN 1 ELSE 0 END,
         CAST(NULL AS NUMERIC), 'sas_probchi',
         s.smd, 'austin_avg_var',
         CASE WHEN s.smd IS NULL THEN NULL WHEN ABS(s.smd) > 0.1 THEN 1 ELSE 0 END,
         s.min_expected, NULL, NULL, NULL,
         CASE WHEN s.n1 = 0 OR s.n0 = 0 THEN 'empty_group' ELSE '' END
  FROM c_b_sex s
  UNION ALL
  /* -------- b_sex / fisher_exact -------- */
  SELECT 'a_stat', 'balance', 'b_sex', 'Sex', 'binary',
         'DRUG_X', 'DRUG_Y', CAST(NULL AS VARCHAR),
         s.n1, s.n0, s.nmiss1, s.nmiss0, s.p1, s.p0, NULL, NULL, s.x1, s.x0,
         'fisher_exact',
         CASE WHEN s.min_expected < 5 THEN 'selected' ELSE 'not_required' END,
         'R-B1a: fisher selected when min expected cell < 5; exact p has no closed form in SQL',
         CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC), CAST(NULL AS NUMERIC),
         CAST(NULL AS INT),
         CAST(NULL AS NUMERIC), 'sas_fisher_exact',
         s.smd, 'austin_avg_var',
         CASE WHEN s.smd IS NULL THEN NULL WHEN ABS(s.smd) > 0.1 THEN 1 ELSE 0 END,
         s.min_expected, NULL, NULL, NULL,
         CASE WHEN s.n1 = 0 OR s.n0 = 0 THEN 'empty_group' ELSE '' END
  FROM c_b_sex s
)
SELECT analysis_id, row_source, row_id, variable, data_type, group_1, group_0,
       comp_role, n1, n0, nmiss1, nmiss0,
       ROUND(CAST(stat1 AS NUMERIC), 4) AS stat1,
       ROUND(CAST(stat0 AS NUMERIC), 4) AS stat0,
       ROUND(CAST(sd1 AS NUMERIC), 4) AS sd1,
       ROUND(CAST(sd0 AS NUMERIC), 4) AS sd0,
       x1, x0, test_selected, test_role, selection_rule,
       ROUND(CAST(statistic AS NUMERIC), 4) AS statistic,   -- reject computed PRE-round above
       ROUND(CAST(df AS NUMERIC), 2) AS df,
       crit_value_05, reject_at_05,
       -- p_value is NULL BY DESIGN in this twin: t/normal/chi-square tail
       -- probabilities and the Fisher exact sum have no closed form in portable
       -- SQL. The SAS twin computes them (PROBT/PROBNORM/PROBCHI/PROC FREQ
       -- EXACT FISHER) and both twins label the source in p_method. The
       -- machine-verified decision column is reject_at_05.
       p_value, p_method,
       ROUND(CAST(smd AS NUMERIC), 5) AS smd, smd_method, imbalance_flag,
       ROUND(CAST(min_expected AS NUMERIC), 4) AS min_expected,
       ROUND(CAST(rank_sum_g1 AS NUMERIC), 1) AS rank_sum_g1,
       ROUND(CAST(e_rank_sum AS NUMERIC), 1) AS e_rank_sum,
       ROUND(CAST(var_rank_sum AS NUMERIC), 4) AS var_rank_sum,
       note
FROM rows_out;

-- REVIEW: comparison table + test-selection ledger, one row per (variable, test).
SELECT row_source, row_id, variable, test_selected, test_role, statistic, df,
       crit_value_05, reject_at_05, p_value, p_method, smd, imbalance_flag, note
FROM tz_study_statengine
ORDER BY row_source, row_id, test_selected;

-- REVIEW: arm-classification QC - engine_n < cohort_n means some patients'
-- index-day drug label matched none of the configured group levels.
SELECT (SELECT COUNT(*) FROM tz_study_cohort) AS cohort_n,
       (SELECT MAX(n1 + nmiss1 + n0 + nmiss0) FROM tz_study_statengine) AS engine_n;
```

`SqlModuleFile`: slug `statengine`, title `08 Statistical comparisons`, subtitle
`deterministic test selection + closed-form comparison table (p-values SAS-side)`.

---

## 4. SAS twin — complete program mirroring the SQL arithmetic

`090_statengine.sas` (Gold instantiation; `header()` / `INCLUDE_SETUP` /
`levelCheck()` from sas-base; every formula line is byte-shared with §3 up to
language syntax and is covered by the §5 signature fragments). SAS missing-value
semantics are guarded explicitly: `abs(.) > crit` would be FALSE (not missing),
so every flag tests `if stat = . then flag = .; else ...` — called out inline.

```sas
/*=== header(spec, "090_statengine.sas", [ ... twin-of-08 note ... ]) ===*/
/* PARITY statengine {...}   (identical stableJson to the SQL twin - see §5) */
/* (REVIEW block when statengineLimitations() is non-empty - §6) */

%include "00_setup.sas";   /* EDIT: use the full site path to 00_setup.sas */

proc datasets lib=tz nolist nowarn;
  delete &tag._090_statengine;
quit;

/*-------------------- arm assignment (rule identical to the SQL twin) --------
  030_index.index_drug is ALREADY min(drug label) over the patient's index-day
  claims, and the 010 CASE labels equal the SQL twin's generated pattern->label
  map (first alternation of each drug_name pattern) - byte-identical levels.  */
proc sort data=tz.&tag._060_coh2 out=work._090_coh; by enrolid; run;   /* ctx.finalCohort */

data work._090_arm;
  set work._090_coh;
  length arm_label $40;
  arm_label = index_drug;
  if      arm_label = 'DRUG_X' then g = 1;   /* g1 = first non-reference level  */
  else if arm_label = 'DRUG_Y' then g = 0;   /* g0 = referenceLevel             */
  else delete;                               /* unclassified -> QC below        */
run;

title "QC: cohort vs classified arms (difference = unclassified index-drug labels)";
proc sql;
  select (select count(*) from tz.&tag._060_coh2) as cohort_n,
         count(*) as engine_n
  from work._090_arm;
quit;

/*-------------------- enrollment-segment demographics -----------------------
  Segment in force at (or latest before) index; dtstart DESC, dtend DESC
  tie-break - the SAME source and tie-break as the SQL twin (never claim AGE). */
proc sql;
  create table work._090_dm0 as
  select a.enrolid, b.dobyr, b.sex, b.dtstart as seg_start, b.dtend as seg_end
  from work._090_arm as a
  left join tz.&tag._040_enroll as b
    on  b.enrolid = a.enrolid
    and b.dtstart <= a.index_date;
quit;

proc sort data=work._090_dm0; by enrolid descending seg_start descending seg_end; run;

data work._090_dm;
  set work._090_dm0;
  by enrolid;
  if first.enrolid;
  keep enrolid dobyr sex;
run;

data work._090_base;
  merge work._090_arm(in=a keep=enrolid index_date g) work._090_dm;
  by enrolid;
  if a;
  if dobyr ne . then age = year(index_date) - dobyr;   /* enrollment-derived age */
run;

/* outcome flag for comparison c_ae: >= 1 qualifying claim, day 1..365 (window
   EXCLUDES index - follow-up convention), from the 020 event pull            */
proc sql;
  create table work._090_base2 as
  select a.*,
         case when exists (select 1 from tz.&tag._ev_ae_dx as e
                           where e.enrolid = a.enrolid
                             and e.svcdate >= a.index_date + 1
                             and e.svcdate <= a.index_date + 365)
              then 1 else 0 end as y_c_ae
  from work._090_base as a;
quit;

title "Level check: work._090_base2 (engine base)";
proc sql;
  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt from work._090_base2;
quit;

/*==================== c_ae: binary outcome vs arm ====================*/
proc sql;
  create table work._090_v_c_ae as
  select sum(g = 1)              as n1,
         sum(g = 0)              as n0,
         sum(g = 1 and y_c_ae = 1) as x1,
         sum(g = 0 and y_c_ae = 1) as x0
  from work._090_base2;
quit;

data work._090_c_c_ae;
  set work._090_v_c_ae;
  if n1 > 0 then p1 = x1 / n1;
  if n0 > 0 then p0 = x0 / n0;
  _den = n1 * n0 * (x1 + x0) * (n1 + n0 - x1 - x0);
  /* Pearson 2x2 closed form N(ad-bc)^2 / (r1*r0*c1*c0) - same as SQL twin */
  if _den > 0 then chisq = (n1 + n0) * (x1 * (n0 - x0) - x0 * (n1 - x1))**2 / _den;
  if n1 + n0 > 0 then
    min_expected = min(n1 * (x1 + x0), n1 * (n1 + n0 - x1 - x0),
                       n0 * (x1 + x0), n0 * (n1 + n0 - x1 - x0)) / (n1 + n0);
  _sden = sqrt((p1 * (1 - p1) + p0 * (1 - p0)) / 2.0);
  if _sden > 0 then smd = (p1 - p0) / _sden;
  drop _den _sden;
run;

/*==================== b_age: continuous covariate ====================*/
proc sql;
  create table work._090_v_b_age as
  select sum(g = 1 and age ne .) as n1,
         sum(g = 0 and age ne .) as n0,
         sum(g = 1 and age = .)  as nmiss1,
         sum(g = 0 and age = .)  as nmiss0,
         mean(case when g = 1 then age end) as mean1,
         mean(case when g = 0 then age end) as mean0,
         var (case when g = 1 then age end) as var1,   /* n-1, matches VAR_SAMP */
         var (case when g = 0 then age end) as var0
  from work._090_base2;
quit;

data work._090_t_b_age;
  set work._090_v_b_age;
  _se2 = var1 / n1 + var0 / n0;                        /* missing propagates    */
  if _se2 > 0 then t_stat = (mean1 - mean0) / sqrt(_se2);
  _dfden = (var1 / n1)**2 / (n1 - 1) + (var0 / n0)**2 / (n0 - 1);
  if _dfden > 0 then df_welch = _se2**2 / _dfden;
  /* Austin average-of-variances SMD (NOT n-weighted pooled) */
  _sden = sqrt((var1 + var0) / 2.0);
  if _sden > 0 then smd = (mean1 - mean0) / _sden;
  drop _se2 _dfden _sden;
run;

/* joint midranks == SQL's RANK() + (ties-1)/2 */
proc rank data=work._090_base2(where=(age ne .)) ties=mean out=work._090_r_b_age;
  var age;
  ranks midrank;
run;

proc sql;
  create table work._090_w_b_age as
  select sum(case when g = 1 then midrank end) as w1,
         sum(g = 1) as n1, sum(g = 0) as n0, count(*) as nn
  from work._090_r_b_age;

  create table work._090_tie_b_age as
  select coalesce(sum(cnt**3 - cnt), 0) as tie_sum
  from (select count(*) as cnt from work._090_base2 where age ne . group by age);
quit;

data work._090_z_b_age;
  merge work._090_w_b_age work._090_tie_b_age;
  e_w = n1 * (nn + 1) / 2.0;
  if nn > 1 then
    var_w = (n1 * n0 / 12.0) * ((nn + 1) - tie_sum / (nn * (nn - 1)));
  /* continuity correction 0.5, clamped so it can never overshoot past 0 */
  if w1 = . or var_w = . or var_w <= 0 then z_stat = .;
  else if abs(w1 - e_w) <= 0.5 then z_stat = 0;
  else z_stat = (w1 - e_w - sign(w1 - e_w) * 0.5) / sqrt(var_w);
run;

/*==================== b_sex: binary covariate (event = Male '1') ====================*/
proc sql;
  create table work._090_v_b_sex as
  select sum(g = 1 and sex ne '') as n1,
         sum(g = 0 and sex ne '') as n0,
         sum(g = 1 and sex = '')  as nmiss1,
         sum(g = 0 and sex = '')  as nmiss0,
         sum(g = 1 and sex = '1') as x1,
         sum(g = 0 and sex = '1') as x0
  from work._090_base2;
quit;

data work._090_c_b_sex;   /* identical arithmetic to _090_c_c_ae */
  set work._090_v_b_sex;
  if n1 > 0 then p1 = x1 / n1;
  if n0 > 0 then p0 = x0 / n0;
  _den = n1 * n0 * (x1 + x0) * (n1 + n0 - x1 - x0);
  if _den > 0 then chisq = (n1 + n0) * (x1 * (n0 - x0) - x0 * (n1 - x1))**2 / _den;
  if n1 + n0 > 0 then
    min_expected = min(n1 * (x1 + x0), n1 * (n1 + n0 - x1 - x0),
                       n0 * (x1 + x0), n0 * (n1 + n0 - x1 - x0)) / (n1 + n0);
  _sden = sqrt((p1 * (1 - p1) + p0 * (1 - p0)) / 2.0);
  if _sden > 0 then smd = (p1 - p0) / _sden;
  drop _den _sden;
run;

/*-------------------- SAS-only p-values (labeled; the SQL twin stores NULL) --
  Fisher exact via PROC FREQ on the reconstructed 2x2 - the ONE sanctioned
  PROC in this program (no closed form exists; factorials explode).           */
data work._090_f_cells;
  set work._090_c_c_ae(in=a) work._090_c_b_sex(in=b);
  length rowid $8;
  rowid = ifc(a, 'c_ae', 'b_sex');
  grp = 1; evt = 1; wt = x1;      output;
  grp = 1; evt = 0; wt = n1 - x1; output;
  grp = 0; evt = 1; wt = x0;      output;
  grp = 0; evt = 0; wt = n0 - x0; output;
  keep rowid grp evt wt;
run;

ods output FishersExact=work._090_fish0;
proc freq data=work._090_f_cells(where=(wt > 0));
  by rowid;
  tables grp * evt / chisq;
  exact fisher;
  weight wt;
run;
ods output close;

data work._090_fish;
  set work._090_fish0(where=(name1 = 'XP2_FISH'));
  p_fisher = nvalue1;
  keep rowid p_fisher;
run;

/*-------------------- assemble the comparison table --------------------------
  One row per (variable, test); flags are guarded against SAS missing
  semantics: abs(.) > crit evaluates FALSE, so every flag tests missing FIRST. */
%macro _tcrit(dfvar=, out=);   /* pinned floor + step-down-conservative lookup */
  array _tcd{36} _temporary_ (1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20
                              21 22 23 24 25 26 27 28 29 30 40 50 60 80 100 120);
  array _tcv{36} _temporary_ (12.7062 4.3027 3.1824 2.7764 2.5706 2.4469 2.3646
                              2.3060 2.2622 2.2281 2.2010 2.1788 2.1604 2.1448
                              2.1314 2.1199 2.1098 2.1009 2.0930 2.0860 2.0796
                              2.0739 2.0687 2.0639 2.0595 2.0555 2.0518 2.0484
                              2.0452 2.0423 2.0211 2.0086 2.0003 1.9901 1.9840
                              1.9799);
  &out = .;
  if &dfvar ne . and &dfvar >= 1 then do _i = 1 to 36;
    if _tcd{_i} <= floor(&dfvar) then &out = _tcv{_i};
  end;
  drop _i;
%mend _tcrit;

data tz.&tag._090_statengine;
  length analysis_id $40 row_source $12 row_id $40 variable $40 data_type $12
         group_1 $40 group_0 $40 comp_role $16 test_selected $32 test_role $32
         selection_rule $200 p_method $24 smd_method $16 note $24;
  retain analysis_id 'a_stat' group_1 'DRUG_X' group_0 'DRUG_Y';

  /* ---- c_ae: chi_square + fisher_exact rows ---- */
  do until (_d1);
    merge work._090_c_c_ae work._090_fish(where=(rowid='c_ae') rename=(p_fisher=_pf)) end=_d1;
    row_source = 'comparison'; row_id = 'c_ae';
    variable = 'AE (E11.9) within 365d'; data_type = 'binary'; comp_role = 'primary';
    nmiss1 = 0; nmiss0 = 0;
    stat1 = round(p1, 0.0001); stat0 = round(p0, 0.0001); sd1 = .; sd0 = .;
    if smd ne . then smd_r = round(smd, 0.00001); else smd_r = .;
    smd_method = 'austin_avg_var'; imbalance_flag = .;
    min_exp_r = round(min_expected, 0.0001);
    if n1 = 0 or n0 = 0 then note = 'empty_group'; else note = '';

    test_selected = 'chi_square';
    if min_expected ne . and min_expected >= 5 then test_role = 'selected';
    else test_role = 'invalid_small_cells';
    selection_rule = 'R-B1: binary x 2 independent groups; chi-square unless min expected cell < 5 (Cochran 1954)';
    statistic = round(chisq, 0.0001); df = 1; crit_value_05 = 3.8415;
    if chisq = . then reject_at_05 = .;                 /* guard BEFORE compare */
    else reject_at_05 = (chisq > 3.8415);
    if chisq = . then p_value = .; else p_value = 1 - probchi(chisq, 1);
    p_method = 'sas_probchi';
    rank_sum_g1 = .; e_rank_sum = .; var_rank_sum = .;
    smd = smd_r; min_expected = min_exp_r; output;

    test_selected = 'fisher_exact';
    if min_expected ne . and min_expected < 5 then test_role = 'selected';
    else test_role = 'not_required';
    selection_rule = 'R-B1a: fisher selected when min expected cell < 5; exact p has no closed form in SQL';
    statistic = .; df = .; crit_value_05 = .; reject_at_05 = .;
    p_value = _pf; p_method = 'sas_fisher_exact'; output;
  end;

  /* ---- b_age: t_welch + wilcoxon rows ---- */
  do until (_d2);
    merge work._090_t_b_age work._090_z_b_age end=_d2;
    row_source = 'balance'; row_id = 'b_age';
    variable = 'Age at index'; data_type = 'continuous'; comp_role = '';
    stat1 = round(mean1, 0.0001); stat0 = round(mean0, 0.0001);
    if var1 ne . then sd1 = round(sqrt(var1), 0.0001); else sd1 = .;
    if var0 ne . then sd0 = round(sqrt(var0), 0.0001); else sd0 = .;
    x1 = .; x0 = .;
    if smd = . then do; smd_r = .; imbalance_flag = .; end;
    else do; smd_r = round(smd, 0.00001); imbalance_flag = (abs(smd) > 0.1); end;
    smd_method = 'austin_avg_var'; min_expected = .;
    if n1 = 0 or n0 = 0 then note = 'empty_group';
    else if var1 = 0 and var0 = 0 then note = 'zero_variance';
    else note = '';

    test_selected = 't_welch'; test_role = 'selected';
    selection_rule = 'R-C1bal: continuous balance covariate; Welch t (assume-normal default; no distribution policy exists on smdBalance)';
    statistic = round(t_stat, 0.0001); df = round(df_welch, 0.01);
    %_tcrit(dfvar=df_welch, out=crit_value_05);
    if t_stat = . or crit_value_05 = . then reject_at_05 = .;
    else reject_at_05 = (abs(t_stat) > crit_value_05);
    if t_stat = . or df_welch = . then p_value = .;
    else p_value = 2 * (1 - probt(abs(t_stat), df_welch));
    p_method = 'sas_probt';
    rank_sum_g1 = .; e_rank_sum = .; var_rank_sum = .;
    smd = smd_r; output;

    test_selected = 'wilcoxon_rank_sum_normal_cc'; test_role = 'supporting';
    selection_rule = 'R-C1bal: rank-sum normal approximation, midranks + tie correction + 0.5 continuity correction';
    statistic = round(z_stat, 0.0001); df = .; crit_value_05 = 1.9600;
    if z_stat = . then reject_at_05 = .;
    else reject_at_05 = (abs(z_stat) > 1.9600);
    if z_stat = . then p_value = .;
    else p_value = 2 * (1 - probnorm(abs(z_stat)));
    p_method = 'sas_probnorm';
    rank_sum_g1 = round(w1, 0.1); e_rank_sum = round(e_w, 0.1);
    var_rank_sum = round(var_w, 0.0001);
    if n1 = 0 or n0 = 0 then note = 'empty_group';
    else if var_w = 0 then note = 'all_tied';
    else note = ''; output;
  end;

  /* ---- b_sex: chi_square + fisher_exact rows (event = Male '1') ---- */
  do until (_d3);
    merge work._090_c_b_sex work._090_fish(where=(rowid='b_sex') rename=(p_fisher=_pf2)) end=_d3;
    row_source = 'balance'; row_id = 'b_sex';
    variable = 'Sex'; data_type = 'binary'; comp_role = '';
    stat1 = round(p1, 0.0001); stat0 = round(p0, 0.0001); sd1 = .; sd0 = .;
    if smd = . then do; smd_r = .; imbalance_flag = .; end;
    else do; smd_r = round(smd, 0.00001); imbalance_flag = (abs(smd) > 0.1); end;
    smd_method = 'austin_avg_var';
    min_exp_r = round(min_expected, 0.0001);
    if n1 = 0 or n0 = 0 then note = 'empty_group'; else note = '';

    test_selected = 'chi_square';
    if min_expected ne . and min_expected >= 5 then test_role = 'selected';
    else test_role = 'invalid_small_cells';
    selection_rule = 'R-B1: binary x 2 independent groups; event level = Male (sex=''1'')';
    statistic = round(chisq, 0.0001); df = 1; crit_value_05 = 3.8415;
    if chisq = . then reject_at_05 = .; else reject_at_05 = (chisq > 3.8415);
    if chisq = . then p_value = .; else p_value = 1 - probchi(chisq, 1);
    p_method = 'sas_probchi';
    rank_sum_g1 = .; e_rank_sum = .; var_rank_sum = .;
    smd = smd_r; min_expected = min_exp_r; output;

    test_selected = 'fisher_exact';
    if min_expected ne . and min_expected < 5 then test_role = 'selected';
    else test_role = 'not_required';
    selection_rule = 'R-B1a: fisher selected when min expected cell < 5; exact p has no closed form in SQL';
    statistic = .; df = .; crit_value_05 = .; reject_at_05 = .;
    p_value = _pf2; p_method = 'sas_fisher_exact'; output;
  end;

  stop;
  keep analysis_id row_source row_id variable data_type group_1 group_0 comp_role
       n1 n0 nmiss1 nmiss0 stat1 stat0 sd1 sd0 x1 x0 test_selected test_role
       selection_rule statistic df crit_value_05 reject_at_05 p_value p_method
       smd smd_method imbalance_flag min_expected rank_sum_g1 e_rank_sum
       var_rank_sum note;
run;

/* same presentation order as the SQL twin's REVIEW query */
proc sort data=tz.&tag._090_statengine;
  by row_source row_id test_selected;
run;

title "Statistical comparisons + test-selection ledger: &tag.";
proc print data=tz.&tag._090_statengine noobs;
  var row_source row_id variable test_selected test_role statistic df
      crit_value_05 reject_at_05 p_value p_method smd imbalance_flag note;
run;
```

(Note on the assembly step: the emitter generates one `do until` block per
implemented variable, mechanically — the blueprint shows the three fixture
instances. `nmiss1/nmiss0` for outcome rows are structurally 0: the outcome flag
is defined for every classified patient.)

---

## 5. Parity record — exact stamped fields

`statengineParity(an, consumed)` in `emitters/parity.ts`; stamp kind
`"statengine"`; serialized with the existing `stableJson` (all leaves strings/
numbers, keys sorted). Built from values each twin ACTUALLY consumed:

```ts
export interface StatEngineParity {
  id: string;                    // analysis id
  alpha: string;                 // bound actually used: "0.05" (always in V1)
  multiplicityApplied: string;   // method actually applied: "none" (always in V1)
  groupVar: {
    id: string;                  // e.g. "g_arm"
    g1: string;                  // e.g. "DRUG_X" (first non-reference level)
    g0: string;                  // e.g. "DRUG_Y" (referenceLevel)
    source: string;              // "exposure_cohort"
    tieBreak: string;            // "min_drug_label_on_index_date"
  };
  rows: Array<{                  // the ledger, in emission order
    rowId: string;               // comparison id or baselineId
    source: "comparison" | "balance";
    label: string;               // stratLabel()-capped display label
    dataType: "continuous" | "binary";
    eventLevel?: string;         // binary only: "sex=1(Male)" | "ge_1_claim_in_window"
    tests: Array<{ test: string; role: string; rule: string }>;
  }>;
  smdMethod: string;             // "austin_avg_var"
  smdThreshold: number;          // smdBalance.imbalanceThreshold (0.1)
  wilcoxon: { ties: string; continuityCorrection: string };
                                 // "midrank_tie_corrected", "0.5"
  welch: { dfRule: string; critDfRule: string };
                                 // "welch_satterthwaite", "floor_step_down"
  critTableVersion: string;      // "tcrit_v1" (the pinned T_CRIT_05 constants)
}
```

Categorical rows record the RULE, not the run-time outcome (roles are resolved by
data): `tests: [{test:"chi_square", role:"selected_if_min_expected_ge_5",
rule:"R-B1"}, {test:"fisher_exact", role:"selected_if_min_expected_lt_5",
rule:"R-B1a"}]`. Continuous roles are generation-time fixed
(`"selected"`/`"supporting"` per R-C1a/R-C1b/R-C1bal). `daysPerYear` is
deliberately absent: this module consumes no person-time, and the stamp records
only consumed values.

Arithmetic signature fragments for `verify/parity.ts` `SIGNATURES.statengine`
(each string must appear verbatim in the respective twin):

```ts
statengine: {
  sql: [
    "SQRT((var1 + var0) / 2.0)",                    // Austin avg-variance SMD
    "POWER(var1 / NULLIF(n1, 0), 2) / NULLIF(n1 - 1, 0)",  // Welch df
    "SIGN(w1 - e_w) * 0.5",                         // continuity correction
    "POWER(cnt, 3) - cnt",                          // tie correction
    "(COUNT(*) OVER (PARTITION BY age) - 1) / 2.0", // midranks
  ],
  sas: [
    "sqrt((var1 + var0) / 2.0)",
    "(var1 / n1)**2 / (n1 - 1)",
    "sign(w1 - e_w) * 0.5",
    "cnt**3 - cnt",
    "ties=mean",                                    // PROC RANK midranks
  ],
},
```

---

## 6. Limitations — every unimplemented option + REVIEW wording

`statengineLimitations(an, spec)` in `emitters/parity.ts` (incidence style —
emitted as the `-- REVIEW` / `/* REVIEW */` block in BOTH twins, never silent):

| Trigger | Emitted line |
|---|---|
| `multiplicity.method !== "none"` | `multiplicity method "<m>" is NOT applied - p-values are SAS-side only and no adjustment is computed; raw per-row bounds at alpha=0.05 are reported` |
| `multiplicity.alpha !== 0.05` | `multiplicity alpha=<a> is NOT implemented - critical bounds use the pinned two-sided alpha=0.05 table (tcrit_v1)` |
| `comparison.design !== "two_group_independent"` | `comparison "<id>" design "<d>" is NOT implemented - row SKIPPED (V1 emits two-group independent comparisons only)` |
| `comparison.adjusted === true` | `comparison "<id>" requests adjustment (regression family "<f>") - regressions are iterative and SAS/R-only (P3); the UNADJUSTED bivariate row is emitted and labeled` |
| `distributionPolicy.normalityTest` in {shapiro_wilk, anderson_darling} | `normality test "<t>" is NOT implemented (SAS PROC, no closed form) - both t_welch and wilcoxon rows are emitted; wilcoxon is selected because allowNonparametricFallback=true` (or `t_welch is selected because allowNonparametricFallback=false`) |
| `distributionPolicy.dispersionTest !== "none"` | `dispersion test "<t>" is NOT implemented - no count outcomes are emitted in V1` |
| `distributionPolicy.varianceTest === "levene"` | `Levene variance test is NOT implemented - the Welch (unequal-variance) t is computed unconditionally and labeled t_welch` |
| `comparison.reportStat !== "smd"` | `reportStat "<s>" is NOT emitted - SMD is reported (labeled austin_avg_var); effect-measure CIs land with the P2/P3 modules` |
| outcome dataType in {count, cost, time_to_event, categorical} | `outcome "<id>" dataType "<t>" is NOT implemented - row SKIPPED (V1: binary comparisons + continuous/binary balance covariates)` |
| outcome dataType `continuous` in comparisons[] | `outcome "<id>" is continuous but has no claims derivation - row SKIPPED (continuous engine variables are balance covariates in V1)` |
| `outcomeDefinition.minClaims > 1` | `outcome minClaims=<n> is NOT yet enforced - any single qualifying claim counts as the outcome` |
| `outcomeDefinition.setting !== "any"` | `outcome care-setting filter "<s>" is NOT yet applied - events from all settings count` |
| `outcomeDefinition.diagnosisPosition !== "any"` | `diagnosisPosition="primary" is NOT yet applied - any-position diagnoses count` |
| groupVar source kind in {baseline, codelist} | `group variable "<id>" source "<kind>" is NOT implemented - analysis rows for it are SKIPPED (V1: exposure_cohort arms only)` |
| `groupVar.levels.length > 2` | `group variable "<id>" has <k> levels - V1 emits two-group comparisons only; rows SKIPPED (multi-group omnibus is a P2 module)` |
| exposure_cohort but `indexEvent.type !== "first_drug_claim"` | `exposure_cohort grouping requires a drug index event - rows SKIPPED` |
| balance covariate kind not in {age, sex} | `balance covariate "<id>" (kind "<k>") is NOT implemented - SKIPPED (V1 derives age and sex; categorical/codelist covariates land next)` |
| `smdBalance.reportWeighted === true` | `reportWeighted=true is NOT implemented - unweighted SMDs only (weights arrive with P2 PS/IPTW)` |

Gold Case A instantiation (§8) fires **zero** notes — the fixture spec is chosen
to be fully inside V1 scope, so the emitted programs are clean.

---

## 7. Fixture vectors — patient-by-patient hand derivation

Frozen inputs (verify/fixture.ts — UNCHANGED): final cohort P01–P10; index date
2019-01-01 for all; arm from index NDC (X=`00000000001`→label `DRUG_X`,
Y=`00000000002`→`DRUG_Y`); age = 2019 − DOBYR from the single enrollment segment
in force at index (P07's second span starts 2019-06-30 > index, so its first span
is the rn=1 segment; DOBYR identical on both spans).

| Pat | Arm (g) | DOBYR → age | sex | AE events (day offset from 2019-01-01) | AE in day 1..365? |
|---|---|---|---|---|---|
| P01 | X (1) | 1979 → 40 | 1 M | 2018-06-01 (day −214) | no (pre-index) |
| P02 | X (1) | 1974 → 45 | 2 F | 2019-04-11 (day 100: Jan31+Feb28+Mar31=90 → Apr11=100) | yes |
| P03 | X (1) | 1969 → 50 | 1 M | 2019-07-20 (day 200: 181 to Jul 1 → +19) | yes |
| P04 | X (1) | 1964 → 55 | 2 F | — | no |
| P05 | X (1) | 1959 → 60 | 1 M | — | no |
| P06 | Y (0) | 1974 → 45 | 1 M | 2018-09-01 (day −122) | no (pre-index) |
| P07 | Y (0) | 1969 → 50 | 2 F | 2019-10-28 (day 300: 273 to Oct 1 → +27) | yes |
| P08 | Y (0) | 1964 → 55 | 1 M | — | no |
| P09 | Y (0) | 1959 → 60 | 2 F | — | no |
| P10 | Y (0) | 1954 → 65 | 1 M | — | no |

n1 = n0 = 5; nmiss = 0 everywhere.

### 7.1 Age — Welch t + SMD (rows `b_age`/`t_welch`)

- mean1 (X) = (40+45+50+55+60)/5 = 250/5 = **50.0000**; mean0 (Y) = (45+50+55+60+65)/5 = 275/5 = **55.0000**
- deviations (both arms): −10,−5,0,5,10 → Σd² = 100+25+0+25+100 = 250 → s² = 250/(5−1) = **62.5** each; sd = √62.5 = 7.9056942 → **7.9057** (4dp)
- SE = √(62.5/5 + 62.5/5) = √25 = 5 → t = (50−55)/5 = **−1.0000**
- Welch df = (12.5+12.5)² / (12.5²/4 + 12.5²/4) = 625 / (39.0625+39.0625) = 625/78.125 = **8.00**
  (fixture note: equal variances and n make Welch ≡ pooled here, t=−1, df=8 both —
  the gold pins the Welch *formula components* (SE, df expression), which the
  signature fragments additionally lock in both languages)
- crit: floor(8.00)=8 → T_CRIT_05[8] = **2.3060**; |−1.0| ≤ 2.3060 → **reject_at_05 = 0**
- SMD = (50−55)/√((62.5+62.5)/2) = −5/√62.5 = −5/7.9056942 = −0.6324555 → **−0.63246** (5dp)
  — equals the pre-existing pin `EXPECTED.smdAge` exactly (cross-pin)
- imbalance_flag: |−0.632| > 0.1 → **1**
- (SAS-only doc, not asserted: p = 2·(1−probt(1, 8)) = 0.3466)

### 7.2 Age — Wilcoxon rank-sum, midranks + tie correction + CC (row `b_age`/`wilcoxon`)

Joint sort of all 10 ages with midranks:

| age | patients | raw ranks | midrank |
|---|---|---|---|
| 40 | P01(X) | 1 | 1.0 |
| 45 | P02(X), P06(Y) | 2,3 | 2.5 |
| 50 | P03(X), P07(Y) | 4,5 | 4.5 |
| 55 | P04(X), P08(Y) | 6,7 | 6.5 |
| 60 | P05(X), P09(Y) | 8,9 | 8.5 |
| 65 | P10(Y) | 10 | 10.0 |

- W (X rank sum) = 1.0 + 2.5 + 4.5 + 6.5 + 8.5 = **23.0**
  (check: Y = 2.5+4.5+6.5+8.5+10.0 = 32.0; 23+32 = 55 = 10·11/2 ✓)
- E[W] = 5·(10+1)/2 = **27.5**
- ties: four groups of size 2 → Σ(t³−t) = 4·(8−2) = **24**
- Var[W] = (5·5/12)·[(10+1) − 24/(10·9)] = 2.0833333·(11 − 0.2666667)
  = 2.0833333·10.7333333 = 22.3611111 → **22.3611** (4dp)
- √Var = 4.7287537
- W − E = −4.5; |−4.5| > 0.5 → z = (−4.5 + 0.5)/4.7287537 = −4.0/4.7287537
  = −0.8458889 → **−0.8459** (4dp)
- crit 1.9600; |−0.8459| ≤ 1.96 → **reject_at_05 = 0**
- SMD column repeats −0.63246 (per-variable value); imbalance_flag 1
- (SAS-only doc: p = 2·(1−probnorm(0.8459)) = 0.3976)

### 7.3 Sex — chi-square feeder + Fisher routing (rows `b_sex`)

Event = Male (`sex='1'`): X has P01,P03,P05 → x1 = **3** (p1 = 3/5 = **0.6000**);
Y has P06,P08,P10 → x0 = **3** (p0 = **0.6000**).

2×2: a=3, b=2, c=3, d=2; N=10; col totals M=6, F=4.

- expected cells: E(X,M)=5·6/10=3, E(X,F)=5·4/10=2, E(Y,M)=3, E(Y,F)=2 →
  **min_expected = 2.0000** < 5 → **fisher_exact selected** (R-B1a); chi row role
  `invalid_small_cells`
- chisq = 10·(3·2 − 2·3)²/(5·5·6·4) = 10·0/600 = **0.0000**, df 1, crit 3.8415,
  reject 0 (on the visibly-invalid feeder row)
- fisher row: statistic/df/crit/reject NULL; p SQL-side NULL
  (`p_method='sas_fisher_exact'`)
- SMD = (0.6−0.6)/√((0.6·0.4 + 0.6·0.4)/2) = 0/√0.24 = **0.00000**; imbalance_flag 0
- (SAS-only doc: hypergeometric two-sided p = 1.0000 — the observed table equals
  its expectation, so every table is "as or more extreme")

### 7.4 AE outcome comparison `c_ae` (rows `c_ae`)

Event = ≥1 `ae_dx` claim in day 1..365 (window excludes index): X → P02, P03 →
x1 = **2** (p1 = **0.4000**); Y → P07 → x0 = **1** (p0 = **0.2000**). Baseline
events (P01, P06) are pre-index and cannot enter the window.

2×2: a=2, b=3, c=1, d=4; col totals yes=3, no=7.

- expected: E(X,yes)=5·3/10=**1.5**, E(X,no)=3.5, E(Y,yes)=1.5, E(Y,no)=3.5 →
  **min_expected = 1.5000** < 5 → **fisher_exact selected**
- chisq = 10·(2·4 − 3·1)²/(5·5·3·7) = 10·25/525 = 0.4761905 → **0.4762**, df 1,
  crit 3.8415, reject 0 (feeder row, `invalid_small_cells`)
  (cross-check Σ(O−E)²/E: 0.25/1.5 + 0.25/3.5 + 0.25/1.5 + 0.25/3.5
  = 0.1666667+0.0714286+0.1666667+0.0714286 = 0.4761905 ✓)
- SMD = (0.4−0.2)/√((0.4·0.6 + 0.2·0.8)/2) = 0.2/√((0.24+0.16)/2) = 0.2/√0.2
  = 0.2/0.4472136 = 0.4472136 → **0.44721** (5dp); imbalance_flag NULL
  (comparison row); comp_role `primary`
- (SAS-only doc: hypergeometric table probs for x1∈{0..3} given rows 5/5, col 3:
  C(3,k)·C(7,5−k)/C(10,5) = 21/252, 105/252, 105/252, 21/252; observed x1=2 has
  p=0.41667; all tables have prob ≤ 0.41667 → two-sided p = 1.0000)

### 7.5 Gold assertions to register in `verify/run.ts`

```
row count: SELECT count(*) FROM tz_study_statengine                          = 6
arm QC:    engine_n (n1+nmiss1+n0+nmiss0 on any row)                         = 10

b_age / t_welch row:
  n1=5, n0=5, nmiss1=0, nmiss0=0
  stat1=50.0000, stat0=55.0000, sd1=7.9057, sd0=7.9057
  statistic=-1.0000 (tol .0001), df=8.00 (tol .01)
  crit_value_05=2.3060, reject_at_05=0
  smd=-0.63246 (tol .000005)  == EXPECTED.smdAge cross-pin
  imbalance_flag=1, test_role='selected', p_value IS NULL, p_method='sas_probt'

b_age / wilcoxon_rank_sum_normal_cc row:
  rank_sum_g1=23.0, e_rank_sum=27.5, var_rank_sum=22.3611 (tol .0001)
  statistic=-0.8459 (tol .0001), df IS NULL, crit_value_05=1.9600, reject_at_05=0
  test_role='supporting'

b_sex / chi_square row:
  x1=3, x0=3, stat1=0.6000, stat0=0.6000
  statistic=0.0000, df=1, min_expected=2.0000, reject_at_05=0
  test_role='invalid_small_cells', smd=0.00000, imbalance_flag=0

b_sex / fisher_exact row:
  test_role='selected', statistic IS NULL, reject_at_05 IS NULL,
  p_value IS NULL, p_method='sas_fisher_exact', min_expected=2.0000

c_ae / chi_square row:
  n1=5, n0=5, x1=2, x0=1, stat1=0.4000, stat0=0.2000
  statistic=0.4762 (tol .0001), df=1, min_expected=1.5000, reject_at_05=0
  test_role='invalid_small_cells', smd=0.44721 (tol .000005),
  imbalance_flag IS NULL, comp_role='primary'

c_ae / fisher_exact row:
  test_role='selected', statistic IS NULL, p_value IS NULL
```

A wrong Welch SE, a missed tie correction, a dropped continuity correction, an
n-weighted SMD denominator, an observed-cell (instead of expected-cell) Fisher
rule, or a swapped g1/g0 each flips at least one asserted number.

---

## 8. Fixture extension — spec-only, zero new data rows

**No new database rows.** All vectors derive from the frozen 12 patients. The
extension is confined to `GOLD_A_SPEC` (catalog entries + one appended analysis)
and `EXPECTED` (new keys only):

```ts
// GOLD_A_SPEC additions
outcomes: [{
  id: "o_ae", label: "AE (E11.9) within 365d", dataType: "binary",
  codeListId: "ae_dx",
  outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "any", diagnosisPosition: "any" },
  ascertainmentWindow: { start: 1, end: 365, includesIndex: false },
}],
groupVars: [{
  id: "g_arm", label: "Index drug arm",
  source: { kind: "exposure_cohort" },
  levels: ["DRUG_X", "DRUG_Y"], referenceLevel: "DRUG_Y",
}],
comparisons: [{
  id: "c_ae", dependentOutcomeId: "o_ae", independentVarId: "g_arm",
  design: "two_group_independent", adjusted: false, covariateIds: [], role: "primary",
  distributionPolicy: { normalityTest: "assume_normal", dispersionTest: "none",
                        varianceTest: "assume_unequal", allowNonparametricFallback: true },
  reportStat: "smd",
}],
analyses: [ ...existing three, then:
  { id: "a_stat", label: "Statistical comparisons (X vs Y)", kind: "statistical_engine",
    enabled: true, comparisonIds: ["c_ae"],
    smdBalance: { groupVarId: "g_arm", covariateIds: ["b_age", "b_sex"],
                  imbalanceThreshold: 0.1, reportWeighted: false },
    multiplicity: { method: "none", alpha: 0.05, appliesToRoles: ["primary", "secondary"] } },
],
```

Non-interference proof:

1. **No inserted rows** ⇒ every existing table the spine builds is byte-identical;
   every pinned gold number (attrition 12→11→10, prevalence, incidence Overall +
   all 6 strata, person-days, SMD pin) is computed from unchanged inputs.
2. **Spec additions don't perturb existing emissions.** `build01/02` iterate
   `codeLists` (unchanged); `build03/04/05/06` read `indexEvent/enrollment/
   criteria/baseline` (unchanged). The new analysis is appended LAST in
   `analyses[]`, so `moduleAnalyses` keeps incidence at index 0 → SQL `07_incidence`
   / SAS `080_incidence` keep their numbers and content; the engine lands as
   `08_statengine` / `090_statengine` — new files only.
3. **Validation stays green**: `o_ae`/`c_ae`/`g_arm` satisfy every
   `validateAnalyses` rule (code list exists, ≥2 levels, referenceLevel ∈ levels,
   ids resolve, alpha ∈ (0,1)); no criterion/readiness state changes.
4. **Parity harness auto-extends**: `sasSqlParityChecks` derives expected stamp
   count from the registry, so it moves 1→2 stamps by construction, not by edit.
5. `EXPECTED` gains only a new `statEngine` sub-object; no existing key is touched,
   and the new `smd` assertion *equals* the pre-existing `EXPECTED.smdAge` pin.

---

## 9. Output table schema

SQL `{wp}_statengine` / SAS `tz.&tag._090_statengine` — one row per
(variable × candidate test); `Overall`-style single stratum (stratified engine
runs are a later option; strata would add `stratifier/stratum` columns in the
incidence pattern). Review ORDER BY: `row_source, row_id, test_selected`.

| column | SQL type | SAS | meaning |
|---|---|---|---|
| analysis_id | VARCHAR | $40 | `an.id` |
| row_source | VARCHAR | $12 | `'comparison'` \| `'balance'` |
| row_id | VARCHAR | $40 | comparison id / baselineId |
| variable | VARCHAR | $40 | display label (stratLabel 40-char cap, both twins) |
| data_type | VARCHAR | $12 | `'continuous'` \| `'binary'` |
| group_1 / group_0 | VARCHAR | $40 | g1 / g0 level labels |
| comp_role | VARCHAR | $16 | Comparison.role; NULL/'' on balance rows |
| n1 / n0 | INT | num | non-missing group sizes |
| nmiss1 / nmiss0 | INT | num | missing covariate values per group |
| stat1 / stat0 | NUMERIC(4dp) | num | mean (continuous) / event proportion (binary) |
| sd1 / sd0 | NUMERIC(4dp) | num | SD (continuous); NULL for binary |
| x1 / x0 | INT | num | event counts (binary); NULL for continuous |
| test_selected | VARCHAR | $32 | `t_welch` \| `wilcoxon_rank_sum_normal_cc` \| `chi_square` \| `fisher_exact` — the method actually computed |
| test_role | VARCHAR | $32 | `selected` \| `supporting` \| `invalid_small_cells` \| `not_required` |
| selection_rule | VARCHAR | $200 | rule id + reason (the printed ledger) |
| statistic | NUMERIC(4dp) | num | t / z / chi²; NULL on fisher rows |
| df | NUMERIC(2dp) | num | Welch df / 1; NULL for z and fisher |
| crit_value_05 | NUMERIC | num | pinned two-sided α=0.05 bound; NULL on fisher rows |
| reject_at_05 | INT 0/1 | num | \|statistic\| > bound (χ²: upper tail), pre-rounding; NULL when statistic NULL |
| p_value | NUMERIC | num | **SQL: always NULL (no closed form).** SAS: probt/probnorm/probchi/PROC FREQ Fisher |
| p_method | VARCHAR | $24 | `sas_probt` \| `sas_probnorm` \| `sas_probchi` \| `sas_fisher_exact` (both twins carry the label) |
| smd | NUMERIC(5dp) | num | Austin average-of-variances SMD, g1−g0 |
| smd_method | VARCHAR | $16 | `austin_avg_var` |
| imbalance_flag | INT 0/1 | num | balance rows: \|smd\| > threshold; NULL on comparison rows / when smd NULL |
| min_expected | NUMERIC(4dp) | num | categorical rows: smallest expected cell |
| rank_sum_g1 / e_rank_sum | NUMERIC(1dp) | num | Wilcoxon diagnostics (wilcoxon rows only) |
| var_rank_sum | NUMERIC(4dp) | num | tie-corrected Var[W] |
| note | VARCHAR | $24 | `''` \| `empty_group` \| `zero_variance` \| `all_tied` |

Small-N / degenerate behavior (identical both sides — SQL NULL ≡ SAS `.`):
empty group → n=0, means/proportions/statistics NULL, note `empty_group`, flags
NULL (never a division error: every denominator is NULLIF/if-guarded); single
patient in a group → variance NULL (0 df) → t/df/SMD NULL; zero variance in both
groups → SMD & t NULL, note `zero_variance`; all values tied → Var[W]=0 → z NULL,
note `all_tied`; zero-margin 2×2 → chisq/SMD NULL, min_expected 0 → fisher
selected; empty `comparisonIds` + absent `smdBalance` → empty table + header
note. Flags guard the NULL/missing case explicitly in both languages (SQL `CASE
WHEN x IS NULL THEN NULL`; SAS `if x = . then flag = .` BEFORE any comparison —
`abs(.) > c` is silently FALSE in SAS, a documented trap).

---

## 10. Integration checklist — files to touch, in order

1. `src/emitters/parity.ts` — add `T_CRIT_05` pinned constant table (+
   `CHI2_CRIT_DF1 = 3.8415`, `Z_CRIT = 1.9600`, version tag `"tcrit_v1"`),
   `StatEngineParity`, `statengineParity()`, `statengineLimitations()`
   (shared-file touch, additive-only — same pattern as the incidence helpers).
2. `src/emitters/modules/statengine.ts` — NEW module: `sqlStatengine` (§3),
   `sasStatengine` (§4), `export const statengineModule: AnalysisModule<
   StatisticalEngineAnalysis> = { analysisKind: "statistical_engine",
   stampKind: "statengine", sql, sas }`.
3. `src/emitters/modules/registry.ts` — register
   `statistical_engine: statengineModule` (one line; parity harness auto-enrolls).
4. `src/verify/parity.ts` — add `SIGNATURES.statengine` (§5 fragments).
5. `src/verify/fixture.ts` — §8 spec additions (`outcomes`, `groupVars`,
   `comparisons`, appended `a_stat` analysis) + `EXPECTED.statEngine` (§7.5
   values; **new keys only**).
6. `src/verify/run.ts` — gold assertion block for `tz_study_statengine` (§7.5),
   incidence-style `eq`/`approx` + explicit IS NULL checks.
7. `npm run verify` — must show: all pre-existing golds byte-identical (07/080
   incidence untouched), 6 engine rows asserted, 2 parity stamp pairs equal,
   signatures present in both languages, invariants green.
