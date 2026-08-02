/**
 * Gold Case I — DECLARED COARSENING, PROPENSITY-SCORE STRATIFICATION,
 * NEGATIVE CONTROLS and E-VALUES, on one cohort of eight.
 *
 * A separate seed, like B through H. Eight patients, one index date, and every
 * age chosen so that each of the four features moves a number that can be
 * checked by hand. EVERY value below was derived BEFORE the modules ran and is
 * written here as an exact fraction.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE COHORT. Index 2020-01-01 for all eight; DRUG_X is the TREATED arm
 * (referenceLevel is DRUG_Y), so P1-P4 are treated and P5-P8 are controls.
 * Age at index is 2020 - dobyr.
 *
 *   P1  X  49    P5  Y  49
 *   P2  X  50    P6  Y  50
 *   P3  X  59    P7  Y  40
 *   P4  X  60    P8  Y  45
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE COARSENING, and why these ages. Age is CONTINUOUS, so unbanded it is
 * refused: the saturated score is closed form only over categorical cells. The
 * primary banding cuts at 50 and 60, giving three bands plus an Unknown one,
 * left-closed and right-open:
 *
 *   <50        P1 | P5, P7, P8      1 treated, 3 control
 *   [50,60)    P2, P3 | P6          2 treated, 1 control
 *   >=60       P4 | -               1 treated, 0 control   <- ONE ARM ONLY
 *   Unknown    -  | -               empty
 *
 * P1 is 49 and P2 is 50: a REAL SUBJECT ON EACH SIDE of the first cut. P3 is 59
 * and P4 is 60: a real subject on each side of the second. Move either boundary
 * by one and both the score and the strata change, which is exactly what the
 * band-boundary mutation asserts.
 *
 * The >=60 band is a positivity violation that a BALANCE TABLE CANNOT SHOW: the
 * standardized difference in age is reported on the raw values and says nothing
 * about a band holding one arm. The occupancy rows are what say it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SATURATED SCORE over those bands, and the ATE weights on it:
 *
 *   cell <50      ps = 1/4     cell [50,60)  ps = 2/3     cell >=60  ps = 1
 *
 *   P1 w = 1/(1/4) = 4      P5, P7, P8 w = 1/(1-1/4) = 4/3
 *   P2, P3 w = 1/(2/3) = 3/2    P6 w = 1/(1-2/3) = 3
 *   P4 w = 1/1 = 1
 *
 *   SUM w (treated) = 4 + 3/2 + 3/2 + 1 = 8
 *   SUM w (control) = 4/3 x 3 + 3       = 7
 *
 * The gap of 1 IS P4: the treated pseudo-population is the membership of every
 * cell containing a treated subject (4+3+1), the control one of every cell
 * containing a control (4+3).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STRATIFICATION, and the two things it is here to prove.
 *
 * Distinct score values ascending, with how many subjects sit strictly below:
 *
 *   ps = 1/4  n = 4  below = 0  ->  stratum min(5, floor(0 x 5/8) + 1) = 1
 *   ps = 2/3  n = 3  below = 4  ->  stratum min(5, floor(4 x 5/8) + 1) = 3
 *   ps = 1    n = 1  below = 7  ->  stratum min(5, floor(7 x 5/8) + 1) = 5
 *
 *   K CANNOT BE FORMED: 5 requested, 3 formed. Boundaries fall BETWEEN distinct
 *   score values, and a saturated score over three cells has three of them.
 *   NTILE(5) would cut through the tied groups instead, and which subject landed
 *   where would depend on row order.
 *
 *   Stratum 5 holds P4 ALONE, treated, with no control. It has no contrast to
 *   estimate, so its contribution is NULL and it is excluded from the pool:
 *   1 subject dropped, 7 pooled.
 *
 * The pooled quantity is the adjusted difference in the declared balance
 * covariate (age) — this analysis declares no outcome:
 *
 *   stratum 1: 49/1 - (49+40+45)/3 = 49 - 134/3 = 13/3
 *   stratum 3: (50+59)/2 - 50/1    = 109/2 - 50 = 9/2
 *   stratum 5: NULL
 *
 *   pooled = [ (13/3)(4) + (9/2)(3) ] / 7 = (52/3 + 27/2) / 7 = (185/6)/7
 *          = 185/42 = 4.40476
 *
 * IF THE ONE-ARM STRATUM CONTRIBUTED 0 INSTEAD OF NULL its single subject would
 * enter the denominator and the answer would be (185/6)/8 = 185/48 = 3.85417.
 * That is the whole difference between "no estimate" and "an estimate of zero",
 * and it is why the mutation suite has a test for it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PRIMARY EFFECT (iptw_outcome, same banding, 365-day horizon).
 * Outcome events: P1 (treated, w = 4) and P6 (control, w = 3). No baseline
 * events, so the washout excludes nobody and the at-risk set is all eight.
 *
 *   mu1 = 4/8 = 1/2          mu0 = 3/7
 *   risk difference = 1/2 - 3/7 = 1/14
 *   RISK RATIO      = (1/2)/(3/7) = 7/6
 *   odds ratio      = (1/1)/(3/4) = 4/3
 *
 *   sandwich variances, Var(mu) = SUM w^2 (Y-mu)^2 / (SUM w)^2:
 *     v1 = [(16 + 9/4 + 9/4 + 1)(1/4)] / 64 = (43/8)/64 = 43/512
 *     v0 = [3(16/9)(9/49) + 9(16/49)] / 49 = (192/49)/49 = 192/2401
 *
 *   E-VALUE on the risk ratio, RR >= 1 so E = RR + sqrt(RR(RR-1)):
 *     E = 7/6 + sqrt((7/6)(1/6)) = 7/6 + sqrt(7)/6 = (7 + sqrt 7)/6 = 1.60763
 *
 *   THE INTERVAL CROSSES THE NULL. se(log RR) = sqrt(43/128 + 64/147) = 0.87824,
 *   so the 95% limits are 0.20863 and 6.52413. The limit E-value is therefore 1
 *   BY CONSTRUCTION — no confounding at all is needed — and the program must say
 *   the data are compatible with no effect rather than printing a bare 1 beside
 *   a point E-value of 1.61.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SAME OUTCOME BY STANDARDIZATION (g_formula), banded at 60 ALONE.
 *
 * This is the second banding on purpose: a WIDER band controls LESS, and the
 * two analyses on the same data show it. One cut gives two cells:
 *
 *   <60    P1, P2, P3 | P5, P6, P7, P8      m1 = 1/3, m0 = 1/4
 *   >=60   P4 | -                           undefined - RESTRICTED OUT
 *
 *   g1 = 1/3, g0 = 1/4, risk difference = 1/12, RISK RATIO = 4/3
 *   subjects in analysis = 7, excluded = 1 (P4, again)
 *
 *   E-VALUE = 4/3 + sqrt((4/3)(1/3)) = 4/3 + 2/3 = EXACTLY 2
 *
 *   AIPW influence functions (e = 3/7 in the one restricted cell):
 *     a1_i = 17/9 (P1), -4/9 (P2, P3), 1/3 (P5-P8)   -> a1 = 1/3 = g1
 *     a0_i = 1/4 (P1-P3), -3/16 (P5, P7, P8), 25/16 (P6) -> a0 = 1/4 = g0
 *     v1 = (294/81)/49 = 2/27      v0 = (588/256)/49 = 3/64      cov10 = 0
 *   The covariance is exactly zero here because every subject whose a1 deviates
 *   has a0 exactly at its mean and vice versa — a coincidence of this fixture,
 *   not an identity, and it is pinned as the value it takes.
 *
 *   Var(log RR) = v1/a1^2 + v0/a0^2 - 2 cov10/(a1 a0) = 2/3 + 3/4 = 17/12, so
 *   this interval crosses the null too.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS, threshold 1.25 (so the interval is [0.8, 1.25]).
 * Same cohort, same score, same ATE weights, no washout.
 *
 *   nc_fx   hip fracture       events P1 (w 4) | P5 (w 4/3)
 *           mu1 = 4/8 = 1/2, mu0 = (4/3)/7 = 4/21
 *           RR = (1/2)/(4/21) = 21/8 = 2.625      -> BREACH
 *
 *   nc_derm contact dermatitis events P2 (w 3/2) | P8 (w 4/3)
 *           mu1 = (3/2)/8 = 3/16, mu0 = 4/21
 *           RR = (3/16)/(4/21) = 63/64 = 0.984375 -> within
 *
 * ONE OF TWO BREACHES, on purpose. A suite in which every control passes proves
 * nothing about the harness: it cannot distinguish "the threshold test works"
 * from "the threshold is never evaluated".
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";
const NDC_Y = "00000000002";
/** the primary outcome, ICD-10-CM as it appears on a claim (dot-free) */
const DX_AE = "E119";
/** negative control A — a fracture. Chosen to BREACH. */
const DX_FX = "S720";
/** negative control B — contact dermatitis. Chosen to pass. */
const DX_DERM = "L309";
const POS_OFFICE = "11";

