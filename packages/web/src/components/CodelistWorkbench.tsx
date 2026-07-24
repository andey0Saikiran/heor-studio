/**
 * Codelist workbench — review, verify, and build the code lists a study
 * spec depends on. AI never invents codes here: entries arrive from the
 * extractor as `ai_suggested`, from NLM vocabulary lookups, from manual
 * entry, or from pasted imports — and every one must be analyst-verified.
 * All spec updates are immutable; the parent owns the StudySpec.
 */
import { useEffect, useId, useRef, useState } from "react";
import type {
  CodeEntry,
  CodeList,
  CodeSource,
  CodeSystem,
  StudySpec,
} from "@heor-studio/core";
import { searchDrugNames, searchIcd10cm } from "@heor-studio/core";
import "./workbench.css";

/* ---------- constants & pure helpers ---------- */

const SYSTEM_LABELS: Record<CodeSystem, string> = {
  icd9cm: "ICD-9-CM",
  icd10cm: "ICD-10-CM",
  cpt_hcpcs: "CPT / HCPCS",
  ndc: "NDC",
  drug_name: "Drug name",
};

const SOURCE_LABELS: Record<CodeSource, string> = {
  ai_suggested: "AI suggested",
  vocabulary_lookup: "Vocabulary",
  user_entered: "Manual",
  imported: "Imported",
};

const SYSTEM_OPTIONS: CodeSystem[] = ["icd10cm", "icd9cm", "cpt_hcpcs", "ndc", "drug_name"];

function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "code_list";
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** Parse pasted text: one code per line, or CSV/TSV `code,description`. */
function parsePastedCodes(text: string): { code: string; description?: string }[] {
  const out: { code: string; description?: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.search(/[,\t]/);
    const code = stripQuotes(sep === -1 ? line : line.slice(0, sep));
    if (!code) continue;
    const description = sep === -1 ? "" : stripQuotes(line.slice(sep + 1));
    out.push(description ? { code, description } : { code });
  }
  return out;
}

/** Normalized vocabulary search hit shown in the results list. */
interface SearchHit {
  code: string;
  description?: string;
  /** RxNorm term type for drug hits (e.g. "IN", "SBD"). */
  meta?: string;
}

async function runVocabSearch(
  system: CodeSystem,
  term: string
): Promise<{ hits: SearchHit[] } | { error: string }> {
  if (system === "icd10cm") {
    const r = await searchIcd10cm(term);
    if ("error" in r) return r;
    return {
      hits: r.results.map((m) => ({ code: m.code, description: m.description || undefined })),
    };
  }
  const r = await searchDrugNames(term);
  if ("error" in r) return r;
  return {
    hits: r.results.map((m) => ({
      code: m.name.toUpperCase(),
      description: m.synonym ?? (m.tty ? `RxNorm ${m.tty}` : undefined),
      meta: m.tty || undefined,
    })),
  };
}

/* ---------- root component ---------- */

export default function CodelistWorkbench({
  spec,
  onChange,
}: {
  spec: StudySpec;
  onChange: (spec: StudySpec) => void;
}) {
  const updateList = (id: string, up: (cl: CodeList) => CodeList) => {
    onChange({
      ...spec,
      codeLists: spec.codeLists.map((cl) => (cl.id === id ? up(cl) : cl)),
    });
  };

  const createList = (label: string, system: CodeSystem) => {
    const taken = new Set(spec.codeLists.map((c) => c.id));
    const list: CodeList = {
      id: uniqueId(slugify(label), taken),
      label: label.trim(),
      system,
      codes: [],
    };
    onChange({ ...spec, codeLists: [...spec.codeLists, list] });
  };

  const total = spec.codeLists.reduce((n, cl) => n + cl.codes.length, 0);
  const verified = spec.codeLists.reduce(
    (n, cl) => n + cl.codes.filter((c) => c.verified).length,
    0
  );

  return (
    <section className="wb" aria-label="Codelist workbench">
      <header className="wb-head">
        <h2 className="wb-title">Code lists</h2>
        <p className="wb-tally">
          {total === 0
            ? "No codes defined yet"
            : `${verified} of ${total} codes verified across ${spec.codeLists.length} list${
                spec.codeLists.length === 1 ? "" : "s"
              }`}
        </p>
      </header>

      {spec.codeLists.map((cl) => (
        <CodeListCard key={cl.id} list={cl} onUpdate={(up) => updateList(cl.id, up)} />
      ))}

      <NewListForm onCreate={createList} />
    </section>
  );
}

