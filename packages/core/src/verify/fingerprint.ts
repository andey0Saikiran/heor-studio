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
    case "comorbidity_index": {
      /* The index IS its weights and its hierarchy. A dropped supersession or a
       * shifted weight produces a score that is wrong by a plausible amount on
       * every patient at once, so both are scraped in order. */
      const conds = [...sql.matchAll(/SELECT '([^']+)' AS cond_id, '.*' AS cond_label, (\d+) AS weight, (\d+) AS cond_ord/g)];
      put(fp, "condition_ids", conds.map((m) => m[1]).join(","));
      put(fp, "condition_weights", conds.map((m) => m[2]).join(","));
      put(fp, "supersessions",
        [...sql.matchAll(/SELECT '([^']+)' AS winner, '([^']+)' AS loser/g)].map((m) => `${m[1]}>${m[2]}`).join(","));
      put(fp, "lookback_lower_days", sqlLookbackOffset(sql));
      // The hierarchy must WITHHOLD the weight, not delete the condition.
      put(fp, "hierarchy_withholds_weight", /THEN 0 ELSE cd\.weight END AS weight_applied/i.test(sql) ? "yes" : "no");
      /* Condition prevalence must come from `has` (everyone who HAS it), not
       * from `applied` (whose weight survived) — otherwise a superseded
       * condition silently reads as absent. */
      put(fp, "superseded_prevalence_kept", /FROM cond cd LEFT JOIN has h ON h\.cond_id = cd\.cond_id/i.test(sql) ? "yes" : "no");
      // Zeros count: the mean is over the cohort, not over the affected.
      put(fp, "zeros_included", /FROM cohort c LEFT JOIN applied a/i.test(sql) ? "yes" : "no");
      put(fp, "score_bands", (sql.match(/WHEN score >= (\d+) THEN '[^']*'/g) ?? []).map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      put(fp, "quantile_probabilities",
        [...new Set((sql.match(/PERCENTILE_CONT\(([\d.]+)\)/gi) ?? []).map((m) => (/([\d.]+)/.exec(m) ?? [])[1]))].sort().join(","));
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
      // Quantile estimator: ONLY the median may be taken (see the module header)
      /* The DISTINCT set of probabilities taken, sorted. Deduped because the
       * module takes the median of two variables and SAS names the estimator
       * once; adding a quartile still shows up as "0.25,0.5" != "0.5". */
      put(fp, "quantile_probabilities",
        [...new Set((sql.match(/PERCENTILE_CONT\(([\d.]+)\)/gi) ?? []).map((m) => (/([\d.]+)/.exec(m) ?? [])[1]))].sort().join(","));
      put(fp, "denominator_is_whole_cohort", /CROSS JOIN settings_list/i.test(sql) ? "yes" : "no");
      put(fp, "cost_field", grab(sql, [/'(paytot|netpay)' AS cost_field/i]));
      put(fp, "days_per_year", grab(sql, [/encounters \* ([\d.]+) \/ NULLIF\(\s*s\.observed_days/i]));
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
  const setting = grab(sql, [/code_list_id\s*=\s*'[^']*'\s+AND\s+setting\s*=\s*'(\w+)'/i]);
  put(fp, "setting_filter", setting ?? "any");
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
    case "comorbidity_index": {
      const conds = [...sas.matchAll(/cond_id = "([^"]+)"; cond_label = "[^"]*"; weight = (\d+); cond_ord = (\d+)/g)];
      put(fp, "condition_ids", conds.map((m) => m[1]).join(","));
      put(fp, "condition_weights", conds.map((m) => m[2]).join(","));
      put(fp, "supersessions",
        [...sas.matchAll(/winner = "([^"]+)"; loser = "([^"]+)"/g)].map((m) => `${m[1]}>${m[2]}`).join(","));
      put(fp, "lookback_lower_days", sasLookbackOffset(sas));
      put(fp, "hierarchy_withholds_weight", /then 0 else cd\.weight end as weight_applied/i.test(sas) ? "yes" : "no");
      put(fp, "superseded_prevalence_kept", /left join work\._\w+_has as h on h\.cond_id = cd\.cond_id/i.test(sas) ? "yes" : "no");
      put(fp, "zeros_included", /left join work\._\w+_applied as b/i.test(sas) ? "yes" : "no");
      put(fp, "score_bands", (sas.match(/score >= (\d+) then do/gi) ?? []).map((m) => (/(\d+)/.exec(m) ?? [])[1]).join(","));
      put(fp, "quantile_probabilities", /pctldef=5/i.test(sas) && /median\s*=/i.test(sas) ? "0.5" : "");
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
      /* SAS names the estimator instead of a probability. PCTLDEF=5 is the only
       * definition that reproduces PERCENTILE_CONT(0.5), so it is pinned here
       * as "0.5" — the SAME token the SQL twin yields — and a site default
       * left implicit would read as MISSING. */
      put(fp, "quantile_probabilities", /pctldef=5/i.test(sas) && /median\s*=/i.test(sas) ? "0.5" : "");
      put(fp, "denominator_is_whole_cohort", /cross join work\._\w+_settings/i.test(sas) ? "yes" : "no");
      put(fp, "cost_field", grab(sas, [/cost_field = "(paytot|netpay)"/i]));
      put(fp, "days_per_year", grab(sas, [/encounters \* ([\d.]+) \/ observed_days/i]));
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

  const rawSetting = grab(sas, [/e\.setting\s*=\s*'(\w+)'/i]);
  put(fp, "setting_filter", rawSetting === undefined ? "any" : (SAS_SETTING_TO_SPEC[rawSetting] ?? `UNMAPPED(${rawSetting})`));
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
      if (stamp.medianEstimator === "percentile_cont_equivalent") exp.quantile_probabilities = "0.5";
      exp.encounter_collapse_key = "yes";
      exp.denominator_is_whole_cohort = "yes";
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
 *  makes a reviewer look at the CI math, which is the point. */
const EXPECTED_CONSTANTS: Record<string, Record<"sql" | "sas", Record<string, number>>> = {
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
  comorbidity_index: {
    /* No interval anywhere — the index reports a mean, an SD and a median, none
     * of which is a confidence interval. A z here would mean an interval was
     * added to a weighted score without saying so. */
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
};

/** Count each statistical constant in one language's CODE (comments stripped). */
export function constantProfile(
  language: "sql" | "sas",
  content: string,
  setup = ""
): Record<string, number> {
  const code =
    language === "sas"
      ? resolveSasMacros(stripComments("sas", content), stripComments("sas", setup))
      : stripComments("sql", content);
  const out: Record<string, number> = {};
  for (const c of STAT_CONSTANTS) out[c.key] = Number(count(code, c.re));
  return out;
}

/** Compare an observed constant profile to the pinned expectation. */
export function diffConstantProfile(
  kind: string,
  language: "sql" | "sas",
  observed: Record<string, number>
): string[] {
  const want = EXPECTED_CONSTANTS[kind]?.[language];
  if (!want) return [];
  const out: string[] = [];
  for (const c of STAT_CONSTANTS) {
    const w = want[c.key] ?? 0;
    const o = observed[c.key] ?? 0;
    if (w !== o) out.push(`${c.means} [${c.key}]: found ${o}x, expected ${w}x`);
  }
  return out;
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
export const LANGUAGE_LOCAL_KEYS: Record<string, { language: "sql" | "sas"; must: string; means: string }> = {
  exact_ci_null_in_sql: { language: "sql", must: "yes", means: "exact Poisson limits are NULL in SQL, not approximated" },
  exact_ci_computed_in_sas: { language: "sas", must: "yes", means: "exact Poisson limits are genuinely computed in SAS" },
  trend_p_null_in_sql: { language: "sql", must: "yes", means: "the trend p-value is NULL in SQL, not guessed" },
  trend_p_computed_in_sas: { language: "sas", must: "yes", means: "the trend p-value is genuinely computed in SAS" },
};

/** Assert every language-local key present in a fingerprint holds its required
 *  value, and that it appeared in the language that is supposed to produce it. */
export function languageLocalChecks(
  language: "sql" | "sas",
  fp: Fingerprint,
): Array<{ key: string; ok: boolean; detail: string }> {
  const out: Array<{ key: string; ok: boolean; detail: string }> = [];
  for (const [key, rule] of Object.entries(LANGUAGE_LOCAL_KEYS)) {
    const got = fp[key];
    if (got === undefined) continue;
    if (rule.language !== language) {
      out.push({ key, ok: false, detail: `${key} was scraped from the ${language} twin, but only ${rule.language} can produce it` });
      continue;
    }
    out.push({
      key,
      ok: got === rule.must,
      detail: got === rule.must ? rule.means : `${key} = "${got}", must be "${rule.must}" — ${rule.means}`,
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
