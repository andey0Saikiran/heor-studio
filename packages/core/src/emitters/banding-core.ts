/**
 * DECLARED COARSENING — turning a continuous covariate into a legal cell axis,
 * and saying out loud what that costs.
 *
 * THE REFUSAL THIS DOES NOT REPEAL. The propensity score in this project is
 * closed form ONLY because a logistic model over categorical cells is
 * SATURATED: its maximum-likelihood fitted probability in each cell IS the
 * observed treated fraction. One raw continuous covariate and that stops being
 * true, the score stops being the MLE, and every weight downstream becomes a
 * wrong number rather than a missing one. Readiness still refuses an UNBANDED
 * continuous covariate for exactly that reason.
 *
 * WHAT A BANDING CHANGES. A banded covariate is a categorical one. The cells it
 * forms are as saturated as any other, so the closed form holds again — but the
 * covariate being adjusted for is now the BAND, not the value. That is a real
 * loss and it is not recoverable downstream:
 *
 *   - confounding WITHIN a band is entirely uncontrolled. Two subjects at 45 and
 *     64 are the same subject to this model;
 *   - a WIDER band controls LESS. The cut points are a study choice that moves
 *     the estimate, which is why they are declared in the spec and stamped into
 *     the emitted program rather than chosen inside a hand-written step;
 *   - a band holding ONE ARM ONLY is a positivity violation. A balance table
 *     will not show it — the standardized difference of a coarsened covariate
 *     can look fine while an entire band has no counterfactual in it — so the
 *     emitted program reports BAND OCCUPANCY BY ARM directly.
 *
 * THE INTERVAL CONVENTION is left-closed / right-open, [a, b), so a value can
 * never land in two bands and never fall between them. Cut points are INTERIOR:
 * [45, 65] gives three bands, (-inf, 45), [45, 65) and [65, inf).
 *
 * MISSING IS ITS OWN BAND, labelled "Unknown", and it is never folded into a
 * numeric one. A member with no birth year is not young; silently sorting them
 * into the lowest band would invent a covariate value, and pooling them into
 * the highest would invent a different one. As a cell of its own it is visible
 * in the occupancy rows, where a one-arm "Unknown" band reads as exactly what it
 * is.
 *
 * Ref: Rosenbaum & Rubin Biometrika 1983;70:41 (subclassification on the score);
 * Greenland Am J Public Health 1995;85:1209 (what categorising a continuous
 * confounder costs, and why it is residual confounding rather than none).
 */
import type { CovariateBanding } from "../spec/types";
import { BANDABLE_BASELINE_KINDS, CATEGORICAL_CELL_KINDS } from "../spec/types";
import type { Ctx as SqlCtx } from "./sql-base";
import { REGION_LABELS, SEX_LABELS } from "./parity";

/** Categorical axes a saturated cell can be built from directly, plus the
 *  coarsened one a declared banding creates. */
export type CellAxisKind = "sex" | "region" | "plan_type" | "year" | "banded";

export interface CellAxis {
  id: string;
  label: string;
  kind: CellAxisKind;
  /** kind "banded": ASCENDING interior cut points, left-closed/right-open */
  cutPoints?: number[];
  /** kind "banded": the continuous baseline kind being coarsened */
  coarsens?: string;
}

/** A cut point as it is written into BOTH twins. One renderer, so a boundary
 *  cannot be spelled `45` in one language and `45.0` in the other — which would
 *  be identical arithmetic and a fingerprint mismatch, or worse, the reverse. */
export function cutLit(v: number): string {
  return String(v);
}

/** Interval labels for interior cut points, left-closed/right-open.
 *  [45, 65] -> ["<45", "[45,65)", ">=65"]. The brackets are the convention
 *  stated in the label itself: a reader never has to guess which end is open. */
export function bandLabels(cutPoints: number[]): string[] {
  const out: string[] = [`<${cutLit(cutPoints[0])}`];
  for (let i = 1; i < cutPoints.length; i++) {
    out.push(`[${cutLit(cutPoints[i - 1])},${cutLit(cutPoints[i])})`);
  }
  out.push(`>=${cutLit(cutPoints[cutPoints.length - 1])}`);
  return out;
}

/** MISSING IS A BAND. Appended last so the numeric bands keep their order. */
export const UNKNOWN_BAND = "Unknown";

