/**
 * The runner: load a manifest, resolve the harness, run every probe against the
 * live install, and return a dated verdict that NAMES the version it checked —
 * so "does it still hold?" has an answer with a timestamp, not a shrug.
 */
import { unknownManifestFields, type Manifest } from "./manifest.js";
import {
  runProbe,
  harnessVersion,
  resolveBinary,
  ENGINE_VERSION,
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
  /** The checker's own version — which peirad produced this verdict. A pinned
   * caller knows it already; one that tracks the newest release does not, and
   * a verdict nobody can attribute to a build is not evidence. */
  checker: string;
  date: string;
  /** Lines about the run itself rather than about the integration — a
   * manifest key this build does not understand, for instance. Notes never
   * change the exit code: they describe the checker, not the contract. */
  notes: string[];
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
  const version = harnessVersion(manifest.harness, versionArgs);
  const ctx = {
    harness: manifest.harness,
    configDir,
    profileName: profile.name,
    harnessPath,
    harnessVersion: version,
    settingsLayers: profile.settingsLayers,
    settingsArrays: profile.settingsArrays,
  };

  const results: ProbeResult[] = [];
  for (const spec of manifest.probes) {
    results.push(runProbe(spec, ctx, versionArgs));
  }

  // A manifest-level key this build does not know is config, not an assertion:
  // it is named so the reader knows the setting had no effect, and the exit
  // code is left alone (the skipped-assertion case lives on the probe itself).
  const notes: string[] = [];
  const unknownKeys = unknownManifestFields(manifest);
  if (unknownKeys.length > 0) {
    notes.push(
      `manifest keys ignored by peirad ${ENGINE_VERSION}: ${unknownKeys.join(", ")} — upgrade peirad to honour them`,
    );
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
    checker: ENGINE_VERSION,
    date: opts.date,
    notes,
    results,
    degraded,
    blocked,
    na,
    ok: degraded === 0 && blocked === 0,
  };
}
