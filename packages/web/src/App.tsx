import { useEffect, useRef, useState } from "react";
import type { Correction, StudySpec } from "@heor-studio/core";
import { PSO_DEMO_SPEC } from "./fixtures/pso";
import type { EmitOptions } from "@heor-studio/core";
import { DEFAULT_EMIT_OPTIONS } from "@heor-studio/core";
import SpecReview from "./components/SpecReview";
import CodePanel from "./components/CodePanel";
import ExportPanel from "./components/ExportPanel";
import SettingsModal, {
  loadSettings,
  saveSettings,
  type AppSettings,
} from "./components/SettingsModal";
import CodelistWorkbench from "./components/CodelistWorkbench";
import CorrectionModal from "./components/CorrectionModal";
import CorrectionsInbox from "./components/CorrectionsInbox";
import { loadCorrections, saveCorrections, type FlagRequest } from "./lib/corrections";
import { extractSpec } from "@heor-studio/core";
import "./App.css";

const DRAFT_KEY = "heor-studio.draft";

const STEPS = [
  { n: 1, label: "Protocol" },
  { n: 2, label: "Review spec" },
  { n: 3, label: "Codelists" },
  { n: 4, label: "Code" },
  { n: 5, label: "Export" },
] as const;

/* ---------- draft persistence ---------- */

interface DraftPayload {
  savedAt: string;
  spec: StudySpec;
}

function loadDraft(): DraftPayload | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const p: unknown = JSON.parse(raw);
    if (
      p &&
      typeof p === "object" &&
      "spec" in p &&
      p.spec &&
      typeof p.spec === "object" &&
      "meta" in (p.spec as object) &&
      Array.isArray((p.spec as { criteria?: unknown }).criteria)
    ) {
      return p as DraftPayload;
    }
  } catch {
    /* corrupt draft — ignore */
  }
  return null;
}

/* ---------- helpers ---------- */

