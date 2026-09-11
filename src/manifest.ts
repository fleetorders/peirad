/**
 * A doctor manifest declares which contract tests to run against a harness. It is
 * data, not code — a project ships a small `peirad.json` and the engine runs it,
 * so adding a project or a probe never touches the engine (adapter-per-consumer).
 */
import fs from "node:fs";

export type ProbeSpec =
  | {
      type: "command-exists";
      /**
       * A helper program the integration needs, checked instead of the harness
       * itself — a feature that shells out to something declares that program
       * here, so "installed but its helper is gone" stops reading as healthy.
       */
      command?: string;
      critical?: boolean;
    }
  | { type: "version" }
  | { type: "flag-accepted"; flags: string[]; critical?: boolean }
  | {
      type: "config-key";
      file: string;
      /** Dotted key paths that must exist (any value). */
      keys?: string[];
      /**
       * Dotted key path → the value it must hold, compared deeply. An update
       * that quietly switches a feature off is drift the day it lands, not a
       * key that still technically exists.
       */
      expect?: Record<string, unknown>;
      /**
       * Dotted key paths that must NOT exist. The leftover twin of a renamed
       * key still parses and still reads as configured, while the harness has
       * moved on to the new name and runs at its default.
       */
      absent?: string[];
      critical?: boolean;
    }
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
    }
  | {
      type: "script";
      /** Repo-relative path to an executable script (resolved against configDir). */
      script: string;
      args?: string[];
      /** Kill the script after this many ms (default 30_000). */
      timeoutMs?: number;
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

/** Fields any probe may carry, whatever its type. */
const COMMON_PROBE_FIELDS: readonly string[] = ["type", "critical"];

/**
 * The fields each probe type understands, by type name. A manifest written for
 * a newer engine may carry fields an older install has never heard of: the run
 * skips them and NAMES them (see `unknownProbeFields`) rather than passing as
 * though the assertion had been made. Keep a row here whenever a probe learns
 * a field — a field missing from this table reads as unknown to its own build.
 */
export const PROBE_FIELDS: Record<string, readonly string[]> = {
  "command-exists": ["command"],
  version: [],
  "flag-accepted": ["flags"],
  "config-key": ["file", "keys", "expect", "absent"],
  "transcript-field": ["glob", "fields"],
  "hook-registered": ["file", "event", "match"],
  script: ["script", "args", "timeoutMs"],
};

/** Manifest-level keys this build understands. */
export const MANIFEST_FIELDS: readonly string[] = [
  "name",
  "harness",
  "harnessProfile",
  "promptArgs",
  "outputArgs",
  "versionArgs",
  "configDir",
  "probes",
];

/** A key a manifest author wrote as a comment: never a field, never reported. */
const isComment = (key: string): boolean => key.startsWith("_");

function unknownKeys(
  obj: object,
  known: readonly string[],
  common: readonly string[] = [],
): string[] {
  return Object.keys(obj)
    .filter((k) => !isComment(k) && !known.includes(k) && !common.includes(k))
    .sort();
}

/**
 * Field names on a probe that this build does not understand. Returns nothing
 * for a probe type the build does not know at all — there is no field list to
 * compare against, and such a probe already renders `n/a` naming the type
 * (D-008); reporting its fields as well would say the same thing twice.
 */
export function unknownProbeFields(spec: ProbeSpec): string[] {
  const known = PROBE_FIELDS[spec.type];
  if (!known) return [];
  return unknownKeys(spec, known, COMMON_PROBE_FIELDS);
}

/** Manifest-level keys this build does not understand. */
export function unknownManifestFields(manifest: Manifest): string[] {
  return unknownKeys(manifest, MANIFEST_FIELDS);
}

export function loadManifest(path: string): Manifest {
  const raw = fs.readFileSync(path, "utf8");
  const m = JSON.parse(raw) as Manifest;
  if (!m.harness || !Array.isArray(m.probes)) {
    throw new Error(`invalid manifest ${path}: needs "harness" and "probes"`);
  }
  // Every probe must at least carry a string type — an unknown type NAME is
  // valid (the engine reports it n/a, fail-open), but a shapeless probe can
  // never be run or attributed, so it fails at load.
  m.probes.forEach((p, i) => {
    if (
      !p ||
      typeof p !== "object" ||
      typeof (p as { type?: unknown }).type !== "string"
    ) {
      throw new Error(
        `invalid manifest ${path}: probes[${i}] needs a string "type"`,
      );
    }
  });
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
