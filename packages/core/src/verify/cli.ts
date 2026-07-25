/* Verification entry — run: npm run verify -w @heor-studio/core */
import { verifyGoldA, verifyDaysPerYearChoice } from "./run";

async function main() {
  const r = await verifyGoldA();
  const dpy = await verifyDaysPerYearChoice();

  console.log("=== emitted Postgres SQL execution ===");
  for (const s of r.execution) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.path}${s.error ? "  :: " + s.error : ""}`);

  console.log("\n=== ground-truth checks (executed vs hand-computed) ===");
  for (const c of r.checks) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  console.log("\n=== invariant catalog ===");
  for (const i of r.invariants) {
    const mark = i.status === "pass" ? "PASS" : i.status === "fail" ? "FAIL" : "skip";
    console.log(`  ${mark}  ${i.name} — ${i.detail}`);
  }

  console.log("\n=== configurable person-time constant (regression guard) ===");
  for (const c of dpy) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  const dpyOk = dpy.every((c) => c.status === "pass");
  console.log(`\nGold Case A: ${r.status.toUpperCase()}${dpyOk ? "" : "  (daysPerYear regression FAILED)"}`);
  process.exit(r.status === "passed" && dpyOk ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
