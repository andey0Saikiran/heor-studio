/**
 * SAS emitter — turns a reviewed StudySpec into a numbered MarketScan program
 * suite in authentic HEOR consulting house style (numbered programs, %LET
 * macro variables, level checks after every step).
 *
 * Everything here is deterministic: the same spec + options always produce
 * the same programs. Programs are skipped when the spec does not need them
 * (e.g. no drug_name code lists → no NDC-pull program).
 *
 * Domain conventions honoured throughout:
 *  - baseline period INCLUDES the index date and runs backward;
 *  - follow-up period EXCLUDES the index date and runs forward;
 *  - ICD-9-CM vs ICD-10-CM era is resolved via the DXVER claim column.
 */

import { DB_PREFIX, DX_COLUMNS, PROC_COLUMNS } from "../data/marketscan";
import type { TableNamingStrategy } from "../data/marketscan";
import { findCodeList } from "../spec/types";
import type {
  BaselineCharacteristic,
  CareSetting,
  CodeList,
  Criterion,
  RelativeWindow,
  StudySpec,
} from "../spec/types";
import type { EmitOptions, GeneratedFile, SasEmitter } from "./types";
import { assertSafeIdent, assertSafeNaming } from "./types";
import { renderDaysPerYear } from "./parity";
import {
  cmt,
  header,
  levelCheck,
  sasDate,
  sasName,
  sq,
  windowConds,
  yearWrap,
  INCLUDE_SETUP,
} from "./sas-base";
import type { Ctx, ListKind, PulledList, SiteNaming } from "./sas-base";
import { moduleAnalyses } from "./modules/registry";
import { comorbidityScoreSasScore, comorbidityScoreSasSteps, indexAnalysisFor } from "./comorbidity";
import { suppressionPolicy, suppressionSasFor, type SuppressionTarget } from "./suppression";
import { ascertainmentWindow, parityStamp } from "./parity";
import {
  resolveSweeps, sasArmCohortTable, sweepArmCohortsSas, sweepParity, sweepSummarySas,
  SWEEP_METHOD_NOTES,
} from "./sweep";

/* ================================================================== *
 *  small utilities
 * ================================================================== */

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

function qcode(s: string): string {
  return `'${sq(s)}'`;
}

/** quoted, comma-separated code values wrapped a few per line */
function chunkQuoted(codes: string[], perLine = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < codes.length; i += perLine) {
    const slice = codes.slice(i, i + perLine).map(qcode).join(",");
    out.push(i + perLine >= codes.length ? slice : slice + ",");
  }
  return out;
}

/**
 * Name pool guaranteeing resolved SAS names stay <= maxLen and unique
 * (SAS dataset member and macro-variable names are limited to 32 chars).
 */
function makeNamePool(maxLen: number): (key: string) => string {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  return (key: string): string => {
    const hit = assigned.get(key);
    if (hit) return hit;
    const base = key.length <= maxLen ? key : key.slice(0, maxLen);
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) {
      const suffix = String(n++);
      candidate = base.slice(0, maxLen - suffix.length) + suffix;
    }
    assigned.set(key, candidate);
    taken.add(candidate);
    return candidate;
  };
}

/* ================================================================== *
 *  physical table naming (site adaptation layer)
 * ================================================================== */

interface FamilyMeta {
  letter: string;
  label: string;
}

const FAMILY: Record<string, FamilyMeta> = {
  enrollment_detail: { letter: "t", label: "enrollment detail" },
  drug_claims: { letter: "d", label: "outpatient pharmacy claims" },
  outpatient_services: { letter: "o", label: "outpatient services" },
  inpatient_services: { letter: "s", label: "inpatient services" },
  inpatient_admissions: { letter: "i", label: "inpatient admissions" },
};

function makeSite(naming: TableNamingStrategy, database: string): SiteNaming {
  const familyComment = (letter: string): string => {
    const fam = Object.values(FAMILY).find((f) => f.letter === letter);
    return fam ? fam.label : letter;
  };

  if (naming.kind === "yearly_sas") {
    const prefix = sasName(naming.prefix);
    return {
      yearLoop: true,
      libnameLines: [
        `libname raw "/EDIT/path/to/marketscan" access=readonly;  /* raw MarketScan yearly SAS data sets */`,
        `libname tz  "/EDIT/path/to/project/work";                /* persistent project work area        */`,
      ],
      namingLines: (letters) => [
        `/*-------------------- MarketScan physical table names -----------------------`,
        `| Delivery style: yearly SAS data sets named <prefix><letter><yy><release>,`,
        `| e.g. ${prefix}s181 = ${prefix} + s (inpatient services) + 18 (2018) + release 1.`,
        `| Family letters: t = enrollment detail, d = pharmacy claims,`,
        `| o = outpatient services, s = inpatient services, i = inpatient admissions.`,
        `| EDIT the libname above plus prefix/rel below so that, for example,`,
        `| %tab_o(2018) resolves to your 2018 outpatient services data set.`,
        `-----------------------------------------------------------------------------*/`,
        `%let prefix = ${prefix};   /* EDIT: database family prefix (${DB_PREFIX[database] ?? prefix} for ${database}) */`,
        `%let rel    = 1;${" ".repeat(Math.max(1, prefix.length - 1))}  /* EDIT: release digit in the yearly file names        */`,
        ``,
        ...letters.map(
          (le) =>
            `%macro tab_${le}(yr); raw.&prefix.${le}%substr(&yr.,3,2)&rel. %mend tab_${le};  /* ${familyComment(le)} */`
        ),
      ],
      tab: (letter) => `%tab_${letter}(&yr.)`,
      ndcRefDefault: "raw.redbook",
    };
  }

  const schema = naming.schema;
  const pattern = naming.pattern;
  const hasRelease = pattern.includes("{RELEASE}");
  const resolve = (letter: string): string =>
    pattern
      .replace(/\{LETTER\}/g, letter.toUpperCase())
      .replace(/\{YEAR\}/g, "&yr.")
      .replace(/\{RELEASE\}/g, "&release.");

  if (naming.kind === "warehouse_yearly") {
    return {
      yearLoop: true,
      libnameLines: [
        `libname db  "/EDIT/warehouse/connection";   /* EDIT: map to warehouse schema "${schema}",   */`,
        `                                            /* e.g. libname db odbc ... schema="${schema}"; */`,
        `libname tz  "/EDIT/path/to/project/work";   /* persistent project work area                 */`,
      ],
      namingLines: (letters) => [
        `/*-------------------- MarketScan physical table names -----------------------`,
        `| Delivery style: warehouse tables per family per year in schema "${schema}"`,
        `| following the pattern "${pattern}".`,
        `| EDIT the libname above${hasRelease ? " and the release suffix below" : ""} to match your site.`,
        `-----------------------------------------------------------------------------*/`,
        ...(hasRelease ? [`%let release = R1912;   /* EDIT: release suffix in physical table names */`, ``] : []),
        ...letters.map((le) => `%macro tab_${le}(yr); db.${resolve(le)} %mend tab_${le};  /* ${familyComment(le)} */`),
      ],
      tab: (letter) => `%tab_${letter}(&yr.)`,
      ndcRefDefault: "db.redbook",
    };
  }

  /* single_table: one physical table per family, no year iteration */
  return {
    yearLoop: false,
    libnameLines: [
      `libname db  "/EDIT/warehouse/connection";   /* EDIT: map to schema "${schema}" */`,
      `libname tz  "/EDIT/path/to/project/work";   /* persistent project work area    */`,
    ],
    namingLines: (letters) => [
      `/*-------------------- MarketScan physical table names -----------------------`,
      `| Delivery style: one consolidated table per family in schema "${schema}"`,
      `| following the pattern "${pattern}". No per-year iteration is needed.`,
      `-----------------------------------------------------------------------------*/`,
      ...letters.map((le) => `%macro tab_${le}(yr); db.${resolve(le)} %mend tab_${le};  /* ${familyComment(le)} */`),
    ],
    tab: (letter) => `%tab_${letter}()`,
    ndcRefDefault: "db.redbook",
  };
}

/* yearWrap moved to sas-base.ts so analysis MODULES can pull raw claim
 * families too (the resource-use ledger needs O/S/I/D directly, not a spine
 * table). Re-exported here is unnecessary — sas.ts imports it below. */

/* ================================================================== *
 *  spec digestion
 * ================================================================== */

function listKind(list: CodeList): ListKind {
  switch (list.system) {
    case "icd9cm":
    case "icd10cm":
      return "dx";
    case "cpt_hcpcs":
      return "px";
    case "drug_name":
      return "drug_name";
    case "ndc":
      return "ndc";
  }
}

