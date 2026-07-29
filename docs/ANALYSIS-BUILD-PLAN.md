# Build plan — all 69 analyses

_Produced 2026-07-27 by a 9-agent workflow: 6 family mappers over the 59 unbuilt
analyses, 1 sequencer, and 2 adversarial reviewers (a MarketScan methodologist and
a code-truth reviewer reading the actual repo). Both reviewers' corrections are
folded in below and marked **[CORRECTION]**._

**Status: 22 done, 4 partial (updated 2026-07-28 — see docs/STATUS.md).**

---

## The shape of the problem

The 59 remaining analyses are not 59 independent builds. They are a thin layer of
per-analysis logic sitting on about a dozen shared substrates that do not exist yet.
Ranked by how many analyses each unlocks:

| Substrate | Size | Unlocks |
|---|---|---|
| SAS-primary contract (asymmetric twin columns) | M | ~40 |
| Multi-fixture harness parameterization | S | ~45 |
| Suppression-shape families (statistic / currency / continuous) | S | ~45 |
| Shared observation-window object | M | ~25 |
| Outcome & covariate ascertainment layer | L | ~22 |
| Closed-form distribution constants (Φ, z, χ², t) | S | ~18 |
| Claim-line ledger spine | XL | ~16 |
| KM life-table primitive | L | ~15 | **DONE** — `emitters/km-core.ts` |
| Continuous-summary result shape | M | ~14 |
| Regression family table + ONE GLM emitter | M | ~10 |
| Interval-algebra kit (merge / clip / gap) | L | ~8 |
| rate-core (shared person-time engine) | M | ~8 |

**One emitter, many rows.** The ten regression analyses are one GLM emitter plus a
family table and two wrappers — not ten modules. The same collapse applies across
survival and cost.

---

## The collision that has to be resolved first

Two project constraints are in direct conflict for ~40 of the 59:

1. Both twins compute **identical numbers**.
2. SQL has **no statistical CDFs** — no p-values, no exact intervals, no fitted coefficients.

There is currently no shape in the architecture for a column that is legitimately
absent from one twin. Until there is, no p-value, exact CI, Fay-Feuer interval,
log-rank statistic or regression coefficient can be built honestly.

**The SAS-primary contract** resolves it: a declared set of columns that are NULL in
SQL with a method label naming the source, computed in SAS, excluded from the numeric
fingerprint comparison, and **required** present in the SAS text and **required** NULL
in the executed SQL — with mutation tests that go red if the SAS statistic is deleted
or the SQL column is populated with a guess.

> **[CORRECTION — code-truth review]** The plan proposed carrying `sasPrimary[]` in the
> PARITY stamp. That would recreate the exact tautology Wave 2 removed: the stamp is
> built by the same builder from the same spec object in both languages, so it cannot
> fail. The carve-out must live in the **fingerprint** and the **SAS lint**, which can.

> **[CORRECTION — code-truth review]** `verify/fingerprint.ts` has **no `default` case**:
> an unregistered kind silently returns almost nothing. This is real and already
> observed — `smd_balance` scraped **1 value** until keys were added by hand. Fix with a
> third load-time throw in `modules/registry.ts` requiring a fingerprint pattern set
> and a constant profile per module, in the style of the two throws already there.

> **[CORRECTION — code-truth review]** Do **not** introduce `z = 1.959964` alongside the
> repo's pinned `1.96` / `1.9208` / `3.8416` / `0.9604`. Two different 95% z values in
> one bundle is a defect. Keep `z = 1.96` repo-wide and document `3.8416` as z² at that z.

---

## Waves

Nothing in a wave depends on a later wave.

| Wave | Goal | Delivers |
|---|---|---|
| **0** | Contracts, constants, mechanisms — **no new numbers** | 0 |
| **1** | rate-core extraction, shared observation window, first completions | 4 |
| **2** | Gold Case B; close descriptive + test-selection tier | 5 |
| **3** | Claim-line ledger → the economic tier | 8 |
| **4** | Treatment patterns and adherence (+ KM primitive) | 8 |
| **5** | ONE GLM emitter → the whole regression family | 10 |
| **6** | Survival / time-to-event (+ the mortality refusal) | 14 |
| **7** | Comparative / causal (propensity-score family) | 13 |

