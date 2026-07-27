/**
 * LLM extraction — direct-from-browser Anthropic Messages API client.
 *
 * BYOK: the user's API key goes straight from their browser to
 * api.anthropic.com (anthropic-dangerous-direct-browser-access) — nothing
 * touches any other server. No SDK; plain fetch.
 *
 * The model is forced (tool_choice) to answer via the `submit_study_spec`
 * tool whose input_schema is SPEC_JSON_SCHEMA, then the raw tool input is
 * normalized into a well-formed StudySpec:
 *  - ids slugified and de-duplicated
 *  - every extracted code: source "ai_suggested", verified false
 *  - every criterion: reviewed false
 *  - meta.provenance filled (llm_extraction, model, timestamp, source name)
 *  - missing/invalid optional fields clamped or defaulted
 *  - dangling code-list references degraded to {type:"unmapped"} + low confidence
 */

import type {
  Analysis,
  AnalysisKind,
  LegacyAnalysisType,
  LegacyAnalysisRequest,
  BaselineCharacteristic,
  CodeEntry,
  CodeList,
  Criterion,
  EnrollmentRule,
  IndexEventRule,
  OutcomeDefinition,
  AnchorDate,
  Stratifier,
  RelativeWindow,
  StudySpec,
} from "../spec/types";
import { migrateLegacyAnalyses, EMITTABLE_ANALYSIS_KINDS } from "../spec/types";
import {
  ANALYSIS_TYPES,
  BASELINE_KINDS,
  CARE_SETTINGS,
  CODE_SYSTEMS,
  CONFIDENCE_LEVELS,
  CRITERION_KINDS,
  DATABASE_IDS,
  INDEX_EVENT_TYPES,
  OUTCOME_DX_POSITIONS,
  STRATIFIER_AXES,
  FUTURE_ANALYSIS_KINDS,
  SPEC_JSON_SCHEMA,
  SYSTEM_PROMPT,
} from "./prompt";

/* ---------- public API ---------- */

export type ExtractSource =
  | { kind: "pdf"; base64: string; name: string }
  | { kind: "text"; text: string; name?: string };

export interface ExtractSpecArgs {
  apiKey: string;
  model: string;
  source: ExtractSource;
  onStatus?: (msg: string) => void;
}

export interface ModelOption {
  id: string;
  label: string;
}

/** Models offered in the extraction UI. Static — no network call needed. */
export function listModels(): ModelOption[] {
  return [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5 (recommended)" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 (highest quality)" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
  ];
}

const API_URL = "https://api.anthropic.com/v1/messages";
const TOOL_NAME = "submit_study_spec";
const MAX_TOKENS = 16000;

/**
 * Extract a StudySpec from a protocol/SAP (PDF or plain text) using the
 * user's own Anthropic API key, directly from the browser.
 */
export async function extractSpec(args: ExtractSpecArgs): Promise<StudySpec> {
  const { apiKey, model, source, onStatus } = args;
  const status = (msg: string): void => {
    if (onStatus) onStatus(msg);
  };

  const sourceName =
    source.kind === "pdf" ? source.name : source.name ?? "Pasted text";

  const userContent: unknown[] =
    source.kind === "pdf"
      ? [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: source.base64,
            },
          },
          {
            type: "text",
            text:
              `Extract the complete study specification from the attached ` +
              `protocol/SAP document ("${source.name}") and submit it via the ` +
              `${TOOL_NAME} tool.`,
          },
        ]
      : [
          {
            type: "text",
            text:
              `Extract the complete study specification from the following ` +
              `protocol/SAP text and submit it via the ${TOOL_NAME} tool.\n\n` +
              `--- BEGIN DOCUMENT (${sourceName}) ---\n` +
              `${source.text}\n` +
              `--- END DOCUMENT ---`,
          },
        ];

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Submit the structured study specification extracted from the " +
          "protocol/SAP. Must be called exactly once with the complete spec.",
        input_schema: SPEC_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
  };

  status(
    source.kind === "pdf"
      ? `Sending "${source.name}" to ${model}…`
      : `Sending protocol text to ${model}…`
  );

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Could not reach the Anthropic API from your browser. This is almost " +
        "always a network or blocking issue rather than a bad key: check " +
        "your internet connection, disable ad-blockers or privacy " +
        "extensions for this page (they often block api.anthropic.com), and " +
        "make sure a corporate firewall or VPN isn't blocking direct " +
        "browser requests to api.anthropic.com."
    );
  }

  if (!response.ok) {
    throw new Error(await describeHttpError(response));
  }

  status("Model finished — parsing extracted specification…");

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The Anthropic API returned a response that could not be parsed as " +
        "JSON. Please try again."
    );
  }

  const rawSpec = pluckToolInput(data);
  if (rawSpec === undefined) {
    const stopReason = isObject(data) ? str(data.stop_reason) : "";
    if (stopReason === "max_tokens") {
      throw new Error(
        "The model ran out of output space before finishing the " +
          "specification. Try a shorter document or a more capable model."
      );
    }
    if (stopReason === "refusal") {
      throw new Error(
        "The model declined to process this document. Check that it is a " +
          "clinical study protocol or SAP and try again."
      );
    }
    throw new Error(
      "The model did not return a structured study specification. Please " +
        "try again (a retry usually resolves this)."
    );
  }

  status("Validating and normalizing the specification…");

  const spec = normalizeSpec(rawSpec, { model, sourceDocumentName: sourceName });

  status("Extraction complete.");
  return spec;
}