/** [enrolid, dobyr, arm NDC] — age at index is 2020 - dobyr. */
const I_MEMBERS: Array<[number, number, string]> = [
  [1, 1971, NDC_X],   // age 49  -> band <50
  [2, 1970, NDC_X],   // age 50  -> band [50,60)   ... the other side of the 50 cut
  [3, 1961, NDC_X],   // age 59  -> band [50,60)
  [4, 1960, NDC_X],   // age 60  -> band >=60      ... the other side of the 60 cut
  [5, 1971, NDC_Y],   // age 49
  [6, 1970, NDC_Y],   // age 50
  [7, 1980, NDC_Y],   // age 40
  [8, 1975, NDC_Y],   // age 45
];

/** [enrolid, dx code, service date] — all outpatient, all after index. */
const I_DX: Array<[number, string, string]> = [
  // PRIMARY outcome: one treated (P1, weight 4) and one control (P6, weight 3)
  [1, DX_AE, "2020-04-10"],
  [6, DX_AE, "2020-04-10"],
  // NEGATIVE CONTROL A: P1 treated, P5 control -> risk ratio 21/8, a BREACH
  [1, DX_FX, "2020-03-01"],
  [5, DX_FX, "2020-03-01"],
  // NEGATIVE CONTROL B: P2 treated, P8 control -> risk ratio 63/64, within
  [2, DX_DERM, "2020-05-01"],
  [8, DX_DERM, "2020-05-01"],
];

