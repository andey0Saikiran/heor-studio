import { defineConfig } from "tsup";

/**
 * The published MCP artifact must run standalone.
 *
 * @heor-studio/core is a source-only workspace package — its "exports" point at
 * .ts files. Left external, the built dist/index.js resolved to
 * packages/core/src/index.ts and Node refused to load it
 * (ERR_UNKNOWN_FILE_EXTENSION ".ts"), so the shipped binary could not start at
 * all. Bundling core in makes dist self-contained and removes the unpublished
 * workspace dependency from the published package.
 *
 * @electric-sql/pglite stays EXTERNAL: it ships wasm assets that a bundler
 * cannot inline, and it is a real runtime dependency of the verification tool.
 * The MCP SDK and zod stay external as normal npm dependencies.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  // core is source-only, so it must be compiled into the bundle
  noExternal: ["@heor-studio/core"],
  external: ["@electric-sql/pglite", "@modelcontextprotocol/sdk", "zod", "jszip"],
  // no banner: src/index.ts already carries the shebang and tsup preserves it
});