/** Every label the axis can take, including the missing-value band. */
export function bandCellLabels(cutPoints: number[]): string[] {
  return [...bandLabels(cutPoints), UNKNOWN_BAND];
}

/**
 * The SQL band expression. Left-closed/right-open, missing first so a NULL can
 * never fall through into a numeric comparison that evaluates UNKNOWN and lands
 * in the ELSE arm — which would put every member with no birth year in the
 * highest band, silently.
 */
export function bandCaseSql(valueExpr: string, cutPoints: number[]): string {
  const arms = [`WHEN ${valueExpr} IS NULL THEN '${UNKNOWN_BAND}'`];
  const labels = bandLabels(cutPoints);
  cutPoints.forEach((c, i) => arms.push(`WHEN ${valueExpr} < ${cutLit(c)} THEN '${labels[i]}'`));
  return `CASE ${arms.join(" ")} ELSE '${labels[labels.length - 1]}' END`;
}

/** The SAS twin of the same construction, as data-step statements. */
export function bandAssignSas(valueExpr: string, cutPoints: number[], target: string): string[] {
  const labels = bandLabels(cutPoints);
  const out = [`if ${valueExpr} = . then ${target} = '${UNKNOWN_BAND}';`];
  cutPoints.forEach((c, i) =>
    out.push(`else if ${valueExpr} < ${cutLit(c)} then ${target} = '${labels[i]}';`));
  out.push(`else ${target} = '${labels[labels.length - 1]}';`);
  return out;
}

/* ------------------------------------------------------------------ *
 *  Cell axes — shared by propensity_score, iptw_outcome, g_formula and
 *  negative_control so a cell is spelled ONE way across four modules.
 * ------------------------------------------------------------------ */

/**
 * The cell axes an analysis actually gets, in the order its covariates were
 * declared — which is the order both twins concatenate them in, and therefore
 * part of the parity contract.
 *
 * A covariate is an axis when it is categorical, or when a DECLARED banding
 * coarsens it into one. Anything else is dropped here and refused by readiness,
 * so the two must agree: an axis this function silently omitted would change
 * every score in the analysis while the balance table still listed the
 * covariate.
 */
export function resolveCellAxes(
  baseline: Array<{ id: string; label: string; kind: string }>,
  covariateIds: string[],
  bandings: CovariateBanding[] | undefined,
): CellAxis[] {
  const bandBy = new Map((bandings ?? []).map((b) => [b.baselineId, b] as const));
  const out: CellAxis[] = [];
  for (const id of covariateIds) {
    const b = baseline.find((x) => x.id === id);
    if (!b) continue;
    if (CATEGORICAL_CELL_KINDS.has(b.kind)) {
      out.push({ id, label: b.label, kind: b.kind as CellAxisKind });
      continue;
    }
    const band = bandBy.get(id);
    if (band && BANDABLE_BASELINE_KINDS.has(b.kind) && band.cutPoints.length > 0) {
      out.push({ id, label: b.label, kind: "banded", cutPoints: [...band.cutPoints], coarsens: b.kind });
    }
  }
  return out;
}

/** The stamped spelling of an axis. A banded axis is NOT the same axis as the
 *  raw covariate and must not stamp as though it were. */
export function axisStamp(a: CellAxis): string {
  return a.kind === "banded" ? `banded:${a.coarsens ?? "unknown"}` : a.kind;
}

/** SQL expression for one cell axis. */
export function cellExprSql(a: CellAxis, ctx: SqlCtx): string {
  switch (a.kind) {
    case "sex":
      return `CASE CAST(dm.sex AS VARCHAR) ${Object.entries(SEX_LABELS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE 'Unknown' END`;
    case "region":
      return `CASE CAST(dm.region AS VARCHAR) ${Object.entries(REGION_LABELS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} ELSE 'Unknown' END`;
    case "plan_type":
      return `COALESCE(CAST(dm.plantyp AS VARCHAR), 'Unknown')`;
    case "year":
      return `CAST(${ctx.d.year("c.index_date")} AS VARCHAR)`;
    case "banded":
      return bandCaseSql(bandedValueSql(ctx), a.cutPoints ?? []);
  }
}

