# HEOR Studio

**Turn a study protocol into SAS and SQL that a reviewer can check, and that a
machine has already checked.**

Health-economics and outcomes research on claims data (MarketScan) runs on
analyst-written SAS. It is slow to write, hard to review, and its correctness
rests on whoever wrote it. HEOR Studio generates it instead, in two steps that
keep a human in the loop:

1. An LLM reads the protocol and produces a **reviewable study spec**: JSON
   describing cohort, exposures, outcomes, windows, analyses. It never writes code.
2. **Deterministic emitters** turn that spec into SAS and SQL twins that compute
   the same numbers.

The interesting part is not a step. It is a standing gate.

---

## The claim, and how it is checked

Every number this project emits is verified by executing the **actual generated
SQL** against a synthetic fixture with hand-derived ground truth. Not a
re-implementation of the logic; the emitted text itself, run in real Postgres 16
(PGlite/wasm).

```
$ npm run verify
1995 checks passing, 0 failing
```

Five mechanisms, each covering a gap the others cannot:

| mechanism | what it catches |
|---|---|
| **Execution** against hand-derived fixtures | wrong numbers |
| **Fingerprints** scraped from each twin's own text | SAS and SQL drifting apart, where no execution is possible |
| **Mutation testing**: corrupt the output on purpose, assert the harness goes red | checks that pass for the wrong reason |
| **PARITY stamps** | a twin silently dropping a spec parameter it claimed to consume |
| **Readiness gates** | analyses that cannot be computed honestly, refused *before* code is generated |
| **Byte-identity snapshot** over 1737 emitted files | a change to the shared spine quietly moving a number in a module nobody touched |

Ground truth is derived by hand as exact fractions *before* anything is executed:
incidence of 3 cases over 2425 person-days with a Byar CI of (90.82, 1320.24); a
Cox score of −31/42 against an information of 1265/1764; an IPTW risk difference
of −37/84. Where an executed value and the derivation disagreed, both were
recomputed independently rather than assuming the code was right.

### What is deliberately *not* computed

Warehouse SQL has no statistical CDFs. Rather than approximate, the project
declares a **SAS-primary contract**: those columns are NULL in SQL beside a label
naming the procedure that produces them, computed in SAS, and covered by
presence/absence tests. Never by a number nobody checked.

Some things are refused outright, in readiness, with the reason attached:

- **Overall survival.** MarketScan's only native death signal is `DSTATUS`,
  which is in-hospital only and masked from data year 2016. A curve built on it
  would silently become "time to in-hospital death before 2016, with every other
  death censored."
- **Greedy nearest-neighbor PS matching.** Order-dependent: the same data in a
  different row order produces a different matched set and a different estimate.
  Byte-stable emission cannot rescue that.
- **Bootstrap intervals** (need an RNG, break reproducible emission), **Gray's
  test**, and **quantile parity between `PROC UNIVARIATE` and SQL**, each named
  with its reason in [`docs/ANALYSIS-BUILD-PLAN.md`](docs/ANALYSIS-BUILD-PLAN.md).

A refusal that explains itself is more useful than a number nobody can defend.

---

## What is built

**22 analysis modules**, each with SAS and SQL twins, hand-derived gold truth and
mutation coverage:

- **Descriptive epidemiology**: incidence rate (person-time, Byar CI), point and
  period prevalence, cumulative incidence (Wilson), direct standardization,
  calendar trend (Cochran–Armitage)
- **Cohort**: attrition/CONSORT, Table 1, SMD balance, Charlson comorbidity index
- **Economics**: a claim-line ledger spine that handles the classic MarketScan
  inpatient double-count, resource use, cost
- **Regression**: one GLM emitter across five families: logistic, Poisson,
  negative binomial, gamma-log, OLS
- **Survival**: Kaplan-Meier with Greenwood and log-rank, Cox proportional
  hazards, competing-risks CIF (Aalen-Johansen), Fine-Gray subdistribution
- **Causal**: propensity scores (IPTW), weighted outcome models (Hájek estimator
  with a sandwich variance), the g-formula and AIPW

Plus derivation-aware small-cell suppression, a tidy long-format results contract,
provenance stamping, and an MCP server exposing the whole thing to Claude and
other MCP hosts.

**Not built**: see [`docs/ROADMAP.md`](docs/ROADMAP.md). The largest gap is
treatment patterns and adherence (PDC/MPR, persistence, switching,
line-of-therapy), which is a routine HEOR ask. Matched-cohort designs, PS
stratification, difference-in-differences and instrumental variables are also
unbuilt.

---

## Fitted models, and the anchors that check them

Maximum-likelihood coefficients need Newton-Raphson, which warehouse SQL cannot
run, so they are SAS-primary. But "needs Newton" turned out never to be a reason
to refuse a *model*, only to carve out the *coefficient*. Everything around it is
usually closed form, and several exact anchors let the generated SAS check itself
against arithmetic, on the site's own data, with no reference value shipped
alongside:

- **The saturated 2×2.** A logistic model whose only predictor is a two-level
  exposure is saturated, so its MLE *is* the closed-form log odds ratio. The same
  argument extends to Poisson, negative binomial, gamma-log and OLS.
- **Cox's constant-proportion anchor.** When every risk set carries the same
  exposed share *p*, the partial likelihood collapses to a binomial with a closed
  maximum: HR = [q/(1−q)] / [p/(1−p)]. Rare on real data (the program reports NOT
  APPLICABLE rather than pretending), but it makes the Cox coefficient checkable
  against something other than itself.
- **U(β̂) = 0.** For a binary exposure the score at any β is closed form in the
  risk-set counts, so the emitted SAS verifies that its fitted coefficient
  satisfies the equation that *defines* it. This one holds on any data.
- **AIPW ≡ the g-formula.** With the score and the outcome model both saturated
  over the same cells, the augmentation term cancels the weighting exactly. Two
  entirely different expressions, one over cells and one over subjects, check
  each other.

---

## Quick start

```bash
npm install
npm run verify
```

`npm run verify` is the full gate (execution, fingerprints, mutations, readiness
guards) and needs no database: it runs Postgres in wasm. Node 22.12+.

```bash
npm run dev
```

starts the spec-review UI. Extracting a spec from a protocol needs an Anthropic
API key; the emitters themselves are deterministic and offline.

## License

Split. `packages/core` and `packages/web` are **AGPL-3.0-only**, so improvements
to the emitters stay available to the analysts who depend on them, including when
the software is offered over a network. `packages/mcp` is **Apache-2.0** so hosts
can integrate without taking on copyleft obligations for their own code. See
[LICENSE](LICENSE).

## Status

Working and useful; actively paused. [`docs/STATUS.md`](docs/STATUS.md) is a
running engineering log, and the entries worth reading are the ones where the
harness caught defects in *itself*: a coverage guard that had been passing
vacuously for three shipped modules, a positivity claim that was false in one
direction, and thirteen mutation tests that were weaker than they looked.
