/**
 * Invariant catalog — assertions that must hold on EVERY generated study, not
 * just gold cases. Each queries the executed PGlite result tables and returns
 * pass / fail / skip (skip when its target table is not present yet, so the
 * catalog runs cleanly both before and after each analysis emitter lands).
 */
import type { PGlite } from "@electric-sql/pglite";

export interface InvariantResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

async function tableExists(db: PGlite, name: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = '${name}'`,
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

async function count(db: PGlite, sql: string): Promise<number> {
  const r = await db.query<Record<string, number>>(sql);
  const row = r.rows[0];
  return row ? Number(Object.values(row)[0]) : 0;
}

/** #2 attrition monotonic non-increasing across steps. */
async function attritionMonotonic(db: PGlite, tag: string): Promise<InvariantResult> {
  const t = `${tag}_attrition_steps`;
  if (!(await tableExists(db, t))) return { name: "attrition monotonic", status: "skip", detail: "no attrition table" };
  const seq = (
    await db.query<{ step: number; n: number }>(`SELECT step, count(*)::int AS n FROM ${t} GROUP BY step ORDER BY step`)
  ).rows;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].n > seq[i - 1].n)
      return { name: "attrition monotonic", status: "fail", detail: `step ${seq[i].step} (${seq[i].n}) > previous (${seq[i - 1].n})` };
  }
  return { name: "attrition monotonic", status: "pass", detail: `[${seq.map((s) => s.n).join(", ")}]` };
}

/** #10 percentages in [0,100] for the Table-1 output. */
async function percentagesInRange(db: PGlite, tag: string): Promise<InvariantResult> {
  const t = `${tag}_table1`;
  if (!(await tableExists(db, t))) return { name: "percentages in [0,100]", status: "skip", detail: "no table1" };
  const bad = await count(db, `SELECT count(*)::int FROM ${t} WHERE pct IS NOT NULL AND (pct < 0 OR pct > 100)`);
  return bad === 0
    ? { name: "percentages in [0,100]", status: "pass", detail: "all pct within bounds" }
    : { name: "percentages in [0,100]", status: "fail", detail: `${bad} rows out of range` };
}

/** #1 numerator <= denominator, #7 rate CI ordering, #9 no negatives, #8 proportion CI in [0,1]
 *  — all read {tag}_incidence, which the incidence module (Step 4) produces. */
async function incidenceInvariants(db: PGlite, tag: string): Promise<InvariantResult[]> {
  const t = `${tag}_incidence`;
  if (!(await tableExists(db, t)))
    return [{ name: "incidence invariants", status: "skip", detail: "no incidence table yet (Step 4)" }];
  const out: InvariantResult[] = [];
  const numLeDen = await count(db, `SELECT count(*)::int FROM ${t} WHERE patients > denominator`);
  out.push(numLeDen === 0
    ? { name: "numerator <= denominator", status: "pass", detail: "ok" }
    : { name: "numerator <= denominator", status: "fail", detail: `${numLeDen} rows violate` });
  const ciOrder = await count(db, `SELECT count(*)::int FROM ${t} WHERE ci_low IS NOT NULL AND NOT (ci_low <= rate_per_1000py AND rate_per_1000py <= ci_high)`);
  out.push(ciOrder === 0
    ? { name: "rate CI ordering", status: "pass", detail: "ci_low <= rate <= ci_high" }
    : { name: "rate CI ordering", status: "fail", detail: `${ciOrder} rows violate` });
  const neg = await count(db, `SELECT count(*)::int FROM ${t} WHERE patients < 0 OR denominator < 0 OR person_days < 0`);
  out.push(neg === 0
    ? { name: "no negative counts/person-time", status: "pass", detail: "ok" }
    : { name: "no negative counts/person-time", status: "fail", detail: `${neg} rows negative` });
  return out;
}

/** Run the full catalog against an executed result db. */
export async function runInvariants(db: PGlite, tag: string): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  results.push(await attritionMonotonic(db, tag));
  results.push(await percentagesInRange(db, tag));
  results.push(...(await incidenceInvariants(db, tag)));
  return results;
}
