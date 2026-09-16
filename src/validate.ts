/**
 * `peirad validate` — the strict reading of a manifest.
 *
 * A run is lenient on purpose: a field it does not understand is skipped and
 * named, so a manifest written for a newer release still delivers a verdict on
 * an older install (D-014). Lenient is only safe if something strict exists.
 * This is that: it refuses an unknown field, an unknown probe type, a value of
 * the wrong shape and a probe that declares nothing — each with the path and
 * the line — before a single harness process is started. A typo that a run
 * would forgive as "skipped" fails here, in CI, where it is cheap to fix.
 */
import fs from "node:fs";
import path from "node:path";
import { MANIFEST_FIELDS, PROBE_FIELDS } from "./manifest.js";
import {
  PROMPT_PLACEHOLDER,
  profileNames,
  resolveProfile,
} from "./harness-profiles.js";
import type { Manifest } from "./manifest.js";

/** One problem, where it is. */
export interface Finding {
  /** JSON path, e.g. `probes[2].absent`. */
  path: string;
  /** 1-based line in the file, when it could be located. */
  line: number | null;
  message: string;
}

export interface ValidatedProbe {
  index: number;
  type: string;
  line: number | null;
  /** Paths the probe reads, resolved against the configuration directory. */
  resolved: string[];
}

export type ValidationReport =
  | {
      file: string;
      ok: true;
      errors: Finding[];
      warnings: Finding[];
      probes: ValidatedProbe[];
    }
  | { file: string; ok: false; fatal: string };

// ---------------------------------------------------------------------------
// JSON with positions. JSON.parse gives values but not lines, and a finding
// that says "somewhere in probes[2]" makes the reader count braces.

interface Located {
  value: unknown;
  lineOf: (jsonPath: string) => number | null;
}

export function parseLocated(text: string): Located {
  const lines = new Map<string, number>();
  const starts = [0];
  for (let k = 0; k < text.length; k++)
    if (text[k] === "\n") starts.push(k + 1);
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let i = 0;
  const fail = (what: string): never => {
    throw new SyntaxError(
      `${what} at line ${lineAt(Math.min(i, text.length))}`,
    );
  };
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      i++;
    }
    if (text[i] !== '"') fail("unterminated string");
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (at: string): unknown => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a quoted key");
        const keyAt = i;
        const key = str();
        const p = at ? `${at}.${key}` : key;
        if (!lines.has(p)) lines.set(p, lineAt(keyAt));
        ws();
        if (text[i] !== ":") fail(`expected ":" after "${key}"`);
        i++;
        // defineProperty: a key named __proto__ is data, not a prototype.
        Object.defineProperty(obj, key, {
          value: value(p),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail('expected "," or "}"');
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (let n = 0; ; n++) {
        ws();
        const p = `${at}[${n}]`;
        lines.set(p, lineAt(i));
        arr.push(value(p));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(i),
    );
    if (!m)
      fail(c === undefined ? "unexpected end of file" : "unexpected token");
    i += m![0].length;
    return JSON.parse(m![0]);
  };
  const v = value("");
  ws();
  if (i < text.length) fail("unexpected content after the document");
  return { value: v, lineOf: (p) => lines.get(p) ?? null };
}

// ---------------------------------------------------------------------------
// Field checks. Each returns null when the value is fine, or what is wrong.

type Check = (v: unknown) => string | null;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const str: Check = (v) => (typeof v === "string" ? null : "must be a string");
const nonEmpty: Check = (v) =>
  typeof v === "string" && v.length > 0 ? null : "must be a non-empty string";
const bool: Check = (v) =>
  typeof v === "boolean" ? null : "must be true or false";
const positive: Check = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? null
    : "must be a positive number";
const strings =
  (atLeastOne = false): Check =>
  (v) =>
    Array.isArray(v) &&
    v.every((x) => typeof x === "string") &&
    (!atLeastOne || v.length > 0)
      ? null
      : atLeastOne
        ? "must be a non-empty array of strings"
        : "must be an array of strings";
const oneOf =
  (...allowed: string[]): Check =>
  (v) =>
    typeof v === "string" && allowed.includes(v)
      ? null
      : `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`;
const compiles: Check = (v) => {
  if (typeof v !== "string") return "must be a string";
  try {
    new RegExp(v);
    return null;
  } catch (e) {
    return `does not compile as a regular expression: ${(e as Error).message}`;
  }
};
const anyObject: Check = (v) => (isObject(v) ? null : "must be an object");
const recordOf =
  (inner: Check): Check =>
  (v) => {
    if (!isObject(v)) return "must be an object";
    for (const [k, x] of Object.entries(v)) {
      const why = inner(x);
      if (why) return `"${k}" ${why}`;
    }
    return null;
  };
const objects: Check = (v) =>
  Array.isArray(v) && v.every(isObject) ? null : "must be an array of objects";

/** Every probe type's fields and their checks. Kept in step with
 * `PROBE_FIELDS` — a test fails the day the two disagree. */
export const PROBE_SCHEMA: Record<
  string,
  { fields: Record<string, Check>; required: string[] }
