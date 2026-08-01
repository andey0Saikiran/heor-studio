/**
 * Gold Case H — THE ECONOMICS LAYER: attribution, the PPPM denominator, the CPI
 * restatement, and the quantile definition, on one cohort of six.
 *
 * Six patients, one 720-day window, and every claim chosen so that each of the
 * four options moves a number that can be checked by hand. Every expected value
 * below was derived BEFORE the module ran and is written as an exact fraction.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONSTANT. spec.meta.daysPerYear = 360, so a member-month is exactly 30
 * days and a member-year exactly 360. That is not the study default (365.25,
 * which gives 30.4375) and it is not hiding from it: verify/run.ts re-emits this
 * same spec at the default and asserts the denominator moves to 3420/30.4375 =
 * 112.36139 member-months, so the constant is demonstrably read rather than
 * baked in. Pinning 360 here is what makes 114 member-months, $200 PPPM and
 * every figure below an exact integer, which is the whole point of a gold case.
 *
 * WINDOW. day 1 .. day 720 relative to index (index date EXCLUDED), i.e.
 * 2020-01-02 .. 2021-12-21. Index is 2020-01-01 for all six, so the index fills
 * sit OUTSIDE the window: a window that silently started at day 0 would pull six
 * $100 fills into the RX row and every total below would fail at once.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ENROLLMENT — where the two denominators part company.
 *
 *   P1-P4   2019-01-01 .. 2021-12-31, plan type 6 (PPO)
 *   P5      2019-01-01 .. 2020-06-29, plan type 6
 *           2020-06-30 .. 2021-12-31, plan type 4 (HMO — CAPITATED)
 *   P6      2019-01-01 .. 2020-12-26, plan type 6      (coverage ENDS mid-window)
 *
 *   observed days (stitched episodes ∩ window, what the fixed-window path uses)
 *     P1-P5 720 each, P6 360                                 → 3960 days
 *   ELIGIBLE days (enrollment segments, capitated months dropped, ∩ window)
 *     P1-P4 720 each = 2880
 *     P5    2020-01-02 .. 2020-06-29 = 180        (day 2..181 of 2020)
 *     P6    2020-01-02 .. 2020-12-26 = 360        (day 2..361 of 2020)
 *                                                            → 3420 days
 *   member-months = 3420 / 30 = 114 EXACTLY.
 *
 * The fixed window says 6 members x 24 months = 144 member-months. The truth is
 * 114. That 21% gap is the entire reason CostNormalization exists, and it is
 * driven by two different mechanisms at once — P6 left, P5 went capitated —
 * so a fix for one of them cannot accidentally satisfy the check for the other.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CLAIMS. CPI: 2019 = 100, 2020 = 105, 2021 = 110.25; target year 2021, so the
 * factors are 1.1025 / 1.05 / 1.00 exactly.
 *
 *   #  member  date        setting  nominal  factor  restated  disease-related?
 *   1  P2      2020-03-15  OP        1,000   1.05     1,050    YES  dx1 = E119 (primary)
 *   2  P6      2020-05-20  OP        1,000   1.05     1,050    no   E119 in dx2 ONLY
 *   3  P3      2020-07-10  OP        2,000   1.05     2,100    YES  proc 96413, NO dx at all
 *   4  P5      2020-02-14  RX        2,000   1.05     2,100    YES  condition drug
 *   5  P4      2021-04-01  IP       15,000   1.00    15,000    YES  pdx = E119
 *   6  P4      2021-06-15  OP        1,500   1.00     1,500    no   dx1 = Z000
 *   7  P5      2021-03-10  OP           0    1.00         0    no   IN A CAPITATED MONTH
 *
 *   P4's stay also carries two service lines (3,000 + 4,000) under the same
 *   CASEID. They are DROPPED: the admission record already contains them. A
 *   double-counting ledger reports 22,000 for IP instead of 15,000.
 *
 *   P1 has no claims at all — the zero that keeps the means per-MEMBER.
 *
 * WHY EACH CLAIM IS HERE.
 *
 *   #2 is the attribution control. The condition sits in a SECONDARY slot, so
 *   `primary_only` must NOT count it and `any_position` must. verify/run.ts
 *   re-emits with the position flipped and asserts the disease-related total
 *   rises by exactly 1,050 — the one number that separates the two rules.
 *
 *   #3 is the infusion line: a procedure claim carrying NO diagnosis whatsoever.
 *   Under a diagnosis-only rule it is invisible, and 2,100 of genuinely
 *   condition-driven cost silently leaves the disease-related column.
 *
 *   #4 is the drug arm: a pharmacy claim has no diagnosis field at all, so
 *   without a drug list every drug dollar falls outside the disease-related
 *   answer — on a specialty-drug study, most of it.
 *
 *   #7 is the capitation case, and it pays ZERO. That is not a convenience: it
 *   is what capitation looks like in claims. The care happened, the plan paid
 *   the provider a per-member fee, and the claim records nothing. Months like
 *   that cannot sit in a PPPM denominator (real dollars divided by months in
 *   which cost was structurally invisible) and their claims cannot sit in its
 *   numerator. Both sides are checked: eligible days drop to 3420 AND the
 *   encounter is counted as excluded rather than quietly kept.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PER-PATIENT RESTATED TOTALS, sorted: 0, 1050, 1050, 2100, 2100, 16500.
 *   total = 22,800 restated from 22,500 nominal (the CPI is worth +300)
 *   mean  = 22,800 / 6 = 3,800
 *   sd    = sqrt(196,635,000 / 5) = sqrt(39,327,000) = 6,271.12
 *
 * QUANTILES, n = 6. This shape is chosen, not incidental:
 *
 *   Q1  p=.25: n*p = 1.5 (not whole) → PCTLDEF=5 takes x(2) = 1050;
 *              PERCENTILE_CONT interpolates at 1+5(.25) = 2.25 → 1050 + .25(x3-x2),
 *              and x2 = x3 = 1050, so it takes 1050 too. THE TWINS AGREE.
 *   Q3  p=.75: n*p = 4.5 → PCTLDEF=5 takes x(5) = 2100; PERCENTILE_CONT
 *              interpolates at 4.75 → 2100 + .75(x5-x4), and x4 = x5 = 2100.
 *              THE TWINS AGREE.
 *   MED p=.5 : n*p = 3 (WHOLE) → both interpolated forms average x(3) and x(4):
 *              (1050 + 2100)/2 = 1575. PERCENTILE_DISC / PCTLDEF=3 take x(3)
 *              itself = 1050. THE DEFINITIONS DISAGREE, by 525.
 *
 * The ties at x2=x3 and x4=x5 are deliberate. For an even n, PCTLDEF=5 and
 * PERCENTILE_CONT are provably equal at Q1 and Q3 ONLY where the neighbouring
 * order statistics coincide; anywhere else the SQL twin would compute a quartile
 * the SAS twin cannot reproduce, and no test in this repo could see it because
 * no SAS runs. So the fixture pins the one arrangement where BOTH declared
 * definitions are exactly twin-reproducible AND the two definitions still
 * disagree — on the median, which is the figure every cost table prints.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BY SETTING (restated), with the disease-related column beside it:
 *
 *   setting  enc  users  all-cause  nominal  disease-related  dr enc  dr users
 *   ALL       7     5      22,800    22,500       20,250         4        4
 *   IP        1     1      15,000    15,000       15,000         1        1
 *   ED        0     0           0         0            0         0        0
 *   OP        5     5       5,700     5,500        3,150         2        2
 *   RX        1     1       2,100     2,000        2,100         1        1
 *
 *   disease-related share of all-cause = 20,250 / 22,800 = 88.82%
 *   encounters per member = 7/6 = 1.16667, sd = sqrt(17/30) = 0.75277
 *   encounter median = 1 under BOTH definitions (counts 0,1,1,1,2,2: n*p = 3,
 *   x(3) = x(4) = 1), so the encounter row is deliberately definition-blind —
 *   only the cost row moves when the definition changes.
 *
 * THE HEADLINE NUMBERS:
 *
 *   PPPM (all-cause)        = 22,800 x 30 / 3,420 = $200.00 EXACTLY
 *   PPPM (disease-related)  = 20,250 x 30 / 3,420 = 3375/19 = $177.63
 *   the same figure computed on the fixed window = 3,800 / 24 = $158.33
 *   per person-year on observed days = 22,800 x 360 / 3,960 = 22800/11 = $2,072.73
 *   the true per-member-year          = 200 x 12                       = $2,400.00
 *
 * The window-based figure understates by 21%, and it understates for exactly the
 * members whose coverage ended or went capitated — which is the failure the type
 * documentation describes and the reason this module stopped dividing by the
 * calendar.
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_INDEX = "00000000001";
const NDC_COND = "00000000009";
/** the condition, ICD-10-CM, dot-free as it appears on claims */
const DX_COND = "E119";
/** a diagnosis that is NOT the condition */
const DX_NEUTRAL = "Z000";
/** chemotherapy administration — the infusion line that carries no diagnosis */
const PX_COND = "96413";
const POS_OFFICE = "11";

