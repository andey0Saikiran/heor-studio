/**
 * PREFIX DIAGNOSIS MATCHING, executed against real Postgres.
 *
 * The audit's blocker #1: a diagnosis list that names an ICD FAMILY (the norm in
 * a real protocol: "E11.x", "K85.xx", "250.x0") was matched with exact equality,
 * so `K85` compared against a claim's `K8590` and found nothing. Every diagnosis
 * cohort on a family came back empty while the pipeline read "ready".
 *
 * A `CodeEntry.match: "prefix"` now emits `dx LIKE 'K85%'` instead of `dx IN
 * ('K85')`. This test proves it on hand-derived truth, and proves it the honest
 * way: the SAME seven patients and the SAME codes are run twice, once with the
 * family flagged prefix and once exact, and the only thing that changes is the
 * flag. Prefix selects the three K85* patients; exact selects none of them. The
 * exact leaf `E1165` matches its own patient and not the neighbouring `E1164` in
 * both runs, so the fix does not loosen exact matching.
 *
 * Ground truth, by hand:
 *   P1 K850   under K85  -> prefix YES, exact(K85) no
 *   P2 K8590  under K85  -> prefix YES, exact(K85) no
 *   P3 K859   under K85  -> prefix YES, exact(K85) no
 *   P4 J450   asthma     -> neither
 *   P5 K95    not K85*   -> neither  (K95 does NOT start with K85)
 *   P6 E1165  leaf       -> exact(E1165) YES, and prefix(K85) no
 *   P7 E1164  leaf       -> neither   (E1164 is not E1165)
 */
import type { StudySpec, EmitOptions, CodeEntry } from "../index";
import { seedAndRun, rows } from "./engine";
import { FIXTURE_DDL } from "./fixture";
import type { Check } from "./run";

const OPTS: EmitOptions = { naming: { kind: "yearly_sas", prefix: "ccae" }, tag: "PFX" };

/** Seven patients, one outpatient diagnosis each, all enrolled across the study. */
function seed(): string {
  const PATIENTS: Array<[number, string]> = [
    [1, "K850"], [2, "K8590"], [3, "K859"], [4, "J450"], [5, "K95"], [6, "E1165"], [7, "E1164"],
  ];
  const enroll = PATIENTS.map(
    ([id]) => `(${id}, DATE '2017-01-01', DATE '2021-12-31', '1', '1', 1970, 49, 'M', '1', '1', '1')`,
  ).join(",\n  ");
  const op = PATIENTS.map(
    ([id, dx]) => `(${id}, DATE '2019-06-01', '0', '${dx}', NULL, NULL, NULL, NULL, '10', 200, NULL, NULL, NULL, NULL)`,
  ).join(",\n  ");
  return [
    FIXTURE_DDL,
    `INSERT INTO ccaet_all (enrolid,dtstart,dtend,rx,drugcovg,dobyr,age,sex,region,plantyp,egeoloc) VALUES\n  ${enroll};`,
    `INSERT INTO ccaeo_all (enrolid,svcdate,dxver,dx1,dx2,dx3,dx4,proc1,stdplac,paytot,netpay,copay,deduct,coins) VALUES\n  ${op};`,
  ].join("\n");
}

function specWith(codes: CodeEntry[]): StudySpec {
  return {
    meta: {
      title: "prefix-match test", version: "1.0", database: "marketscan_ccae",
      studyPeriod: { start: "2018-01-01", end: "2020-12-31" },
      provenance: { method: "manual" },
    },
    codeLists: [{ id: "panc", label: "Acute pancreatitis (K85 family)", system: "icd10cm", codes }],
    indexEvent: { type: "first_diagnosis", codeListId: "panc", indexPeriod: { start: "2019-01-01", end: "2019-12-31" } },
    enrollment: { baselineDays: 1, followupDays: 1, gapAllowanceDays: 31, requiresRxCoverage: false },
    criteria: [],
    baseline: [],
    outcomes: [], groupVars: [], comparisons: [],
    analyses: [{ id: "a_attr", label: "Attrition", kind: "attrition", enabled: true }],
  } as unknown as StudySpec;
}

const K85_FAMILY: CodeEntry = { code: "K85", source: "user_entered", verified: true, match: "prefix" };
const K85_EXACT: CodeEntry = { code: "K85", source: "user_entered", verified: true };
const E1165_LEAF: CodeEntry = { code: "E1165", source: "user_entered", verified: true };

async function matchedEnrolids(spec: StudySpec): Promise<number[]> {
  const { db, ok, steps } = await seedAndRun(spec, OPTS, seed());
  if (!ok) {
    const bad = steps.find((s) => !s.ok);
    throw new Error(`emitted SQL did not execute: ${bad?.path} :: ${bad?.error}`);
  }
  const tbl = (await rows<{ table_name: string }>(
    db, "SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%_events' LIMIT 1"))[0]?.table_name;
  if (!tbl) throw new Error("no events table was emitted");
  const r = await rows<{ enrolid: number }>(
    db, `SELECT DISTINCT enrolid FROM ${tbl} WHERE code_list_id = 'panc' ORDER BY enrolid`);
  return r.map((x) => Number(x.enrolid));
}

const eq = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export async function verifyPrefixMatching(): Promise<Check[]> {
  const out: Check[] = [];
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });

  /* PREFIX run: K85 family + the E1165 leaf. */
  const prefixHits = await matchedEnrolids(specWith([K85_FAMILY, E1165_LEAF]));
  push("prefix: K85 family matches K850, K8590, K859 and the E1165 leaf, nothing else",
    eq(prefixHits, [1, 2, 3, 6]), `matched enrolids [${prefixHits.join(", ")}], expected [1, 2, 3, 6]`);
  push("prefix: K95 and J450 are NOT swept in by 'K85%'",
    !prefixHits.includes(4) && !prefixHits.includes(5), `matched [${prefixHits.join(", ")}]`);
  push("prefix: the exact leaf E1165 does not match its neighbour E1164",
    prefixHits.includes(6) && !prefixHits.includes(7), `matched [${prefixHits.join(", ")}]`);

  /* EXACT run: the SAME codes, only the family flag removed. This is the bug the
   * fix repairs, pinned as an executed fact: exact "K85" matches no real claim. */
  const exactHits = await matchedEnrolids(specWith([K85_EXACT, E1165_LEAF]));
  push("exact (the old behaviour): 'K85' as an exact code matches NONE of K850/K8590/K859",
    !exactHits.includes(1) && !exactHits.includes(2) && !exactHits.includes(3),
    `matched enrolids [${exactHits.join(", ")}] — only the E1165 leaf should remain`);
  push("exact: the leaf E1165 still matches under exact mode (fix did not loosen it)",
    eq(exactHits, [6]), `matched [${exactHits.join(", ")}], expected [6]`);

  /* The whole point, stated as one comparison: the flag is the difference. */
  push("prefix vs exact: the family flag is the ONLY difference, and it turns an empty match into three patients",
    prefixHits.filter((x) => x <= 3).length === 3 && exactHits.filter((x) => x <= 3).length === 0,
    `prefix matched ${prefixHits.filter((x) => x <= 3).length} of the K85 family, exact matched 0`);

  return out;
}
