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
import fs from "node:fs";
import path from "node:path";
import type { ProbeSpec } from "./manifest.js";

export type ProbeStatus = "pass" | "degraded" | "blocked";

export interface ProbeResult {
  probe: string;
  status: ProbeStatus;
  detail: string;
}

export interface ProbeContext {
  harness: string;
  /** Base dir that a probe's relative `file`/`glob` resolves against. */
  configDir: string;
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

function commandExists(harness: string): boolean {
  const r = spawnSync("command", ["-v", harness], {
    shell: true,
    encoding: "utf8",
  });
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}

// Minimal glob: supports "dir/**/*.ext" and "dir/*.ext"; returns the first match.
function firstMatch(base: string, pattern: string): string | null {
  const recursive = pattern.includes("**");
  const ext = path.extname(pattern);
  const root = path.join(base, pattern.split("*")[0]!.replace(/\/$/, ""));
  const walk = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isFile() && (!ext || e.name.endsWith(ext))) return full;
    }
    if (recursive || depth === 0) {
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory()) {
          const found = walk(path.join(dir, e.name), depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return walk(root, 0);
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

export function runProbe(
  spec: ProbeSpec,
  ctx: ProbeContext,
  versionArgs: string[],
): ProbeResult {
  switch (spec.type) {
    case "command-exists": {
      const ok = commandExists(ctx.harness);
      return {
        probe: `command-exists(${ctx.harness})`,
        status: ok ? "pass" : fail(spec),
        detail: ok
          ? `${ctx.harness} is on PATH`
          : `${ctx.harness} not found on PATH`,
      };
    }
    case "version": {
      const v = harnessVersion(ctx.harness, versionArgs);
      return { probe: "version", status: "pass", detail: v };
    }
    case "flag-accepted": {
      const { out } = runHarness(ctx.harness, ["--help"]);
      const missing = spec.flags.filter((f) => !out.includes(f));
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
      const file = firstMatch(ctx.configDir, spec.glob);
      if (!file) {
        return {
          probe: `transcript-field(${spec.glob})`,
          status: fail(spec),
          detail: `no file matched ${spec.glob}`,
        };
      }
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
            detail: `fields present (${spec.fields.join(", ")}) on a record within the first ${lines.length}`,
          };
        }
      }
      return {
        probe: `transcript-field(${spec.glob})`,
        status: fail(spec),
        detail:
          scanned === 0
            ? `no JSON records in the first ${lines.length} lines`
            : `schema drift — no record in the first ${scanned} has all of: ${spec.fields.join(", ")}`,
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
  }
}
