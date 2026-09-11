import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROBE_FIELDS } from "../src/manifest.js";
import {
  PROBE_SCHEMA,
  parseLocated,
  validateManifestText,
  validateManifestFile,
} from "../src/validate.js";

const check = (manifest: unknown, configDir = os.tmpdir()) => {
  const r = validateManifestText(
    JSON.stringify(manifest, null, 2),
    "peirad.json",
    { configDir },
  );
  if (!r.ok) throw new Error(r.fatal);
  return r;
};
const messages = (r: ReturnType<typeof check>) =>
  r.errors.map((e) => `${e.path}: ${e.message}`);

describe("the strict schema", () => {
  it("covers exactly the fields every probe type understands", () => {
    expect(Object.keys(PROBE_SCHEMA).sort()).toEqual(
      Object.keys(PROBE_FIELDS).sort(),
    );
    for (const [type, fields] of Object.entries(PROBE_FIELDS)) {
      expect(Object.keys(PROBE_SCHEMA[type]!.fields).sort()).toEqual(
        [...fields].sort(),
      );
    }
  });

  it("accepts the repository's own example manifest without errors", () => {
    const r = validateManifestFile(
      path.join(__dirname, "..", "peirad.example.json"),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.errors).toEqual([]);
  });
});

describe("what validate refuses, and where", () => {
  it("names an unknown field with its path and line", () => {
    const text = [
      "{",
      '  "harness": "claude",',
      '  "probes": [',
      '    { "type": "command-exists" },',
      '    { "type": "flag-accepted", "flags": ["-p"],',
      '      "absent": ["x"] }',
      "  ]",
      "}",
    ].join("\n");
    const r = validateManifestText(text, "peirad.json");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.errors).toEqual([
      {
        path: "probes[1].absent",
        line: 6,
        message: 'unknown field "absent" on a flag-accepted probe',
      },
    ]);
  });

  it("refuses an unknown manifest field and an unknown probe type", () => {
    const r = check({
      harness: "claude",
      futureSetting: true,
      probes: [{ type: "future-probe" }],
    });
    expect(messages(r)).toEqual([
      'futureSetting: unknown field "futureSetting" — not part of the manifest format',
      expect.stringContaining(
        'probes[0].type: unknown probe type "future-probe"',
      ),
    ]);
  });

  it("refuses values of the wrong shape", () => {
    const r = check({
      harness: "claude",
      harnessProfile: "no-such-profile",
      promptArgs: ["-p"],
      settingsArrays: "merge",
      probes: [
        { type: "flag-accepted", flags: "-p", critical: "yes" },
        {
          type: "config-key",
          scope: "everywhere",
          keys: ["a"],
          file: "s.json",
        },
        { type: "env", matches: { A: "(" }, pointsAt: { B: "socket" } },
        { type: "script", script: "x.sh", timeoutMs: -1 },
      ],
    });
    const m = messages(r).join("\n");
    expect(m).toContain(
      'harnessProfile: "harnessProfile" must be one of "claude", "codex"',
    );
    expect(m).toContain(
      'promptArgs: "promptArgs" must contain the {prompt} placeholder',
    );
    expect(m).toContain(
      'settingsArrays: "settingsArrays" must be one of "concat", "override"',
    );
    expect(m).toContain(
      'probes[0].flags: "flags" must be a non-empty array of strings',
    );
    expect(m).toContain('probes[0].critical: "critical" must be true or false');
    expect(m).toContain(
      'probes[1].scope: "scope" must be one of "file", "effective"',
    );
    expect(m).toContain('probes[2].matches: "matches" "A" does not compile');
    expect(m).toContain('probes[2].pointsAt: "pointsAt" "B" must be one of');
    expect(m).toContain(
      'probes[3].timeoutMs: "timeoutMs" must be a positive number',
    );
  });

  it("refuses a probe that is missing what it needs or declares nothing", () => {
    const r = check({
      probes: [
        { type: "transcript-field", glob: "x/*.jsonl" },
        { type: "hook-registered", event: "PreToolUse", match: "guard" },
        { type: "config-key", file: "s.json" },
        { type: "env", scope: "effective" },
      ],
    });
    expect(messages(r)).toEqual([
      'harness: "harness" is required',
      'probes[0]: a transcript-field probe needs "fields"',
      'probes[1]: a hook-registered probe needs "file", or scope "effective"',
      'probes[2]: a config-key probe declares nothing — give it "keys", "expect" or "absent"',
      'probes[3]: an env probe declares nothing — give it "set", "unset", "equals", "matches" or "pointsAt"',
    ]);
  });

  it("checks declared layers and reports field by field", () => {
    const r = check({
      harness: "x",
      settingsLayers: [{ name: "user" }, { name: "p", path: "a", extra: 1 }],
      reports: { list: { args: ["ls"], format: "lines" } },
      probes: [],
    });
    expect(messages(r)).toEqual([
      'settingsLayers[0]: settingsLayers[0] needs "path"',
      'settingsLayers[1].extra: unknown field "extra"',
      'reports.list: reports.list is a "lines" report and needs a "pattern"',
    ]);
  });

  it("treats underscore keys as comments everywhere", () => {
    const r = check({
      _note: "why this manifest exists",
      harness: "claude",
      probes: [{ type: "command-exists", _from: "scripts/run.sh:3" }],
    });
    expect(r.errors).toEqual([]);
  });

  it("reports malformed JSON with the line, as fatal", () => {
    const r = validateManifestText(
      '{\n  "harness": "claude",\n  "probes": [\n}',
      "m.json",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fatal).toMatch(/not valid JSON: .* at line 4/);
  });
});

