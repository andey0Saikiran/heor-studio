/**
 * Silence guards — regression checks for the Wave-0 "make silence impossible"
 * fixes (docs/PENDING.md). Each check exists because an audit PROVED the
 * failure it pins:
 *   1. an enabled analysis with no registered emitter used to pass readiness
 *      and vanish from the bundle with zero diagnostics;
 *   2. EmitOptions.tag / naming values used to flow verbatim into generated
 *      SQL identifiers (injection);
 *   3. untrusted spec JSON used to be cast straight to StudySpec, so wrong
 *      field types were emitted into code;
 *   4. bundle files landed at sql_postgres/postgres/… while the README told
 *      the client sql_postgres/….
 * (The zero-cohort run_verification gate is pinned in the MCP smoke test,
 * which drives the real server.)
 */
import { specReadiness } from "../spec/types";
import type { StudySpec } from "../spec/types";
import { checkSpecShape } from "../spec/shape";
import { emitSql } from "../emitters/sql";
import { emitSas as emitSasFn } from "../emitters/sas";
import { planBundle } from "../bundle";
import { DEFAULT_SUPPRESSION_THRESHOLD } from "../emitters/suppression";
import { EMITTER_VERSION, stableHash } from "../provenance";
import { moduleAnalyses } from "../emitters/modules/registry";
import { normalizeSpec } from "../extract/anthropic";
import { DEFAULT_EMIT_OPTIONS } from "../emitters/types";
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import type { Check } from "./run";