/* ---------- HTTP error mapping ---------- */

async function describeHttpError(response: Response): Promise<string> {
  let apiMessage = "";
  try {
    const errBody: unknown = await response.json();
    if (isObject(errBody) && isObject(errBody.error)) {
      apiMessage = str(errBody.error.message);
    }
  } catch {
    /* body not JSON — ignore */
  }
  const detail = apiMessage ? ` (${apiMessage})` : "";

  switch (response.status) {
    case 401:
      return (
        "API key rejected. Check that your Anthropic API key is entered " +
        "correctly and is still active (keys can be revoked or expire) — " +
        "you can verify it at console.anthropic.com." + detail
      );
    case 403:
      return (
        "Your API key does not have permission for this request or model. " +
        "Check your Anthropic Console plan and model access." + detail
      );
    case 404:
      return (
        "Model not found. The selected model id may be wrong or not " +
        "available to your account — pick another model and retry." + detail
      );
    case 413:
      return (
        "The document is too large for a single request. Try a smaller PDF " +
        "or paste only the relevant protocol sections as text." + detail
      );
    case 429:
      return (
        "Rate limit reached: Anthropic is temporarily throttling requests " +
        "for this API key. Wait a minute and try again, or use a faster " +
        "model tier with more headroom." + detail
      );
    case 500:
    case 529:
      return (
        "The Anthropic API is temporarily overloaded or having issues. " +
        "This is not a problem with your document — wait a moment and " +
        "retry." + detail
      );
    default:
      return (
        `The Anthropic API returned an unexpected error ` +
        `(HTTP ${response.status}).` +
        detail +
        " Please retry; if it persists, check status.anthropic.com."
      );
  }
}

/* ---------- response parsing ---------- */

function pluckToolInput(data: unknown): unknown {
  if (!isObject(data) || !Array.isArray(data.content)) return undefined;
  for (const block of data.content) {
    if (
      isObject(block) &&
      block.type === "tool_use" &&
      block.name === TOOL_NAME &&
      isObject(block.input)
    ) {
      return block.input;
    }
  }
  return undefined;
}

/* ---------- normalization ---------- */

interface NormalizeContext {
  model: string;
  sourceDocumentName: string;
}

