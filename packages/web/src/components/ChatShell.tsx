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
 * every criterion is reviewed and every code verified. As a form that is a wall
 * of checkboxes, and a wall of checkboxes gets cleared without being read. Here
 * it is one question at a time, riskiest first, each carrying the verbatim
 * protocol sentence beside the rule it produced so the analyst is comparing two
 * things rather than recalling one. The ordering and the evidence come from
 * core (spec/review-queue.ts) and are guarded there.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ProposedSpecEdit, ReviewItem, SpecChange, StudySpec, GeneratedFile, EmitOptions,
} from "@heor-studio/core";
import {
  changesRequiringRereview, confirmItem, diffSpecs, emitSas, emitSql, extractSpec,
  listModels, planBundle, proposeSpecEdit, reviewProgress, reviewQueue, specReadiness,
  bundleFilename,
} from "@heor-studio/core";
import type { AppSettings } from "./SettingsModal";
import { buildZip, downloadBlob } from "../lib/exportZip";
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
        ? `Everything here is already signed off, so the code is ready whenever you are.`
        : `None of it is signed off yet, and I will not generate code until it is. ` +
          `There ${p.remaining === 1 ? "is 1 thing" : `are ${p.remaining} things`} to confirm, and I will go ` +
          `through them one at a time, starting with the ones most likely to be wrong.`)
    );
  };

  /* Keep the newest turn in view, the way a terminal does. */
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);


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

  /** Ask the next outstanding question, or announce the gate is clear. */
  const askNext = useCallback((s: StudySpec) => {
    const q = reviewQueue(s);
    if (q.length === 0) {
      const r = specReadiness(s);
      if (r.ready) {
        say(
          "That is everything signed off. The study code is ready, and I have opened it on the right.\n\n" +
          "You can still ask for changes: anything you accept re-runs the emitters, and anything you touch goes back to needing a look.",
        );
        setPaneOpen(true);
      } else {
        say(
          "Every criterion and code is signed off, but the spec is not ready yet:\n\n" +
          r.problems.map((p) => `  - ${p}`).join("\n") +
          "\n\nTell me what to change and I will propose it.",
        );
      }
      return;
    }
    setMsgs((m) => [...m, { id: nextId(), role: "assistant", kind: "review", item: q[0] }]);
  }, [say]);

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
    askNext(spec);
    /* `spec` alone on purpose. This must fire ONCE when a study first arrives,
     * and the ref is what enforces that; adding askNext (which changes identity
     * whenever `say` does) would re-run it and re-greet mid-review. */
  }, [spec, askNext]);

  const answer = (msgId: string, item: ReviewItem, ok: boolean) => {
    if (!spec) return;
    const next = confirmItem(spec, item.id, item.kind, ok);
    onChange(next);
    setMsgs((m) => m.map((x) => (x.id === msgId && x.kind === "review" ? { ...x, answer: ok ? "yes" : "no" } : x)));
    if (ok) {
      askNext(next);
    } else {
      say(
        `Noted, and I have left it unconfirmed so it stays on the list. Tell me what it should say instead and I will propose the change.`,
      );
    }
  };

  /* ---------------- extraction ---------------- */

  const acceptFile = async (file?: File | null) => {
    if (!file) return;
    setError("");
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
      askNext(s);
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
    setBusy("Working out what that changes…");
    try {
      const history = msgs
        .filter((m): m is Extract<Msg, { kind: "text" }> => m.kind === "text")
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text }));
      const proposal = await proposeSpecEdit({
        apiKey: settings.apiKey, model, spec, instruction, history, onStatus: setBusy,
      });
      setMsgs((m) => [...m, { id: nextId(), role: "assistant", kind: "proposal", proposal }]);
    } catch (e) {
      setError((e as Error).message);
      setDraft(instruction);
    } finally {
      setBusy("");
    }
  };

  const acceptProposal = (msgId: string, p: ProposedSpecEdit) => {
    onChange(p.spec);
    setMsgs((m) => m.map((x) => (x.id === msgId && x.kind === "proposal" ? { ...x, settled: "accepted" } : x)));
    askNext(p.spec);
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
      <label
        className={dragging ? "cs-drop cs-drag" : "cs-drop"}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void acceptFile(e.dataTransfer.files[0]); }}
      >
        <input type="file" accept="application/pdf,.pdf" className="sr-only"
          onChange={(e) => { void acceptFile(e.target.files?.[0]); e.target.value = ""; }} />
        <span className="cs-drop-primary">Drop your protocol or SAP here</span>
        <span className="cs-drop-sub">
          Read in this browser and sent only to the endpoint you configured, with your key. It goes nowhere else.
        </span>
      </label>
      <div className="cs-or">or</div>
      <div className="field-row">
        <button type="button" className="btn" onClick={props.onLoadDemo}>Load a demo study</button>
        <button type="button" className="btn btn-quiet" onClick={props.onStartBlank}>Start from blank</button>
      </div>
      {!hasKey && (
        <p className="cs-hint">
          Reading a document needs your own API key.{" "}
          <button type="button" className="btn btn-quiet btn-sm" onClick={onOpenSettings}>Add one in Settings</button>
        </p>
      )}
    </div>
  );

  return (
    <div className={paneOpen && files.length > 0 ? "cs-shell cs-split" : "cs-shell"}>
      <section className="cs-chat" aria-label="Conversation">
        <div className="cs-log" ref={logRef}>
          {landing}

          {msgs.map((m) => {
            if (m.kind === "text") {
              return (
                <div key={m.id} className={m.role === "user" ? "cs-msg cs-msg-user" : "cs-msg cs-msg-assistant"}>
                  <span className="cs-who">{m.role === "user" ? "You" : "HEOR Studio"}</span>
                  <div className="cs-bubble">{m.text}</div>
                </div>
              );
            }
            if (m.kind === "review") {
              return (
                <div key={m.id} className="cs-msg cs-msg-assistant">
                  <span className="cs-who">HEOR Studio</span>
                  <div className="cs-review">
                    <div className="cs-review-body">
                      <strong>{m.item.question}</strong>
                      {m.item.concern && <div className="cs-concern">{m.item.concern}</div>}
                      <div className="cs-review-row">
                        <span className="cs-review-label">
                          {m.item.kind === "criterion" ? "Your protocol said" : "The code"}
                        </span>
                        <span className="cs-review-said">{m.item.evidence}</span>
                      </div>
                      <div className="cs-review-row">
                        <span className="cs-review-label">What the generated code will do</span>
                        <span className="cs-review-derived">{m.item.derived}</span>
                      </div>
                    </div>
                    <div className="cs-review-foot">
                      {m.answer === undefined ? (
                        <>
                          <button type="button" className="btn btn-primary btn-sm"
                            onClick={() => answer(m.id, m.item, true)}>Yes, that is right</button>
                          <button type="button" className="btn btn-sm"
                            onClick={() => answer(m.id, m.item, false)}>No, that is wrong</button>
                        </>
                      ) : (
                        <span className="cs-answered">
                          {m.answer === "yes" ? "Confirmed by you" : "You said this is wrong, so it stays on the list"}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            }
            /* proposal */
            const changes: SpecChange[] = spec ? diffSpecs(spec, m.proposal.spec) : [];
            const costly = changesRequiringRereview(changes);
            return (
              <div key={m.id} className="cs-msg cs-msg-assistant">
                <span className="cs-who">HEOR Studio</span>
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

          {busy && <div className="status-line" role="status" aria-live="polite">{busy}</div>}
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
              {queue.length > 0 && msgs.every((m) => m.kind !== "review" || m.answer !== undefined) && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => spec && askNext(spec)}>
                  Next question
                </button>
              )}
            </div>
          )}
          <div className="cs-input-row">
            <label className="sr-only" htmlFor={`${uid}-ask`}>Ask for a change</label>
            <textarea
              id={`${uid}-ask`}
              className="cs-input"
              placeholder={spec ? "Ask for a change, in plain words" : "Upload a protocol to begin"}
              value={draft}
              disabled={!spec || Boolean(busy)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
              }}
            />
            <button type="button" className="btn btn-primary" disabled={!spec || !draft.trim() || Boolean(busy)}
              onClick={() => void send()}>Send</button>
          </div>
          <span className="cs-hint">
            Changes are made to the study specification, never to the generated code. Nothing changes until you
            apply a proposal, and then the code is rebuilt from it.
          </span>
        </div>
      </section>

      {paneOpen && files.length > 0 && (
        <section className="cs-pane" aria-label="Generated study code">
          <div className="cs-pane-head">
            <h2 className="cs-pane-title">Generated code</h2>
            <button type="button" className="btn btn-sm" onClick={() => void download()}>Download bundle</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={props.onOpenPanels}>Open full editor</button>
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
