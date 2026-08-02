/**
 * Structural checks on the emitted SAS.
 *
 * There is no free SAS runtime, so the SAS twin can never be execution-verified
 * the way the Postgres twin is. Fingerprints (verify/fingerprint.ts) prove the
 * SAS computes the same QUANTITIES as the executed SQL; they say nothing about
 * whether the program is well-formed. Before this, zero SAS bytes were ever
 * parsed — a program with an unbalanced comment or a `proc sql` missing its
 * `quit;` would ship, and the analyst would find out by running it.
 *
 * These are deliberately structural, not a SAS parser: every rule is one an
 * emitter bug would plausibly trip, and each is cheap and unambiguous.
 */
import type { Check } from "./run";

interface SasFile {
  path: string;
  content: string;
}

/** Strip block comments, tracking whether they were balanced. */
function stripBlockComments(text: string): { code: string; unbalanced: boolean } {
  let code = "";
  let i = 0;
  let unbalanced = false;
  while (i < text.length) {
    const open = text.indexOf("/*", i);
    if (open === -1) {
      code += text.slice(i);
      break;
    }
    code += text.slice(i, open);
    const close = text.indexOf("*/", open + 2);
    if (close === -1) {
      unbalanced = true;
      break;
    }
    code += " ";
    i = close + 2;
  }
  return { code, unbalanced };
}

