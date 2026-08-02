/**
 * Gold Case K — THE LINE-OF-THERAPY CONSTRUCTION, and LINKED MORTALITY.
 *
 * Two features share one fixture because they share one cohort and interfere
 * with each other nowhere: the line construction reads pharmacy fills, the
 * survival curve reads an external death table, and neither touches the other's
 * inputs. Six patients, three agents, one linked mortality file.
 *
 * Window: 360 days, day 0 through 359. Index = first DRUG_A fill, which every
 * patient has on 2020-01-01, so the survival clock starts on the same calendar
 * day for everyone and every day offset below is also a real date.
 *
 * DECLARED LINE CONSTRUCTION (all four values are inputs, not findings):
 *   combinationWindowDays 28   gapDays 60   advanceTrigger "substitution"
 *   maxLines 3                 agents [agent_a, agent_b, agent_c]
 *
 * Every fill is a 30-day supply, so a fill on day d covers d..d+29.
 *
 *   P1  A 0,30,60,90    B 20,50,80,110          DOUBLET INSIDE the window
 *   P2  A 0,30,60,90    B 35,65,95,125          THE SAME DOUBLET, OUTSIDE it
 *   P3  A 0             B 100   C 200   A 300   HITS maxLines, TRUNCATED
 *   P4  A 0,30,...,150  C 60,90,120,150         an ADDITION that must NOT advance
 *   P5  A 0,30,60,120,150  B 100,130,160        a real SUBSTITUTION
 *   P6  A 0                                     the degenerate single line
 *
 * ================= HAND-DERIVED, BEFORE ANYTHING RAN =================
 *
 * P1 AND P2 ARE THE WHOLE POINT OF THE COMBINATION WINDOW. Their claims differ
 * only in when the second agent starts: day 20 for P1, day 35 for P2, with the
 * window at 28.
 *
 *   P1 line 1 opens day 0. A's first dispensing is day 0 and B's is day 20,
 *   which is inside 0+28, so BOTH join the regimen: R1 = {A, B}. Their supply
 *   merges to one island 0..139 (A tiles 0..119, B tiles 20..139, and they
 *   overlap throughout). The uncovered stretch 140..359 is 220 days, past the
 *   60-day gap, so the line CLOSES at 140 and ends on day 139. No dispensing
 *   falls at or after 140, so no line 2 opens. P1 REACHES ONE LINE.
 *
 *   P2 line 1 opens day 0 with R1 = {A} alone, because B's first dispensing at
 *   day 35 is OUTSIDE 0+28. A tiles 0..119; the gap 120..359 closes the line at
 *   120, ending it on day 119. (B's day-125 dispensing is a substitution — A ran
 *   out at 119 — but at day 125 it is later than the gap, so the gap wins.) The
 *   next dispensing at or after 120 is B on day 125, so LINE 2 OPENS AT 125 with
 *   R2 = {B}: A has no dispensing at or after 125 at all. B covers 125..154, the
 *   gap 155..359 closes it, and nothing follows. P2 REACHES TWO LINES.
 *
 *   Identical drugs, identical order, a fifteen-day difference, and one patient
 *   has one line while the other has two. That is what a declared parameter
 *   means, and it is why the caveat row names all three of them.
 *
 * P3 HITS THE BOUND. Line 1 = {A} over 0..29 (the gap 30..99 is 70 days, so it
 * closes at 30); the next dispensing at or after 30 is B on day 100, so line 2 =
 * {B} over 100..129 closing at 130; the next is C on day 200, so line 3 = {C}
 * over 200..229 closing at 230; and the next dispensing at or after 230 is A on
 * day 300 — which WOULD open line 4. maxLines is 3, so P3 is COUNTED in the
 * truncation row rather than dropped. n_truncated = 1.
 *
 * P4 IS THE ADVANCE-TRIGGER CONTROL. R1 = {A} (C first appears on day 60, past
 * the window). A tiles 0..179 with no break, so on every day C is dispensed
 * (60, 90, 120, 150) A is STILL COVERED — each is an ADDITION, not a
 * substitution. Under the declared trigger "substitution" none of them advances
 * the line, so P4 stays on line 1 until the gap at 180 and REACHES ONE LINE.
 * Flip the trigger and the line closes on day 60 instead; that flip is asserted
 * as a spec-level control, because a program that ignored the trigger would
 * still report a perfectly plausible line distribution.
 *
 * P5 IS THE SUBSTITUTION. R1 = {A}. A covers 0..89 and then, after a 30-day
 * break (shorter than the 60-day gap), 120..179. B starts on day 100 — inside
 * that break, so A is NOT covered and this IS a substitution. It closes line 1
 * at 100, ending it on day 99. Line 2 opens at 100 and its combination window
 * 100..128 catches A's day-120 dispensing, so R2 = {A, B}: an agent can rejoin.
 * P5 REACHES TWO LINES.
 *
 * P6 is the degenerate case: one fill, one line, closed by the gap at day 30.
 *
 * PER-LINE TOTALS, summed from the six derivations above.
 *
 *   line 1: all 6 reach it. Regimen sizes 2,1,1,1,1,1 -> mean 7/6 = 1.16667.
 *           agent_a in 6, agent_b in 1 (P1), agent_c in 0.
 *           Advancing: P2, P3, P5 -> 3. Days to next line 125, 100, 100 ->
 *           mean 325/3 = 108.33333.
 *           Closed by gap 5 (P1 P2 P3 P4 P6), by substitution 1 (P5),
 *           by addition 0, open at window end 0.
 *   line 2: P2, P3, P5. Regimen sizes 1,1,2 -> mean 4/3 = 1.33333.
 *           agent_a in 1 (P5), agent_b in 3, agent_c in 0.
 *           Advancing: P3 only -> 1, at 200-100 = 100 days.
 *           Closed by gap 3.
 *   line 3: P3 alone. Regimen {C}. Its "next line" is the TRUNCATED one, so
 *           n_advancing = 1 at 300-200 = 100 days. Closed by gap 1.
 *
 * PPPM BY LINE. Every fill costs $100 and there are no other claims, so a
 * line's cost is $100 per fill whose date falls inside its span. Enrollment runs
 * 2019-01-01..2021-12-31 with a non-capitated plan type, so eligible days inside
 * a line span equal the span's own length.
 *
 *   line 1 spans 0..139, 0..119, 0..29, 0..179, 0..99, 0..29 = 600 eligible days
 *          fills inside them 8+7+1+10+3+1 = 30 -> $3,000
 *          member-months 600 / 30.4375 = 19.71253
 *          PPPM 3000 * 30.4375 / 600 = $152.1875 -> 152.19
 *   line 2 spans 125..154, 100..129, 100..189 = 150 eligible days
 *          fills 1 + 1 + 5 = 7 -> $700
 *          member-months 150 / 30.4375 = 4.92813
 *          PPPM 700 * 30.4375 / 150 = $142.0417 -> 142.04
 *   line 3 span 200..229 = 30 eligible days, 1 fill -> $100
 *          member-months 30 / 30.4375 = 0.98563
 *          PPPM 100 * 30.4375 / 30 = $101.4583 -> 101.46
 *
 * The three PPPM figures are NOT comparable to a fixed-window per-patient-month
 * cost and that is the point: line 3 lasts 30 days and line 1 lasts up to 180,
 * so dividing either by the 360-day window would report the same dollars over
 * twelve times the denominator.
 *
 * THE SWITCH BLOCK STILL RUNS, on the same claims, and DISAGREES — which is the
 * honest illustration of "definitional". Its two-line approximation asks only
 * whether a to-drug started with at most 90 days of A left: P2 (85 days left)
 * and P5 (80) qualify, so it reports 2 patients reaching line 2 while the full
 * construction reports 3. Neither is wrong. They are different rules.
 *
 * ================= THE LINKED MORTALITY ARM =================
 *
 * linked_death carries one row per member: a death date (NULL if not known to
 * have died) and a linked flag. The linked subset is a STRICT SUBSET:
 *
 *   P1 linked, died 2020-04-10 = day 100
 *   P2 linked, died 2020-07-19 = day 200
 *   P3 UNLINKED, no death recorded
 *   P4 linked, alive
 *   P5 linked, died 2020-10-27 = day 300 — AFTER the ascertainment date
 *   P6 UNLINKED, no death recorded
 *
 * So: cohort 6, linked 4, unlinked 2, ascertainment 4/6 = 66.67%; deaths on or
 * before the 2020-09-30 ascertainment date = 2; deaths after it = 1.
 *
 * FOLLOW-UP. Censoring is disenrollment (2021-12-31), study end (2021-12-31)
 * and the ASCERTAINMENT DATE 2020-09-30, whichever is earliest — so everyone's
 * administrative censor is 2020-09-30, which is day 273. P5's death on day 300
 * is therefore CENSORED at 273, not an event: the linkage cannot see it.
 *
 * KAPLAN-MEIER over the linked subset (n = 4: P1, P2, P4, P5):
 *   times/events  P1 (100, died)  P2 (200, died)  P4 (273, censored)
 *                 P5 (273, censored)
 *   day 100: 4 at risk, 1 event  -> S = 3/4 = 0.75
 *   day 200: 3 at risk, 1 event  -> S = 0.75 x 2/3 = 0.5
 *   S(90) = 1, S(180) = 0.75, S(270) = 0.5, S(330) = 0.5
 *   median = 200 (the first time S falls to one half)
 *
 * WHAT THE IMMORTALITY BUG WOULD GIVE. Draw the same curve over all six members
 * — leaving the two UNLINKED ones in the risk set — and they contribute
 * person-time with no possible event:
 *   day 100: 6 at risk -> S = 5/6;  day 200: 5 at risk -> S = 5/6 x 4/5 = 2/3
 *   S(180) = 0.83333 instead of 0.75
 *   S(270) = 0.66667 instead of 0.5
 *   median = NOT REACHED instead of 200
 * Survival is biased UPWARD at every horizon and the median disappears
 * entirely. verify/run.ts asserts the correct values AND asserts they are not
 * these.
 *
 * WHAT IGNORING THE ASCERTAINMENT DATE WOULD GIVE. Censor at the study end
 * instead and P5's day-300 death becomes an event:
 *   day 300: 2 at risk, 1 event -> S = 0.5 x 1/2 = 0.25
 *   S(330) = 0.25 instead of 0.5
 * The horizon at 330 exists precisely to make that visible: it is past the
 * ascertainment date, which is the situation the censoring rule is for.
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_A = "00000000011";
const NDC_B = "00000000012";
const NDC_C = "00000000013";

/** Fill-start day offsets from index, per patient, per agent. */
const K_A: Record<number, number[]> = {
  1: [0, 30, 60, 90],
  2: [0, 30, 60, 90],
  3: [0, 300],
  4: [0, 30, 60, 90, 120, 150],
  5: [0, 30, 60, 120, 150],
  6: [0],
};
const K_B: Record<number, number[]> = {
  1: [20, 50, 80, 110],
  2: [35, 65, 95, 125],
  3: [100],
  4: [],
  5: [100, 130, 160],
  6: [],
};
const K_C: Record<number, number[]> = {
  1: [], 2: [], 3: [200], 4: [60, 90, 120, 150], 5: [], 6: [],
};
const SUPPLY = 30;
/** Every fill costs the same, so a line's cost is $100 per fill inside it and
 *  the PPPM derivation above is checkable by counting dispensings. */
