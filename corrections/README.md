# Corrections ledger

The git-tracked record of every "this is wrong" HEOR Studio has been told, and how it was
resolved. This is the tool's learning memory — see [docs/LEARNING-PROTOCOL.md](../docs/LEARNING-PROTOCOL.md).

One JSON file per correction (schema: `packages/core/src/feedback/types.ts`). Corrections are
captured **locally** on an analyst's machine and shared here only when the analyst chooses to.
Nothing phones home.

**The rule:** a correction never silently changes how code is generated. Every accepted one resolves
into a durable, reviewed outcome and is encoded as a **regression test**:

| Classification | Becomes |
|---|---|
| `correctness_bug` | a failing gold case → emitter fix → the gold case guards it forever |
| `methodological_choice` | a new spec option (analyst decides), with its own verified test |
| `site_preference` / `data_vintage` | a config surfaced in the spec / BRD |
| `terminology` | a label or doc change |
| `misunderstanding` | a UI/doc clarification (the review surface failed — improve it) |

Every correction carries a **reason** — the tool always asks why. Bare "this is wrong" is not
recordable (`newCorrection` throws without a reason).

## Ledger

| id | target | classification | status | resolution |
|---|---|---|---|---|
| `daysperyear-*` | `spec_field` daysPerYear | methodological_choice | accepted | new spec option `spec.meta.daysPerYear` |
| `07_incidence-*` | `generated_code` 07_incidence.sql | correctness_bug | accepted | decimal-literal fix + `verifyDaysPerYearChoice` gold guard |
