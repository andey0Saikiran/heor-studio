/**
 * Structural (shape) validation for UNTRUSTED spec JSON.
 *
 * specReadiness/validateAnalyses assume a well-typed StudySpec and check
 * SEMANTICS (dangling refs, parameter gaps). This module guards the boundary
 * BEFORE that: MCP validate_spec (and any future import path) receives raw
 * JSON, and previously cast it straight to StudySpec — so a spec with
 * `minClaims: "2"`, a missing outcomeDefinition, or a control character in a
 * code string would sail through readiness and be emitted verbatim into
 * generated SQL/SAS. Every field an emitter dereferences is checked here.
 *
 * Deliberately hand-rolled (core carries no schema-library dependency) and
 * path-labeled: each problem reads like "analyses[2].horizonDays: expected a
 * finite number > 0, got string".
 */
import type { StudySpec } from "./types";

const DATABASES = new Set(["marketscan_ccae", "marketscan_mdcr", "marketscan_medicaid"]);
const CODE_SYSTEMS = new Set(["icd9cm", "icd10cm", "cpt_hcpcs", "ndc", "drug_name"]);
const CODE_SOURCES = new Set(["ai_suggested", "vocabulary_lookup", "user_entered", "imported"]);
const SETTINGS = new Set(["any", "inpatient", "outpatient", "pharmacy"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const INDEX_TYPES = new Set(["first_drug_claim", "first_diagnosis", "first_procedure"]);
const DX_POSITIONS = new Set(["any", "primary"]);
const PT_STARTS = new Set(["index", "enrollment_start", "washout_end"]);
const PT_CENSORS = new Set(["outcome", "disenrollment", "death", "study_end", "max_followup"]);
const PROP_CI = new Set(["wilson", "clopper_pearson", "wald"]);
const RATE_CI = new Set(["poisson_byar", "poisson_exact", "wald_log"]);
const RECURRENCE = new Set(["first_only", "all_events"]);
const DEMO_AXES = new Set(["age_band", "sex", "region", "plan_type", "year"]);
/** Analysis kinds this structural gate accepts.
 *
 * This list is SEPARATE from EMITTABLE_ANALYSIS_KINDS in spec/types.ts, and
 * that separation once cost a working build: registering treatment_switching
 * taught the emitters and readiness about it but not this checker, so the MCP
 * server rejected its own demo spec with "unknown analysis kind" while every
 * emitter was perfectly happy. The registry's load-time throws catch the
 * registry/readiness disagreement; nothing was watching this third list.
 *
 * verify/coverage.ts now asserts the two agree, so the next kind cannot land
 * half-registered. */
export const SHAPE_CHECKED_ANALYSIS_KINDS = new Set([
  "attrition", "table1", "point_prevalence", "period_prevalence", "cumulative_incidence",
  "incidence_rate", "standardization", "calendar_trend", "resource_use",
  "comorbidity_index", "regression", "survival", "cox", "competing_risks", "fine_gray", "propensity_score", "iptw_outcome", "g_formula", "adherence", "treatment_switching", "statistical_engine", "future_stub",
]);
const ANALYSIS_KINDS = SHAPE_CHECKED_ANALYSIS_KINDS;
const SURVIVAL_CI = new Set(["log_log", "linear"]);
const SURVIVAL_ENDPOINTS = new Set(["claims_event", "death"]);

const LEDGER_SETTINGS = new Set(["inpatient", "ed", "outpatient", "pharmacy"]);
const COST_FIELDS = new Set(["paytot", "netpay"]);

/** Generous DoS caps — real studies sit far below these. */
const MAX = { codeLists: 200, codesPerList: 5000, criteria: 200, baseline: 200, analyses: 100, stratifiers: 25 };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Slug ids flow into file names (codelists/{id}.csv) and SAS/SQL names. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Codes/labels are embedded in generated code as (escaped) literals — but
 *  control characters, quotes and backslashes are never legitimate in a
 *  clinical code and only ever appear in garbage or injection attempts. */
const SAFE_CODE = /^[\x20-\x7E]+$/;

class Problems {
  list: string[] = [];
  push(path: string, msg: string): void {
    if (this.list.length < 100) this.list.push(`${path}: ${msg}`);
    else if (this.list.length === 100) this.list.push("... further problems truncated at 100");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function need(p: Problems, path: string, cond: boolean, msg: string): boolean {
  if (!cond) p.push(path, msg);
  return cond;
}

function needStr(p: Problems, o: Record<string, unknown>, key: string, path: string, opts?: { nonEmpty?: boolean }): boolean {
  const v = o[key];
  if (!isStr(v)) { p.push(`${path}.${key}`, `expected a string, got ${typeOf(v)}`); return false; }
  if (opts?.nonEmpty && v.length === 0) { p.push(`${path}.${key}`, "must not be empty"); return false; }
  return true;
}

function needEnum(p: Problems, o: Record<string, unknown>, key: string, path: string, allowed: Set<string>): boolean {
  const v = o[key];
  if (!isStr(v) || !allowed.has(v)) {
    p.push(`${path}.${key}`, `expected one of [${[...allowed].join(", ")}], got ${JSON.stringify(v)}`);
    return false;
  }
  return true;
}

function needNum(p: Problems, o: Record<string, unknown>, key: string, path: string, opts?: { min?: number; max?: number }): boolean {
  const v = o[key];
  if (!isNum(v)) { p.push(`${path}.${key}`, `expected a finite number, got ${typeOf(v)}`); return false; }
  if (opts?.min !== undefined && v < opts.min) { p.push(`${path}.${key}`, `must be >= ${opts.min}, got ${v}`); return false; }
  if (opts?.max !== undefined && v > opts.max) { p.push(`${path}.${key}`, `must be <= ${opts.max}, got ${v}`); return false; }
  return true;
}

function needBool(p: Problems, o: Record<string, unknown>, key: string, path: string): boolean {
  if (!isBool(o[key])) { p.push(`${path}.${key}`, `expected a boolean, got ${typeOf(o[key])}`); return false; }
  return true;
}

/** Free text (titles, versions, provenance) is printed verbatim into SQL "--"
 *  lines and SAS block comments in every generated file. Control characters
 *  (esp. newlines) escape a "--" comment; a close-comment sequence (star-slash)
 *  closes a SAS block comment. Either turns the remainder of a header into live
 *  code. Reject both at the boundary — emitters also escape (oneLine/cmt). */
function needSafeText(p: Problems, o: Record<string, unknown>, key: string, path: string, opts?: { nonEmpty?: boolean; maxLen?: number }): boolean {
  if (!needStr(p, o, key, path, opts)) return false;
  const v = o[key] as string;
  if (v.length > (opts?.maxLen ?? 300)) { p.push(`${path}.${key}`, `too long (> ${opts?.maxLen ?? 300} chars)`); return false; }
  // oxlint-disable-next-line no-control-regex -- matching control characters IS
  // the check: a newline here escapes a generated `--` comment into live code.
  if (/[\x00-\x1F\x7F]/.test(v)) { p.push(`${path}.${key}`, "contains control characters (e.g. newlines/tabs) — it is printed into SQL/SAS comment headers where a newline escapes the comment"); return false; }
  if (v.includes("*/")) { p.push(`${path}.${key}`, 'contains "*/" — it is printed into SAS block comments where that sequence closes the comment and turns the rest into live code'); return false; }
  return true;
}

function needIso(p: Problems, o: Record<string, unknown>, key: string, path: string): boolean {
  const v = o[key];
  if (!isStr(v) || !ISO_DATE.test(v)) {
    p.push(`${path}.${key}`, `expected an ISO date "YYYY-MM-DD", got ${JSON.stringify(v)}`);
    return false;
  }
  return true;
}

function needArr(p: Problems, o: Record<string, unknown>, key: string, path: string, max: number): unknown[] | null {
  const v = o[key];
  if (!Array.isArray(v)) { p.push(`${path}.${key}`, `expected an array, got ${typeOf(v)}`); return null; }
  if (v.length > max) { p.push(`${path}.${key}`, `too many entries (${v.length} > ${max})`); return null; }
  return v;
}

function typeOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/* ---------- sub-shapes ---------- */

function checkWindow(p: Problems, v: unknown, path: string): void {
  if (!isObj(v)) { p.push(path, `expected a RelativeWindow object, got ${typeOf(v)}`); return; }
  for (const key of ["start", "end"] as const) {
    const b = v[key];
    const okBound = isNum(b) || b === "anytime_before" || b === "anytime_after";
    need(p, `${path}.${key}`, okBound, `expected a day offset number or "anytime_before"/"anytime_after", got ${JSON.stringify(b)}`);
  }
  needBool(p, v, "includesIndex", path);
}

function checkOutcomeDefinition(p: Problems, v: unknown, path: string): void {
  if (!isObj(v)) { p.push(path, `expected an OutcomeDefinition object, got ${typeOf(v)}`); return; }
  needStr(p, v, "codeListId", path); // empty allowed: readiness reports "not yet chosen"
  needNum(p, v, "minClaims", path, { min: 1 });
  if (v.claimSeparationDays !== undefined) needNum(p, v, "claimSeparationDays", path, { min: 0 });
  needEnum(p, v, "setting", path, SETTINGS);
  needEnum(p, v, "diagnosisPosition", path, DX_POSITIONS);
}

function checkPersonTimeRule(p: Problems, v: unknown, path: string): void {
  if (!isObj(v)) { p.push(path, `expected a PersonTimeRule object, got ${typeOf(v)}`); return; }
  needEnum(p, v, "start", path, PT_STARTS);
  const arr = needArr(p, v, "censorAt", path, 10);
  if (arr) arr.forEach((c, i) => need(p, `${path}.censorAt[${i}]`, isStr(c) && PT_CENSORS.has(c), `expected one of [${[...PT_CENSORS].join(", ")}], got ${JSON.stringify(c)}`));
  if (v.maxFollowupDays !== undefined) needNum(p, v, "maxFollowupDays", path, { min: 1 });
}

function checkStratifiers(p: Problems, o: Record<string, unknown>, path: string): void {
  const arr = needArr(p, o, "stratifyBy", path, MAX.stratifiers);
  if (!arr) return;
  arr.forEach((s, i) => {
    const sp = `${path}.stratifyBy[${i}]`;
    if (!isObj(s)) { p.push(sp, `expected a Stratifier object, got ${typeOf(s)}`); return; }
    needStr(p, s, "id", sp, { nonEmpty: true });
    needStr(p, s, "label", sp);
    const src = s.source;
    if (!isObj(src)) { p.push(`${sp}.source`, `expected an object, got ${typeOf(src)}`); return; }
    if (src.kind === "baseline") needStr(p, src, "baselineId", `${sp}.source`, { nonEmpty: true });
    else if (src.kind === "demographic") needEnum(p, src, "axis", `${sp}.source`, DEMO_AXES);
    else p.push(`${sp}.source.kind`, `expected "baseline" or "demographic", got ${JSON.stringify(src.kind)}`);
    if (s.ageBandLowerBounds !== undefined) {
      if (!Array.isArray(s.ageBandLowerBounds)) p.push(`${sp}.ageBandLowerBounds`, "expected an array of numbers");
      else s.ageBandLowerBounds.forEach((b, j) => need(p, `${sp}.ageBandLowerBounds[${j}]`, isNum(b), `expected a finite number, got ${typeOf(b)}`));
    }
  });
}

function checkDatePair(p: Problems, v: unknown, path: string): void {
  if (!isObj(v)) { p.push(path, `expected {start, end} ISO dates, got ${typeOf(v)}`); return; }
  const okS = needIso(p, v, "start", path);
  const okE = needIso(p, v, "end", path);
  if (okS && okE && (v.start as string) > (v.end as string)) p.push(path, `start ${JSON.stringify(v.start)} is after end ${JSON.stringify(v.end)}`);
}

/* ---------- analyses ---------- */

function checkAnalysis(p: Problems, v: unknown, path: string): void {
  if (!isObj(v)) { p.push(path, `expected an Analysis object, got ${typeOf(v)}`); return; }
  needStr(p, v, "id", path, { nonEmpty: true });
  if (isStr(v.id) && !SLUG.test(v.id)) p.push(`${path}.id`, `must be a slug (letters/digits/_/-), got ${JSON.stringify(v.id)} — analysis ids become SQL/SAS table suffixes`);
  needStr(p, v, "label", path);
  needBool(p, v, "enabled", path);
  const kind = v.kind;
  if (!isStr(kind) || !ANALYSIS_KINDS.has(kind)) {
    p.push(`${path}.kind`, `unknown analysis kind ${JSON.stringify(kind)} — expected one of [${[...ANALYSIS_KINDS].join(", ")}]`);
    return;
  }
  switch (kind) {
    case "attrition":
    case "table1":
      break;
    case "point_prevalence": {
      checkOutcomeDefinition(p, v.outcomeDefinition, `${path}.outcomeDefinition`);
      const a = v.anchorDate;
      if (!isObj(a)) p.push(`${path}.anchorDate`, `expected {kind:"fixed",date} or {kind:"index"}, got ${typeOf(a)}`);
      else if (a.kind === "fixed") needIso(p, a, "date", `${path}.anchorDate`);
      else if (a.kind !== "index") p.push(`${path}.anchorDate.kind`, `expected "fixed" or "index", got ${JSON.stringify(a.kind)}`);
      needEnum(p, v, "ciMethod", path, PROP_CI);
      checkStratifiers(p, v, path);
      break;
    }
    case "period_prevalence":
      checkOutcomeDefinition(p, v.outcomeDefinition, `${path}.outcomeDefinition`);
      checkDatePair(p, v.prevalencePeriod, `${path}.prevalencePeriod`);
      needEnum(p, v, "ciMethod", path, PROP_CI);
      checkStratifiers(p, v, path);
      break;
    case "cumulative_incidence":
      checkOutcomeDefinition(p, v.outcomeDefinition, `${path}.outcomeDefinition`);
      checkWindow(p, v.washout, `${path}.washout`);
      needNum(p, v, "horizonDays", path, { min: 1 });
      checkPersonTimeRule(p, v.personTimeRule, `${path}.personTimeRule`);
      needEnum(p, v, "ciMethod", path, PROP_CI);
      checkStratifiers(p, v, path);
      break;
    case "incidence_rate":
      checkOutcomeDefinition(p, v.outcomeDefinition, `${path}.outcomeDefinition`);
      checkWindow(p, v.washout, `${path}.washout`);
      checkPersonTimeRule(p, v.personTimeRule, `${path}.personTimeRule`);
      needNum(p, v, "rateMultiplier", path, { min: 1 });
      needEnum(p, v, "recurrence", path, RECURRENCE);
      needEnum(p, v, "ciMethod", path, RATE_CI);
      checkStratifiers(p, v, path);
      break;
    // Not emittable yet — readiness blocks them when enabled; shape only needs
    // the common header (checked above) to hold.
    case "resource_use": {
      checkWindow(p, v.ascertainmentWindow, `${path}.ascertainmentWindow`);
      if (!Array.isArray(v.settings)) p.push(`${path}.settings`, `expected an array of care settings, got ${typeOf(v.settings)}`);
      else {
        if (v.settings.length === 0) p.push(`${path}.settings`, "expected at least one setting — an empty list would count nothing");
        v.settings.forEach((x, j) => need(p, `${path}.settings[${j}]`, LEDGER_SETTINGS.has(x as string), `expected one of [${[...LEDGER_SETTINGS].join(", ")}], got ${JSON.stringify(x)}`));
      }
      needEnum(p, v, "costField", path, COST_FIELDS);
      needBool(p, v, "includeCombined", path);
      if (v.edPlaceOfService !== undefined) {
        if (!Array.isArray(v.edPlaceOfService)) p.push(`${path}.edPlaceOfService`, "expected an array of place-of-service codes");
        else v.edPlaceOfService.forEach((x, j) => need(p, `${path}.edPlaceOfService[${j}]`, isStr(x) && SAFE_CODE.test(x), `expected a printable code string, got ${typeOf(x)}`));
      }
      break;
    }
    case "comorbidity_index": {
      needStr(p, v, "indexName", path, { nonEmpty: true });
      checkWindow(p, v.lookback, `${path}.lookback`);
      if (!Array.isArray(v.conditions)) p.push(`${path}.conditions`, `expected an array of conditions, got ${typeOf(v.conditions)}`);
      else v.conditions.forEach((c, j) => {
        const cp = `${path}.conditions[${j}]`;
        if (!isObj(c)) { p.push(cp, `expected a condition object, got ${typeOf(c)}`); return; }
        needStr(p, c, "id", cp, { nonEmpty: true });
        needStr(p, c, "label", cp);
        needStr(p, c, "codeListId", cp, { nonEmpty: true });
        needNum(p, c, "weight", cp, { min: 0 });
        if (c.supersedes !== undefined) {
          if (!Array.isArray(c.supersedes)) p.push(`${cp}.supersedes`, "expected an array of condition ids");
          else c.supersedes.forEach((x, k) => need(p, `${cp}.supersedes[${k}]`, isStr(x), `expected a condition id string, got ${typeOf(x)}`));
        }
      });
      if (!Array.isArray(v.scoreBands)) p.push(`${path}.scoreBands`, `expected an array of numbers, got ${typeOf(v.scoreBands)}`);
      else v.scoreBands.forEach((b, j) => need(p, `${path}.scoreBands[${j}]`, isNum(b), `expected a finite number, got ${typeOf(b)}`));
      break;
    }
    case "regression": {
      needStr(p, v, "family", path, { nonEmpty: true });
      checkOutcomeDefinition(p, v.outcomeDefinition, `${path}.outcomeDefinition`);
      checkWindow(p, v.washout, `${path}.washout`);
      needNum(p, v, "horizonDays", path, { min: 1 });
      needStr(p, v, "groupVarId", path, { nonEmpty: true });
      if (v.personTimeRule !== undefined) checkPersonTimeRule(p, v.personTimeRule, `${path}.personTimeRule`);
      if (v.recurrence !== undefined) needEnum(p, v, "recurrence", path, RECURRENCE);
      if (v.continuousResponse !== undefined) {
        const rp = `${path}.continuousResponse`;
        if (!isObj(v.continuousResponse)) p.push(rp, `expected {source, comorbidityIndexAnalysisId}, got ${typeOf(v.continuousResponse)}`);
        else {
          need(p, `${rp}.source`, v.continuousResponse.source === "comorbidity_index", `expected "comorbidity_index", got ${JSON.stringify(v.continuousResponse.source)}`);
          needStr(p, v.continuousResponse, "comorbidityIndexAnalysisId", rp, { nonEmpty: true });
        }
      }
      if (v.costResponse !== undefined) {
        const cp = `${path}.costResponse`;
        if (!isObj(v.costResponse)) p.push(cp, `expected {window, settings, costField}, got ${typeOf(v.costResponse)}`);
        else {
          checkWindow(p, v.costResponse.window, `${cp}.window`);
          needEnum(p, v.costResponse, "costField", cp, COST_FIELDS);
          if (!Array.isArray(v.costResponse.settings)) p.push(`${cp}.settings`, "expected an array of care settings");
          else v.costResponse.settings.forEach((x, j) => need(p, `${cp}.settings[${j}]`, LEDGER_SETTINGS.has(x as string), `expected one of [${[...LEDGER_SETTINGS].join(", ")}], got ${JSON.stringify(x)}`));
        }
      }
      if (!Array.isArray(v.covariateIds)) p.push(`${path}.covariateIds`, `expected an array of baseline ids, got ${typeOf(v.covariateIds)}`);
      else v.covariateIds.forEach((x, j) => need(p, `${path}.covariateIds[${j}]`, isStr(x), `expected a baseline id string, got ${typeOf(x)}`));
      break;
    }
    case "survival": {
      /* The endpoint is shape-checked but NOT refused here: shape validation
       * says whether untrusted JSON has the right FORM, and readiness says
       * whether the study can be run. A mortality endpoint is well-formed and
       * unbuildable, so it must reach specReadiness to be refused there with
       * its reason, rather than being rejected here as malformed. */
      const ep = `${path}.endpoint`;
      if (!isObj(v.endpoint)) p.push(ep, `expected {kind, ...}, got ${typeOf(v.endpoint)}`);
      else {
        needEnum(p, v.endpoint, "kind", ep, SURVIVAL_ENDPOINTS);
        if (v.endpoint.kind === "claims_event") checkOutcomeDefinition(p, v.endpoint.outcomeDefinition, `${ep}.outcomeDefinition`);
      }
      checkWindow(p, v.washout, `${path}.washout`);
      checkPersonTimeRule(p, v.personTimeRule, `${path}.personTimeRule`);
      needEnum(p, v, "ciMethod", path, SURVIVAL_CI);
      need(p, `${path}.emitLifeTable`, typeof v.emitLifeTable === "boolean", `expected a boolean, got ${typeOf(v.emitLifeTable)}`);
      if (v.groupVarId !== undefined) needStr(p, v, "groupVarId", path, { nonEmpty: true });
      if (!Array.isArray(v.horizonDays)) p.push(`${path}.horizonDays`, `expected an array of day marks, got ${typeOf(v.horizonDays)}`);
      else v.horizonDays.forEach((x, j) => need(p, `${path}.horizonDays[${j}]`, typeof x === "number" && Number.isFinite(x), `expected a number, got ${typeOf(x)}`));
      break;
    }
    case "cox": {
      const epc = `${path}.endpoint`;
      if (!isObj(v.endpoint)) p.push(epc, `expected {kind, ...}, got ${typeOf(v.endpoint)}`);
      else {
        needEnum(p, v.endpoint, "kind", epc, SURVIVAL_ENDPOINTS);
        if (v.endpoint.kind === "claims_event") checkOutcomeDefinition(p, v.endpoint.outcomeDefinition, `${epc}.outcomeDefinition`);
      }
      checkWindow(p, v.washout, `${path}.washout`);
      checkPersonTimeRule(p, v.personTimeRule, `${path}.personTimeRule`);
      needStr(p, v, "groupVarId", path, { nonEmpty: true });
      needStr(p, v, "ties", path, { nonEmpty: true });
      if (!Array.isArray(v.covariateIds)) p.push(`${path}.covariateIds`, `expected an array of baseline ids, got ${typeOf(v.covariateIds)}`);
      else v.covariateIds.forEach((x, j) => need(p, `${path}.covariateIds[${j}]`, isStr(x), `expected a baseline id string, got ${typeOf(x)}`));
      break;
    }
    case "competing_risks": {
      const epr = `${path}.endpoint`;
      if (!isObj(v.endpoint)) p.push(epr, `expected {kind, ...}, got ${typeOf(v.endpoint)}`);
      else {
        needEnum(p, v.endpoint, "kind", epr, SURVIVAL_ENDPOINTS);
        if (v.endpoint.kind === "claims_event") checkOutcomeDefinition(p, v.endpoint.outcomeDefinition, `${epr}.outcomeDefinition`);
      }
      if (!Array.isArray(v.competingEvents)) p.push(`${path}.competingEvents`, `expected an array, got ${typeOf(v.competingEvents)}`);
      else v.competingEvents.forEach((ce, j) => {
        const cp = `${path}.competingEvents[${j}]`;
        if (!isObj(ce)) { p.push(cp, `expected an object, got ${typeOf(ce)}`); return; }
        needStr(p, ce, "id", cp, { nonEmpty: true });
        needStr(p, ce, "label", cp, { nonEmpty: true });
        checkOutcomeDefinition(p, ce.outcomeDefinition, `${cp}.outcomeDefinition`);
      });
      checkWindow(p, v.washout, `${path}.washout`);
      checkPersonTimeRule(p, v.personTimeRule, `${path}.personTimeRule`);
      if (!Array.isArray(v.horizonDays)) p.push(`${path}.horizonDays`, `expected an array of day marks, got ${typeOf(v.horizonDays)}`);
      else v.horizonDays.forEach((h, j) => need(p, `${path}.horizonDays[${j}]`, isNum(h), `expected a number, got ${typeOf(h)}`));
      needBool(p, v, "emitNaiveComparison", path);
      needBool(p, v, "emitLifeTable", path);
      break;
    }
    case "fine_gray": {
      const epf = `${path}.endpoint`;
      if (!isObj(v.endpoint)) p.push(epf, `expected {kind, ...}, got ${typeOf(v.endpoint)}`);
      else {
        needEnum(p, v.endpoint, "kind", epf, SURVIVAL_ENDPOINTS);
        if (v.endpoint.kind === "claims_event") checkOutcomeDefinition(p, v.endpoint.outcomeDefinition, `${epf}.outcomeDefinition`);
      }
      if (!Array.isArray(v.competingEvents)) p.push(`${path}.competingEvents`, `expected an array, got ${typeOf(v.competingEvents)}`);
      else v.competingEvents.forEach((ce, j) => {
        const cp = `${path}.competingEvents[${j}]`;
        if (!isObj(ce)) { p.push(cp, `expected an object, got ${typeOf(ce)}`); return; }
        needStr(p, ce, "id", cp, { nonEmpty: true });
        needStr(p, ce, "label", cp, { nonEmpty: true });
        checkOutcomeDefinition(p, ce.outcomeDefinition, `${cp}.outcomeDefinition`);
      });
      checkWindow(p, v.washout, `${path}.washout`);
      checkPersonTimeRule(p, v.personTimeRule, `${path}.personTimeRule`);
      needStr(p, v, "groupVarId", path, { nonEmpty: true });
      if (!Array.isArray(v.covariateIds)) p.push(`${path}.covariateIds`, `expected an array of baseline ids, got ${typeOf(v.covariateIds)}`);
      else v.covariateIds.forEach((x, j) => need(p, `${path}.covariateIds[${j}]`, isStr(x), `expected a baseline id string, got ${typeOf(x)}`));
      break;
    }
    case "propensity_score": {
      needStr(p, v, "groupVarId", path, { nonEmpty: true });
      needStr(p, v, "method", path, { nonEmpty: true });
      needStr(p, v, "estimand", path, { nonEmpty: true });
      needBool(p, v, "stabilized", path);
      needNum(p, v, "trim", path);
      for (const key of ["psCovariateIds", "balanceCovariateIds"]) {
        const arr = (v as Record<string, unknown>)[key];
        if (!Array.isArray(arr)) p.push(`${path}.${key}`, `expected an array of baseline ids, got ${typeOf(arr)}`);
        else arr.forEach((x, j) => need(p, `${path}.${key}[${j}]`, isStr(x), `expected a baseline id string, got ${typeOf(x)}`));
      }
      break;
    }
    case "iptw_outcome": {
      needStr(p, v, "groupVarId", path, { nonEmpty: true });
      needStr(p, v, "estimand", path, { nonEmpty: true });
      needBool(p, v, "stabilized", path);
      needBool(p, v, "doublyRobust", path);
      needNum(p, v, "trim", path);
      needNum(p, v, "horizonDays", path);
      checkOutcomeDefinition(p, v.outcomeDefinition, `${path}.outcomeDefinition`);
      checkWindow(p, v.washout, `${path}.washout`);
      if (!Array.isArray(v.psCovariateIds)) p.push(`${path}.psCovariateIds`, `expected an array of baseline ids, got ${typeOf(v.psCovariateIds)}`);
      else v.psCovariateIds.forEach((x, j) => need(p, `${path}.psCovariateIds[${j}]`, isStr(x), `expected a baseline id string, got ${typeOf(x)}`));
      break;
    }
    case "g_formula": {
      needStr(p, v, "groupVarId", path, { nonEmpty: true });
      needNum(p, v, "horizonDays", path);
      checkOutcomeDefinition(p, v.outcomeDefinition, `${path}.outcomeDefinition`);
      checkWindow(p, v.washout, `${path}.washout`);
      if (!Array.isArray(v.covariateIds)) p.push(`${path}.covariateIds`, `expected an array of baseline ids, got ${typeOf(v.covariateIds)}`);
      else v.covariateIds.forEach((x, j) => need(p, `${path}.covariateIds[${j}]`, isStr(x), `expected a baseline id string, got ${typeOf(x)}`));
      break;
    }
    case "adherence": {
      needStr(p, v, "drugCodeListId", path, { nonEmpty: true });
      checkWindow(p, v.window, `${path}.window`);
      needNum(p, v, "permissibleGapDays", path);
      needNum(p, v, "adherenceThreshold", path);
      break;
    }
    case "treatment_switching": {
      needStr(p, v, "fromCodeListId", path, { nonEmpty: true });
      /* The to-list is what the module follows. An empty one is not a
       * degenerate case to tolerate: it would emit a program that reports
       * zero switches for every patient and looks entirely well-behaved. */
      need(p, `${path}.toCodeListIds`, Array.isArray(v.toCodeListIds) && v.toCodeListIds.length > 0,
        `expected a non-empty array of code-list ids, got ${typeOf(v.toCodeListIds)}`);
      if (Array.isArray(v.toCodeListIds)) {
        v.toCodeListIds.forEach((id: unknown, i: number) =>
          need(p, `${path}.toCodeListIds[${i}]`, typeof id === "string" && id.length > 0,
            `expected a non-empty string, got ${typeOf(id)}`));
      }
      checkWindow(p, v.window, `${path}.window`);
      needNum(p, v, "permissibleOverlapDays", path);
      need(p, `${path}.lineRule`, v.lineRule === "new_line_on_switch",
        `expected "new_line_on_switch" (the only line rule emitted), got ${JSON.stringify(v.lineRule)}`);
      break;
    }
    case "standardization":
    case "calendar_trend":
    case "statistical_engine":
      break;
    case "future_stub":
      needStr(p, v, "plannedKind", path, { nonEmpty: true });
      break;
  }
}

/* ---------- entry point ---------- */

/**
 * Validate that raw JSON has the structure of a StudySpec everywhere an
 * emitter or validator will dereference it. Returns path-labeled problems;
 * empty list = safe to treat as StudySpec (semantic readiness still applies).
 */
export function checkSpecShape(raw: unknown): { ok: boolean; problems: string[] } {
  const p = new Problems();
  if (!isObj(raw)) return { ok: false, problems: [`spec: expected an object, got ${typeOf(raw)}`] };

  /* meta */
  if (!isObj(raw.meta)) p.push("meta", `expected an object, got ${typeOf(raw.meta)}`);
  else {
    const m = raw.meta;
    needSafeText(p, m, "title", "meta", { nonEmpty: true });
    needSafeText(p, m, "version", "meta", { nonEmpty: true, maxLen: 60 });
    needEnum(p, m, "database", "meta", DATABASES);
    if (m.description !== undefined) needSafeText(p, m, "description", "meta", { maxLen: 2000 });
    checkDatePair(p, m.studyPeriod, "meta.studyPeriod");
    if (m.daysPerYear !== undefined) needNum(p, m, "daysPerYear", "meta", { min: 300, max: 400 });
    if (!isObj(m.provenance)) p.push("meta.provenance", `expected an object, got ${typeOf(m.provenance)}`);
    else {
      const prov = m.provenance;
      need(p, "meta.provenance.method", prov.method === "llm_extraction" || prov.method === "llm_assisted" || prov.method === "manual", `expected "llm_extraction", "llm_assisted" or "manual", got ${JSON.stringify(prov.method)}`);
      // model / sourceDocumentName / extractedAt are printed into generated headers.
      if (prov.model !== undefined) needSafeText(p, prov, "model", "meta.provenance", { maxLen: 120 });
      if (prov.sourceDocumentName !== undefined) needSafeText(p, prov, "sourceDocumentName", "meta.provenance", { maxLen: 200 });
      if (prov.extractedAt !== undefined) needSafeText(p, prov, "extractedAt", "meta.provenance", { maxLen: 40 });
    }
  }

  /* codeLists */
  const lists = needArr(p, raw, "codeLists", "spec", MAX.codeLists);
  if (lists) {
    lists.forEach((cl, i) => {
      const lp = `codeLists[${i}]`;
      if (!isObj(cl)) { p.push(lp, `expected a CodeList object, got ${typeOf(cl)}`); return; }
      needStr(p, cl, "id", lp, { nonEmpty: true });
      if (isStr(cl.id) && !SLUG.test(cl.id)) p.push(`${lp}.id`, `must be a slug (letters/digits/_/-), got ${JSON.stringify(cl.id)} — list ids become file names and SAS names`);
      needStr(p, cl, "label", lp);
      needEnum(p, cl, "system", lp, CODE_SYSTEMS);
      const codes = needArr(p, cl, "codes", lp, MAX.codesPerList);
      if (codes) {
        codes.forEach((c, j) => {
          const cp = `${lp}.codes[${j}]`;
          if (!isObj(c)) { p.push(cp, `expected a CodeEntry object, got ${typeOf(c)}`); return; }
          const code = c.code;
          if (!isStr(code) || code.length === 0) p.push(`${cp}.code`, `expected a non-empty string, got ${typeOf(code)}`);
          else if (code.length > 80 || !SAFE_CODE.test(code) || /['"\\;]/.test(code))
            p.push(`${cp}.code`, `${JSON.stringify(code.slice(0, 40))} contains characters never valid in a clinical code (quotes, backslashes, semicolons, control chars) or exceeds 80 chars — codes are embedded in generated SQL/SAS`);
          needBool(p, c, "verified", cp);
          needEnum(p, c, "source", cp, CODE_SOURCES);
        });
      }
    });
  }

  /* indexEvent */
  if (!isObj(raw.indexEvent)) p.push("indexEvent", `expected an object, got ${typeOf(raw.indexEvent)}`);
  else {
    needEnum(p, raw.indexEvent, "type", "indexEvent", INDEX_TYPES);
    needStr(p, raw.indexEvent, "codeListId", "indexEvent", { nonEmpty: true });
    checkDatePair(p, raw.indexEvent.indexPeriod, "indexEvent.indexPeriod");
  }

  /* enrollment */
  if (!isObj(raw.enrollment)) p.push("enrollment", `expected an object, got ${typeOf(raw.enrollment)}`);
  else {
    needNum(p, raw.enrollment, "baselineDays", "enrollment", { min: 0 });
    needNum(p, raw.enrollment, "followupDays", "enrollment", { min: 0 });
    needNum(p, raw.enrollment, "gapAllowanceDays", "enrollment", { min: 0 });
    needBool(p, raw.enrollment, "requiresRxCoverage", "enrollment");
  }

  /* criteria */
  const crits = needArr(p, raw, "criteria", "spec", MAX.criteria);
  if (crits) {
    crits.forEach((c, i) => {
      const cp = `criteria[${i}]`;
      if (!isObj(c)) { p.push(cp, `expected a Criterion object, got ${typeOf(c)}`); return; }
      needStr(p, c, "id", cp, { nonEmpty: true });
      need(p, `${cp}.kind`, c.kind === "inclusion" || c.kind === "exclusion", `expected "inclusion" or "exclusion", got ${JSON.stringify(c.kind)}`);
      needStr(p, c, "sourceText", cp);
      needEnum(p, c, "confidence", cp, CONFIDENCES);
      needBool(p, c, "reviewed", cp);
      const t = c.test;
      if (!isObj(t)) { p.push(`${cp}.test`, `expected a test object, got ${typeOf(t)}`); return; }
      const tp = `${cp}.test`;
      switch (t.type) {
        case "diagnosis":
          needStr(p, t, "codeListId", tp, { nonEmpty: true });
          needNum(p, t, "minClaims", tp, { min: 1 });
          if (t.claimSeparationDays !== undefined) needNum(p, t, "claimSeparationDays", tp, { min: 0 });
          needEnum(p, t, "setting", tp, SETTINGS);
          checkWindow(p, t.window, `${tp}.window`);
          break;
        case "procedure":
          needStr(p, t, "codeListId", tp, { nonEmpty: true });
          needNum(p, t, "minClaims", tp, { min: 1 });
          needEnum(p, t, "setting", tp, SETTINGS);
          checkWindow(p, t.window, `${tp}.window`);
          break;
        case "drug":
          needStr(p, t, "codeListId", tp, { nonEmpty: true });
          needNum(p, t, "minClaims", tp, { min: 1 });
          checkWindow(p, t.window, `${tp}.window`);
          break;
        case "age_at_index":
          if (t.min !== undefined) needNum(p, t, "min", tp, { min: 0, max: 130 });
          if (t.max !== undefined) needNum(p, t, "max", tp, { min: 0, max: 130 });
          break;
        case "sex":
          need(p, `${tp}.value`, t.value === "M" || t.value === "F", `expected "M" or "F", got ${JSON.stringify(t.value)}`);
          break;
        case "continuous_enrollment":
          needNum(p, t, "baselineDays", tp, { min: 0 });
          needNum(p, t, "followupDays", tp, { min: 0 });
          needBool(p, t, "requiresRxCoverage", tp);
          break;
        case "unmapped":
          break;
        default:
          p.push(`${tp}.type`, `unknown criterion test type ${JSON.stringify(t.type)}`);
      }
    });
  }

  /* baseline */
  const base = needArr(p, raw, "baseline", "spec", MAX.baseline);
  if (base) {
    base.forEach((b, i) => {
      const bp = `baseline[${i}]`;
      if (!isObj(b)) { p.push(bp, `expected a BaselineCharacteristic object, got ${typeOf(b)}`); return; }
      needStr(p, b, "id", bp, { nonEmpty: true });
      needStr(p, b, "label", bp);
      needStr(p, b, "kind", bp, { nonEmpty: true });
      if (b.codeListId !== undefined) needStr(p, b, "codeListId", bp);
      if (b.comorbidityIndexAnalysisId !== undefined) needStr(p, b, "comorbidityIndexAnalysisId", bp, { nonEmpty: true });
      if (b.window !== undefined) checkWindow(p, b.window, `${bp}.window`);
    });
  }

  /* engine catalogs — optional at the boundary; deep checks are semantic
     (validateAnalyses). Shape only requires: arrays of objects with string ids. */
  for (const key of ["outcomes", "groupVars", "comparisons"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) { p.push(key, `expected an array, got ${typeOf(v)}`); continue; }
    v.forEach((e, i) => {
      if (!isObj(e) || !isStr(e.id)) p.push(`${key}[${i}]`, "expected an object with a string id");
    });
  }

  /* analyses */
  const analyses = needArr(p, raw, "analyses", "spec", MAX.analyses);
  if (analyses) analyses.forEach((a, i) => checkAnalysis(p, a, `analyses[${i}]`));

  return { ok: p.list.length === 0, problems: p.list };
}

/** Convenience: shape-check then return the typed spec (throws on failure).
 *  For boundaries that want an exception instead of a problem list. */
export function parseSpec(raw: unknown): StudySpec {
  const { ok, problems } = checkSpecShape(raw);
  if (!ok) throw new Error(`Spec failed structural validation:\n- ${problems.join("\n- ")}`);
  return raw as StudySpec;
}
