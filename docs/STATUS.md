# HEOR Studio — Status & Roadmap

_Snapshot of what exists vs what's left. Last updated 2026-07-28 (after Analysis Waves
1.6 through 3 — calendar trend, the claim-line ledger, the comorbidity-index
engine and its Table 1 / SMD wiring, and the GLM emitter; **751 harness
checks**). See
`docs/NIGHT-REPORT-2026-07-26.md` for the overnight build and **`docs/PENDING.md`
for the audited, authoritative roadmap** — a 9-agent audit found 151 pending items
and corrected several claims previously made here)._

Repo: private `github.com/andey0Saikiran/heor-studio` · monorepo (`packages/core`, `packages/web`, `packages/mcp`).
Everything below is committed and pushed unless noted.

---

## ✅ HAVE (built, and where noted, machine-verified)

### Product foundation
- npm-workspaces monorepo; `@heor-studio/core` (AGPL) shared by the web app and the MCP server (Apache).
- Full typecheck / build / smoke / verify all green.

### Knowledge base (in `docs/` + `corrections/`)
- **MarketScan BRD** — ~70 numbered business rules, confidence-tagged (`V-PRIMARY`/`V-PUBLIC`/`CONFIRM`/`CHOICE`).
- **Domain rules** distilled from public methods sources.
- **Coverage matrix** — all 70 analyses mapped (method, output, spec fields, verification).
- **MCP plan**, **Learning protocol**, and the full research corpus.