/** Normalize raw (untrusted) tool output into a well-formed StudySpec. */
export function normalizeSpec(raw: unknown, ctx: NormalizeContext): StudySpec {
  const root = isObject(raw) ? raw : {};

  /* --- code lists first: criteria validation needs the id set --- */
  const usedListIds = new Set<string>();
  const codeLists: CodeList[] = arr(root.codeLists)
    .filter(isObject)
    .map((cl, i) => normalizeCodeList(cl, i, usedListIds));
  const listIds = new Set(codeLists.map((c) => c.id));

  /* --- index event (create a placeholder list for a dangling ref) --- */
  const indexEvent = normalizeIndexEvent(root.indexEvent, codeLists, listIds, usedListIds);

  /* --- enrollment --- */
  const enrollment = normalizeEnrollment(root.enrollment);

  /* --- criteria --- */
  const usedCriterionIds = new Set<string>();
  const criteria: Criterion[] = arr(root.criteria)
    .filter(isObject)
    .map((c, i) => normalizeCriterion(c, i, listIds, usedCriterionIds));

  /* --- baseline --- */
  const usedBaselineIds = new Set<string>();
  const baseline: BaselineCharacteristic[] = arr(root.baseline)
    .filter(isObject)
    .map((b, i) => normalizeBaseline(b, i, listIds, usedBaselineIds));

  /* --- analyses: the extractor now emits per-KIND objects. Each is normalized
   *  into a valid Analysis with methodological defaults filled in; the four
   *  descriptive-epi kinds reach their real emitters. A dangling outcome code
   *  list is replaced with an empty placeholder the analyst fills (same policy
   *  as the index event). For backward-compatibility we still accept the legacy
   *  {type,enabled,notes} shape and migrate it. Outcome/group/comparison
   *  catalogs start empty (the analyst builds them during review). --- */
  const usedAnalysisIds = new Set<string>();
  const analyses: Analysis[] = [];
  const legacy: LegacyAnalysisRequest[] = [];
  for (const a of arr(root.analyses)) {
    if (!isObject(a)) continue;
    if (typeof a.kind === "string") {
      const an = normalizeAnalysis(a, codeLists, listIds, usedListIds, usedAnalysisIds);
      if (an) analyses.push(an);
    } else if (typeof a.type === "string") {
      // legacy shape from an older extractor / hand-authored input
      const type = pick(a.type, ANALYSIS_TYPES) as LegacyAnalysisType | undefined;
      if (type === undefined) continue;
      const notes = optStr(a.notes);
      legacy.push({ type, enabled: bool(a.enabled, true), ...(notes !== undefined ? { notes } : {}) });
    }
  }
  if (legacy.length > 0) {
    for (const a of migrateLegacyAnalyses(legacy)) {
      const id = uniqueSlug(a.id, a.kind, usedAnalysisIds);
      // migrated non-spine kinds are shells → keep visible but disabled
      const enabled = EMITTABLE_ANALYSIS_KINDS.has(a.kind);
      analyses.push({ ...a, id, enabled: a.kind === "future_stub" ? false : enabled });
    }
  }
  // Guarantee the two spine analyses always exist so the bundle always has an
  // attrition table + Table 1, even if the extractor omitted them.
  ensureSpineAnalyses(analyses, usedAnalysisIds);

  /* --- meta --- */
  const meta = normalizeMeta(root.meta, ctx);

  return {
    meta, codeLists, indexEvent, enrollment, criteria, baseline,
    outcomes: [], groupVars: [], comparisons: [], analyses,
  };
}

function normalizeMeta(v: unknown, ctx: NormalizeContext): StudySpec["meta"] {
  const m = isObject(v) ? v : {};
  const period = isObject(m.studyPeriod) ? m.studyPeriod : {};
  const description = optStr(m.description);
  return {
    title: str(m.title).trim() || `Untitled study (${ctx.sourceDocumentName})`,
    version: str(m.version).trim() || "0.1.0",
    database: pick(m.database, DATABASE_IDS) ?? "marketscan_ccae",
    studyPeriod: {
      start: isoDate(period.start, "2000-01-01"),
      end: isoDate(period.end, todayIso()),
    },
    ...(description !== undefined ? { description } : {}),
    provenance: {
      method: "llm_extraction",
      model: ctx.model,
      extractedAt: new Date().toISOString(),
      sourceDocumentName: ctx.sourceDocumentName,
    },
  };
}

function normalizeCodeList(v: Record<string, unknown>, index: number, used: Set<string>): CodeList {
  const label = str(v.label).trim();
  const id = uniqueSlug(str(v.id) || label || `code_list_${index + 1}`, `code_list_${index + 1}`, used);
  const codes: CodeEntry[] = [];
  for (const c of arr(v.codes)) {
    if (!isObject(c)) continue;
    const code = str(c.code).trim();
    if (!code) continue;
    const description = optStr(c.description);
    codes.push({
      code,
      ...(description !== undefined ? { description } : {}),
      // Extracted codes are ALWAYS ai_suggested + unverified, whatever the model said.
      source: "ai_suggested",
      verified: false,
    });
  }
  const notes = optStr(v.notes);
  return {
    id,
    label: label || id,
    system: pick(v.system, CODE_SYSTEMS) ?? "icd10cm",
    codes,
    ...(notes !== undefined ? { notes } : {}),
  };
}

