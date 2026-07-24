/* prototype incidence SQL against the fixture — run: npx tsx packages/core/src/verify/proto_incidence.ts */
import { seedAndRun, rows } from "./engine";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";

const INCIDENCE_SQL = `
WITH cohort AS (SELECT enrolid, index_date, index_code FROM tz_study_cohort),
ae AS (SELECT enrolid, event_date FROM tz_study_events WHERE code_list_id = 'ae_dx'),
prevalent AS (
  -- washout: AE anywhere in baseline [index-365, index] removes the subject
  SELECT DISTINCT c.enrolid
  FROM cohort c JOIN ae a ON a.enrolid = c.enrolid
  WHERE a.event_date BETWEEN (c.index_date - 365) AND c.index_date
),
atrisk AS (SELECT c.* FROM cohort c WHERE c.enrolid NOT IN (SELECT enrolid FROM prevalent)),
first_fu AS (
  SELECT c.enrolid, MIN(a.event_date) AS fu_date
  FROM atrisk c JOIN ae a ON a.enrolid = c.enrolid AND a.event_date > c.index_date
  GROUP BY c.enrolid
),
pt AS (
  SELECT c.enrolid, c.index_code, c.index_date, ep.episode_end, f.fu_date,
         LEAST(ep.episode_end, DATE '2020-12-31', c.index_date + 365) AS admin_censor
  FROM atrisk c
  JOIN tz_study_enroll_episodes ep
    ON ep.enrolid = c.enrolid AND c.index_date BETWEEN ep.episode_start AND ep.episode_end
  LEFT JOIN first_fu f ON f.enrolid = c.enrolid
),
pt2 AS (
  SELECT enrolid, index_code,
         (LEAST(COALESCE(fu_date, DATE '9999-12-31'), admin_censor) - index_date) AS person_days,
         CASE WHEN fu_date IS NOT NULL AND fu_date <= admin_censor THEN 1 ELSE 0 END AS is_case
  FROM pt
),
agg AS (
  SELECT 'Overall' AS stratum, COUNT(*)::int AS denominator, SUM(is_case)::int AS patients, SUM(person_days)::numeric AS person_days FROM pt2
  UNION ALL SELECT 'DRUG_X', COUNT(*)::int, SUM(is_case)::int, SUM(person_days)::numeric FROM pt2 WHERE index_code = '00000000001'
  UNION ALL SELECT 'DRUG_Y', COUNT(*)::int, SUM(is_case)::int, SUM(person_days)::numeric FROM pt2 WHERE index_code = '00000000002'
)
SELECT stratum, patients, denominator, person_days,
  ROUND((person_days / 365.25)::numeric, 4) AS person_years,
  ROUND((patients * 1000 * 365.25 / person_days)::numeric, 2) AS rate_per_1000py,
  ROUND(((CASE WHEN patients = 0 THEN 0
               ELSE POWER(1 - 1.0/(9*patients) - 1.96/(3*SQRT(patients)), 3) * patients END)
        * 1000 * 365.25 / person_days)::numeric, 2) AS ci_low,
  ROUND((POWER(1 - 1.0/(9*(patients+1)) + 1.96/(3*SQRT(patients+1)), 3) * (patients+1)
        * 1000 * 365.25 / person_days)::numeric, 2) AS ci_high
FROM agg ORDER BY (stratum <> 'Overall'), stratum;
`;

async function main() {
  const { db } = await seedAndRun(GOLD_A_SPEC, GOLD_A_OPTS);
  const r = await rows<Record<string, unknown>>(db, INCIDENCE_SQL);
  console.log("=== incidence result ===");
  for (const row of r) console.log("  " + JSON.stringify(row));
  console.log("\nExpected Overall: patients 3, denominator 8, person_days 2425, rate 451.86, ci ~ (90.82, 1320.55)");
  console.log("Expected DRUG_X: patients 2, denom 4, person_days 1030 | DRUG_Y: patients 1, denom 4, person_days 1395");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