export function fixtureISeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];

  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ` +
      I_MEMBERS.map(([id, dobyr]) =>
        `(${id}, DATE '2018-01-01', DATE '2021-12-31', '1', '1', ${dobyr}, ${2020 - dobyr}, '1', '1', '6', '1')`,
      ).join(",\n  ") + `;`,
  );

  lines.push(
    `INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ` +
      I_MEMBERS.map(([id, , ndc]) => `(${id}, DATE '2020-01-01', '${ndc}', 30, 30, 100)`).join(",\n  ") + `;`,
  );

  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac,paytot) VALUES\n  ` +
      I_DX.map(([id, dx, day]) =>
        `(${id}, DATE '${day}', '0', '${dx}', NULL, NULL, NULL, NULL, NULL, '${POS_OFFICE}', 100)`,
      ).join(",\n  ") + `;`,
  );

  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ` +
      `('${NDC_X}','DRUG_X','BRAND_X'), ('${NDC_Y}','DRUG_Y','BRAND_Y');`,
  );
  return lines.join("\n");
}

export const GOLD_I_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_I" };

/** The cut points, in one place, so the fixture doc and the spec cannot drift. */
export const I_CUTS_PRIMARY = [50, 60];
export const I_CUTS_WIDE = [60];
export const I_BIAS_THRESHOLD = 1.25;

export const GOLD_I_SPEC: StudySpec = {
  meta: {
    title: "Gold Case I — declared coarsening, PS stratification, negative controls and E-values",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2018-01-01", end: "2021-12-31" },
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
    { id: "nc_fx_dx", label: "Hip fracture (S72.0)", system: "icd10cm", codes: [{ code: "S72.0", source: "user_entered", verified: true }] },
    { id: "nc_derm_dx", label: "Contact dermatitis (L30.9)", system: "icd10cm", codes: [{ code: "L30.9", source: "user_entered", verified: true }] },
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
  baseline: [
    { id: "b_age", label: "Age at index", kind: "age", dataType: "continuous" },
    { id: "b_sex", label: "Sex", kind: "sex", dataType: "binary" },
  ],
  outcomes: [],
  /* DRUG_Y is the reference, so DRUG_X is the treated arm. */
  groupVars: [
    { id: "g_arm", label: "Index drug", source: { kind: "exposure_cohort" }, levels: ["DRUG_X", "DRUG_Y"], referenceLevel: "DRUG_Y" },
  ],
  comparisons: [],
  analyses: [
    { id: "i_attrition", label: "Attrition", kind: "attrition", enabled: true },
    /* PROPENSITY-SCORE STRATIFICATION on a COARSENED continuous covariate.
     *
     * Two Wave-2 features at once, and deliberately: the strata are cut on a
     * score that only exists because age was banded, so a shifted band boundary
     * changes which strata form. The balance covariate is the RAW age, which is
     * the point — the score adjusts for the band, the balance table reports the
     * value, and the difference between them is the residual confounding a
     * coarsening leaves behind. */
    {
      id: "i_ps", label: "Propensity-score stratification on banded age", kind: "propensity_score", enabled: true,
      groupVarId: "g_arm",
      psCovariateIds: ["b_age"],
      bandings: [{ baselineId: "b_age", cutPoints: I_CUTS_PRIMARY }],
      balanceCovariateIds: ["b_age"],
      method: "stratification", estimand: "ate", stabilized: false, trim: 0,
    },
    /* THE WEIGHTED EFFECT, on the same coarsening, with an E-value. */
    {
      id: "i_iptw", label: "IPTW outcome model on banded age, with an E-value", kind: "iptw_outcome", enabled: true,
      groupVarId: "g_arm",
      psCovariateIds: ["b_age"],
      bandings: [{ baselineId: "b_age", cutPoints: I_CUTS_PRIMARY }],
      eValue: {},
      estimand: "ate", stabilized: false, trim: 0, doublyRobust: false,
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
    },
    /* THE SAME OUTCOME, STANDARDIZED OVER A WIDER BAND. One cut instead of two,
     * so ages 40 through 59 become a single covariate value: a wider band
     * controls less, and the two analyses on identical data are what make that
     * visible rather than asserted. */
    {
      id: "i_gform", label: "Standardization over a WIDER band, with an E-value", kind: "g_formula", enabled: true,
      groupVarId: "g_arm",
      covariateIds: ["b_age"],
      bandings: [{ baselineId: "b_age", cutPoints: I_CUTS_WIDE }],
      eValue: {},
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -365, end: 0, includesIndex: true },
      horizonDays: 365,
    },
    /* NEGATIVE CONTROLS through the SAME adjustment as i_iptw. One breaches its
     * declared threshold and one does not, because a suite in which every
     * control passes cannot tell a working test from an unevaluated one. */
    {
      id: "i_negctl", label: "Negative control outcomes", kind: "negative_control", enabled: true,
      groupVarId: "g_arm",
      covariateIds: ["b_age"],
      bandings: [{ baselineId: "b_age", cutPoints: I_CUTS_PRIMARY }],
      horizonDays: 365,
      biasThreshold: I_BIAS_THRESHOLD,
      controls: [
        {
          id: "nc_fx", label: "Hip fracture",
          outcomeDefinition: { codeListId: "nc_fx_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
          rationale: "Neither study drug acts on bone density, balance or falls risk, so neither can cause a hip fracture in the year after index. Frailty predicts both which drug is prescribed and fracture, so an association here is confounding rather than effect.",
        },
        {
          id: "nc_derm", label: "Contact dermatitis",
          outcomeDefinition: { codeListId: "nc_derm_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
          rationale: "Contact dermatitis is a skin reaction to an external agent with no pharmacologic pathway from either study drug, and no shared care pathway that would bring it to attention differentially by arm.",
        },
      ],
    },
  ],
};

export const EXPECTED_I = {
  cohortN: 8,

  /* ---- the coarsening, primary banding (cuts 50/60) ---- */
  bandLabels: ["<50", "[50,60)", ">=60", "Unknown"],
  /** occupancy by arm, in band order: [treated, control] */
  bandOccupancy: [[1, 3], [2, 1], [1, 0], [0, 0]] as Array<[number, number]>,
  bandsDeclared: 4,
  bandsWithOneArm: 1,

  /* ---- the score and its weights ---- */
  nCells: 3,
  minScore: 0.25,
  maxScore: 1,
  subjectsOffSupport: 1,
  pseudoTreated: 8,
  pseudoControl: 7,
  pseudoGap: 1,

  /* ---- stratification ---- */
  strataRequested: 5,
  strataFormed: 3,
  strataOneArm: 1,
  subjectsPooled: 7,
  subjectsDropped: 1,
  /** (185/6)/7 = 185/42 */
  stratifiedDifference: 4.40476,
  /** what pooling a one-arm stratum as ZERO would have given: (185/6)/8 */
  stratifiedDifferenceIfZeroPooled: 3.85417,
  /** (46 - 54.5) / sqrt((62/3 + 101/3)/2) = -8.5 / sqrt(163/6) */
  ageSmdUnweighted: -1.63080,

  /* ---- the IPTW effect ---- */
  iptw: {
    analysisSetN: 8,
    offSupport: 1,
    identified: 0,
    riskTreated: 0.5,          // 1/2
    riskControl: 0.42857,      // 3/7
    riskDifference: 0.07143,   // 1/14
    riskRatio: 1.16667,        // 7/6
    oddsRatio: 1.33333,        // 4/3
    seTreated: 0.28980,        // sqrt(43/512)
    seControl: 0.28278,        // sqrt(192/2401)
    rdSe: 0.40491,             // sqrt(43/512 + 192/2401)
    /** E = 7/6 + sqrt(7)/6 = (7 + sqrt 7)/6 */
    eValue: 1.60763,
    /** the interval crosses the null, so the limit E-value is 1 by construction */
    limitEValue: 1,
    rrCi: [0.20863, 6.52413] as [number, number],
  },

  /* ---- the g-formula, on the WIDER band ---- */
  gform: {
    cellsTotal: 2,
    cellsWithBothArms: 1,
    subjectsInAnalysis: 7,
    subjectsExcluded: 1,
    g1: 0.33333,               // 1/3
    g0: 0.25,                  // 1/4
    riskDifference: 0.08333,   // 1/12
    riskRatio: 1.33333,        // 4/3
    /** E = 4/3 + sqrt((4/3)(1/3)) = 4/3 + 2/3 = 2 EXACTLY */
    eValue: 2,
    limitEValue: 1,
    aipwV1: 0.07407,           // 2/27
    aipwV0: 0.046875,          // 3/64
    /** sqrt(2/27 + 3/64) = sqrt(209/1728) */
    aipwRdSe: 0.34778,
    /** wider band, so this analysis keeps ages 40-59 in ONE cell */
    bandsDeclared: 3,
    bandsWithOneArm: 1,
  },

  /* ---- negative controls ---- */
  negctl: {
    threshold: I_BIAS_THRESHOLD,
    controlsTested: 2,
    controlsBreaching: 1,
    /** (1/2) / (4/21) = 21/8 */
    fxRiskRatio: 2.625,
    fxBreaches: 1,
    /** (3/16) / (4/21) = 63/64 */
    dermRiskRatio: 0.98438,
    dermBreaches: 0,
    offSupport: 1,
  },

  /** The E-value closed form, applied to literal ratios by the SAME expression
   *  the emitters write. Covers both branches of the formula and all three
   *  branches of the nearest-the-null selection, which the eight-patient cohort
   *  cannot reach on its own (every interval it produces crosses the null).
   *  [rr, lo, hi, expected E, expected nearest limit] */
  eValueTable: [
    // RR = 2:   E = 2 + sqrt(2 x 1) = 2 + sqrt2
    { rr: 2, lo: 1.5, hi: 3, e: 3.41421, nearest: 1.5 },
    // RR = 0.5: 1/RR = 2, so the SAME E — the measure is symmetric about the null
    { rr: 0.5, lo: 0.3, hi: 0.7, e: 3.41421, nearest: 0.7 },
    // RR = 1.2: E = 1.2 + sqrt(1.2 x 0.2) = 1.2 + sqrt(0.24)
    { rr: 1.2, lo: 0.8, hi: 2, e: 1.68990, nearest: null },
    // RR exactly at the null: E = 1 + sqrt(0) = 1
    { rr: 1, lo: 0.9, hi: 1.1, e: 1, nearest: null },
  ] as Array<{ rr: number; lo: number; hi: number; e: number; nearest: number | null }>,
} as const;
