import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  newestMatch,
  resolveBinary,
  runProbe,
  type ProbeContext,
} from "../src/probes.js";
import { expandGlob } from "../src/glob.js";
import {
  loadManifest,
  type Manifest,
  type ProbeSpec,
} from "../src/manifest.js";
import { runManifest } from "../src/doctor.js";

let dir: string;
const ctx = (): ProbeContext => ({ harness: "true", configDir: dir });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-test-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: "sh agent-guard.sh" }] }] },
    }),
  );
  fs.mkdirSync(path.join(dir, "projects", "a"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "projects", "a", "s.jsonl"),
    JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n",
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("config-key", () => {
  it("passes when the dotted key exists", () => {
    const r = runProbe(
      { type: "config-key", file: "settings.json", keys: ["hooks.PreToolUse"] },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
  });
  it("degrades when a key is missing (non-critical)", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "settings.json",
        keys: ["hooks.Nonexistent"],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
  });
  it("blocks when a critical key is missing", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "settings.json",
        keys: ["hooks.Nope"],
        critical: true,
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("blocked");
  });
});

describe("hook-registered", () => {
  it("finds a registered hook by match string", () => {
    const r = runProbe(
      {
        type: "hook-registered",
        file: "settings.json",
        event: "PreToolUse",
        match: "agent-guard",
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
  });
  it("degrades (critical → blocks) when the hook is gone", () => {
    const r = runProbe(
      {
        type: "hook-registered",
        file: "settings.json",
        event: "PreToolUse",
        match: "missing-guard",
        critical: true,
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("blocked");
  });
});

describe("transcript-field", () => {
  it("passes when declared fields exist on the first record", () => {
    const r = runProbe(
      {
        type: "transcript-field",
        glob: "projects/**/*.jsonl",
        fields: ["type", "message"],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
  });
  it("degrades on schema drift (a field vanished)", () => {
    const r = runProbe(
      {
        type: "transcript-field",
        glob: "projects/**/*.jsonl",
        fields: ["type", "removed_field"],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
  });

  // Two transcripts where the alphabetically-first, OLDER file lacks a
  // declared field and the alphabetically-later, NEWER file has it: the probe
  // must sample by mtime (the file the current build wrote), not by name.
  const writeTranscript = (
    name: string,
    fields: Record<string, unknown>,
    mtime: Date,
  ): void => {
    fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });
    const p = path.join(dir, "transcripts", name);
    fs.writeFileSync(p, JSON.stringify(fields) + "\n");
    fs.utimesSync(p, mtime, mtime);
  };
  const OLD = new Date("2026-01-01T00:00:00Z");
  const NEW = new Date("2026-06-01T00:00:00Z");

  it("samples the newest transcript, not the first in name order", () => {
    writeTranscript("a-first.jsonl", { type: "user" }, OLD);
    writeTranscript(
      "z-second.jsonl",
      { type: "user", message: { role: "x" } },
      NEW,
    );
    const r = runProbe(
      {
        type: "transcript-field",
        glob: "transcripts/**/*.jsonl",
        fields: ["type", "message"],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("z-second.jsonl");
    expect(r.detail).toContain("2026-06-01");
  });

  it("reports drift when the NEWEST transcript lacks the field", () => {
    writeTranscript(
      "a-first.jsonl",
      { type: "user", message: { role: "x" } },
      OLD,
    );
    writeTranscript("z-second.jsonl", { type: "user" }, NEW);
    const r = runProbe(
      {
        type: "transcript-field",
        glob: "transcripts/**/*.jsonl",
        fields: ["type", "message"],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("z-second.jsonl");
    expect(r.detail).toContain("2026-06-01");
  });
});

// Every wildcard shape a glob may use, against one tree: a stray file one
// level too shallow, the intended file one level deeper, and a top-level
// file. A `*` in a middle segment must match exactly that segment — matching
// the stray instead would assert fields against the wrong file entirely.
describe("glob shapes", () => {
  let tree: string;
  const OLD = new Date("2026-01-01T00:00:00Z");
  const NEW = new Date("2026-06-01T00:00:00Z");
  const found = (pattern: string): string | null => {
    const m = newestMatch(tree, pattern);
    return m ? path.relative(tree, m.file).split(path.sep).join("/") : null;
  };

  beforeAll(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-glob-"));
    fs.mkdirSync(path.join(tree, "a", "sub"), { recursive: true });
    for (const rel of ["top.jsonl", "a/stray.jsonl", "a/sub/b.jsonl"]) {
      fs.writeFileSync(path.join(tree, ...rel.split("/")), "{}\n");
      fs.utimesSync(
        path.join(tree, ...rel.split("/")),
        rel === "a/sub/b.jsonl" ? NEW : OLD,
        rel === "a/sub/b.jsonl" ? NEW : OLD,
      );
    }
  });
  afterAll(() => fs.rmSync(tree, { recursive: true, force: true }));

  it("*.jsonl matches the top level only", () => {
    expect(found("*.jsonl")).toBe("top.jsonl");
  });

  it("a/*/b.jsonl matches one level deep, never the stray beside it", () => {
    expect(found("a/*/b.jsonl")).toBe("a/sub/b.jsonl");
  });

  it("a/*.jsonl matches one level deep, never the file below it", () => {
    expect(found("a/*.jsonl")).toBe("a/stray.jsonl");
  });

  it("a/*/*.jsonl needs two segments after a", () => {
    expect(found("a/*/*.jsonl")).toBe("a/sub/b.jsonl");
  });

  it("a/**/*.jsonl crosses any depth, sampling the newest", () => {
    expect(found("a/**/*.jsonl")).toBe("a/sub/b.jsonl");
  });

  it("returns null when the middle segment has no match", () => {
    expect(found("a/*/c.jsonl")).toBeNull();
  });

  it("expands {home} and {configDir} templates, and walks an absolute glob", () => {
    // Synthetic roots, so no test names a real directory layout.
    expect(
      expandGlob("{home}/.claude/projects/**/*.jsonl", {
        home: "/h",
        configDir: "/p",
      }),
    ).toBe("/h/.claude/projects/**/*.jsonl");
    expect(
      expandGlob("{configDir}/a/*.jsonl", {
        home: "/h",
        configDir: "/p",
      }),
    ).toBe("/p/a/*.jsonl");
    // An absolute pattern — with or without a template behind it — matches the
    // whole path from the filesystem root.
    const abs = newestMatch(tree, path.join(tree, "a", "**", "*.jsonl"));
    expect(abs).not.toBeNull();
    expect(path.relative(tree, abs!.file)).toBe(
      path.join("a", "sub", "b.jsonl"),
    );
    const templated = newestMatch(tree, "{configDir}/a/sub/*.jsonl");
    expect(path.relative(tree, templated!.file)).toBe(
      path.join("a", "sub", "b.jsonl"),
    );
  });
});

describe("script", () => {
  const write = (name: string, body: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
    return p;
  };
  it("exit 0 passes and surfaces the script's stdout", () => {
    write("ok.sh", '#!/bin/sh\necho "still holds"\nexit 0\n');
    const r = runProbe({ type: "script", script: "ok.sh" }, ctx(), []);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("still holds");
  });
  it("exit 1 fails with stdout as the finding (critical → blocked)", () => {
    write("bad.sh", '#!/bin/sh\necho "CHECK FAILS — thing drifted"\nexit 1\n');
    expect(
      runProbe({ type: "script", script: "bad.sh" }, ctx(), []).status,
    ).toBe("degraded");
    const r = runProbe(
      { type: "script", script: "bad.sh", critical: true },
      ctx(),
      [],
    );
    expect(r.status).toBe("blocked");
    expect(r.detail).toContain("CHECK FAILS — thing drifted");
  });
  it("exit 2 is n/a — even when critical (fails open)", () => {
    write("na.sh", '#!/bin/sh\necho "probe error: no verdict"\nexit 2\n');
    const r = runProbe(
      { type: "script", script: "na.sh", critical: true },
      ctx(),
      [],
    );
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain("probe error: no verdict");
  });
  it("passes args through and names them in the probe label", () => {
    write("echo.sh", '#!/bin/sh\necho "arg: $1"\nexit 0\n');
    const r = runProbe(
      { type: "script", script: "echo.sh", args: ["quick"] },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.probe).toBe("script(echo.sh quick)");
    expect(r.detail).toContain("arg: quick");
  });
  it("a missing script is n/a, not a verdict", () => {
    const r = runProbe({ type: "script", script: "nope.sh" }, ctx(), []);
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain("script not found");
  });
  it("a timeout kills the script into the n/a register", () => {
    write("slow.sh", "#!/bin/sh\nsleep 5\n");
    const r = runProbe(
      { type: "script", script: "slow.sh", timeoutMs: 500 },
      ctx(),
      [],
    );
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain("killed");
  });
});

describe("loadManifest", () => {
  it("rejects a manifest without harness/probes", () => {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ probes: [] }));
    expect(() => loadManifest(bad)).toThrow();
  });
  it("rejects non-array promptArgs/outputArgs", () => {
    const bad = path.join(dir, "bad-args.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({ harness: "x", promptArgs: "-p", probes: [] }),
    );
    expect(() => loadManifest(bad)).toThrow(/promptArgs/);
  });
  it("rejects a probe without a string type", () => {
    const bad = path.join(dir, "bad-probe.json");
    fs.writeFileSync(bad, JSON.stringify({ harness: "x", probes: [{}] }));
    expect(() => loadManifest(bad)).toThrow(/probes\[0\]/);
  });
});

describe("unknown probe type", () => {
  it("declares n/a naming the type and the engine version — never a crash", () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const r = runProbe({ type: "bogus-probe" } as never, ctx(), []);
    expect(r.status).toBe("n/a");
    expect(r.probe).toBe("bogus-probe");
    expect(r.detail).toContain("bogus-probe");
    expect(r.detail).toContain(pkg.version);
    expect(r.detail).toContain("upgrade peirad");
  });
});

describe("runManifest", () => {
  it("returns ok with na=1 over a manifest holding one unknown probe type", () => {
    const v = runManifest(
      {
        harness: "true",
        probes: [{ type: "bogus-probe" }, { type: "command-exists" }] as never,
      },
      { date: "2026-09-11" },
    );
    expect(v.ok).toBe(true);
    expect(v.na).toBe(1);
    expect(v.results).toHaveLength(2);
  });

  it("names the checker's own version in the verdict", () => {
    // Attribution: a wiring that tracks the newest published release learns
    // which build spoke only from the verdict itself.
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const v = runManifest(
      { harness: "true", probes: [{ type: "command-exists" }] },
      { date: "2026-09-11" },
    );
    expect(v.checker).toBe(pkg.version);
  });

  it("carries the resolved binary path in the verdict and the detail", () => {
    // `sh` is an on-disk binary everywhere; `true` would resolve to a shell
    // builtin, which `command -v` reports by name, not by path.
    const v = runManifest(
      { harness: "sh", probes: [{ type: "command-exists" }] },
      { date: "2026-09-11" },
    );
    expect(typeof v.path).toBe("string");
    expect(v.path).toMatch(/\/sh$/);
    const ce = v.results.find((r) => r.probe === "command-exists(sh)");
    expect(ce?.status).toBe("pass");
    expect(ce?.detail).toContain(`is on PATH (${v.path})`);
  });
});

describe("profile applicability", () => {
  // D-009: applicability follows the file shape, not the harness name. Codex
  // keeps hooks in a JSON file of the same `hooks.<Event>[].hooks[].command`
  // shape, so the settings probes apply to it — a manifest names that file.
  it("config-key applies under the codex profile against its hooks JSON", () => {
    fs.writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ command: "sh ask-guard.sh" }] }] },
      }),
    );
    const r = runProbe(
      { type: "config-key", file: "hooks.json", keys: ["hooks.PreToolUse"] },
      { ...ctx(), profileName: "codex" },
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.probe).toBe("config-key(hooks.json)");
  });

  it("hook-registered finds a codex hook in that file", () => {
    const r = runProbe(
      {
        type: "hook-registered",
        file: "hooks.json",
        event: "PreToolUse",
        match: "ask-guard",
      },
      { ...ctx(), profileName: "codex" },
      [],
    );
    expect(r.status).toBe("pass");
  });

  it("a settings file the codex install lacks is drift, not n/a", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "no-such-settings.json",
        keys: ["hooks.PreToolUse"],
      },
      { ...ctx(), profileName: "codex" },
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("file not found");
  });

  it("keeps config-key passing under the default (claude) profile", () => {
    const r = runProbe(
      { type: "config-key", file: "settings.json", keys: ["hooks.PreToolUse"] },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
  });
});