function listSources(spec: StudySpec, listId: string): { op: boolean; ip: boolean } {
  let op = false;
  let ip = false;
  let referenced = false;
  const add = (setting: CareSetting): void => {
    referenced = true;
    if (setting === "any" || setting === "outpatient" || setting === "pharmacy") op = true;
    if (setting === "any" || setting === "inpatient" || setting === "pharmacy") ip = true;
  };
  for (const c of spec.criteria) {
    const t = c.test;
    if ((t.type === "diagnosis" || t.type === "procedure") && t.codeListId === listId) add(t.setting);
  }
  if (
    (spec.indexEvent.type === "first_diagnosis" || spec.indexEvent.type === "first_procedure") &&
    spec.indexEvent.codeListId === listId
  )
    add("any");
  for (const b of spec.baseline) if (b.codeListId === listId) add("any");
  // Analysis outcome lists must be pulled from ALL settings: the analysis
  // module applies its own care-setting filter downstream, so restricting the
  // pull here (because another reference was setting-narrow) would silently
  // starve the analysis of events.
  for (const a of spec.analyses) {
    const od = (a as { outcomeDefinition?: { codeListId?: string } }).outcomeDefinition;
    if (od?.codeListId === listId) add("any");
  }
  if (!referenced) {
    op = true;
    ip = true;
  }
  return { op, ip };
}

/**
 * Split a diagnosis code list into ICD-10-CM era vs ICD-9-CM era codes
 * (claims store codes without decimal points; DXVER marks the era).
 * Codes beginning with a digit are always ICD-9; V/E-leading codes are
 * ambiguous and follow the list's declared system.
 */
function splitDxEras(list: CodeList): { icd10: string[]; icd9: string[] } {
  const icd10: string[] = [];
  const icd9: string[] = [];
  for (const entry of list.codes) {
    const c = entry.code.replace(/\./g, "").toUpperCase().trim();
    if (c.length === 0) continue;
    let era: "9" | "10";
    if (/^[0-9]/.test(c)) era = "9";
    else if (/^[VE]/.test(c)) era = list.system === "icd9cm" ? "9" : "10";
    else era = "10";
    (era === "9" ? icd9 : icd10).push(c);
  }
  return { icd10: [...new Set(icd10)], icd9: [...new Set(icd9)] };
}

/* ================================================================== *
 *  shared SAS fragments
 * ================================================================== */

/** diagnosis-column scan with DXVER era handling; caller indents */
function dxCondLines(cols: string[], mv10: string | null, mv9: string | null): string[] {
  const branch = (ver: string, mv: string): string[] => {
    const lines: string[] = [`(a.dxver = '${ver}' and`];
    cols.forEach((c, i) => {
      const head = i === 0 ? " (   " : "  or ";
      const tail = i === cols.length - 1 ? "))" : "";
      lines.push(`${head}a.${c.toLowerCase()} in (&${mv}.)${tail}`);
    });
    return lines;
  };
  if (mv10 && mv9) {
    const b10 = branch("0", mv10);
    const b9 = branch("9", mv9);
    return [
      "and (",
      ...b10.map((l, i) => (i === 0 ? `      ${l}` : `       ${l}`)),
      ...b9.map((l, i) => (i === 0 ? `   or ${l}` : `       ${l}`)),
      "    )",
    ];
  }
  const only = branch(mv10 ? "0" : "9", (mv10 ?? mv9) as string);
  return ["and " + only[0], ...only.slice(1).map((l) => "    " + l)];
}

/** procedure-column scan (no era split); caller indents */
function pxCondLines(cols: string[], mv: string): string[] {
  return cols.map((c, i) => {
    const head = i === 0 ? "and (   " : "     or ";
    const tail = i === cols.length - 1 ? ")" : "";
    return `${head}a.${c.toLowerCase()} in (&${mv}.)${tail}`;
  });
}

/* ================================================================== *
 *  emitter context
 * ================================================================== */

function buildCtx(spec: StudySpec, opts: EmitOptions): Ctx {
  assertSafeIdent(opts.tag, "EmitOptions.tag");
  assertSafeNaming(opts.naming);
  const tag = sasName(opts.tag);
  const memberPool = makeNamePool(32);
  const tbl = (suffix: string): string => {
    const full = memberPool(`${tag}_${sasName(suffix)}`);
    return `tz.&tag.${full.slice(tag.length)}`;
  };
  const mvarPool = makeNamePool(32);
  const mvar = (name: string): string => mvarPool(sasName(name));
  const mnamePool = makeNamePool(32);
  const mname = (name: string): string => mnamePool(sasName(name));

  const pulled: PulledList[] = spec.codeLists.map((list) => {
    const kind = listKind(list);
    const src = kind === "dx" || kind === "px" ? listSources(spec, list.id) : { op: false, ip: false };
    return { list, kind, ...src };
  });

  const indexList = findCodeList(spec, spec.indexEvent.codeListId);
  if (!indexList)
    throw new Error(`SAS emitter: index event references missing code list "${spec.indexEvent.codeListId}"`);

  const letters = new Set<string>(["t"]);
  for (const p of pulled) {
    if (p.kind === "drug_name" || p.kind === "ndc") letters.add("d");
    if ((p.kind === "dx" || p.kind === "px") && p.op) letters.add("o");
    if ((p.kind === "dx" || p.kind === "px") && p.ip) {
      letters.add("s");
      letters.add("i");
    }
  }
  const order = ["t", "d", "o", "s", "i"];
  const lettersUsed = order.filter((l) => letters.has(l));

  const ctx: Ctx = {
    spec,
    opts,
    site: makeSite(opts.naming, spec.meta.database),
    tbl,
    mvar,
    mname,
    evOf: (listId) => tbl(`ev_${sasName(listId)}`),
    ndcOf: (listId) => tbl(`ndc_${sasName(listId)}`),
    pulled,
    drugNameLists: spec.codeLists.filter((l) => l.system === "drug_name"),
    indexList,
    lettersUsed,
    finalCohort: "",
    daysPerYearLit: renderDaysPerYear(spec),
  };
  ctx.finalCohort =
    spec.criteria.length > 0 ? ctx.tbl(`060_coh${spec.criteria.length}`) : ctx.tbl("030_index");
  return ctx;
}

/* ================================================================== *
 *  00_setup.sas
 * ================================================================== */

