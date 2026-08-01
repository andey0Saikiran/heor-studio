/**
 * Resource-use and cost module — encounter counts and payments over a window
 * relative to index, both drawn from ONE claim-line ledger (emitters/ledger.ts).
 *
 * Counts and costs are one analysis rather than two on purpose. They are the
 * same denominator, the same window and the same definition of an encounter; a
 * utilization table and a cost table that quietly disagree about what an
 * admission IS are worse than either alone, and that disagreement is invisible
 * in the output.
 *
 * THE ECONOMICS LAYER, all of it optional and all of it stamped.
 *
 *   ATTRIBUTION. All-cause and disease-related are emitted SIDE BY SIDE when an
 *   attribution rule is declared, because their difference is the finding and
 *   neither column alone supports it. The rule itself is contested — primary
 *   position only is conservative, any position is generous, and published
 *   comparisons rank the same conditions differently — so it is declared and
 *   stamped rather than defaulted.
 *
 *   NORMALIZATION. `observed_member_months` builds the denominator from the
 *   enrollment SEGMENTS, not from the window length and not from the stitched
 *   episodes (which bridge gaps the denominator must not count). Capitated
 *   months leave both the denominator and the numerator: a capitated claim's
 *   paid amount does not measure the care given.
 *
 *   INFLATION. Every line is restated to the declared dollar year on its OWN
 *   service year. With no `inflation` the program SAYS its costs are nominal
 *   rather than leaving the reader to assume it.
 *
 *   QUANTILES. Median, Q1, Q3 and IQR under the DECLARED definition, written
 *   out explicitly in both languages — PERCENTILE_CONT/PCTLDEF=5 for
 *   "interpolated", PERCENTILE_DISC/PCTLDEF=3 for "nearest_rank" — never a
 *   language default. This was a refusal ("median yes, quartiles no"); the
 *   risk was real and the remedy was wrong. Removing the CHOICE is what makes
 *   the statistic safe, not removing the statistic. The residual estimator gap
 *   under "interpolated" is bounded, stated in an always-emitted method note,
 *   and absent entirely under "nearest_rank" — see resourceUseMethodNotes.
 *
 * BYTE-IDENTITY IS PART OF THE CONTRACT. Every branch above is gated on a
 * declared option: a spec that declares none of them emits exactly the text it
 * emitted before this layer existed, which is what the snapshot gate checks.
 *
 * Verified vs Gold Case A over [index, index+364]: 19 encounters across 10
 * members (11 RX, 5 OP, 1 ED, 2 IP) and $18,600 of payments, mean $1,860 against
 * a median of $350 — the right-skew that makes reporting both mandatory. The
 * inpatient total is $15,000; a ledger that summed admission totals WITH their
 * own service lines would report $22,000.
 *
 * Verified vs Gold Case H for the economics layer: 114 eligible member-months
 * against a 144-member-month fixed window, $22,800 restated from $22,500,
 * $20,250 disease-related, PPPM $200.00 where the window-based figure says
 * $158.33, and a median of $1,575 interpolated against $1,050 nearest-rank on
 * the same six patients. All hand-derived, all asserted in verify/run.ts.
 */
import type { ResourceUseAnalysis } from "../../spec/types";
import type { GeneratedFile } from "../types";
import type { AnalysisModule, SqlCtx, SasCtx, SqlModuleFile } from "./types";
import { oneLine } from "../sql-base";
import { cmt, header, levelCheck, INCLUDE_SETUP } from "../sas-base";
import {
  parityStamp,
  renderDaysPerMonth,
  renderDaysPerYear,
  resourceUseLimitations,
  resourceUseMethodNotes,
  resourceUseParity,
} from "../parity";
import {
  DEFAULT_CAPITATED_PLAN_TYPES,
  DEFAULT_ED_PLACE_OF_SERVICE,
  ledgerSasSteps,
  ledgerSqlCtes,
  orderedSettings,
  resolveAttribution,
  resolveInflation,
  windowDays,
  SETTING_LABEL,
  type LedgerAttribution,
  type LedgerInflation,
  type MemberMonthOptions,
} from "../ledger";

const MEASURE = "resource_use";

/** Row order in the output: the combined row first, then the ledger order. */
function settingRows(an: ResourceUseAnalysis): string[] {
  const labels = orderedSettings(an.settings).map((s) => SETTING_LABEL[s]);
  return an.includeCombined ? ["ALL", ...labels] : labels;
}

/** Observed-day length the window implies (both ends inclusive). */
function windowLength(an: ResourceUseAnalysis): number | null {
  const { start, end } = windowDays(an.ascertainmentWindow);
  if (typeof an.ascertainmentWindow.start !== "number" || typeof an.ascertainmentWindow.end !== "number") return null;
  return end - start + 1;
}

/**
 * Everything the two twins must consume identically, resolved ONCE.
 *
 * Resolved here rather than in each emitter for the same reason rate-core
 * resolves censoring once: two independent readings of the same optional field
 * is how one twin ends up scanning PDX while the other scans PDX..DX15, and
 * both report a plausible number.
 */
