/**
 * The verdict as a ledger.
 *
 * A run answers "does what I declared still hold?". It cannot answer "what
 * moved that I never declared?", because it keeps nothing. A baseline is the
 * observed surface written down once, on request — the harness version, the
 * flags its help carries, the settings key names around what the manifest
 * declares, the field names its transcripts use — so a later run can report
 * what moved since, as a third register beside pass and drift.
 *
 * That register never changes the exit code. Something moving is a reason to
 * look, not evidence anything broke; the declared probes already say whether
 * anything broke.
 *
 * What is written is NAMES, never values, and only around what the manifest
 * points at: the file is meant to be committed beside the manifest, so a
 * reviewer sees the harness's surface move in a diff.
 */
import fs from "node:fs";
import type { Manifest, ProbeSpec } from "./manifest.js";
import type { HarnessProfile } from "./harness-profiles.js";
import {
  helpTokens,
  newestMatch,
  readSettings,
  type ProbeContext,
} from "./probes.js";

/** Default file name, beside the manifest. */
export const BASELINE_FILE = "peirad.baseline.json";

/** Record kind and format, so a file from a future format is refused loudly
 * instead of being misread. */
const KIND = "peirad-baseline";
const FORMAT = 1;

/** Everything a run observed about the harness — names only. */
export interface Surface {
  harnessVersion: string;
  /** Flag-shaped tokens in the profile's help output. */
  help: string[];
  /** Settings source ("effective", or a file as the manifest names it) →
   * key paths present there, scoped to what the manifest declares. */
  settings: Record<string, string[]>;
  /** Transcript glob → field paths seen on sampled records. */
  transcripts: Record<string, string[]>;
}

export interface Baseline extends Surface {
  kind: typeof KIND;
  format: typeof FORMAT;
  /** ISO date the surface was recorded. */
  recorded: string;
  /** The peirad version that recorded it. */
  checker: string;
  harness: string;
}

/** One thing that moved since the baseline and that no probe declares. */
export interface Moved {
  surface: "version" | "help" | "settings" | "transcript";
  /** The settings source or transcript glob; absent for version and help. */
  where?: string;
  change: "added" | "removed" | "changed";
  /** The token, key path or field path; for a version change, the new one. */
  name: string;
  /** For a version change, the recorded one. */
  from?: string;
}

export interface BaselineReport {
  /** The baseline file as the caller named it. */
  file: string;
  /** When the compared baseline was recorded. */
  recorded: string;
  moved: Moved[];
  /** Sources the manifest reads now that the baseline never recorded — they
   * cannot be compared until the baseline is recorded again. */
  untracked: string[];
}

// A key that is not identifier-shaped is data wearing a key's clothes — a
// file path, an id, a plugin@source pair. Recording it would write the user's
// content into a committed file and turn every new entry into "moved", so the
// parent is recorded with `*` and the walk stops there.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** Dotted paths of every object key down to `maxDepth`. Lists are values, not
 * structure: the walk never descends into one. */
export function keyPaths(value: unknown, maxDepth: number): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, prefix: string, depth: number): void => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    for (const key of Object.keys(v as Record<string, unknown>)) {
      if (!IDENT.test(key)) {
        out.add(`${prefix}*`);
        continue;
      }
      const p = `${prefix}${key}`;
      out.add(p);
      if (depth < maxDepth) {
        walk((v as Record<string, unknown>)[key], `${p}.`, depth + 1);
      }
    }
  };
  walk(value, "", 1);
  return [...out].sort();
}

/** The key paths a settings probe declares, whatever the declaration. */
function declaredSettingsKeys(spec: ProbeSpec): string[] {
  if (spec.type === "config-key") {
    return [
      ...(spec.keys ?? []),
      ...Object.keys(spec.expect ?? {}),
      ...(spec.absent ?? []),
    ];
  }
  if (spec.type === "hook-registered") return [`hooks.${spec.event}`];
  return [];
}

/** Where a settings probe reads, as the baseline names it. */
function settingsSourceName(spec: ProbeSpec): string | null {
  if (spec.type !== "config-key" && spec.type !== "hook-registered") {
    return null;
  }
  if (spec.scope === "effective") return "effective";
  return spec.file ?? null;
}

/**
 * Keep top-level names, plus everything under the parent of each declared
 * key. A key renamed beside the one you declared — `voice.enable` next to
 * `voice.enabled` — is the movement worth seeing; a key in a part of the
 * settings the manifest never mentions is somebody else's business, and in a
 * user's own settings it is not the project's to commit.
 */
function scopeToDeclared(paths: string[], declared: string[]): string[] {
  const roots = new Set(
    declared
      .map((k) => k.split(".").slice(0, -1).join("."))
      .filter((r) => r.length > 0),
  );
  return paths.filter(
    (p) =>
      !p.includes(".") ||
      [...roots].some((r) => p === r || p.startsWith(`${r}.`)),
  );
}

const SETTINGS_DEPTH = 6;
const TRANSCRIPT_DEPTH = 3;
const TRANSCRIPT_SAMPLE = 200;

/** Observe the surface a manifest points at. Reads the same places the probes
 * read, through the same helpers, so the ledger and the verdict can never
 * disagree about where they looked. */
