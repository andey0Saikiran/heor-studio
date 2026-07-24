# @heor-studio/mcp

MCP server for HEOR Studio — turns a **human-reviewed study spec** into deterministic SAS + SQL for
Merative MarketScan. Any MCP-capable LLM host (Claude Code, Claude Desktop, …) drives it.

## Two modes, one server

- **Path A — keyless (default).** The server exposes only deterministic tools. Your host's own LLM
  reads the protocol, drafts the spec from the exposed schema, and drives the tools. The server holds
  **no API key** and makes no LLM calls — the only network it touches is NLM/RxNav code lookups.
- **Path B — turnkey (optional).** If `ANTHROPIC_API_KEY` is set, one extra tool, `extract_spec`,
  appears: it extracts a spec from protocol text server-side using **your** key.

Both paths converge on the same spec and the same **non-skippable gate**: `generate_code` refuses
unless the spec is ready, every code is verified, and `signoff:true` is passed. No patient data ever
reaches this process.

## Tools

`search_codes` · `validate_spec` · `generate_code` (gated) · `get_artifact` · `run_verification`
(planned) · `export_bundle` — plus `extract_spec` when a key is set.

**Resources:** `heor://schema/study-spec`, `heor://schema/marketscan`, `heor://models`.
**Prompts:** `extract_protocol_to_spec`, `verify_codelists`, `review_and_signoff`.

## Try it (from this repo, before npm publish)

Claude Code, keyless (path A):

```bash
claude mcp add heor-studio -- npx -y tsx packages/mcp/src/index.ts
```

Claude Code, turnkey (path B) — pass your own key:

```bash
claude mcp add heor-studio -e ANTHROPIC_API_KEY=sk-ant-... -- npx -y tsx packages/mcp/src/index.ts
```

Claude Desktop — add to `claude_desktop_config.json` (a built/published `npx -y @heor-studio/mcp` will
replace the tsx entry point once packaged):

```json
{
  "mcpServers": {
    "heor-studio": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/heor-studio/packages/mcp/src/index.ts"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

Smoke test (spawns the server over real stdio and exercises the full flow):

```bash
npm run mcp:smoke
```

## License

Apache-2.0 (the server shim). The engine it wraps, `@heor-studio/core`, is AGPL-3.0-only.
MarketScan® is a registered trademark of Merative US L.P.; HEOR Studio is independent and unaffiliated.
