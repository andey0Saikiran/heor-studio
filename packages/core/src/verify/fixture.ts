/**
 * Synthetic MarketScan-shaped verification fixture — 12 patients with
 * DELIBERATELY PLANTED, hand-computable ground truth. Seeded into PGlite under
 * the emitter's {yearly_sas, prefix:"ccae"} naming so the EMITTED Postgres SQL
 * runs against it verbatim. No real patient data — every value is invented so
 * the expected numbers can be checked by hand (see EXPECTED below).
 *
 * Ground truth (all hand-derived, see docs/COVERAGE-MATRIX.md verification):
 *   attrition: indexed 12 -> continuous-enrollment 11 (drop P11) -> age>=18 10 (drop P12)
 *   arms: DRUG_X {P01-P05}, DRUG_Y {P06-P10}
 *   prevalent-in-baseline M = 2 (P01, P06); baseline prevalence 2/10 = 0.200
 *   incidence denominator (at-risk) = 8; incident cases K = 3 (P02,P03,P07)
 *   person-time at risk = 100+200+300 + 5*365 = 2425 person-days
 *   crude incidence rate = 3*365*1000/2425 = 451.55 per 1000 PY
 *   Byar 95% CI = (90.76, 1319.66) per 1000 PY
 *   cumulative incidence 3/8 = 0.375, Wilson 95% CI = (0.13684, 0.69426)
 *   SMD(age, X vs Y) = (50-55)/sqrt((62.5+62.5)/2) = -0.63246
 */
import type { StudySpec, EmitOptions } from "../index";

/* ---------------- raw-table DDL (superset of emitter-referenced columns) ---------------- *
 *  Flag columns (dxver/rx/sex/region/plantyp) are VARCHAR because the emitter
 *  compares them as text ('0','1','2'); dates are true DATE. Extra columns are
 *  harmless — PGlite ignores columns the SQL does not touch; the danger is a
 *  MISSING column, so we err generous. */
const DDL = `
DROP TABLE IF EXISTS ccaet_all;
CREATE TABLE ccaet_all (
  enrolid BIGINT, dtstart DATE, dtend DATE, rx VARCHAR, drugcovg VARCHAR,
  dobyr INT, age INT, sex VARCHAR, region VARCHAR, plantyp VARCHAR, egeoloc VARCHAR
);
DROP TABLE IF EXISTS ccaeo_all;
CREATE TABLE ccaeo_all (
  enrolid BIGINT, svcdate DATE, dxver VARCHAR,
  dx1 VARCHAR, dx2 VARCHAR, dx3 VARCHAR, dx4 VARCHAR,
  proc1 VARCHAR, proctyp VARCHAR, stdplac VARCHAR,
  paytot NUMERIC, netpay NUMERIC, copay NUMERIC, deduct NUMERIC, coins NUMERIC
);
DROP TABLE IF EXISTS ccaes_all;
CREATE TABLE ccaes_all (
  enrolid BIGINT, admdate DATE, svcdate DATE, dxver VARCHAR, pdx VARCHAR,
  dx1 VARCHAR, dx2 VARCHAR, dx3 VARCHAR, dx4 VARCHAR,
  pproc VARCHAR, proc1 VARCHAR, proctyp VARCHAR,
  caseid BIGINT, paytot NUMERIC, netpay NUMERIC
);
DROP TABLE IF EXISTS ccaei_all;
CREATE TABLE ccaei_all (
  enrolid BIGINT, admdate DATE, disdate DATE, dxver VARCHAR, pdx VARCHAR,
  dx1 VARCHAR, dx2 VARCHAR, dx3 VARCHAR, dx4 VARCHAR, dx5 VARCHAR, dx6 VARCHAR,
  dx7 VARCHAR, dx8 VARCHAR, dx9 VARCHAR, dx10 VARCHAR, dx11 VARCHAR, dx12 VARCHAR,
  dx13 VARCHAR, dx14 VARCHAR, dx15 VARCHAR, pproc VARCHAR, proc1 VARCHAR,
  caseid BIGINT, los INT, paytot NUMERIC, netpay NUMERIC
);
DROP TABLE IF EXISTS ccaed_all;
CREATE TABLE ccaed_all (
  enrolid BIGINT, svcdate DATE, ndcnum VARCHAR, daysupp INT, qty NUMERIC,
  paytot NUMERIC, netpay NUMERIC, copay NUMERIC, deduct NUMERIC, coins NUMERIC
);
DROP TABLE IF EXISTS redbook;
CREATE TABLE redbook ( ndcnum VARCHAR, gennme VARCHAR, prodnme VARCHAR );
`;

/* one enrollment span per row (P07/P11 have two spans to test stitching). */
const NDC_X = "00000000001";
const NDC_Y = "00000000002";

// [enrolid, dtstart, dtend, dobyr, sex, region, plantyp]
const ENROLL: Array<[number, string, string, number, string, string, string]> = [
  [1, "2018-01-01", "2020-06-30", 1979, "1", "1", "6"], // P01 X age40
  [2, "2018-01-01", "2020-06-30", 1974, "2", "1", "6"], // P02 X age45
  [3, "2018-01-01", "2020-06-30", 1969, "1", "2", "6"], // P03 X age50
  [4, "2018-01-01", "2020-06-30", 1964, "2", "2", "6"], // P04 X age55
  [5, "2018-01-01", "2020-06-30", 1959, "1", "3", "6"], // P05 X age60
  [6, "2018-01-01", "2020-06-30", 1974, "1", "3", "7"], // P06 Y age45
  [7, "2018-01-01", "2019-06-10", 1969, "2", "4", "7"], // P07 Y age50 span1
  [7, "2019-06-30", "2020-06-30", 1969, "2", "4", "7"], // P07 span2 (gap 20d <=31 -> stitches)
  [8, "2018-01-01", "2020-06-30", 1964, "1", "4", "7"], // P08 Y age55
  [9, "2018-01-01", "2020-06-30", 1959, "2", "1", "7"], // P09 Y age60
  [10, "2018-01-01", "2020-06-30", 1954, "1", "2", "7"], // P10 Y age65
  [11, "2018-01-01", "2019-05-01", 1970, "2", "2", "6"], // P11 X age49 span1
  [11, "2019-07-01", "2020-06-30", 1970, "2", "2", "6"], // P11 span2 (gap 61d >31 -> FAILS CE)
  [12, "2018-01-01", "2020-06-30", 2009, "1", "3", "7"], // P12 Y age10 (fails age>=18)
  /* P13 — NESTED-SEGMENT stitching case (regression test for the LAG defect).
   * Deliberately has NO index drug claim, so it never enters the cohort and
   * cannot disturb any pinned gold number; it exercises the stitching step
   * alone, asserted directly against tz_study_enroll_episodes.
   *
   * Ordered by dtstart: A(2018-01-01..2019-03-31), B(2018-02-01..2018-02-10,
   * nested inside A), C(2019-04-15..2020-06-30).
   *   C starts 15 days after A ends  -> within the 31-day allowance
   *   C starts 429 days after B ends -> outside it
   * Comparing against only the PREVIOUS row's end (LAG) sees B and wrongly
   * opens a second episode; comparing against the running MAX of all prior
   * ends sees A and correctly continues one episode. The SAS twin already
   * used the running-max form, so this was also a silent SAS/SQL divergence. */
  [13, "2018-01-01", "2019-03-31", 1980, "2", "1", "6"], // P13 span A (long)
  [13, "2018-02-01", "2018-02-10", 1980, "2", "1", "6"], // P13 span B (nested in A)
  [13, "2019-04-15", "2020-06-30", 1980, "2", "1", "6"], // P13 span C (15d after A)
  [14, "2018-01-01", "2020-06-30", 1975, "1", "2", "6"], // P14 multi-day inpatient stay (no index claim)
];