describe("flag-accepted help routing", () => {
  let cli: string;
  beforeAll(() => {
    cli = path.join(dir, "subcommand-cli.sh");
    // Help only exists under the subcommand, like `codex exec --help`.
    fs.writeFileSync(
      cli,
      [
        "#!/bin/sh",
        'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then',
        '  echo "  --json   print events as JSONL"',
        '  echo "  -o, --output-last-message FILE"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    fs.chmodSync(cli, 0o755);
  });

  it("checks a subcommand's help when the profile says so", () => {
    const r = runProbe(
      { type: "flag-accepted", flags: ["--json", "--output-last-message"] },
      { harness: cli, configDir: dir, profileName: "codex" },
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("all flags present");
  });

  it("still checks root --help under the default profile", () => {
    const r = runProbe(
      { type: "flag-accepted", flags: ["--json"] },
      { harness: cli, configDir: dir },
      [],
    );
    // Root --help fails on this fake, so the flags are not found: drift,
    // not a silent pass.
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("not in --help: --json");
  });
});

describe("flag-accepted whole-token matching", () => {
  let cli: string;
  beforeAll(() => {
    cli = path.join(dir, "flaggy-cli.sh");
    fs.writeFileSync(
      cli,
      [
        "#!/bin/sh",
        'if [ "$1" = "--help" ]; then',
        '  echo "  --allowedTools <tools...>"',
        '  echo "  -p, --print"',
        '  echo "  --output-format=json"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    fs.chmodSync(cli, 0o755);
  });
  const probe = (flags: string[]) =>
    runProbe(
      { type: "flag-accepted", flags },
      { harness: cli, configDir: dir },
      [],
    );

  it("a substring of a longer flag does not pass", () => {
    expect(probe(["--allowedTools"]).status).toBe("pass");
    const sub = probe(["--allowed"]);
    expect(sub.status).toBe("degraded");
    expect(sub.detail).toContain("not in --help: --allowed");
  });
  it("a short flag beside its long form matches exactly", () => {
    expect(probe(["-p"]).status).toBe("pass");
    expect(probe(["-x"]).status).toBe("degraded");
  });
  it("a flag written --output-format=json still matches --output-format", () => {
    expect(probe(["--output-format"]).status).toBe("pass");
  });
});

describe("config-key: expected values", () => {
  let cfg: string;
  beforeAll(() => {
    cfg = path.join(dir, "values.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        voice: { enabled: true, enable: false },
        permissions: { defaultMode: "acceptEdits", allow: ["Bash", "Read"] },
        limits: { maxTokens: 4096 },
      }),
    );
  });

  it("passes when every declared value matches", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "values.json",
        expect: {
          "voice.enabled": true,
          "permissions.defaultMode": "acceptEdits",
        },
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("values match");
  });

  it("degrades naming the value it found and the one declared", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "values.json",
        expect: { "voice.enabled": false },
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("voice.enabled is true (expected false)");
  });

  it("reports an expected key that is not there at all", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "values.json",
        expect: { "voice.volume": 3 },
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("voice.volume is absent (expected 3)");
  });

  it("compares arrays and objects deeply, not by identity", () => {
    const match = runProbe(
      {
        type: "config-key",
        file: "values.json",
        expect: { "permissions.allow": ["Bash", "Read"] },
      },
      ctx(),
      [],
    );
    expect(match.status).toBe("pass");
    const reordered = runProbe(
      {
        type: "config-key",
        file: "values.json",
        expect: { "permissions.allow": ["Read", "Bash"] },
      },
      ctx(),
      [],
    );
    expect(reordered.status).toBe("degraded");
  });

  it("blocks on a wrong value when the probe is critical", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "values.json",
        expect: { "limits.maxTokens": 8192 },
        critical: true,
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("blocked");
  });
});

