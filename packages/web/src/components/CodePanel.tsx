import { useId, useMemo, useState } from "react";
import type { StudySpec } from "@heor-studio/core";
import { specReadiness } from "@heor-studio/core";
import type { EmitOptions, GeneratedFile } from "@heor-studio/core";
import type { TableNamingStrategy } from "@heor-studio/core";
import { DB_PREFIX } from "@heor-studio/core";
import { emitSas } from "@heor-studio/core";
import { emitSql } from "@heor-studio/core";
import { FlagButton } from "./CorrectionModal";
import type { FlagRequest } from "../lib/corrections";

type TabId = "sas" | "postgres" | "snowflake";

const TAB_LABELS: Record<TabId, string> = {
  sas: "SAS",
  postgres: "SQL · Postgres",
  snowflake: "SQL · Snowflake",
};

/** Where each emitter's files land in the export bundle (bundle.ts flattens
 *  every program into one folder per language, so the two paths differ). */
const BUNDLE_FOLDER: Record<TabId, string> = {
  sas: "sas",
  postgres: "sql_postgres",
  snowflake: "sql_snowflake",
};

function bundlePath(tab: TabId, emitterPath: string): string {
  return `${BUNDLE_FOLDER[tab]}/${emitterPath.split("/").pop() ?? emitterPath}`;
}

type EmitResult = { files: GeneratedFile[] } | { error: string };

