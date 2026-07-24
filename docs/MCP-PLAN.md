# HEOR Studio — MCP Server Build Plan

Status: design finalized 2026-07-24. Ready to implement.
Grounded in a pinned-facts research pass (SDK versions, host capabilities) with adversarial verification.

---

## 1. Architecture decision — hybrid A + B in one server

The server exposes a **deterministic, keyless spine as the default path (A)**, and **conditionally
registers one LLM-backed tool (B)** only when an API key is present. **MCP sampling (C) is rejected**
as a dependency.

**Why (current 2026 host facts, verified):**
- **Claude Desktop and Claude Code do NOT support MCP sampling** (`sampling/createMessage`). Claude
  Code issue #1785 is still an open, unimplemented feature request; Claude Desktop's capability page
  lists only Tools/Resources/Prompts. A server that depends on sampling for extraction **fails to
  function** in the two hosts our users actually run. → C is out as a primary mechanism.
- **Elicitation** (`elicitation/create`) is supported in **Claude Code ≥ 2.1.76** (2026-03-14) but
  **broken in Claude Desktop / Cowork** (returns immediate `cancelled`, issue #56243). → treat as a
  progressive enhancement, never a requirement.
- **Host-driven multi-step extraction works but degrades with tool-catalog size** (tool-selection
  accuracy drops 7–85% as the catalog grows). → keep the tool count tiny; lean on strict server-side
  validation to catch host mistakes.
- A single **forced `tool_choice`** extraction (what our existing `extractSpec` already does) is
  materially more reliable than host-driven reasoning for the schema-constrained step.

**How A and B coexist in one server:**
- The deterministic spine (`search_codes`, `validate_spec`, `generate_code`, `get_artifact`,
  `run_verification`, `export_bundle`) is **always registered** — no server-side LLM, no key needed.
- `extract_spec` is **registered conditionally at startup**:
  `if (process.env.ANTHROPIC_API_KEY) server.registerTool('extract_spec', …)`.
  No key → the tool isn't advertised; the host builds the spec itself via the
  `extract_protocol_to_spec` prompt + `search_codes` (path A).
- **Both paths converge on the identical `StudySpec`**, so everything downstream
  (`validate_spec → generate_code → run_verification → export_bundle`) is byte-identical, and the
  **human-review checkpoint fires in both**.
- C is wired as a **zero-cost future fallback**: if a host ever advertises `sampling`, offer it; costs
  nothing today.

**Payoff for this project:** path A works in *every* MCP host (needs only the universal
tools/resources/prompts baseline) and gives pharma IT a keyless binary that makes **zero outbound
calls except NLM/RxNav code lookups**. Path B is a reliable turnkey option using the analyst's *own*
funded key. Shipping both costs nothing and never depends on the one primitive (sampling) the hosts lack.

---

## 2. Tool contract (7 tools max — deliberately small)

| Tool | Det / LLM | Input | Output (small) | Wraps |
|---|---|---|---|---|
| `search_codes` | Deterministic | `query`, `system:'icd10cm'\|'rxnorm'`, `limit?=25` | `{candidates:[{code,label,system}], truncated}` | `searchIcd10cm`/`searchDrugNames` |
| `validate_spec` | Deterministic | `spec:object` **or** `spec_id` | `{spec_id, ready, problems:[{path,issue}], unverified_code_count, normalized_spec}` | `normalizeSpec`+`specReadiness`+`unverifiedCodeCount`; also persists → returns `spec_id` |
| `extract_spec` ⚑ | **LLM** (cloud, env key) | `source:string\|{path}`, `model?` | `{spec_id, summary, unverified_code_count, normalized_spec}` | `extractSpec({apiKey:env,…})` — **only registered if `ANTHROPIC_API_KEY` set** |
| `generate_code` | Deterministic (**gated**) | `spec_id`, `targets:('sas'\|'sql:postgres'\|'sql:snowflake')[]`, `signoff:boolean` | `{artifact_id, files:[{path,bytes,sha256}], program_count, refusal?}` | `emitSas`/`emitSql` |
| `get_artifact` | Deterministic | `artifact_id`, `path`, `offset?`, `limit?` | `{path, contents, line_start, line_end, more}` | reads server workdir (line-paged) |
| `run_verification` ⧗ | Deterministic (*planned*) | `artifact_id`, `checks?` | `{passed, checks:[{name,status,detail}], synthetic_dataset}` | planned synthetic-data executor; stub returns `not_implemented` |
| `export_bundle` | Deterministic | `artifact_id`, `format?='zip'` | `{zip_path, bytes, sha256, file_count}` | `exportZip`/`bundle` — returns a **path**, not bytes |

⚑ conditional on key  ⧗ planned surface, stubbed now

**The safety gate (product's core property):** `generate_code` **refuses** unless
`specReadiness.ready === true` **AND** `unverified_code_count === 0` **AND** `signoff === true`;
otherwise it returns a structured `refusal` listing what's missing. It is **not skippable and not
LLM-self-approvable**. On elicitation-capable hosts, raise `elicitation/create` for the final confirm.

**Output-size discipline (MCP hard-caps tool output at ~25,000 tokens):** codegen returns a
**manifest of handles** (`path/bytes/sha256`), never file contents; `get_artifact` streams one file
line-paged; `export_bundle` returns a path; `run_verification` returns pass/fail + short detail, never
rows. The `StudySpec` is KB-scale so it's safe to echo inline. Log progress to **stderr only** (stdout
is the JSON-RPC channel).

## 2a. Resources & prompts

**Resources:** `heor://schema/study-spec` (the contract for path A), `heor://schema/marketscan`,
`heor://docs/brd`, `heor://models`, `heor://spec/{spec_id}` (for the human reviewer),
`heor://artifact/{artifact_id}/manifest`.

**Prompts:** `extract_protocol_to_spec` (draft spec → `search_codes` per concept → `validate_spec` →
**STOP for human review**, do not generate), `verify_codelists` (walk each codelist, set
`verified:true` only on human-confirmed codes), `review_and_signoff` (render cohort logic + problems +
unverified count, capture explicit sign-off before `generate_code(signoff:true)`).

## 2b. End-to-end sequence

**Path A (default, keyless):** invoke `extract_protocol_to_spec` → host reads schema resources →
drafts spec → `search_codes` per concept → `validate_spec` → **★ HUMAN REVIEW (verify every codelist,
sign off) ★** → `validate_spec` (ready, 0 unverified) → `generate_code(signoff:true)` →
`get_artifact` (paged) → `run_verification` → `export_bundle` → **analyst runs on their own MarketScan
warehouse; server never sees patient data.**

**Path B (turnkey):** replaces the draft steps with one `extract_spec(source, model)` call
(server-side forced `tool_choice`, env key). **Steps from human review onward are identical.**

---

## 3. Repo layout — npm-workspaces monorepo

```
heor-studio/                     (repo root, private)
  package.json                   workspaces:["packages/*"], scripts
  tsconfig.json                  project references: [core, web, mcp]
  packages/
    core/     @heor-studio/core  — AGPL-3.0-only, "type":"module", NO "DOM" lib
      src/  spec/ extract/ emitters/ data/ lib/vocab.ts  bundle.ts(NEW)  index.ts(NEW barrel)
    web/      the existing Vite React app — imports @heor-studio/core
    mcp/      @heor-studio/mcp   — Apache-2.0, the stdio server + tool/resource/prompt registration
```

**File moves (from current `src/` into `packages/core/src/`):** `spec/types.ts`, `extract/anthropic.ts`,
`extract/prompt.ts`, `emitters/{sas,sql,types}.ts`, `data/marketscan.ts`, `lib/vocab.ts`,
`lib/exportZip.ts`. Add `core/src/index.ts` (barrel) and `core/src/bundle.ts` (pure `planBundle`).
`App.tsx` + `components/` + `main.tsx` + CSS stay in `packages/web/`.

**Node vs browser:** `extract/anthropic.ts` uses global `fetch` (stable in Node ≥18/21) and sets
`anthropic-dangerous-direct-browser-access`, which is a harmless no-op in Node — it runs unchanged
server-side. Core's tsconfig omits the `DOM` lib so a browser-only API sneaking in fails the build.

## 4. SDK / packaging specifics (pinned)

- `@modelcontextprotocol/sdk@1.29.0` (ESM, node ≥18), **Zod v3** raw-shape `inputSchema`/`outputSchema`.
  API: `new McpServer({name,version})` → `server.registerTool(name,{title,description,inputSchema,
  outputSchema}, handler)` → `new StdioServerTransport()` → `await server.connect(transport)`.
  (V2 is beta — build on V1; keep tool defs in one module for a mechanical later port.)
- **npx distribution:** `"bin":{"heor-studio-mcp":"dist/index.js"}`, entry starts with
  `#!/usr/bin/env node`, `"type":"module"`, bundle with tsup/esbuild to one ESM file, `npm publish`.
- **Claude Desktop one-click:** MCPB bundle (`.mcpb`, CLI `@anthropic-ai/mcpb`; `mcpb init`/`mcpb pack`),
  manifest_version "0.3", the key declared as `user_config {"sensitive":true}` injected to
  `ANTHROPIC_API_KEY`. Key presence is the single switch that toggles path B's `extract_spec`.
- **Client registration:** `claude_desktop_config.json` (command/args/env) or Claude Code
  `claude mcp add … -e ANTHROPIC_API_KEY=… -- npx -y @heor-studio/mcp` / project `.mcp.json`.

## 5. Build checklist (each step independently testable)

1. Convert repo to npm workspaces; create `packages/core`, move files, add barrel `index.ts`; fix
   import paths; `tsc -b` green. The web app imports from `@heor-studio/core` and still builds.
2. Extract `planBundle` into `core/src/bundle.ts` (pure: spec → all files). Web app uses it too.
3. Scaffold `packages/mcp`: SDK dep, stdio server skeleton, `#!/usr/bin/env node`, stderr logging.
4. Implement the deterministic spine tools: `validate_spec`, `generate_code` (with the safety gate),
   `get_artifact`, `export_bundle`, `search_codes`. Session store for `spec_id`/`artifact_id`.
5. Register resources + prompts (`extract_protocol_to_spec`, `verify_codelists`, `review_and_signoff`).
6. Conditionally register `extract_spec` when `ANTHROPIC_API_KEY` is set.
7. Stub `run_verification` (returns `not_implemented`) — real synthetic-data executor is a later module.
8. Package: tsup bundle + bin; smoke-test with `npx`; then MCPB bundle for Claude Desktop.
9. Smoke test end-to-end in a real host (Claude Code): path A (keyless) and path B (key set).

## 6. Risks / open questions

- **`run_verification` depends on the synthetic MarketScan-shaped dataset + executor, which is not
  built yet.** Ship the tool stubbed; the invariant checks (monotonic attrition, non-negative
  person-time) land with that module.
- **Cursor's resource auto-read is historically weak.** If field testing shows a host won't pull
  `heor://schema/study-spec`, mirror it behind a trivial `get_spec_schema` tool (costs one tool slot).
- **Host variance in path A quality.** Weaker hosts produce weaker first-draft specs; the human-review
  gate contains the risk, and path B (turnkey forced-tool) is the fallback for those cases.
- **Package scope/name** depends on the final product name (`@heor-studio/*` assumed).
