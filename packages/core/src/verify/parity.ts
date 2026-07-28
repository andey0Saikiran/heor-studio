/**
 * SAS↔SQL twin parity checks.
 *
 * SAS has no free runtime, so the SAS twin can't be execution-verified the way
 * the SQL twin is (PGlite + ground truth). Instead every analysis program in
 * BOTH languages carries a `PARITY <kind> <json>` stamp of the parameters it
 * actually consumed (emitters/parity.ts). This module emits both languages for
 * a spec and asserts:
 *
 *   1. the same set of analysis stamps exists in both languages;
 *   2. each stamp pair is deep-equal (same multiplier, person-time constant,
 *      washout window, censor terms, CI method actually computed, ...);
 *   3. the arithmetic signatures match — the Byar closed form and the
 *      strictly-after-index case predicate are present in both twins.
 *
 * A twin that drifts (different default, ignored parameter, edited formula)
 * fails verification instead of shipping different numbers per language.
 */
import { emitSql } from "../emitters/sql";
import { emitSas } from "../emitters/sas";
import { parseParityStamps } from "../emitters/parity";
import { STAMP_KIND_BY_ANALYSIS } from "../emitters/modules/registry";
import {
  fingerprint,
  expectedFromStamp,
  diffFingerprints,
  diffAgainstExpected,
  constantProfile,
  diffConstantProfile,
  hasConstantProfile,
  languageLocalChecks,
  spineFingerprint,
} from "./fingerprint";
import type { StudySpec, EmitOptions } from "../index";
import type { Check } from "./run";

interface Stamped {
  path: string;
  content: string;
  kind: string;
  values: Record<string, unknown>;
}

function collect(files: Array<{ path: string; content: string }>): Stamped[] {
  const out: Stamped[] = [];
  for (const f of files) {
    for (const s of parseParityStamps(f.content)) {
      out.push({ path: f.path, content: f.content, kind: s.kind, values: s.values });
    }
  }
  return out;
}

function stampKey(s: Stamped): string {
  return `${s.kind}:${String(s.values.id ?? "?")}`;
}

/** Arithmetic fragments that MUST appear in a twin for each analysis kind —
 *  parameters matching means nothing if someone rewrote the formula itself. */
const SIGNATURES: Record<string, { sql: string[]; sas: string[] }> = {
  incidence: {
    sql: [
      "1.0/(9*patients)",
      "1.96/(3*SQRT(patients))",
      "1.0/(9*(patients+1))",
      "1.96/(3*SQRT(patients+1))",
      "> c.index_date", // first outcome STRICTLY after index
    ],
    sas: [
      "1/(9*patients)",
      "1.96/(3*sqrt(patients))",
      "1/(9*(patients+1))",
      "1.96/(3*sqrt(patients+1))",
      "> a.index_date", // first outcome STRICTLY after index
      "**3",            // cubing — SAS power operator
    ],
  },
  point_prevalence: {
    sql: [
      "1.9208", // z^2/2
      "3.8416", // z^2
      "0.9604", // z^2/4
      "e.event_date <= den.anchor_date", // on-or-before-anchor case predicate
    ],
    sas: [
      "1.9208",
      "3.8416",
      "0.9604",
      "e.svcdate <= a.anchor_date", // on-or-before-anchor case predicate
    ],
  },
  period_prevalence: {
    sql: [
      "1.9208",
      "3.8416",
      "0.9604",
      "e.event_date BETWEEN", // event-dated-in-period case predicate
    ],
    sas: [
      "1.9208",
      "3.8416",
      "0.9604",
      "e.svcdate between", // event-dated-in-period case predicate
    ],
  },
  cumulative_incidence: {
    sql: [
      "1.9208",
      "3.8416",
      "0.9604",
      "a.event_date > c.index_date", // first event strictly after index
      "a.event_date <=", // ... and within the horizon
    ],
    sas: [
      "1.9208",
      "3.8416",
      "0.9604",
      "e.svcdate > a.index_date", // first event strictly after index
      "e.svcdate <= a.index_date +", // ... and within the horizon
    ],
  },
};

/** Emit both languages for the spec and cross-check every analysis twin.
 *  The stamped-kind map derives from the module registry, so registering a
 *  module automatically enrolls it here. */
