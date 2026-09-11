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
import { resolveProfile, type HarnessProfile } from "./harness-profiles.js";
import fs from "node:fs";
import {
  compareSurface,
  formatBaseline,
  makeBaseline,
  observeSurface,
  readBaseline,
  type BaselineReport,
  type Surface,
} from "./baseline.js";
import type { ProbeContext } from "./probes.js";

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
  /** What moved since the recorded baseline that no probe declares — a third
   * register, attached by a caller that compared one. Never counted in `ok`. */
  baseline?: BaselineReport;
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

/** Everything a run resolves once before any probe looks: the profile (with
 * the manifest's overrides folded in), the binary, the version, and the
 * context every probe — and the baseline observer — reads through. */
function prepare(
  manifest: Manifest,
  opts: { configDir?: string },
): {
  profile: HarnessProfile;
  ctx: ProbeContext & { harnessVersion: string };
  versionArgs: string[];
} {
  const versionArgs = manifest.versionArgs ?? ["--version"];
  const configDir = opts.configDir ?? manifest.configDir ?? ".";
  const profile = resolveProfile(
    manifest.harness,
    manifest.harnessProfile,
    manifest,
  );
  const harnessPath = resolveBinary(manifest.harness);
  const version = harnessVersion(manifest.harness, versionArgs);
  return {
    profile,
    versionArgs,
    ctx: {
      harness: manifest.harness,
      configDir,
      profileName: profile.name,
      harnessPath,
      harnessVersion: version,
      settingsLayers: profile.settingsLayers,
      settingsArrays: profile.settingsArrays,
      reports: profile.reports,
    },
  };
}

export function runManifest(manifest: Manifest, opts: RunOptions): Verdict {
  const { profile, ctx, versionArgs } = prepare(manifest, opts);
  const { harnessPath, harnessVersion: version } = ctx;

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

/**
 * Observe the surface a manifest points at — for recording a baseline or
 * comparing against one. Resolves the run the same way `runManifest` does, so
 * the ledger reads exactly where the probes read.
 */
export function observeManifest(
  manifest: Manifest,
  opts: { configDir?: string },
): Surface {
  const { profile, ctx } = prepare(manifest, opts);
  return observeSurface(manifest, ctx, profile);
}

export interface LedgerOptions {
  /** Base dir for relative probe paths, as the run used. */
  configDir?: string;
  /** The baseline file, resolved. */
  file: string;
  /** How the file is named in output — never an absolute machine path. */
  label: string;
  /** Write the observed surface instead of comparing against it. */
  record: boolean;
  /** The caller named the file outright, so its absence is worth saying. */
  explicit: boolean;
  /** ISO date stamped on a recorded baseline. */
  date: string;
}

/**
 * The ledger step after a run: record the observed surface, or compare it
 * against the recorded one and attach what moved. Returns a NEW verdict whose
 * `ok`, `degraded` and `blocked` are exactly the run's — movement is a reason
 * to look, never a failure, so it cannot reach the exit code.
 */
export function runLedger(
  manifest: Manifest,
  verdict: Verdict,
  opts: LedgerOptions,
): Verdict {
  const notes = [...verdict.notes];
  if (opts.record) {
    const surface = observeManifest(manifest, opts);
    fs.writeFileSync(
      opts.file,
      formatBaseline(
        makeBaseline(surface, {
          recorded: opts.date,
          checker: verdict.checker,
          harness: manifest.harness,
        }),
      ),
    );
    const sources = Object.keys(surface.settings).length;
    const globs = Object.keys(surface.transcripts).length;
    notes.push(
      `baseline recorded to ${opts.label}: harness ${surface.harnessVersion}, ${surface.help.length} help flags, ` +
        `${sources} settings ${sources === 1 ? "source" : "sources"}, ${globs} transcript ${globs === 1 ? "glob" : "globs"} — commit it beside the manifest`,
    );
    return { ...verdict, notes };
  }
  if (!fs.existsSync(opts.file)) {
    if (opts.explicit) {
      notes.push(
        `baseline ${opts.label} not found — record one with --record-baseline`,
      );
    }
    return { ...verdict, notes };
  }
  const read = readBaseline(opts.file);
  if (!read.ok) {
    notes.push(`baseline not compared: ${read.reason}`);
    return { ...verdict, notes };
  }
  const report = compareSurface(
    read.baseline,
    observeManifest(manifest, opts),
    manifest,
    opts.label,
  );
  return { ...verdict, notes, baseline: report };
}
