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
    const quitProcs = n(code, /\bproc\s+(?:sql|datasets)\b/gi);
    const quits = n(code, /\bquit\s*;/gi);
    if (quits < quitProcs) {
      problems.push(`${name}: ${quitProcs} proc sql/datasets but only ${quits} quit;`);
    }

    // 3. data steps must be closed with run;
    const dataSteps = n(code, /^\s*data\s+[\w.&]/gim);
    const otherProcs = n(code, /\bproc\s+(?!sql\b|datasets\b)\w+/gi);
    const runs = n(code, /\brun\s*;/gi);
    if (runs < dataSteps + otherProcs) {
      problems.push(`${name}: ${dataSteps} data steps + ${otherProcs} procs but only ${runs} run;`);
    }

    // 4. Balanced parentheses in code (comments already stripped). Unbalanced
    //    parens are the classic symptom of a mis-built expression.
    let depth = 0;
    let broke = false;
    for (const ch of code) {
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
