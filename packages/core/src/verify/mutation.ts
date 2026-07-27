/**
 * Mutation tests — the standing proof that parity verification can FAIL.
 *
 * A verification suite that only ever runs against correct code proves
 * nothing about its own sensitivity. The stamp-only parity checks looked
 * green for months while being structurally incapable of failing (both
 * languages built the stamp from the same spec object), and an adversarial
 * review demonstrated it by sabotaging the SAS twin without turning anything
 * red.
 *
 * So: deliberately corrupt the emitted code — the way a bad edit or a
 * copy-paste slip actually would — and assert the fingerprint comparison
 * catches every corruption. Each mutation asserts twice:
 *
 *   1. the mutation ACTUALLY changed the text (else the test is vacuous and
 *      would "pass" by doing nothing);
 *   2. the resulting fingerprint mismatch is detected.
 *
 * A mutation that stops being caught means the harness lost sensitivity —
 * which is exactly the regression this file exists to prevent.
 */
import { emitSql } from "../emitters/sql";
import { emitSas } from "../emitters/sas";
import { parseParityStamps } from "../emitters/parity";
import {
  fingerprint,
  expectedFromStamp,
  diffFingerprints,
  diffAgainstExpected,
  constantProfile,
  diffConstantProfile,
} from "./fingerprint";
import { sasStructureChecks } from "./sas-lint";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import type { Check } from "./run";

interface Mutation {
  /** what a reviewer would call this defect */
  name: string;
  /** parity kind whose program to corrupt */
  kind: string;
  /** which twin to corrupt */
  lang: "sql" | "sas";
  /** corrupt the analysis program (or the SAS setup file when `setup` is true) */
  apply: (text: string) => string;
  /** mutate 00_setup.sas instead of the analysis program */
  setup?: boolean;
}

/** Corruptions that MUST be caught. Each mirrors a real failure mode:
 *  a mistyped constant, a dropped predicate, a wrong unit, a flipped filter. */
const MUTATIONS: Mutation[] = [
  {
    name: "SAS rate is 100x too large (multiplier 1000 -> 100000)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(rate_per_1000py\s*=\s*round\(\s*patients\s*\*\s*)1000(\s*\*)/i, "$1100000$2"),
  },
  {
    name: "SAS person-time constant drifts (365.25 -> 365 in 00_setup)",
    kind: "incidence", lang: "sas", setup: true,
    apply: (t) => t.replace(/(%let\s+days_per_year\s*=\s*)365\.25/i, "$1365"),
  },
  {
    // Targets the admin_censor EXPRESSION, not the comment above it that
    // describes the same arithmetic — a mutation that only edits prose proves
    // nothing (the first version of this test did exactly that and "passed").
    name: "SAS adds a day to every patient's follow-up (+365 -> +366)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(min\([^;]*?index_date\s*\+\s*)365(\s*\)\s*as admin_censor)/i, "$1366$2"),
  },
  {
    name: "SAS care-setting filter inverted (outpatient -> inpatient)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(e\.setting\s*=\s*')OP(')/i, "$1IP$2"),
  },
  {
    name: "SAS washout upper bound dropped (prevalent cases leak in)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/and\s+e\.svcdate\s*<=\s*a\.index_date\s*;/i, ";"),
  },
  {
    name: "SAS counts events ON the index date too (> becomes >=)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/(e\.svcdate\s*)>(\s*a\.index_date)/i, "$1>=$2"),
  },
  {
    name: "SAS Byar CI loses its cube (**3 dropped)",
    kind: "incidence", lang: "sas",
    apply: (t) => t.replace(/\*\*\s*3/, "**1"),
  },
  {
    name: "SQL washout window widened (365 -> 730 days)",
    kind: "incidence", lang: "sql",
    apply: (t) => t.replace(/(index_date\s*-\s*)365(\s*\))/i, "$1730$2"),
  },
  {
    name: "SQL point-prevalence anchor date shifted",
    kind: "point_prevalence", lang: "sql",
    apply: (t) => t.replace(/DATE\s*'2019-07-20'/i, "DATE '2019-08-20'"),
  },
  {
    name: "SQL risk horizon doubled (365 -> 730)",
    kind: "cumulative_incidence", lang: "sql",
    apply: (t) => t.replace(/(index_date\s*\+\s*)365\b/i, "$1730"),
  },
  {
    name: "SQL Wilson z^2/2 constant mistyped (1.9208 -> 1.96)",
    kind: "point_prevalence", lang: "sql",
    apply: (t) => t.replace(/1\.9208/, "1.96"),
  },
  {
    name: "SAS period-prevalence window shifted by a year",
    kind: "period_prevalence", lang: "sas",
    apply: (t) => t.replace(/'01JAN2019'd/i, "'01JAN2018'd"),
  },
];

interface Program {
  content: string;
  kind: string;
  stamp: Record<string, unknown>;
}

/** First emitted program carrying a stamp of the given kind, per language. */
function programsByKind(files: Array<{ path: string; content: string }>): Map<string, Program> {
  const out = new Map<string, Program>();
  for (const f of files) {
    for (const s of parseParityStamps(f.content)) {
      if (!out.has(s.kind)) out.set(s.kind, { content: f.content, kind: s.kind, stamp: s.values });
    }
  }
  return out;
}