Wave 0 is the only wave buildable while Gold Case A is the single fixture — it moves
no pinned number, which is precisely why it goes first.

**Fixtures are additive but never appended.** Gold Case A is frozen: any new patient
with an index drug claim moves attrition 12→11→10, the at-risk 8, the 2425
person-days and every rate, prevalence and SMD simultaneously. New cases (B, C, D…)
are **separate seeds**, each hand-derived patient by patient the way A was.

> **[CORRECTION — methodologist]** Move the **Charlson/Elixhauser comorbidity index**
> into Wave 2, not "later". No wave built it, yet it is simultaneously a Table 1 row,
> an SMD covariate and a regression adjustment — it blocks three families at once.

> **[CORRECTION — methodologist]** Add `meta.dataCutDate` / claims run-out to the
> observation window's `LEAST()` in Wave 1. Without it, an immature delivery reads the
> entire tail cohort as disenrolled.

> **[CORRECTION — methodologist]** Split the NUAC exposure spine out of Wave 7 and land
> it early: Wave 2's two-group comparison and Wave 5's regressions are almost always
> new-user active-comparator contrasts in real MarketScan work.

> **[CORRECTION — code-truth]** Multiplicity governance cannot be a Wave 1 *executed*
> deliverable — under the SAS-primary contract the SQL p-value columns are NULL, so
> there is nothing to adjust. It belongs with the wave that first produces real p-values.

---

## What will NOT be built, and why

Stated up front so no one has to discover it later.

- **Overall survival is REFUSED, not approximated.** MarketScan's only native death
  signal is `DSTATUS` on I/S/F, it captures in-hospital death only, and it is masked
  from data year 2016. The gate ships *before* any survival module, so the tool cannot
  be asked for OS while OS is unbuildable.
  **DONE (`1218719`, before the module in `749ec54`).** `SurvivalAnalysis.endpoint` is
  a discriminated union, so the refusal keys on a type rather than on wording; four
  guards in `verify/guards.ts` assert both halves — the death endpoint is refused,
  and the claims-event twin of the same spec stays ready.
- **Every p-value and exact interval is permanently outside execution verification.**
  No SAS runs in CI and PGlite has no inverse CDF. They are SAS-primary, labeled, and
  covered by presence/absence tests — never by a number the harness checked.
- **Fitted coefficients are unverifiable except at a saturated design.** Logistic,
  Poisson, NB, gamma-log, Cox all need IRLS/Newton. The saturated anchor (a 2×2 whose
  MLE equals the closed-form odds ratio) is the only real check available.
  **[CORRECTED — Wave 6.2]** Cox has a saturated analogue this plan missed. When every
  risk set carries the same exposed share *p*, the partial likelihood collapses to a
  binomial and its maximum is closed form: HR = [q/(1−q)] / [p/(1−p)], with *q* the
  exposed share of events. It almost never applies on real data — and says NOT
  APPLICABLE when it does not — but it makes the Cox coefficient checkable against
  something other than itself, and Gold Case C is built to satisfy it. Separately,
  `U(beta_hat) = 0` is closed form for a binary exposure and holds on ANY data, so
  the emitted SAS checks the fitted coefficient against its own defining equation
  regardless. See `emitters/cox-core.ts`.
- **Bootstrap CIs need an RNG and break byte-stable emission outright.**
- **Greedy / nearest-neighbour PS matching is order-dependent** and cannot be
  byte-stable. Ship deterministic frequency matching or imported match sets.
  **[ACTIONED — Wave 7.0]** Both matching methods are now refused in readiness
  with their reasons, and IPTW shipped instead (`228b417`). The plan assumed the
  SCORE would also be out of reach; it is not, provided the model is saturated
  over categorical cells, in which case the fitted probability is the cell
  fraction and the whole pipeline executes. A continuous covariate is refused
  rather than silently downgraded.
