/**
 * Spec chat — natural language in, a PROPOSED spec out.
 *
 * The chat edits the SPEC and never the generated code. Generated SAS and SQL
 * are a pure function of the reviewed spec, so an assistant that hand-edited
 * emitted text would break the parity stamps, the fingerprints and the mutation
 * tests at once. Instead a proposal comes back, a person reads a diff of it, and
 * the emitters re-run from the spec they accepted. CodePanel recomputes from
 * `spec` in a useMemo, so accepting is the whole trigger.
 *
 * Nothing is applied until Accept is pressed. The diff is measured against the
 * spec AS IT STANDS NOW rather than the spec the proposal was built from, so
 * what the analyst reads is exactly what Accept would do, even if they edited a
 * field in the meantime.
 */
import { useId, useMemo, useState } from "react";
import type { ProposedSpecEdit, SpecChange, StudySpec } from "@heor-studio/core";
import {
  changesRequiringRereview,
  diffSpecs,
  listModels,
  proposeSpecEdit,
} from "@heor-studio/core";
import type { AppSettings } from "./SettingsModal";
import "./specchat.css";

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

const KIND_LABEL: Record<SpecChange["kind"], string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

const COST_LABEL: Record<Exclude<SpecChange["invalidates"], "none">, string> = {
  criterion_review: "Costs a criterion review",
  code_verification: "Costs a code verification",
};

/** Diff rows are grouped so a reader can scan by section instead of by path. */
const GROUPS: Array<{ label: string; owns: (path: string) => boolean }> = [
  { label: "Study details", owns: (p) => p.startsWith("meta.") },
  { label: "Index event", owns: (p) => p === "indexEvent" || p.startsWith("indexEvent.") },
  { label: "Enrollment", owns: (p) => p === "enrollment" || p.startsWith("enrollment.") },
  { label: "Cohort criteria", owns: (p) => p.startsWith("criteria.") },
  { label: "Code lists", owns: (p) => p.startsWith("codeLists.") },
  { label: "Analyses", owns: (p) => p.startsWith("analyses.") },
  { label: "Baseline characteristics", owns: (p) => p.startsWith("baseline.") },
];

function groupChanges(changes: SpecChange[]): Array<{ label: string; changes: SpecChange[] }> {
  const out: Array<{ label: string; changes: SpecChange[] }> = [];
  const claimed = new Set<SpecChange>();
  for (const g of GROUPS) {
    const rows = changes.filter((c) => g.owns(c.path));
    rows.forEach((r) => claimed.add(r));
    if (rows.length > 0) out.push({ label: g.label, changes: rows });
  }
  const rest = changes.filter((c) => !claimed.has(c));
  if (rest.length > 0) out.push({ label: "Elsewhere in the spec", changes: rest });
  return out;
}