function normalizeIndexEvent(
  v: unknown,
  codeLists: CodeList[],
  listIds: Set<string>,
  usedListIds: Set<string>
): IndexEventRule {
  const e = isObject(v) ? v : {};
  const type = pick(e.type, INDEX_EVENT_TYPES) ?? "first_diagnosis";
  let codeListId = str(e.codeListId).trim();

  if (!listIds.has(codeListId)) {
    // Dangling / missing reference: create an empty placeholder list so the
    // spec stays structurally valid; the analyst fills it in the workbench.
    const placeholderId = uniqueSlug(
      codeListId || "index_event_codes",
      "index_event_codes",
      usedListIds
    );
    codeLists.push({
      id: placeholderId,
      label: "Index event codes (needs lookup)",
      system:
        type === "first_drug_claim"
          ? "drug_name"
          : type === "first_procedure"
            ? "cpt_hcpcs"
            : "icd10cm",
      codes: [],
      notes:
        "Created automatically: the extraction referenced this code list " +
        "but did not define it. Look up and enter the codes that define " +
        "the index event, then verify them.",
    });
    listIds.add(placeholderId);
    codeListId = placeholderId;
  }

  const period = isObject(e.indexPeriod) ? e.indexPeriod : {};
  const description = optStr(e.description);
  return {
    type,
    codeListId,
    indexPeriod: {
      start: isoDate(period.start, "2000-01-01"),
      end: isoDate(period.end, todayIso()),
    },
    ...(description !== undefined ? { description } : {}),
  };
}

function normalizeEnrollment(v: unknown): EnrollmentRule {
  const e = isObject(v) ? v : {};
  return {
    baselineDays: clampInt(num(e.baselineDays, 0), 0),
    followupDays: clampInt(num(e.followupDays, 0), 0),
    gapAllowanceDays: clampInt(num(e.gapAllowanceDays, 0), 0),
    requiresRxCoverage: bool(e.requiresRxCoverage, false),
  };
}

function normalizeCriterion(
  v: Record<string, unknown>,
  index: number,
  listIds: Set<string>,
  used: Set<string>
): Criterion {
  const sourceText = str(v.sourceText).trim();
  const id = uniqueSlug(
    str(v.id) || sourceText.slice(0, 40) || `criterion_${index + 1}`,
    `criterion_${index + 1}`,
    used
  );
  const { test, degraded } = normalizeTest(v.test, listIds);
  const extracted = pick(v.confidence, CONFIDENCE_LEVELS) ?? "low";
  return {
    id,
    kind: pick(v.kind, CRITERION_KINDS) ?? "inclusion",
    sourceText: sourceText || "(no source text extracted)",
    test,
    // A degraded mapping (dangling ref, invalid shape) is never trustworthy.
    confidence: degraded ? "low" : extracted,
    reviewed: false,
  };
}

const UNMAPPED: Criterion["test"] = { type: "unmapped" };

