/**
 * Code fingerprints — parity checks that CAN fail.
 *
 * The `PARITY` stamp (emitters/parity.ts) records the parameters each emitter
 * says it consumed. Comparing the two languages' stamps is necessary but NOT
 * sufficient: both stamps are produced by the same builder from the same spec
 * object, so stamp equality holds by construction and cannot detect a twin
 * whose CODE drifted. (An adversarial review proved exactly that: sabotaging
 * the SAS rate arithmetic left every stamp check green.)
 *
 * A fingerprint is different in kind: every value is scraped out of the
 * language's OWN EMITTED TEXT by a language-specific pattern. SQL's multiplier
 * comes from the SQL rate expression; SAS's comes from the SAS rate statement.
 * Nothing is shared but the comparison itself, so the checks have real
 * falsifying power:
 *
 *   fingerprint(SQL) === fingerprint(SAS)   — the twins compute the same thing
 *   fingerprint(*)   === stamp              — the stamp does not lie about the code
 *
 * SAS resolves `&macro.` references against 00_setup.sas, so a setup file whose
 * `%let days_per_year` disagrees with the SQL literal fails too.
 *
 * verify/mutation.ts sabotages emitted code and asserts these checks go red —
 * that is the standing proof the harness is capable of failing.
 */

/** Named facts scraped from one language's emitted code for one analysis. */
export type Fingerprint = Record<string, string>;

/** SAS encodes care settings with short codes; SQL uses the spec's own words.
 *  Normalizing here is what lets the two be compared at all — and it is also
 *  the only place the mapping is asserted, so a broken map fails loudly. */
const SAS_SETTING_TO_SPEC: Record<string, string> = {
  OP: "outpatient",
  IP: "inpatient",
  RX: "pharmacy",
};

/** Strip comments so the fingerprint reads CODE, never prose.
 *
 *  Two reasons this matters, both found by mutation testing:
 *  (a) the generated programs EXPLAIN their formulas in comments, so counting
 *      raw occurrences of a constant counts the prose too — and the two
 *      languages comment differently, making counts incomparable;
 *  (b) a "mutation" that only rewrites a comment would otherwise register as
 *      a change while the executed logic is untouched.
 *  Stripping also removes the PARITY stamp itself, which is what keeps the
 *  fingerprint independent of the stamp it is checked against. */
export function stripComments(language: "sql" | "sas", text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, " "); // block comments (both)
  if (language === "sql") out = out.replace(/--[^\n]*/g, " "); // line comments
  return out;
}

/** Exponents of `POWER(base, n)`, paren-balanced.
 *  A regex cannot do this: the base argument itself contains nested parens
 *  (`POWER(1 - 1.0/(9*patients) - 1.96/(3*SQRT(patients)), 3)`), so a naive
 *  `[^)]*` stops at the first inner `)` and matches nothing. */
function sqlPowerExponents(sql: string): string {
  const out: string[] = [];
  const re = /POWER\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    let lastComma = -1;
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 1) lastComma = i;
    }
    if (depth === 0 && lastComma >= 0) {
      const arg = sql.slice(lastComma + 1, i - 1).trim();
      if (/^\d+$/.test(arg)) out.push(arg);
    }
  }
  return out.length > 0 ? out.join(",") : "NONE";
}

/** Resolve `&name.` / `&name` macro references using 00_setup.sas `%let`s. */
export function resolveSasMacros(text: string, setup: string): string {
  const vars = new Map<string, string>();
  for (const m of setup.matchAll(/%let\s+(\w+)\s*=\s*([^;]*);/g)) {
    vars.set(m[1].toLowerCase(), m[2].trim());
  }
  return text.replace(/&(\w+)\.?/g, (whole, name: string) => {
    const v = vars.get(name.toLowerCase());
    return v === undefined ? whole : v;
  });
}

/** First capture group of the first matching pattern, or undefined. */
function grab(text: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return (m[1] ?? "").trim();
  }
  return undefined;
}

function put(fp: Fingerprint, key: string, v: string | undefined): void {
  fp[key] = v === undefined ? "ABSENT" : v;
}

/** COUNT of occurrences, not mere presence.
 *
 *  Presence checks are near-worthless here: statistical constants appear more
 *  than once per program (Wilson's z² in both CI bounds, Byar's cube in both),
 *  so corrupting ONE occurrence leaves the others and a boolean "is it there?"
 *  stays true. Mutation testing caught exactly that blind spot. Counting makes
 *  a single mistyped constant a 2-vs-1 mismatch. */
function count(text: string, re: RegExp): string {
  return String((text.match(re) ?? []).length);
}

/** EVERY capture of a repeated pattern, joined — not just the first.
 *
 *  The line-of-therapy construction is UNROLLED, so a parameter like the
 *  combination window appears once per line. `grab` would read only the first
 *  copy, and a mutation that changed the second and third would read as caught
 *  by nothing. Joining every occurrence makes a partial change a different
 *  string AND makes a wrong unroll count (too few lines) visible in the same
 *  key — which is the same lesson the POWER-exponent list already encodes. */
function allOf(text: string, re: RegExp): string {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push((m[1] ?? "").trim());
  return out.length > 0 ? out.join(",") : "ABSENT";
}

/** The highest integer a repeated pattern captures, as a string. Used for the
 *  unroll bound: the construction emits lot_x1 .. lot_x<maxLines>, so the
 *  largest suffix IS the bound the emitter consumed. */
function maxOf(text: string, re: RegExp): string {
  let best = -1;
  for (const m of text.matchAll(re)) best = Math.max(best, Number(m[1]));
  return best < 0 ? "ABSENT" : String(best);
}

/** Every exponent applied in the program, in order (e.g. "3,3").
 *  A dropped or altered cube changes the list even when a sibling is intact. */
function exponents(text: string, re: RegExp): string {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1].trim());
  return out.length > 0 ? out.join(",") : "NONE";
}

/** SAS date literal '31DEC2020'd → ISO 2020-12-31, so the twins are comparable. */
const SAS_MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function sasDateToIso(lit: string | undefined): string | undefined {
  if (lit === undefined) return undefined;
  const m = /^'?(\d{2})([A-Z]{3})(\d{4})'?d?$/i.exec(lit.trim());
  if (!m) return lit;
  const mm = SAS_MONTHS[m[2].toUpperCase()];
  return mm ? `${m[3]}-${mm}-${m[1]}` : lit;
}

/** Day offset of an index-relative window bound, read from EITHER SQL dialect.
 *
 *  Postgres emits `x >= (c.index_date - 30)` and `x <= (c.index_date + 364)`;
 *  Snowflake emits `x >= DATEADD(day, -30, c.index_date)`. A zero offset has no
 *  arithmetic at all in Postgres (`x >= c.index_date`), which is why a single
 *  optional-group regex silently produced an empty string here — the bug this
 *  helper exists to remove. */
function sqlWindowOffset(sql: string, cmp: ">=" | "<="): string {
  const c = cmp === ">=" ? ">=" : "<=";
  const pg = new RegExp(`(?:admdate|svcdate)\\s*${c}\\s*\\(c\\.index_date\\s*([+-])\\s*(\\d+)\\)`, "i").exec(sql);
  if (pg) return String(pg[1] === "-" ? -Number(pg[2]) : Number(pg[2]));
  const sf = new RegExp(`(?:admdate|svcdate)\\s*${c}\\s*DATEADD\\(\\s*day\\s*,\\s*(-?\\d+)\\s*,`, "i").exec(sql);
  if (sf) return String(Number(sf[1]));
  const bare = new RegExp(`(?:admdate|svcdate)\\s*${c}\\s*c\\.index_date(?!\\s*[+-])`, "i").test(sql);
  return bare ? "0" : "ABSENT";
}

/** Date bounds inside the admin-censor expression, ISO, in order. */
function censorBoundsSql(sql: string): string {
  const line = sql.split("\n").find((l) => /AS admin_censor/i.test(l)) ?? "";
  return (line.match(/DATE\s*'(\d{4}-\d{2}-\d{2})'/g) ?? []).map((m) => m.slice(6, -1)).join(",");
}

/** SAS twin of the above; `&study_end.` is already macro-resolved by the caller. */
function censorBoundsSas(sas: string): string {
  const line = sas.split("\n").find((l) => /as admin_censor/i.test(l)) ?? "";
  return (line.match(/'\d{2}[A-Z]{3}\d{4}'d/g) ?? []).map((m) => sasDateToIso(m) ?? m).join(",");
}

