/**
 * Verification-coverage guard — makes a BLIND SPOT impossible, the same way
 * modules/registry.ts makes a silently-dropped analysis impossible.
 *
 * The problem this closes: `fingerprint.ts`'s per-kind switch has no `default`.
 * A module whose stamp kind is not listed there still passes every parity check
 * — because there is almost nothing to compare. It reads as green while being
 * unverified. This is not hypothetical: `smd_balance` scraped exactly ONE
 * fingerprint value (`setting_filter`) until keys were added by hand, and it had
 * no `expectedFromStamp` entry at all, so its stamp was never cross-checked
 * against its own code.
 *
 * So every registered module must DECLARE its coverage in four places, and this
 * guard fails the suite if any is missing:
 *
 *   1. a real SQL fingerprint    (values scraped from the SQL twin's own text)
 *   2. a real SAS fingerprint    (values scraped from the SAS twin's own text)
 *   3. an EXPECTED_CONSTANTS profile (the CI constants, pinned per language)
 *   4. a suppression shape       (so results cannot skip disclosure control)
 *
 * It lives in verify/ rather than as a load-time throw in emitters/registry.ts
 * because emitters must not depend on the verification layer — CI runs this on
 * every push, which is the same practical gate without the circular import.
 */
import { emitSql } from "../emitters/sql";
import { emitSas } from "../emitters/sas";
import { parseParityStamps } from "../emitters/parity";
import { ANALYSIS_MODULES, STAMP_KIND_BY_ANALYSIS } from "../emitters/modules/registry";
import { SUPPRESSION_SHAPES } from "../emitters/suppression";
import { SHAPE_CHECKED_ANALYSIS_KINDS } from "../spec/shape";
import { EMITTABLE_ANALYSIS_KINDS } from "../spec/types";
import { fingerprint, expectedFromStamp, hasConstantProfile, STAMP_SHARED_KEYS } from "./fingerprint";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import { GOLD_B_SPEC, GOLD_B_OPTS } from "./fixture-b";
import { GOLD_C_SPEC, GOLD_C_OPTS } from "./fixture-c";
import { GOLD_D_SPEC, GOLD_D_OPTS } from "./fixture-d";
import { GOLD_E_SPEC, GOLD_E_OPTS } from "./fixture-e";
import { GOLD_F_SPEC, GOLD_F_OPTS } from "./fixture-f";
import { GOLD_G_SPEC, GOLD_G_OPTS } from "./fixture-g";
import type { Analysis, StudySpec } from "../spec/types";
import type { EmitOptions } from "../emitters/types";
import {
  STANDARD_POPULATIONS,
  STANDARD_POPULATIONS_PENDING,
  validateStandardPopulation,
  rebaseWeights,
  standardPopulationLabels,
  collapseReferenceToStudyBands,
  directlyStandardizedRate,
} from "../emitters/std-populations";
import type { Check } from "./run";

/** A fingerprint with only the always-present baseline key is not coverage.
 *  Anything at or below this count means the kind fell through the switch. */
const MIN_FINGERPRINT_KEYS = 3;

