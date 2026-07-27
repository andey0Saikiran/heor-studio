# HEOR Studio — What's Pending

_Produced 2026-07-26 by a 9-agent repo audit (7 area auditors + 2 adversarial challengers:
one code-truth, one playing a MarketScan methodologist). 151 pending items found, plus 41
places the docs claim something the code does not support. Every item below carries
file:line evidence in the audit record._

**This supersedes the priority order in `STATUS.md` and `NIGHT-REPORT-2026-07-26.md`.**
Those documents are accurate about what was *built*; they are wrong about what matters *next*.

## Progress (2026-07-26, same day)

- **✅ Wave 0 — make silence impossible** (commit `919c32d`). Enabled-but-unemittable
  analyses now block readiness; `run_verification` returns `inconclusive` (not `passed`) on
  a zero-cohort spec; `tag`/naming are identifier-validated in both emitters + the MCP
  boundary; a new `spec/shape.ts` structurally validates untrusted JSON; two comment-escape
  injection vectors found by adversarial review (`meta.version` → SQL, `provenance.model` →
  SAS) are closed at both the emitter and the boundary; bundle `placePath` fixed; docs
  corrected (206→218 checks). 12 silence guards + 3 smoke assertions pin it.
- **✅ Wave 1 — connect the ends** (commits `0f173fd` core, `aae0353` UI). The extractor
  schema + prompt + `normalizeSpec` now produce the four verified descriptive-epi kinds
  (was: legacy 7 types, everything but attrition/table1 force-disabled); the MCP schema
  resource follows automatically; the web `SpecReview` has an editable card per analysis +
  an add-analysis control; the demo spec ships two real descriptive-epi analyses. Browser-
  verified end to end. Pinned by new "extractor reaches the modules" guards.

- **✅ Wave 2 — make the verifier able to fail** (commits `11e58f7`, `ffc7040`).
  `verify/fingerprint.ts` scrapes operative values from each language's **own**
  emitted text (nothing shared but the comparison), so parity finally has
  falsifying power; `verify/mutation.ts` corrupts emitted code **18 ways** and
  asserts every corruption is caught, each also asserting it actually changed the
  text so a stale pattern can't pass vacuously. **Snowflake** went from zero
  coverage (14 of 28 shipped SQL files) to fingerprinted against the
  execution-verified Postgres twin. `verify/sas-lint.ts` gives the never-executed
  SAS structural checking. **CI now exists** (`.github/workflows/ci.yml`) and
  `npm run lint` works again.
- **✅ Wave 3 — the confirmed defects** (commits `9963c16`, `abbfbbd`, `497813e`,
  `e377fa2`). All 12 closed; each cohort-affecting fix has a regression case that
  was **confirmed to fail before the fix**. See the defect table below.

- **✅ Wave 4 (partial) — suppression + compliance** (commits `b967596`, `9f595ee`,
  `dd91e71`). **Small-cell suppression** shipped in both languages: on by default at
  threshold 11, triggered by a small numerator **or** denominator, **derivation-aware**
  (a group left with one masked cell gets a second masked — the smallest *non-zero*
  survivor), rule footnote on every row, originals kept intact for QC. Verified by
  EXECUTION cell-by-cell plus 4 mutations. **Reproducibility provenance** (emitter
  version + canonical spec hash) stamped into SQL, SAS and the bundle README.
  **License files** finally shipped, with the AGPL-core-inside-Apache-shim
  contradiction resolved. **Results contract** (`<prefix>_results`) gives table shells
  one tidy shape and cannot leak a masked value.
  _Still open in Wave 4:_ Excel table shells / Word report, QC pack, and the
  IRB/DUA attestation surface.

**Next up: finish Wave 4 (table shells + QC pack), then Wave 5 (more analyses).**

---

## The three findings that reordered everything — ALL RESOLVED

> These were the audit's headline findings and the reason for the wave order.
> All three are now closed (Waves 0–2); the original text is kept below as the
> record of what was wrong and why the priorities changed.

### 1. ~~The verified modules are unreachable through the product~~ — FIXED in Wave 1
The four machine-verified modules (incidence rate, point/period prevalence, cumulative
incidence) cannot be produced by anything a user touches:

- the extractor's forced tool schema still exposes only the **legacy 7 `{type,enabled,notes}`**
  analysis types (`extract/prompt.ts:99-106`);
- `normalizeSpec` **force-disables every analysis except attrition and table1**
  (`extract/anthropic.ts:339-341`);
- the web `SpecReview` renders analyses as a **read-only comma-joined string** with no
  parameter editing and no add-analysis control (`SpecReview.tsx:1047-1056`);
