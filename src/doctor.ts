/**
 * The runner: load a manifest, resolve the harness, run every probe against the
 * live install, and return a dated verdict that NAMES the version it checked —
 * so "does it still hold?" has an answer with a timestamp, not a shrug.
 */
import type { Manifest } from "./manifest.js";
import { runProbe, harnessVersion, type ProbeResult } from "./probes.js";

export interface Verdict {
  name: string;
  harness: string;
  version: string;
  date: string;
  results: ProbeResult[];
  degraded: number;
  blocked: number;
  ok: boolean;
}

export interface RunOptions {
  /** Base dir for relative file/glob probes; defaults to the manifest's configDir or ".". */
  configDir?: string;
  /** ISO date stamp for the verdict; caller supplies it (keeps this pure/testable). */
  date: string;
}

export function runManifest(manifest: Manifest, opts: RunOptions): Verdict {
  const versionArgs = manifest.versionArgs ?? ["--version"];
  const configDir = opts.configDir ?? manifest.configDir ?? ".";
  const ctx = { harness: manifest.harness, configDir };

  const version = harnessVersion(manifest.harness, versionArgs);
  const results: ProbeResult[] = [];
  for (const spec of manifest.probes) {
    if (spec.type === "version") {
      results.push({ probe: "version", status: "pass", detail: version });
      continue;
    }
    results.push(runProbe(spec, ctx, versionArgs));
  }

  const degraded = results.filter((r) => r.status === "degraded").length;
  const blocked = results.filter((r) => r.status === "blocked").length;
  return {
    name: manifest.name ?? manifest.harness,
    harness: manifest.harness,
    version,
    date: opts.date,
    results,
    degraded,
    blocked,
    ok: degraded === 0 && blocked === 0,
  };
}