### Protocol → spec (the LLM step)
- `extract_spec`: protocol/SAP → structured `StudySpec` via Anthropic BYOK, forced `tool_choice`, normalized. (Extraction *pipeline* proven end-to-end to Anthropic's servers; live-quality run still pending a funded call.)
- `SPEC_JSON_SCHEMA` + system prompt with HEOR extraction rules.

### Spec schema (the review surface)
- Full analysis-layer discriminated union: P1 detailed (`incidence_rate`, `point/period_prevalence`, `cumulative_incidence`, `standardization`, `calendar_trend`, `statistical_engine`) + `future_stub` for P2–P4.
- `spec.meta.daysPerYear` — analyst-configurable person-time constant (default 365.25).
- Readiness validation walks the whole spec.

### Code generation (deterministic emitters) — modular, both languages
- **Cohort spine — SQL (Postgres verified; Snowflake emitted-only) AND SAS:** code/NDC pull → events → index → enrollment pull → stitch → continuous-enrollment → attrition → **Table 1**. ⚠️ Only the Postgres twin is executed by the harness; Snowflake output currently has NO automated check and the SAS twin is parity-checked, not executed.
- **Per-analysis module registry** (`emitters/modules/` + `registry.ts`): each analysis is one file exposing twin `sql()`/`sas()`; adding one touches no emitter core. Proven zero-behavior-change on refactor (43 emitted files byte-identical).
- **Descriptive-epi quartet — SQL execution-verified; SAS parity-checked (not executed):**
  - **Incidence rate** ✅ (washout, person-time clipping at earliest of event/disenroll/study-end/max-follow-up, crude rate, Byar exact-Poisson CI, demographic strata; SAS twin + parity).
  - **Point prevalence** ✅ (cohort-enrolled-on-anchor denom, fixed/index anchor, Wilson CI, strata, zero-denominator NULLs).
  - **Period prevalence** ✅ (enrolled-anytime overlap denom, event-in-period numerator with no carry-in, Wilson CI, panel-churn warning).
  - **Cumulative incidence (risk)** ✅ (at-risk denom, first event within horizon, naive risk + Wilson CI; KM/CIF honestly deferred to SAS).
- **Outcome care-setting filter** applied in both twins (shared `outcomeSettingPlan`), with a planted inpatient negative control.
- **Honest labeling:** unimplemented options (Clopper-Pearson, Wald, KM, competing risk, minClaims>1, dx-position) → computed-with-closest-method + visible `REVIEW` note in both languages.

### Verification harness (the "machine-verified" engine) — **751 passing checks**
_(the figure once quoted as 207 was miscounted — a live run printed 206. Waves 0-4 took it to 308.)_
- PGlite (real Postgres-16 wasm) executes the **actual emitted SQL** against a 12-patient synthetic MarketScan fixture with hand-computed ground truth.
- **Gold Case A passes:** spine 12→11→10; incidence 3/8/2425/451.86/Byar CI + 6 stratum rows; point prevalence 4/10 + 7 strata; period prevalence 3/10 + 6 strata; cumulative incidence 3/8 = 0.375 Wilson (0.13684, 0.69426) + strata; plus zero-denominator and horizon-bound edge cases.
- **SAS↔SQL parity harness:** every analysis stamps a `PARITY` record of consumed parameters, and — since Wave 2 — the harness ALSO compares values scraped from each language's own emitted text (fingerprints), plus the cohort spine, which previously had no parity coverage at all. The stamp comparison alone could not fail (both stamps came from one shared builder); the fingerprints can, and mutation tests prove it on every run.
- Invariant catalog (attrition monotonic, numerator≤denominator, CI ordering, no negatives, pct bounds) + `daysPerYear` regression guard + care-setting negative control.
- `npm run verify -w @heor-studio/core`.
- **Code fingerprints + 18 mutation tests** (Wave 2): every operative value is scraped from
  each language's OWN emitted text, and deliberate corruptions of the emitted code are
  asserted to turn the suite red — the standing proof it can fail. Snowflake is
  fingerprinted against the execution-verified Postgres twin; the SAS twin gets structural
  linting (balanced comments/parens, closed procs, defined macros).
- **CI** (`.github/workflows/ci.yml`): typecheck, lint, verify, MCP smoke (source AND the
  built dist under plain node), and web build, on every push and PR.

### MCP server
- **7 tools:** `search_codes`, `validate_spec` (now shape-validates untrusted JSON before storing), `generate_code` (non-skippable sign-off + all-codes-verified gate + injection-safe tag), `get_artifact` (paged), `run_verification` (wired to the real harness; returns `inconclusive`, never `passed`, on a zero-cohort smoke), `export_bundle`, `report_correction`.
- **+ conditional `extract_spec`** (path B, only when a key is present); 3 prompts (`extract_protocol_to_spec`, `verify_codelists`, `review_and_signoff`); resources.
- Keyless path A (host LLM drives) + keyed path B. Smoke test green.

### Learning protocol
- `report_correction` captures "this is wrong" — **reason required** (always asks why), written **locally** (nothing transmitted), returns a shareable record.
- Git-tracked `corrections/` ledger; every accepted correction → a gold case (bug), a spec option (choice), or a doc change. Seeded with 2 real closed corrections from this build.

### Web app
- Wizard UI: protocol input → spec review → codelist workbench → code panel → export (exists from the MVP; needs the new analysis-layer surfaced — see below).

---

## 🔨 NEED TO BUILD

### A. Finish the incidence module — ✅ DONE
- Snowflake now has fingerprint coverage (Wave 2); it still is not EXECUTED (no account).
- SAS twin ✅, SAS↔SQL parity ✅, stratified output ✅, `run_verification` wired ✅.
- _Remaining:_ **Snowflake** verification of any kind (PGlite only runs the Postgres twin; the Snowflake SQL is emitted through the Dialect layer with zero automated checks). Note: there is **no CI pipeline at all yet** — `npm run verify` only runs manually.

### B. P1 — remaining 3 modules (descriptive-epi quartet ✅ done)
Each has a real prerequisite — deliberately left for an awake session (see NIGHT-REPORT §"What did NOT finish"). Design drafts in `docs/blueprints/p1/` (UNVERIFIED).
- **Age/sex standardization** — needs the reference-population weight tables (US 2000 / WHO / ESP) entered as verified constants + composition over a base measure.
- **Calendar trends** — needs a multi-period fixture extension (fixture indexes all in 2019) + a p-value policy (SQL has no chi-square CDF).
- **Deterministic test-selection engine + SMD balance table** — needs a **two-exposure-cohort spine extension** first (the single-cohort spine can't produce the drug X-vs-Y partition the SMD gold requires); highest value once the spine supports exposure groups.

### C. P2 — patterns + economics (21)
- **HCRU** (PPPM/PPPY by setting), **Cost** (all-cause vs disease-related, CPI adjustment, gamma-log GLM, two-part), **Adherence** (PDC/MPR), **Line of therapy**, **Switching / persistence**.

### D. P3 — causal + survival (26)
- **PS matching / IPTW** (+ balance table, Love plot, overlap), **Kaplan-Meier**, **Cox PH**, **adjusted cost GLM**.

### E. P4 — advanced (11)
- **Competing risks** (Fine-Gray / CIF), **high-dimensional PS**, **target-trial emulation**, **recurrent events**.

### F. Deliverable packaging (what clients actually receive)
- **Excel table shells + Word report** (the real HEOR deliverable format), not only code files.
- ✅ **Small-cell suppression** — derivation-aware, both languages, on by default (Wave 4).
- ✅ **Results contract** (`<prefix>_results`) — one tidy long-format table for shells to read.
- ✅ **Reproducibility provenance** — emitter version + spec hash in code and README.
- Still open: **Excel table shells + Word report**, **QC pack**, code-list appendix as a
  primary output, IRB/DUA attestation block.

### G. Extractor + UI to match the new schema
- Teach the extractor prompt/schema to fill the new analysis-layer fields.
- Spec-review UI renders + edits the new analysis parameters.
- Live extraction-quality run on a funded key (synthetic protocol → good spec).

### H. Distribution + launch
- **MCPB bundle** (`.mcpb`) for Claude Desktop one-click; **npm publish** `@heor-studio/mcp`; MCP registry.
- Web on **Cloudflare Workers** static ($0).
- **Trademark** "HEOR Studio"; license files (AGPL core + Apache MCP); landing page; docs site.
- **Validation:** 5–10 practitioner interviews; expand to a ~50-case gold benchmark.

---

## Open decisions (none blocking)
- 365 vs 365.25 — already handled as a per-study choice (`daysPerYear`).
- Table numbering scheme (flat vs ICH-E3 vs STaRT-RWE) — pick when packaging deliverables.
- Whether to bundle a MarketScan-shaped synthetic dataset publicly (verification uses one internally).

## Suggested order when resuming
1. ✅ ~~Wire `run_verification`~~ · ✅ ~~Incidence SAS twin + stratified~~ · ✅ ~~Prevalence + cumulative incidence~~ (all done overnight).
2. **Statistical engine** — first add the two-exposure-cohort spine extension, then the SMD balance table (pinned gold smdAge = −0.63246 is waiting).
3. **Standardization** (enter + double-check the standard-pop weight tables) → **calendar trend** (multi-year fixture extension + p-value policy).
4. Then P2 economics (where MarketScan demand concentrates).

---

## Analysis Waves 1.6 + 2 (2026-07-28) — 8 analyses now verified

**Score: 15 of 69 done, 4 partial. 2 gold cases.** Harness: **751 checks, 0 failing** (was 396).

### Calendar trend (`4758e5a`) — the 7th analysis
Cochran-Armitage over calendar buckets. The statistic **z is closed form, computed
in BOTH twins, and executed** against hand-derived truth; only the two-sided
p-value is SAS-primary. Declaring the whole test SAS-primary would have been
easier and would have put a perfectly verifiable number beyond verification.

On Gold Case A the algebra collapses to clean fractions — R=5, N=30, pbar=1/6,
T=-2, Var=25/9 — giving **z = -1.2 exactly**, a value a floating-point slip or a
mis-scored bucket cannot land on by accident.

Refused by name at readiness: `incidence_rate` and `point_prevalence` bases
(person-time split across buckets, and a per-bucket anchor, do not exist), and
monthly buckets under Cochran-Armitage (dozens of sparse cells scored 0,1,2,…
give the test almost no power).

**A latent defect found by reusing the SAS-primary contract:** `exact_ci_null_in_sql`
and `exact_ci_computed_in_sas` are produced by one language each, and
`diffFingerprints` compared the union of keys — so the first spec asking for
`poisson_exact` would have hit a spurious mismatch. Never fired because the gold
spec uses `poisson_byar`. Fixed with `LANGUAGE_LOCAL_KEYS` + per-language
assertions: strictly more enforcement, not an exemption.

### Claim-line ledger + resource use and cost (`cbe0c15`) — the 8th
The substrate the whole economic tier sits on. Counts and costs are ONE module
because they share a denominator, a window and a definition of an encounter.

**The inpatient double count.** MarketScan records an admission twice — a
stay-level total, and service lines that already roll up into it. Summing both
inflates the largest cost component in most studies and produces a table that is
complete, well-formed and wrong. Gold Case A pins it:

| | |
|---|---|
| correct IP total | **$15,000** |
| double-counting ledger | $22,000 |

Both are in the fixture, the second labelled as the failure to detect. The
mirror-image error — dropping service lines that have no admission record —
loses whole stays; P05 is that case and is kept.

**Median yes, quartiles no, and the reason is a proof:** SQL's
`PERCENTILE_CONT(0.5)` and SAS's `PCTLDEF=5` agree exactly for every n (n even →
both average the two central order statistics; n odd → both take the central
one). Away from p=0.5 they genuinely differ, so no quartile is emitted by either
twin, and `PCTLDEF=5` is written out rather than left to a site default.

Every executed number matched a hand derivation done *before* the module ran: 19
encounters over 10 members, $18,600 total, mean $1,860 vs median $350.

**Fixture safety proven, not asserted.** 8 claim rows and 5 payment columns were
added; all 440 previously-pinned checks still passed on the fixture change ALONE,
before any module existed to read it.

### Comorbidity index (`e3df312`) — the 9th, and a refusal at its centre

Shipped as a general weighted-index **engine**, not a Charlson module. The
scoring — ascertain in a lookback, apply a hierarchy so a severe condition's
weight REPLACES its milder form, sum — is identical across every index and is
where the errors live. The weights and codes are published research.

**The weights are NOT bundled**, because the sources disagree: a general survey
puts "uncontrolled diabetes" at 3, while the Deyo/Quan administrative
implementations score *diabetes with chronic complications* at 2. Bundling either
would be a plausible-looking constant shifting every adjusted estimate
downstream, invisibly. Same discipline as `STANDARD_POPULATIONS_PENDING`: refuse
with a citation.

To transcribe and sum-check: **Quan H, et al. Med Care 2005;43(11):1130-9**
(ICD-10 algorithms) and **Deyo RA, et al. J Clin Epidemiol 1992;45(6):613-9**
(the 17-category adaptation and its weights).

`supersedes` is declared per condition, so Charlson, Elixhauser or a bespoke
index all run on one emitter. A superseded condition still reports its
**prevalence** — only its weight is withheld. Verified with both hierarchy
directions planted: P03 (diabetes uncomplicated + complicated) scores 2 not 3;
P05 (liver mild + severe) scores 3 not 4; cohort mean 1.1, and the failure
signature (1.3, the flat sum) is pinned beside it.

### Comorbidity index wired into Table 1 + SMD (`e79e6d7`)

The index is now a **covariate**, not just a standalone analysis — the Table 1
row and the SMD balance row the build plan said would unblock three families.

**One scorer, three consumers.** Table 1 is emitted by the spine, before any
analysis module, so it cannot read the index module's output. `emitters/comorbidity.ts`
owns the chain; the extraction was gated on a **byte-identity diff of all 62
generated files** (identical). A baseline characteristic of kind
`comorbidity_index` names the index ANALYSIS by id, and readiness refuses a
reference that does not resolve to an enabled one.

Hand-derived and executed: SMD = 1/√1.3 = **0.87706**, and the cross-check that
matters — (5×1.6 + 5×0.6)/10 = 1.1 — is exactly the cohort mean the index
analysis reports and exactly what Table 1 prints. Three independently-emitted
programs, three tables, one number.

**Two real defects this surfaced**, both invisible until a second *continuous*
covariate existed:
1. The emitters keyed the source column on the **measure** (`continuous` → age),
   so the index would have reported age's SMD twice, once mislabelled — every
   number real, correctly computed, from the wrong variable. Now keyed on axis.
2. The PARITY stamp carried only `{id, measure}` per covariate, so it could not
   describe which variable a row's moments came from. It now carries the axis.

Also fixed: the harness located balance rows by measure, which kept working only
because "Age at index" sorts before "Comorbidity index".

### GLM emitter (`1e4c015`) — the 11th, and the third family unblocked

Fitted coefficients need IRLS/Newton and warehouse SQL has neither, so the split
is drawn where the verifiability actually changes:

| | |
|---|---|
| both twins, **executed** | analytic dataset, the 2×2, and closed-form OR / RR / RD + Woolf SE + Wald interval |
| **SAS only** | the adjusted coefficients — NULL in SQL beside the procedure that produces them |

**The anchor.** A logistic model whose only predictor is the two-level exposure
is *saturated* for a 2×2 — as many free parameters as cells. Its MLE is not an
approximation of the closed-form log odds ratio, it **is** that number. The
emitted SAS fits that model, recomputes the closed form from its own data, and
prints PASS/FAIL. No reference value ships with it; it is the one place a site
watches the fitting machinery be validated rather than trusted.

Hand-derived, matched exactly: OR = (1×2)/(3×2) = **1/3**, Woolf SE = √(7/3) =
1.52753, CI (0.01670, 6.65479), RR = 0.5, RD = −0.25. A zero cell returns NULL
rather than a continuity correction — a correction changes the estimand, and
doing it silently is how a study reports an estimate nobody chose.

**One family is built** (logistic). `poisson`, `negative_binomial`, `gamma_log`
and `ols` are refused by name at readiness with the specific feeder each is
missing.

**Two harness gaps this module found**, not me: the SAS lint didn't know
`ODS OUTPUT` creates a dataset (this is the first module to capture PROC
LOGISTIC's ParameterEstimates), and the mutation runner never evaluated
language-local keys — so "SAS stops fitting" and "the anchor is deleted" read as
NOT CAUGHT while the parity pass genuinely checked them. Both fixed generally.

### A silent SAS/SQL divergence, found and fixed (`3cdda71`)

Found while extracting the person-time chain the Poisson family needs.
`meta.dataCutDate` was applied by the SQL incidence builder and **ignored** by
the SAS one, so a study declaring a data cut got two different person-times from
one bundle — SQL censored at the cut, SAS ran to the study end.

Nothing caught it, and that is the more interesting part: the PARITY stamp
recorded `censorAt`, which both twins read from the same spec field, so the
stamps agreed by construction; the fingerprints scraped the max-follow-up
offset, not the censor bound; and Gold Case A declares no cut, so no fixture ran
the path. The data-cut feature exists specifically to stop the immature tail
being counted as event-free person-time — so this silently disabled a
correctness control in half of every bundle that used it.

Fixed structurally: `rate-core.censorPlan()` decides the terms once and each
language only renders them, so a twin cannot omit a term it never chose. Three
layers stop it returning — `dataCut` in the stamp, a `censor_bounds` fingerprint
compared across languages, and a guard that emits a spec **declaring a cut** and
asserts both twins bound at it. The guard carries a self-test that strips the cut
from SAS and confirms the comparison goes red.

### Poisson family (`d32de98`) — the 12th

Slots INTO the GLM emitter rather than beside it: design, analytic dataset,
SAS-primary contract and saturated anchor are shared; only the closed form and
the offset differ. The anchor holds because a Poisson model with one binary
predictor and a log person-time offset is saturated for the two-cell table, so
its MLE is exactly ln(rate ratio).

Hand-derived, matched to the digit: **RR = 1030/2790 = 103/279 = 0.36918**,
SE = √1.5 = 1.22474, CI (0.03347, 4.07152), rate difference −447.39534/1000 PY.

The load-bearing check: **1395 + 1030 = 2425**, the person-time every rate module
already pins. The offset is built by rate-core's censoring plan — the one
extracted to fix the data-cut divergence — so a feeder that disagreed with the
incidence table could not pass, and the harness asserts the reconciliation
rather than leaving it to coincidence.

Note the SE uses **event counts alone**; person-time enters the estimate, not the
variance. A mutation adds person-time terms to it, which narrows every interval
while leaving the point estimate untouched.

**A real mislabeling caught here:** adjusted rows came out as `odds_ratio` on a
Poisson model. An odds-ratio label on a rate ratio reads as correct and is not.
The statistic now follows the family and is stamped and asserted.

Overdispersion is an emitted limitation, not a silent assumption.

### Competing-risks CIF (Wave 6.3) — the 18th, and the first with nothing deferred to SAS

Kaplan-Meier treats a competing event as censoring, which asserts that the
subject who failed from another cause would have gone on to have the event of
interest at the same rate as everyone still at risk. They cannot have it at all,
so **1 − KM overstates the risk** — always.

This module emits Aalen-Johansen **and the naive number it replaces**, so the
reason for running it is a subtraction in the output rather than a claim in a
method note. On Gold Case D:

| | CIF (Aalen-Johansen) | naive 1 − KM | overstated by |
|---|---|---|---|
| event of interest | 1/3 | 3/8 | **1/24** |
| competing cause | 1/6 | 1/5 | **1/30** |

And the pathology, flagged in the output: the naive pair sums to **23/40**
against a true total event probability of **1/2** — two mutually exclusive
outcomes whose probabilities add to more than the chance of either happening.
That is not rounding.

**Nothing is SAS-primary here.** No p-value, no fitted coefficient — the first
family in the bundle where the SQL twin is complete.

**Three things make it checkable, all executed.** The partition identity
Σ CIF_k(t) = 1 − S(t) is not a tolerance check: the sums telescope, so any error
in one cause's accumulation breaks it. It ships as a *row*, so the check travels
with the result. The bias is a number. And the naive-sum pathology is detected
rather than left to be noticed.

**The variance ships with a reduction check rather than on trust.** Three
interacting delta-method terms are easy to get subtly wrong, and a wrong one
still produces a plausible standard error. But with no competing event the whole
expression must collapse to Greenwood — and on Gold Case A it does, at
**15/512**, whose square root is the 0.17116 the survival module already pins
independently for S(365).

**Gold Case D exists because A, B and C cannot fail.** All three have a single
kind of event, which makes the CIF and the naive 1 − KM the same number on every
one of them. An implementation that had quietly built *per-cause* risk sets —
the standard way to get this wrong — agrees with all three. Gold A is kept as
the deliberate degenerate branch: three independent code paths must all reach
3/8, the bias must be *exactly* zero, and the program must name it the
degenerate case rather than an overstatement.

**Refused, not approximated:** Gray's test (its weights depend on the cumulative
incidence at each event time — closed form, but a different statistic, and a
"close enough" version would be a mislabeled test) and Fine-Gray regression. The
method notes state plainly that cause-specific and subdistribution hazards
answer different questions and routinely point in different directions.

**Readiness gates three things a reader would not think to check.** The mortality
refusal applies here too, and the trap is that this analysis is *about* competing
mortality, so a death endpoint reads as legitimate. It is not — the endpoint is
what the CIF estimates. An analysis with no competing event is refused as a
correction it is not making. And a competing cause sharing the endpoint's code
list is refused because every event would count as both — with the partition
identity still perfectly satisfied by the double count.

*Five harness defects and two of mine.* The SAS twin had **no horizon rows at
all** — I left a stub where the assembly should have been, and the constant
profile caught it (4 z in SQL against 0 in SAS). A `CASE` built as a string
concatenation didn't parse. The results contract needs two always-populated
identifying columns, and `horizon`/`time_days` are mutually exclusive — collapsed
into one `at_label`, which also removes a real collision when a horizon equals an
event time. A shape's `rowDetailCol` must be a column the suppression pass
*keeps*, or the contract fails at run time in the last program of the bundle;
that is now a load-time throw. And a SAS scrape keyed on a program number where
the text carries the resolved `&tag.`.

Mine: the identity fingerprint tested for the "HOLDS" *text* and not the
comparison, so a mutation reducing it to a tautology passed — and this one
matters more than the Cox equivalent, because the identity ships *with the
result* and nobody downstream re-derives it. And a check that failed a correct
program: comparing se² against Greenwood at 1e-6 when the se is emitted rounded
to five decimals.

### Cox proportional hazards + Gold Case C (Wave 6.2) — the 17th

**The build plan was wrong about Cox, in a useful direction.** It lists the
coefficient with the families that are "unverifiable except at a saturated
design". True of the coefficient. Not true of the model around it, and — it
turns out — not true of the coefficient either, under one condition.

**Executed in both twins**, all hand-derived before running:

| | Gold A (no ties) | Gold C (one tie) |
|---|---|---|
| partial logL(0) | −5.81711 | −4.96981 |
| score U(0) | −31/42 | −1/2 |
| information I(0) | 1265/1764 | **3/4** |
| log-rank variance | 1265/1764 | **13/20** |
| score χ² | 0.75968 | 1/3 |

The score at the null **is** the log-rank numerator O − E — the log-rank test is
the Cox score test at β = 0 — and the harness asserts the survival module and
this one produce the same number from different expressions over different CTEs.
The information equals the log-rank variance **only when nothing is tied**,
because the log-rank carries a (n−d)/(n−1) correction Breslow's does not. Gold A
has them equal; Gold C has them apart. That difference is the whole reason Gold C
exists.

**The anchor.** If every risk set has the same exposed share *p*, the partial
likelihood collapses to a binomial and its maximum is closed form:

> HR = [q/(1−q)] / [p/(1−p)]

— an odds ratio of "share of **events** exposed" over "share **at risk**
exposed". Real risk sets drift, so this almost never applies and the program says
NOT APPLICABLE. It is a verification device, exactly as the saturated 2×2 is.
Both branches are exercised: Gold A's share runs 1/2, 4/7, 2/3 (not applicable);
Gold C's is 1/2 throughout and gives **HR = 1/2 exactly**, confirmed against an
independent Newton solve to ten decimals.

**Three self-checks on PROC PHREG**, none shipping a reference value: the null
−2 LOG L; **U(β̂) = 0**, the equation that *defines* the estimate and closed form
here because the exposure is binary; and the anchor where it applies. The second
is the strongest thing available about a coefficient with no closed form — not
"the fit looks right" but "the fit solves the equation that defines it".

The one-step estimator is reported because it is executable and **labelled**
because it is not the answer: 0.35728 against a true maximum of 0.35583 on Gold
A, 0.51342 against an exact 0.5 on Gold C.

**Refusals, with reasons.** Proportional hazards is **assumed and not tested**,
and the emitted program says so rather than leaving a reader to assume otherwise.
No time-varying covariates, no stratified baseline hazard. `ties:"efron"` is
refused because every closed form the SQL twin computes is Breslow's — a SAS fit
maximizing Efron's likelihood would fail this program's own U(β̂)=0 check while
being perfectly correct. The refusal also says when Efron would be the better
choice, which is the part that matters.

**Gold Case C.** Three pieces of arithmetic were unreachable on A and B: the KM
factor (n−d)/n with d > 1, the log-rank tie correction, and the
information-vs-variance gap. Two of the nine Cox mutations corrupt a quantity
that is *numerically identical* on Gold A to what it was swapped with — the
fingerprint catches them, and Gold C turns them into numbers. That pairing is the
case for having both mechanisms.

*Four harness defects and three in my own checks.* A UNION takes its column names
from the first branch only, and that branch had no aliases; `sas-lint` saw only
the first dataset in a multi-target `ods output`; the log-rank variance was built
from a second construction of the risk sets; a loose critical-value scrape
matched the tied-event-time counter first. Then, found by mutation testing:
`cox_fit_in_sas` matched `/ties=breslow/` anywhere including the method *label*,
so switching the real fit to Efron stayed green; `cox_null_loglik_check` tested
the PASS string and not the comparison; and `cox_fit_null_in_sql` looked for
**one** NULL adjusted estimate when the contract is that **every** one is NULL —
the third time in this repo a single-occurrence pattern has hidden a partial
corruption.

### Survival: Kaplan-Meier + log-rank (Wave 6.0/6.1) — the 16th, and the family with the smallest SAS carve-out

**The mortality refusal shipped first, in its own commit**, before the module it
governs — as `docs/ANALYSIS-BUILD-PLAN.md` promised. MarketScan's only native
death signal is `DSTATUS`: a *discharge* status, so in-hospital death only, and
masked from data year 2016. An "overall survival" curve on it is really "time to
in-hospital death before 2016, with every other death censored" — and censoring
by death is exactly the informative censoring Kaplan-Meier assumes away, biasing
survival **upward**. `endpoint` is a discriminated union, not a string, so the
refusal keys on a **type** and cannot be evaded by relabelling the analysis.

**This family inverts the usual split.** In the regression family every fitted
coefficient is SAS-primary because IRLS has no SQL counterpart. Here the
product-limit estimator, Greenwood's variance, both interval forms, the median
**and the log-rank statistic** are all closed form — so all of them are executed
in both twins. Exactly one column is SAS-primary: the p-value.

And that gap is narrowed rather than accepted. A **decision** at α = 0.05 needs
no CDF — for 1 df the critical value is z², already pinned repo-wide as 3.8416 —
so the SQL states the decision, labels it a critical-value comparison, and says
out loud that the exact quantile is 3.841459 and a statistic between the two
would be called significant here and not by SAS.

**The anchor.** The SAS twin does not run `PROC LIFETEST` and report it. It
computes the same closed form the SQL does, runs LIFETEST *beside* it, and
prints a row-by-row PASS/FAIL. Unlike a GLM's MLE the estimator has a closed
form, so the procedure can be **checked** rather than trusted.

Hand-derived before execution, and matched exactly:

| t | n at risk | S(t) | Greenwood sum | se |
|---|---|---|---|---|
| 100 | 8 | 7/8 | 1/56 | 0.11693 |
| 200 | 7 | 3/4 | 1/24 | 0.15309 |
| 300 | 6 | 5/8 | 3/40 = 0.075 | 0.17116 |

**The cross-module check.** Nobody is censored before the last event, so
1 − S(365) = 1 − 5/8 = **0.375** — the cumulative-incidence module's 3/8, reached
by a completely different algorithm. Two modules, one number, now asserted
rather than left as a coincidence a reader might notice.

**The boundary.** The reference arm's curve lands on **exactly one half** at day
200 — the boundary the median's `S(t) ≤ 0.5` is evaluated at, planted there on
purpose. SQL has no product aggregate, so S is accumulated as `exp(sum(ln))` and
an exact ½ can land either side by a few ulps; `MEDIAN_EPS` is what makes the two
languages agree there, not a fudge for imprecision. The exposed arm never reaches
½, so its median is legitimately NULL — and the row **says NOT REACHED** rather
than being omitted, because an absent row reads as a computation that failed.

Log-rank (accumulated for the exposed arm): O = 1, E = 73/42, V = 1265/1764,
χ² = **961/1265 = 0.75968**, below 3.8416. The Peto one-step HR = 0.35728 points
the same way as the logistic module's OR = 1/3 on the same data — and is labeled
`peto_one_step`, not "hazard ratio", because it is the first Newton step toward
the Cox MLE and is biased away from the null at large effects.

Two more analyses cover the edges: a **linear** interval whose upper limit
computes to 1.104 and must be clamped (the whole argument for `log_log`), and an
endpoint that **never occurs** — empty life table, S(t) = 1, NULL median, and
every log-rank term NULL *together*, because "0 observed" beside a NULL
expectation reads as a result rather than an absence.

**A disclosure finding worth stating plainly.** The KM life table is the most
disclosive table this project produces: nearly every row carries `n_event = 1`,
which is one patient's event date to the day. At the default threshold of 11 the
whole component masks — and that is the correct answer, not a defect. The
releasable form of a survival curve is S(t) at a handful of fixed horizons, where
`n_risk` is a group rather than an individual. The life table now sits behind an
explicit `emitLifeTable` opt-in.

*Five harness gaps this module exposed, all fixed:* `sas-lint` counted a
procedure name inside a `TITLE` **string** as a procedure; it did not know
`outsurv=` creates a dataset; the results contract identified a row by two
labels, which a time-indexed table is not (it grew a nullable third column); the
CI-constant profile counted `1.96` and `3.8416` inside **prose**, so a module's
pinned profile depended on how its captions were worded; and the interval was
computed once per row shape, so the z count moved with spec options and could not
be pinned at all.

*And one in my own check.* `logrank_p_null_in_sql` looked for any
`CAST(NULL AS NUMERIC)` near the `p_value` label — which a **populated** estimate
still satisfies, because the `ci_low`/`ci_high` beside it are NULL either way.
The mutation that fills the p-value in with 0.05 left the check green. It is now
anchored on the estimate slot itself. The check read like a contract and proved
almost nothing.

### OLS (Wave 3.4) — the 15th, and the regression family table is complete

logistic, poisson, negative_binomial, gamma_log, ols — **nothing in the family
table is refused any more.**

OLS is the strongest case of the five. Every family's saturated coefficient is
closed form; OLS is the only one whose **standard error** is too (the pooled
two-sample form), so both halves are executed rather than deferred to SAS.

Hand-derived and matched: mean difference **−1.75 exactly**, pooled SE 0.47871,
interval (−2.68828, −0.81172). One arm has **zero variance** — a real edge case,
pinned: the pooled estimator falls back on the other arm rather than dividing by
nothing.

**The interval is labeled for what it is:** `wald_normal_approx_pooled_sd`. The
exact interval is Student t on n−2 df and the t quantile needs an inverse CDF
SQL lacks. At this size that is not a technicality — t(6) = 2.447 vs z = 1.96, a
25% wider interval — so the residual df ships as its own diagnostic row.

The response is the comorbidity score from the **shared scorer**, so this model
cannot disagree with Table 1 or the balance table. Readiness refuses the index
being both response and covariate.

*Two of my own errors, caught and fixed:* the expected row count (6+1+1+3 = 11,
not 10), and a mutation that read as NOT CAUGHT because the emitter writes the
pooled variance twice and `replace` without `/g` corrupted only the first — the
same partial-replacement trap as the D3 spine mutation.

### Gamma-log cost model (Wave 3.3) — the 14th

The response comes through the **shared ledger**, so the model's costs are the
resource-use table's costs — inpatient double-count rule included (P04's stay is
its $10,000 admission total, not $17,000). The ledger is now parameterizable so
it can coexist with rate-core's chain in one WITH clause.

