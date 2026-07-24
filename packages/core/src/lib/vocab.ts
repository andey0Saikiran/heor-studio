/**
 * Typed clients for two free, public, CORS-enabled NLM terminology APIs.
 *
 *  - ICD-10-CM search: NLM Clinical Tables
 *    https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search
 *  - Drug names: NLM RxNav (RxNorm)
 *    https://rxnav.nlm.nih.gov/REST/drugs.json
 *
 * Both clients NEVER throw: they resolve to `{ results }` on success or
 * `{ error }` on any failure (network, HTTP status, malformed payload),
 * so callers can render errors inline without try/catch.
 */

export interface Icd10Match {
  code: string;
  description: string;
}

export interface DrugMatch {
  name: string;
  synonym?: string;
  /** RxNorm term type, e.g. "IN" (ingredient), "SBD", "SCD". */
  tty: string;
}

export type VocabResult<T> = { results: T[] } | { error: string };

const ICD10_SEARCH_URL = "https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search";
const RXNAV_DRUGS_URL = "https://rxnav.nlm.nih.gov/REST/drugs.json";

/** Shared fetch wrapper: network / HTTP / JSON failures become { error }. */
async function fetchJson(
  url: string,
  serviceLabel: string,
  signal?: AbortSignal
): Promise<{ data: unknown } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { error: "Search cancelled." };
    }
    return { error: `${serviceLabel} is unreachable — check your connection.` };
  }
  if (!res.ok) {
    return { error: `${serviceLabel} returned HTTP ${res.status}.` };
  }
  try {
    return { data: (await res.json()) as unknown };
  } catch {
    return { error: `${serviceLabel} returned a malformed response.` };
  }
}

/**
 * Search ICD-10-CM codes by term (code fragment or description words).
 * Response shape is positional: [total, codes[], extra, [[code, name], ...]].
 */
export async function searchIcd10cm(
  term: string,
  signal?: AbortSignal
): Promise<VocabResult<Icd10Match>> {
  const q = term.trim();
  if (!q) return { results: [] };

  const url = `${ICD10_SEARCH_URL}?sf=code,name&terms=${encodeURIComponent(q)}&maxList=25`;
  const r = await fetchJson(url, "ICD-10-CM lookup (NLM Clinical Tables)", signal);
  if ("error" in r) return r;

  const data = r.data;
  if (!Array.isArray(data) || data.length < 4 || !Array.isArray(data[3])) {
    return { error: "ICD-10-CM lookup returned an unexpected response shape." };
  }

  const results: Icd10Match[] = [];
  for (const row of data[3] as unknown[]) {
    if (!Array.isArray(row) || row.length < 1) continue;
    const code = String(row[0] ?? "").trim();
    if (!code) continue;
    results.push({ code, description: String(row[1] ?? "").trim() });
  }
  return { results };
}

interface RxNavConceptProperty {
  name?: unknown;
  synonym?: unknown;
  tty?: unknown;
}

interface RxNavConceptGroup {
  tty?: unknown;
  conceptProperties?: unknown;
}

/**
 * Search drug concepts by name via RxNav. Flattens
 * drugGroup.conceptGroup[].conceptProperties[] into a de-duplicated
 * (by name + term type) list of matches.
 */
export async function searchDrugNames(
  name: string,
  signal?: AbortSignal
): Promise<VocabResult<DrugMatch>> {
  const q = name.trim();
  if (!q) return { results: [] };

  const url = `${RXNAV_DRUGS_URL}?name=${encodeURIComponent(q)}`;
  const r = await fetchJson(url, "RxNav drug lookup", signal);
  if ("error" in r) return r;

  const drugGroup = (r.data as { drugGroup?: { conceptGroup?: unknown } } | null)?.drugGroup;
  const groups = drugGroup?.conceptGroup;
  // RxNav omits conceptGroup entirely when there are no matches.
  if (groups === undefined || groups === null) return { results: [] };
  if (!Array.isArray(groups)) {
    return { error: "RxNav returned an unexpected response shape." };
  }

  const seen = new Set<string>();
  const results: DrugMatch[] = [];
  for (const g of groups as RxNavConceptGroup[]) {
    const props = g?.conceptProperties;
    if (!Array.isArray(props)) continue;
    const groupTty = typeof g.tty === "string" ? g.tty : "";
    for (const p of props as RxNavConceptProperty[]) {
      const nm = typeof p?.name === "string" ? p.name.trim() : "";
      if (!nm) continue;
      const tty = typeof p?.tty === "string" && p.tty ? p.tty : groupTty;
      const key = `${nm.toLowerCase()}|${tty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const synonym =
        typeof p?.synonym === "string" && p.synonym.trim() ? p.synonym.trim() : undefined;
      results.push({ name: nm, synonym, tty });
    }
  }
  return { results };
}