export function fingerprintCoverageChecks(): Check[] {
  const checks: Check[] = [];
  const kinds = Object.keys(ANALYSIS_MODULES) as Array<Analysis["kind"]>;

  /* EVERY gold spec, not just A.
   *
   * This used to emit from GOLD_A_SPEC alone, which quietly made "is this
   * module's fingerprint measurable?" mean "does Gold A happen to use it?".
   * Those are different questions, and the gap between them grew with every
   * gold case added: a module exercised thoroughly by its OWN fixture would
   * still be reported as uncovered, and the only way to clear the guard was to
   * bolt an unrelated analysis onto Gold A. Adherence is the first module whose
   * fixture cannot be folded into Gold A at all — it needs a fills feeder and a
   * refill pattern of its own — so the guard is fixed rather than worked
   * around. A kind is covered if ANY gold spec emits it in BOTH languages. */
  const GOLD_SPECS: Array<{ name: string; spec: StudySpec; opts: EmitOptions }> = [
    { name: "A", spec: GOLD_A_SPEC, opts: GOLD_A_OPTS },
    { name: "B", spec: GOLD_B_SPEC, opts: GOLD_B_OPTS },
    { name: "C", spec: GOLD_C_SPEC, opts: GOLD_C_OPTS },
    { name: "D", spec: GOLD_D_SPEC, opts: GOLD_D_OPTS },
    { name: "E", spec: GOLD_E_SPEC, opts: GOLD_E_OPTS },
    { name: "F", spec: GOLD_F_SPEC, opts: GOLD_F_OPTS },
    { name: "G", spec: GOLD_G_SPEC, opts: GOLD_G_OPTS },
  ];
  const emitted = GOLD_SPECS.map((g) => ({
    name: g.name,
    sql: emitSql(g.spec, "postgres", g.opts),
    sas: emitSas(g.spec, g.opts),
  }));
  const sasFiles = emitted[0].sas;
  const setup = sasFiles.find((f) => /setup/i.test(f.path))?.content ?? "";

  /** first emitted program of a stamp kind, per language */
  const firstOf = (files: Array<{ content: string }>, stampKind: string) => {
    for (const f of files) {
      for (const s of parseParityStamps(f.content)) {
        if (s.kind === stampKind) return { content: f.content, stamp: s.values };
      }
    }
    return undefined;
  };

  /* THE THIRD LIST. Registering a module has to teach three places about the
   * new kind: the emitter registry, EMITTABLE_ANALYSIS_KINDS (readiness), and
   * the structural gate in spec/shape.ts. The registry throws at load time if
   * the first two disagree; nothing watched the third, and treatment_switching
   * shipped with the MCP server rejecting its own demo spec while every
   * emitter was happy. */
  for (const kind of EMITTABLE_ANALYSIS_KINDS) {
    checks.push({
      name: `coverage ${kind}: the structural gate knows this kind`,
      status: SHAPE_CHECKED_ANALYSIS_KINDS.has(kind) ? "pass" : "fail",
      detail: SHAPE_CHECKED_ANALYSIS_KINDS.has(kind)
        ? "spec/shape.ts accepts it, so untrusted JSON carrying it can reach the emitters"
        : `spec/shape.ts does NOT list "${kind}", so checkSpecShape rejects any spec containing it — the MCP server and the chat would refuse a spec the emitters can generate`,
    });
  }

  for (const kind of kinds) {
    const stampKind = STAMP_KIND_BY_ANALYSIS[kind];
    const label = `${kind} (stamp "${stampKind}")`;

    // 4. suppression shape — declared statically, checkable without emission
    checks.push({
      name: `coverage ${label}: has a suppression shape`,
      status: SUPPRESSION_SHAPES[stampKind] ? "pass" : "fail",
      detail: SUPPRESSION_SHAPES[stampKind]
        ? "results cannot skip disclosure control"
        : `no SUPPRESSION_SHAPES["${stampKind}"] — this module's results would ship UNSUPPRESSED`,
    });

    // 3. pinned CI-constant profile
    checks.push({
      name: `coverage ${label}: has a pinned CI-constant profile`,
      status: hasConstantProfile(stampKind) ? "pass" : "fail",
      detail: hasConstantProfile(stampKind)
        ? "a mistyped statistical constant is detectable"
        : `no EXPECTED_CONSTANTS["${stampKind}"] — a mistyped z or z^2 would ship silently`,
    });

    /* The first gold spec that emits this kind in BOTH languages. Searching
     * rather than assuming Gold A is the whole fix — see GOLD_SPECS above. */
    let sq: ReturnType<typeof firstOf>;
    let sa: ReturnType<typeof firstOf>;
    let source = "";
    for (const g of emitted) {
      const a = firstOf(g.sql, stampKind);
      const b = firstOf(g.sas, stampKind);
      if (a && b) { sq = a; sa = b; source = g.name; break; }
    }
    if (!sq || !sa) {
      // No gold spec exercises this kind, so its fingerprints cannot be
      // measured at all. Say so rather than passing by omission.
      checks.push({
        name: `coverage ${label}: exercised by a gold spec`,
        status: "fail",
        detail: `no ${stampKind} program emitted in BOTH languages by any of ${emitted.map((g) => g.name).join("/")} — add an analysis of this kind to a fixture so its coverage is measurable`,
      });
      continue;
    }
    checks.push({
      name: `coverage ${label}: exercised by a gold spec`,
      status: "pass",
      detail: `emitted in both languages by Gold Case ${source}`,
    });

    // 1 + 2. real fingerprints in BOTH languages
    for (const [lang, prog] of [["sql", sq], ["sas", sa]] as const) {
      const fp = fingerprint(stampKind, lang, prog.content, lang === "sas" ? setup : "");
      const n = Object.keys(fp).length;
      checks.push({
        name: `coverage ${label}: ${lang} fingerprint is non-trivial`,
        status: n >= MIN_FINGERPRINT_KEYS ? "pass" : "fail",
        detail:
          n >= MIN_FINGERPRINT_KEYS
            ? `${n} values scraped from the ${lang} twin's own code`
            : `only ${n} value(s) scraped (${Object.keys(fp).join(", ") || "none"}) — this kind falls through the ${lang} fingerprint switch and is effectively UNVERIFIED`,
      });
    }

    // the stamp must be cross-checkable against the code
    const exp = expectedFromStamp(stampKind, sq.stamp);
    /* Only KIND-SPECIFIC keys count. setting_filter is set for every stamp that
     * carries one, so a bare non-emptiness test passed for kinds with no case
     * in the switch at all — which is how three modules shipped with a stamp
     * that was never cross-checked. */
    const expSpecific = Object.keys(exp).filter((k) => !STAMP_SHARED_KEYS.has(k));
    checks.push({
      name: `coverage ${label}: stamp is cross-checked against the code`,
      status: expSpecific.length >= 1 ? "pass" : "fail",
      detail:
        expSpecific.length >= 1
          ? `${expSpecific.length} kind-specific stamp value(s) asserted against the emitted code (${expSpecific.join(", ")})`
          : `expectedFromStamp("${stampKind}") returns no KIND-SPECIFIC expectation (only ${Object.keys(exp).join(", ") || "nothing"}) — the PARITY stamp is never compared to what the code actually does`,
    });
  }

  return checks;
}

