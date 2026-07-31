/**
 * Gold Case F — ADHERENCE, and the choice that moves it across the threshold.
 *
 * A separate seed, like B through E. Five patients, one measurement window, five
 * refill patterns chosen so every number is an exact fraction and each patient
 * pins a different piece of the interval algebra.
 *
 * Window: 180 days, day 0 through 179. Every measurable fill is a 30-day supply.
 *
 *   P1  fills at 0, 30, 60, 90, 120, 150   PERFECT — no overlap, no gap
 *   P2  fills at 0, 20, 40, 60, 80, 100    EARLY REFILLS — overlap, no gap
 *   P3  fills at 0, 30, 120, 150           A REAL GAP of 60 days
 *   P4  a single fill at 0                 minimal
 *   P5  fills at 0, and at 60 with a NULL days supply   DIRTY DATA
 *
 * Hand-derived, and executed by verify/run.ts verifyGoldF:
 *
 *   patient  covered  PDC        MPR    stockpiled PDC   discontinued  persistence
 *   P1       180      1          1      1                never          180 (censored)
 *   P2       130      13/18      1      1                day 130        130
 *   P3       120      2/3        2/3    2/3              day 60          60
 *   P4        30      1/6        1/6    1/6              day 30          30
 *   P5        30      1/6        1/6    1/6              day 30          30
 *
 * WHAT EACH PATIENT IS FOR.
 *
 * P1 pins the boundary arithmetic. A 30-day supply dispensed on day 0 covers
 * days 0..29, so six of them tile 180 days exactly. If the emitter used
 * start + supply as the end rather than start + supply - 1, P1's coverage would
 * come out at 186 and PDC above 1 — an impossible value, which is the point:
 * the off-by-one is worth one day per fill and is visible here immediately.
 *
 * P2 IS THE HEADLINE. Refilling every 20 days on a 30-day supply, the same fills
 * give PDC = 13/18 = 0.722 without stockpiling and 1.000 with it. The
 * conventional adherence cut-point is 0.8, so a single unstated methodological
 * choice moves this patient from NON-ADHERENT to ADHERENT. The module reports
 * both, labelled, rather than picking one.
 *
 * P2 also pins the PDC <= MPR relation at its most informative: MPR is 1.000
 * because six 30-day fills is 180 days of supply, while only 130 distinct days
 * are covered. MPR counts pills; PDC counts days. Overlap is the whole gap
 * between them.
 *
 * P3 separates a gap from non-adherence. Its PDC equals its MPR exactly (2/3),
 * because nothing overlaps — so on the adherence measures P3 and a patient who
 * skipped doses evenly are indistinguishable. Persistence is what tells them
 * apart: P3 discontinued on day 60.
 *
 * P4 pins the degenerate end and the censoring distinction against P1: P4
 * discontinues on day 30, while P1 never discontinues and is CENSORED at 180.
 * A table that reported both as "180" and "30" without saying which is an event
 * would turn "still on treatment when we stopped looking" into "never stopped".
 */
import type { StudySpec, EmitOptions } from "../index";
import { FIXTURE_DDL } from "./fixture";

const NDC_X = "00000000001";

/** Fill-start day offsets from index, per patient, with days supply.
 *  `null` supply is a REAL claims value, not a typo — see P5. */
const F_FILLS: Record<number, Array<[day: number, supply: number | null]>> = {
  1: [[0, 30], [30, 30], [60, 30], [90, 30], [120, 30], [150, 30]],
  2: [[0, 30], [20, 30], [40, 30], [60, 30], [80, 30], [100, 30]],
  3: [[0, 30], [30, 30], [120, 30], [150, 30]],
  4: [[0, 30]],
  /* P5 PINS THE CLEANING PATH, which nothing else here touches. Its second fill
   * has a NULL days supply — the single most common dirty value in a pharmacy
   * file. Uncleaned it does not raise an error: the interval end goes NULL, the
   * window predicate evaluates UNKNOWN, the row leaves the calculation, and P5
   * simply looks less adherent with nothing anywhere saying a fill vanished.
   * Cleaned, P5 lands on P4's numbers exactly (one measurable 30-day fill), but
   * with a fill-attrition count that is NOT zero. That pairing is the assertion:
   * the same PDC, reported honestly in one case and silently in the other. */
  5: [[0, 30], [60, null]],
};

/** 2020 is a leap year — day offsets are converted here rather than written by
 *  hand, because an off-by-one in a fill date moves coverage silently. */
function dayToIso(day: number): string {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + day);
  return d.toISOString().slice(0, 10);
}

