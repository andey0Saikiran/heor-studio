/**
 * The review, grouped by how much scrutiny each item actually needs.
 *
 * Core (review-queue.ts) already computes a real 5-band risk model with a
 * per-item `concern`. The first version of this panel threw almost all of it
 * away: it split only "unmapped" from "everything else", collapsed exclusions
 * and low-confidence criteria into a "routine" bucket that hid the protocol
 * evidence, and rendered one "Confirm all" on the model-suggested codes so a
 * single click could sign off forty codes the tool itself says to check one by
 * one. That is the rubber stamp this product exists to refuse, and the exported
 * bundle attests it as human oversight.
 *
 * This version uses the risk band:
 *   - UNMAPPED criteria: the extractor could not build a rule. There is nothing
 *     to confirm, so there is no Confirm button; the only move is to fix it in
 *     chat. Confirming it would clear the panel while readiness stays blocked.
 *   - AI-SUGGESTED codes and EXCLUSION criteria: shown open with the protocol
 *     sentence and the concern, confirmed ONE AT A TIME. No bulk confirm: a
 *     wrong exclusion or an invented code changes who is in the study.
 *   - LOW / MEDIUM confidence criteria: shown open with evidence, bulk confirm
 *     allowed once read.
 *   - HIGH confidence criteria and codes read straight from the protocol:
 *     collapsed to a count with one bulk confirm.
 *
 * Nothing is auto-confirmed anywhere. The point is to make the few decisions
 * that matter legible, not to make signing off effortless.
 */
import { useMemo, useState } from "react";
import type { StudySpec } from "@heor-studio/core";
import { reviewQueue, confirmItem } from "@heor-studio/core";
import type { ReviewItem } from "@heor-studio/core";
import type { FlagRequest } from "../lib/corrections";
import "./reviewpanel.css";

/* Risk bands mirror core/spec/review-queue.ts. Stable boundary values. */
const RISK_UNMAPPED = 0;
const RISK_MED_CONF = 20;
const RISK_EXCLUSION = 30;
const RISK_CODE_AI = 50;

interface Section {
  key: string;
  title: string;
  /** show the verbatim protocol sentence and the concern */
  evidence: boolean;
  /** offer a single "Confirm all" for the group */
  bulk: boolean;
  /** unmapped items cannot be confirmed, only fixed */
  fixOnly?: boolean;
  note?: string;
  items: ReviewItem[];
}

function group(items: ReviewItem[]): Section[] {
  const unmapped: ReviewItem[] = [];
  const exclusions: ReviewItem[] = [];
  const softCriteria: ReviewItem[] = [];   // low / medium confidence
  const routineCriteria: ReviewItem[] = []; // high confidence
  const aiCodes: ReviewItem[] = [];
  const routineCodes: ReviewItem[] = [];
  for (const it of items) {
    if (it.kind === "criterion") {
      if (it.risk <= RISK_UNMAPPED) unmapped.push(it);
      else if (it.risk <= RISK_MED_CONF) softCriteria.push(it);
      else if (it.risk === RISK_EXCLUSION) exclusions.push(it);
      else routineCriteria.push(it);
    } else {
      if (it.risk <= RISK_CODE_AI) aiCodes.push(it);
      else routineCodes.push(it);
    }
  }
  const out: Section[] = [];
  if (unmapped.length)
    out.push({
      key: "unmapped", title: "Criteria the extractor could not turn into a rule", evidence: true, bulk: false, fixOnly: true,
      note: "Each of these generates no code, so the cohort is larger than your protocol describes. Say what the rule should be in the chat.",
      items: unmapped,
    });
  if (exclusions.length)
    out.push({
      key: "exclusions", title: "Exclusions", evidence: true, bulk: false,
      note: "A wrong exclusion changes who is in the study. Confirm each against the protocol sentence beside it.",
      items: exclusions,
    });
  if (aiCodes.length)
    out.push({
      key: "ai", title: "Codes the model suggested", evidence: true, bulk: false,
      note: "These were proposed by the model, not read from your protocol. Check each against a vocabulary before confirming it.",
      items: aiCodes,
    });
  if (softCriteria.length)
    out.push({
      key: "soft", title: "Criteria the extractor was less sure about", evidence: true, bulk: true,
      items: softCriteria,
    });
  if (routineCriteria.length)
    out.push({ key: "criteria", title: "Criteria read from the protocol", evidence: false, bulk: true, items: routineCriteria });
  if (routineCodes.length)
    out.push({ key: "codes", title: "Codes read from the protocol", evidence: false, bulk: true, items: routineCodes });
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

  /* The headline counts what needs a DECISION (the sections with no bulk
   * confirm), not the raw total, so a real protocol reads as "a few to look at"
   * rather than "seventy to clear". */
  const decisions = sections.filter((s) => !s.bulk).reduce((n, s) => n + s.items.length, 0);
  const routine = queue.length - decisions;
  const headline =
    decisions === 0
      ? `Read and confirm ${routine === 1 ? "the one item" : `these ${routine} items`}, then the code is ready.`
      : `${decisions} ${decisions === 1 ? "item needs" : "items need"} a decision. The other ${routine} were read straight from your protocol.`;

  return (
    <section className="rp" aria-label="Review before code generation">
      <header className="rp-head">
        <h3 className="rp-title">{headline}</h3>
        <p className="rp-sub">
          Every item needs your sign-off before code is generated, because that sign-off is what the
          bundle reports as human oversight. The groups without a bulk button are the ones to read.
        </p>
      </header>

      {sections.map((s) => {
        const isOpen = open[s.key] ?? (s.evidence);
        return (
          <div key={s.key} className={s.bulk ? "rp-sec" : "rp-sec rp-sec-attn"}>
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
              {s.bulk && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => confirmMany(s.items)}>
                  Confirm all {s.items.length}
                </button>
              )}
            </div>

            {s.note && isOpen && <p className="rp-note">{s.note}</p>}

            {isOpen && (
              <ul className="rp-items">
                {s.items.map((it) => (
                  <li key={it.id} className="rp-item">
                    <div className="rp-item-body">
                      {s.evidence ? (
                        <>
                          {it.concern && <div className="rp-concern">{it.concern}</div>}
                          <div className="rp-evi"><span className="rp-lbl">Protocol</span> {it.evidence}</div>
                          <div className="rp-der"><span className="rp-lbl">Code will</span> {it.derived}</div>
                        </>
                      ) : (
                        <div className="rp-der-1">{it.derived}</div>
                      )}
                    </div>
                    <div className="rp-item-acts">
                      {s.fixOnly ? (
                        <button type="button" className="btn btn-sm" onClick={() => flag(it)}>Fix in chat</button>
                      ) : (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => confirmOne(it)}>Confirm</button>
                          <button type="button" className="btn btn-quiet btn-sm" onClick={() => flag(it)}>Wrong</button>
                        </>
                      )}
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
