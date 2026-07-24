/* Verification entry — run: npm run verify -w @heor-studio/core */
import { verifyGoldA } from "./run";

async function main() {
  const r = await verifyGoldA();

  console.log("=== emitted Postgres SQL execution ===");
  for (const s of r.execution) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.path}${s.error ? "  :: " + s.error : ""}`);

  console.log("\n=== ground-truth checks (executed vs hand-computed) ===");
  for (const c of r.checks) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  console.log("\n=== invariant catalog ===");
  for (const i of r.invariants) {
    const mark = i.status === "pass" ? "PASS" : i.status === "fail" ? "FAIL" : "skip";
    console.log(`  ${mark}  ${i.name} — ${i.detail}`);
  }

  console.log(`\nGold Case A: ${r.status.toUpperCase()}`);
  process.exit(r.status === "passed" ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
