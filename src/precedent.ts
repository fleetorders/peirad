/**
 * `peirad precedent` — match a work item to earlier decisions and emit the
 * resolution to apply, so an automated caller can close an alarm that was
 * already decided instead of raising it again.
 *
 * A work item is a markdown file: optional `---` frontmatter (a `from:` line
 * names the source that raised it), a `#` title, and — once resolved — a
 * `done:` line saying how it was closed. The decisions log is markdown with
 * `### D-<n> — title` headings, each followed by a `**Scope:**` line.
 *
 * Where triage asks WHETHER drift matters, precedent asks whether it has
 * already been DECIDED. The match is deterministic text work — no harness
 * call, no model — and three properties keep the result safe to act around:
 *
 * - the command is read-only: it prints, never writes, and never resolves
 *   anything itself;
 * - a match must name a quotable earlier record (a resolved item's `done:`
 *   line or a decision in the log) — an assertion without one reads as "no
 *   precedent found";
 * - items whose text trips one of the rails, a fixed stop list of topics
 *   (credentials, confidential material, system configuration, registries,
 *   releases, outward actions), always report no match with the rail named — deliberately over-broad, because a false "no match"
 *   costs a person a glance and a false "matched" costs a wrong
 *   auto-resolution.
 */
import fs from "node:fs";
import path from "node:path";

/** A parsed work item: frontmatter values, first `#` title, `done:` lines. */
export interface ParsedEntry {
  meta: Record<string, string>;
  title: string | null;
  done: string[];
  /** The full file text — rail scanning reads everything. */
  text: string;
}

/** Parse a work item: line-based frontmatter, first h1, every `done:` line. */
export function parseEntry(md: string): ParsedEntry {
  const lines = md.split("\n");
  const meta: Record<string, string> = {};
  let fmEnd = -1;
  if ((lines[0] ?? "").trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() === "---") {
        fmEnd = i;
        break;
      }
      const m = line.match(/^([A-Za-z][A-Za-z-]*):\s?(.*)$/);
      if (m) meta[m[1]!] = m[2]!.trim();
    }
  }
  let title: string | null = null;
  for (let i = fmEnd + 1; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(/^#\s+(.+)$/);
    if (m) {
      title = m[1]!.trim();
      break;
    }
  }
  const done: string[] = [];
  for (const line of lines) {
    const m = line.match(/^done:\s*(.*)$/);
    if (m) done.push(m[1]!.trim().replace(/^"(.*)"$/, "$1"));
  }
  return { meta, title, done, text: md };
}

/** The class key: title stem plus `from:` source, normalized so recurrences collapse. */
export interface ClassKey {
  stem: string;
  from: string;
  display: string;
}

/**
 * Normalize a key part: strip parenthetical qualifiers, number runs with
 * their joining punctuation (dates, versions, counts, ids) and markdown
 * marks, collapse case and whitespace — so "scheduled sweep 2026-09-04" and
 * "scheduled sweep 2026-09-05" are one source.
 */
export function normalizeKeyPart(s: string): string {
  return s
    .replace(/\([^)]*\)/g, "")
    .replace(/\d+(?:[-–—/.]\d+)*/g, "")
    .replace(/[`*_[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Derive the class key: the title up to the first `:` or ` — `, plus `from:`. */
export function classKey(e: ParsedEntry): ClassKey {
  const t = e.title ?? "";
  const cut = t.search(/:|\s—\s/);
  const stem = normalizeKeyPart(cut === -1 ? t : t.slice(0, cut));
  const from = normalizeKeyPart(e.meta.from ?? "");
  return { stem, from, display: from ? `${stem} · ${from}` : stem };
}

/** One decision from a decisions log (`### D-<n> — title` blocks). */
export interface LedgerEntry {
  id: string;
  title: string;
  /** The `**Scope:**` line's text, verbatim. */
  scope: string;
  /** The first paragraph after the Scope line — the decision statement. */
  firstParagraph: string;
}

export function parseLedger(md: string): LedgerEntry[] {
  const re = /^###\s+(D-\d+)\s*[—–-]\s*(.+?)\s*$/gm;
  const marks: { id: string; title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    marks.push({ id: m[1]!, title: m[2]!, start: m.index, end: re.lastIndex });
  }
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const block = md.slice(
      mark.end,
      i + 1 < marks.length ? marks[i + 1]!.start : md.length,
    );
    const sm = block.match(/\*\*Scope:\*\*\s*(.+)/);
    const scope = sm?.[1]?.trim() ?? "";
    const after = sm
      ? block.slice(block.indexOf(sm[0]!) + sm[0]!.length)
      : block;
    const para =
      after
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0] ?? "";
    entries.push({
      id: mark.id,
      title: mark.title,
      scope,
      firstParagraph: para.split("\n").join(" "),
    });
  }
  return entries;
}

