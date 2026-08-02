/**
 * E-VALUES — how strong an unmeasured confounder would have to be.
 *
 * Closed form, on the risk-ratio scale (VanderWeele & Ding Ann Intern Med
 * 2017;167:268):
 *
 *     E = RR   + sqrt(RR   * (RR   - 1))      for RR >= 1
 *     E = 1/RR + sqrt(1/RR * (1/RR - 1))      for RR <  1
 *
 * The second line is the first applied to the reciprocal, which is what makes
 * the quantity symmetric: an RR of 2 and an RR of 0.5 are the same distance
 * from the null and get the same E-value. Both branches are exact arithmetic on
 * a number the same program already computed, so nothing here is deferred to
 * SAS and nothing is retyped from another table.
 *
 * THE LIMIT E-VALUE, and why it is the one to read. The point estimate's
 * E-value answers "how strong to move the estimate to the null". The CONFIDENCE
 * LIMIT NEAREST THE NULL answers "how strong to make the data compatible with
 * no effect", which is the question anybody actually has. A large point E-value
 * beside a limit E-value near 1 means modest confounding would explain
 * everything, and reporting only the first would say the opposite.
 *
 * WHEN THE INTERVAL CROSSES THE NULL the limit E-value is 1 by construction —
 * no confounding at all is needed, because the data are already compatible with
 * no effect. Printing a bare "1" there is worse than printing nothing: it reads
 * as a small number on the same scale as the point E-value beside it. So the
 * emitted program says what the 1 means instead.
 *
 * WHAT AN E-VALUE IS NOT, stated in every program that emits one. It is not
 * evidence that a confounder exists, and not evidence that none does. It
 * converts an estimate into "how strong would the lurking variable have to be",
 * and whether anything that strong is plausible in this population is a
 * judgement about the subject matter, not a computation. An E-value reported as
 * a robustness certificate is worse than no E-value at all.
 */

/** The closed form, as a SQL expression over an already-computed risk ratio. */
export function eValueSql(rr: string): string {
  return (
    `CASE WHEN ${rr} IS NULL OR ${rr} <= 0 THEN NULL` +
    ` WHEN ${rr} >= 1 THEN ${rr} + SQRT(${rr} * (${rr} - 1))` +
    ` ELSE 1.0 / ${rr} + SQRT((1.0 / ${rr}) * (1.0 / ${rr} - 1)) END`
  );
}

/** The limit NEAREST THE NULL, as a SQL expression. NULL when the interval
 *  covers 1 — there is no limit on the far side to bound, and the caller emits
 *  the "compatible with no effect" reading rather than a bare 1. */
export function nearestNullLimitSql(lo: string, hi: string): string {
  return (
    `CASE WHEN ${lo} IS NULL OR ${hi} IS NULL THEN NULL` +
    ` WHEN ${lo} > 1 THEN ${lo}` +
    ` WHEN ${hi} < 1 THEN ${hi}` +
    ` ELSE NULL END`
  );
}

/** SAS twin of the closed form, as an expression usable in a data step. */
export function eValueSas(rr: string): string {
  return `ifn(${rr} > 0, ifn(${rr} >= 1, ${rr} + sqrt(${rr} * (${rr} - 1)), 1 / ${rr} + sqrt((1 / ${rr}) * (1 / ${rr} - 1))), .)`;
}

/** SAS twin of the nearest-the-null limit. Missing when the interval covers 1. */
export function nearestNullLimitSas(lo: string, hi: string): string {
  return `ifn(${lo} > 1, ${lo}, ifn(${hi} < 1, ${hi}, .))`;
}

/** The caveat every program emitting an E-value carries, in both languages. */
export const EVALUE_METHOD_NOTES = [
  `the E-VALUE is the minimum strength of association, on the risk-ratio scale, that an unmeasured confounder would need with BOTH the exposure and the outcome - above and beyond every covariate already adjusted for - to explain this estimate away entirely (VanderWeele & Ding 2017)`,
  `AN E-VALUE IS NOT EVIDENCE THAT A CONFOUNDER EXISTS, AND NOT EVIDENCE THAT ONE DOES NOT. It converts an estimate into "how strong would the lurking variable have to be". Whether anything that strong is plausible in this population is a judgement about the subject matter, not a computation, and an E-value reported as a robustness certificate is worse than no E-value at all`,
  `the E-value for the CONFIDENCE LIMIT NEAREST THE NULL is usually the more informative of the pair: a large point E-value beside a limit E-value near 1 means modest confounding would already make the data compatible with no effect`,
  `when the interval CROSSES the null the limit E-value is 1 by construction - no confounding at all is needed, because the data are already compatible with no effect. The program says so rather than printing a bare 1 beside the point E-value, where it would read as a number on the same scale`,
  `it is computed from the risk ratio THIS PROGRAM produced, never one retyped from elsewhere, and it bounds only UNMEASURED confounding - it says nothing about selection, misclassification or the horizon this outcome was ascertained over`,
];

/** The row-level method text for the point E-value. */
export const EVALUE_POINT_METHOD =
  `E = RR + sqrt(RR(RR-1)) for RR >= 1, and the same applied to 1/RR below 1. The minimum association an unmeasured confounder would need with BOTH exposure and outcome to explain this estimate away. It is NOT evidence a confounder exists or does not - whether anything this strong is plausible is a judgement about the subject, not a computation`;
