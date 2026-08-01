/**
 * The verification run, executed IN THE BROWSER.
 *
 * `@heor-studio/core/verify` is a subpath export specifically so that PGlite
 * never enters the main import graph. That constraint is respected here by
 * loading it through a DYNAMIC import: the harness and its 10MB wasm Postgres
 * are their own chunks and are fetched only when a human asks for a run. The
 * main bundle does not grow by a byte.
 *
 * WHY THIS EXISTS AT ALL. Every other code generator asks to be trusted. This
 * one can hand over the engine: the checks below are the same ones CI runs, on
 * the same fixtures, against real Postgres compiled to wasm, with no network
 * and no server. A green badge is unfalsifiable and therefore worthless. A run
 * the analyst starts on their own machine is falsifiable, which is the only
 * reason to believe it.
 */

export type MarkState = "hollow" | "struck" | "failed";

export interface MarkCheck {
  id: number;
  name: string;
  state: MarkState;
  detail?: string;
  /** ms this check took, when the run reports it */
  ms?: number;
}

export interface RunProgress {
  /** every mark, in execution order, updated in place as the run proceeds */
  marks: MarkCheck[];
  done: number;
  /** grows as the run proceeds. It is NOT known in advance, because how many
   *  checks exist depends on what the emitters produce, and announcing a total
   *  before computing it would be the fabrication this product refuses. */
  total: number;
  failed: number;
  /** the only thing knowable up front: how many groups the suite has */
  groupsDone: number;
  groupsTotal: number;
  /** the group that just finished, for the band label */
  group?: string;
  /** wall clock of the run so far, ms. Real, never interpolated. */
  elapsed: number;
  phase: "idle" | "loading" | "running" | "done" | "error";
  error?: string;
}

/** Transfer cost of the engine, stated up front rather than sprung on someone
 *  behind a spinner. Measured from the built assets. */
export const ENGINE_DOWNLOAD_MB = 10;

/**
 * Run the harness, reporting progress as it goes.
 *
 * The harness resolves as a single promise rather than streaming per-check
 * events, so `onProgress` fires at the phase boundaries the run actually has:
 * engine loading, execution, and completion. NOTHING here fabricates
 * intermediate states. A mark goes from hollow to struck when its check has
 * genuinely reported, and the elapsed time is measured, not eased.
 */
export async function runVerification(
  onProgress: (p: RunProgress) => void,
  now: () => number = () => performance.now(),
): Promise<RunProgress> {
  const started = now();
  let state: RunProgress = {
    marks: [], done: 0, total: 0, failed: 0,
    groupsDone: 0, groupsTotal: 0,
    elapsed: 0, phase: "loading",
  };
  const emit = (patch: Partial<RunProgress>) => {
    state = { ...state, ...patch, elapsed: now() - started };
    onProgress(state);
    return state;
  };
  emit({});

  try {
    /* The chunk boundary. Postgres arrives here, or not at all. */
    const mod = await import("@heor-studio/core/verify");
    emit({ phase: "running" });

    /* THE WHOLE SUITE, the same one CI runs, not Gold Case A alone. The browser
     * used to run a subset, so the screen said 1058 while the README said 1572:
     * both honest, and not the same number. A headline figure nobody can
     * reproduce from the UI is exactly the kind of unbacked claim this project
     * exists to refuse. */
    const final = await mod.verifyAll((p) => {
      /* Marks are built from REAL completions, group by group, so the column
       * fills at the pace the engine actually reports. A slow group reads as a
       * slow group. Nothing is interpolated or pre-filled. */
      const marks: MarkCheck[] = p.checks.map((c, i) => ({
        id: i,
        name: c.name,
        state: c.status === "pass" ? "struck" : "failed",
        detail: c.detail,
      }));
      emit({
        marks,
        total: marks.length,
        done: marks.length,
        failed: p.failed,
        groupsDone: p.groupsDone,
        groupsTotal: p.groupsTotal,
        group: p.groups[p.groups.length - 1]?.title,
      });
    });

    const marks: MarkCheck[] = final.checks.map((c, i) => ({
      id: i,
      name: c.name,
      state: c.status === "pass" ? "struck" : "failed",
      detail: c.detail,
    }));

    return emit({
      marks,
      total: marks.length,
      done: marks.length,
      failed: final.failed,
      groupsDone: final.groupsDone,
      groupsTotal: final.groupsTotal,
      phase: "done",
    });
  } catch (err) {
    return emit({
      phase: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
