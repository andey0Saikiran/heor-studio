/**
 * PGlite execution engine. Seeds the synthetic fixture, runs the EMITTED
 * Postgres SQL files in order against it, and exposes query access to the
 * resulting work tables. PGlite is real Postgres-16 (wasm), so date+int
 * arithmetic, SIMILAR TO, PERCENTILE_CONT, and sample STDDEV all behave exactly
 * as on the analyst's Postgres/Redshift-class target — which is what lets an
 * executed result stand in for correctness.
 */
import { PGlite } from "@electric-sql/pglite";
import { emitSql } from "../emitters/sql";
import type { StudySpec, EmitOptions } from "../index";
import { fixtureSeedSql } from "./fixture";

export interface ExecStep {
  path: string;
  ok: boolean;
  error?: string;
}

export interface ExecResult {
  db: PGlite;
  steps: ExecStep[];
  /** true when every emitted file executed without error. */
  ok: boolean;
}

/**
 * Seed the fixture, then execute the emitted Postgres files in run order.
 * Each file is DROP+CREATE+diagnostic-SELECTs; we exec the whole file and
 * ignore diagnostic result sets. Stops recording after the first hard failure
 * but keeps the db so the caller can inspect what did build.
 */
export async function seedAndRun(spec: StudySpec, opts: EmitOptions): Promise<ExecResult> {
  const db = new PGlite();
  await db.exec(fixtureSeedSql());

  const files = emitSql(spec, "postgres", opts).sort((a, b) => a.path.localeCompare(b.path));
  const steps: ExecStep[] = [];
  let ok = true;
  for (const f of files) {
    try {
      await db.exec(f.content);
      steps.push({ path: f.path, ok: true });
    } catch (e) {
      ok = false;
      steps.push({ path: f.path, ok: false, error: (e as Error).message });
    }
  }
  return { db, steps, ok };
}

/** Convenience typed query. */
export async function rows<T>(db: PGlite, sql: string): Promise<T[]> {
  const r = await db.query<T>(sql);
  return r.rows;
}

/** Single scalar (first column of first row), or undefined. */
export async function scalar<T = number>(db: PGlite, sql: string): Promise<T | undefined> {
  const r = await db.query<Record<string, T>>(sql);
  const row = r.rows[0];
  if (!row) return undefined;
  return Object.values(row)[0];
}