interface Consumed {
  att: LedgerAttribution | null;
  inf: LedgerInflation | null;
  mm: MemberMonthOptions | null;
  /** "month" | "year" — only meaningful when `mm` is set */
  per: "month" | "year";
  /** days per member-month (or member-year), as a DECIMAL literal so the
   *  division is numeric rather than integer */
  daysPerUnit: string;
  /** quantiles are emitted at all */
  wantQ: boolean;
  /** the definition BOTH twins compute; "interpolated" when none is declared */
  qdef: "interpolated" | "nearest_rank";
}

function consume(ctx: SqlCtx | SasCtx, an: ResourceUseAnalysis): Consumed {
  const spec = ctx.spec;
  const norm = an.normalization;
  const wantQ = an.reportQuantiles === true;
  const mm: MemberMonthOptions | null =
    norm?.kind === "observed_member_months"
      ? {
          // spec default is TRUE: a capitated month is one whose payments do not
          // measure care, so it takes an explicit false to keep it
          excludeCapitated: norm.excludeCapitated !== false,
          capitatedPlanTypes: DEFAULT_CAPITATED_PLAN_TYPES,
          requiresRxCoverage: spec.enrollment.requiresRxCoverage,
          rxColumn: spec.meta.database === "marketscan_medicaid" ? "drugcovg" : "rx",
        }
      : null;
  const per = norm?.kind === "observed_member_months" ? norm.per : "month";
  return {
    att: resolveAttribution(spec, an.attribution),
    inf: resolveInflation(an.inflation),
    mm,
    per,
    daysPerUnit: per === "year" ? renderDaysPerYear(spec) : renderDaysPerMonth(spec),
    wantQ,
    qdef: wantQ ? (an.quantileDefinition ?? "interpolated") : "interpolated",
  };
}

/** The per-member columns the ledger's optional flags feed, in ONE order so the
 *  four places that carry them (by_pt, per_pt, per_pt_all, stacked) cannot line
 *  them up differently. */
interface XCol {
  name: string;
  /** aggregate over encounter rows, per member per class */
  byPt: string;
  byPtSas: string;
  /** aggregate over the per-class rows, for the combined ALL row */
  all: string;
  allSas: string;
}

function extraCols(c: Consumed): XCol[] {
  const X: XCol[] = [];
  const plain = (name: string, src = name): XCol => ({
    name,
    byPt: `SUM(${src})`,
    byPtSas: `sum(${src})`,
    all: `SUM(${name})`,
    allSas: `sum(${name})`,
  });
  const flagged = (name: string, cond: string, val: string): XCol => ({
    name,
    byPt: `SUM(CASE WHEN ${cond.replace(/ and /g, " AND ")} THEN ${val} ELSE 0 END)`,
    byPtSas: `sum(case when ${cond} then ${val} else 0 end)`,
    all: `SUM(${name})`,
    allSas: `sum(${name})`,
  });
  if (c.inf) {
    X.push(plain("paid_nominal"));
    X.push(plain("n_no_index"));
  }
  if (c.att) {
    X.push(flagged("dr_enc", "dr = 1", "1"));
    X.push(flagged("dr_paid", "dr = 1", "paid"));
  }
  if (c.mm) {
    X.push(flagged("paid_elig", "elig = 1", "paid"));
    X.push(flagged("enc_excl", "elig = 0", "1"));
    if (c.att) X.push(flagged("dr_paid_elig", "dr = 1 and elig = 1", "paid"));
  }
  return X;
}

/** Human label for the dollar basis, emitted as a column so a reader of the
 *  RESULTS (not the code) can never mistake restated dollars for nominal ones. */
function costBasisLabel(inf: LedgerInflation): string {
  return `${inf.targetYear} dollars, restated by ${inf.seriesLabel}`;
}

function attributionLabel(a: LedgerAttribution): string {
  const parts = [
    a.dxPosition === "primary_only" ? "condition in the PRIMARY diagnosis slot" : "condition in ANY diagnosis slot",
    ...(a.procCodes.length > 0 ? ["a condition-specific procedure in any position"] : []),
    ...(a.drugCodeListId || a.drugNdcCodes ? ["a condition-specific drug"] : []),
  ];
  return `disease-related = ${parts.join(", or ")}`;
}

function denominatorLabel(c: Consumed): string {
  const unit = c.per === "year" ? "member-years" : "member-months";
  return (
    `eligible ${unit} from the enrollment segments` +
    (c.mm?.excludeCapitated ? `, capitated months excluded` : `, capitated months KEPT`) +
    ` (${c.daysPerUnit} days per ${c.per})`
  );
}

/* ================================================================== *
 *  SQL twin
 * ================================================================== */

