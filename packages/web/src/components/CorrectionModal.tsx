/**
 * "This looks wrong" capture. The record is built by core (newCorrection),
 * which refuses to build one without a reason; that refusal is shown to the
 * analyst rather than pre-empted, so the rule stays in one place.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Correction, CorrectionClass } from "@heor-studio/core";
import { newCorrection } from "@heor-studio/core";
import {
  CORRECTION_CLASS_LABELS,
  CORRECTION_KIND_LABELS,
  type FlagRequest,
} from "../lib/corrections";

/** The affordance itself. Kept in one place so its wording stays consistent. */
export function FlagButton({
  what,
  onClick,
  className = "btn btn-sm",
  children = "Flag",
}: {
  /** What is being flagged, for the accessible name, e.g. "criterion inc_1". */
  what: string;
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={`Flag ${what} as wrong`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const CLASS_OPTIONS = Object.keys(CORRECTION_CLASS_LABELS) as CorrectionClass[];

export default function CorrectionModal({
  request,
  onRecord,
  onClose,
}: {
  request: FlagRequest;
  onRecord: (c: Correction) => void;
  onClose: () => void;
}) {
  const [claim, setClaim] = useState("");
  const [reason, setReason] = useState("");
  const [suggested, setSuggested] = useState("");
  const [classification, setClassification] = useState<CorrectionClass>(
    request.classification ?? "unclassified",
  );
  const [error, setError] = useState<string | null>(null);

  const claimRef = useRef<HTMLTextAreaElement>(null);
  const uid = useId();
  const claimId = `${uid}-claim`;
  const reasonId = `${uid}-reason`;
  const suggestId = `${uid}-suggest`;
  const classId = `${uid}-class`;

  useEffect(() => {
    claimRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const record = () => {
    setError(null);
    try {
      onRecord(
        newCorrection({
          createdAt: new Date().toISOString(),
          target: request.target,
          claim,
          reason,
          suggestedCorrect: suggested,
          classification,
        }),
      );
    } catch (e) {
      // core enforces the reason; surface its wording instead of restating it.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="correction-title"
        className="modal modal-correction"
      >
        <h2 className="modal-title" id="correction-title">
          This looks wrong
        </h2>
        <p className="card-sub">
          Recorded on this device only. Nothing is sent anywhere, and nothing here changes the
          generated code by itself. The stance is not that you are wrong: it is that we need to know
          why, so a person can turn this into a regression test, a spec option, or a clearer label.
        </p>

        <div className="flag-target">
          <p className="flag-target-kind">{CORRECTION_KIND_LABELS[request.target.kind]}</p>
          <p className="flag-target-label">{request.label}</p>
          <p className="flag-target-ref">
            <code>{request.target.ref}</code>
          </p>
          {request.context?.map((line, i) => (
            // Static list for the life of the dialog, so the index is a stable key.
            <p key={i} className="flag-target-note">
              {line}
            </p>
          ))}
          {(request.target.artifactPath || request.target.specVersion) && (
            <p className="flag-target-note">
              {request.target.artifactPath ? `In the bundle at ${request.target.artifactPath}` : ""}
              {request.target.artifactPath && request.target.specVersion ? " · " : ""}
              {request.target.specVersion ? `Spec v${request.target.specVersion}` : ""}
            </p>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={claimId}>
            What looks wrong
          </label>
          <textarea
            id={claimId}
            ref={claimRef}
            className="control control-wide"
            rows={2}
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            placeholder="Name the specific thing you are contesting."
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor={reasonId}>
            Why you believe that
          </label>
          <textarea
            id={reasonId}
            className="control control-wide"
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={request.reasonHint ?? "Cite the protocol, the guideline, or what you saw."}
          />
          <span className="field-hint">
            Required. A correction with no reason cannot be routed to a fix, an option, or a
            clarification, so the tool always asks.
          </span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor={suggestId}>
            What it should be (optional)
          </label>
          <textarea
            id={suggestId}
            className="control control-wide"
            rows={2}
            value={suggested}
            onChange={(e) => setSuggested(e.target.value)}
            placeholder="Leave blank if you are not sure yet."
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor={classId}>
            What kind of disagreement is this
          </label>
          <select
            id={classId}
            className="control control-wide"
            value={classification}
            onChange={(e) => setClassification(e.target.value as CorrectionClass)}
          >
            {CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {CORRECTION_CLASS_LABELS[c]}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Your read on it, not a verdict. It only tells triage where to start.
          </span>
        </div>

        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}

        <div className="modal-foot">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={record}>
            Record correction
          </button>
        </div>
      </div>
    </div>
  );
}
