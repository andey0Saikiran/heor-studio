#!/usr/bin/env node
/**
 * HEOR Studio MCP server.
 *
 * Deterministic tools by default (path A): a host LLM (Claude Desktop, Claude
 * Code, …) reads the protocol, drafts a StudySpec from the exposed schema, and
 * drives these tools; the server holds NO key and makes no LLM calls. If an
 * ANTHROPIC_API_KEY is present, one extra LLM tool (extract_spec, path B) is
 * additionally registered for turnkey extraction with the analyst's own key.
 *
 * Either way, code generation is gated on an explicit human sign-off + a fully
 * reviewed, fully code-verified spec — that gate is the product's core safety
 * property. No patient data ever reaches this process.
 *
 * stdout is the JSON-RPC channel — log ONLY to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  SPEC_JSON_SCHEMA,
  listModels,
  extractSpec,
  specReadiness,
  unverifiedCodeCount,
  planBundle,
  bundleFilename,
  DEFAULT_EMIT_OPTIONS,
  MARKETSCAN_TABLES,
  DX_COLUMNS,
  PROC_COLUMNS,
  searchIcd10cm,
  searchDrugNames,
} from "@heor-studio/core";
import type { StudySpec, BundleEntry, EmitOptions, ExtractSource } from "@heor-studio/core";
import { putSpec, getSpec, putArtifact, getArtifact } from "./session.js";

const log = (msg: string) => console.error(`[heor-studio-mcp] ${msg}`);

/** Every tool returns JSON as text — small, host-agnostic, no output-schema coupling. */
function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

const server = new McpServer({ name: "heor-studio", version: "0.1.0" });

/* ============================ tools (deterministic spine) ============================ */

server.registerTool(
  "search_codes",
  {
    title: "Search medical vocabularies",
    description:
      "Look up candidate codes to help build a code list. system='icd10cm' searches ICD-10-CM " +
      "diagnosis codes (NLM Clinical Tables); system='rxnorm' searches drug names (RxNav). " +
      "Returns candidates only — the analyst still verifies each code before use.",
    inputSchema: {
      query: z.string().describe("Search term, e.g. 'psoriasis' or 'adalimumab'"),
      system: z.enum(["icd10cm", "rxnorm"]),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, system, limit }) => {
    const cap = limit ?? 25;
    if (system === "icd10cm") {
      const r = await searchIcd10cm(query);
      if ("error" in r) return fail(r.error);
      const candidates = r.results
        .slice(0, cap)
        .map((m) => ({ code: m.code, label: m.description, system: "icd10cm" }));
      return json({ candidates, truncated: r.results.length > cap });
    }
    const r = await searchDrugNames(query);
    if ("error" in r) return fail(r.error);
    const candidates = r.results
      .slice(0, cap)
      .map((m) => ({ code: m.name, label: m.synonym ? `${m.name} (${m.synonym})` : m.name, tty: m.tty, system: "rxnorm" }));
    return json({ candidates, truncated: r.results.length > cap });
  },
);

server.registerTool(
  "validate_spec",
  {
    title: "Validate & store a study spec",
    description:
      "Validate a StudySpec (conforming to the heor://schema/study-spec resource) and store it, " +
      "returning a spec_id. Reports readiness and how many codes remain unverified. Also used to " +
      "SAVE an edited spec after the analyst confirms code lists — resubmit the spec with " +
      "verified:true on confirmed codes. Verification flags you set are preserved.",
    inputSchema: {
      spec: z.record(z.unknown()).describe("The StudySpec object"),
    },
  },
  async ({ spec }) => {
    const s = spec as unknown as StudySpec;
    let readiness: { ready: boolean; problems: string[] };
    let unverified: number;
    try {
      readiness = specReadiness(s);
      unverified = unverifiedCodeCount(s);
    } catch (e) {
      return fail(
        `Spec is malformed and could not be validated: ${(e as Error).message}. ` +
          `Fetch heor://schema/study-spec and conform to it.`,
      );
    }
    const spec_id = putSpec(s);
    return json({
      spec_id,
      ready: readiness.ready,
      problems: readiness.problems,
      unverified_code_count: unverified,
      normalized_spec: s,
    });
  },
);

const TARGET = z.enum(["sas", "sql:postgres", "sql:snowflake"]);

