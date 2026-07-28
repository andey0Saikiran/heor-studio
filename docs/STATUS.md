# HEOR Studio — Status & Roadmap

_Snapshot of what exists vs what's left. Last updated 2026-07-28 (after Analysis Waves
1.6 through 2.2 — calendar trend, the claim-line ledger, the comorbidity-index
engine and its Table 1 / SMD wiring; **574 harness checks**). See
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

### Verification harness (the "machine-verified" engine) — **574 passing checks**
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

**Score: 10 of 69 done, 4 partial.** Harness: **574 checks, 0 failing** (was 396).

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

**Still open:** regression adjustment (the third family) needs the GLM emitter
from Wave 5 of the build plan; the covariate plumbing it will consume now exists.
