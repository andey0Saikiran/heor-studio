/**
 * Gold Case D — COMPETING RISKS.
 *
 * A separate SEED, like B and C. Gold Case A is frozen.
 *
 * WHAT THIS CASE EXISTS TO EXERCISE. On A, B and C every event is the same
 * kind of event, so the cumulative incidence function and the naive 1 - KM are
 * the SAME NUMBER — Gold A's cause-1 CIF is 3/8, and so is its 1 - KM, and so
 * is the cumulative-incidence module's naive risk. Three modules agreeing there
 * proves the degenerate case and nothing else: a CIF implementation that had
 * quietly built PER-CAUSE risk sets, which is the standard way to get this
 * wrong, would agree with all of them.
 *
 * Here one subject fails from a competing cause, and the two estimators come
 * apart by an exact fraction.
 *
 * Ground truth, hand-derived (all confirmed by execution):
 *   6 subjects, index 2020-01-01, no washout exclusions, followed to day 365
 *     P1 cause 1 (interest)  d100      P4 censored d365
 *     P2 cause 2 (competing) d200      P5 censored d365
 *     P3 cause 1 (interest)  d300      P6 censored d365
 *
 *   ALL-CAUSE Kaplan-Meier — the weight Aalen-Johansen applies:
 *     t=100  n=6 d=1  S = 5/6
 *     t=200  n=5 d=1  S = 5/6 * 4/5 = 2/3
 *     t=300  n=4 d=1  S = 2/3 * 3/4 = 1/2
 *
 *   CIF_1 = S(t_prev) * d_1 / n, accumulated:
 *     t=100  1 * 1/6           = 1/6
 *     t=300  + (2/3) * 1/4     = 1/3
 *   CIF_2:
 *     t=200  (5/6) * 1/5       = 1/6
 *
 *   THE PARTITION IDENTITY: 1/3 + 1/6 = 1/2 = 1 - S(300). Exactly.
 *
 *   THE BIAS, which is the whole point:
 *     naive 1-KM cause 1 = 3/8   vs CIF 1/3   ->  OVERSTATED by 1/24
 *     naive 1-KM cause 2 = 1/5   vs CIF 1/6   ->  OVERSTATED by 1/30
 *
 *   AND THE PATHOLOGY: the naive complements sum to 3/8 + 1/5 = 23/40 = 0.575,
 *   against a true total event probability of 1/2. Two mutually exclusive
 *   outcomes whose probabilities add up to more than the probability of either
 *   happening. That is not rounding, and the module reports it as a row.
 *
 *   Aalen-Johansen delta-method variance:
 *     Var(CIF_1) = 1/27   = 0.037037037,  se = 0.19245
 *     Var(CIF_2) = 5/216  = 0.023148148,  se = 0.15215
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";
const NDC_Y = "00000000002";

/** Two arms so the CIF can be reported per stratum as well as overall. */
const D_DRUG: Array<[number, string]> = [
  [1, NDC_X], [2, NDC_X], [3, NDC_X],
  [4, NDC_Y], [5, NDC_Y], [6, NDC_Y],
];

const D_INDEX = "2020-01-01";
/** 2020 is a leap year: day 100 is 10 April, day 200 is 19 July, day 300 is
 *  27 October. Worth stating — an off-by-one here moves every weight in the
 *  accumulation and still produces a perfectly plausible curve. */
const DAY_100 = "2020-04-10";
const DAY_200 = "2020-07-19";
const DAY_300 = "2020-10-27";

/** The EVENT OF INTEREST (E11.9, outpatient). */
const D_EVENTS: Array<[number, string]> = [
  [1, DAY_100],
  [3, DAY_300],
];

/** The COMPETING event — a different diagnosis, its own code list. It is what
 *  makes P2 unable to ever have the event of interest, which is the fact
 *  Kaplan-Meier cannot represent. */
const COMPETING_DX = "C3490"; // lung malignancy, a plausible competing cause
const D_COMPETING: Array<[number, string]> = [
  [2, DAY_200],
];

