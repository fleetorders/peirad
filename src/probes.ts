/**
 * Probe implementations — each exercises one integration point against the LIVE
 * installed harness and returns a verdict. The point is to catch drift the day it
 * lands: a flag that stopped being accepted, a config key the build no longer
 * reads, a hook that fell out of the settings, a transcript whose schema changed.
 *
 * Two failure registers (degrade loudly, never fail silently): a non-critical
 * probe that drifts reports "degraded"; a probe marked `critical` (a security or
 * correctness dependency) reports "blocked". Neither throws — the runner collects
 * every result so one drift never hides the next.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  unknownProbeFields,
  type ProbeSpec,
  type SettingsScope,
} from "./manifest.js";
import {
  resolveProfile,
  type ArrayMerge,
  type HarnessProfile,
  type SettingsLayer,
} from "./harness-profiles.js";
import { deepEqual, fold, getDotted, show } from "./values.js";
import {
  describeEntry,
  describeMiss,
  evaluateFind,
  readReport,
  type HarnessReport,
} from "./reports.js";
import { envNames, evaluateEnv, type EnvSource } from "./environment.js";
import { listMatches } from "./glob.js";
import {
  describeLayers,
  effectiveSettings,
  layerVars,
  loadLayers,
  provenance,
  type LoadedLayer,
} from "./settings.js";

/** This engine's own version, read from package.json at run time — resolves
 * from both src/ (tests) and dist/ (the built CLI) without bundling it in.
 * Exported because a verdict names the checker that produced it, not just the
 * harness it checked: a line that changed someone's mind has to be traceable
 * to a build. */
export const ENGINE_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export { fold };

export type ProbeStatus = "pass" | "degraded" | "blocked" | "n/a";

export interface ProbeResult {
  probe: string;
  status: ProbeStatus;
  detail: string;
}

export interface ProbeContext {
  harness: string;
  /** Base dir that a probe's relative `file`/`glob` resolves against. */
  configDir: string;
  /** Resolved profile name; inferred from the harness when absent. */
  profileName?: string;
  /** Resolved binary path (`command -v`), taken once by the runner; the
   * command-exists probe re-resolves when a direct caller omits it. */
  harnessPath?: string | null;
  /** Version string the runner already read, so the `version` probe reports it
   * without spawning the harness a second time. */
  harnessVersion?: string;
  /** The settings stack a `scope: "effective"` probe merges. The runner puts
   * the resolved stack here — the profile's, or the manifest's override of it
   * — because a probe resolves its profile by name and would otherwise never
   * see what the manifest asked for. */
  settingsLayers?: SettingsLayer[];
  /** How that stack combines list values; see `ProbeContext.settingsLayers`. */
  settingsArrays?: ArrayMerge;
  /** The reports a `harness-reports` probe may name — the profile's, with the
   * manifest's own declarations folded in by the runner. */
  reports?: Record<string, HarnessReport>;
  /** Dotted path to the settings' environment block; see `HarnessProfile`. */
  settingsEnv?: string;
  /** The environment an `env` probe checks; `process.env` when absent. */
  env?: EnvSource;
}

const fail = (spec: { critical?: boolean }): ProbeStatus =>
  spec.critical ? "blocked" : "degraded";

