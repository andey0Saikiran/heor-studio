/**
 * Claim-line ledger — the shared encounter spine underneath resource use, cost,
 * and (later) treatment patterns.
 *
 * MarketScan has no "encounter" table. It has claim LINES spread across four
 * families, and turning them into encounters is where the arithmetic is won or
 * lost. Three traps, all of which produce a complete, plausible-looking table
 * when you fall into them:
 *
 * 1. THE INPATIENT DOUBLE COUNT. An admission appears twice: once as a
 *    stay-level record on the admissions family (with the stay's total payment)
 *    and again as service lines on the inpatient-services family (with the
 *    line-level payments that already roll up into it). Summing both inflates
 *    inpatient cost — the largest component of most studies — by roughly the
 *    line total. The ledger takes the admission record and DROPS its own
 *    service lines. Gold Case A pins this: P04's stay is $10,000 at the
 *    admission with $3,000 + $4,000 of lines beneath it, so a double-counting
 *    ledger reports $17,000 and fails.
 *
 * 2. ORPHAN SERVICE LINES. Not every service line has an admission record in
 *    the same delivery (year-file boundaries, partial extracts, coding gaps).
 *    Dropping every line that "should" have a parent silently loses those
 *    stays. The ledger keeps a line only when no admission record matches it —
 *    by CASEID where present, and by admission date where CASEID is null.
 *    P05 is exactly this case and must still count as one stay.
 *
 * 3. ENCOUNTER GRAIN. Multiple lines on one service date are one visit, not
 *    several. Two different drugs dispensed on one day ARE two fills. The key
 *    differs per family and is stated explicitly below rather than assumed.
 *
 * Emitted as CTEs/steps into the consuming module rather than as a materialized
 * spine table, the same choice rate-core made: one implementation, no spine
 * surgery, and the module that uses it owns its own output.
 */
import type { CodeList, CostAttribution, CostInflation, LedgerSetting, RelativeWindow, StudySpec } from "../spec/types";
import { findCodeList } from "../spec/types";
import { DX_COLUMNS, PROC_COLUMNS } from "../data/marketscan";
import { q } from "./sql-base";
import type { Ctx as SqlCtx } from "./sql-base";
import type { Ctx as SasCtx } from "./sas-base";
import { sq, yearWrap } from "./sas-base";

/** Place-of-service codes treated as an emergency department when the spec
 *  does not say otherwise. 23 is the standard ED POS. */
export const DEFAULT_ED_PLACE_OF_SERVICE = ["23"];

/** Ledger setting -> the label carried in the emitted `setting` column. */
export const SETTING_LABEL: Record<LedgerSetting, string> = {
  inpatient: "IP",
  ed: "ED",
  outpatient: "OP",
  pharmacy: "RX",
};

/** Stable emission order, so both twins build the setting list identically. */
export const SETTING_ORDER: LedgerSetting[] = ["inpatient", "ed", "outpatient", "pharmacy"];

export function orderedSettings(settings: LedgerSetting[]): LedgerSetting[] {
  return SETTING_ORDER.filter((s) => settings.includes(s));
}

/* ================================================================== *
 *  Disease-related attribution
 * ================================================================== */

/**
 * The attribution rule, resolved from the spec's code lists into the literal
 * codes and CLAIM COLUMNS both twins scan.
 *
 * Resolved ONCE, here, and rendered by each language — the same discipline
 * rate-core applies to censoring. Deciding "which diagnosis slots count" twice,
 * once per emitter, is exactly how a SAS twin ends up reading PDX while the SQL
 * twin reads PDX..DX15 and both report a plausible disease-related cost.
 */
export interface LedgerAttribution {
  dxPosition: "primary_only" | "any_position";
  /** dot-free codes, split by era — DXVER separates them at query time */
  dxIcd10: string[];
  dxIcd9: string[];
  /** condition-specific procedures. A claim carrying one is attributed even
   *  when no qualifying diagnosis appears on it. */
  procCodes: string[];
  /** condition-specific drugs held as a NAME list, matched through the NDC
   *  lookup the spine builds from the reference file. Null when the study named
   *  no drug list, or named one of literal NDCs (see drugNdcCodes) — and a null
   *  on BOTH means pharmacy cost can never be disease-related, which the module
   *  says out loud rather than reporting as a zero. */
  drugCodeListId: string | null;
  /** condition-specific drugs given as literal NDCs, matched inline. Kept
   *  separate because the SAS twin has no lookup table for a literal list —
   *  the spine only materializes one for NAME lists. */
  drugNdcCodes: string[] | null;
  /** the dx columns actually scanned, per claim family (stamped, so the
   *  fingerprint can hold the emitted code to what the stamp claims) */
  dxColumns: Record<string, string[]>;
  /** the procedure columns actually scanned, per claim family */
  procColumns: Record<string, string[]>;
}

/** Diagnosis columns that count as the PRIMARY/principal slot.
 *
 *  The outpatient family has no principal-diagnosis column at all — MarketScan's
 *  O table carries DX1..DX4 with no position semantics beyond ordering — so
 *  "primary" there means DX1, the first-listed diagnosis. That is the universal
 *  convention and it is written down here rather than assumed, because it is the
 *  one place `primary_only` means something slightly different per family. */
const PRIMARY_DX_COLUMNS: Record<string, string[]> = {
  inpatient_admissions: ["pdx"],
  inpatient_services: ["pdx"],
  outpatient_services: ["dx1"],
};

/** Claim families the attribution predicate is applied to. */
const ATTRIBUTION_FAMILIES = ["inpatient_admissions", "inpatient_services", "outpatient_services"] as const;

const lower = (xs: string[]): string[] => xs.map((x) => x.toLowerCase());

/** Normalize a dx/proc code the way it appears in claims (no dots, upper). */
const claimCode = (raw: string): string => raw.trim().toUpperCase().replace(/\./g, "");