function sqlResourceUse(ctx: SqlCtx, an: ResourceUseAnalysis, suffix: string): SqlModuleFile {
  const { d, wp, spec } = ctx;
  const out = `${wp}_hcru${suffix}`;
  const edPlaces = an.edPlaceOfService ?? DEFAULT_ED_PLACE_OF_SERVICE;
  const dpy = renderDaysPerYear(spec);
  const rows = settingRows(an);
  const labels = orderedSettings(an.settings).map((s) => SETTING_LABEL[s]);
  const c = consume(ctx, an);
  const X = extraCols(c);
  // The ordered-set aggregate that IS the declared definition. Never left to a
  // default: the SAS twin names PCTLDEF explicitly for exactly the same reason.
  const PCT = c.qdef === "nearest_rank" ? "PERCENTILE_DISC" : "PERCENTILE_CONT";
  const unit = c.per === "year" ? "member_years" : "member_months";
  const pppu = c.per === "year" ? "paid_per_member_year" : "paid_per_member_month";

  const L: string[] = [];
  L.push(
    `-- ${parityStamp(
      "resource_use",
      resourceUseParity(an, {
        settings: labels,
        edPlaces,
        windowDays: windowLength(an),
        daysPerYear: dpy,
        attribution: c.att,
        inflation: c.inf,
        memberMonths: c.mm,
        daysPerUnit: c.daysPerUnit,
      }),
    )}`,
  );
  const limits = resourceUseLimitations(an);
  if (limits.length > 0) {
    L.push(`-- REVIEW - spec options this program does not implement yet:`);
    for (const lim of limits) L.push(`--   * ${lim}`);
  }
  L.push(`-- REVIEW - method notes (always emitted):`);
  /* oneLine() because one of these notes now carries the analyst's own CPI
   * series label. A newline inside it would end the "--" comment and put the
   * rest of the note into the query as live SQL. (Shape-checking rejects one at
   * the boundary too; this is the emitter half of the same rule.) */
  for (const note of resourceUseMethodNotes(an)) L.push(`--   * ${oneLine(note)}`);

  L.push(d.createTableAs(out));
  L.push(
    ...ledgerSqlCtes(ctx, {
      wp,
      window: an.ascertainmentWindow,
      settings: an.settings,
      costField: an.costField,
      edPlaces,
      attribution: c.att,
      inflation: c.inf,
      memberMonths: c.mm,
    }),
  );

  L.push(`settings_list AS (`);
  labels.forEach((s, i) => {
    L.push(`  ${i === 0 ? "  " : "UNION ALL "}SELECT '${s}' AS setting`);
  });
  L.push(`),`);
  L.push(`by_pt AS (   -- encounters and payments per member per class`);
  L.push(`  SELECT enrolid, setting, COUNT(*) AS n_enc, SUM(paid) AS paid${X.length > 0 ? "," : ""}`);
  X.forEach((x, i) => L.push(`         ${x.byPt} AS ${x.name}${i < X.length - 1 ? "," : ""}`));
  L.push(`  FROM encounters_kept GROUP BY enrolid, setting`);
  L.push(`),`);
  L.push(`per_pt AS (   -- the WHOLE cohort x every class: a non-user contributes a zero,`);
  L.push(`  -- so the means below are per-member and not per-user`);
  L.push(`  SELECT sl.setting, c.enrolid,`);
  L.push(`         COALESCE(b.n_enc, 0) AS n_enc,`);
  L.push(`         COALESCE(b.paid, 0) AS paid,`);
  for (const x of X) L.push(`         COALESCE(b.${x.name}, 0) AS ${x.name},`);
  L.push(`         ob.observed_days${c.mm ? "," : ""}`);
  if (c.mm) L.push(`         mp.eligible_days`);
  L.push(`  FROM cohort c`);
  L.push(`  CROSS JOIN settings_list sl`);
  L.push(`  LEFT JOIN by_pt b ON b.enrolid = c.enrolid AND b.setting = sl.setting`);
  L.push(`  JOIN obs ob ON ob.enrolid = c.enrolid`);
  if (c.mm) L.push(`  JOIN mm_pt mp ON mp.enrolid = c.enrolid`);
  L.push(`),`);
  const stackCols = ["setting", "enrolid", "n_enc", "paid", ...X.map((x) => x.name), "observed_days", ...(c.mm ? ["eligible_days"] : [])];
  if (an.includeCombined) {
    L.push(`per_pt_all AS (   -- combined across the chosen classes, still per member`);
    L.push(`  SELECT 'ALL' AS setting, enrolid, SUM(n_enc) AS n_enc, SUM(paid) AS paid,`);
    for (const x of X) L.push(`         ${x.all} AS ${x.name},`);
    L.push(`         MAX(observed_days) AS observed_days${c.mm ? "," : ""}`);
    if (c.mm) L.push(`         MAX(eligible_days) AS eligible_days`);
    L.push(`  FROM per_pt GROUP BY enrolid`);
    L.push(`),`);
  }
  L.push(`stacked AS (`);
  L.push(`  SELECT ${stackCols.join(", ")} FROM per_pt`);
  if (an.includeCombined) {
    L.push(`  UNION ALL`);
    L.push(`  SELECT ${stackCols.join(", ")} FROM per_pt_all`);
  }
  L.push(`),`);
  L.push(`summ AS (`);
  L.push(`  SELECT setting,`);
  L.push(`         COUNT(*) AS denominator,`);
  L.push(`         SUM(CASE WHEN n_enc > 0 THEN 1 ELSE 0 END) AS users,`);
  L.push(`         SUM(n_enc) AS encounters,`);
  L.push(`         AVG(CAST(n_enc AS DOUBLE PRECISION)) AS enc_mean,`);
  L.push(`         STDDEV_SAMP(CAST(n_enc AS DOUBLE PRECISION)) AS enc_sd,`);
  // The DECLARED quantile definition, spelled out. See the module header.
  L.push(`         ${PCT}(0.5) WITHIN GROUP (ORDER BY CAST(n_enc AS DOUBLE PRECISION)) AS enc_median,`);
  L.push(`         MAX(n_enc) AS enc_max,`);
  L.push(`         SUM(paid) AS paid_total,`);
  L.push(`         AVG(CAST(paid AS DOUBLE PRECISION)) AS paid_mean,`);
  L.push(`         STDDEV_SAMP(CAST(paid AS DOUBLE PRECISION)) AS paid_sd,`);
  L.push(`         ${PCT}(0.5) WITHIN GROUP (ORDER BY CAST(paid AS DOUBLE PRECISION)) AS paid_median,`);
  if (c.wantQ) {
    L.push(`         ${PCT}(0.25) WITHIN GROUP (ORDER BY CAST(paid AS DOUBLE PRECISION)) AS paid_q1,`);
    L.push(`         ${PCT}(0.75) WITHIN GROUP (ORDER BY CAST(paid AS DOUBLE PRECISION)) AS paid_q3,`);
  }
  L.push(`         MAX(paid) AS paid_max,`);
  if (c.inf) {
    L.push(`         SUM(paid_nominal) AS paid_total_nominal,`);
    L.push(`         SUM(n_no_index) AS enc_not_restated,`);
  }
  if (c.att) {
    L.push(`         SUM(CASE WHEN dr_enc > 0 THEN 1 ELSE 0 END) AS dr_users,`);
    L.push(`         SUM(dr_enc) AS dr_encounters,`);
    L.push(`         SUM(dr_paid) AS dr_paid_total,`);
    L.push(`         AVG(CAST(dr_paid AS DOUBLE PRECISION)) AS dr_paid_mean,`);
  }
  if (c.mm) {
    L.push(`         SUM(eligible_days) AS eligible_days,`);
    L.push(`         SUM(paid_elig) AS paid_elig,`);
    L.push(`         SUM(enc_excl) AS enc_excluded_months,`);
    if (c.att) L.push(`         SUM(dr_paid_elig) AS dr_paid_elig,`);
  }
  L.push(`         SUM(observed_days) AS observed_days`);
  L.push(`  FROM stacked GROUP BY setting`);
  L.push(`)`);
  L.push(`SELECT '${MEASURE}' AS measure, s.setting,`);
  L.push(`       s.users, s.denominator,`);
  L.push(`       ${d.roundN(`s.users * 100.0 / NULLIF(s.denominator, 0)`, 2)} AS users_pct,`);
  L.push(`       s.encounters,`);
  L.push(`       ${d.roundN(`s.enc_mean`, 5)} AS enc_per_patient,`);
  L.push(`       ${d.roundN(`s.enc_sd`, 5)} AS enc_sd,`);
  L.push(`       ${d.roundN(`s.enc_median`, 5)} AS enc_median,`);
  L.push(`       s.enc_max,`);
  L.push(`       s.observed_days,`);
  L.push(`       ${d.roundN(`s.encounters * ${dpy} / NULLIF(s.observed_days, 0)`, 5)} AS enc_per_person_year,`);
  L.push(`       ${d.roundN(`s.paid_total`, 2)} AS paid_total,`);
  L.push(`       ${d.roundN(`s.paid_mean`, 2)} AS paid_per_patient,`);
  L.push(`       ${d.roundN(`s.paid_sd`, 2)} AS paid_sd,`);
  L.push(`       ${d.roundN(`s.paid_median`, 2)} AS paid_median,`);
  if (c.wantQ) {
    L.push(`       ${d.roundN(`s.paid_q1`, 2)} AS paid_q1,`);
    L.push(`       ${d.roundN(`s.paid_q3`, 2)} AS paid_q3,`);
    L.push(`       ${d.roundN(`s.paid_q3 - s.paid_q1`, 2)} AS paid_iqr,`);
    L.push(`       '${c.qdef}' AS quantile_definition,`);
  }
  L.push(`       ${d.roundN(`s.paid_max`, 2)} AS paid_max,`);
  L.push(`       ${d.roundN(`s.paid_total * ${dpy} / NULLIF(s.observed_days, 0)`, 2)} AS paid_per_person_year,`);
  if (c.inf) {
    /* Nominal and restated side by side: their difference is the size of the
     * correction, and a reader who cannot see it cannot judge it. */
    L.push(`       ${d.roundN(`s.paid_total_nominal`, 2)} AS paid_total_nominal,`);
    L.push(`       s.enc_not_restated,`);
    L.push(`       '${costBasisLabel(c.inf).replace(/'/g, "''")}' AS cost_basis,`);
  }
  if (c.att) {
    L.push(`       s.dr_users, s.dr_encounters,`);
    L.push(`       ${d.roundN(`s.dr_paid_total`, 2)} AS dr_paid_total,`);
    L.push(`       ${d.roundN(`s.dr_paid_mean`, 2)} AS dr_paid_per_patient,`);
    L.push(`       ${d.roundN(`s.dr_paid_total * 100.0 / NULLIF(s.paid_total, 0)`, 2)} AS dr_paid_share_pct,`);
    L.push(`       '${c.att.dxPosition}' AS dx_position,`);
    L.push(`       '${attributionLabel(c.att).replace(/'/g, "''")}' AS attribution_rule,`);
  }
  if (c.mm) {
    L.push(`       s.eligible_days,`);
    L.push(`       ${d.roundN(`s.eligible_days / ${c.daysPerUnit}`, 5)} AS ${unit},`);
    L.push(`       ${d.roundN(`s.paid_elig`, 2)} AS paid_in_eligible_months,`);
    L.push(`       s.enc_excluded_months,`);
    L.push(`       ${d.roundN(`s.paid_elig * ${c.daysPerUnit} / NULLIF(s.eligible_days, 0)`, 2)} AS ${pppu},`);
    if (c.att)
      L.push(`       ${d.roundN(`s.dr_paid_elig * ${c.daysPerUnit} / NULLIF(s.eligible_days, 0)`, 2)} AS dr_${pppu},`);
    L.push(`       '${denominatorLabel(c).replace(/'/g, "''")}' AS denominator_basis,`);
  }
  L.push(`       '${an.costField}' AS cost_field,`);
  L.push(`       ord.setting_ord`);
  L.push(`FROM summ s`);
  L.push(`JOIN (`);
  rows.forEach((s, i) => {
    L.push(`  ${i === 0 ? "  " : "UNION ALL "}SELECT '${s}' AS setting, ${i} AS setting_ord`);
  });
  L.push(`) ord ON ord.setting = s.setting`);
  L.push(`ORDER BY ord.setting_ord;`);
  L.push("");
  L.push(`-- REVIEW: resource use and cost per member over the window, by care setting.`);
  L.push(`SELECT * FROM ${out}`);
  L.push(`ORDER BY setting_ord;`);

  const { start, end } = windowDays(an.ascertainmentWindow);
  return {
    slug: `hcru${suffix}`,
    title: `Resource use and cost${suffix ? ` (${an.label})` : ""}`,
    subtitle: "encounter counts and payments per member, by care setting",
    extra: [
      `Analysis: ${oneLine(an.label)} (id ${an.id}); payment column ${an.costField}.`,
      `Window: day ${start} to day ${end} relative to index, inclusive (${windowLength(an) ?? "?"} days).`,
      `Settings: ${labels.join(", ")}${an.includeCombined ? " (+ combined ALL row)" : ""}.`,
      ...(c.att ? [`Attribution: ${attributionLabel(c.att)}; all-cause reported beside it.`] : []),
      ...(c.mm ? [`Denominator: ${denominatorLabel(c)}.`] : []),
      ...(c.inf ? [`Dollars: ${costBasisLabel(c.inf)}.`] : []),
      ...(c.wantQ ? [`Quantiles: ${c.qdef} (${PCT} here, PCTLDEF=${c.qdef === "nearest_rank" ? 3 : 5} in the SAS twin).`] : []),
    ],
    body: L.join("\n"),
  };
}