export function fixtureDSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  const enroll = D_DRUG.map(
    ([id]) => `(${id}, DATE '2019-01-01', DATE '2021-12-31', '1', '1', 1980, 40, '1', '1', '6', '1')`,
  ).join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
  );
  const drugs = D_DRUG.map(([id, ndc]) => `(${id}, DATE '${D_INDEX}', '${ndc}', 30, 30, 100)`).join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${drugs};`);
  const ev = [
    ...D_EVENTS.map(([id, d]) => `(${id}, DATE '${d}', '0', 'E119', NULL, NULL, NULL, NULL, NULL, '11', 200)`),
    ...D_COMPETING.map(([id, d]) => `(${id}, DATE '${d}', '0', '${COMPETING_DX}', NULL, NULL, NULL, NULL, NULL, '11', 200)`),
  ].join(",\n  ");
  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac,paytot) VALUES\n  ${ev};`,
  );
  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ('${NDC_X}','DRUG_X','BRAND_X'),('${NDC_Y}','DRUG_Y','BRAND_Y');`,
  );
  return lines.join("\n");
}

export const GOLD_D_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_D" };

const D_OUTCOME = { codeListId: "ae_dx", minClaims: 1, setting: "outpatient" as const, diagnosisPosition: "any" as const };
const D_COMPETING_OUTCOME = { codeListId: "cr_dx", minClaims: 1, setting: "outpatient" as const, diagnosisPosition: "any" as const };
const D_WASHOUT = { start: -365, end: 0, includesIndex: true } as const;
const D_CLOCK = {
  start: "index" as const,
  censorAt: ["outcome", "disenrollment", "study_end", "max_followup"] as Array<"outcome" | "disenrollment" | "death" | "study_end" | "max_followup">,
  maxFollowupDays: 365,
};

export const GOLD_D_SPEC: StudySpec = {
  meta: {
    title: "Gold Case D — competing risks",
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
    { id: "d_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "d_cif", label: "Cumulative incidence of AE with a competing risk", kind: "competing_risks", enabled: true,
      endpoint: { kind: "claims_event", outcomeDefinition: D_OUTCOME },
      competingEvents: [{ id: "cr_malignancy", label: "Lung malignancy", outcomeDefinition: D_COMPETING_OUTCOME }],
      washout: D_WASHOUT,
      personTimeRule: D_CLOCK,
      horizonDays: [150, 365],
      emitNaiveComparison: true,
      emitLifeTable: true,
    },
  ],
};

export const EXPECTED_D = {
  cohortN: 6,
  atRisk: 6,
  /** all-cause Kaplan-Meier, the weight the estimator applies */
  survAll: [
    { t: 100, nRisk: 6, dAll: 1, surv: 0.83333 },
    { t: 200, nRisk: 5, dAll: 1, surv: 0.66667 },
    { t: 300, nRisk: 4, dAll: 1, surv: 0.5 },
  ],
  cif: {
    /** the event of interest */
    interest: { at100: 0.16667, at300: 0.33333, variance: 0.03704, se: 0.19245 },
    /** the competing event */
    competing: { at200: 0.16667, at300: 0.16667, variance: 0.02315, se: 0.15215 },
  },
  /** SUM_k CIF_k(t) = 1 - S(t), exactly, at every t */
  identity: { sumCif: 0.5, oneMinusSurv: 0.5 },
  /** the number this module exists to produce */
  naive: {
    interest: 0.375,   // 3/8
    competing: 0.2,    // 1/5
    biasInterest: 0.04167,   // 1/24
    biasCompeting: 0.03333,  // 1/30
    /** 23/40 against a true 1/2 — two mutually exclusive outcomes whose
     *  probabilities sum above the probability of either happening */
    naiveSum: 0.575,
  },
  horizons: {
    /** day 150 falls between the first and second event: only P1 has failed */
    150: { interest: 0.16667, competing: 0 },
    365: { interest: 0.33333, competing: 0.16667 },
  },
} as const;
