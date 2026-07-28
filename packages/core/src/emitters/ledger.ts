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
import type { LedgerSetting, RelativeWindow } from "../spec/types";
import { q } from "./sql-base";
import type { Ctx as SqlCtx } from "./sql-base";
import type { Ctx as SasCtx } from "./sas-base";
import { yearWrap } from "./sas-base";

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

export interface LedgerInput {
  wp: string;
  window: RelativeWindow;
  settings: LedgerSetting[];
  costField: "paytot" | "netpay";
  edPlaces: string[];
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

  const L: string[] = [];
  L.push(`WITH cohort AS (SELECT enrolid, index_date FROM ${i.wp}_cohort),`);

  /* Observed days: the window intersected with enrollment. Every rate below
   * divides by this, so a member observed for half the window does not look
   * like a light user of care — they look like what they are. */
  L.push(`obs AS (   -- per-member observed days = window INTERSECT enrollment`);
  L.push(`  SELECT c.enrolid,`);
  L.push(`         COALESCE(SUM(GREATEST(0, ${d.daysBetween(`LEAST(${winHi}, ep.episode_end)`, `GREATEST(${winLo}, ep.episode_start)`)} + 1)), 0) AS observed_days`);
  L.push(`  FROM cohort c`);
  L.push(`  LEFT JOIN ${i.wp}_enroll_episodes ep`);
  L.push(`    ON ep.enrolid = c.enrolid`);
  L.push(`   AND ep.episode_start <= ${winHi}`);
  L.push(`   AND ep.episode_end   >= ${winLo}`);
  L.push(`  GROUP BY c.enrolid`);
  L.push(`),`);

  const parts: string[] = [];

  if (want("inpatient")) {
    /* Stay-level records carry the stay's TOTAL payment. Their own service
     * lines are therefore excluded below — not because the lines are wrong, but
     * because they are already inside this number. */
    L.push(`led_ip_adm AS (   -- inpatient ADMISSIONS: one encounter per stay, dated at admission`);
    L.push(`  SELECT c.enrolid, 'IP' AS setting, i.admdate AS service_date,`);
    L.push(`         COALESCE(CAST(i.caseid AS VARCHAR), 'ADM' || CAST(i.admdate AS VARCHAR)) AS enc_id,`);
    L.push(`         COALESCE(i.${cost}, 0) AS paid`);
    L.push(`  FROM cohort c`);
    L.push(`  JOIN ${ctx.t("inpatient_admissions")} i ON i.enrolid = c.enrolid`);
    L.push(`   AND i.admdate >= ${winLo} AND i.admdate <= ${winHi}`);
    L.push(`),`);
    L.push(`led_ip_orphan AS (   -- inpatient SERVICE LINES with no admission record`);
    L.push(`  -- Kept only when nothing matches: by CASEID where the line has one,`);
    L.push(`  -- by admission date where it does not. Dropping these outright would`);
    L.push(`  -- silently lose stays that span a year-file boundary.`);
    L.push(`  SELECT c.enrolid, 'IP' AS setting, s.admdate AS service_date,`);
    L.push(`         COALESCE(CAST(s.caseid AS VARCHAR), 'ADM' || CAST(s.admdate AS VARCHAR)) AS enc_id,`);
    L.push(`         COALESCE(s.${cost}, 0) AS paid`);
    L.push(`  FROM cohort c`);
    L.push(`  JOIN ${ctx.t("inpatient_services")} s ON s.enrolid = c.enrolid`);
    L.push(`   AND s.admdate >= ${winLo} AND s.admdate <= ${winHi}`);
    L.push(`  WHERE NOT EXISTS (`);
    L.push(`    SELECT 1 FROM ${ctx.t("inpatient_admissions")} i2`);
    L.push(`     WHERE i2.enrolid = s.enrolid`);
    L.push(`       AND ( (s.caseid IS NOT NULL AND i2.caseid = s.caseid)`);
    L.push(`          OR (s.caseid IS NULL     AND i2.admdate = s.admdate) )`);
    L.push(`  )`);
    L.push(`),`);
    parts.push("led_ip_adm", "led_ip_orphan");
  }