/**
 * Split a diagnosis list into ICD-10 vs ICD-9 era codes.
 *
 * ONE splitter, used by BOTH twins — deliberately, and not the same shape as
 * the two private copies in sql.ts and sas.ts. Those two disagree about a
 * letter-leading code inside a list declared `icd9cm`, which is a latent
 * divergence in the events pipeline; attribution is new code, so it gets a
 * single implementation and cannot inherit that.
 */
function splitEras(list: CodeList): { icd10: string[]; icd9: string[] } {
  const icd10: string[] = [];
  const icd9: string[] = [];
  for (const entry of list.codes) {
    const c = claimCode(entry.code);
    if (c.length === 0) continue;
    if (list.system === "icd9cm" || /^[0-9]/.test(c)) icd9.push(c);
    else icd10.push(c);
  }
  return { icd10: [...new Set(icd10)], icd9: [...new Set(icd9)] };
}

/**
 * Resolve a spec's attribution rule against its code lists.
 *
 * Returns null for all-cause (and for a disease_related rule whose lists are
 * empty, which readiness already refuses — the null keeps the emitters total
 * rather than emitting a predicate that matches nothing and reports a
 * disease-related cost of zero as if it were a finding).
 */
export function resolveAttribution(spec: StudySpec, att: CostAttribution | undefined): LedgerAttribution | null {
  if (!att || att.kind !== "disease_related") return null;
  const dxList = findCodeList(spec, att.codeListId);
  const procList = att.procedureCodeListId ? findCodeList(spec, att.procedureCodeListId) : undefined;
  const { icd10, icd9 } = dxList ? splitEras(dxList) : { icd10: [], icd9: [] };
  const procCodes = procList
    ? [...new Set(procList.codes.map((c) => claimCode(c.code)).filter((c) => c.length > 0))]
    : [];
  const drugList = att.drugCodeListId ? findCodeList(spec, att.drugCodeListId) : undefined;
  const drugNdcCodes =
    drugList && drugList.system === "ndc"
      ? [...new Set(drugList.codes.map((c) => c.code.trim()).filter((c) => c.length > 0))]
      : null;
  const drugCodeListId = drugList && drugList.system !== "ndc" ? drugList.id : null;
  if (icd10.length === 0 && icd9.length === 0 && procCodes.length === 0 && !drugCodeListId && !drugNdcCodes) return null;

  const dxColumns: Record<string, string[]> = {};
  const procColumns: Record<string, string[]> = {};
  for (const fam of ATTRIBUTION_FAMILIES) {
    dxColumns[fam] =
      icd10.length + icd9.length === 0
        ? []
        : att.dxPosition === "primary_only"
          ? PRIMARY_DX_COLUMNS[fam]
          : lower(DX_COLUMNS[fam] ?? []);
    procColumns[fam] = procCodes.length === 0 ? [] : lower(PROC_COLUMNS[fam] ?? []);
  }
  return {
    /* NORMALIZED, not copied. This value is emitted as a bare literal in both
     * twins' output labels; taking the spec's string on trust would let a
     * hand-edited JSON put anything inside those quotes. Collapsing it to one
     * of exactly two tokens here means the emitters cannot render a third. */
    dxPosition: att.dxPosition === "primary_only" ? "primary_only" : "any_position",
    dxIcd10: icd10,
    dxIcd9: icd9,
    procCodes,
    drugCodeListId,
    drugNdcCodes,
    dxColumns,
    procColumns,
  };
}

/* ================================================================== *
 *  CPI restatement
 * ================================================================== */

/** Per-year multipliers, resolved once so both twins embed identical literals. */
export interface LedgerInflation {
  targetYear: number;
  seriesLabel: string;
  /** [calendar year, factor literal], ascending. The literal is what each twin
   *  writes into its own code, so a formatting difference cannot become an
   *  arithmetic difference. */
  factors: Array<[number, string]>;
}

/** index[target] / index[y] per year, rendered to a fixed 8 decimals.
 *  Formatted HERE, once: two independently-rounded literals would give the two
 *  twins different totals on a large enough claim volume. */
export function resolveInflation(inf: CostInflation | undefined): LedgerInflation | null {
  if (!inf) return null;
  const target = inf.indexByYear[inf.targetYear];
  if (!(target > 0)) return null;
  const factors = Object.keys(inf.indexByYear)
    .map(Number)
    .filter((y) => Number.isFinite(y) && inf.indexByYear[y] > 0)
    .sort((a, b) => a - b)
    .map((y) => [y, (target / inf.indexByYear[y]).toFixed(8)] as [number, string]);
  return { targetYear: inf.targetYear, seriesLabel: inf.seriesLabel, factors };
}

/** How the eligible member-month denominator is built, when one is asked for. */
export interface MemberMonthOptions {
  /** drop months under capitated coverage (spec default true) */
  excludeCapitated: boolean;
  /** plan-type codes treated as capitated */
  capitatedPlanTypes: string[];
  /** the study's own Rx-coverage requirement, applied to the same segments the
   *  spine's enrollment pull applies it to */
  requiresRxCoverage: boolean;
  /** MarketScan Medicaid flags drug coverage in a different column */
  rxColumn: string;
}

/**
 * Plan types treated as CAPITATED.
 *
 * 4 (HMO) and 7 (POS with capitation) are the MarketScan plan types under which
 * a provider is paid a per-member fee rather than per service, so a claim's paid
 * amount does not measure the cost of the care delivered — it is frequently zero
 * for care that certainly happened. Those months cannot sit in a PPPM
 * denominator, and their claims cannot sit in its numerator.
 */
export const DEFAULT_CAPITATED_PLAN_TYPES = ["4", "7"];

