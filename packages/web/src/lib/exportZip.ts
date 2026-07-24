/**
 * Browser bundle download. The bundle CONTENTS are planned by @heor-studio/core
 * (platform-neutral); this file only zips them and triggers a browser download.
 * Nothing leaves the browser.
 */
import JSZip from "jszip";
import type { EmitOptions, StudySpec, BundleEntry } from "@heor-studio/core";
import { planBundle, bundleFilename } from "@heor-studio/core";

export type { BundleEntry };

export async function buildZip(entries: BundleEntry[]): Promise<Blob> {
  const zip = new JSZip();
  for (const e of entries) zip.file(e.path, e.content);
  return zip.generateAsync({ type: "blob" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Plan, zip, and download in one step. */
export async function exportStudyBundle(spec: StudySpec, opts: EmitOptions): Promise<string> {
  const entries = planBundle(spec, opts);
  const blob = await buildZip(entries);
  const name = bundleFilename(spec);
  downloadBlob(blob, name);
  return name;
}