> = {
  "command-exists": { fields: { command: nonEmpty }, required: [] },
  version: { fields: {}, required: [] },
  "flag-accepted": { fields: { flags: strings(true) }, required: ["flags"] },
  "config-key": {
    fields: {
      file: nonEmpty,
      keys: strings(),
      expect: anyObject,
      absent: strings(),
      scope: oneOf("file", "effective"),
    },
    required: [],
  },
  "transcript-field": {
    fields: { glob: nonEmpty, fields: strings(true) },
    required: ["glob", "fields"],
  },
  "hook-registered": {
    fields: {
      file: nonEmpty,
      event: nonEmpty,
      match: nonEmpty,
      scope: oneOf("file", "effective"),
    },
    required: ["event", "match"],
  },
  script: {
    fields: { script: nonEmpty, args: strings(), timeoutMs: positive },
    required: ["script"],
  },
  "harness-reports": {
    fields: { report: nonEmpty, find: objects },
    required: ["report"],
  },
  env: {
    fields: {
      set: strings(),
      unset: strings(),
      equals: recordOf(str),
      matches: recordOf(compiles),
      pointsAt: recordOf(oneOf("file", "dir", "executable", "path")),
      scope: oneOf("process", "effective"),
    },
    required: [],
  },
};

const LAYER_FIELDS: Record<string, Check> = {
  name: nonEmpty,
  path: nonEmpty,
  platformPaths: recordOf(str),
};
const REPORT_FIELDS: Record<string, Check> = {
  args: strings(),
  format: oneOf("json", "lines"),
  records: str,
  pattern: compiles,
  emptyPattern: compiles,
  timeoutMs: positive,
};

const isComment = (k: string): boolean => k.startsWith("_");

// ---------------------------------------------------------------------------

