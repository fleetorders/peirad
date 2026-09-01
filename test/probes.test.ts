import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runProbe, type ProbeContext } from "../src/probes.js";
import { loadManifest } from "../src/manifest.js";

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
});

describe("profile applicability", () => {
  it("declares config-key n/a for the codex profile, never a pass", () => {
    const r = runProbe(
      { type: "config-key", file: "settings.json", keys: ["hooks.PreToolUse"] },
      { ...ctx(), profileName: "codex" },
      [],
    );
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain('profile "codex"');
    expect(r.probe).toBe("config-key(settings.json)");
  });

  it("declares hook-registered n/a for the codex profile", () => {
    const r = runProbe(
      {
        type: "hook-registered",
        file: "settings.json",
        event: "PreToolUse",
        match: "agent-guard",
      },
      { ...ctx(), profileName: "codex" },
      [],
    );
    expect(r.status).toBe("n/a");
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
