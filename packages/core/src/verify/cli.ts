/* Verification entry — run: npm run verify -w @heor-studio/core
 *
 * TWO LISTS BECAME ONE. This file used to enumerate every group by hand while
 * the browser's Run button called verifyGoldA alone, so the README said 1572
 * and the UI said 1058: both honest, and not the same number. Both surfaces now
 * walk verify/all.ts, which means "the checks" has a single definition and a new
 * group is picked up by the CLI and the browser in the same commit.
 *
 * AND IT FIXES A DEFECT THE HAND-WRITTEN VERSION HAD. The old exit expression
 * listed sixteen booleans and forgot four of them: gfOk, ggOk, scOk and rqOk.
 * Gold Case F, Gold Case G, the spec-chat guards and the review-queue guards
 * could every one of them fail, print FAILED in the summary banner, and the
 * process would still exit 0 — so CI would report green on a red suite. That is
 * the exact silent-success failure this harness exists to make impossible, sat
 * in the harness's own entry point.
 *
 * The lesson is the one this repo keeps relearning: a list maintained by hand
 * beside the thing it describes will drift, and the drift is invisible until it
 * matters. The pass/fail verdict is now DERIVED from the run rather than
 * assembled from remembered parts.
 */
import { verifyAll } from "./all";
import { verifyGoldA } from "./run";

async function main() {
  /* Gold A additionally carries the SQL execution log and the invariant
   * catalog, which are shaped differently from a Check[] and are worth their
   * own sections. Its CHECKS come through verifyAll like everything else, so
   * nothing here is counted twice. */
  const goldA = await verifyGoldA();

  console.log("=== emitted Postgres SQL execution ===");
  for (const s of goldA.execution) {
    console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.path}${s.error ? "  :: " + s.error : ""}`);
  }

  console.log("\n=== invariant catalog ===");
  for (const i of goldA.invariants) {
    const mark = i.status === "pass" ? "PASS" : i.status === "fail" ? "FAIL" : "skip";
    console.log(`  ${mark}  ${i.name} — ${i.detail}`);
  }

  const suite = await verifyAll((p) => {
    const g = p.groups[p.groups.length - 1];
    if (!g) return;
    console.log(`\n=== ${g.title} ===`);
    for (const c of g.checks) {
      console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
    }
  });

  const failed = suite.checks.filter((c) => c.status === "fail");
  const invariantsFailed = goldA.invariants.filter((i) => i.status === "fail");
  const execFailed = goldA.execution.filter((s) => !s.ok);

  console.log(
    `\n${suite.checks.length} checks across ${suite.groupsTotal} groups, ${failed.length} failing.`,
  );
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const c of failed) console.log(`  - ${c.name} — ${c.detail}`);
  }
  if (execFailed.length > 0) {
    console.log("\nSQL THAT DID NOT EXECUTE:");
    for (const s of execFailed) console.log(`  - ${s.path}: ${s.error}`);
  }
  if (invariantsFailed.length > 0) {
    console.log("\nINVARIANTS VIOLATED:");
    for (const i of invariantsFailed) console.log(`  - ${i.name}: ${i.detail}`);
  }

  /* THE PUBLISHED NUMBER MUST BE THIS NUMBER.
   *
   * Three times now the check count in the README has drifted from the count the
   * suite reports: it has read 751, 1377, 1554, 2342 and 2526 while the suite
   * said something else, and once all three of the README, docs/STATUS.md and the
   * GitHub repo description disagreed with each other simultaneously. Every fix
   * was a human retyping a number beside a thing that computes it, which is the
   * failure this repo keeps rediscovering in other people's code.
   *
   * So the front page is now scraped and compared. This lives at the END of the
   * CLI rather than inside the suite because a check that asserts the suite's own
   * total cannot run inside the suite: the total is not known until the last group
   * reports, which is exactly why nothing checked it before.
   *
   * Adding a check now fails the build until the README is updated. That is the
   * intended cost. A number nobody can reproduce from the repo is the one kind of
   * claim this project exists to refuse. */
  const publishedProblems: string[] = [];
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../../..");
    const total = suite.checks.length;
    for (const rel of ["README.md", "docs/STATUS.md"]) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      /* Only counts that CLAIM to be this suite's: a number immediately followed
       * by "checks". A year or a code count is not swept up. */
      const claims = [...text.matchAll(/([0-9][0-9,]{2,})\s+(?:harness\s+)?checks/gi)]
        .map((m) => Number(m[1].replace(/,/g, "")));
      for (const c of new Set(claims))
        if (c !== total) publishedProblems.push(`${rel} claims ${c} checks; the suite reports ${total}`);
    }
  }
  if (publishedProblems.length > 0) {
    console.log("\nPUBLISHED NUMBERS THAT DISAGREE WITH THIS RUN:");
    for (const p of publishedProblems) console.log(`  - ${p}`);
  }

  /* Derived, not assembled. Every failure channel is represented, and adding a
   * group cannot leave it out of the verdict. */
  const ok =
    failed.length === 0 && invariantsFailed.length === 0 && execFailed.length === 0 &&
    publishedProblems.length === 0;
  console.log(`\nVerification: ${ok ? "PASSED" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
