/**
 * Gold Case C — TIED EVENT TIMES.
 *
 * A separate SEED, like Gold Case B, and for the same reason: Gold Case A is
 * frozen, and every number in it moves if a patient is added.
 *
 * WHAT THIS CASE EXISTS TO EXERCISE, and what A and B structurally cannot. On
 * both existing fixtures every subject fails on a different day, so every risk
 * set drops exactly one member. That makes three separate pieces of arithmetic
 * unreachable by execution:
 *
 *   1. The Kaplan-Meier factor (n - d)/n reduces to (n - 1)/n, so a version
 *      that had hard-coded 1 would pass.
 *   2. The log-rank variance carries a (n - d)/(n - 1) TIE CORRECTION which is
 *      exactly 1 whenever d = 1. Deleting it changes no number on A or B. It is
 *      fingerprinted in both twins precisely because no fixture could reach it —
 *      and a fingerprint proves the code says something, not that it is right.
 *   3. Cox's Breslow information and the log-rank variance are EQUAL when there
 *      are no ties and DIFFER when there are. Gold A therefore cannot tell a
 *      correct Cox information from one that reused the log-rank variance.
 *
 * Here, two subjects — one per arm — fail on the SAME day. All three become
 * observable, and (3) becomes a hard number: log-rank V = 13/20 = 0.65 against
 * Cox I(0) = 3/4 = 0.75. On Gold Case A those two are the same value.
 *
 * AND ONE MORE THING, which was not the original point. The risk-set exposure
 * proportion here is 1/2 at BOTH event times, and under a constant proportion
 * the Cox partial likelihood collapses to a binomial with a CLOSED-FORM
 * maximum. So this fixture has an exact Cox coefficient — beta = -ln 2, hazard
 * ratio 0.5 — which makes it the only place the fitted coefficient is checkable
 * against anything but itself. See emitters/cox-core.ts.
 *
 * Ground truth, hand-derived (all confirmed by execution):
 *   6 subjects, index 2020-01-01, none washed out, all followed to day 365
 *     DRUG_X (reference)  P1 event d100, P3 event d200, P4 censored d365
 *     DRUG_Y (exposed)    P2 event d100, P5 and P6 censored d365
 *
 *   Kaplan-Meier, Overall:
 *     t=100  n=6 d=2  S = 4/6 = 2/3     Greenwood 2/(6*4) = 1/12
 *     t=200  n=4 d=1  S = 2/3 * 3/4 = 1/2   +1/(4*3) -> 1/6
 *   The d=2 factor is the point: a life table that dropped one member per event
 *   time would report 5/6 here.
 *
 *   Log-rank, accumulated for the exposed arm:
 *     t=100  n=6 n1=3 d=2 d1=1  E = 1     V = 2*4*3*3/(36*5) = 2/5
 *     t=200  n=4 n1=2 d=1 d1=0  E = 1/2   V = 1*3*2*2/(16*3) = 1/4
 *     O = 1, E = 3/2, V = 13/20, chi^2 = (1/4)/(13/20) = 5/13 = 0.38462
 *
 *   Cox at beta = 0 (Breslow):
 *     U(0) = O - E = -1/2          (the SCORE is the same statistic)
 *     I(0) = 2*(1/2)(1/2) + 1*(1/2)(1/2) = 3/4    NOT 13/20
 *     score chi^2 = (1/4)/(3/4) = 1/3 = 0.33333, against the log-rank 0.38462
 *     partial logL(0) = -(2 ln 6 + ln 4) = -4.96981, so -2logL(0) = 9.93963
 *     one-step beta = U/I = -2/3, HR = 0.51342
 *     MLE beta = -ln 2 EXACTLY (constant risk-set proportion), HR = 0.5
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";
const NDC_Y = "00000000002";

/** enrolid -> arm NDC. P1/P3/P4 reference, P2/P5/P6 exposed. */
const C_DRUG: Array<[number, string]> = [
  [1, NDC_X], [3, NDC_X], [4, NDC_X],
  [2, NDC_Y], [5, NDC_Y], [6, NDC_Y],
];

/** Index 2020-01-01. 2020 is a leap year, so day 100 is 10 April and day 200
 *  is 19 July — worth stating, because an off-by-one here would move every
 *  survival time and still look like a plausible curve. */
const C_INDEX = "2020-01-01";
const DAY_100 = "2020-04-10";
const DAY_200 = "2020-07-19";

