/**
 * The review, as SECTIONS instead of a queue of 71 identical questions.
 *
 * The old flow served one review item at a time as a chat message, riskiest
 * first. On a real protocol that is seventy-odd yes/no cards, and rejecting one
 * re-served the SAME card forever, because core keeps a rejected item in the
 * queue on purpose (an item known to be wrong should reappear). Defensible
 * logic, unusable as a linear interrogation.
 *
 * Here the outstanding items are grouped. The two groups that actually need a
 * human, unmapped criteria and AI-suggested codes, are shown open with their
 * evidence. The routine groups, mapped criteria and codes that came straight
 * from the protocol, collapse to a count and a single "Confirm all" so the
 * analyst clears them in one click instead of seventy.
 *
 * This does NOT lower the bar. Nothing is auto-confirmed; the analyst still
 * presses the button. It stops making them press it seventy times to say the
 * same thing.
 */
import { useMemo, useState } from "react";
import type { StudySpec } from "@heor-studio/core";
import { reviewQueue, confirmItem } from "@heor-studio/core";
import type { ReviewItem } from "@heor-studio/core";
import type { FlagRequest } from "../lib/corrections";
import "./reviewpanel.css";

/* Risk bands from core (review-queue.ts). Kept in sync by intent, not import,
 * because core does not export them; the boundary values are stable. */
const RISK_UNMAPPED = 0;
const RISK_CODE_AI = 50;

interface Section {
  key: string;
  title: string;
  /** true = show items open with evidence; false = collapse to a count */
  attention: boolean;
  note?: string;
  items: ReviewItem[];
}

function group(items: ReviewItem[]): Section[] {
  const unmapped: ReviewItem[] = [];
  const criteria: ReviewItem[] = [];
  const aiCodes: ReviewItem[] = [];
  const codes: ReviewItem[] = [];
  for (const it of items) {
    if (it.kind === "criterion") (it.risk <= RISK_UNMAPPED ? unmapped : criteria).push(it);
    else (it.risk <= RISK_CODE_AI ? aiCodes : codes).push(it);
  }
  const out: Section[] = [];
  if (unmapped.length)
    out.push({
      key: "unmapped", title: "Criteria the extractor could not map", attention: true,
      note: "Each of these does nothing until you fix it, so the cohort is larger than the protocol describes. Say what the rule should be in the chat, or confirm you are dropping it on purpose.",
      items: unmapped,
    });
  if (aiCodes.length)
    out.push({
      key: "ai", title: "Codes the model suggested", attention: true,
      note: "These were proposed by the model, not read from your protocol. Check each against a vocabulary before you confirm it.",
      items: aiCodes,
    });
  if (criteria.length)
    out.push({ key: "criteria", title: "Cohort criteria read from the protocol", attention: false, items: criteria });
  if (codes.length)
    out.push({ key: "codes", title: "Codes read from the protocol", attention: false, items: codes });
  return out;
}

export interface ReviewPanelProps {
  spec: StudySpec;
  onChange: (s: StudySpec) => void;
  onFlag: (r: FlagRequest) => void;
}

export default function ReviewPanel({ spec, onChange, onFlag }: ReviewPanelProps) {
  const queue = useMemo(() => reviewQueue(spec), [spec]);
  const sections = useMemo(() => group(queue), [queue]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (queue.length === 0) return null;

  const confirmMany = (items: ReviewItem[]) => {
    let next = spec;
    for (const it of items) next = confirmItem(next, it.id, it.kind, true);
    onChange(next);
  };
  const confirmOne = (it: ReviewItem) => onChange(confirmItem(spec, it.id, it.kind, true));
  const flag = (it: ReviewItem) =>
    onFlag({
      label: it.question,
      context: [`Protocol: ${it.evidence}`, `Generated code: ${it.derived}`],
      target: { kind: it.kind === "criterion" ? "spec_field" : "code_list", ref: it.id, specVersion: spec.meta.version },
      reasonHint: "What should this say instead?",
    });

  const attention = sections.filter((s) => s.attention).reduce((n, s) => n + s.items.length, 0);
  const routine = queue.length - attention;
  const headline =
    attention === 0
      ? `Nothing needs a decision. Confirm ${routine === 1 ? "the one item" : `all ${routine} items`} and the code is ready.`
      : `${attention} ${attention === 1 ? "thing needs" : "things need"} a closer look. The other ${routine} were read straight from your protocol.`;

  return (
    <section className="rp" aria-label="Review before code generation">
      <header className="rp-head">
        <h3 className="rp-title">{headline}</h3>
        <p className="rp-sub">
          Every item needs your sign-off before code is generated, because that sign-off is what the
          bundle reports as human oversight. Confirm the routine groups in one click; the ones at the
          top are the actual questions.
        </p>
      </header>

      {sections.map((s) => {
        const isOpen = open[s.key] ?? s.attention;
        return (
          <div key={s.key} className={s.attention ? "rp-sec rp-sec-attn" : "rp-sec"}>
            <div className="rp-sec-head">
              <button
                type="button"
                className="rp-sec-toggle"
                aria-expanded={isOpen}
                onClick={() => setOpen((o) => ({ ...o, [s.key]: !isOpen }))}
              >
                <span className="rp-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                <span className="rp-sec-title">{s.title}</span>
                <span className="rp-count" data-num>{s.items.length}</span>
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => confirmMany(s.items)}>
                Confirm all {s.items.length}
              </button>
            </div>

            {s.note && isOpen && <p className="rp-note">{s.note}</p>}

            {isOpen && (
              <ul className="rp-items">
                {s.items.map((it) => (
                  <li key={it.id} className="rp-item">
                    <div className="rp-item-body">
                      {s.attention ? (
                        <>
                          <div className="rp-evi"><span className="rp-lbl">Protocol</span> {it.evidence}</div>
                          <div className="rp-der"><span className="rp-lbl">Code will</span> {it.derived}</div>
                        </>
                      ) : (
                        <div className="rp-der-1">{it.derived}</div>
                      )}
                    </div>
                    <div className="rp-item-acts">
                      <button type="button" className="btn btn-sm" onClick={() => confirmOne(it)}>Confirm</button>
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => flag(it)}>Wrong</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
