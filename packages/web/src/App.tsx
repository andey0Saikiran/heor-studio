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
import ChatShell from "./components/ChatShell";
import { loadCorrections, saveCorrections, type FlagRequest } from "./lib/corrections";
import "./App.css";

const DRAFT_KEY = "heor-studio.draft";

/* The tools drawer. NOT a wizard: these are the form-based editors that are
 * genuinely better as forms than as conversation (a code-list grid with live
 * vocabulary search, the per-analysis parameter fields, bundle naming). They
 * open on demand over the one chat surface, in any order, with no numbered
 * steps and no forced sequence. The old 1..5 stepper is gone. */
const TOOLS = [
  { key: "details", label: "Study details" },
  { key: "codelists", label: "Code lists" },
  { key: "code", label: "Code & naming" },
  { key: "export", label: "Export" },
] as const;
type ToolKey = (typeof TOOLS)[number]["key"];

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

/* ---------- app shell ---------- */

export default function App() {
  const [spec, setSpec] = useState<StudySpec | null>(null);
  /* THE CHAT IS THE ONLY SURFACE. The form editors live in an on-demand tools
   * drawer (toolsTab), never a numbered mode you switch into. */
  const [toolsTab, setToolsTab] = useState<ToolKey | null>(null);
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
  };

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
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setInboxOpen(true)}>
              Corrections
              {openCount > 0 && (
                <span className="count-badge" aria-label={`${openCount} open`}>
                  {openCount}
                </span>
              )}
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSettingsOpen(true)}>
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

        <ChatShell
          spec={spec}
          onChange={updateSpec}
          onAdopt={adoptSpec}
          settings={settings}
          onOpenSettings={() => setSettingsOpen(true)}
          options={emitOptions}
          onLoadDemo={() => adoptSpec(structuredClone(PSO_DEMO_SPEC))}
          onStartBlank={() => adoptSpec(blankSpec())}
          onOpenPanels={() => setToolsTab("codelists")}
          onFlag={setFlagRequest}
        />
      </main>

      {spec && toolsTab && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setToolsTab(null); }}
        >
          <div role="dialog" aria-modal="true" aria-label="Study tools" className="modal modal-tools">
            <div className="tools-head">
              <div className="tools-tabs" role="tablist">
                {TOOLS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={toolsTab === t.key}
                    className={toolsTab === t.key ? "tools-tab tools-tab-on" : "tools-tab"}
                    onClick={() => setToolsTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-quiet btn-sm" aria-label="Close tools" onClick={() => setToolsTab(null)}>
                Done
              </button>
            </div>
            <div className="tools-body">
              {toolsTab === "details" && (
                <SpecReview
                  spec={spec}
                  settings={settings}
                  onChange={updateSpec}
                  onFlag={setFlagRequest}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              )}
              {toolsTab === "codelists" && (
                <CodelistWorkbench spec={spec} onChange={updateSpec} onFlag={setFlagRequest} />
              )}
              {toolsTab === "code" && (
                <CodePanel
                  spec={spec}
                  options={emitOptions}
                  onOptionsChange={setEmitOptions}
                  onNavigate={() => setToolsTab(null)}
                  onFlag={setFlagRequest}
                />
              )}
              {toolsTab === "export" && (
                <ExportPanel spec={spec} options={emitOptions} onNavigate={() => setToolsTab(null)} />
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="app-footer-inner">
          <p className="privacy-line">
            Runs entirely in your browser. Documents go only to Anthropic, with your key. Nothing
            touches our servers.
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