function ChangeRow({ change }: { change: SpecChange }) {
  const costly = change.invalidates !== "none";
  return (
    <li className={costly ? "sc-change sc-change--costly" : "sc-change"}>
      <div className="sc-change-head">
        <span className={`sc-kind sc-kind--${change.kind}`}>{KIND_LABEL[change.kind]}</span>
        <code className="sc-path">{change.path}</code>
        {costly && (
          <span className="sc-cost">
            {COST_LABEL[change.invalidates as keyof typeof COST_LABEL]}
          </span>
        )}
      </div>
      <p className="sc-summary">{change.summary}</p>
      {(change.before !== undefined || change.after !== undefined) && (
        <div className="sc-ba">
          {change.before !== undefined && (
            <>
              <span className="sc-ba-label">Now</span>
              <span className="sc-ba-val">{change.before}</span>
            </>
          )}
          {change.after !== undefined && (
            <>
              <span className="sc-ba-label">After</span>
              <span className="sc-ba-val">{change.after}</span>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function SpecChat({
  spec,
  settings,
  onChange,
  onOpenSettings,
}: {
  spec: StudySpec;
  settings: AppSettings;
  onChange: (s: StudySpec) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposedSpecEdit | null>(null);
  /** The spec the proposal was built from, so drift can be pointed out. */
  const [proposedFrom, setProposedFrom] = useState<StudySpec | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const uid = useId();
  const inputId = `${uid}-instruction`;
  const proposalTitleId = `${uid}-proposal`;
  const panelId = `${uid}-panel`;

  const models = useMemo(() => {
    try {
      return listModels();
    } catch {
      return [];
    }
  }, []);
  const model = settings.model || models[0]?.id || "";

  const changes = useMemo(
    () => (proposal ? diffSpecs(spec, proposal.spec) : []),
    [proposal, spec],
  );
  const costly = useMemo(() => changesRequiringRereview(changes), [changes]);
  const groups = useMemo(() => groupChanges(changes), [changes]);
  const drifted = proposal !== null && proposedFrom !== null && proposedFrom !== spec;
  /* While a proposal is open its notes are shown in the proposal box, so the
   * matching transcript turn is held back rather than printed twice. It joins
   * the transcript once the proposal is accepted or discarded. */
  const visibleTurns = proposal ? turns.slice(0, -1) : turns;

  const send = async () => {
    const instruction = input.trim();
    if (!instruction || busy) return;
    setError(null);
    setApplied(null);
    setPending(instruction);
    setInput("");
    setBusy(true);
    try {
      const result = await proposeSpecEdit({
        apiKey: settings.apiKey,
        model,
        spec,
        instruction,
        history: turns,
        onStatus: (m) => setStatus(m),
      });
      setTurns((t) => [
        ...t,
        { role: "user", text: instruction },
        { role: "assistant", text: result.notes },
      ]);
      setProposal(result);
      setProposedFrom(spec);
    } catch (e) {
      // The messages from core are written for a person to act on; do not
      // paraphrase them. Put the instruction back so it can be edited and resent.
      setInput(instruction);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      setBusy(false);
      setStatus(null);
    }
  };

  const accept = () => {
    if (!proposal) return;
    const n = changes.length;
    onChange(proposal.spec);
    setProposal(null);
    setProposedFrom(null);
    setApplied(
      `Applied ${n} ${n === 1 ? "change" : "changes"} to the spec. The generated code has been rebuilt from it.`,
    );
  };

  const discard = () => {
    setProposal(null);
    setProposedFrom(null);
    setApplied("Proposal discarded. The spec is unchanged.");
  };

  return (
    <section className="sc" aria-labelledby={`${uid}-title`}>
      <div className="sc-head">
        <button
          type="button"
          className="sc-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          <span className="sc-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <h2 className="sc-title" id={`${uid}-title`}>
            Edit this spec by asking
          </h2>
          <span className="sc-head-note">
            {open ? "" : "Describe a change in plain words and review it as a diff"}
          </span>
        </button>
        {proposal && !open && <span className="sc-pill">Proposal waiting for review</span>}
      </div>

      {open && (
        <div className="sc-body" id={panelId}>
          <p className="sc-sub">
            Ask for a change and you get a proposed spec back, never a rewrite of the generated
            code. SAS and SQL are built from the spec, so nothing changes until you accept the
            diff below and the emitters run again on their own.
          </p>

          {!settings.apiKey ? (
            <div className="sc-gate">
              <p className="sc-sub">
                This needs your own API key, the same one extraction uses. It is sent from this
                browser to the endpoint you configured, and nowhere else.
              </p>
              <button type="button" className="sc-btn" onClick={onOpenSettings}>
                Set API key in Settings
              </button>
            </div>
          ) : (
            <>
              {visibleTurns.length > 0 || pending ? (
                <ol className="sc-log">
                  {visibleTurns.map((t, i) => (
                    // The transcript is append-only, so the index is a stable key.
                    <li key={i} className={`sc-turn sc-turn--${t.role}`}>
                      <span className="sc-who">{t.role === "user" ? "You" : "Proposal"}</span>
                      {t.text}
                    </li>
                  ))}
                  {pending && (
                    <li className="sc-turn sc-turn--user sc-turn--pending">
                      <span className="sc-who">You</span>
                      {pending}
                    </li>
                  )}
                </ol>
              ) : (
                <p className="sc-hint">
                  Nothing asked yet. Try something like &ldquo;require two psoriasis diagnoses at
                  least 30 days apart&rdquo; or &ldquo;drop the age floor to 16&rdquo;.
                </p>
              )}

              {proposal && (
                <div className="sc-proposal" role="region" aria-labelledby={proposalTitleId}>
                  <h3 className="sc-proposal-title" id={proposalTitleId}>
                    Proposed spec, not applied
                  </h3>

                  {proposal.notes && <p className="sc-notes">{proposal.notes}</p>}

                  {drifted && (
                    <p className="sc-hint">
                      You edited the spec after this proposal was made. The changes below are
                      measured against the spec as it stands now, so they show exactly what
                      accepting would do.
                    </p>
                  )}

                  {changes.length === 0 ? (
                    <div className="sc-block sc-block--empty">
                      <p className="sc-block-title">This proposal changes nothing.</p>
                      <p>
                        The spec it returned is identical to the one you have. There is nothing to
                        accept. Rephrase the request or say which part of the spec you mean.
                      </p>
                    </div>
                  ) : (
                    <>
                      {costly.length > 0 && (
                        <div className="sc-block sc-block--cost">
                          <p className="sc-block-title">
                            Accepting this costs you {costly.length}{" "}
                            {costly.length === 1 ? "review you already gave" : "reviews you already gave"}
                          </p>
                          <p>
                            These items return to unreviewed or unverified, and code generation
                            stays locked until you read them again.
                          </p>
                          <ul className="sc-block-list">
                            {costly.map((c) => (
                              <li key={`${c.path}-${c.kind}`}>
                                <code>{c.path}</code> {c.summary}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="sc-groups">
                        {groups.map((g) => (
                          <div key={g.label}>
                            <h4 className="sc-group-title">
                              {g.label} ({g.changes.length})
                            </h4>
                            <ul className="sc-changes">
                              {g.changes.map((c) => (
                                <ChangeRow key={`${c.path}-${c.kind}`} change={c} />
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {proposal.forged.length > 0 && (
                    <div className="sc-block sc-block--forged">
                      <p className="sc-block-title">
                        The model set review flags itself, and they were stripped
                      </p>
                      <p>
                        Only a person can mark a criterion reviewed or a code verified, so these
                        were reset before you saw this proposal. Nothing is broken. It is listed
                        because you should know what a tool editing your study tried to do.
                      </p>
                      <ul className="sc-block-list">
                        {proposal.forged.map((f) => (
                          <li key={f}>
                            <code>{f}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {proposal.invalidated.length > 0 && (
                    <div className="sc-block sc-block--forged">
                      <p className="sc-block-title">Review state reset because its subject changed</p>
                      <ul className="sc-block-list">
                        {proposal.invalidated.map((f) => (
                          <li key={f}>
                            <code>{f}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="sc-actions">
                    {changes.length > 0 && (
                      <button type="button" className="sc-btn" onClick={accept}>
                        Accept {changes.length} {changes.length === 1 ? "change" : "changes"}
                      </button>
                    )}
                    <button type="button" className="sc-btn sc-btn--ghost" onClick={discard}>
                      Discard
                    </button>
                  </div>
                </div>
              )}

              <div className="sc-composer">
                <label className="sc-label" htmlFor={inputId}>
                  What should change
                </label>
                <textarea
                  id={inputId}
                  className="sc-textarea"
                  rows={3}
                  value={input}
                  disabled={busy}
                  placeholder="Add an exclusion for prior biologic use in the 12 months before index."
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="sc-composer-row">
                  <button
                    type="button"
                    className="sc-btn"
                    disabled={busy || !input.trim()}
                    onClick={() => void send()}
                  >
                    {busy ? "Asking…" : "Propose a change"}
                  </button>
                  {turns.length > 0 && (
                    <button
                      type="button"
                      className="sc-btn sc-btn--ghost"
                      disabled={busy}
                      onClick={() => {
                        setTurns([]);
                        setProposal(null);
                        setProposedFrom(null);
                        setError(null);
                        setApplied("Conversation cleared. The spec is unchanged.");
                      }}
                    >
                      Clear conversation
                    </button>
                  )}
                  <span className="sc-hint">
                    {model ? `Using ${model}.` : "No model set in Settings."} Cmd or Ctrl plus
                    Enter sends. History is kept for this session only.
                  </span>
                </div>
              </div>

              <p className="sc-status" role="status" aria-live="polite">
                {status ?? applied ?? ""}
              </p>

              {error && (
                <p className="sc-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