const FILL_PAID = 100;

/** 2020 is a leap year — offsets are converted here rather than written by hand,
 *  because an off-by-one in a fill date silently moves a line boundary. */
function dayToIso(day: number): string {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + day);
  return d.toISOString().slice(0, 10);
}

/** The linked mortality file: [enrolid, death date or null, linked flag]. */
const K_DEATH: Array<[number, string | null, string]> = [
  [1, "2020-04-10", "1"],
  [2, "2020-07-19", "1"],
  [3, null, "0"],
  [4, null, "1"],
  [5, "2020-10-27", "1"],
  [6, null, "0"],
];

export function fixtureKSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  const ids = Object.keys(K_A).map(Number);
  /* plantyp '6' is a PPO: NOT one of the capitated types (4, 7), so every month
   * counts in the member-month denominator. A capitated plan type here would
   * silently empty the PPPM denominator. */
  const enroll = ids
    .map((id) => `(${id}, DATE '2019-01-01', DATE '2021-12-31', '1', '1', 1980, 40, '1', '1', '6', '1')`)
    .join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
  );
  const fills = ids
    .flatMap((id) => [
      ...K_A[id].map((d) => `(${id}, DATE '${dayToIso(d)}', '${NDC_A}', ${SUPPLY}, 30, ${FILL_PAID})`),
      ...K_B[id].map((d) => `(${id}, DATE '${dayToIso(d)}', '${NDC_B}', ${SUPPLY}, 30, ${FILL_PAID})`),
      ...K_C[id].map((d) => `(${id}, DATE '${dayToIso(d)}', '${NDC_C}', ${SUPPLY}, 30, ${FILL_PAID})`),
    ])
    .join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${fills};`);
  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ` +
      `('${NDC_A}','DRUG_A','BRAND_A'), ('${NDC_B}','DRUG_B','BRAND_B'), ('${NDC_C}','DRUG_C','BRAND_C');`,
  );
  /* THE LINKED MORTALITY FILE. It is a SITE asset, not a MarketScan table, so
   * it is created here rather than in FIXTURE_DDL — the shared DDL describes
   * the delivery, and a linkage is something a site brings to it. */
  lines.push(
    `DROP TABLE IF EXISTS linked_death;`,
    `CREATE TABLE linked_death ( enrolid BIGINT, dod DATE, linked VARCHAR );`,
    `INSERT INTO linked_death (enrolid,dod,linked) VALUES\n  ` +
      K_DEATH.map(([id, dod, flag]) => `(${id}, ${dod === null ? "NULL" : `DATE '${dod}'`}, '${flag}')`).join(",\n  ") +
      `;`,
  );
  return lines.join("\n");
}

