/**
 * SQL emitter - deterministic generation of the MarketScan claims pipeline
 * as a set of runnable-after-configure SQL scripts.
 *
 * The same pipeline as the SAS emitter, expressed per dialect:
 *   01_ndc_lookup.sql   drug-name patterns -> NDC codes (Redbook-style ref)
 *   02_events.sql       long/tall clinical event table (dx unpivot, drug join)
 *   03_index.sql        first qualifying event per patient (time zero)
 *   04_enrollment.sql   gaps-and-islands enrollment stitching + index join
 *   05_attrition.sql    sequential CONSORT criteria as chained CTEs
 *   06_baseline.sql     Table 1 aggregates over the final cohort
 *
 * Everything is derived from the StudySpec; no timestamps or randomness, so
 * output is byte-stable for a given (spec, dialect, options) triple.
 *
 * Conventions (per HEOR practice, see spec/types.ts):
 *   - baseline period INCLUDES the index date and runs backward;
 *   - follow-up period EXCLUDES the index date and runs forward;
 *   - ICD-9 vs ICD-10 era is resolved via DXVER ('9' / '0', NULL -> ICD-9).
 */

import type {
  BaselineCharacteristic,
  CodeList,
  Criterion,
  RelativeWindow,
  StudySpec,
} from "../spec/types";
import { findCodeList } from "../spec/types";
import type { TableNamingStrategy } from "../data/marketscan";
import {
  DB_PREFIX,
  DX_COLUMNS,
  MARKETSCAN_TABLES,
  PROC_COLUMNS,
} from "../data/marketscan";
import type {
  GeneratedFile,
  SqlEmitter,
} from "./types";
import { assertSafeIdent, assertSafeNaming } from "./types";
import { q, oneLine, makeDialect, windowConds, describeWindow } from "./sql-base";
import { suppressionPolicy, suppressionSqlFor, type SuppressionTarget } from "./suppression";
import type { Ctx } from "./sql-base";
import { moduleAnalyses } from "./modules/registry";

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const pad2 = (n: number): string => String(n).padStart(2, "0");

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/** Normalize a dx/proc code the way it appears in claims (no dots, upper). */
const claimCode = (raw: string): string =>
  raw.trim().toUpperCase().replace(/\./g, "");

/** Render an IN-list, wrapping onto indented lines of six codes each. */
function inList(values: string[], indent: string): string {
  const items = values.map((v) => `'${q(v)}'`);
  if (items.join(", ").length <= 56) return `(${items.join(", ")})`;
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 6) {
    lines.push(indent + "  " + items.slice(i, i + 6).join(", "));
  }
  return `(\n${lines.join(",\n")}\n${indent})`;
}

/* ------------------------------------------------------------------ */
/* Physical table naming                                               */
/* ------------------------------------------------------------------ */

function letterFor(key: string): string {
  const t = MARKETSCAN_TABLES.find((mt) => mt.key === key);
  return t ? t.letter : "?";
}

function warehouseFamilyName(pattern: string, letter: string): string {
  return pattern
    .replace(/\{LETTER\}/g, letter)
    .replace(/[._-]?\{RELEASE\}/g, "")
    .replace(/\{YEAR\}/g, "ALL");
}

/**
 * Resolve a logical MarketScan family (by key) to the physical name used in
 * the generated SQL. Yearly strategies resolve to an "_all"-style name the
 * user points at a UNION ALL view (see the CONFIGURE header note).
 */
function physicalTable(naming: TableNamingStrategy, key: string): string {
  const letter = letterFor(key);
  switch (naming.kind) {
    case "yearly_sas":
      return `${naming.prefix}${letter.toLowerCase()}_all`;
    case "warehouse_yearly":
      return `${naming.schema}.${warehouseFamilyName(naming.pattern, letter)}`;
    case "single_table":
      return `${naming.schema}.${naming.pattern.replace(/\{LETTER\}/g, letter)}`;
  }
}

function namingNote(naming: TableNamingStrategy): string[] {
  switch (naming.kind) {
    case "yearly_sas": {
      const p = naming.prefix;
      return [
        `-- NOTE: yearly SAS deliveries are one file per family per year (for`,
        `-- example "${p}o181" = ${p} + letter o + year 18 + release 1). Point each`,
        `-- "*_all" name above at a UNION ALL view over the years you license:`,
        `--   CREATE VIEW ${p}o_all AS`,
        `--     SELECT * FROM ${p}o171 UNION ALL SELECT * FROM ${p}o181 /* ... */;`,
      ];
    }
    case "warehouse_yearly": {
      const ex2018 = naming.pattern
        .replace(/\{LETTER\}/g, "O")
        .replace(/\{YEAR\}/g, "2018")
        .replace(/\{RELEASE\}/g, "R1912");
      const exAll = warehouseFamilyName(naming.pattern, "O");
      return [
        `-- NOTE: warehouse deliveries are yearly (pattern "${naming.pattern}"`,
        `-- in schema "${naming.schema}"). Point each "*ALL" name above at a`,
        `-- UNION ALL view over the yearly tables:`,
        `--   CREATE VIEW ${naming.schema}.${exAll} AS`,
        `--     SELECT * FROM ${naming.schema}.${ex2018} UNION ALL /* ... */;`,
      ];
    }
    case "single_table":
      return [
        `-- NOTE: single-table strategy; the schema-qualified names above are`,
        `-- used directly (no yearly UNION needed).`,
      ];
  }
}

/* ------------------------------------------------------------------ */
/* Shared context + file header                                        */
/* ------------------------------------------------------------------ */

function header(
  ctx: Ctx,
  fileName: string,
  subtitle: string,
  tableKeys: string[],
  extraConfig: string[]
): string {
  const { spec, d, opts, wp } = ctx;
  const bar = "-- " + "=".repeat(76);
  const rule = "-- " + "-".repeat(76);
  const L: string[] = [];
  L.push(bar);
  L.push(`-- ${fileName} - ${subtitle}`);
  L.push(rule);
  L.push(`-- Generated by HEOR Studio. Do not hand-edit; edit the study spec and re-emit.`);
  L.push(`-- Study    : ${oneLine(spec.meta.title)}`);
  // oneLine() strips newlines: a raw newline would end this `--` comment and
  // turn the rest of the line into live SQL (parity with the title above).
  L.push(`-- Spec     : v${oneLine(spec.meta.version)}`);
  L.push(
    `-- Database : ${spec.meta.database} (MarketScan family prefix "${DB_PREFIX[spec.meta.database] ?? "?"}")`
  );
  L.push(`-- Dialect  : ${d.label}`);
  L.push(`-- Period   : ${spec.meta.studyPeriod.start} .. ${spec.meta.studyPeriod.end}`);
  L.push(`-- Run order: 01_ndc_lookup -> 02_events -> 03_index -> 04_enrollment`);
  L.push(`--            -> 05_attrition -> 06_baseline`);
  L.push(`--`);
  L.push(`-- CONFIGURE ${"-".repeat(66)}`);
  if (tableKeys.length > 0) {
    L.push(`-- Raw MarketScan tables referenced below (naming strategy "${opts.naming.kind}"):`);
    for (const k of tableKeys) {
      const tbl = MARKETSCAN_TABLES.find((mt) => mt.key === k);
      const label = (tbl ? tbl.label : k).padEnd(30);
      L.push(`--   ${label}[${letterFor(k)}] -> ${ctx.t(k)}`);
    }
    L.push(...namingNote(opts.naming));
  } else {
    L.push(`-- No raw claims tables in this step; it reads work tables built earlier.`);
  }
  for (const e of extraConfig) L.push(`-- ${e}`);
  L.push(`-- Work tables are created in the current schema/database, prefix "${wp}_".`);
  L.push(`-- Date columns are assumed DATE-typed (cast numeric SAS dates first).`);
  L.push(`-- Flag columns (dxver, rx, sex, region, plantyp) are compared as text;`);
  L.push(`-- add casts if your load stores them numerically.`);
  L.push(bar);
  return L.join("\n");
}