function normalizeTest(
  v: unknown,
  listIds: Set<string>
): { test: Criterion["test"]; degraded: boolean } {
  if (!isObject(v)) return { test: UNMAPPED, degraded: true };
  const type = str(v.type);

  switch (type) {
    case "diagnosis": {
      const codeListId = str(v.codeListId).trim();
      if (!listIds.has(codeListId)) return { test: UNMAPPED, degraded: true };
      const sep = optNonNegInt(v.claimSeparationDays);
      return {
        test: {
          type: "diagnosis",
          codeListId,
          minClaims: clampInt(num(v.minClaims, 1), 1),
          ...(sep !== undefined ? { claimSeparationDays: sep } : {}),
          setting: pick(v.setting, CARE_SETTINGS) ?? "any",
          window: normalizeWindow(v.window, BASELINE_ANYTIME),
        },
        degraded: false,
      };
    }
    case "procedure": {
      const codeListId = str(v.codeListId).trim();
      if (!listIds.has(codeListId)) return { test: UNMAPPED, degraded: true };
      return {
        test: {
          type: "procedure",
          codeListId,
          minClaims: clampInt(num(v.minClaims, 1), 1),
          setting: pick(v.setting, CARE_SETTINGS) ?? "any",
          window: normalizeWindow(v.window, BASELINE_ANYTIME),
        },
        degraded: false,
      };
    }
    case "drug": {
      const codeListId = str(v.codeListId).trim();
      if (!listIds.has(codeListId)) return { test: UNMAPPED, degraded: true };
      return {
        test: {
          type: "drug",
          codeListId,
          minClaims: clampInt(num(v.minClaims, 1), 1),
          window: normalizeWindow(v.window, BASELINE_ANYTIME),
        },
        degraded: false,
      };
    }
    case "age_at_index": {
      const min = optNonNegInt(v.min);
      const max = optNonNegInt(v.max);
      return {
        test: {
          type: "age_at_index",
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        },
        degraded: false,
      };
    }
    case "sex": {
      const value = v.value === "M" || v.value === "F" ? v.value : undefined;
      if (value === undefined) return { test: UNMAPPED, degraded: true };
      return { test: { type: "sex", value }, degraded: false };
    }
    case "continuous_enrollment":
      return {
        test: {
          type: "continuous_enrollment",
          baselineDays: clampInt(num(v.baselineDays, 0), 0),
          followupDays: clampInt(num(v.followupDays, 0), 0),
          requiresRxCoverage: bool(v.requiresRxCoverage, false),
        },
        degraded: false,
      };
    case "unmapped":
      return { test: UNMAPPED, degraded: false };
    default:
      return { test: UNMAPPED, degraded: true };
  }
}

function normalizeBaseline(
  v: Record<string, unknown>,
  index: number,
  listIds: Set<string>,
  used: Set<string>
): BaselineCharacteristic {
  const label = str(v.label).trim();
  const id = uniqueSlug(str(v.id) || label || `baseline_${index + 1}`, `baseline_${index + 1}`, used);
  const rawCodeListId = str(v.codeListId).trim();
  // Drop dangling references — a baseline characteristic without a code list
  // is still reportable for demographic kinds and reviewable for the rest.
  const codeListId = listIds.has(rawCodeListId) ? rawCodeListId : undefined;
  const kind =
    pick(v.kind, BASELINE_KINDS) ?? (codeListId !== undefined ? "comorbidity" : "utilization");
  const window = isObject(v.window)
    ? normalizeWindow(v.window, BASELINE_ANYTIME)
    : undefined;
  return {
    id,
    label: label || id,
    kind,
    ...(codeListId !== undefined ? { codeListId } : {}),
    ...(window !== undefined ? { window } : {}),
  };
}

/* ---------- analysis-layer normalizers ---------- */

/** Prevalent-case washout default: any outcome ever on/before index removes
 *  the subject (the safe new-user default; analyst narrows it in review). */
const WASHOUT_DEFAULT: RelativeWindow = { start: "anytime_before", end: 0, includesIndex: true };

/** Normalize one per-kind analysis object into a valid Analysis, filling
 *  methodological defaults. Returns undefined if the kind is unrecognized. */