- **Runtime data-dependent test routing must be refused by design.** A SAS `%IF` on a
  Shapiro-Wilk p has no SQL counterpart; the twins would silently disagree about which
  test ran.
- **Line-of-therapy is definitional**, so execution proves only that the twins
  implement the same rule — never that the rule matches a given protocol.
- **Set A vs Set B licensing is unverifiable by any fixture**; the probe can be shown
  to fire, not to match the vendor's actual delivery.
- **Quantile parity is not executable** — `PROC UNIVARIATE` PCTLDEF and SQL
  `PERCENTILE_CONT` are different estimators and SAS never runs.
- **Snowflake has never executed anywhere.** This plan adds substantial dialect surface
  (LISTAGG, PERCENTILE_CONT, recursive CTEs, calendar generators) to that half, which
  is fingerprint-checked but not run.
- **Gray's test is REFUSED, not approximated.** The competing-risks analogue of
  the log-rank compares subdistribution hazards, and its weights depend on the
  cumulative incidence at each event time. It is closed form — this is not a
  "SQL cannot" refusal — but it is a different and more intricate statistic than
  the log-rank, and a close-enough version of it would be a mislabeled test
  rather than a rounding error.
  **[CORRECTED — Wave 6.4]** The sentence that followed this one refused
  Fine-Gray "for the same reason plus the usual one: it needs Newton", and that
  was wrong. Fine-Gray is not a different statistic — it is a Cox model over a
  different risk set, so it takes exactly the Cox carve-out: beta is SAS-primary,
  everything around it is closed form. It shipped in Wave 6.4 (`30b3105`). The
  right reading is that "needs Newton" is never on its own a reason to refuse a
  model here; it is a reason to carve out the coefficient.
- **Numbers in `docs/blueprints/p1/` must not be pinned as-is** — that README states
  the adversarial-verification pass never ran (the workflow hit a spend limit).

---

## Already actioned from this plan

- **`studyPeriod` truncation defect** (`a4da47b`) — found by the methodologist review,
  reproduced by execution, fixed. The event pull was bounded to `meta.studyPeriod`, so a
  spec reading "study period" as the identification window lost its entire washout:
  at-risk 10 instead of 8, excluded-as-prevalent 0 instead of 2, reported as success.
  The pull window is now derived from what the spec asks for and only ever widens.
- **Prevalent-case washout row closed** (`0b862f7`, `b824f8e`) — toggle test, zero-check
  and attrition addendum.

---

## Next up: the Poisson family (designed, hand-derived, NOT built)

The GLM emitter (`1e4c015`) built `logistic`. `poisson` is the next slot and the
groundwork is done — this section exists so it can be picked up without
re-deriving anything.

**Why it is the next one.** The saturated anchor holds for Poisson too. A model
`log E[Y] = b0 + b1·exposed + log(PT)` with one binary predictor and an offset is
saturated for the two-cell (events, person-time) table, so its MLE is EXACTLY
`ln(rate ratio)` — the same self-check the logistic path already emits, with no
new verification machinery.

**The feeder it needs** is per-subject person-time. That is now unblocked:
`rate-core.censorPlan()` + `renderCensorSql` / `renderCensorSas` (added in
`3cdda71`) decide censoring once and render it per language, so the regression
module can build person-time that provably agrees with the incidence module's
rather than re-deriving it. `RegressionAnalysis` needs a `personTimeRule`,
required when the family is `poisson` or `negative_binomial`.

**Hand-derived Gold Case A truth** (person-time from the incidence module's
pinned `personDaysByArm`, so the two must agree by construction):

| | DRUG_Y (exposed) | DRUG_X (reference) |
|---|---|---|
| subjects | 4 | 4 |
| events | 1 | 2 |
| person-days | 1395 | 1030 |
| rate / 1000 PY | 261.82796 | 709.22330 |

    RR      = (1/1395) / (2/1030) = 1030/2790 = 103/279 = 0.36918
    ln(RR)  = -0.99648
    SE      = sqrt(1/1 + 1/2) = sqrt(1.5) = 1.22474
    95% CI  = exp(-0.99648 +/- 1.96*1.22474) = (0.03347, 4.07152)
    rate difference = 261.82796 - 709.22330 = -447.39534 per 1000 PY

