/**
 * Chat shell — the conversation IS the app.
 *
 * Two panes, the shape people already know from a coding assistant: talk on the
 * left, and a pane on the right that OPENS when there is something to look at.
 * Generated programs, the study summary, the export bundle. The pane closes and
 * the conversation is still there.
 *
 * WHAT THE CHAT MAY AND MAY NOT DO. It edits the SPEC. It never edits generated
 * code. SAS and SQL are a pure function of the reviewed spec, and every
 * verification guarantee in this project stands on that, so the chat proposes a
 * spec, the analyst accepts a diff, and the emitters run again on their own.
 *
 * THE REVIEW GATE IS ASKED, NOT PRESENTED. Code generation is blocked until
 * every criterion is reviewed and every code verified. That review is the
 * ReviewPanel: the outstanding items grouped into sections, each carrying the
 * verbatim protocol sentence beside the rule it produced, with a bulk confirm
 * for the routine groups and the risky ones (unmapped criteria, AI-suggested
 * codes) surfaced open. The ordering, evidence and risk come from core
 * (spec/review-queue.ts) and are guarded there.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ProposedSpecEdit, ReviewItem, SpecChange, StudySpec, GeneratedFile, EmitOptions,
} from "@heor-studio/core";
import {
  changesRequiringRereview, diffSpecs, emitSas, emitSql, extractSpec,
  listModels, planBundle, converseOrEdit, reviewProgress, reviewQueue, specReadiness,
  bundleFilename,
} from "@heor-studio/core";
import type { AppSettings } from "./SettingsModal";
import type { FlagRequest } from "../lib/corrections";
import { buildZip, downloadBlob } from "../lib/exportZip";
import type { RunProgress } from "../lib/verifyRun";
import { runVerification } from "../lib/verifyRun";
import Margin from "./Margin";
import ReviewPanel from "./ReviewPanel";
import LimitationsPanel from "./LimitationsPanel";
import "./chatshell.css";

type Dialect = "sas" | "postgres" | "snowflake";

type Msg =
  | { id: string; role: "user"; kind: "text"; text: string }
  | { id: string; role: "assistant"; kind: "text"; text: string }
  | { id: string; role: "assistant"; kind: "review"; item: ReviewItem; answer?: "yes" | "no" }
  | { id: string; role: "assistant"; kind: "proposal"; proposal: ProposedSpecEdit; settled?: "accepted" | "discarded" };

let seq = 0;
const nextId = () => `m${++seq}`;

export interface ChatShellProps {
  spec: StudySpec | null;
  onChange: (s: StudySpec) => void;
  onAdopt: (s: StudySpec) => void;
  settings: AppSettings;
  onOpenSettings: () => void;
  options: EmitOptions;
  onLoadDemo: () => void;
  onStartBlank: () => void;
  onOpenPanels: () => void;
  onFlag: (r: FlagRequest) => void;
}

export default function ChatShell(props: ChatShellProps) {
  const { spec, onChange, onAdopt, settings, onOpenSettings, options } = props;
  const uid = useId();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [paneOpen, setPaneOpen] = useState(false);
  const [dialect, setDialect] = useState<Dialect>("postgres");
  const [selected, setSelected] = useState("");
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* THE VERIFICATION RUN, owned here so its trigger can sit in the pane header
   * where a person actually looks, instead of at the foot of the Margin. The
   * Margin renders this same state as the ledger. */
  const [run, setRun] = useState<RunProgress | null>(null);
  const runStartedRef = useRef(false);
  const startRun = useCallback(() => {
    if (runStartedRef.current) return;
    runStartedRef.current = true;
    void runVerification(setRun).finally(() => { runStartedRef.current = false; });
  }, []);

  const say = useCallback((text: string) => {
    setMsgs((m) => [...m, { id: nextId(), role: "assistant", kind: "text", text }]);
  }, []);

  const summarize = (s: StudySpec, from: "document" | "loaded") => {
    const p = reviewProgress(s);
    const enabled = s.analyses.filter((a) => a.enabled).length;
    return (
      (from === "document" ? `Here is what I read out of that document.\n\n` : `Here is the study as it stands.\n\n`) +
      `  Study        ${s.meta.title}\n` +
      `  Database     ${s.meta.database}\n` +
      `  Period       ${s.meta.studyPeriod.start} to ${s.meta.studyPeriod.end}\n` +
      `  Index event  ${s.indexEvent.type.replace(/_/g, " ")}\n` +
      `  Criteria     ${p.criteriaTotal}\n` +
      `  Code lists   ${s.codeLists.length} (${p.codesTotal} codes)\n` +
      `  Analyses     ${enabled} enabled\n\n` +
      (p.remaining === 0
        ? (s.meta.provenance.method === "demo"
            ? `This is the built-in demo, pre-filled so you can see the generated code right away. The review flags were set by the project, not by you, so the exported bundle says plainly it is a demonstration, not a reviewed study.`
            : `Everything here is already signed off, so the code is ready whenever you are.`)
        : `None of it is signed off yet, and I will not generate code until it is. ` +
          `There ${p.remaining === 1 ? "is 1 thing" : `are ${p.remaining} things`} to confirm below, grouped so you ` +
          `can clear the routine ones in a click and look closely at the few that need it.`)
    );
  };

  /* Keep the newest turn in view, the way a terminal does. */
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  /* A ticking elapsed clock while the model works. A single 30-to-60-second API
   * call reports almost no intermediate status, so without a visible counter the
   * screen looks frozen. The number moving is the proof it is alive. */
  const [busySeconds, setBusySeconds] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setBusySeconds(0);
    const t = window.setInterval(() => setBusySeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [busy]);


  const models = useMemo(() => { try { return listModels(); } catch { return []; } }, []);
  const model = settings.model || models[0]?.id || "";
  const hasKey = Boolean(settings.apiKey);

  const readiness = useMemo(() => (spec ? specReadiness(spec) : null), [spec]);
  const progress = useMemo(() => (spec ? reviewProgress(spec) : null), [spec]);
  const queue = useMemo(() => (spec ? reviewQueue(spec) : []), [spec]);

  /* Emitted files, recomputed from the spec exactly as the code panel does.
   * Nothing here triggers generation: it IS the spec, rendered. */
  const files: GeneratedFile[] = useMemo(() => {
    if (!spec || !readiness?.ready) return [];
    try {
      return dialect === "sas" ? emitSas(spec, options) : emitSql(spec, dialect, options);
    } catch {
      return [];
    }
  }, [spec, options, dialect, readiness?.ready]);

  const current = files.find((f) => f.path === selected) ?? files[0];

  /* ---------------- the review conversation ---------------- */

  /* THE REVIEW IS A PANEL NOW, NOT A QUEUE OF CHAT MESSAGES. askNext used to
   * push one review card per outstanding item, riskiest first, which on a real
   * protocol is seventy-odd sequential yes/no questions and a reject that
   * re-asks the same card forever. The ReviewPanel below shows them grouped,
   * with bulk confirm. So this only announces the transitions: gate cleared, or
   * signed off but still not ready. Each fires once. */
  const announced = useRef<"none" | "ready" | "blocked">("none");
  const announce = useCallback((s: StudySpec) => {
    const q = reviewQueue(s);
    if (q.length > 0) { announced.current = "none"; return; }
    const r = specReadiness(s);
    if (r.ready && announced.current !== "ready") {
      announced.current = "ready";
      say(
        "That is everything signed off. The study code is ready, and I have opened it on the right.\n\n" +
        "Nothing in it has been verified yet. Run the checks, top right of the code pane, and this browser will download Postgres and execute the full suite against the emitted SQL.\n\n" +
        "You can still ask for changes: anything you accept re-runs the emitters, and anything you touch goes back to needing a look.",
      );
      setPaneOpen(true);
    } else if (!r.ready && announced.current !== "blocked") {
      announced.current = "blocked";
      say(
        "Everything you could confirm is confirmed, but the spec still is not ready to generate code:\n\n" +
        r.problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nTell me what to change and I will propose it.",
      );
    }
  }, [say]);
  /* Announce whenever the outstanding count reaches zero, however it got there
   * (the panel's bulk-confirm, a single confirm, or an accepted chat edit). */
  useEffect(() => {
    if (spec && progress && progress.remaining === 0) announce(spec);
    else announced.current = "none";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, progress?.remaining]);

  /* GREET WHATEVER ARRIVES, however it arrived.
   *
   * A spec can turn up four ways: extracted from a document, loaded as the
   * demo, started blank, or restored from a saved draft. Only the first of
   * those goes through code that has anything to say, so the other three
   * dropped the analyst into an EMPTY conversation with a spec silently loaded
   * behind it - a button was pressed and nothing visibly happened. Greeting on
   * arrival rather than inside the upload path covers all four by construction,
   * including any future fifth. */
  const greeted = useRef(false);
  useEffect(() => {
    if (!spec || greeted.current) return;
    greeted.current = true;
    setMsgs((m) => (m.length > 0 ? m : [{ id: nextId(), role: "assistant", kind: "text", text: summarize(spec, "loaded") }]));
    announce(spec);
    /* `spec` alone on purpose. This must fire ONCE when a study first arrives,
     * and the ref is what enforces that. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  /* ---------------- extraction ---------------- */

  const acceptFile = async (file?: File | null) => {
    if (!file) return;
    setError("");
    /* The dropzone used to base64-encode ANYTHING and send it to the API as a
     * PDF, so a .docx or a text SAP came back as a raw API error. Validate here,
     * and point at the paste-text path for non-PDFs. */
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      setError(
        `That is not a PDF (${file.name}). Extraction reads PDFs; for a Word doc or a text SAP, ` +
        `open the full editor and paste the text into the protocol box instead.`,
      );
      return;
    }
    if (!hasKey) { setError("Reading a protocol needs your own API key. Open Settings to add one."); return; }
    setMsgs((m) => [...m, { id: nextId(), role: "user", kind: "text", text: `Uploaded ${file.name}` }]);
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onerror = () => rej(new Error("Could not read that file."));
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.readAsDataURL(file);
      });
      setBusy(`Reading ${file.name}…`);
      const s = await extractSpec({
        apiKey: settings.apiKey, model,
        source: { kind: "pdf", base64, name: file.name },
        onStatus: setBusy,
      });
      onAdopt(s);
      say(summarize(s, "document"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  /* ---------------- asking for a change ---------------- */

  const send = async () => {
    const instruction = draft.trim();
    if (!instruction || !spec) return;
    setError("");
    if (!hasKey) { setError("Asking for a change needs your own API key. Open Settings to add one."); return; }
    setMsgs((m) => [...m, { id: nextId(), role: "user", kind: "text", text: instruction }]);
    setDraft("");
    setBusy("Thinking…");
    try {
      const history = msgs
        .filter((m): m is Extract<Msg, { kind: "text" }> => m.kind === "text")
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text }));
      const turn = await converseOrEdit({
        apiKey: settings.apiKey, model, spec, instruction, history, onStatus: setBusy,
      });
      /* A question gets an answer; only a change gets a proposal card. */
      if (turn.kind === "reply") {
        say(turn.text);
      } else {
        setMsgs((m) => [...m, { id: nextId(), role: "assistant", kind: "proposal", proposal: turn.proposal }]);
      }
    } catch (e) {
      setError((e as Error).message);
      setDraft(instruction);
    } finally {
      setBusy(""); // send
    }
  };

  /* ---------------- let the AI fix the open problems ----------------
   * The product's point is that the AI does the analysis, not that it hands the
   * analyst a to-do list. When readiness is blocked on things the AI CAN resolve
   * (an unmapped criterion, a missing code list, an unset bound), it proposes the
   * fixes as one reviewable diff rather than saying "tell me what to change". It
   * does NOT touch the "cannot represent" limitations (those are acknowledge-or-
   * remove, not fixable) and it cannot mark anything reviewed or verified: the
   * human still approves, the AI just did the work. */
  const fixableProblems = useMemo(() => {
    if (!readiness) return [];
    return readiness.problems.filter((p) => !p.startsWith("CANNOT REPRESENT"));
  }, [readiness]);

  const proposeFixes = async () => {
    if (!spec || fixableProblems.length === 0) return;
    setError("");
    if (!hasKey) { setError("Fixing the open problems needs your own API key. Open Settings to add one."); return; }
    setMsgs((m) => [...m, { id: nextId(), role: "user", kind: "text", text: "Fix the open problems you can." }]);
    setBusy("Working out fixes for the open problems…");
    try {
      const instruction =
        "Resolve these readiness problems so the specification can generate code. For each, make the " +
        "SMALLEST correct change: map an unmapped criterion to a concrete rule, add a missing code list " +
        "(with codes marked source 'ai_suggested', or an empty list plus a note saying what to look up if " +
        "you are not sure of the codes, never invent a code you cannot stand behind), set a missing bound. " +
        "Change nothing the list below does not name, and do not mark anything reviewed or verified.\n\n" +
        "Problems:\n" + fixableProblems.map((p) => "- " + p).join("\n");
      const turn = await converseOrEdit({
        apiKey: settings.apiKey, model, spec, instruction, history: [], onStatus: setBusy,
      });
      if (turn.kind === "reply") {
        say(turn.text);
      } else {
        setMsgs((m) => [...m, { id: nextId(), role: "assistant", kind: "proposal", proposal: turn.proposal }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const acceptProposal = (msgId: string, p: ProposedSpecEdit) => {
    onChange(p.spec);
    setMsgs((m) => m.map((x) => (x.id === msgId && x.kind === "proposal" ? { ...x, settled: "accepted" } : x)));
  };

  /* ---------------- export ---------------- */

  const download = async () => {
    if (!spec) return;
    try {
      setBusy("Building the bundle…");
      const entries = planBundle(spec, options);
      const blob = await buildZip(entries);
      downloadBlob(blob, bundleFilename(spec));
      say(`Downloaded ${bundleFilename(spec)}. It holds the SAS and SQL, the reviewed spec, one CSV per code list, a README and the AI disclosure.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  /* ================= render ================= */

  const landing = !spec && (
    <div className="cs-landing">
      {!hasKey && (
        <div className="cs-callout" role="note">
          <span className="cs-callout-body">Reading a document needs your API key.</span>
          <button type="button" className="cs-callout-link" onClick={onOpenSettings}>Add key in settings</button>
        </div>
      )}
      <label
        className={`cs-drop${dragging ? " cs-drag" : ""}${busy ? " cs-drop-busy" : ""}`}
        onDragOver={(e) => { if (busy) return; e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (busy) return; e.preventDefault(); setDragging(false); void acceptFile(e.dataTransfer.files[0]); }}
      >
        <input type="file" accept="application/pdf,.pdf" className="sr-only" disabled={Boolean(busy)}
          onChange={(e) => { void acceptFile(e.target.files?.[0]); e.target.value = ""; }} />
        <svg className="cs-drop-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 2.5h8.5L20 8v13.5H6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M14.5 2.5V8H20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M9 12.5h8M9 15.5h8M9 18.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {busy ? (
          <>
            <span className="cs-drop-primary">{busy}</span>
            <span className="cs-drop-trust">
              A long protocol can take up to a minute. It is being read here, in your browser.
            </span>
          </>
        ) : (
          <>
            <span className="cs-drop-primary">Drop your protocol or SAP</span>
            <span className="cs-drop-formats" aria-label="Accepted format: PDF">
              <span className="cs-chip">.pdf</span>
            </span>
            <span className="cs-drop-trust">
              <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
                <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              Read in your browser, sent only to Anthropic with your key.
            </span>
          </>
        )}
      </label>
      <div className="cs-actions">
        <button type="button" className="btn btn-primary" onClick={props.onLoadDemo}>Load a demo study</button>
        <button type="button" className="btn btn-quiet" onClick={props.onStartBlank}>Start from blank</button>
      </div>
    </div>
  );

  /* ONE-LINE STATUS. Not a stepper, not layers: a single where-am-I line that
     derives from the same spec/readiness state everything else reads and changes
     nothing. The one flow is the chat; this just names where it is. It says
     "code ready" only when readiness is genuinely ready, because a status that
     reads settled while the gate is blocked is the exact settled-looking-unsettled
     state this product refuses. */
  const statusTone = !spec ? "idle" : readiness?.ready ? "ready" : "working";
  const statusText = !spec
    ? "Upload a protocol to begin."
    : readiness?.ready
      ? "Code ready."
      : progress && progress.remaining > 0
        ? `Reviewing the spec. ${progress.remaining} to confirm.`
        : "Finishing the spec.";
  const rail = (
    <p className="cs-status" data-tone={statusTone} role="status" aria-live="polite">
      <span className="cs-status-dot" aria-hidden="true" />
      {statusText}
    </p>
  );

  return (
    <div className={paneOpen && files.length > 0 ? "cs-shell cs-split cs-split-margin" : "cs-shell"}>
      <section className="cs-chat" aria-label="Conversation">
        {rail}
        <div className="cs-log" ref={logRef}>
          {landing}

          {msgs.map((m) => {
            if (m.kind === "text") {
              /* Claude-style: the assistant's reply is plain text in the reading
                 column, no bubble and no name label. The user's turn is a quiet
                 right-aligned bubble. That asymmetry is the whole feel. */
              return m.role === "user" ? (
                <div key={m.id} className="cs-turn cs-turn-user">
                  <div className="cs-user-bubble">{m.text}</div>
                </div>
              ) : (
                <div key={m.id} className="cs-turn cs-turn-assistant">
                  <div className="cs-md">{m.text}</div>
                </div>
              );
            }
            if (m.kind === "review") return null; /* review lives in ReviewPanel now */
            /* proposal */
            const changes: SpecChange[] = spec ? diffSpecs(spec, m.proposal.spec) : [];
            const costly = changesRequiringRereview(changes);
            return (
              <div key={m.id} className="cs-turn cs-turn-assistant">
                <div className="cs-proposal">
                  <div className="cs-proposal-body">
                    <div>{m.proposal.notes}</div>
                    {m.proposal.forged.length > 0 && (
                      <div className="cs-concern">
                        The model tried to mark {m.proposal.forged.length}{" "}
                        {m.proposal.forged.length === 1 ? "item" : "items"} as already checked by you. That was
                        overruled. Only you can sign something off here.
                      </div>
                    )}
                    {changes.length === 0 ? (
                      <em>This proposal changes nothing.</em>
                    ) : (
                      changes.map((c, i) => (
                        <div key={i} className={c.invalidates === "none" ? "cs-change" : "cs-change cs-costly"}>
                          <span className="cs-change-path">{c.path}</span>
                          <span>{c.summary}</span>
                        </div>
                      ))
                    )}
                  </div>
                  {costly.length > 0 && (
                    <div className="cs-cost">
                      Accepting this costs you {costly.length}{" "}
                      {costly.length === 1 ? "sign-off you already gave" : "sign-offs you already gave"}. Those
                      items go back on the list and I will ask about them again.
                    </div>
                  )}
                  <div className="cs-review-foot">
                    {m.settled ? (
                      <span className="cs-answered">
                        {m.settled === "accepted" ? "Applied" : "Discarded"}
                      </span>
                    ) : changes.length === 0 ? (
                      <button type="button" className="btn btn-sm"
                        onClick={() => setMsgs((x) => x.map((y) => (y.id === m.id && y.kind === "proposal" ? { ...y, settled: "discarded" } : y)))}>
                        Close
                      </button>
                    ) : (
                      <>
                        <button type="button" className="btn btn-primary btn-sm"
                          onClick={() => acceptProposal(m.id, m.proposal)}>Apply this</button>
                        <button type="button" className="btn btn-sm"
                          onClick={() => setMsgs((x) => x.map((y) => (y.id === m.id && y.kind === "proposal" ? { ...y, settled: "discarded" } : y)))}>
                          Discard
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {spec && !busy && (
            <LimitationsPanel spec={spec} onChange={onChange} />
          )}

          {spec && queue.length > 0 && !busy && (
            <ReviewPanel spec={spec} onChange={onChange} onFlag={props.onFlag} />
          )}

          {busy && (
            <div className="cs-turn cs-turn-assistant">
              <div className="cs-working" role="status" aria-live="polite">
                <span className="cs-working-dots" aria-hidden="true"><i /><i /><i /></span>
                <span className="cs-working-text">{busy}</span>
                <span className="cs-working-timer" data-num>{busySeconds}s</span>
              </div>
              {busySeconds >= 8 && (
                <div className="cs-working-note">
                  A long protocol can take up to a minute. It is being read in your browser and sent only to Anthropic.
                </div>
              )}
            </div>
          )}
          {error && <div className="inline-error" role="alert">{error}</div>}
        </div>

        <div className="cs-composer">
          {progress && progress.remaining > 0 && (
            <div className="cs-progress">
              <span>{progress.remaining} left to confirm</span>
              <span className="cs-bar">
                <span className="cs-bar-fill" style={{
                  width: `${Math.round(((progress.criteriaDone + progress.codesDone) /
                    Math.max(1, progress.criteriaTotal + progress.codesTotal)) * 100)}%`,
                }} />
              </span>
            </div>
          )}
          <div className="cs-box">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(e) => { void acceptFile(e.target.files?.[0]); e.target.value = ""; }}
            />
            <button
              type="button"
              className="cs-icon-btn"
              aria-label="Attach a protocol PDF"
              title="Attach a protocol PDF"
              disabled={Boolean(busy)}
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M8.5 12.5l6-6a3 3 0 0 1 4.2 4.2l-8 8a5 5 0 0 1-7-7l8-8"
                  fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <label className="sr-only" htmlFor={`${uid}-ask`}>Ask for a change</label>
            <textarea
              id={`${uid}-ask`}
              className="cs-box-input"
              rows={1}
              placeholder={spec ? "Ask for a change, or attach a new protocol" : "Attach a protocol, or load the demo below"}
              value={draft}
              disabled={!spec || Boolean(busy)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
            />
            <button
              type="button"
              className="cs-send"
              aria-label="Send"
              disabled={!spec || !draft.trim() || Boolean(busy)}
              onClick={() => void send()}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M12 19V6M6 12l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <span className="cs-hint">
            Enter to send, Shift+Enter for a new line. Changes edit the study spec, never the generated code.
          </span>
          {/* THE EDITOR IS REACHABLE WHENEVER THERE IS A STUDY, not only once
              the code exists. This button used to live inside the code pane,
              which only opens when the spec is READY - so the full editor was
              unreachable in exactly the state where an analyst needs it, which
              is when readiness is blocked and something has to be fixed by
              hand. */}
          {spec && (
            <div className="cs-progress">
              {fixableProblems.length > 0 && (
                <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)}
                  onClick={() => void proposeFixes()}>
                  Fix the {fixableProblems.length} open problem{fixableProblems.length === 1 ? "" : "s"} for me
                </button>
              )}
              <button type="button" className="btn btn-quiet btn-sm" onClick={props.onOpenPanels}>
                Study tools
              </button>
              {readiness && !readiness.ready && (
                <span className="cs-hint">
                  {readiness.problems.length} thing{readiness.problems.length === 1 ? "" : "s"} still to settle
                  before code can be generated
                </span>
              )}
            </div>
          )}
        </div>
      </section>

      {paneOpen && files.length > 0 && (
        /* A fragment, so both stay DIRECT children of the shell grid: the
           Margin is a real 44px track between the panes, not an overlay and not
           a child of either one. */
        <>
        <Margin programCount={files.length} run={run} onStart={startRun} />
        <section className="cs-pane" aria-label="Generated study code">
          <div className="cs-pane-head">
            <h2 className="cs-pane-title">Generated code</h2>
            {(!run || run.phase === "idle" || run.phase === "error") ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={startRun}>
                {run?.phase === "error" ? "Run failed. Try again" : "Run the checks"}
              </button>
            ) : run.phase === "done" ? (
              <span
                className={run.failed > 0 ? "cs-verdict cs-verdict-bad" : "cs-verdict cs-verdict-ok"}
                role="status"
              >
                {run.failed > 0
                  ? `${run.failed} of ${run.total.toLocaleString()} checks failed`
                  : `${run.total.toLocaleString()} checks passed`}
              </span>
            ) : (
              <span className="cs-verdict cs-verdict-live" role="status" aria-live="polite">
                {run.phase === "loading"
                  ? "Downloading Postgres…"
                  : <>Running <span data-num>{run.done.toLocaleString()}</span> checks…</>}
              </span>
            )}
            <button type="button" className="btn btn-sm" onClick={() => void download()}>Download bundle</button>
            <button type="button" className="btn btn-quiet btn-sm" aria-label="Close the code pane"
              onClick={() => setPaneOpen(false)}>&times;</button>
          </div>
          <div className="cs-tabs">
            {(["sas", "postgres", "snowflake"] as Dialect[]).map((d) => (
              <button key={d} type="button" className={d === dialect ? "cs-tab cs-on" : "cs-tab"}
                onClick={() => { setDialect(d); setSelected(""); }}>
                {d === "sas" ? "SAS" : d === "postgres" ? "SQL · Postgres" : "SQL · Snowflake"}
              </button>
            ))}
          </div>
          <div className="cs-pane-body">
            <ul className="cs-files">
              {files.map((f) => (
                <li key={f.path}>
                  <button type="button" className={current?.path === f.path ? "cs-file cs-on" : "cs-file"}
                    onClick={() => setSelected(f.path)}>
                    {f.title}
                    <span className="cs-file-path">{f.path}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="cs-code-wrap">
              <div className="cs-code-head">
                <span className="cs-code-name">{current?.path}</span>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => {
                  if (!current) return;
                  void navigator.clipboard.writeText(current.content).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  });
                }}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <pre className="cs-code">{current?.content}</pre>
            </div>
          </div>
        </section>
        </>
      )}

      {!paneOpen && files.length > 0 && (
        <div className="cs-hint" style={{ padding: "0 var(--space-2)" }}>
          <button type="button" className="btn btn-sm" onClick={() => setPaneOpen(true)}>
            Show the generated code ({files.length} files)
          </button>
        </div>
      )}
    </div>
  );
}