export function sasSqlParityChecks(spec: StudySpec, opts: EmitOptions): Check[] {
  const checks: Check[] = [];
  const sqlStamps = collect(emitSql(spec, "postgres", opts));
  const sasStamps = collect(emitSas(spec, opts));
  const snowStamps = collect(emitSql(spec, "snowflake", opts));
  const sasFiles = emitSas(spec, opts);
  const sasSetup = sasFiles.find((f) => /setup/i.test(f.path))?.content ?? "";
  const snowByKey = new Map(snowStamps.map((s) => [stampKey(s), s]));

  /* SPINE parity. The cohort spine carries no PARITY stamp, so nothing compared
   * the languages there — and two real defects hid in that gap (a one-day
   * stricter SAS continuous-enrollment predicate, and SQL episode stitching
   * that mishandled nested segments). Fingerprint it directly. */
  {
    const fpSql = spineFingerprint("sql", emitSql(spec, "postgres", opts));
    const fpSas = spineFingerprint("sas", sasFiles, sasSetup);
    const drift = diffFingerprints(fpSql, fpSas);
    checks.push({
      name: "parity spine: cohort construction agrees across twins",
      status: drift.length === 0 ? "pass" : "fail",
      detail: drift.length === 0
        ? `continuous-enrollment window, gap allowance and stitching form all match (${JSON.stringify(fpSql)})`
        : drift.join(" | "),
    });
    // Both languages must use the running-max stitch; LAG-style stitching
    // silently truncates coverage when segments nest (fixture P13).
    for (const [lang, fp] of [["sql", fpSql], ["sas", fpSas]] as const) {
      checks.push({
        name: `parity spine: ${lang} stitches with a running maximum`,
        status: fp.stitch_uses_running_max === "yes" ? "pass" : "fail",
        detail: fp.stitch_uses_running_max === "yes"
          ? "nested/overlapping segments stitch correctly"
          : "compares against the previous segment only — nested segments will split an episode",
      });
    }
  }

  const expected = spec.analyses.filter((a) => a.enabled && STAMP_KIND_BY_ANALYSIS[a.kind]).length;
  checks.push({
    name: "parity: every stamped-module analysis appears in BOTH languages",
    status: sqlStamps.length === expected && sasStamps.length === expected ? "pass" : "fail",
    detail: `expected=${expected}, sql stamps=${sqlStamps.length}, sas stamps=${sasStamps.length}`,
  });

  const sasByKey = new Map(sasStamps.map((s) => [stampKey(s), s]));
  for (const sq of sqlStamps) {
    const key = stampKey(sq);
    const sa = sasByKey.get(key);
    if (!sa) {
      checks.push({ name: `parity ${key}: SAS twin exists`, status: "fail", detail: `no SAS stamp for ${sq.path}` });
      continue;
    }

    // 2. consumed-parameter deep equality (stableJson makes both sides byte-stable)
    const a = JSON.stringify(sq.values);
    const b = JSON.stringify(sa.values);
    checks.push({
      name: `parity ${key}: consumed parameters identical`,
      status: a === b ? "pass" : "fail",
      detail: a === b ? `${sq.path} == ${sa.path}` : `sql=${a} sas=${b}`,
    });

    /* 3. CODE FINGERPRINTS — the checks with real falsifying power.
     *    Unlike the stamp comparison above (both stamps come from the same
     *    builder, so it cannot fail), every value here is scraped from that
     *    language's own emitted text. verify/mutation.ts proves these go red
     *    when the code is corrupted. */
    const fpSql = fingerprint(sq.kind, "sql", sq.content);
    const fpSas = fingerprint(sa.kind, "sas", sa.content, sasSetup);
    const xlang = diffFingerprints(fpSql, fpSas);
    checks.push({
      name: `parity ${key}: emitted CODE agrees across twins (fingerprint)`,
      status: xlang.length === 0 ? "pass" : "fail",
      detail: xlang.length === 0
        ? `${Object.keys(fpSql).length} values scraped from each twin's own code all match`
        : xlang.join(" | "),
    });

    // the stamp must describe what the code actually does
    for (const [lang, fp, stamp] of [["sql", fpSql, sq.values], ["sas", fpSas, sa.values]] as const) {
      const drift = diffAgainstExpected(fp, expectedFromStamp(sq.kind, stamp));
      if (drift.length > 0) {
        checks.push({
          name: `parity ${key}: ${lang} stamp matches its own code`,
          status: "fail",
          detail: drift.join(" | "),
        });
      }
    }

    /* 3a. SAS-PRIMARY contract, asserted per language. These keys are excluded
     *     from the cross-language diff above (one language produces each by
     *     design), so they are checked HERE instead — the SQL column must be
     *     NULL and the SAS statistic must genuinely exist. Skipping them would
     *     let an asymmetric column go unverified in both directions at once. */
    for (const [lang, fp] of [["sql", fpSql], ["sas", fpSas]] as const) {
      for (const c of languageLocalChecks(lang, fp)) {
        checks.push({
          name: `parity ${key}: ${lang} SAS-primary contract (${c.key})`,
          status: c.ok ? "pass" : "fail",
          detail: c.detail,
        });
      }
    }

    // statistical constants, pinned per language (see fingerprint.ts)
    if (hasConstantProfile(sq.kind)) {
      const cSql = diffConstantProfile(sq.kind, "sql", constantProfile("sql", sq.content));
      const cSas = diffConstantProfile(sq.kind, "sas", constantProfile("sas", sa.content, sasSetup));
      checks.push({
        name: `parity ${key}: CI constants intact in both twins`,
        status: cSql.length + cSas.length === 0 ? "pass" : "fail",
        detail: cSql.length + cSas.length === 0
          ? "z / z^2 / z^2-2 / z^2-4 occur exactly as expected in each language"
          : [...cSql.map((d) => `sql ${d}`), ...cSas.map((d) => `sas ${d}`)].join(" | "),
      });
    }

    /* 3b. SNOWFLAKE — emitted into every bundle but previously covered by
     *     NOTHING (not executed, not parsed, not even grepped). It cannot run
     *     in PGlite, so it is verified by fingerprint against the Postgres twin
     *     that IS execution-verified. */
    const sn = snowByKey.get(key);
    if (!sn) {
      checks.push({ name: `parity ${key}: snowflake twin exists`, status: "fail", detail: "no snowflake stamp" });
    } else {
      const fpSnow = fingerprint(sn.kind, "sql", sn.content);
      const sdiff = diffFingerprints(fpSql, fpSnow);
      const csnow = hasConstantProfile(sn.kind)
        ? diffConstantProfile(sn.kind, "sql", constantProfile("sql", sn.content))
        : [];
      checks.push({
        name: `parity ${key}: snowflake code agrees with the executed postgres twin`,
        status: sdiff.length + csnow.length === 0 ? "pass" : "fail",
        detail: sdiff.length + csnow.length === 0
          ? "dialect differs (DATEADD vs date arithmetic); every operative value matches"
          : [...sdiff, ...csnow].join(" | "),
      });
    }

    // 4. arithmetic signatures present in each twin
    const sig = SIGNATURES[sq.kind];
    if (sig) {
      const missSql = sig.sql.filter((f) => !sq.content.includes(f));
      const missSas = sig.sas.filter((f) => !sa.content.includes(f));
      checks.push({
        name: `parity ${key}: arithmetic signatures match`,
        status: missSql.length === 0 && missSas.length === 0 ? "pass" : "fail",
        detail:
          missSql.length === 0 && missSas.length === 0
            ? `all ${sig.sql.length + sig.sas.length} arithmetic/predicate signatures present in both twins`
            : `missing in sql: [${missSql.join(" | ")}]; missing in sas: [${missSas.join(" | ")}]`,
      });
    }
  }

  // orphaned SAS stamps (SAS emits an analysis SQL doesn't know about)
  const sqlKeys = new Set(sqlStamps.map(stampKey));
  for (const sa of sasStamps) {
    if (!sqlKeys.has(stampKey(sa))) {
      checks.push({
        name: `parity ${stampKey(sa)}: SQL twin exists`,
        status: "fail",
        detail: `SAS stamp in ${sa.path} has no SQL counterpart`,
      });
    }
  }

  return checks;
}
