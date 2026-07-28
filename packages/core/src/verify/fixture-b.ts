/**
 * Gold Case B — RECURRENT EVENTS and overdispersion.
 *
 * A separate SEED, not an extension of Gold Case A. Gold A is frozen: an extra
 * indexed patient there moves attrition, the at-risk 8, the 2425 person-days and
 * every rate, prevalence, SMD and regression estimate simultaneously. So each
 * new gold case gets its own data and its own hand derivation, and the harness
 * runs it in its own PGlite instance.
 *
 * WHAT THIS CASE EXISTS TO EXERCISE, and what A structurally cannot: on Gold A
 * every at-risk subject has at most ONE qualifying event, so the response is
 * Bernoulli, its variance is necessarily below its mean, and the negative
 * binomial dispersion parameter is not identified. Gold B is built so that it
 * IS — one arm carries a subject with seven events, and the variance-to-mean
 * ratio comes out well above 1.
 *
 * The cohort is deliberately plain (no attrition, no stitching, no censoring
 * edge cases — those are Gold A's job) so that every number here is traceable to
 * the event counts alone.
 *
 * Ground truth, hand-derived:
 *   cohort 8, all at risk (no baseline events, so nothing washes out)
 *   event counts, distinct dates in (index, index+365]:
 *     DRUG_X (reference)  P1=1, P2=1, P3=2, P4=0  -> 4
 *     DRUG_Y (exposed)    P5=0, P6=0, P7=1, P8=7  -> 8
 *   person-time: every subject observed the full 365 days (recurrent model does
 *     NOT censor at the outcome) -> 1460 per arm, 2920 total
 *   rate_X = 4 x 1000 x 365.25 / 1460 = 1000.68493 per 1000 PY
 *   rate_Y = 8 x 1000 x 365.25 / 1460 = 2001.36986 per 1000 PY
 *   RR     = (8/1460) / (4/1460) = 2.0 EXACTLY (equal person-time cancels)
 *   SE     = sqrt(1/8 + 1/4) = sqrt(0.375) = 0.61237
 *   95% CI = exp(ln2 +/- 1.96*0.61237) = (0.60224, 6.64189)
 *   rate difference = 2001.36986 - 1000.68493 = 1000.68493 per 1000 PY
 *
 *   dispersion: counts [1,1,2,0,0,0,1,7], mean 12/8 = 1.5,
 *     sample variance = 38/7 = 5.428571, ratio = 3.61905 -> OVERDISPERSED,
 *     which is exactly the condition Gold A cannot produce.
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";
const NDC_Y = "00000000002";

/** enrolid -> arm NDC. Four per arm, all indexed 2020-01-01. */
const B_DRUG: Array<[number, string]> = [
  [1, NDC_X], [2, NDC_X], [3, NDC_X], [4, NDC_X],
  [5, NDC_Y], [6, NDC_Y], [7, NDC_Y], [8, NDC_Y],
];

/** Qualifying OUTPATIENT events (E11.9), distinct dates inside the horizon.
 *  P3 has two and P8 has seven — the recurrence Gold A lacks entirely. */
const B_EVENTS: Array<[number, string]> = [
  [1, "2020-03-01"],
  [2, "2020-04-01"],
  [3, "2020-05-01"], [3, "2020-06-01"],
  [7, "2020-07-01"],
  [8, "2020-02-01"], [8, "2020-03-01"], [8, "2020-04-01"], [8, "2020-05-01"],
  [8, "2020-06-01"], [8, "2020-07-01"], [8, "2020-08-01"],
];

/** Full seed SQL for Gold Case B (same DDL as A, entirely different data). */
export function fixtureBSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  // Enrollment spans the whole study period for everyone: this case is about
  // event counts, so no member is allowed to fail continuous enrollment.
  const enroll = B_DRUG.map(
    ([id]) => `(${id}, DATE '2019-01-01', DATE '2021-12-31', '1', '1', 1980, 40, '1', '1', '6', '1')`,
  ).join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
  );
  const drugs = B_DRUG.map(([id, ndc]) => `(${id}, DATE '2020-01-01', '${ndc}', 30, 30, 100)`).join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${drugs};`);
  const ev = B_EVENTS.map(
    ([id, d]) => `(${id}, DATE '${d}', '0', 'E119', NULL, NULL, NULL, NULL, NULL, '11', 200)`,
  ).join(",\n  ");
  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac,paytot) VALUES\n  ${ev};`,
  );
  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ('${NDC_X}','DRUG_X','BRAND_X'),('${NDC_Y}','DRUG_Y','BRAND_Y');`,
  );
  return lines.join("\n");
}

export const GOLD_B_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_B" };

export const GOLD_B_SPEC: StudySpec = {
  meta: {
    title: "Gold Case B — recurrent AE counts and overdispersion",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2019-01-01", end: "2021-12-31" },
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
    { id: "ae_dx", label: "AE (T2DM E11.9)", system: "icd10cm", codes: [{ code: "E11.9", source: "user_entered", verified: true }] },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "index_drug", indexPeriod: { start: "2020-01-01", end: "2020-12-31" } },
  enrollment: { baselineDays: 365, followupDays: 365, gapAllowanceDays: 31, requiresRxCoverage: true },
  criteria: [
    {
      id: "c_cont", kind: "inclusion", sourceText: "Continuous enrollment 365d pre/post index",
      test: { type: "continuous_enrollment", baselineDays: 365, followupDays: 365, requiresRxCoverage: true },
      confidence: "high", reviewed: true,
    },
  ],
  baseline: [{ id: "b_age", label: "Age at index", kind: "age", dataType: "continuous" }],
  outcomes: [],
  groupVars: [
    { id: "g_arm", label: "Index drug", source: { kind: "exposure_cohort" }, levels: ["DRUG_X", "DRUG_Y"], referenceLevel: "DRUG_X" },
  ],
  comparisons: [],
  analyses: [
    { id: "b_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "b_nb", label: "Recurrent AE rate, negative binomial", kind: "regression", enabled: true,
      family: "negative_binomial",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
      recurrence: "all_events",
      personTimeRule: { start: "index", censorAt: ["disenrollment", "study_end", "max_followup"], maxFollowupDays: 365 },
      groupVarId: "g_arm",
      covariateIds: ["b_age"],
    },
  ],
};

export const EXPECTED_B = {
  cohortN: 8,
  personDaysPerArm: 1460,
  personDaysTotal: 2920,
  design: {
    exposed: { n: 4, events: 8, ratePer1000py: 2001.36986 },   // DRUG_Y
    reference: { n: 4, events: 4, ratePer1000py: 1000.68493 }, // DRUG_X
  },
  rateRatio: { estimate: 2, ciLow: 0.60224, ciHigh: 6.64189, seLog: 0.61237 },
  rateDifference: 1000.68493,
  logRr: 0.6931472,
  /** counts [1,1,2,0,0,0,1,7]: mean 1.5, sample variance 38/7, ratio 3.61905 */
  varianceToMeanRatio: 3.61905,
  maxEventsPerSubject: 7,
} as const;
