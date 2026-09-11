/**
 * One glob implementation, shared by every reader of a file tree — the
 * transcript probes, the baseline observer, the live run's session lookup —
 * so two readers of the same pattern can never disagree about what matches.
 *
 * `*` stays inside one path segment; a `**` SEGMENT crosses segments (any
 * number of directories, including none; a trailing `**` anything left);
 * `{session}` expands to one literal session id, for the pattern a live turn
 * resolves. Anything else — `?`, bracket expressions, braces — is matched as
 * the literal character it is, and `peirad validate` warns about it, so no
 * pattern silently matches less than it appears to.
 */
import fs from "node:fs";
import path from "node:path";

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A regular expression that matches a whole `/`-separated relative path. */
export function globRegExp(
  pattern: string,
  opts: { session?: string } = {},
): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith("{session}", i) && opts.session !== undefined) {
      re += escapeRe(opts.session);
      i += "{session}".length - 1;
    } else if (pattern.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (pattern[i] === "*") {
      re += "[^/]*";
    } else {
      re += escapeRe(pattern[i]!);
    }
  }
  return new RegExp(`^${re}$`);
}

/** The directory a pattern's walk starts from: everything before the first
 * wildcard, which no match can live outside. */
export function globRoot(base: string, pattern: string): string {
  const prefix = pattern.split(/[*{]/)[0]!;
  return path.join(
    base,
    prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "",
  );
}

/** Every file under `base` whose path relative to `base` matches the
 * pattern. Callers sample by recency, never by listing order. */
export function listMatches(base: string, pattern: string): string[] {
  const matcher = globRegExp(pattern);
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(base, full).split(path.sep).join("/");
        if (matcher.test(rel)) found.push(full);
      }
    }
  };
  walk(globRoot(base, pattern));
  return found;
}
