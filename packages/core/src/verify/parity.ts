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
};

/** Emit both languages for the spec and cross-check every analysis twin.
 *  The stamped-kind map derives from the module registry, so registering a
 *  module automatically enrolls it here. */
export function sasSqlParityChecks(spec: StudySpec, opts: EmitOptions): Check[] {
  const checks: Check[] = [];
  const sqlStamps = collect(emitSql(spec, "postgres", opts));
  const sasStamps = collect(emitSas(spec, opts));

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

    // 3. arithmetic signatures present in each twin
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