describe("what validate only warns about", () => {
  it("warns about a file or script that is not there yet, and lists what each probe reads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-validate-"));
    try {
      fs.writeFileSync(path.join(dir, "present.json"), "{}");
      const r = check(
        {
          harness: "claude",
          probes: [
            { type: "config-key", file: "present.json", keys: ["a"] },
            {
              type: "hook-registered",
              file: "missing.json",
              event: "Stop",
              match: "x",
            },
            { type: "script", script: "check.sh" },
            { type: "flag-accepted", flags: ["exec"] },
            { type: "harness-reports", report: "plugins" },
          ],
        },
        dir,
      );
      expect(r.errors).toEqual([]);
      expect(r.warnings.map((w) => w.path)).toEqual([
        "probes[1].file",
        "probes[2].script",
        "probes[3].flags[0]",
        "probes[4].report",
      ]);
      expect(r.probes[0]!.resolved).toEqual([path.join(dir, "present.json")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns about a transcript glob that uses characters matched literally", () => {
    const r = check(
      {
        harness: "claude",
        probes: [
          { type: "transcript-field", glob: "projects/?/{a,b}.jsonl", fields: ["type"] },
        ],
      },
      ".",
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.path)).toEqual(["probes[0].glob"]);
    expect(r.warnings[0]!.message).toContain("within one path segment");
  });
});

describe("locating positions in JSON", () => {
  it("records the line of keys and array elements, and keeps __proto__ as data", () => {
    const { value, lineOf } = parseLocated(
      '{\n  "a": [\n    1,\n    {"__proto__": 2}\n  ]\n}',
    );
    expect(lineOf("a")).toBe(2);
    expect(lineOf("a[1]")).toBe(4);
    expect(lineOf("a[1].__proto__")).toBe(4);
    const inner = (value as { a: unknown[] }).a[1] as Record<string, unknown>;
    expect(Object.keys(inner)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(inner)).toBe(Object.prototype);
  });
});

describe("a drafted manifest", () => {
  it("passes validate without errors", async () => {
    const { scanProject, draftManifest } = await import("../src/derive.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-draft-"));
    try {
      fs.mkdirSync(path.join(root, ".claude"));
      fs.writeFileSync(
        path.join(root, ".claude", "settings.json"),
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ command: "node hooks/notify.mjs" }] }] },
        }),
      );
      fs.writeFileSync(
        path.join(root, "run.sh"),
        "#!/bin/sh\nclaude -p --output-format json\n",
      );
      const draft = draftManifest(scanProject(root), "claude", "fixture");
      const r = validateManifestText(
        JSON.stringify(draft, null, 2),
        path.join(root, "peirad.json"),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.errors).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
