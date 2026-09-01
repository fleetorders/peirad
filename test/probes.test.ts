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
