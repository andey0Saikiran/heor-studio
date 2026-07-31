/**
 * The corrections you have recorded. Without a place to read and delete them,
 * capture would be a write-only hole. Everything here is local; the download
 * buttons are the only way anything leaves the browser, and you press them.
 */
import { useEffect, useState } from "react";
import type { Correction } from "@heor-studio/core";
import {
  CORRECTION_CLASS_LABELS,
  CORRECTION_KIND_LABELS,
  downloadAllCorrectionsJson,
  downloadAllCorrectionsMarkdown,
  downloadCorrectionJson,
  downloadCorrectionMarkdown,
} from "../lib/corrections";

export default function CorrectionsInbox({
  corrections,
  onDelete,
  onClose,
}: {
  corrections: Correction[];
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const announce = (msg: string) => setStatus(msg);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="inbox-title" className="modal modal-wide">
        <h2 className="modal-title" id="inbox-title">
          Corrections you recorded
        </h2>
        <p className="card-sub">
          Kept in this browser only. Nothing has been sent. To have one fixed for everyone, download
          the record and send it upstream yourself: it becomes a regression test, a spec option, or a
          doc change.
        </p>

        {corrections.length === 0 ? (
          <p className="field-hint">
            Nothing flagged yet. Use Flag next to a generated program, a criterion, an analysis, or a
            code when it does not match your protocol.
          </p>
        ) : (
          <>
            <div className="corr-toolbar">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  downloadAllCorrectionsJson(corrections);
                  announce(`Downloaded ${corrections.length} corrections as JSON.`);
                }}
              >
                Download all as JSON
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  downloadAllCorrectionsMarkdown(corrections);
                  announce(`Downloaded ${corrections.length} corrections as Markdown.`);
                }}
              >
                Download all as Markdown
              </button>
            </div>

            <ul className="corr-list">
              {corrections.map((c) => (
                <li key={c.id} className="corr-item">
                  <div className="corr-head">
                    <span className="badge badge-neutral">
                      {CORRECTION_KIND_LABELS[c.target.kind]}
                    </span>
                    <code className="corr-ref">{c.target.ref}</code>
                    <span className="corr-when">{new Date(c.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="corr-claim">{c.claim}</p>
                  <p className="corr-reason">
                    <span className="summary-label">Why</span>
                    {c.reason}
                  </p>
                  {c.suggestedCorrect && (
                    <p className="corr-reason">
                      <span className="summary-label">Should be</span>
                      {c.suggestedCorrect}
                    </p>
                  )}
                  <p className="corr-meta">
                    {CORRECTION_CLASS_LABELS[c.classification]} · status {c.status} ·{" "}
                    <code>{c.id}</code>
                    {c.target.artifactPath ? ` · ${c.target.artifactPath}` : ""}
                    {c.target.specVersion ? ` · spec v${c.target.specVersion}` : ""}
                  </p>
                  <div className="corr-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        downloadCorrectionJson(c);
                        announce(`Downloaded ${c.id} as JSON.`);
                      }}
                    >
                      Download JSON
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        downloadCorrectionMarkdown(c);
                        announce(`Downloaded ${c.id} as Markdown.`);
                      }}
                    >
                      Download Markdown
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-quiet"
                      aria-label={`Delete correction ${c.id}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete this correction about "${c.target.ref}"? It is only stored here, so it cannot be recovered.`,
                          )
                        ) {
                          onDelete(c.id);
                          announce("Correction deleted.");
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="status-line" role="status" aria-live="polite">
          {status}
        </p>

        <div className="modal-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