// index drug claim (one per patient, all 2019-01-01). enrolid -> NDC (arm)
const DRUG: Array<[number, string]> = [
  [1, NDC_X], [2, NDC_X], [3, NDC_X], [4, NDC_X], [5, NDC_X], [11, NDC_X],
  [6, NDC_Y], [7, NDC_Y], [8, NDC_Y], [9, NDC_Y], [10, NDC_Y], [12, NDC_Y],
];

// AE outpatient dx (E11.9 -> 'E119', DXVER '0'). Baseline (P01,P06) vs follow-up (P02,P03,P07).
const AE: Array<[number, string]> = [
  [1, "2018-06-01"], // P01 baseline -> PREVALENT
  [6, "2018-09-01"], // P06 baseline -> PREVALENT
  [2, "2019-04-11"], // P02 index+100 -> INCIDENT
  [3, "2019-07-20"], // P03 index+200 -> INCIDENT
  [7, "2019-10-28"], // P07 index+300 -> INCIDENT
];

// NEGATIVE CONTROL for the outcome care-setting filter: P05 gets an INPATIENT
// AE (index+59). The gold analysis (setting "outpatient") MUST exclude it —
// gold numbers stay 3/2425. A setting:"any" clone MUST include it (P05 becomes
// a case censored at day 59): 4 cases / 2119 pd — see EXPECTED.settingAny.
// A broken (unapplied) filter now fails the harness instead of passing silently.
const AE_IP: Array<[number, string]> = [[5, "2019-03-01"]];

/* P14 — MULTI-DAY INPATIENT STAY, the double-counting regression case.
 * One clinical stay: admitted 2019-05-01, the qualifying diagnosis recorded on
 * a service line dated 2019-05-04, and the same diagnosis on the admission
 * record dated at admission. Reading service lines at SVCDATE and admission
 * records at ADMDATE yields TWO event rows with different dates for ONE stay —
 * DISTINCT cannot collapse them, so claim counts inflate and a `minClaims >= 2`
 * rule can be satisfied by a single admission.
 * P14 has NO index drug claim, so it never enters the cohort and cannot move a
 * pinned gold number; it is asserted directly against the events table. */
const IP_STAY_ADMIT = "2019-05-01";
const IP_STAY_SERVICE = "2019-05-04";
/** CASEID linking P14's admission record to its service line (see the ledger). */
const IP_STAY_CASEID = 14001;

/* ---------------- resource-use / cost claims (ledger fixtures) ----------------
 *
 * Every row below is DELIBERATELY NEUTRAL to the existing gold numbers: the
 * diagnoses are 'Z0000' (not in the ae_dx list, which is E11.9 only) and the
 * extra drug fill uses an NDC absent from `redbook`, so it can never resolve to
 * DRUG_X/DRUG_Y and cannot become anyone's index event. Nothing in the spine or
 * the six existing analyses reads a raw claim count or a payment column.
 *
 * That is an argument, not a proof — the proof is that every pinned number in
 * EXPECTED must still verify after these rows land, which the harness re-checks
 * on every run.
 *
 * Costs are chosen so the totals are hand-computable AND so the classic
 * MarketScan inpatient double-count is FALSIFIABLE: P04's stay carries a
 * $10,000 admission total plus $3,000 + $4,000 of service lines for the SAME
 * stay. A ledger that sums both reports $17,000. The correct answer is $10,000,
 * and the harness pins it.
 */
const NEUTRAL_DX = "Z0000";
const NDC_OTHER = "99999999999"; // deliberately absent from `redbook`
const PLACE_OFFICE = "11";
const PLACE_ED = "23";

/** extra OUTPATIENT claims: [enrolid, date, stdplac, paytot] */
const HCRU_OP: Array<[number, string, string, number]> = [
  [2, "2019-05-01", PLACE_OFFICE, 200], // P02 -> 3 OP visits in the window
  [2, "2019-05-15", PLACE_OFFICE, 200],
  [8, "2019-06-10", PLACE_ED, 1500],    // P08 -> the only ED visit
];

/* Baseline COMORBIDITY claims, all dated inside the 365-day pre-index lookback
 * and therefore OUTSIDE the resource-use window (which starts at index), so
 * they move no utilization or cost number either.
 *
 * Diagnosis matching is exact membership (`dx in (&list.)`), not prefix, so
 * E10.0 / E10.2 cannot collide with the outcome list's E11.9.
 *
 * P03 carries diabetes BOTH with and without complications, and P05 carries
 * liver disease BOTH mild and severe — the two supersession rules, planted so
 * the hierarchy is exercised in both directions rather than assumed. */
const CCI_DX: Array<[number, string]> = [
  [1, "I500"], // CHF                             -> 1
  [2, "E100"], // diabetes, uncomplicated         -> 1
  [3, "E100"], // P03: uncomplicated ...
  [3, "E102"], //      ... AND complicated        -> 2, NOT 3
  [4, "K703"], // mild liver                      -> 1
  [5, "K703"], // P05: mild ...
  [5, "K721"], //      ... AND severe             -> 3, NOT 4
  [6, "I500"], // P06: CHF ...
  [6, "E102"], //      ... AND complicated DM     -> 3
];
const CCI_DATE = "2018-06-15";

/** extra PHARMACY fill: P03 gets a second, non-index fill. */
const HCRU_RX: Array<[number, string, number]> = [[3, "2019-02-01", 100]];

/** P04's inpatient stay: ONE admission, three payment-bearing rows.
 *  caseid 4001 links the admission record to both service lines. */
