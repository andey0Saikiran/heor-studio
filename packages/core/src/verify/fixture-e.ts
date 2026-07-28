/**
 * Gold Case E — FRACTIONAL inverse-probability-of-censoring weights.
 *
 * What Gold Case D cannot reach. D has a competing event, so it does exercise
 * the Fine-Gray risk set — a competing-event subject is retained where a Cox
 * model would drop them. But nobody in D is censored before the last event of
 * interest, so G(t) is 1 throughout and EVERY WEIGHT IS EXACTLY 1. The weight
 * expression could be deleted entirely and D would not move.
 *
 * Here one subject is censored BETWEEN the competing event and the second event
 * of interest, so G drops, and the retained subject enters the later risk set at
 * a genuinely fractional weight.
 *
 * Ground truth, hand-derived (all confirmed by execution):
 *   5 subjects, index 2020-01-01
 *     P1  exposed     cause 1 (interest)  day 100
 *     P2  reference   cause 2 (competing) day 200
 *     P3  exposed     CENSORED            day 300   <- disenrolls; this is what moves G
 *     P4  reference   cause 1 (interest)  day 400
 *     P5  exposed     censored            day 500   (max follow-up)
 *
 *   G(t), Kaplan-Meier of the CENSORING distribution:
 *     censoring times are 300 and 500. At t=300 three subjects are still being
 *     observed (P3, P4, P5) and one is censored, so
 *       G(t) = 1     for t < 300
 *       G(t) = 2/3   for 300 <= t < 500
 *
 *   The subdistribution risk sets at the two cause-1 event times:
 *     t=100  everyone is still at risk        -> weights all 1, weighted n = 5
 *            exposed weight 3 (P1, P3, P5)    -> p = 3/5
 *     t=400  at risk: P4, P5                  -> weight 1 each
 *            RETAINED: P2, competing at 200   -> w = G(400)/G(200) = (2/3)/1 = 2/3
 *            weighted n = 1 + 1 + 2/3 = 8/3   -> NOT 3, which is the point
 *            exposed weight 1 (P5)            -> p = (1)/(8/3) = 3/8
 *
 *   A CAUSE-SPECIFIC Cox model would use risk sets of 5 and 2 at those times.
 *
 *   U(0) = (1 + 0) - (3/5 + 3/8) = 1/40 = 0.025
 *   I(0) = (3/5)(2/5) + (3/8)(5/8) = 6/25 + 15/64 = 759/1600 = 0.474375
 *   logL(0)  = -(ln 5 + ln(8/3)) = -2.5902672,  so -2logL(0) = 5.1805343
 *   score chi-square = (1/1600)/(759/1600) = 1/759 = 0.0013175
 *   one-step beta = 40/759 = 0.0527009,  HR = 1.0541143,  se = 1.4519080
 *
 * A NOTE ON CONVENTION, because it decides a number. Implementations differ on
 * whether G is evaluated at t or at t-. No event time here coincides with a
 * censoring time (events at 100 and 400, censoring at 300 and 500), so the
 * choice cannot change any value pinned above. That is deliberate: a fixture
 * whose gold numbers depended on an unstated convention would be pinning this
 * repo's guess rather than the estimator.
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";
const NDC_Y = "00000000002";

/** P1, P3, P5 exposed (DRUG_Y); P2, P4 reference (DRUG_X). One cause-1 event in
 *  each arm, so the maximum likelihood estimate is FINITE — unlike Gold Case D,
 *  which is the separation fixture. */
const E_DRUG: Array<[number, string]> = [
  [1, NDC_Y], [3, NDC_Y], [5, NDC_Y],
  [2, NDC_X], [4, NDC_X],
];

const E_INDEX = "2020-01-01";
const DAY_100 = "2020-04-10";
const DAY_200 = "2020-07-19";
const DAY_300 = "2020-10-27";
const DAY_400 = "2021-02-04";

const COMPETING_DX = "C3490";

