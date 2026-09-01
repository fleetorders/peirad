/**
 * A doctor manifest declares which contract tests to run against a harness. It is
 * data, not code — a project ships a small `peirad.json` and the engine runs it,
 * so adding a project or a probe never touches the engine (adapter-per-consumer).
 */
import fs from "node:fs";

export type ProbeSpec =
  | { type: "command-exists"; critical?: boolean }
  | { type: "version" }
  | { type: "flag-accepted"; flags: string[]; critical?: boolean }
  | { type: "config-key"; file: string; keys: string[]; critical?: boolean }
  | {
      type: "transcript-field";
      glob: string;
      fields: string[];
      critical?: boolean;
    }
  | {
      type: "hook-registered";
      file: string;
      event: string;
      match: string;
      critical?: boolean;
    };

export interface Manifest {
  /** Human name for the integration being checked. */
  name?: string;
  /** The harness command, e.g. "claude". */
  harness: string;
  /**
   * Invocation profile ("claude", "codex"): how the harness is called
   * headless and how its reply is parsed. Inferred from the harness name
   * when absent; an unknown harness defaults to the "claude" convention.
   */
  harnessProfile?: string;
  /** Replace the profile's prompt argv; one element must be "{prompt}". */
  promptArgs?: string[];
  /** Replace the profile's machine-readable-output argv. */
  outputArgs?: string[];
  /** Args that print the version (default ["--version"]). */
  versionArgs?: string[];
  /** Relative paths in probes resolve against this (default "."). Overridden by --config-dir. */
  configDir?: string;
  probes: ProbeSpec[];
}

export function loadManifest(path: string): Manifest {
  const raw = fs.readFileSync(path, "utf8");
  const m = JSON.parse(raw) as Manifest;
  if (!m.harness || !Array.isArray(m.probes)) {
    throw new Error(`invalid manifest ${path}: needs "harness" and "probes"`);
  }
  for (const key of ["harnessProfile"] as const) {
    if (m[key] !== undefined && typeof m[key] !== "string") {
      throw new Error(`invalid manifest ${path}: "${key}" must be a string`);
    }
  }
  for (const key of ["promptArgs", "outputArgs"] as const) {
    const v = m[key];
    if (
      v !== undefined &&
      (!Array.isArray(v) || v.some((a) => typeof a !== "string"))
    ) {
      throw new Error(
        `invalid manifest ${path}: "${key}" must be an array of strings`,
      );
    }
  }
  return m;
}
