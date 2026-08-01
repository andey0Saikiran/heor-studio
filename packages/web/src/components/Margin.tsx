/**
 * THE MARGIN.
 *
 * A 44px ruled column between the conversation and the generated code, carrying
 * one mark per verification check. It is the signature element of this product
 * and it could not be lifted onto another one: its cells are checks that exist
 * only because this tool executes its own generated SQL against hand-derived
 * ground truth, and its fill rate is a real in-browser Postgres run.
 *
 * THE POINT IS THE EMPTY STATE. An artifact that has not been verified renders
 * as a column of HOLLOW marks, and that absence is legible from across a room.
 * Every other code generator asks to be trusted; this one shows you, before you
 * ask, exactly how much of what you are looking at has been proven. A green
 * badge is unfalsifiable and therefore worthless. 1,572 boxes that are visibly
 * empty until someone runs the engine is a claim you can check.
 *
 * NO GREEN. A struck mark is achromatic (--mark). 1,572 green ticks encode zero
 * information per pixel and read as decoration, which is precisely what makes a
 * verification screen look fake. Passes encode DENSITY, not approval. The only
 * saturated thing here is a failure, which is why one failed mark is findable in
 * under a second.
 *
 * NO PROGRESS BAR. The Margin IS the progress, and it measures something real.
 * Marks strike at the pace the engine actually reports, so a slow band reads as
 * a slow band. Nothing is interpolated, pre-filled or eased: easing a count is
 * fabricating intermediate states of a fact.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MarkCheck, RunProgress } from "../lib/verifyRun";
import { ENGINE_DOWNLOAD_MB, runVerification } from "../lib/verifyRun";
import "./margin.css";

/** Marks rendered before a run exists. Enough to read as a full ledger without
 *  claiming a specific count the product has not measured on THIS spec. */
const HOLLOW_ROWS = 220;

export interface MarginProps {
  /** how many programs the emitters produced, for the hollow ledger's height */
  programCount: number;
  /** opens the expanded unit chart */
  onExpand?: () => void;
}

export default function Margin({ programCount, onExpand }: MarginProps) {
  const [run, setRun] = useState<RunProgress | null>(null);
  const [expanded, setExpanded] = useState(false);
  const liveId = useId();
  const startedRef = useRef(false);

  const marks: MarkCheck[] = useMemo(() => {
    if (run?.marks.length) return run.marks;
    /* The unverified ledger. Deliberately not a fake count: these are placeholder
     * cells standing for "not yet measured", and they say so in the label. */
    return Array.from({ length: Math.max(HOLLOW_ROWS, programCount * 6) }, (_, i) => ({
      id: i, name: "not yet run", state: "hollow" as const,
    }));
  }, [run, programCount]);

  const total = run?.total ?? 0;
  const done = run?.done ?? 0;
  const failed = run?.failed ?? 0;
  const phase = run?.phase ?? "idle";

  const start = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runVerification(setRun).finally(() => { startedRef.current = false; });
  };

  /* Keyboard: M toggles the expanded unit chart, matching the affordance the
   * count button advertises. Ignored while typing. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      if (t?.isContentEditable) return;
      if (e.key === "m" || e.key === "M") { e.preventDefault(); setExpanded((v) => !v); }
      if (e.key === "Escape" && expanded) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    if (expanded) onExpand?.();
  }, [expanded, onExpand]);

  const label =
    phase === "idle"
      ? "Nothing here has been verified yet"
      : phase === "loading"
        ? `Loading the engine, about ${ENGINE_DOWNLOAD_MB}MB`
        : phase === "running"
          ? "Running checks"
          : phase === "error"
            ? `Run failed: ${run?.error ?? "unknown"}`
            : failed > 0
              ? `${failed} of ${total} checks failed`
              : `${total} checks passed`;

  return (
    <aside
      className={`mg${expanded ? " mg-expanded" : ""}`}
      data-phase={phase}
      aria-label="Verification ledger"
    >
      <div className="mg-rail" role="img" aria-labelledby={liveId}>
        <div className="mg-cells" data-expanded={expanded ? "yes" : "no"}>
          {marks.map((m) => (
            <span
              key={m.id}
              className="mg-mark"
              data-s={m.state}
              title={expanded ? `${m.name}${m.detail ? ` — ${m.detail}` : ""}` : undefined}
            />
          ))}
        </div>
      </div>

      <div className="mg-foot">
        {phase === "idle" || phase === "error" ? (
          <button type="button" className="mg-run" onClick={start}>
            Run the checks
          </button>
        ) : phase === "done" ? (
          <button
            type="button"
            className="mg-count"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={`${label}. Press to ${expanded ? "collapse" : "expand"} the ledger.`}
          >
            <span className="mg-num" data-num>{done.toLocaleString()}</span>
            <span className="mg-den" data-num>/{total.toLocaleString()}</span>
          </button>
        ) : (
          <span className="mg-running" data-num>
            {phase === "loading" ? `${ENGINE_DOWNLOAD_MB}MB` : "…"}
          </span>
        )}
      </div>

      {/* The claim, in words, for anyone not reading geometry. */}
      <p className="sr-only" id={liveId} role="status" aria-live="polite">{label}</p>
    </aside>
  );
}
