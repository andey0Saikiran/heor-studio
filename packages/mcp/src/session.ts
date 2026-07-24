/**
 * In-memory session store. The MCP server is a single local stdio process per
 * client, so a plain per-process Map is the right scope: specs and generated
 * artifacts live only for the life of the connection and never touch disk
 * (until the analyst explicitly exports a bundle). No patient data is ever here
 * — only the study spec and the generated code.
 */
import { randomUUID } from "node:crypto";
import type { StudySpec, BundleEntry } from "@heor-studio/core";

export interface Artifact {
  entries: BundleEntry[];
  filename: string;
}

const specs = new Map<string, StudySpec>();
const artifacts = new Map<string, Artifact>();

export function putSpec(spec: StudySpec): string {
  const id = `spec_${randomUUID().slice(0, 8)}`;
  specs.set(id, spec);
  return id;
}

export function getSpec(id: string): StudySpec | undefined {
  return specs.get(id);
}

export function putArtifact(entries: BundleEntry[], filename: string): string {
  const id = `art_${randomUUID().slice(0, 8)}`;
  artifacts.set(id, { entries, filename });
  return id;
}

export function getArtifact(id: string): Artifact | undefined {
  return artifacts.get(id);
}