describe("config-key: names that must be absent", () => {
  it("passes when the declared name is gone", () => {
    const r = runProbe(
      { type: "config-key", file: "values.json", absent: ["voice.legacyMode"] },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("absent as declared");
  });

  it("reports the leftover twin of a renamed key, with the value it still holds", () => {
    const r = runProbe(
      { type: "config-key", file: "values.json", absent: ["voice.enable"] },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain(
      "declared absent but present: voice.enable = false",
    );
  });

  it("names a wrong value and a leftover key in the same verdict", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "values.json",
        keys: ["limits.maxTokens"],
        expect: { "voice.enabled": false },
        absent: ["voice.enable"],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("voice.enabled is true");
    expect(r.detail).toContain("voice.enable = false");
  });

  it("is n/a when the probe declares nothing to assert", () => {
    const r = runProbe({ type: "config-key", file: "values.json" }, ctx(), []);
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain("nothing declared");
  });
});

describe("command-exists: helper programs", () => {
  it("checks a declared helper program instead of the harness", () => {
    const r = runProbe({ type: "command-exists", command: "sh" }, ctx(), []);
    expect(r.status).toBe("pass");
    expect(r.probe).toBe("command-exists(sh)");
  });

  it("names a missing helper as a helper, not as the harness", () => {
    const r = runProbe(
      { type: "command-exists", command: "peirad-no-such-helper" },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("declared as a helper program");
  });

  it("still checks the harness itself when no helper is named", () => {
    const r = runProbe({ type: "command-exists" }, ctx(), []);
    expect(r.probe).toBe("command-exists(true)");
    expect(r.status).toBe("pass");
  });

  // A manifest is trusted local input, but a harness string that names no
  // executable must never read as installed — and must never be evaluated as
  // command syntax on the way to finding out.
  it("reports drift for shell metacharacters in a harness name, and runs nothing", () => {
    const r = runProbe(
      { type: "command-exists", critical: true },
      { harness: "true; echo PEIRAD_INJECTION_MARKER", configDir: dir },
      [],
    );
    expect(r.status).toBe("blocked");
    expect(r.detail).toContain("not found on PATH");
    // Under the old shell lookup this string "resolved" to the injected
    // command's own output; resolveBinary must return null for it instead.
    expect(resolveBinary("true; echo PEIRAD_INJECTION_MARKER")).toBeNull();
  });
});

describe("resolveBinary", () => {
  it("resolves a bare name along PATH, without a shell", () => {
    const p = resolveBinary("sh");
    expect(p).not.toBeNull();
    expect(path.isAbsolute(p!)).toBe(true);
    expect(resolveBinary("peirad-no-such-harness")).toBeNull();
  });

  it("resolves an absolute path directly", () => {
    expect(resolveBinary(process.execPath)).toBe(process.execPath);
  });

  it("never evaluates the harness string as command syntax", () => {
    expect(resolveBinary("true; echo PEIRAD_INJECTION_MARKER")).toBeNull();
    expect(resolveBinary("$(touch pwned)")).toBeNull();
  });
});

describe("fields a build does not understand", () => {
  const withUnknown = (extra: Record<string, unknown>): ProbeSpec =>
    ({
      type: "config-key",
      file: "settings.json",
      keys: ["hooks.PreToolUse"],
      ...extra,
    }) as unknown as ProbeSpec;

  it("degrades a pass that skipped a declared assertion, naming the field", () => {
    const r = runProbe(withUnknown({ mustEqual: { a: 1 } }), ctx(), []);
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("1 declared assertion skipped");
    expect(r.detail).toContain("mustEqual");
    expect(r.detail).toContain("upgrade peirad");
  });

  it("never turns a skipped assertion into a block, however critical the probe", () => {
    const r = runProbe(
      withUnknown({ mustEqual: { a: 1 }, critical: true }),
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
  });

  it("keeps a real failure's own register and still names the skipped field", () => {
    const r = runProbe(
      {
        type: "config-key",
        file: "settings.json",
        keys: ["hooks.Nope"],
        critical: true,
        mustEqual: {},
      } as unknown as ProbeSpec,
      ctx(),
      [],
    );
    expect(r.status).toBe("blocked");
    expect(r.detail).toContain("missing keys");
    expect(r.detail).toContain("mustEqual");
  });

  it("treats an underscore key as a comment, never as a skipped assertion", () => {
    const r = runProbe(
      withUnknown({ _note: "why this probe exists" }),
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).not.toContain("skipped");
  });

  it("says nothing extra about a probe type it does not know at all", () => {
    const r = runProbe(
      { type: "future-probe", someField: 1 } as unknown as ProbeSpec,
      ctx(),
      [],
    );
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain('unknown probe type "future-probe"');
    expect(r.detail).not.toContain("someField");
  });

  it("notes a manifest key it ignores without changing the verdict", () => {
    const v = runManifest(
      {
        harness: "true",
        probes: [{ type: "command-exists" }],
        futureSetting: "on",
      } as unknown as Manifest,
      { configDir: dir, date: "2026-09-11" },
    );
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("futureSetting");
    expect(v.notes.join(" ")).toContain("upgrade peirad");
  });
});