const P04_CASEID = 4001;
const P04_ADMIT = "2019-08-01";
const P04_DISCH = "2019-08-05";

function q(v: string | number): string {
  return typeof v === "number" ? String(v) : `'${v}'`;
}

/** Full seed SQL: DDL + inserts. Run once per PGlite instance before the emitted SQL. */
export function fixtureSeedSql(): string {
  const lines: string[] = [DDL];

  const enrollVals = ENROLL.map(
    ([id, s, e, dob, sex, reg, plan]) =>
      `(${id}, DATE '${s}', DATE '${e}', '1', '1', ${dob}, ${2019 - dob}, '${sex}', '${reg}', '${plan}', '1')`,
  ).join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enrollVals};`,
  );

  const drugVals = [
    ...DRUG.map(([id, ndc]) => `(${id}, DATE '2019-01-01', '${ndc}', 30, 30, 100)`),
    ...HCRU_RX.map(([id, dt, pay]) => `(${id}, DATE '${dt}', '${NDC_OTHER}', 30, 30, ${pay})`),
  ].join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${drugVals};`);

  const opVals = [
    ...AE.map(([id, d]) => `(${id}, DATE '${d}', '0', 'E119', NULL, NULL, NULL, NULL, NULL, '${PLACE_OFFICE}', 200)`),
    ...HCRU_OP.map(([id, d, place, pay]) => `(${id}, DATE '${d}', '0', '${NEUTRAL_DX}', NULL, NULL, NULL, NULL, NULL, '${place}', ${pay})`),
    ...CCI_DX.map(([id, dx]) => `(${id}, DATE '${CCI_DATE}', '0', '${dx}', NULL, NULL, NULL, NULL, NULL, '${PLACE_OFFICE}', 200)`),
  ].join(",\n  ");
  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac,paytot) VALUES\n  ${opVals};`,
  );

  /* Inpatient SERVICE lines. P05's carries NO caseid — an orphan line with no
   * admission record, which the ledger must still count as one stay rather than
   * drop. P14's and P04's DO link to admission records, so the ledger must drop
   * them in favour of the admission-level total (else the cost double counts). */
  const sVals = [
    ...AE_IP.map(([id, d]) => `(${id}, DATE '${d}', DATE '${d}', '0', 'E119', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 5000)`),
    `(14, DATE '${IP_STAY_ADMIT}', DATE '${IP_STAY_SERVICE}', '0', 'E119', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${IP_STAY_CASEID}, 2000)`,
    `(4, DATE '${P04_ADMIT}', DATE '${P04_ADMIT}', '0', '${NEUTRAL_DX}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${P04_CASEID}, 3000)`,
    `(4, DATE '${P04_ADMIT}', DATE '2019-08-03', '0', '${NEUTRAL_DX}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${P04_CASEID}, 4000)`,
  ].join(",\n  ");
  lines.push(
    `INSERT INTO ccaes_all (enrolid,admdate,svcdate,dxver,pdx,dx1,dx2,dx3,dx4,pproc,proc1,proctyp,caseid,paytot) VALUES\n  ${sVals};`,
  );

  // Admission records. P14's is the SAME stay and diagnosis as its service line;
  // P04's carries a NEUTRAL diagnosis so it cannot disturb any outcome count.
  const nulls15 = Array(15).fill("NULL").join(", ");
  lines.push(
    `INSERT INTO ccaei_all (enrolid,admdate,disdate,dxver,pdx,dx1,dx2,dx3,dx4,dx5,dx6,dx7,dx8,dx9,dx10,dx11,dx12,dx13,dx14,dx15,pproc,proc1,caseid,paytot) VALUES\n` +
      `  (14, DATE '${IP_STAY_ADMIT}', DATE '2019-05-06', '0', 'E119', ${nulls15}, NULL, NULL, ${IP_STAY_CASEID}, 8000),\n` +
      `  (4, DATE '${P04_ADMIT}', DATE '${P04_DISCH}', '0', '${NEUTRAL_DX}', ${nulls15}, NULL, NULL, ${P04_CASEID}, 10000);`,
  );

  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ('${NDC_X}','DRUG_X','BRAND_X'),('${NDC_Y}','DRUG_Y','BRAND_Y');`,
  );
  void q; // (kept for future typed inserts)
  return lines.join("\n");
}

/* ---------------- hand-computed expected values (the ground truth) ---------------- */

export const EXPECTED = {
  // spine
  indexed: 12,
  continuouslyEnrolled: 11, // drop P11 (gap 61d > 31)
  finalCohortN: 10, // drop P12 (age 10)
  armX: [1, 2, 3, 4, 5],
  armY: [6, 7, 8, 9, 10],
  // descriptive epi — VERIFIED in PGlite against the emitted incidence SQL
  // (see verify/proto_incidence.ts). Person-time constant = 365.25 everywhere
  // (internally consistent: rate = cases*1000/person_years). NOTE for the owner:
  // a common AE-rate convention §4 uses 365 for the AE rate specifically — switching to 365
  // gives rate 451.55 and CI (90.76, 1319.66); it is a single repo-wide constant.
  prevalentM: 2,
  baselinePrevalence: 0.2,
  atRiskDenominator: 8,
  incidentCases: 3,
  personDays: 2425,
  personDaysByArm: { X: 1030, Y: 1395 },
  personYears: 6.6393, // 2425 / 365.25
  crudeRatePer1000PY: 451.86, // 3 * 1000 * 365.25 / 2425
  byarCiPer1000PY: [90.82, 1320.24] as [number, number], // z=1.96, 365.25 scaling
  // NOTE: the legacy scalars cumulativeIncidence (0.375) and wilsonCi
  // ([0.13684, 0.69426]) are now the live gold in EXPECTED.cumulativeIncidence
  // (the module block below) — asserted against the executed cumulative-incidence SQL.
  smdAge: -0.63246, // reserved for the statistical-engine module (X vs Y age SMD)
  /* stratified incidence — per-patient hand derivation (at-risk 8, index 2019-01-01,
   * admin censor 2020-01-01 for all): P02 F45 case@100d, P03 M50 case@200d,
   * P04 F55 365d, P05 M60 365d, P07 F50 case@300d, P08 M55 365d, P09 F60 365d,
   * P10 M65 365d. Rates/CIs = closed-form Byar evaluated on those hand counts. */
  incidenceStrata: {
    Sex: {
      Male:   { cases: 1, denominator: 4, personDays: 1295, rate: 282.05, ci: [3.69, 1569.27] },
      Female: { cases: 2, denominator: 4, personDays: 1130, rate: 646.46, ci: [72.6, 2334.04] },
    },
    "Age band": {
      "45-54": { cases: 3, denominator: 3, personDays: 600,  rate: 1826.25, ci: [367.05, 5335.99] },
      "55-64": { cases: 0, denominator: 4, personDays: 1460, rate: 0,       ci: [0, 917.65] },
      "65+":   { cases: 0, denominator: 1, personDays: 365,  rate: 0,       ci: [0, 3670.61] },
    },
    "Index year": {
      "2019": { cases: 3, denominator: 8, personDays: 2425, rate: 451.86, ci: [90.82, 1320.24] },
    },
  } as Record<string, Record<string, { cases: number; denominator: number; personDays: number; rate: number; ci: [number, number] }>>,
  incidenceRowCount: 7, // 1 Overall + 2 sex + 3 age bands + 1 year
  /* setting:"any" clone of the gold incidence analysis — picks up P05's
   * INPATIENT AE at index+59 (negative-control row): P05 censors at day 59
   * instead of 365, so person-days = 2425 - 365 + 59 = 2119. */
  settingAny: {
    cases: 4,
    personDays: 2119,
    personYears: 5.8015,
    rate: 689.48, // 4 * 1000 * 365.25 / 2119
    ci: [185.49, 1765.21] as [number, number],
  },
  /* Small-cell suppression (BR-DEL-004), threshold 3, on the gold incidence
   * table. Hand-derived from the rows above:
   *   Overall        n=3 d=8 -> both >= 3, VISIBLE
   *   Index year/2019 n=3 d=8 -> VISIBLE
   *   Sex/Male        n=1     -> primary (count < 3)
   *   Sex/Female      n=2     -> primary (count < 3)      [group already has 2 masked]
   *   Age/65+         n=0 d=1 -> primary (DENOMINATOR < 3; a zero count is not
   *                              itself disclosive, but "0 of 1" identifies the member)
   *   Age/55-64       n=0 d=4 -> survives
   *   Age/45-54       n=3 d=3 -> survives on its own, but its group has exactly ONE
   *                              masked cell, so it is masked COMPLEMENTARILY — it is
   *                              the smallest NON-ZERO survivor (masking the zero
   *                              55-64 instead would leave 65+ recoverable). */
  suppressionThreshold3: {
    visible: [
      ["Overall", "Overall"],
      ["Index year", "2019"],
      ["Age band", "55-64"],
    ] as Array<[string, string]>,
    masked: [
      ["Sex", "Male"],
      ["Sex", "Female"],
      ["Age band", "65+"],
      ["Age band", "45-54"],
    ] as Array<[string, string]>,
  },
  /* Point prevalence — Wilson score CI (z=1.96), hand-derived on the frozen
   * fixture. setting "outpatient" is APPLIED, so P05's inpatient AE is excluded
   * (the numerator uses only the 5 outpatient E119 events). */
  pointPrevalence: {
    // a_pp_main: fixed anchor 2019-07-20. Denominator = 10 (whole cohort enrolled).
    // Cases on-or-before D: P01,P02,P03,P06 (P03's event lands exactly ON D);
    // P07's event 2019-10-28 is after D. k=4/n=10.
    main: {
      rowCount: 8, // Overall + Male/Female + 4 age bands (0-17,18-34 empty→absent) + Anchor year 2019
      overall: { patients: 4, denominator: 10, prevalence: 0.4, pct: 40, ci: [0.16818, 0.68733] as [number, number] },
      strata: {
        Sex: {
          Male:   { patients: 3, denominator: 6, prevalence: 0.5,  pct: 50, ci: [0.18761, 0.81239] as [number, number] },
          Female: { patients: 1, denominator: 4, prevalence: 0.25, pct: 25, ci: [0.04559, 0.69936] as [number, number] },
        },
        "Age band": {
          "35-44": { patients: 1, denominator: 1, prevalence: 1,    pct: 100, ci: [0.20654, 1] as [number, number] },
          "45-54": { patients: 3, denominator: 4, prevalence: 0.75, pct: 75,  ci: [0.30064, 0.95441] as [number, number] },
          "55-64": { patients: 0, denominator: 4, prevalence: 0,    pct: 0,   ci: [0, 0.4899] as [number, number] },
          "65+":   { patients: 0, denominator: 1, prevalence: 0,    pct: 0,   ci: [0, 0.79346] as [number, number] },
        },
        "Anchor year": {
          "2019": { patients: 4, denominator: 10, prevalence: 0.4, pct: 40, ci: [0.16818, 0.68733] as [number, number] },
        },
      } as Record<string, Record<string, { patients: number; denominator: number; prevalence: number; pct: number; ci: [number, number] }>>,
    },
    // a_pp_idx: anchor = each subject's index (2019-01-01). Cases before index:
    // P01,P06 only → k=2/n=10, reproducing baselinePrevalence=0.2 independently.
    idx: { patients: 2, denominator: 10, prevalence: 0.2, pct: 20, ci: [0.05668, 0.50984] as [number, number] },
    // a_pp_eos: anchor 2020-12-31 is after every episode end (2020-06-30) →
    // denominator 0; prevalence + both CI bounds NULL.
    eos: { patients: 0, denominator: 0 },
  },
  /* Period prevalence — Wilson score CI. Denominator = cohort members whose
   * stitched episode overlaps the period; numerator = a qualifying OUTPATIENT
   * event DATED inside the period (no carry-in). */
  periodPrevalence: {
    // a_perp_2019: 2019 full year. All 10 enrolled. Events dated in 2019
    // (outpatient): P02,P03,P07 → k=3/n=10. P01/P06 (2018 events) are
    // denominator-only, pinning the NO-carry-in rule.
    p2019: {
      rowCount: 7, // Overall + Male/Female + 4 age bands (35-44,45-54,55-64,65+)
      overall: { patients: 3, denominator: 10, prevalence: 0.3, pct: 30, ci: [0.10779, 0.60323] as [number, number] },
      strata: {
        Sex: {
          Male:   { patients: 1, denominator: 6, prevalence: 0.16667, pct: 16.67, ci: [0.03005, 0.56351] as [number, number] },
          Female: { patients: 2, denominator: 4, prevalence: 0.5,     pct: 50,    ci: [0.15004, 0.84996] as [number, number] },
        },
        "Age band": {
          "35-44": { patients: 0, denominator: 1, prevalence: 0,    pct: 0,  ci: [0, 0.79346] as [number, number] },
          "45-54": { patients: 3, denominator: 4, prevalence: 0.75, pct: 75, ci: [0.30064, 0.95441] as [number, number] },
          "55-64": { patients: 0, denominator: 4, prevalence: 0,    pct: 0,  ci: [0, 0.4899] as [number, number] },
          "65+":   { patients: 0, denominator: 1, prevalence: 0,    pct: 0,  ci: [0, 0.79346] as [number, number] },
        },
      } as Record<string, Record<string, { patients: number; denominator: number; prevalence: number; pct: number; ci: [number, number] }>>,
    },
    // a_perp_empty: 2021 is after every episode end → denominator 0, NULLs.
    empty: { patients: 0, denominator: 0 },
  },
  /* Cumulative incidence (risk) — naive at-risk denominator (event-free at
   * index after washout = 8), Wilson CI. Numerator = first OUTPATIENT event
   * within the horizon. */
  cumulativeIncidence: {
    // a_ci_365: horizon 365d. Cases in (index, index+365]: P02(100),P03(200),
    // P07(300) → 3/8 = 0.375, reproducing EXPECTED.wilsonCi from this module.
    ci365: {
      rowCount: 3, // Overall + Male + Female
      overall: { patients: 3, denominator: 8, risk: 0.375, pct: 37.5, ci: [0.13684, 0.69426] as [number, number] },
      strata: {
        Sex: {
          Male:   { patients: 1, denominator: 4, risk: 0.25, pct: 25, ci: [0.04559, 0.69936] as [number, number] },
          Female: { patients: 2, denominator: 4, risk: 0.5,  pct: 50, ci: [0.15004, 0.84996] as [number, number] },
        },
      } as Record<string, Record<string, { patients: number; denominator: number; risk: number; pct: number; ci: [number, number] }>>,
    },
    // a_ci_180: horizon 180d. Only P02's day-100 event is within 180d
    // (P03 day-200, P07 day-300 excluded) → 1/8 = 0.125.
    ci180: { patients: 1, denominator: 8, risk: 0.125, pct: 12.5, ci: [0.02242, 0.47089] as [number, number] },
  },
  /* Calendar trend — per-calendar-year prevalence + the Cochran-Armitage test.
   *
   * Denominator, per year: every cohort member's stitched episode is
   * 2018-01-01..2020-06-30 (P07's two spans stitch across a 20-day gap), which
   * overlaps all three study years, so n = 10 in each.
   * Numerator: OUTPATIENT E119 events dated inside the year —
   *   2018: P01 (06-01), P06 (09-01)                    -> 2
   *   2019: P02 (04-11), P03 (07-20), P07 (10-28)       -> 3
   *         (P05's 2019-03-01 event is INPATIENT, so the setting filter drops it)
   *   2020: none                                        -> 0
   *
   * Cochran-Armitage with scores w = 0,1,2 (the bucket ordinals):
   *   R = 5, N = 30, pbar = 1/6
   *   sum(w*r)   = 0*2 + 1*3 + 2*0 = 3
   *   sum(w*n)   = 0  + 10  + 20   = 30
   *   sum(w^2*n) = 0  + 10  + 40   = 50
   *   T   = 3 - (1/6)(30) = -2
   *   Var = (1/6)(5/6)(50 - 30^2/30) = (5/36)(20) = 25/9
   *   z   = -2 / (5/3) = -1.2   EXACTLY
   * The two-sided p (2*(1-Phi(1.2)) = 0.2301) is SAS-primary: NULL in SQL. */
  calendarTrend: {
    rowCount: 4, // 2018 + 2019 + 2020 + the Trend row
    buckets: {
      "2018": { patients: 2, denominator: 10, prevalence: 0.2, pct: 20, ci: [0.05668, 0.50984] as [number, number] },
      "2019": { patients: 3, denominator: 10, prevalence: 0.3, pct: 30, ci: [0.10779, 0.60323] as [number, number] },
      "2020": { patients: 0, denominator: 10, prevalence: 0,   pct: 0,  ci: [0, 0.27754] as [number, number] },
    } as Record<string, { patients: number; denominator: number; prevalence: number; pct: number; ci: [number, number] }>,
    // person-BUCKET sums on the Trend row, not distinct patients
    trend: { patients: 5, denominator: 30, prevalence: 0.16667, z: -1.2, method: "cochran_armitage" },
  },
  /* Resource use and cost over day 0..364 (365 observed days x 10 members =
   * 3650), hand-derived claim by claim BEFORE the module was executed.
   *
   * Encounters per member:
   *   RX  P03 = 2 (index fill + a second, non-index NDC), everyone else 1  -> 11
   *   OP  P02 = 3 (its AE claim + two neutral visits), P03 = 1, P07 = 1    ->  5
   *   ED  P08 = 1 (place of service 23)                                   ->  1
   *   IP  P04 = 1 (one stay), P05 = 1 (orphan service line, no admission)  ->  2
   *   ALL                                                                 -> 19
   *
   * THE DOUBLE COUNT. P04's stay is $10,000 at the admission record with
   * $3,000 + $4,000 of service lines beneath it. P05's orphan line is $5,000.
   * The correct inpatient total is 10,000 + 5,000 = 15,000. A ledger that sums
   * admission totals together with their own service lines reports 22,000 —
   * which is why that number is written down here as the failure to detect.
   *
   * The cost distribution is deliberately right-skewed: mean 1,860 against a
   * median of 350, so any module that reported only one of them would be
   * visibly reporting the wrong thing. */
  resourceUse: {
    rowCount: 5, // ALL + IP + ED + OP + RX
    observedDaysTotal: 3650,
    // the number a double-counting ledger would produce for IP paid_total
    ipDoubleCountWouldBe: 22000,
    bySetting: {
      ALL: { users: 10, encounters: 19, encMean: 1.9,  encSd: 0.99443, encMedian: 2, encMax: 4, paidTotal: 18600, paidMean: 1860, paidSd: 3278.96, paidMedian: 350, paidMax: 10100 },
      IP:  { users: 2,  encounters: 2,  encMean: 0.2,  encSd: 0.42164, encMedian: 0, encMax: 1, paidTotal: 15000, paidMean: 1500, paidSd: 3374.74, paidMedian: 0,   paidMax: 10000 },
      ED:  { users: 1,  encounters: 1,  encMean: 0.1,  encSd: 0.31623, encMedian: 0, encMax: 1, paidTotal: 1500,  paidMean: 150,  paidSd: 474.34,  paidMedian: 0,   paidMax: 1500 },
      OP:  { users: 3,  encounters: 5,  encMean: 0.5,  encSd: 0.97183, encMedian: 0, encMax: 3, paidTotal: 1000,  paidMean: 100,  paidSd: 194.37,  paidMedian: 0,   paidMax: 600 },
      RX:  { users: 10, encounters: 11, encMean: 1.1,  encSd: 0.31623, encMedian: 1, encMax: 2, paidTotal: 1100,  paidMean: 110,  paidSd: 31.62,   paidMedian: 100, paidMax: 200 },
    } as Record<string, { users: number; encounters: number; encMean: number; encSd: number; encMedian: number; encMax: number; paidTotal: number; paidMean: number; paidSd: number; paidMedian: number; paidMax: number }>,
  },
  /* Weighted comorbidity index, hand-derived per patient.
   *
   *   P01  CHF                        -> 1
   *   P02  DM uncomplicated           -> 1
   *   P03  DM uncomplicated + DM comp -> 2   (uncomplicated withheld, NOT 1+2=3)
   *   P04  mild liver                 -> 1
   *   P05  mild + severe liver        -> 3   (mild withheld, NOT 1+3=4)
   *   P06  CHF + DM complicated       -> 3
   *   P07-P10                         -> 0
   *
   * scores 1,1,2,1,3,3,0,0,0,0 -> sum 11, mean 1.1
   *   sorted 0,0,0,0,1,1,1,2,3,3 -> median = (1+1)/2 = 1, max 3
   *   sample variance = 12.90/9 = 1.43333, sd = 1.19722
   *
   * Superseded conditions still report PREVALENCE: uncomplicated diabetes shows
   * 2 patients (P02, P03) even though P03 contributed 0 for it. */
  comorbidityIndex: {
    rowCount: 9, // 5 conditions + 3 score bands + 1 index row
    conditions: {
      "Congestive heart failure": { patients: 2, weight: 1 },
      "Diabetes, uncomplicated": { patients: 2, weight: 1 },
      "Diabetes with complications": { patients: 2, weight: 2 },
      "Mild liver disease": { patients: 2, weight: 1 },
      "Moderate/severe liver disease": { patients: 1, weight: 3 },
    } as Record<string, { patients: number; weight: number }>,
    bands: { "0": 4, "1-2": 4, "3+": 2 } as Record<string, number>,
    index: { mean: 1.1, sd: 1.19722, median: 1, max: 3 },
    /* What a hierarchy-less implementation would produce instead — written down
     * so the failure has a name when it appears. */
    withoutHierarchy: { p03: 3, p05: 4, sum: 13, mean: 1.3 },
  },
  /* Logistic regression, hand-derived from the 2x2.
   *
   * At risk after washout = 8 (P02..P05 on DRUG_X, P07..P10 on DRUG_Y).
   * Incident events inside 365 days: P02, P03 (X) and P07 (Y).
   *
   *                events   non-events
   *   DRUG_Y (exposed)   a=1        b=3
   *   DRUG_X (reference) c=2        d=2
   *
   * DRUG_X is the referenceLevel, so the coefficient is for DRUG_Y:
   *   OR  = (a*d)/(b*c) = (1*2)/(3*2) = 1/3 EXACTLY
   *   ln(OR) = -1.0986123
   *   Woolf SE = sqrt(1/1 + 1/3 + 1/2 + 1/2) = sqrt(7/3) = 1.5275252
   *   95% Wald on the log scale: -1.0986123 +/- 1.96*1.5275252
   *                            = (-4.0925617, 1.8953715)
   *   OR interval = (0.01670, 6.65479)
   *   RR = (1/4)/(2/4) = 0.5 EXACTLY
   *   RD = 0.25 - 0.5  = -0.25 EXACTLY
   *
   * The SATURATED ANCHOR is the point of all this: a logistic model with only
   * the exposure term has as many parameters as this table has cells, so its
   * MLE must be exactly ln(1/3). The emitted SAS checks that against the closed
   * form it computes from its own data. */
  regression: {
    rowCount: 11, // 4 design + 3 crude + 4 adjusted terms
    design: { exposedN: 4, exposedEvents: 1, referenceN: 4, referenceEvents: 2 },
    oddsRatio: { estimate: 0.33333, ciLow: 0.0167, ciHigh: 6.65479, seLog: 1.52753 },
    riskRatio: 0.5,
    riskDifference: -0.25,
    logOr: -1.0986123,
    /** terms of the adjusted model, in emission order */
    adjustedTerms: ["Index drug", "Age at index", "Sex", "Comorbidity index"],
  },
  /* SMD balance, DRUG_X (reference) vs DRUG_Y, over the 10-patient cohort.
   *   ages X = 40,45,50,55,60 -> mean 50, sample variance 62.5
   *   ages Y = 45,50,55,60,65 -> mean 55, sample variance 62.5
   *   SMD(age) = (50 - 55) / sqrt((62.5 + 62.5)/2) = -5/7.90569 = -0.632456
   * Sex: X has sex 1,2,1,2,1 -> 3/5 male = 0.6; Y has 1,2,1,2,1 -> 3/5 male = 0.6
   *   (P06=1, P07=2, P08=1, P09=2, P10=1), so p_ref = p_oth and SMD(sex) = 0. */
  balance: {
    rowCount: 3,
    age: { nRef: 5, nOth: 5, valueRef: 50, valueOth: 55, smd: -0.63246, imbalanced: 1 },
    sex: { nRef: 5, nOth: 5, valueRef: 0.6, valueOth: 0.6, smd: 0, imbalanced: 0 },
    /* Comorbidity index, X vs Y, from the SAME scores the index analysis
     * reports (P01..P05 = 1,1,2,1,3; P06..P10 = 3,0,0,0,0):
     *   X mean 8/5 = 1.6, sample variance 3.2/4 = 0.8
     *   Y mean 3/5 = 0.6, sample variance 7.2/4 = 1.8
     *   SMD = (1.6 - 0.6) / sqrt((0.8 + 1.8)/2) = 1 / sqrt(1.3) = 0.87706
     * Strongly imbalanced, which is the point: an unadjusted comparison of
     * these arms would be confounded by baseline comorbidity. */
    cci: { nRef: 5, nOth: 5, valueRef: 1.6, valueOth: 0.6, smd: 0.87706, imbalanced: 1 },
  },
} as const;

/* ---------------- Gold Case A spec (cohort spine; incidence analysis added at Step 4) ---------------- */

export const GOLD_A_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_STUDY" };

export const GOLD_A_SPEC: StudySpec = {
  meta: {
    title: "Gold Case A — new-user AE incidence",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2018-01-01", end: "2020-12-31" },
    provenance: { method: "manual" },
  },
  codeLists: [
    {
      id: "index_drug", label: "Index drugs (X/Y)", system: "drug_name",
      codes: [
        { code: "DRUG_X", source: "user_entered", verified: true },
        { code: "DRUG_Y", source: "user_entered", verified: true },
      ],
    },
    {
      id: "ae_dx", label: "AE (T2DM E11.9)", system: "icd10cm",
      codes: [{ code: "E11.9", source: "user_entered", verified: true }],
    },
    /* Comorbidity code lists. INVENTED single codes, not a published algorithm:
     * the fixture's job is to verify the SCORING (weights + hierarchy), and a
     * partial transcription of a real Charlson code set would be worse than an
     * obviously synthetic one — it would look authoritative and undercount. */
    { id: "cci_chf_dx",  label: "Congestive heart failure",     system: "icd10cm", codes: [{ code: "I50.0", source: "user_entered", verified: true }] },
    { id: "cci_dm_dx",   label: "Diabetes, uncomplicated",      system: "icd10cm", codes: [{ code: "E10.0", source: "user_entered", verified: true }] },
    { id: "cci_dmc_dx",  label: "Diabetes with complications",  system: "icd10cm", codes: [{ code: "E10.2", source: "user_entered", verified: true }] },
    { id: "cci_mliv_dx", label: "Mild liver disease",           system: "icd10cm", codes: [{ code: "K70.3", source: "user_entered", verified: true }] },
    { id: "cci_sliv_dx", label: "Moderate/severe liver disease", system: "icd10cm", codes: [{ code: "K72.1", source: "user_entered", verified: true }] },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "index_drug", indexPeriod: { start: "2019-01-01", end: "2019-12-31" } },
  enrollment: { baselineDays: 365, followupDays: 365, gapAllowanceDays: 31, requiresRxCoverage: true },
  criteria: [
    {
      id: "c_cont", kind: "inclusion", sourceText: "Continuous enrollment 365d pre/post index",
      test: { type: "continuous_enrollment", baselineDays: 365, followupDays: 365, requiresRxCoverage: true },
      confidence: "high", reviewed: true,
    },
    {
      id: "c_age", kind: "inclusion", sourceText: "Age >= 18 at index",
      test: { type: "age_at_index", min: 18 }, confidence: "high", reviewed: true,
    },
  ],
  baseline: [
    { id: "b_age", label: "Age at index", kind: "age", dataType: "continuous" },
    { id: "b_sex", label: "Sex", kind: "sex", dataType: "binary" },
    { id: "b_region", label: "Region", kind: "region", dataType: "categorical" },
    { id: "b_plan", label: "Plan type", kind: "plan_type", dataType: "categorical" },
    { id: "b_year", label: "Index year", kind: "year", dataType: "categorical" },
    /* Derived from the a_cci index analysis, referenced by id so there is ONE
     * definition of the index in this spec. Table 1 and the balance table both
     * score it through the SHARED scorer, so they cannot disagree with the
     * index analysis about what P03 or P05 scored. */
    { id: "b_cci", label: "Comorbidity index", kind: "comorbidity_index", comorbidityIndexAnalysisId: "a_cci", dataType: "continuous" },
  ],
  outcomes: [],
  /* Exposure arms for the balance table: the index code list holds both drugs,
   * so the cohort's index_code IS the arm (active-comparator new-user design). */
  groupVars: [
    {
      id: "g_arm",
      label: "Index drug",
      source: { kind: "exposure_cohort" },
      levels: ["DRUG_X", "DRUG_Y"],
      referenceLevel: "DRUG_X",
    },
  ],
  comparisons: [],
  analyses: [

    /* Direct age standardization of the SAME incidence measure.
     * The at-risk cohort spans exactly three bands (45-54: 3, 55-64: 4, 65+: 1),
     * so bands [45,55,65] cover it completely and the DSR is hand-computable:
     *   45-54 rate = 3 x 1000 x 365.25 / 600 = 1826.25 per 1000 PY, w = 134,834
     *   55-64 rate = 0                        , w =  87,247
     *   65+   rate = 0                        , w = 126,387 (65-74+75-84+85+)
     *   DSR = 134,834 x 1826.25 / 348,468 = 706.64 per 1000 PY
     * Coverage = 348,468 / 1,000,000 = 34.85% of US 2000 — reported, because a
     * rate standardized to a third of a reference is not comparable to a
     * published one. */
    {
      id: "a_dsr", label: "Age-standardized AE incidence (US 2000)", kind: "standardization",
      enabled: true, base: "incidence_rate",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      rateMultiplier: 1000,
      /* MUST match the incidence analysis this standardizes, max-follow-up
       * included — otherwise the DSR re-weights a DIFFERENT measure than the
       * one the incidence table reports, and the two disagree on person-time. */
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      standardization: {
        method: "direct",
        strataIds: ["s_age"],
        referencePopulation: { kind: "named", name: "us_2000" },
        ciMethod: "fay_feuer",
        standardizationBands: [45, 55, 65],
      },
    },    { id: "a_attrition", label: "Attrition", kind: "attrition", enabled: true },
    { id: "a_table1", label: "Baseline characteristics", kind: "table1", enabled: true },
    {
      id: "a_incidence", label: "Incidence rate of AE (E11.9)", kind: "incidence_rate", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "incident",
      washout: { start: -365, end: 0, includesIndex: true },
      denominatorRule: "person_time",
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      recurrence: "first_only",
      rateMultiplier: 1000,
      ciMethod: "poisson_byar",
      stratifyBy: [
        { id: "s_sex", label: "Sex", source: { kind: "demographic", axis: "sex" } },
        { id: "s_age", label: "Age band", source: { kind: "demographic", axis: "age_band" }, ageBandLowerBounds: [0, 18, 35, 45, 55, 65] },
        { id: "s_year", label: "Index year", source: { kind: "demographic", axis: "year" } },
      ],
    },
    // --- point prevalence (3 analyses: fixed-anchor + strata, index-anchor, EOS zero-denominator) ---
    {
      id: "a_pp_main", label: "Point prevalence of AE on 2019-07-20", kind: "point_prevalence", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "prevalent",
      anchorDate: { kind: "fixed", date: "2019-07-20" },
      denominatorRule: "enrolled_midperiod",
      ciMethod: "wilson",
      stratifyBy: [
        { id: "s_sex", label: "Sex", source: { kind: "demographic", axis: "sex" } },
        { id: "s_age", label: "Age band", source: { kind: "demographic", axis: "age_band" }, ageBandLowerBounds: [0, 18, 35, 45, 55, 65] },
        { id: "s_ppyear", label: "Anchor year", source: { kind: "demographic", axis: "year" } },
      ],
    },
    {
      id: "a_pp_idx", label: "Point prevalence of AE at index", kind: "point_prevalence", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "prevalent",
      anchorDate: { kind: "index" },
      denominatorRule: "enrolled_midperiod",
      ciMethod: "wilson",
      stratifyBy: [],
    },
    {
      id: "a_pp_eos", label: "Point prevalence of AE on 2020-12-31", kind: "point_prevalence", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "prevalent",
      anchorDate: { kind: "fixed", date: "2020-12-31" },
      denominatorRule: "enrolled_midperiod",
      ciMethod: "clopper_pearson", // exercises honest labeling: Wilson computed + labeled
      stratifyBy: [],
    },
    // --- period prevalence (2 analyses: calendar-year window + strata, empty-period) ---
    {
      id: "a_perp_2019", label: "Period prevalence of AE in 2019", kind: "period_prevalence", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "prevalent",
      prevalencePeriod: { start: "2019-01-01", end: "2019-12-31" },
      denominatorRule: "enrolled_anytime",
      ciMethod: "wilson",
      stratifyBy: [
        { id: "s_sex", label: "Sex", source: { kind: "demographic", axis: "sex" } },
        { id: "s_age", label: "Age band", source: { kind: "demographic", axis: "age_band" }, ageBandLowerBounds: [0, 18, 35, 45, 55, 65] },
      ],
    },
    {
      id: "a_perp_empty", label: "Period prevalence of AE in 2021", kind: "period_prevalence", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "prevalent",
      prevalencePeriod: { start: "2021-01-01", end: "2021-12-31" }, // after every episode end
      denominatorRule: "enrolled_anytime",
      ciMethod: "wilson",
      stratifyBy: [],
    },
    // --- cumulative incidence (2 analyses: 365d horizon + sex strata, 180d horizon) ---
    {
      id: "a_ci_365", label: "1-year cumulative incidence of AE", kind: "cumulative_incidence", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "incident",
      washout: { start: -365, end: 0, includesIndex: true },
      incidentWithRespectTo: "cohort_entry",
      denominatorRule: "at_risk_start",
      horizonDays: 365,
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end"], maxFollowupDays: 365 },
      competingRiskDeath: "ignore",
      recurrence: "first_only",
      ciMethod: "wilson",
      stratifyBy: [
        { id: "s_sex", label: "Sex", source: { kind: "demographic", axis: "sex" } },
      ],
    },
    {
      id: "a_ci_180", label: "180-day cumulative incidence of AE", kind: "cumulative_incidence", enabled: true,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      caseStatus: "incident",
      washout: { start: -365, end: 0, includesIndex: true },
      incidentWithRespectTo: "cohort_entry",
      denominatorRule: "at_risk_start",
      horizonDays: 180,
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end"], maxFollowupDays: 180 },
      competingRiskDeath: "censor", // exercises the KM/SAS-only limitation note
      recurrence: "first_only",
      ciMethod: "wilson",
      stratifyBy: [],
    },
    /* Calendar trend of the SAME outcome across the three study years.
     * Deliberately NON-monotone-looking in the middle (2 -> 3 -> 0) so the test
     * is exercised on data where the direction is not obvious by eye: the rise
     * then fall yields z = -1.2, which is exactly the case the method notes warn
     * about (a monotone-trend test has little power against a peak). */
    {
      id: "a_trend", label: "Calendar trend of AE prevalence", kind: "calendar_trend", enabled: true,
      base: "period_prevalence",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      denominatorRule: "enrolled_anytime",
      trend: { bucket: "calendar_year", method: "cochran_armitage", reportPerBucket: true },
      ciMethod: "wilson",
      stratifyBy: [],
    },
    /* Resource use and cost over the first year of follow-up, all four care
     * settings plus the combined row. The window is day 0..364 INCLUSIVE, so
     * every member contributes exactly 365 observed days (their enrollment
     * covers it by construction — continuous enrollment is an inclusion
     * criterion, which is also why the disenrollment clip cannot be exercised
     * by this cohort and is stated as such rather than fake-tested). */
    {
      id: "a_hcru", label: "Resource use and cost, first year", kind: "resource_use", enabled: true,
      ascertainmentWindow: { start: 0, end: 364, includesIndex: true },
      settings: ["inpatient", "ed", "outpatient", "pharmacy"],
      costField: "paytot",
      includeCombined: true,
    },
    /* Weighted comorbidity index. Weights follow the classic Charlson shape
     * (1 / 2 / 3) but are declared HERE, in the spec, exactly as a real study
     * would declare them after reading the source paper — the emitter supplies
     * no weight of its own. Both supersession rules are exercised. */
    {
      id: "a_cci", label: "Baseline comorbidity index", kind: "comorbidity_index", enabled: true,
      indexName: "charlson_like_fixture",
      lookback: { start: -365, end: 0, includesIndex: true },
      conditions: [
        { id: "chf",  label: "Congestive heart failure",      codeListId: "cci_chf_dx",  weight: 1 },
        { id: "dm",   label: "Diabetes, uncomplicated",       codeListId: "cci_dm_dx",   weight: 1 },
        { id: "dmc",  label: "Diabetes with complications",   codeListId: "cci_dmc_dx",  weight: 2, supersedes: ["dm"] },
        { id: "mliv", label: "Mild liver disease",            codeListId: "cci_mliv_dx", weight: 1 },
        { id: "sliv", label: "Moderate/severe liver disease", codeListId: "cci_sliv_dx", weight: 3, supersedes: ["mliv"] },
      ],
      scoreBands: [0, 1, 3],
    },
    /* Logistic regression of the incident AE on the exposure arm.
     *
     * The at-risk set is the incidence module's: 8 subjects after washout,
     * 4 per arm. Events inside the 365-day horizon are P02 and P03 (DRUG_X)
     * and P07 (DRUG_Y). DRUG_X is the reference, so the reported effect is for
     * DRUG_Y and every closed-form quantity is exact — see EXPECTED. */
    {
      id: "a_glm", label: "Adjusted odds of incident AE within 1 year", kind: "regression", enabled: true,
      family: "logistic",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
      groupVarId: "g_arm",
      covariateIds: ["b_age", "b_sex", "b_cci"],
    },
    /* Covariate balance between the exposure arms. Age is deliberately
     * IMBALANCED (SMD -0.63246, |SMD| > 0.1) and sex is deliberately BALANCED
     * (both arms 3/5 male -> SMD exactly 0), so the table exercises the flag in
     * both directions rather than only the interesting one. */
    {
      id: "a_balance", label: "Baseline balance, X vs Y", kind: "statistical_engine", enabled: true,
      comparisonIds: [],
      smdBalance: { groupVarId: "g_arm", covariateIds: ["b_age", "b_sex", "b_cci"], imbalanceThreshold: 0.1, reportWeighted: false },
      multiplicity: { method: "none", alpha: 0.05, appliesToRoles: ["primary"] },
    },
  ],
};
