import type { StudySpec } from "../spec/types";
import type { TableNamingStrategy } from "../data/marketscan";

/** One generated source file. */
export interface GeneratedFile {
  /** Relative path inside the export bundle, e.g. "sas/050_enroll_stitch.sas". */
  path: string;
  language: "sas" | "sql";
  /** Human title shown in the UI file list. */
  title: string;
  content: string;
}

export interface EmitOptions {
  naming: TableNamingStrategy;
  /** Short uppercase study tag used to prefix work tables, e.g. "PSO_TP". */
  tag: string;
}

export type SqlDialect = "postgres" | "snowflake";

/** Identifier charset shared by SQL table names and SAS names/macro vars.
 *  tag and naming.prefix are embedded VERBATIM in generated code, so anything
 *  outside this set is an injection vector (e.g. tag "x; DROP TABLE y;--").
 *  Both emitters call this from buildCtx; the MCP generate_code input schema
 *  enforces the same pattern at the boundary. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertSafeIdent(value: string, what: string, maxLen = 20): string {
  if (!SAFE_IDENT.test(value) || value.length > maxLen) {
    throw new Error(
      `${what} "${value}" is not a safe identifier — it is embedded verbatim in generated SQL/SAS. ` +
        `Use letters, digits and underscores, starting with a letter or underscore (max ${maxLen} chars).`
    );
  }
  return value;
}

/** Validate every user-supplied string a TableNamingStrategy embeds in
 *  generated code. Patterns may additionally contain the {LETTER}/{YEAR}/
 *  {RELEASE} placeholders and dots (schema-qualified names). */
export function assertSafeNaming(naming: TableNamingStrategy): void {
  if (naming.kind === "yearly_sas") {
    assertSafeIdent(naming.prefix, "naming.prefix");
    return;
  }
  assertSafeIdent(naming.schema, "naming.schema", 40);
  const stripped = naming.pattern.replace(/\{(LETTER|YEAR|RELEASE)\}/g, "x");
  if (!/^[A-Za-z0-9_.]+$/.test(stripped) || naming.pattern.length > 80) {
    throw new Error(
      `naming.pattern "${naming.pattern}" is not a safe table-name template — letters, digits, underscores, ` +
        `dots and {LETTER}/{YEAR}/{RELEASE} placeholders only (max 80 chars). It is embedded verbatim in generated SQL.`
    );
  }
}

export type SasEmitter = (spec: StudySpec, opts: EmitOptions) => GeneratedFile[];
export type SqlEmitter = (spec: StudySpec, dialect: SqlDialect, opts: EmitOptions) => GeneratedFile[];

export const DEFAULT_EMIT_OPTIONS: EmitOptions = {
  naming: { kind: "yearly_sas", prefix: "ccae" },
  tag: "TZ_STUDY",
};