function runHarness(
  harness: string,
  args: string[],
): { ok: boolean; out: string } {
  const r = spawnSync(harness, args, { encoding: "utf8", timeout: 20_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0 && !r.error, out };
}

/** `<harness> --version` (or manifest override) — records the version string. */
export function harnessVersion(harness: string, versionArgs: string[]): string {
  const { ok, out } = runHarness(harness, versionArgs);
  if (!ok) return "unknown";
  return out.trim().split("\n")[0]?.trim() ?? "unknown";
}

/** The whole tokens of a harness's help output. The text is split on
 * whitespace and on the punctuation that glues a flag to its placeholder, so a
 * lookup for "--allowed" cannot succeed against "--allowedTools", nor "-p"
 * against "--print". Shared by the flag probe and the baseline ledger, so the
 * two can never disagree about what the help carries. */
export function helpTokens(harness: string, helpArgs: string[]): Set<string> {
  const { out } = runHarness(harness, helpArgs);
  return new Set(out.split(/[\s,=\[\]<>|()]+/).filter((t) => t.length > 0));
}

/** `command -v <harness>`: the resolved binary path, or null when off PATH. */
export function resolveBinary(harness: string): string | null {
  const r = spawnSync("command", ["-v", harness], {
    shell: true,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const p = (r.stdout ?? "").trim();
  return p.length > 0 ? p : null;
}

/** The match with the newest mtime: the transcript the current build wrote,
 * not whichever file sorts first. Ties keep the first-listed (name order)
 * file, so the pick stays deterministic. */
export function newestMatch(
  base: string,
  pattern: string,
): { file: string; mtime: Date } | null {
  let best: { file: string; mtime: Date } | null = null;
  for (const file of listMatches(base, pattern)) {
    let mtime: Date;
    try {
      mtime = fs.statSync(file).mtime;
    } catch {
      continue; // vanished between listing and stat — not a verdict
    }
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best;
}

/**
 * Where a settings probe reads from: one named file, or the harness's whole
 * stack merged in its own precedence. Either way the caller gets one parsed
 * object plus, under "effective", the layers behind it — so a verdict can say
 * which scope a setting actually came from.
 */
export type SettingsSource =
  | { ok: true; data: unknown; where: string; layers?: LoadedLayer[] }
  | { ok: false; status: ProbeStatus; detail: string };

export function readSettings(
  spec: { scope?: SettingsScope; file?: string; critical?: boolean },
  ctx: ProbeContext,
  profile: HarnessProfile,
): SettingsSource {
  if (spec.scope === "effective") {
    const declared = profile.settingsLayers;
    if (declared.length === 0) {
      return {
        ok: false,
        status: "n/a",
        detail: `harness profile "${profile.name}" declares no settings stack — name a file instead of scope "effective"`,
      };
    }
    const layers = loadLayers(declared, layerVars(ctx.configDir));
    const broken = layers.filter((l) => l.state === "unreadable");
    if (broken.length > 0) {
      // The effective settings are unknowable while a layer will not parse,
      // and the harness reading the same stack is in no better position.
      return {
        ok: false,
        status: fail(spec),
        detail: `settings layer "${broken[0]!.name}" will not parse (${broken[0]!.path}): ${broken[0]!.reason}`,
      };
    }
    return {
      ok: true,
      data: effectiveSettings(layers, profile.settingsArrays),
      where: describeLayers(layers),
      layers,
    };
  }
  if (!spec.file) {
    return {
      ok: false,
      status: "n/a",
      detail: `no "file" declared — name one, or set scope "effective" to read the harness's own stack`,
    };
  }
  const file = path.resolve(ctx.configDir, spec.file);
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      status: fail(spec),
      detail: `file not found: ${spec.file}`,
    };
  }
  try {
    return {
      ok: true,
      data: JSON.parse(fs.readFileSync(file, "utf8")),
      where: spec.file,
    };
  } catch (e) {
    return {
      ok: false,
      status: fail(spec),
      detail: `unparseable JSON: ${String(e)}`,
    };
  }
}

/** " ← project (shadows user)" for an effective read; nothing for a single
 * file, where there is only one place the value could have come from. */
function attribution(
  source: SettingsSource & { ok: true },
  key: string,
  arrays: HarnessProfile["settingsArrays"],
): string {
  if (!source.layers) return "";
  const p = provenance(source.layers, key, arrays, getDotted);
  if (p.from.length === 0) return "";
  const shadow =
    p.shadowed.length > 0 ? ` (shadows ${p.shadowed.join(", ")})` : "";
  return ` ← ${p.from.join("+")}${shadow}`;
}

/** The label a probe reports itself under, mirroring the per-case labels. */
function probeLabel(spec: ProbeSpec, harness: string): string {
  switch (spec.type) {
    case "command-exists":
      return `command-exists(${spec.command ?? harness})`;
    case "version":
      return "version";
    case "flag-accepted":
      return `flag-accepted(${spec.flags.join(",")})`;
    case "config-key":
      return `config-key(${spec.scope === "effective" ? "effective" : (spec.file ?? "?")})`;
    case "transcript-field":
      return `transcript-field(${spec.glob})`;
    case "hook-registered":
      return `hook-registered(${spec.event}~${spec.match})`;
    case "script":
      return `script(${[spec.script, ...(spec.args ?? [])].join(" ")})`;
    case "harness-reports":
      return `harness-reports(${spec.report})`;
    case "env": {
      const names = envNames(spec);
      return `env(${names.slice(0, 4).join(",")}${names.length > 4 ? ",…" : ""})`;
    }
    default:
      return (spec as { type: string }).type;
  }
}

/**
 * Check one transcript file: pass when any record in its sample carries every
 * declared field. Shared by the probe, which samples the newest matching file,
 * and the live run, which reads the exact file its own turn wrote.
 */
export function checkTranscriptFile(
  spec: { glob: string; fields: string[]; critical?: boolean },
  match: { file: string; mtime: Date },
  base: string,
): ProbeResult {
  const { file, mtime } = match;
  // Name the sample — which file was read and how fresh it is — so a
  // verdict can be checked against the transcript it describes.
  const sampled = `${path.relative(base, file)} (mtime ${mtime.toISOString().slice(0, 10)})`;
  // Transcript JSONL mixes record types (summary/meta headers, then user and
  // assistant messages), so the declared fields may legitimately be absent
  // from line 1. Scan a sample and pass if ANY record carries all of them —
  // that proves the schema still exposes the fields. Only "no record in the
  // sample has them" is real drift.
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 200);
  if (lines.length === 0) {
    return {
      probe: `transcript-field(${spec.glob})`,
      status: fail(spec),
      detail: `matched file is empty`,
    };
  }
  let scanned = 0;
  for (const line of lines) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    scanned++;
    if (spec.fields.every((f) => getDotted(rec, f) !== undefined)) {
      return {
        probe: `transcript-field(${spec.glob})`,
        status: "pass",
        detail: `fields present (${spec.fields.join(", ")}) on a record within the first ${lines.length} — sampled ${sampled}`,
      };
    }
  }
  return {
    probe: `transcript-field(${spec.glob})`,
    status: fail(spec),
    detail:
      scanned === 0
        ? `no JSON records in the first ${lines.length} lines`
        : `schema drift — no record in the first ${scanned} has all of: ${spec.fields.join(", ")} — sampled ${sampled}`,
  };
}

