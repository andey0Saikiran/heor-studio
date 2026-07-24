import { useMemo, useState } from "react";
import type { StudySpec } from "@heor-studio/core";
import { specReadiness } from "@heor-studio/core";
import type { EmitOptions } from "@heor-studio/core";
import {
  bundleFilename,
  buildZip,
  downloadBlob,
  planBundle,
  type BundleEntry,
} from "../lib/exportZip";

type Plan = { entries: BundleEntry[] } | { error: string };

function groupNote(entries: BundleEntry[], prefix: string): number {
  return entries.filter((e) => e.path.startsWith(prefix)).length;
}

export default function ExportPanel({
  spec,
  options,
  onNavigate,
}: {
  spec: StudySpec;
  options: EmitOptions;
  onNavigate?: (step: number) => void;
}) {
  const readiness = specReadiness(spec);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);

  const plan = useMemo<Plan | null>(() => {
    if (!readiness.ready) return null;
    try {
      return { entries: planBundle(spec, options) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [spec, options, readiness.ready]);

  if (!readiness.ready) {
    return (
      <section className="card" aria-labelledby="export-locked-title">
        <h2 className="card-title" id="export-locked-title">
          Export is locked
        </h2>
        <p className="card-sub">
          The bundle includes generated code, so the same rule applies as on the Code step: no
          export until the spec is fully reviewed.
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
        {onNavigate && (
          <button type="button" className="btn" onClick={() => onNavigate(2)}>
            Go to Review
          </button>
        )}
      </section>
    );
  }

  const filename = bundleFilename(spec);

  return (
    <section className="card" aria-labelledby="export-title">
      <h2 className="card-title" id="export-title">
        Export bundle
      </h2>
      <p className="card-sub">
        Everything is assembled in your browser and downloaded as{" "}
        <code>{filename}</code>. The bundle carries its own provenance: the spec, a README with a
        verification disclaimer, and a generative-AI disclosure with the review attestation.
      </p>

      {plan && "error" in plan ? (
        <div className="inline-error" role="alert">
          Could not assemble the bundle: {plan.error}
        </div>
      ) : plan ? (
        <>
          <ul className="manifest" aria-label="Bundle contents">
            <li>
              spec.json
              <span className="manifest-note">reviewed study specification</span>
            </li>
            <li>
              README.md
              <span className="manifest-note">study summary + verification disclaimer</span>
            </li>
            <li>
              AI_DISCLOSURE.md
              <span className="manifest-note">AI use + human-review attestation</span>
            </li>
            <li>
              sas/
              <span className="manifest-note">{groupNote(plan.entries, "sas/")} SAS programs</span>
            </li>
            <li>
              sql_postgres/
              <span className="manifest-note">
                {groupNote(plan.entries, "sql_postgres/")} PostgreSQL scripts
              </span>
            </li>
            <li>
              sql_snowflake/
              <span className="manifest-note">
                {groupNote(plan.entries, "sql_snowflake/")} Snowflake scripts
              </span>
            </li>
            <li>
              codelists/
              <span className="manifest-note">
                {groupNote(plan.entries, "codelists/")} CSV code lists
              </span>
            </li>
          </ul>

          <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                setDownloaded(null);
                try {
                  const blob = await buildZip(plan.entries);
                  downloadBlob(blob, filename);
                  setDownloaded(filename);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Zipping…" : "Download bundle (.zip)"}
            </button>
            {downloaded && (
              <span className="badge badge-ok" role="status">
                Downloaded {downloaded}
              </span>
            )}
          </div>
          {error && (
            <div className="inline-error" role="alert">
              Export failed: {error}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
