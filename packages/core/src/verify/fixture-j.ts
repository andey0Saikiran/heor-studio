/**
 * Gold Case J — NEGATIVE INDEX WEIGHTS, THE ICD-9/ICD-10 TRANSITION, and
 * DECLARED SUBGROUP + SENSITIVITY SWEEPS, on one cohort of sixteen.
 *
 * A separate seed, like B through I. EVERY value below was derived by hand
 * BEFORE the modules ran, and is written here as an exact fraction wherever
 * one exists.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE COHORT. Index 2016-01-04 for all sixteen — chosen so a 365-day lookback
 * reaches back to 2015-01-04 and CROSSES 1 October 2015. DRUG_X is the exposed
 * arm (referenceLevel is DRUG_Y). Everyone is enrolled 2015-01-01 to
 * 2017-12-31, so continuous enrollment never excludes anyone and every number
 * below is a property of the analysis rather than of the spine.
 *
 *   exposed  DRUG_X   P1 P2 P3 P4 (female)   P5 P6 P7 P8 (male)
 *   control  DRUG_Y   P9 P10 P11 P12 (female) P13 P14 P15 P16 (male)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PART A — A VAN-WALRAVEN-STYLE INDEX WITH NEGATIVE WEIGHTS.
 *
 * Five conditions. Two carry NEGATIVE weights, which is what van Walraven's
 * Elixhauser summary actually does (drug abuse -7, depression -3): conditioned
 * on everything else in the index, those patients really do die less. One
 * supersession pair, the Elixhauser one — metastatic cancer replaces solid
 * tumour without metastasis.
 *
 *   chf   Congestive heart failure           +7
 *   mets  Metastatic cancer                 +12   supersedes tumr
 *   tumr  Solid tumour without metastasis    +4
 *   drug  Drug abuse                         -7
 *   depr  Depression                         -3
 *
 * Every code list carries BOTH eras, because the lookback crosses the
 * transition and a code only ever matches claims from its own era. The planted
 * claims deliberately split across the boundary, so an era that stopped
 * matching would move a number:
 *
 *   P1  chf   ICD-9  428.0  on 2015-06-01     -> score  7
 *   P2  tumr  ICD-9  174.9  on 2015-06-15
 *       mets  ICD-10 C78.00 on 2015-11-15     -> score 12, NOT 16
 *   P3  drug  ICD-9  304.90 on 2015-07-01
 *       depr  ICD-10 F32.9  on 2015-12-01     -> score -10   <- NEGATIVE TOTAL
 *   P4  depr  ICD-9  311    on 2015-07-15     -> score -3
 *   P5  chf   ICD-10 I50.9  on 2015-11-01
 *       depr  ICD-10 F32.9  on 2015-12-15     -> score  4
 *   P6..P16                                   -> score  0  (eleven members)
 *
 * P2 IS THE SUPERSESSION CASE. mets(12) supersedes tumr(4), so tumr's WEIGHT is
 * withheld and P2 scores 12 rather than 16 — while tumr's PREVALENCE still
 * reports 1. Suppressing the prevalence too would hide a real clinical fact
 * behind a scoring convention.
 *
 * chf's prevalence of 2 is the ERA CHECK: P1 is ascertained through an ICD-9
 * claim and P5 through an ICD-10 one, so a broken era branch reports 1.
 *
 *   sum of scores = 7 + 12 - 10 - 3 + 4 = 10 over 16 members
 *   MEAN   = 10/16 = 0.625
 *   MEDIAN = 0        (sorted, positions 8 and 9 are both zeros)
 *   MAX    = 12
 *   SD (sample) = sqrt(311.75 / 15) = sqrt(20.783333...) = 4.55887
 *     deviations from 0.625: 112.890625 + 13.140625 + 11.390625 + 40.640625
 *                          + 129.390625 + 11 x 0.390625 = 311.75
 *
 * SCORE BANDS [-10, 0, 7] -> "-10 to -1", "0-6", "7+". This is the whole reason
 * readiness now checks the band floor: the band CASE is a descending ladder
 * with the FIRST band as its ELSE arm, so bands starting at 0 would have put
 * P3's -10 inside the band LABELLED 0 — a clamp at zero in the distribution
 * while the stored score stayed correct.
 *
 *   "-10 to -1"  P3 (-10), P4 (-3)            = 2
 *   "0-6"        P5 (4) and the eleven zeros  = 12
 *   "7+"         P1 (7), P2 (12)              = 2
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PART B, SWEEP 1 — THE DIRECTION FLIP, on a logistic regression.
 *
 * Outcome AE (E11.9) claims dated 2016-06-01, inside the 365-day horizon:
 *   exposed: P1, P5, P6, P7, P8      control: P9, P10, P11, P13
 * Plus two PRE-index AE claims dated 2015-01-02, on P5 and P13. Index minus 365
 * days is 2015-01-04, so those two claims sit OUTSIDE the declared washout and
 * INSIDE a 730-day one — which is the only thing the second arm changes.
 *
 * Three arms, all declared in the spec before any of these numbers existed:
 *
 *   base  SENSITIVITY washout_days = 365   <- PRIMARY (the protocol's own value,
 *                                              so the primary arm runs through
 *                                              the identical machinery)
 *         at-risk 16.  a=5 b=3 c=4 d=4
 *         OR = (5 x 4) / (3 x 4) = 20/12 = 5/3   = 1.66667
 *
 *   w730  SENSITIVITY washout_days = 730
 *         P5 and P13 are now prevalent and excluded; at-risk 14.
 *         a=4 b=3 c=3 d=4
 *         OR = (4 x 4) / (3 x 3) = 16/9          = 1.77778
 *
 *   fem   SUBGROUP Sex = Female (P1-P4 exposed, P9-P12 control), washout 365
 *         a=1 b=3 c=3 d=1
 *         OR = (1 x 1) / (3 x 3) = 1/9           = 0.11111
 *
 * THE FEMALE ARM IS ON THE OTHER SIDE OF THE NULL. Two arms above 1, one below
 * it, so the direction-disagreement verdict fires: an effect whose sign flips
 * under a different analysis choice is not robust under any threshold. This is
 * Simpson's paradox built on purpose — the men carry the overall association
 * and the women reverse it — and it is why the sweep contract exists.
 *
 *   range: min 1/9 = 0.11111, max 16/9 = 1.77778, span 15/9 = 5/3 = 1.66667
 *   arms above the null 2, below 1, direction_disagreement = 1
 *   familywise error if uncorrected = 1 - 0.95^3 = 0.142625 -> 0.14263
 *   arm_n: base 16, w730 16 (the arm COHORT is the whole cohort; the washout
 *          excludes inside the analysis, and the arm's own design rows show it),
 *          fem 8
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PART B, SWEEP 2 — A TARGET WITH NO NULL VALUE, on the index above.
 *
 * A mean score is a LEVEL, not a contrast: it has no null, so there is no
 * direction to agree or disagree about and the program says exactly that
 * instead of inventing a reference point. Both branches of the sweep emitter
 * are therefore executed by this fixture rather than one of them assumed.
 *
 *   lb365  SENSITIVITY lookback_days = 365   <- PRIMARY.  mean = 10/16 = 0.625
 *
 *   lb120  SENSITIVITY lookback_days = 120
 *          The window becomes [2015-09-06, 2016-01-04], which keeps only the
 *          later claims: P2's mets, P3's depr, P5's chf and depr.
 *          scores 0, 12, -3, 0, 4 and eleven zeros -> sum 13
 *          mean = 13/16 = 0.8125
 *          A SHORTER LOOKBACK RAISED THE MEAN, because what it dropped was
 *          P1's +7 and P3's -7 and P4's -3 — a net +3 removed. With only
 *          positive weights a shorter lookback can never raise the index; with
 *          negative ones it can, which is precisely the behaviour the wave was
 *          written to make visible.
 *
 *   fem    SUBGROUP Sex = Female, lookback 365
 *          P1 7, P2 12, P3 -10, P4 -3, P9-P12 zero -> sum 6 over 8
 *          mean = 6/8 = 0.75
 *
 *   range: min 0.625, max 0.8125, span 0.1875; direction verdict NOT claimed
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";
const NDC_Y = "00000000002";
/** the outcome, ICD-10-CM as it appears on a claim (dot-free) */
const DX_AE = "E119";
const POS_OFFICE = "11";