/* ================================================================== *
 *  SAS twin
 * ================================================================== */

function sasResourceUse(ctx: SasCtx, an: ResourceUseAnalysis, num: string, suffix: string): GeneratedFile {
  const { spec } = ctx;
  const outT = ctx.tbl(`${num}_hcru${suffix}`);
  const cohT = ctx.finalCohort;
  const epiT = ctx.tbl("050_epi");
  const edPlaces = an.edPlaceOfService ?? DEFAULT_ED_PLACE_OF_SERVICE;
  const dpy = renderDaysPerYear(spec);
  const rows = settingRows(an);
  const labels = orderedSettings(an.settings).map((s) => SETTING_LABEL[s]);
  const limits = resourceUseLimitations(an);
  const label = an.label.replace(/"/g, "'");
  const { start, end } = windowDays(an.ascertainmentWindow);
  const c = consume(ctx, an);
  const X = extraCols(c);
  const PCTLDEF = c.qdef === "nearest_rank" ? 3 : 5;
  const unit = c.per === "year" ? "member_years" : "member_months";
  const pppu = c.per === "year" ? "paid_per_member_year" : "paid_per_member_month";

  const ledger = ledgerSasSteps(ctx, {
    wp: "",
    num,
    cohT,
    epiT,
    enrT: ctx.tbl("040_enroll"),
    window: an.ascertainmentWindow,
    settings: an.settings,
    costField: an.costField,
    edPlaces,
    attribution: c.att,
    inflation: c.inf,
    memberMonths: c.mm,
  });

  const lines: string[] = [
    ...header(spec, `${num}_hcru${suffix}.sas`, [
      `Resource use and cost for "${an.label}": encounter counts and payments`,
      `per member over day ${start} to day ${end} relative to index, by care`,
      `setting, from the shared claim-line ledger.`,
      `Inpatient stays take the ADMISSION total and drop their own service`,
      `lines - summing both is the classic double count.`,
      `Twin of the SQL hcru program (SQL twin is execution-verified; this SAS twin is parity-checked, not executed). Keep both in sync.`,
    ]),
    `/* ${parityStamp(
      "resource_use",
      resourceUseParity(an, {
        settings: labels,
        edPlaces,
        windowDays: windowLength(an),
        daysPerYear: dpy,
        attribution: c.att,
        inflation: c.inf,
        memberMonths: c.mm,
        daysPerUnit: c.daysPerUnit,
      }),
    )} */`,
    ``,
  ];
  if (limits.length > 0) {
    lines.push(`/* REVIEW - spec options this program does not implement yet:`, ...limits.map((l) => `   * ${cmt(l)}`), `*/`);
  }
  lines.push(
    `/* REVIEW - method notes (always emitted):`,
    ...resourceUseMethodNotes(an).map((n) => `   * ${cmt(n)}`),
    `*/`,
    ``,
    ...INCLUDE_SETUP,
    `proc datasets lib=tz nolist nowarn;`,
    `  delete ${outT.replace("tz.", "")};`,
    `quit;`,
    ``,
    ...ledger.lines,
    `/*-------------------- per-member x class grid (zeros included) --------------*/`,
    `data work._${num}_settings;`,
    `  length setting $3;`,
    ...labels.map((s) => `  setting = "${s}"; output;`),
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_perpt as`,
    `  select s.setting, a.enrolid,`,
    `         coalesce(b.n_enc, 0) as n_enc,`,
    `         coalesce(b.paid, 0)  as paid,`,
    ...X.map((x) => `         coalesce(b.${x.name}, 0) as ${x.name},`),
    `         o.observed_days${c.mm ? "," : ""}`,
    ...(c.mm ? [`         mp.eligible_days`] : []),
    `  from ${cohT} as a`,
    `  cross join work._${num}_settings as s`,
    `  left join (select enrolid, setting, count(*) as n_enc, sum(paid) as paid${X.length > 0 ? "," : ""}`,
    ...X.map((x, i) => `                    ${x.byPtSas} as ${x.name}${i < X.length - 1 ? "," : ""}`),
    `             from ${ledger.encounters} group by enrolid, setting) as b`,
    `    on  b.enrolid = a.enrolid`,
    `    and b.setting = s.setting`,
    ...(c.mm
      ? [
          `  inner join ${ledger.obs} as o`,
          `    on o.enrolid = a.enrolid`,
          `  inner join ${ledger.memberMonths} as mp`,
          `    on mp.enrolid = a.enrolid;`,
        ]
      : [`  inner join ${ledger.obs} as o`, `    on o.enrolid = a.enrolid;`]),
    `quit;`,
    ``,
    ...levelCheck(`work._${num}_perpt`, "member x class rows"),
    ``,
  );
  if (an.includeCombined) {
    lines.push(
      `/* combined across the chosen classes, still per member */`,
      `proc sql;`,
      `  create table work._${num}_all as`,
      `  select 'ALL' as setting length=3, enrolid,`,
      `         sum(n_enc) as n_enc, sum(paid) as paid,`,
      ...X.map((x) => `         ${x.allSas} as ${x.name},`),
      `         max(observed_days) as observed_days${c.mm ? "," : ""}`,
      ...(c.mm ? [`         max(eligible_days) as eligible_days`] : []),
      `  from work._${num}_perpt group by enrolid;`,
      `quit;`,
      ``,
      `data work._${num}_stack;`,
      `  set work._${num}_perpt work._${num}_all;`,
      `run;`,
      ``,
    );
  } else {
    lines.push(`data work._${num}_stack; set work._${num}_perpt; run;`, ``);
  }
  lines.push(
    `proc sort data=work._${num}_stack; by setting; run;`,
    ``,
    `/*----------------------------------------------------------------------------`,
    ...(c.wantQ
      ? c.qdef === "nearest_rank"
        ? [
            `  PCTLDEF=3 is stated EXPLICITLY rather than left to the site default: it`,
            `  is the DECLARED nearest-rank definition, and it is the same estimator as`,
            `  the SQL twin's PERCENTILE_DISC at EVERY probability - both return the`,
            `  smallest observed value whose cumulative share reaches p. So the median,`,
            `  Q1 and Q3 agree exactly across the twins, and each is a dollar amount`,
            `  somebody was actually billed.`,
          ]
        : [
            `  PCTLDEF=5 is stated EXPLICITLY rather than left to the site default: it`,
            `  is the DECLARED interpolated definition, matching the SQL twin's`,
            `  PERCENTILE_CONT. At p = 0.5 the two agree for every n (n even -> both`,
            `  average the two central order statistics; n odd -> both take the central`,
            `  one). AT Q1 AND Q3 THEY AGREE ONLY WHEN n*p IS NOT A WHOLE NUMBER: where`,
            `  it is, PCTLDEF=5 averages the two neighbouring order statistics while`,
            `  PERCENTILE_CONT interpolates at 1+(n-1)p. The gap is bounded by the`,
            `  distance between those neighbours; quantileDefinition "nearest_rank" is`,
            `  the pairing with no gap at all.`,
          ]
      : [
          `  PCTLDEF=5 is stated EXPLICITLY rather than left to the site default.`,
          `  At p = 0.5 it agrees with the SQL twin's PERCENTILE_CONT for every n: with`,
          `  n even both return the average of the two central order statistics, with n`,
          `  odd both return the central one. That equality is why a median is emitted`,
          `  at all - away from 0.5 the two estimators genuinely differ, which is why no`,
          `  quartile is emitted by either twin.`,
        ]),
    `----------------------------------------------------------------------------*/`,
    `proc univariate data=work._${num}_stack pctldef=${PCTLDEF} noprint;`,
    `  by setting;`,
    `  var n_enc paid;`,
    `  output out=work._${num}_stats`,
    `    sum    = encounters paid_total`,
    `    mean   = enc_mean   paid_mean`,
    `    std    = enc_sd     paid_sd`,
    `    median = enc_median paid_median`,
    ...(c.wantQ ? [`    q1     = enc_q1     paid_q1`, `    q3     = enc_q3     paid_q3`] : []),
    `    max    = enc_max    paid_max;`,
    `run;`,
    ``,
    `proc sql;`,
    `  create table work._${num}_extra as`,
    `  select setting,`,
    `         count(*) as denominator,`,
    `         sum(case when n_enc > 0 then 1 else 0 end) as users,`,
    ...(c.inf
      ? [`         sum(paid_nominal) as paid_total_nominal,`, `         sum(n_no_index) as enc_not_restated,`]
      : []),
    ...(c.att
      ? [
          `         sum(case when dr_enc > 0 then 1 else 0 end) as dr_users,`,
          `         sum(dr_enc) as dr_encounters,`,
          `         sum(dr_paid) as dr_paid_total,`,
          `         mean(dr_paid) as dr_paid_mean,`,
        ]
      : []),
    ...(c.mm
      ? [
          `         sum(eligible_days) as eligible_days,`,
          `         sum(paid_elig) as paid_elig,`,
          `         sum(enc_excl) as enc_excluded_months,`,
          ...(c.att ? [`         sum(dr_paid_elig) as dr_paid_elig,`] : []),
        ]
      : []),
    `         sum(observed_days) as observed_days`,
    `  from work._${num}_stack group by setting;`,
    `quit;`,
    ``,
    `data ${outT};`,
    `  merge work._${num}_stats work._${num}_extra;`,
    `  by setting;`,
    `  length measure $20 cost_field $8${c.att ? ` dx_position $16 attribution_rule $200` : ""}${c.inf ? ` cost_basis $200` : ""}${c.mm ? ` denominator_basis $200` : ""}${c.wantQ ? ` quantile_definition $16` : ""};`,
    `  measure    = "${MEASURE}";`,
    `  cost_field = "${an.costField}";`,
    `  if encounters = . then encounters = 0;`,
    `  if paid_total = . then paid_total = 0;`,
    `  if denominator > 0 then users_pct = round(100 * users / denominator, 0.01);`,
    `  enc_per_patient = round(enc_mean, 0.00001);`,
    `  enc_sd          = round(enc_sd, 0.00001);`,
    `  enc_median      = round(enc_median, 0.00001);`,
    `  paid_per_patient = round(paid_mean, 0.01);`,
    `  paid_sd          = round(paid_sd, 0.01);`,
    `  paid_median      = round(paid_median, 0.01);`,
    `  paid_max         = round(paid_max, 0.01);`,
    `  paid_total       = round(paid_total, 0.01);`,
    ...(c.wantQ
      ? [
          `  /* IQR from the UNROUNDED quartiles, so it cannot disagree with them by a`,
          `     rounding step the SQL twin does not take */`,
          `  paid_iqr = round(paid_q3 - paid_q1, 0.01);`,
          `  paid_q1  = round(paid_q1, 0.01);`,
          `  paid_q3  = round(paid_q3, 0.01);`,
          `  quantile_definition = "${c.qdef}";`,
        ]
      : []),
    ...(c.inf
      ? [
          `  if paid_total_nominal = . then paid_total_nominal = 0;`,
          `  paid_total_nominal = round(paid_total_nominal, 0.01);`,
          `  if enc_not_restated = . then enc_not_restated = 0;`,
          `  cost_basis = "${costBasisLabel(c.inf).replace(/"/g, "'")}";`,
        ]
      : []),
    ...(c.att
      ? [
          `  if dr_encounters = . then dr_encounters = 0;`,
          `  if dr_paid_total = . then dr_paid_total = 0;`,
          `  dr_paid_total     = round(dr_paid_total, 0.01);`,
          `  dr_paid_per_patient = round(dr_paid_mean, 0.01);`,
          `  if paid_total > 0 then dr_paid_share_pct = round(100 * dr_paid_total / paid_total, 0.01);`,
          `  dx_position      = "${c.att.dxPosition}";`,
          `  attribution_rule = "${attributionLabel(c.att).replace(/"/g, "'")}";`,
        ]
      : []),
    ...(c.mm
      ? [
          `  /* the DECLARED denominator: eligible member-time, not the window */`,
          `  ${unit} = round(eligible_days / ${c.daysPerUnit}, 0.00001);`,
          `  paid_in_eligible_months = round(paid_elig, 0.01);`,
          `  if enc_excluded_months = . then enc_excluded_months = 0;`,
          `  if eligible_days > 0 then do;`,
          `    ${pppu} = round(paid_elig * ${c.daysPerUnit} / eligible_days, 0.01);`,
          ...(c.att ? [`    dr_${pppu} = round(dr_paid_elig * ${c.daysPerUnit} / eligible_days, 0.01);`] : []),
          `  end;`,
          `  denominator_basis = "${denominatorLabel(c).replace(/"/g, "'")}";`,
        ]
      : []),
    `  /* same person-time constant the incidence twins use, from 00_setup */`,
    `  if observed_days > 0 then do;`,
    `    enc_per_person_year  = round(encounters * ${dpy} / observed_days, 0.00001);`,
    `    paid_per_person_year = round(paid_total * ${dpy} / observed_days, 0.01);`,
    `  end;`,
    ...rows.map((s, i) => `  ${i === 0 ? "if" : "else if"} setting = "${s}" then setting_ord = ${i};`),
    `  drop enc_mean paid_mean${c.wantQ ? " enc_q1 enc_q3" : ""}${c.att ? " dr_paid_mean" : ""}${c.mm ? " paid_elig" + (c.att ? " dr_paid_elig" : "") : ""};`,
    `run;`,
    ``,
    `/* same presentation order as the SQL twin's REVIEW query */`,
    `proc sort data=${outT};`,
    `  by setting_ord;`,
    `run;`,
    ``,
    `title "Resource use and cost: ${label}";`,
    `proc print data=${outT} noobs;`,
    `  var measure setting users denominator users_pct encounters enc_per_patient`,
    `      enc_sd enc_median enc_max observed_days enc_per_person_year`,
    `      paid_total paid_per_patient paid_sd paid_median` +
      `${c.wantQ ? " paid_q1 paid_q3 paid_iqr quantile_definition" : ""} paid_max`,
    `      paid_per_person_year` +
      `${c.inf ? " paid_total_nominal enc_not_restated cost_basis" : ""}` +
      `${c.att ? " dr_users dr_encounters dr_paid_total dr_paid_per_patient dr_paid_share_pct dx_position" : ""}` +
      `${c.mm ? ` eligible_days ${unit} paid_in_eligible_months enc_excluded_months ${pppu}${c.att ? ` dr_${pppu}` : ""}` : ""}` +
      ` cost_field;`,
    `run;`,
    ``,
  );

  return {
    path: `sas/${num}_hcru${suffix}.sas`,
    language: "sas",
    title: `${num} Resource use and cost${suffix ? ` (${an.label})` : ""}`,
    content: lines.join("\n"),
  };
}

