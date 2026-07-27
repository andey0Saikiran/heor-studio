/**
 * Smoke test: drive the HEOR Studio MCP server exactly as a host would, over a
 * real stdio transport. Verifies tool listing (with/without key), the human-
 * review gate, code generation, artifact paging, and zip export.
 *
 * Run: npm run smoke -w @heor-studio/mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PSO_DEMO_SPEC } from "../../web/src/fixtures/pso.js";
import type { StudySpec } from "@heor-studio/core";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "src", "index.ts");
const tsxBin = join(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function parse(res: any): any {
  return JSON.parse(res.content[0].text);
}

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [serverEntry],
    env: { ...(process.env as Record<string, string>), ...env },
  });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  return client;
}

async function main() {
  // ---- 1. keyless (path A): 7 tools, no extract_spec ----
  console.log("\n# Keyless server (path A)");
  const a = await connect({ ANTHROPIC_API_KEY: "" });
  const toolsA = (await a.listTools()).tools.map((t) => t.name).sort();
  check("7 tools registered", toolsA.length === 7, toolsA.join(", "));
  check("extract_spec NOT present without key", !toolsA.includes("extract_spec"));
  check("core tools present", ["search_codes", "validate_spec", "generate_code", "get_artifact", "export_bundle", "run_verification", "report_correction"].every((t) => toolsA.includes(t)));

  const resources = (await a.listResources()).resources.map((r) => r.uri).sort();
  check("3 resources", resources.length === 3, resources.join(", "));
  const prompts = (await a.listPrompts()).prompts.map((p) => p.name).sort();
  check("3 prompts", prompts.length === 3, prompts.join(", "));

  // ---- 2. the gate: generate refuses on an unreviewed spec ----
  const stored = parse(await a.callTool({ name: "validate_spec", arguments: { spec: PSO_DEMO_SPEC as unknown as Record<string, unknown> } }));
  check("validate_spec returns spec_id", typeof stored.spec_id === "string", stored.spec_id);
  const refused = parse(await a.callTool({ name: "generate_code", arguments: { spec_id: stored.spec_id, signoff: false } }));
  check("generate_code REFUSES without signoff", !!refused.refusal, refused.refusal?.reason ?? "no refusal!");

  // ---- 3. sign off: mark reviewed + verified, then generate ----
  const signed: StudySpec = JSON.parse(JSON.stringify(PSO_DEMO_SPEC));
  for (const c of signed.criteria) c.reviewed = true;
  for (const cl of signed.codeLists) for (const code of cl.codes) code.verified = true;
  const s2 = parse(await a.callTool({ name: "validate_spec", arguments: { spec: signed as unknown as Record<string, unknown> } }));
  check("signed spec is ready", s2.ready === true, s2.problems?.join("; "));
  check("signed spec has 0 unverified", s2.unverified_code_count === 0, String(s2.unverified_code_count));

  const gen = parse(await a.callTool({ name: "generate_code", arguments: { spec_id: s2.spec_id, signoff: true } }));
  check("generate_code produced files", Array.isArray(gen.files) && gen.files.length > 0, `${gen.files?.length} files, ${gen.program_count} programs`);
  check("manifest has handles not contents", gen.files?.every((f: any) => typeof f.sha256 === "string" && typeof f.bytes === "number" && !("content" in f)));

  // ---- 4. read one file, paged ----
  const firstSas = gen.files.find((f: any) => f.path.startsWith("sas/"))?.path;
  const art = parse(await a.callTool({ name: "get_artifact", arguments: { artifact_id: gen.artifact_id, path: firstSas, limit: 20 } }));
  check("get_artifact returns paged file", typeof art.contents === "string" && art.contents.length > 0, `${firstSas}: lines 0-${art.line_end}/${art.total_lines}`);
  check("get_artifact signals more", art.more === true || art.total_lines <= 20);

  // ---- 5. export bundle to disk ----
  const exp = parse(await a.callTool({ name: "export_bundle", arguments: { artifact_id: gen.artifact_id } }));
  check("export_bundle wrote a zip", typeof exp.zip_path === "string" && exp.bytes > 0, `${exp.zip_path} (${exp.bytes} bytes)`);

  // ---- 5a. run_verification: engine proof + code smoke on the generated SQL ----
  const ver = parse(await a.callTool({ name: "run_verification", arguments: { spec_id: s2.spec_id } }));
  check("run_verification engine proof passes", ver.engine_proof?.status === "passed", JSON.stringify(ver.engine_proof?.status));
  // The demo spec's codes match ZERO fixture patients, so the honest verdict
  // is "inconclusive" (executed cleanly, nothing numerically exercised) — a
  // "passed" here would be the vacuous-verification bug the zero-cohort gate
  // exists to prevent. This assertion pins that gate.
  check("run_verification code smoke is inconclusive on a zero-cohort spec", ver.code_smoke?.status === "inconclusive", JSON.stringify(ver.code_smoke?.status));
  check("run_verification zero-cohort note is surfaced", typeof ver.code_smoke?.note === "string" && ver.code_smoke.note.includes("0 patients"), JSON.stringify(ver.code_smoke?.note).slice(0, 80));
  check("run_verification overall reflects the inconclusive smoke", ver.overall === "inconclusive", JSON.stringify(ver.overall));

  // ---- 5b. learning protocol: report_correction records with a reason ----
  const corr = parse(await a.callTool({ name: "report_correction", arguments: {
    target_kind: "statistic", target_ref: "smoke-test-rate", claim: "rate looks off", reason: "smoke-test reason",
  } }));
  check("report_correction records with a reason", corr.status === "recorded" && typeof corr.id === "string" && typeof corr.shareable_markdown === "string", corr.id ?? corr);

  await a.close();

  // ---- 6. with a key present: 8 tools incl. extract_spec (not called) ----
  console.log("\n# Keyed server (path B available)");
  const b = await connect({ ANTHROPIC_API_KEY: "sk-ant-dummy-not-called" });
  const toolsB = (await b.listTools()).tools.map((t) => t.name);
  check("8 tools registered with key", toolsB.length === 8, `${toolsB.length}`);
  check("extract_spec present with key", toolsB.includes("extract_spec"));
  await b.close();

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
