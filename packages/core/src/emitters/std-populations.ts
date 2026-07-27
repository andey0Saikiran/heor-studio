/**
 * Standard reference populations for DIRECT age standardization.
 *
 * A directly standardized rate is a weighted average of stratum-specific rates,
 * where the weights come from an external reference population. The weights are
 * therefore load-bearing data: a single mistyped figure shifts every
 * standardized rate a study reports, and does it invisibly — the output still
 * looks like a plausible rate.
 *
 * Two protections, because "I typed them carefully" is not verification:
 *
 *  1. Each population declares its PUBLISHED TOTAL, and `validateStandardPopulation`
 *     asserts the weights sum to it exactly. Any single-digit typo breaks the sum.
 *     This runs in the harness, not just at review time.
 *  2. Provenance is recorded per population and emitted into the generated code,
 *     so the analyst can check the numbers against the source their journal or
 *     payer expects rather than trusting this file.
 *
 * IMPORTANT — the analyst still confirms. These are transcribed constants, and
 * a sum check proves internal consistency, NOT that the transcription matches
 * the intended edition. Reference populations have several published variants
 * (the US 2000 standard exists in 11-band and 19-band forms; ESP has 1976 and
 * 2013 editions). The emitted code names the edition it used and says to confirm it.
 */

export type StandardPopulationId = "us_2000" | "who_world" | "esp_2013";

export interface StandardPopulationBand {
  /** inclusive lower bound in years */
  lower: number;
  /** weight for this band, in the population's own units */
  weight: number;
}

export interface StandardPopulation {
  id: StandardPopulationId;
  label: string;
  /** what the weights are expressed per (e.g. 1,000,000 = "standard million") */
  publishedTotal: number;
  /** citation the generated code carries, so the analyst can verify the source */
  provenance: string;
  /** ascending by lower bound; the last band is open-ended */
  bands: StandardPopulationBand[];
}

/**
 * US 2000 Standard Population — the "standard million", 10-band form.
 * Sums to exactly 1,000,000 by construction of the published table.
 */
const US_2000: StandardPopulation = {
  id: "us_2000",
  label: "US 2000 standard population (standard million, 10 bands)",
  publishedTotal: 1_000_000,
  provenance:
    "Klein RJ, Schoenborn CA. Age adjustment using the 2000 projected U.S. population. " +
    "Healthy People 2010 Statistical Notes No. 20. NCHS, January 2001. " +
    "CONFIRM against your own copy: an 11-band variant splits 0-4 into <1 and 1-4.",
  bands: [
    { lower: 0, weight: 69_135 },
    { lower: 5, weight: 145_565 },
    { lower: 15, weight: 138_646 },
    { lower: 25, weight: 135_573 },
    { lower: 35, weight: 162_613 },
    { lower: 45, weight: 134_834 },
    { lower: 55, weight: 87_247 },
    { lower: 65, weight: 66_037 },
    { lower: 75, weight: 44_842 },
    { lower: 85, weight: 15_508 },
  ],
};


/**
 * WHO World Standard Population (average world population 2000-2025).
 *
 * Per 1,000,000, 21 bands, terminal 100+ (the WHO standard deliberately extends
 * past the conventional 85+ terminal).
 *
 * Transcribed from SEER's published reference table and CROSS-CHECKED against
 * the percentages printed in the WHO source paper: 0-4 = 8.860%, 5-9 = 8.690%,
 * 10-14 = 8.600%, which match 88,569 / 86,870 / 85,970 per million exactly.
 */
const WHO_WORLD: StandardPopulation = {
  id: "who_world",
  label: "WHO World Standard Population (2000-2025)",
  publishedTotal: 1_000_000,
  provenance:
    "Ahmad OB, Boschi-Pinto C, Lopez AD, Murray CJL, Lozano R, Inoue M. Age standardization of " +
    "rates: a new WHO standard. GPE Discussion Paper Series No. 31, WHO 2001. Values transcribed " +
    "from the SEER reference table (seer.cancer.gov/stdpopulations/world.who.html) and cross-checked " +
    "against the percentages printed in the source paper.",
  bands: [
    { lower: 0, weight: 88_569 },
    { lower: 5, weight: 86_870 },
    { lower: 10, weight: 85_970 },
    { lower: 15, weight: 84_670 },
    { lower: 20, weight: 82_171 },
    { lower: 25, weight: 79_272 },
    { lower: 30, weight: 76_073 },
    { lower: 35, weight: 71_475 },
    { lower: 40, weight: 65_877 },
    { lower: 45, weight: 60_379 },
    { lower: 50, weight: 53_681 },
    { lower: 55, weight: 45_484 },
    { lower: 60, weight: 37_187 },
    { lower: 65, weight: 29_590 },
    { lower: 70, weight: 22_092 },
    { lower: 75, weight: 15_195 },
    { lower: 80, weight: 9_097 },
    { lower: 85, weight: 4_398 },
    { lower: 90, weight: 1_500 },
    { lower: 95, weight: 400 },
    { lower: 100, weight: 50 },
  ],
};