function normalizeAnalysis(
  v: Record<string, unknown>,
  codeLists: CodeList[],
  listIds: Set<string>,
  usedListIds: Set<string>,
  usedIds: Set<string>
): Analysis | undefined {
  const kind = pick(v.kind, ALL_ANALYSIS_KINDS);
  if (kind === undefined) return undefined;
  const label = str(v.label).trim();
  const id = uniqueSlug(str(v.id) || label || kind, kind, usedIds);
  const notes = optStr(v.notes);
  const common = { id, label: label || id, enabled: bool(v.enabled, true), ...(notes !== undefined ? { notes } : {}) };

  switch (kind) {
    case "attrition":
      return { ...common, kind: "attrition" };
    case "table1": {
      const ids = arr(v.includeBaselineIds).map((x) => str(x).trim()).filter(Boolean);
      return { ...common, kind: "table1", ...(ids.length > 0 ? { includeBaselineIds: ids } : {}) };
    }
    case "future_stub": {
      const plannedKind = pick(v.plannedKind, FUTURE_ANALYSIS_KINDS) ?? "cost";
      // Non-emittable: force disabled so it stays visible without blocking readiness.
      return { ...common, enabled: false, kind: "future_stub", plannedKind };
    }
    case "incidence_rate": {
      const outcomeDefinition = normalizeOutcomeDefinition(v.outcomeDefinition, codeLists, listIds, usedListIds, id);
      return {
        ...common, kind: "incidence_rate", outcomeDefinition, caseStatus: "incident",
        washout: isObject(v.washout) ? normalizeWindow(v.washout, WASHOUT_DEFAULT) : { ...WASHOUT_DEFAULT },
        denominatorRule: "person_time",
        personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end"] },
        recurrence: v.recurrence === "all_events" ? "all_events" : "first_only",
        rateMultiplier: positiveNum(v.rateMultiplier, 1000),
        ciMethod: "poisson_byar",
        stratifyBy: normalizeStratifiers(v.stratifyBy),
      };
    }
    case "point_prevalence": {
      const outcomeDefinition = normalizeOutcomeDefinition(v.outcomeDefinition, codeLists, listIds, usedListIds, id);
      return {
        ...common, kind: "point_prevalence", outcomeDefinition, caseStatus: "prevalent",
        anchorDate: normalizeAnchorDate(v.anchorDate),
        denominatorRule: "enrolled_midperiod",
        ciMethod: "wilson",
        stratifyBy: normalizeStratifiers(v.stratifyBy),
      };
    }
    case "period_prevalence": {
      const outcomeDefinition = normalizeOutcomeDefinition(v.outcomeDefinition, codeLists, listIds, usedListIds, id);
      const period = isObject(v.prevalencePeriod) ? v.prevalencePeriod : {};
      return {
        ...common, kind: "period_prevalence", outcomeDefinition, caseStatus: "prevalent",
        prevalencePeriod: { start: isoDate(period.start, "2000-01-01"), end: isoDate(period.end, todayIso()) },
        denominatorRule: "enrolled_anytime",
        ciMethod: "wilson",
        stratifyBy: normalizeStratifiers(v.stratifyBy),
      };
    }
    case "cumulative_incidence": {
      const outcomeDefinition = normalizeOutcomeDefinition(v.outcomeDefinition, codeLists, listIds, usedListIds, id);
      const horizonDays = clampInt(Math.round(num(v.horizonDays, 365)), 1);
      return {
        ...common, kind: "cumulative_incidence", outcomeDefinition, caseStatus: "incident",
        washout: isObject(v.washout) ? normalizeWindow(v.washout, WASHOUT_DEFAULT) : { ...WASHOUT_DEFAULT },
        incidentWithRespectTo: "cohort_entry",
        denominatorRule: "at_risk_start",
        horizonDays,
        personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end", "max_followup"], maxFollowupDays: horizonDays },
        competingRiskDeath: "ignore",
        recurrence: "first_only",
        ciMethod: "wilson",
        stratifyBy: normalizeStratifiers(v.stratifyBy),
      };
    }
    // standardization / calendar_trend / statistical_engine: valid spec kinds
    // but no emitter yet, so the extractor never produces them; if one appears,
    // fall through to undefined (dropped) rather than emit a broken shell.
    default:
      return undefined;
  }
}

/** All analysis kinds the extractor/normalizer accepts. */
const ALL_ANALYSIS_KINDS = [
  "attrition", "table1", "incidence_rate", "point_prevalence",
  "period_prevalence", "cumulative_incidence", "future_stub",
] as const;

function normalizeOutcomeDefinition(
  v: unknown,
  codeLists: CodeList[],
  listIds: Set<string>,
  usedListIds: Set<string>,
  analysisId: string
): OutcomeDefinition {
  const o = isObject(v) ? v : {};
  let codeListId = str(o.codeListId).trim();
  if (!codeListId || !listIds.has(codeListId)) {
    // Create an empty placeholder outcome list (same policy as the index event):
    // keeps the reference valid; the analyst looks up + verifies the codes.
    const placeholderId = uniqueSlug(codeListId || `${analysisId}_outcome`, `${analysisId}_outcome`, usedListIds);
    codeLists.push({
      id: placeholderId,
      label: "Outcome codes (needs lookup)",
      system: "icd10cm",
      codes: [],
      notes:
        "Created automatically: an analysis referenced this outcome code list " +
        "but it was not defined. Look up and enter the codes that define the " +
        "outcome, then verify them.",
    });
    listIds.add(placeholderId);
    codeListId = placeholderId;
  }
  const minClaims = clampInt(Math.round(num(o.minClaims, 1)), 1);
  const claimSeparationDays = optNonNegInt(o.claimSeparationDays);
  return {
    codeListId,
    minClaims,
    ...(minClaims >= 2 && claimSeparationDays !== undefined ? { claimSeparationDays } : {}),
    setting: pick(o.setting, CARE_SETTINGS) ?? "any",
    diagnosisPosition: pick(o.diagnosisPosition, OUTCOME_DX_POSITIONS) ?? "any",
  };
}