The anchor holds: a saturated gamma-log model reproduces the observed arm means,
so its MLE is ln(mean_exposed / mean_reference).

**The interval is labeled for what it is.** The fitted model's interval needs the
gamma dispersion parameter and is SAS-primary. What both twins can compute is
the **delta method** on the log ratio of means — a different, named estimator,
shipped as `delta_method_ratio_of_means` with a check on the label itself.

**The zeros are the point.** The cost window excludes the index date (the index
fill *is* the exposure), which leaves two subjects at zero cost — what a gamma
response cannot take. They are counted and excluded, named as the second part of
a two-part model, never dropped silently and never rescued with a small constant.

Hand-derived and matched: cost ratio = 850/3975 = **34/159 = 0.21384**, delta SE
0.95555, CI (0.03286, 1.39143).

*A correction:* my hand derivation gave SE 0.95554. Execution said 0.95555. I
recomputed independently rather than assume the code was right — a long-division
slip in my working. The fixture comment records it.

### Negative binomial + the recurrence feeder (`d32de98`→ Wave 3.2) — the 13th

**A correction first.** I twice refused NB on the grounds that "a dispersion
parameter has no closed form and therefore no saturated anchor". The second half
does not follow: at saturation the model reproduces the observed means, so the
NB MLE equals the Poisson MLE equals ln(rate ratio). Dispersion affects the
*standard errors*, not the point estimate. The anchor holds.

