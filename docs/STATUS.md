# HEOR Studio — Status & Roadmap

_Snapshot of what exists vs what's left. Last updated 2026-07-25, at commit `46b5627`._

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

### Code generation (deterministic emitters)
- **Cohort spine — SQL (Postgres + Snowflake) AND SAS:** code/NDC pull → events → index → enrollment pull → stitch → continuous-enrollment → attrition → **Table 1**.
- **Incidence-rate module — SQL:** ✅ **generated + machine-verified** (washout, person-time clipping at earliest of event/disenroll/study-end/max-follow-up, crude rate, Byar exact-Poisson CI, arm strata).

### Verification harness (the "machine-verified" engine)
- PGlite (real Postgres-16 wasm) executes the **actual emitted SQL** against a 12-patient synthetic MarketScan fixture with hand-computed ground truth.
- **Gold Case A passes:** spine 12→11→10 (incl. stitch-success & stitch-fail), incidence 3 cases / 8 at-risk / 2425 person-days / rate 451.86 / Byar CI (90.82, 1320.24).
- Invariant catalog (attrition monotonic, numerator≤denominator, CI ordering, no negatives, pct bounds) + `daysPerYear` regression guard.
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

### A. Finish the incidence module (closest to done)
- **Incidence-rate SAS twin** (SAS stops at Table 1 today) + **SAS↔SQL structural parity** checks.
- Verify **stratified** output (arm/age/sex rows), not just Overall.
- **Wire `run_verification` MCP tool to the real harness** (currently returns `not_implemented`; the harness exists — just connect it).
- **Snowflake** parity verification (PGlite only runs the Postgres twin).

### B. P1 — descriptive epi + stat engine (10; incidence done)
- **Prevalence** (point + period) — SQL + SAS. _Cheapest next win — reuses the verified washout/denominator machinery._
- **Cumulative incidence** (risk; KM-based when censored).
- **Age/sex standardization** (`PROC STDRATE`; SQL partial).
- **Calendar trends** (+ panel-churn safeguards).
- **Deterministic test-selection engine** + comparison tables (chi-square/Fisher, t/Wilcoxon, ANOVA/Kruskal-Wallis, **SMD balance table + Love plot**, McNemar).

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
1. Wire `run_verification` to the harness (small, high-value).
2. Incidence SAS twin + stratified verify (finishes the first full module across both languages).
3. Prevalence (cheapest P1) → cumulative incidence → standardization → trend → stat engine.
4. Then P2 economics (where MarketScan demand concentrates).
