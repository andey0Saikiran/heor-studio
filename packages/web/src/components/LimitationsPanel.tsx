/**
 * "I cannot represent this."
 *
 * The most important thing this product ever puts on screen. When the protocol
 * asks for something the schema cannot express (a confirmatory outcome, a pooled
 * Optum analysis, an as-treated clock, a lab covariate), the tool refuses to go
 * ready until the analyst has SEEN what it cannot do and explicitly accepted that
 * the generated code does not do it. It sits above the review, because a wrong
 * cohort criterion is a detail and a study answering a different question is not.
 *
 * There is no "acknowledge all". Each limitation is a separate admission that the
 * delivered code omits part of the protocol, and each is accepted on its own.
 */
import { openLimitations, acknowledgeLimitation } from "@heor-studio/core";
import type { StudySpec, UnrepresentedConstruct } from "@heor-studio/core";
import "./limitations.css";

const CATEGORY_LABEL: Record<UnrepresentedConstruct["category"], string> = {
  outcome_algorithm: "Outcome definition",
  database: "Database / pooling",
  censoring: "Follow-up clock",
  covariate: "Covariate",
  exposure: "Exposure",
  other: "Design",
};

export interface LimitationsPanelProps {
  spec: StudySpec;
  onChange: (s: StudySpec) => void;
}

export default function LimitationsPanel({ spec, onChange }: LimitationsPanelProps) {
  const open = openLimitations(spec);
  if (open.length === 0) return null;

  return (
    <section className="lp" aria-label="What this tool cannot express from your protocol">
      <header className="lp-head">
        <h3 className="lp-title">
          {open.length === 1
            ? "One thing in your protocol cannot be expressed"
            : `${open.length} things in your protocol cannot be expressed`}
        </h3>
        <p className="lp-sub">
          The generated code will not do the following. This is not a bug to work around: the tool
          refuses to call a study ready while it is silently leaving part of the protocol out. Read
          each one, then either acknowledge that the code omits it, or change the study so it does
          not need it.
        </p>
      </header>

      <ul className="lp-items">
        {open.map((c) => (
          <li key={c.key} className="lp-item">
            <div className="lp-item-main">
              <div className="lp-cat" data-cat={c.category}>{CATEGORY_LABEL[c.category]}</div>
              <div className="lp-label">{c.label}</div>
              {c.sourceText && (
                <div className="lp-src"><span className="lp-src-lbl">Protocol</span> {c.sourceText}</div>
              )}
              <div className="lp-detail">{c.detail}</div>
              <div className="lp-origin">
                {c.origin === "model" ? "Flagged during extraction." : "Detected in the study text."}
              </div>
            </div>
            <div className="lp-item-act">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onChange(acknowledgeLimitation(spec, c.key))}
              >
                I understand the code omits this
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