/* ------------------------------------------------------------------ */
/* Code-list helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Split a diagnosis list into ICD-10 vs ICD-9 era code sets.
 * An icd10cm list may carry numeric-leading ICD-9 codes retained for
 * lookback (e.g. 696.1 alongside L40.x); DXVER separates the eras at query
 * time, so each code only ever matches claims from its own era.
 */
function splitDxEras(list: CodeList): { icd10: string[]; icd9: string[] } {
  const icd10: string[] = [];
  const icd9: string[] = [];
  for (const entry of list.codes) {
    const code = claimCode(entry.code);
    if (code.length === 0) continue;
    if (list.system === "icd9cm" || /^[0-9]/.test(code)) icd9.push(code);
    else icd10.push(code);
  }
  return { icd10: dedupe(icd10), icd9: dedupe(icd9) };
}

const dxLists = (spec: StudySpec): CodeList[] =>
  spec.codeLists.filter((c) => c.system === "icd9cm" || c.system === "icd10cm");
const procLists = (spec: StudySpec): CodeList[] =>
  spec.codeLists.filter((c) => c.system === "cpt_hcpcs");
const drugNameLists = (spec: StudySpec): CodeList[] =>
  spec.codeLists.filter((c) => c.system === "drug_name");
const ndcLists = (spec: StudySpec): CodeList[] =>
  spec.codeLists.filter((c) => c.system === "ndc");

/* ------------------------------------------------------------------ */
/* 01 - NDC lookup                                                     */
/* ------------------------------------------------------------------ */