function bumpPatch(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return v;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function blankSpec(): StudySpec {
  return {
    meta: {
      title: "Untitled study",
      version: "0.1.0",
      database: "marketscan_ccae",
      studyPeriod: { start: "2018-01-01", end: "2023-12-31" },
      provenance: { method: "manual" },
    },
    codeLists: [],
    indexEvent: {
      type: "first_diagnosis",
      codeListId: "",
      indexPeriod: { start: "2019-01-01", end: "2022-12-31" },
    },
    enrollment: {
      baselineDays: 365,
      followupDays: 365,
      gapAllowanceDays: 31,
      requiresRxCoverage: true,
    },
    criteria: [],
    baseline: [],
    outcomes: [],
    groupVars: [],
    comparisons: [],
    analyses: [
      { id: "a_attrition", label: "Attrition", kind: "attrition", enabled: true },
      { id: "a_table1", label: "Baseline characteristics", kind: "table1", enabled: true },
    ],
  };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
}

/* ---------- step 1: protocol intake ---------- */

interface PdfPick {
  name: string;
  size: number;
  base64: string;
}

function ProtocolStep({
  settings,
  onOpenSettings,
  onSpecReady,
}: {
  settings: AppSettings;
  onOpenSettings: () => void;
  onSpecReady: (spec: StudySpec) => void;
}) {
  const [pdf, setPdf] = useState<PdfPick | null>(null);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const acceptFile = async (file: File | null | undefined) => {
    setError(null);
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setError("Only PDF files are supported here. For anything else, paste the text below.");
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setPdf({ name: file.name, size: file.size, base64 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runExtract = async () => {
    setError(null);
    const source = pdf
      ? { kind: "pdf" as const, base64: pdf.base64, name: pdf.name }
      : text.trim()
        ? { kind: "text" as const, text }
        : null;
    if (!source) {
      setError("Choose a protocol PDF or paste SAP text first.");
      return;
    }
    if (!settings.apiKey) {
      setError("AI extraction needs your API key — set it in Settings.");
      return;
    }
    setBusy(true);
    setStatus("Preparing extraction…");
    try {
      const result: StudySpec = await extractSpec({
        apiKey: settings.apiKey,
        model: settings.model,
        source,
        onStatus: (s: string) => setStatus(s),
      });
      onSpecReady(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  return (
    <div>
      <section className="card" aria-labelledby="proto-title">
        <h2 className="card-title" id="proto-title">
          Protocol or SAP
        </h2>
        <p className="card-sub">
          Bring your own key: extraction calls the LLM endpoint you configured in Settings, directly
          from this browser, with your key. The document goes nowhere else.
        </p>

        <label
          className={dragging ? "dropzone is-drag" : "dropzone"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void acceptFile(e.dataTransfer.files[0]);
          }}
        >
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => {
              void acceptFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <span className="dropzone-primary">Drop a protocol PDF here, or click to choose</span>
          <span>Read locally with FileReader; sent only to your configured endpoint.</span>
        </label>

        {pdf && (
          <span className="file-chip">
            {pdf.name} ({Math.max(1, Math.round(pdf.size / 1024))} KB)
            <button type="button" aria-label={`Remove ${pdf.name}`} onClick={() => setPdf(null)}>
              &times;
            </button>
          </span>
        )}

        <div className="or-rule">or paste text</div>

        <div className="field">
          <label className="field-label" htmlFor="sap-text">
            SAP / protocol text
          </label>
          <textarea
            id="sap-text"
            className="control control-wide"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the relevant protocol or SAP sections (cohort definition, index event, criteria)…"
          />
          {pdf && text.trim() && (
            <span className="field-hint">
              A PDF is selected, so it takes precedence — remove it to extract from this text.
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "1rem" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (!pdf && !text.trim())}
            onClick={() => void runExtract()}
          >
            {busy ? "Extracting…" : "Extract with AI"}
          </button>
          {!settings.apiKey && (
            <button type="button" className="btn btn-quiet" onClick={onOpenSettings}>
              Set API key in Settings
            </button>
          )}
        </div>
        {status && (
          <p className="status-line" role="status" aria-live="polite">
            {status}
          </p>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="noai-title">
        <h2 className="card-title" id="noai-title">
          No AI required
        </h2>
        <p className="card-sub">
          Both paths below build the same reviewed-spec structure without any LLM call.
        </p>
        <div className="alt-paths">
          <button
            type="button"
            className="btn"
            onClick={() => onSpecReady(structuredClone(PSO_DEMO_SPEC))}
          >
            Load demo study (PsO biologics)
          </button>
          <button type="button" className="btn" onClick={() => onSpecReady(blankSpec())}>
            Start blank
          </button>
        </div>
      </section>
    </div>
  );
}

/* ---------- app shell ---------- */

export default function App() {
  const [spec, setSpec] = useState<StudySpec | null>(null);
  const [step, setStep] = useState(1);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [emitOptions, setEmitOptions] = useState<EmitOptions>(DEFAULT_EMIT_OPTIONS);
  const [draft, setDraft] = useState<DraftPayload | null>(() => loadDraft());
  const [corrections, setCorrections] = useState<Correction[]>(() => loadCorrections());
  const [flagRequest, setFlagRequest] = useState<FlagRequest | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const lastBumpRef = useRef(0);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveCorrections(corrections);
  }, [corrections]);

  // Auto-save the working spec as a draft.
  useEffect(() => {
    if (!spec) return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ savedAt: new Date().toISOString(), spec }),
        );
      } catch {
        /* storage full/unavailable — draft stays in memory */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [spec]);

  /** Central spec update: bumps the patch version, coalescing rapid edits. */
  const updateSpec = (next: StudySpec) => {
    const now = Date.now();
    if (now - lastBumpRef.current > 2000) {
      lastBumpRef.current = now;
      next = { ...next, meta: { ...next.meta, version: bumpPatch(next.meta.version) } };
    }
    setSpec(next);
  };

  const adoptSpec = (s: StudySpec) => {
    lastBumpRef.current = Date.now();
    setSpec(s);
    setDraft(null);
    setStep(2);
  };

  const reachable = (n: number) => n === 1 || spec !== null;

  /** Newest first; the deterministic id means re-filing the same claim replaces it. */
  const addCorrection = (c: Correction) =>
    setCorrections((prev) => [c, ...prev.filter((p) => p.id !== c.id)]);
  const openCount = corrections.filter((c) => c.status === "open").length;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="wordmark">HEOR Studio</h1>
          <span className="tagline">Protocol to verified study code, for MarketScan</span>
          <div className="header-actions">
            <button type="button" className="btn btn-sm" onClick={() => setInboxOpen(true)}>
              Corrections
              {openCount > 0 && (
                <span className="count-badge" aria-label={`${openCount} open`}>
                  {openCount}
                </span>
              )}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        {draft && !spec && (
          <div className="banner banner-info">
            <div className="banner-body">
              <p className="banner-title">Saved draft found</p>
              <p>
                &ldquo;{draft.spec.meta.title}&rdquo; was auto-saved on{" "}
                {new Date(draft.savedAt).toLocaleString()}.
              </p>
            </div>
            <div className="banner-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => adoptSpec(draft.spec)}>
                Restore
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  try {
                    localStorage.removeItem(DRAFT_KEY);
                  } catch {
                    /* ignore */
                  }
                  setDraft(null);
                }}
              >
                Discard
              </button>
            </div>
          </div>
        )}

        <nav aria-label="Wizard steps">
          <ol className="stepper">
            {STEPS.map((s) => (
              <li key={s.n}>
                <button
                  type="button"
                  className="step-btn"
                  aria-current={step === s.n ? "step" : undefined}
                  disabled={!reachable(s.n)}
                  onClick={() => setStep(s.n)}
                >
                  <span className="step-num" aria-hidden="true">
                    {s.n}
                  </span>
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        {step === 1 && (
          <ProtocolStep
            settings={settings}
            onOpenSettings={() => setSettingsOpen(true)}
            onSpecReady={adoptSpec}
          />
        )}
        {step > 1 && !spec && (
          <section className="card">
            <h2 className="card-title">No study yet</h2>
            <p className="card-sub">Start on the Protocol step to create or load a study spec.</p>
            <button type="button" className="btn" onClick={() => setStep(1)}>
              Go to Protocol
            </button>
          </section>
        )}
        {step === 2 && spec && (
          <SpecReview spec={spec} onChange={updateSpec} onFlag={setFlagRequest} />
        )}
        {step === 3 && spec && (
          <CodelistWorkbench spec={spec} onChange={updateSpec} onFlag={setFlagRequest} />
        )}
        {step === 4 && spec && (
          <CodePanel
            spec={spec}
            options={emitOptions}
            onOptionsChange={setEmitOptions}
            onNavigate={setStep}
            onFlag={setFlagRequest}
          />
        )}
        {step === 5 && spec && (
          <ExportPanel spec={spec} options={emitOptions} onNavigate={setStep} />
        )}

        <div className="wizard-nav">
          <button
            type="button"
            className="btn"
            disabled={step === 1}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
          <button
            type="button"
            className="btn"
            disabled={step === 5 || !reachable(step + 1)}
            onClick={() => setStep(step + 1)}
          >
            Continue
          </button>
        </div>
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <p className="privacy-line">
            Runs entirely in your browser. Documents go only to the LLM endpoint you configure, with
            your key. Nothing touches our servers.
          </p>
          <span className="footer-note">
            HEOR Studio is an independent open-source project, not affiliated with or endorsed by
            Merative. MarketScan&reg; is a registered trademark of Merative US&nbsp;L.P. Generated
            code requires analyst verification and a valid MarketScan license.
          </span>
        </div>
      </footer>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {flagRequest && (
        <CorrectionModal
          request={flagRequest}
          onRecord={(c) => {
            addCorrection(c);
            setFlagRequest(null);
          }}
          onClose={() => setFlagRequest(null)}
        />
      )}

      {inboxOpen && (
        <CorrectionsInbox
          corrections={corrections}
          onDelete={(id) => setCorrections((prev) => prev.filter((c) => c.id !== id))}
          onClose={() => setInboxOpen(false)}
        />
      )}
    </div>
  );
}