/** Qualifying OUTPATIENT events (E11.9). P1 and P2 share DAY_100 — the tie. */
const C_EVENTS: Array<[number, string]> = [
  [1, DAY_100],
  [2, DAY_100], // <- the TIE, and the whole reason this fixture exists
  [3, DAY_200],
];

/** Full seed SQL for Gold Case C (same DDL as A and B, entirely different data). */
export function fixtureCSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  // Enrollment spans the whole study period for everyone: this case is about
  // event TIMING, so no member is allowed to fail continuous enrollment or to
  // censor early for a reason other than the follow-up cap.
  const enroll = C_DRUG.map(
    ([id]) => `(${id}, DATE '2019-01-01', DATE '2021-12-31', '1', '1', 1980, 40, '1', '1', '6', '1')`,
  ).join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
  );
  const drugs = C_DRUG.map(([id, ndc]) => `(${id}, DATE '${C_INDEX}', '${ndc}', 30, 30, 100)`).join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${drugs};`);
  const ev = C_EVENTS.map(
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

export const GOLD_C_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_C" };

const C_ENDPOINT = {
  kind: "claims_event" as const,
  outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient" as const, diagnosisPosition: "any" as const },
};
const C_WASHOUT = { start: -365, end: 0, includesIndex: true } as const;
const C_CLOCK = {
  start: "index" as const,
  censorAt: ["outcome", "disenrollment", "study_end", "max_followup"] as Array<"outcome" | "disenrollment" | "death" | "study_end" | "max_followup">,
  maxFollowupDays: 365,
};

export const GOLD_C_SPEC: StudySpec = {
  meta: {
    title: "Gold Case C — tied event times",
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
    { id: "c_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "c_km", label: "Time to incident AE, by arm (tied event times)", kind: "survival", enabled: true,
      endpoint: C_ENDPOINT, washout: C_WASHOUT, personTimeRule: C_CLOCK,
      horizonDays: [90, 365], ciMethod: "log_log", groupVarId: "g_arm", emitLifeTable: true,
    },
    {
      id: "c_cox", label: "Cox proportional hazards, X vs Y (tied event times)", kind: "cox", enabled: true,
      endpoint: C_ENDPOINT, washout: C_WASHOUT, personTimeRule: C_CLOCK,
      groupVarId: "g_arm", covariateIds: ["b_age"], ties: "breslow",
    },
  ],
};

export const EXPECTED_C = {
  cohortN: 6,
  atRisk: 6,
  /** survival, Overall — the d=2 factor is what Gold A cannot reach */
  km: {
    overall: [
      { t: 100, nRisk: 6, nEvent: 2, surv: 0.66667, se: 0.19245, ci: [0.19461, 0.90444] as [number, number] },
      { t: 200, nRisk: 4, nEvent: 1, surv: 0.5, se: 0.20412, ci: [0.11094, 0.80371] as [number, number] },
    ],
    /** both arms lose a member to the SAME event time, which is the tie */
    tiedEventTime: 100,
    medianOverall: 200,
    medianX: 200,
    medianY: null,
  },
  /** log-rank, with the tie correction ACTIVE: (n-d)/(n-1) is 4/5 at t=100 */
  logRank: { observed: 1, expected: 1.5, variance: 0.65, chiSquare: 0.38462 },
  /** Cox at beta = 0. The score is the SAME statistic as the log-rank numerator;
   *  the INFORMATION is not the log-rank variance once a tie exists. */
  cox: {
    score: -0.5,
    information: 0.75,
    logRankVariance: 0.65, // deliberately different — that is the finding
    scoreChiSquare: 0.33333,
    partialLogLik0: -4.96981,
    minusTwoLogLik0: 9.93963,
    tiedEventTimes: 1,
    oneStepBeta: -0.66667,
    oneStepHr: 0.51342,
    oneStepSe: 1.15470,
    /** THE ANCHOR. Every risk set here is half exposed, and under a constant
     *  exposure proportion the partial likelihood collapses to a binomial whose
     *  maximum is closed form: HR = [q/(1-q)] / [p/(1-p)] with p = 1/2 the share
     *  at risk exposed and q = 1/3 the share of events exposed. */
    riskSetProportion: 0.5,
    eventShareExposed: 0.33333,
    closedFormHr: 0.5,
    closedFormBeta: -0.69315,
  },
} as const;