Note `1395 + 1030 = 2425`, the person-time every rate module already pins — so a
Poisson feeder that disagrees with the incidence module fails immediately.

**Row shape** (the logistic path emits 4 design + 3 crude + N adjusted; Poisson
differs because the design carries person-time):

- `design`: n, events, person_days, rate_per_1000py per arm — 8 rows
- `crude`: rate_ratio (with CI and SE), rate_difference — 2 rows
- `adjusted`: exposure + covariates, NULL in SQL, `sas_proc_genmod` — N rows

**SAS side**: `PROC GENMOD` with `dist=poisson link=log offset=log_pt`, plus the
same anchor step the logistic path uses (unadjusted model, closed form
recomputed from its own data, PASS/FAIL printed).

**Still refused after this**: `negative_binomial` (a dispersion parameter with no
closed form and therefore no anchor), `gamma_log` (needs the ledger's
per-subject totals as the response), `ols` (needs a continuous response).

> **SUPERSEDED.** All five families shipped (Waves 3.1–3.4). The negative-binomial
> refusal above was wrong on its own terms and is corrected in `docs/STATUS.md`:
> at saturation the NB MLE equals the Poisson MLE equals ln(rate ratio), so the
> anchor holds for the point estimate — dispersion affects the standard errors
> only. The real blocker was the fixture, and Gold Case B removed it.

---

## Wave 6 landed: survival

The KM primitive and the survival module shipped (`749ec54`). Two things the plan
did not anticipate, both recorded in `docs/STATUS.md`:

1. **Survival has the SMALLEST SAS-primary carve-out of any family**, not a large
   one. The plan grouped "log-rank statistic" with regression coefficients as
   permanently unverifiable. That was wrong: the log-rank STATISTIC is closed form
   and executes in both twins. Only its tail probability needs a CDF — and even the
   α = 0.05 DECISION does not, because for 1 df the critical value is the z² this
   repo already pins.
2. **A per-event-time life table cannot survive small-cell suppression**, because
   nearly every row is one patient's event date. That is the correct outcome rather
   than a defect, and it makes S(t) at fixed horizons the releasable form of a
   curve. The life table now sits behind an explicit opt-in.

**Cox landed** in Wave 6.2 (`fc65694`), and the guess above was half right: the
log-rank statistic IS the Cox score test at β = 0, and that identity is now
asserted across the two modules. The other half was wrong — see the corrected
bullet under "What will NOT be built": Cox does have an anchor.

**Competing-risks CIF landed** in Wave 6.3 (`b9123fa`), with Gold Case D. It is
the first family in this bundle with nothing deferred to SAS.

**Fine-Gray landed** in Wave 6.4 (`30b3105`), with Gold Case E. Its verification
rests on a REDUCTION rather than on a reference value: with no competing events
the subdistribution model is Cox identically, so the harness asserts the two
modules produce the same numbers on Gold Case A. Gold Case E exists because
neither A nor D has censoring before the last event of interest, so on both of
them every IPCW weight is exactly 1 and the weight expression could be deleted
without moving a number.

**Still unbuilt in this family**: the
Brookmeyer-Crowley interval on the median (derivable from the band already
computed, simply not built — and the emitted program says so rather than shipping
a median with an invented interval), and a proportional-hazards TEST. The last
one is the most consequential gap: PH is currently assumed, stated as assumed,
and not checked. The Schoenfeld residual at each event time is closed form given
β̂, so a site with SAS can get it; what this project cannot yet do is compute it
in the SQL twin, because β̂ only exists on the SAS side.

**A fixture gap now closed**: Gold Case C (tied event times) makes the KM (n−d)/n
factor, the log-rank tie correction, and the Breslow-vs-log-rank variance gap
executable. Before it, all three were fingerprint-only.