/* ---------- one code list card ---------- */

function CodeListCard({
  list,
  onUpdate,
}: {
  list: CodeList;
  onUpdate: (up: (cl: CodeList) => CodeList) => void;
}) {
  const [open, setOpen] = useState(true);
  const uid = useId();
  const bodyId = `${uid}-body`;
  const notesId = `${uid}-notes`;

  const verifiedCount = list.codes.filter((c) => c.verified).length;
  const allVerified = list.codes.length > 0 && verifiedCount === list.codes.length;

  const setVerified = (index: number, value: boolean) =>
    onUpdate((cl) => ({
      ...cl,
      codes: cl.codes.map((c, i) => (i === index ? { ...c, verified: value } : c)),
    }));

  const removeCode = (index: number) =>
    onUpdate((cl) => ({ ...cl, codes: cl.codes.filter((_, i) => i !== index) }));

  const verifyAll = () =>
    onUpdate((cl) => ({
      ...cl,
      codes: cl.codes.map((c) => (c.verified ? c : { ...c, verified: true })),
    }));

  /** Append entries, silently skipping codes already in the list. */
  const addCodes = (entries: CodeEntry[]) =>
    onUpdate((cl) => {
      const have = new Set(cl.codes.map((c) => c.code.toLowerCase()));
      const fresh = entries.filter((e) => {
        const k = e.code.toLowerCase();
        if (have.has(k)) return false;
        have.add(k);
        return true;
      });
      return fresh.length === 0 ? cl : { ...cl, codes: [...cl.codes, ...fresh] };
    });

  const setNotes = (value: string) =>
    onUpdate((cl) => ({ ...cl, notes: value || undefined }));

  return (
    <article className={`wb-card${allVerified ? " wb-card--done" : ""}`}>
      <header className="wb-card-head">
        <button
          type="button"
          className="wb-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <span className="wb-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="wb-card-label">{list.label}</span>
        </button>
        <span className="wb-sys">{SYSTEM_LABELS[list.system]}</span>
        <span className={`wb-count${allVerified ? " wb-count--done" : ""}`}>
          {list.codes.length === 0
            ? "empty"
            : `${verifiedCount}/${list.codes.length} verified`}
        </span>
        <code className="wb-listid">{list.id}</code>
      </header>

      {open && (
        <div id={bodyId} className="wb-card-body">
          {list.codes.length === 0 ? (
            <p className="wb-empty">
              No codes yet — AI intentionally does not invent codes; search the
              vocabulary or paste your list.
            </p>
          ) : (
            <>
              <div className="wb-table-wrap">
                <table className="wb-table">
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Description</th>
                      <th scope="col">Source</th>
                      <th scope="col">Verified</th>
                      <th scope="col">
                        <span className="wb-visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.codes.map((c, i) => (
                      <tr key={`${c.code}-${i}`} className={c.verified ? undefined : "wb-row--unverified"}>
                        <td className="wb-code">{c.code}</td>
                        <td className="wb-desc">
                          {c.description ? c.description : <span className="wb-none">(none)</span>}
                        </td>
                        <td>
                          <SourceBadge source={c.source} />
                        </td>
                        <td className="wb-verify-cell">
                          <input
                            type="checkbox"
                            className="wb-check"
                            checked={c.verified}
                            onChange={(ev) => setVerified(i, ev.target.checked)}
                            aria-label={`Verify ${c.code}`}
                          />
                        </td>
                        <td className="wb-actions-cell">
                          <button
                            type="button"
                            className="wb-remove"
                            onClick={() => removeCode(i)}
                            aria-label={`Remove ${c.code}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="wb-rowactions">
                <button
                  type="button"
                  className="wb-btn"
                  onClick={verifyAll}
                  disabled={allVerified}
                >
                  Verify all
                </button>
              </div>
            </>
          )}

          <AddCodeRow system={list.system} onAdd={(entry) => addCodes([entry])} />
          <ImportPanel existing={list.codes} onAdd={addCodes} />

          <div className="wb-notes">
            <label className="wb-label" htmlFor={notesId}>
              Notes
            </label>
            <textarea
              id={notesId}
              className="wb-textarea"
              rows={2}
              value={list.notes ?? ""}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Provenance, lookback caveats, era handling…"
            />
          </div>
        </div>
      )}
    </article>
  );
}

/* ---------- provenance badge ---------- */

function SourceBadge({ source }: { source: CodeSource }) {
  return <span className={`wb-src wb-src--${source}`}>{SOURCE_LABELS[source]}</span>;
}

/* ---------- add-code row (vocabulary search or manual) ---------- */

function AddCodeRow({
  system,
  onAdd,
}: {
  system: CodeSystem;
  onAdd: (entry: CodeEntry) => void;
}) {
  const searchable = system === "icd10cm" || system === "drug_name";

  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const [manualCode, setManualCode] = useState("");
  const [manualDesc, setManualDesc] = useState("");

  const uid = useId();
  const searchId = `${uid}-search`;
  const codeId = `${uid}-code`;
  const descId = `${uid}-desc`;

  useEffect(() => {
    if (!searchable) return;
    const q = term.trim();
    const mySeq = ++seq.current;
    if (q.length < 2) {
      setHits([]);
      setBusy(false);
      setError(null);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      void runVocabSearch(system, q).then((r) => {
        if (seq.current !== mySeq) return; // stale response — a newer search is in flight
        setBusy(false);
        if ("error" in r) {
          setError(r.error);
          setHits([]);
        } else {
          setError(null);
          setHits(r.hits);
        }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [term, system, searchable]);

  if (!searchable) {
    return (
      <form
        className="wb-addrow"
        onSubmit={(e) => {
          e.preventDefault();
          const code = manualCode.trim();
          if (!code) return;
          onAdd({
            code,
            description: manualDesc.trim() || undefined,
            source: "user_entered",
            verified: false,
          });
          setManualCode("");
          setManualDesc("");
        }}
      >
        <div className="wb-field wb-field--code">
          <label className="wb-label" htmlFor={codeId}>
            Add code ({SYSTEM_LABELS[system]})
          </label>
          <input
            id={codeId}
            className="wb-input"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            placeholder={system === "ndc" ? "11-digit NDC" : "Code"}
            autoComplete="off"
          />
        </div>
        <div className="wb-field">
          <label className="wb-label" htmlFor={descId}>
            Description (optional)
          </label>
          <input
            id={descId}
            className="wb-input"
            value={manualDesc}
            onChange={(e) => setManualDesc(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="wb-btn" disabled={!manualCode.trim()}>
          Add
        </button>
      </form>
    );
  }

  const manualFromTerm = () => {
    const code = term.trim().toUpperCase();
    if (!code) return;
    onAdd({ code, source: "user_entered", verified: false });
    setTerm("");
  };

  return (
    <div className="wb-search">
      <label className="wb-label" htmlFor={searchId}>
        {system === "icd10cm"
          ? "Add code — search ICD-10-CM (NLM Clinical Tables)"
          : "Add code — search drug names (NLM RxNav)"}
      </label>
      <input
        id={searchId}
        type="search"
        className="wb-input"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={system === "icd10cm" ? "e.g. psoriasis or L40" : "e.g. secukinumab"}
        autoComplete="off"
      />
      <div className="wb-search-status" aria-live="polite">
        {busy && <span>Searching…</span>}
        {!busy && error && <span className="wb-error">{error}</span>}
        {!busy && !error && term.trim().length >= 2 && hits.length === 0 && (
          <span>No matches.</span>
        )}
      </div>
      {hits.length > 0 && (
        <ul className="wb-results">
          {hits.map((h) => (
            <li key={`${h.code}|${h.meta ?? ""}`}>
              <button
                type="button"
                className="wb-result"
                onClick={() =>
                  onAdd({
                    code: h.code,
                    description: h.description,
                    source: "vocabulary_lookup",
                    verified: false,
                  })
                }
              >
                <span className="wb-result-code">{h.code}</span>
                {h.description && <span className="wb-result-desc">{h.description}</span>}
                {h.meta && <span className="wb-result-meta">{h.meta}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {term.trim() && (
        <button type="button" className="wb-btn wb-btn--ghost" onClick={manualFromTerm}>
          Add “{term.trim().toUpperCase()}” as a manual entry
        </button>
      )}
    </div>
  );
}

/* ---------- paste-a-list import ---------- */

function ImportPanel({
  existing,
  onAdd,
}: {
  existing: CodeEntry[];
  onAdd: (entries: CodeEntry[]) => void;
}) {
  const [show, setShow] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const uid = useId();
  const areaId = `${uid}-paste`;

  const doImport = () => {
    const parsed = parsePastedCodes(text);
    const have = new Set(existing.map((c) => c.code.toLowerCase()));
    const fresh: CodeEntry[] = [];
    let skipped = 0;
    for (const p of parsed) {
      const k = p.code.toLowerCase();
      if (have.has(k)) {
        skipped++;
        continue;
      }
      have.add(k);
      fresh.push({
        code: p.code,
        description: p.description,
        source: "imported",
        verified: false,
      });
    }
    if (fresh.length > 0) onAdd(fresh);
    setStatus(
      `Imported ${fresh.length} code${fresh.length === 1 ? "" : "s"}` +
        (skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}` : "") +
        "."
    );
    setText("");
  };

  return (
    <div className="wb-import">
      <button
        type="button"
        className="wb-btn wb-btn--ghost"
        aria-expanded={show}
        aria-controls={areaId}
        onClick={() => {
          setShow(!show);
          setStatus(null);
        }}
      >
        {show ? "Hide paste import" : "Paste a list…"}
      </button>
      {show && (
        <div className="wb-import-body">
          <label className="wb-label" htmlFor={areaId}>
            One code per line, or CSV <code>code,description</code>
          </label>
          <textarea
            id={areaId}
            className="wb-textarea"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"L40.0,Psoriasis vulgaris\nL40.1"}
            spellCheck={false}
          />
          <button
            type="button"
            className="wb-btn"
            onClick={doImport}
            disabled={!text.trim()}
          >
            Import
          </button>
        </div>
      )}
      <div className="wb-search-status" aria-live="polite">
        {status && <span>{status}</span>}
      </div>
    </div>
  );
}

/* ---------- new code list ---------- */

function NewListForm({
  onCreate,
}: {
  onCreate: (label: string, system: CodeSystem) => void;
}) {
  const [label, setLabel] = useState("");
  const [system, setSystem] = useState<CodeSystem>("icd10cm");
  const uid = useId();
  const labelId = `${uid}-label`;
  const sysId = `${uid}-system`;

  return (
    <form
      className="wb-newlist"
      onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        onCreate(label, system);
        setLabel("");
      }}
    >
      <h3 className="wb-newlist-title">New code list</h3>
      <div className="wb-newlist-fields">
        <div className="wb-field">
          <label className="wb-label" htmlFor={labelId}>
            Label
          </label>
          <input
            id={labelId}
            className="wb-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Depression diagnosis"
            autoComplete="off"
          />
        </div>
        <div className="wb-field">
          <label className="wb-label" htmlFor={sysId}>
            Code system
          </label>
          <select
            id={sysId}
            className="wb-input wb-select"
            value={system}
            onChange={(e) => setSystem(e.target.value as CodeSystem)}
          >
            {SYSTEM_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {SYSTEM_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="wb-btn" disabled={!label.trim()}>
          Create list
        </button>
      </div>
      {label.trim() && (
        <p className="wb-hint">
          id: <code>{slugify(label)}</code>
        </p>
      )}
    </form>
  );
}