/** Run every mutation and report whether the harness catches it. */
export function mutationChecks(): Check[] {
  const checks: Check[] = [];
  const sqlFiles = emitSql(GOLD_A_SPEC, "postgres", GOLD_A_OPTS);
  const sasFiles = emitSas(GOLD_A_SPEC, GOLD_A_OPTS);
  const setup = sasFiles.find((f) => /setup/i.test(f.path))?.content ?? "";
  const sqlByKind = programsByKind(sqlFiles);
  const sasByKind = programsByKind(sasFiles);

  for (const m of MUTATIONS) {
    const sqlProg = sqlByKind.get(m.kind);
    const sasProg = sasByKind.get(m.kind);
    if (!sqlProg || !sasProg) {
      checks.push({ name: `mutation: ${m.name}`, status: "fail", detail: `no ${m.kind} program emitted in both languages` });
      continue;
    }

    // Apply the corruption to exactly one artifact.
    const mutatedSetup = m.setup ? m.apply(setup) : setup;
    const mutatedSql = m.lang === "sql" && !m.setup ? m.apply(sqlProg.content) : sqlProg.content;
    const mutatedSas = m.lang === "sas" && !m.setup ? m.apply(sasProg.content) : sasProg.content;

    const changed = m.setup
      ? mutatedSetup !== setup
      : m.lang === "sql"
        ? mutatedSql !== sqlProg.content
        : mutatedSas !== sasProg.content;

    if (!changed) {
      // The pattern no longer matches the emitted code: the mutation is a
      // no-op, so "caught" would be meaningless. Fail loudly instead.
      checks.push({
        name: `mutation: ${m.name}`,
        status: "fail",
        detail: "mutation pattern did not match the emitted code — the test is vacuous; update the pattern",
      });
      continue;
    }

    const fpSql = fingerprint(m.kind, "sql", mutatedSql);
    const fpSas = fingerprint(m.kind, "sas", mutatedSas, mutatedSetup);
    const crossLang = diffFingerprints(fpSql, fpSas);
    const vsStampSql = diffAgainstExpected(fpSql, expectedFromStamp(m.kind, sqlProg.stamp));
    const vsStampSas = diffAgainstExpected(fpSas, expectedFromStamp(m.kind, sasProg.stamp));
    const constSql = diffConstantProfile(m.kind, "sql", constantProfile("sql", mutatedSql));
    const constSas = diffConstantProfile(m.kind, "sas", constantProfile("sas", mutatedSas, mutatedSetup));

    const reasons = [
      crossLang.length > 0 ? `cross-language: ${crossLang.join(" | ")}` : "",
      vsStampSql.length + vsStampSas.length > 0 ? `vs stamp: ${[...vsStampSql, ...vsStampSas].join(" | ")}` : "",
      constSql.length + constSas.length > 0 ? `constants: ${[...constSql, ...constSas].join(" | ")}` : "",
    ].filter(Boolean);
    const caught = reasons.length > 0;
    const how = reasons.join("; ");
    checks.push({
      name: `mutation caught: ${m.name}`,
      status: caught ? "pass" : "fail",
      detail: caught ? how : "NOT CAUGHT — the harness is blind to this corruption",
    });
  }

  checks.push(...sasStructureMutationChecks());
  return checks;
}

/** Corruptions the SAS STRUCTURAL lint must catch. Same principle as above: a
 *  structural check that has never gone red is an unproven check. */
const SAS_STRUCTURE_MUTATIONS: Array<{ name: string; apply: (t: string) => string }> = [
  {
    name: "SAS proc sql left unclosed (missing quit;)",
    apply: (t) => t.replace(/\bquit\s*;/i, ""),
  },
  {
    name: "SAS data step left unclosed (missing run;)",
    apply: (t) => t.replace(/\brun\s*;/i, ""),
  },
  {
    // Anchored on the _byar_low ASSIGNMENT: the first `sqrt(` in the file is
    // inside the comment that explains the formula, and corrupting prose
    // proves nothing (this mutation "passed" that way until it was retargeted).
    name: "SAS expression left with an unbalanced parenthesis",
    apply: (t) => t.replace(/(_byar_low\s*=\s*)\(/i, "$1(("),
  },
  {
    name: "SAS block comment left unterminated",
    apply: (t) => t.replace(/\*\//, " "),
  },
  {
    name: "SAS references an undefined macro variable",
    apply: (t) => t.replace(/&days_per_year\./i, "&days_per_yr."),
  },
  {
    name: "SAS analysis program loses its %include of 00_setup",
    apply: (t) => t.replace(/%include\s+["'][^"']*setup[^"']*["']\s*;/i, ""),
  },
];

function sasStructureMutationChecks(): Check[] {
  const checks: Check[] = [];
  const files = emitSas(GOLD_A_SPEC, GOLD_A_OPTS);
  const targetIdx = files.findIndex((f) => /incidence/i.test(f.path));
  if (targetIdx < 0) {
    return [{ name: "sas structure mutations", status: "fail", detail: "no incidence SAS program emitted" }];
  }

  for (const m of SAS_STRUCTURE_MUTATIONS) {
    const mutated = files.map((f, i) => (i === targetIdx ? { ...f, content: m.apply(f.content) } : f));
    if (mutated[targetIdx].content === files[targetIdx].content) {
      checks.push({
        name: `sas structure mutation: ${m.name}`,
        status: "fail",
        detail: "mutation pattern did not match — the test is vacuous; update the pattern",
      });
      continue;
    }
    const failures = sasStructureChecks(mutated).filter((c) => c.status === "fail");
    checks.push({
      name: `sas structure mutation caught: ${m.name}`,
      status: failures.length > 0 ? "pass" : "fail",
      detail: failures.length > 0
        ? failures.map((f) => f.detail).join(" | ").slice(0, 180)
        : "NOT CAUGHT — the SAS structural lint is blind to this",
    });
  }
  return checks;
}
