/**
 * Derive a manifest from the project's own source.
 *
 * Nobody lists what they depend on before they have to. But the project
 * already says it: its scripts pass flags to the harness, its settings files
 * register hooks, its hook commands call helper programs, its transcript
 * readers pull fields out of JSON lines. A deterministic scan of those files
 * drafts the manifest they imply, with the file and line behind every entry,
 * and — against a manifest that already exists — names what the code uses that
 * nobody declared, and what is declared that the code never mentions.
 *
 * No model reads the code. Every entry comes from a pattern that can be read
 * in this file, so a surprising entry can be traced to the line that produced
 * it and the rule that matched. It is a draft: it proposes, and the maintainer
 * decides.
 */
import fs from "node:fs";
import path from "node:path";
import type { Manifest, ProbeSpec } from "./manifest.js";

/** Harness names the scan recognises in an invocation. */
const HARNESSES = ["claude", "codex"] as const;
type Harness = (typeof HARNESSES)[number];

/** Where each harness's transcripts live. The glob points into the harness's
 * own configuration directory with a `{home}` template, so a drafted
 * manifest works from the project directory its hooks live in — a relative
 * glob would need a base dir that finds either the hooks or the transcripts,
 * never both. */
const TRANSCRIPT_GLOB: Record<Harness, string> = {
  claude: "{home}/.claude/projects/**/*.jsonl",
  codex: "{home}/.codex/sessions/**/*.jsonl",
};

/** Directories that hold someone else's code or build output. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
]);
/** Dot-directories that DO hold a project's own wiring. */
const KEEP_DOT_DIRS = new Set([
  ".claude",
  ".codex",
  ".github",
  ".githooks",
  ".husky",
]);
const TEXT_EXT = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".py",
  ".rb",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
]);
const TEXT_NAMES = new Set(["Makefile", "makefile", "justfile", "Justfile"]);
const MAX_FILES = 5_000;
const MAX_BYTES = 512 * 1024;

/** Flags that say nothing about an integration's contract. */
const TRIVIAL_FLAGS = new Set(["-h", "--help", "-v", "-V", "--version"]);
/** Programs every hook environment has; declaring them is noise. */
const BASE_PROGRAMS = new Set(["sh", "bash", "zsh", "env", "exec", "command"]);

/** "path:line" — where an entry came from. */
export type Location = string;

export interface Scan {
  /** Files read, after skipping build output, dependencies and binaries. */
  scanned: number;
  /** True when the file cap stopped the walk early. */
  truncated: boolean;
  /** Harness → flag → where it was passed. */
  flags: Record<string, Record<string, Location[]>>;
  /** Hooks registered in settings files found in the project. */
  hooks: {
    harness: Harness;
    file: string;
    event: string;
    match: string;
    command: string;
    at: Location;
  }[];
  /** Helper program → where a hook command calls it. */
  helpers: Record<string, Location[]>;
  /** Field path → where a transcript reader takes it. */
  transcriptFields: Record<string, Location[]>;
}

function add(map: Record<string, Location[]>, key: string, at: Location): void {
  const list = (map[key] ??= []);
  if (!list.includes(at)) list.push(at);
}

/** Walk the project, yielding repo-relative paths of text files worth reading. */
function listFiles(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith(".") && !KEEP_DOT_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        files.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return { files, truncated };
}

function readText(root: string, rel: string): string | null {
  const full = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (stat.size > MAX_BYTES) return null;
  const base = path.basename(rel);
  const ext = path.extname(rel);
  let text: string;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null;
  const known = TEXT_EXT.has(ext) || TEXT_NAMES.has(base);
  return known || (ext === "" && text.startsWith("#!")) ? text : null;
}