/** Prove the coverage guard can FAIL.
 *
 *  A guard that has only ever been green is an unproven guard — the same
 *  argument that produced the mutation suite. Here the "mutation" is a stamp
 *  kind that no fingerprint case handles, which is exactly the state
 *  `smd_balance` was in: it must come back with almost nothing and be reported
 *  as unverified rather than passing by silence. */
export function coverageGuardSelfTest(): Check[] {
  const UNKNOWN = "kind_that_no_fingerprint_case_handles";
  const sqlFiles = emitSql(GOLD_A_SPEC, "postgres", GOLD_A_OPTS);
  const sample = sqlFiles.find((f) => /incidence/.test(f.path))?.content ?? "";

  const fp = fingerprint(UNKNOWN, "sql", sample);
  const n = Object.keys(fp).length;
  const exp = expectedFromStamp(UNKNOWN, { rateMultiplier: 1000, imbalanceThreshold: 0.1 });

  return [
    {
      name: "coverage self-test: an unhandled kind yields a trivial fingerprint",
      status: n < MIN_FINGERPRINT_KEYS ? "pass" : "fail",
      detail:
        n < MIN_FINGERPRINT_KEYS
          ? `${n} key(s) — below the ${MIN_FINGERPRINT_KEYS}-key floor, so the guard would flag it`
          : `${n} keys scraped for a kind nothing handles — the floor no longer detects a blind spot`,
    },
    {
      name: "coverage self-test: an unhandled kind has no stamp cross-check",
      status: Object.keys(exp).length === 0 ? "pass" : "fail",
      detail:
        Object.keys(exp).length === 0
          ? "expectedFromStamp returns nothing, as the guard expects"
          : `returned ${Object.keys(exp).join(", ")} for an unknown kind`,
    },
    {
      name: "coverage self-test: suppression + constants lookups miss an unknown kind",
      status: !SUPPRESSION_SHAPES[UNKNOWN] && !hasConstantProfile(UNKNOWN) ? "pass" : "fail",
      detail: "an unregistered kind is absent from both static maps",
    },
  ];
}


/** Standard reference-population constants.
 *
 *  Direct standardization is a weighted average, so the weights ARE the result.
 *  A single mistyped figure shifts every standardized rate a study publishes and
 *  looks entirely plausible doing it. The sum check is the protection: it turns
 *  a transcription error into a failure. */