/** Count non-overlapping matches. */
function n(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/**
 * Blank out quoted string literals.
 *
 * SAS text inside quotes is DATA, not code structure, and the counting rules
 * below cannot tell the difference on their own. The survival module found
 * this: a `title "Kaplan-Meier anchor: PROC LIFETEST vs the closed form"`
 * counted as a ninth procedure, so the lint demanded a ninth `run;` that no
 * correct program would have — a rule failing on a program that was right.
 *
 * The same hazard applies to parentheses: a method label mentioning
 * "d(n-d)n1n0 / (n^2 (n-1))" is balanced by luck, not by structure, and one
 * that was not would have read as a mis-built expression.
 *
 * Only the STRUCTURAL rules use this. The macro-variable check deliberately
 * does not: SAS resolves `&var.` inside double quotes, so a macro reference in
 * a string is a real reference and must still be defined.
 */
function stripStrings(text: string): string {
  return text.replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');
}

/** Structural lint over every emitted .sas file. */
export function sasStructureChecks(files: SasFile[]): Check[] {
  const checks: Check[] = [];
  const sasFiles = files.filter((f) => f.path.endsWith(".sas"));

  checks.push({
    name: "sas: programs were emitted",
    status: sasFiles.length > 0 ? "pass" : "fail",
    detail: `${sasFiles.length} .sas files`,
  });

  const problems: string[] = [];

  for (const f of sasFiles) {
    const name = f.path.split("/").pop() ?? f.path;
    const { code, unbalanced } = stripBlockComments(f.content);
    /* Structural rules read the STRING-FREE text; see stripStrings. The macro
     * check below deliberately reads `code` instead. */
    const codeNS = stripStrings(code);

    // 1. An unterminated /* ... comment swallows the rest of the program.
    if (unbalanced) problems.push(`${name}: unterminated block comment`);

    // 1b. Delimiter COUNTS must match too. Scanning alone cannot see a dropped
    //     `*/`: it just merges two comments and consumes them as one, silently
    //     commenting out every statement between them. (Mutation testing found
    //     exactly this hole.) The emitter escapes `*/` inside comment text via
    //     cmt(), so an unpaired delimiter is always a defect.
    const opens = n(f.content, /\/\*/g);
    const closes = n(f.content, /\*\//g);
    if (opens !== closes) {
      problems.push(`${name}: ${opens} "/*" vs ${closes} "*/" — a comment delimiter is unpaired, so code is being swallowed into a comment`);
    }

    // 2. Every proc must be closed. `proc sql` and `proc datasets` close with
    //    quit; most others close with run;. An unclosed proc silently swallows
    //    the following statements into itself.
    const quitProcs = n(codeNS, /\bproc\s+(?:sql|datasets)\b/gi);
    const quits = n(codeNS, /\bquit\s*;/gi);
    if (quits < quitProcs) {
      problems.push(`${name}: ${quitProcs} proc sql/datasets but only ${quits} quit;`);
    }

    // 3. data steps must be closed with run;
    const dataSteps = n(codeNS, /^\s*data\s+[\w.&]/gim);
    const otherProcs = n(codeNS, /\bproc\s+(?!sql\b|datasets\b)\w+/gi);
    const runs = n(codeNS, /\brun\s*;/gi);
    if (runs < dataSteps + otherProcs) {
      problems.push(`${name}: ${dataSteps} data steps + ${otherProcs} procs but only ${runs} run;`);
    }

    // 4. Balanced parentheses in code (comments already stripped). Unbalanced
    //    parens are the classic symptom of a mis-built expression.
    let depth = 0;
    let broke = false;
    for (const ch of codeNS) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth < 0) { broke = true; break; }
      }
    }
    if (broke || depth !== 0) {
      problems.push(`${name}: unbalanced parentheses (${broke ? "closed too many" : `${depth} unclosed`})`);
    }

    // 5. Every &macro. referenced must be defined — in this file, in 00_setup
    //    (which each program %includes), or be a SAS automatic variable.
    //    An undefined macro var resolves to literal text and corrupts results.
    const AUTOMATIC = new Set(["sysdate", "sysdate9", "systime", "sysuserid", "sysscp", "syserr", "sqlobs"]);
    const setup = sasFiles.find((s) => /setup/i.test(s.path));
    const defined = new Set<string>();
    for (const src of [f.content, setup?.content ?? ""]) {
      for (const m of src.matchAll(/%let\s+(\w+)\s*=/g)) defined.add(m[1].toLowerCase());
      /* PROC SQL's `select ... into :name` is the OTHER way a macro variable
       * gets defined, and it is the only way to define one from data. Missing
       * it here made the lint reject a program that was perfectly correct —
       * the propensity-score stratifier reads its own cohort size that way,
       * because a %let cannot hold a number nobody knows until run time. */
      for (const m of src.matchAll(/\binto\s*:(\w+)/gi)) defined.add(m[1].toLowerCase());
      // macro parameters, e.g. %macro foo(bar=, baz=);
      for (const m of src.matchAll(/%macro\s+\w+\s*\(([^)]*)\)/g)) {
        for (const p of m[1].split(",")) {
          const nm = p.split("=")[0].trim();
          if (nm) defined.add(nm.toLowerCase());
        }
      }
    }
    const undef = new Set<string>();
    for (const m of code.matchAll(/&(\w+)\.?/g)) {
      const v = m[1].toLowerCase();
      if (!defined.has(v) && !AUTOMATIC.has(v)) undef.add(m[1]);
    }
    if (undef.size > 0) problems.push(`${name}: undefined macro variable(s) &${[...undef].join(", &")}`);

    /* 5b. Every WORK dataset a program READS must also be CREATED in that same
     *     program. SAS work datasets do not survive between programs, so a
     *     reference to one that is never built is a guaranteed runtime failure —
     *     and a purely syntactic lint sails straight past it. This was found the
     *     hard way: a new module's SAS twin referenced work._NNN_pt2, which
     *     nothing created, while balanced-parens/closed-procs checks stayed green. */
    const created = new Set<string>();
    for (const m of codeNS.matchAll(/create\s+table\s+(work\.\w+)/gi)) created.add(m[1].toLowerCase());
    for (const m of codeNS.matchAll(/^\s*data\s+(work\.\w+)/gim)) created.add(m[1].toLowerCase());
    /* `out=` and its procedure-specific siblings. PROC LIFETEST writes its
     * survival curve to `outsurv=`, which a bare `out=` pattern does not see —
     * so the program read a dataset the lint believed nothing created, and a
     * correct program was flagged. Same class as the ODS OUTPUT gap below. */
    for (const m of codeNS.matchAll(/\b(?:out|outsurv|outest|outstat|outcorr|outcov)\s*=\s*(work\.\w+)/gi)) created.add(m[1].toLowerCase());
    // PROC APPEND creates its BASE dataset when it does not already exist, so
    // an append target counts as created (checked against 030_index, which
    // legitimately accumulates into work._030_dob0 that way).
    for (const m of codeNS.matchAll(/proc\s+append[^;]*base\s*=\s*(work\.\w+)/gi)) created.add(m[1].toLowerCase());
    /* ODS OUTPUT routes a procedure's own output table into a dataset — the way
     * fitted model estimates are captured. It creates the dataset as surely as
     * a DATA step does, and this check flagged a correct program until it knew
     * that. Found by the regression module, which is the first to capture
     * PROC LOGISTIC's ParameterEstimates. */
    /* ONE `ods output` statement can route SEVERAL tables at once:
     *   ods output ParameterEstimates = work._a
     *              FitStatistics      = work._b;
     * The old pattern was non-greedy up to the first `=`, so it saw work._a and
     * missed work._b — and then flagged the program for reading a dataset
     * nothing created. Take every target in the statement, not the first. */
    for (const stmt of codeNS.matchAll(/ods\s+output\b[^;]*/gi)) {
      for (const m of stmt[0].matchAll(/=\s*(work\.\w+)/gi)) created.add(m[1].toLowerCase());
    }
    const referenced = new Set<string>();
    for (const m of codeNS.matchAll(/\bfrom\s+(work\.\w+)/gi)) referenced.add(m[1].toLowerCase());
    for (const m of codeNS.matchAll(/\bjoin\s+(work\.\w+)/gi)) referenced.add(m[1].toLowerCase());
    for (const m of codeNS.matchAll(/^\s*set\s+(work\.\w+)/gim)) referenced.add(m[1].toLowerCase());
    for (const m of codeNS.matchAll(/data\s*=\s*(work\.\w+)/gi)) referenced.add(m[1].toLowerCase());
    const dangling = [...referenced].filter((r) => !created.has(r));
    if (dangling.length > 0) {
      problems.push(`${name}: reads work dataset(s) it never creates: ${dangling.join(", ")} — the program would fail at runtime`);
    }

    // 6. Analysis programs must %include the setup that defines the macros.
    if (!/setup/i.test(f.path) && !/%include\s+["'][^"']*setup/i.test(f.content)) {
      problems.push(`${name}: does not %include 00_setup.sas (its &macros. would be undefined)`);
    }
  }

  checks.push({
    name: "sas: every program is structurally well-formed",
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0
      ? `${sasFiles.length} programs: comments balanced, procs/data steps closed, parens balanced, all &macros. defined, setup included`
      : problems.join(" | "),
  });

  return checks;
}
