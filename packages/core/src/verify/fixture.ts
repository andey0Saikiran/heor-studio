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
  proc1 VARCHAR, proctyp VARCHAR, stdplac VARCHAR
);
DROP TABLE IF EXISTS ccaes_all;
CREATE TABLE ccaes_all (
  enrolid BIGINT, admdate DATE, svcdate DATE, dxver VARCHAR, pdx VARCHAR,
  dx1 VARCHAR, dx2 VARCHAR, dx3 VARCHAR, dx4 VARCHAR,
  pproc VARCHAR, proc1 VARCHAR, proctyp VARCHAR
);
DROP TABLE IF EXISTS ccaei_all;
CREATE TABLE ccaei_all (
  enrolid BIGINT, admdate DATE, disdate DATE, dxver VARCHAR, pdx VARCHAR,
  dx1 VARCHAR, dx2 VARCHAR, dx3 VARCHAR, dx4 VARCHAR, dx5 VARCHAR, dx6 VARCHAR,
  dx7 VARCHAR, dx8 VARCHAR, dx9 VARCHAR, dx10 VARCHAR, dx11 VARCHAR, dx12 VARCHAR,
  dx13 VARCHAR, dx14 VARCHAR, dx15 VARCHAR, pproc VARCHAR, proc1 VARCHAR
);
DROP TABLE IF EXISTS ccaed_all;
CREATE TABLE ccaed_all (
  enrolid BIGINT, svcdate DATE, ndcnum VARCHAR, daysupp INT, qty NUMERIC
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

  const drugVals = DRUG.map(([id, ndc]) => `(${id}, DATE '2019-01-01', '${ndc}', 30, 30)`).join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty) VALUES\n  ${drugVals};`);

  const aeVals = AE.map(([id, d]) => `(${id}, DATE '${d}', '0', 'E119', NULL, NULL, NULL, NULL, NULL, NULL)`).join(",\n  ");
  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac) VALUES\n  ${aeVals};`,
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
  // descriptive epi (verified once the incidence module lands)
  prevalentM: 2,
  baselinePrevalence: 0.2,
  atRiskDenominator: 8,
  incidentCases: 3,
  personDays: 2425,
  personDaysByArm: { X: 1030, Y: 1395 },
  crudeRatePer1000PY: 451.55, // 3*365*1000/2425
  byarCiPer1000PY: [90.76, 1319.66] as [number, number],
  cumulativeIncidence: 0.375, // 3/8
  wilsonCi: [0.13684, 0.69426] as [number, number],
  smdAge: -0.63246,
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
  ],
  outcomes: [],
  groupVars: [],
  comparisons: [],
  analyses: [
    { id: "a_attrition", label: "Attrition", kind: "attrition", enabled: true },
    { id: "a_table1", label: "Baseline characteristics", kind: "table1", enabled: true },
  ],
};
