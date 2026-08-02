# HEOR Studio — Learning Protocol

How the tool absorbs "this is wrong" without ever becoming rigid, and without ever
sacrificing correctness.

---

## The tension this resolves

HEOR Studio's whole credibility rests on two properties that pull against each other:

- **Correctness** — the emitters are deterministic and every number is machine-verified
  against a fixture. That rigor is the product.
- **Humility** — no tool that generates statistical code for regulated studies can assume it
  is always right. Analysts, sites, and data vintages differ. A tool that answers "no, you're
  wrong" and moves on will be abandoned.

The resolution: **the tool learns by turning human corrections into new tests and new options —
never by silently changing behavior.** Correctness is preserved because nothing changes without
human review and a regression test. Rigidity is avoided because everything genuinely contestable
becomes a parameter or a documented choice.

---

## Three principles

### 1. Learn through tests and options, never through silent behavior change
A correction never quietly alters how code is generated. It resolves into exactly one of:
- a **new gold case + emitter fix** (if the output was wrong), so the bug can never silently return;
- a **new spec option** (if it was a legitimate methodological choice), so the analyst decides;
- a **documented rule or UI/label change** (if it was a wording or clarity issue).

There is **no online learning, no model fine-tuning on corrections, and no heuristic that mutates
statistical logic from unvetted input.** Those would trade away the one thing that makes the tool
trustworthy.

### 2. Capture is local; sharing is the analyst's choice
Consistent with the privacy architecture, a correction is captured **on the analyst's own machine**
and **nothing is transmitted**. The tool formats the correction as a ready-to-share record; the
analyst chooses whether to send it upstream (a GitHub issue/PR). The learning loop is:

> local capture → analyst-initiated upstream share → maintainer review → gold case / option / doc →
> everyone benefits on the next release.

### 3. Always ask *why*, and record it
A bare "this is wrong" is not actionable and — more importantly — treating it as a yes/no verdict is
exactly the rigidity we reject. Every correction **requires a reason** (`newCorrection` throws
without one). The reason is what lets a maintainer tell a real bug from a site preference from a
misunderstanding. The tool's stance is never "you're wrong" or "we're right" — it is *"tell us why,
and we'll route it."*

---

## The correction record

Defined in `packages/core/src/feedback/types.ts`. Stored one JSON per correction under
`corrections/` (git-tracked → auditable, reviewable, versioned). Key fields:

| Field | Meaning |
|---|---|
| `target` | what is being contested: `generated_code` / `business_rule` / `spec_field` / `code_list` / `statistic` / `terminology`, plus a `ref` (e.g. `07_incidence.sql`, `BR-FIN-001`, a rate value) |
| `claim` | what the analyst says is wrong |
| **`reason`** | **required** — why they believe so |
| `suggestedCorrect` | what they think it should be (optional) |
| `classification` | see routing table (default `unclassified`) |
| `status` | `open` → `under_review` → `accepted` / `declined` / `deferred` |
| `resolution` | the durable outcome, incl. the gold-case id / spec field / BRD rule / commit that closed it |

No PII is required; `reporter` (role/org) is optional.

---

## Classification → routing

Every accepted correction lands on a **durable, reviewable outcome**. Nothing dead-ends in a "no".

| Classification | Meaning | Durable outcome |
|---|---|---|
| `correctness_bug` | the generated output is wrong | **failing gold case** reproducing it → emitter fix → gold case passes → commit |
| `methodological_choice` | legitimately contestable method | **new spec option** with a sensible default; document both choices |
| `site_preference` | licensee/environment-specific | **config surfaced in the spec**, never silently defaulted |
| `data_vintage` | MarketScan vintage difference | confirm against the licensee's dictionary → config or documented note |
| `terminology` | naming/label/wording | BRD or UI label update |
| `misunderstanding` | output correct, but unclear | **UI/doc clarification** — the review surface failed, so improve it |

Even a "misunderstanding" produces an improvement (clearer review UI or docs). The tool is never
merely defensive.

---

## The workflow

1. **Capture** — analyst flags something via the MCP `report_correction` tool (or opens an issue).
   The tool refuses to record without a reason. A JSON lands in the local `corrections/` ledger.
2. **Classify** — a maintainer sets `classification` (or confirms the analyst's).
3. **Route** — per the table above.
4. **Encode as a test** — the resolution is written as a regression: a gold case (bug), an option
   with its own verified test (choice), or a doc/label diff. This is the step that makes the fix
   permanent and the learning real.
5. **Release & close** — set `status: accepted`, record the `resolution` (gold-case id / spec field
   / commit). The correction stays in the ledger as the audit trail.

This ledger doubles as the tool's **continuous-improvement / audit record** — the kind of trail
HTA and regulatory reviewers value, and it feeds the AI-methods disclosure a study reports.

---

## Two worked examples (both real, from the build itself)

### Example 1 — a methodological choice became an option
- **Claim:** "the incidence rate uses 365.25; our deliverables use 365."
- **Reason:** a widely used adverse-event rate convention annualizes with a 365-day year.
- **Classification:** `methodological_choice`.
- **Resolution (`new_spec_option`):** added `spec.meta.daysPerYear` (default 365.25, analyst may set
  365), documented both; the value lives in the spec so results stay reproducible. **Closed.**

### Example 2 — a correctness bug became a permanent test
- **Claim:** "with `daysPerYear=365` the rate comes out 451, not 451.55."
- **Reason:** an integer constant made the SQL do integer division.
- **Classification:** `correctness_bug`.
- **Resolution (`emitter_fix_with_gold_case`):** render the constant as a decimal literal;
  regression guard `verifyDaysPerYearChoice` asserts 365.25→451.86 and 365→451.55 forever. **Closed.**

Both were surfaced *by verifying a change the owner requested* — which is the protocol working as
intended: a request → a check → a discovered issue → a permanent test/option.

---

## What we will explicitly NOT do

- **No auto-learning / fine-tuning** on corrections that changes generation.
- **No phoning home** — corrections never leave the analyst's machine unless they send them.
- **No silent statistic changes** — a contested number is never quietly re-computed a new way;
  it becomes an option or a reviewed fix.
- **No "you're wrong, end of discussion."** Every correction is captured, reasoned, and routed.
