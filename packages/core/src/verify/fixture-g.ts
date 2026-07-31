/**
 * Gold Case G — SWITCHING, and the rule that decides what a switch is.
 *
 * Gold Case F is single-drug by construction, so it cannot express a switch at
 * all. G is the two-drug fixture: every patient starts on DRUG_X and some of
 * them are later dispensed DRUG_Y, in patterns chosen so that the OVERLAP RULE
 * is what separates them rather than anything about the timing.
 *
 * Window: 360 days, day 0 through 359. Index = first DRUG_X fill.
 *
 *   P1  X at 0,30,60 (30d each); no Y            NEVER STARTS A SECOND DRUG
 *   P2  X at 0,30,60; Y at 120                   CLEAN SWITCH - X ran out day 89
 *   P3  X at 0,30,60,90,120,150; Y at 60         ADD-ON - X supply runs to 179
 *   P4  X at 0; Y at 30                          BOUNDARY - X ends day 29, Y at 30
 *   P5  X at 0,30; Y at 45                       PARTIAL OVERLAP of 15 days
 *
 * HAND-DERIVED. from_last_day is max(fill_start + supply - 1) over X's fills;
 * overlap = from_last_day - to_day + 1, floored at 0.
 *
 *   patient  X last day  Y starts  overlap  strict(0)  rule(30)  loose(inf)
 *   P1       89          none      -        no         no        no
 *   P2       89          120       0        SWITCH     SWITCH    SWITCH
 *   P3       179         60        120      add-on     add-on    switch
 *   P4       29          30        0        SWITCH     SWITCH    SWITCH
 *   P5       59          45        15       add-on     SWITCH    switch
 *
 * WHY EACH PATIENT IS HERE.
 *
 * P4 PINS THE BOUNDARY ARITHMETIC, and it is the reason this fixture exists in
 * this exact shape. A 30-day supply dispensed on day 0 covers days 0..29, so a
 * new drug starting on day 30 begins the day after the old supply ends: overlap
 * is ZERO and this is a clean switch. If the emitter used start + supply as the
 * last covered day, P4's overlap would be 1, and under a strict zero-overlap
 * rule P4 would flip to combination therapy. One off-by-one, one patient
 * reclassified, and no number anywhere would look impossible.
 *
 * P5 IS THE HEADLINE. Fifteen days of X remaining when Y starts. Under a
 * zero-overlap rule that is combination therapy; under the 30-day rule this
 * study declares, it is a switch. Same claims, opposite answers, and the module
 * reports the whole band rather than one point in it.
 *
 * P3 is the case a naive "first Y fill after index" definition gets wrong: Y
 * starts on day 60 while X has another 120 days to run, and X keeps being
 * dispensed afterwards. Calling that a switch would say the patient abandoned X
 * on the day they demonstrably did not.
 *
 * So: strict rule = 2 switches, declared 30-day rule = 3, loose rule = 4. The
 * band is TWO PATIENTS wide on a cohort of five, which is the point.
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";
const NDC_Y = "00000000002";

/** [day offset from index, days supply] per patient, per drug. */
const G_X: Record<number, number[]> = {
  1: [0, 30, 60],
  2: [0, 30, 60],
  3: [0, 30, 60, 90, 120, 150],
  4: [0],
  5: [0, 30],
};
const G_Y: Record<number, number[]> = {
  1: [],
  2: [120],
  3: [60],
  4: [30],
  5: [45],
};
const SUPPLY = 30;

/** 2020 is a leap year — offsets are converted here rather than written by hand,
 *  because an off-by-one in a fill date silently moves a classification. */
function dayToIso(day: number): string {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + day);
  return d.toISOString().slice(0, 10);
}

export function fixtureGSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  const ids = Object.keys(G_X).map(Number);
  const enroll = ids
    .map((id) => `(${id}, DATE '2019-01-01', DATE '2021-12-31', '1', '1', 1980, 40, '1', '1', '6', '1')`)
    .join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
  );
  const fills = ids
    .flatMap((id) => [
      ...G_X[id].map((d) => `(${id}, DATE '${dayToIso(d)}', '${NDC_X}', ${SUPPLY}, 30, 100)`),
      ...G_Y[id].map((d) => `(${id}, DATE '${dayToIso(d)}', '${NDC_Y}', ${SUPPLY}, 30, 100)`),
    ])
    .join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${fills};`);
  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ` +
      `('${NDC_X}','DRUG_X','BRAND_X'), ('${NDC_Y}','DRUG_Y','BRAND_Y');`,
  );
  return lines.join("\n");
}

export const GOLD_G_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_G" };

export const GOLD_G_SPEC: StudySpec = {
  meta: {
    title: "Gold Case G — treatment switching and line of therapy",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2019-01-01", end: "2021-12-31" },
    provenance: { method: "manual" },
  },
  codeLists: [
    {
      id: "drug_x", label: "Index drug (X)", system: "drug_name",
      codes: [{ code: "DRUG_X", source: "user_entered", verified: true }],
    },
    {
      id: "drug_y", label: "Switch target (Y)", system: "drug_name",
      codes: [{ code: "DRUG_Y", source: "user_entered", verified: true }],
    },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "drug_x", indexPeriod: { start: "2020-01-01", end: "2020-12-31" } },
  enrollment: { baselineDays: 365, followupDays: 360, gapAllowanceDays: 31, requiresRxCoverage: true },
  criteria: [
    {
      id: "c_cont", kind: "inclusion", sourceText: "Continuous enrollment 365d pre / 360d post index",
      test: { type: "continuous_enrollment", baselineDays: 365, followupDays: 360, requiresRxCoverage: true },
      confidence: "high", reviewed: true,
    },
  ],
  baseline: [{ id: "b_age", label: "Age at index", kind: "age", dataType: "continuous" }],
  outcomes: [],
  groupVars: [],
  comparisons: [],
  analyses: [
    { id: "g_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "g_switch", label: "Switching from X to Y over 360 days", kind: "treatment_switching", enabled: true,
      fromCodeListId: "drug_x",
      toCodeListIds: ["drug_y"],
      window: { start: 0, end: 359, includesIndex: true },
      permissibleOverlapDays: 30,
      lineRule: "new_line_on_switch",
    },
  ],
};

export const EXPECTED_G = {
  cohortN: 5,
  windowDays: 360,
  /** per patient: X's last covered day, Y's start day, overlap */
  patients: {
    1: { fromLast: 89, toDay: null, overlap: null },
    2: { fromLast: 89, toDay: 120, overlap: 0 },
    3: { fromLast: 179, toDay: 60, overlap: 120 },
    4: { fromLast: 29, toDay: 30, overlap: 0 },
    5: { fromLast: 59, toDay: 45, overlap: 15 },
  } as Record<number, { fromLast: number; toDay: number | null; overlap: number | null }>,
  startedNew: 4,        // P2 P3 P4 P5
  /** the DECLARED 30-day rule: P2, P4, P5 */
  switched: 3,
  addOn: 1,             // P3 only
  /** the band. strict = P2, P4 (zero overlap); loose = all four starters */
  switchedStrict: 2,
  switchedLoose: 4,
  reclassified: 2,      // the band is two patients wide on a cohort of five
  meanDaysToSwitch: 65, // (120 + 30 + 45) / 3
  minDaysToSwitch: 30,
  reachingLine2: 3,     // one line per switch under the declared rule
  meanLines: 1.6,       // (1 + 2 + 1 + 2 + 2) / 5
} as const;