- the shipped demo spec contains **zero enabled analyses of a registered kind**;
- the MCP resource `heor://schema/study-spec` **serves the legacy schema too**, so the
  keyless host-LLM path (Path A) is broken the same way as the keyed path (Path B).

Only a hand-authored JSON posted to `validate_spec` can reach them. "Protocol → verified
SAS/SQL" is true of the emitter, not of the product.

### 2. ~~Unimplemented analyses are dropped silently, and readiness says "ready"~~ — FIXED in Wave 0
`standardization`, `calendar_trend` and `statistical_engine` are valid spec kinds with no
registered emitter. A spec with all three **enabled** returns `specReadiness().ready === true`
with **zero problems** and emits **zero** files for them — while the AI-disclosure text prints
"Readiness at export: ready (no open problems)". `future_stub` is hard-blocked
(`types.ts:663-665`); these three are not. *Proven by execution during the audit.*

### 3. ~~"Machine-verified" is narrower than the docs say~~ — FIXED in Wave 2
- **Only the Postgres twin executes.** SAS is never run or parsed — 16 `.sas` files are
  checked by ~8-11 substring greps. Snowflake is never run, parsed, *or even grepped*
  (`verify/parity.ts:118` collects stamps from the Postgres emission only), so **14 of 28
  emitted SQL files carry zero automated verification** while shipping in every bundle.
- **The parity stamp comparison is structurally incapable of failing.** Both languages build
  the stamp by calling the *same builder* in `emitters/parity.ts` with values from the *same*
  helpers on the *same* spec object. 8 of 17 parity checks are tautologies. An auditor
  sabotaged the SAS twin (rate ×100, +1 day person-time, inverted setting filter) and
  **verification still passed**.
- **`run_verification` reports "passed" on an empty cohort** — every invariant is a
  count-of-violations query, and zero rows violates nothing (`verify/run.ts:29-40`).
- **There is no CI.** No `.github` directory exists; `npm run verify` has only ever run
  manually. Nothing gates a commit that breaks it.
- **The count is 206, not 207.** My night report was off by one. Exit status is genuinely 0
  with 0 failures.

---

## Confirmed defects in shipped code — ALL FIXED (Wave 3)

| # | Defect | Status |
|---|---|---|
| D1 | **SAS baseline off-by-one** — SAS implements `index - baseline_days` = baseline_days+1 covered days; the SQL twin and BR-CHT-003 disagree. The twins differ by a day. | **FIXED** (`497813e`) — SAS now uses `index - (N-1)`, matching SQL. Guarded by the spine fingerprint. |
| D2 | **Inpatient dx double-counted** whenever `admdate ≠ svcdate` (any stay > 1 day): the same diagnosis survives as two event rows with different dates, inflating counts and claim-separation logic. | **FIXED** (`abbfbbd`) — both inpatient sources dated at ADMDATE. Regression: fixture P14 (failed first). |
| D3 | **Enrollment stitching mishandles nested segments** — needs a running `MAX(dtend) OVER (...)`, not a lag comparison. | **FIXED** (`9963c16`) — running `MAX(dtend)` window. Regression: fixture P13 (failed first). |
| D4 | **`minClaims` means different things per language** — SAS counts distinct service dates, SQL counts rows. | **FIXED** (`abbfbbd`) — SQL counts DISTINCT service dates, matching SAS. Guarded. |
| D5 | **Age-at-index computed from two different sources** in the spine vs the analysis modules. | **FIXED** (`497813e`) — SAS derives age from enrollment DOBYR like SQL. Guarded (`age_from_dobyr`). |
| D6 | **NULL/open enrollment dates** filtered in SAS, not in SQL. | **FIXED** (`497813e`) — SQL excludes null enrolid/dtstart/dtend explicitly (BR-KEY-004). Guarded. |
| D7 | **SQL identifier injection** — `EmitOptions.tag` and `naming.prefix` flow unsanitized into emitted SQL; the SAS side has `sasName()`, SQL has no counterpart, and `validate_spec` does no type validation at all. | **FIXED** (`919c32d`, Wave 0) — identifiers validated in both emitters and at the MCP boundary. |
| D8 | **Death-censoring rationale contradicts our own BRD** — code cites "MarketScan mortality unavailable"; BR-LIM-002 says "severely limited, but not absent" (in-hospital death via DSTATUS). Person-time accrues past observed death. | **FIXED** (`e377fa2`) — wording matches BR-LIM-002; a requested death censor emits a REVIEW note and is no longer stamped as consumed. Guarded. |
| D9 | **MCP published artifact cannot execute** — build emits an unrunnable artifact, `"@heor-studio/core": "*"` is an unpublished dep, and nothing ever runs `dist/`. | **FIXED** (`e377fa2`) — core bundled into dist; smoke drives the BUILT artifact under plain node; CI builds it. |
| D10 | **`validate_spec` never calls `normalizeSpec`** — it casts and echoes the raw input, so invalid field types pass with `ready:true` and reach the emitter verbatim. | **MOSTLY FIXED** (`919c32d`, Wave 0) — `checkSpecShape` hard-rejects malformed specs and stores nothing. Remaining piece is defaulting/normalization, which is a convenience, not a safety gap. |
| D11 | **Bundle README lies about paths** — says `sql_postgres/`, actual is `sql_postgres/postgres/`. | **FIXED** (`919c32d`, Wave 0) — bundle paths match the README. |
| D12 | **`npm run lint` currently fails** (oxlint native binding) — one of the four scripts STATUS calls "green" is red. | **FIXED** (`ffc7040`, Wave 2) — lint runs (0 errors); root cause was a partial local install, lockfile was fine. |

