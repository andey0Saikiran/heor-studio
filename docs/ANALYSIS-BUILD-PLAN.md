# Build plan — all 69 analyses

_Produced 2026-07-27 by a 9-agent workflow: 6 family mappers over the 59 unbuilt
analyses, 1 sequencer, and 2 adversarial reviewers (a MarketScan methodologist and
a code-truth reviewer reading the actual repo). Both reviewers' corrections are
folded in below and marked **[CORRECTION]**._

**Status: 7 done, 3 partial, 59 to build.**

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
| KM life-table primitive | L | ~15 |
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
- **Every p-value and exact interval is permanently outside execution verification.**
  No SAS runs in CI and PGlite has no inverse CDF. They are SAS-primary, labeled, and
  covered by presence/absence tests — never by a number the harness checked.
- **Fitted coefficients are unverifiable except at a saturated design.** Logistic,
  Poisson, NB, gamma-log, Cox all need IRLS/Newton. The saturated anchor (a 2×2 whose
  MLE equals the closed-form odds ratio) is the only real check available.
- **Bootstrap CIs need an RNG and break byte-stable emission outright.**
- **Greedy / nearest-neighbour PS matching is order-dependent** and cannot be
  byte-stable. Ship deterministic frequency matching or imported match sets.
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
