/**
 * The environment contract.
 *
 * An integration often depends less on a flag or a hook than on the variables
 * around the harness: a provider endpoint, a config directory, a certificate
 * bundle, a helper on PATH. Change a shell profile and the harness quietly
 * starts talking to a different provider, or reading a different config, with
 * nothing in its own output to say so.
 *
 * These checks are deterministic: a variable is set or it is not, a path
 * exists or it does not. Nothing here asks a model what it is — a model's
 * account of itself is not evidence of how it was configured.
 *
 * Values are secrets until shown otherwise. A verdict line lands in CI logs,
 * so a value is printed only when its name does not look like a credential and
 * the value itself is short and plain.
 */
import fs from "node:fs";
import path from "node:path";
import { show } from "./values.js";

/** What a variable holding a path must point at. `path` accepts anything
 * that exists. A bare `executable` name is looked up on PATH. */
export type PathKind = "file" | "dir" | "executable" | "path";

export interface EnvAssertions {
  /** Must be set, and not empty. */
  set?: string[];
  /** Must be unset, or empty — a variable that would override the intended
   * provider or credential when present. */
  unset?: string[];
  /** Name → the exact value it must hold. */
  equals?: Record<string, string>;
  /** Name → a regular expression its value must match. */
  matches?: Record<string, string>;
  /** Name → what its value must point at on disk. */
  pointsAt?: Record<string, PathKind>;
}

export type EnvSource = Record<string, string | undefined>;

// A name that looks like it holds a credential never has its value printed,
// whatever the value looks like.
const SECRET_NAME =
  /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|SIGNATURE/i;
// A value short and plain enough to be a setting rather than a secret.
const PLAIN_VALUE = /^[\w.:@/+-]{1,80}$/;
// A value that reads as a filesystem path, for the one line that needs it.
const PATHLIKE = /^[^\s]{1,240}$/;
// A URL carrying a userinfo part (`scheme://user:password@host`) — a
// credential embedded in a value that is otherwise short and plain, as proxy
// variables often are. Short and plain is not the same as safe to print.
const URL_USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*@/;

/** Whether a variable's value may appear in a verdict line. */
export function safeToShow(name: string, value: string): boolean {
  return (
    !SECRET_NAME.test(name) &&
    !URL_USERINFO.test(value) &&
    PLAIN_VALUE.test(value)
  );
}

const isSet = (v: string | undefined): v is string =>
  v !== undefined && v !== "";

const isExecutableFile = (p: string): boolean => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The executable file a value names, and where it is: a bare name is
 * searched along PATH for an executable file, a value containing a separator
 * is resolved against `baseDir` and checked directly. Null when nothing is
 * there. The one lookup `checkPath` and the harness resolution share, so the
 * two can never disagree about what counts as installed — and no value is
 * ever handed to a shell on the way, so a name is only ever a name. */
export function findExecutable(
  value: string,
  opts: { baseDir: string; searchPath: string | undefined },
): string | null {
  if (!/[/\\]/.test(value)) {
    for (const dir of (opts.searchPath ?? "")
      .split(path.delimiter)
      .filter(Boolean)) {
      const candidate = path.join(dir, value);
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }
  const resolved = path.resolve(opts.baseDir, value);
  return isExecutableFile(resolved) ? resolved : null;
}

/** Every variable a set of assertions names, in declaration order. */
export function envNames(a: EnvAssertions): string[] {
  const names = [
    ...(a.set ?? []),
    ...(a.unset ?? []),
    ...Object.keys(a.equals ?? {}),
    ...Object.keys(a.matches ?? {}),
    ...Object.keys(a.pointsAt ?? {}),
  ];
  return [...new Set(names)];
}

/** Does a path value point at the declared kind of thing? A relative value is
 * resolved against `baseDir`, which the caller names in its own output. */
export function checkPath(
  value: string,
  kind: PathKind,
  opts: { baseDir: string; searchPath: string | undefined },
): { ok: true } | { ok: false; why: string } {
  if (kind === "executable" && !/[/\\]/.test(value)) {
    return findExecutable(value, opts)
      ? { ok: true }
      : { ok: false, why: "is not on PATH" };
  }
  const resolved = path.resolve(opts.baseDir, value);
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    return { ok: false, why: "does not exist" };
  }
  if (kind === "file" && !st.isFile()) {
    return { ok: false, why: "is not a file" };
  }
  if (kind === "dir" && !st.isDirectory()) {
    return { ok: false, why: "is not a directory" };
  }
  if (kind === "executable") {
    if (!st.isFile()) return { ok: false, why: "is not a file" };
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
    } catch {
      return { ok: false, why: "is not executable" };
    }
  }
  return { ok: true };
}