/** [enrolid, arm NDC, sex] — sex '1' Male, '2' Female. */
const J_MEMBERS: Array<[number, string, string]> = [
  [1, NDC_X, "2"], [2, NDC_X, "2"], [3, NDC_X, "2"], [4, NDC_X, "2"],
  [5, NDC_X, "1"], [6, NDC_X, "1"], [7, NDC_X, "1"], [8, NDC_X, "1"],
  [9, NDC_Y, "2"], [10, NDC_Y, "2"], [11, NDC_Y, "2"], [12, NDC_Y, "2"],
  [13, NDC_Y, "1"], [14, NDC_Y, "1"], [15, NDC_Y, "1"], [16, NDC_Y, "1"],
];

/** [enrolid, dxver, claim code (dot-free), service date] */
const J_DX: Array<[number, string, string, string]> = [
  /* ---- the outcome, inside the 365-day horizon ---- */
  [1, "0", DX_AE, "2016-06-01"],
  [5, "0", DX_AE, "2016-06-01"],
  [6, "0", DX_AE, "2016-06-01"],
  [7, "0", DX_AE, "2016-06-01"],
  [8, "0", DX_AE, "2016-06-01"],
  [9, "0", DX_AE, "2016-06-01"],
  [10, "0", DX_AE, "2016-06-01"],
  [11, "0", DX_AE, "2016-06-01"],
  [13, "0", DX_AE, "2016-06-01"],
  /* ---- PRE-index outcome, OUTSIDE a 365-day washout, INSIDE a 730-day one.
         Index - 365 = 2015-01-04, index - 730 = 2014-01-04. ---- */
  [5, "9", "25000", "2015-01-02"],
  [13, "9", "25000", "2015-01-02"],
  /* ---- the comorbidity claims, deliberately split across 1 Oct 2015 ---- */
  [1, "9", "4280", "2015-06-01"],     // chf, ICD-9
  [2, "9", "1749", "2015-06-15"],     // tumr, ICD-9
  [2, "0", "C7800", "2015-11-15"],    // mets, ICD-10
  [3, "9", "30490", "2015-07-01"],    // drug, ICD-9
  [3, "0", "F329", "2015-12-01"],     // depr, ICD-10
  [4, "9", "311", "2015-07-15"],      // depr, ICD-9
  [5, "0", "I509", "2015-11-01"],     // chf, ICD-10
  [5, "0", "F329", "2015-12-15"],     // depr, ICD-10
];