/**
 * European Standard Population 2013 (ESP2013).
 *
 * Per 100,000, 21 bands: the published form splits infants (<1) from 1-4 and
 * runs 5-year bands to a 95+ terminal.
 *
 * CROSS-CHECKED against an independent implementation (the R PHEindicatormethods
 * package), which publishes a 19-band variant collapsing <1 + 1-4 into 0-4
 * (1,000 + 4,000 = 5,000) and 90-94 + 95+ into 90+ (800 + 200 = 1,000). Both
 * forms total 100,000, and the collapse algebra below derives the 19-band
 * variant from these bands, so only the finest published form is stored.
 *
 * NOTE for MarketScan: age is derived from DOBYR and is therefore calendar-year
 * precision (BR-ENR-009), so the <1 / 1-4 split is not resolvable in practice.
 * A study banding starting at 0 collapses the two automatically.
 */
const ESP_2013: StandardPopulation = {
  id: "esp_2013",
  label: "European Standard Population 2013 (ESP2013)",
  publishedTotal: 100_000,
  provenance:
    "Eurostat. Revision of the European Standard Population: report of Eurostat's task force. " +
    "2013 edition (KS-RA-13-028-EN). Cross-checked against the R PHEindicatormethods esp2013 " +
    "reference vector, whose 19-band variant collapses <1+1-4 and 90-94+95+ to the same totals.",
  bands: [
    { lower: 0, weight: 1_000 },
    { lower: 1, weight: 4_000 },
    { lower: 5, weight: 5_500 },
    { lower: 10, weight: 5_500 },
    { lower: 15, weight: 5_500 },
    { lower: 20, weight: 6_000 },
    { lower: 25, weight: 6_000 },
    { lower: 30, weight: 6_500 },
    { lower: 35, weight: 7_000 },
    { lower: 40, weight: 7_000 },
    { lower: 45, weight: 7_000 },
    { lower: 50, weight: 7_000 },
    { lower: 55, weight: 6_500 },
    { lower: 60, weight: 6_000 },
    { lower: 65, weight: 5_500 },
    { lower: 70, weight: 5_000 },
    { lower: 75, weight: 4_000 },
    { lower: 80, weight: 2_500 },
    { lower: 85, weight: 1_500 },
    { lower: 90, weight: 800 },
    { lower: 95, weight: 200 },
  ],
};

/** All bundled reference populations. Each is sum-checked by the harness. */
export const STANDARD_POPULATIONS: Partial<Record<StandardPopulationId, StandardPopulation>> = {
  us_2000: US_2000,
  who_world: WHO_WORLD,
  esp_2013: ESP_2013,
};

/** Populations the spec can name but this file does not carry.
 *
 *  Empty now that all three are bundled and sum-checked. Kept because the
 *  mechanism matters more than its current contents: a reference we do not have
 *  must be refused BY NAME, never silently swapped for one we do have — a
 *  substitution relabels the rate while changing it. */
export const STANDARD_POPULATIONS_PENDING: Record<string, string> = {};

export interface PopulationValidation {
  ok: boolean;
  problems: string[];
}

/** Structural + arithmetic validation. The sum check is the real one: it turns
 *  a transcription error into a failure instead of a wrong number. */
export function validateStandardPopulation(p: StandardPopulation): PopulationValidation {
  const problems: string[] = [];

  if (p.bands.length === 0) problems.push(`${p.id}: no bands`);

  const sum = p.bands.reduce((a, b) => a + b.weight, 0);
  if (sum !== p.publishedTotal) {
    problems.push(
      `${p.id}: weights sum to ${sum.toLocaleString()}, but the published total is ` +
        `${p.publishedTotal.toLocaleString()} (difference ${(sum - p.publishedTotal).toLocaleString()}) — ` +
        `a transcription error, not a rounding artifact`,
    );
  }

  for (let i = 1; i < p.bands.length; i++) {
    if (p.bands[i].lower <= p.bands[i - 1].lower) {
      problems.push(`${p.id}: band lower bounds must strictly ascend (${p.bands[i - 1].lower} then ${p.bands[i].lower})`);
    }
  }
  for (const b of p.bands) {
    if (!Number.isFinite(b.weight) || b.weight <= 0) problems.push(`${p.id}: band ${b.lower} has a non-positive weight`);
    if (!Number.isInteger(b.lower) || b.lower < 0) problems.push(`${p.id}: band lower bound ${b.lower} is not a non-negative integer`);
  }

  return { ok: problems.length === 0, problems };
}

/** Human labels for the bands, matching the emitted stratum grammar
 *  (`ageBandLabels` in parity.ts) so standardized output joins to strata. */
