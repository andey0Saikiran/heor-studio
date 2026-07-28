/**
 * SAS-primary columns — the declared carve-out from "both twins compute
 * identical numbers".
 *
 * Two project constraints collide for most of the remaining analyses:
 *   1. the SAS and SQL twins must compute identical numbers;
 *   2. warehouse SQL has no statistical CDFs — no exact intervals, no p-values,
 *      no fitted coefficients.
 * Without a shape for that collision, every inferential deliverable had only
 * two options: lie about parity, or be dropped. Both are wrong.
 *
 * A SAS-primary column is the third option, and it is a CONTRACT, not an
 * exemption:
 *   - SQL emits the column as NULL, beside a label naming what would compute it;
 *   - SAS computes it;
 *   - the numeric fingerprint comparison EXCLUDES it (there is nothing to
 *     compare) but the structural checks REQUIRE it:
 *       * the SAS twin MUST contain the computing token (verify/sas-lint.ts),
 *       * the SQL twin MUST have it NULL and MUST NOT compute a guess.
 * Mutation tests pin both directions: deleting the SAS statistic and populating
 * the SQL column each turn the suite red.
 *
 * The point is that a number we cannot verify is still *declared*, *labeled*,
 * and *structurally enforced* — never quietly absent and never faked in SQL.
 */

/** One column that only SAS can produce. */
export interface SasPrimaryColumn {
  /** output column name */
  column: string;
  /** value of the companion *_method label column, naming what computes it */
  methodLabel: string;
  /** why SQL cannot compute it — rendered into both twins */
  why: string;
  /** substring that MUST appear in the SAS twin for the column to be real */
  sasToken: string;
}

/** Companion label column for a SAS-primary column. */
export function methodColumnFor(column: string): string {
  return `${column}_method`;
}

/**
 * Exact (gamma) Poisson interval — the classic case.
 *
 * Byar's approximation is closed form and both twins compute it. The EXACT
 * interval inverts the Poisson CDF, which needs the inverse incomplete gamma
 * (SAS GAMINV / CINV). Stock Postgres and Snowflake have neither, so before
 * this contract a spec asking for `poisson_exact` was silently downgraded to
 * Byar and relabeled. Now the downgrade is still what SQL reports — but the
 * exact interval is genuinely produced in SAS and declared as such.
 */
export const EXACT_POISSON_CI: SasPrimaryColumn[] = [
  {
    column: "ci_low_exact",
    methodLabel: "sas_poisson_exact",
    why: "exact Poisson limits invert the Poisson CDF (inverse incomplete gamma); warehouse SQL has no such function",
    sasToken: "gaminv(",
  },
  {
    column: "ci_high_exact",
    methodLabel: "sas_poisson_exact",
    why: "exact Poisson limits invert the Poisson CDF (inverse incomplete gamma); warehouse SQL has no such function",
    sasToken: "gaminv(",
  },
];

/**
 * Two-sided p-value from the standard normal CDF.
 *
 * The companion case to the exact Poisson interval, and the one that shows why
 * this contract is drawn at the COLUMN and not at the statistic: the
 * Cochran-Armitage trend test splits cleanly in two. Its statistic z is a ratio
 * of sums over the bucket table — closed form, so both twins compute it and the
 * harness executes it against hand-derived truth. Only the tail probability
 * needs Phi, which warehouse SQL has no function for.
 *
 * Declaring the whole test SAS-primary would have been the easy call and would
 * have put a perfectly verifiable number permanently beyond verification.
 */
export const NORMAL_CDF_P_VALUE: SasPrimaryColumn[] = [
  {
    column: "trend_p",
    methodLabel: "sas_normal_cdf",
    why: "the two-sided p-value inverts the standard normal CDF (SAS PROBNORM); warehouse SQL has no such function. The trend statistic z beside it IS computed in both twins",
    sasToken: "probnorm(",
  },
];

/** Registry: PARITY stamp kind -> the SAS-primary columns it may emit.
 *  Emission is still conditional on the spec asking for them; this declares
 *  what is POSSIBLE so the verification layer knows what to enforce. */
export const SAS_PRIMARY_BY_KIND: Record<string, SasPrimaryColumn[]> = {
  incidence: EXACT_POISSON_CI,
  calendar_trend: NORMAL_CDF_P_VALUE,
};

/** SQL side: NULL columns + the method label, with the reason stated inline. */
export function sasPrimarySqlColumns(cols: SasPrimaryColumn[]): string[] {
  if (cols.length === 0) return [];
  const out: string[] = [];
  out.push(`-- SAS-PRIMARY columns: NULL here BY CONTRACT, computed in the SAS twin.`);
  out.push(`-- They are not missing and they are not approximated — SQL cannot`);
  out.push(`-- compute them, so it declares them rather than guessing:`);
  for (const c of cols) out.push(`--   ${c.column}: ${c.why}`);
  for (const c of cols) {
    out.push(`CAST(NULL AS DOUBLE PRECISION) AS ${c.column},`);
  }
  out.push(`'${cols[0].methodLabel}' AS ${methodColumnFor(cols[0].column)},`);
  return out;
}

/** The exact-Poisson limits in SAS, from the same event count the twins share.
 *
 *  Lower = GAMINV(alpha/2, k) and Upper = GAMINV(1-alpha/2, k+1), each divided
 *  by person-time and scaled by the same multiplier the Byar columns use, so
 *  the exact and approximate intervals are directly comparable in one row. */
export function exactPoissonSasLines(multiplier: number, daysPerYearMacro: string): string[] {
  return [
    `  /* SAS-PRIMARY: exact (gamma) Poisson limits. SQL emits these as NULL —`,
    `     inverting the Poisson CDF needs the inverse incomplete gamma, which`,
    `     warehouse SQL does not have. Byar's closed form above stays in BOTH`,
    `     twins; this is the exact interval beside it. */`,
    `  if patients = 0 then _exact_low = 0;`,
    `  else _exact_low = gaminv(0.025, patients);`,
    `  _exact_high = gaminv(0.975, patients + 1);`,
    `  if person_days > 0 then do;`,
    `    ci_low_exact  = round(_exact_low  * ${multiplier} * ${daysPerYearMacro} / person_days, 0.01);`,
    `    ci_high_exact = round(_exact_high * ${multiplier} * ${daysPerYearMacro} / person_days, 0.01);`,
    `  end;`,
    `  ci_low_exact_method = "sas_poisson_exact";`,
    `  drop _exact_low _exact_high;`,
  ];
}