export function observeSurface(
  manifest: Manifest,
  ctx: ProbeContext & { harnessVersion: string },
  profile: HarnessProfile,
): Surface {
  const settings: Record<string, string[]> = {};
  const declaredBySource: Record<string, string[]> = {};
  const transcripts: Record<string, string[]> = {};

  for (const spec of manifest.probes) {
    const source = settingsSourceName(spec);
    if (source) {
      (declaredBySource[source] ??= []).push(...declaredSettingsKeys(spec));
      if (!(source in settings)) {
        const read = readSettings(
          spec as { scope?: "file" | "effective"; file?: string },
          ctx,
          profile,
        );
        // An unreadable source is already a finding on its probe; recording
        // an empty list here would make its recovery look like movement.
        if (read.ok) settings[source] = keyPaths(read.data, SETTINGS_DEPTH);
      }
    }
    if (spec.type === "transcript-field" && !(spec.glob in transcripts)) {
      const match = newestMatch(ctx.configDir, spec.glob);
      if (match) {
        const fields = new Set<string>();
        const lines = fs
          .readFileSync(match.file, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .slice(0, TRANSCRIPT_SAMPLE);
        for (const line of lines) {
          try {
            for (const f of keyPaths(JSON.parse(line), TRANSCRIPT_DEPTH)) {
              fields.add(f);
            }
          } catch {
            // a partial line at the end of a file being written — not schema
          }
        }
        transcripts[spec.glob] = [...fields].sort();
      }
    }
  }
  for (const [source, paths] of Object.entries(settings)) {
    settings[source] = scopeToDeclared(paths, declaredBySource[source] ?? []);
  }

  const help = [...helpTokens(ctx.harness, profile.helpArgs)]
    .filter((t) => /^--?[A-Za-z][A-Za-z0-9-]*$/.test(t))
    .sort();

  return {
    harnessVersion: ctx.harnessVersion,
    help,
    settings,
    transcripts,
  };
}

/** Serialise a baseline with sorted, one-per-line lists, so a committed file
 * changes by exactly the lines that moved. */
export function formatBaseline(b: Baseline): string {
  return `${JSON.stringify(b, null, 2)}\n`;
}

export function makeBaseline(
  surface: Surface,
  meta: { recorded: string; checker: string; harness: string },
): Baseline {
  return { kind: KIND, format: FORMAT, ...meta, ...surface };
}

export type BaselineRead =
  | { ok: true; baseline: Baseline }
  | { ok: false; reason: string };

/** Read a baseline file. Anything that is not a baseline this build can read
 * is refused with the reason — a misread ledger would report movement that
 * never happened. */
export function readBaseline(file: string): BaselineRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, reason: `unreadable baseline ${file}: ${String(e)}` };
  }
  const b = parsed as Partial<Baseline> | null;
  if (!b || b.kind !== KIND) {
    return { ok: false, reason: `${file} is not a peirad baseline` };
  }
  if (b.format !== FORMAT) {
    return {
      ok: false,
      reason: `${file} is baseline format ${String(b.format)}; this peirad reads format ${FORMAT} — record it again`,
    };
  }
  if (
    typeof b.harnessVersion !== "string" ||
    !Array.isArray(b.help) ||
    !b.settings ||
    typeof b.settings !== "object" ||
    !b.transcripts ||
    typeof b.transcripts !== "object"
  ) {
    return { ok: false, reason: `${file} is missing recorded surface fields` };
  }
  return { ok: true, baseline: b as Baseline };
}

/** Names the manifest declares on each surface. Those are the probes' job;
 * the ledger reports only what nobody declared. */
function declaredNames(manifest: Manifest): {
  help: Set<string>;
  settings: Set<string>;
  transcript: Set<string>;
} {
  const help = new Set<string>();
  const settings = new Set<string>();
  const transcript = new Set<string>();
  for (const spec of manifest.probes) {
    if (spec.type === "flag-accepted") spec.flags.forEach((f) => help.add(f));
    declaredSettingsKeys(spec).forEach((k) => settings.add(k));
    if (spec.type === "transcript-field") {
      spec.fields.forEach((f) => transcript.add(f));
    }
  }
  return { help, settings, transcript };
}

function diff(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

/** What moved between a recorded surface and the current one that no probe
 * declares. Only sources present in both are compared: a source the manifest
 * stopped reading is a manifest change, not movement in the harness. */
export function compareSurface(
  baseline: Baseline,
  current: Surface,
  manifest: Manifest,
  file: string,
): BaselineReport {
  const declared = declaredNames(manifest);
  const moved: Moved[] = [];

  if (baseline.harnessVersion !== current.harnessVersion) {
    moved.push({
      surface: "version",
      change: "changed",
      name: current.harnessVersion,
      from: baseline.harnessVersion,
    });
  }

  const push = (
    surface: Moved["surface"],
    where: string | undefined,
    before: readonly string[],
    after: readonly string[],
    skip: Set<string>,
  ): void => {
    const { added, removed } = diff(before, after);
    for (const name of added) {
      if (!skip.has(name))
        moved.push({ surface, where, change: "added", name });
    }
    for (const name of removed) {
      if (!skip.has(name)) {
        moved.push({ surface, where, change: "removed", name });
      }
    }
  };

  push("help", undefined, baseline.help, current.help, declared.help);

  const untracked: string[] = [];
  for (const [source, paths] of Object.entries(current.settings)) {
    const before = baseline.settings[source];
    if (!before) {
      untracked.push(`settings(${source})`);
      continue;
    }
    push("settings", source, before, paths, declared.settings);
  }
  for (const [glob, fields] of Object.entries(current.transcripts)) {
    const before = baseline.transcripts[glob];
    if (!before) {
      untracked.push(`transcript(${glob})`);
      continue;
    }
    push("transcript", glob, before, fields, declared.transcript);
  }

  return { file, recorded: baseline.recorded, moved, untracked };
}
