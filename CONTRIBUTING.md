# Contributing

The bar here is unusual and worth stating before you spend time: **a change that
cannot be verified does not land.**

## The gate

```bash
npm run verify
```

This runs everything — the emitted SQL executed against hand-derived fixtures,
cross-language fingerprints, mutation tests, readiness guards, SAS structural
lint, and the coverage guard. It must end `0 failing`. CI runs the same command
on every push and pull request.

Also: `npm run typecheck`, `npm run lint`, `npm run mcp:smoke`, `npm run build`.

## Adding an analysis module

1. `packages/core/src/emitters/modules/<kind>.ts` — SAS and SQL twins. Copy the
   shape of `modules/incidence.ts`, which is the reference.
2. Register it in `modules/registry.ts`. Three load-time throws will tell you
   what else is missing (readiness entry, suppression shape, fingerprint set).
3. **Hand-derive the ground truth first**, as exact fractions, and write it into
   `verify/fixture.ts` before you run anything. If the executed value disagrees
   with your derivation, recompute both independently — do not assume the code is
   right. That has caught real defects more than once.
4. Add fingerprints in `verify/fingerprint.ts` for both twins, and a
   `expectedFromStamp` case so the PARITY stamp is cross-checked against the code.
5. Add mutations in `verify/mutation.ts`. Each must be **caught**, and each must
   use `/g` — a non-global `replace` corrupts only the first occurrence, the
   survivors satisfy any loose check, and the test then passes for the wrong
   reason. The harness now detects that automatically; if yours is legitimately
   non-idempotent, declare `notIdempotent` with the reason.

## Fixtures

Gold Case A is **frozen**. An extra indexed patient there moves attrition, the
at-risk count, the person-days and every rate, prevalence, SMD and regression
estimate simultaneously. New cases are **separate seeds** (B, C, D, E …), each
hand-derived patient by patient, each built to exercise something the others
structurally cannot — ties, competing risks, fractional weights.

## Refusing things

If an analysis cannot be computed honestly, refuse it in `specReadiness` **with
the reason in the message**, and add a guard asserting the refusal fires. Say
plainly whether it is a refusal or an unbuilt gap — "not emitted" reads
identically for both, and the distinction is what a user needs.

See `docs/ROADMAP.md` for what is already refused and why.