export function validateManifestText(
  text: string,
  file: string,
  opts: { configDir?: string } = {},
): ValidationReport {
  let located: Located;
  try {
    located = parseLocated(text);
  } catch (e) {
    return {
      file,
      ok: false,
      fatal: `not valid JSON: ${(e as Error).message}`,
    };
  }
  const { value: root, lineOf } = located;
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const err = (p: string, message: string): void => {
    errors.push({ path: p, line: lineOf(p), message });
  };
  const warn = (p: string, message: string): void => {
    warnings.push({ path: p, line: lineOf(p), message });
  };

  if (!isObject(root)) {
    return { file, ok: false, fatal: "the manifest must be a JSON object" };
  }

  for (const key of Object.keys(root)) {
    if (!isComment(key) && !MANIFEST_FIELDS.includes(key)) {
      err(key, `unknown field "${key}" — not part of the manifest format`);
    }
  }
  const field = (key: string, check: Check): void => {
    if (root[key] === undefined) return;
    const why = check(root[key]);
    if (why) err(key, `"${key}" ${why}`);
  };
  if (root.harness === undefined) err("harness", `"harness" is required`);
  field("harness", nonEmpty);
  field("name", str);
  field("configDir", str);
  field("settingsEnv", nonEmpty);
  field("harnessProfile", oneOf(...profileNames()));
  field("promptArgs", strings());
  field("outputArgs", strings());
  field("versionArgs", strings());
  field("settingsArrays", oneOf("concat", "override"));
  if (
    Array.isArray(root.promptArgs) &&
    root.promptArgs.every((a) => typeof a === "string") &&
    !root.promptArgs.includes(PROMPT_PLACEHOLDER)
  ) {
    err(
      "promptArgs",
      `"promptArgs" must contain the ${PROMPT_PLACEHOLDER} placeholder`,
    );
  }
  const nested = (
    base: string,
    value: unknown,
    fields: Record<string, Check>,
    required: string[],
  ): void => {
    if (!isObject(value)) {
      err(base, `${base} must be an object`);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (isComment(k)) continue;
      const check = fields[k];
      if (!check) err(`${base}.${k}`, `unknown field "${k}"`);
      else {
        const why = check(v);
        if (why) err(`${base}.${k}`, `"${k}" ${why}`);
      }
    }
    for (const r of required) {
      if (value[r] === undefined) err(base, `${base} needs "${r}"`);
    }
  };
  if (root.settingsLayers !== undefined) {
    if (!Array.isArray(root.settingsLayers)) {
      err("settingsLayers", `"settingsLayers" must be an array`);
    } else {
      root.settingsLayers.forEach((layer, n) =>
        nested(`settingsLayers[${n}]`, layer, LAYER_FIELDS, ["name", "path"]),
      );
    }
  }
  if (root.reports !== undefined) {
    if (!isObject(root.reports)) {
      err("reports", `"reports" must be an object`);
    } else {
      for (const [name, report] of Object.entries(root.reports)) {
        const base = `reports.${name}`;
        nested(base, report, REPORT_FIELDS, ["args", "format"]);
        if (
          isObject(report) &&
          report.format === "lines" &&
          report.pattern === undefined
        ) {
          err(base, `${base} is a "lines" report and needs a "pattern"`);
        }
      }
    }
  }

  const probes: ValidatedProbe[] = [];
  if (!Array.isArray(root.probes)) {
    err("probes", `"probes" is required and must be an array`);
    return { file, ok: true, errors, warnings, probes };
  }

  const configDir = path.resolve(
    opts.configDir ??
      (typeof root.configDir === "string" ? root.configDir : undefined) ??
      path.dirname(path.resolve(file)),
  );
  let profileReports: string[] = [];
  try {
    profileReports = Object.keys(
      resolveProfile(
        typeof root.harness === "string" ? root.harness : "",
        typeof root.harnessProfile === "string"
          ? root.harnessProfile
          : undefined,
        root as unknown as Manifest,
      ).reports,
    );
  } catch {
    // an invalid profile or promptArgs is already an error above
  }

  root.probes.forEach((probe, index) => {
    const base = `probes[${index}]`;
    if (!isObject(probe) || typeof probe.type !== "string") {
      err(base, `${base} must be an object with a string "type"`);
      probes.push({ index, type: "?", line: lineOf(base), resolved: [] });
      return;
    }
    const type = probe.type;
    const schema = PROBE_SCHEMA[type];
    const resolved: string[] = [];
    probes.push({ index, type, line: lineOf(base), resolved });
    if (!schema) {
      err(
        `${base}.type`,
        `unknown probe type "${type}" (known: ${Object.keys(PROBE_SCHEMA).join(", ")})`,
      );
      return;
    }
    for (const [k, v] of Object.entries(probe)) {
      if (k === "type" || isComment(k)) continue;
      if (k === "critical") {
        const why = bool(v);
        if (why) err(`${base}.critical`, `"critical" ${why}`);
        continue;
      }
      const check = schema.fields[k];
      if (!check) {
        err(`${base}.${k}`, `unknown field "${k}" on a ${type} probe`);
        continue;
      }
      const why = check(v);
      if (why) err(`${base}.${k}`, `"${k}" ${why}`);
    }
    for (const r of schema.required) {
      if (probe[r] === undefined) err(base, `a ${type} probe needs "${r}"`);
    }

    // Rules across fields, and what the probe will read.
    const fileScoped =
      (type === "config-key" || type === "hook-registered") &&
      probe.scope !== "effective";
    if (fileScoped) {
      if (typeof probe.file !== "string") {
        err(base, `a ${type} probe needs "file", or scope "effective"`);
      } else {
        const target = path.resolve(configDir, probe.file);
        resolved.push(target);
        if (!fs.existsSync(target)) {
          warn(`${base}.file`, `"${probe.file}" does not exist at ${target}`);
        }
      }
    }
    if (type === "config-key") {
      const declared =
        (Array.isArray(probe.keys) && probe.keys.length > 0) ||
        (isObject(probe.expect) && Object.keys(probe.expect).length > 0) ||
        (Array.isArray(probe.absent) && probe.absent.length > 0);
      if (!declared) {
        err(
          base,
          `a config-key probe declares nothing — give it "keys", "expect" or "absent"`,
        );
      }
    }
    if (type === "env") {
      const declared = ["set", "unset", "equals", "matches", "pointsAt"].some(
        (k) =>
          (Array.isArray(probe[k]) && (probe[k] as unknown[]).length > 0) ||
          (isObject(probe[k]) && Object.keys(probe[k] as object).length > 0),
      );
      if (!declared) {
        err(
          base,
          `an env probe declares nothing — give it "set", "unset", "equals", "matches" or "pointsAt"`,
        );
      }
    }
    if (type === "transcript-field" && typeof probe.glob === "string") {
      if (/[[\]{}?]/.test(probe.glob)) {
        warn(
          `${base}.glob`,
          `"${probe.glob}" carries characters matched literally: only "*" (within one path segment) and "**" (across segments) are wildcards`,
        );
      }
    }
    if (type === "flag-accepted" && Array.isArray(probe.flags)) {
      probe.flags.forEach((f, n) => {
        if (typeof f === "string" && !f.startsWith("-")) {
          warn(
            `${base}.flags[${n}]`,
            `"${f}" does not look like a flag — it is matched as a whole token of the help text`,
          );
        }
      });
    }
    if (type === "script" && typeof probe.script === "string") {
      const target = path.resolve(configDir, probe.script);
      resolved.push(target);
      if (!fs.existsSync(target)) {
        warn(`${base}.script`, `"${probe.script}" does not exist at ${target}`);
      } else {
        try {
          fs.accessSync(target, fs.constants.X_OK);
        } catch {
          warn(`${base}.script`, `"${probe.script}" is not executable`);
        }
      }
    }
    if (
      type === "harness-reports" &&
      typeof probe.report === "string" &&
      profileReports.length > 0 &&
      !profileReports.includes(probe.report)
    ) {
      warn(
        `${base}.report`,
        `no "${probe.report}" report is declared for this harness (declared: ${profileReports.join(", ")})`,
      );
    }
  });

  return { file, ok: true, errors, warnings, probes };
}

export function validateManifestFile(
  file: string,
  opts: { configDir?: string } = {},
): ValidationReport {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { file, ok: false, fatal: `cannot read: ${(e as Error).message}` };
  }
  return validateManifestText(text, file, opts);
}
