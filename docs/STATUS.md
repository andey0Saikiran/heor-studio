# HEOR Studio — Status & Roadmap

_Snapshot of what exists vs what's left. Last updated 2026-07-26 (overnight build;
see `docs/NIGHT-REPORT-2026-07-26.md`), at commit `c937898`._

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
- **Cohort spine — SQL (Postgres + Snowflake) AND SAS:** code/NDC pull → events → index → enrollment pull → stitch → continuous-enrollment → attrition → **Table 1**.
- **Per-analysis module registry** (`emitters/modules/` + `registry.ts`): each analysis is one file exposing twin `sql()`/`sas()`; adding one touches no emitter core. Proven zero-behavior-change on refactor (43 emitted files byte-identical).
- **Descriptive-epi quartet — SAS + SQL, all machine-verified:**
  - **Incidence rate** ✅ (washout, person-time clipping at earliest of event/disenroll/study-end/max-follow-up, crude rate, Byar exact-Poisson CI, demographic strata; SAS twin + parity).
  - **Point prevalence** ✅ (cohort-enrolled-on-anchor denom, fixed/index anchor, Wilson CI, strata, zero-denominator NULLs).
  - **Period prevalence** ✅ (enrolled-anytime overlap denom, event-in-period numerator with no carry-in, Wilson CI, panel-churn warning).
  - **Cumulative incidence (risk)** ✅ (at-risk denom, first event within horizon, naive risk + Wilson CI; KM/CIF honestly deferred to SAS).
- **Outcome care-setting filter** applied in both twins (shared `outcomeSettingPlan`), with a planted inpatient negative control.
- **Honest labeling:** unimplemented options (Clopper-Pearson, Wald, KM, competing risk, minClaims>1, dx-position) → computed-with-closest-method + visible `REVIEW` note in both languages.

### Verification harness (the "machine-verified" engine) — **207 passing checks**
- PGlite (real Postgres-16 wasm) executes the **actual emitted SQL** against a 12-patient synthetic MarketScan fixture with hand-computed ground truth.
- **Gold Case A passes:** spine 12→11→10; incidence 3/8/2425/451.86/Byar CI + 6 stratum rows; point prevalence 4/10 + 7 strata; period prevalence 3/10 + 6 strata; cumulative incidence 3/8 = 0.375 Wilson (0.13684, 0.69426) + strata; plus zero-denominator and horizon-bound edge cases.
- **SAS↔SQL parity harness:** every analysis stamps a `PARITY` record of consumed parameters; the harness deep-compares the two languages' stamps + arithmetic signatures, so a drifting twin fails verification.
- Invariant catalog (attrition monotonic, numerator≤denominator, CI ordering, no negatives, pct bounds) + `daysPerYear` regression guard + care-setting negative control.
- `npm run verify -w @heor-studio/core`.

### MCP server
- **7 tools:** `search_codes`, `validate_spec`, `generate_code` (with the non-skippable sign-off + all-codes-verified safety gate), `get_artifact` (paged), `run_verification` ⚠️stub, `export_bundle`, `report_correction`.
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
- SAS twin ✅, SAS↔SQL parity ✅, stratified output ✅, `run_verification` wired ✅.
- _Remaining:_ **Snowflake** execution parity (PGlite only runs the Postgres twin; the Snowflake SQL is emitted through the Dialect layer but not yet executed in CI).

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
- **Code-list appendix** as a primary output; **QC pack**; small-cell suppression.

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
