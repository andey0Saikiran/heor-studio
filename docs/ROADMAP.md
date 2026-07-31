# Roadmap — what is built, what is not, and what will never be

This file exists so nobody has to read the source to find out what is missing.
It is honest rather than flattering: the project is paused at a useful point,
not finished.

**24 of the 69 analyses in the original build plan are implemented.** That 69 was
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
| Treatment patterns | adherence (PDC / MPR / stockpiled PDC), persistence and discontinuation, treatment switching vs add-on, line of therapy |

Supporting: small-cell suppression (derivation-aware), results contract,
provenance, MCP server, seven gold fixtures (A-G) each built to exercise something
the others structurally cannot, and a byte-identity snapshot gate on spine changes.

**Spec chat.** Plain-language instructions revise the SPECIFICATION, never the
generated code. The distinction is not stylistic: generated SAS and SQL are a
pure function of the reviewed spec, and every verification guarantee here stands
on that (PARITY stamps compare two twins derived from one spec; fingerprints
scrape values out of emitted text and check them against the spec's parameters;
mutation tests prove corrupting the emitted code turns the suite red). A chat
that edited generated code would break all three at once.

A proposal passes three gates before a human sees it: the structural check that
every emitter's assumptions depend on, a sanitizer, and an itemized diff.

The sanitizer exists because **a model may never mark its own work reviewed**.
`reviewed` on a criterion and `verified` on a code are what code generation is
gated on, and the AI disclosure in every bundle reports them as evidence of
human oversight, so a model emitting them is a forged signature rather than a
shortcut. Anything the model changed comes back with those flags false;
anything it left alone keeps exactly the flag the analyst gave it. That second
clause is a safety property too: a sanitizer that reset everything would be
trivially safe and unusable, and an unusable control is one people route around.
Both halves are held by 21 adversarial guards in `verify/chat.ts`.

A chat-edited spec also stops being provenance `manual`, so the exported AI
disclosure cannot claim no model was involved.

---

## Not built — the gaps that matter

Ordered by how likely a real study is to need them.

### 1. Treatment patterns: BUILT

**Adherence and persistence now ship**, both twins, executed against Gold Case F.
PDC, MPR, stockpiled PDC, persistence and discontinuation, with the measures
deliberately reported in pairs whose difference is the finding.

The blocker that held this back was a missing per-fill feeder. It is built:
`<prefix>_fills`, one row per dispensing with days supply, emitted inside
`02_events.sql` and **only when an enabled analysis needs it**, so every spec
that does not ask for fills emits byte-identical code to before it existed
(`verify/snapshot.ts` gates exactly that, over 1398 files).

Three things worth knowing about how it was built:

- It cannot be a projection of `<prefix>_events`. That table never selects
  DAYSUPP, and its trailing `SELECT DISTINCT` collapses two same-day dispensings
  of one NDC into one row. Correct for a diagnosis ledger, wrong for fills.
- The NDC lookup is one row per `(code_list_id, pattern, ndcnum)`, so an NDC
  caught by two name patterns of the same list appears twice. In the events
  table the trailing DISTINCT absorbed it; a fills table has none, so the join
  goes through a deduplicated `(code_list_id, ndcnum)` map. Left alone it would
  have inflated MPR and the stockpile cursor while leaving PDC flat, which is
  the exact shape of a genuine early-refilling finding.
- The SAS twin was reading a `020_rx` table **no emitter creates anywhere** and
  would have failed on its first statement. The spine already pulls DAYSUPP per
  drug code list, so the fix was to resolve the right table, and a mutation test
  now reproduces the phantom so the harness is what would catch it next time.

Dirty DAYSUPP is handled explicitly rather than by accident. Missing, zero,
negative and implausibly large values each get a stated rule, and every drop is
COUNTED in a fill-attrition block. Uncleaned, a NULL supply produces a NULL
interval end, fails the window predicate and vanishes; a negative supply
subtracts from the MPR numerator and can push MPR below PDC, at which point the
program's own identity row reports "the interval merge is broken" about a merge
that is fine, sending the analyst to debug correct code.

**Switching and line of therapy also ship**, on the same feeder, executed
against Gold Case G (two drugs, five patients).

The module refuses to answer "how many switched?" with a single number, because
that number is not in the data. A patient dispensed a second drug either stopped
the first or kept taking it, and claims record dispensings rather than intent.
The only available signal is how much of the index supply was unconsumed when
the new drug began, so the module reports the **full band**: the switch count
under a zero-overlap rule, under an unbounded one, and under the threshold the
study declares. On Gold Case G that band is 2 to 4 switches on a cohort of five.
**Two of five patients are classified by the rule rather than by the data**, and
a switch rate quoted without its rule is one arbitrary point inside that band.

**Line of therapy is DEFINITIONAL, and that is different in kind** from
everything else here. Every other number can be checked against arithmetic: a
PDC either counts the right days or it does not. A line number cannot be.
Protocols advance a line on a switch, on an add-on, after a gap, only within a
drug class, or on clinical intent claims never record, and the same patient
carries a different number under each. Execution proves the twins implement the
SAME rule; it can never prove the rule is yours. The emitted row therefore
carries **no estimate at all** in the definitional slot, and says why, in both
languages, beside the number.

**Still open here:** switching back and drug cycling (only the FIRST switch is
characterized), third and later lines, drug-class logic, and any
characterization of the combination period for add-on patients.

Also not yet covered by any fixture: ragged supply lengths and same-day double
fills. The stockpiling closed form is unverified on those two shapes.

### 2. The rest of the causal family

- matched-cohort designs (deterministic frequency matching, or imported match sets)
- **propensity-score stratification** — still unbuilt, but the algebra and the
  trap in it are now written down in `emitters/psstrat-core.ts`. Worth reading
  before reaching for stratification anywhere: **the conventional NTILE-into-
  quintiles recipe does not work on a saturated score.** The score is constant
  within a covariate cell, so NTILE cuts through tied groups and which subjects
  land on each side depends on row order. That is the same order-dependence that
  got greedy matching refused. Boundaries have to fall BETWEEN distinct score
  values, which has a consequence worth reporting rather than hiding: **K strata
  cannot always be formed.** With four cells and K=5 there are at most four, and
  a program printing "quintiles" would be describing something it did not build.
  The file is deliberately NOT registered and NOT verified, and says so at the
  top: nothing has executed it against hand-derived truth, no fingerprint
  scrapes it, and no mutation proves the harness would notice it going wrong.
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