The real blocker was the **fixture**. Counting events per at-risk subject on Gold
Case A gives `[0,1,1,0,0,0,1,0,0,0]` — max 1. A 0/1 response is Bernoulli, whose
variance is always below its mean, so dispersion is not identified. NB needs
recurrent counts, which is a *feeder*, not a family.

So `recurrence: "all_events"` makes the response a **count** of distinct
qualifying event dates. Readiness refuses the two incoherent combinations: NB
with `first_only`, and `all_events` with person-time censoring at `outcome`
(counting every event while stopping the clock at the first).

That changes the denominator, and the change *is* the methodology:

| | |
|---|---|
| person-days | 1460 + 1460 = **2920** = 8 × 365 (not the 2425 of a first-event model) |
| RR | (1/1460)/(2/1460) = **0.5 exactly** |
| SE | √1.5 = 1.22474; CI (0.04534, 5.51434) |

A check asserts the denominator must *differ* from 2425 — if it ever agrees,
recurrence became unobservable.

**The honest row:** the program reports `DEGENERATE: no subject has >1 event, so
the dispersion parameter is NOT identified` rather than printing an estimate. It
is asserted, so the day Gold Case B adds real recurrence the assertion changes.

### Gold Case B (`ba64b3f`) — the 2nd gold case

Exists for a condition Gold A **cannot** produce: on A no at-risk subject has
more than one qualifying event, so the response is Bernoulli and NB's dispersion
parameter is not identified. B is seeded so it is — one arm carries a subject
with seven events.

