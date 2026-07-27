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
import { GOLD_A_SPEC, GOLD_A_OPTS } from "./fixture";
import type { Check } from "./run";

export function verifySilenceGuards(): Check[] {
  const out: Check[] = [];
  const push = (name: string, cond: boolean, detail: string) =>
    out.push({ name, status: cond ? "pass" : "fail", detail });

  /* 1. readiness BLOCKS enabled-but-unemittable analyses (silent-drop hole) */
  {
    const spec: StudySpec = JSON.parse(JSON.stringify(GOLD_A_SPEC));
    spec.analyses.push({
      id: "guard_std", label: "guard", enabled: true, kind: "standardization",
      base: "incidence_rate",
      outcomeDefinition: { codeListId: "ae_dx", minClaims: 1, setting: "any", diagnosisPosition: "any" },
      personTimeRule: { start: "index", censorAt: ["outcome", "disenrollment", "study_end"] },
      standardization: {
        method: "direct", strataIds: ["s1"],
        referencePopulation: { kind: "named", name: "us_2000_standard" },
        ciMethod: "normal_approx",
      },
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
