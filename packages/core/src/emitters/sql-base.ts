/**
 * SQL emitter base — the dialect layer, shared context, and window helpers
 * that both the cohort-spine builders (sql.ts) and the per-analysis modules
 * (modules/*.ts) depend on. Lives in its own file so analysis modules never
 * import sql.ts (no cycles): sql.ts → modules/registry → modules/* → here.
 */
import type { RelativeWindow, StudySpec } from "../spec/types";
import type { EmitOptions, SqlDialect } from "./types";

/** Escape a value for inclusion in a single-quoted SQL literal. */
export const q = (s: string): string => s.replace(/'/g, "''");

/** Collapse newlines so free text can live safely inside a `--` comment. */
export const oneLine = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ").trim();

export interface Dialect {
  id: SqlDialect;
  label: string;
  /** `dateExpr` shifted by a whole number of days (may be negative). */
  offset(dateExpr: string, days: number): string;
  /** Whole days from `earlier` to `later` (later - earlier). */
  daysBetween(later: string, earlier: string): string;
  /** True when `expr` contains a match for the alternation `pattern`. */
  regexContains(expr: string, pattern: string): string;
  /** Statement head that (re)creates a table from the SELECT that follows. */
  createTableAs(name: string): string;
  /** Calendar year of a date expression, as an integer. */
  year(dateExpr: string): string;
  /** Round a numeric expression to one decimal place. */
  round1(expr: string): string;
  /** Round a numeric expression to n decimal places (Postgres needs a NUMERIC cast). */
  roundN(expr: string, n: number): string;
}

export function makeDialect(id: SqlDialect): Dialect {
  if (id === "postgres") {
    return {
      id,
      label: "PostgreSQL",
      offset: (e, days) =>
        days === 0 ? e : days > 0 ? `(${e} + ${days})` : `(${e} - ${-days})`,
      daysBetween: (later, earlier) => `(${later} - ${earlier})`,
      // SIMILAR TO understands (A|B) alternation; % makes it a contains-match.
      regexContains: (e, p) => `${e} SIMILAR TO '%(${q(p)})%'`,
      createTableAs: (n) => `DROP TABLE IF EXISTS ${n};\nCREATE TABLE ${n} AS`,
      year: (e) => `CAST(EXTRACT(YEAR FROM ${e}) AS INT)`,
      round1: (e) => `ROUND(CAST(${e} AS NUMERIC), 1)`,
      roundN: (e, n) => `ROUND(CAST(${e} AS NUMERIC), ${n})`,
    };
  }
  return {
    id,
    label: "Snowflake",
    offset: (e, days) => (days === 0 ? e : `DATEADD(day, ${days}, ${e})`),
    daysBetween: (later, earlier) => `DATEDIFF(day, ${earlier}, ${later})`,
    // RLIKE anchors the whole string, hence the '.*' wrappers.
    regexContains: (e, p) => `${e} RLIKE '.*(${q(p)}).*'`,
    createTableAs: (n) => `CREATE OR REPLACE TABLE ${n} AS`,
    year: (e) => `YEAR(${e})`,
    round1: (e) => `ROUND(${e}, 1)`,
    roundN: (e, n) => `ROUND(${e}, ${n})`,
  };
}

/** Shared emitter context threaded through every SQL builder and module. */
export interface Ctx {
  spec: StudySpec;
  d: Dialect;
  opts: EmitOptions;
  /** Work-table prefix (lower-cased study tag). */
  wp: string;
  /** Logical family key -> physical table name. */
  t: (key: string) => string;
}

export function describeWindow(w: RelativeWindow): string {
  const s = w.start === "anytime_before" ? "anytime before" : `day ${w.start}`;
  const e = w.end === "anytime_after" ? "anytime after" : `day ${w.end}`;
  const inc = w.includesIndex ? "includes" : "excludes";
  return `${s} .. ${e} relative to index (${inc} index date)`;
}

/** Predicates locating `dateExpr` inside window `w` around `indexExpr`. */
export function windowConds(
  w: RelativeWindow,
  dateExpr: string,
  indexExpr: string,
  d: Dialect
): string[] {
  const conds: string[] = [];
  if (w.start !== "anytime_before") {
    conds.push(`${dateExpr} >= ${d.offset(indexExpr, w.start)}`);
  }
  if (w.end !== "anytime_after") {
    conds.push(`${dateExpr} <= ${d.offset(indexExpr, w.end)}`);
  }
  const spansStart = w.start === "anytime_before" || w.start <= 0;
  const spansEnd = w.end === "anytime_after" || w.end >= 0;
  if (!w.includesIndex && spansStart && spansEnd) {
    conds.push(`${dateExpr} <> ${indexExpr}`);
  }
  return conds;
}