A separate **seed**, not an append: an extra indexed patient in A would move
attrition, the at-risk 8, the 2425 person-days and every downstream estimate at
once. `seedAndRun` now takes the seed and each case runs in its own PGlite.

Hand-derived and matched: RR = (8/1460)/(4/1460) = **2.0 exactly**, SE = √0.375 =
0.61237, CI (0.60224, 6.64189), rate difference 1000.68493/1000 PY.

**The contrast is the deliverable.** A closed-form variance-to-mean ratio now
ships in both twins — the statistic that says whether NB earns its extra
parameter. Same emitter, opposite verdicts, both read off the data:

| case | counts | ratio | verdict |
|---|---|---|---|
| Gold A | 1,1,0,0,1,0,0,0 | 0.71429 | NOT overdispersed |
| Gold B | 1,1,2,0,0,0,1,7 | 3.61905 | OVERDISPERSED, NB warranted |

**The defect B found on its first run:** the analytic dataset built trailing
commas from one optional column, so a count family *without* a comorbidity
covariate emitted `... AS sex_male CAST(...) AS person_days` and failed to parse.
Gold A's NB analysis happens to carry that covariate, so the path was never
exercised — same shape as the data-cut divergence. It earned its keep before it
finished being written.

B runs the full parity and SAS-structure checks on its **own** emission too.