/** [enrolid, dtstart, dtend, plantyp] — one row per coverage segment. */
const H_ENROLL: Array<[number, string, string, string]> = [
  [1, "2019-01-01", "2021-12-31", "6"],
  [2, "2019-01-01", "2021-12-31", "6"],
  [3, "2019-01-01", "2021-12-31", "6"],
  [4, "2019-01-01", "2021-12-31", "6"],
  /* P5 goes CAPITATED mid-window. The segments are adjacent (no lapse), so the
   * stitcher makes them one episode and the fixed-window denominator sees 720
   * days — while the eligible denominator sees 180. */
  [5, "2019-01-01", "2020-06-29", "6"],
  [5, "2020-06-30", "2021-12-31", "4"],
  /* P6 simply stops being covered inside the window. */
  [6, "2019-01-01", "2020-12-26", "6"],
];

export function fixtureHSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  const ids = [1, 2, 3, 4, 5, 6];

  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ` +
      H_ENROLL.map(([id, s, e, plan]) => `(${id}, DATE '${s}', DATE '${e}', '1', '1', 1970, 50, '1', '1', '${plan}', '1')`).join(",\n  ") +
      `;`,
  );

  /* Pharmacy: the index fill for everyone on the index date (OUTSIDE the
   * window), plus P5's condition-drug fill inside it. */
  const fills = [
    ...ids.map((id) => `(${id}, DATE '2020-01-01', '${NDC_INDEX}', 30, 30, 100)`),
    `(5, DATE '2020-02-14', '${NDC_COND}', 30, 30, 2000)`,
  ].join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${fills};`);

  /* Outpatient. Columns: enrolid, svcdate, dxver, dx1..dx4, proc1, proctyp,
   * stdplac, paytot. dxver '0' = the ICD-10-CM era. */
  const op = [
    // #1 condition in the PRIMARY (first-listed) slot
    `(2, DATE '2020-03-15', '0', '${DX_COND}', NULL, NULL, NULL, NULL, NULL, '${POS_OFFICE}', 1000)`,
    // #2 condition in a SECONDARY slot ONLY — the attribution control
    `(6, DATE '2020-05-20', '0', '${DX_NEUTRAL}', '${DX_COND}', NULL, NULL, NULL, NULL, '${POS_OFFICE}', 1000)`,
    // #3 infusion administration: a procedure and NO diagnosis anywhere
    `(3, DATE '2020-07-10', '0', NULL, NULL, NULL, NULL, '${PX_COND}', 'CPT', '${POS_OFFICE}', 2000)`,
    // #6 all-cause only
    `(4, DATE '2021-06-15', '0', '${DX_NEUTRAL}', NULL, NULL, NULL, NULL, NULL, '${POS_OFFICE}', 1500)`,
    // #7 a visit inside P5's CAPITATED period, paying nothing — as capitation does
    `(5, DATE '2021-03-10', '0', '${DX_NEUTRAL}', NULL, NULL, NULL, NULL, NULL, '${POS_OFFICE}', 0)`,
  ].join(",\n  ");
  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac,paytot) VALUES\n  ${op};`,
  );

  /* #5 the admission record, carrying the stay's TOTAL payment. */
  lines.push(
    `INSERT INTO ccaei_all (enrolid,admdate,disdate,dxver,pdx,dx1,caseid,los,paytot) VALUES\n  ` +
      `(4, DATE '2021-04-01', DATE '2021-04-05', '0', '${DX_COND}', NULL, 900, 4, 15000);`,
  );
  /* ...and its own service lines, which the ledger must DROP. */
  lines.push(
    `INSERT INTO ccaes_all (enrolid,admdate,svcdate,dxver,pdx,caseid,paytot) VALUES\n  ` +
      `(4, DATE '2021-04-01', DATE '2021-04-01', '0', '${DX_COND}', 900, 3000),\n  ` +
      `(4, DATE '2021-04-01', DATE '2021-04-03', '0', '${DX_COND}', 900, 4000);`,
  );

  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ` +
      `('${NDC_INDEX}','DRUG_X','BRAND_X'), ('${NDC_COND}','DRUG_C','BRAND_C');`,
  );
  return lines.join("\n");
}