export function standardPopulationChecks(): Check[] {
  const checks: Check[] = [];

  for (const p of Object.values(STANDARD_POPULATIONS)) {
    if (!p) continue;
    const v = validateStandardPopulation(p);
    const sum = p.bands.reduce((a, b) => a + b.weight, 0);
    checks.push({
      name: `std population ${p.id}: weights sum to the published total`,
      status: v.ok ? "pass" : "fail",
      detail: v.ok
        ? `${p.bands.length} bands summing to exactly ${sum.toLocaleString()}`
        : v.problems.join(" | "),
    });
    checks.push({
      name: `std population ${p.id}: band labels match the stratum grammar`,
      status: standardPopulationLabels(p).every((l) => /^\d+(-\d+|\+)$/.test(l)) ? "pass" : "fail",
      detail: standardPopulationLabels(p).join(", "),
    });
  }

  /* Rebasing must REPORT its own incompleteness. A cohort covering half the
   * reference is standardizable, but the resulting rate is not comparable to a
   * published one — so the covered share is a required output, not a footnote. */
  const us = STANDARD_POPULATIONS.us_2000;
  if (us) {
    const rb = rebaseWeights(us, [35, 45, 55, 65]);
    const sharesSumToOne = Math.abs(rb.weights.reduce((a, w) => a + w.share, 0) - 1) < 1e-9;
    checks.push({
      name: "std population rebasing: shares renormalize to 1 and report coverage",
      status: sharesSumToOne && rb.coveredWeightPct > 0 && rb.coveredWeightPct < 100 ? "pass" : "fail",
      detail: `covers ${rb.coveredWeightPct}% of the reference; rebased shares sum to ${rb.weights.reduce((a, w) => a + w.share, 0).toFixed(6)}`,
    });
  }

  /* Band alignment. Direct standardization is only DEFINED when each study band
   * is a union of whole reference bands; a boundary inside a reference band
   * would need an assumed within-band age distribution, which is an invented
   * number. The gold fixture's own default banding fails this — its boundary at
   * 18 cuts US 2000's 15-24 band — so the refusal is exercised by real data,
   * not a contrived case. */
  if (us) {
    const bad = collapseReferenceToStudyBands(us, [0, 18, 35, 45, 55, 65]);
    checks.push({
      name: "std population: misaligned study bands are REFUSED, not interpolated",
      status: !bad.ok && (bad.problem ?? "").includes("18") ? "pass" : "fail",
      detail: bad.ok
        ? "accepted a banding whose boundary at 18 splits the reference's 15-24 band"
        : "names the offending boundary and the reference's own boundaries",
    });

    const good = collapseReferenceToStudyBands(us, [45, 55, 65]);
    const terminalCollapsed = good.weights.find((w) => w.lower === 65)?.weight;
    checks.push({
      name: "std population: aligned bands collapse, terminal band included",
      status: good.ok && terminalCollapsed === 66_037 + 44_842 + 15_508 ? "pass" : "fail",
      detail: good.ok
        ? `65+ = ${terminalCollapsed?.toLocaleString()} (65-74 + 75-84 + 85+); covers ${good.coveredWeightPct}%`
        : (good.problem ?? ""),
    });

    /* DSR over the fixture's own pinned incidence strata (45-54 = 1826.25/1000 PY,
     * 55-64 = 0, 65+ = 0), hand-computed:
     *   134,834 x 1826.25 / 348,468 = 706.64 per 1000 PY */
    const { dsr, totalWeight } = directlyStandardizedRate(
      [{ lower: 45, rate: 1826.25 }, { lower: 55, rate: 0 }, { lower: 65, rate: 0 }],
      good.weights,
    );
    checks.push({
      name: "std population: DSR over the fixture's pinned strata = 706.64 per 1000 PY",
      status: Math.abs(dsr - 706.64) < 0.01 && totalWeight === 348_468 ? "pass" : "fail",
      detail: `got ${dsr.toFixed(2)} with total weight ${totalWeight.toLocaleString()} (hand-computed 134,834 x 1826.25 / 348,468)`,
    });
  }

  /* CROSS-SOURCE verification, the strongest check available here: the bundled
   * 21-band ESP 2013 plus the collapse algebra must REPRODUCE an independently
   * published 19-band ESP vector (R PHEindicatormethods), which collapses
   * <1 + 1-4 and 90-94 + 95+. Agreement means two separately-sourced
   * transcriptions and the band arithmetic all concur — a typo in any one of
   * them breaks it. */
  const esp = STANDARD_POPULATIONS.esp_2013;
  if (esp) {
    const r19Bands = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
    const R19_PUBLISHED = [5000, 5500, 5500, 5500, 6000, 6000, 6500, 7000, 7000, 7000, 7000, 6500, 6000, 5500, 5000, 4000, 2500, 1500, 1000];
    const derived = collapseReferenceToStudyBands(esp, r19Bands);
    const match = derived.ok && JSON.stringify(derived.weights.map((w) => w.weight)) === JSON.stringify(R19_PUBLISHED);
    checks.push({
      name: "std population esp_2013: collapse reproduces an INDEPENDENT published 19-band vector",
      status: match ? "pass" : "fail",
      detail: match
        ? "bundled 21-band data + collapse algebra == R PHEindicatormethods esp2013, both totalling 100,000"
        : `derived [${derived.weights.map((w) => w.weight).join(",")}] vs published [${R19_PUBLISHED.join(",")}]`,
    });
  }

  /* A population we do not carry must be REFUSED by name, with a citation of
   * what to transcribe — never silently swapped for one we do carry, which
   * would relabel the rate while changing it. */
  for (const [id, reason] of Object.entries(STANDARD_POPULATIONS_PENDING)) {
    const bundled = (STANDARD_POPULATIONS as Record<string, unknown>)[id] !== undefined;
    checks.push({
      name: `std population ${id}: refused with a citation rather than substituted`,
      status: !bundled && reason.length > 60 ? "pass" : "fail",
      detail: bundled ? `${id} is both bundled and listed as pending` : "names the source to transcribe and sum-check",
    });
  }

  return checks;
}