export function standardPopulationLabels(p: StandardPopulation): string[] {
  return p.bands.map((b, i) =>
    i === p.bands.length - 1 ? `${b.lower}+` : `${b.lower}-${p.bands[i + 1].lower - 1}`,
  );
}

/**
 * Weights REBASED onto the age bands a study actually reports.
 *
 * A cohort rarely spans the whole reference population — a working-age
 * commercial cohort touches only the middle bands. Two honest options exist:
 * report nothing, or renormalize the reference over the covered bands and say
 * so. This does the second and returns `coveredWeightPct` so the caller can
 * state it, because a rate standardized to 28% of a reference population is NOT
 * comparable to a published rate standardized to the whole one.
 */
export function rebaseWeights(
  p: StandardPopulation,
  studyBandLowers: number[],
): { weights: Array<{ lower: number; weight: number; share: number }>; coveredWeightPct: number } {
  const covered = p.bands.filter((b) => studyBandLowers.includes(b.lower));
  const coveredTotal = covered.reduce((a, b) => a + b.weight, 0);
  const pct = p.publishedTotal > 0 ? (coveredTotal / p.publishedTotal) * 100 : 0;
  return {
    weights: covered.map((b) => ({
      lower: b.lower,
      weight: b.weight,
      share: coveredTotal > 0 ? b.weight / coveredTotal : 0,
    })),
    coveredWeightPct: Number(pct.toFixed(2)),
  };
}

/**
 * Collapse a reference population onto the study's OWN age bands.
 *
 * Direct standardization is only defined when each study band is a union of
 * whole reference bands. If a study boundary falls INSIDE a reference band the
 * weight would have to be split, and there is no non-arbitrary way to do it —
 * assuming a uniform age distribution within the band is exactly the kind of
 * invented number this project refuses to ship.
 *
 * Real example from the gold fixture: the default banding
 * [0, 18, 35, 45, 55, 65] puts a boundary at 18, but US 2000 runs 15-24. The
 * 18 boundary cuts that band in half, so the study CANNOT be standardized to
 * US 2000 without interpolation. The honest response is to say so and name the
 * bands that would work — not to silently apportion 15-24 and report a rate.
 *
 * The terminal band is the one exception: reference bands above the study's
 * final lower bound are always collapsible, because the study's last band is
 * open-ended and so is the reference's.
 */
export interface CollapsedReference {
  ok: boolean;
  /** study band lower bound -> summed reference weight */
  weights: Array<{ lower: number; label: string; weight: number }>;
  /** share of the reference population the study bands cover */
  coveredWeightPct: number;
  /** why the collapse is impossible, when ok is false */
  problem?: string;
}

export function collapseReferenceToStudyBands(
  p: StandardPopulation,
  studyBandLowers: number[],
): CollapsedReference {
  const study = [...studyBandLowers].sort((a, b) => a - b);
  const refLowers = p.bands.map((b) => b.lower);

  /* Every study boundary except the first must coincide with a reference
   * boundary, or it splits a reference band. */
  const misaligned = study.filter((lo, i) => i > 0 && !refLowers.includes(lo));
  if (misaligned.length > 0) {
    return {
      ok: false,
      weights: [],
      coveredWeightPct: 0,
      problem:
        `study age bands cannot be standardized to ${p.label}: boundary/boundaries at ` +
        `${misaligned.join(", ")} fall INSIDE reference bands, so their weights would have to be ` +
        `split with an assumed within-band age distribution. Re-band the study on the reference's ` +
        `own boundaries (${refLowers.join(", ")}) — the terminal band may be open-ended — or choose ` +
        `a reference whose bands match`,
    };
  }

  const weights = study.map((lo, i) => {
    const hi = i === study.length - 1 ? Infinity : study[i + 1];
    const weight = p.bands
      .filter((b) => b.lower >= lo && b.lower < hi)
      .reduce((a, b) => a + b.weight, 0);
    return {
      lower: lo,
      label: i === study.length - 1 ? `${lo}+` : `${lo}-${study[i + 1] - 1}`,
      weight,
    };
  });

  const covered = weights.reduce((a, w) => a + w.weight, 0);
  return {
    ok: true,
    weights,
    coveredWeightPct: Number(((covered / p.publishedTotal) * 100).toFixed(2)),
  };
}

/** Directly standardized rate: the weighted average of stratum rates.
 *  Returned alongside the weights so the caller can show the derivation —
 *  a DSR without its weights is not checkable by a reviewer. */
export function directlyStandardizedRate(
  strata: Array<{ lower: number; rate: number }>,
  weights: Array<{ lower: number; weight: number }>,
): { dsr: number; totalWeight: number } {
  let num = 0;
  let den = 0;
  for (const w of weights) {
    const s = strata.find((x) => x.lower === w.lower);
    if (!s) continue;
    num += w.weight * s.rate;
    den += w.weight;
  }
  return { dsr: den > 0 ? num / den : 0, totalWeight: den };
}