/** Result columns this analysis adds beyond the static suppression shape.
 *
 *  The shape is per STAMP KIND and cannot know which optional columns a given
 *  analysis emitted, so a wide table would carry its disease-related counts
 *  straight through the SAS `set` into the released data set — a leak, not a
 *  drop. Declared here, applied by the suppression pass. */
function resourceUseSuppression(an: ResourceUseAnalysis): { maskCols: string[]; keepCols: string[] } {
  const maskCols: string[] = [];
  const keepCols: string[] = [];
  const per = an.normalization?.kind === "observed_member_months" ? an.normalization.per : "month";
  const pppu = per === "year" ? "paid_per_member_year" : "paid_per_member_month";
  if (an.reportQuantiles) {
    maskCols.push("paid_q1", "paid_q3", "paid_iqr");
    keepCols.push("quantile_definition");
  }
  if (an.inflation) {
    maskCols.push("paid_total_nominal", "enc_not_restated");
    keepCols.push("cost_basis");
  }
  if (an.attribution?.kind === "disease_related") {
    maskCols.push("dr_users", "dr_encounters", "dr_paid_total", "dr_paid_per_patient", "dr_paid_share_pct");
    keepCols.push("dx_position", "attribution_rule");
  }
  if (an.normalization?.kind === "observed_member_months") {
    maskCols.push("paid_in_eligible_months", "enc_excluded_months", pppu);
    if (an.attribution?.kind === "disease_related") maskCols.push(`dr_${pppu}`);
    // eligible days and member-months are properties of ENROLLMENT, not of who
    // used care — the same reason observed_days stays visible in the shape.
    keepCols.push("eligible_days", per === "year" ? "member_years" : "member_months", "denominator_basis");
  }
  return { maskCols, keepCols };
}

export const resourceUseModule: AnalysisModule<ResourceUseAnalysis> = {
  analysisKind: "resource_use",
  stampKind: "resource_use",
  resultSlug: "hcru",
  sql: sqlResourceUse,
  sas: sasResourceUse,
  suppressionExtras: resourceUseSuppression as (an: never) => { maskCols: string[]; keepCols: string[] },
};