/**
 * Run one probe and report what its declared assertions did — including the
 * ones this build could not make.
 *
 * A manifest may carry a field an older engine has never heard of. Skipping it
 * silently would hand back a `pass` for an assertion nobody checked, which is
 * the exact failure this tool exists to catch, so a probe that passed while
 * skipping a declared field reports `degraded` and names the field. It is
 * never `blocked`, however critical the probe: an out-of-date checker is not
 * drift in the harness, and the fix is an upgrade rather than an investigation
 * (D-014). An unknown probe TYPE is a different case, already answered by
 * D-008: nothing about it is understood, so it renders `n/a`.
 */
export function runProbe(
  spec: ProbeSpec,
  ctx: ProbeContext,
  versionArgs: string[],
): ProbeResult {
  const result = runKnownProbe(spec, ctx, versionArgs);
  const unknown = unknownProbeFields(spec);
  if (unknown.length === 0) return result;
  const count = `${unknown.length} declared ${unknown.length === 1 ? "assertion" : "assertions"}`;
  return {
    ...result,
    status: result.status === "pass" ? "degraded" : result.status,
    detail:
      `${result.detail} — ${count} skipped: peirad ${ENGINE_VERSION} does not understand ` +
      `${unknown.join(", ")} on a ${spec.type} probe; upgrade peirad`,
  };
}