function build01(ctx: Ctx): string {
  const { spec, d, wp } = ctx;
  const lookup = `${wp}_ndc_lookup`;
  const names = drugNameLists(spec);
  const literals = ndcLists(spec);
  const out: string[] = [];

  if (names.length === 0 && literals.length === 0) {
    out.push(`-- This spec has no drug_name or NDC code lists. An empty lookup table is`);
    out.push(`-- still created so the later scripts can reference it unconditionally.`);
    out.push(d.createTableAs(lookup));
    out.push(`SELECT CAST(NULL AS VARCHAR) AS code_list_id,`);
    out.push(`       CAST(NULL AS VARCHAR) AS pattern,`);
    out.push(`       CAST(NULL AS VARCHAR) AS ndcnum`);
    out.push(`WHERE 1 = 0;`);
    return out.join("\n");
  }

  out.push(`-- Resolve drug-name patterns to NDC codes against a Redbook-style NDC`);
  out.push(`-- reference. Each pattern is an alternation of generic/brand names; both`);
  out.push(`-- the generic (gennme) and product (prodnme) names are searched, upper-`);
  out.push(`-- cased, so brand-only patterns still resolve.`);
  if (d.id === "postgres") {
    out.push(`-- Matching uses SIMILAR TO: '%(A|B)%' = name contains A or B.`);
  } else {
    out.push(`-- Matching uses RLIKE, which anchors the full string - hence '.*(A|B).*'.`);
  }
  out.push(``);

  const branches: string[] = [];
  for (const list of names) {
    for (const entry of list.codes) {
      const pattern = entry.code.trim().toUpperCase();
      const desc = entry.description ? ` (${oneLine(entry.description)})` : "";
      branches.push(
        [
          `  -- ${oneLine(list.label)} [${list.id}]${desc}`,
          `  SELECT '${q(list.id)}' AS code_list_id,`,
          `         '${q(pattern)}' AS pattern,`,
          `         r.ndcnum`,
          `  FROM redbook r`,
          `  WHERE ${d.regexContains("UPPER(r.gennme)", pattern)}`,
          `     OR ${d.regexContains("UPPER(r.prodnme)", pattern)}`,
        ].join("\n")
      );
    }
  }
  for (const list of literals) {
    const codes = dedupe(list.codes.map((c) => c.code.trim()).filter((c) => c.length > 0));
    if (codes.length === 0) continue;
    const rows = codes.map((c) => `    ('${q(c)}')`).join(",\n");
    branches.push(
      [
        `  -- ${oneLine(list.label)} [${list.id}]: literal NDC codes from the spec`,
        `  SELECT '${q(list.id)}' AS code_list_id,`,
        `         '(literal ndc list)' AS pattern,`,
        `         v.ndcnum`,
        `  FROM (VALUES`,
        rows,
        `  ) AS v (ndcnum)`,
      ].join("\n")
    );
  }

  out.push(d.createTableAs(lookup));
  out.push(`SELECT DISTINCT code_list_id, pattern, ndcnum`);
  out.push(`FROM (`);
  out.push(branches.join("\n\n  UNION ALL\n\n"));
  out.push(`) AS m;`);
  out.push(``);
  out.push(`-- REVIEW: NDC counts per pattern. Zero-count patterns usually mean the`);
  out.push(`-- reference table spells the name differently - fix the spec, not the SQL.`);
  out.push(`SELECT code_list_id, pattern, COUNT(DISTINCT ndcnum) AS ndc_count`);
  out.push(`FROM ${lookup}`);
  out.push(`GROUP BY code_list_id, pattern`);
  out.push(`ORDER BY code_list_id, pattern;`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* 02 - events                                                         */
/* ------------------------------------------------------------------ */

/** Diagnosis/procedure source tables, in emission order.
 *
 *  Inpatient diagnoses are dated at ADMDATE from BOTH inpatient sources. The
 *  same clinical diagnosis on one stay is recorded on the service lines (S) and
 *  on the admission record (I); dating S at SVCDATE gives one stay two event
 *  rows with different dates whenever the stay lasts more than a day, which
 *  DISTINCT cannot collapse. That inflates claim counts and lets a
 *  `minClaims >= 2` rule be satisfied by a single admission.
 *
 *  ADMDATE is present on both tables, so this needs no CASEID join — which is
 *  just as well: BR-KEY-002b warns that CASEID is unique only within a
 *  (database, year, release) and must never be joined across years.
 *  Regression: fixture patient P14. */
const CLAIM_SOURCES = [
  { key: "outpatient_services", setting: "outpatient", dateCol: "svcdate" },
  { key: "inpatient_services", setting: "inpatient", dateCol: "admdate" },
  { key: "inpatient_admissions", setting: "inpatient", dateCol: "admdate" },
] as const;

function build02(ctx: Ctx): string {
  const { spec, d, wp } = ctx;
  const dx = dxLists(spec);
  const procs = procLists(spec);
  const hasDrugs = drugNameLists(spec).length > 0 || ndcLists(spec).length > 0;
  const out: string[] = [];

  if (dx.length === 0 && procs.length === 0 && !hasDrugs) {
    out.push(`-- This spec has no code lists at all; creating an empty events table so`);
    out.push(`-- the later scripts can still run.`);
    out.push(d.createTableAs(`${wp}_events`));
    out.push(`SELECT CAST(NULL AS VARCHAR) AS enrolid,`);
    out.push(`       CAST(NULL AS DATE)    AS event_date,`);
    out.push(`       CAST(NULL AS VARCHAR) AS event_type,`);
    out.push(`       CAST(NULL AS VARCHAR) AS setting,`);
    out.push(`       CAST(NULL AS VARCHAR) AS code_list_id,`);
    out.push(`       CAST(NULL AS VARCHAR) AS code`);
    out.push(`WHERE 1 = 0;`);
    return out.join("\n");
  }

  out.push(`-- One long/tall table of every claim that matches a study code list:`);
  out.push(`--   (enrolid, event_date, event_type, setting, code_list_id, code)`);
  out.push(`-- event_type: 'dx' | 'drug' | 'proc'; setting: 'outpatient' | 'inpatient'`);
  out.push(`-- | 'pharmacy'. Every later step reads this table instead of raw claims.`);
  out.push(``);

  const ctes: string[] = [];
  const unionParts: string[] = [];

  if (dx.length > 0) {
    // -- dx_long: unpivot every DX column ------------------------------
    // Each table contributes one block; the block's leading comment stays
    // attached to its first SELECT so UNION ALL separators remain valid.
    const rows: string[] = [];
    for (const src of CLAIM_SOURCES) {
      const cols = DX_COLUMNS[src.key] ?? [];
      const selects = cols.map((cRaw) => {
        const c = cRaw.toLowerCase();
        return [
          `    SELECT enrolid, ${src.dateCol} AS event_date, '${src.setting}' AS setting,`,
          `           dxver, ${c} AS dx`,
          `    FROM ${ctx.t(src.key)}`,
          `    WHERE ${c} IS NOT NULL AND ${c} <> ''`,
        ].join("\n");
      });
      rows.push(
        `    -- ${src.key} (${letterFor(src.key)}): ${cols.join(", ").toLowerCase()}\n` +
          selects.join("\n    UNION ALL\n")
      );
    }
    ctes.push(
      [
        `  -- Diagnosis slots unpivoted to one row per (claim line, dx position)`,
        `  -- via UNION ALL. facility_header (F) is omitted by default; add its`,
        `  -- dx1..dx9 here if the study needs facility claims. Inpatient dx are`,
        `  -- read from both the admission summary (I) and the service lines (S),`,
        `  -- BOTH dated at ADMDATE so one stay yields one dated event per code and`,
        `  -- the final DISTINCT collapses the duplicate. (Dating S at SVCDATE`,
        `  -- would give a multi-day stay two dates for the same diagnosis.)`,
        `  dx_long AS (`,
        rows.join("\n    UNION ALL\n"),
        `  )`,
      ].join("\n")
    );

    // -- dx_events: filter to study code lists, era via DXVER ----------
    const perList: string[] = [];
    for (const list of dx) {
      const { icd10, icd9 } = splitDxEras(list);
      const conds: string[] = [];
      if (icd10.length > 0) {
        conds.push(`(dxver = '0' AND dx IN ${inList(icd10, "       ")})`);
      }
      if (icd9.length > 0) {
        conds.push(`((dxver = '9' OR dxver IS NULL) AND dx IN ${inList(icd9, "       ")})`);
      }
      if (conds.length === 0) continue;
      perList.push(
        [
          `    -- ${oneLine(list.label)} [${list.id}]`,
          `    SELECT enrolid, event_date, 'dx' AS event_type, setting,`,
          `           '${q(list.id)}' AS code_list_id, dx AS code`,
          `    FROM dx_long`,
          `    WHERE ${conds.join("\n       OR ")}`,
        ].join("\n")
      );
    }
    ctes.push(
      [
        `  -- Keep only codes on the study's diagnosis lists. DXVER picks the era:`,
        `  -- '0' = ICD-10-CM, '9' = ICD-9-CM; NULL (older deliveries) -> ICD-9.`,
        `  -- Codes are matched dot-free, as stored in claims (L40.0 -> 'L400').`,
        `  dx_events AS (`,
        perList.join("\n\n    UNION ALL\n\n"),
        `  )`,
      ].join("\n")
    );
    unionParts.push(`  SELECT * FROM dx_events`);
  }

  if (hasDrugs) {
    ctes.push(
      [
        `  -- Pharmacy claims joined to the NDC lookup built by 01_ndc_lookup.sql.`,
        `  drug_events AS (`,
        `    SELECT dr.enrolid, dr.svcdate AS event_date, 'drug' AS event_type,`,
        `           'pharmacy' AS setting, n.code_list_id, dr.ndcnum AS code`,
        `    FROM ${ctx.t("drug_claims")} dr`,
        `    JOIN ${wp}_ndc_lookup n`,
        `      ON dr.ndcnum = n.ndcnum`,
        `  )`,
      ].join("\n")
    );
    unionParts.push(`  SELECT * FROM drug_events`);
  }

  if (procs.length > 0) {
    const rows: string[] = [];
    for (const src of CLAIM_SOURCES) {
      const cols = PROC_COLUMNS[src.key] ?? [];
      const selects = cols.map((cRaw) => {
        const c = cRaw.toLowerCase();
        return [
          `    SELECT enrolid, ${src.dateCol} AS event_date, '${src.setting}' AS setting,`,
          `           ${c} AS proc`,
          `    FROM ${ctx.t(src.key)}`,
          `    WHERE ${c} IS NOT NULL AND ${c} <> ''`,
        ].join("\n");
      });
      rows.push(
        `    -- ${src.key} (${letterFor(src.key)}): ${cols.join(", ").toLowerCase()}\n` +
          selects.join("\n    UNION ALL\n")
      );
    }
    ctes.push(
      [
        `  -- Procedure slots unpivoted, same shape as dx_long. PROCTYP is not`,
        `  -- filtered; add it if a list mixes CPT and ICD procedure codes.`,
        `  proc_long AS (`,
        rows.join("\n    UNION ALL\n"),
        `  )`,
      ].join("\n")
    );
    const perList: string[] = [];
    for (const list of procs) {
      const codes = dedupe(list.codes.map((c) => claimCode(c.code)).filter((c) => c.length > 0));
      if (codes.length === 0) continue;
      perList.push(
        [
          `    -- ${oneLine(list.label)} [${list.id}]`,
          `    SELECT enrolid, event_date, 'proc' AS event_type, setting,`,
          `           '${q(list.id)}' AS code_list_id, proc AS code`,
          `    FROM proc_long`,
          `    WHERE proc IN ${inList(codes, "       ")}`,
        ].join("\n")
      );
    }
    ctes.push(
      [`  proc_events AS (`, perList.join("\n\n    UNION ALL\n\n"), `  )`].join("\n")
    );
    unionParts.push(`  SELECT * FROM proc_events`);
  }

  ctes.push(
    [
      `  all_events AS (`,
      unionParts.join("\n  UNION ALL\n"),
      `  )`,
    ].join("\n")
  );

  out.push(d.createTableAs(`${wp}_events`));
  out.push(`WITH`);
  out.push(ctes.join(",\n\n"));
  out.push(`-- DISTINCT collapses the same code repeated across dx slots or service`);
  out.push(`-- lines of one claim; the date bound is the observable study window.`);
  out.push(`SELECT DISTINCT enrolid, event_date, event_type, setting, code_list_id, code`);
  out.push(`FROM all_events`);
  out.push(`WHERE event_date >= DATE '${spec.meta.studyPeriod.start}'`);
  out.push(`  AND event_date <= DATE '${spec.meta.studyPeriod.end}';`);
  out.push(``);
  out.push(`-- REVIEW: event volume per list - a zero row here means an upstream`);
  out.push(`-- code-list or lookup problem.`);
  out.push(`SELECT code_list_id, event_type, setting,`);
  out.push(`       COUNT(*) AS events, COUNT(DISTINCT enrolid) AS patients`);
  out.push(`FROM ${wp}_events`);
  out.push(`GROUP BY code_list_id, event_type, setting`);
  out.push(`ORDER BY code_list_id, event_type, setting;`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* 03 - index                                                          */
/* ------------------------------------------------------------------ */

const INDEX_EVENT_TYPE: Record<string, string> = {
  first_drug_claim: "drug",
  first_diagnosis: "dx",
  first_procedure: "proc",
};

function build03(ctx: Ctx): string {
  const { spec, d, wp } = ctx;
  const rule = spec.indexEvent;
  const list = findCodeList(spec, rule.codeListId);
  const evType = INDEX_EVENT_TYPE[rule.type] ?? "drug";
  const out: string[] = [];
  out.push(`-- Index rule  : ${rule.type} from list "${oneLine(list ? list.label : rule.codeListId)}"`);
  out.push(`-- Index period: ${rule.indexPeriod.start} .. ${rule.indexPeriod.end} (index date must fall inside)`);
  if (rule.description) out.push(`-- ${oneLine(rule.description)}`);
  out.push(`-- The index date is "time zero": baseline runs backward from it (and`);
  out.push(`-- includes it); follow-up runs forward from it (and excludes it).`);
  out.push(``);
  out.push(d.createTableAs(`${wp}_index`));
  out.push(`WITH candidates AS (`);
  out.push(`  SELECT enrolid,`);
  out.push(`         event_date,`);
  out.push(`         code,`);
  out.push(`         -- First qualifying claim per patient (event_date is the claim`);
  out.push(`         -- svcdate). Same-day ties break on code for determinism.`);
  out.push(`         ROW_NUMBER() OVER (PARTITION BY enrolid`);
  out.push(`                            ORDER BY event_date, code) AS rn`);
  out.push(`  FROM ${wp}_events`);
  out.push(`  WHERE event_type = '${evType}'`);
  out.push(`    AND code_list_id = '${q(rule.codeListId)}'`);
  out.push(`    AND event_date >= DATE '${rule.indexPeriod.start}'`);
  out.push(`    AND event_date <= DATE '${rule.indexPeriod.end}'`);
  out.push(`)`);
  out.push(`SELECT enrolid,`);
  out.push(`       event_date AS index_date,  -- time zero`);
  out.push(`       code       AS index_code   -- defining code (e.g. index drug NDC)`);
  out.push(`FROM candidates`);
  out.push(`WHERE rn = 1;`);
  out.push(``);
  out.push(`-- REVIEW: cohort entry sanity check.`);
  out.push(`SELECT COUNT(*)        AS patients,`);
  out.push(`       MIN(index_date) AS earliest_index,`);
  out.push(`       MAX(index_date) AS latest_index`);
  out.push(`FROM ${wp}_index;`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* 04 - enrollment                                                     */
/* ------------------------------------------------------------------ */

function rxCoverageFilter(spec: StudySpec): { where: string; comment: string } {
  if (!spec.enrollment.requiresRxCoverage) {
    return {
      where: "",
      comment: "-- Rx coverage not required by the spec; all segments retained.",
    };
  }
  if (spec.meta.database === "marketscan_medicaid") {
    return {
      where: `  WHERE drugcovg = '1'`,
      comment: "-- Rx coverage required: Medicaid uses drugcovg = '1'.",
    };
  }
  return {
    where: `  WHERE rx = '1'`,
    comment: "-- Rx coverage required: CCAE/MDCR flag segments with rx = '1'.",
  };
}

function build04(ctx: Ctx): string {
  const { spec, d, wp } = ctx;
  const enr = spec.enrollment;
  const gap = enr.gapAllowanceDays;
  const bdOff = enr.baselineDays > 0 ? -(enr.baselineDays - 1) : 0;
  const rx = rxCoverageFilter(spec);
  /* Running MAX of every PRIOR segment end — not LAG(dtend).
   *
   * Real deliveries contain nested and overlapping segments (a short plan-change
   * row inside a long span). Comparing against only the immediately preceding
   * row's end then measures the gap from the SHORT segment and wrongly opens a
   * new episode, truncating coverage and dropping members from the cohort. The
   * running maximum is the correct gaps-and-islands form and matches the SAS
   * twin, whose retain algorithm already only ever moved its running end
   * forward. Regression: fixture patient P13. */
  const lagEnd =
    `MAX(dtend) OVER (PARTITION BY enrolid ORDER BY dtstart, dtend ` +
    `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`;
  const out: string[] = [];

  out.push(`-- Members appear in enrollment detail as one row per contiguous coverage`);
  out.push(`-- segment. Real deliveries split coverage at every plan change, so the`);
  out.push(`-- study stitches segments whose lapse is within the gap allowance`);
  out.push(`-- (${gap} days) into continuous "episodes" (gaps-and-islands).`);
  out.push(``);
  out.push(d.createTableAs(`${wp}_enroll_episodes`));
  out.push(`WITH seg AS (`);
  out.push(`  ${rx.comment}`);
  out.push(`  -- Rows with a null member id or null coverage dates cannot define an`);
  out.push(`  -- episode. They are excluded EXPLICITLY (BR-KEY-004) rather than left`);
  out.push(`  -- to drop out silently in a later join, and the SAS twin filters the`);
  out.push(`  -- same three columns at its enrollment pull.`);
  out.push(`  SELECT enrolid, dtstart, dtend`);
  out.push(`  FROM ${ctx.t("enrollment_detail")}`);
  out.push(`  WHERE enrolid IS NOT NULL`);
  out.push(`    AND dtstart IS NOT NULL`);
  out.push(`    AND dtend   IS NOT NULL`);
  if (rx.where) out.push(`    ${rx.where.trim().replace(/^WHERE\s+/i, "AND ")}`);
  out.push(`),`);
  out.push(``);
  out.push(`flagged AS (`);
  out.push(`  -- A segment starts a NEW episode when the day count from the FURTHEST`);
  out.push(`  -- coverage end seen so far to this segment's start exceeds the gap`);
  out.push(`  -- allowance (${gap} days), or when there is no previous segment.`);
  out.push(`  -- The running MAX (not the previous row's end) is what makes nested and`);
  out.push(`  -- overlapping segments stitch correctly: a short plan-change row inside`);
  out.push(`  -- a long span must not be mistaken for the end of coverage.`);
  out.push(`  SELECT enrolid, dtstart, dtend,`);
  out.push(`         CASE`);
  out.push(`           WHEN ${lagEnd} IS NULL THEN 1`);
  out.push(`           WHEN ${d.daysBetween("dtstart", lagEnd)} > ${gap} THEN 1`);
  out.push(`           ELSE 0`);
  out.push(`         END AS new_episode`);
  out.push(`  FROM seg`);
  out.push(`),`);
  out.push(``);
  out.push(`numbered AS (`);
  out.push(`  -- Running SUM() of the flags gives each member a stable episode id.`);
  out.push(`  SELECT enrolid, dtstart, dtend,`);
  out.push(`         SUM(new_episode) OVER (PARTITION BY enrolid`);
  out.push(`                                ORDER BY dtstart, dtend`);
  out.push(`                                ROWS BETWEEN UNBOUNDED PRECEDING`);
  out.push(`                                         AND CURRENT ROW) AS episode_id`);
  out.push(`  FROM flagged`);
  out.push(`)`);
  out.push(``);
  out.push(`-- Collapse each episode to its start/end span.`);
  out.push(`SELECT enrolid,`);
  out.push(`       episode_id,`);
  out.push(`       MIN(dtstart) AS episode_start,`);
  out.push(`       MAX(dtend)   AS episode_end,`);
  out.push(`       COUNT(*)     AS n_segments`);
  out.push(`FROM numbered`);
  out.push(`GROUP BY enrolid, episode_id;`);
  out.push(``);
  out.push(`-- Continuous-enrollment check against the index date.`);
  out.push(`-- Baseline INCLUDES the index date and runs backward: ${enr.baselineDays} covered days`);
  out.push(`-- means episode_start <= index_date ${bdOff === 0 ? "" : `- ${-bdOff} `}(days ${bdOff}..0).`);
  out.push(`-- Follow-up EXCLUDES the index date: episode_end >= index_date + ${enr.followupDays}.`);
  out.push(`-- 05_attrition.sql re-applies this as a numbered criterion; this table is`);
  out.push(`-- the reusable member-level view of who clears the study-level rule.`);
  out.push(d.createTableAs(`${wp}_enrolled`));
  out.push(`SELECT i.enrolid, i.index_date, i.index_code,`);
  out.push(`       e.episode_start, e.episode_end`);
  out.push(`FROM ${wp}_index i`);
  out.push(`JOIN ${wp}_enroll_episodes e`);
  out.push(`  ON e.enrolid = i.enrolid`);
  out.push(` AND e.episode_start <= ${d.offset("i.index_date", bdOff)}`);
  out.push(` AND e.episode_end   >= ${d.offset("i.index_date", enr.followupDays)};`);
  out.push(``);
  out.push(`-- REVIEW: how much of the indexed population clears enrollment.`);
  out.push(`SELECT (SELECT COUNT(*) FROM ${wp}_index)    AS indexed_patients,`);
  out.push(`       (SELECT COUNT(*) FROM ${wp}_enrolled) AS continuously_enrolled;`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* 05 - attrition                                                      */
/* ------------------------------------------------------------------ */

interface EventCriterionParts {
  comments: string[];
  joinConds: string[];
  having: string[];
}

function eventCriterionParts(
  ctx: Ctx,
  test: Extract<
    Criterion["test"],
    { type: "diagnosis" | "procedure" | "drug" }
  >
): EventCriterionParts {
  const { spec, d } = ctx;
  const evType =
    test.type === "diagnosis" ? "dx" : test.type === "drug" ? "drug" : "proc";
  const list = findCodeList(spec, test.codeListId);
  const setting = test.type === "drug" ? "pharmacy (implied)" : test.setting;
  const comments: string[] = [
    `  --   requires: >= ${test.minClaims} claim(s) of "${oneLine(list ? list.label : test.codeListId)}" [${test.codeListId}]`,
    `  --   setting : ${setting}`,
    `  --   window  : ${describeWindow(test.window)}`,
  ];
  const joinConds: string[] = [
    `ev.event_type = '${evType}'`,
    `ev.code_list_id = '${q(test.codeListId)}'`,
  ];
  if (test.type !== "drug" && test.setting !== "any") {
    joinConds.push(`ev.setting = '${test.setting}'`);
  }
  joinConds.push(...windowConds(test.window, "ev.event_date", "s.index_date", d));

  const having: string[] = [];
  const sep = test.type === "diagnosis" ? test.claimSeparationDays : undefined;
  if (sep !== undefined && sep > 0) {
    // Distinct service dates so two dx slots on one claim don't count twice.
    having.push(`COUNT(DISTINCT ev.event_date) >= ${test.minClaims}`);
    having.push(
      `${d.daysBetween("MAX(ev.event_date)", "MIN(ev.event_date)")} >= ${sep}`
    );
    comments.push(
      `  --   separation: span of claim dates must be >= ${sep} day(s) (MAX - MIN)`
    );
    if (test.minClaims > 2) {
      comments.push(
        `  --   NOTE: with > 2 required claims, MAX-MIN checks the overall span only;`,
        `  --   use a self-join if every consecutive pair must be separated.`
      );
    }
  } else if (test.minClaims > 1) {
    /* Distinct service DATES, not rows. The same code in two diagnosis slots of
     * one claim — or on both inpatient sources for one stay — is a single
     * clinical encounter, so COUNT(*) would let one encounter satisfy
     * ">= 2 claims". This also matches the SAS twin, which has always counted
     * distinct dates here, and the separation branch above. */
    having.push(`COUNT(DISTINCT ev.event_date) >= ${test.minClaims}`);
    comments.push(
      `  --   counted as DISTINCT service dates (one encounter = one claim)`
    );
  }
  return { comments, joinConds, having };
}

function criterionCtes(
  ctx: Ctx,
  c: Criterion,
  stepNo: number,
  prev: string
): string[] {
  const { spec, d, wp } = ctx;
  const name = `step_${pad2(stepNo)}`;
  const head = [
    `  -- Step ${stepNo} [${c.kind}] ${c.id}`,
    `  -- "${oneLine(c.sourceText)}"`,
  ];
  const test = c.test;

  switch (test.type) {
    case "diagnosis":
    case "procedure":
    case "drug": {
      const parts = eventCriterionParts(ctx, test);
      const joinLines = [
        `    JOIN ${wp}_events ev`,
        `      ON ev.enrolid = ${"s.enrolid"}`,
        ...parts.joinConds.map((x) => `     AND ${x}`),
      ];
      if (c.kind === "inclusion") {
        const L = [
          ...head,
          ...parts.comments,
          `  ${name} AS (`,
          `    SELECT s.enrolid, s.index_date`,
          `    FROM ${prev} s`,
          ...joinLines,
          `    GROUP BY s.enrolid, s.index_date`,
        ];
        if (parts.having.length > 0) {
          L.push(`    HAVING ${parts.having.join("\n       AND ")}`);
        }
        L.push(`  )`);
        return [L.join("\n")];
      }
      // Exclusion: build the set of members who DO qualify, then anti-join.
      const hits = `${name}_hits`;
      const hitsCte = [
        ...head,
        ...parts.comments,
        `  -- Exclusion, part 1: members of ${prev} who DO meet the condition.`,
        `  ${hits} AS (`,
        `    SELECT ev.enrolid`,
        `    FROM ${prev} s`,
        ...joinLines,
        `    GROUP BY ev.enrolid`,
      ];
      if (parts.having.length > 0) {
        hitsCte.push(`    HAVING ${parts.having.join("\n       AND ")}`);
      }
      hitsCte.push(`  )`);
      const stepCte = [
        `  -- Exclusion, part 2: keep only members with NO qualifying events.`,
        `  ${name} AS (`,
        `    SELECT s.enrolid, s.index_date`,
        `    FROM ${prev} s`,
        `    LEFT JOIN ${hits} h ON h.enrolid = s.enrolid`,
        `    WHERE h.enrolid IS NULL`,
        `  )`,
      ];
      return [hitsCte.join("\n"), stepCte.join("\n")];
    }

    case "age_at_index": {
      const ageExpr = `${d.year("s.index_date")} - dm.dobyr`;
      const conds: string[] = [];
      if (test.min !== undefined) conds.push(`${ageExpr} >= ${test.min}`);
      if (test.max !== undefined) conds.push(`${ageExpr} <= ${test.max}`);
      const L = [
        ...head,
        `  -- Age = index year - year of birth (DOBYR is the only DOB field in`,
        `  -- MarketScan, so age is calendar-year precision).`,
        `  ${name} AS (`,
        `    SELECT s.enrolid, s.index_date`,
        `    FROM ${prev} s`,
        `    JOIN demo dm ON dm.enrolid = s.enrolid`,
      ];
      if (conds.length > 0) L.push(`    WHERE ${conds.join("\n      AND ")}`);
      else L.push(`    -- no age bounds given; criterion passes everyone through`);
      L.push(`  )`);
      return [L.join("\n")];
    }

    case "sex": {
      const code = test.value === "M" ? "1" : "2";
      return [
        [
          ...head,
          `  ${name} AS (`,
          `    SELECT s.enrolid, s.index_date`,
          `    FROM ${prev} s`,
          `    JOIN demo dm ON dm.enrolid = s.enrolid`,
          `    WHERE dm.sex = '${code}'  -- MarketScan: '1' = male, '2' = female`,
          `  )`,
        ].join("\n"),
      ];
    }

    case "continuous_enrollment": {
      const bdOff = test.baselineDays > 0 ? -(test.baselineDays - 1) : 0;
      const L = [
        ...head,
        `  -- Baseline INCLUDES index (days ${bdOff}..0 => ${test.baselineDays} covered days);`,
        `  -- follow-up EXCLUDES index (days 1..${test.followupDays}). One stitched episode`,
        `  -- from 04_enrollment.sql must span the whole interval.`,
      ];
      if (test.requiresRxCoverage !== spec.enrollment.requiresRxCoverage) {
        L.push(
          `  -- NOTE: this criterion's Rx-coverage requirement (${test.requiresRxCoverage}) differs`,
          `  -- from the study enrollment rule (${spec.enrollment.requiresRxCoverage}); episodes in`,
          `  -- 04_enrollment.sql were built under the study rule.`
        );
      }
      L.push(
        `  ${name} AS (`,
        `    SELECT DISTINCT s.enrolid, s.index_date`,
        `    FROM ${prev} s`,
        `    JOIN ${wp}_enroll_episodes e`,
        `      ON e.enrolid = s.enrolid`,
        `     AND e.episode_start <= ${d.offset("s.index_date", bdOff)}`,
        `     AND e.episode_end   >= ${d.offset("s.index_date", test.followupDays)}`,
        `  )`
      );
      return [L.join("\n")];
    }

    case "unmapped": {
      return [
        [
          ...head,
          `  -- !!! UNMAPPED CRITERION - the extractor could not translate this rule.`,
          `  -- !!! It passes everyone through; resolve it in the workbench and`,
          `  -- !!! re-emit before trusting the attrition below.`,
          `  ${name} AS (`,
          `    SELECT enrolid, index_date FROM ${prev}`,
          `  )`,
        ].join("\n"),
      ];
    }
  }
}

function build05(ctx: Ctx): string {
  const { spec, d, wp } = ctx;
  const needDemo = spec.criteria.some(
    (c) => c.test.type === "age_at_index" || c.test.type === "sex"
  );
  const idxList = findCodeList(spec, spec.indexEvent.codeListId);
  const out: string[] = [];

  out.push(`-- CONSORT-style attrition: criteria apply SEQUENTIALLY in spec order, so`);
  out.push(`-- each step count is "survivors of steps 0..k". Windows are day offsets`);
  out.push(`-- relative to the index date (negative = before; baseline includes index,`);
  out.push(`-- follow-up excludes it).`);
  out.push(``);

  const ctes: string[] = [];
  if (needDemo) {
    ctes.push(
      [
        `  -- Member demographics (one row per member) for age/sex criteria.`,
        `  demo AS (`,
        `    SELECT enrolid, MIN(dobyr) AS dobyr, MIN(sex) AS sex`,
        `    FROM ${ctx.t("enrollment_detail")}`,
        `    GROUP BY enrolid`,
        `  )`,
      ].join("\n")
    );
  }
  ctes.push(
    [
      `  -- Step 0: everyone with a qualifying index event (03_index.sql).`,
      `  step_00 AS (`,
      `    SELECT enrolid, index_date`,
      `    FROM ${wp}_index`,
      `  )`,
    ].join("\n")
  );

  const labels: string[] = [
    `Index event: ${spec.indexEvent.type.replace(/_/g, " ")} of "${oneLine(
      idxList ? idxList.label : spec.indexEvent.codeListId
    )}" in ${spec.indexEvent.indexPeriod.start}..${spec.indexEvent.indexPeriod.end}`,
  ];

  let prev = "step_00";
  spec.criteria.forEach((c, i) => {
    const stepNo = i + 1;
    labels.push(`[${c.kind}] ${oneLine(c.sourceText)}`);
    ctes.push(...criterionCtes(ctx, c, stepNo, prev));
    prev = `step_${pad2(stepNo)}`;
  });

  const nSteps = spec.criteria.length;

  out.push(d.createTableAs(`${wp}_attrition_steps`));
  out.push(`WITH`);
  out.push(ctes.join(",\n\n"));
  out.push(`-- One row per (step, member): step k = member survives criteria 1..k.`);
  out.push(`SELECT 0 AS step, enrolid, index_date FROM step_00`);
  for (let i = 1; i <= nSteps; i++) {
    out.push(`UNION ALL SELECT ${i} AS step, enrolid, index_date FROM step_${pad2(i)}`);
  }
  out.push(`;`);
  out.push(``);
  out.push(`-- Final analysis cohort = survivors of the last step, with index details.`);
  out.push(d.createTableAs(`${wp}_cohort`));
  out.push(`SELECT i.enrolid, i.index_date, i.index_code`);
  out.push(`FROM ${wp}_index i`);
  out.push(`JOIN ${wp}_attrition_steps s`);
  out.push(`  ON s.enrolid = i.enrolid`);
  out.push(` AND s.step = ${nSteps};`);
  out.push(``);
  out.push(`-- ATTRITION REPORT - one labeled row per sequential step, in order.`);
  const reportRows = labels.map(
    (label, i) =>
      `SELECT ${i} AS step, '${q(label)}' AS criterion,\n` +
      `       COUNT(DISTINCT enrolid) AS patients\n` +
      `FROM ${wp}_attrition_steps\nWHERE step = ${i}`
  );
  out.push(reportRows.join("\n\nUNION ALL\n\n"));
  out.push(``);
  out.push(`ORDER BY step;`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* 06 - baseline (Table 1)                                             */
/* ------------------------------------------------------------------ */

const NULL_NUM = `CAST(NULL AS NUMERIC)`;

function categoricalBranch(
  ctx: Ctx,
  ord: number,
  label: string,
  categoryExpr: string,
  note?: string
): string {
  const { d } = ctx;
  const L: string[] = [];
  L.push(`-- ${label}${note ? ` (${note})` : ""}`);
  L.push(`SELECT ${ord} AS ord,`);
  L.push(`       '${q(label)}' AS characteristic,`);
  L.push(`       x.category,`);
  L.push(`       COUNT(*) AS n_patients,`);
  L.push(`       ${d.round1(`100.0 * COUNT(*) / MAX(t.n)`)} AS pct,`);
  L.push(`       ${NULL_NUM} AS mean_val,`);
  L.push(`       ${NULL_NUM} AS sd_val,`);
  L.push(`       ${NULL_NUM} AS median_val`);
  L.push(`FROM (SELECT ${categoryExpr} AS category FROM demo1) x`);
  L.push(`CROSS JOIN n_total t`);
  L.push(`GROUP BY x.category`);
  return L.join("\n");
}

function baselineWindow(spec: StudySpec, ch: BaselineCharacteristic): RelativeWindow {
  if (ch.window) return ch.window;
  const bd = spec.enrollment.baselineDays;
  return { start: bd > 0 ? -(bd - 1) : 0, end: 0, includesIndex: true };
}

function build06(ctx: Ctx): string {
  const { spec, d, wp } = ctx;
  const out: string[] = [];
  const needDemo = spec.baseline.some((b) =>
    ["age", "sex", "region", "plan_type", "year"].includes(b.kind)
  );
  const bd = spec.enrollment.baselineDays;
  const bdOff = bd > 0 ? -(bd - 1) : 0;

  out.push(`-- Table 1 (baseline characteristics) over the final cohort, one long`);
  out.push(`-- result table: (ord, characteristic, category, n_patients, pct,`);
  out.push(`-- mean_val, sd_val, median_val). Categorical rows fill n/pct; continuous`);
  out.push(`-- rows fill mean/sd/median. Default baseline window: days ${bdOff}..0`);
  out.push(`-- (includes the index date, runs backward).`);
  out.push(``);

  const ctes: string[] = [];
  ctes.push(
    [
      `  cohort AS (`,
      `    SELECT enrolid, index_date FROM ${wp}_cohort`,
      `  )`,
    ].join("\n")
  );
  ctes.push(
    [
      `  n_total AS (`,
      `    SELECT COUNT(DISTINCT enrolid) AS n FROM cohort`,
      `  )`,
    ].join("\n")
  );
  if (needDemo) {
    ctes.push(
      [
        `  -- Demographics from the enrollment segment in force at (or latest`,
        `  -- before) the index date; rn = 1 picks that segment.`,
        `  demo AS (`,
        `    SELECT c.enrolid, c.index_date, en.dobyr, en.sex, en.region, en.plantyp,`,
        `           ROW_NUMBER() OVER (PARTITION BY c.enrolid`,
        `                              ORDER BY en.dtstart DESC, en.dtend DESC) AS rn`,
        `    FROM cohort c`,
        `    JOIN ${ctx.t("enrollment_detail")} en`,
        `      ON en.enrolid = c.enrolid`,
        `     AND en.dtstart <= c.index_date`,
        `  )`,
      ].join("\n")
    );
    ctes.push(
      [
        `  demo1 AS (`,
        `    SELECT enrolid, index_date,`,
        `           ${d.year("index_date")} - dobyr AS age_at_index,`,
        `           CAST(sex AS VARCHAR)     AS sex,`,
        `           CAST(region AS VARCHAR)  AS region,`,
        `           CAST(plantyp AS VARCHAR) AS plantyp`,
        `    FROM demo`,
        `    WHERE rn = 1`,
        `  )`,
      ].join("\n")
    );
  }

  const branches: string[] = [];
  const skipped: string[] = [];

  branches.push(
    [
      `-- Cohort size (denominator for every percentage below)`,
      `SELECT 0 AS ord,`,
      `       'Cohort' AS characteristic,`,
      `       'N' AS category,`,
      `       t.n AS n_patients,`,
      `       ${NULL_NUM} AS pct,`,
      `       ${NULL_NUM} AS mean_val,`,
      `       ${NULL_NUM} AS sd_val,`,
      `       ${NULL_NUM} AS median_val`,
      `FROM n_total t`,
    ].join("\n")
  );

  spec.baseline.forEach((ch, i) => {
    const ord = i + 1;
    switch (ch.kind) {
      case "age": {
        branches.push(
          [
            `-- ${oneLine(ch.label)} (continuous, years)`,
            `SELECT ${ord} AS ord,`,
            `       '${q(oneLine(ch.label))}' AS characteristic,`,
            `       '(years)' AS category,`,
            `       COUNT(*) AS n_patients,`,
            `       ${NULL_NUM} AS pct,`,
            `       ${d.round1(`AVG(age_at_index)`)} AS mean_val,`,
            `       ${d.round1(`STDDEV(age_at_index)`)} AS sd_val,`,
            `       ${d.round1(
              `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY age_at_index)`
            )} AS median_val`,
            `FROM demo1`,
          ].join("\n")
        );
        break;
      }
      case "sex": {
        branches.push(
          categoricalBranch(
            ctx,
            ord,
            oneLine(ch.label),
            `CASE sex WHEN '1' THEN 'Male' WHEN '2' THEN 'Female'\n                   ELSE 'Unknown' END`,
            `MarketScan: '1' = male, '2' = female`
          )
        );
        break;
      }
      case "region": {
        branches.push(
          categoricalBranch(
            ctx,
            ord,
            oneLine(ch.label),
            `CASE region WHEN '1' THEN 'Northeast' WHEN '2' THEN 'North Central'\n                   WHEN '3' THEN 'South' WHEN '4' THEN 'West'\n                   ELSE 'Unknown' END`,
            `census region codes`
          )
        );
        break;
      }
      case "plan_type": {
        branches.push(
          categoricalBranch(
            ctx,
            ord,
            oneLine(ch.label),
            `COALESCE(plantyp, 'Unknown')`,
            `raw PLANTYP codes; recode to labels post hoc if preferred`
          )
        );
        break;
      }
      case "year": {
        branches.push(
          categoricalBranch(
            ctx,
            ord,
            oneLine(ch.label),
            `CAST(${d.year("index_date")} AS VARCHAR)`
          )
        );
        break;
      }
      case "comorbidity":
      case "medication": {
        if (!ch.codeListId) {
          skipped.push(
            `-- SKIPPED "${oneLine(ch.label)}" (${ch.kind}): no code list attached in the spec.`
          );
          break;
        }
        const w = baselineWindow(spec, ch);
        const conds = windowConds(w, "ev.event_date", "c.index_date", d);
        branches.push(
          [
            `-- ${oneLine(ch.label)} (${ch.kind}; window: ${describeWindow(w)})`,
            `SELECT ${ord} AS ord,`,
            `       '${q(oneLine(ch.label))}' AS characteristic,`,
            `       'present (>= 1 claim in window)' AS category,`,
            `       COUNT(DISTINCT c.enrolid) AS n_patients,`,
            `       ${d.round1(
              `100.0 * COUNT(DISTINCT c.enrolid) / MAX(t.n)`
            )} AS pct,`,
            `       ${NULL_NUM} AS mean_val,`,
            `       ${NULL_NUM} AS sd_val,`,
            `       ${NULL_NUM} AS median_val`,
            `FROM cohort c`,
            `CROSS JOIN n_total t`,
            `JOIN ${wp}_events ev`,
            `  ON ev.enrolid = c.enrolid`,
            ` AND ev.code_list_id = '${q(ch.codeListId)}'`,
            ...conds.map((x) => ` AND ${x}`),
          ].join("\n")
        );
        break;
      }
      case "utilization": {
        const w = baselineWindow(spec, ch);
        const conds = windowConds(w, "o.svcdate", "c.index_date", d);
        branches.push(
          [
            `-- ${oneLine(ch.label)} (utilization; all-cause outpatient service days,`,
            `-- window: ${describeWindow(w)})`,
            `SELECT ${ord} AS ord,`,
            `       '${q(oneLine(ch.label))}' AS characteristic,`,
            `       '(visits per patient)' AS category,`,
            `       COUNT(*) AS n_patients,`,
            `       ${NULL_NUM} AS pct,`,
            `       ${d.round1(`AVG(u.n_visits)`)} AS mean_val,`,
            `       ${d.round1(`STDDEV(u.n_visits)`)} AS sd_val,`,
            `       ${d.round1(
              `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY u.n_visits)`
            )} AS median_val`,
            `FROM (`,
            `  SELECT c.enrolid, COUNT(DISTINCT o.svcdate) AS n_visits`,
            `  FROM cohort c`,
            `  LEFT JOIN ${ctx.t("outpatient_services")} o`,
            `    ON o.enrolid = c.enrolid`,
            ...conds.map((x) => `   AND ${x}`),
            `  GROUP BY c.enrolid`,
            `) u`,
          ].join("\n")
        );
        break;
      }
    }
  });

  if (skipped.length > 0) {
    out.push(...skipped);
    out.push(``);
  }

  out.push(d.createTableAs(`${wp}_table1`));
  out.push(`WITH`);
  out.push(ctes.join(",\n\n"));
  const indented = branches
    .map((b) => b.split("\n").map((l) => (l.length > 0 ? `  ${l}` : l)).join("\n"))
    .join("\n\n  UNION ALL\n\n");
  out.push(indented);
  out.push(`;`);
  out.push(``);
  out.push(`-- REVIEW: the assembled Table 1, in spec order.`);
  out.push(`SELECT characteristic, category, n_patients, pct,`);
  out.push(`       mean_val, sd_val, median_val`);
  out.push(`FROM ${wp}_table1`);
  out.push(`ORDER BY ord, category;`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Emitter                                                             */
/* ------------------------------------------------------------------ */

export const emitSql: SqlEmitter = (spec, dialect, opts) => {
  assertSafeIdent(opts.tag, "EmitOptions.tag");
  assertSafeNaming(opts.naming);
  const d = makeDialect(dialect);
  const ctx: Ctx = {
    spec,
    d,
    opts,
    wp: opts.tag.toLowerCase(),
    t: (key) => physicalTable(opts.naming, key),
  };

  const hasDx = dxLists(spec).length > 0 || procLists(spec).length > 0;
  const hasDrugs = drugNameLists(spec).length > 0 || ndcLists(spec).length > 0;
  const eventsTables: string[] = [];
  if (hasDx) {
    eventsTables.push(
      "outpatient_services",
      "inpatient_services",
      "inpatient_admissions"
    );
  }
  if (hasDrugs) eventsTables.push("drug_claims");

  const needDemo05 = spec.criteria.some(
    (c) => c.test.type === "age_at_index" || c.test.type === "sex"
  );
  const needDemo06 = spec.baseline.some((b) =>
    ["age", "sex", "region", "plan_type", "year"].includes(b.kind)
  );
  const needUtil06 = spec.baseline.some((b) => b.kind === "utilization");
  const t06: string[] = [];
  if (needDemo06) t06.push("enrollment_detail");
  if (needUtil06) t06.push("outpatient_services");

  const mk = (
    num: string,
    slug: string,
    title: string,
    subtitle: string,
    tables: string[],
    extra: string[],
    body: string
  ): GeneratedFile => ({
    path: `sql/${dialect}/${num}_${slug}.sql`,
    language: "sql",
    title,
    content: `${header(ctx, `${num}_${slug}.sql`, subtitle, tables, extra)}\n\n${body}\n`,
  });

  const files: GeneratedFile[] = [
    mk(
      "01",
      "ndc_lookup",
      "01 NDC lookup",
      "drug-name patterns to NDC codes",
      [],
      [
        `NDC reference table: "redbook" - REPLACE with your site's Redbook-style`,
        `table (needs columns: ndcnum, gennme, prodnme).`,
      ],
      build01(ctx)
    ),
    mk(
      "02",
      "events",
      "02 Event extraction",
      "long clinical event table from claims",
      eventsTables,
      [],
      build02(ctx)
    ),
    mk(
      "03",
      "index",
      "03 Index event",
      "first qualifying event per patient (time zero)",
      [],
      [],
      build03(ctx)
    ),
    mk(
      "04",
      "enrollment",
      "04 Enrollment stitching",
      "gaps-and-islands episodes + continuous-enrollment check",
      ["enrollment_detail"],
      [],
      build04(ctx)
    ),
    mk(
      "05",
      "attrition",
      "05 Attrition",
      "sequential cohort criteria (CONSORT counts)",
      needDemo05 ? ["enrollment_detail"] : [],
      [],
      build05(ctx)
    ),
    mk(
      "06",
      "baseline",
      "06 Baseline Table 1",
      "baseline characteristic aggregates",
      t06,
      [],
      build06(ctx)
    ),
  ];

  // 07+ analysis modules (one file per enabled analysis), dispatched through
  // the module registry in spec order. The suffix (applied to slug AND output
  // table names) disambiguates several analyses of the same kind.
  // Result tables that carry patient counts, for the suppression pass below.
  const suppressTargets: SuppressionTarget[] = [];
  if (spec.analyses.some((a) => a.enabled && a.kind === "table1")) {
    suppressTargets.push({ table: `${ctx.wp}_table1`, shapeKey: "table1", label: "Baseline characteristics (Table 1)" });
  }

  let lastNum = 6;
  moduleAnalyses(spec.analyses).forEach(({ an, mod, multi }, i) => {
    const suffix = multi ? `_${an.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : "";
    const num = String(7 + i).padStart(2, "0");
    lastNum = 7 + i;
    const f = mod.sql(ctx, an as never, suffix);
    // the module returns a bare title; the emitter owns the file number so the
    // displayed title always matches the actual NN_slug filename
    files.push(mk(num, f.slug, `${num} ${f.title}`, f.subtitle, [], f.extra, f.body));
    suppressTargets.push({ table: `${ctx.wp}_${f.slug}`, shapeKey: mod.stampKind, label: `${an.label} (${an.kind})` });
  });

  /* Small-cell suppression — the last step, because it reads every result table
   * the study produced (BR-DEL-004). */
  const policy = suppressionPolicy(spec);
  if (policy.enabled && suppressTargets.length > 0) {
    const num = String(lastNum + 1).padStart(2, "0");
    const body: string[] = [];
    for (const t of suppressTargets) body.push(...suppressionSqlFor(t, policy));
    files.push(
      mk(
        num,
        "suppression",
        `${num} Small-cell suppression (releasable tables)`,
        `Masks cells below the disclosure threshold and writes <table>_released.`,
        [],
        [
          `-- Rule applied: ${policy.ruleLabel}.`,
          `-- Reads the result tables built above; writes one *_released table each.`,
          `-- The unsuppressed originals stay for YOUR QC and must NOT be released.`,
        ],
        body.join("\n"),
      ),
    );
  }

  return files;
};