export const GOLD_K_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_K" };

export const GOLD_K_SPEC: StudySpec = {
  meta: {
    title: "Gold Case K — line-of-therapy construction and linked mortality",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2019-01-01", end: "2021-12-31" },
    provenance: { method: "manual" },
  },
  codeLists: [
    {
      id: "agent_a", label: "Agent A (index)", system: "drug_name",
      codes: [{ code: "DRUG_A", source: "user_entered", verified: true }],
    },
    {
      id: "agent_b", label: "Agent B", system: "drug_name",
      codes: [{ code: "DRUG_B", source: "user_entered", verified: true }],
    },
    {
      id: "agent_c", label: "Agent C", system: "drug_name",
      codes: [{ code: "DRUG_C", source: "user_entered", verified: true }],
    },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "agent_a", indexPeriod: { start: "2020-01-01", end: "2020-12-31" } },
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
    { id: "k_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "k_lot", label: "Line of therapy over 360 days", kind: "treatment_switching", enabled: true,
      fromCodeListId: "agent_a",
      toCodeListIds: ["agent_b", "agent_c"],
      window: { start: 0, end: 359, includesIndex: true },
      permissibleOverlapDays: 90,
      lineRule: "declared_regimen",
      lineConstruction: {
        combinationWindowDays: 28,
        gapDays: 60,
        advanceTrigger: "substitution",
        agentCodeListIds: ["agent_a", "agent_b", "agent_c"],
        maxLines: 3,
      },
    },
    {
      id: "k_os", label: "Overall survival on the linked death file", kind: "survival", enabled: true,
      endpoint: {
        kind: "death",
        source: "ssa_master_file",
        linkage: {
          tableHandle: "linked_death",
          deathDateColumn: "dod",
          linkedFlagColumn: "linked",
          ascertainedThrough: "2020-09-30",
          vintageLabel: "SSA Master Death File, 2024 vintage",
        },
      },
      washout: { start: -365, end: 0, includesIndex: true },
      /* NO max_followup on purpose: the ASCERTAINMENT DATE is what has to bind,
       * and a shorter follow-up bound would hide it. */
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end"] },
      /* 330 is PAST the ascertainment date, which is the horizon that makes the
       * censoring rule visible: it is where a program ignoring the date would
       * report an extra death. */
      horizonDays: [90, 180, 270, 330],
      ciMethod: "log_log",
      emitLifeTable: false,
    },
  ],
};