export interface LedgerInput {
  wp: string;
  window: RelativeWindow;
  settings: LedgerSetting[];
  costField: "paytot" | "netpay";
  edPlaces: string[];
  /** disease-related attribution. Omitted = all-cause only, and the ledger
   *  emits BYTE-IDENTICAL text to the all-cause form. */
  attribution?: LedgerAttribution | null;
  /** CPI restatement. Omitted = nominal dollars of the service year. */
  inflation?: LedgerInflation | null;
  /** build the eligible member-month denominator (and flag every encounter that
   *  falls OUTSIDE eligible member-time). Omitted = fixed-window only. */
  memberMonths?: MemberMonthOptions | null;
  /** CTE the ledger reads its members from. Defaults to defining `cohort`
   *  itself; a caller that already has a cohort (or a narrower at-risk set)
   *  passes its name and the ledger joins to that instead. */
  cohortCte?: string;
  /** prefix for every emitted CTE name, so the ledger can coexist with another
   *  chain in one WITH clause (rate-core also defines `cohort`, `ae`, ...). */
  prefix?: string;
}

/** Day offsets, resolved. An unbounded window is refused at readiness, so both
 *  ends are numbers by the time a module gets here; the fallbacks keep the
 *  emitters total rather than throwing on a spec that slipped through. */
export function windowDays(w: RelativeWindow): { start: number; end: number } {
  return {
    start: typeof w.start === "number" ? w.start : 0,
    end: typeof w.end === "number" ? w.end : 0,
  };
}

/* ================================================================== *
 *  SQL
 * ================================================================== */

/** `('A', 'B')`, wrapped so a long list does not run off the page. */
function inListSql(codes: string[]): string {
  const items = codes.map((c) => `'${q(c)}'`);
  if (items.join(", ").length <= 60) return `(${items.join(", ")})`;
  const rows: string[] = [];
  for (let n = 0; n < items.length; n += 6) rows.push("                 " + items.slice(n, n + 6).join(", "));
  return `(\n${rows.join(",\n")}\n               )`;
}

/**
 * The disease-related flag for one claim family, as a CASE expression.
 *
 * THE ARMS ARE ALTERNATIVES, NOT CONJUNCTS. A procedure or a drug attributes a
 * claim on its own, with no qualifying diagnosis anywhere on it — an infusion
 * administration line routinely carries none, and requiring one would drop the
 * single most expensive component of a specialty-drug cost study while leaving
 * a complete-looking table behind.
 */
function drCaseSql(alias: string, fam: string, a: LedgerAttribution, ind: string): string[] {
  const dxCols = a.dxColumns[fam] ?? [];
  const procCols = a.procColumns[fam] ?? [];
  const L: string[] = [`${ind}CASE`];
  const dxArm = (test: string, codes: string[]) => {
    const conds = dxCols.map((c) => `${alias}.${c} IN ${inListSql(codes)}`);
    L.push(`${ind}  WHEN ${test} AND (`);
    conds.forEach((cd, n) => L.push(`${ind}         ${n === 0 ? "   " : "OR "}${cd}`));
    L.push(`${ind}       ) THEN 1`);
  };
  if (dxCols.length > 0 && a.dxIcd10.length > 0) dxArm(`${alias}.dxver = '0'`, a.dxIcd10);
  if (dxCols.length > 0 && a.dxIcd9.length > 0) dxArm(`(${alias}.dxver = '9' OR ${alias}.dxver IS NULL)`, a.dxIcd9);
  if (procCols.length > 0) {
    procCols.forEach((c, n) =>
      L.push(`${ind}  ${n === 0 ? "WHEN " : "  OR "}${alias}.${c} IN ${inListSql(a.procCodes)}`),
    );
    L[L.length - 1] += ` THEN 1`;
  }
  L.push(`${ind}  ELSE 0`);
  L.push(`${ind}END AS dr`);
  return L;
}

/** `COALESCE(x.paytot, 0)` restated to the target dollar year by the claim's OWN
 *  service year. A year with no index yields NULL rather than 1.0 — see the
 *  `enc_not_restated` count, which is what keeps that drop from being silent. */
function paidSql(ctx: SqlCtx, alias: string, cost: string, dateCol: string, inf: LedgerInflation | null | undefined, ind: string): string[] {
  const nominal = `COALESCE(${alias}.${cost}, 0)`;
  if (!inf) return [`${ind}${nominal} AS paid`];
  const L: string[] = [`${ind}${nominal} AS paid_nominal,`];
  L.push(`${ind}${nominal} * CASE ${ctx.d.year(`${alias}.${dateCol}`)}`);
  for (const [y, f] of inf.factors) L.push(`${ind}    WHEN ${y} THEN ${f}`);
  L.push(`${ind}    ELSE NULL END AS paid`);
  return L;
}

/**
 * CTE chain from `cohort` through `encounters` (+ `obs`, the per-patient
 * observed-day denominator). The caller owns the `WITH` keyword and everything
 * downstream.
 */
