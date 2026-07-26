/**
 * @heor-studio/core/verify — the verification harness, exposed as a SUBPATH
 * export (not the main barrel) so the PGlite dependency never enters the web
 * app's import graph. The MCP server imports this; the browser never does.
 */
export { verifySpec, verifyGoldA, verifyDaysPerYearChoice, verifySettingFilterControl } from "./run";
export { sasSqlParityChecks } from "./parity";
export type { VerificationResult, Check } from "./run";
export type { InvariantResult } from "./invariants";
export { GOLD_A_OPTS } from "./fixture";
