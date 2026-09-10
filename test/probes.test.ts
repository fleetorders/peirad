import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runProbe, type ProbeContext } from "../src/probes.js";
import { loadManifest } from "../src/manifest.js";
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
