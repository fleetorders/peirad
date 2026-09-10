/**
 * The runner: load a manifest, resolve the harness, run every probe against the
 * live install, and return a dated verdict that NAMES the version it checked —
 * so "does it still hold?" has an answer with a timestamp, not a shrug.
 */
import type { Manifest } from "./manifest.js";
import {
  runProbe,
  harnessVersion,
  resolveBinary,
  type ProbeResult,
} from "./probes.js";
import { resolveProfile } from "./harness-profiles.js";

export interface Verdict {
  name: string;
  harness: string;
  /** Resolved path of the harness binary (`command -v`); omitted when the
   * harness is not resolvable on PATH. */
  path?: string;
  /** Invocation profile the probes ran under ("claude", "codex", …). */
  profile: string;
  version: string;
  date: string;
  results: ProbeResult[];
  degraded: number;
  blocked: number;
  /** Probes that cannot apply to this harness family (declared, not passed). */
  na: number;
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
  const profile = resolveProfile(
    manifest.harness,
    manifest.harnessProfile,
    manifest,
  );
  const harnessPath = resolveBinary(manifest.harness);
  const ctx = {
    harness: manifest.harness,
    configDir,
    profileName: profile.name,
    harnessPath,
  };

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
  const na = results.filter((r) => r.status === "n/a").length;
  return {
    name: manifest.name ?? manifest.harness,
    harness: manifest.harness,
    path: harnessPath ?? undefined,
    profile: profile.name,
    version,
    date: opts.date,
    results,
    degraded,
    blocked,
    na,
    ok: degraded === 0 && blocked === 0,
  };
}