server.registerTool(
  "generate_code",
  {
    title: "Generate SAS + SQL (gated)",
    description:
      "Deterministically generate study code from a stored spec. REFUSES unless the spec is ready, " +
      "every code is verified, AND signoff=true — this enforces human review. Returns a manifest of " +
      "file handles (path, bytes, sha256), never file contents; read files with get_artifact.",
    inputSchema: {
      spec_id: z.string(),
      targets: z.array(TARGET).optional().describe("Defaults to all: sas + both SQL dialects"),
      signoff: z
        .boolean()
        .describe("Must be true. Set only after a human reviewed the spec and verified every code."),
      tag: z.string().optional().describe("Short uppercase work-table prefix, e.g. PSO_TP"),
    },
  },
  async ({ spec_id, targets, signoff, tag }) => {
    const spec = getSpec(spec_id);
    if (!spec) return fail(`No spec with id '${spec_id}'. Call validate_spec first.`);

    const readiness = specReadiness(spec);
    const unverified = unverifiedCodeCount(spec);
    if (!signoff || !readiness.ready || unverified > 0) {
      return json({
        refusal: {
          reason: "Code generation requires a reviewed, fully-verified spec plus explicit sign-off.",
          signoff_given: signoff === true,
          ready: readiness.ready,
          problems: readiness.problems,
          unverified_code_count: unverified,
          how_to_proceed:
            "Resolve every problem, set verified:true on each code the analyst confirms, resubmit via " +
            "validate_spec, then call generate_code with signoff:true.",
        },
      });
    }

    const opts: EmitOptions = tag ? { ...DEFAULT_EMIT_OPTIONS, tag } : DEFAULT_EMIT_OPTIONS;
    let entries: BundleEntry[];
    try {
      entries = planBundle(spec, opts);
    } catch (e) {
      return fail(`Emitter rejected the spec: ${(e as Error).message}`);
    }

    const want = new Set<string>(targets ?? ["sas", "sql:postgres", "sql:snowflake"]);
    const keep = (p: string) => {
      if (p.startsWith("sas/")) return want.has("sas");
      if (p.startsWith("sql_postgres/")) return want.has("sql:postgres");
      if (p.startsWith("sql_snowflake/")) return want.has("sql:snowflake");
      return true; // README, AI_DISCLOSURE, spec.json, codelists always included
    };
    const filtered = entries.filter((e) => keep(e.path));
    const artifact_id = putArtifact(filtered, bundleFilename(spec));
    const files = filtered.map((e) => ({ path: e.path, bytes: byteLen(e.content), sha256: sha256(e.content) }));
    const program_count = filtered.filter(
      (e) => e.path.startsWith("sas/") || e.path.startsWith("sql_"),
    ).length;
    return json({ artifact_id, program_count, file_count: files.length, files });
  },
);

server.registerTool(
  "get_artifact",
  {
    title: "Read one generated file",
    description:
      "Read a single file from a generated artifact, line-paged so large programs stay within MCP " +
      "output limits. Use the paths from generate_code's manifest.",
    inputSchema: {
      artifact_id: z.string(),
      path: z.string(),
      offset: z.number().int().min(0).optional().describe("First line (0-based), default 0"),
      limit: z.number().int().min(1).max(2000).optional().describe("Max lines, default 400"),
    },
  },
  async ({ artifact_id, path, offset, limit }) => {
    const art = getArtifact(artifact_id);
    if (!art) return fail(`No artifact with id '${artifact_id}'.`);
    const entry = art.entries.find((e) => e.path === path);
    if (!entry) return fail(`No file '${path}' in artifact '${artifact_id}'.`);
    const lines = entry.content.split("\n");
    const start = offset ?? 0;
    const end = Math.min(lines.length, start + (limit ?? 400));
    return json({
      path,
      contents: lines.slice(start, end).join("\n"),
      line_start: start,
      line_end: end,
      total_lines: lines.length,
      more: end < lines.length,
    });
  },
);

server.registerTool(
  "run_verification",
  {
    title: "Verify generated code (planned)",
    description:
      "Execute the generated SQL against a bundled synthetic MarketScan-shaped dataset and assert " +
      "invariants (monotonic attrition, non-negative person-time, plausible rates). Not yet " +
      "implemented — returns a not_implemented status.",
    inputSchema: { artifact_id: z.string() },
  },
  async ({ artifact_id }) => {
    const art = getArtifact(artifact_id);
    if (!art) return fail(`No artifact with id '${artifact_id}'.`);
    return json({
      status: "not_implemented",
      note: "Execution-based verification on synthetic data lands with the verification module. " +
        "Until then, verify by review and by running the code against your own licensed MarketScan.",
    });
  },
);

server.registerTool(
  "export_bundle",
  {
    title: "Export the bundle to a zip on disk",
    description:
      "Zip a generated artifact and write it to disk (default: the OS temp dir). Returns the absolute " +
      "path. The analyst runs the SAS/SQL from disk against their own licensed MarketScan warehouse.",
    inputSchema: {
      artifact_id: z.string(),
      out_dir: z.string().optional().describe("Directory to write the zip into; defaults to the OS temp dir"),
    },
  },
  async ({ artifact_id, out_dir }) => {
    const art = getArtifact(artifact_id);
    if (!art) return fail(`No artifact with id '${artifact_id}'.`);
    const zip = new JSZip();
    for (const e of art.entries) zip.file(e.path, e.content);
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const dir = out_dir ?? tmpdir();
    await mkdir(dir, { recursive: true });
    const zip_path = join(dir, art.filename);
    await writeFile(zip_path, buf);
    return json({
      zip_path,
      bytes: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
      file_count: art.entries.length,
    });
  },
);