function normalizeAnchorDate(v: unknown): AnchorDate {
  const a = isObject(v) ? v : {};
  if (a.kind === "fixed") return { kind: "fixed", date: isoDate(a.date, todayIso()) };
  if (a.kind === "index") return { kind: "index" };
  // default to a fixed date only when one is provided; else the subject index
  return typeof a.date === "string" && ISO_DATE_RE.test(a.date) ? { kind: "fixed", date: a.date } : { kind: "index" };
}

function normalizeStratifiers(v: unknown): Stratifier[] {
  const used = new Set<string>();
  const out: Stratifier[] = [];
  for (const [i, s] of arr(v).entries()) {
    if (!isObject(s)) continue;
    const src = isObject(s.source) ? s.source : {};
    const label = str(s.label).trim();
    const id = uniqueSlug(str(s.id) || label || `stratum_${i + 1}`, `stratum_${i + 1}`, used);
    let source: Stratifier["source"];
    if (src.kind === "baseline" && str(src.baselineId).trim()) {
      source = { kind: "baseline", baselineId: str(src.baselineId).trim() };
    } else {
      const axis = pick(src.axis, STRATIFIER_AXES) ?? "sex";
      source = { kind: "demographic", axis };
    }
    const bounds = arr(s.ageBandLowerBounds).map((n) => Math.round(num(n, NaN))).filter((n) => Number.isFinite(n));
    out.push({
      id,
      label: label || id,
      source,
      ...(source.kind === "demographic" && source.axis === "age_band" && bounds.length > 0 ? { ageBandLowerBounds: bounds } : {}),
    });
  }
  return out;
}

/** Guarantee attrition + table1 analyses exist (the bundle always ships them). */
function ensureSpineAnalyses(analyses: Analysis[], usedIds: Set<string>): void {
  const has = (k: AnalysisKind) => analyses.some((a) => a.kind === k);
  if (!has("attrition")) {
    analyses.unshift({ id: uniqueSlug("attrition", "attrition", usedIds), label: "Attrition (CONSORT)", enabled: true, kind: "attrition" });
  }
  if (!has("table1")) {
    analyses.push({ id: uniqueSlug("table1", "table1", usedIds), label: "Baseline characteristics (Table 1)", enabled: true, kind: "table1" });
  }
}

function positiveNum(v: unknown, fallback: number): number {
  const n = num(v, fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Default window: any time on or before index (baseline includes index). */
const BASELINE_ANYTIME: RelativeWindow = {
  start: "anytime_before",
  end: 0,
  includesIndex: true,
};

function normalizeWindow(v: unknown, fallback: RelativeWindow): RelativeWindow {
  if (!isObject(v)) return { ...fallback };
  const start: RelativeWindow["start"] =
    v.start === "anytime_before"
      ? "anytime_before"
      : Math.round(num(v.start, typeof fallback.start === "number" ? fallback.start : 0));
  const end: RelativeWindow["end"] =
    v.end === "anytime_after"
      ? "anytime_after"
      : Math.round(num(v.end, typeof fallback.end === "number" ? fallback.end : 0));
  const spansIndex =
    (start === "anytime_before" || start <= 0) && (end === "anytime_after" || end >= 0);
  return {
    start,
    end,
    // If the window cannot contain day 0, includesIndex must be false
    // regardless of what the model claimed.
    includesIndex: spansIndex ? bool(v.includesIndex, true) : false,
  };
}

/* ---------- small utilities ---------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

function clampInt(n: number, min: number): number {
  return Math.max(min, Math.round(n));
}

function optNonNegInt(v: unknown): number | undefined {
  const n = num(v, Number.NaN);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
}

function uniqueSlug(candidate: string, fallback: string, used: Set<string>): string {
  const base = slugify(candidate) || slugify(fallback) || "item";
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(v: unknown, fallback: string): string {
  if (typeof v === "string") {
    const s = v.trim();
    if (ISO_DATE_RE.test(s)) return s;
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return fallback;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