/** Lower bound of a pre-index lookback, from either SQL dialect. */
function sqlLookbackOffset(sql: string): string {
  const pg = /event_date\s*>=\s*\(c\.index_date\s*([+-])\s*(\d+)\)/i.exec(sql);
  if (pg) return String(pg[1] === "-" ? -Number(pg[2]) : Number(pg[2]));
  const sf = /event_date\s*>=\s*DATEADD\(\s*day\s*,\s*(-?\d+)\s*,/i.exec(sql);
  if (sf) return String(Number(sf[1]));
  return /event_date\s*>=\s*c\.index_date(?!\s*[+-])/i.test(sql) ? "0" : "ABSENT";
}

/** SAS twin of the above. */
function sasLookbackOffset(sas: string): string {
  const m = /svcdate\s*>=\s*a\.index_date\s*([+-])\s*(\d+)/i.exec(sas);
  if (m) return String(m[1] === "-" ? -Number(m[2]) : Number(m[2]));
  return /svcdate\s*>=\s*a\.index_date(?!\s*[+-])/i.test(sas) ? "0" : "ABSENT";
}

/** SAS twin of the above: `a.index_date`, `a.index_date + 364`. */
function sasWindowOffset(expr: string | undefined): string {
  if (expr === undefined) return "ABSENT";
  const m = /index_date\s*([+-])\s*(\d+)/i.exec(expr);
  if (!m) return "0";
  return String(m[1] === "-" ? -Number(m[2]) : Number(m[2]));
}

/* ------------------------------------------------------------------ *
 *  Resource-use economics layer — shared normalizers
 *
 *  Attribution, the PPPM denominator, the CPI restatement and the quantile
 *  definition each change a number without changing the SHAPE of the output, so
 *  every one of them is scraped out of each language's own text and compared.
 *  The helpers live here rather than inline because the two languages emit the
 *  same facts in the same shape for once, and one implementation is one place
 *  for the pattern to be wrong in.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  DECLARED COARSENING and E-VALUES — shared scrapers
 *
 *  Both features are OPTIONAL, so the keys below are emitted for every
 *  analysis of a coarsenable kind and read "none"/"no" when the option was not
 *  asked for. That is deliberate: a key that appeared only when the feature was
 *  on would be absent in one twin and present in the other the moment one side
 *  stopped emitting it, and `MISSING vs no` is a weaker signal than `no vs yes`.
 * ------------------------------------------------------------------ */

/** The cut points a SQL band CASE actually compares against, in order.
 *
 *  Anchored on the age expression itself (`... AS DOUBLE PRECISION) < 50 THEN`)
 *  rather than on the band LABEL beside it. A label is a string the emitter
 *  writes twice; the comparison is what decides which band a subject lands in,
 *  and scraping the label would pass a program whose label said "<50" while its
 *  predicate said 55. */
function sqlBandCuts(sql: string): string {
  const out: string[] = [];
  for (const m of sql.matchAll(/AS DOUBLE PRECISION\)\s*<\s*(-?[\d.]+)\s+THEN\s+'/g)) out.push(m[1]);
  return out.length > 0 ? out.join(",") : "none";
}

/** SAS twin: the band assignment compares the ONE named value variable. */
function sasBandCuts(sas: string): string {
  const out: string[] = [];
  for (const m of sas.matchAll(/_band_val\s*<\s*(-?[\d.]+)\s+then\s+_c\d+\s*=\s*'/gi)) out.push(m[1]);
  return out.length > 0 ? out.join(",") : "none";
}

/** Coarsening keys both languages must agree on. */
function putBandingKeys(fp: Fingerprint, language: "sql" | "sas", text: string): void {
  put(fp, "banding_cut_points", language === "sql" ? sqlBandCuts(text) : sasBandCuts(text));
  /* MISSING IS ITS OWN BAND. Folding it into a numeric one invents a covariate
   * value, and the direction of the invention depends on which arm of the CASE
   * a NULL falls through to — which is why this is checked and not assumed. */
  put(fp, "banding_missing_is_own_band",
    language === "sql"
      ? (/IS NULL THEN 'Unknown'/.test(text) ? "yes" : /AS DOUBLE PRECISION\)\s*</.test(text) ? "no" : "none")
      : (/_band_val\s*=\s*\.\s*then\s+_c\d+\s*=\s*'Unknown'/i.test(text) ? "yes" : /_band_val\s*</i.test(text) ? "no" : "none"));
  put(fp, "band_occupancy_by_arm",
    /'band_1_treated'/.test(text) && /'band_1_control'/.test(text) ? "yes" : "no");
  put(fp, "coarsening_caution_emitted",
    /CONFOUNDING WITHIN A BAND IS UNCONTROLLED/.test(text) ? "yes" : "no");
}

/** E-value keys. The formula is the whole feature, so both branches of it are
 *  scraped separately: a program that kept the RR >= 1 arm and lost the
 *  reciprocal one is silently wrong for every protective effect. */
function putEValueKeys(fp: Fingerprint, language: "sql" | "sas", text: string): void {
  if (language === "sql") {
    put(fp, "evalue_point_formula", /THEN rr \+ SQRT\(rr \* \(rr - 1\)\)/.test(text) ? "yes" : /risk_ratio_e_value/.test(text) ? "no" : "none");
    put(fp, "evalue_reciprocal_formula",
      /ELSE 1\.0 \/ rr \+ SQRT\(\(1\.0 \/ rr\) \* \(1\.0 \/ rr - 1\)\)/.test(text) ? "yes" : /risk_ratio_e_value/.test(text) ? "no" : "none");
  } else {
    put(fp, "evalue_point_formula", /ifn\(_rr >= 1, _rr \+ sqrt\(_rr \* \(_rr - 1\)\)/i.test(text) ? "yes" : /risk_ratio_e_value/i.test(text) ? "no" : "none");
    put(fp, "evalue_reciprocal_formula",
      /1 \/ _rr \+ sqrt\(\(1 \/ _rr\) \* \(1 \/ _rr - 1\)\)/i.test(text) ? "yes" : /risk_ratio_e_value/i.test(text) ? "no" : "none");
  }
  put(fp, "evalue_include_limit", /'limit_e_value'/.test(text) ? "yes" : /risk_ratio_e_value/i.test(text) ? "no" : "none");
  /* A limit E-value of 1 printed bare reads as a small number on the same scale
   * as the point value beside it. The program must say what the 1 means. */
  put(fp, "evalue_crossing_is_explained",
    /COMPATIBLE WITH NO EFFECT/.test(text) ? "yes" : /'limit_e_value'/.test(text) ? "no" : "none");
}

/**
 * PROPENSITY-SCORE STRATIFICATION keys.
 *
 * Three of these exist because of a specific way the recipe goes wrong:
 *
 *  - NTILE. The saturated score is CONSTANT within a covariate cell, so
 *    NTILE(K) cuts through tied groups and which subject lands on each side
 *    depends on row arrival order. That is the same order-dependence that got
 *    greedy matching refused, and it is invisible in the output.
 *  - A ONE-ARM STRATUM CONTRIBUTING ZERO. Zero is a real effect estimate. It
 *    would be pooled as though it had been measured, and it would also enlarge
 *    the denominator — so the pooled number moves twice.
 *  - K REPORTED RATHER THAN FORMED. A program that printed "quintiles" while
 *    forming three would be describing something it did not build.
 */
function putStrataKeys(fp: Fingerprint, language: "sql" | "sas", text: string): void {
  const present = language === "sql" ? /'strata_formed'/.test(text) : /'strata_formed'/i.test(text);
  if (!present) {
    put(fp, "strata_requested", "none");
    put(fp, "strata_boundary_rule", "none");
    put(fp, "one_arm_stratum_contribution", "none");
    put(fp, "pooled_excludes_one_arm", "none");
    return;
  }
  if (language === "sql") {
    put(fp, "strata_requested", grab(text, [/FLOOR\(v\.n_below \* (\d+)\.0 \/ NULLIF\(t\.n_all, 0\)\)/]));
    put(fp, "strata_boundary_rule",
      /\bNTILE\s*\(/i.test(text) ? "ntile"
      : /FLOOR\(v\.n_below \* [\d.]+ \/ NULLIF\(t\.n_all, 0\)\) \+ 1/.test(text) ? "distinct_score_share"
      : "OTHER");
    put(fp, "one_arm_stratum_contribution",
      /ELSE NULL END AS diff/.test(text) ? "null" : /ELSE 0 END AS diff/.test(text) ? "zero" : "OTHER");
    put(fp, "pooled_excludes_one_arm",
      /SUM\(CASE WHEN diff IS NOT NULL THEN n_stratum ELSE 0 END\) AS n_pooled/.test(text) ? "yes" : "no");
  } else {
    put(fp, "strata_requested", grab(text, [/floor\(n_below \* (\d+) \//i]));
    put(fp, "strata_boundary_rule",
      /proc rank\b/i.test(text) || /\bgroups\s*=/i.test(text) ? "ntile"
      : /floor\(n_below \* \d+ \/ [^)]*\) \+ 1/i.test(text) ? "distinct_score_share"
      : "OTHER");
    put(fp, "one_arm_stratum_contribution",
      /else diff = \.;/i.test(text) ? "null" : /else diff = 0;/i.test(text) ? "zero" : "OTHER");
    put(fp, "pooled_excludes_one_arm",
      /sum\(ifn\(diff ne \., n_stratum, 0\)\) as n_pooled/i.test(text) ? "yes" : "no");
  }
}

/** Distinct claim columns a pattern names, sorted — e.g. "dx1,pdx".
 *  Sorted lexicographically to match the parity stamp's own flatten(). */
function claimColumns(text: string, re: RegExp): string {
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) seen.add(m[1].toLowerCase());
  return [...seen].sort().join(",");
}

/** Codes inside the FIRST matching IN-list, unquoted and sorted. */
function inListCodes(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return "";
  return m[1]
    .split(",")
    .map((s) => s.replace(/['\s]/g, ""))
    .filter((s) => s.length > 0)
    .sort()
    .join(",");
}

/** "2019:1.10250000,2020:1.05000000,..." — every restatement factor the program
 *  embeds, deduped (the CASE is repeated once per claim family) and ordered by
 *  year. A factor silently becoming 1.0 changes this string. */
function inflationFactors(text: string): string {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(/\bwhen (\d{4}) then ([\d.]+)/gi)) seen.set(m[1], m[2]);
  return [...seen.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([y, f]) => `${y}:${f}`).join(",");
}

/** The ELSE arms of every disease-related CASE, deduped. Correct code has one
 *  value, "0"; a mutation that attributes everything shows up as "1". */
function drDefaults(text: string): string {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\belse\s+(\d+)\s+end as dr\b/gis)) seen.add(m[1]);
  return [...seen].sort().join(",");
}

/* ------------------------------------------------------------------ *
 *  SQL extraction — patterns match the Postgres/Snowflake emission.
 * ------------------------------------------------------------------ */

function sqlFingerprint(kind: string, raw: string): Fingerprint {
  const sql = stripComments("sql", raw);
  const fp: Fingerprint = {};

  // NOTE: statistical constants are NOT fingerprinted here — the twins express
  // the same algebra with different structure (SQL inlines the Wilson radical
  // in both bounds; SAS computes it once into _rad and reuses it), so their
  // occurrence counts legitimately differ. They are checked per-language
  // against pinned counts instead — see constantProfile / EXPECTED_CONSTANTS.

  switch (kind) {
    case "incidence": {
      // rate_per_1000py = patients * <MULT> * <DPY> / person_days
      put(fp, "rate_multiplier", grab(sql, [/patients\s*\*\s*([\d.]+)\s*\*\s*[\d.]+\s*\/\s*NULLIF\(\s*person_days/i]));
      put(fp, "days_per_year", grab(sql, [/patients\s*\*\s*[\d.]+\s*\*\s*([\d.]+)\s*\/\s*NULLIF\(\s*person_days/i]));
      put(fp, "person_years_divisor", grab(sql, [/person_days\s*\/\s*([\d.]+)\s*(?:AS NUMERIC|,)/i]));
      // Both dialects: Postgres `index_date - 365`, Snowflake `DATEADD(day, -365, ...)`
      put(fp, "washout_lower_days", grab(sql, [/DATEADD\(\s*day\s*,\s*-(\d+)\s*,/i, /index_date\s*-\s*(\d+)\s*\)/i]));
      put(fp, "washout_includes_index", /event_date\s*<=\s*c\.index_date/i.test(sql) ? "yes" : "no");
      put(fp, "max_followup_days", grab(sql, [
        /DATEADD\(\s*day\s*,\s*(\d+)\s*,[^)]*\)\s*\)\s*AS admin_censor/i,
        /index_date\s*\+\s*(\d+)\s*\)\s*\)\s*AS admin_censor/i,
        /index_date\s*\+\s*(\d+)\s*\)/i,
      ]));
      put(fp, "strictly_after_index", /a\.event_date\s*>\s*c\.index_date/i.test(sql) ? "yes" : "no");
      /* Every DATE bound inside the admin-censor expression, in order. The data
       * cut lives here and nowhere else, which is how the SAS twin managed to
       * omit it while SQL applied it — the stamps agreed because neither
       * recorded it. */
      put(fp, "censor_bounds", censorBoundsSql(sql));
      // Byar exponents, in order — a single altered cube changes the list.
      put(fp, "byar_exponents", sqlPowerExponents(sql));
      /* SAS-PRIMARY contract: if the exact columns are present at all, SQL must
       * emit them as NULL. A SQL twin that computes a plausible-looking exact
       * limit is worse than one that omits it, because the number would be
       * wrong and labeled right. */
      if (/ci_low_exact/i.test(sql)) {
        put(fp, "exact_ci_null_in_sql",
          /CAST\(NULL AS [^)]*\)\s*AS ci_low_exact/i.test(sql) && /CAST\(NULL AS [^)]*\)\s*AS ci_high_exact/i.test(sql)
            ? "yes" : "no");
      }
      break;
    }
    case "cumulative_incidence": {
      put(fp, "horizon_days", grab(sql, [
        /event_date\s*<=\s*DATEADD\(\s*day\s*,\s*(\d+)\s*,/i, // snowflake
        /event_date\s*<=\s*\(?\s*c\.index_date\s*\+\s*(\d+)/i, // postgres
        /index_date\s*\+\s*(\d+)/i,
      ]));
      put(fp, "washout_includes_index", /event_date\s*<=\s*c\.index_date/i.test(sql) ? "yes" : "no");
      put(fp, "strictly_after_index", /a\.event_date\s*>\s*c\.index_date/i.test(sql) ? "yes" : "no");
      /* Every DATE bound inside the admin-censor expression, in order. The data
       * cut lives here and nowhere else, which is how the SAS twin managed to
       * omit it while SQL applied it — the stamps agreed because neither
       * recorded it. */
      put(fp, "censor_bounds", censorBoundsSql(sql));
      break;
    }
    case "point_prevalence": {
      put(fp, "anchor_date", grab(sql, [/DATE\s*'(\d{4}-\d{2}-\d{2})'\s*AS anchor_date/i]));
      put(fp, "anchor_is_index", /index_date\s+AS anchor_date/i.test(sql) ? "yes" : "no");
      put(fp, "case_on_or_before_anchor", /event_date\s*<=\s*den\.anchor_date/i.test(sql) ? "yes" : "no");
      // The date the denominator requires enrollment to cover must be the SAME
      // date the numerator anchors on — a drift here silently mismatches them.
      put(fp, "enrol_covers_date", grab(sql, [/DATE\s*'(\d{4}-\d{2}-\d{2})'\s+BETWEEN\s+ep\.episode_start/i]));
      break;
    }
    case "standardization": {
      // The DSR is SUM(w x rate)/SUM(w). Its truth is the WEIGHTS and the bands
      // they are attached to, so those are what get scraped — a swapped
      // reference population or a shifted band silently changes every rate.
      put(fp, "ref_weights", (sql.match(/\(\s*'[\d+-]+'\s*,\s*(\d+)\s*\)/g) ?? []).map((m) => (/(\d+)\s*\)/.exec(m) ?? [])[1]).join(","));
      put(fp, "ref_bands", (sql.match(/\(\s*'([\d+-]+)'\s*,\s*\d+\s*\)/g) ?? []).map((m) => (/'([\d+-]+)'/.exec(m) ?? [])[1]).join(","));
      put(fp, "covered_weight_pct", grab(sql, [/([\d.]+)\s+AS covered_weight_pct/i]));
      put(fp, "dsr_is_weighted_mean", /SUM\(weight \* COALESCE\(band_rate, 0\)\) \/ NULLIF\(SUM\(weight\), 0\)/i.test(sql) ? "yes" : "no");
      put(fp, "ci_is_sas_primary", /CAST\(NULL AS NUMERIC\) AS ci_low/i.test(sql) ? "yes" : "no");
      break;
    }
    case "smd_balance": {
      // SMD must use SAMPLE variance and the pooled (halved-sum) denominator;
      // a switch to population variance changes every balance number quietly.
      put(fp, "sample_variance", /VAR_SAMP\(/i.test(sql) ? "yes" : "no");
      put(fp, "pooled_halved_denominator", /\/\s*2\.0\s*\)/.test(sql) ? "yes" : "no");
      // anchored on "> <thr> THEN 1": the ABS() argument contains nested parens,
      // so matching inside it needs balancing (same trap as POWER above)
      put(fp, "imbalance_threshold", grab(sql, [/>\s*([\d.]+)\s*THEN 1/i]));
      put(fp, "reference_arm", grab(sql, [/IN \('([^']+)',/i]));
      /* WHICH column each covariate's moments are taken from, in order. A
       * second CONTINUOUS covariate (the comorbidity index) can silently reuse
       * age's column if the emitter keys on the measure instead of the axis —
       * the table then reports age's SMD twice under two different labels. */
      put(fp, "covariate_columns",
        [...sql.matchAll(/AVG\(CASE WHEN arm = '[^']*' THEN (\w+) END\) AS m_ref/g)].map((m) => m[1]).join(","));
      /* When this table scores a comorbidity index, it must apply the SAME
       * hierarchy the index analysis applies. Dropping it here alone would put
       * two different comorbidity means in one deliverable. */
      if (/weight_applied/i.test(sql))
        put(fp, "cci_hierarchy_withholds", /THEN 0 ELSE cd\.weight END AS weight_applied/i.test(sql) ? "yes" : "no");
      break;
    }
    case "regression": {
      /* The model IS its design. A shifted horizon, a flipped reference level or
       * a lost washout each produce a complete, plausible odds ratio for a
       * different question. */
      put(fp, "horizon_days", grab(sql, [
        /fu_date <= DATEADD\(\s*day\s*,\s*(\d+)\s*,/i,
        /fu_date <= \(s\.index_date \+ (\d+)\)/i,
        // recurrent-count feeder bounds the EVENTS, not a first-event date
        /a\.event_date <= DATEADD\(\s*day\s*,\s*(\d+)\s*,/i,
        /a\.event_date <= \(c\.index_date \+ (\d+)\)/i,
      ]));
      put(fp, "response_is_count", /COUNT\(DISTINCT a\.event_date\) AS n_events/i.test(sql) ? "yes" : "no");
      /* Cost family. The response is a ledger total, the closed form is a ratio
       * of arm MEANS, and zero-cost subjects are excluded because a gamma
       * response must be strictly positive. */
      if (/COALESCE\(cp\.cost, 0\) AS y/i.test(sql)) {
        put(fp, "cost_ratio_is_mean_over_mean",
          /LN\(\(a_ee \* 1\.0 \/ b_en\) \/ \(c_ue \* 1\.0 \/ d_un\)\)/i.test(sql) ? "yes" : "no");
        put(fp, "gamma_excludes_zero_cost", /AND y > 0 THEN y ELSE 0 END\) AS a_ee/i.test(sql) ? "yes" : "no");
        put(fp, "crude_interval_is_delta_method", /'delta_method_ratio_of_means'/i.test(sql) ? "yes" : "no");
      }
      put(fp, "exposed_level", grab(sql, [/WHEN s\.arm = '([^']+)' THEN 1/i, /WHEN s\.index_code = '([^']+)' THEN 1/i]));
      put(fp, "arm_levels", (sql.match(/s\.arm IN \('([^']+)', '([^']+)'\)/i) ?? []).slice(1).join(","));
      // 2x2 cell definitions — an inverted cell silently inverts the estimate.
      /* A COUNT response has no "non-event" cell: a_ee is the SUM of counts,
       * not a tally of subjects. Checking it against the indicator algebra
       * would fail a correct program. */
      /* OLS: BOTH the coefficient and its SE are closed form here, which is
       * true of no other family, so both are fingerprinted. */
      if (/COALESCE\(rp\.score, 0\) AS DOUBLE PRECISION\) AS y/i.test(sql)) {
        put(fp, "ols_diff_of_means", /\(m_exp - m_unexp\) AS mean_diff/i.test(sql) ? "yes" : "no");
        put(fp, "ols_pooled_se",
          /\(\(b_en - 1\) \* v_exp \+ \(d_un - 1\) \* v_unexp\)/i.test(sql) && /1\.0\/NULLIF\(b_en, 0\) \+ 1\.0\/NULLIF\(d_un, 0\)/i.test(sql) ? "yes" : "no");
        put(fp, "ols_interval_is_normal_approx", /'wald_normal_approx_pooled_sd'/i.test(sql) ? "yes" : "no");
      }
      if (/COALESCE\(cp\.cost, 0\) AS y/i.test(sql)) {
        put(fp, "cell_a", /SUM\(CASE WHEN exposed = 1 AND y > 0 THEN y ELSE 0 END\) AS a_ee/i.test(sql) ? "yes" : "no");
        put(fp, "cell_d", /SUM\(CASE WHEN exposed = 0 AND y > 0 THEN 1 ELSE 0 END\) AS d_un/i.test(sql) ? "yes" : "no");
      } else if (/COUNT\(DISTINCT a\.event_date\)/i.test(sql)) {
        put(fp, "cell_a", /SUM\(CASE WHEN exposed = 1 THEN y ELSE 0 END\) AS a_ee/i.test(sql) ? "yes" : "no");
        put(fp, "cell_d", /SUM\(CASE WHEN exposed = 0 THEN 1 ELSE 0 END\) AS d_un/i.test(sql) ? "yes" : "no");
      } else {
        put(fp, "cell_a", /SUM\(CASE WHEN exposed = 1 AND y = 1 THEN 1 ELSE 0 END\) AS a_ee/i.test(sql) ? "yes" : "no");
        put(fp, "cell_d", /SUM\(CASE WHEN exposed = 0 AND y = 0 THEN 1 ELSE 0 END\) AS d_un/i.test(sql) ? "yes" : "no");
      }
      put(fp, "log_or_is_cross_product", /LN\(\(a_ee \* 1\.0 \* d_un\) \/ \(b_en \* 1\.0 \* c_ue\)\)/i.test(sql) ? "yes" : "no");
      put(fp, "woolf_se", /SQRT\(1\.0\/a_ee \+ 1\.0\/b_en \+ 1\.0\/c_ue \+ 1\.0\/d_un\)/i.test(sql) ? "yes" : "no");
      /* A zero cell must yield NULL, never a continuity-corrected number: a
       * correction changes the estimand, and applying one silently is how a
       * study reports an estimate nobody chose. */
      put(fp, "zero_cell_returns_null", /CASE WHEN b_en > 0 AND c_ue > 0 AND a_ee > 0 AND d_un > 0/i.test(sql) ? "yes" : "no");
      put(fp, "model_terms", (sql.match(/SELECT 'adjusted', '([^']*)'/g) ?? []).map((m) => (/'adjusted', '([^']*)'/.exec(m) ?? [])[1]).join(","));
      // the effect the coefficient IS — a Poisson coefficient labelled
      // "odds_ratio" reads as correct and is not
      put(fp, "effect_statistic", grab(sql, [/SELECT 'adjusted', '[^']*', '(\w+)'/i]));
      /* Count families only. The offset is what makes the model a RATE model;
       * without it the same coefficients describe counts. */
      if (/person_days/i.test(sql)) {
        put(fp, "rate_ratio_is_rate_over_rate",
          /LN\(\(a_ee \* 1\.0 \/ pt_exp\) \/ \(c_ue \* 1\.0 \/ pt_unexp\)\)/i.test(sql) ? "yes" : "no");
        put(fp, "poisson_se_uses_events_only",
          /SQRT\(1\.0\/a_ee \+ 1\.0\/c_ue\)/i.test(sql) ? "yes" : "no");
        put(fp, "offset_censor_bounds", censorBoundsSql(sql));
        /* Whether the clock STOPS at the first event. Combined with a count
         * response this is incoherent — later events could never be observed —
         * and nothing else in the fingerprint could see it. */
        put(fp, "offset_censors_at_outcome",
          /LEAST\(COALESCE\(fu_date, DATE '9999-12-31'\), admin_censor\)/i.test(sql) ? "yes" : "no");
      }
      // SAS-PRIMARY (language-local): the fitted estimates must be NULL here.
      put(fp, "adjusted_null_in_sql",
        /SELECT 'adjusted', '[^']*', '\w+', \d+, CAST\(NULL AS NUMERIC\)/i.test(sql) ? "yes" : "no");
      break;
    }
    case "survival": {
      /* A KAPLAN-MEIER CURVE IS ITS RISK SETS. Every classic way to get this
       * wrong produces a complete, plausible, monotone curve for a different
       * question, so the scrapes below target the exact arithmetic rather than
       * the shape of the output. */
      put(fp, "horizon_days", (sql.match(/SELECT (\d+) AS horizon/g) ?? []).map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      put(fp, "ci_method", grab(sql, [/'km_(log_log|linear)'/i]));
      /* THE RISK SET BOUNDARY. `>=` includes the subjects whose event is AT t,
       * which is the whole point - they are at risk right up to the instant
       * they fail. A `>` drops them from their own denominator and inflates
       * every survival probability, and nothing about the resulting curve looks
       * wrong. */
      put(fp, "risk_set_includes_t", count(sql, /s\.t >= e\.t/g));
      put(fp, "product_limit_factor", /\(n_risk - n_event\) \* 1\.0 \/ n_risk/i.test(sql) ? "yes" : "no");
      put(fp, "greenwood_term", /n_event \* 1\.0 \/ \(n_risk \* \(n_risk - n_event\)\)/i.test(sql) ? "yes" : "no");
      /* Follow-up must stop at the endpoint. Readiness requires it, but the
       * emitter could still drop the term, and then every survival time would
       * be the administrative one while the event flags stayed set. */
      put(fp, "time_stops_at_event", /LEAST\(COALESCE\(fu_date, DATE '9999-12-31'\), admin_censor\)/i.test(sql) ? "yes" : "no");
      put(fp, "censor_bounds", censorBoundsSql(sql));
      /* The MEDIAN's tolerance, scraped as a value rather than a yes/no: it is
       * what makes the two twins agree on a curve that lands exactly on one
       * half, and a silently widened one would start moving medians. */
      put(fp, "median_tolerance", grab(sql, [/surv <= 0\.5 \+ (\S+?)\s/i]));
      if (/'km_log_log'/i.test(sql)) {
        /* THE SIGN THAT READS BACKWARDS. A larger exponent on a number below 1
         * gives a SMALLER value, so +z belongs on the LOWER limit. Swapping
         * them yields an interval that is still inside [0,1] and still
         * contains the estimate - it is simply inverted. */
        put(fp, "loglog_lower_uses_plus_z", /POWER\(surv, EXP\(1\.96 \* \(SQRT\(gw\) \/ ABS\(LN\(surv\)\)\)\)\) END AS ci_low/i.test(sql) ? "yes" : "no");
        put(fp, "loglog_upper_uses_minus_z", /POWER\(surv, EXP\(-1\.96 \* \(SQRT\(gw\) \/ ABS\(LN\(surv\)\)\)\)\) END AS ci_high/i.test(sql) ? "yes" : "no");
      } else {
        put(fp, "linear_ci_is_clamped", /GREATEST\(0\.0, surv - 1\.96/i.test(sql) && /LEAST\(1\.0, surv \+ 1\.96/i.test(sql) ? "yes" : "no");
      }
      if (/lrsum/i.test(sql)) {
        put(fp, "exposed_level", grab(sql, [/WHEN arm = '([^']+)' THEN 1/i]));
        put(fp, "arm_levels", (sql.match(/arm IN \('([^']+)', '([^']+)'\)/i) ?? []).slice(1).join(","));
        put(fp, "logrank_expected_is_hypergeometric", /d \* 1\.0 \* n1 \/ NULLIF\(n, 0\)/i.test(sql) ? "yes" : "no");
        /* THE TIE CORRECTION. (n-d)/(n-1) is 1 whenever d = 1, so no fixture
         * with distinct event times can tell a correct implementation from one
         * that dropped it. It is pinned here precisely because execution
         * cannot reach it. */
        put(fp, "logrank_tie_correction", /d \* 1\.0 \* \(n - d\) \* n1 \* \(n - n1\) \/ \(n \* 1\.0 \* n \* \(n - 1\)\)/i.test(sql) ? "yes" : "no");
        put(fp, "logrank_critical_value", grab(sql, [/> ([\d.]+) THEN 1 ELSE 0 END/i]));
        put(fp, "peto_log_hr", /\(o_exp - e_exp\) \/ NULLIF\(v_exp, 0\)/i.test(sql) ? "yes" : "no");
        /* SAS-PRIMARY (language-local): the p-value's ESTIMATE must be NULL.
         *
         * This pattern is anchored on the estimate SLOT, not merely near the
         * p_value label, and that precision was earned. The first version
         * looked for any CAST(NULL AS NUMERIC) within 200 characters of
         * 'p_value' — which a populated estimate still satisfies, because the
         * ci_low/ci_high/se columns beside it are NULL either way. Mutation
         * testing filled the estimate with 0.05 and the check stayed green: it
         * was proving that a NULL existed somewhere nearby, not that the number
         * SQL must not invent was absent. */
        put(fp, "logrank_p_null_in_sql",
          /CAST\('p_value' AS VARCHAR\),\s*\n\s*CAST\(\d+ AS INT\),(?:\s*CAST\(NULL AS INT\),)+\s*\n\s*CAST\(NULL AS NUMERIC\)/i.test(sql) ? "yes" : "no");
      }
      /* ---- THE EXTERNAL MORTALITY LINKAGE ----
       *
       * Two of these are the whole feature and the rest are supporting: the
       * risk set must be the LINKED SUBSET, and follow-up must stop at the
       * ASCERTAINMENT DATE. Both corruptions leave a complete, plausible curve
       * that is biased UPWARD, which is exactly the failure mode the DSTATUS
       * refusal exists to prevent — so both are scraped from the expression
       * that implements them, not from a label near it. */
      if (/AS linked_flag/i.test(sql)) {
        const src = /SELECT enrolid, (\w+) AS death_date, (\w+) AS linked_flag\s*\n\s*FROM ([\w.]+)/i.exec(sql);
        put(fp, "mortality_death_column", src?.[1]);
        put(fp, "mortality_linked_flag_column", src?.[2]);
        put(fp, "mortality_linkage_table", src?.[3]);
        /* THE RISK SET. Anchored on BOTH halves: the linked-flag predicate that
         * builds the subset, and the atrisk CTE that reads it. Dropping either
         * one alone puts the unlinked members back into the denominator. */
        put(fp, "mortality_linked_predicate",
          /JOIN mlink m ON m\.enrolid = c\.enrolid\s*\n\s*WHERE CAST\(m\.linked_flag AS VARCHAR\) IN \(/i.test(sql) ? "yes" : "no");
        put(fp, "mortality_risk_set_is_linked_subset",
          /atrisk AS \(\s*SELECT enrolid, index_date FROM mcov/i.test(sql) ? "yes" : "no");
        /* THE ASCERTAINMENT DATE, twice and from two different places: the
         * administrative censor (which decides the curve) and the attrition
         * row (which reports it). They must agree, and the cross-language diff
         * plus the stamp check together pin both. Anchored on the
         * `) AS admin_censor` slot rather than on any DATE literal nearby —
         * a censoring plan legitimately carries several. */
        put(fp, "mortality_censor_at_ascertainment",
          grab(sql, [/, DATE '(\d{4}-\d{2}-\d{2})'\) AS admin_censor/i]));
        put(fp, "mortality_ascertained_through",
          grab(sql, [/AND k\.death_date <= DATE '(\d{4}-\d{2}-\d{2})' THEN 1 ELSE 0 END\) AS n_deaths/i]));
        put(fp, "mortality_attrition_row",
          /AS n_linked/i.test(sql) && /AS n_unlinked/i.test(sql) && /unlinked_excluded_from_risk_set/i.test(sql) ? "yes" : "no");
      }
      break;
    }
    case "treatment_switching": {
      /* Every scrape here is an expression whose corruption still yields a
       * switch rate between 0% and 100%. That is the module's only failure
       * mode: there is no impossible value to notice. */
      put(fp, "from_source_in_sql", grab(sql, [/f\.code_list_id = '([^']+)'\n?/i]));
      put(fp, "to_list_in_sql", (sql.match(/f\.code_list_id IN \(([^)]*)\)/i) ?? [])[1]?.replace(/['\s]/g, "") ?? "ABSENT");
      /* THE OFF-BY-ONE, which decides P4 in Gold Case G. */
      put(fp, "from_last_day_is_supply_minus_one", /\+ f\.days_supply - 1 AS d_end/i.test(sql) ? "yes" : "no");
      /* STRICTLY AFTER INDEX: a to-drug on day 0 is the starting regimen. */
      put(fp, "new_drug_strictly_after_index", /WHERE d_start > 0 AND/i.test(sql) ? "yes" : "no");
      /* THE OVERLAP DEFINITION and its floor. */
      put(fp, "overlap_is_remaining_supply",
        /GREATEST\(COALESCE\(fc\.from_last_day, t\.to_day - 1\) - t\.to_day \+ 1, 0\)/i.test(sql) ? "yes" : "no");
      put(fp, "permissible_overlap_days", grab(sql, [/overlap_days <= (\d+)\n?\s*THEN 1 ELSE 0 END AS switched/i]));
      /* THE BAND. Deleting either bound leaves a program that still reports a
       * switch count and no longer says how much the rule decided. */
      put(fp, "strict_bound_emitted", /overlap_days <= 0 THEN 1 ELSE 0 END AS switched_strict/i.test(sql) ? "yes" : "no");
      put(fp, "loose_bound_emitted", /END AS switched_loose/i.test(sql) ? "yes" : "no");
      put(fp, "reclassification_reported", /reclassified_by_overlap_rule/i.test(sql) ? "yes" : "no");
      /* ADD-ON kept distinct from switching. */
      put(fp, "add_on_kept_distinct", /overlap_days > (\d+)\n?\s*THEN 1 ELSE 0 END AS add_on/i.test(sql) ? "yes" : "no");
      /* LINE OF THERAPY, and the row that says it is definitional. */
      put(fp, "line_rule", grab(sql, [/under the DECLARED rule \((\w+)\)/i]));
      put(fp, "line_definitional_row", /DEFINITIONAL, NOT MEASURED/i.test(sql) ? "yes" : "no");
      put(fp, "line_estimate_is_null", /CAST\(NULL AS NUMERIC\) AS estimate[\s\S]{0,200}DEFINITIONAL/i.test(sql) || /rule_is_definitional/i.test(sql) ? "yes" : "no");
      put(fp, "days_supply_cap", grab(sql, [/days_supply IS NULL OR days_supply <= (\d+)\)/i]));
      /* ---- THE FULL REGIMEN CONSTRUCTION (lineRule "declared_regimen") ----
       *
       * Emitted only on that rule, so the keys are PUT only when the program
       * actually contains it — a key set that appeared unconditionally would
       * read ABSENT on every two-line program and turn the cross-language diff
       * into noise. Every pattern below is anchored on an expression that
       * exists nowhere else in the program: this module already carries a
       * `f.code_list_id IN (...)` for the to-drug list, and a pattern loose
       * enough to match either would scrape the wrong drug set while looking
       * entirely healthy (see the days_supply_cap and condition_weights
       * comments for two earlier instances of exactly that). */
      if (/lot_agw AS \(/i.test(sql)) {
        put(fp, "lot_agents", grab(sql, [/SELECT c\.enrolid, f\.code_list_id AS agent,[\s\S]{0,500}?f\.code_list_id IN \(([^)]*)\)/i])?.replace(/['\s]/g, ""));
        /* ONE OCCURRENCE PER LINE, all joined. The construction is unrolled to
         * maxLines, so these also pin the unroll count. */
        put(fp, "lot_combination_window_days", allOf(sql, /WHERE r\.agent_first <= o\.t \+ (\d+)/gi));
        put(fp, "lot_gap_days", allOf(sql, /WHERE g_len >= (\d+) GROUP BY enrolid/gi));
        put(fp, "lot_advance_trigger", allOf(sql, /WHERE (is_sub = 1|is_sub IN \(0, 1\)) GROUP BY enrolid/gi)
          .split(",").map((t) => (t === "is_sub = 1" ? "substitution" : "addition_or_substitution")).join(","));
        /* THE UNROLL BOUND, read off the per-line island-merge CTEs.
         *
         * NOT off `lot_x<k> AS (`: the construction also emits `lot_x<k>0` (the
         * pre-NULL close), so `lot_x(\d+)` reads "30" from `lot_x30` and the
         * bound comes back as thirty. That is the loose-pattern failure this
         * file keeps re-learning — the merge CTEs have no `<k>0` sibling. */
        put(fp, "lot_max_lines", maxOf(sql, /lot_m(\d+) AS \(/gi));
        /* THE REGIMEN RULE ITSELF. Each of these is an expression whose
         * corruption still yields a line distribution between 1 and maxLines. */
        put(fp, "lot_merge_uses_running_max",
          String((sql.match(/MAX\(d_end\) OVER \(PARTITION BY enrolid ORDER BY d_start, d_end/gi) ?? []).length));
        put(fp, "lot_substitution_is_coverage_based",
          /CASE WHEN v\.n_cov < z\.n_reg THEN 1 ELSE 0 END AS is_sub/i.test(sql) ? "yes" : "no");
        put(fp, "lot_next_line_opens_at_close",
          /JOIN lot_agw a ON a\.enrolid = x\.enrolid AND a\.d_start >= x\.close_day/i.test(sql) ? "yes" : "no");
        put(fp, "lot_truncation_reported",
          /lot_trunc AS \(/i.test(sql) && /patients_truncated_at_max_lines/i.test(sql) ? "yes" : "no");
        /* PPPM BY LINE. The denominator is the whole argument for the feature,
         * so both the per-line clip and the days-per-month literal are pinned. */
        put(fp, "lot_cost_denominator_is_line_span",
          /LEAST\(l\.line_end, /i.test(sql) && /GREATEST\(l\.line_start, /i.test(sql) ? "yes" : "no");
        put(fp, "lot_days_per_month", allOf(sql, /elig_days \/ ([\d.]+)/gi));
        put(fp, "lot_cost_on_eligible_time_only",
          /SUM\(CASE WHEN e\.elig = 1 THEN e\.paid ELSE 0 END\)/i.test(sql) ? "yes" : "no");
      }
      break;
    }
    case "adherence": {
      /* Adherence is arithmetic on intervals, so every scrape here is an
       * expression whose corruption still yields a PDC between 0 and 1. A
       * plausible wrong number is the only failure mode this module has. */
      /* THE SOURCE TABLE. The SQL twin reads the long fills feeder and narrows
       * it with a predicate; the SAS twin reads a per-code-list table. The
       * PARITY stamp cannot check that split (it is compared for strict
       * equality), so it is checked here, from each twin's own text. This is
       * also the scrape that would have caught the module naming a `020_rx`
       * table that no emitter creates. */
      put(fp, "fills_source_in_sql", grab(sql, [/JOIN (\w+_fills) f ON/i]));
      put(fp, "fills_selected_by_code_list_in_sql", grab(sql, [/f\.code_list_id = '([^']+)'/i]));
      /* THE OFF-BY-ONE, worth one day of PDC per fill. */
      put(fp, "interval_end_is_supply_minus_one", /\+ days_supply - 1/i.test(sql) ? "yes" : "no");
      /* THE MERGE. Running max of prior ends, never LAG — a nested fill would
       * otherwise open a spurious island and inflate the gap count. */
      put(fp, "merge_uses_running_max",
        /MAX\(d_end\) OVER \(PARTITION BY enrolid ORDER BY d_start, d_end/i.test(sql) ? "yes" : "no");
      put(fp, "merge_avoids_lag", /LAG\(d_end\)/i.test(sql) ? "NO_LAG_PRESENT" : "yes");
      /* STOCKPILING in closed form: a running MAX plus a running SUM. */
      put(fp, "stockpile_closed_form",
        /MAX\(d_start - \(t_cum - days_supply\)\) OVER/i.test(sql) ? "yes" : "no");
      put(fp, "stockpile_cumulative_supply",
        /SUM\(days_supply\) OVER[^)]*ROWS UNBOUNDED PRECEDING\) AS t_cum/i.test(sql) ? "yes" : "no");
      /* THE DENOMINATOR both measures divide by. */
      put(fp, "pdc_denominator", grab(sql, [/covered \* 1\.0 \/ (\d+) AS pdc/i]));
      put(fp, "mpr_denominator", grab(sql, [/dispensed \* 1\.0 \/ (\d+) AS mpr/i]));
      /* THE MPR GUARD. Without GREATEST(...,0) a negative clipped span
       * subtracts from days dispensed, MPR can fall below PDC, and the
       * identity row reports a broken merge about a merge that is fine. */
      put(fp, "mpr_numerator_guarded",
        /SUM\(GREATEST\(LEAST\(d_end, -?\d+\) - GREATEST\(d_start, -?\d+\) \+ 1, 0\)\) AS dispensed/i.test(sql) ? "yes" : "no");
      put(fp, "adherence_threshold", grab(sql, [/pdc >= ([\d.]+) THEN 1 ELSE 0 END\) AS n_adherent/i]));
      put(fp, "permissible_gap", grab(sql, [/gap of at least (\d+) uncovered days/i]));
      /* CLEANING, and that its drops are COUNTED rather than silent. */
      put(fp, "days_supply_cap", grab(sql, [/days_supply IS NULL OR days_supply <= (\d+)\)/i]));
      put(fp, "drops_missing_supply", /days_supply IS NOT NULL/i.test(sql) ? "yes" : "no");
      put(fp, "fill_attrition_counted", /AS n_raw,/i.test(sql) && /AS n_kept/i.test(sql) ? "yes" : "no");
      /* THE IDENTITY ROW and the CENSORING split, both of which can be deleted
       * while leaving a program that still produces every number. */
      put(fp, "identity_row_emitted", /patients_with_pdc_above_mpr/i.test(sql) ? "yes" : "no");
      put(fp, "censoring_kept_distinct", /COUNT\(\*\) - SUM\(discontinued\) AS n_censored/i.test(sql) ? "yes" : "no");
      put(fp, "stockpile_reclassification_reported", /reclassified_by_stockpiling/i.test(sql) ? "yes" : "no");
      break;
    }
    case "cox": {
      /* A Cox model is its RISK SETS and its likelihood. Every scrape below is
       * an expression whose corruption still yields a plausible hazard ratio. */
      put(fp, "exposed_level", grab(sql, [/WHEN arm = '([^']+)' THEN 1 ELSE 0 END AS exposed/i]));
      put(fp, "arm_levels", (sql.match(/arm IN \('([^']+)', '([^']+)'\)/i) ?? []).slice(1).join(","));
      put(fp, "risk_set_includes_t", count(sql, /s\.t >= e\.t/g));
      put(fp, "time_stops_at_event", /LEAST\(COALESCE\(fu_date, DATE '9999-12-31'\), admin_censor\)/i.test(sql) ? "yes" : "no");
      put(fp, "censor_bounds", censorBoundsSql(sql));
      /* THE SCORE. Corrupting it to SUM(d1) alone, or to the wrong margin,
       * produces a number with the right units and the wrong meaning. */
      put(fp, "score_is_o_minus_e",
        /SUM\(d1\) - SUM\(d \* 1\.0 \* n1 \/ NULLIF\(n, 0\)\) AS score_u0/i.test(sql) ? "yes" : "no");
      /* BRESLOW INFORMATION, which is NOT the log-rank variance: it has no
       * (n-d)/(n-1) factor. Substituting one for the other is invisible on any
       * fixture without a tied event time, which is why Gold Case C exists. */
      put(fp, "information_is_breslow",
        /SUM\(d \* 1\.0 \* n1 \* \(n - n1\) \/ NULLIF\(n \* 1\.0 \* n, 0\)\) AS information0/i.test(sql) ? "yes" : "no");
      put(fp, "null_loglik_form", /-SUM\(d \* LN\(n\)\) AS loglik0/i.test(sql) ? "yes" : "no");
      put(fp, "logrank_variance_emitted_beside", /'logrank_variance'/i.test(sql) ? "yes" : "no");
      put(fp, "one_step_is_u_over_i", /score_u0 \/ NULLIF\(information0, 0\)/i.test(sql) ? "yes" : "no");
      /* Anchored on the information0 guard, not on a bare "> n THEN 1": the
       * tied-event-time counter is written `CASE WHEN d > 1 THEN 1 ELSE 0 END`
       * and matched first, so the loose pattern reported the critical value as
       * "1" on a perfectly correct program. */
      put(fp, "score_critical_value", grab(sql, [/NULLIF\(information0, 0\) > ([\d.]+) THEN 1 ELSE 0 END/i]));
      /* THE ANCHOR and its two guards. A closed form emitted when the
       * proportion is NOT constant would be a wrong number; one emitted under
       * complete separation would be a finite stand-in for an infinite
       * estimate. */
      put(fp, "anchor_requires_constant_proportion",
        /ABS\(c\.p_max - c\.p_min\) < 1e-12/i.test(sql) ? "yes" : "no");
      put(fp, "anchor_guards_separation",
        /c\.d1_exposed > 0 AND c\.d1_exposed < c\.d_total/i.test(sql) ? "yes" : "no");
      put(fp, "anchor_closed_form",
        /\/ \(c\.p_min \/ \(1 - c\.p_min\)\)/i.test(sql) ? "yes" : "no");
      put(fp, "model_terms", [...sql.matchAll(/CAST\('adjusted' AS VARCHAR\) AS component, CAST\('([^']*)' AS VARCHAR\) AS term/g)].map((m) => m[1]).join(","));
      // SAS-PRIMARY (language-local): the fitted coefficient must be NULL here.
      /* EVERY adjusted estimate must be NULL, counted — not "some adjusted row
       * has a NULL estimate somewhere".
       *
       * The first version looked for one matching row, and a mutation that
       * filled in only the FIRST of three adjusted rows left it green: the
       * regex simply found one of the two that were still NULL. The contract
       * is universal, so the check counts. (This is the third time a
       * single-occurrence pattern has hidden a partial corruption in this repo
       * — the D3 spine mutation and the OLS pooled variance were the others.) */
      {
        const adjusted = [...sql.matchAll(/CAST\('adjusted' AS VARCHAR\) AS component,[\s\S]{0,240}?CAST\(\d+ AS INT\) AS ord,\s*\n\s*(\S+[^\n]*?) AS estimate/g)];
        put(fp, "cox_fit_null_in_sql",
          adjusted.length > 0 && adjusted.every((m) => m[1] === "CAST(NULL AS NUMERIC)") ? "yes" : "no");
      }
      break;
    }
    case "competing_risks": {
      /* The estimator is three decisions, and every one of them has a wrong
       * version that still produces a monotone curve between 0 and 1. */
      put(fp, "causes", (sql.match(/SELECT enrolid, event_date, (\d+) AS cause/g) ?? [])
        .map((m) => (/(\d+) AS cause/.exec(m) ?? [])[1]).join(","));
      put(fp, "cause_lists", (sql.match(/WHERE code_list_id = '([^']+)'/g) ?? [])
        .map((m) => (/'([^']+)'/.exec(m) ?? [])[1]).join(","));
      /* THE RISK SET IS ALL-CAUSE. Restricting it to the cause in hand is the
       * standard way to write this wrong, and it reproduces exactly the 1 - KM
       * bias the estimator exists to remove — while leaving a curve that looks
       * entirely reasonable. */
      put(fp, "risk_set_is_all_cause",
        /SUM\(CASE WHEN s\.t = e\.t AND s\.cause > 0 THEN 1 ELSE 0 END\) AS d_all/i.test(sql) ? "yes" : "no");
      /* THE WEIGHT IS S AT THE PREVIOUS EVENT TIME, not at this one. Using the
       * current S understates every cumulative incidence by one factor. */
      put(fp, "weight_is_s_prev",
        /SUM\(s_prev \* d_\d+ \* 1\.0 \/ NULLIF\(n_risk, 0\)\)/i.test(sql) ? "yes" : "no");
      put(fp, "s_prev_lags_one_row",
        /ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING/i.test(sql) ? "yes" : "no");
      /* FIRST EVENT OF ANY CAUSE, from one union — per-cause firsts combined
       * afterwards is how a subject contributes to two causes at once. */
      put(fp, "first_event_is_any_cause",
        /ORDER BY a\.event_date, a\.cause\) AS rn/i.test(sql) ? "yes" : "no");
      put(fp, "variance_three_terms", String(
        (/POWER\(a\.cif_\d+ - b\.cif_\d+, 2\)/i.test(sql) ? 1 : 0) +
        (/POWER\(b\.s_prev, 2\)/i.test(sql) ? 1 : 0) +
        (/- 2 \* SUM\( \(a\.cif_\d+ - b\.cif_\d+\) \* b\.s_prev/i.test(sql) ? 1 : 0)));
      put(fp, "naive_treats_competing_as_censored",
        /SUM\(CASE WHEN s\.t = e\.t AND s\.cause = \d+ THEN 1 ELSE 0 END\) AS d_k/i.test(sql) ? "yes" : "no");
      /* The COMPARISON, not the verdict string. This check is unusual in that
       * it SHIPS WITH THE RESULT — nobody downstream re-derives it — so a
       * version that always prints HOLDS is worse than none at all. Testing for
       * the HOLDS text alone passed exactly that mutation. */
      put(fp, "identity_row_emitted",
        /ABS\(\(cif_\d+(?: \+ cif_\d+)*\) - \(1\.0 - surv_all\)\) < 1e-9/i.test(sql) &&
        /HOLDS: the causes partition/i.test(raw) ? "yes" : "no");
      put(fp, "bias_row_emitted", /'bias'/i.test(sql) ? "yes" : "no");
      put(fp, "interval_is_clamped",
        /GREATEST\(0\.0, cif_\d+ - 1\.96/i.test(sql) && /LEAST\(1\.0, cif_\d+ \+ 1\.96/i.test(sql) ? "yes" : "no");
      put(fp, "horizons", (sql.match(/SELECT (\d+) AS horizon/g) ?? [])
        .map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      put(fp, "censor_bounds", censorBoundsSql(sql));
      break;
    }
    case "fine_gray": {
      put(fp, "causes", (sql.match(/SELECT enrolid, event_date, (\d+) AS cause/g) ?? [])
        .map((m) => (/(\d+) AS cause/.exec(m) ?? [])[1]).join(","));
      put(fp, "exposed_level", grab(sql, [/WHEN arm = '([^']+)' THEN 1 ELSE 0 END AS exposed/i]));
      put(fp, "arm_levels", (sql.match(/arm IN \('([^']+)', '([^']+)'\)/i) ?? []).slice(1).join(","));
      /* G IS THE CENSORING KM. Building it on the EVENTS instead is one
       * predicate away and would produce weights that are wrong in a direction
       * nobody would question — the curve is still monotone in [0,1]. */
      put(fp, "g_is_censoring_km",
        /SUM\(CASE WHEN x\.t = c\.t AND x\.cause = 0 THEN 1 ELSE 0 END\) AS d/i.test(sql) ? "yes" : "no");
      put(fp, "g_times_are_censoring_times",
        /SELECT DISTINCT t FROM \w+ WHERE cause = 0/i.test(sql) ? "yes" : "no");
      /* THE MODIFIED RISK SET — the single CASE arm that is the whole model.
       * Without the second predicate this is a cause-specific Cox model. */
      put(fp, "retains_competing_subjects", /WHERE x\.t >= e\.t OR x\.cause >= 2/i.test(sql) ? "yes" : "no");
      /* The ORDER of the ratio, not merely that both terms appear. G(t)/G(t_j)
       * inverted to G(t_j)/G(t) makes retained subjects GAIN influence over
       * time instead of losing it — and a check that only asserted both
       * subqueries exist passed the inversion, because both still do. */
      put(fp, "weight_is_g_ratio",
        /CASE WHEN x\.t >= e\.t THEN 1\.0/i.test(sql) &&
        /ELSE COALESCE\(\(SELECT g\.g FROM \w*fgg g WHERE g\.t <= e\.t[\s\S]{0,140}?\/ NULLIF\(COALESCE\(\(SELECT g\.g FROM \w*fgg g WHERE g\.t <= x\.t/i.test(sql)
          ? "yes" : "no");
      put(fp, "score_uses_weighted_totals",
        /SUM\(d1\) - SUM\(d \* wn1 \/ NULLIF\(wn, 0\)\) AS score_u0/i.test(sql) ? "yes" : "no");
      put(fp, "information_uses_weighted_share",
        /SUM\(d \* \(wn1 \/ NULLIF\(wn, 0\)\) \* \(1 - wn1 \/ NULLIF\(wn, 0\)\)\) AS information0/i.test(sql) ? "yes" : "no");
      put(fp, "null_loglik_uses_weighted_n", /-SUM\(d \* LN\(NULLIF\(wn, 0\)\)\) AS loglik0/i.test(sql) ? "yes" : "no");
      /* The cause-specific total emitted BESIDE the weighted one, so a reader
       * (and the harness) can see whether anything was actually retained. */
      /* The cause-specific total must come from an EXPLICIT at-risk flag, not
       * from "weight = 1" — those are different predicates whenever G has not
       * dropped, and the loose one made the retained diagnostic report zero on
       * a fixture where a subject was genuinely retained. */
      put(fp, "emits_cause_specific_comparison",
        /SUM\(m\.at_risk\) AS n_cause_specific/i.test(sql) &&
        /CASE WHEN x\.t >= e\.t THEN 1 ELSE 0 END AS at_risk/i.test(sql) ? "yes" : "no");
      /* SEPARATION guards on BOTH the one-step and the anchor. A large finite
       * number standing in for an infinite estimate reads as a very strong
       * effect. */
      /* The FACT at each site, not an occurrence count. SQL inlines the guard
       * into all four one-step columns; the SAS twin hoists it into _finite and
       * uses it twice. Both are correct and the counts are 5 and 2 — the same
       * structural-divergence trap the statistical constants at the top of this
       * file are exempted from. */
      /* Dialect-agnostic: Postgres rounds via ROUND(CAST(x AS NUMERIC), n) and
       * Snowflake via ROUND(x, n), so a pattern anchored on the CAST passed on
       * the executed twin and failed the Snowflake one — which is the check
       * doing its job on my regex rather than on the emitter. */
      put(fp, "separation_guards_one_step",
        /CASE WHEN d1_exposed > 0 AND d1_exposed < d_total THEN ROUND\(\s*(?:CAST\(\s*)?EXP\(/i.test(sql) ? "yes" : "no");
      put(fp, "separation_guards_anchor",
        /AND c\.d1_exposed > 0 AND c\.d1_exposed < c\.d_total/i.test(sql) ? "yes" : "no");
      put(fp, "anchor_requires_constant_proportion", /ABS\(p_max - p_min\) < 1e-12/i.test(sql) ? "yes" : "no");
      put(fp, "model_terms", [...sql.matchAll(/CAST\('adjusted' AS VARCHAR\) AS component, CAST\('([^']*)' AS VARCHAR\) AS term/g)].map((m) => m[1]).join(","));
      put(fp, "censor_bounds", censorBoundsSql(sql));
      {
        const adjusted = [...sql.matchAll(/CAST\('adjusted' AS VARCHAR\) AS component,[\s\S]{0,260}?CAST\(\d+ AS INT\) AS ord,\s*\n\s*(\S+[^\n]*?) AS estimate/g)];
        put(fp, "fg_fit_null_in_sql",
          adjusted.length > 0 && adjusted.every((m) => m[1] === "CAST(NULL AS NUMERIC)") ? "yes" : "no");
      }
      break;
    }
    case "propensity_score": {
      put(fp, "treated_level", grab(sql, [/WHEN (?:nl\.pattern|c\.index_code) = '([^']+)' THEN 1 ELSE 0 END AS treated/i]));
      put(fp, "arm_levels", (sql.match(/IN \('([^']+)', '([^']+)'\)\s*$/im) ?? []).slice(1).join(","));
      /* THE SCORE IS THE CELL FRACTION. That single expression is the saturated
       * maximum-likelihood claim; anything else is a different estimator. */
      put(fp, "score_is_cell_fraction",
        /SUM\(treated\) \* 1\.0 \/ COUNT\(\*\) AS ps/i.test(sql) ? "yes" : "no");
      /* THE CELL SPELLING. Two twins agreeing on the covariates but
       * concatenating them differently would score the same subject
       * differently, and no comparison of NUMBERS would catch it - the cell is
       * a string. The separator and the axis order are both scraped. */
      put(fp, "cell_separator", /\|\| '\|' \|\|/.test(sql) ? "pipe" : (/AS cell/i.test(sql) ? "OTHER" : "ABSENT"));
      put(fp, "cell_axis_count", String(((sql.match(/AS cell,/i) ? sql.slice(0, sql.search(/AS cell,/i)) : "").match(/\|\| '\|' \|\|/g) ?? []).length + 1));
      /* THE WEIGHTS. ATE and ATT differ only in these two expressions, and a
       * swapped pair produces a perfectly plausible set of weights for the
       * OTHER estimand. */
      put(fp, "treated_weight",
        /THEN 1\.0 \/ NULLIF\(c\.ps, 0\) ELSE/i.test(sql) ? "ate"
        : /THEN 1\.0 ELSE/i.test(sql) ? "att" : "OTHER");
      put(fp, "control_weight",
        /ELSE 1\.0 \/ NULLIF\(1 - c\.ps, 0\) END AS w_raw/i.test(sql) ? "ate"
        : /ELSE c\.ps \/ NULLIF\(1 - c\.ps, 0\) END AS w_raw/i.test(sql) ? "att" : "OTHER");
      /* A zero denominator must be NULL. A large finite weight there would be a
       * number standing in for a counterpart that does not exist. */
      put(fp, "zero_denominator_is_null", /NULLIF\(1 - c\.ps, 0\)/i.test(sql) ? "yes" : "no");
      put(fp, "stabilized", /p_treated \* \(/i.test(sql) ? "yes" : "no");
      put(fp, "trim_bounds", (sql.match(/c\.ps < ([\d.]+) OR c\.ps > ([\d.]+)/i) ?? []).slice(1).join(",") || "none");
      /* THE WEIGHTED VARIANCE. The naive SUM(w(x-xbar)^2)/SUM(w) shrinks every
       * standardized difference and flatters the balance - the direction nobody
       * checks. The frequency-weighted form carries the sw^2 - sw2 denominator. */
      put(fp, "weighted_variance_is_frequency_form",
        /\(b\.sw_t \/ NULLIF\(b\.sw_t \* b\.sw_t - b\.sw2_t, 0\)\)/i.test(sql) ? "yes" : "no");
      put(fp, "ess_is_kish", /POWER\(sw_t, 2\) \/ NULLIF\(sw2_t, 0\)/i.test(sql) ? "yes" : "no");
      put(fp, "positivity_gap_emitted", /'pseudo_population_gap'/i.test(sql) ? "yes" : "no");
      put(fp, "reports_balance_before_and_after",
        /'smd_unweighted'/i.test(sql) && /'smd_weighted'/i.test(sql) ? "yes" : "no");
      put(fp, "balance_terms", [...sql.matchAll(/CAST\('balance' AS VARCHAR\) AS component, CAST\('([^']*)' AS VARCHAR\) AS term,\n\s*CAST\('smd_unweighted'/g)].map((m) => m[1]).join(","));
      putBandingKeys(fp, "sql", sql);
      putStrataKeys(fp, "sql", sql);
      break;
    }
    case "negative_control": {
      put(fp, "treated_level", grab(sql, [/WHEN (?:nl\.pattern|c\.index_code) = '([^']+)' THEN 1 ELSE 0 END AS treated/i]));
      put(fp, "arm_levels", (sql.match(/IN \('([^']+)', '([^']+)'\)\s*$/im) ?? []).slice(1).join(","));
      put(fp, "horizon_days", grab(sql, [
        /a\.event_date <= DATEADD\(\s*day\s*,\s*(\d+)\s*,/i,
        /a\.event_date <= \(c\.index_date \+ (\d+)\)/i,
      ]));
      /* THE DECLARED THRESHOLD. It is the only number here that decides an
       * answer, and it is scraped from the COMPARISON rather than from the row
       * that prints it — a program could print 1.25 and compare against 2. */
      put(fp, "bias_threshold", grab(sql, [/ < 1\.0 \/ ([\d.]+) OR /]));
      /* [1/t, t] must be SYMMETRIC ON THE RATIO SCALE. Two different numbers in
       * the two halves would make a breach test that is easier to fail in one
       * direction than the other, which is not what the spec field describes —
       * so both are read out of the comparison and compared to each other. */
      {
        const m = /IS NULL THEN 0 WHEN [^\n]*?<\s*1\.0 \/ ([\d.]+) OR [^\n]*?>\s*([\d.]+) THEN 1/.exec(sql);
        put(fp, "bias_interval_is_symmetric",
          m ? (m[1] === m[2] ? "yes" : "no") : (/breaches_threshold/.test(sql) ? "no" : "none"));
      }
      put(fp, "control_ids", [...sql.matchAll(
        /CAST\('control' AS VARCHAR\) AS component, CAST\('([^']*)' AS VARCHAR\) AS term,\s*\n\s*CAST\('adjusted_risk_ratio'/g)].map((m) => m[1]).join(","));
      /* THE SAME PIPELINE. A control adjusted more cheaply than the primary
       * analysis tests a different claim, and a null result would then be
       * reassurance about an analysis nobody ran. */
      put(fp, "score_is_cell_fraction", /SUM\(treated\) \* 1\.0 \/ COUNT\(\*\) AS ps/i.test(sql) ? "yes" : "no");
      put(fp, "same_pipeline_ate_weights",
        /THEN 1\.0 \/ NULLIF\(c\.ps, 0\) ELSE/i.test(sql) && /ELSE 1\.0 \/ NULLIF\(1 - c\.ps, 0\) END AS w_raw/i.test(sql) ? "yes" : "no");
      put(fp, "estimator_is_hajek_ratio", /SUM\(w \* y0\) \/ NULLIF\(SUM\(w\), 0\) AS mu/i.test(sql) ? "yes" : "no");
      /* THE RATIONALE. A control without one is an arbitrary outcome, and
       * nothing else in the table can tell the difference. */
      put(fp, "rationale_emitted",
        /'rationale'/.test(sql) && /WHY THE EXPOSURE CANNOT CAUSE THIS/.test(sql) ? "yes" : "no");
      /* NO interval on a control estimate: the declared threshold is the test,
       * and an interval invites reading low power as reassurance. */
      put(fp, "control_interval_emitted", /\bci_low\b/i.test(sql) ? "yes" : "no");
      put(fp, "verdict_counts_breaches", /'controls_breaching'/.test(sql) ? "yes" : "no");
      putBandingKeys(fp, "sql", sql);
      break;
    }
    case "iptw_outcome": {
      put(fp, "treated_level", grab(sql, [/WHEN (?:nl\.pattern|c\.index_code) = '([^']+)' THEN 1 ELSE 0 END AS treated/i]));
      put(fp, "horizon_days", grab(sql, [
        /a\.event_date <= DATEADD\(\s*day\s*,\s*(\d+)\s*,/i,
        /a\.event_date <= \(c\.index_date \+ (\d+)\)/i,
      ]));
      put(fp, "score_is_cell_fraction", /SUM\(treated\) \* 1\.0 \/ COUNT\(\*\) AS ps/i.test(sql) ? "yes" : "no");
      /* THE SCORE POPULATION. Estimating it on the whole cohort and applying it
       * to the at-risk set gives weights that describe neither, and every
       * number downstream would still look ordinary. */
      /* Scraped from the SUBJ CTE specifically — the one place the score
       * population is decided. A bare "does 'atrisk' appear anywhere" test is
       * satisfied by the washout chain that BUILDS it, so it stayed green when
       * the subject set was switched to the whole cohort. */
      /* `subj0?` because a DECLARED COARSENING splits the subject build in two
       * (axis columns first, cell second) — the FROM that decides the score
       * population is then on subj0, and a pattern that only knew `subj AS (`
       * would read ABSENT and report the coarsening itself as drift. */
      put(fp, "score_population",
        (/subj0? AS \([\s\S]{0,1600}?\n\s*FROM (\w+) c\b/i.exec(sql) ?? [])[1] ?? "ABSENT");
      /* HAJEK, not Horvitz-Thompson. SUM(wY)/n instead of SUM(wY)/SUM(w) can
       * produce a "risk" above 1 and is a different estimator. */
      put(fp, "estimator_is_hajek_ratio",
        /SUM\(w \* y\) \/ NULLIF\(SUM\(w\), 0\) AS mu/i.test(sql) ? "yes" : "no");
      /* THE SANDWICH. The naive p(1-p)/n_eff is the variance of something else
       * and is too small - this is the single most consequential expression in
       * the module and the easiest to replace with a plausible wrong one. */
      put(fp, "variance_is_sandwich",
        /SUM\(k\.w \* k\.w \* POWER\(k\.y - h\.mu, 2\)\) \/ NULLIF\(POWER\(h\.sw, 2\), 0\) AS var_mu/i.test(sql) ? "yes" : "no");
      put(fp, "identification_row_first",
        /CAST\('identification' AS VARCHAR\) AS component, CAST\('subjects_off_support' AS VARCHAR\) AS statistic,\s*\n\s*CAST\(0 AS INT\) AS ord/i.test(sql) ? "yes" : "no");
      put(fp, "reports_unadjusted_beside", /CAST\('unadjusted' AS VARCHAR\)/i.test(sql) ? "yes" : "no");
      /* The risk-difference interval must NOT be clamped: clamping hides the
       * one signal saying the normal approximation has broken down. */
      put(fp, "rd_interval_unclamped",
        /GREATEST\(-1[.,]/i.test(sql) || /LEAST\(1\.0, mu1 - mu0/i.test(sql) ? "no" : "yes");
      put(fp, "range_diagnostic_emitted", /'rd_interval_within_range'/i.test(sql) ? "yes" : "no");
      putBandingKeys(fp, "sql", sql);
      putEValueKeys(fp, "sql", sql);
      break;
    }
    case "g_formula": {
      put(fp, "treated_level", grab(sql, [/WHEN (?:nl\.pattern|c\.index_code) = '([^']+)' THEN 1 ELSE 0 END AS treated/i]));
      put(fp, "horizon_days", grab(sql, [
        /a\.event_date <= DATEADD\(\s*day\s*,\s*(\d+)\s*,/i,
        /a\.event_date <= \(c\.index_date \+ (\d+)\)/i,
      ]));
      /* THE SATURATED OUTCOME MODEL. Cell means, with NULL where an arm is
       * absent — an undefined term, and the whole reason this estimator
       * restricts itself. COALESCE-ing them to 0 would silently invent an
       * outcome for a group that does not exist. */
      put(fp, "outcome_model_is_cell_means",
        /AVG\(CASE WHEN treated = 1 THEN y END\) AS m1/i.test(sql) &&
        /AVG\(CASE WHEN treated = 0 THEN y END\) AS m0/i.test(sql) ? "yes" : "no");
      put(fp, "restricted_to_cells_with_both_arms",
        /ok_cells AS \(SELECT \* FROM cellm WHERE n_t > 0 AND n_c > 0\)/i.test(sql) ? "yes" : "no");
      /* The g-formula standardizes over the cells' OWN sizes. Weighting each
       * cell equally instead is a different estimand and looks identical. */
      put(fp, "standardizes_over_cell_sizes",
        /SUM\(n_cell \* m1\) \/ NULLIF\(SUM\(n_cell\), 0\) AS g1/i.test(sql) ? "yes" : "no");
      put(fp, "aipw_augmentation_present",
        /- \(s\.treated - c\.e\) \/ NULLIF\(c\.e, 0\) \* c\.m1 AS a1_i/i.test(sql) &&
        /\+ \(s\.treated - c\.e\) \/ NULLIF\(1 - c\.e, 0\) \* c\.m0 AS a0_i/i.test(sql) ? "yes" : "no");
      /* The arms share subjects, so the covariance is a real term. Dropping it
       * OVERSTATES the interval, which is the safe direction and therefore the
       * one nobody notices. */
      put(fp, "variance_includes_covariance",
        /SUM\(\(i\.a1_i - a\.a1\) \* \(i\.a0_i - a\.a0\)\)/i.test(sql) &&
        /v1 \+ v0 - 2 \* cov10/i.test(sql) ? "yes" : "no");
      put(fp, "identity_row_emitted", /'aipw_minus_g_formula'/i.test(sql) ? "yes" : "no");
      /* The CONDITION, not just the row label. A row named zero_variance_arm
       * whose test is `0` still appears in the table and still says nothing. */
      put(fp, "zero_variance_flagged",
        /'zero_variance_arm'/i.test(sql) && /CASE WHEN v\.v1 <= 0 OR v\.v0 <= 0/i.test(sql) ? "yes" : "no");
      putBandingKeys(fp, "sql", sql);
      putEValueKeys(fp, "sql", sql);
      break;
    }
    case "comorbidity_index": {
      /* The index IS its weights and its hierarchy. A dropped supersession or a
       * shifted weight produces a score that is wrong by a plausible amount on
       * every patient at once, so both are scraped in order. */
      /* `-?\d+(\.\d+)?`, not `\d+`. A NEGATIVE weight is legal (van Walraven's
       * Elixhauser summary uses them), and the old integer-only pattern simply
       * did not match a condition whose weight was -7 — so that condition fell
       * out of the scraped list entirely and the fingerprint compared a SHORTER
       * list against a shorter list, agreeing perfectly while being blind to
       * every negatively-weighted condition in the index. */
      const WEIGHT = String.raw`-?\d+(?:\.\d+)?`;
      const conds = [...sql.matchAll(new RegExp(String.raw`SELECT '([^']+)' AS cond_id, '.*' AS cond_label, (${WEIGHT}) AS weight, (\d+) AS cond_ord`, "g"))];
      put(fp, "condition_ids", conds.map((m) => m[1]).join(","));
      put(fp, "condition_weights", conds.map((m) => m[2]).join(","));
      put(fp, "negative_weights", conds.filter((m) => Number(m[2]) < 0).map((m) => `${m[1]}:${m[2]}`).join(","));
      put(fp, "supersessions",
        [...sql.matchAll(/SELECT '([^']+)' AS winner, '([^']+)' AS loser/g)].map((m) => `${m[1]}>${m[2]}`).join(","));
      put(fp, "lookback_lower_days", sqlLookbackOffset(sql));
      // The hierarchy must WITHHOLD the weight, not delete the condition.
      put(fp, "hierarchy_withholds_weight", /THEN 0 ELSE cd\.weight END AS weight_applied/i.test(sql) ? "yes" : "no");
      /* THE SCORE IS A SIGNED SUM AND IS NEVER CLAMPED. With only positive
       * weights a GREATEST(..., 0) around it is a no-op and nobody would
       * notice; with a negative weight it silently rewrites every negative
       * patient to zero, which raises the mean, empties the lowest band, and
       * leaves a table that looks entirely ordinary. */
      put(fp, "score_clamped_at_zero",
        /(?:GREATEST|MAX)\s*\(\s*COALESCE\(SUM\(a\.weight_applied\)/i.test(sql) ? "yes" : "no");
      /* Condition prevalence must come from `has` (everyone who HAS it), not
       * from `applied` (whose weight survived) — otherwise a superseded
       * condition silently reads as absent. */
      put(fp, "superseded_prevalence_kept", /FROM cond cd LEFT JOIN has h ON h\.cond_id = cd\.cond_id/i.test(sql) ? "yes" : "no");
      // Zeros count: the mean is over the cohort, not over the affected.
      put(fp, "zeros_included", /FROM cohort c LEFT JOIN applied a/i.test(sql) ? "yes" : "no");
      // negative lower bounds too: the bands are what keep a negative total out
      // of the band labelled 0, so a pattern that skipped them was blind to the
      // exact defect the band-floor rule exists to prevent
      put(fp, "score_bands",
        [...sql.matchAll(/WHEN score >= (-?\d+(?:\.\d+)?) THEN '[^']*'/g)].map((m) => m[1]).join(","));
      /* THE LOWEST BAND IS THE `ELSE` ARM, so it has no `score >=` test and the
       * list above can never contain it. That is fine when every weight is
       * positive and nothing can fall below the floor; with a negative weight
       * the floor band is where the negative totals LIVE, and it was the one
       * bound in the whole ladder that nothing scraped. Its label is pinned
       * here and cross-checked against the stamp's first band. */
      put(fp, "score_band_floor_label", grab(sql, [/ELSE '((?:[^']|'')*)' END AS band,/]));
      put(fp, "quantile_probabilities",
        [...new Set((sql.match(/PERCENTILE_CONT\(([\d.]+)\)/gi) ?? []).map((m) => (/([\d.]+)/.exec(m) ?? [])[1]))].sort().join(","));
      break;
    }
    case "sweep": {
      /* A SWEEP'S FINGERPRINT IS ITS ARM LIST. Every failure this file exists to
       * catch has the same shape here: the program still emits a well-formed
       * summary table with a range and a verdict, and the only thing wrong is
       * WHICH arms went into it, or which arm was called primary, or whether
       * the direction test ran at all. None of that shows up in a number. */
      const arms = [...sql.matchAll(
        /SELECT CAST\('([^']*)' AS VARCHAR\) AS sw_arm_id, CAST\('([^']*)' AS VARCHAR\) AS sw_arm_kind, CAST\('(?:[^']|'')*' AS VARCHAR\) AS sw_arm_label, CAST\((\d+) AS NUMERIC\) AS sw_arm_ord, CAST\('([^']*)' AS VARCHAR\) AS sw_param, (?:CAST\((-?[\d.]+|NULL) AS NUMERIC\)) AS sw_param_value, CAST\('([^']*)' AS VARCHAR\) AS sw_slice/g,
      )];
      put(fp, "sweep_arm_ids", arms.map((m) => m[1]).join("|"));
      put(fp, "sweep_arm_kinds", arms.map((m) => m[2]).join("|"));
      put(fp, "sweep_arm_ords", arms.map((m) => m[3]).join("|"));
      put(fp, "sweep_arm_params", arms.map((m) => m[4]).join("|"));
      put(fp, "sweep_arm_param_values", arms.map((m) => (m[5] === "NULL" ? "" : m[5])).join("|"));
      put(fp, "sweep_arm_slices", arms.map((m) => m[6]).join("|"));
      put(fp, "sweep_arm_count", String(arms.length));
      /* THE PRE-DECLARED PRIMARY ARM, read from the one place the program
       * selects it. A mutation that replaces this predicate with "whichever arm
       * has the largest effect" leaves the table's shape untouched. */
      put(fp, "sweep_primary_arm", grab(sql, [/WHERE sw_arm_id = '([^']*)'/i]));
      // which row of the arm's own result table each arm is read from
      put(fp, "sweep_target_component", grab(sql, [/\(SELECT \w+ FROM \S+ WHERE component = '([^']*)'/i]));
      put(fp, "sweep_target_statistic", grab(sql, [/AND statistic = '([^']*)'\) AS sw_est/i]));
      put(fp, "sweep_target_stratum", grab(sql, [/\(SELECT \w+ FROM \S+ WHERE stratum = '([^']*)'\) AS sw_est/i]));
      put(fp, "sweep_value_column", grab(sql, [/\(SELECT (\w+) FROM \S+ WHERE (?:component|statistic|stratum) = /i]));
      // the null value the direction test compares against, or NONE
      put(fp, "sweep_null_value",
        grab(sql, [/SUM\(CASE WHEN sw_est IS NOT NULL AND sw_est > (-?[\d.]+) THEN 1 ELSE 0 END\)/i]) ?? "NONE");
      put(fp, "sweep_direction_test",
        /SUM\(CASE WHEN sw_est IS NOT NULL AND sw_est > -?[\d.]+ THEN 1 ELSE 0 END\).*AS n_above/is.test(sql)
        && /CASE WHEN n_above > 0 AND n_below > 0 THEN 1 ELSE 0 END/i.test(sql) ? "yes" : "no");
      put(fp, "sweep_range_reported",
        /MIN\(sw_est\) AS est_min, MAX\(sw_est\) AS est_max/i.test(sql) && /est_max - est_min/i.test(sql) ? "yes" : "no");
      put(fp, "sweep_multiplicity_reported",
        /POWER\(0\.95, (\d+)\)/i.test(sql) ? "yes" : "no");
      put(fp, "sweep_arm_accounting",
        /SUM\(CASE WHEN sw_est IS NULL THEN 1 ELSE 0 END\)/i.test(sql) && /COUNT\(\*\)\s*AS NUMERIC\)?\s*AS n_reported|COUNT\(\*\)\) AS n_reported/i.test(sql.replace(/CAST\(/gi, "")) ? "yes" : "no");
      break;
    }
    case "resource_use": {
      /* The ledger's correctness lives in four places, and each one produces a
       * complete, plausible table when it breaks — so each is scraped from the
       * emitted text rather than trusted. */
      // Bounds must read the SAME in both dialects: Postgres writes
      // `(c.index_date + 364)`, Snowflake `DATEADD(day, 364, c.index_date)`.
      put(fp, "window_lower_days", sqlWindowOffset(sql, ">="));
      put(fp, "window_upper_days", sqlWindowOffset(sql, "<="));
      // IP double-count guard: service lines must be filtered by NOT EXISTS
      put(fp, "ip_lines_excluded_when_admission_exists",
        /NOTEXISTS\(/i.test(sql.replace(/\s+/g, "")) && /i2\.caseid\s*=\s*s\.caseid/i.test(sql) ? "yes" : "no");
      put(fp, "ip_orphan_fallback_on_admdate", /i2\.admdate\s*=\s*s\.admdate/i.test(sql) ? "yes" : "no");
      put(fp, "ip_dated_at_admission", /i\.admdate AS service_date/i.test(sql) ? "yes" : "no");
      // Encounter grain, per family
      put(fp, "rx_key_includes_ndc", /ndcnum/i.test(sql) && /svcdate AS VARCHAR\) \|\| ':'/i.test(sql) ? "yes" : "no");
      put(fp, "amb_key_is_service_date", /CAST\(o\.svcdate AS VARCHAR\) AS enc_id/i.test(sql) ? "yes" : "no");
      put(fp, "encounter_collapse_key", /GROUP BY enrolid, setting, enc_id/i.test(sql) ? "yes" : "no");
      // ED carve-out places, in order
      put(fp, "ed_places", (sql.match(/CAST\(o\.stdplac AS VARCHAR\) IN \(([^)]*)\)/i)?.[1] ?? "").replace(/['\s]/g, ""));
      /* QUANTILES. The DISTINCT set of probabilities taken, sorted, and the
       * estimator that takes them. Deduped because the module takes each
       * quantile of two variables and SAS names the estimator once per PROC;
       * a quartile appearing where none was declared still shows up as
       * "0.25,0.5" != "0.5", and a twin quietly switching estimator shows up
       * in quantile_estimator even when the probabilities agree. */
      put(fp, "quantile_probabilities",
        [...new Set((sql.match(/PERCENTILE_(?:CONT|DISC)\(([\d.]+)\)/gi) ?? []).map((m) => (/([\d.]+)/.exec(m) ?? [])[1]))].sort().join(","));
      put(fp, "quantile_estimator",
        [...new Set((sql.match(/PERCENTILE_(CONT|DISC)\(/gi) ?? []).map((m) => `percentile_${/(CONT|DISC)/i.exec(m)![1].toLowerCase()}`))].sort().join(","));
      put(fp, "quantile_definition_label", grab(sql, [/'(interpolated|nearest_rank)' AS quantile_definition/i]));
      put(fp, "denominator_is_whole_cohort", /CROSS JOIN settings_list/i.test(sql) ? "yes" : "no");
      put(fp, "cost_field", grab(sql, [/'(paytot|netpay)' AS cost_field/i]));
      put(fp, "days_per_year", grab(sql, [/encounters \* ([\d.]+) \/ NULLIF\(\s*s\.observed_days/i]));

      /* ---- DISEASE-RELATED ATTRIBUTION ----------------------------------
       * Anchored on the emitted OUTPUT column rather than on the word "dr":
       * `dr` appears inside dr_paid_elig too, and a pattern loose enough to
       * match both would report the same value whichever one broke. */
      put(fp, "attribution_kind", /AS dr_paid_total\b/i.test(sql) ? "disease_related" : "all_cause");
      put(fp, "attribution_dx_position", grab(sql, [/'(primary_only|any_position)' AS dx_position/i]));
      // The slots actually scanned — this is what dxPosition MEANS in the code.
      put(fp, "attribution_dx_columns", claimColumns(sql, /\b\w+\.(pdx|dx\d+) IN \(/gi));
      put(fp, "attribution_proc_columns", claimColumns(sql, /\b\w+\.(pproc|proc\d+) IN \(/gi));
      put(fp, "attribution_dx_codes", inListCodes(sql, /\b\w+\.(?:pdx|dx\d+) IN \(([^)]*)\)/i));
      put(fp, "attribution_proc_codes", inListCodes(sql, /\b\w+\.(?:pproc|proc\d+) IN \(([^)]*)\)/i));
      put(fp, "attribution_drug_source",
        /dn\.code_list_id = '/.test(sql)
          ? `lookup:${grab(sql, [/dn\.ndcnum = r\.ndcnum AND dn\.code_list_id = '([^']+)'/i]) ?? "?"}`
          : /CAST\(r\.ndcnum AS VARCHAR\) IN \(/i.test(sql)
            ? `literal:${inListCodes(sql, /CAST\(r\.ndcnum AS VARCHAR\) IN \(([^)]*)\)/i)}`
            : "none");
      // ANY qualifying line makes the encounter disease-related.
      put(fp, "attribution_encounter_is_any_line", /MAX\(dr\) AS dr\b/i.test(sql) ? "yes" : "no");
      // The ELSE arm. A silent fallback to all-cause is exactly "ELSE 1".
      put(fp, "attribution_dr_default", drDefaults(sql));
      /* THE FALLBACK THIS MODULE IS MOST LIKELY TO SUFFER: the disease-related
       * total quietly summing every payment. Without this the dr_ column would
       * equal the all-cause one and every other check would stay green. */
      put(fp, "dr_cost_is_filtered", /SUM\(CASE WHEN dr = 1 THEN paid ELSE 0 END\) AS dr_paid(?![_\w])/i.test(sql) ? "yes" : "no");
      put(fp, "dr_reported_beside_all_cause",
        /AS paid_total\b/i.test(sql) && /AS dr_paid_total\b/i.test(sql) ? "yes" : /AS dr_paid_total\b/i.test(sql) ? "no" : "n/a");

      /* ---- THE DENOMINATOR ----------------------------------------------- */
      put(fp, "normalization_basis", /AS eligible_days\b/i.test(sql) ? "observed_member_months" : "fixed_window");
      {
        /* One match, two facts: the divisor literal AND the column divided by.
         * Anchored on the INNER expression, not on ROUND(...): Postgres wraps it
         * in a NUMERIC cast and Snowflake does not, and a pattern anchored on
         * the wrapper reported ABSENT for a perfectly correct Snowflake program.
         * `s.paid_elig` cannot match inside `s.dr_paid_elig` — the character
         * before the name is an underscore there, not a dot. */
        const m = /s\.paid_elig \* ([\d.]+) \/ NULLIF\(s\.(\w+), 0\)/i.exec(sql);
        put(fp, "member_time_days_per_unit", m?.[1]);
        put(fp, "pppm_denominator_source", m?.[2]);
      }
      put(fp, "member_time_numerator_filtered",
        /SUM\(CASE WHEN elig = 1 THEN paid ELSE 0 END\) AS paid_elig\b/i.test(sql) ? "yes" : "no");
      put(fp, "capitated_plan_types",
        (/CAST\(e\.plantyp AS VARCHAR\) NOT IN \(([^)]*)\)/i.exec(sql)?.[1] ?? "").replace(/['\s]/g, ""));
      /* The merge rule. Bridging a lapse the way the enrollment STITCHER does
       * would silently restore the very days the denominator must not count. */
      put(fp, "member_time_merges_adjacent_only",
        /WHEN dtstart > /i.test(sql) && /MAX\(dtend\) OVER \(PARTITION BY enrolid/i.test(sql) ? "yes" : "no");
      put(fp, "member_time_source",
        /AS eligible_days\b/i.test(sql)
          ? /mm_seg0 AS \([\s\S]*?\n\),/.exec(sql)?.[0]?.includes("_enroll_episodes")
            ? "enroll_episodes"
            : "enroll_segments"
          : "n/a");

      /* ---- CPI RESTATEMENT ----------------------------------------------- */
      put(fp, "cost_basis_kind", /AS cost_basis\b/i.test(sql) ? "restated" : "nominal");
      put(fp, "inflation_factors", inflationFactors(sql));
      put(fp, "inflation_target_year", grab(sql, [/'(\d{4}) dollars, restated by [^']*' AS cost_basis/i]));
      put(fp, "inflation_series", grab(sql, [/'\d{4} dollars, restated by ([^']*)' AS cost_basis/i]));
      /* A service year with no index must restate to NULL and be COUNTED, never
       * be treated as 1.0 and enter unadjusted beside adjusted dollars. */
      put(fp, "inflation_missing_year_is_null", /ELSE NULL END AS paid\b/i.test(sql) ? "yes" : "no");
      break;
    }
    case "calendar_trend": {
      /* The buckets ARE the analysis: a boundary off by a day silently moves
       * events between buckets and still yields a complete trend table. Every
       * literal boundary is scraped IN ORDER, from the bucket CTE's own rows. */
      put(fp, "bucket_bounds", (sql.match(/DATE\s*'(\d{4}-\d{2}-\d{2})'/g) ?? []).map((m) => m.slice(6, -1)).join(","));
      // Cochran-Armitage scores, in emission order (the bucket_ord literals).
      put(fp, "bucket_scores", (sql.match(/SELECT\s+(\d+)\s*(?:AS bucket_ord|,\s*')/g) ?? []).map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      // The three CA sums must be over the scores, not over anything else.
      put(fp, "ca_sum_wr", /SUM\(bucket_ord \* patients\)/i.test(sql) ? "yes" : "no");
      put(fp, "ca_sum_wn", /SUM\(bucket_ord \* denominator\)/i.test(sql) ? "yes" : "no");
      put(fp, "ca_sum_w2n", /SUM\(bucket_ord \* bucket_ord \* denominator\)/i.test(sql) ? "yes" : "no");
      // z is computed in BOTH twins, so this key IS cross-compared.
      put(fp, "ca_z_is_t_over_sd", /t_stat\s*\/\s*NULLIF\(\s*SQRT\(var_t\)/i.test(sql) ? "yes" : "no");
      /* SAS-PRIMARY contract, SQL side (language-local): the p-value column must
       * be present and NULL. A SQL twin that computes a plausible-looking
       * p-value is worse than one that omits it — the number would be wrong and
       * the label right. */
      put(fp, "trend_p_null_in_sql",
        /CAST\(NULL AS NUMERIC\),\s*\n\s*CAST\('sas_[a-z_]+' AS VARCHAR\)/i.test(sql) ? "yes" : "no");
      break;
    }
    case "period_prevalence": {
      const between = /event_date\s+BETWEEN\s+DATE\s*'(\d{4}-\d{2}-\d{2})'\s+AND\s+DATE\s*'(\d{4}-\d{2}-\d{2})'/i.exec(sql);
      put(fp, "period_start", between?.[1]);
      put(fp, "period_end", between?.[2]);
      // Demographics reference date + the enrollment-overlap bounds. These must
      // track the period; mutation testing showed a shifted ref_date was
      // invisible when only the BETWEEN was fingerprinted.
      put(fp, "ref_date", grab(sql, [/DATE\s*'(\d{4}-\d{2}-\d{2})'\s+AS ref_date/i]));
      put(fp, "overlap_start_le", grab(sql, [/episode_start\s*<=\s*DATE\s*'(\d{4}-\d{2}-\d{2})'/i]));
      put(fp, "overlap_end_ge", grab(sql, [/episode_end\s*>=\s*DATE\s*'(\d{4}-\d{2}-\d{2})'/i]));
      break;
    }
  }

  // Care setting actually filtered on the outcome event stream.
  //
  // A LINKED MORTALITY endpoint reads an external death table, so there is no
  // claim to filter and "any" would be the wrong answer rather than a neutral
  // one: it would say a filter was considered and widened. The emitter stamps
  // its own token for that case, and the scrape has to agree.
  const setting = grab(sql, [/code_list_id\s*=\s*'[^']*'\s+AND\s+setting\s*=\s*'(\w+)'/i]);
  put(fp, "setting_filter", /AS linked_flag/i.test(sql) ? "not_applicable_external_linkage" : (setting ?? "any"));
  return fp;
}

/* ------------------------------------------------------------------ *
 *  SAS extraction — independent patterns over the SAS emission.
 * ------------------------------------------------------------------ */

function sasFingerprint(kind: string, rawSas: string, setup: string): Fingerprint {
  const sas = resolveSasMacros(stripComments("sas", rawSas), stripComments("sas", setup));
  const fp: Fingerprint = {};

  // (statistical constants: see the note in sqlFingerprint — pinned per-language)

  switch (kind) {
    case "incidence": {
      // rate_per_1000py = round(patients * <MULT> * <DPY> / person_days, 0.01);
      put(fp, "rate_multiplier", grab(sas, [/rate_per_1000py\s*=\s*round\(\s*patients\s*\*\s*([\d.]+)\s*\*/i]));
      put(fp, "days_per_year", grab(sas, [/rate_per_1000py\s*=\s*round\(\s*patients\s*\*\s*[\d.]+\s*\*\s*([\d.]+)\s*\//i]));
      put(fp, "person_years_divisor", grab(sas, [/person_years\s*=\s*round\(\s*person_days\s*\/\s*([\d.]+)/i]));
      put(fp, "washout_lower_days", grab(sas, [/svcdate\s*>=\s*a\.index_date\s*-\s*(\d+)/i]));
      put(fp, "washout_includes_index", /svcdate\s*<=\s*a\.index_date/i.test(sas) ? "yes" : "no");
      // Anchored on the admin_censor expression so a comment mentioning the
      // same arithmetic cannot stand in for the code that computes it.
      put(fp, "max_followup_days", grab(sas, [/min\([^;]*?index_date\s*\+\s*(\d+)\s*\)\s*as admin_censor/i]));
      put(fp, "strictly_after_index", /svcdate\s*>\s*a\.index_date/i.test(sas) ? "yes" : "no");
      put(fp, "censor_bounds", censorBoundsSas(sas));
      put(fp, "byar_exponents", exponents(sas, /\*\*\s*(\d+)/g));
      // SAS-PRIMARY contract: the exact limits must be genuinely computed here
      if (/ci_low_exact/i.test(sas)) {
        put(fp, "exact_ci_computed_in_sas",
          /gaminv\(/i.test(sas) && /ci_low_exact\s*=/i.test(sas) && /ci_high_exact\s*=/i.test(sas) ? "yes" : "no");
      }
      break;
    }
    case "cumulative_incidence": {
      put(fp, "horizon_days", grab(sas, [/svcdate\s*<=\s*a\.index_date\s*\+\s*(\d+)/i, /index_date\s*\+\s*(\d+)/i]));
      put(fp, "washout_includes_index", /svcdate\s*<=\s*a\.index_date(?!\s*\+)/i.test(sas) ? "yes" : "no");
      put(fp, "strictly_after_index", /svcdate\s*>\s*a\.index_date/i.test(sas) ? "yes" : "no");
      put(fp, "censor_bounds", censorBoundsSas(sas));
      break;
    }
    case "point_prevalence": {
      put(fp, "anchor_date", sasDateToIso(grab(sas, [/('\d{2}[A-Z]{3}\d{4}'d)\s+as anchor_date/i])));
      put(fp, "anchor_is_index", /index_date\s+as anchor_date/i.test(sas) ? "yes" : "no");
      put(fp, "case_on_or_before_anchor", /svcdate\s*<=\s*a\.anchor_date/i.test(sas) ? "yes" : "no");
      put(fp, "enrol_covers_date", sasDateToIso(grab(sas, [/('\d{2}[A-Z]{3}\d{4}'d)\s+between\s+ep\.dtstart/i, /ep\.dtstart\s*<=\s*('\d{2}[A-Z]{3}\d{4}'d)/i])));
      break;
    }
    case "standardization": {
      put(fp, "ref_weights", (sas.match(/weight\s*=\s*(\d+)\s*;/g) ?? []).map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      // Scoped to the weights table: `band = "X"; weight = N;` on one line.
      // An unscoped match also picks up the banding logic further down and
      // reports every band twice over.
      put(fp, "ref_bands", (sas.match(/band\s*=\s*"([\d+-]+)"\s*;\s*weight\s*=\s*\d+/g) ?? []).map((m) => (/"([\d+-]+)"/.exec(m) ?? [])[1]).join(","));
      put(fp, "covered_weight_pct", grab(sas, [/([\d.]+)\s+as covered_weight_pct/i]));
      put(fp, "dsr_is_weighted_mean", /sum\(weight \* coalesce\(band_rate, 0\)\) \/ sum\(weight\)/i.test(sas) ? "yes" : "no");
      put(fp, "ci_is_sas_primary", /ci_method\s*=\s*"sas_/i.test(sas) ? "yes" : "no");
      break;
    }
    case "smd_balance": {
      // SAS var() is the SAMPLE variance, matching SQL's VAR_SAMP
      put(fp, "sample_variance", /\bvar\s*\(/i.test(sas) ? "yes" : "no");
      put(fp, "pooled_halved_denominator", /\/\s*2\s*\)/.test(sas) ? "yes" : "no");
      put(fp, "imbalance_threshold", grab(sas, [/abs\(smd\)\s*>\s*([\d.]+)/i]));
      put(fp, "reference_arm", grab(sas, [/in \('([^']+)',/i]));
      // SAS names a per-axis PREFIX where SQL names a column; normalized here
      // so the two are comparable at all.
      const PRE_TO_COL: Record<string, string> = { age: "age_val", sex: "sex_male", cci: "cci_val" };
      put(fp, "covariate_columns",
        [...sas.matchAll(/value_ref = round\((\w+?)_[mp]_ref/g)].map((m) => PRE_TO_COL[m[1]] ?? `UNMAPPED(${m[1]})`).join(","));
      if (/weight_applied/i.test(sas))
        put(fp, "cci_hierarchy_withholds", /then 0 else cd\.weight end as weight_applied/i.test(sas) ? "yes" : "no");
      break;
    }
    case "regression": {
      put(fp, "horizon_days", grab(sas, [/svcdate <= a\.index_date \+ (\d+)/i]));
      put(fp, "response_is_count", /count\(distinct e\.svcdate\) as n_events/i.test(sas) ? "yes" : "no");
      if (/coalesce\(cst\.cost, 0\) as y/i.test(sas)) {
        put(fp, "cost_ratio_is_mean_over_mean",
          /log\(\(a_ee \/ b_en\) \/ \(c_ue \/ d_un\)\)/i.test(sas) ? "yes" : "no");
        put(fp, "gamma_excludes_zero_cost", /and y > 0 then y else 0 end\) as a_ee/i.test(sas) ? "yes" : "no");
        put(fp, "crude_interval_is_delta_method", /se_log_cr = sqrt\(/i.test(sas) ? "yes" : "no");
      }
      put(fp, "exposed_level", grab(sas, [/when a\.arm = '([^']+)' then 1/i]));
      put(fp, "arm_levels", (sas.match(/in \('([^']+)', '([^']+)'\)/i) ?? []).slice(1).join(","));
      if (/coalesce\(rsp\.score, 0\) as y/i.test(sas)) {
        put(fp, "ols_diff_of_means", /mean_diff = m_exp - m_unexp;/i.test(sas) ? "yes" : "no");
        put(fp, "ols_pooled_se",
          /\(\(b_en - 1\)\*v_exp \+ \(d_un - 1\)\*v_unexp\) \/ \(b_en \+ d_un - 2\)/i.test(sas) && /sqrt\(1\/b_en \+ 1\/d_un\)/i.test(sas) ? "yes" : "no");
        put(fp, "ols_interval_is_normal_approx", /wald_normal_approx_pooled_sd/i.test(sas) ? "yes" : "no");
      }
      if (/coalesce\(cst\.cost, 0\) as y/i.test(sas)) {
        put(fp, "cell_a", /sum\(case when exposed = 1 and y > 0 then y else 0 end\) as a_ee/i.test(sas) ? "yes" : "no");
        put(fp, "cell_d", /sum\(case when exposed = 0 and y > 0 then 1 else 0 end\) as d_un/i.test(sas) ? "yes" : "no");
      } else if (/count\(distinct e\.svcdate\)/i.test(sas)) {
        put(fp, "cell_a", /sum\(case when exposed = 1 then y else 0 end\) as a_ee/i.test(sas) ? "yes" : "no");
        put(fp, "cell_d", /sum\(case when exposed = 0 then 1 else 0 end\) as d_un/i.test(sas) ? "yes" : "no");
      } else {
        put(fp, "cell_a", /sum\(case when exposed = 1 and y = 1 then 1 else 0 end\) as a_ee/i.test(sas) ? "yes" : "no");
        put(fp, "cell_d", /sum\(case when exposed = 0 and y = 0 then 1 else 0 end\) as d_un/i.test(sas) ? "yes" : "no");
      }
      put(fp, "log_or_is_cross_product", /log\(\(a_ee \* d_un\) \/ \(b_en \* c_ue\)\)/i.test(sas) ? "yes" : "no");
      put(fp, "woolf_se", /sqrt\(1\/a_ee \+ 1\/b_en \+ 1\/c_ue \+ 1\/d_un\)/i.test(sas) ? "yes" : "no");
      put(fp, "zero_cell_returns_null", /if a_ee > 0 and b_en > 0 and c_ue > 0 and d_un > 0/i.test(sas) ? "yes" : "no");
      put(fp, "model_terms", (sas.match(/term="([^"]*)"; ord=2\d;/g) ?? []).map((m) => (/term="([^"]*)"/.exec(m) ?? [])[1]).join(","));
      put(fp, "effect_statistic", grab(sas, [/component='adjusted'; statistic='(\w+)'/i]));
      if (/person_days/i.test(sas)) {
        put(fp, "rate_ratio_is_rate_over_rate",
          /log\(\(a_ee \/ pt_exp\) \/ \(c_ue \/ pt_unexp\)\)/i.test(sas) ? "yes" : "no");
        put(fp, "poisson_se_uses_events_only",
          /sqrt\(1\/a_ee \+ 1\/c_ue\)/i.test(sas) ? "yes" : "no");
        put(fp, "offset_censor_bounds", censorBoundsSas(sas));
        put(fp, "offset_censors_at_outcome",
          /censor_date = min\(coalesce\(fu_date, '31DEC9999'd\), admin_censor\)/i.test(sas) ? "yes" : "no");
      }
      /* SAS-PRIMARY (language-local), plus the ANCHOR. The saturated model and
       * the self-check are what make the fitted estimates trustworthy at all;
       * losing either leaves a column of numbers nothing ever validated. */
      // logistic -> PROC LOGISTIC, count/cost -> PROC GENMOD, ols -> PROC GLM
      put(fp, "adjusted_fitted_in_sas", /proc (logistic|genmod|glm)/i.test(sas) && /_adj_pe/i.test(sas) ? "yes" : "no");
      put(fp, "saturated_anchor_present",
        /model y = exposed\s*(;|\/)/i.test(sas) && /anchor_verdict/i.test(sas) ? "yes" : "no");
      break;
    }
    case "survival": {
      put(fp, "horizon_days", (sas.match(/horizon = (\d+); output;/g) ?? []).map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      put(fp, "ci_method", grab(sas, [/'km_(log_log|linear)'/i]));
      put(fp, "risk_set_includes_t", count(sas, /s\.t >= e\.t/g));
      put(fp, "product_limit_factor", /_s \* \(n_risk - n_event\) \/ n_risk/i.test(sas) ? "yes" : "no");
      put(fp, "greenwood_term", /_g \+ n_event \/ \(n_risk \* \(n_risk - n_event\)\)/i.test(sas) ? "yes" : "no");
      put(fp, "time_stops_at_event", /min\(coalesce\(fu_date, '31DEC9999'd\), admin_censor\)/i.test(sas) ? "yes" : "no");
      put(fp, "censor_bounds", censorBoundsSas(sas));
      put(fp, "median_tolerance", grab(sas, [/surv <= 0\.5 \+ (\S+?)\)/i]));
      if (/'km_log_log'/i.test(sas)) {
        put(fp, "loglog_lower_uses_plus_z", /ci_low  = surv \*\* exp\(1\.96 \* _sig\)/i.test(sas) ? "yes" : "no");
        put(fp, "loglog_upper_uses_minus_z", /ci_high = surv \*\* exp\(-1\.96 \* _sig\)/i.test(sas) ? "yes" : "no");
      } else {
        put(fp, "linear_ci_is_clamped", /max\(0, surv - 1\.96 \* se\)/i.test(sas) && /min\(1, surv \+ 1\.96 \* se\)/i.test(sas) ? "yes" : "no");
      }
      if (/_lrsum/i.test(sas)) {
        put(fp, "exposed_level", grab(sas, [/exposed = \(arm = "([^"]+)"\)/i]));
        put(fp, "arm_levels", (sas.match(/arm not in \("([^"]+)", "([^"]+)"\)/i) ?? []).slice(1).join(","));
        put(fp, "logrank_expected_is_hypergeometric", /sum\(d \* n1 \/ n\) as e_exp/i.test(sas) ? "yes" : "no");
        put(fp, "logrank_tie_correction", /d \* \(n - d\) \* n1 \* \(n - n1\) \/ \(n \* n \* \(n - 1\)\)/i.test(sas) ? "yes" : "no");
        put(fp, "logrank_critical_value", grab(sas, [/estimate = \(_chi > ([\d.]+)\)/i]));
        put(fp, "peto_log_hr", /_lhr = \(o_exp - e_exp\) \/ v_exp/i.test(sas) ? "yes" : "no");
        /* Language-local: the p-value the SQL twin leaves NULL must be genuinely
         * produced HERE, by a procedure that can compute a chi-square tail. */
        put(fp, "logrank_p_computed_in_sas",
          /ods output HomTests\s*=\s*work\.\w+/i.test(sas) && /strata exposed \/ test=logrank/i.test(sas) ? "yes" : "no");
      }
      /* Language-local: the anchor. PROC LIFETEST run BESIDE the closed form and
       * compared to it, with a verdict printed - the survival analogue of the
       * saturated-design anchor. Deleting it leaves a program that still
       * produces every number and checks none of them. */
      put(fp, "km_anchor_present",
        /proc lifetest data=work\.\w+ method=km conftype=\w+ outsurv=/i.test(sas) &&
        /anchor_verdict = 'PASS: LIFETEST = closed-form product limit'/i.test(sas) ? "yes" : "no");
      /* The SAS twin of the linkage scrapes, read from THIS language's own
       * text. The names differ throughout (min/LEAST, ne ./IS NOT NULL, SAS
       * date literals) precisely so neither pattern can pass by borrowing the
       * other twin's correctness. */
      if (/create table work\.\w+_mcov as/i.test(sas)) {
        const srcS = /select a\.enrolid, a\.index_date, m\.(\w+) as death_date[\s\S]{0,400}?inner join ([\w.]+) as m[\s\S]{0,200}?where strip\(vvalue\(m\.(\w+)\)\) in \(/i.exec(sas);
        put(fp, "mortality_death_column", srcS?.[1]);
        put(fp, "mortality_linkage_table", srcS?.[2]);
        put(fp, "mortality_linked_flag_column", srcS?.[3]);
        put(fp, "mortality_linked_predicate",
          /where strip\(vvalue\(m\.\w+\)\) in \('1', 'Y'/i.test(sas) ? "yes" : "no");
        put(fp, "mortality_risk_set_is_linked_subset",
          /create table work\.(\w+)_atrisk as\s*\n\s*select \* from work\.\1_mcov;/i.test(sas) ? "yes" : "no");
        put(fp, "mortality_censor_at_ascertainment",
          sasDateToIso(grab(sas, [/, ('\d{2}[A-Z]{3}\d{4}'d)\) as admin_censor/i])));
        put(fp, "mortality_ascertained_through",
          sasDateToIso(grab(sas, [/sum\(k\.death_date ne \. and k\.death_date <= ('\d{2}[A-Z]{3}\d{4}'d)\) as n_deaths/i])));
        put(fp, "mortality_attrition_row",
          /as n_linked/i.test(sas) && /as n_unlinked/i.test(sas) && /unlinked_excluded_from_risk_set/i.test(sas) ? "yes" : "no");
      }
      break;
    }
    case "treatment_switching": {
      put(fp, "from_source_in_sas", grab(sas, [/from (tz\.\S*_ev_\w+) as f\s*\n\s*inner join work\.\w+_cohort as a[\s\S]{0,200}from_last_day/i, /create table work\.\w+_fromcov as[\s\S]{0,300}?from (tz\.\S*_ev_\w+)/i]));
      put(fp, "to_list_in_sas", [...sas.matchAll(/"([^"]+)" as code_list_id/g)].map((m) => m[1]).join(",") || "ABSENT");
      put(fp, "from_last_day_is_supply_minus_one", /f\.svcdate - a\.index_date \+ f\.daysupp - 1/i.test(sas) ? "yes" : "no");
      put(fp, "new_drug_strictly_after_index", /f\.svcdate - a\.index_date > 0/i.test(sas) ? "yes" : "no");
      put(fp, "overlap_is_remaining_supply",
        /overlap_days = max\(coalesce\(from_last_day, to_day - 1\) - to_day \+ 1, 0\)/i.test(sas) ? "yes" : "no");
      put(fp, "permissible_overlap_days", grab(sas, [/switched\s+= \(to_day ne \. and overlap_days <= (\d+)\)/i]));
      put(fp, "strict_bound_emitted", /switched_strict = \(to_day ne \. and overlap_days <= 0\)/i.test(sas) ? "yes" : "no");
      put(fp, "loose_bound_emitted", /switched_loose\s+= \(to_day ne \.\)/i.test(sas) ? "yes" : "no");
      put(fp, "reclassification_reported", /reclassified_by_overlap_rule/i.test(sas) ? "yes" : "no");
      put(fp, "add_on_kept_distinct", /add_on\s+= \(to_day ne \. and overlap_days > (\d+)\)/i.test(sas) ? "yes" : "no");
      put(fp, "line_rule", grab(sas, [/under the DECLARED rule \((\w+)\)/i]));
      put(fp, "line_definitional_row", /DEFINITIONAL, NOT MEASURED/i.test(sas) ? "yes" : "no");
      put(fp, "line_estimate_is_null", /rule_is_definitional/i.test(sas) ? "yes" : "no");
      put(fp, "days_supply_cap", grab(sas, [/daysupp = \. OR daysupp <= (\d+)\)/i]));
      /* The SAS twin of the regimen-construction scrapes. Read from THIS
       * language's own text: the names differ (daysupp/days_supply,
       * work._NNN_lot_x1/lot_x1 AS) precisely so that neither pattern can pass
       * by borrowing the other twin's correctness. */
      if (/create table work\.\w+_lot_agw as/i.test(sas)) {
        put(fp, "lot_agents", [...sas.matchAll(/"([^"]+)" as agent length=64/g)].map((m) => m[1]).join(",") || "ABSENT");
        put(fp, "lot_combination_window_days", allOf(sas, /where r\.agent_first <= o\.t \+ (\d+);/gi));
        put(fp, "lot_gap_days", allOf(sas, /where g_len >= (\d+) group by enrolid;/gi));
        put(fp, "lot_advance_trigger", allOf(sas, /where (is_sub = 1|is_sub in \(0, 1\)) group by enrolid;/gi)
          .split(",").map((t) => (t === "is_sub = 1" ? "substitution" : "addition_or_substitution")).join(","));
        put(fp, "lot_max_lines", maxOf(sas, /_lot_m(\d+) as/gi));
        put(fp, "lot_merge_uses_running_max",
          String((sas.match(/_maxend = max\(_maxend, d_end\);/gi) ?? []).length));
        put(fp, "lot_substitution_is_coverage_based",
          /\(case when v\.n_cov < z\.n_reg then 1 else 0 end\) as is_sub/i.test(sas) ? "yes" : "no");
        put(fp, "lot_next_line_opens_at_close",
          /on a\.enrolid = x\.enrolid and a\.d_start >= x\.close_day/i.test(sas) ? "yes" : "no");
        put(fp, "lot_truncation_reported",
          /_lot_trunc as/i.test(sas) && /patients_truncated_at_max_lines/i.test(sas) ? "yes" : "no");
        put(fp, "lot_cost_denominator_is_line_span",
          /min\(l\.line_end, /i.test(sas) && /max\(l\.line_start, /i.test(sas) ? "yes" : "no");
        put(fp, "lot_days_per_month", allOf(sas, /elig_days \/ ([\d.]+)/gi));
        put(fp, "lot_cost_on_eligible_time_only",
          /sum\(case when e\.elig = 1 then e\.paid else 0 end\)/i.test(sas) ? "yes" : "no");
      }
      break;
    }
    case "adherence": {
      /* The SAS twin of the scrapes above. Names differ by language on purpose
       * (svcdate/daysupp against fill_date/days_supply), which is exactly why
       * each is read from its OWN text rather than assumed from the other. */
      /* Matched AFTER macro resolution: sasFingerprint runs resolveSasMacros,
       * so `tz.&tag._ev_index_drug` in the emitted file is `tz.TZ_F_ev_...`
       * here. A regex written against the unresolved form scrapes nothing and,
       * before the ABSENT sentinel was handled, that read as a pass. */
      put(fp, "fills_source_in_sas", grab(sas, [/from (tz\.\S*_ev_\w+)/i]));
      /* The SAS side needs no code-list predicate: the spine writes one event
       * table per code list, so the table name IS the selection. Recorded so
       * that a change to either strategy shows up here. */
      put(fp, "fills_selected_by_per_list_table_in_sas", "yes");
      put(fp, "interval_end_is_supply_minus_one", /\+ f\.daysupp - 1 as d_end/i.test(sas) ? "yes" : "no");
      put(fp, "merge_uses_running_max",
        /if _maxend = \. or d_start > _maxend then island \+ 1;/i.test(sas) ? "yes" : "no");
      put(fp, "merge_avoids_lag", /lag\(d_end\)/i.test(sas) ? "NO_LAG_PRESENT" : "yes");
      put(fp, "stockpile_closed_form", /u_max = max\(u_max, d_start - \(t_cum - days_supply\)\)/i.test(sas) ? "yes" : "no");
      put(fp, "stockpile_cumulative_supply", /t_cum \+ days_supply/i.test(sas) ? "yes" : "no");
      put(fp, "pdc_denominator", grab(sas, [/pdc\s+= covered \/ (\d+);/i]));
      put(fp, "mpr_denominator", grab(sas, [/mpr\s+= dispensed \/ (\d+);/i]));
      put(fp, "mpr_numerator_guarded",
        /sum\(max\(min\(d_end, -?\d+\) - max\(d_start, -?\d+\) \+ 1, 0\)\) as dispensed/i.test(sas) ? "yes" : "no");
      put(fp, "adherence_threshold", grab(sas, [/sum\(pdc >= ([\d.]+)\) as n_adherent/i]));
      put(fp, "permissible_gap", grab(sas, [/gap of at least (\d+) uncovered days/i]));
      put(fp, "days_supply_cap", grab(sas, [/daysupp = \. OR daysupp <= (\d+)\)/i]));
      put(fp, "drops_missing_supply", /daysupp ne \./i.test(sas) ? "yes" : "no");
      put(fp, "fill_attrition_counted", /as n_raw,/i.test(sas) && /as n_kept/i.test(sas) ? "yes" : "no");
      put(fp, "identity_row_emitted", /patients_with_pdc_above_mpr/i.test(sas) ? "yes" : "no");
      put(fp, "censoring_kept_distinct", /count\(\*\) - sum\(discontinued\) as n_censored/i.test(sas) ? "yes" : "no");
      put(fp, "stockpile_reclassification_reported", /reclassified_by_stockpiling/i.test(sas) ? "yes" : "no");
      break;
    }
    case "cox": {
      put(fp, "exposed_level", grab(sas, [/exposed = \(arm = "([^"]+)"\)/i]));
      put(fp, "arm_levels", (sas.match(/arm not in \("([^"]+)", "([^"]+)"\)/i) ?? []).slice(1).join(","));
      put(fp, "risk_set_includes_t", count(sas, /s\.t >= e\.t/g));
      put(fp, "time_stops_at_event", /min\(coalesce\(fu_date, '31DEC9999'd\), admin_censor\)/i.test(sas) ? "yes" : "no");
      put(fp, "censor_bounds", censorBoundsSas(sas));
      put(fp, "score_is_o_minus_e", /sum\(d1\) - sum\(d \* n1 \/ n\) as score_u0/i.test(sas) ? "yes" : "no");
      put(fp, "information_is_breslow", /sum\(d \* n1 \* \(n - n1\) \/ \(n \* n\)\) as information0/i.test(sas) ? "yes" : "no");
      put(fp, "null_loglik_form", /-sum\(d \* log\(n\)\) as loglik0/i.test(sas) ? "yes" : "no");
      put(fp, "logrank_variance_emitted_beside", /'logrank_variance'/i.test(sas) ? "yes" : "no");
      put(fp, "one_step_is_u_over_i", /_lhr = score_u0 \/ information0/i.test(sas) ? "yes" : "no");
      put(fp, "score_critical_value", grab(sas, [/estimate = \(_chi > ([\d.]+)\)/i]));
      put(fp, "anchor_requires_constant_proportion", /abs\(p_max - p_min\) < 1e-12/i.test(sas) ? "yes" : "no");
      put(fp, "anchor_guards_separation", /d1_exposed > 0 and d1_exposed < d_total/i.test(sas) ? "yes" : "no");
      put(fp, "anchor_closed_form", /\(_q \/ \(1 - _q\)\) \/ \(p_min \/ \(1 - p_min\)\)/i.test(sas) ? "yes" : "no");
      put(fp, "model_terms", (sas.match(/term="([^"]*)"; ord=4\d+; output;/g) ?? []).map((m) => (/term="([^"]*)"/.exec(m) ?? [])[1]).join(","));
      /* Language-local: the fit itself, and the THREE self-checks on it. Each
       * can be deleted individually while leaving a program that still produces
       * every number and checks none of them. */
      /* The tie option is scraped FROM THE MODEL STATEMENT, not from anywhere
       * in the file. A bare /ties=breslow/ also matched the method label
       * "sas_proc_phreg (ties=breslow)" further down, so switching the actual
       * fit to Efron — which would make every closed form here describe a
       * different likelihood than the one being maximized — left this green. */
      put(fp, "cox_fit_in_sas",
        /proc phreg data=work\.\w+;/i.test(sas) && /model t\*ev\(0\) = [^;]*ties=breslow/i.test(sas) ? "yes" : "no");
      /* The COMPARISON, not just the verdict string. Testing for the PASS text
       * alone passed a mutation that set the gap to a constant zero: the
       * program still printed "PASS" and had checked nothing. */
      put(fp, "cox_null_loglik_check",
        /_gap = abs\(closed_form_m2ll - phreg_m2ll\);/i.test(sas) &&
        /null_ll_verdict = 'PASS: PHREG null -2logL = closed form'/i.test(sas) ? "yes" : "no");
      put(fp, "cox_score_zero_check",
        /u_at_bhat = u_at_bhat \+ d1 - d \* \(n1 \* _r\) \/ \(\(n - n1\) \+ n1 \* _r\)/i.test(sas) &&
        /score_verdict = 'PASS: U\(beta_hat\) = 0, the fit solves its own equation'/i.test(sas) ? "yes" : "no");
      put(fp, "cox_anchor_check",
        /anchor_verdict = 'PASS: fitted HR = closed-form binomial maximum'/i.test(sas) &&
        /anchor_verdict = 'NOT APPLICABLE: risk-set exposure share is not constant'/i.test(sas) ? "yes" : "no");
      break;
    }
    case "competing_risks": {
      put(fp, "causes", (sas.match(/select e\.enrolid, e\.svcdate, (\d+) as cause/gi) ?? [])
        .map((m) => (/(\d+) as cause/i.exec(m) ?? [])[1]).join(","));
      /* The event table is named tz.&tag._ev_<listid>, and &tag. is resolved by
       * the caller before this runs — so the prefix is the RESOLVED tag, not a
       * program number. Matching on the _ev_ marker itself keeps this working
       * whatever the tag is. */
      put(fp, "cause_lists", (sas.match(/_ev_(\w+) as e/gi) ?? [])
        .map((m) => (/_ev_(\w+) as e/i.exec(m) ?? [])[1]).join(","));
      put(fp, "risk_set_is_all_cause",
        /sum\(case when s\.t = e\.t and s\.cause > 0 then 1 else 0 end\) as d_all/i.test(sas) ? "yes" : "no");
      put(fp, "weight_is_s_prev", /cif_\d+ = cif_\d+ \+ s_prev \* d_\d+ \/ n_risk;/i.test(sas) ? "yes" : "no");
      /* SAS lags by ASSIGNING s_prev before updating surv_all — a different
       * mechanism from the SQL window frame, which is why the fingerprint
       * compares the FACT rather than the text. */
      put(fp, "s_prev_lags_one_row", /s_prev = surv_all;[\s\S]{0,400}?surv_all = surv_all \*/i.test(sas) ? "yes" : "no");
      put(fp, "first_event_is_any_cause", /by enrolid svcdate cause;/i.test(sas) ? "yes" : "no");
      put(fp, "variance_three_terms", String(
        (/\(a\.cif_\d+ - b\.cif_\d+\)\*\*2/i.test(sas) ? 1 : 0) +
        (/\(b\.s_prev\*\*2\)/i.test(sas) ? 1 : 0) +
        (/- 2 \* sum\( \(a\.cif_\d+ - b\.cif_\d+\) \* b\.s_prev/i.test(sas) ? 1 : 0)));
      put(fp, "naive_treats_competing_as_censored",
        /sum\(case when s\.t = e\.t and s\.cause = \d+ then 1 else 0 end\) as d_k/i.test(sas) ? "yes" : "no");
      put(fp, "identity_row_emitted",
        /abs\(\(cif_\d+(?: \+ cif_\d+)*\) - \(1 - surv_all\)\) < 1e-9/i.test(sas) &&
        /HOLDS: the causes partition/i.test(rawSas) ? "yes" : "no");
      put(fp, "bias_row_emitted", /'bias'/i.test(sas) ? "yes" : "no");
      put(fp, "interval_is_clamped",
        /max\(0, cif_\d+ - 1\.96/i.test(sas) && /min\(1, cif_\d+ \+ 1\.96/i.test(sas) ? "yes" : "no");
      put(fp, "horizons", (sas.match(/horizon = (\d+); output;/g) ?? [])
        .map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      put(fp, "censor_bounds", censorBoundsSas(sas));
      /* Language-local: SAS has its OWN Aalen-Johansen in PROC LIFETEST, so the
       * closed form is checked against a second implementation on the site's
       * own data. */
      put(fp, "cif_anchor_present",
        /proc lifetest data=work\.\w+ plots=none;/i.test(sas) && /eventcode=1/i.test(sas) &&
        /cif_anchor_verdict = 'PASS: closed form = PROC LIFETEST CIF'/i.test(rawSas) ? "yes" : "no");
      break;
    }
    case "fine_gray": {
      put(fp, "causes", (sas.match(/select e\.enrolid, e\.svcdate, (\d+) as cause/gi) ?? [])
        .map((m) => (/(\d+) as cause/i.exec(m) ?? [])[1]).join(","));
      put(fp, "exposed_level", grab(sas, [/exposed = \(arm = "([^"]+)"\)/i]));
      put(fp, "arm_levels", (sas.match(/arm not in \("([^"]+)", "([^"]+)"\)/i) ?? []).slice(1).join(","));
      put(fp, "g_is_censoring_km",
        /sum\(case when x\.t = c\.t and x\.cause = 0 then 1 else 0 end\) as d/i.test(sas) ? "yes" : "no");
      put(fp, "g_times_are_censoring_times",
        /select distinct t from work\.\w+ where cause = 0/i.test(sas) ? "yes" : "no");
      put(fp, "retains_competing_subjects", /where x\.t >= e\.t or x\.cause >= 2/i.test(sas) ? "yes" : "no");
      put(fp, "weight_is_g_ratio",
        /case when x\.t >= e\.t then 1/i.test(sas) &&
        /where t <= e\.t\)\), 1\)[\s\S]{0,200}?\/ coalesce[\s\S]{0,200}?where t <= x\.t\)\), 1\)/i.test(sas)
          ? "yes" : "no");
      put(fp, "score_uses_weighted_totals", /sum\(d1\) - sum\(d \* wn1 \/ wn\) as score_u0/i.test(sas) ? "yes" : "no");
      put(fp, "information_uses_weighted_share",
        /sum\(d \* \(wn1 \/ wn\) \* \(1 - wn1 \/ wn\)\) as information0/i.test(sas) ? "yes" : "no");
      put(fp, "null_loglik_uses_weighted_n", /-sum\(d \* log\(wn\)\) as loglik0/i.test(sas) ? "yes" : "no");
      put(fp, "emits_cause_specific_comparison",
        /sum\(m\.at_risk\) as n_cause_specific/i.test(sas) &&
        /case when x\.t >= e\.t then 1 else 0 end as at_risk/i.test(sas) ? "yes" : "no");
      put(fp, "separation_guards_one_step",
        /_finite = \(d1_exposed > 0 and d1_exposed < d_total\);/i.test(sas) &&
        /if _finite and information0 > 0 then do;/i.test(sas) ? "yes" : "no");
      put(fp, "separation_guards_anchor",
        /and d1_exposed > 0 and d1_exposed < d_total then do;/i.test(sas) ? "yes" : "no");
      put(fp, "anchor_requires_constant_proportion", /abs\(p_max - p_min\) < 1e-12/i.test(sas) ? "yes" : "no");
      put(fp, "model_terms", (sas.match(/term="([^"]*)"; ord=4\d+; output;/g) ?? []).map((m) => (/term="([^"]*)"/.exec(m) ?? [])[1]).join(","));
      put(fp, "censor_bounds", censorBoundsSas(sas));
      /* Language-local. eventcode= is scraped FROM THE MODEL STATEMENT: without
       * it PROC PHREG fits a cause-specific Cox model, cleanly and
       * convergently, answering a different question. */
      put(fp, "fg_fit_in_sas",
        /proc phreg data=work\.\w+;/i.test(sas) && /model t\*cause\(0\) = [^;]*eventcode=1/i.test(sas) ? "yes" : "no");
      put(fp, "fg_null_loglik_check",
        /abs\(closed_form_m2ll - phreg_m2ll\) < 1e-6/i.test(sas) ? "yes" : "no");
      put(fp, "fg_score_zero_check",
        /u_at_bhat = u_at_bhat \+ d1 - d \* \(wn1 \* _r\) \/ \(\(wn - wn1\) \+ wn1 \* _r\)/i.test(sas) ? "yes" : "no");
      /* Anchored on the SELF-CHECK's own verdict assignment. The same
       * comparison appears again in the result assembly, so a bare test for it
       * found the assembly copy and stayed green while the check itself had
       * been reduced to `if 1 then`. Fourth time in this repo that a
       * single-occurrence pattern has hidden a partial corruption. */
      put(fp, "fg_subdistribution_check",
        /if wn_total > n_cs_total \+ 1e-9 then\s*\n\s*subdist_verdict = 'PASS: the risk sets are genuinely subdistribution/i.test(sas) &&
        /Cox model by another name/i.test(rawSas) ? "yes" : "no");
      break;
    }
    case "propensity_score": {
      put(fp, "treated_level", grab(sas, [/treated = \(arm = "([^"]+)"\)/i]));
      put(fp, "arm_levels", (sas.match(/arm not in \("([^"]+)", "([^"]+)"\)/i) ?? []).slice(1).join(","));
      put(fp, "score_is_cell_fraction", /sum\(treated\) \/ count\(\*\) as ps/i.test(sas) ? "yes" : "no");
      put(fp, "cell_separator", /\|\| '\|' \|\|/.test(sas) ? "pipe" : (/cell = /i.test(sas) ? "OTHER" : "ABSENT"));
      put(fp, "cell_axis_count", String(((/cell = ([^;]*);/i.exec(sas) ?? ["", ""])[1].match(/\|\| '\|' \|\|/g) ?? []).length + 1));
      put(fp, "treated_weight",
        /then w_raw = 1 \/ ps;/i.test(sas) ? "ate" : /then w_raw = 1;/i.test(sas) ? "att" : "OTHER");
      put(fp, "control_weight",
        /then w_raw = 1 \/ \(1 - ps\);/i.test(sas) ? "ate" : /then w_raw = ps \/ \(1 - ps\);/i.test(sas) ? "att" : "OTHER");
      put(fp, "zero_denominator_is_null", /if 1 - ps > 0 then w_raw/i.test(sas) ? "yes" : "no");
      put(fp, "stabilized", /w = p_treated \* w_raw;/i.test(sas) ? "yes" : "no");
      put(fp, "trim_bounds", (sas.match(/trimmed = \(ps < ([\d.]+) or ps > ([\d.]+)\)/i) ?? []).slice(1).join(",") || "none");
      put(fp, "weighted_variance_is_frequency_form",
        /\(b\.sw_t \/ \(b\.sw_t\*b\.sw_t - b\.sw2_t\)\)/i.test(sas) ? "yes" : "no");
      put(fp, "ess_is_kish", /\(sw_t\*\*2\) \/ sw2_t/i.test(sas) ? "yes" : "no");
      put(fp, "positivity_gap_emitted", /'pseudo_population_gap'/i.test(sas) ? "yes" : "no");
      put(fp, "reports_balance_before_and_after",
        /'smd_unweighted'/i.test(sas) && /'smd_weighted'/i.test(sas) ? "yes" : "no");
      put(fp, "balance_terms", (sas.match(/component = 'balance'; term = "([^"]*)"/g) ?? []).map((m) => (/term = "([^"]*)"/.exec(m) ?? [])[1]).join(","));
      /* Language-local: the anchor. The saturated claim is exactly the kind of
       * statement that is easy to assert and easy to get wrong, so the emitted
       * program checks it against PROC LOGISTIC instead of repeating it. */
      put(fp, "ps_anchor_present",
        /proc logistic data=work\.\w+ noprint descending;/i.test(sas) &&
        /ps_anchor_verdict = 'PASS: saturated closed form = PROC LOGISTIC fitted probability'/i.test(sas) ? "yes" : "no");
      putBandingKeys(fp, "sas", sas);
      putStrataKeys(fp, "sas", sas);
      break;
    }
    case "negative_control": {
      put(fp, "treated_level", grab(sas, [/treated = \(arm = "([^"]+)"\)/i]));
      put(fp, "arm_levels", (sas.match(/arm not in \("([^"]+)", "([^"]+)"\)/i) ?? []).slice(1).join(","));
      put(fp, "horizon_days", grab(sas, [/e\.svcdate <= a\.index_date \+ (\d+)/i]));
      put(fp, "bias_threshold", grab(sas, [/_rr < 1 \/ ([\d.]+) or _rr > [\d.]+/i]));
      {
        const m = /_rr < 1 \/ ([\d.]+) or _rr > ([\d.]+)/i.exec(sas);
        put(fp, "bias_interval_is_symmetric",
          m ? (m[1] === m[2] ? "yes" : "no") : (/breaches_threshold/i.test(sas) ? "no" : "none"));
      }
      put(fp, "control_ids", [...sas.matchAll(/component = 'control'; term = "([^"]*)"/g)].map((m) => m[1]).join(","));
      put(fp, "score_is_cell_fraction", /sum\(treated\) \/ count\(\*\) as ps/i.test(sas) ? "yes" : "no");
      put(fp, "same_pipeline_ate_weights",
        /then w_raw = 1 \/ ps;/i.test(sas) && /then w_raw = 1 \/ \(1 - ps\);/i.test(sas) ? "yes" : "no");
      put(fp, "estimator_is_hajek_ratio", /sum\(w \* y0\) \/ sum\(w\) as mu/i.test(sas) ? "yes" : "no");
      put(fp, "rationale_emitted",
        /statistic='rationale'/i.test(sas) && /WHY THE EXPOSURE CANNOT CAUSE THIS/.test(sas) ? "yes" : "no");
      put(fp, "control_interval_emitted", /\bci_low\b/i.test(sas) ? "yes" : "no");
      put(fp, "verdict_counts_breaches", /'controls_breaching'/i.test(sas) ? "yes" : "no");
      putBandingKeys(fp, "sas", sas);
      break;
    }
    case "iptw_outcome": {
      put(fp, "treated_level", grab(sas, [/treated = \(arm = "([^"]+)"\)/i]));
      put(fp, "horizon_days", grab(sas, [/e\.svcdate <= a\.index_date \+ (\d+)/i]));
      put(fp, "score_is_cell_fraction", /sum\(treated\) \/ count\(\*\) as ps/i.test(sas) ? "yes" : "no");
      /* Scraped from the _s0 build, which is what feeds _subj — not from
       * anywhere the at-risk table merely appears. */
      put(fp, "score_population",
        ((/create table work\.\w+_s0 as[\s\S]{0,900}?\n\s*from ([\w.]+) as a\b/i.exec(sas) ?? [])[1] ?? "ABSENT")
          .replace(/^work\._\w+?_/, "").replace(/^tz\.\d*_?/, ""));
      put(fp, "estimator_is_hajek_ratio", /sum\(w \* y\) \/ sum\(w\) as mu/i.test(sas) ? "yes" : "no");
      put(fp, "variance_is_sandwich",
        /sum\(k\.w \* k\.w \* \(k\.y - h\.mu\)\*\*2\) \/ \(h\.sw \*\* 2\) as var_mu/i.test(sas) ? "yes" : "no");
      put(fp, "identification_row_first",
        /component='identification'; statistic='subjects_off_support'; ord=0;/i.test(sas) ? "yes" : "no");
      put(fp, "reports_unadjusted_beside", /component='unadjusted'/i.test(sas) ? "yes" : "no");
      put(fp, "rd_interval_unclamped",
        /ci_low = round\(mu1 - mu0 - 1\.96 \* _serd, 0\.00001\);/i.test(sas) ? "yes" : "no");
      put(fp, "range_diagnostic_emitted", /'rd_interval_within_range'/i.test(sas) ? "yes" : "no");
      /* Language-local: the weighted saturated anchor. */
      put(fp, "iptw_anchor_present",
        /weighted_anchor_verdict = 'PASS: weighted saturated fit = Hajek weighted arm means'/i.test(sas) &&
        /lsmeans treated;/i.test(sas) ? "yes" : "no");
      putBandingKeys(fp, "sas", sas);
      putEValueKeys(fp, "sas", sas);
      break;
    }
    case "g_formula": {
      put(fp, "treated_level", grab(sas, [/treated = \(arm = "([^"]+)"\)/i]));
      put(fp, "horizon_days", grab(sas, [/e\.svcdate <= a\.index_date \+ (\d+)/i]));
      put(fp, "outcome_model_is_cell_means",
        /mean\(case when treated = 1 then y else \. end\) as m1/i.test(sas) &&
        /mean\(case when treated = 0 then y else \. end\) as m0/i.test(sas) ? "yes" : "no");
      put(fp, "restricted_to_cells_with_both_arms",
        /where n_t > 0 and n_c > 0/i.test(sas) ? "yes" : "no");
      put(fp, "standardizes_over_cell_sizes",
        /sum\(n_cell \* m1\) \/ sum\(n_cell\) as g1/i.test(sas) ? "yes" : "no");
      put(fp, "aipw_augmentation_present",
        /- \(s\.treated - c\.e\) \/ c\.e \* c\.m1 as a1_i/i.test(sas) &&
        /\+ \(s\.treated - c\.e\) \/ \(1 - c\.e\) \* c\.m0 as a0_i/i.test(sas) ? "yes" : "no");
      put(fp, "variance_includes_covariance",
        /sum\(\(i\.a1_i - a\.a1\) \* \(i\.a0_i - a\.a0\)\)/i.test(sas) &&
        /v1 \+ v0 - 2\*cov10/i.test(sas) ? "yes" : "no");
      put(fp, "identity_row_emitted", /'aipw_minus_g_formula'/i.test(sas) ? "yes" : "no");
      put(fp, "zero_variance_flagged",
        /'zero_variance_arm'/i.test(sas) && /if v1 <= 0 or v0 <= 0 then method='AN ARM HAS ZERO/i.test(sas) ? "yes" : "no");
      putBandingKeys(fp, "sas", sas);
      putEValueKeys(fp, "sas", sas);
      break;
    }
    case "comorbidity_index": {
      // negative weights and negative band bounds, scraped from this twin's own
      // text — see the SQL case for what an integer-only pattern hid
      const SAS_WEIGHT = String.raw`-?\d+(?:\.\d+)?`;
      const conds = [...sas.matchAll(new RegExp(String.raw`cond_id = "([^"]+)"; cond_label = "[^"]*"; weight = (${SAS_WEIGHT}); cond_ord = (\d+)`, "g"))];
      put(fp, "condition_ids", conds.map((m) => m[1]).join(","));
      put(fp, "condition_weights", conds.map((m) => m[2]).join(","));
      put(fp, "negative_weights", conds.filter((m) => Number(m[2]) < 0).map((m) => `${m[1]}:${m[2]}`).join(","));
      put(fp, "supersessions",
        [...sas.matchAll(/winner = "([^"]+)"; loser = "([^"]+)"/g)].map((m) => `${m[1]}>${m[2]}`).join(","));
      put(fp, "lookback_lower_days", sasLookbackOffset(sas));
      put(fp, "hierarchy_withholds_weight", /then 0 else cd\.weight end as weight_applied/i.test(sas) ? "yes" : "no");
      put(fp, "superseded_prevalence_kept", /left join work\._\w+_has as h on h\.cond_id = cd\.cond_id/i.test(sas) ? "yes" : "no");
      put(fp, "zeros_included", /left join work\._\w+_applied as b/i.test(sas) ? "yes" : "no");
      put(fp, "score_clamped_at_zero",
        /max\s*\(\s*coalesce\(sum\(b\.weight_applied\)/i.test(sas) ? "yes" : "no");
      put(fp, "score_bands",
        [...sas.matchAll(/score >= (-?\d+(?:\.\d+)?) then do/gi)].map((m) => m[1]).join(","));
      // the ELSE arm's label, this twin's own text — see the SQL case
      put(fp, "score_band_floor_label", grab(sas, [/else do; band = "([^"]*)"; band_ord = 0; end;/i]));
      put(fp, "quantile_probabilities", /pctldef=5/i.test(sas) && /median\s*=/i.test(sas) ? "0.5" : "");
      break;
    }
    case "sweep": {
      // The same arm list, scraped from the SAS twin's own data steps.
      const armBlocks = [...sas.matchAll(
        /sw_arm_id = '((?:[^']|'')*)'; sw_arm_kind = '([^']*)'; sw_arm_label = '(?:[^']|'')*';\s*\n\s*sw_arm_ord = (\d+); sw_param = '([^']*)';\s*\n\s*sw_param_value = (-?[\d.]+|\.);\s*\n\s*sw_slice = '([^']*)'/g,
      )];
      put(fp, "sweep_arm_ids", armBlocks.map((m) => m[1]).join("|"));
      put(fp, "sweep_arm_kinds", armBlocks.map((m) => m[2]).join("|"));
      put(fp, "sweep_arm_ords", armBlocks.map((m) => m[3]).join("|"));
      put(fp, "sweep_arm_params", armBlocks.map((m) => m[4]).join("|"));
      put(fp, "sweep_arm_param_values", armBlocks.map((m) => (m[5] === "." ? "" : m[5])).join("|"));
      put(fp, "sweep_arm_slices", armBlocks.map((m) => m[6]).join("|"));
      put(fp, "sweep_arm_count", String(armBlocks.length));
      put(fp, "sweep_primary_arm", grab(sas, [/where sw_arm_id = '([^']*)'/i]));
      put(fp, "sweep_target_component", grab(sas, [/where component = '([^']*)'/i]));
      put(fp, "sweep_target_statistic", grab(sas, [/where component = '[^']*' and statistic = '([^']*)'/i]));
      put(fp, "sweep_target_stratum", grab(sas, [/where stratum = '([^']*)'/i]));
      put(fp, "sweep_value_column", grab(sas, [/select (\w+) as sw_est/i]));
      put(fp, "sweep_null_value",
        grab(sas, [/sum\(sw_est ne \. and sw_est > (-?[\d.]+)\) as n_above/i]) ?? "NONE");
      put(fp, "sweep_direction_test",
        /sum\(sw_est ne \. and sw_est > -?[\d.]+\) as n_above/i.test(sas)
        && /estimate = \(n_above > 0 and n_below > 0\)/i.test(sas) ? "yes" : "no");
      put(fp, "sweep_range_reported",
        /min\(sw_est\) as est_min, max\(sw_est\) as est_max/i.test(sas) && /est_max - est_min/i.test(sas) ? "yes" : "no");
      put(fp, "sweep_multiplicity_reported", /0\.95\*\*(\d+)/i.test(sas) ? "yes" : "no");
      put(fp, "sweep_arm_accounting",
        /sum\(sw_est = \.\) as n_missing/i.test(sas) && /count\(\*\) as n_reported/i.test(sas) ? "yes" : "no");
      break;
    }
    case "resource_use": {
      // Same values, scraped from the SAS twin's own text.
      const bounds = /between (a\.index_date(?:\s*[+-]\s*\d+)?) and (a\.index_date(?:\s*[+-]\s*\d+)?)/i.exec(sas);
      put(fp, "window_lower_days", sasWindowOffset(bounds?.[1]));
      put(fp, "window_upper_days", sasWindowOffset(bounds?.[2]));
      put(fp, "ip_lines_excluded_when_admission_exists",
        /notexists\(/i.test(sas.replace(/\s+/g, "")) && /i2\.caseid\s*=\s*s\.caseid/i.test(sas) ? "yes" : "no");
      put(fp, "ip_orphan_fallback_on_admdate", /i2\.admdate\s*=\s*s\.admdate/i.test(sas) ? "yes" : "no");
      put(fp, "ip_dated_at_admission", /b\.admdate as service_date/i.test(sas) ? "yes" : "no");
      put(fp, "rx_key_includes_ndc", /ndcnum/i.test(sas) && /\|\| ':' \|\|/i.test(sas) ? "yes" : "no");
      put(fp, "amb_key_is_service_date", /put\(o\.svcdate, yymmdd10\.\) as enc_id/i.test(sas) ? "yes" : "no");
      put(fp, "encounter_collapse_key", /group by enrolid, setting, enc_id/i.test(sas) ? "yes" : "no");
      put(fp, "ed_places", (sas.match(/vvalue\(o\.stdplac\)\) in \(([^)]*)\)/i)?.[1] ?? "").replace(/['\s]/g, ""));
      /* SAS names the ESTIMATOR where SQL names a probability, so both are
       * translated to the SQL twin's tokens here. PCTLDEF=5 is the interpolated
       * definition (PERCENTILE_CONT) and PCTLDEF=3 the nearest-rank one
       * (PERCENTILE_DISC); a site default left implicit reads as MISSING rather
       * than as either. The probability list follows the OUTPUT keywords, so a
       * twin that computes quartiles the SQL twin does not is a mismatch. */
      {
        const def = grab(sas, [/pctldef=(\d)/i]);
        const hasMedian = /median\s*=/i.test(sas);
        const hasQ = /\bq1\s*=/i.test(sas) && /\bq3\s*=/i.test(sas);
        put(fp, "quantile_probabilities", hasMedian ? (hasQ ? "0.25,0.5,0.75" : "0.5") : "");
        put(fp, "quantile_estimator",
          def === "5" ? "percentile_cont" : def === "3" ? "percentile_disc" : def ? `pctldef_${def}` : "ABSENT");
      }
      put(fp, "quantile_definition_label", grab(sas, [/quantile_definition = "(interpolated|nearest_rank)"/i]));
      put(fp, "denominator_is_whole_cohort", /cross join work\._\w+_settings/i.test(sas) ? "yes" : "no");
      put(fp, "cost_field", grab(sas, [/cost_field = "(paytot|netpay)"/i]));
      put(fp, "days_per_year", grab(sas, [/encounters \* ([\d.]+) \/ observed_days/i]));

      /* ---- DISEASE-RELATED ATTRIBUTION — same facts, this twin's own text -- */
      put(fp, "attribution_kind", /as dr_paid_total\b/i.test(sas) ? "disease_related" : "all_cause");
      put(fp, "attribution_dx_position", grab(sas, [/dx_position\s*=\s*"(primary_only|any_position)"/i]));
      put(fp, "attribution_dx_columns", claimColumns(sas, /\b\w+\.(pdx|dx\d+) in \(/gi));
      put(fp, "attribution_proc_columns", claimColumns(sas, /\b\w+\.(pproc|proc\d+) in \(/gi));
      put(fp, "attribution_dx_codes", inListCodes(sas, /\b\w+\.(?:pdx|dx\d+) in \(([^)]*)\)/i));
      put(fp, "attribution_proc_codes", inListCodes(sas, /\b\w+\.(?:pproc|proc\d+) in \(([^)]*)\)/i));
      put(fp, "attribution_drug_source",
        /_ndc_\w+ as dn/i.test(sas)
          ? `lookup:${grab(sas, [/_ndc_(\w+) as dn/i]) ?? "?"}`
          : /strip\(r\.ndcnum\) in \(/i.test(sas)
            ? `literal:${inListCodes(sas, /strip\(r\.ndcnum\) in \(([^)]*)\)/i)}`
            : "none");
      put(fp, "attribution_encounter_is_any_line", /max\(dr\) as dr\b/i.test(sas) ? "yes" : "no");
      put(fp, "attribution_dr_default", drDefaults(sas));
      put(fp, "dr_cost_is_filtered",
        /sum\(case when dr = 1 then paid else 0 end\) as dr_paid(?![_\w])/i.test(sas) ? "yes" : "no");
      put(fp, "dr_reported_beside_all_cause",
        /\bpaid_total\b/i.test(sas) && /as dr_paid_total\b/i.test(sas) ? "yes" : /as dr_paid_total\b/i.test(sas) ? "no" : "n/a");

      /* ---- THE DENOMINATOR ----------------------------------------------- */
      put(fp, "normalization_basis", /as eligible_days\b/i.test(sas) ? "observed_member_months" : "fixed_window");
      {
        const m = /paid_per_member_(?:month|year) = round\(paid_elig \* ([\d.]+) \/ (\w+)/i.exec(sas);
        put(fp, "member_time_days_per_unit", m?.[1]);
        put(fp, "pppm_denominator_source", m?.[2]);
      }
      put(fp, "member_time_numerator_filtered",
        /sum\(case when elig = 1 then paid else 0 end\) as paid_elig\b/i.test(sas) ? "yes" : "no");
      put(fp, "capitated_plan_types",
        (/vvalue\(b\.plantyp\)\) not in \(([^)]*)\)/i.exec(sas)?.[1] ?? "").replace(/['\s]/g, ""));
      put(fp, "member_time_merges_adjacent_only",
        /dtstart <= run_end \+ 1 then run_end = max\(run_end, dtend\)/i.test(sas) ? "yes" : "no");
      put(fp, "member_time_source",
        /as eligible_days\b/i.test(sas)
          ? /_mseg0 as([\s\S]*?)quit;/i.exec(sas)?.[1]?.includes("_050_epi")
            ? "enroll_episodes"
            : "enroll_segments"
          : "n/a");

      /* ---- CPI RESTATEMENT ----------------------------------------------- */
      put(fp, "cost_basis_kind", /cost_basis = "/i.test(sas) ? "restated" : "nominal");
      put(fp, "inflation_factors", inflationFactors(sas));
      put(fp, "inflation_target_year", grab(sas, [/cost_basis = "(\d{4}) dollars, restated by [^"]*"/i]));
      put(fp, "inflation_series", grab(sas, [/cost_basis = "\d{4} dollars, restated by ([^"]*)"/i]));
      put(fp, "inflation_missing_year_is_null", /else \. end\) as paid\b/i.test(sas) ? "yes" : "no");
      break;
    }
    case "calendar_trend": {
      // Same values, scraped from the SAS twin's OWN bucket data step.
      put(fp, "bucket_bounds", (sas.match(/'\d{2}[A-Z]{3}\d{4}'d/g) ?? []).map((m) => sasDateToIso(m) ?? m).join(","));
      put(fp, "bucket_scores", (sas.match(/bucket_ord\s*=\s*(\d+)\s*;\s*bucket\s*=/g) ?? []).map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      put(fp, "ca_sum_wr", /sum\(bucket_ord \* patients\)/i.test(sas) ? "yes" : "no");
      put(fp, "ca_sum_wn", /sum\(bucket_ord \* denominator\)/i.test(sas) ? "yes" : "no");
      put(fp, "ca_sum_w2n", /sum\(bucket_ord \* bucket_ord \* denominator\)/i.test(sas) ? "yes" : "no");
      put(fp, "ca_z_is_t_over_sd", /trend_z\s*=\s*round\(\s*t_stat\s*\/\s*sqrt\(var_t\)/i.test(sas) ? "yes" : "no");
      /* SAS-PRIMARY contract, SAS side (language-local): the p-value must
       * genuinely be COMPUTED here. That is the entire basis on which SQL is
       * allowed to leave the column NULL — delete this and the contract becomes
       * a column that simply does not exist anywhere. */
      put(fp, "trend_p_computed_in_sas", /probnorm\(/i.test(sas) && /trend_p\s*=\s*round\(/i.test(sas) ? "yes" : "no");
      break;
    }
    case "period_prevalence": {
      const between = /svcdate\s+between\s+('\d{2}[A-Z]{3}\d{4}'d)\s+and\s+('\d{2}[A-Z]{3}\d{4}'d)/i.exec(sas);
      put(fp, "period_start", sasDateToIso(between?.[1]));
      put(fp, "period_end", sasDateToIso(between?.[2]));
      put(fp, "ref_date", sasDateToIso(grab(sas, [/('\d{2}[A-Z]{3}\d{4}'d)\s+as ref_date/i])));
      put(fp, "overlap_start_le", sasDateToIso(grab(sas, [/ep\.dtstart\s*<=\s*('\d{2}[A-Z]{3}\d{4}'d)/i])));
      put(fp, "overlap_end_ge", sasDateToIso(grab(sas, [/ep\.dtend\s*>=\s*('\d{2}[A-Z]{3}\d{4}'d)/i])));
      break;
    }
  }

  // Twin of the SQL note: an EXTERNAL MORTALITY LINKAGE has no claim to filter,
  // so "any" would misdescribe it rather than describe nothing.
  const rawSetting = grab(sas, [/e\.setting\s*=\s*'(\w+)'/i]);
  put(fp, "setting_filter", /create table work\.\w+_mcov as/i.test(sas)
    ? "not_applicable_external_linkage"
    : rawSetting === undefined ? "any" : (SAS_SETTING_TO_SPEC[rawSetting] ?? `UNMAPPED(${rawSetting})`));
  return fp;
}

/** Scrape the operative values out of one language's emitted analysis program. */
export function fingerprint(
  kind: string,
  language: "sql" | "sas",
  content: string,
  sasSetup = ""
): Fingerprint {
  return language === "sql" ? sqlFingerprint(kind, content) : sasFingerprint(kind, content, sasSetup);
}

/* ------------------------------------------------------------------ *
 *  Cohort-spine fingerprint
 * ------------------------------------------------------------------ */

/** The spine (events -> index -> enrollment -> attrition -> Table 1) builds the
 *  cohort every analysis module consumes, yet it carries NO parity stamp — so
 *  nothing compared the languages there. Two real defects hid in that gap: the
 *  SAS continuous-enrollment predicate was one day stricter than SQL's (so the
 *  twins built different cohorts), and SQL's episode stitching mishandled
 *  nested segments while SAS's did not. These values are scraped from each
 *  language's own spine code and must agree. */
export function spineFingerprint(
  language: "sql" | "sas",
  files: Array<{ path: string; content: string }>,
  sasSetup = ""
): Fingerprint {
  const all = files
    .map((f) =>
      language === "sas"
        ? resolveSasMacros(stripComments("sas", f.content), stripComments("sas", sasSetup))
        : stripComments("sql", f.content),
    )
    .join("\n");
  const fp: Fingerprint = {};

  if (language === "sql") {
    // CE predicate: episode_start <= index_date - N  /  episode_end >= index_date + M
    put(fp, "ce_baseline_offset", evalOffset(grab(all, [
      /episode_start\s*<=\s*DATEADD\(\s*day\s*,\s*-([\d\s()-]+?)\s*,\s*i\.index_date/i,
      /episode_start\s*<=\s*\(\s*i\.index_date\s*-\s*([\d\s()-]+?)\s*\)/i,
      /episode_start\s*<=\s*i\.index_date\b(?!\s*-)/i,
    ])));
    put(fp, "ce_followup_offset", grab(all, [
      /episode_end\s*>=\s*DATEADD\(\s*day\s*,\s*(\d+)\s*,\s*i\.index_date/i,
      /episode_end\s*>=\s*\(\s*i\.index_date\s*\+\s*(\d+)\s*\)/i,
    ]));
    put(fp, "gap_allowance", grab(all, [/>\s*(\d+)\s*THEN 1/i]));
    /* Age at index must come from enrollment DOBYR, not a claim's AGE column.
     * Matches both dialects: Postgres CAST(EXTRACT(YEAR FROM x) AS INT) - dobyr
     * and Snowflake YEAR(x) - dobyr. */
    put(
      fp,
      "age_from_dobyr",
      /(?:YEAR\(|EXTRACT\(YEAR FROM)[^\n]*?index_date[^\n]*?-\s*(?:\w+\.)?dobyr/i.test(all) ? "yes" : "no",
    );
    // null member ids / coverage dates excluded explicitly, not by silent join loss
    put(fp, "excludes_null_enrol_dates", /dtstart\s+IS NOT NULL/i.test(all) && /dtend\s+IS NOT NULL/i.test(all) ? "yes" : "no");
    /* Stitching form. Requires the running-MAX window AND the absence of any
     * LAG(dtend) — a PARTIAL revert (one of the two uses switched back) leaves
     * a MAX present and would otherwise still read as correct. */
    put(
      fp,
      "stitch_uses_running_max",
      /MAX\(dtend\)\s*OVER[^)]*ROWS BETWEEN UNBOUNDED PRECEDING/i.test(all) && !/LAG\(\s*dtend\s*\)/i.test(all)
        ? "yes"
        : "no",
    );
  } else {
    put(fp, "ce_baseline_offset", evalOffset(grab(all, [
      /b\.dtstart\s*<=\s*a\.index_date\s*-\s*([\d\s()-]+?)\s*$/im,
      /b\.dtstart\s*<=\s*a\.index_date\s*-\s*([\d\s()-]+)/i,
      /b\.dtstart\s*<=\s*a\.index_date\b(?!\s*-)/i,
    ])));
    put(fp, "ce_followup_offset", grab(all, [/b\.dtend\s*>=\s*a\.index_date\s*\+\s*(\d+)/i]));
    put(fp, "gap_allowance", grab(all, [/\(\s*dtstart\s*-\s*prev_dtend\s*\)\s*(?:gt|>)\s*(\d+)/i]));
    put(fp, "age_from_dobyr", /year\(\s*a?\.?index_date\s*\)\s*-\s*t?\.?dobyr/i.test(all) ? "yes" : "no");
    put(fp, "excludes_null_enrol_dates", /dtstart\s+is not null/i.test(all) && /dtend\s+is not null/i.test(all) ? "yes" : "no");
    /* SAS expresses the running maximum through BRANCHES rather than a max()
     * call: the "segment ends inside the running episode" arm keeps prev_dtend
     * unchanged, so the running end never moves backward. Detecting that arm is
     * how we confirm nested segments are handled. */
    put(
      fp,
      "stitch_uses_running_max",
      /dtend\s+(?:lt|<)\s+prev_dtend/i.test(all) && /prev_dtend\s*=\s*prev_dtend\s*;/i.test(all) ? "yes" : "no",
    );
  }
  return fp;
}

/** Reduce a day-offset expression to a single integer.
 *
 *  SQL bakes the literal (`index_date - 364`) while SAS keeps the macro form
 *  (`index_date - (365 - 1)`, resolved to `(365 - 1)`), so the two must be
 *  EVALUATED to be compared. Doing this by pattern instead — "treat 365 as if
 *  it meant 364" — silently rewrites a wrong value into the right one and
 *  hides the very off-by-one it is supposed to detect. (An earlier draft did
 *  exactly that, and the mutation reproducing the D1 defect went uncaught.)
 *
 *  Only `+`/`-` over integers and parens appear here; anything else is
 *  returned verbatim so an unexpected form shows up as a mismatch. */
function evalOffset(expr: string | undefined): string {
  if (expr === undefined) return "0";
  const cleaned = expr.replace(/[()\s]/g, "");
  if (/^\d+$/.test(cleaned)) return cleaned;
  const m = /^(\d+)([+-])(\d+)$/.exec(cleaned);
  if (!m) return expr.trim();
  const a = Number(m[1]);
  const b = Number(m[3]);
  return String(m[2] === "-" ? a - b : a + b);
}

/** Values the fingerprint must agree with, derived from the parity stamp.
 *  Only keys present here are cross-checked against the stamp; a fingerprint
 *  key with no stamp counterpart is still compared ACROSS languages. */
/**
 * Keys `expectedFromStamp` sets for EVERY kind, before the switch.
 *
 * The coverage guard used to ask only whether the result was non-empty, and
 * `setting_filter` is set for any stamp carrying a settingFilter — which is
 * every outcome-based analysis. So a kind with NO case in the switch at all
 * still "returned something", and the guard passed. Three modules shipped that
 * way (cox, fine_gray, competing_risks) before propensity_score — whose stamp
 * has no settingFilter, so it returned genuinely nothing — made the hole
 * visible. The guard now counts only keys BEYOND these.
 */
export const STAMP_SHARED_KEYS: ReadonlySet<string> = new Set(["setting_filter"]);

/** The cut points the stamp says were consumed, in the order the code compares
 *  them. Absent from the stamp means the analysis declared no coarsening, and
 *  the code must then contain no band predicate at all. */
function putBandingExpectations(exp: Fingerprint, stamp: Record<string, unknown>): void {
  const b = stamp.bandings as Array<{ cutPoints: number[] }> | undefined;
  if (!Array.isArray(b) || b.length === 0) {
    exp.banding_cut_points = "none";
    exp.band_occupancy_by_arm = "no";
    exp.coarsening_caution_emitted = "no";
    return;
  }
  exp.banding_cut_points = b.flatMap((x) => x.cutPoints.map(String)).join(",");
  exp.banding_missing_is_own_band = "yes";
  exp.band_occupancy_by_arm = "yes";
  exp.coarsening_caution_emitted = "yes";
}

/** Whether an E-value was requested, and whether the limit one came with it. */
function putEValueExpectations(exp: Fingerprint, stamp: Record<string, unknown>): void {
  const e = stamp.eValue as { includeLimit?: unknown } | undefined;
  if (!e) {
    exp.evalue_point_formula = "none";
    exp.evalue_reciprocal_formula = "none";
    exp.evalue_include_limit = "none";
    return;
  }
  exp.evalue_point_formula = "yes";
  /* BOTH branches, always. A program that kept the RR >= 1 arm and dropped the
   * reciprocal one is silently wrong for every protective effect, and nothing
   * about its output would look unusual. */
  exp.evalue_reciprocal_formula = "yes";
  exp.evalue_include_limit = e.includeLimit === false ? "no" : "yes";
}

export function expectedFromStamp(kind: string, stamp: Record<string, unknown>): Fingerprint {
  const exp: Fingerprint = {};
  const num = (v: unknown): string | undefined =>
    typeof v === "number" ? String(v) : undefined;

  if (typeof stamp.settingFilter === "string") exp.setting_filter = stamp.settingFilter;

  switch (kind) {
    case "incidence": {
      const mult = num(stamp.rateMultiplier);
      if (mult) exp.rate_multiplier = mult;
      if (typeof stamp.daysPerYear === "string") {
        exp.days_per_year = stamp.daysPerYear;
        exp.person_years_divisor = stamp.daysPerYear;
      }
      const w = stamp.washout as { start?: unknown; includesIndex?: unknown } | undefined;
      if (w && typeof w.start === "number") exp.washout_lower_days = String(Math.abs(w.start));
      if (w && typeof w.includesIndex === "boolean") exp.washout_includes_index = w.includesIndex ? "yes" : "no";
      const mf = num(stamp.maxFollowupDays);
      if (mf) exp.max_followup_days = mf;
      exp.strictly_after_index = "yes";
      exp.byar_exponents = "3,3"; // both CI bounds cube; neither may be lost
      break;
    }
    case "cumulative_incidence": {
      const h = num(stamp.horizonDays);
      if (h) exp.horizon_days = h;
      exp.strictly_after_index = "yes";
      break;
    }
    case "point_prevalence": {
      const a = stamp.anchor as { kind?: unknown; date?: unknown } | undefined;
      if (a?.kind === "fixed" && typeof a.date === "string") {
        exp.anchor_date = a.date;
        exp.anchor_is_index = "no";
      } else if (a?.kind === "index") {
        exp.anchor_is_index = "yes";
      }
      exp.case_on_or_before_anchor = "yes";
      break;
    }
    case "standardization": {
      // the stamp records the weights and coverage; the code must use exactly those
      if (Array.isArray(stamp.weights)) exp.ref_weights = (stamp.weights as number[]).join(",");
      const cov = num(stamp.coveredWeightPct);
      if (cov) exp.covered_weight_pct = cov;
      exp.dsr_is_weighted_mean = "yes";
      exp.ci_is_sas_primary = "yes";
      break;
    }
    case "smd_balance": {
      // The stamp claims a threshold, a reference arm and a variance
      // convention; the code must actually implement those three.
      const thr = num(stamp.imbalanceThreshold);
      if (thr) exp.imbalance_threshold = thr;
      if (typeof stamp.referenceLevel === "string") exp.reference_arm = stamp.referenceLevel;
      if (stamp.smdDenominator === "pooled_sd_sample_variance") {
        exp.sample_variance = "yes";
        exp.pooled_halved_denominator = "yes";
      }
      /* The stamp lists the covariates and their axes; the code must read each
       * one from the column that axis implies, in the same order. */
      if (Array.isArray(stamp.covariates)) {
        const AXIS_TO_COL: Record<string, string> = { age: "age_val", sex: "sex_male", comorbidity_index: "cci_val" };
        const covs = stamp.covariates as Array<{ axis: string }>;
        exp.covariate_columns = covs.map((c) => AXIS_TO_COL[c.axis] ?? `UNMAPPED(${c.axis})`).join(",");
        if (covs.some((c) => c.axis === "comorbidity_index")) exp.cci_hierarchy_withholds = "yes";
      }
      break;
    }
    case "regression": {
      /* A cost response does not use the outcome horizon at all — the window
       * that matters is costResponse's. Expecting a horizon in the code would
       * fail a correct gamma program. */
      const isCostStamp = stamp.responseKind === "cost";
      const isOlsStamp = stamp.responseKind === "continuous";
      const h = num(stamp.horizonDays);
      if (h && !isCostStamp && !isOlsStamp) exp.horizon_days = h;
      if (typeof stamp.exposedLevel === "string") exp.exposed_level = stamp.exposedLevel;
      if (typeof stamp.referenceLevel === "string" && typeof stamp.exposedLevel === "string")
        exp.arm_levels = `${stamp.referenceLevel},${stamp.exposedLevel}`;
      if (Array.isArray(stamp.terms)) exp.model_terms = (stamp.terms as string[]).join(",");
      if (typeof stamp.effectStatistic === "string") exp.effect_statistic = stamp.effectStatistic;
      /* The stamp says the model carries an offset; the code must build the
       * rate ratio from rates and take its SE from event counts alone. */
      if (stamp.offset !== null && typeof stamp.offset === "object") {
        exp.rate_ratio_is_rate_over_rate = "yes";
        exp.poisson_se_uses_events_only = "yes";
        /* The stamp lists the censoring terms actually honored; the clock must
         * stop at the outcome only when "outcome" is among them. */
        const applied = (stamp.offset as { applied?: unknown }).applied;
        if (Array.isArray(applied)) exp.offset_censors_at_outcome = applied.includes("outcome") ? "yes" : "no";
      }
      /* The stamp CLAIMS a closed-form crude effect and a saturated anchor; the
       * code has to actually be those things — but WHICH closed form depends on
       * the family. An offset in the stamp means a rate model, and a rate model
       * must not be checked against the odds-ratio algebra. */
      if (typeof stamp.responseKind === "string" && !isCostStamp && !isOlsStamp)
        exp.response_is_count = stamp.responseKind === "count" ? "yes" : "no";
      if (stamp.crudeEffect === "closed_form_2x2") {
        if (isOlsStamp) {
          /* OLS is the one family whose STANDARD ERROR is closed form too, so
           * the stamp requires both halves of the saturated result. */
          exp.ols_diff_of_means = "yes";
          exp.ols_pooled_se = "yes";
          exp.ols_interval_is_normal_approx = "yes";
          break;
        }
        exp.cell_a = "yes";
        exp.cell_d = "yes";
        if (isCostStamp) {
          exp.cost_ratio_is_mean_over_mean = "yes";
          exp.gamma_excludes_zero_cost = "yes";
          exp.crude_interval_is_delta_method = "yes";
        } else if (stamp.offset === null) {
          exp.log_or_is_cross_product = "yes";
          exp.woolf_se = "yes";
          exp.zero_cell_returns_null = "yes";
        }
      }
      break;
    }
    case "survival": {
      exp.horizon_days = (stamp.horizonDays as number[] ?? []).join(",");
      exp.ci_method = String(stamp.ciMethod ?? "");
      if (stamp.logRank) {
        exp.exposed_level = String(stamp.exposedLevel ?? "");
        exp.arm_levels = [stamp.referenceLevel, stamp.exposedLevel].filter(Boolean).join(",");
      }
      /* THE LINKAGE. Only when the stamp declares one — a claims endpoint must
       * keep the expectations it had before this arm existed, or every survival
       * analysis in the repo would start failing against keys its code has no
       * reason to contain. */
      const lk = stamp.mortalityLinkage as Record<string, unknown> | undefined;
      if (lk) {
        exp.mortality_linkage_table = String(lk.tableHandle ?? "");
        exp.mortality_death_column = String(lk.deathDateColumn ?? "");
        exp.mortality_linked_flag_column = String(lk.linkedFlagColumn ?? "");
        /* THE SAME DATE FROM TWO PLACES. One decides the curve (the
         * administrative censor), the other reports it (the attrition row).
         * Checking only one would leave a program that censors correctly and
         * says it censored somewhere else, or the reverse. */
        exp.mortality_ascertained_through = String(lk.ascertainedThrough ?? "");
        exp.mortality_censor_at_ascertainment = String(lk.ascertainedThrough ?? "");
        /* Stamped as VALUES, not implied by the presence of the block: these
         * two are the entire reason the endpoint is emittable. */
        exp.mortality_risk_set_is_linked_subset = String(lk.riskSet ?? "") === "linked_subset_only" ? "yes" : "no";
        exp.mortality_linked_predicate = String(lk.riskSet ?? "") === "linked_subset_only" ? "yes" : "no";
        exp.mortality_attrition_row = String(lk.attritionRow ?? "") === "ascertained_n_of_m" ? "yes" : "no";
      }
      break;
    }
    case "cox": {
      exp.exposed_level = String(stamp.exposedLevel ?? "");
      exp.arm_levels = [stamp.referenceLevel, stamp.exposedLevel].filter(Boolean).join(",");
      exp.model_terms = (stamp.terms as string[] ?? []).join(",");
      break;
    }
    case "fine_gray": {
      exp.exposed_level = String(stamp.exposedLevel ?? "");
      exp.arm_levels = [stamp.referenceLevel, stamp.exposedLevel].filter(Boolean).join(",");
      exp.model_terms = (stamp.terms as string[] ?? []).join(",");
      exp.causes = ((stamp.causes as Array<{ code: number }>) ?? []).map((c) => c.code).join(",");
      break;
    }
    case "competing_risks": {
      /* The CAUSE NUMBERING is the part worth cross-checking: if the twins
       * disagreed about which cause is 2, every cumulative incidence would be
       * attached to the wrong label while the partition identity still held
       * perfectly. */
      exp.causes = ((stamp.causes as Array<{ code: number }>) ?? []).map((c) => c.code).join(",");
      exp.horizons = (stamp.horizonDays as number[] ?? []).join(",");
      break;
    }
    case "treatment_switching": {
      /* The THRESHOLD is the one to cross-check hardest: twins using different
       * overlap rules classify different patients while every count stays
       * entirely plausible. */
      exp.permissible_overlap_days = String(stamp.permissibleOverlapDays ?? "");
      exp.line_rule = String(stamp.lineRule ?? "");
      exp.days_supply_cap = String(stamp.maxDaysSupplyCap ?? "");
      exp.new_drug_strictly_after_index = String(stamp.newDrugMustStartAfterIndex ?? "") === "strictly_after_index" ? "yes" : "no";
      exp.overlap_is_remaining_supply = String(stamp.overlapDefinition ?? "") === "remaining_from_supply_on_to_start_day" ? "yes" : "no";
      exp.line_definitional_row = String(stamp.lineRuleIsDefinitional ?? "") === "yes" ? "yes" : "no";
      /* THE THREE PARAMETERS, cross-checked against the code that consumed
       * them — and REPEATED maxLines times, because the construction is
       * unrolled and a value corrected in only the first block is the exact
       * partial mutation this repo has been bitten by five times. */
      const lc = stamp.lineConstruction as Record<string, unknown> | undefined;
      if (lc) {
        const n = Number(lc.maxLines ?? 0);
        const rep = (v: unknown) => Array(Math.max(n, 0)).fill(String(v)).join(",");
        exp.lot_combination_window_days = rep(lc.combinationWindowDays);
        exp.lot_gap_days = rep(lc.gapDays);
        exp.lot_advance_trigger = rep(lc.advanceTrigger);
        exp.lot_max_lines = String(lc.maxLines ?? "");
        exp.lot_agents = String(lc.agentCodeListIds ?? "");
        /* One island merge per line, so the count IS the unroll bound: a
         * construction that quietly stopped merging on the last line would
         * still report a line distribution, with one line's gaps invented. */
        exp.lot_merge_uses_running_max = String(lc.maxLines ?? "");
        exp.lot_substitution_is_coverage_based = "yes";
        exp.lot_next_line_opens_at_close = "yes";
        exp.lot_truncation_reported = String(lc.truncationReported ?? "") === "yes" ? "yes" : "no";
        exp.lot_cost_denominator_is_line_span = String(lc.costNormalization ?? "") === "observed_member_months" ? "yes" : "no";
        exp.lot_cost_on_eligible_time_only = "yes";
        /* Two occurrences per line (the member-month row and the PPPM row), so
         * a literal changed in one of the two - which would make the reported
         * denominator disagree with the denominator actually divided by - is a
         * different string here. */
        exp.lot_days_per_month = Array(Math.max(n * 2, 0)).fill(String(lc.daysPerMonth ?? "")).join(",");
      }
      break;
    }
    case "adherence": {
      /* The DENOMINATOR is the one worth cross-checking hardest: an off-by-one
       * in windowDays moves every PDC and MPR in the study by the same amount,
       * which looks exactly like a real finding rather than like a bug. */
      exp.pdc_denominator = String(stamp.windowDays ?? "");
      exp.mpr_denominator = String(stamp.windowDays ?? "");
      exp.adherence_threshold = String(stamp.adherenceThreshold ?? "");
      exp.permissible_gap = String(stamp.permissibleGapDays ?? "");
      exp.days_supply_cap = String(stamp.maxDaysSupplyCap ?? "");
      exp.drops_missing_supply = stamp.dropMissingSupply === true ? "yes" : "no";
      exp.interval_end_is_supply_minus_one = String(stamp.intervalEnd ?? "") === "start_plus_supply_minus_one" ? "yes" : "no";
      exp.merge_uses_running_max = String(stamp.merge ?? "") === "running_max_islands" ? "yes" : "no";
      exp.stockpile_closed_form = String(stamp.stockpiling ?? "") === "closed_form_running_max" ? "yes" : "no";
      break;
    }
    case "g_formula": {
      exp.treated_level = String(stamp.treatedLevel ?? "");
      exp.horizon_days = String(stamp.horizonDays ?? "");
      exp.restricted_to_cells_with_both_arms = String(stamp.population ?? "") === "cells_with_both_arms" ? "yes" : "no";
      exp.variance_includes_covariance = String(stamp.variance ?? "") === "influence_function_with_covariance" ? "yes" : "no";
      putBandingExpectations(exp, stamp);
      putEValueExpectations(exp, stamp);
      break;
    }
    case "iptw_outcome": {
      exp.treated_level = String(stamp.treatedLevel ?? "");
      exp.horizon_days = String(stamp.horizonDays ?? "");
      exp.score_population = String(stamp.scorePopulation ?? "") === "at_risk_after_washout" ? "atrisk" : "OTHER";
      putBandingExpectations(exp, stamp);
      putEValueExpectations(exp, stamp);
      break;
    }
    case "propensity_score": {
      exp.treated_level = String(stamp.treatedLevel ?? "");
      exp.arm_levels = [stamp.referenceLevel, stamp.treatedLevel].filter(Boolean).join(",");
      exp.cell_axis_count = String((stamp.cellAxes as string[] ?? []).length);
      exp.balance_terms = (stamp.balanceTerms as string[] ?? []).join(",");
      exp.treated_weight = String(stamp.estimand ?? "");
      exp.control_weight = String(stamp.estimand ?? "");
      exp.stabilized = stamp.stabilized ? "yes" : "no";
      putBandingExpectations(exp, stamp);
      /* Stratification. K is the number the program ASKED for; how many were
       * formed is data-dependent and is emitted by the program, not stamped. */
      if (typeof stamp.strataRequested === "number") {
        exp.strata_requested = String(stamp.strataRequested);
        exp.strata_boundary_rule =
          String(stamp.strataBoundaries ?? "") === "between_distinct_scores" ? "distinct_score_share" : "OTHER";
        exp.one_arm_stratum_contribution =
          String(stamp.strataOneArmContribution ?? "") === "null_excluded_from_pool" ? "null" : "OTHER";
        exp.pooled_excludes_one_arm = "yes";
      }
      break;
    }
    case "negative_control": {
      exp.treated_level = String(stamp.treatedLevel ?? "");
      exp.arm_levels = [stamp.referenceLevel, stamp.treatedLevel].filter(Boolean).join(",");
      exp.horizon_days = String(stamp.horizonDays ?? "");
      /* THE THRESHOLD. Stamped because it decides every verdict, cross-checked
       * because a program could print one number and compare against another. */
      exp.bias_threshold = String(stamp.biasThreshold ?? "");
      exp.bias_interval_is_symmetric = "yes";
      if (Array.isArray(stamp.controls))
        exp.control_ids = (stamp.controls as Array<{ id: string }>).map((c) => c.id).join(",");
      exp.same_pipeline_ate_weights =
        String(stamp.adjustment ?? "") === "saturated_score_iptw" && String(stamp.estimand ?? "") === "ate" ? "yes" : "no";
      exp.control_interval_emitted =
        String(stamp.interval ?? "") === "none_declared_threshold_is_the_test" ? "no" : "yes";
      exp.rationale_emitted = "yes";
      putBandingExpectations(exp, stamp);
      break;
    }
    case "comorbidity_index": {
      if (Array.isArray(stamp.conditions)) {
        const cs = stamp.conditions as Array<{ id: string; weight: number }>;
        exp.condition_ids = cs.map((c) => c.id).join(",");
        exp.condition_weights = cs.map((c) => String(c.weight)).join(",");
      }
      if (Array.isArray(stamp.supersessions))
        exp.supersessions = (stamp.supersessions as Array<{ winner: string; loser: string }>)
          .map((p) => `${p.winner}>${p.loser}`).join(",");
      const lb = stamp.lookback as { start?: unknown } | undefined;
      if (lb && typeof lb.start === "number") exp.lookback_lower_days = String(lb.start);
      /* The stamp claims supersession only withholds the WEIGHT. The code must
       * do exactly that — and must still report the superseded prevalence. */
      if (stamp.supersessionEffect === "withholds_weight_keeps_prevalence") {
        exp.hierarchy_withholds_weight = "yes";
        exp.superseded_prevalence_kept = "yes";
      }
      if (stamp.medianEstimator === "percentile_cont_equivalent") exp.quantile_probabilities = "0.5";
      exp.zeros_included = "yes";
      /* THE SCORE IS NEVER CLAMPED, whether or not this index carries a negative
       * weight. Asserted unconditionally because a clamp is never right: with
       * only positive weights it is invisible, so one introduced there would sit
       * undetected until the first index that actually needed a negative one. */
      exp.score_clamped_at_zero = "no";
      /* NEGATIVE WEIGHTS are stamped only when present, so the ABSENCE of the
       * key is itself the claim "every weight in this index is positive" — and
       * the code must then contain no negative weight either. */
      const neg = stamp.negativeWeights as { conditions?: unknown } | undefined;
      exp.negative_weights = Array.isArray(neg?.conditions) ? (neg.conditions as string[]).join(",") : "";
      /* The FLOOR band, from the stamp's own band list. With a negative weight
       * this is the band the negative totals land in, and it is the only bound
       * of the ladder the `score >=` scrape cannot see. */
      if (Array.isArray(stamp.bands) && (stamp.bands as string[]).length > 0)
        exp.score_band_floor_label = (stamp.bands as string[])[0];
      break;
    }
    case "sweep": {
      /* The stamp names every arm, in declaration order, with its kind and its
       * one difference. The code must contain exactly that list: a dropped arm,
       * a reordered one, a subgroup relabelled as a sensitivity check, or a
       * varied value that does not match the declaration all show up here and
       * nowhere else in the output. */
      const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String).join("|") : "");
      if (Array.isArray(stamp.armIds)) {
        exp.sweep_arm_ids = list(stamp.armIds);
        exp.sweep_arm_count = String((stamp.armIds as unknown[]).length);
        exp.sweep_arm_ords = (stamp.armIds as unknown[]).map((_a, i) => String(i + 1)).join("|");
      }
      if (Array.isArray(stamp.armKinds)) exp.sweep_arm_kinds = list(stamp.armKinds);
      if (Array.isArray(stamp.armParams)) exp.sweep_arm_params = list(stamp.armParams);
      if (Array.isArray(stamp.armParamValues)) exp.sweep_arm_param_values = list(stamp.armParamValues);
      if (Array.isArray(stamp.armSlices)) exp.sweep_arm_slices = list(stamp.armSlices);
      if (typeof stamp.primaryArmId === "string") exp.sweep_primary_arm = stamp.primaryArmId;
      /* WHICH ROW OF THE ARM'S TABLE, and which column of it. Both are stamped
       * because reading the right column of the wrong row (or the wrong column
       * of the right one) gives a summary that is complete, well-formed and
       * about something else. An empty selector is itself a claim: this target's
       * row is identified by its component alone. */
      if (typeof stamp.valueColumn === "string") exp.sweep_value_column = stamp.valueColumn;
      if (typeof stamp.selectorStatistic === "string")
        exp.sweep_target_statistic = stamp.selectorStatistic === "" ? "ABSENT" : stamp.selectorStatistic;
      if (typeof stamp.statisticComponent === "string" && stamp.statisticComponent !== "")
        exp.sweep_target_component = stamp.statisticComponent;
      if (typeof stamp.nullValue === "string") exp.sweep_null_value = stamp.nullValue === "none" ? "NONE" : stamp.nullValue;
      /* The three things the stamp CLAIMS the program does. Each is a property
       * of the emitted code and each would be invisible in the numbers: a sweep
       * with no range still reports every arm, and a sweep with no direction
       * test still reports a range. */
      if (stamp.reportsEveryArm === true) exp.sweep_arm_accounting = "yes";
      if (stamp.reportsRange === true) exp.sweep_range_reported = "yes";
      if (stamp.reportsMultiplicity === true) exp.sweep_multiplicity_reported = "yes";
      if (stamp.reportsDirection === "yes") exp.sweep_direction_test = "yes";
      if (stamp.reportsDirection === "no_null_value") exp.sweep_direction_test = "no";
      break;
    }
    case "resource_use": {
      const w = stamp.window as { start?: unknown; end?: unknown } | undefined;
      if (w && typeof w.start === "number") exp.window_lower_days = String(w.start);
      if (w && typeof w.end === "number") exp.window_upper_days = String(w.end);
      if (Array.isArray(stamp.edPlaceOfService)) exp.ed_places = (stamp.edPlaceOfService as string[]).join(",");
      if (typeof stamp.costField === "string") exp.cost_field = stamp.costField;
      if (typeof stamp.daysPerYear === "string") exp.days_per_year = stamp.daysPerYear;
      /* The stamp CLAIMS these rules; the code must implement them. This is
       * where the inpatient double count would be caught: the stamp says
       * "admission_total_lines_excluded" and the NOT EXISTS clause is what
       * makes that true. */
      if (stamp.inpatientRule === "admission_total_lines_excluded") {
        exp.ip_lines_excluded_when_admission_exists = "yes";
        exp.ip_orphan_fallback_on_admdate = "yes";
        exp.ip_dated_at_admission = "yes";
      }
      exp.encounter_collapse_key = "yes";
      exp.denominator_is_whole_cohort = "yes";

      /* THE ECONOMICS LAYER.
       *
       * Every option below is stamped ONLY when declared, so the ABSENCE of a
       * key is itself a claim: "this program is all-cause / fixed-window /
       * nominal". Those claims are asserted here too, which is what stops the
       * new machinery from appearing in a program that never asked for it. */
      const att = stamp.attribution as
        | { dxPosition?: unknown; dxColumns?: unknown; procColumns?: unknown; procedureCodeListId?: unknown; drugSource?: unknown }
        | undefined;
      exp.attribution_kind = att ? "disease_related" : "all_cause";
      if (att) {
        if (typeof att.dxPosition === "string") exp.attribution_dx_position = att.dxPosition;
        // the stamp names the slots; the code must scan exactly those
        if (Array.isArray(att.dxColumns)) exp.attribution_dx_columns = (att.dxColumns as string[]).join(",");
        if (Array.isArray(att.procColumns)) exp.attribution_proc_columns = (att.procColumns as string[]).join(",");
        exp.attribution_encounter_is_any_line = "yes";
        exp.attribution_dr_default = "0";
        exp.dr_cost_is_filtered = "yes";
        exp.dr_reported_beside_all_cause = "yes";
        if (typeof att.drugSource === "string") exp.attribution_drug_source = att.drugSource;
      }

      const norm = stamp.normalization as
        | { per?: unknown; excludeCapitated?: unknown; capitatedPlanTypes?: unknown; daysPerUnit?: unknown }
        | undefined;
      exp.normalization_basis = norm ? "observed_member_months" : "fixed_window";
      if (norm) {
        if (typeof norm.daysPerUnit === "string") exp.member_time_days_per_unit = norm.daysPerUnit;
        /* The denominator the stamp CLAIMS. Reverting to the stitched-episode
         * observed days is the exact defect this catches, and it leaves a
         * perfectly plausible PPPM behind. */
        exp.pppm_denominator_source = "eligible_days";
        exp.member_time_numerator_filtered = "yes";
        exp.member_time_merges_adjacent_only = "yes";
        exp.member_time_source = "enroll_segments";
        if (norm.excludeCapitated === true && Array.isArray(norm.capitatedPlanTypes))
          exp.capitated_plan_types = (norm.capitatedPlanTypes as string[]).join(",");
        if (norm.excludeCapitated === false) exp.capitated_plan_types = "";
      }

      const inf = stamp.inflation as { targetYear?: unknown; seriesLabel?: unknown; factors?: unknown } | undefined;
      exp.cost_basis_kind = inf ? "restated" : "nominal";
      if (inf) {
        if (typeof inf.factors === "string") exp.inflation_factors = inf.factors;
        const ty = num(inf.targetYear);
        if (ty) exp.inflation_target_year = ty;
        if (typeof inf.seriesLabel === "string") exp.inflation_series = inf.seriesLabel;
        exp.inflation_missing_year_is_null = "yes";
      } else {
        // nothing to restate: no factor may appear anywhere in the program
        exp.inflation_factors = "";
      }

      /* QUANTILES. medianEstimator alone covers the no-quantile case (the
       * median has always been PERCENTILE_CONT-equivalent); quantileDefinition
       * appears only when quartiles are actually emitted. */
      const qdef = stamp.quantileDefinition;
      if (typeof qdef === "string") {
        exp.quantile_definition_label = qdef;
        exp.quantile_probabilities = "0.25,0.5,0.75";
        exp.quantile_estimator = qdef === "nearest_rank" ? "percentile_disc" : "percentile_cont";
      } else if (stamp.medianEstimator === "percentile_cont_equivalent") {
        exp.quantile_probabilities = "0.5";
        exp.quantile_estimator = "percentile_cont";
      }
      break;
    }
    case "calendar_trend": {
      /* The stamp lists every bucket; the code must contain exactly those
       * boundaries, in that order, plus the overall span on the Trend row.
       * A bucket silently shifted by a day is the failure this catches. */
      const bk = stamp.buckets as Array<{ start?: unknown; end?: unknown }> | undefined;
      if (Array.isArray(bk) && bk.length > 0) {
        const bounds = bk.flatMap((b) => [String(b.start), String(b.end)]);
        exp.bucket_bounds = [...bounds, String(bk[0].start), String(bk[bk.length - 1].end)].join(",");
      }
      if (Array.isArray(stamp.scores)) exp.bucket_scores = (stamp.scores as number[]).join(",");
      // The three CA sums and the z ratio are the test; none is optional.
      exp.ca_sum_wr = "yes";
      exp.ca_sum_wn = "yes";
      exp.ca_sum_w2n = "yes";
      exp.ca_z_is_t_over_sd = "yes";
      break;
    }
    case "period_prevalence": {
      const p = stamp.period as { start?: unknown; end?: unknown } | undefined;
      if (typeof p?.start === "string") {
        exp.period_start = p.start;
        // demographics reference date and the overlap lower bound are the
        // period start by construction — they must not drift from it
        exp.ref_date = p.start;
        exp.overlap_end_ge = p.start;
      }
      if (typeof p?.end === "string") {
        exp.period_end = p.end;
        exp.overlap_start_le = p.end;
      }
      break;
    }
  }
  return exp;
}

/* ------------------------------------------------------------------ *
 *  Statistical-constant profile (per language, pinned counts)
 * ------------------------------------------------------------------ */

/** The exact literals the CI algebra depends on. A typo in any one of these
 *  silently shifts every confidence interval the study reports. */
const STAT_CONSTANTS: Array<{ key: string; re: RegExp; means: string }> = [
  { key: "z", re: /1\.96/g, means: "z for 95%" },
  { key: "z2_half", re: /1\.9208/g, means: "z^2/2 (Wilson)" },
  { key: "z2", re: /3\.8416/g, means: "z^2 (Wilson)" },
  { key: "z2_quarter", re: /0\.9604/g, means: "z^2/4 (Wilson)" },
];

/** How many times each constant must appear in each language's code.
 *
 *  Pinned per language ON PURPOSE: the twins are algebraically identical but
 *  structurally different, so these counts are not cross-comparable. Pinning
 *  them is what makes a SINGLE mistyped occurrence detectable (2 -> 1) instead
 *  of hiding behind a sibling occurrence that is still correct.
 *
 *  If a module is deliberately restructured, update the number here — the diff
 *  makes a reviewer look at the CI math, which is the point.
 *
 *  A module may pin SEVERAL WHOLE profiles when a spec option genuinely changes
 *  which intervals exist — survival emits a hazard-ratio interval and a
 *  chi-square critical value only when the spec asks for a two-group
 *  comparison. They are listed as complete profiles rather than as a set of
 *  allowed counts per constant, so an incoherent combination (the chi-square
 *  critical value present with no comparison to use it on) still fails. */
type ConstantProfileSpec = Record<string, number> | Array<Record<string, number>>;
const EXPECTED_CONSTANTS: Record<string, Record<"sql" | "sas", ConstantProfileSpec>> = {
  incidence: {
    // Byar: z appears in both bounds; Wilson constants are not used.
    sql: { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  point_prevalence: {
    sql: { z: 2, z2_half: 2, z2: 2, z2_quarter: 2 },
    sas: { z: 1, z2_half: 2, z2: 2, z2_quarter: 1 },
  },
  period_prevalence: {
    sql: { z: 2, z2_half: 2, z2: 2, z2_quarter: 2 },
    sas: { z: 1, z2_half: 2, z2: 2, z2_quarter: 1 },
  },
  cumulative_incidence: {
    sql: { z: 2, z2_half: 2, z2: 2, z2_quarter: 2 },
    sas: { z: 1, z2_half: 2, z2: 2, z2_quarter: 1 },
  },
  regression: {
    /* z = 1.96 appears exactly TWICE in each twin, in the two Wald bounds on the
     * log odds ratio, and nowhere else. The Wilson constants must not appear at
     * all — a z^2 here would mean somebody added a proportion interval to a
     * table of ratios. */
    sql: { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  treatment_switching: {
    /* No interval anywhere. A switch count is a count, and the mean time to
     * switch is a mean over switchers - neither carries a confidence interval,
     * because the uncertainty an analyst cares about here is the DEFINITION,
     * not sampling. The rule_sensitivity band is the honest substitute, and a z
     * appearing here would mean somebody put a Wald interval around a number
     * whose real uncertainty is a study decision. */
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  adherence: {
    /* No interval anywhere. PDC, MPR and the persistence mean are proportions
     * and averages reported WITHOUT confidence intervals, deliberately: the
     * denominator is a fixed window chosen by the analyst rather than a sample
     * size, so a Wilson interval around PDC would describe sampling error that
     * the design does not have. A z appearing here would mean somebody attached
     * an interval to a measure whose uncertainty is not sampling uncertainty. */
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  comorbidity_index: {
    /* No interval anywhere — the index reports a mean, an SD and a median, none
     * of which is a confidence interval. A z here would mean an interval was
     * added to a weighted score without saying so. */
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  sweep: {
    /* NO INTERVAL ANYWHERE, and that is the substantive claim rather than an
     * omission. The range across arms is not a confidence interval — it has no
     * coverage property at all — so a z appearing here would mean somebody
     * attached sampling uncertainty to a spread produced by analysis choices,
     * which is the single most inviting mistake this module could make. Each
     * arm's OWN interval lives in that arm's own program, where the estimator
     * that produced it is. */
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  resource_use: {
    /* No interval is computed anywhere in this module — an SD is a dispersion
     * statistic, not a confidence interval. A z appearing here would mean
     * someone added an interval to a cost mean without saying so, which for a
     * distribution this skewed would be a normal approximation on data that
     * badly violates it. */
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  calendar_trend: {
    /* Per-bucket Wilson intervals, structured exactly like the prevalence
     * modules (SQL inlines the radical in both bounds, SAS computes _rad once).
     * The Cochran-Armitage statistic itself uses NO z constant — z is the
     * OUTPUT here, not an input — so these counts must not grow when the trend
     * arithmetic changes. A 1.96 appearing in the trend algebra would mean
     * someone slipped a normal approximation in beside the statistic. */
    sql: { z: 2, z2_half: 2, z2: 2, z2_quarter: 2 },
    sas: { z: 1, z2_half: 2, z2: 2, z2_quarter: 1 },
  },
  // SMD is a descriptive diagnostic with NO confidence interval, so none of the
  // z constants may appear — a stray one would mean a CI crept in unannounced.
  standardization: {
    // No CI is computed in either twin here — the interval is SAS-primary, so
    // a z or z^2 appearing in this program would mean someone added an
    // approximation and labelled it as the exact method.
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  smd_balance: {
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  g_formula: {
    /* TWO whole profiles, because requesting an E-value genuinely adds an
     * interval this module otherwise does not compute.
     *
     *   z = 2  the two bounds of the AIPW risk-difference interval. The
     *          g-formula rows carry point estimates only — their interval is
     *          the AIPW one, since under double saturation the two estimators
     *          are the same quantity and a second interval would imply
     *          otherwise.
     *   z = 4  the two above, plus the two bounds of the RATIO interval the
     *          limit E-value needs. It is derived from the SAME
     *          influence-function variances (including the covariance), not
     *          from a second variance estimate. */
    sql: [
      { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
      { z: 4, z2_half: 0, z2: 0, z2_quarter: 0 },
    ],
    sas: [
      { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
      { z: 4, z2_half: 0, z2: 0, z2_quarter: 0 },
    ],
  },
  iptw_outcome: {
    /* z = 10 in each twin: two bounds each on the risk difference, the risk
     * ratio and the odds ratio, plus the two the odds-ratio delta method needs
     * spelled out. NO z^2 — this module estimates no proportion by the Wilson
     * form and runs no chi-square test.
     *
     * z = 12 when an E-value is requested: the ratio interval is recomputed in
     * its own block so the point value and the limit value bound the SAME
     * number, rather than one of them being read off a row. */
    sql: [
      { z: 10, z2_half: 0, z2: 0, z2_quarter: 0 },
      { z: 12, z2_half: 0, z2: 0, z2_quarter: 0 },
    ],
    sas: [
      { z: 10, z2_half: 0, z2: 0, z2_quarter: 0 },
      { z: 12, z2_half: 0, z2: 0, z2_quarter: 0 },
    ],
  },
  negative_control: {
    /* NO z, in either twin. No confidence interval is computed on a control
     * estimate at all: the DECLARED threshold is the test, and it was declared
     * in advance for exactly that reason. An interval here would invite "not
     * significant, therefore fine", which on a rare control outcome is a
     * statement about power — the direction in which a negative-control suite
     * is most often over-trusted. A z appearing here later means somebody
     * added one, and it should be argued for first. */
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  propensity_score: {
    /* NO z and NO z^2, in either twin. This module emits no confidence
     * interval at all: standardized differences are reported as point
     * estimates because their sampling distribution under weighting is not the
     * simple one, and an interval computed as though it were would be a
     * confident statement about the wrong quantity. A z appearing here later
     * means someone added an interval, and it should be argued for first. */
    sql: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 0, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  fine_gray: {
    /* Identical to cox, and for the same reasons: z twice in the one-step
     * interval, z^2 once in the score test's alpha = 0.05 decision. */
    sql: { z: 2, z2_half: 0, z2: 1, z2_quarter: 0 },
    sas: { z: 2, z2_half: 0, z2: 1, z2_quarter: 0 },
  },
  competing_risks: {
    /* z = 4: both bounds of the delta-method Wald interval, for each of the two
     *        causes. No z^2 anywhere — nothing here estimates a proportion by
     *        Wilson and nothing runs a chi-square test, because the one test
     *        this family would want (Gray's) is refused rather than
     *        approximated. A z^2 appearing here would mean something did. */
    sql: { z: 4, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 4, z2_half: 0, z2: 0, z2_quarter: 0 },
  },
  cox: {
    /* z = 2: both bounds of the one-step hazard ratio's Wald interval, and
     *        nowhere else - the fitted interval is PHREG's and is NULL here.
     * z2 = 1: 3.8416 in the score test's alpha = 0.05 decision, the same
     *        literal the Wilson interval uses, because it IS z^2.
     * The Wilson constants must not appear: no proportion is estimated here. */
    sql: { z: 2, z2_half: 0, z2: 1, z2_quarter: 0 },
    sas: { z: 2, z2_half: 0, z2: 1, z2_quarter: 0 },
  },
  survival: {
    /* TWO whole profiles, because a survival analysis with a two-group
     * comparison genuinely emits two more intervals than one without.
     *
     *   z = 2  both bounds of the survival interval. It is TWO and not four
     *          because the interval is computed once over the union of
     *          life-table and horizon points rather than once per row shape -
     *          the refactor exists so this number stops depending on whether
     *          the spec asked for a life table.
     *   z = 4  the two above, plus both bounds of the Peto hazard-ratio Wald
     *          interval, which exists only with a comparison.
     *   z2 = 1 3.8416 is the chi-square critical value at 1 df, which IS z^2 at
     *          the repo's pinned z = 1.96 - deliberately the same literal
     *          rather than a second 95% constant. It appears once, in the
     *          alpha = 0.05 log-rank decision, and only when there is a
     *          log-rank to decide.
     *   The Wilson constants must never appear: this module reports no
     *          proportion interval. */
    sql: [
      { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
      { z: 4, z2_half: 0, z2: 1, z2_quarter: 0 },
    ],
    sas: [
      { z: 2, z2_half: 0, z2: 0, z2_quarter: 0 },
      { z: 4, z2_half: 0, z2: 1, z2_quarter: 0 },
    ],
  },
};

/**
 * Count each statistical constant in one language's CODE — comments AND string
 * literals stripped.
 *
 * Strings are excluded because the point of this check is arithmetic: "a typo
 * in any one of these silently shifts every confidence interval the study
 * reports". A constant inside a label cannot shift anything. The survival
 * module forced the distinction — its log-rank row explains itself with
 * "chi-square(1) vs 3.8416 = z^2 at the repo-wide z = 1.96", so the prose alone
 * moved the counts and would have made a module's pinned profile depend on how
 * carefully its captions were worded.
 */
export function constantProfile(
  language: "sql" | "sas",
  content: string,
  setup = ""
): Record<string, number> {
  const stripStrings = (t: string) => t.replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');
  const code = stripStrings(
    language === "sas"
      ? resolveSasMacros(stripComments("sas", content), stripComments("sas", setup))
      : stripComments("sql", content));
  const out: Record<string, number> = {};
  for (const c of STAT_CONSTANTS) out[c.key] = Number(count(code, c.re));
  return out;
}

/** Compare an observed constant profile to the pinned expectation(s). The
 *  observed profile must match ONE pinned profile completely; the reported diff
 *  is against the nearest one, so the message names the constant that moved. */
export function diffConstantProfile(
  kind: string,
  language: "sql" | "sas",
  observed: Record<string, number>
): string[] {
  const spec = EXPECTED_CONSTANTS[kind]?.[language];
  if (!spec) return [];
  const candidates = Array.isArray(spec) ? spec : [spec];
  const diffs = candidates.map((want) => {
    const out: string[] = [];
    for (const c of STAT_CONSTANTS) {
      const w = want[c.key] ?? 0;
      const o = observed[c.key] ?? 0;
      if (w !== o) out.push(`${c.means} [${c.key}]: found ${o}x, expected ${w}x`);
    }
    return out;
  });
  if (diffs.some((d) => d.length === 0)) return [];
  return diffs.reduce((a, b) => (b.length < a.length ? b : a));
}

export function hasConstantProfile(kind: string): boolean {
  return EXPECTED_CONSTANTS[kind] !== undefined;
}

/* ------------------------------------------------------------------ *
 *  Language-local fingerprint keys
 * ------------------------------------------------------------------ */

/**
 * Keys that only ONE language can produce, by design — the SAS-primary contract
 * (emitters/sas-primary.ts) creates them in pairs: SQL asserts the column is
 * NULL, SAS asserts it is computed. Cross-language comparison must skip them,
 * because "present in SAS, absent in SQL" is the contract working, not drift.
 *
 * This was a latent defect, not a new requirement. `exact_ci_null_in_sql` and
 * `exact_ci_computed_in_sas` already existed and would have made
 * `diffFingerprints` report a spurious mismatch the moment a spec asked for
 * `poisson_exact` — the gold spec uses `poisson_byar`, so neither key was ever
 * emitted and the collision never fired.
 *
 * Skipping them here would weaken the check, so each is asserted SEPARATELY, in
 * its own language, by `languageLocalChecks` — the contract is enforced more
 * strictly than a cross-diff ever did, not less.
 */
export const LANGUAGE_LOCAL_KEYS: Record<string, { language: "sql" | "sas"; must: string; means: string; kind?: string }> = {
  exact_ci_null_in_sql: { language: "sql", must: "yes", means: "exact Poisson limits are NULL in SQL, not approximated" },
  /* THE FILLS FEEDER. The twins reach the same dispensings by different routes
   * on purpose: SQL reads one long <prefix>_fills table and narrows it with a
   * code_list_id predicate, SAS reads the spine's per-code-list event table, so
   * the table name IS the selection. Comparing these across languages would
   * report the design as drift; asserting each in its own language is what
   * catches a twin that stopped reading the feeder at all — which is the defect
   * that shipped here, as a SAS table name no emitter ever created. */
  from_source_in_sql: { kind: "treatment_switching", language: "sql", must: "NONEMPTY", means: "the SQL twin narrows the feeder to the index drug" },
  to_list_in_sql: { kind: "treatment_switching", language: "sql", must: "NONEMPTY", means: "the SQL twin knows which drugs count as a destination" },
  from_source_in_sas: { kind: "treatment_switching", language: "sas", must: "NONEMPTY", means: "the SAS twin reads a real per-code-list event table for the index drug" },
  to_list_in_sas: { kind: "treatment_switching", language: "sas", must: "NONEMPTY", means: "the SAS twin knows which drugs count as a destination" },
  fills_source_in_sql: { kind: "adherence", language: "sql", must: "NONEMPTY", means: "the SQL twin reads the <prefix>_fills feeder" },
  fills_selected_by_code_list_in_sql: { kind: "adherence", language: "sql", must: "NONEMPTY", means: "the SQL twin narrows the feeder to the measured drug" },
  fills_source_in_sas: { kind: "adherence", language: "sas", must: "NONEMPTY", means: "the SAS twin reads a real per-code-list event table, not a phantom one" },
  fills_selected_by_per_list_table_in_sas: { kind: "adherence", language: "sas", must: "yes", means: "the SAS twin selects its drug by reading that list's own table" },
  exact_ci_computed_in_sas: { language: "sas", must: "yes", means: "exact Poisson limits are genuinely computed in SAS" },
  trend_p_null_in_sql: { language: "sql", must: "yes", means: "the trend p-value is NULL in SQL, not guessed" },
  trend_p_computed_in_sas: { language: "sas", must: "yes", means: "the trend p-value is genuinely computed in SAS" },
  adjusted_null_in_sql: { language: "sql", must: "yes", means: "fitted GLM coefficients are NULL in SQL, not approximated" },
  adjusted_fitted_in_sas: { language: "sas", must: "yes", means: "fitted GLM coefficients are genuinely produced by a SAS modelling procedure" },
  saturated_anchor_present: { language: "sas", must: "yes", means: "the saturated model and its self-check against the closed form are emitted" },
  logrank_p_null_in_sql: { language: "sql", must: "yes", means: "the log-rank p-value is NULL in SQL, not approximated from the statistic beside it" },
  logrank_p_computed_in_sas: { language: "sas", must: "yes", means: "the log-rank p-value is genuinely produced by PROC LIFETEST" },
  km_anchor_present: { language: "sas", must: "yes", means: "PROC LIFETEST is run beside the closed-form life table and compared to it, with a verdict printed" },
  cox_fit_null_in_sql: { language: "sql", must: "yes", means: "the fitted Cox coefficient is NULL in SQL, not approximated by the one-step estimate sitting above it" },
  cox_fit_in_sas: { language: "sas", must: "yes", means: "PROC PHREG fits the model, with ties=breslow stated explicitly rather than left to the default" },
  cox_null_loglik_check: { language: "sas", must: "yes", means: "PHREG's null -2 LOG L is checked against the closed-form partial log-likelihood" },
  cox_score_zero_check: { language: "sas", must: "yes", means: "U(beta_hat) = 0 is verified — the fitted coefficient is checked against the equation that defines it" },
  iptw_anchor_present: { language: "sas", must: "yes", means: "the weighted saturated fit is run beside the Hajek arm means and compared to them (POINT estimates only — GENMOD's weighted standard errors are not the sandwich ones)" },
  ps_anchor_present: { language: "sas", must: "yes", means: "PROC LOGISTIC is run beside the saturated closed form and compared to it, so the saturation claim is checked rather than asserted" },
  fg_fit_null_in_sql: { language: "sql", must: "yes", means: "the fitted subdistribution coefficient is NULL in SQL, not approximated by the one-step estimate above it" },
  fg_fit_in_sas: { language: "sas", must: "yes", means: "PROC PHREG fits with eventcode= — without it it fits a cause-specific Cox model, cleanly, answering a different question" },
  fg_null_loglik_check: { language: "sas", must: "yes", means: "PHREG's null -2 LOG L is checked against the closed-form partial log-likelihood" },
  fg_score_zero_check: { language: "sas", must: "yes", means: "U(beta_hat) = 0 is verified on the WEIGHTED risk sets" },
  fg_subdistribution_check: { language: "sas", must: "yes", means: "the program checks whether a subdistribution model was actually fitted, by comparing its own two risk-set totals" },
  cif_anchor_present: { language: "sas", must: "yes", means: "PROC LIFETEST with eventcode= is run beside the closed-form CIF and compared to it, with a verdict printed" },
  cox_anchor_check: { language: "sas", must: "yes", means: "the constant-proportion closed form is checked, and says NOT APPLICABLE rather than passing vacuously when it does not apply" },
};

/** Assert every language-local key present in a fingerprint holds its required
 *  value, and that it appeared in the language that is supposed to produce it. */
export function languageLocalChecks(
  language: "sql" | "sas",
  fp: Fingerprint,
  kind?: string,
): Array<{ key: string; ok: boolean; detail: string }> {
  const out: Array<{ key: string; ok: boolean; detail: string }> = [];
  for (const [key, rule] of Object.entries(LANGUAGE_LOCAL_KEYS)) {
    const got = fp[key];
    /* A rule scoped to one module only applies to that module. Without this,
     * "the adherence twin must resolve a source table" would fail on every Cox
     * and incidence program in the repo. */
    if (rule.kind && kind && rule.kind !== kind) continue;
    if (got === undefined) {
      /* ABSENCE IS A FAILURE for a required key, not something to skip.
       *
       * This was a hole. The loop used to `continue` on a missing key, so a
       * corruption that made a key STOP BEING SCRAPED read as "not checked"
       * rather than "wrong" — and a mutation pointing the SAS twin at a table
       * no emitter creates went uncaught for exactly that reason. A key that
       * disappears is the loudest possible signal, and it was the one being
       * ignored. */
      if (rule.kind && rule.kind === kind && rule.language === language) {
        out.push({ key, ok: false, detail: `${key} is ABSENT from the ${language} twin — ${rule.means}` });
      }
      continue;
    }
    if (rule.language !== language) {
      out.push({ key, ok: false, detail: `${key} was scraped from the ${language} twin, but only ${rule.language} can produce it` });
      continue;
    }
    /* "NONEMPTY" asserts that a value was RESOLVED, not that it equals a
     * literal. A source table name is site- and spec-dependent (tz_f_fills,
     * tz.&tag._ev_index_drug), so there is no constant to pin — but "the twin
     * resolved SOME table here" is exactly the assertion that fails when a
     * module names a table no emitter creates, which is how the phantom
     * `020_rx` survived. */
    /* "ABSENT" is put()'s sentinel for a scrape that found nothing — it is a
     * STRING, not undefined, so a naive non-empty test passes on it and the
     * exact corruption this rule exists to catch reads as fine. That is how a
     * mutation pointing the SAS twin at a table no emitter creates survived
     * this check on its first run. */
    const ok =
      rule.must === "NONEMPTY"
        ? got !== "ABSENT" && String(got).trim().length > 0
        : got === rule.must;
    out.push({
      key,
      ok,
      detail: ok
        ? rule.means
        : rule.must === "NONEMPTY"
          ? `${key} resolved to nothing — ${rule.means}`
          : `${key} = "${got}", must be "${rule.must}" — ${rule.means}`,
    });
  }
  return out;
}

/** Human-readable diff of two fingerprints (empty array = identical).
 *  Language-local keys are excluded — see LANGUAGE_LOCAL_KEYS. */
export function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !LANGUAGE_LOCAL_KEYS[k]).sort();
  const out: string[] = [];
  for (const k of keys) {
    if (a[k] !== b[k]) out.push(`${k}: ${a[k] ?? "MISSING"} vs ${b[k] ?? "MISSING"}`);
  }
  return out;
}

/** Compare a fingerprint against stamp-derived expectations (subset check). */
export function diffAgainstExpected(fp: Fingerprint, exp: Fingerprint): string[] {
  const out: string[] = [];
  for (const [k, want] of Object.entries(exp)) {
    if (fp[k] !== want) out.push(`${k}: code says ${fp[k] ?? "MISSING"}, stamp says ${want}`);
  }
  return out;
}
