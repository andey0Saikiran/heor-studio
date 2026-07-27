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
import { fingerprint, expectedFromStamp, hasConstantProfile } from "./fingerprint";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import type { Analysis } from "../spec/types";
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

  const sqlFiles = emitSql(GOLD_A_SPEC, "postgres", GOLD_A_OPTS);
  const sasFiles = emitSas(GOLD_A_SPEC, GOLD_A_OPTS);
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

    const sq = firstOf(sqlFiles, stampKind);
    const sa = firstOf(sasFiles, stampKind);
    if (!sq || !sa) {
      // The gold spec does not exercise this kind, so its fingerprints cannot be
      // measured here. Say so rather than passing by omission.
      checks.push({
        name: `coverage ${label}: exercised by the gold spec`,
        status: "fail",
        detail: `no ${stampKind} program emitted in ${!sq ? "SQL" : "SAS"} from GOLD_A_SPEC — add an analysis of this kind to the fixture so its coverage is measurable`,
      });
      continue;
    }

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
    const expKeys = Object.keys(exp).length;
    checks.push({
      name: `coverage ${label}: stamp is cross-checked against the code`,
      status: expKeys >= 1 ? "pass" : "fail",
      detail:
        expKeys >= 1
          ? `${expKeys} stamp value(s) asserted against the emitted code`
          : `expectedFromStamp("${stampKind}") returns nothing — the PARITY stamp is never compared to what the code actually does`,
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

  return checks;
}
