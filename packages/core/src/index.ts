/*
 * @heor-studio/core — the shared, platform-neutral engine.
 *
 * Everything HEOR Studio does that is NOT UI lives here: the study-spec type +
 * schema, the protocol->spec extractor, the deterministic SAS/SQL emitters, the
 * MarketScan schema map, and the vocabulary lookups. Both the web app and the
 * MCP server import from this barrel, so the two entry points share one engine.
 *
 * Platform note: this package must stay DOM-free (its tsconfig omits the "DOM"
 * lib) so it runs unchanged in Node (the MCP server) and the browser (the app).
 * Browser-only concerns (blob download) and Node-only concerns (fs) live in the
 * respective entry packages, not here.
 */
export * from "./spec/types";
export * from "./spec/shape";
export * from "./extract/prompt";
export * from "./extract/anthropic";
export * from "./emitters/types";
export * from "./emitters/sas";
export * from "./emitters/sql";
export * from "./data/marketscan";
export * from "./lib/vocab";
export * from "./bundle";
export * from "./feedback/types";
