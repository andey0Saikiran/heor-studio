/**
 * Generator provenance — what makes "identical spec in, identical code out"
 * an auditable claim rather than a slogan.
 *
 * The bundle README asserts determinism, but determinism is only meaningful
 * RELATIVE TO A GENERATOR VERSION: the same spec run through a later emitter
 * can legitimately produce different code, and without a version stamp there is
 * no way to tell that apart from a bug. A reviewer re-running a study a year
 * later needs to know which emitter produced the numbers in the paper.
 *
 * The spec hash closes the other half: it pins WHICH spec produced the bundle,
 * so an edited spec cannot be passed off as the one that was signed off.
 */

/** Bumped when emitted code changes in a way that could change RESULTS.
 *  Cosmetic changes (comments, whitespace) do not require a bump; anything that
 *  alters a predicate, constant, or table shape does. */
export const EMITTER_VERSION = "0.4.0";

/** Which analysis modules this emitter version can generate, for the record. */
export const EMITTER_CAPABILITIES = [
  "cohort spine (events, index, enrollment, attrition, Table 1)",
  "incidence rate (person-time, Byar CI)",
  "point prevalence (Wilson CI)",
  "period prevalence (Wilson CI)",
  "cumulative incidence / risk (Wilson CI)",
  "small-cell suppression (derivation-aware)",
] as const;

/**
 * Stable content hash of a value (FNV-1a, 64-bit, hex).
 *
 * Deliberately dependency-free and synchronous: this runs in the browser, in
 * Node, and inside the MCP server, and a hash that needs WebCrypto would have
 * to be async and would differ per environment. This is an INTEGRITY stamp for
 * telling two specs apart in an audit trail — not a security primitive, and it
 * is labeled as such wherever it is printed.
 */
export function stableHash(value: unknown): string {
  const json = canonicalJson(value);
  // FNV-1a 64-bit via BigInt (exact; avoids float precision loss)
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < json.length; i++) {
    h ^= BigInt(json.charCodeAt(i) & 0xff);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

/** JSON with object keys sorted at every depth, so logically identical specs
 *  hash identically regardless of key order or how they were serialized. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export interface GeneratorProvenance {
  emitterVersion: string;
  specHash: string;
  generatedAt: string;
}

export function generatorProvenance(spec: unknown, generatedAt: string): GeneratorProvenance {
  return { emitterVersion: EMITTER_VERSION, specHash: stableHash(spec), generatedAt };
}