export const EXPECTED_K = {
  cohortN: 6,
  windowDays: 360,

  /* ---------- the line construction ---------- */
  linesReached: { 1: 6, 2: 3, 3: 1 } as Record<number, number>,
  regimenSizeMean: { 1: 7 / 6, 2: 4 / 3, 3: 1 } as Record<number, number>,
  /** patients whose line-k regimen includes each agent */
  regimen: {
    1: { agent_a: 6, agent_b: 1, agent_c: 0 },
    2: { agent_a: 1, agent_b: 3, agent_c: 0 },
    3: { agent_a: 0, agent_b: 0, agent_c: 1 },
  } as Record<number, Record<string, number>>,
  advancing: { 1: 3, 2: 1, 3: 1 } as Record<number, number>,
  meanDaysToNext: { 1: 325 / 3, 2: 100, 3: 100 } as Record<number, number>,
  closedByGap: { 1: 5, 2: 3, 3: 1 } as Record<number, number>,
  closedBySubstitution: { 1: 1, 2: 0, 3: 0 } as Record<number, number>,
  closedByAddition: { 1: 0, 2: 0, 3: 0 } as Record<number, number>,
  openAtWindowEnd: { 1: 0, 2: 0, 3: 0 } as Record<number, number>,
  truncated: 1,

  /** eligible days, dollars and the PPPM they give at 30.4375 days per month */
  eligibleDays: { 1: 600, 2: 150, 3: 30 } as Record<number, number>,
  memberMonths: { 1: 600 / 30.4375, 2: 150 / 30.4375, 3: 30 / 30.4375 } as Record<number, number>,
  paid: { 1: 3000, 2: 700, 3: 100 } as Record<number, number>,
  pppm: { 1: 152.19, 2: 142.04, 3: 101.46 } as Record<number, number>,

  /* the switch block, on the same claims and under a DIFFERENT rule */
  startedNew: 5,
  switched: 2,          // P2 (85 days of A left) and P5 (80), at a 90-day rule
  addOn: 3,
  reachingLine2TwoLineRule: 2,   // vs 3 under the full construction

  /* ---------- the linked mortality arm ---------- */
  cohortMembers: 6,
  linkedMembers: 4,
  unlinkedExcluded: 2,
  ascertainmentPct: 66.67,
  deathsAscertained: 2,
  deathsAfterAscertainment: 1,
  /** S(t) over the LINKED SUBSET */
  survival: { 90: 1, 180: 0.75, 270: 0.5, 330: 0.5 } as Record<number, number>,
  nRisk: { 90: 4, 180: 3, 270: 2, 330: 0 } as Record<number, number>,
  median: 200,
  /** what the IMMORTALITY BUG would report — asserted as NOT the answer */
  survivalIfUnlinkedIncluded: { 180: 5 / 6, 270: 2 / 3 } as Record<number, number>,
  /** what IGNORING the ascertainment date would report at the 330-day horizon */
  survivalIfAscertainmentIgnored330: 0.25,
} as const;

