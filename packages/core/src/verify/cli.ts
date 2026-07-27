/* Verification entry — run: npm run verify -w @heor-studio/core */
import { verifyGoldA, verifyDaysPerYearChoice, verifySettingFilterControl, verifySuppression, verifyWashoutToggle, verifyAscertainmentWindow } from "./run";
import { fingerprintCoverageChecks, coverageGuardSelfTest, standardPopulationChecks } from "./coverage";
import { verifySilenceGuards } from "./guards";

async function main() {
  const r = await verifyGoldA();
  const dpy = await verifyDaysPerYearChoice();
  const sfc = await verifySettingFilterControl();
  const aw = await verifyAscertainmentWindow();
  const wt = await verifyWashoutToggle();
  const sup = await verifySuppression();
  const sg = verifySilenceGuards();

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

  console.log("\n=== outcome care-setting filter (negative control) ===");
  for (const c of sfc) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  const cov = [...fingerprintCoverageChecks(), ...coverageGuardSelfTest(), ...standardPopulationChecks()];
  console.log("\n=== verification coverage (every module must declare its own coverage) ===");
  for (const c of cov) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  console.log("\n=== ascertainment window (studyPeriod must not truncate lookbacks) ===");
  for (const c of aw) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  console.log("\n=== prevalent-case washout (incidence <-> prevalence toggle) ===");
  for (const c of wt) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  console.log("\n=== small-cell suppression (BR-DEL-004, derivation-aware) ===");
  for (const c of sup) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  console.log("\n=== silence guards (readiness gate, injection, shape, bundle layout) ===");
  for (const c of sg) console.log(`  ${c.status === "pass" ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);

  const dpyOk = dpy.every((c) => c.status === "pass");
  const sfcOk = sfc.every((c) => c.status === "pass");
  const covOk = cov.every((c) => c.status === "pass");
  const awOk = aw.every((c) => c.status === "pass");
  const wtOk = wt.every((c) => c.status === "pass");
  const supOk = sup.every((c) => c.status === "pass");
  const sgOk = sg.every((c) => c.status === "pass");
  console.log(`\nGold Case A: ${r.status.toUpperCase()}${dpyOk ? "" : "  (daysPerYear regression FAILED)"}${sfcOk ? "" : "  (setting-filter control FAILED)"}${covOk ? "" : "  (coverage guard FAILED)"}${awOk ? "" : "  (ascertainment window FAILED)"}${wtOk ? "" : "  (washout toggle FAILED)"}${supOk ? "" : "  (suppression FAILED)"}${sgOk ? "" : "  (silence guards FAILED)"}`);
  process.exit(r.status === "passed" && dpyOk && sfcOk && covOk && awOk && wtOk && supOk && sgOk ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