export function ledgerSqlCtes(ctx: SqlCtx, i: LedgerInput): string[] {
  const { d } = ctx;
  const { start, end } = windowDays(i.window);
  const winLo = d.offset("c.index_date", start);
  const winHi = d.offset("c.index_date", end);
  const chosen = orderedSettings(i.settings);
  const want = (s: LedgerSetting) => chosen.includes(s);
  const cost = i.costField;
  const att = i.attribution ?? null;
  const inf = i.inflation ?? null;
  const mm = i.memberMonths ?? null;
  /* Extra per-line columns every ledger part must carry, in ONE order, so the
   * UNION ALL below cannot line them up differently per family. */
  const extra = [...(inf ? ["paid_nominal"] : []), ...(att ? ["dr"] : [])];

  const p = i.prefix ?? "";
  const coh = i.cohortCte ?? `${p}cohort`;
  const L: string[] = [];
  // ctx.cohortT so a subgroup sweep arm can slice the cohort this reads.
  if (!i.cohortCte) L.push(`WITH ${coh} AS (SELECT enrolid, index_date FROM ${ctx.cohortT}),`);

  /* Observed days: the window intersected with enrollment. Every rate below
   * divides by this, so a member observed for half the window does not look
   * like a light user of care — they look like what they are. */
  L.push(`${p}obs AS (   -- per-member observed days = window INTERSECT enrollment`);
  L.push(`  SELECT c.enrolid,`);
  L.push(`         COALESCE(SUM(GREATEST(0, ${d.daysBetween(`LEAST(${winHi}, ep.episode_end)`, `GREATEST(${winLo}, ep.episode_start)`)} + 1)), 0) AS observed_days`);
  L.push(`  FROM ${coh} c`);
  L.push(`  LEFT JOIN ${i.wp}_enroll_episodes ep`);
  L.push(`    ON ep.enrolid = c.enrolid`);
  L.push(`   AND ep.episode_start <= ${winHi}`);
  L.push(`   AND ep.episode_end   >= ${winLo}`);
  L.push(`  GROUP BY c.enrolid`);
  L.push(`),`);

  /* ELIGIBLE MEMBER-MONTHS, and why they are not the observed days above.
   *
   * `obs` reads the STITCHED episodes, which bridge a lapse up to the study's
   * gap allowance — correct for "was this member under observation", wrong for
   * "how many months of coverage do we get to divide by", because a bridged gap
   * is a month nobody was enrolled in. This chain therefore goes back to the
   * enrollment DETAIL, drops capitated months if asked, and merges what is left
   * into non-overlapping islands: real deliveries carry nested and overlapping
   * segments (one row per plan change), and summing them raw would count the
   * same day twice and understate PPPM. */
  if (mm) {
    const capList = mm.capitatedPlanTypes.map((c) => `'${q(c)}'`).join(", ");
    const priorEnd =
      `MAX(dtend) OVER (PARTITION BY enrolid ORDER BY dtstart, dtend ` +
      `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`;
    L.push(`${p}mm_seg0 AS (   -- eligible enrollment SEGMENTS (detail, not the stitched episode)`);
    L.push(`  SELECT e.enrolid, e.dtstart, e.dtend`);
    L.push(`  FROM ${coh} c`);
    L.push(`  JOIN ${ctx.t("enrollment_detail")} e ON e.enrolid = c.enrolid`);
    L.push(`  WHERE e.dtstart IS NOT NULL AND e.dtend IS NOT NULL`);
    if (mm.requiresRxCoverage) L.push(`    AND e.${mm.rxColumn} = '1'   -- the study's own Rx-coverage requirement`);
    if (mm.excludeCapitated) {
      L.push(`    -- CAPITATED MONTHS EXCLUDED. Under plan types ${mm.capitatedPlanTypes.join(", ")} the provider is paid a`);
      L.push(`    -- per-member fee, so a claim's paid amount does not measure the care given`);
      L.push(`    -- and is frequently zero for care that certainly happened.`);
      L.push(`    AND (e.plantyp IS NULL OR CAST(e.plantyp AS VARCHAR) NOT IN (${capList}))`);
    }
    L.push(`),`);
    L.push(`${p}mm_isl AS (   -- island break when a segment starts AFTER the running end + 1 day`);
    L.push(`  SELECT enrolid, dtstart, dtend,`);
    L.push(`         CASE WHEN ${priorEnd} IS NULL THEN 1`);
    L.push(`              WHEN dtstart > ${d.offset(priorEnd, 1)} THEN 1`);
    L.push(`              ELSE 0 END AS new_isl`);
    L.push(`  FROM ${p}mm_seg0`);
    L.push(`),`);
    L.push(`${p}mm_num AS (`);
    L.push(`  SELECT enrolid, dtstart, dtend,`);
    L.push(`         SUM(new_isl) OVER (PARTITION BY enrolid ORDER BY dtstart, dtend`);
    L.push(`                            ROWS UNBOUNDED PRECEDING) AS isl`);
    L.push(`  FROM ${p}mm_isl`);
    L.push(`),`);
    L.push(`${p}mm_seg AS (   -- non-overlapping eligible spans, one row per island`);
    L.push(`  SELECT enrolid, MIN(dtstart) AS seg_start, MAX(dtend) AS seg_end`);
    L.push(`  FROM ${p}mm_num GROUP BY enrolid, isl`);
    L.push(`),`);
    L.push(`${p}mm_pt AS (   -- per-member ELIGIBLE days inside the window`);
    L.push(`  SELECT c.enrolid,`);
    L.push(`         COALESCE(SUM(GREATEST(0, ${d.daysBetween(`LEAST(${winHi}, s.seg_end)`, `GREATEST(${winLo}, s.seg_start)`)} + 1)), 0) AS eligible_days`);
    L.push(`  FROM ${coh} c`);
    L.push(`  LEFT JOIN ${p}mm_seg s`);
    L.push(`    ON s.enrolid = c.enrolid`);
    L.push(`   AND s.seg_start <= ${winHi}`);
    L.push(`   AND s.seg_end   >= ${winLo}`);
    L.push(`  GROUP BY c.enrolid`);
    L.push(`),`);
  }

  const parts: string[] = [];

  if (want("inpatient")) {
    /* Stay-level records carry the stay's TOTAL payment. Their own service
     * lines are therefore excluded below — not because the lines are wrong, but
     * because they are already inside this number. */
    L.push(`${p}led_ip_adm AS (   -- inpatient ADMISSIONS: one encounter per stay, dated at admission`);
    L.push(`  SELECT c.enrolid, 'IP' AS setting, i.admdate AS service_date,`);
    L.push(`         COALESCE(CAST(i.caseid AS VARCHAR), 'ADM' || CAST(i.admdate AS VARCHAR)) AS enc_id,`);
    if (att) L.push(...drCaseSql("i", "inpatient_admissions", att, "         ").map((l, n, arr) => (n === arr.length - 1 ? `${l},` : l)));
    L.push(...paidSql(ctx, "i", cost, "admdate", inf, "         "));
    L.push(`  FROM ${coh} c`);
    L.push(`  JOIN ${ctx.t("inpatient_admissions")} i ON i.enrolid = c.enrolid`);
    L.push(`   AND i.admdate >= ${winLo} AND i.admdate <= ${winHi}`);
    L.push(`),`);
    L.push(`${p}led_ip_orphan AS (   -- inpatient SERVICE LINES with no admission record`);
    L.push(`  -- Kept only when nothing matches: by CASEID where the line has one,`);
    L.push(`  -- by admission date where it does not. Dropping these outright would`);
    L.push(`  -- silently lose stays that span a year-file boundary.`);
    L.push(`  SELECT c.enrolid, 'IP' AS setting, s.admdate AS service_date,`);
    L.push(`         COALESCE(CAST(s.caseid AS VARCHAR), 'ADM' || CAST(s.admdate AS VARCHAR)) AS enc_id,`);
    if (att) L.push(...drCaseSql("s", "inpatient_services", att, "         ").map((l, n, arr) => (n === arr.length - 1 ? `${l},` : l)));
    L.push(...paidSql(ctx, "s", cost, "admdate", inf, "         "));
    L.push(`  FROM ${coh} c`);
    L.push(`  JOIN ${ctx.t("inpatient_services")} s ON s.enrolid = c.enrolid`);
    L.push(`   AND s.admdate >= ${winLo} AND s.admdate <= ${winHi}`);
    L.push(`  WHERE NOT EXISTS (`);
    L.push(`    SELECT 1 FROM ${ctx.t("inpatient_admissions")} i2`);
    L.push(`     WHERE i2.enrolid = s.enrolid`);
    L.push(`       AND ( (s.caseid IS NOT NULL AND i2.caseid = s.caseid)`);
    L.push(`          OR (s.caseid IS NULL     AND i2.admdate = s.admdate) )`);
    L.push(`  )`);
    L.push(`),`);
    parts.push(`${p}led_ip_adm`, `${p}led_ip_orphan`);
  }

  if (want("ed") || want("outpatient")) {
    const edList = i.edPlaces.map((p) => `'${q(p)}'`).join(", ");
    const cls = want("ed")
      ? `CASE WHEN CAST(o.stdplac AS VARCHAR) IN (${edList}) THEN 'ED' ELSE 'OP' END`
      : `'OP'`;
    L.push(`${p}led_amb AS (   -- ambulatory lines; ONE encounter per member per service date per class`);
    if (want("ed")) L.push(`  -- MarketScan has no ED family: the ED is carved out by place of service (${i.edPlaces.join(", ")}).`);
    L.push(`  SELECT c.enrolid, ${cls} AS setting, o.svcdate AS service_date,`);
    L.push(`         CAST(o.svcdate AS VARCHAR) AS enc_id,`);
    if (att) L.push(...drCaseSql("o", "outpatient_services", att, "         ").map((l, n, arr) => (n === arr.length - 1 ? `${l},` : l)));
    L.push(...paidSql(ctx, "o", cost, "svcdate", inf, "         "));
    L.push(`  FROM ${coh} c`);
    L.push(`  JOIN ${ctx.t("outpatient_services")} o ON o.enrolid = c.enrolid`);
    L.push(`   AND o.svcdate >= ${winLo} AND o.svcdate <= ${winHi}`);
    L.push(`),`);
    parts.push(`${p}led_amb`);
  }

  if (want("pharmacy")) {
    L.push(`${p}led_rx AS (   -- pharmacy FILLS; the key includes the NDC, so two different`);
    L.push(`  -- products dispensed on one day are two fills, not one visit`);
    L.push(`  SELECT c.enrolid, 'RX' AS setting, r.svcdate AS service_date,`);
    L.push(`         CAST(r.svcdate AS VARCHAR) || ':' || CAST(r.ndcnum AS VARCHAR) AS enc_id,`);
    if (att) {
      /* A pharmacy claim carries no diagnosis at all, so the drug list is the
       * ONLY thing that can attribute one. Without it every dollar of drug cost
       * sits outside the disease-related column — which is why the module emits
       * a REVIEW note rather than letting a zero speak for itself. */
      L.push(
        att.drugCodeListId
          ? `         CASE WHEN dn.ndcnum IS NOT NULL THEN 1 ELSE 0 END AS dr,`
          : att.drugNdcCodes
            ? `         CASE WHEN CAST(r.ndcnum AS VARCHAR) IN ${inListSql(att.drugNdcCodes)} THEN 1 ELSE 0 END AS dr,`
            : `         0 AS dr,   -- no drug list declared: pharmacy cannot be attributed`,
      );
    }
    L.push(...paidSql(ctx, "r", cost, "svcdate", inf, "         "));
    L.push(`  FROM ${coh} c`);
    L.push(`  JOIN ${ctx.t("drug_claims")} r ON r.enrolid = c.enrolid`);
    L.push(`   AND r.svcdate >= ${winLo} AND r.svcdate <= ${winHi}`);
    if (att?.drugCodeListId) {
      L.push(`  LEFT JOIN ${i.wp}_ndc_lookup dn`);
      L.push(`    ON dn.ndcnum = r.ndcnum AND dn.code_list_id = '${q(att.drugCodeListId)}'`);
    }
    L.push(`),`);
    parts.push(`${p}led_rx`);
  }

  const lineCols = ["enrolid", "setting", "service_date", "enc_id", ...extra, "paid"].join(", ");
  L.push(`${p}ledger AS (`);
  parts.forEach((pt, n) => {
    L.push(`  ${n === 0 ? "  " : "UNION ALL "}SELECT ${lineCols} FROM ${pt}`);
  });
  L.push(`),`);
  /* Lines collapse to encounters here: same member, same class, same key.
   *
   * The plain form is spelled out separately rather than reached by dropping
   * conditional lines out of the wide one, because it must stay BYTE-IDENTICAL
   * to what this emitter produced before the economics layer existed — a spec
   * declaring none of it gets exactly its old program, and the snapshot gate
   * checks that. */
  L.push(`${p}encounters AS (`);
  if (!inf && !att) {
    L.push(`  SELECT enrolid, setting, enc_id, MIN(service_date) AS encounter_date, SUM(paid) AS paid`);
  } else {
    L.push(`  SELECT enrolid, setting, enc_id, MIN(service_date) AS encounter_date,`);
    if (inf) {
      L.push(`         SUM(paid_nominal) AS paid_nominal,`);
      /* A line whose service year has no index restates to NULL. SUM() would
       * drop it without a word, so the encounter is COUNTED here and reported. */
      L.push(`         SUM(CASE WHEN paid IS NULL THEN 1 ELSE 0 END) AS n_no_index,`);
    }
    /* ANY qualifying line makes the whole encounter disease-related: a stay
     * whose principal diagnosis is the condition is a disease-related stay even
     * though most of its lines carry something else. */
    if (att) L.push(`         MAX(dr) AS dr,`);
    L.push(`         SUM(paid) AS paid`);
  }
  L.push(`  FROM ${p}ledger`);
  L.push(`  GROUP BY enrolid, setting, enc_id`);
  L.push(`),`);
  // Filter the ambulatory split down to the settings actually requested.
  const keptWhere =
    want("ed") && !want("outpatient") ? ` WHERE setting <> 'OP'` :
    want("outpatient") && !want("ed") ? ` WHERE setting <> 'ED'` : ``;
  if (mm) {
    /* ELIGIBLE MEMBER-TIME, on the numerator side too. A payment made in a month
     * the denominator excludes would otherwise inflate PPPM: real dollars over
     * fewer months. The flag is emitted rather than the rows dropped, so the
     * excluded encounters stay countable and visible. */
    L.push(`${p}encounters_kept AS (`);
    L.push(`  SELECT e.*,`);
    L.push(`         CASE WHEN EXISTS (`);
    L.push(`           SELECT 1 FROM ${p}mm_seg s`);
    L.push(`            WHERE s.enrolid = e.enrolid`);
    L.push(`              AND e.encounter_date BETWEEN s.seg_start AND s.seg_end`);
    L.push(`         ) THEN 1 ELSE 0 END AS elig`);
    L.push(`  FROM ${p}encounters e${keptWhere}`);
    L.push(`),`);
  } else {
    L.push(`${p}encounters_kept AS (SELECT * FROM ${p}encounters${keptWhere}),`);
  }
  return L;
}