---

## Compliance & deliverable gaps

- **No small-cell suppression anywhere** — every result table writes raw counts. Our own
  **BR-DEL-004 requires it**, and Gold Case A already emits cells of 1. Nothing leaves a real
  HEOR shop without this. Needs derivation-aware (complementary) masking, not just a threshold.
- **No results-dataset contract** (`table_id, row_label, column_label, stat, value, n,
  denominator, suppressed_flag`) — the product stops at `CREATE TABLE`; the deliverable is
  formatted tables.
- **No Excel table shells, no Word/PDF report, no QC pack, no data dictionary.**
- **No provenance/versioning in the bundle** — no emitter version, commit, schema version,
  data vintage, release version, data-cut date, or code-list version. Only a wall-clock
  timestamp. The determinism claim is unauditable without it.
- **No LICENSE files at all** — and the AGPL-core-inside-Apache-shim contradiction is unresolved.
- **No IRB / DUA / de-identification attestation surface.**
- **Root README is still the stock Vite + React template.**

---

## Domain gaps a MarketScan methodologist flagged

These would make a practitioner refuse the output; none were on our roadmap.

1. **No enrolled-panel (source-population) spine.** Every denominator is an index-event
   cohort, so the single most common claims paper — "prevalence among the N million
   continuously enrolled members in year Y" — **cannot be expressed at all**.
2. **`meta.studyPeriod` hard-filters the events table** and is never validated against the
   baseline lookback. A protocol whose "study period" means the identification window
   silently truncates every baseline comorbidity lookback. *Fails silently and plausibly —
   the most dangerous defect found.*
3. **No claims run-out / data-maturity handling and no data-cut date.** The last 3–6 months
   of any delivery are incomplete and every member's final DTEND is truncated, so the entire
   tail cohort looks disenrolled.
4. **Single-database only** — no pooled CCAE+MDCR (with the age-65 transition and ENROLID
   dedup), and MDCD is treated as CCAE with a renamed column, violating our own BR-LIM-008.
5. **Cost taxonomy missing the methodology, not just columns** — paid vs allowed vs billed vs
   COB, capitated-encounter exclusion, the MDCR Medicare portion, components-reconcile-to-net.
6. **No dollar-year / CPI construct** — no `dollarYear`, no index choice, no per-service-year
   vs total inflation rule. Our own acceptance criteria require the footnote.
7. **No service-setting or provider taxonomy, no facility/professional dedup** — one ED visit
   generates facility + professional lines; without FACPROF-aware dedup you report ~2× visits.
8. **Charlson/Elixhauser not first-class** — analysts must hand-enter ~17 code lists for a
   score every Table 1 reports. Needs bundled, versioned, citable ICD-9/ICD-10 mappings.
9. **No sensitivity-analysis construct** — every real SAP pre-specifies the same analysis
   under alternate parameterizations (narrow/broad list, 6/12-mo washout, minClaims 1/2).
10. **No design-validity pass** — nothing detects immortal time, post-index information in
    eligibility, or a baseline window overlapping follow-up. LLM-drafted specs fail this way,
    not with type errors.
11. **Age is calendar-year precision (DOBYR, ±1 year) used for hard 18/64 cut-offs** with no
    warning — contradicts BR-ENR-009.
12. **Not written for real volume** — no date/year pushdown into the yearly pulls, no column
    pruning, no dedup of the yearly UNION. `SELECT DISTINCT` over a decade of full O/S/I scans.
13. **`IndexEventRule` too thin** — no composite index, no Nth-event/re-entry rules, no
    same-day tie-breaking, new-user status not first-class.