/** cause 1, the event of interest */
const E_EVENTS: Array<[number, string]> = [
  [1, DAY_100],
  [4, DAY_400],
];
/** cause 2, the competing event — P2, retained in the later risk set at 2/3 */
const E_COMPETING: Array<[number, string]> = [
  [2, DAY_200],
];

/** P3 DISENROLLS at day 300. That is the censoring that moves G, and it is the
 *  entire reason this fixture exists. */
const E_ENROLL_END: Record<number, string> = { 3: DAY_300 };

export function fixtureESeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  const enroll = E_DRUG.map(
    ([id]) => `(${id}, DATE '2019-01-01', DATE '${E_ENROLL_END[id] ?? "2021-12-31"}', '1', '1', 1980, 40, '1', '1', '6', '1')`,
  ).join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
  );
  const drugs = E_DRUG.map(([id, ndc]) => `(${id}, DATE '${E_INDEX}', '${ndc}', 30, 30, 100)`).join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${drugs};`);
  const ev = [
    ...E_EVENTS.map(([id, d]) => `(${id}, DATE '${d}', '0', 'E119', NULL, NULL, NULL, NULL, NULL, '11', 200)`),
    ...E_COMPETING.map(([id, d]) => `(${id}, DATE '${d}', '0', '${COMPETING_DX}', NULL, NULL, NULL, NULL, NULL, '11', 200)`),
  ].join(",\n  ");
  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac,paytot) VALUES\n  ${ev};`,
  );
  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ('${NDC_X}','DRUG_X','BRAND_X'),('${NDC_Y}','DRUG_Y','BRAND_Y');`,
  );
  return lines.join("\n");
}

export const GOLD_E_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_E" };

export const GOLD_E_SPEC: StudySpec = {
  meta: {
    title: "Gold Case E — fractional IPCW weights",
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
    { id: "cr_dx", label: "Competing event (lung malignancy C34.90)", system: "icd10cm", codes: [{ code: "C34.90", source: "user_entered", verified: true }] },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "index_drug", indexPeriod: { start: "2020-01-01", end: "2020-12-31" } },
  /* followupDays is 90, NOT 365: P3 disenrolls at day 300 and must stay in the
   * cohort, because its censoring is what moves G. A 365-day requirement would
   * exclude the one subject this fixture is built around. */
  enrollment: { baselineDays: 365, followupDays: 90, gapAllowanceDays: 31, requiresRxCoverage: true },
  criteria: [
    {
      id: "c_cont", kind: "inclusion", sourceText: "Continuous enrollment 365d pre / 90d post index",
      test: { type: "continuous_enrollment", baselineDays: 365, followupDays: 90, requiresRxCoverage: true },
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
    { id: "e_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "e_fg", label: "Fine-Gray subdistribution model, fractional weights", kind: "fine_gray", enabled: true,
      endpoint: {
        kind: "claims_event",
        outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      },
      competingEvents: [{
        id: "cr_malignancy", label: "Lung malignancy",
        outcomeDefinition: { codeListId: "cr_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      }],
      washout: { start: -365, end: 0, includesIndex: true },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: 500 },
      groupVarId: "g_arm",
      covariateIds: ["b_age"],
    },
  ],
};

export const EXPECTED_E = {
  cohortN: 5,
  eventTimes: 2,
  eventsTotal: 2,
  eventsExposed: 1,
  /** 5 at day 100, plus 1 + 1 + 2/3 at day 400 */
  subdistributionRiskTotal: 5 + 8 / 3,
  /** a Cox model would use 5 and 2 */
  causeSpecificRiskTotal: 7,
  /** the retained competing-event subject's weighted contribution: exactly 2/3 */
  retained: 2 / 3,
  scoreU0: 0.025,
  information0: 0.474375,
  partialLogLik0: -2.59027,
  minusTwoLogLik0: 5.18053,
  scoreChiSquare: 0.00132,
  oneStepHr: 1.05411,
  oneStepSe: 1.45191,
  reject: 0,
  /** the weighted shares are 3/5 and 3/8, so the closed form does NOT apply */
  anchorApplies: false,
  eventShareExposed: 0.5,
} as const;