  if (want("ed") || want("outpatient")) {
    const edList = i.edPlaces.map((p) => `'${q(p)}'`).join(", ");
    const cls = want("ed")
      ? `CASE WHEN CAST(o.stdplac AS VARCHAR) IN (${edList}) THEN 'ED' ELSE 'OP' END`
      : `'OP'`;
    L.push(`led_amb AS (   -- ambulatory lines; ONE encounter per member per service date per class`);
    if (want("ed")) L.push(`  -- MarketScan has no ED family: the ED is carved out by place of service (${i.edPlaces.join(", ")}).`);
    L.push(`  SELECT c.enrolid, ${cls} AS setting, o.svcdate AS service_date,`);
    L.push(`         CAST(o.svcdate AS VARCHAR) AS enc_id,`);
    L.push(`         COALESCE(o.${cost}, 0) AS paid`);
    L.push(`  FROM cohort c`);
    L.push(`  JOIN ${ctx.t("outpatient_services")} o ON o.enrolid = c.enrolid`);
    L.push(`   AND o.svcdate >= ${winLo} AND o.svcdate <= ${winHi}`);
    L.push(`),`);
    parts.push("led_amb");
  }

  if (want("pharmacy")) {
    L.push(`led_rx AS (   -- pharmacy FILLS; the key includes the NDC, so two different`);
    L.push(`  -- products dispensed on one day are two fills, not one visit`);
    L.push(`  SELECT c.enrolid, 'RX' AS setting, r.svcdate AS service_date,`);
    L.push(`         CAST(r.svcdate AS VARCHAR) || ':' || CAST(r.ndcnum AS VARCHAR) AS enc_id,`);
    L.push(`         COALESCE(r.${cost}, 0) AS paid`);
    L.push(`  FROM cohort c`);
    L.push(`  JOIN ${ctx.t("drug_claims")} r ON r.enrolid = c.enrolid`);
    L.push(`   AND r.svcdate >= ${winLo} AND r.svcdate <= ${winHi}`);
    L.push(`),`);
    parts.push("led_rx");
  }

  L.push(`ledger AS (`);
  parts.forEach((p, n) => {
    L.push(`  ${n === 0 ? "  " : "UNION ALL "}SELECT enrolid, setting, service_date, enc_id, paid FROM ${p}`);
  });
  L.push(`),`);
  // Lines collapse to encounters here: same member, same class, same key.
  L.push(`encounters AS (`);
  L.push(`  SELECT enrolid, setting, enc_id, MIN(service_date) AS encounter_date, SUM(paid) AS paid`);
  L.push(`  FROM ledger`);
  L.push(`  GROUP BY enrolid, setting, enc_id`);
  L.push(`),`);
  // Filter the ambulatory split down to the settings actually requested.
  if (want("ed") && !want("outpatient")) {
    L.push(`encounters_kept AS (SELECT * FROM encounters WHERE setting <> 'OP'),`);
  } else if (want("outpatient") && !want("ed")) {
    L.push(`encounters_kept AS (SELECT * FROM encounters WHERE setting <> 'ED'),`);
  } else {
    L.push(`encounters_kept AS (SELECT * FROM encounters),`);
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
}

/**
 * SAS twin of the chain above, as a list of statements. Raw claim families are
 * pulled through the site's per-year driver (yearWrap), which is why that
 * helper lives in sas-base.ts rather than inside sas.ts.
 */
export function ledgerSasSteps(ctx: SasCtx, i: LedgerSasInput): { lines: string[]; encounters: string; obs: string } {
  const { site } = ctx;
  const n = i.num;
  const { start, end } = windowDays(i.window);
  const lo = start === 0 ? "a.index_date" : start > 0 ? `a.index_date + ${start}` : `a.index_date - ${-start}`;
  const hi = end === 0 ? "a.index_date" : end > 0 ? `a.index_date + ${end}` : `a.index_date - ${-end}`;
  const chosen = orderedSettings(i.settings);
  const want = (s: LedgerSetting) => chosen.includes(s);
  const cost = i.costField;
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
    `  delete _${n}_led _${n}_enc _${n}_obs;`,
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
        `         coalesce(b.${cost}, 0) as paid`,
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
        `         coalesce(s.${cost}, 0) as paid`,
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
        `         coalesce(o.${cost}, 0) as paid`,
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
        `         coalesce(r.${cost}, 0) as paid`,
        `  from ${i.cohT} as a`,
        `  inner join ${site.tab("d")} as r`,
        `    on  r.enrolid = a.enrolid`,
        `    and r.svcdate between ${lo} and ${hi};`,
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

  return { lines: L, encounters: `work._${n}_enc`, obs: `work._${n}_obs` };
}