/** The continuous value a banding coarsens, in SQL. Age at index is the only
 *  one the spine derives, and it is derived HERE so the band expression and the
 *  balance table cannot disagree about what "age" means. */
export function bandedValueSql(ctx: SqlCtx): string {
  return `CAST(${ctx.d.year("c.index_date")} - dm.dobyr AS DOUBLE PRECISION)`;
}

/** SAS twin: statements assigning one cell axis into `v`. */
export function cellAssignSas(a: CellAxis, v: string): string[] {
  switch (a.kind) {
    case "sex": {
      const arms = Object.entries(SEX_LABELS).map(([k, lab], j) => `${j === 0 ? "if" : "else if"} sex = '${k}' then ${v} = '${lab}';`);
      return [...arms, `else ${v} = 'Unknown';`];
    }
    case "region": {
      const arms = Object.entries(REGION_LABELS).map(([k, lab], j) => `${j === 0 ? "if" : "else if"} region = '${k}' then ${v} = '${lab}';`);
      return [...arms, `else ${v} = 'Unknown';`];
    }
    case "plan_type":
      return [`${v} = strip(vvalue(plantyp));`, `if ${v} in ('', '.') then ${v} = 'Unknown';`];
    case "year":
      return [`${v} = strip(put(year(index_date), 4.));`];
    case "banded":
      return bandAssignSas(SAS_BANDED_VALUE, a.cutPoints ?? [], v);
  }
}

/** The SAS variable holding the value a banding coarsens. Assigned by
 *  `sasBandedValueStep` BEFORE any axis assignment, which is the whole reason
 *  it is a named variable rather than an inline expression. */
export const SAS_BANDED_VALUE = "_band_val";

/** The one statement that computes it. Emitted only when an axis is banded, so
 *  an unbanded program is byte-identical to what it emitted before. */
export function sasBandedValueStep(): string[] {
  return [
    `/* the CONTINUOUS value a declared banding coarsens, computed once and`,
    `   BEFORE the axis assignments below - the band is a function of it, and`,
    `   a data step that read it afterwards would band a missing value */`,
    `${SAS_BANDED_VALUE} = year(index_date) - dobyr;`,
  ];
}

/* ------------------------------------------------------------------ *
 *  Band occupancy by arm
 * ------------------------------------------------------------------ */

/** One band of one axis, with the column each twin reads it from. */
export interface BandSlot {
  /** 1-based ordinal across every declared banding, in declaration order */
  ord: number;
  /** the axis column in the emitted code (ax0, ax1, ...) */
  col: string;
  label: string;
  /** the baseline being coarsened, for the emitted method text */
  covariateLabel: string;
  /** the full cut-point list this band belongs to, for the method text */
  cutPoints: number[];
}

/** Flatten every banded axis into the band slots both twins report on. */
export function bandSlots(axes: CellAxis[]): BandSlot[] {
  const out: BandSlot[] = [];
  axes.forEach((a, j) => {
    if (a.kind !== "banded") return;
    for (const label of bandCellLabels(a.cutPoints ?? [])) {
      out.push({
        ord: out.length + 1,
        col: `ax${j}`,
        label,
        covariateLabel: a.label,
        cutPoints: a.cutPoints ?? [],
      });
    }
  });
  return out;
}

/** `bocc` — occupancy of every band, BY ARM.
 *
 *  A band holding one arm only is a positivity violation, and it is one a
 *  balance table cannot show: the standardized difference of the coarsened
 *  covariate can sit comfortably below 0.1 while an entire band has no
 *  counterpart in the other arm. */
export function bandOccupancySqlCte(o: { from: string; slots: BandSlot[]; alias: string }): string[] {
  const L: string[] = [];
  L.push(`${o.alias} AS (   -- BAND OCCUPANCY BY ARM. A band with one arm only is a`);
  L.push(`  -- positivity violation, and a balance table will not show it: the`);
  L.push(`  -- standardized difference of a coarsened covariate can look fine while`);
  L.push(`  -- a whole band has no counterpart in the other arm.`);
  L.push(`  SELECT`);
  const parts: string[] = [];
  for (const s of o.slots) {
    parts.push(`    SUM(CASE WHEN ${s.col} = '${s.label}' AND treated = 1 THEN 1 ELSE 0 END) AS b${s.ord}_t`);
    parts.push(`    SUM(CASE WHEN ${s.col} = '${s.label}' AND treated = 0 THEN 1 ELSE 0 END) AS b${s.ord}_c`);
  }
  L.push(parts.join(",\n"));
  L.push(`  FROM ${o.from}`);
  L.push(`),`);
  return L;
}

