/**
 * The whole suite, as one call, streamed.
 *
 * WHY THIS EXISTS. The CLI and the browser were running DIFFERENT amounts of
 * verification: `npm run verify` executed every gold case, every guard, the
 * coverage gate and the mutation tests, while the browser's Run button called
 * `verifyGoldA` alone. So the README said 1572 and the screen said 1058, and
 * the two numbers were both honest and not the same. On a project whose entire
 * claim is that it does not assert what it has not checked, a headline figure
 * nobody can reproduce from the UI is the least defensible thing in the repo.
 *
 * Both surfaces now call this. One list, one count, one definition of "the
 * checks", and if it ever drifts again it drifts for both at once.
 *
 * STREAMING, BECAUSE THE PROGRESS HAS TO BE REAL. The Margin fills at the pace
 * checks actually complete, so this reports each GROUP as it finishes rather
 * than resolving once at the end. A group that takes four seconds shows as four
 * seconds of stillness, which is the truth. Nothing here interpolates, and
 * nothing pre-announces a total it has not yet computed: `total` is unknown
 * until the run ends, because the number of checks depends on what the
 * emitters produce.
 */
import type { Check } from "./run";
import {
  verifyGoldA, verifyGoldB, verifyGoldC, verifyGoldD, verifyGoldE, verifyGoldF, verifyGoldG,
  verifyDaysPerYearChoice, verifySettingFilterControl, verifyAscertainmentWindow,
  verifyDataCutReachesBothTwins, verifyWashoutToggle, verifySuppression,
} from "./run";
import { verifySilenceGuards } from "./guards";
import { fingerprintCoverageChecks, coverageGuardSelfTest, standardPopulationChecks } from "./coverage";
import { mutationChecks } from "./mutation";
import { specChatGuards } from "./chat";
import { reviewQueueGuards } from "./review-queue";

export interface CheckGroup {
  /** shown in the UI as a band label; also the CLI's section heading */
  title: string;
  checks: Check[];
}

export interface SuiteProgress {
  /** groups completed so far, in execution order */
  groups: CheckGroup[];
  /** every check so far, flattened, in execution order */
  checks: Check[];
  failed: number;
  /** groups finished / groups planned. The only thing knowable in advance. */
  groupsDone: number;
  groupsTotal: number;
  done: boolean;
}

/* Execution order is deliberate: the executing gold cases first, because they
 * are the slowest and the most load-bearing, so a watcher sees real work
 * immediately rather than a burst of instant static checks. */
const GROUPS: Array<{ title: string; run: () => Check[] | Promise<Check[]> }> = [
  { title: "Gold Case A — the spine and descriptive epi", run: async () => (await verifyGoldA()).checks },
  { title: "Gold Case B — regression families", run: verifyGoldB },
  { title: "Gold Case C — tied event times", run: verifyGoldC },
  { title: "Gold Case D — competing risks", run: verifyGoldD },
  { title: "Gold Case E — fractional IPCW weights", run: verifyGoldE },
  { title: "Gold Case F — adherence and dirty days supply", run: verifyGoldF },
  { title: "Gold Case G — switching and line of therapy", run: verifyGoldG },
  { title: "Person-time constant", run: verifyDaysPerYearChoice },
  { title: "Care-setting filter (negative control)", run: verifySettingFilterControl },
  { title: "Ascertainment window", run: verifyAscertainmentWindow },
  { title: "Data cut reaches both twins", run: () => verifyDataCutReachesBothTwins() },
  { title: "Washout toggle", run: verifyWashoutToggle },
  { title: "Small-cell suppression", run: verifySuppression },
  { title: "Silence guards (refusals must speak)", run: () => verifySilenceGuards() },
  { title: "Verification coverage", run: () => [...fingerprintCoverageChecks(), ...coverageGuardSelfTest(), ...standardPopulationChecks()] },
  { title: "Mutation tests (the proof it can fail)", run: () => mutationChecks() },
  { title: "Spec chat (a model cannot sign its own work off)", run: () => specChatGuards() },
  { title: "Review queue", run: () => reviewQueueGuards() },
];

export const SUITE_GROUP_COUNT = GROUPS.length;

/**
 * Run everything. `onGroup` fires after each group completes, so a caller can
 * render progress that measures something rather than animating a guess.
 *
 * A group that THROWS is reported as a single failed check rather than taking
 * the run down: a harness that dies silently on one bad group is exactly the
 * silence this project spends its effort eliminating.
 */
export async function verifyAll(
  onGroup?: (p: SuiteProgress) => void,
): Promise<SuiteProgress> {
  const groups: CheckGroup[] = [];
  const checks: Check[] = [];

  for (const g of GROUPS) {
    let out: Check[];
    try {
      out = await g.run();
    } catch (err) {
      out = [{
        name: `${g.title} — group threw`,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
      }];
    }
    groups.push({ title: g.title, checks: out });
    checks.push(...out);
    onGroup?.({
      groups: [...groups],
      checks: [...checks],
      failed: checks.filter((c) => c.status === "fail").length,
      groupsDone: groups.length,
      groupsTotal: GROUPS.length,
      done: groups.length === GROUPS.length,
    });
  }

  return {
    groups, checks,
    failed: checks.filter((c) => c.status === "fail").length,
    groupsDone: groups.length,
    groupsTotal: GROUPS.length,
    done: true,
  };
}
