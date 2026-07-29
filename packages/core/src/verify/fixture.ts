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
export const FIXTURE_DDL = `
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
  const lines: string[] = [FIXTURE_DDL];

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
  /* ---------------- survival (Kaplan-Meier / log-rank) ---------------- *
   *
   * All hand-derived before execution. The at-risk 8 carry events at days 100
   * (P02), 200 (P03) and 300 (P07); the other five are censored at 365.
   *
   *   Overall  S = 7/8, then x6/7 = 3/4, then x5/6 = 5/8
   *   Greenwood sums  1/56, 1/56+1/42 = 1/24, +1/30 = 3/40  (EXACTLY 0.075)
   *   se = S * sqrt(sum) -> 0.11693, 0.15309, 0.17116
   *
   * THE CROSS-MODULE CHECK. Nobody is censored before the last event, so the
   * product-limit estimator and the naive at-risk risk must agree EXACTLY:
   * 1 - S(365) = 1 - 5/8 = 0.375 = EXPECTED.cumulativeIncidence.ci365 3/8.
   * Two modules, two algorithms, one number - and asserted as such in
   * verify/run.ts rather than left as a coincidence for a reader to notice.
   *
   * THE MEDIAN BOUNDARY. The reference arm's curve is 3/4 then EXACTLY 1/2, so
   * its median sits precisely on the "S(t) <= 0.5" boundary the definition is
   * evaluated at. The exposed arm never reaches one half, so its median is
   * legitimately NULL - one defined and one not, in the same table.
   *
   * THE LOG-RANK, accumulated for the EXPOSED arm (DRUG_Y):
   *   t=100  n=8 n_Y=4 d=1 d_Y=0  E=1/2      V=1/4
   *   t=200  n=7 n_Y=4 d=1 d_Y=0  E=4/7      V=12/49
   *   t=300  n=6 n_Y=4 d=1 d_Y=1  E=2/3      V=2/9
   *   O=1  E=73/42=1.7381  V=1265/1764=0.71712
   *   chi^2 = (O-E)^2/V = 961/1265 = 0.75968, well below 3.8416 -> do NOT reject
   *   Peto ln(HR) = (O-E)/V = -1.02925 -> HR 0.35728, se 1/sqrt(V) = 1.18088
   * The direction agrees with the logistic module, which reports OR = 1/3 for
   * the same arm on the same data: fewer events under DRUG_Y than expected. */
  survival: {
    rowCount: 25, // 6 life table + 9 horizon + 3 median + 6 logrank + 1 hazard ratio
    lifeTable: {
      Overall: [
        { t: 100, nRisk: 8, nEvent: 1, surv: 0.875, se: 0.11693, ci: [0.38699, 0.98139] as [number, number] },
        { t: 200, nRisk: 7, nEvent: 1, surv: 0.75,  se: 0.15309, ci: [0.3148,  0.9309]  as [number, number] },
        { t: 300, nRisk: 6, nEvent: 1, surv: 0.625, se: 0.17116, ci: [0.22933, 0.8607]  as [number, number] },
      ],
      DRUG_X: [
        { t: 100, nRisk: 4, nEvent: 1, surv: 0.75, se: 0.21651, ci: [0.12794, 0.96055] as [number, number] },
        { t: 200, nRisk: 3, nEvent: 1, surv: 0.5,  se: 0.25,    ci: [0.05784, 0.84486] as [number, number] },
      ],
      DRUG_Y: [
        { t: 300, nRisk: 4, nEvent: 1, surv: 0.75, se: 0.21651, ci: [0.12794, 0.96055] as [number, number] },
      ],
    } as Record<string, Array<{ t: number; nRisk: number; nEvent: number; surv: number; se: number; ci: [number, number] }>>,
    /* S(t) at the reported horizons. n_risk is the count still being observed AT
     * the horizon, so it falls 8 -> 7 -> 5 as subjects fail and are censored. */
    horizons: {
      Overall: [
        { t: 90,  nRisk: 8, surv: 1 },
        { t: 180, nRisk: 7, surv: 0.875 },
        { t: 365, nRisk: 5, surv: 0.625 },
      ],
      DRUG_X: [
        { t: 90,  nRisk: 4, surv: 1 },
        { t: 180, nRisk: 3, surv: 0.75 },
        { t: 365, nRisk: 2, surv: 0.5 },
      ],
      DRUG_Y: [
        { t: 90,  nRisk: 4, surv: 1 },
        { t: 180, nRisk: 4, surv: 1 },
        { t: 365, nRisk: 3, surv: 0.75 },
      ],
    } as Record<string, Array<{ t: number; nRisk: number; surv: number }>>,
    median: { Overall: null, DRUG_X: 200, DRUG_Y: null } as Record<string, number | null>,
    logRank: {
      comparison: "DRUG_Y vs DRUG_X",
      observed: 1,
      expected: 1.7381,
      variance: 0.71712,
      chiSquare: 0.75968,
      /* 0 = do not reject at alpha 0.05. The decision uses 3.8416 = z^2 at the
       * repo-wide z, NOT a p-value: SQL has no chi-square CDF, and a decision
       * against a fixed critical value needs none. */
      reject: 0,
    },
    petoHr: { estimate: 0.35728, se: 1.18088, ci: [0.0353, 3.61563] as [number, number] },
    /* a_km_lin: the LINEAR interval, ungrouped. Greenwood on the raw scale is
     * not bounded by [0,1] - at day 100 the upper limit computes to
     * 0.875 + 1.96*0.11693 = 1.10418 and at day 200 to 1.05006, both CLAMPED to
     * 1. At day 300 it lands at 0.96048 and is not clamped. That is the whole
     * argument for log_log being the default, pinned rather than asserted. */
    linear: {
      rowCount: 6, // 3 life table + 2 horizon + 1 median
      clamped: [
        { t: 100, ciLow: 0.64582, ciHigh: 1 },
        { t: 200, ciLow: 0.44994, ciHigh: 1 },
      ],
      unclamped: { t: 300, ciLow: 0.28952, ciHigh: 0.96048 },
    },
    /* a_km_none: an endpoint that never occurs. The CHF list's only claims are
     * P01's and P06's, both inside the washout, so both wash out as prevalent
     * and nothing happens to the remaining 8 afterwards. Every edge this
     * exercises is a divide-by-zero or an empty-set path that a curve WITH
     * events can never reach. */
    noEvents: {
      rowCount: 13, // 0 life table + 3 horizon + 3 median + 6 logrank + 1 hazard ratio
      lifeTableRows: 0, // there is no event time to tabulate
      survAtHorizon: 1, // nobody had the event, so survival is 1 - not missing
      nRiskOverall: 8,
      /* every term of an undefined test is NULL TOGETHER. "0 observed" beside a
       * NULL expectation would read as a result rather than as an absence. */
      logRankAllNull: true,
    },
  },
  /* ---------------- Cox proportional hazards ---------------- *
   * Gold Case A has NO tied event times, which makes it the case that pins two
   * identities Gold Case C cannot: the Cox information at beta = 0 EQUALS the
   * log-rank variance, and the Cox score EQUALS the log-rank numerator. It also
   * exercises the closed-form anchor's NOT-APPLICABLE branch.
   *
   *   loglik(0) = -(ln 8 + ln 7 + ln 6) = -5.81711, so -2logL(0) = 11.63422
   *   U(0)      = O - E = -31/42 = -0.73810
   *   I(0)      = 1/4 + 12/49 + 2/9 = 1265/1764 = 0.71712 = the log-rank V
   *   chi^2     = 0.75968, the same number the log-rank reports
   *   one-step  = exp(U/I) = 0.35728  (NOT the maximum, which is 0.35583)
   *
   * The true MLE is beta = -1.03329, HR = 0.35583, found by an independent
   * Newton solve. It is recorded here and NOT asserted: the SQL twin cannot
   * compute it and no SAS runs in CI, so pinning it would be pinning a number
   * nothing in this repo produces. The one-step's visible drift from it is the
   * reason the one-step is labelled rather than reported as the answer. */
  /* ---------------- competing risks, the DEGENERATE branch ---------------- *
   * Gold A's competing cause (mild liver disease) never occurs after index, so
   * every quantity below must collapse onto a number another module already
   * pins — which is the point. Three independent code paths reaching 3/8:
   * the cumulative-incidence module's naive risk, the KM complement, and the
   * Aalen-Johansen CIF.
   *
   * And the one that could not be checked any other way: the three-term
   * delta-method variance must reduce to Greenwood's, 15/512, whose square root
   * is the 0.17116 the survival module already pins for S(365). A variance with
   * a wrong sign or a dropped cross-term still produces a plausible standard
   * error on Gold Case D; here it has exactly one value it can take. */
  competingRisks: {
    rowCount: 24,
    cifInterest365: 0.375,   // = 3/8, the same number cumulative_incidence and KM report
    cifInterest180: 0.125,   // = 1/8, matching a_ci_180
    cifCompeting365: 0,      // the cause never occurs
    /** sqrt(15/512) — the Greenwood standard error, reached by the AJ formula */
    seInterest365: 0.17116,
    greenwoodVariance: 0.029296875, // 15/512
    naiveInterest365: 0.375,
    biasInterest365: 0,      // EXACTLY zero, not approximately
    identitySum: 0.375,
  },
  /* ---------------- IPTW OUTCOME MODEL ---------------- *
   * The score here is estimated on the AT-RISK set (8, after the washout drops
   * P01 and P06), NOT on the cohort of 10 — so its cells differ from the
   * propensity module's above, deliberately: weights built in one population
   * and applied in another describe neither.
   *
   *   region 1 {P02,P09}    n=2 t=1  ps=1/2
   *   region 2 {P03,P04,P10} n=3 t=1 ps=1/3
   *   region 3 {P05}        n=1 t=0  ps=0   <- single-arm
   *   region 4 {P07,P08}    n=2 t=2  ps=1   <- single-arm
   *
   * THREE of the eight are off support, so the effect is NOT IDENTIFIED. Every
   * number below is still computed — the arithmetic never fails, which is the
   * whole reason the identification row is emitted first and pinned here.
   *
   *   ATE weights  treated P07 1, P08 1, P09 2, P10 3  -> SUM 7
   *                control P02 2, P03 3/2, P04 3/2, P05 1 -> SUM 6
   *   Hajek risks  treated 1/7, control 7/12
   *   sandwich     Var = SUM(w^2 (Y-mu)^2)/(SUM w)^2 -> 50/2401 and 631/10368
   *   RD -37/84, RR 12/49, OR 5/42     (crude: -1/4, 1/2, 1/3)
   *
   * The RD interval runs from -1.00066: BELOW the range a difference of two
   * probabilities can occupy. Reported unclamped, with the diagnostic row. */
  iptwOutcome: {
    rowCount: 19,
    offSupport: 3, analysisSetN: 8, identified: 0,
    nTreated: 4, nControl: 4, eventsTreated: 1, eventsControl: 2,
    weightedNTreated: 7, weightedNControl: 6,
    riskTreated: 0.14286, riskControl: 0.58333,
    seTreated: 0.14431, seControl: 0.2467,
    riskDifference: -0.44048, rdSe: 0.28581, rdCi: [-1.00066, 0.1197] as [number, number],
    riskRatio: 0.2449, oddsRatio: 0.11905,
    crudeRiskTreated: 0.25, crudeRiskControl: 0.5, crudeRiskDifference: -0.25,
    weightingShift: -0.19048,
    intervalWithinRange: 0,
  },
  /* ---------------- Propensity score (IPTW on region) ---------------- *
   * Cells are the four regions: {P01,P02,P09}, {P03,P04,P10}, {P05,P06} and
   * {P07,P08}. Saturated scores 1/3, 1/3, 1/2 and 1 — the last because region 4
   * is entirely DRUG_Y.
   *
   *   ATE weights   treated 1/ps -> P06 2, P07 1, P08 1, P09 3, P10 3  = 10
   *                 control 1/(1-ps) -> 1.5, 1.5, 1.5, 1.5, 2          =  8
   *
   * The pseudo-populations are 10 and 8. Both are meant to represent the SAME
   * population, so the gap of 2 is not rounding: it is exactly the two people
   * in region 4, who exist in the treated pseudo-population and have no
   * counterpart in the control one.
   *
   * BALANCE IS REPORTED ON AGE AND SEX, NEITHER IN THE SCORE. Age was already
   * imbalanced and gets WORSE (-0.63246 -> -0.76234); sex was PERFECTLY
   * balanced (3M/2F in both arms, SMD exactly 0) and weighting breaks it
   * (0 -> 0.04527). Both are correct behaviour and both are the reason this
   * module reports before AND after rather than only the number an analyst
   * wants to see. */
  propensityScore: {
    rowCount: 24, // 5 design + 7 positivity + 6 weights + 2 covariates x 3
    nTreated: 5, nControl: 5, nCells: 4,
    minScore: 0.33333, maxScore: 1,
    cellsWithNoControl: 1, cellsWithNoTreated: 0, subjectsOffSupport: 2,
    pseudoTreated: 10, pseudoControl: 8, pseudoGap: 2,
    maxWeight: 3,
    essTreated: 4.16667,  // 25/6
    essControl: 4.92308,  // 64/13
    balance: {
      "Age at index": { unweighted: -0.63246, weighted: -0.76234, worse: true },
      Sex: { unweighted: 0, weighted: 0.04527, worse: true },
    } as Record<string, { unweighted: number; weighted: number; worse: boolean }>,
  },
  /* ---------------- Fine-Gray, the REDUCTION branch ---------------- *
   * Gold A's competing cause never occurs, so every one of these must EQUAL
   * the Cox value above. They are listed separately rather than referenced so
   * that a change to either module shows up as a disagreement between two
   * pinned numbers rather than as one number quietly following the other. */
  fineGray: {
    rowCount: 20, // 6 design + 7 score + 1 one-step + 3 anchor + 3 adjusted
    scoreU0: -0.7381,        // = the Cox score, and the log-rank numerator
    information0: 0.71712,   // = the Cox information
    partialLogLik0: -5.81711,
    scoreChiSquare: 0.75968,
    oneStepHr: 0.35728,
    /* nothing was retained, because nothing competed: the subdistribution and
     * cause-specific denominators are the SAME 21 = 8 + 7 + 6 */
    subdistributionRiskTotal: 21,
    causeSpecificRiskTotal: 21,
    retained: 0,
  },
  cox: {
    rowCount: 19, // 4 design + 8 score + 1 one-step + 3 anchor + 3 adjusted
    eventTimes: 3,
    eventsTotal: 3,
    eventsExposed: 1,
    tiedEventTimes: 0,
    partialLogLik0: -5.81711,
    minusTwoLogLik0: 11.63422,
    scoreU0: -0.7381,
    information0: 0.71712,
    logRankVariance: 0.71712, // EQUAL here, and only because nothing is tied
    scoreChiSquare: 0.75968,
    reject: 0,
    oneStep: { hr: 0.35728, se: 1.18088, ci: [0.0353, 3.61563] as [number, number] },
    /** the risk-set exposed share runs 1/2, 4/7, 2/3 — so no closed form */
    anchorApplies: false,
    eventShareExposed: 0.33333,
    /** recorded, not asserted: nothing in this repo computes it */
    trueMleBeta: -1.03329,
    trueMleHr: 0.35583,
  },
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
  /* Poisson regression, hand-derived. Same at-risk set and same events as the
   * logistic model; what changes is the denominator — person-time, not persons.
   *
   *                events   person-days
   *   DRUG_Y (exposed)   1        1395
   *   DRUG_X (reference) 2        1030
   *
   * 1395 + 1030 = 2425, the person-time every rate module already pins, so a
   * Poisson offset that disagrees with the incidence table cannot pass.
   *
   *   rate_Y = 1 x 1000 x 365.25 / 1395 = 261.82796 per 1000 PY
   *   rate_X = 2 x 1000 x 365.25 / 1030 = 709.22330 per 1000 PY
   *   RR     = (1/1395) / (2/1030) = 1030/2790 = 103/279 = 0.36918
   *   ln(RR) = -0.99648
   *   SE     = sqrt(1/1 + 1/2) = sqrt(1.5) = 1.22474   <- events only; the
   *            person-time enters the estimate, not the variance
   *   95% CI = exp(-0.99648 +/- 1.96*1.22474) = (0.03347, 4.07152)
   *   rate difference = 261.82796 - 709.22330 = -447.39534 per 1000 PY
   *
   * The SATURATED ANCHOR holds here too: a Poisson model with one binary
   * predictor and a log person-time offset is saturated for this two-cell
   * table, so its MLE is exactly ln(103/279). */
  regressionPoisson: {
    rowCount: 14, // 8 design + 2 crude + 4 adjusted terms
    design: {
      exposed: { n: 4, events: 1, personDays: 1395, ratePer1000py: 261.82796 },
      reference: { n: 4, events: 2, personDays: 1030, ratePer1000py: 709.2233 },
    },
    rateRatio: { estimate: 0.36918, ciLow: 0.03347, ciHigh: 4.07152, seLog: 1.22474 },
    rateDifference: -447.39534,
    logRr: -0.99648,
    adjustedTerms: ["Index drug", "Age at index", "Sex", "Comorbidity index"],
  },
  /* Negative binomial on recurrent counts, hand-derived.
   *
   * Follow-up does NOT stop at the first event, so every at-risk member is
   * observed for the full 365 days: 8 x 365 = 2920 person-days, 1460 per arm.
   * That is a different denominator from the Poisson analysis (which censors at
   * the outcome and gives 2425) — and the difference is exactly the point: a
   * recurrent-event model must keep observing.
   *
   *                events   person-days
   *   DRUG_Y (exposed)   1          1460
   *   DRUG_X (reference) 2          1460
   *
   *   rate_Y = 1 x 1000 x 365.25 / 1460 = 250.17123 per 1000 PY
   *   rate_X = 2 x 1000 x 365.25 / 1460 = 500.34247 per 1000 PY
   *   RR     = (1/1460) / (2/1460) = 0.5 EXACTLY  (equal person-time cancels)
   *   ln(RR) = -0.69315
   *   SE     = sqrt(1/1 + 1/2) = sqrt(1.5) = 1.22474
   *   95% CI = exp(-0.69315 +/- 1.96*1.22474) = (0.04534, 5.51434)
   *   rate difference = -250.17123 per 1000 PY
   *
   * max events per subject = 1, so dispersion is NOT identified — asserted, so
   * the day Gold Case B adds recurrence this check changes and says so. */
  regressionNegBin: {
    rowCount: 16, // 8 design + 2 crude + 2 diagnostic + 4 adjusted
    /* counts [1,1,0,0,1,0,0,0]: mean 0.375, sample variance 0.267857,
     * ratio 0.71429 — BELOW 1, so NB has nothing to estimate here. Gold Case B
     * is the seed where this exceeds 1. */
    varianceToMeanRatio: 0.71429,
    personDaysPerArm: 1460,
    personDaysTotal: 2920,
    design: {
      exposed: { n: 4, events: 1, ratePer1000py: 250.17123 },
      reference: { n: 4, events: 2, ratePer1000py: 500.34247 },
    },
    rateRatio: { estimate: 0.5, ciLow: 0.04534, ciHigh: 5.51434, seLog: 1.22474 },
    rateDifference: -250.17123,
    logRr: -0.6931472,
    maxEventsPerSubject: 1,
    dispersionVerdict: "DEGENERATE",
  },
  /* Gamma-log cost model, hand-derived.
   *
   * Cost window is day 1..365 — EXCLUDING the index date, because the index
   * fill IS the exposure and counting it would put the treatment's own price on
   * both sides of the comparison. Costs come through the shared ledger, so
   * P04's stay contributes its $10,000 admission total and not the $17,000 a
   * double count would give.
   *
   *   DRUG_X (reference)  P02 600, P03 300, P04 10000, P05 5000  -> mean 3975
   *   DRUG_Y (exposed)    P07 200, P08 1500, P09 0, P10 0        -> mean 850
   *                                                                 over the 2
   *                                                                 POSITIVE ones
   *
   * P09 and P10 have no post-index claims at all, so their cost is ZERO — the
   * condition a gamma response cannot take. They are counted and excluded, and
   * the program says so.
   *
   *   cost ratio = 850/3975 = 34/159 = 0.21384
   *   ln(ratio)  = -1.54254
   *   delta-method SE on the log ratio of means = 0.95555
   *   95% CI     = (0.03286, 1.39143)
   *   mean cost difference = 850 - 3975 = -3125
   *
   * NOTE: the SE and the upper bound here were CORRECTED against execution — a
   * long-division slip in the hand derivation gave 0.95554 and 1.39141. The
   * derivation was re-done independently and agrees with these values. */
  regressionGamma: {
    rowCount: 14, // 8 design + 2 crude + 1 diagnostic + 3 adjusted
    design: {
      exposed: { n: 4, nPositive: 2, totalCost: 1700, meanCost: 850 },
      reference: { n: 4, nPositive: 4, totalCost: 15900, meanCost: 3975 },
    },
    costRatio: { estimate: 0.21384, ciLow: 0.03286, ciHigh: 1.39143, seLog: 0.95555 },
    meanCostDifference: -3125,
    logCr: -1.54254,
    zeroCostExcluded: 2,
  },
  /* OLS on the comorbidity score, hand-derived. The at-risk set is the same 8.
   *
   *   DRUG_X (reference)  P02 1, P03 2, P04 1, P05 3  -> mean 1.75, sample var 0.916667
   *   DRUG_Y (exposed)    P07 0, P08 0, P09 0, P10 0  -> mean 0,    sample var 0
   *
   * OLS is the ONE family here whose standard error is also closed form:
   *   mean difference = 0 - 1.75 = -1.75 EXACTLY
   *   pooled var = (3*0 + 3*0.916667)/6 = 0.458333;  s_p = 0.677003
   *   SE = s_p * sqrt(1/4 + 1/4) = 0.677003 * 0.707107 = 0.47871
   *   normal-approx 95% CI = -1.75 +/- 1.96*0.47871 = (-2.68828, -0.81172)
   *   residual df = 6, so the EXACT interval is t(6) = 2.447, 25% wider — which
   *   is why the emitted label says normal approximation rather than implying
   *   the model's own interval.
   *
   * DRUG_Y's variance is exactly zero, which is a real edge case: the pooled
   * estimator must fall back on the other arm rather than divide by nothing. */
  regressionOls: {
    rowCount: 11, // 6 design + 1 crude + 1 diagnostic + 3 adjusted
    design: {
      exposed: { n: 4, mean: 0, sd: 0 },
      reference: { n: 4, mean: 1.75, sd: 0.95743 },
    },
    meanDifference: { estimate: -1.75, ciLow: -2.68828, ciHigh: -0.81172, se: 0.47871 },
    residualDf: 6,
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
    /* POISSON regression of the same incident AE on the same exposure, with
     * person-time as the log offset. The person-time rule is the incidence
     * analysis's, so the offset must reconcile to the pinned 2425 person-days —
     * a feeder that disagrees with the rate table fails immediately. */
    {
      id: "a_glm_pois", label: "Adjusted rate of incident AE", kind: "regression", enabled: true,
      family: "poisson",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      groupVarId: "g_arm",
      covariateIds: ["b_age", "b_sex", "b_cci"],
    },
    /* NEGATIVE BINOMIAL on a RECURRENT-EVENT count.
     *
     * Two things change from the Poisson analysis: the response is a COUNT of
     * qualifying events (recurrence "all_events"), and follow-up no longer stops
     * at the first event — counting every event while censoring at the first is
     * incoherent, so "outcome" is out of censorAt. Every at-risk member is
     * therefore observed for the full 365 days.
     *
     * On THIS fixture no subject has more than one event, so the response is
     * Bernoulli and the dispersion parameter is NOT identified. That is not a
     * defect of the model, it is a property of the data — and the emitted
     * program says so in a diagnostic row rather than printing a dispersion
     * estimate nobody could trust. Gold Case B (recurrent events) is what would
     * exercise dispersion for real. */
    {
      id: "a_glm_nb", label: "Recurrent AE rate, negative binomial", kind: "regression", enabled: true,
      family: "negative_binomial",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
      recurrence: "all_events",
      personTimeRule: { start: "index", censorAt: ["disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      groupVarId: "g_arm",
      covariateIds: ["b_age", "b_sex", "b_cci"],
    },
    /* GAMMA-LOG cost model on the same at-risk set.
     *
     * The cost window starts at day 1, EXCLUDING the index date: the index fill
     * is the exposure itself, so counting it as follow-up cost would put the
     * treatment's own price on both sides of the comparison. It also means
     * subjects whose only claim was the index fill have ZERO cost — which is
     * the condition a gamma model cannot fit, and therefore the one worth
     * exercising. */
    {
      id: "a_glm_cost", label: "Follow-up cost, gamma-log", kind: "regression", enabled: true,
      family: "gamma_log",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
      costResponse: {
        window: { start: 1, end: 365, includesIndex: false },
        settings: ["inpatient", "ed", "outpatient", "pharmacy"],
        costField: "paytot",
      },
      groupVarId: "g_arm",
      covariateIds: ["b_age", "b_sex"],
    },
    /* OLS on a continuous response — the comorbidity score, from the SAME
     * shared scorer Table 1 and the balance table use.
     *
     * OLS is the one family where BOTH the coefficient and its standard error
     * are closed form, so more of it is executed than of any other. Only the
     * p-value and the exact t interval stay SAS-primary. */
    {
      id: "a_glm_ols", label: "Baseline comorbidity by arm (OLS)", kind: "regression", enabled: true,
      family: "ols",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
      continuousResponse: { source: "comorbidity_index", comorbidityIndexAnalysisId: "a_cci" },
      groupVarId: "g_arm",
      covariateIds: ["b_age", "b_sex"],
    },
    /* SURVIVAL. Three analyses, because the interesting behaviour of a
     * Kaplan-Meier curve lives at its edges rather than in the middle.
     *
     * a_km — the main curve, by arm, with the log-log interval SAS defaults to.
     *   The at-risk 8 have events at days 100 (P02), 200 (P03) and 300 (P07),
     *   and nobody is censored before the last event, which makes the CROSS-
     *   MODULE check exact: 1 - S(365) = 1 - 5/8 = 0.375, the same number the
     *   cumulative-incidence module reaches as 3/8 by a completely different
     *   route. The reference arm's curve lands on EXACTLY one half at day 200 —
     *   the boundary the median's "S(t) <= 0.5" is evaluated at, planted there
     *   on purpose — while the exposed arm never reaches it, so one median is
     *   defined and one is legitimately NULL.
     *
     * a_km_lin — the same endpoint with the LINEAR interval and no grouping.
     *   Greenwood on the raw scale is not bounded by [0,1]: at day 100 the
     *   upper limit computes to 1.104 and has to be clamped. That clamp is the
     *   whole argument for log_log being the default, so it is pinned rather
     *   than described.
     *
     * a_km_none — a curve with NO events at all. The CHF list's only claims are
     *   P01's and P06's, both inside the washout, so both are excluded as
     *   prevalent and nothing happens afterwards to the remaining 8. The life
     *   table is EMPTY (there is no event time to tabulate), S(t) = 1 at every
     *   horizon, the median is NULL, and the log-rank variance is zero — so the
     *   chi-square must be NULL rather than a divide-by-zero or a confident 0. */
    {
      id: "a_km", label: "Time to incident AE, by arm", kind: "survival", enabled: true,
      endpoint: {
        kind: "claims_event",
        outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      },
      washout: { start: -365, end: 0, includesIndex: true },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      horizonDays: [90, 180, 365],
      ciMethod: "log_log",
      groupVarId: "g_arm",
      emitLifeTable: true,
    },
    {
      id: "a_km_lin", label: "Time to incident AE, linear interval", kind: "survival", enabled: true,
      endpoint: {
        kind: "claims_event",
        outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      },
      washout: { start: -365, end: 0, includesIndex: true },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      horizonDays: [100, 365],
      ciMethod: "linear",
      emitLifeTable: true,
    },
    {
      id: "a_km_none", label: "Time to incident CHF (no events occur)", kind: "survival", enabled: true,
      endpoint: {
        kind: "claims_event",
        outcomeDefinition: { codeListId: "cci_chf_dx", minClaims: 1, setting: "any", diagnosisPosition: "any" },
      },
      washout: { start: -365, end: 0, includesIndex: true },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      horizonDays: [365],
      ciMethod: "log_log",
      groupVarId: "g_arm",
      emitLifeTable: true,
    },
    /* COMPETING RISKS, with a competing cause that NEVER OCCURS after index —
     * the mild-liver-disease list, whose only Gold A claims are dated
     * 2018-06-15 and therefore sit in the baseline.
     *
     * That makes this the DEGENERATE branch, and it is worth having precisely
     * because it is degenerate: with no competing event the Aalen-Johansen CIF
     * must equal 1 - Kaplan-Meier must equal the cumulative-incidence module's
     * naive risk of 3/8, the reported bias must be exactly zero, and the
     * three-term delta-method variance must collapse to Greenwood's 15/512.
     * Gold Case D is the mirror image, where the two estimators come apart. An
     * implementation that had quietly built PER-CAUSE risk sets — the standard
     * way to get this wrong — agrees with everything here and fails there. */
    {
      id: "a_cif", label: "Cumulative incidence of AE with a competing risk", kind: "competing_risks", enabled: true,
      endpoint: {
        kind: "claims_event",
        outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      },
      competingEvents: [{
        id: "cr_liver", label: "Severe liver disease",
        outcomeDefinition: { codeListId: "cci_mliv_dx", minClaims: 1, setting: "any", diagnosisPosition: "any" },
      }],
      washout: { start: -365, end: 0, includesIndex: true },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      horizonDays: [180, 365],
      emitNaiveComparison: true,
      emitLifeTable: true,
    },
    /* PROPENSITY SCORE, scored on REGION — chosen because it produces the
     * configuration this module most needs to be tested against.
     *
     * The four region cells hold {P01,P02,P09}, {P03,P04,P10}, {P05,P06} and
     * {P07,P08}. The last is entirely DRUG_Y, so its saturated score is exactly
     * 1: there is no control anywhere in it, and no weighting can conjure one.
     * The treated pseudo-population comes to 10 and the control one to 8, and
     * the gap of 2 IS those two subjects.
     *
     * Balance is reported on age and sex, NEITHER of which is in the score —
     * deliberately, because weighting on region makes the age imbalance WORSE
     * (SMD -0.63246 before, -0.76234 after) and a module that could only ever
     * show balance improving would be hiding its most useful output. */
    {
      id: "a_ps", label: "Propensity-score adjustment (IPTW on region)", kind: "propensity_score", enabled: true,
      groupVarId: "g_arm",
      psCovariateIds: ["b_region"],
      balanceCovariateIds: ["b_age", "b_sex"],
      method: "iptw", estimand: "ate", stabilized: false, trim: 0,
    },
    /* THE IPTW OUTCOME MODEL, on the same score covariate (region) and the
     * same AE outcome the rest of Gold A uses.
     *
     * Note what changes when the score is estimated on the AT-RISK set rather
     * than the cohort: the washout removes P01 and P06, so region 3 becomes
     * {P05} alone (score 0) and region 1 becomes {P02, P09} (score 1/2). THREE
     * of the eight subjects now sit in single-arm cells, so the effect is NOT
     * IDENTIFIED — which is exactly the configuration this module exists to
     * refuse to report quietly.
     *
     * Weighted risks 1/7 and 7/12; risk difference -37/84 against a crude
     * -1/4, so weighting moves it by -0.19048. And the Wald interval on the
     * risk difference runs from -1.00066, below the range a difference of two
     * probabilities can occupy — reported UNCLAMPED, with the diagnostic row
     * that says the normal approximation has broken down. */
    {
      id: "a_iptw", label: "IPTW outcome model (AE at 365d, weighted on region)", kind: "iptw_outcome", enabled: true,
      groupVarId: "g_arm",
      psCovariateIds: ["b_region"],
      estimand: "ate", stabilized: false, trim: 0, doublyRobust: false,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
    },
    /* A SECOND propensity analysis, scored on REGION x SEX.
     *
     * It exists for two reasons. First, a one-axis score never emits a cell
     * SEPARATOR, so the cell-spelling contract — which the parity stamp records
     * precisely because a mis-spelled cell changes every score without changing
     * any comparison of numbers — was structurally unexercised.
     *
     * Second, and this is why it earned its place: it is a COUNTEREXAMPLE to a
     * claim this module used to make. Seven cells, four of them single-arm, so
     * positivity plainly fails — and yet both pseudo-populations come to
     * exactly 8, so the gap is ZERO. A nonzero gap proves a violation; a zero
     * gap proves nothing. subjects_off_support is the authoritative row. */
    {
      id: "a_ps2", label: "Propensity-score adjustment (IPTW on region x sex)", kind: "propensity_score", enabled: true,
      groupVarId: "g_arm",
      psCovariateIds: ["b_region", "b_sex"],
      balanceCovariateIds: ["b_age"],
      method: "iptw", estimand: "ate", stabilized: false, trim: 0,
    },
    /* FINE-GRAY on the same endpoint and the same competing cause as a_cif.
     *
     * Gold A's competing cause never occurs, which makes this the REDUCTION
     * case: the modified risk set has nothing extra to hold, every weight is 1,
     * and the subdistribution model must become Cox IDENTICALLY. Not similar —
     * the same score, the same information, the same null log-likelihood, the
     * same one-step estimate as a_cox produces on the same data.
     *
     * That is the strongest available check on the weighting machinery, and it
     * needs two modules to make: a weighting bug, a wrong G, or a risk set that
     * retained the wrong people all break the equality, and none of them is
     * visible from inside either module alone. */
    {
      id: "a_fg", label: "Fine-Gray subdistribution model, X vs Y", kind: "fine_gray", enabled: true,
      endpoint: {
        kind: "claims_event",
        outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      },
      competingEvents: [{
        id: "cr_liver", label: "Severe liver disease",
        outcomeDefinition: { codeListId: "cci_mliv_dx", minClaims: 1, setting: "any", diagnosisPosition: "any" },
      }],
      washout: { start: -365, end: 0, includesIndex: true },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      groupVarId: "g_arm",
      covariateIds: ["b_age", "b_sex"],
    },
    /* COX on the same endpoint as a_km. Gold A has NO tied event times, which
     * makes it the case that pins two identities the tie fixture cannot:
     *   - Cox's information at beta = 0 EQUALS the log-rank variance
     *     (1265/1764), because the (n-d)/(n-1) correction is 1 throughout;
     *   - the Cox score at beta = 0 EQUALS the log-rank numerator O - E.
     * It also exercises the anchor's NOT-APPLICABLE branch: the risk-set
     * exposed share runs 1/2, 4/7, 2/3, so there is no closed-form maximum and
     * the program must say so rather than print a number. Gold Case C is the
     * mirror image on both counts. */
    {
      id: "a_cox", label: "Cox proportional hazards, X vs Y", kind: "cox", enabled: true,
      endpoint: {
        kind: "claims_event",
        outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      },
      washout: { start: -365, end: 0, includesIndex: true },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      groupVarId: "g_arm",
      covariateIds: ["b_age", "b_sex"],
      ties: "breslow",
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
