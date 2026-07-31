# Roadmap — what is built, what is not, and what will never be

This file exists so nobody has to read the source to find out what is missing.
It is honest rather than flattering: the project is paused at a useful point,
not finished.

**22 of the 69 analyses in the original build plan are implemented.** That 69 was
a planning number, not a specification, and the remainder is not uniform — a
meaningful slice of it is *refused by design* rather than pending.

---

## Built and verified

Every module below ships SAS and SQL twins, hand-derived gold truth executed
against a synthetic MarketScan fixture, and mutation coverage.

| family | modules |
|---|---|
| Descriptive epi | incidence rate, point prevalence, period prevalence, cumulative incidence, direct standardization, calendar trend |
| Cohort | attrition/CONSORT, Table 1, SMD balance, Charlson comorbidity index |
| Economics | claim-line ledger, resource use, cost |
| Regression | one GLM emitter × 5 families (logistic, Poisson, negative binomial, gamma-log, OLS) |
| Survival | Kaplan-Meier + log-rank, Cox, competing-risks CIF, Fine-Gray |
| Causal | propensity scores (IPTW), IPTW outcome model, g-formula + AIPW |

Supporting: small-cell suppression (derivation-aware), results contract,
provenance, MCP server, five gold fixtures (A–E) each built to exercise something
the others structurally cannot.

---

## Not built — the gaps that matter

Ordered by how likely a real study is to need them.

### 1. Treatment patterns and adherence — the largest gap

PDC/MPR, persistence, discontinuation, treatment switching, line-of-therapy.
Routine in HEOR work.

**PARTLY BUILT, blocked on ONE spine addition.** Landed and reviewable:

- `emitters/interval-core.ts` — the interval algebra: merge into islands (via the
  running maximum of prior ends, not LAG — the same trap the enrollment
  stitching defect fell into), clip to window, first-gap detection, and
  **stockpiling in closed form**. Stockpiling's definition is sequential
  (`cursor_k = max(s_k, cursor_{k-1}) + supply_k`) but unrolls to a running MAX
  plus a running SUM, so it is two window functions rather than a loop —
  verified against the sequential definition on ragged supplies, same-day double
  fills and real gaps.
- `emitters/modules/adherence.ts` — PDC, MPR, stockpiled PDC, persistence and
  discontinuation, both twins.
- `verify/fixture-f.ts` — Gold Case F, hand-derived: coverage 180/130/120/30 over
  a 180-day window; PDC 1, 13/18, 2/3, 1/6 against MPR 1, 1, 2/3, 1/6.

**THE BLOCKER.** The module needs a per-fill feeder carrying `days_supply`, and
the cohort spine does not produce one: `tz_study_events` keeps drug claims but
drops `daysupp`, and `tz_study_index` keeps only the *first* dispensing. Adding a
`<prefix>_fills` table to the spine (all dispensings of a drug code list, with
days supply) unblocks adherence, persistence, switching AND line-of-therapy at
once.

That change touches `emitters/sql.ts` and `emitters/sas.ts`, which feed all 22
shipped modules, so it wants a session with room to verify rather than the tail
of one. The module is therefore **not registered** — registering it before the
feeder exists would let readiness approve an analysis the emitters cannot
produce, which is precisely the silent-drop failure this project spent Wave 0
eliminating.

Line-of-therapy carries a caveat worth stating up front: it is **definitional**,
so execution can only ever prove that the twins implement the same rule — never
that the rule matches a given protocol.

### 2. The rest of the causal family

- matched-cohort designs (deterministic frequency matching, or imported match sets)
- propensity-score stratification — closed form and deterministic, simply unbuilt
- difference-in-differences, instrumental variables
- negative-control outcomes, E-values

### 3. Long tail

Additional descriptive variants, subgroup and sensitivity machinery, and the
multiplicity-governance layer (which needs real p-values to adjust, and those are
SAS-primary).

---

## Refused by design

These are not pending. Each is refused in readiness, before code is generated,
with the reason attached to the refusal.

| refused | why |
|---|---|
| **Overall survival** | MarketScan's only native death signal is `DSTATUS` — in-hospital only, masked from data year 2016. A curve built on it silently becomes "time to in-hospital death before 2016, with every other death censored," and censoring by death is exactly the informative censoring KM and Cox assume away. |
| **Greedy nearest-neighbour matching** | Order-dependent. The match a treated subject gets depends on how many controls earlier subjects consumed, so the same data in a different row order gives a different estimate. Byte-stable emission cannot fix a property of the algorithm. |
| **Optimal matching** | An assignment problem — needs the Hungarian algorithm or min-cost flow, neither expressible in warehouse SQL, and its ties need a rule the method does not specify. |
| **Bootstrap confidence intervals** | Need an RNG, which breaks byte-stable emission outright. |
| **Gray's test** | Closed form, but a *different and more intricate statistic* than the log-rank. A close-enough version would be a mislabeled test rather than a rounding error. |
| **Quantile parity** | `PROC UNIVARIATE` PCTLDEF and SQL `PERCENTILE_CONT` are different estimators, and no SAS runs in CI to arbitrate. |
| **Runtime data-dependent test routing** | A SAS `%IF` on a Shapiro-Wilk p-value has no SQL counterpart; the twins would silently disagree about which test ran. |
| **Continuous covariates in the causal family** | The propensity score is closed form *only* because a logistic model over categorical cells is saturated. One continuous covariate and the score stops being the MLE — every weight downstream would be a wrong number rather than a missing one. |

### Corrected refusals

Two entries were refused and later found to be wrong, and are recorded here
because the reasoning matters more than the verdict:

- **Negative binomial** was refused twice on the grounds that a dispersion
  parameter has no closed form and therefore no anchor. The anchor holds for the
  *point estimate*; only the standard errors are unverifiable.
- **Fine-Gray** was filed beside Gray's test as "needs Newton, plus the same
  reason." It is not a different statistic — it is a Cox model over a different
  risk set, and takes exactly the Cox carve-out.

The rule those two produced: **"needs Newton" is never on its own a reason to
refuse a model. It is a reason to carve out the coefficient and execute
everything around it.**

---

## Permanent limits

Not refusals, but boundaries no amount of work moves:

- **No SAS runs in CI.** The SAS twin is parity-checked against the SQL twin's
  emitted text, never executed. Every p-value and exact interval is therefore
  outside execution verification permanently.
- **Snowflake has never executed anywhere.** That dialect is fingerprint-checked
  only.
- **Set A vs Set B licensing is unverifiable by any fixture** — the probe can be
  shown to fire, not to match a vendor's actual delivery.