export function fixtureJSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];

  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ` +
      J_MEMBERS.map(([id, , sex]) =>
        `(${id}, DATE '2015-01-01', DATE '2017-12-31', '1', '1', 1970, 46, '${sex}', '1', '6', '1')`,
      ).join(",\n  ") + `;`,
  );

  lines.push(
    `INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ` +
      J_MEMBERS.map(([id, ndc]) => `(${id}, DATE '2016-01-04', '${ndc}', 30, 30, 100)`).join(",\n  ") + `;`,
  );

  lines.push(
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,proctyp,stdplac,paytot) VALUES\n  ` +
      J_DX.map(([id, ver, dx, day]) =>
        `(${id}, DATE '${day}', '${ver}', '${dx}', NULL, NULL, NULL, NULL, NULL, '${POS_OFFICE}', 100)`,
      ).join(",\n  ") + `;`,
  );

  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ` +
      `('${NDC_X}','DRUG_X','BRAND_X'), ('${NDC_Y}','DRUG_Y','BRAND_Y');`,
  );
  return lines.join("\n");
}

export const GOLD_J_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_J" };

/** Declared in one place so the fixture doc, the spec and the assertions cannot
 *  drift apart. */
export const J_SCORE_BANDS = [-10, 0, 7];
export const J_WASHOUT_PRIMARY = 365;
export const J_WASHOUT_LONG = 730;
export const J_LOOKBACK_PRIMARY = 365;
export const J_LOOKBACK_SHORT = 120;

export const GOLD_J_SPEC: StudySpec = {
  meta: {
    title: "Gold Case J — negative index weights, the ICD transition, and declared sweeps",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2015-01-01", end: "2017-12-31" },
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
      id: "ae_dx", label: "AE (T2DM)", system: "icd10cm",
      /* BOTH eras, because the washout arms reach back into 2015: 250.00 is the
       * ICD-9 spelling and E11.9 the ICD-10 one. The pre-index claims are dated
       * 2015-01-02 and carry DXVER '9', so they only match through the ICD-9
       * member of this list. */
      codes: [
        { code: "E11.9", source: "user_entered", verified: true },
        { code: "250.00", source: "user_entered", verified: true },
      ],
    },
    /* Every condition list carries BOTH eras. The lookback crosses 1 Oct 2015,
     * and a single-era list there is refused by readiness — see the
     * readiness-only clone in verify/run.ts, which proves the refusal fires. */
    {
      id: "cci_chf", label: "Congestive heart failure", system: "icd10cm",
      codes: [
        { code: "428.0", source: "user_entered", verified: true },
        { code: "I50.9", source: "user_entered", verified: true },
      ],
    },
    {
      id: "cci_mets", label: "Metastatic cancer", system: "icd10cm",
      codes: [
        { code: "196.9", source: "user_entered", verified: true },
        { code: "C78.00", source: "user_entered", verified: true },
      ],
    },
    {
      id: "cci_tumr", label: "Solid tumour without metastasis", system: "icd10cm",
      codes: [
        { code: "174.9", source: "user_entered", verified: true },
        { code: "C50.919", source: "user_entered", verified: true },
      ],
    },
    {
      id: "cci_drug", label: "Drug abuse", system: "icd10cm",
      codes: [
        { code: "304.90", source: "user_entered", verified: true },
        { code: "F19.20", source: "user_entered", verified: true },
      ],
    },
    {
      id: "cci_depr", label: "Depression", system: "icd10cm",
      codes: [
        { code: "311", source: "user_entered", verified: true },
        { code: "F32.9", source: "user_entered", verified: true },
      ],
    },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "index_drug", indexPeriod: { start: "2016-01-01", end: "2016-12-31" } },
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
  groupVars: [
    { id: "g_arm", label: "Index drug", source: { kind: "exposure_cohort" }, levels: ["DRUG_X", "DRUG_Y"], referenceLevel: "DRUG_Y" },
  ],
  comparisons: [],
  analyses: [
    { id: "j_attrition", label: "Attrition", kind: "attrition", enabled: true },
    /* THE INDEX. Named van Walraven because that is the label the analyst
     * attached to these weights — the module says so in its own output, and
     * validates nothing against any published table. Two weights are NEGATIVE,
     * which is what made this the first index the emitters had never run. */
    {
      id: "j_vw", label: "van Walraven-style Elixhauser summary", kind: "comorbidity_index", enabled: true,
      indexName: "van Walraven (Elixhauser summary)",
      lookback: { start: -J_LOOKBACK_PRIMARY, end: 0, includesIndex: true },
      scoreBands: J_SCORE_BANDS,
      conditions: [
        { id: "chf", label: "Congestive heart failure", codeListId: "cci_chf", weight: 7 },
        { id: "mets", label: "Metastatic cancer", codeListId: "cci_mets", weight: 12, supersedes: ["tumr"] },
        { id: "tumr", label: "Solid tumour without metastasis", codeListId: "cci_tumr", weight: 4 },
        { id: "drug", label: "Drug abuse", codeListId: "cci_drug", weight: -7 },
        { id: "depr", label: "Depression", codeListId: "cci_depr", weight: -3 },
      ],
    },
    /* THE SWEEP TARGET. A logistic regression whose CRUDE effect is a
     * closed-form 2x2 odds ratio — executed in both twins, hand-derivable to
     * the digit, and signed about a null of 1 so a subgroup can flip it. */
    {
      id: "j_glm", label: "AE within a year, exposed vs reference", kind: "regression", enabled: true,
      family: "logistic",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "outpatient", diagnosisPosition: "any" },
      washout: { start: -J_WASHOUT_PRIMARY, end: 0, includesIndex: true },
      horizonDays: 365,
      groupVarId: "g_arm",
      covariateIds: ["b_age"],
    },
  ],
  /* THE DECLARED SWEEPS. Both name their primary arm here, in the spec, which
   * is the only thing that stops "the primary analysis" from being whichever
   * arm came out best. */
  sweeps: [
    {
      analysisId: "j_glm",
      primaryArmId: "base",
      arms: [
        {
          kind: "sensitivity", id: "base", label: "Washout 365 days (protocol)",
          vary: { param: "washout_days", value: J_WASHOUT_PRIMARY },
        },
        {
          kind: "sensitivity", id: "w730", label: "Washout 730 days",
          vary: { param: "washout_days", value: J_WASHOUT_LONG },
        },
        { kind: "subgroup", id: "fem", label: "Female", baselineId: "b_sex", level: "Female" },
      ],
    },
    {
      analysisId: "j_vw",
      primaryArmId: "lb365",
      arms: [
        {
          kind: "sensitivity", id: "lb365", label: "Lookback 365 days (protocol)",
          vary: { param: "lookback_days", value: J_LOOKBACK_PRIMARY },
        },
        {
          kind: "sensitivity", id: "lb120", label: "Lookback 120 days",
          vary: { param: "lookback_days", value: J_LOOKBACK_SHORT },
        },
        { kind: "subgroup", id: "fem", label: "Female", baselineId: "b_sex", level: "Female" },
      ],
    },
  ],
};

export const EXPECTED_J = {
  cohortN: 16,

  /* ---- the index: negative weights, supersession, both ICD eras ---- */
  index: {
    /** sum 10 over 16 members */
    scoreMean: 0.625,
    scoreMedian: 0,
    scoreMax: 12,
    /** sqrt(311.75 / 15) */
    scoreSd: 4.55887,
    /** P1 through ICD-9, P5 through ICD-10 — a broken era branch reports 1 */
    chfPrevalence: 2,
    metsPrevalence: 1,
    /** SUPERSEDED, and its prevalence still reports */
    tumrPrevalence: 1,
    drugPrevalence: 1,
    deprPrevalence: 3,
    bandLabels: ["-10 to -1", "0-6", "7+"],
    /** P3 (-10) and P4 (-3); the eleven zeros plus P5; P1 and P2 */
    bandCounts: [2, 12, 2],
  },

  /* ---- sweep 1: the logistic regression, three arms, one sign flip ---- */
  sweep1: {
    armIds: ["base", "w730", "fem"],
    armKinds: ["sensitivity", "sensitivity", "subgroup"],
    primaryArmId: "base",
    armsDeclared: 3,
    armsReported: 3,
    armsMissing: 0,
    /** 20/12 */
    baseOr: 1.66667,
    /** 16/9 */
    w730Or: 1.77778,
    /** 1/9 */
    femOr: 0.11111,
    armN: { base: 16, w730: 16, fem: 8 },
    estimateMin: 0.11111,
    estimateMax: 1.77778,
    /** 16/9 - 1/9 = 15/9 */
    estimateSpan: 1.66667,
    primaryEstimate: 1.66667,
    armsAboveNull: 2,
    armsBelowNull: 1,
    directionDisagreement: 1,
    /** 1 - 0.95^3 = 0.142625 */
    familywise: 0.14263,
    /** the base arm must reproduce the un-swept analysis exactly */
    baseAnalysisOr: 1.66667,
  },

  /* ---- sweep 2: a LEVEL, so no direction verdict is possible ---- */
  sweep2: {
    armIds: ["lb365", "lb120", "fem"],
    armKinds: ["sensitivity", "sensitivity", "subgroup"],
    primaryArmId: "lb365",
    /** 10/16 */
    lb365Mean: 0.625,
    /** 13/16 — a SHORTER lookback RAISED the mean, because what it dropped was
     *  net positive: P1's +7 out, P3's -7 out, P4's -3 out */
    lb120Mean: 0.8125,
    /** 6/8 */
    femMean: 0.75,
    armN: { lb365: 16, lb120: 16, fem: 8 },
    estimateMin: 0.625,
    estimateMax: 0.8125,
    estimateSpan: 0.1875,
    primaryEstimate: 0.625,
  },
} as const;