14. **The tool does not refuse endpoints the data cannot support** — most importantly overall
    survival, which BR-LIM-002 says it *must* refuse.
15. **Enrollment hygiene unimplemented** — null-ENROLID exclusion as a counted attrition step
    (BR-KEY-004), RX coverage for every month of the analytic window (BR-ENR-007).

---

## Analysis coverage (the original scoreboard)

**7 of 70 done, 2 partial, 61 absent.**

| Tier | Done | Pending |
|---|---|---|
| P0 cohort spine | 2 | 0 |
| P1 core-descriptive | 5 | 5 |
| P2 economics + patterns | 0 | 21 |
| P3 causal + survival | 0 | 26 |
| P4 advanced | 0 | 11 |

Remaining P1, with real blockers:
- **Age/sex standardization** — reference-population weight tables (US 2000 / WHO / ESP)
  exist only as a type union with no data behind them; also needs a module *composition*
  mechanism (it composes over a base measure) and degrades to normal-approx CI in SQL.
  *Indirect* standardization additionally needs a schema widening (`method` is literally `"direct"`).
- **Calendar trend** — fixture indexes every patient on 2019-01-01, so there is no multi-period
  ground truth; needs a p-value policy (no chi-square CDF in SQL); `TrendSpec` is missing the
  three fields the matrix marks mandatory for the panel-churn safeguard.
- **Two-exposure-cohort spine + SMD balance table + two-group comparison** — `IndexEventRule`
  carries a single `codeListId`, and **no emitter has ever read `groupVars[]` or `comparisons[]`**.
  The fixture already plants armX/armY and pins `smdAge = -0.63246`, so the module is blocked
  purely on the spine partition. This also gates the entire P3 causal family.

Note: the matrix **double-counts incidence** — row 55 says "absent" for a capability row 7
marks "✅ done". Row 5 (prevalent-case washout) is marked done but none of its three named
deliverables (washout attrition addendum, reusable `{tag}_at_risk` table, toggle test) exist.

---

## Proposed sequence

**Wave 0 — Make silence impossible** ✅ DONE (`919c32d`)
Block enabled-but-unregistered analyses in readiness; gate `run_verification` on a non-empty
cohort; sanitize `tag`/prefix into SQL identifiers; make `validate_spec` actually validate;
correct the scope of the "machine-verified" claim in the docs and the bundle README.
_(Plus two injection vectors closed that the adversarial diff-review found.)_

**Wave 1 — Connect the ends** ✅ DONE (`0f173fd`, `aae0353`)
Replaced `SPEC_JSON_SCHEMA` with the real analysis-layer union (fixed the extractor *and* the
MCP schema resource); rewrote `normalizeSpec`'s analysis handling; built analysis editor cards
+ an add-analysis control in `SpecReview`; put descriptive-epi analyses in the demo spec.
_Remaining sub-item: run one real protocol on a funded key and check in the golden extraction
(needs a key — deferred to an interactive/funded session)._

**Wave 2 — Make the verifier able to fail**
Derive each parity stamp by parsing that language's own emitted text; add a Snowflake parse
gate (`sqlglot read=snowflake` — no account needed, would have caught the sabotage); add a SAS
syntactic check; mutation-test the harness; extend the fixture along the boundary axes
(31-day gap, nested segments, NULL dates, ICD-9 era, dx slots beyond dx1, same-day duplicates,
minClaims≥2, mid-follow-up disenrollment); add CI running typecheck/verify/smoke; fix `lint`.

**Wave 3 — Fix the confirmed defects** (D1–D12 above), each with a fixture case that fails first.

**Wave 4 — Deliverable + compliance layer** — ✅ mostly done (`b967596`, `9f595ee`, `dd91e71`)
✅ Small-cell suppression (spec field + derivation-aware masking + footnote) · ✅ results-dataset
contract · ✅ provenance/version stamping · ✅ LICENSE files · ⬜ Excel table shells / Word report
· ⬜ QC pack · ⬜ IRB/DUA attestation block.

**Wave 5 — Then expand analyses**
Enrolled-panel denominator spine → two-exposure-cohort spine → SMD/test-selection →
standardization → calendar trend → P2 economics (payment taxonomy *first*, then HCRU/cost/
adherence) → P3 → P4.

**Wave 6 — Launch** — MCPB bundle, npm publish, registry, Cloudflare deploy, trademark,
landing page, 5–10 practitioner interviews, ~50-case gold benchmark.

---

_Both adversarial challengers, working independently and from different angles (code truth vs
domain practice), converged on the same #1: **nothing else matters while the tool can emit a
green, confident bundle that quietly omits or truncates an analysis.**_