function runKnownProbe(
  spec: ProbeSpec,
  ctx: ProbeContext,
  versionArgs: string[],
): ProbeResult {
  const named = resolveProfile(ctx.harness, ctx.profileName);
  const profile: HarnessProfile = {
    ...named,
    settingsLayers: ctx.settingsLayers ?? named.settingsLayers,
    settingsArrays: ctx.settingsArrays ?? named.settingsArrays,
    reports: ctx.reports ?? named.reports,
    settingsEnv: ctx.settingsEnv ?? named.settingsEnv,
  };
  // A probe the harness family cannot express is declared, never passed.
  if (profile.inapplicableProbes.includes(spec.type)) {
    return {
      probe: probeLabel(spec, ctx.harness),
      status: "n/a",
      detail: `no counterpart for harness profile "${profile.name}"`,
    };
  }
  switch (spec.type) {
    case "command-exists": {
      // `command` names a helper program the integration shells out to; absent
      // it, the probe checks the harness itself (its original meaning).
      const target = spec.command ?? ctx.harness;
      const isHarness = target === ctx.harness;
      const resolved =
        isHarness && ctx.harnessPath !== undefined
          ? ctx.harnessPath
          : resolveBinary(target);
      return {
        probe: `command-exists(${target})`,
        status: resolved ? "pass" : fail(spec),
        detail: resolved
          ? `${target} is on PATH (${resolved})`
          : `${target} not found on PATH${isHarness ? "" : " — declared as a helper program"}`,
      };
    }
    case "version": {
      const v = ctx.harnessVersion ?? harnessVersion(ctx.harness, versionArgs);
      return { probe: "version", status: "pass", detail: v };
    }
    case "flag-accepted": {
      // Flags for a subcommand-shaped CLI live in that subcommand's help;
      // the profile says which help to read.
      const tokens = helpTokens(ctx.harness, profile.helpArgs);
      const missing = spec.flags.filter((f) => !tokens.has(f));
      return {
        probe: `flag-accepted(${spec.flags.join(",")})`,
        status: missing.length === 0 ? "pass" : fail(spec),
        detail:
          missing.length === 0
            ? "all flags present in --help"
            : `not in --help: ${missing.join(", ")}`,
      };
    }
    case "config-key": {
      const label = probeLabel(spec, ctx.harness);
      const source = readSettings(spec, ctx, profile);
      if (!source.ok) {
        return { probe: label, status: source.status, detail: source.detail };
      }
      const parsed = source.data;
      const where = source.layers ? ` [${source.where}]` : "";
      const at = (key: string): string =>
        attribution(source, key, profile.settingsArrays);
      // Three assertions over one file, reported together: the keys that must
      // exist, the values they must hold, and the names that must NOT exist.
      // Every failing one is named — a wrong value never hides a leftover key.
      const held: string[] = [];
      const problems: string[] = [];

      const keys = spec.keys ?? [];
      if (keys.length > 0) {
        const missing = keys.filter((k) => getDotted(parsed, k) === undefined);
        if (missing.length === 0) {
          held.push(
            `keys present: ${keys.map((k) => `${k}${at(k)}`).join(", ")}`,
          );
        } else {
          problems.push(`missing keys: ${missing.join(", ")}`);
        }
      }

      const expected = Object.entries(spec.expect ?? {});
      if (expected.length > 0) {
        const wrong: string[] = [];
        for (const [key, want] of expected) {
          const got = getDotted(parsed, key);
          if (got === undefined) {
            wrong.push(`${key} is absent (expected ${show(want)})`);
          } else if (!deepEqual(got, want)) {
            wrong.push(`${key} is ${show(got)} (expected ${show(want)})`);
          }
        }
        if (wrong.length === 0) {
          held.push(
            `values match: ${expected.map(([k]) => `${k}${at(k)}`).join(", ")}`,
          );
        } else {
          problems.push(wrong.join("; "));
        }
      }

      const absent = spec.absent ?? [];
      if (absent.length > 0) {
        const leftover = absent.filter(
          (k) => getDotted(parsed, k) !== undefined,
        );
        if (leftover.length === 0) {
          held.push(`absent as declared: ${absent.join(", ")}`);
        } else {
          // The key the harness no longer reads is still in the file, so the
          // setting looks configured while the feature runs at its default.
          problems.push(
            `declared absent but present: ${leftover
              .map((k) => `${k}${at(k)} = ${show(getDotted(parsed, k))}`)
              .join(", ")}`,
          );
        }
      }

      if (held.length === 0 && problems.length === 0) {
        return {
          probe: label,
          status: "n/a",
          detail: `nothing declared — the probe needs "keys", "expect" or "absent"`,
        };
      }
      return {
        probe: label,
        status: problems.length === 0 ? "pass" : fail(spec),
        detail: `${(problems.length === 0 ? held : problems).join(" · ")}${where}`,
      };
    }
    case "transcript-field": {
      const match = newestMatch(ctx.configDir, spec.glob);
      if (!match) {
        return {
          probe: `transcript-field(${spec.glob})`,
          status: fail(spec),
          detail: `no file matched ${spec.glob}`,
        };
      }
      return checkTranscriptFile(spec, match, ctx.configDir);
    }
    case "hook-registered": {
      const label = `hook-registered(${spec.event}~${spec.match})`;
      const source = readSettings(spec, ctx, profile);
      if (!source.ok) {
        return { probe: label, status: source.status, detail: source.detail };
      }
      const key = `hooks.${spec.event}`;
      const carries = (data: unknown): boolean =>
        JSON.stringify(getDotted(data, key) ?? "").includes(spec.match);
      const where = source.layers ? ` [${source.where}]` : "";
      if (carries(source.data)) {
        // Under an effective read, name the scope the hook lives in: a hook
        // that moved between scopes is registered, not drifted, and the line
        // should say so rather than leave the reader to guess.
        const scopes = source.layers
          ? source.layers
              .filter((l) => l.state === "read" && carries(l.data))
              .map((l) => l.name)
          : [];
        const from = scopes.length > 0 ? ` in ${scopes.join(", ")} scope` : "";
        return {
          probe: label,
          status: "pass",
          detail: `hook "${spec.match}" registered on ${spec.event}${from}${where}`,
        };
      }
      // Declared, present in a file, and still never run: a higher layer
      // replaced the list it was in. The old single-file read called this a
      // pass, which is the silent failure this tool exists to catch.
      const shadowed = (source.layers ?? []).filter(
        (l) => l.state === "read" && carries(l.data),
      );
      if (shadowed.length > 0) {
        return {
          probe: label,
          status: fail(spec),
          detail: `hook "${spec.match}" is in ${shadowed.map((l) => l.name).join(", ")} scope but not in the effective settings — a higher layer overrides ${key}${where}`,
        };
      }
      return {
        probe: label,
        status: fail(spec),
        detail: `no ${spec.event} hook matching "${spec.match}"${where}`,
      };
    }
    case "script": {
      const label = `script(${[spec.script, ...(spec.args ?? [])].join(" ")})`;
      const base = path.resolve(ctx.configDir);
      const file = path.resolve(base, spec.script);
      // A verdict the script never delivered is n/a, never a fail: the probe
      // fails open, so a missing/unrunnable/overshooting script can only
      // report "no verdict", never block — even when marked critical.
      const na = (detail: string): ProbeResult => ({
        probe: label,
        status: "n/a",
        detail,
      });
      if (!fs.existsSync(file)) {
        return na(`script not found: ${spec.script}`);
      }
      const r = spawnSync(file, spec.args ?? [], {
        encoding: "utf8",
        cwd: base,
        timeout: spec.timeoutMs ?? 30_000,
      });
      const out = `${r.stdout ?? ""}`;
      if (r.error) {
        // A timeout lands here as ETIMEDOUT, with or without a signal.
        const code = (r.error as NodeJS.ErrnoException).code;
        if (code === "ETIMEDOUT" || r.signal) {
          return na(
            `killed by ${r.signal ?? "timeout"} after ${spec.timeoutMs ?? 30_000}ms — no verdict`,
          );
        }
        return na(
          `could not run ${spec.script}: ${r.error.message} (must be executable)`,
        );
      }
      if (r.signal) {
        return na(`killed by ${r.signal} — no verdict`);
      }
      if (r.status === 0) {
        return {
          probe: label,
          status: "pass",
          detail: fold(out) || "exit 0",
        };
      }
      if (r.status === 1) {
        return {
          probe: label,
          status: fail(spec),
          detail: fold(out) || "exit 1 (no output)",
        };
      }
      // Exit 2 is the script's own "no verdict" channel; any other exit code
      // is read the same way — fail-open, never a fail verdict.
      return na(
        `exit ${r.status}${out.trim() ? `: ${fold(out, 1)}` : " — no verdict"}`,
      );
    }
    case "harness-reports": {
      const label = `harness-reports(${spec.report})`;
      const report = profile.reports[spec.report];
      if (!report) {
        const known = Object.keys(profile.reports);
        return {
          probe: label,
          status: "n/a",
          detail: `harness profile "${profile.name}" declares no "${spec.report}" report${known.length > 0 ? ` (it declares: ${known.join(", ")})` : ""} — declare one under "reports" in the manifest`,
        };
      }
      const read = readReport(ctx.harness, report, path.resolve(ctx.configDir));
      if (!read.ok) {
        // The report changed shape, or never ran: nothing it says can be
        // trusted either way, so no verdict — named, never a pass.
        return {
          probe: label,
          status: "n/a",
          detail: `could not read the "${spec.report}" report (${read.command}): ${read.reason}`,
        };
      }
      const find = spec.find ?? [];
      const count = `${read.records.length} ${read.records.length === 1 ? "record" : "records"}`;
      if (find.length === 0) {
        return {
          probe: label,
          status: "pass",
          detail: `${read.command} read: ${count}`,
        };
      }
      const misses = evaluateFind(read.records, find).filter((r) => !r.matched);
      return misses.length === 0
        ? {
            probe: label,
            status: "pass",
            detail: `${read.command} reports ${find.map(describeEntry).join("; ")}`,
          }
        : {
            probe: label,
            status: fail(spec),
            detail: `${read.command}: ${misses.map((m) => describeMiss(m, read.records)).join("; ")}`,
          };
    }
    case "env": {
      const label = probeLabel(spec, ctx.harness);
      if (envNames(spec).length === 0) {
        return {
          probe: label,
          status: "n/a",
          detail: `nothing declared — the probe needs "set", "unset", "equals", "matches" or "pointsAt"`,
        };
      }
      const processEnv: EnvSource = ctx.env ?? process.env;
      let env = processEnv;
      let origin: ((name: string) => string | undefined) | undefined;
      let where = "";
      if (spec.scope === "effective") {
        const envKey = profile.settingsEnv;
        if (!envKey) {
          return {
            probe: label,
            status: "n/a",
            detail: `harness profile "${profile.name}" declares no environment block in its settings — use scope "process"`,
          };
        }
        const source = readSettings(
          { scope: "effective", critical: spec.critical },
          ctx,
          profile,
        );
        if (!source.ok) {
          return { probe: label, status: source.status, detail: source.detail };
        }
        // The settings' variables are laid over the process environment, as
        // the harness applies them to its session.
        const block = getDotted(source.data, envKey);
        const declared: Record<string, string> = {};
        if (block && typeof block === "object" && !Array.isArray(block)) {
          for (const [k, v] of Object.entries(block)) {
            if (v !== undefined && v !== null) declared[k] = String(v);
          }
        }
        env = { ...processEnv, ...declared };
        const layers = source.layers ?? [];
        origin = (name) => {
          if (name in declared) {
            const p = provenance(
              layers,
              `${envKey}.${name}`,
              profile.settingsArrays,
              getDotted,
            );
            return `settings: ${p.from.join("+")}`;
          }
          return processEnv[name] ? "process" : undefined;
        };
        where = ` [${source.where}]`;
      }
      const { held, problems } = evaluateEnv(spec, env, {
        baseDir: path.resolve(ctx.configDir),
        origin,
      });
      return {
        probe: label,
        status: problems.length === 0 ? "pass" : fail(spec),
        detail: `${(problems.length === 0 ? held : problems).join(" · ")}${where}`,
      };
    }
    default: {
      // An unknown type name means a newer manifest met an older engine:
      // declared n/a, never a crash — the run still delivers a verdict that
      // names what it did not understand (mirrors the script probe's fail-open).
      const type = (spec as { type: string }).type;
      return {
        probe: type,
        status: "n/a",
        detail: `unknown probe type "${type}" — not understood by peirad ${ENGINE_VERSION}; upgrade peirad or remove the probe`,
      };
    }
  }
}