/* ================================================================== *
 *  SAS
 * ================================================================== */

export interface LedgerSasInput extends LedgerInput {
  /** program number, for the work-table prefix */
  num: string;
  /** final-cohort table reference */
  cohT: string;
  /** stitched-episode table reference */
  epiT: string;
  /** enrollment-SEGMENT table reference (040_enroll), which the member-month
   *  denominator reads instead of the stitched episodes */
  enrT?: string;
}

/** `('A','B')` for a SAS IN-list, wrapped like the SQL twin's. */
function inListSas(codes: string[]): string {
  const items = codes.map((c) => `'${sq(c)}'`);
  if (items.join(",").length <= 60) return `(${items.join(",")})`;
  const rows: string[] = [];
  for (let k = 0; k < items.length; k += 6) rows.push("                 " + items.slice(k, k + 6).join(","));
  return `(\n${rows.join(",\n")}\n               )`;
}

/** SAS twin of drCaseSql — same arms, same alternation, same columns. */
function drCaseSas(alias: string, fam: string, a: LedgerAttribution, ind: string): string[] {
  const dxCols = a.dxColumns[fam] ?? [];
  const procCols = a.procColumns[fam] ?? [];
  const L: string[] = [`${ind}case`];
  const dxArm = (test: string, codes: string[]) => {
    L.push(`${ind}  when ${test} and (`);
    dxCols.forEach((c, k) => L.push(`${ind}         ${k === 0 ? "   " : "or "}${alias}.${c} in ${inListSas(codes)}`));
    L.push(`${ind}       ) then 1`);
  };
  if (dxCols.length > 0 && a.dxIcd10.length > 0) dxArm(`${alias}.dxver = '0'`, a.dxIcd10);
  if (dxCols.length > 0 && a.dxIcd9.length > 0) dxArm(`(${alias}.dxver = '9' or ${alias}.dxver = '')`, a.dxIcd9);
  if (procCols.length > 0) {
    procCols.forEach((c, k) =>
      L.push(`${ind}  ${k === 0 ? "when " : "  or "}${alias}.${c} in ${inListSas(a.procCodes)}`),
    );
    L[L.length - 1] += ` then 1`;
  }
  L.push(`${ind}  else 0`);
  L.push(`${ind}end as dr`);
  return L;
}

