/**
 * Byte-identity snapshot — the gate on every spine change.
 *
 * emitters/sql.ts and emitters/sas.ts feed all 19 emittable analysis kinds, so
 * a change there can move a number in a module that looks untouched. The house
 * rule (used for the rate-core extraction and again for the comorbidity scorer)
 * is that a refactor must prove itself: emit EVERY file for EVERY gold spec in
 * EVERY dialect, hash them, and require the digest to be unchanged.
 *
 *   npx tsx src/verify/snapshot.ts write   # before the change
 *   npx tsx src/verify/snapshot.ts check   # after — exits 1 on any drift
 *
 * A deliberate change to shipped output is legitimate; it just has to be SEEN.
 * `check` prints the per-file diff so an intended change can be re-baselined
 * with `write` and read in the commit, rather than discovered later by a number
 * nobody can explain.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudySpec, EmitOptions } from "../index";
import { emitSql, emitSas, planBundle } from "../index";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import { GOLD_B_SPEC, GOLD_B_OPTS } from "./fixture-b";
import { GOLD_C_SPEC, GOLD_C_OPTS } from "./fixture-c";
import { GOLD_D_SPEC, GOLD_D_OPTS } from "./fixture-d";
import { GOLD_E_SPEC, GOLD_E_OPTS } from "./fixture-e";
import { GOLD_F_SPEC, GOLD_F_OPTS } from "./fixture-f";
import { GOLD_G_SPEC, GOLD_G_OPTS } from "./fixture-g";
import { GOLD_H_SPEC, GOLD_H_OPTS } from "./fixture-h";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "snapshot.baseline.json");

const CASES: Array<{ name: string; spec: StudySpec; opts: EmitOptions }> = [
  { name: "A", spec: GOLD_A_SPEC, opts: GOLD_A_OPTS },
  { name: "B", spec: GOLD_B_SPEC, opts: GOLD_B_OPTS },
  { name: "C", spec: GOLD_C_SPEC, opts: GOLD_C_OPTS },
  { name: "D", spec: GOLD_D_SPEC, opts: GOLD_D_OPTS },
  { name: "E", spec: GOLD_E_SPEC, opts: GOLD_E_OPTS },
  { name: "F", spec: GOLD_F_SPEC, opts: GOLD_F_OPTS },
  { name: "G", spec: GOLD_G_SPEC, opts: GOLD_G_OPTS },
  { name: "H", spec: GOLD_H_SPEC, opts: GOLD_H_OPTS },
];

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/** Pinned so the bundle's provenance stamp cannot masquerade as emitter drift. */
const FIXED_NOW = "2020-01-01T00:00:00.000Z";

/** path -> content hash, for every file every emitter produces on every case. */
export function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CASES) {
    /* Naming strategies are part of the emitted text (table names, %let blocks),
     * so a spine change can be invisible under one and visible under another.
     * Every case is emitted under all three. */
    const namings: EmitOptions["naming"][] = [
      c.opts.naming,
      { kind: "warehouse_yearly", schema: "ms", pattern: "ms_{LETTER}_{YEAR}" },
      { kind: "single_table", schema: "ms", pattern: "ms_{LETTER}" },
    ];
    for (const naming of namings) {
      const opts: EmitOptions = { ...c.opts, naming };
      const tag = `${c.name}/${naming.kind}`;
      for (const f of emitSas(c.spec, opts)) out[`${tag}/sas/${f.path}`] = sha(f.content);
      for (const f of emitSql(c.spec, "postgres", opts)) out[`${tag}/pg/${f.path}`] = sha(f.content);
      for (const f of emitSql(c.spec, "snowflake", opts)) out[`${tag}/sf/${f.path}`] = sha(f.content);
      /* planBundle stamps a "generated at" time into README.md and
       * AI_DISCLOSURE.md. That is legitimate provenance, but it means two
       * bundles from one spec differ in those two files, so the snapshot pins
       * the clock rather than chasing a hash that moves every second. The
       * emitted CODE carries no timestamp and is byte-stable without help —
       * which is the property this gate exists to protect. */
      for (const e of planBundle(c.spec, opts, FIXED_NOW)) out[`${tag}/bundle/${e.path}`] = sha(e.content);
    }
  }
  return out;
}

function main() {
  const mode = process.argv[2];
  const now = snapshot();
  const n = Object.keys(now).length;

  if (mode === "write") {
    writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
    console.log(`snapshot: wrote ${n} file hashes to ${BASELINE}`);
    return;
  }

  if (mode !== "check") {
    console.error("usage: snapshot.ts write|check");
    process.exit(2);
  }

  if (!existsSync(BASELINE)) {
    console.error(`snapshot: no baseline at ${BASELINE} — run 'write' BEFORE the change, not after.`);
    process.exit(2);
  }
  const base: Record<string, string> = JSON.parse(readFileSync(BASELINE, "utf8"));

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [p, h] of Object.entries(now)) {
    if (!(p in base)) added.push(p);
    else if (base[p] !== h) changed.push(p);
  }
  for (const p of Object.keys(base)) if (!(p in now)) removed.push(p);

  console.log(`snapshot: ${n} files emitted, baseline had ${Object.keys(base).length}`);
  for (const p of changed) console.log(`  CHANGED  ${p}`);
  for (const p of added) console.log(`  ADDED    ${p}`);
  for (const p of removed) console.log(`  REMOVED  ${p}`);

  if (changed.length || removed.length) {
    console.error(
      `\nsnapshot: FAILED — ${changed.length} changed, ${removed.length} removed.\n` +
        `A spine change must not move output for analyses it did not touch. If this change is\n` +
        `INTENDED, re-baseline with 'write' and say so in the commit message.`,
    );
    process.exit(1);
  }
  if (added.length) {
    console.log(
      `\nsnapshot: ${added.length} NEW files, nothing changed or removed — additive, which is what a\n` +
        `conditionally-emitted feeder should look like. Re-baseline with 'write' to adopt them.`,
    );
  } else {
    console.log(`\nsnapshot: PASSED — byte-identical.`);
  }
}

main();