/** SAS twin of the same counts. */
export function bandOccupancySasSteps(o: { num: string; from: string; slots: BandSlot[] }): string[] {
  const L: string[] = [
    `/*----------------------------------------------------------------------------`,
    `  BAND OCCUPANCY BY ARM. A band holding one arm only is a positivity`,
    `  violation, and a balance table will not show it.`,
    `----------------------------------------------------------------------------*/`,
    `proc sql;`,
    `  create table work._${o.num}_bocc as`,
    `  select`,
  ];
  const parts: string[] = [];
  for (const s of o.slots) {
    parts.push(`    sum(${s.col} = '${s.label}' and treated = 1) as b${s.ord}_t`);
    parts.push(`    sum(${s.col} = '${s.label}' and treated = 0) as b${s.ord}_c`);
  }
  L.push(parts.join(",\n"));
  L.push(`  from ${o.from};`, `quit;`, ``);
  return L;
}

/** Bands that hold EXACTLY ONE arm, as a SQL expression over the occupancy CTE.
 *  An empty band is not counted: nobody is stranded in it. */
export function oneArmBandCountSql(slots: BandSlot[]): string {
  if (slots.length === 0) return `0`;
  return slots
    .map((s) => `CASE WHEN (b${s.ord}_t + b${s.ord}_c) > 0 AND (b${s.ord}_t = 0 OR b${s.ord}_c = 0) THEN 1 ELSE 0 END`)
    .join(" + ");
}

/** SAS twin of the same count. */
export function oneArmBandCountSas(slots: BandSlot[]): string {
  if (slots.length === 0) return `0`;
  return slots
    .map((s) => `((b${s.ord}_t + b${s.ord}_c) > 0 and (b${s.ord}_t = 0 or b${s.ord}_c = 0))`)
    .join(" + ");
}

/* ------------------------------------------------------------------ *
 *  The notes both twins always emit when a banding is declared
 * ------------------------------------------------------------------ */

/** The caution that must appear whenever ANY covariate was coarsened.
 *  Always emitted — not conditional on the occupancy coming out badly — because
 *  what it says is true of every banding, including the ones that look fine. */
export function coarseningNotes(axes: CellAxis[]): string[] {
  const banded = axes.filter((a) => a.kind === "banded");
  if (banded.length === 0) return [];
  const out: string[] = [];
  for (const a of banded) {
    out.push(
      `DECLARED COARSENING: "${a.label}" enters the score as BANDS, cut at ${(a.cutPoints ?? []).map(cutLit).join(", ")} (left-closed, right-open, so a value never lands in two bands). Missing values form their own "Unknown" band rather than being folded into a numeric one`,
    );
  }
  out.push(
    `CONFOUNDING WITHIN A BAND IS UNCONTROLLED. The model adjusts for the band, not the value: two subjects at opposite ends of one band are the same subject to it, and a WIDER band controls LESS. The cut points are a study choice that moves the estimate, which is why they are declared in the spec and stamped into this program`,
  );
  out.push(
    `READ THE BAND OCCUPANCY ROWS. A band holding ONE ARM ONLY is a positivity violation, and it is one the balance table cannot show you - a coarsened covariate's standardized difference can sit below 0.1 while a whole band has no counterpart in the other arm`,
  );
  return out;
}

/** Stamp form: which baseline each banding coarsens and where it cuts.
 *  Consumed by the parity stamp, so a boundary that moved is a stamp diff. */
export function bandingStamp(
  bandings: CovariateBanding[] | undefined,
  baseline: Array<{ id: string; kind: string }>,
): Array<{ baselineId: string; coarsens: string; cutPoints: number[] }> | undefined {
  if (!bandings || bandings.length === 0) return undefined;
  return bandings.map((b) => ({
    baselineId: b.baselineId,
    coarsens: baseline.find((x) => x.id === b.baselineId)?.kind ?? "unknown",
    cutPoints: [...b.cutPoints],
  }));
}
