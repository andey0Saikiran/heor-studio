/**
 * @heor-studio/core/verify — the verification harness, exposed as a SUBPATH
 * export (not the main barrel) so the PGlite dependency never enters the web
 * app's import graph. The MCP server imports this; the browser never does.
 */
export { verifySpec, verifyGoldA, verifyDaysPerYearChoice, verifySettingFilterControl, verifySuppression, verifyWashoutToggle } from "./run";
/* The WHOLE suite, so the browser and the CLI count the same checks. */
export { verifyAll, SUITE_GROUP_COUNT } from "./all";
export type { SuiteProgress, CheckGroup } from "./all";
export { sasSqlParityChecks } from "./parity";
export type { VerificationResult, Check } from "./run";
export type { InvariantResult } from "./invariants";
export { GOLD_A_OPTS } from "./fixture";