export function verifySilenceGuards(): Check[] {
  const out: Check[] = [];
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });

  /* 1. readiness BLOCKS enabled-but-unemittable analyses (silent-drop hole)
   *
   * The kind here is DELIBERATELY SYNTHETIC. This guard previously used whatever
   * real analysis kind happened to be unbuilt — standardization, then
   * calendar_trend — and broke on the day each one shipped, which is a guard
   * that fails for the one reason that is good news. It is also the wrong test:
   * readiness keys on membership in EMITTABLE_ANALYSIS_KINDS, so a kind that is
   * definitionally absent from that set exercises the mechanism directly and
   * keeps doing so no matter how many modules land.
   *
   * Do not "fix" this back to a real unbuilt kind. */
  {
    const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    spec.analyses.push({
      id: "guard_no_generator", label: "guard", enabled: true,
      kind: "kind_that_has_no_registered_generator",
    } as never);
    const r = specReadiness(spec);
    push(
      "guard: enabled unemittable analysis BLOCKS readiness",
      !r.ready && r.problems.some((p) => p.includes("no code generator")),
      r.ready ? "readiness said ready — silent drop is back" : `blocked: ${r.problems.find((p) => p.includes("no code generator")) ?? r.problems.join("; ")}`
    );
    // same spec but DISABLED must stay ready (planned work stays visible)
    (spec.analyses[spec.analyses.length - 1] as { enabled: boolean }).enabled = false;
    const r2 = specReadiness(spec);
    push("guard: disabled unemittable analysis does NOT block", r2.ready, r2.ready ? "ready as expected" : r2.problems.join("; "));
  }

  /* 2. identifier-injection guard in both emitters */
  {
    let threw = "";
    try {
      emitSql(GOLD_A_SPEC, "postgres", { ...GOLD_A_OPTS, tag: 'x; DROP TABLE enrollment;--' });
    } catch (e) {
      threw = (e as Error).message;
    }
    push("guard: SQL emitter rejects injection tag", threw.includes("not a safe identifier"), threw ? threw.slice(0, 80) : "emitter ACCEPTED an injection tag");
  }

  /* 3. structural shape gate rejects wrong-typed untrusted JSON */
  {
    const bad = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as Record<string, unknown>;
    const an = (bad.analyses as Array<Record<string, unknown>>).find((a) => a.kind === "incidence_rate")!;
    (an.outcomeDefinition as Record<string, unknown>).minClaims = "2"; // string, not number
    const r = checkSpecShape(bad);
    push("guard: shape check rejects minClaims as string", !r.ok && r.problems.some((p) => p.includes("minClaims")), r.ok ? "accepted a string minClaims" : r.problems.find((p) => p.includes("minClaims")) ?? "");

    const bad2 = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as Record<string, unknown>;
    const cl = (bad2.codeLists as Array<Record<string, unknown>>)[0];
    (cl.codes as Array<Record<string, unknown>>).push({ code: "L40.0'; DROP TABLE x;--", source: "user_entered", verified: true });
    const r2 = checkSpecShape(bad2);
    push("guard: shape check rejects quote/semicolon in a code", !r2.ok && r2.problems.some((p) => p.includes("never valid in a clinical code")), r2.ok ? "accepted an injection code string" : "rejected");

    const good = checkSpecShape(JSON.parse(JSON.stringify(GOLD_A_SPEC)));
    push("guard: shape check accepts the gold spec", good.ok, good.ok ? "gold spec passes shape" : good.problems.slice(0, 3).join("; "));

    // meta free-text comment-escape vectors (found by the Wave-0 diff review):
    // a newline escapes a SQL `--` header; "*/" closes a SAS block comment.
    const injVersion = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as Record<string, unknown>;
    (injVersion.meta as { version: string }).version = "1\n; DROP TABLE public.enrollment; --";
    const rv = checkSpecShape(injVersion);
    push("guard: shape check rejects newline in meta.version", !rv.ok && rv.problems.some((p) => p.includes("version")), rv.ok ? "accepted a newline in version" : "rejected");

    const injProv = JSON.parse(JSON.stringify(GOLD_A_SPEC)) as Record<string, unknown>;
    (injProv.meta as { provenance: Record<string, unknown> }).provenance = { method: "llm_extraction", model: "x */; %put PWNED; /*" };
    const rp = checkSpecShape(injProv);
    push("guard: shape check rejects */ in provenance.model", !rp.ok && rp.problems.some((p) => p.includes("provenance.model")), rp.ok ? "accepted */ in model" : "rejected");
  }

  /* 3b. emitters escape meta free-text even if a raw spec reaches them
     (defense-in-depth: the shape gate above is the boundary, this is the emitter) */
  {
    const inj: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    inj.meta.version = "1\n; DROP TABLE x; --";
    inj.meta.provenance = { method: "llm_extraction", model: "m */; %put PWNED; data _null_; run; /*" };
    // The injected payload names table "x" (legit emitter drops are tz_study_*).
    // It is neutralized iff it only ever appears on a COMMENT line (starts "--").
    const sqlFiles = emitSql(inj, "postgres", GOLD_A_OPTS);
    const sqlLive = sqlFiles.some((f) =>
      f.content.split("\n").some((ln) => ln.includes("DROP TABLE x") && !ln.trimStart().startsWith("--"))
    );
    push("guard: SQL emitter neutralizes newline in meta.version", !sqlLive, sqlLive ? "injected DROP escaped onto a live SQL line" : "version stayed on one comment line");
    const sasFiles = emitSasFn(inj, GOLD_A_OPTS);
    // the payload's raw "*/" must be neutralized to "* /" wherever model text appears
    const sasEscaped = sasFiles.every((f) => !f.content.includes("m */; %put PWNED"));
    push("guard: SAS emitter neutralizes */ in provenance.model", sasEscaped, sasEscaped ? "*/ escaped to * / in headers" : "raw */ survived into a SAS block comment");
  }

  /* 3c. Wave-1 connect-the-ends: a representative extractor tool output must
     normalize into ENABLED descriptive-epi analyses that actually reach the
     emitters (this was the whole point of Wave 1 — the four verified modules
     were previously unreachable through extraction). */
  {
    const raw = {
      meta: { title: "Guard study", version: "0.1.0", database: "marketscan_ccae",
        studyPeriod: { start: "2016-01-01", end: "2021-12-31" }, provenance: { method: "llm_extraction" } },
      codeLists: [
        { id: "idx", label: "Index drug", system: "drug_name", codes: [{ code: "ADALIMUMAB", source: "ai_suggested", verified: false }] },
        { id: "oc", label: "Outcome", system: "icd10cm", codes: [{ code: "L40.0", source: "ai_suggested", verified: false }] },
      ],
      indexEvent: { type: "first_drug_claim", codeListId: "idx", indexPeriod: { start: "2016-01-01", end: "2021-12-31" } },
      enrollment: { baselineDays: 365, followupDays: 365, gapAllowanceDays: 31, requiresRxCoverage: true },
      criteria: [],
      baseline: [{ id: "b_sex", label: "Sex", kind: "sex" }],
      analyses: [
        { kind: "incidence_rate", id: "ir", label: "IR", enabled: true, outcomeDefinition: { codeListId: "oc", minClaims: 1, setting: "any", diagnosisPosition: "any" } },
        { kind: "point_prevalence", id: "pp", label: "PP", enabled: true, outcomeDefinition: { codeListId: "oc", minClaims: 1, setting: "any", diagnosisPosition: "any" }, anchorDate: { kind: "fixed", date: "2020-07-01" } },
        { kind: "cumulative_incidence", id: "ci", label: "CI", enabled: true, outcomeDefinition: { codeListId: "oc", minClaims: 1, setting: "any", diagnosisPosition: "any" }, horizonDays: 365 },
        { kind: "future_stub", id: "cost", label: "Cost", enabled: true, plannedKind: "cost" },
      ],
    };
    const spec = normalizeSpec(raw, { model: "guard", sourceDocumentName: "guard" });
    const enabledKinds = new Set(spec.analyses.filter((a) => a.enabled).map((a) => a.kind));
    push("guard: extractor output enables the descriptive-epi modules",
      ["incidence_rate", "point_prevalence", "cumulative_incidence"].every((k) => enabledKinds.has(k as never)),
      `enabled kinds: ${[...enabledKinds].join(", ")}`);
    push("guard: extractor future_stub stays disabled (does not block readiness)",
      !spec.analyses.some((a) => a.kind === "future_stub" && a.enabled),
      "cost stub disabled");
    const shape = checkSpecShape(spec);
    push("guard: normalized extractor spec is shape-valid", shape.ok, shape.ok ? "valid" : shape.problems.slice(0, 3).join("; "));
    const files = emitSql(spec, "postgres", DEFAULT_EMIT_OPTIONS).map((f) => f.path);
    const reached = ["incidence", "pointprev", "cuminc"].every((slug) => files.some((p) => p.includes(slug)));
    push("guard: emitter produces a file for each enabled descriptive-epi analysis", reached,
      reached ? "incidence + pointprev + cuminc emitted" : `emitted: ${files.filter((p) => /\/\d/.test(p)).join(", ")}`);
  }

  /* 3d. minClaims counting semantics must MATCH across languages.
     SQL counted rows (COUNT(*)) while SAS counted distinct service dates, so a
     single encounter recorded in two diagnosis slots — or on both inpatient
     sources for one stay — satisfied ">= 2 claims" in SQL but not SAS. Both
     must count distinct dates. */
  {
    const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    spec.criteria = [
      {
        id: "inc_two_claims",
        kind: "inclusion",
        sourceText: "At least 2 claims of the outcome condition",
        // no claimSeparationDays: exercises the branch that diverged
        test: { type: "diagnosis", codeListId: "ae_dx", minClaims: 2, setting: "any", window: { start: "anytime_before", end: 0, includesIndex: true } },
        confidence: "high",
        reviewed: true,
      },
    ];
    const sql = emitSql(spec, "postgres", GOLD_A_OPTS).map((f) => f.content).join("\n");
    const sas = emitSasFn(spec, GOLD_A_OPTS).map((f) => f.content).join("\n");
    const sqlDistinct = /COUNT\(DISTINCT ev\.event_date\)\s*>=\s*2/i.test(sql);
    const sqlRows = /COUNT\(\*\)\s*>=\s*2/i.test(sql);
    const sasDistinct = /count\(distinct e\.svcdate\)/i.test(sas);
    push(
      "guard: minClaims counts DISTINCT service dates in both languages",
      sqlDistinct && !sqlRows && sasDistinct,
      sqlDistinct && !sqlRows && sasDistinct
        ? "both twins count distinct dates (one encounter = one claim)"
        : `sql distinct=${sqlDistinct} sql rows=${sqlRows} sas distinct=${sasDistinct}`,
    );
  }

  /* 3e. A requested-but-unimplemented death censor must be SURFACED, not
     silently dropped — and must not be stamped as consumed. The emitters used
     to claim MarketScan mortality was "unascertainable", contradicting
     BR-LIM-002 ("severely limited, but not absent": in-hospital death is
     observable via DSTATUS), while person-time quietly ran past it. */
  {
    const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    const inc = spec.analyses.find((a) => a.kind === "incidence_rate");
    if (inc && inc.kind === "incidence_rate") {
      inc.personTimeRule = { ...inc.personTimeRule, censorAt: ["outcome", "disenrollment", "death", "study_end"] };
    }
    for (const [lang, files] of [
      ["sql", emitSql(spec, "postgres", GOLD_A_OPTS)],
      ["sas", emitSasFn(spec, GOLD_A_OPTS)],
    ] as const) {
      const text = files.map((f) => f.content).join("\n");
      const noted = /death censoring is NOT implemented/.test(text);
      const stamped = /"censorAt":\[[^\]]*"death"/.test(text);
      push(
        `guard: ${lang} surfaces an unimplemented death censor and does not stamp it`,
        noted && !stamped,
        noted && !stamped
          ? "REVIEW note emitted; death excluded from the parity stamp"
          : `note=${noted} stampedAsConsumed=${stamped}`,
      );
    }
    // and the false "unascertainable" wording must not come back
    const all = emitSql(spec, "postgres", GOLD_A_OPTS).map((f) => f.content).join("\n") +
      emitSasFn(spec, GOLD_A_OPTS).map((f) => f.content).join("\n");
    push(
      "guard: generated code does not claim MarketScan mortality is unascertainable",
      !/unascertainable/i.test(all),
      !/unascertainable/i.test(all) ? "wording matches BR-LIM-002" : "found 'unascertainable' — contradicts BR-LIM-002",
    );
  }

  /* 3f. Suppression is ON BY DEFAULT and reaches every result table.
     A disclosure control that must be switched on is one that gets forgotten,
     and a control that silently skips a table is worse than none. */
  {
    const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    delete spec.suppression; // no policy stated at all
    const sqlFiles = emitSql(spec, "postgres", GOLD_A_OPTS);
    const supFile = sqlFiles.find((f) => /suppression/i.test(f.path));
    push(
      "guard: suppression is emitted by DEFAULT (no spec field needed)",
      !!supFile,
      supFile ? `${supFile.path} emitted at threshold ${DEFAULT_SUPPRESSION_THRESHOLD}` : "no suppression program emitted",
    );
    if (supFile) {
      // every module result table AND table1 must get a _released twin
      const expected = moduleAnalyses(spec.analyses).length + (spec.analyses.some((a) => a.enabled && a.kind === "table1") ? 1 : 0);
      const releasedCount = (supFile.content.match(/_released AS/g) ?? []).length;
      push(
        "guard: every result table gets a _released twin",
        releasedCount === expected,
        `expected ${expected}, emitted ${releasedCount}`,
      );
      push(
        "guard: suppression states the rule on the released rows",
        /AS suppression_rule/.test(supFile.content),
        "suppression_rule column present",
      );
    }
    // SAS twin must emit one too
    const sasSup = emitSasFn(spec, GOLD_A_OPTS).find((f) => /suppression/i.test(f.path));
    push("guard: SAS emits the suppression twin", !!sasSup, sasSup?.path ?? "missing");

    // opting OUT must be explicit and must actually take effect
    const off: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    off.suppression = { enabled: false };
    const noSup = emitSql(off, "postgres", GOLD_A_OPTS).some((f) => /suppression/i.test(f.path));
    push("guard: suppression can be explicitly disabled", !noSup, noSup ? "still emitted" : "omitted when enabled:false");
  }

  /* 3g. Reproducibility provenance. "Identical spec in, identical code out" is
     only auditable against a generator VERSION and a spec identity — otherwise
     a reviewer re-running a study a year later cannot tell a legitimate emitter
     change from a bug. */
  {
    const gold = stableHash(GOLD_A_SPEC);
    const edited: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    edited.enrollment.baselineDays = 180;
    push("guard: spec hash changes when the spec changes", stableHash(edited) !== gold, `${gold} vs ${stableHash(edited)}`);

    // logically identical specs must hash identically regardless of key order
    const shuffled: Record<string, unknown> = {};
    for (const k of Object.keys(GOLD_A_SPEC as unknown as Record<string, unknown>).reverse()) {
      shuffled[k] = (GOLD_A_SPEC as unknown as Record<string, unknown>)[k];
    }
    const reordered = JSON.parse(JSON.stringify(shuffled)) as StudySpec;
    push("guard: spec hash is stable under key reordering", stableHash(reordered) === gold, `${stableHash(reordered)} vs ${gold}`);

    const sqlHead = emitSql(GOLD_A_SPEC, "postgres", GOLD_A_OPTS)[0].content;
    const sasHead = emitSasFn(GOLD_A_SPEC, GOLD_A_OPTS)[0].content;
    push(
      "guard: emitted code stamps the emitter version and spec hash",
      sqlHead.includes(EMITTER_VERSION) && sqlHead.includes(gold) && sasHead.includes(EMITTER_VERSION) && sasHead.includes(gold),
      `sql=${sqlHead.includes(gold)} sas=${sasHead.includes(gold)} v${EMITTER_VERSION}`,
    );

    const readme = planBundle(GOLD_A_SPEC, GOLD_A_OPTS, "2026-01-01T00:00:00Z").find((f) => /readme\.md$/i.test(f.path));
    push(
      "guard: bundle README carries the reproducibility block",
      !!readme && readme.content.includes("## Reproducibility") && readme.content.includes(gold) && readme.content.includes(EMITTER_VERSION),
      readme ? "emitter version + spec hash present" : "no README in bundle",
    );
  }

  /* 4. bundle layout matches the README the client reads */
  {
    const entries = planBundle(GOLD_A_SPEC, GOLD_A_OPTS, "2026-01-01T00:00:00.000Z");
    const badPaths = entries.filter((e) => /^sql_(postgres|snowflake)\/.*\//.test(e.path) || /^sas\/.*\//.test(e.path));
    push("guard: bundle files sit directly under their README folder", badPaths.length === 0, badPaths.length === 0 ? `${entries.length} entries, all flat` : `nested: ${badPaths.slice(0, 3).map((e) => e.path).join(", ")}`);
    const pg = entries.filter((e) => e.path.startsWith("sql_postgres/"));
    push("guard: postgres scripts present under sql_postgres/", pg.length > 0, `${pg.length} files`);
  }

  return out;
}