// A harness named as a command: at the start of a line or after a quote,
// separator or `=`, followed by whitespace or a closing quote.
const INVOCATION = new RegExp(
  `(?:^|[\\s"'\`;(|&=\\[,])(${HARNESSES.join("|")})(?=["'\`]?\\s*[,\\s])`,
  "g",
);
const FLAG = /(?:^|[\s"'`,[(=])(--?[A-Za-z][A-Za-z0-9-]*)(?=[\s"'`,\])=]|$)/g;

/** Flags passed to a harness on one line: the tokens after its name, up to a
 * shell separator that starts a different command. */
function flagsOnLine(line: string): { harness: Harness; flags: string[] }[] {
  const found: { harness: Harness; flags: string[] }[] = [];
  for (const m of line.matchAll(INVOCATION)) {
    const harness = m[1] as Harness;
    const rest = line.slice((m.index ?? 0) + m[0].length);
    const segment = rest.split(/\s(?:\||&&|\|\||;)\s|`/)[0] ?? rest;
    const flags = [...segment.matchAll(FLAG)]
      .map((f) => f[1]!)
      .filter((f) => !TRIVIAL_FLAGS.has(f));
    if (flags.length > 0) found.push({ harness, flags: [...new Set(flags)] });
  }
  return found;
}

/** The 1-based line on which `needle` first appears in `text`. */
function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split("\n").length;
}

/** A hook command's identifying name: the script it runs, by file name, since
 * the surrounding command is the part other tools rewrite. */
function hookMatch(command: string): string {
  const tokens = command.split(/\s+/).filter(Boolean);
  const script = [...tokens]
    .reverse()
    .find((t) => /[/\\]/.test(t) || /\.(sh|bash|js|mjs|cjs|ts|py|rb)$/.test(t));
  const pick = script ?? tokens[0] ?? command;
  return path.basename(pick.replace(/["']/g, ""));
}

/** The program a hook command runs, when it is one that has to be installed. */
function helperProgram(command: string): string | null {
  const first = command.trim().split(/\s+/)[0]?.replace(/["']/g, "") ?? "";
  if (!first || /[/\\$]/.test(first) || first.includes("=")) return null;
  if (BASE_PROGRAMS.has(first)) return null;
  return /^[A-Za-z][\w.+-]*$/.test(first) ? first : null;
}

/** Hooks in a parsed settings or hooks file, in the `hooks.<Event>[].hooks[]`
 * shape both built-in harness families use. */
function hooksIn(data: unknown): { event: string; command: string }[] {
  const out: { event: string; command: string }[] = [];
  const hooks =
    data && typeof data === "object"
      ? (data as { hooks?: unknown }).hooks
      : undefined;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const inner = (group as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const command = (h as { command?: unknown })?.command;
        if (typeof command === "string" && command.trim()) {
          out.push({ event, command });
        }
      }
    }
  }
  return out;
}

// Field accesses a transcript reader makes, recognised only in a file that
// mentions JSON lines at all: jq paths in a quoted jq program, and string keys
// taken with ["key"] or .get("key"). Bare `.key` in general-purpose code is
// left alone — too common to mean anything.
const JQ_PROGRAM = /\bjq\b[^'"\n]*(['"])(.*?)\1/g;
const JQ_PATH = /(?:^|[^\w\]])\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g;
const STRING_KEY = /(?:\[\s*|\.get\(\s*)(["'])([A-Za-z_]\w*)\1/g;

export function scanProject(root: string): Scan {
  const scan: Scan = {
    scanned: 0,
    truncated: false,
    flags: {},
    hooks: [],
    helpers: {},
    transcriptFields: {},
  };
  const { files, truncated } = listFiles(root);
  scan.truncated = truncated;
  for (const rel of files) {
    const text = readText(root, rel);
    if (text === null) continue;
    scan.scanned++;
    const lines = text.split("\n");

    lines.forEach((line, i) => {
      for (const { harness, flags } of flagsOnLine(line)) {
        const byFlag = (scan.flags[harness] ??= {});
        for (const f of flags) add(byFlag, f, `${rel}:${i + 1}`);
      }
    });

    if (rel.endsWith(".json")) {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      const harness: Harness = rel.split(path.sep).includes(".codex")
        ? "codex"
        : "claude";
      for (const { event, command } of hooksIn(data)) {
        const at = `${rel}:${lineOf(text, JSON.stringify(command).slice(1, -1))}`;
        scan.hooks.push({
          harness,
          file: rel.split(path.sep).join("/"),
          event,
          match: hookMatch(command),
          command,
          at,
        });
        const helper = helperProgram(command);
        if (helper) add(scan.helpers, helper, at);
      }
    }

    if (text.includes(".jsonl")) {
      lines.forEach((line, i) => {
        const at = `${rel}:${i + 1}`;
        for (const program of line.matchAll(JQ_PROGRAM)) {
          for (const p of program[2]!.matchAll(JQ_PATH)) {
            add(scan.transcriptFields, p[1]!, at);
          }
        }
        for (const k of line.matchAll(STRING_KEY)) {
          add(scan.transcriptFields, k[2]!, at);
        }
      });
    }
  }
  return scan;
}

/** The harness the project invokes most, when the caller does not say. */
export function likelyHarness(scan: Scan): Harness | null {
  const weight = (h: Harness): number =>
    Object.keys(scan.flags[h] ?? {}).length +
    scan.hooks.filter((x) => x.harness === h).length;
  const ranked = HARNESSES.map((h) => [h, weight(h)] as const)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

const sortedEntries = (m: Record<string, Location[]>): [string, Location[]][] =>
  Object.entries(m).sort(([a], [b]) => a.localeCompare(b));

/**
 * The draft manifest a scan implies. Every probe carries `_from` — a comment
 * key the engine never reads — naming the file and line behind it.
 */
export function draftManifest(
  scan: Scan,
  harness: string,
  name = "draft",
): Manifest {
  const probes: (ProbeSpec & { _from?: unknown; _note?: string })[] = [
    { type: "command-exists", critical: true },
    { type: "version" },
  ];
  const flags = sortedEntries(scan.flags[harness] ?? {});
  if (flags.length > 0) {
    probes.push({
      type: "flag-accepted",
      flags: flags.map(([f]) => f),
      _from: Object.fromEntries(flags),
    });
  }
  for (const h of scan.hooks.filter((x) => x.harness === harness)) {
    probes.push({
      type: "hook-registered",
      file: h.file,
      event: h.event,
      match: h.match,
      _from: h.at,
    });
  }
  for (const [command, at] of sortedEntries(scan.helpers)) {
    probes.push({ type: "command-exists", command, _from: at });
  }
  const fields = sortedEntries(scan.transcriptFields);
  if (fields.length > 0) {
    probes.push({
      type: "transcript-field",
      glob: TRANSCRIPT_GLOB[harness as Harness] ?? "**/*.jsonl",
      fields: fields.map(([f]) => f),
      _from: Object.fromEntries(fields),
      _note:
        "fields read by code that mentions .jsonl — keep the ones that come from transcripts; the glob points into the harness's configuration directory ({home} expands at run time)",
    });
  }
  return { name: `${name} (draft)`, harness, probes };
}

/** One line of a coverage report. */
export interface CoverageItem {
  kind: "flag" | "hook" | "helper" | "transcript-field";
  name: string;
  /** Where the code uses it; empty for a declared-but-unused item. */
  at: Location[];
}

/** A scan's coverage as it rides on a verdict. */
export interface ScanReport {
  /** The scanned directory as the caller named it. */
  dir: string;
  scanned: number;
  truncated: boolean;
  undeclared: CoverageItem[];
  unused: CoverageItem[];
}

export interface ScanCoverage {
  /** Used by the scanned code, declared by no probe. */
  undeclared: CoverageItem[];
  /** Declared by a probe, not found in the scanned files. */
  unused: CoverageItem[];
}

/**
 * Compare a manifest with what the project's files use. "Unused" means only
 * "not found in these files" — a hook registered in a user's own settings is
 * real and invisible to a scan of the repository, and the report says so.
 */
export function compareWithScan(manifest: Manifest, scan: Scan): ScanCoverage {
  const undeclared: CoverageItem[] = [];
  const unused: CoverageItem[] = [];
  const harness = manifest.harness;

  const declaredFlags = new Set(
    manifest.probes.flatMap((p) => (p.type === "flag-accepted" ? p.flags : [])),
  );
  const usedFlags = scan.flags[harness] ?? {};
  for (const [flag, at] of sortedEntries(usedFlags)) {
    if (!declaredFlags.has(flag))
      undeclared.push({ kind: "flag", name: flag, at });
  }
  for (const flag of [...declaredFlags].sort()) {
    if (!(flag in usedFlags)) unused.push({ kind: "flag", name: flag, at: [] });
  }

  const declaredHooks = manifest.probes.flatMap((p) =>
    p.type === "hook-registered" ? [p] : [],
  );
  const foundHooks = scan.hooks.filter((h) => h.harness === harness);
  for (const h of foundHooks) {
    const covered = declaredHooks.some(
      (d) =>
        d.event === h.event &&
        (h.command.includes(d.match) || d.match.includes(h.match)),
    );
    if (!covered) {
      undeclared.push({
        kind: "hook",
        name: `${h.event} → ${h.match}`,
        at: [h.at],
      });
    }
  }
  for (const d of declaredHooks) {
    const found = foundHooks.some(
      (h) => h.event === d.event && h.command.includes(d.match),
    );
    if (!found) {
      unused.push({ kind: "hook", name: `${d.event} → ${d.match}`, at: [] });
    }
  }

  const declaredHelpers = new Set(
    manifest.probes.flatMap((p) =>
      p.type === "command-exists" && p.command ? [p.command] : [],
    ),
  );
  for (const [helper, at] of sortedEntries(scan.helpers)) {
    if (!declaredHelpers.has(helper)) {
      undeclared.push({ kind: "helper", name: helper, at });
    }
  }
  for (const helper of [...declaredHelpers].sort()) {
    if (!(helper in scan.helpers)) {
      unused.push({ kind: "helper", name: helper, at: [] });
    }
  }

  const declaredFields = new Set(
    manifest.probes.flatMap((p) =>
      p.type === "transcript-field" ? p.fields : [],
    ),
  );
  for (const [field, at] of sortedEntries(scan.transcriptFields)) {
    if (!declaredFields.has(field)) {
      undeclared.push({ kind: "transcript-field", name: field, at });
    }
  }
  for (const field of [...declaredFields].sort()) {
    if (!(field in scan.transcriptFields)) {
      unused.push({ kind: "transcript-field", name: field, at: [] });
    }
  }

  return { undeclared, unused };
}