export interface EnvEvaluation {
  /** Assertions that held, one phrase each. */
  held: string[];
  /** Assertions that did not, one phrase each — every one named. */
  problems: string[];
}

/**
 * Check a set of assertions against an environment. `origin` names where a
 * variable's value came from (the process, a settings layer) so a verdict can
 * say which of several places set it.
 */
export function evaluateEnv(
  a: EnvAssertions,
  env: EnvSource,
  opts: { baseDir: string; origin?: (name: string) => string | undefined },
): EnvEvaluation {
  const held: string[] = [];
  const problems: string[] = [];
  const from = (name: string): string => {
    const o = opts.origin?.(name);
    return o ? ` (${o})` : "";
  };

  const set = a.set ?? [];
  if (set.length > 0) {
    const missing = set.filter((n) => !isSet(env[n]));
    if (missing.length === 0) {
      held.push(`set: ${set.map((n) => `${n}${from(n)}`).join(", ")}`);
    } else {
      problems.push(`not set: ${missing.join(", ")}`);
    }
  }

  const unset = a.unset ?? [];
  if (unset.length > 0) {
    const present = unset.filter((n) => isSet(env[n]));
    if (present.length === 0) {
      held.push(`unset as declared: ${unset.join(", ")}`);
    } else {
      problems.push(
        `set but declared unset: ${present.map((n) => `${n}${from(n)}`).join(", ")}`,
      );
    }
  }

  const equals = Object.entries(a.equals ?? {});
  if (equals.length > 0) {
    const wrong: string[] = [];
    for (const [name, want] of equals) {
      const got = env[name];
      if (!isSet(got)) {
        wrong.push(
          `${name} is not set${safeToShow(name, want) ? ` (expected ${show(want)})` : ""}`,
        );
      } else if (got !== want) {
        wrong.push(
          safeToShow(name, got) && safeToShow(name, want)
            ? `${name} is ${show(got)}${from(name)} (expected ${show(want)})`
            : `${name}${from(name)} holds a different value than declared (not shown)`,
        );
      }
    }
    if (wrong.length === 0) {
      held.push(
        `values match: ${equals.map(([n]) => `${n}${from(n)}`).join(", ")}`,
      );
    } else {
      problems.push(...wrong);
    }
  }

  const matches = Object.entries(a.matches ?? {});
  if (matches.length > 0) {
    const wrong: string[] = [];
    for (const [name, pattern] of matches) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        wrong.push(
          `the pattern for ${name} does not compile: ${(e as Error).message}`,
        );
        continue;
      }
      const got = env[name];
      if (!isSet(got)) wrong.push(`${name} is not set`);
      else if (!re.test(got)) {
        wrong.push(`${name}${from(name)} does not match /${pattern}/`);
      }
    }
    if (wrong.length === 0) {
      held.push(`patterns match: ${matches.map(([n]) => n).join(", ")}`);
    } else {
      problems.push(...wrong);
    }
  }

  const pointsAt = Object.entries(a.pointsAt ?? {});
  if (pointsAt.length > 0) {
    const wrong: string[] = [];
    for (const [name, kind] of pointsAt) {
      const got = env[name];
      if (!isSet(got)) {
        wrong.push(`${name} is not set (expected a ${kind})`);
        continue;
      }
      const r = checkPath(got, kind, {
        baseDir: opts.baseDir,
        searchPath: env.PATH,
      });
      if (!r.ok) {
        // The one place a value is worth printing: "points at X, which does
        // not exist" is the whole finding. Still never for a credential name,
        // nor for a URL with a userinfo part — the credential it carries is
        // the last thing a verdict line should repeat.
        const shown =
          !SECRET_NAME.test(name) &&
          PATHLIKE.test(got) &&
          !URL_USERINFO.test(got)
            ? ` ${show(got, 120)}`
            : " (value not shown)";
        wrong.push(`${name}${from(name)} ${r.why}:${shown}`);
      }
    }
    if (wrong.length === 0) {
      held.push(
        `paths resolve: ${pointsAt.map(([n, k]) => `${n} → ${k}`).join(", ")}`,
      );
    } else {
      problems.push(...wrong);
    }
  }

  return { held, problems };
}