/* -------------------------------------------------------------------------- *
 *  SPEC-LEVEL CONTROLS
 *
 *  A number that does not MOVE when the rule that produced it changes was never
 *  computed from that rule. Each control below re-emits Gold K with exactly one
 *  declared parameter altered and pins the value the altered rule must give —
 *  hand-derived the same way the primary numbers were.
 * -------------------------------------------------------------------------- */

/** advanceTrigger flipped to "addition_or_substitution".
 *
 *  P2's B on day 35 and P4's C on day 60 are both ADDITIONS (the regimen agent
 *  is still covered on those days), so both now CLOSE their line. P2's line 1
 *  ends on day 34 and line 2 opens at 35 with R2 = {A, B} — A's day-60
 *  dispensing is inside 35+28. P4's line 1 ends on day 59 and line 2 opens at
 *  60 with R2 = {A, C}, both dispensed that day. P1, P3, P5 and P6 are
 *  unchanged, so line 2 gains P4: 3 patients become 4, and line 1 gains two
 *  closes by addition. */
export const EXPECTED_K_TRIGGER_FLIPPED = {
  line2Patients: 4,
  line1ClosedByAddition: 2,
  line1ClosedByGap: 3,        // P1, P3, P6
  line1ClosedBySubstitution: 1, // P5
} as const;

/** combinationWindowDays collapsed to 0 — every agent becomes its own line.
 *
 *  Nothing may join a line unless it starts on the opening day itself. P1's B
 *  at day 20 is out, so line 1's regimen is {A} for all six patients and the
 *  mean regimen size falls from 7/6 to exactly 1. P5's line 2 loses A (day 120
 *  against an opening of 100), so agent_a appears in NO line-2 regimen. */
export const EXPECTED_K_WINDOW_ZERO = {
  line1RegimenSizeMean: 1,
  line1AgentB: 0,
  line2AgentA: 0,
} as const;

/** gapDays widened to 400 — longer than the window, so NO gap can ever close a
 *  line and only substitutions advance.
 *
 *  P1, P4 and P6 then never close at all and are OPEN AT THE WINDOW END; P2, P3
 *  and P5 close by substitution (B on day 125, B on day 100, B on day 100). */
export const EXPECTED_K_NO_GAP = {
  line1ClosedByGap: 0,
  line1ClosedBySubstitution: 3,
  line1OpenAtWindowEnd: 3,
} as const;