export const GOLD_H_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_H" };

/** The CPI vintage, as the analyst supplies it. Values chosen so the factors are
 *  exact terminating decimals: 110.25/105 = 1.05, 110.25/100 = 1.1025. */
export const H_CPI: Record<number, number> = { 2019: 100, 2020: 105, 2021: 110.25 };
export const H_CPI_SERIES = "CPI-U medical care, U.S. city average, annual average";

export const GOLD_H_SPEC: StudySpec = {
  meta: {
    title: "Gold Case H — cost attribution, PPPM, CPI restatement and quantiles",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2019-01-01", end: "2021-12-31" },
    /* 360 so a member-month is exactly 30 days — see the header. run.ts proves
     * the constant is read, not baked, by re-emitting at the 365.25 default. */
    daysPerYear: 360,
    provenance: { method: "manual" },
  },
  codeLists: [
    {
      id: "index_drug", label: "Index drug (X)", system: "drug_name",
      codes: [{ code: "DRUG_X", source: "user_entered", verified: true }],
    },
    {
      id: "cond_dx", label: "Condition diagnoses", system: "icd10cm",
      codes: [{ code: "E11.9", source: "user_entered", verified: true }],
    },
    {
      id: "cond_px", label: "Condition-specific procedures (infusion administration)", system: "cpt_hcpcs",
      codes: [{ code: PX_COND, source: "user_entered", verified: true }],
    },
    {
      id: "cond_rx", label: "Condition-specific drug", system: "drug_name",
      codes: [{ code: "DRUG_C", source: "user_entered", verified: true }],
    },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "index_drug", indexPeriod: { start: "2020-01-01", end: "2020-12-31" } },
  enrollment: { baselineDays: 365, followupDays: 180, gapAllowanceDays: 31, requiresRxCoverage: true },
  criteria: [
    {
      id: "c_cont", kind: "inclusion", sourceText: "Continuous enrollment 365d pre / 180d post index",
      test: { type: "continuous_enrollment", baselineDays: 365, followupDays: 180, requiresRxCoverage: true },
      confidence: "high", reviewed: true,
    },
  ],
  baseline: [{ id: "b_age", label: "Age at index", kind: "age", dataType: "continuous" }],
  outcomes: [],
  groupVars: [],
  comparisons: [],
  analyses: [
    { id: "h_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "h_hcru",
      label: "Cost and resource use over 720 days, all-cause and disease-related",
      kind: "resource_use",
      enabled: true,
      ascertainmentWindow: { start: 1, end: 720, includesIndex: false },
      settings: ["inpatient", "ed", "outpatient", "pharmacy"],
      costField: "paytot",
      includeCombined: true,
      attribution: {
        kind: "disease_related",
        dxPosition: "primary_only",
        codeListId: "cond_dx",
        procedureCodeListId: "cond_px",
        drugCodeListId: "cond_rx",
      },
      normalization: { kind: "observed_member_months", per: "month", excludeCapitated: true },
      inflation: { targetYear: 2021, indexByYear: H_CPI, seriesLabel: H_CPI_SERIES },
      reportQuantiles: true,
      quantileDefinition: "interpolated",
    },
  ],
};