function runEmitter(fn: () => GeneratedFile[]): EmitResult {
  try {
    return { files: fn() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function defaultNaming(kind: TableNamingStrategy["kind"], spec: StudySpec): TableNamingStrategy {
  switch (kind) {
    case "yearly_sas":
      return { kind, prefix: DB_PREFIX[spec.meta.database] ?? "ccae" };
    case "warehouse_yearly":
      return { kind, schema: "MS", pattern: "CCAE_{LETTER}_{YEAR}_{RELEASE}" };
    case "single_table":
      return { kind, schema: "marketscan", pattern: "{LETTER}" };
  }
}

function NamingEditor({
  spec,
  options,
  onChange,
}: {
  spec: StudySpec;
  options: EmitOptions;
  onChange: (o: EmitOptions) => void;
}) {
  const tagId = useId();
  const kindId = useId();
  const aId = useId();
  const bId = useId();
  const naming = options.naming;

  return (
    <div className="field-row">
      <div className="field">
        <label className="field-label" htmlFor={tagId}>
          Study tag
        </label>
        <input
          id={tagId}
          className="control control-num"
          style={{ width: "9rem" }}
          type="text"
          value={options.tag}
          onChange={(e) =>
            onChange({
              ...options,
              tag: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
            })
          }
        />
        <span className="field-hint">Prefixes work tables, e.g. {options.tag || "TAG"}_COHORT</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={kindId}>
          Table naming
        </label>
        <select
          id={kindId}
          className="control"
          value={naming.kind}
          onChange={(e) =>
            onChange({
              ...options,
              naming: defaultNaming(e.target.value as TableNamingStrategy["kind"], spec),
            })
          }
        >
          <option value="yearly_sas">Yearly SAS files (e.g. ccaes181)</option>
          <option value="warehouse_yearly">Warehouse, yearly tables</option>
          <option value="single_table">Warehouse, one table per family</option>
        </select>
      </div>
      {naming.kind === "yearly_sas" && (
        <div className="field">
          <label className="field-label" htmlFor={aId}>
            File prefix
          </label>
          <input
            id={aId}
            className="control control-num"
            style={{ width: "8rem" }}
            type="text"
            value={naming.prefix}
            onChange={(e) => onChange({ ...options, naming: { ...naming, prefix: e.target.value } })}
          />
          <span className="field-hint">Usually {DB_PREFIX[spec.meta.database] ?? "ccae"}</span>
        </div>
      )}
      {(naming.kind === "warehouse_yearly" || naming.kind === "single_table") && (
        <>
          <div className="field">
            <label className="field-label" htmlFor={aId}>
              Schema
            </label>
            <input
              id={aId}
              className="control"
              type="text"
              value={naming.schema}
              onChange={(e) =>
                onChange({ ...options, naming: { ...naming, schema: e.target.value } })
              }
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={bId}>
              Table pattern
            </label>
            <input
              id={bId}
              className="control"
              type="text"
              value={naming.pattern}
              onChange={(e) =>
                onChange({ ...options, naming: { ...naming, pattern: e.target.value } })
              }
            />
            <span className="field-hint">
              {naming.kind === "warehouse_yearly"
                ? "Placeholders: {LETTER} {YEAR} {RELEASE}"
                : "Placeholder: {LETTER}"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export default function CodePanel({
  spec,
  options,
  onOptionsChange,
  onNavigate,
  onFlag,
}: {
  spec: StudySpec;
  options: EmitOptions;
  onOptionsChange: (o: EmitOptions) => void;
  onNavigate?: (step: number) => void;
  onFlag: (r: FlagRequest) => void;
}) {
  const readiness = specReadiness(spec);
  const [tab, setTab] = useState<TabId>("sas");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const results = useMemo<Record<TabId, EmitResult> | null>(() => {
    if (!readiness.ready) return null;
    return {
      sas: runEmitter(() => emitSas(spec, options)),
      postgres: runEmitter(() => emitSql(spec, "postgres", options)),
      snowflake: runEmitter(() => emitSql(spec, "snowflake", options)),
    };
  }, [spec, options, readiness.ready]);

  if (!readiness.ready) {
    return (
      <section className="card" aria-labelledby="code-locked-title">
        <h2 className="card-title" id="code-locked-title">
          Code generation is locked
        </h2>
        <p className="card-sub">
          HEOR Studio will not generate code from an unreviewed spec — that is the point of the tool.
          Resolve these first:
        </p>
        <div className="banner banner-warn" role="status">
          <div className="banner-body">
            <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
              {readiness.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {onNavigate && (
            <>
              <button type="button" className="btn" onClick={() => onNavigate(2)}>
                Go to Review
              </button>
              <button type="button" className="btn" onClick={() => onNavigate(3)}>
                Go to Codelists
              </button>
            </>
          )}
        </div>
      </section>
    );
  }

  const current = results ? results[tab] : null;
  const files = current && "files" in current ? current.files : [];
  const selected = files.find((f) => f.path === selectedPath) ?? files[0] ?? null;

  const copy = async (file: GeneratedFile) => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopiedPath(file.path);
      window.setTimeout(() => setCopiedPath(null), 1600);
    } catch {
      /* clipboard unavailable; selection fallback is manual */
    }
  };

  return (
    <section className="card" aria-labelledby="code-title">
      <h2 className="card-title" id="code-title">
        Generated code
      </h2>
      <p className="card-sub">
        Deterministically emitted from the reviewed spec — regenerated on every edit. Adjust the
        study tag and table naming to match your site&rsquo;s MarketScan delivery.
      </p>

      <NamingEditor spec={spec} options={options} onChange={onOptionsChange} />

      <div className="tabs" role="tablist" aria-label="Code language">
        {(Object.keys(TAB_LABELS) as TabId[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="tab"
            onClick={() => {
              setTab(t);
              setSelectedPath(null);
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {current && "error" in current ? (
        <div className="inline-error" role="alert">
          The {TAB_LABELS[tab]} emitter reported a problem: {current.error}
        </div>
      ) : files.length === 0 ? (
        <p className="field-hint">The {TAB_LABELS[tab]} emitter produced no files for this spec.</p>
      ) : (
        <div className="code-layout">
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className="file-item"
                  aria-current={selected?.path === f.path}
                  onClick={() => setSelectedPath(f.path)}
                >
                  <span className="file-title">{f.title}</span>
                  <span className="file-path">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <div>
              <div className="code-head">
                <h3 style={{ margin: 0, fontSize: "1rem" }}>{selected.title}</h3>
                <span className="file-path">{selected.path}</span>
                <div className="code-head-actions">
                  <button type="button" className="btn btn-sm" onClick={() => copy(selected)}>
                    {copiedPath === selected.path ? "Copied" : "Copy"}
                  </button>
                  <FlagButton
                    what={`the generated program ${selected.path}`}
                    onClick={() =>
                      onFlag({
                        label: `${selected.title} (${TAB_LABELS[tab]})`,
                        context: [
                          `Emitted from spec version ${spec.meta.version} with study tag ${options.tag}.`,
                        ],
                        target: {
                          kind: "generated_code",
                          ref: selected.path,
                          specVersion: spec.meta.version,
                          artifactPath: bundlePath(tab, selected.path),
                        },
                        reasonHint:
                          "Which statement is wrong, and what does the protocol or your site's SAS/SQL do instead?",
                      })
                    }
                  />
                </div>
              </div>
              <div className="code-view" role="region" aria-label={`Source of ${selected.path}`}>
                <pre>
                  <code>{selected.content}</code>
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