function setupProgram(ctx: Ctx): GeneratedFile {
  const { spec, opts, site } = ctx;
  const lines: string[] = [
    ...header(spec, "00_setup.sas", [
      "Site configuration and study-level macro variables.",
      "%include this program at the top of every numbered program.",
    ]),
    `options mprint mlogic nocenter;   /* house standard: verbose macro logging */`,
    ``,
    `/*-------------------- libraries (EDIT to your site) -------------------------*/`,
    ...site.libnameLines,
    ``,
    `/*-------------------- study identity ----------------------------------------*/`,
    `%let tag = ${sasName(opts.tag)};   /* prefix on every data set this study writes */`,
    ``,
    `/*-------------------- study window ------------------------------------------*/`,
    `%let study_start = ${sasDate(spec.meta.studyPeriod.start)};`,
    `%let study_end   = ${sasDate(spec.meta.studyPeriod.end)};`,
    `/* ASCERTAINMENT window = the span the EVENT PULLS must cover. It is WIDER`,
    `   than the study period whenever the spec looks outside it (baseline`,
    `   lookback, prevalent-case washout, follow-up horizon). Pulling events over`,
    `   the study period alone silently truncates those windows. Twin of the SQL`,
    `   bound in 02_events. */`,
    ...(() => { const aw = ascertainmentWindow(spec); return [
      aw.start === null
        ? `%let ascertain_start = .;   /* a window in this spec is unbounded before index */`
        : `%let ascertain_start = ${sasDate(aw.start)};`,
      `%let ascertain_end   = ${sasDate(aw.end)};`,
      ...aw.reasons.map((r) => `/*   driven by: ${cmt(r)} */`),
    ]; })(),
    `%let start_year  = ${yearOf(spec.meta.studyPeriod.start)};`,
    `%let end_year    = ${yearOf(spec.meta.studyPeriod.end)};`,
    ``,
    `/* person-time constant for rate denominators (spec.meta.daysPerYear -`,
    `   an analyst choice; 365.25 default, 365 = AE-rate convention AE convention) */`,
    `%let days_per_year = ${ctx.daysPerYearLit};`,
    ``,
    `/*-------------------- index event period ------------------------------------*/`,
    `%let index_start = ${sasDate(spec.indexEvent.indexPeriod.start)};`,
    `%let index_end   = ${sasDate(spec.indexEvent.indexPeriod.end)};`,
    ``,
    `/*-------------------- enrollment requirements -------------------------------*/`,
    `/* Convention: the baseline period INCLUDES the index date and runs backward; */`,
    `/* the follow-up period EXCLUDES the index date and runs forward.             */`,
    `%let baseline_days = ${spec.enrollment.baselineDays};`,
    `%let followup_days = ${spec.enrollment.followupDays};`,
    `%let gap_allowance = ${spec.enrollment.gapAllowanceDays};   /* stitch segments separated by <= this many days */`,
    ``,
    ...site.namingLines(ctx.lettersUsed),
  ];

  if (ctx.drugNameLists.length > 0) {
    lines.push(
      ``,
      `/*-------------------- NDC reference (Redbook-style) -------------------------*/`,
      `%let ndc_ref = ${site.ndcRefDefault};   /* EDIT: your NDC reference table, e.g. redbook_rfd_2021q3.`,
      `                                 Expected columns: NDCNUM (11-digit NDC),`,
      `                                 GENNME (generic name), PRODNME (product/brand name). */`
    );
  }

  lines.push(``, `title;`, `footnote;`, ``);
  return {
    path: "sas/00_setup.sas",
    language: "sas",
    title: "00 Setup",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  010_ndc_pull.sas
 * ================================================================== */

function ndcPullProgram(ctx: Ctx): GeneratedFile | null {
  const { spec } = ctx;
  if (ctx.drugNameLists.length === 0) return null;

  const lines: string[] = [
    ...header(spec, "010_ndc_pull.sas", [
      "Build NDC lookup tables from a Redbook-style reference for every",
      "drug-name code list (one CASE WHEN per drug, matched with",
      "UPPER(...) LIKE against generic and product names).",
    ]),
    ...INCLUDE_SETUP,
  ];

  ctx.drugNameLists.forEach((list, idx) => {
    const ndcT = ctx.ndcOf(list.id);
    const drugs = list.codes
      .map((c) => {
        const alts = c.code
          .split("|")
          .map((a) => a.trim().toUpperCase())
          .filter((a) => a.length > 0);
        return { label: alts[0] ?? c.code.toUpperCase(), alts, note: c.description };
      })
      .filter((d) => d.alts.length > 0);

    const likePair = (alt: string): string =>
      `upper(gennme) like '%${sq(alt)}%' or upper(prodnme) like '%${sq(alt)}%'`;

    lines.push(
      `/*----------------------------------------------------------------------------`,
      `  NDC lookup ${idx + 1} of ${ctx.drugNameLists.length}: ${cmt(list.label)} [${cmt(list.id)}]`,
      ...(list.notes ? [`  Note: ${cmt(list.notes)}`] : []),
      `----------------------------------------------------------------------------*/`,
      `proc datasets lib=tz nolist nowarn;`,
      `  delete ${ndcT.replace("tz.", "")};`,
      `quit;`,
      ``,
      `proc sql;`,
      `  create table ${ndcT} as`,
      `  select ndcnum, gennme, prodnme,`,
      `         case`
    );
    for (const d of drugs) {
      d.alts.forEach((alt, ai) => {
        const head = ai === 0 ? "           when " : "             or ";
        lines.push(`${head}${likePair(alt)}`);
      });
      lines.push(`             then '${sq(d.label)}'${d.note ? `   /* ${cmt(d.note)} */` : ""}`);
    }
    lines.push(
      `           else 'NA'`,
      `         end as drug`,
      `  from &ndc_ref.`,
      `  where ndcnum is not null`,
      `    and (`
    );
    const allAlts = drugs.flatMap((d) => d.alts);
    allAlts.forEach((alt, i) => {
      const head = i === 0 ? "            " : "         or ";
      lines.push(`${head}${likePair(alt)}`);
    });
    lines.push(
      `        );`,
      `quit;`,
      ``,
      `title "Level check: ${ndcT} (${cmt(list.label)})";`,
      `proc sql;`,
      `  select count(*) as row_cnt, count(distinct ndcnum) as ndc_cnt`,
      `  from ${ndcT};`,
      ``,
      `  select drug, count(distinct ndcnum) as ndc_cnt`,
      `  from ${ndcT}`,
      `  group by drug`,
      `  order by drug;`,
      `quit;`,
      ``,
      `title "NDC lookup print: ${cmt(list.id)}";`,
      `proc print data=${ndcT};`,
      `run;`,
      ``
    );
  });

  return {
    path: "sas/010_ndc_pull.sas",
    language: "sas",
    title: "010 NDC pull",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  020_events_pull.sas
 * ================================================================== */

interface DxSource {
  key: "outpatient_services" | "inpatient_services" | "inpatient_admissions";
  letter: string;
  setting: "OP" | "IP";
  dateCol: string;
  label: string;
  work: string;
}

function eventsProgram(ctx: Ctx): GeneratedFile | null {
  const { spec, site } = ctx;
  if (ctx.pulled.length === 0) return null;

  const lines: string[] = [
    ...header(spec, "020_events_pull.sas", [
      "Pull clinical events for every code list into one work table per",
      "list (&tag._ev_<codelist>): diagnoses from outpatient/inpatient",
      "claims (ICD era via DXVER), drugs from pharmacy claims joined to",
      "the 010 NDC lookups (or direct NDC lists), procedures by position.",
    ]),
    ...INCLUDE_SETUP,
  ];

  ctx.pulled.forEach((pl, idx) => {
    const list = pl.list;
    const evT = ctx.evOf(list.id);
    const sectionHead = [
      `/*----------------------------------------------------------------------------`,
      `  Event pull ${idx + 1} of ${ctx.pulled.length}: ${cmt(list.label)} [${cmt(list.id)}]`,
    ];

    if (list.codes.length === 0) {
      lines.push(
        ...sectionHead,
        `  NOTE: this code list has no codes yet - nothing pulled. Verify the`,
        `  spec in the HEOR Studio workbench and regenerate.`,
        `----------------------------------------------------------------------------*/`,
        ``
      );
      return;
    }

    if (pl.kind === "dx") {
      const { icd10, icd9 } = splitDxEras(list);
      const mv10 = icd10.length > 0 ? ctx.mvar(`${list.id}_c10`) : null;
      const mv9 = icd9.length > 0 ? ctx.mvar(`${list.id}_c9`) : null;
      const sources: DxSource[] = [];
      if (pl.op)
        sources.push({
          key: "outpatient_services",
          letter: "o",
          setting: "OP",
          dateCol: "svcdate",
          label: "outpatient services (O)",
          work: "work._pull_o",
        });
      if (pl.ip) {
        sources.push(
          {
            key: "inpatient_services",
            letter: "s",
            setting: "IP",
            // ADMDATE, not SVCDATE: the same diagnosis on one stay appears on
            // both the service lines and the admission record, so dating them
            // differently double-counts a single stay (see sql.ts CLAIM_SOURCES
            // and fixture P14). Twin of the SQL fix.
            dateCol: "admdate",
            label: "inpatient services (S), dated at admission",
            work: "work._pull_s",
          },
          {
            key: "inpatient_admissions",
            letter: "i",
            setting: "IP",
            dateCol: "admdate",
            label: "inpatient admissions (I) - PDX..DX15 at the case level",
            work: "work._pull_i",
          }
        );
      }

      lines.push(
        ...sectionHead,
        `  Diagnosis events. Sources: ${sources.map((s) => s.label.split(" - ")[0]).join(", ")}.`,
        `  ICD-9-CM vs ICD-10-CM era is enforced with DXVER ('9' vs '0'); codes`,
        `  below are stored dot-stripped, as they appear on claims.`,
        ...(list.notes ? [`  Note: ${cmt(list.notes)}`] : []),
        `----------------------------------------------------------------------------*/`
      );
      if (mv10)
        lines.push(
          `%let ${mv10} =`,
          ...chunkQuoted(icd10).map((l) => `  ${l}`),
          `;   /* ICD-10-CM era (DXVER = '0') */`
        );
      if (mv9)
        lines.push(
          `%let ${mv9} =`,
          ...chunkQuoted(icd9).map((l) => `  ${l}`),
          `;   /* ICD-9-CM era (DXVER = '9') */`
        );
      lines.push(
        ``,
        `proc datasets lib=tz nolist nowarn;`,
        `  delete ${evT.replace("tz.", "")};`,
        `quit;`,
        ``
      );

      const body: string[] = [];
      for (const src of sources) {
        const cols = DX_COLUMNS[src.key] ?? [];
        const dateSel = src.dateCol === "svcdate" ? "a.svcdate" : `a.${src.dateCol} as svcdate`;
        body.push(
          `/* ${src.label} */`,
          `proc sql;`,
          `  create table ${src.work} as`,
          `  select distinct a.enrolid, ${dateSel}, '${src.setting}' as setting,`,
          `         a.age, a.sex`,
          `  from ${site.tab(src.letter)} as a`,
          `  where a.enrolid is not null`,
          `    and a.${src.dateCol} between &ascertain_start. and &ascertain_end.`,
          ...dxCondLines(cols, mv10, mv9).map((l, i, arr) =>
            `    ${l}${i === arr.length - 1 ? ";" : ""}`
          ),
          `quit;`,
          ``,
          `proc append base=${evT} data=${src.work} force;`,
          `run;`,
          ``
        );
      }
      lines.push(...yearWrap(site, ctx.mname(`pull_ev_${list.id}`), body), ``);
      lines.push(
        ...levelCheck(evT, cmt(list.label), [
          `min(svcdate) as min_dt format=date9.`,
          `max(svcdate) as max_dt format=date9.`,
        ]),
        ``
      );
    } else if (pl.kind === "px") {
      const mv = ctx.mvar(`${list.id}_px`);
      const codes = [...new Set(list.codes.map((c) => c.code.toUpperCase().trim()).filter((c) => c.length > 0))];
      const sources: DxSource[] = [];
      if (pl.op)
        sources.push({
          key: "outpatient_services",
          letter: "o",
          setting: "OP",
          dateCol: "svcdate",
          label: "outpatient services (O)",
          work: "work._pull_o",
        });
      if (pl.ip) {
        sources.push(
          {
            key: "inpatient_services",
            letter: "s",
            setting: "IP",
            // ADMDATE, not SVCDATE: the same diagnosis on one stay appears on
            // both the service lines and the admission record, so dating them
            // differently double-counts a single stay (see sql.ts CLAIM_SOURCES
            // and fixture P14). Twin of the SQL fix.
            dateCol: "admdate",
            label: "inpatient services (S), dated at admission",
            work: "work._pull_s",
          },
          {
            key: "inpatient_admissions",
            letter: "i",
            setting: "IP",
            dateCol: "admdate",
            label: "inpatient admissions (I) - PPROC..PROC15 at the case level",
            work: "work._pull_i",
          }
        );
      }
      lines.push(
        ...sectionHead,
        `  Procedure events matched by claim position (PROCTYP is not filtered;`,
        `  add a PROCTYP restriction if your protocol requires one).`,
        ...(list.notes ? [`  Note: ${cmt(list.notes)}`] : []),
        `----------------------------------------------------------------------------*/`,
        `%let ${mv} =`,
        ...chunkQuoted(codes).map((l) => `  ${l}`),
        `;`,
        ``,
        `proc datasets lib=tz nolist nowarn;`,
        `  delete ${evT.replace("tz.", "")};`,
        `quit;`,
        ``
      );
      const body: string[] = [];
      for (const src of sources) {
        const cols = PROC_COLUMNS[src.key] ?? [];
        const dateSel = src.dateCol === "svcdate" ? "a.svcdate" : `a.${src.dateCol} as svcdate`;
        body.push(
          `/* ${src.label} */`,
          `proc sql;`,
          `  create table ${src.work} as`,
          `  select distinct a.enrolid, ${dateSel}, '${src.setting}' as setting,`,
          `         a.age, a.sex`,
          `  from ${site.tab(src.letter)} as a`,
          `  where a.enrolid is not null`,
          `    and a.${src.dateCol} between &ascertain_start. and &ascertain_end.`,
          ...pxCondLines(cols, mv).map((l, i, arr) => `    ${l}${i === arr.length - 1 ? ";" : ""}`),
          `quit;`,
          ``,
          `proc append base=${evT} data=${src.work} force;`,
          `run;`,
          ``
        );
      }
      lines.push(...yearWrap(site, ctx.mname(`pull_ev_${list.id}`), body), ``);
      lines.push(
        ...levelCheck(evT, cmt(list.label), [
          `min(svcdate) as min_dt format=date9.`,
          `max(svcdate) as max_dt format=date9.`,
        ]),
        ``
      );
    } else {
      /* drug_name or direct ndc list → pharmacy claims (D) */
      const viaLookup = pl.kind === "drug_name";
      const mvNdc = viaLookup ? null : ctx.mvar(`${list.id}_ndc`);
      lines.push(
        ...sectionHead,
        viaLookup
          ? `  Drug claims from pharmacy claims (D) joined to the 010 NDC lookup.`
          : `  Drug claims from pharmacy claims (D) using the direct NDC list below.`,
        ...(list.notes ? [`  Note: ${cmt(list.notes)}`] : []),
        `----------------------------------------------------------------------------*/`
      );
      if (mvNdc) {
        const codes = [...new Set(list.codes.map((c) => c.code.trim()).filter((c) => c.length > 0))];
        lines.push(`%let ${mvNdc} =`, ...chunkQuoted(codes).map((l) => `  ${l}`), `;`);
      }
      lines.push(
        ``,
        `proc datasets lib=tz nolist nowarn;`,
        `  delete ${evT.replace("tz.", "")};`,
        `quit;`,
        ``
      );
      const body: string[] = [`proc sql;`, `  create table work._pull_d as`];
      if (viaLookup) {
        body.push(
          `  select distinct a.enrolid, a.svcdate, b.drug, a.ndcnum, a.daysupp,`,
          `         a.age, a.sex`,
          `  from ${site.tab("d")} as a`,
          `  inner join ${ctx.ndcOf(list.id)} as b`,
          `    on a.ndcnum = b.ndcnum`,
          `  where a.enrolid is not null`,
          `    and a.svcdate between &ascertain_start. and &ascertain_end.;`
        );
      } else {
        body.push(
          `  select distinct a.enrolid, a.svcdate, a.ndcnum, a.daysupp,`,
          `         a.age, a.sex`,
          `  from ${site.tab("d")} as a`,
          `  where a.enrolid is not null`,
          `    and a.ndcnum in (&${mvNdc}.)`,
          `    and a.svcdate between &ascertain_start. and &ascertain_end.;`
        );
      }
      body.push(`quit;`, ``, `proc append base=${evT} data=work._pull_d force;`, `run;`, ``);
      lines.push(...yearWrap(site, ctx.mname(`pull_ev_${list.id}`), body), ``);
      lines.push(
        ...levelCheck(evT, cmt(list.label), [
          `min(svcdate) as min_dt format=date9.`,
          `max(svcdate) as max_dt format=date9.`,
        ]),
        ``
      );
      if (viaLookup) {
        lines.push(
          `title "Event mix by drug: ${evT}";`,
          `proc freq data=${evT};`,
          `  tables drug / missing;`,
          `run;`,
          ``
        );
      }
    }
  });

  return {
    path: "sas/020_events_pull.sas",
    language: "sas",
    title: "020 Events pull",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  030_index.sas
 * ================================================================== */

function indexProgram(ctx: Ctx): GeneratedFile {
  const { spec, site } = ctx;
  const evT = ctx.evOf(spec.indexEvent.codeListId);
  const idxT = ctx.tbl("030_index");
  const isDrug = spec.indexEvent.type === "first_drug_claim";
  const drugExpr =
    isDrug && ctx.indexList.system === "drug_name"
      ? "min(b.drug) as index_drug"
      : isDrug
        ? "min(b.ndcnum) as index_drug"
        : null;

  const ruleLabel: Record<string, string> = {
    first_drug_claim: "first qualifying drug claim",
    first_diagnosis: "first qualifying diagnosis",
    first_procedure: "first qualifying procedure",
  };

  const lines: string[] = [
    ...header(spec, "030_index.sas", [
      `Index event rule: ${ruleLabel[spec.indexEvent.type]} of`,
      `"${ctx.indexList.label}" inside the index period defines index_date.`,
      ...(spec.indexEvent.description ? [spec.indexEvent.description] : []),
    ]),
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${idxT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/* first qualifying event inside the index period, per patient */`,
    `proc sql;`,
    `  create table work._030_first as`,
    `  select enrolid,`,
    `         min(svcdate) as index_date format=date9.`,
    `  from ${evT}`,
    `  where svcdate between &index_start. and &index_end.`,
    `  group by enrolid;`,
    `quit;`,
    ``,
    ...levelCheck("work._030_first", "first qualifying event"),
    ``,
    `/* attributes at the index claim. Same-day ties are resolved with min()`,
    `   (alphabetical${isDrug ? "; review multi-drug index days before analysis" : ""}).`,
    `   AGE_AT_INDEX is derived from enrollment DOBYR as year(index) - dobyr —`,
    `   the SAME source and formula the SQL twin and every analysis module use.`,
    `   The AGE carried on a claim is a different quantity (the vendor's age at`,
    `   that service date) and the two disagree by up to a year, which would put`,
    `   patients on opposite sides of an age cut-off depending on the language.`,
    `   NOTE: DOBYR is a birth YEAR, so this is calendar-year precision (BR-ENR-009). */`,
    `/* One birth year per member from enrollment detail (the SQL twin's "demo"`,
    `   CTE). Pulled through the same year loop the other raw-table reads use. */`,
    `proc datasets lib=work nolist nowarn;`,
    `  delete _030_dob _030_dob0;   /* incl. the append accumulator, so a re-run starts clean */`,
    `quit;`,
    ``,
    ...yearWrap(site, ctx.mname("pull_dob"), [
      `proc sql;`,
      `  create table work._pull_dob as`,
      `  select distinct a.enrolid, a.dobyr`,
      `  from ${site.tab("t")} as a`,
      `  inner join work._030_first as b`,
      `    on a.enrolid = b.enrolid`,
      `  where a.enrolid is not null;`,
      `quit;`,
      ``,
      `proc append base=work._030_dob0 data=work._pull_dob force;`,
      `run;`,
      ``,
    ]),
    `proc sql;`,
    `  create table work._030_dob as`,
    `  select enrolid, min(dobyr) as dobyr`,
    `  from work._030_dob0`,
    `  group by enrolid;`,
    `quit;`,
    ``,
    `proc sql;`,
    `  create table ${idxT} as`,
    `  select a.enrolid,`,
    `         a.index_date,`,
    ...(drugExpr ? [`         ${drugExpr},`] : []),
    `         (year(a.index_date) - t.dobyr) as age_at_index,`,
    `         min(b.sex) as sex`,
    `  from work._030_first as a`,
    `  inner join ${evT} as b`,
    `    on  a.enrolid = b.enrolid`,
    `    and a.index_date = b.svcdate`,
    `  left join work._030_dob as t`,
    `    on t.enrolid = a.enrolid`,
    `  group by a.enrolid, a.index_date, t.dobyr;`,
    `quit;`,
    ``,
    ...levelCheck(idxT, "index cohort", [
      `min(index_date) as min_idx format=date9.`,
      `max(index_date) as max_idx format=date9.`,
    ]),
    ``,
    `title "Index cohort print (first 5 rows)";`,
    `proc print data=${idxT} (obs=5);`,
    `run;`,
    ``,
  ];

  return {
    path: "sas/030_index.sas",
    language: "sas",
    title: "030 Index assignment",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  040_enroll_pull.sas
 * ================================================================== */

function enrollPullProgram(ctx: Ctx): GeneratedFile {
  const { spec, site } = ctx;
  const enrT = ctx.tbl("040_enroll");
  const idxT = ctx.tbl("030_index");
  const rxCol = spec.meta.database === "marketscan_medicaid" ? "drugcovg" : "rx";
  const needRx = spec.enrollment.requiresRxCoverage;

  const body: string[] = [
    `proc sql;`,
    `  create table work._pull_t as`,
    `  select distinct a.enrolid, a.dtstart, a.dtend,`,
    `         a.${rxCol}${rxCol === "rx" ? "" : " as rx"}, a.plantyp, a.sex, a.region, a.dobyr`,
    `  from ${site.tab("t")} as a`,
    `  inner join ${idxT} as b`,
    `    on a.enrolid = b.enrolid`,
    `  where a.enrolid is not null`,
    `    and a.dtstart is not null`,
    `    and a.dtend is not null`,
  ];
  if (needRx) {
    body.push(`    /* pharmacy (Rx) coverage required by the spec */`);
    body.push(`    and a.${rxCol} = '1';`);
  } else {
    body[body.length - 1] = body[body.length - 1] + ";";
  }
  body.push(`quit;`, ``, `proc append base=${enrT} data=work._pull_t force;`, `run;`, ``);

  const lines: string[] = [
    ...header(spec, "040_enroll_pull.sas", [
      "Pull enrollment-detail segments for patients with an index date.",
      needRx
        ? `Segments must carry pharmacy coverage (${rxCol.toUpperCase()} = '1') per the spec.`
        : "Pharmacy coverage is NOT required by the spec; no RX filter applied.",
      "Demographic columns (SEX, REGION, PLANTYP, DOBYR) ride along for 070.",
    ]),
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${enrT.replace("tz.", "")};`,
    `quit;`,
    ``,
    ...yearWrap(site, ctx.mname("pull_enroll"), body),
    ``,
    ...levelCheck(enrT, "enrollment segments", [
      `min(dtstart) as min_dtstart format=date9.`,
      `max(dtend)   as max_dtend   format=date9.`,
    ]),
    ``,
    `title "Enrollment pull print (first 5 rows)";`,
    `proc print data=${enrT} (obs=5);`,
    `run;`,
    ``,
  ];

  return {
    path: "sas/040_enroll_pull.sas",
    language: "sas",
    title: "040 Enrollment pull",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  050_enroll_stitch.sas
 * ================================================================== */

function enrollStitchProgram(ctx: Ctx): GeneratedFile {
  const { spec } = ctx;
  const enrT = ctx.tbl("040_enroll");
  const epiT = ctx.tbl("050_epi");
  const outT = ctx.tbl("050_cont_enroll");
  const idxT = ctx.tbl("030_index");

  /* Baseline INCLUDES the index date (BR-CHT-003), so N baseline days span
   * index-(N-1) .. index — NOT index-N, which would require N+1 covered days.
   * This expression previously read `index_date - &baseline_days.`, one day
   * stricter than the SQL twin's `index_date - (N-1)`, so the two languages
   * built DIFFERENT cohorts from the same spec. The same file already used the
   * correct form for criteria windows. */
  const blStart =
    spec.enrollment.baselineDays > 0
      ? `a.index_date - (&baseline_days. - 1)`
      : `a.index_date`;

  const lines: string[] = [
    ...header(spec, "050_enroll_stitch.sas", [
      "Stitch enrollment segments into continuous episodes (classic sorted",
      "DATA-step retain algorithm), then keep patients whose episode covers",
      "&baseline_days. before through &followup_days. after the index date.",
    ]),
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${epiT.replace("tz.", "")} ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    `/* the stitching DATA step relies on this sort order */`,
    `proc sort data=${enrT} out=work._050_seg (keep=enrolid dtstart dtend);`,
    `  by enrolid dtstart dtend;`,
    `run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Retained-variable stitching:`,
    `    - the first segment of each patient opens episode 1;`,
    `    - a segment starting within &gap_allowance. days of the running episode`,
    `      end continues the episode (the running end only ever moves forward);`,
    `    - a larger gap increments the episode counter.`,
    `----------------------------------------------------------------------------*/`,
    `data work._050_epi0;`,
    `  set work._050_seg;`,
    `  by enrolid dtstart dtend;`,
    `  retain prev_dtend episode;`,
    `  format prev_dtend enrolst enrolend date9.;`,
    ``,
    `  /* first enrollment segment of each patient */`,
    `  if first.enrolid then do;`,
    `    enrolst    = dtstart;`,
    `    episode    = 1;`,
    `    prev_dtend = dtend;`,
    `    enrolend   = dtend;`,
    `  end;`,
    ``,
    `  /* continuous, and the segment end extends the running episode */`,
    `  else if ((dtstart - prev_dtend) le &gap_allowance.) and (dtend ge prev_dtend) then do;`,
    `    enrolst    = dtstart;`,
    `    episode    = episode;`,
    `    prev_dtend = dtend;`,
    `    enrolend   = dtend;`,
    `  end;`,
    ``,
    `  /* continuous, but the segment ends inside the running episode */`,
    `  else if ((dtstart - prev_dtend) le &gap_allowance.) and (dtend lt prev_dtend) then do;`,
    `    enrolst    = dtstart;`,
    `    episode    = episode;`,
    `    prev_dtend = prev_dtend;`,
    `    enrolend   = prev_dtend;`,
    `  end;`,
    ``,
    `  /* gap larger than the allowance - open a new episode */`,
    `  else if (dtstart - prev_dtend) gt &gap_allowance. then do;`,
    `    enrolst    = dtstart;`,
    `    episode    = episode + 1;`,
    `    prev_dtend = dtend;`,
    `    enrolend   = dtend;`,
    `  end;`,
    `run;`,
    ``,
    `title "Stitching intermediate print (first 10 rows)";`,
    `proc print data=work._050_epi0 (obs=10);`,
    `run;`,
    ``,
    `/* collapse to one row per patient-episode */`,
    `proc sql;`,
    `  create table ${epiT} as`,
    `  select distinct enrolid, episode,`,
    `         min(enrolst)  as dtstart format=date9.,`,
    `         max(enrolend) as dtend   format=date9.`,
    `  from work._050_epi0`,
    `  group by enrolid, episode;`,
    `quit;`,
    ``,
    ...levelCheck(epiT, "stitched episodes"),
    ``,
    `/*----------------------------------------------------------------------------`,
    `  Continuous-enrollment requirement around index. Baseline INCLUDES the index`,
    `  date, so &baseline_days. days span index - (&baseline_days. - 1) .. index;`,
    `  follow-up EXCLUDES it, so it runs index + 1 .. index + &followup_days.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table ${outT} as`,
    `  select distinct a.*,`,
    `         b.episode,`,
    `         b.dtstart as epi_start format=date9.,`,
    `         b.dtend   as epi_end   format=date9.,`,
    `         (a.index_date - b.dtstart) as bl_avail_days,`,
    `         (b.dtend - a.index_date)   as fup_avail_days`,
    `  from ${idxT} as a`,
    `  inner join ${epiT} as b`,
    `    on a.enrolid = b.enrolid`,
    `  where b.dtstart <= ${blStart}`,
    `    and b.dtend   >= a.index_date + &followup_days.;`,
    `quit;`,
    ``,
    ...levelCheck(outT, "index + continuous enrollment", [
      `min(bl_avail_days)  as min_bl`,
      `max(bl_avail_days)  as max_bl`,
      `min(fup_avail_days) as min_fup`,
      `max(fup_avail_days) as max_fup`,
    ]),
    ``,
  ];

  return {
    path: "sas/050_enroll_stitch.sas",
    language: "sas",
    title: "050 Enrollment stitching",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  060_attrition.sas
 * ================================================================== */

function attrDesc(c: Criterion): string {
  let raw = `${c.kind}: ${c.sourceText}`;
  if (raw.length > 200) raw = raw.slice(0, 197) + "...";
  return sq(raw);
}

interface EventTestSql {
  ev: string;
  window: RelativeWindow;
  settingCond: string | null;
  minClaims: number;
  sepDays?: number;
  negate: boolean;
}

function eventWhereLines(t: EventTestSql): string[] {
  const win = (al: string): string[] => windowConds(t.window, al);
  const set = (al: string): string[] => (t.settingCond ? [`and ${al}${t.settingCond}`] : []);

  const single = (kw: string): string[] => [
    `  where ${kw} (`,
    `          select 1`,
    `          from ${t.ev} as e`,
    `          where e.enrolid = a.enrolid`,
    ...[...win("e"), ...set("e")].map((l) => `            ${l}`),
    `        );`,
  ];

  const pairBody: string[] = [
    `          select 1`,
    `          from ${t.ev} as e1, ${t.ev} as e2`,
    `          where e1.enrolid = a.enrolid`,
    `            and e2.enrolid = a.enrolid`,
    ...[...win("e1"), ...set("e1"), ...win("e2"), ...set("e2")].map((l) => `            ${l}`),
    `            and e2.svcdate >= e1.svcdate + ${t.sepDays ?? 1}`,
  ];
  const pair = (kw: string): string[] => [`  where ${kw} (`, ...pairBody, `        );`];

  const countLines = (cmp: string): string[] => [
    `  where (select count(distinct e.svcdate)`,
    `         from ${t.ev} as e`,
    `         where e.enrolid = a.enrolid`,
    ...[...win("e"), ...set("e")].map((l) => `           ${l}`),
    `        ) ${cmp};`,
  ];

  if (t.minClaims <= 1) return single(t.negate ? "not exists" : "exists");
  if (t.minClaims === 2 && t.sepDays) return pair(t.negate ? "not exists" : "exists");
  if (!t.sepDays) return countLines(`${t.negate ? "<" : ">="} ${t.minClaims}`);

  /* minClaims > 2 with a separation requirement: distinct-date count plus the
     two-claims-apart EXISTS pattern (pairwise separation approximation). */
  return [
    `  where ${t.negate ? "not (" : "("}`,
    `          (select count(distinct e.svcdate)`,
    `           from ${t.ev} as e`,
    `           where e.enrolid = a.enrolid`,
    ...[...win("e"), ...set("e")].map((l) => `             ${l}`),
    `          ) >= ${t.minClaims}`,
    `      and exists (`,
    ...pairBody.map((l) => `    ${l}`),
    `          )`,
    `        );`,
  ];
}

function settingCondOf(setting: CareSetting): string | null {
  if (setting === "inpatient") return `.setting = 'IP'`;
  if (setting === "outpatient") return `.setting = 'OP'`;
  return null;
}

function attritionProgram(ctx: Ctx): GeneratedFile | null {
  const { spec } = ctx;
  if (spec.criteria.length === 0) return null;

  const attrT = ctx.tbl("060_attrition");
  const idxT = ctx.tbl("030_index");
  const epiT = ctx.tbl("050_epi");
  const cohTables = spec.criteria.map((_, i) => ctx.tbl(`060_coh${i + 1}`));
  const coh0 = ctx.tbl("060_coh0");
  const deleteList = [attrT, coh0, ...cohTables].map((t) => t.replace("tz.", "")).join(" ");

  const lines: string[] = [
    ...header(spec, "060_attrition.sas", [
      "Apply inclusion/exclusion criteria in spec order (CONSORT-style",
      "attrition); every step writes the count of patients remaining to",
      "&tag._060_attrition and prints a level check.",
    ]),
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${deleteList};`,
    `quit;`,
    ``,
    `proc sql;`,
    `  create table ${attrT}`,
    `    (step num, description char(240), n num);`,
    `quit;`,
    ``,
    `/*-------------------- step 0: index cohort ---------------------------------*/`,
    `title "Attrition step 0: qualifying index event";`,
    `data ${coh0};`,
    `  set ${idxT};`,
    `run;`,
    ``,
    `proc sql;`,
    `  insert into ${attrT}`,
    `  select 0, 'Patients with a qualifying index event in the index period',`,
    `         count(distinct enrolid)`,
    `  from ${coh0};`,
    ``,
    `  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt`,
    `  from ${coh0};`,
    `quit;`,
    ``,
  ];

  let prev = coh0;
  spec.criteria.forEach((c, i) => {
    const step = i + 1;
    const cur = cohTables[i];
    const t = c.test;
    lines.push(
      `/*-------------------- step ${step}: ${sasName(c.id)} (${c.kind}) ----------------------*/`,
      `/* Source text: ${cmt(c.sourceText)} */`,
      `title "Attrition step ${step}: ${sasName(c.id)} (${c.kind})";`
    );

    if (t.type === "unmapped") {
      lines.push(
        `/* !! UNMAPPED CRITERION - the extractor could not translate this criterion`,
        `   into claims logic. The cohort is carried forward UNCHANGED below;`,
        `   resolve it in the HEOR Studio workbench and regenerate before delivery. */`,
        `data ${cur};`,
        `  set ${prev};`,
        `run;`,
        ``,
        `proc sql;`,
        `  insert into ${attrT}`,
        `  select ${step}, 'UNMAPPED (cohort carried forward unchanged): ${attrDesc(c)}',`,
        `         count(distinct enrolid)`,
        `  from ${cur};`,
        ``,
        `  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt`,
        `  from ${cur};`,
        `quit;`,
        ``
      );
      prev = cur;
      return;
    }

    const negate = c.kind === "exclusion";
    let whereLines: string[];

    if (t.type === "diagnosis" || t.type === "procedure" || t.type === "drug") {
      whereLines = eventWhereLines({
        ev: ctx.evOf(t.codeListId),
        window: t.window,
        settingCond: t.type === "drug" ? null : settingCondOf(t.setting),
        minClaims: t.minClaims,
        sepDays: t.type === "diagnosis" ? t.claimSeparationDays : undefined,
        negate,
      });
    } else if (t.type === "age_at_index") {
      const conds: string[] = [];
      if (t.min !== undefined) conds.push(`a.age_at_index >= ${t.min}`);
      if (t.max !== undefined) conds.push(`a.age_at_index <= ${t.max}`);
      if (conds.length === 0) conds.push(`1 = 1   /* no age bounds supplied */`);
      const joined = conds.join("\n    and ");
      whereLines = negate ? [`  where not (${joined});`] : [`  where ${joined};`];
    } else if (t.type === "sex") {
      const v = t.value === "M" ? "1" : "2";
      const cond = `a.sex = '${v}'   /* '1' = male, '2' = female in MarketScan */`;
      whereLines = negate ? [`  where not (${cond});`] : [`  where ${cond};`];
    } else {
      /* continuous_enrollment */
      const bl =
        t.baselineDays === spec.enrollment.baselineDays ? "&baseline_days." : String(t.baselineDays);
      const fu =
        t.followupDays === spec.enrollment.followupDays ? "&followup_days." : String(t.followupDays);
      if (t.requiresRxCoverage !== spec.enrollment.requiresRxCoverage) {
        lines.push(
          `/* NOTE: this criterion's Rx-coverage requirement differs from the`,
          `   enrollment pull in 040 - review before delivery. */`
        );
      }
      const inner = [
        `          select 1`,
        `          from ${epiT} as b`,
        `          where b.enrolid = a.enrolid`,
        `            and b.dtstart <= a.index_date - ${bl}`,
        `            and b.dtend   >= a.index_date + ${fu}`,
      ];
      whereLines = [`  where ${negate ? "not exists" : "exists"} (`, ...inner, `        );`];
    }

    lines.push(
      `proc sql;`,
      `  create table ${cur} as`,
      `  select distinct a.*`,
      `  from ${prev} as a`,
      ...whereLines,
      ``,
      `  insert into ${attrT}`,
      `  select ${step}, '${attrDesc(c)}',`,
      `         count(distinct enrolid)`,
      `  from ${cur};`,
      ``,
      `  select count(*) as row_cnt, count(distinct enrolid) as pat_cnt`,
      `  from ${cur};`,
      `quit;`,
      ``
    );
    prev = cur;
  });

  lines.push(
    `/*-------------------- attrition report -------------------------------------*/`,
    `data work._060_report;`,
    `  set ${attrT};`,
    `  prev_n = lag(n);`,
    `  if _n_ = 1 then pct_prev = 100;`,
    `  else if prev_n > 0 then pct_prev = round(100 * n / prev_n, 0.1);`,
    `run;`,
    ``,
    `title "Attrition summary: &tag.";`,
    `proc print data=work._060_report noobs label;`,
    `  var step description n pct_prev;`,
    `  label step     = 'Step'`,
    `        description = 'Criterion'`,
    `        n        = 'Patients remaining'`,
    `        pct_prev = 'Pct of previous step';`,
    `run;`,
    ``,
    ...levelCheck(prev, "final analytic cohort"),
    ``
  );

  return {
    path: "sas/060_attrition.sas",
    language: "sas",
    title: "060 Attrition",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  070_baseline.sas
 * ================================================================== */

function baselineProgram(ctx: Ctx): GeneratedFile | null {
  const { spec } = ctx;
  if (spec.baseline.length === 0) return null;

  const cohT = ctx.tbl("070_cohort");
  const demoT = ctx.tbl("070_demo");
  const enrT = ctx.tbl("040_enroll");
  const needsDemo = spec.baseline.some((b) =>
    ["age", "sex", "region", "plan_type", "year"].includes(b.kind)
  );
  const needsFormats = spec.baseline.some((b) => b.kind === "sex" || b.kind === "region");

  const lines: string[] = [
    ...header(spec, "070_baseline.sas", [
      "Table 1 shells for the baseline characteristics in the spec:",
      spec.baseline.map((b) => b.label).join(", ") + ".",
      "Baseline window convention: INCLUDES index date, runs backward",
      "(&baseline_days. days total: index - (&baseline_days. - 1) .. index).",
    ]),
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${cohT.replace("tz.", "")}${needsDemo ? ` ${demoT.replace("tz.", "")}` : ""};`,
    `quit;`,
    ``,
    `/* final analytic cohort from 060 */`,
    `data ${cohT};`,
    `  set ${ctx.finalCohort};`,
    `run;`,
    ``,
    ...levelCheck(cohT, "Table 1 cohort"),
    ``,
  ];

  if (needsFormats) {
    lines.push(
      `proc format;`,
      `  value $tzsex  '1' = 'Male'`,
      `                '2' = 'Female';`,
      `  value $tzreg  '1' = 'Northeast'`,
      `                '2' = 'North Central'`,
      `                '3' = 'South'`,
      `                '4' = 'West'`,
      `                '5' = 'Unknown';`,
      `run;`,
      ``
    );
  }

  if (needsDemo) {
    lines.push(
      `/*----------------------------------------------------------------------------`,
      `  Demographics at index: join the enrollment segment covering the index`,
      `  date (latest-starting segment wins when several overlap), with DOBYR as`,
      `  the age fallback when the claim-level AGE was missing.`,
      `----------------------------------------------------------------------------*/`,
      `proc sql;`,
      `  create table work._070_demo0 as`,
      `  select a.enrolid, a.index_date, a.age_at_index, a.sex,`,
      `         b.region, b.plantyp, b.dobyr, b.dtstart as seg_start`,
      `  from ${cohT} as a`,
      `  left join ${enrT} as b`,
      `    on  a.enrolid = b.enrolid`,
      `    and b.dtstart <= a.index_date`,
      `    and b.dtend   >= a.index_date;`,
      `quit;`,
      ``,
      `proc sort data=work._070_demo0;`,
      `  by enrolid descending seg_start;`,
      `run;`,
      ``,
      `data ${demoT};`,
      `  set work._070_demo0;`,
      `  by enrolid;`,
      `  if first.enrolid;`,
      `  if age_at_index = . and dobyr ne . then age_at_index = year(index_date) - dobyr;`,
      `  index_year = year(index_date);`,
      `  drop seg_start;`,
      `run;`,
      ``,
      ...levelCheck(demoT, "demographics at index"),
      ``
    );
  }

  spec.baseline.forEach((b: BaselineCharacteristic) => {
    const label = b.label.replace(/"/g, "'");
    switch (b.kind) {
      case "age":
        lines.push(
          `title "Table 1 - ${label} (continuous)";`,
          `proc means data=${demoT} n mean std median min max maxdec=1;`,
          `  var age_at_index;`,
          `run;`,
          ``,
          `data work._070_age;`,
          `  set ${demoT};`,
          `  length age_group $8;`,
          `  if      age_at_index =  .  then age_group = 'Missing';`,
          `  else if age_at_index <  18 then age_group = '<18';`,
          `  else if age_at_index <= 34 then age_group = '18-34';`,
          `  else if age_at_index <= 44 then age_group = '35-44';`,
          `  else if age_at_index <= 54 then age_group = '45-54';`,
          `  else if age_at_index <= 64 then age_group = '55-64';`,
          `  else                            age_group = '65+';`,
          `run;`,
          ``,
          `title "Table 1 - ${label} (grouped)";`,
          `proc freq data=work._070_age;`,
          `  tables age_group / missing;`,
          `run;`,
          ``
        );
        break;
      case "sex":
        lines.push(
          `title "Table 1 - ${label}";`,
          `proc freq data=${demoT};`,
          `  tables sex / missing;`,
          `  format sex $tzsex.;`,
          `run;`,
          ``
        );
        break;
      case "region":
        lines.push(
          `title "Table 1 - ${label}";`,
          `proc freq data=${demoT};`,
          `  tables region / missing;`,
          `  format region $tzreg.;`,
          `run;`,
          ``
        );
        break;
      case "plan_type":
        lines.push(
          `title "Table 1 - ${label}";`,
          `proc freq data=${demoT};`,
          `  tables plantyp / missing;   /* MarketScan PLANTYP codes; label at reporting time */`,
          `run;`,
          ``
        );
        break;
      case "year":
        lines.push(
          `title "Table 1 - ${label}";`,
          `proc freq data=${demoT};`,
          `  tables index_year / missing;`,
          `run;`,
          ``
        );
        break;
      case "comorbidity":
      case "medication": {
        if (!b.codeListId || !findCodeList(spec, b.codeListId)) {
          lines.push(
            `/* ${label}: no (valid) code list attached in the spec - resolve in the`,
            `   HEOR Studio workbench and regenerate. */`,
            ``
          );
          break;
        }
        const evT = ctx.evOf(b.codeListId);
        const flag = sasName(b.id).toLowerCase();
        const winLines = b.window
          ? windowConds(b.window, "e")
          : [
              `and e.svcdate >= a.index_date - (&baseline_days. - 1)`,
              `and e.svcdate <= a.index_date`,
            ];
        lines.push(
          `/* ${label}: flagged from the ${b.codeListId} event table in the`,
          `   ${b.window ? "criterion-specific window" : "baseline window"} */`,
          `proc sql;`,
          `  create table work._070_flag_${flag} as`,
          `  select a.enrolid,`,
          `         max(case when e.enrolid is not null then 1 else 0 end) as ${flag}`,
          `  from ${cohT} as a`,
          `  left join ${evT} as e`,
          `    on  e.enrolid = a.enrolid`,
          ...winLines.map((l) => `    ${l}`),
          `  group by a.enrolid;`,
          `quit;`,
          ``,
          `title "Table 1 - ${label} (baseline flag)";`,
          `proc freq data=work._070_flag_${flag};`,
          `  tables ${flag} / missing;`,
          `run;`,
          ``
        );
        break;
      }
      case "comorbidity_index": {
        const idxAn = indexAnalysisFor(spec, b.comorbidityIndexAnalysisId);
        if (!idxAn) {
          lines.push(
            `/* ${label}: comorbidityIndexAnalysisId "${cmt(b.comorbidityIndexAnalysisId ?? "(unset)")}" does not`,
            `   name an enabled comorbidity_index analysis - resolve in the HEOR`,
            `   Studio workbench and regenerate. */`,
            ``
          );
          break;
        }
        /* Same shared scorer as the SQL twin, the index analysis and the
         * balance table (emitters/comorbidity.ts). The work-table stem is
         * per-characteristic so several indices can coexist in one Table 1. */
        const stem = `070${sasName(b.id).toLowerCase()}`;
        const sc = comorbidityScoreSasSteps(ctx, { an: idxAn, num: stem, cohT, evOf: ctx.evOf });
        lines.push(
          `/* ${label}: comorbidity index "${cmt(idxAn.indexName)}" - weights and`,
          `   hierarchy come from the reviewed spec, scored by the shared engine so`,
          `   this row cannot disagree with the index analysis or the balance table. */`,
          ...sc.lines,
          ...comorbidityScoreSasScore(stem, cohT),
          `/* PCTLDEF=5 reproduces the SQL twin's PERCENTILE_CONT at p = 0.5 */`,
          `title "Table 1 - ${label} (index score)";`,
          `proc univariate data=${sc.scoreTable} pctldef=5;`,
          `  var score;`,
          `run;`,
          ``
        );
        break;
      }
      case "utilization":
        lines.push(
          `/* ${label}: utilization shell. All-cause utilization needs claim-level`,
          `   pulls beyond the code-list event tables generated in 020 - add a`,
          `   dedicated all-cause pull (O/S/I/D restricted to the baseline window)`,
          `   here before running. */`,
          ``
        );
        break;
    }
  });

  return {
    path: "sas/070_baseline.sas",
    language: "sas",
    title: "070 Baseline (Table 1)",
    content: lines.join("\n"),
  };
}

/* ================================================================== *
 *  entry point
 * ================================================================== */

export const emitSas: SasEmitter = (spec: StudySpec, opts: EmitOptions): GeneratedFile[] => {
  const ctx = buildCtx(spec, opts);
  const files: GeneratedFile[] = [];

  files.push(setupProgram(ctx));
  const ndc = ndcPullProgram(ctx);
  if (ndc) files.push(ndc);
  const events = eventsProgram(ctx);
  if (events) files.push(events);
  files.push(indexProgram(ctx));
  files.push(enrollPullProgram(ctx));
  files.push(enrollStitchProgram(ctx));
  const attrition = attritionProgram(ctx);
  if (attrition) files.push(attrition);
  const baseline = baselineProgram(ctx);
  if (baseline) files.push(baseline);

  // 080+ analysis modules (one program per enabled analysis), dispatched
  // through the module registry in spec order.
  const suppressTargets: SuppressionTarget[] = [];
  let seq = 8;
  moduleAnalyses(spec.analyses).forEach(({ an, mod, multi }) => {
    const num = String(seq++ * 10).padStart(3, "0"); // 080, 090, 100, ...
    const suffix = multi ? `_${sasName(an.id).toLowerCase()}` : "";
    files.push(mod.sas(ctx, an as never, num, suffix));
    const extras = mod.suppressionExtras?.(an as never);
    suppressTargets.push({
      table: ctx.tbl(`${num}_${mod.resultSlug}${suffix}`),
      shapeKey: mod.stampKind,
      label: `${an.label} (${an.kind})`,
      ...(extras?.maskCols.length ? { extraMaskCols: extras.maskCols } : {}),
      ...(extras?.keepCols.length ? { extraKeepCols: extras.keepCols } : {}),
    });
  });

  /* DECLARED SWEEPS — twin of the SQL pass, program for program. The arm's
   * analysis is emitted by the target's OWN module with `finalCohort` repointed
   * at the arm's cohort (a subgroup slice, or a copy of the whole cohort for a
   * sensitivity arm, so the two kinds differ only where they declare they do). */
  const sweeps = resolveSweeps(spec);
  for (const s of sweeps) {
    if (!s.emittable) {
      const num = String(seq++ * 10).padStart(3, "0");
      files.push({
        path: `sas/${num}_sweep_${s.tag}.sas`,
        language: "sas",
        title: `${num} Sweep ${s.tag} (not emitted)`,
        content: [
          ...header(spec, `${num}_sweep_${s.tag}.sas`, [
            `Declared sweep over "${s.plan.analysisId}" - NOT EMITTED.`,
            `Reason: ${s.reason}.`,
            `A declared sweep the bundle simply left out would be indistinguishable`,
            `from a study that never declared one, so the file is emitted anyway.`,
          ]),
          `/* SWEEP NOT EMITTED: ${cmt(s.reason)} */`,
          ``,
        ].join("\n"),
      });
      continue;
    }
    const cohNum = String(seq++ * 10).padStart(3, "0");
    files.push({
      path: `sas/${cohNum}_swcoh_${s.tag}.sas`,
      language: "sas",
      title: `${cohNum} Sweep ${s.tag} arm cohorts`,
      content: [
        ...header(spec, `${cohNum}_swcoh_${s.tag}.sas`, [
          `Arm cohorts for sweep "${s.tag}" over "${s.target.label}" (${s.target.kind}).`,
          `One data set per declared arm: a SENSITIVITY arm gets the whole cohort,`,
          `a SUBGROUP arm gets a slice. Nothing else differs between them.`,
          `Twin of the SQL swcoh program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
        ]),
        ...INCLUDE_SETUP,
        ...sweepArmCohortsSas({
          spec, s, num: cohNum,
          finalCohort: ctx.finalCohort,
          enrollTable: ctx.tbl("040_enroll"),
          tbl: ctx.tbl,
        }),
      ].join("\n"),
    });

    const armTables: string[] = [];
    for (const arm of s.arms) {
      const num = String(seq++ * 10).padStart(3, "0");
      const armCtx: Ctx = { ...ctx, finalCohort: sasArmCohortTable(ctx.tbl, cohNum, arm) };
      files.push(s.mod.sas(armCtx, arm.analysis as never, num, arm.suffix));
      const table = ctx.tbl(`${num}_${s.mod.resultSlug}${arm.suffix}`);
      armTables.push(table);
      const extras = s.mod.suppressionExtras?.(arm.analysis as never);
      suppressTargets.push({
        table,
        shapeKey: s.mod.stampKind,
        label: `${arm.analysis.label} (${arm.analysis.kind}) [sweep ${s.tag} arm ${arm.id}]`,
        arm: { id: arm.id, kind: arm.kind, label: arm.label },
        ...(extras?.maskCols.length ? { extraMaskCols: extras.maskCols } : {}),
        ...(extras?.keepCols.length ? { extraKeepCols: extras.keepCols } : {}),
      });
    }

    const sumNum = String(seq++ * 10).padStart(3, "0");
    const outT = ctx.tbl(`${sumNum}_sweep_${s.tag}`);
    files.push({
      path: `sas/${sumNum}_sweep_${s.tag}.sas`,
      language: "sas",
      title: `${sumNum} Sweep ${s.tag} summary`,
      content: [
        ...header(spec, `${sumNum}_sweep_${s.tag}.sas`, [
          `Sweep "${s.tag}" over "${s.target.label}": every declared arm, the range`,
          `across them, and the direction verdict. Every row carries its arm id,`,
          `its arm KIND (subgroup vs sensitivity) and its label.`,
          `The primary arm is "${s.primaryArmId}", named in the spec before any`,
          `estimate existed.`,
          `SAS-PRIMARY: nothing.`,
          `Twin of the SQL sweep program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
        ]),
        `/* ${parityStamp("sweep", sweepParity(s))} */`,
        ``,
        `/* REVIEW - method notes (always emitted):`,
        ...SWEEP_METHOD_NOTES.map((n) => `   * ${cmt(n)}`),
        `*/`,
        `/* ARMS, in declaration order:`,
        ...s.arms.map((a) => `   * ${cmt(a.id)} (${a.kind}${a.isPrimary ? ", PRIMARY" : ""}): ${cmt(a.label)} - ${cmt(a.note)}`),
        `*/`,
        ``,
        ...INCLUDE_SETUP,
        `proc datasets lib=tz nolist nowarn;`,
        `  delete ${outT.replace("tz.", "")};`,
        `quit;`,
        ``,
        ...sweepSummarySas({ s, num: sumNum, cohNum, outT, armTables, tbl: ctx.tbl }),
      ].join("\n"),
    });
    suppressTargets.push({
      table: outT,
      shapeKey: "sweep",
      label: `Sweep ${s.tag} over ${s.target.label}`,
    });
  }

  /* Small-cell suppression (BR-DEL-004) — twin of the SQL pass. */
  const policy = suppressionPolicy(spec);
  if (policy.enabled && suppressTargets.length > 0) {
    const num = String(seq++ * 10).padStart(3, "0");
    const lines: string[] = [
      ...header(spec, `${num}_suppression.sas`, [
        `Small-cell suppression: mask cells below the disclosure threshold and`,
        `write a releasable <dataset>_released beside each result table.`,
        `Rule: ${policy.ruleLabel}.`,
      ]),
      ...INCLUDE_SETUP,
      `/*----------------------------------------------------------------------------`,
      `  WHICH TABLE MAY LEAVE THIS ENVIRONMENT`,
      `  The *_released data sets below are the shareable ones. The unsuppressed`,
      `  originals keep their exact computed values for YOUR OWN QC and must not`,
      `  be released, pasted into a deck, or sent to a client.`,
      ``,
      `  LIMITATION - Table 1 (070_baseline.sas) is produced as a PRINTED report,`,
      `  not a data set, so it is NOT masked here. Apply the same rule by hand to`,
      `  its small cells before releasing it. (The SQL twin does mask its Table 1,`,
      `  because there it is materialized as a table.)`,
      `----------------------------------------------------------------------------*/`,
      ``,
    ];
    suppressTargets.forEach((t, i) => {
      lines.push(...suppressionSasFor(t, policy, `work._${num}_s${i + 1}`));
    });
    files.push({
      path: `sas/${num}_suppression.sas`,
      language: "sas",
      title: `${num} Small-cell suppression`,
      content: lines.join("\n"),
    });
  }

  return files;
};