export const EXPECTED_H = {
  cohortN: 6,
  windowDays: 720,
  /** stitched-episode days inside the window, summed — the FIXED-WINDOW path */
  observedDays: 3960,
  /** enrollment-segment days, capitated months dropped — the PPPM path */
  eligibleDays: 3420,
  memberMonths: 114,
  /** 6 members x 24 months, the figure a window-based "PPPM" would divide by */
  fixedWindowMemberMonths: 144,
  /** eligible days when excludeCapitated is turned OFF (P5 keeps all 720) */
  eligibleDaysNoCapExclusion: 3960,
  memberMonthsNoCapExclusion: 132,
  /** member-months at the study default 365.25 (3420 / 30.4375) */
  memberMonthsAtDefaultYear: 112.36139,
  pppmAtDefaultYear: 202.92,

  /** per patient, restated to 2021 dollars */
  paidByPatient: { 1: 0, 2: 1050, 3: 2100, 4: 16500, 5: 2100, 6: 1050 } as Record<number, number>,

  bySetting: {
    ALL: { users: 5, encounters: 7, paid: 22800, nominal: 22500, drUsers: 4, drEnc: 4, drPaid: 20250 },
    IP: { users: 1, encounters: 1, paid: 15000, nominal: 15000, drUsers: 1, drEnc: 1, drPaid: 15000 },
    ED: { users: 0, encounters: 0, paid: 0, nominal: 0, drUsers: 0, drEnc: 0, drPaid: 0 },
    OP: { users: 5, encounters: 5, paid: 5700, nominal: 5500, drUsers: 2, drEnc: 2, drPaid: 3150 },
    RX: { users: 1, encounters: 1, paid: 2100, nominal: 2000, drUsers: 1, drEnc: 1, drPaid: 2100 },
  } as Record<string, { users: number; encounters: number; paid: number; nominal: number; drUsers: number; drEnc: number; drPaid: number }>,

  /** what a ledger that summed the admission total WITH its own lines would say */
  ipDoubleCountWouldBe: 22000,

  /** ALL row, restated */
  paidMean: 3800,
  paidSd: 6271.12,
  encMean: 1.16667,
  encSd: 0.75277,
  encMedian: 1,
  encMax: 2,

  /** the quantile block, ALL row */
  quantiles: {
    q1: 1050,
    /** (x(3) + x(4)) / 2 under the declared "interpolated" definition */
    medianInterpolated: 1575,
    /** x(3) under "nearest_rank" — the SAME six patients */
    medianNearestRank: 1050,
    q3: 2100,
    iqr: 1050,
  },

  /** the disease-related column, ALL row */
  drSharePct: 88.82,
  /** flipping dxPosition to any_position adds P6's secondary-slot claim */
  drPaidAnyPosition: 21300,
  drPaidDelta: 1050,

  /** PPPM */
  pppm: 200,
  drPppm: 177.63,
  /** the same cost divided by the DECLARED window instead: 3800 / 24 months */
  naivePppm: 158.33,
  /** the existing fixed-window annualization, on stitched-episode days */
  paidPerPersonYear: 2072.73,
  /** what 12 x the true PPPM says instead */
  truePerMemberYear: 2400,
  pppmNoCapExclusion: 172.73,

  /** exactly one encounter falls in a month the denominator excludes */
  encountersInExcludedMonths: 1,
  /** every claim year has a CPI index, so nothing is silently unrestated */
  encountersNotRestated: 0,
} as const;
