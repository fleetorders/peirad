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
import type { ProbeSpec } from "./manifest.js";
import { resolveProfile } from "./harness-profiles.js";

/** This engine's own version, read from package.json at run time — resolves
 * from both src/ (tests) and dist/ (the built CLI) without bundling it in. */
const ENGINE_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

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

// Minimal glob: supports "dir/**/*.ext" (recursive) and "dir/*.ext" (one
// level); returns EVERY match so the caller samples by recency, not by the
// order a directory listing happened to surface.
function allMatches(base: string, pattern: string): string[] {
  const recursive = pattern.includes("**");
  const ext = path.extname(pattern);
  const root = path.join(base, pattern.split("*")[0]!.replace(/\/$/, ""));
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && (!ext || e.name.endsWith(ext))) {
        found.push(path.join(dir, e.name));
      }
    }
    if (recursive) {
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return found;
}

/** The match with the newest mtime: the transcript the current build wrote,
 * not whichever file sorts first. Ties keep the first-listed (name order)
 * file, so the pick stays deterministic. */
function newestMatch(
  base: string,
  pattern: string,
): { file: string; mtime: Date } | null {
  let best: { file: string; mtime: Date } | null = null;
  for (const file of allMatches(base, pattern)) {
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

function getDotted(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (
      cur &&
      typeof cur === "object" &&
      part in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** The label a probe reports itself under, mirroring the per-case labels. */
function probeLabel(spec: ProbeSpec, harness: string): string {
  switch (spec.type) {
    case "command-exists":
      return `command-exists(${harness})`;
    case "version":
      return "version";
    case "flag-accepted":
      return `flag-accepted(${spec.flags.join(",")})`;
    case "config-key":
      return `config-key(${spec.file})`;
    case "transcript-field":
      return `transcript-field(${spec.glob})`;
    case "hook-registered":
      return `hook-registered(${spec.event}~${spec.match})`;
    case "script":
      return `script(${[spec.script, ...(spec.args ?? [])].join(" ")})`;
    default:
      return (spec as { type: string }).type;
  }
}

/** Fold raw process output into one reportable line: leading non-empty lines,
 * joined with " · ", capped so a chatty finding can't wreck the render. */
export function fold(out: string, maxLines = 3, maxChars = 300): string {
  const joined = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(" · ");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

export function runProbe(
  spec: ProbeSpec,
  ctx: ProbeContext,
  versionArgs: string[],
): ProbeResult {
  const profile = resolveProfile(ctx.harness, ctx.profileName);
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
      const resolved =
        ctx.harnessPath !== undefined
          ? ctx.harnessPath
          : resolveBinary(ctx.harness);
      return {
        probe: `command-exists(${ctx.harness})`,
        status: resolved ? "pass" : fail(spec),
        detail: resolved
          ? `${ctx.harness} is on PATH (${resolved})`
          : `${ctx.harness} not found on PATH`,
      };
    }
    case "version": {
      const v = harnessVersion(ctx.harness, versionArgs);
      return { probe: "version", status: "pass", detail: v };
    }
    case "flag-accepted": {
      // Flags for a subcommand-shaped CLI live in that subcommand's help;
      // the profile says which help to read.
      const { out } = runHarness(ctx.harness, profile.helpArgs);
      // Whole-token match only: the help text is split on whitespace and the
      // punctuation that glues flags to placeholders, so "--allowed" cannot
      // pass against "--allowedTools" nor "-p" against "--print".
      const tokens = new Set(
        out.split(/[\s,=\[\]<>|()]+/).filter((t) => t.length > 0),
      );
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
      const file = path.resolve(ctx.configDir, spec.file);
      if (!fs.existsSync(file)) {
        return {
          probe: `config-key(${spec.file})`,
          status: fail(spec),
          detail: `file not found: ${spec.file}`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        return {
          probe: `config-key(${spec.file})`,
          status: fail(spec),
          detail: `unparseable JSON: ${String(e)}`,
        };
      }
      const missing = spec.keys.filter(
        (k) => getDotted(parsed, k) === undefined,
      );
      return {
        probe: `config-key(${spec.file})`,
        status: missing.length === 0 ? "pass" : fail(spec),
        detail:
          missing.length === 0
            ? `keys present: ${spec.keys.join(", ")}`
            : `missing keys: ${missing.join(", ")}`,
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
      const { file, mtime } = match;
      // Name the sample — which file was read and how fresh it is — so a
      // verdict can be checked against the transcript it describes.
      const sampled = `${path.relative(ctx.configDir, file)} (mtime ${mtime.toISOString().slice(0, 10)})`;
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
    case "hook-registered": {
      const file = path.resolve(ctx.configDir, spec.file);
      if (!fs.existsSync(file)) {
        return {
          probe: `hook-registered(${spec.event})`,
          status: fail(spec),
          detail: `settings not found: ${spec.file}`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return {
          probe: `hook-registered(${spec.event})`,
          status: fail(spec),
          detail: `unparseable settings JSON`,
        };
      }
      const events = getDotted(parsed, `hooks.${spec.event}`);
      const found = JSON.stringify(events ?? "").includes(spec.match);
      return {
        probe: `hook-registered(${spec.event}~${spec.match})`,
        status: found ? "pass" : fail(spec),
        detail: found
          ? `hook "${spec.match}" registered on ${spec.event}`
          : `no ${spec.event} hook matching "${spec.match}"`,
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