/* ============================ conditional LLM tool (path B) ============================ */

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey) {
  server.registerTool(
    "extract_spec",
    {
      title: "Extract a study spec from a protocol (LLM)",
      description:
        "Turnkey extraction: send a protocol/SAP as text and get back a stored StudySpec draft, using " +
        "the analyst's own Anthropic key configured on this server. All codes come back unverified — " +
        "the human-review + generate_code gate still applies. (Only available because a key is set.)",
      inputSchema: {
        source: z.string().describe("Protocol or SAP text"),
        name: z.string().optional().describe("Source document name, for provenance"),
        model: z.string().optional().describe("Model id; see heor://models. Defaults to Sonnet."),
      },
    },
    async ({ source, name, model }) => {
      const src: ExtractSource = { kind: "text", text: source, name: name ?? "pasted-protocol" };
      let spec: StudySpec;
      try {
        spec = await extractSpec({
          apiKey,
          model: model ?? "claude-sonnet-5",
          source: src,
          onStatus: (m) => log(m),
        });
      } catch (e) {
        return fail(`Extraction failed: ${(e as Error).message}`);
      }
      const spec_id = putSpec(spec);
      return json({
        spec_id,
        summary: `${spec.meta.title} — ${spec.criteria.length} criteria, ${spec.codeLists.length} code lists`,
        unverified_code_count: unverifiedCodeCount(spec),
        normalized_spec: spec,
      });
    },
  );
  log("extract_spec enabled (ANTHROPIC_API_KEY present)");
} else {
  log("extract_spec disabled (no ANTHROPIC_API_KEY) — host-driven extraction only");
}

/* ============================ resources ============================ */

server.registerResource(
  "study-spec-schema",
  "heor://schema/study-spec",
  {
    title: "StudySpec JSON Schema",
    description: "The contract a host must produce to drive generation (path A).",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(SPEC_JSON_SCHEMA, null, 2) }],
  }),
);

server.registerResource(
  "marketscan-schema",
  "heor://schema/marketscan",
  {
    title: "MarketScan schema reference",
    description: "CCAE/MDCR/MDCD tables + diagnosis/procedure columns the emitters target.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ tables: MARKETSCAN_TABLES, dxColumns: DX_COLUMNS, procColumns: PROC_COLUMNS }, null, 2),
      },
    ],
  }),
);

server.registerResource(
  "models",
  "heor://models",
  {
    title: "Available extraction models",
    description: "Model ids for extract_spec (only meaningful when a key is set).",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(listModels(), null, 2) }],
  }),
);

/* ============================ prompts (path-A workflow) ============================ */

server.registerPrompt(
  "extract_protocol_to_spec",
  {
    title: "Extract a protocol into a study spec",
    description: "Guided workflow: read the schema, draft a spec, look up codes, then STOP for human review.",
    argsSchema: { protocol: z.string().describe("The protocol or SAP text") },
  },
  ({ protocol }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "You are turning a clinical study protocol/SAP into a MarketScan retrospective study spec for HEOR Studio.\n\n" +
            "Steps:\n" +
            "1. Read the resource heor://schema/study-spec and heor://schema/marketscan.\n" +
            "2. Draft a StudySpec matching that schema. Never invent medical codes — for each condition/drug, " +
            "create the code list with an EMPTY codes array and note what must be looked up.\n" +
            "3. Call search_codes for each condition/drug to propose candidate codes (leave them verified:false).\n" +
            "4. Call validate_spec with the draft.\n" +
            "5. THEN STOP and present the spec and its open problems to the analyst for review. Do NOT call " +
            "generate_code yet — a human must verify every code list and sign off first.\n\n" +
            "PROTOCOL:\n" +
            protocol,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "verify_codelists",
  {
    title: "Verify code lists with the analyst",
    description: "Walk each code list with the analyst; mark only human-confirmed codes verified.",
    argsSchema: { spec_id: z.string() },
  },
  ({ spec_id }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Help the analyst verify the code lists in spec ${spec_id}. For each code list, show the codes, ` +
            "use search_codes to corroborate, and ask the analyst to confirm. Set verified:true ONLY on codes the " +
            "analyst explicitly confirms. Then resubmit the edited spec via validate_spec and report the new " +
            "unverified_code_count. Do not mark anything verified on the analyst's behalf.",
        },
      },
    ],
  }),
);

server.registerPrompt(
  "review_and_signoff",
  {
    title: "Review the spec and capture sign-off",
    description: "Render cohort logic + open problems for the analyst and capture explicit sign-off.",
    argsSchema: { spec_id: z.string() },
  },
  ({ spec_id }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Present spec ${spec_id} for final human review: summarize the cohort logic (index event, ` +
            "enrollment, criteria in order, outcomes), list any readiness problems and the unverified_code_count, " +
            "and explicitly ask the analyst to confirm sign-off. Only after they confirm, call generate_code with " +
            "signoff:true. If any problem remains or any code is unverified, generation will (correctly) refuse.",
        },
      },
    ],
  }),
);

/* ============================ connect ============================ */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("connected over stdio");
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