/**
 * Rail keyword list — item classes that are never auto-resolved. Order is
 * the precedence when several hit; most sensitive first.
 */
const RAILS: { name: string; test: RegExp }[] = [
  {
    name: "credentials",
    test: /\b(token|secret|password|credential|api[- ]?key|keychain|private key|\.env)\b/i,
  },
  {
    name: "confidential",
    test: /\b(confidential|proprietary|internal[- ]only|restricted)\b/i,
  },
  {
    name: "system-config",
    test: /\b(system config|launchagent|global config|dotfile|ide profile|home[- ]dir)\b/i,
  },
  { name: "registry", test: /\bregistry\b/i },
  { name: "release", test: /\b(publish|release|git tag|npm publish)\b/i },
  {
    name: "outward-action",
    test: /\b(push|deploy|send|email|announce|post to|comment on)\b/i,
  },
];

/**
 * Extra words for the confidential rail, supplied by the caller (one per line, `#`
 * comments allowed): a project's own words for material that must never be resolved
 * automatically are supplied by the project rather than built into this tool. Matched as whole words, case-insensitively.
 */
export function parseRailWords(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectRail(
  text: string,
  extraWords: string[] = [],
): string | null {
  if (extraWords.length) {
    const extra = new RegExp(
      `\\b(${extraWords.map(escapeRe).join("|")})\\b`,
      "i",
    );
    if (extra.test(text)) return "confidential";
  }
  for (const rail of RAILS) {
    if (rail.test.test(text)) return rail.name;
  }
  return null;
}

/** A resolved item of the same kind, as passed in by the caller (file + text). */
export interface SiblingInput {
  file: string;
  text: string;
}

export interface PrecedentResult {
  schema: "precedent/1";
  matched: boolean;
  /** The class key the match was sought under, e.g. "canary drift · scheduled sweep". */
  class: string;
  source: "resolved" | "ledger" | null;
  /** The resolved item's filename or the decision id that was matched. */
  id: string | null;
  /** The resolution to apply: a resolved item's `done:` line, or the decision's first paragraph. */
  resolution: string | null;
  /** Positional, not semantic: high = a resolved item, medium = a decision only. */
  confidence: "high" | "medium" | null;
  /** Why nothing matched, when nothing did. */
  reason: string | null;
  /** The rail that blocked matching, when one hit. */
  rail: string | null;
  entry: string;
  checked_at: string;
}

/**
 * Find precedent for one work item against a decisions log and a set of
 * resolved items. Pure: all inputs are texts, so the same inputs give the same
 * answer. Throws when the entry has no `#` title to derive a class from.
 */
export function findPrecedent(
  entryText: string,
  ledgerText: string,
  siblings: SiblingInput[],
  extraRailWords: string[] = [],
): Omit<PrecedentResult, "entry" | "checked_at"> {
  const entry = parseEntry(entryText);
  if (!entry.title) {
    throw new Error("entry has no `#` title — cannot derive a class key");
  }
  const key = classKey(entry);
  const base = { schema: "precedent/1" as const, class: key.display };

  const rail = detectRail(entry.text, extraRailWords);
  if (rail) {
    return {
      ...base,
      matched: false,
      source: null,
      id: null,
      resolution: null,
      confidence: null,
      reason: `rail hit: ${rail} — this class is never auto-resolved`,
      rail,
    };
  }

  const same = key.stem.length > 0 ? key.stem : null;
  const cands = siblings
    .map((s) => ({ file: s.file, e: parseEntry(s.text) }))
    .filter(({ e }) => e.done.length > 0)
    .filter(({ e }) => {
      const k = classKey(e);
      return k.stem === key.stem && k.from === key.from;
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const newest = cands.length > 0 ? cands[cands.length - 1] : undefined;
  if (newest && same !== null) {
    return {
      ...base,
      matched: true,
      source: "resolved",
      id: newest.file,
      resolution: newest.e.done[0] ?? "",
      confidence: "high",
      reason: null,
      rail: null,
    };
  }

  const ruling = parseLedger(ledgerText).find(
    (l) =>
      same !== null &&
      (normalizeKeyPart(l.title).includes(same) ||
        normalizeKeyPart(l.scope).includes(same)),
  );
  if (ruling && same !== null) {
    return {
      ...base,
      matched: true,
      source: "ledger",
      id: ruling.id,
      resolution: ruling.firstParagraph,
      confidence: "medium",
      reason: null,
      rail: null,
    };
  }

  return {
    ...base,
    matched: false,
    source: null,
    id: null,
    resolution: null,
    confidence: null,
    reason: `no resolved item and no decision covers class "${key.display}"`,
    rail: null,
  };
}

export function renderPrecedentMarkdown(r: PrecedentResult): string {
  const lines: string[] = [
    "## Precedent (machine, unverified)",
    `Class: ${r.class}`,
  ];
  if (r.matched) {
    const src = r.source === "resolved" ? "sibling" : "ruling";
    lines.push(`Matched: yes (${r.confidence}) — ${src} ${r.id}`);
    lines.push("Resolution to apply:");
    lines.push(r.resolution ?? "");
  } else {
    lines.push("Matched: no");
    lines.push(`Reason: ${r.reason}`);
    if (r.rail) lines.push(`Rail: ${r.rail}`);
  }
  return lines.join("\n") + "\n";
}

export function renderPrecedentJson(r: PrecedentResult): string {
  return JSON.stringify(r, null, 2) + "\n";
}

export interface PrecedentCliOptions {
  entry: string;
  ledger: string;
  resolved?: string[];
  /** Extra whole-word keywords for the confidential rail, one per line. */
  railWords?: string;
  json?: boolean;
}

/**
 * The `peirad precedent` command body: read inputs, match, print. Read-only
 * by construction. Returns the process exit code (0 whether or not precedent
 * matched — the answer is information; 2 when inputs are unusable).
 */
export function precedentCommand(opts: PrecedentCliOptions): number {
  let entryText: string;
  try {
    entryText = fs.readFileSync(opts.entry, "utf8");
  } catch {
    process.stderr.write(`peirad: entry not found: ${opts.entry}\n`);
    return 2;
  }
  let ledgerText: string;
  try {
    ledgerText = fs.readFileSync(opts.ledger, "utf8");
  } catch {
    process.stderr.write(`peirad: ledger not found: ${opts.ledger}\n`);
    return 2;
  }
  const entryReal = fs.realpathSync(opts.entry);
  const siblings: SiblingInput[] = [];
  for (const dir of opts.resolved ?? []) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      process.stderr.write(`peirad: resolved dir not found: ${dir}\n`);
      return 2;
    }
    for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) continue;
      if (fs.realpathSync(full) === entryReal) continue; // never match the entry to itself
      siblings.push({ file: name, text: fs.readFileSync(full, "utf8") });
    }
  }
  let found: Omit<PrecedentResult, "entry" | "checked_at">;
  try {
    let railWords: string[] = [];
    if (opts.railWords) {
      try {
        railWords = parseRailWords(fs.readFileSync(opts.railWords, "utf8"));
      } catch {
        process.stderr.write(
          `peirad: rail words file not found: ${opts.railWords}\n`,
        );
        return 2;
      }
    }
    found = findPrecedent(entryText, ledgerText, siblings, railWords);
  } catch (e) {
    process.stderr.write(`peirad: ${String(e)}\n`);
    return 2;
  }
  const result: PrecedentResult = {
    ...found,
    entry: opts.entry,
    checked_at: new Date().toISOString(),
  };
  process.stdout.write(
    opts.json ? renderPrecedentJson(result) : renderPrecedentMarkdown(result),
  );
  return 0;
}
