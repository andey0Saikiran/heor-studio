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
      put(fp, "score_population",
        (/subj AS \([\s\S]{0,900}?\n\s*FROM (\w+) c\b/i.exec(sql) ?? [])[1] ?? "ABSENT");
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
    case "iptw_outcome": {
      exp.treated_level = String(stamp.treatedLevel ?? "");
      exp.horizon_days = String(stamp.horizonDays ?? "");
      exp.score_population = String(stamp.scorePopulation ?? "") === "at_risk_after_washout" ? "atrisk" : "OTHER";
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
  iptw_outcome: {
    /* z = 10 in each twin: two bounds each on the risk difference, the risk
     * ratio and the odds ratio, plus the two the odds-ratio delta method needs
     * spelled out. NO z^2 — this module estimates no proportion by the Wilson
     * form and runs no chi-square test. */
    sql: { z: 10, z2_half: 0, z2: 0, z2_quarter: 0 },
    sas: { z: 10, z2_half: 0, z2: 0, z2_quarter: 0 },
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
export const LANGUAGE_LOCAL_KEYS: Record<string, { language: "sql" | "sas"; must: string; means: string }> = {
  exact_ci_null_in_sql: { language: "sql", must: "yes", means: "exact Poisson limits are NULL in SQL, not approximated" },
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