export function fixtureFSeedSql(): string {
  const lines: string[] = [FIXTURE_DDL];
  const ids = Object.keys(F_FILLS).map(Number);
  const enroll = ids
    .map((id) => `(${id}, DATE '2019-01-01', DATE '2021-12-31', '1', '1', 1980, 40, '1', '1', '6', '1')`)
    .join(",\n  ");
  lines.push(
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
  );
  /* Every fill is the SAME drug (the index drug), so nothing here is a switch —
   * switching gets its own fixture when that module lands. */
  const fills = ids
    .flatMap((id) =>
      F_FILLS[id].map(([d, sup]) =>
        `(${id}, DATE '${dayToIso(d)}', '${NDC_X}', ${sup === null ? "NULL" : sup}, 30, 100)`),
    )
    .join(",\n  ");
  lines.push(`INSERT INTO ccaed_all (enrolid,svcdate,ndcnum,daysupp,qty,paytot) VALUES\n  ${fills};`);
  lines.push(
    `INSERT INTO redbook (ndcnum,gennme,prodnme) VALUES ('${NDC_X}','DRUG_X','BRAND_X');`,
  );
  return lines.join("\n");
}

export const GOLD_F_OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "TZ_F" };

export const GOLD_F_SPEC: StudySpec = {
  meta: {
    title: "Gold Case F — adherence and persistence",
    version: "1.0",
    database: "marketscan_ccae",
    studyPeriod: { start: "2019-01-01", end: "2021-12-31" },
    provenance: { method: "manual" },
  },
  codeLists: [
    {
      id: "index_drug", label: "Index drug (X)", system: "drug_name",
      codes: [{ code: "DRUG_X", source: "user_entered", verified: true }],
    },
  ],
  indexEvent: { type: "first_drug_claim", codeListId: "index_drug", indexPeriod: { start: "2020-01-01", end: "2020-12-31" } },
  enrollment: { baselineDays: 365, followupDays: 180, gapAllowanceDays: 31, requiresRxCoverage: true },
  criteria: [
    {
      id: "c_cont", kind: "inclusion", sourceText: "Continuous enrollment 365d pre / 180d post index",
      test: { type: "continuous_enrollment", baselineDays: 365, followupDays: 180, requiresRxCoverage: true },
      confidence: "high", reviewed: true,
    },
  ],
  baseline: [{ id: "b_age", label: "Age at index", kind: "age", dataType: "continuous" }],
  outcomes: [],
  groupVars: [],
  comparisons: [],
  analyses: [
    { id: "f_attrition", label: "Attrition", kind: "attrition", enabled: true },
    {
      id: "f_adh", label: "Adherence and persistence to DRUG_X over 180 days", kind: "adherence", enabled: true,
      drugCodeListId: "index_drug",
      window: { start: 0, end: 179, includesIndex: true },
      permissibleGapDays: 30,
      adherenceThreshold: 0.8,
    },
  ],
};

export const EXPECTED_F = {
  cohortN: 5,
  windowDays: 180,
  /** per patient: covered days, PDC, MPR, stockpiled PDC, discontinuation day */
  patients: {
    1: { covered: 180, pdc: 1, mpr: 1, pdcStock: 1, disc: null, persistence: 180, adherent: 1 },
    2: { covered: 130, pdc: 0.72222, mpr: 1, pdcStock: 1, disc: 130, persistence: 130, adherent: 0 },
    3: { covered: 120, pdc: 0.66667, mpr: 0.66667, pdcStock: 0.66667, disc: 60, persistence: 60, adherent: 0 },
    4: { covered: 30, pdc: 0.16667, mpr: 0.16667, pdcStock: 0.16667, disc: 30, persistence: 30, adherent: 0 },
    /* identical to P4 AFTER cleaning drops its null-supply fill */
    5: { covered: 30, pdc: 0.16667, mpr: 0.16667, pdcStock: 0.16667, disc: 30, persistence: 30, adherent: 0 },
  } as Record<number, { covered: number; pdc: number; mpr: number; pdcStock: number; disc: number | null; persistence: number; adherent: number }>,
  /** cohort-level. 5 patients: 1 + 13/18 + 2/3 + 1/6 + 1/6 = 49/18 */
  meanPdc: 0.54444,       // (49/18) / 5
  meanMpr: 0.6,           // (1 + 1 + 2/3 + 1/6 + 1/6) / 5 = 3/5
  adherentCount: 1,       // only P1 clears 0.8 without stockpiling
  adherentCountStock: 2,  // P2 joins it under stockpiling — the headline
  discontinuedCount: 4,   // P1 is censored, not an event
  censoredCount: 1,
  /** fill attrition. 6+6+4+1+2 = 19 dispensings inserted; P5's null-supply fill
   *  is the one drop, so the counts must read 19 / 1 / 18. */
  fillsFound: 19,
  fillsDroppedMissing: 1,
  fillsMeasured: 18,
} as const;
