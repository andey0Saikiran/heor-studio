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

export type SasEmitter = (spec: StudySpec, opts: EmitOptions) => GeneratedFile[];
export type SqlEmitter = (spec: StudySpec, dialect: SqlDialect, opts: EmitOptions) => GeneratedFile[];

export const DEFAULT_EMIT_OPTIONS: EmitOptions = {
  naming: { kind: "yearly_sas", prefix: "ccae" },
  tag: "TZ_STUDY",
};