/** SAS twin of paidSql. The factor literals come from the SAME resolved list, so
 *  a rounding difference cannot become an arithmetic difference. */
function paidSas(alias: string, cost: string, dateCol: string, inf: LedgerInflation | null | undefined, ind: string): string[] {
  const nominal = `coalesce(${alias}.${cost}, 0)`;
  if (!inf) return [`${ind}${nominal} as paid`];
  const L: string[] = [`${ind}${nominal} as paid_nominal,`];
  L.push(`${ind}${nominal} * (case year(${alias}.${dateCol})`);
  for (const [y, f] of inf.factors) L.push(`${ind}    when ${y} then ${f}`);
  L.push(`${ind}    else . end) as paid`);
  return L;
}

/**
 * SAS twin of the chain above, as a list of statements. Raw claim families are
 * pulled through the site's per-year driver (yearWrap), which is why that
 * helper lives in sas-base.ts rather than inside sas.ts.
 */
export function ledgerSasSteps(
  ctx: SasCtx,
  i: LedgerSasInput,
): { lines: string[]; encounters: string; obs: string; memberMonths: string } {
  const { site } = ctx;
  const n = i.num;
  const { start, end } = windowDays(i.window);
  const lo = start === 0 ? "a.index_date" : start > 0 ? `a.index_date + ${start}` : `a.index_date - ${-start}`;
  const hi = end === 0 ? "a.index_date" : end > 0 ? `a.index_date + ${end}` : `a.index_date - ${-end}`;
  const chosen = orderedSettings(i.settings);
  const want = (s: LedgerSetting) => chosen.includes(s);
  const cost = i.costField;
  const att = i.attribution ?? null;
  const inf = i.inflation ?? null;
  const mm = i.memberMonths ?? null;
  const L: string[] = [];
  const src: string[] = [];

  L.push(
    `/*-------------------- claim-line ledger -------------------------------------`,
    `  Raw claim families pulled through the site's per-year driver, joined to the`,
    `  cohort and clipped to the resource-use window, then collapsed to encounters.`,
    `  The inpatient rule is the one that matters: admission records carry the`,
    `  stay total, so their own service lines are EXCLUDED. Service lines with no`,
    `  matching admission record are kept, or those stays vanish. */`,
    ``,
    `proc datasets lib=work nolist nowarn;`,
    `  delete _${n}_led _${n}_enc _${n}_obs${mm ? ` _${n}_enc2 _${n}_mseg0 _${n}_mseg _${n}_mm` : ""};`,
    `quit;`,
    ``,
  );

  if (want("inpatient")) {
    src.push(`work._${n}_ip_adm`, `work._${n}_ip_orp`);
    L.push(
      ...yearWrap(site, ctx.mname(`led_ipa_${n}`), [
        `proc sql;`,
        `  create table work._${n}_ipa as`,
        `  select a.enrolid, 'IP' as setting length=2,`,
        `         b.admdate as service_date format=date9.,`,
        `         case when b.caseid ne . then strip(put(b.caseid, best12.))`,
        `              else 'ADM' || put(b.admdate, yymmdd10.) end as enc_id length=32,`,
        ...(att ? drCaseSas("b", "inpatient_admissions", att, "         ").map((l, k, arr) => (k === arr.length - 1 ? `${l},` : l)) : []),
        ...paidSas("b", cost, "admdate", inf, "         "),
        `  from ${i.cohT} as a`,
        `  inner join ${site.tab("i")} as b`,
        `    on  b.enrolid = a.enrolid`,
        `    and b.admdate between ${lo} and ${hi};`,
        `quit;`,
        ``,
        `proc append base=work._${n}_ip_adm data=work._${n}_ipa force;`,
        `run;`,
        ``,
      ]),
      ``,
      ...yearWrap(site, ctx.mname(`led_ipo_${n}`), [
        `proc sql;`,
        `  create table work._${n}_ipo as`,
        `  select a.enrolid, 'IP' as setting length=2,`,
        `         s.admdate as service_date format=date9.,`,
        `         case when s.caseid ne . then strip(put(s.caseid, best12.))`,
        `              else 'ADM' || put(s.admdate, yymmdd10.) end as enc_id length=32,`,
        ...(att ? drCaseSas("s", "inpatient_services", att, "         ").map((l, k, arr) => (k === arr.length - 1 ? `${l},` : l)) : []),
        ...paidSas("s", cost, "admdate", inf, "         "),
        `  from ${i.cohT} as a`,
        `  inner join ${site.tab("s")} as s`,
        `    on  s.enrolid = a.enrolid`,
        `    and s.admdate between ${lo} and ${hi}`,
        `  where not exists (`,
        `    select 1 from ${site.tab("i")} as i2`,
        `     where i2.enrolid = s.enrolid`,
        `       and ( (s.caseid ne . and i2.caseid = s.caseid)`,
        `          or (s.caseid  = . and i2.admdate = s.admdate) )`,
        `  );`,
        `quit;`,
        ``,
        `proc append base=work._${n}_ip_orp data=work._${n}_ipo force;`,
        `run;`,
        ``,
      ]),
      ``,
    );
  }

  if (want("ed") || want("outpatient")) {
    src.push(`work._${n}_amb`);
    const edTest = i.edPlaces.map((p) => `'${p}'`).join(", ");
    const clsLines = want("ed")
      ? [
          `         /* MarketScan has no ED family: carved out by place of service */`,
          `         case when strip(vvalue(o.stdplac)) in (${edTest}) then 'ED'`,
          `              else 'OP' end as setting length=2,`,
        ]
      : [`         'OP' as setting length=2,`];
    L.push(
      ...yearWrap(site, ctx.mname(`led_amb_${n}`), [
        `proc sql;`,
        `  create table work._${n}_amb_stg as`,
        `  select a.enrolid,`,
        ...clsLines,
        `         o.svcdate as service_date format=date9.,`,
        `         put(o.svcdate, yymmdd10.) as enc_id length=32,`,
        ...(att ? drCaseSas("o", "outpatient_services", att, "         ").map((l, k, arr) => (k === arr.length - 1 ? `${l},` : l)) : []),
        ...paidSas("o", cost, "svcdate", inf, "         "),
        `  from ${i.cohT} as a`,
        `  inner join ${site.tab("o")} as o`,
        `    on  o.enrolid = a.enrolid`,
        `    and o.svcdate between ${lo} and ${hi};`,
        `quit;`,
        ``,
        `proc append base=work._${n}_amb data=work._${n}_amb_stg force;`,
        `run;`,
        ``,
      ]),
      ``,
    );
  }

  if (want("pharmacy")) {
    src.push(`work._${n}_rx`);
    L.push(
      ...yearWrap(site, ctx.mname(`led_rx_${n}`), [
        `proc sql;`,
        `  create table work._${n}_rx_stg as`,
        `  select a.enrolid, 'RX' as setting length=2,`,
        `         r.svcdate as service_date format=date9.,`,
        `         put(r.svcdate, yymmdd10.) || ':' || strip(r.ndcnum) as enc_id length=32,`,
        ...(att
          ? [
              att.drugCodeListId
                ? `         (case when dn.ndcnum ne '' then 1 else 0 end) as dr,`
                : att.drugNdcCodes
                  ? `         (case when strip(r.ndcnum) in ${inListSas(att.drugNdcCodes)} then 1 else 0 end) as dr,`
                  : `         0 as dr,   /* no drug list declared: pharmacy cannot be attributed */`,
            ]
          : []),
        ...paidSas("r", cost, "svcdate", inf, "         "),
        `  from ${i.cohT} as a`,
        `  inner join ${site.tab("d")} as r`,
        `    on  r.enrolid = a.enrolid`,
        ...(att?.drugCodeListId
          ? [
              `    and r.svcdate between ${lo} and ${hi}`,
              `  left join ${ctx.ndcOf(att.drugCodeListId)} as dn`,
              `    on dn.ndcnum = r.ndcnum;`,
            ]
          : [`    and r.svcdate between ${lo} and ${hi};`]),
        `quit;`,
        ``,
        `proc append base=work._${n}_rx data=work._${n}_rx_stg force;`,
        `run;`,
        ``,
      ]),
      ``,
    );
  }

  L.push(
    `data work._${n}_led;`,
    `  set ${src.join(" ")};`,
    `run;`,
    ``,
  );
  if (want("ed") && !want("outpatient")) L.push(`data work._${n}_led; set work._${n}_led; if setting ne 'OP'; run;`, ``);
  if (want("outpatient") && !want("ed")) L.push(`data work._${n}_led; set work._${n}_led; if setting ne 'ED'; run;`, ``);

  L.push(
    `/* lines -> encounters: same member, same class, same key */`,
    `proc sql;`,
    `  create table work._${n}_enc as`,
    `  select enrolid, setting, enc_id,`,
    `         min(service_date) as encounter_date format=date9.,`,
    ...(inf
      ? [
          `         sum(paid_nominal) as paid_nominal,`,
          /* SAS's sum() ignores a missing value exactly as SQL's SUM() ignores a
           * NULL, so a claim whose service year has no index would vanish from
           * the total without a word. Counted here, reported downstream. */
          `         sum(paid = .) as n_no_index,`,
        ]
      : []),
    ...(att ? [`         max(dr) as dr,`] : []),
    `         sum(paid) as paid`,
    `  from work._${n}_led`,
    `  group by enrolid, setting, enc_id;`,
    `quit;`,
    ``,
    `/* observed days = the window INTERSECT enrollment, summed per member */`,
    `proc sql;`,
    `  create table work._${n}_obs as`,
    `  select a.enrolid,`,
    `         coalesce(sum(max(0, min(${hi}, ep.dtend) - max(${lo}, ep.dtstart) + 1)), 0) as observed_days`,
    `  from ${i.cohT} as a`,
    `  left join ${i.epiT} as ep`,
    `    on  ep.enrolid = a.enrolid`,
    `    and ep.dtstart <= ${hi}`,
    `    and ep.dtend   >= ${lo}`,
    `  group by a.enrolid;`,
    `quit;`,
    ``,
  );

  let encounters = `work._${n}_enc`;
  if (mm) {
    const capList = mm.capitatedPlanTypes.map((c) => `'${sq(c)}'`).join(", ");
    L.push(
      `/*-------------------- eligible member-months --------------------------------`,
      `  Twin of the SQL mm_* chain, and NOT the observed days above: those come`,
      `  from the STITCHED episodes, which bridge a lapse up to the gap allowance.`,
      `  A bridged gap is a month nobody was enrolled in, so the denominator goes`,
      `  back to the enrollment SEGMENTS, drops capitated months if asked, and`,
      `  merges the rest into non-overlapping islands (a delivery carries one row`,
      `  per plan change, and summing them raw double-counts the overlap). */`,
      ``,
      `proc sql;`,
      `  create table work._${n}_mseg0 as`,
      `  select distinct a.enrolid, b.dtstart, b.dtend`,
      `  from ${i.cohT} as a`,
      `  inner join ${i.enrT ?? ctx.tbl("040_enroll")} as b`,
      `    on b.enrolid = a.enrolid`,
      `  where b.dtstart ne . and b.dtend ne .`,
      ...(mm.excludeCapitated
        ? [
            `    /* capitated months excluded: plan types ${mm.capitatedPlanTypes.join(", ")} pay the provider a`,
            `       per-member fee, so a paid amount there does not measure the care given */`,
            `    and strip(vvalue(b.plantyp)) not in (${capList});`,
          ]
        : [`  ;`]),
      `quit;`,
      ``,
      `proc sort data=work._${n}_mseg0;`,
      `  by enrolid dtstart dtend;`,
      `run;`,
      ``,
      `data work._${n}_mseg;`,
      `  set work._${n}_mseg0;`,
      `  by enrolid dtstart dtend;`,
      `  retain seg_start run_end;`,
      `  format seg_start seg_end date9.;`,
      `  if first.enrolid then do;`,
      `    seg_start = dtstart;`,
      `    run_end   = dtend;`,
      `  end;`,
      `  else if dtstart <= run_end + 1 then run_end = max(run_end, dtend);`,
      `  else do;`,
      `    /* a real lapse: close the island and open the next one */`,
      `    seg_end = run_end;`,
      `    output;`,
      `    seg_start = dtstart;`,
      `    run_end   = dtend;`,
      `  end;`,
      `  if last.enrolid then do;`,
      `    seg_end = run_end;`,
      `    output;`,
      `  end;`,
      `  keep enrolid seg_start seg_end;`,
      `run;`,
      ``,
      `proc sql;`,
      `  create table work._${n}_mm as`,
      `  select a.enrolid,`,
      `         coalesce(sum(max(0, min(${hi}, s.seg_end) - max(${lo}, s.seg_start) + 1)), 0) as eligible_days`,
      `  from ${i.cohT} as a`,
      `  left join work._${n}_mseg as s`,
      `    on  s.enrolid = a.enrolid`,
      `    and s.seg_start <= ${hi}`,
      `    and s.seg_end   >= ${lo}`,
      `  group by a.enrolid;`,
      ``,
      `/* eligible member-TIME on the numerator side too: a payment made in a month`,
      `   the denominator excludes would otherwise inflate PPPM (real dollars over`,
      `   fewer months). Flagged rather than dropped, so it stays countable. */`,
      `  create table work._${n}_enc2 as`,
      `  select e.*,`,
      `         (case when exists (select 1 from work._${n}_mseg as s`,
      `                             where s.enrolid = e.enrolid`,
      `                               and e.encounter_date between s.seg_start and s.seg_end)`,
      `               then 1 else 0 end) as elig`,
      `  from work._${n}_enc as e;`,
      `quit;`,
      ``,
    );
    encounters = `work._${n}_enc2`;
  }

  return { lines: L, encounters, obs: `work._${n}_obs`, memberMonths: `work._${n}_mm` };
}
