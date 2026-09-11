import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runManifest } from "../src/doctor.js";
import { runLive } from "../src/live.js";
import { resolveProfile } from "../src/harness-profiles.js";
import type { Manifest } from "../src/manifest.js";

// A scripted stand-in for a harness: it answers the login check, fires the
// hooks registered in the settings of whatever configuration directory it is
// pointed at, writes a transcript there, and reports usage — each behaviour
// switchable, so every live check can be made to hold or break.
const FAKE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), cp = require("child_process");
const args = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR;
if (args[0] === "--version") { console.log("9.9.9 (fake)"); process.exit(0); }
if (args[0] === "--help") { console.log("  -p, --print  --output-format <f>  --strict-mcp-config  --allowedTools <t>"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN === "1" }, null, 2)); process.exit(0); }
fs.appendFileSync(process.env.FAKE_TURN_LOG, JSON.stringify({ home, args }) + "\\n");
const reject = process.env.FAKE_REJECT_FLAG;
if (reject && args.includes(reject)) { console.error("error: unknown option '" + reject + "'"); process.exit(1); }
const file = path.join(home, "settings.json");
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const skip = (process.env.FAKE_SKIP_EVENTS || "").split(",");
const fire = (event) => {
  for (const group of (settings.hooks && settings.hooks[event]) || [])
    for (const h of group.hooks) cp.execSync(h.command, { input: JSON.stringify({ hook_event_name: event }) });
};
const events = ["SessionStart", "UserPromptSubmit"];
if (args.includes("--allowedTools")) events.push("PreToolUse", "PostToolUse");
events.push("Stop");
for (const e of events) if (!skip.includes(e)) fire(e);
if (process.env.FAKE_NO_TRANSCRIPT !== "1") {
  const t = path.join(home, "projects", "work", "session.jsonl");
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user" } }) + "\\n");
}
console.log(JSON.stringify({ result: "done", model: "fake-model", usage: { input_tokens: Number(process.env.FAKE_TOKENS || 120), output_tokens: 3 } }));
`;

let dir: string;
let harness: string;
let turnLog: string;

const manifest = (extra: object[] = []): Manifest =>
  ({
    harness,
    harnessProfile: "claude",
    probes: [
      { type: "hook-registered", event: "UserPromptSubmit", match: "x" },
      {
        type: "hook-registered",
        event: "PreToolUse",
        match: "x",
        critical: true,
      },
      {
        type: "transcript-field",
        glob: "projects/**/*.jsonl",
        fields: ["type", "message"],
      },
      { type: "flag-accepted", flags: ["-p", "--json-schema"] },
      ...extra,
    ],
  }) as Manifest;

const run = (fake: Record<string, string>, m = manifest(), ceiling = 10_000) =>
  runManifest(m, {
    configDir: dir,
    date: "2026-09-11",
    live: {
      ceiling,
      timeoutMs: 20_000,
      env: { ...process.env, FAKE_TURN_LOG: turnLog, ...fake },
    },
  });

const live = (v: ReturnType<typeof run>) =>
  Object.fromEntries(
    v.results
      .filter((r) => r.probe.startsWith("live"))
      .map((r) => [r.probe, r]),
  );

const turns = (): { home: string; args: string[] }[] =>
  fs.existsSync(turnLog)
    ? fs
        .readFileSync(turnLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-live-test-"));
  harness = path.join(dir, "fake-harness");
  fs.writeFileSync(harness, FAKE);
  fs.chmodSync(harness, 0o755);
  turnLog = path.join(dir, "turns.log");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the live turn", () => {
  it("refuses before any turn when no login resolves in the isolated directory", () => {
    fs.rmSync(turnLog, { force: true });
    const v = run({ FAKE_LOGGED_IN: "0" });
    const r = live(v);
    expect(Object.keys(r)).toEqual(["live:login"]);
    expect(r["live:login"]!.status).toBe("n/a");
    expect(r["live:login"]!.detail).toContain("nothing was spent");
    expect(r["live:login"]!.detail).toContain("never copies credentials");
    expect(v.live).toEqual({ turned: false, tokens: null });
    expect(turns()).toEqual([]);
  });

  it("runs one turn with fixture hooks for exactly the manifest's events and checks what it produced", () => {
    fs.rmSync(turnLog, { force: true });
    const v = run({ FAKE_LOGGED_IN: "1" });
    const r = live(v);
    expect(Object.keys(r)).toEqual([
      "live:login",
      "live:turn",
      "live:ceiling",
      "live:flags",
      "live:transcript-field(projects/**/*.jsonl)",
      "live:hook-fired(UserPromptSubmit)",
      "live:hook-fired(PreToolUse)",
    ]);
    for (const result of Object.values(r)) expect(result.status).toBe("pass");
    expect(r["live:turn"]!.detail).toContain(
      "the harness reported model fake-model (information, not checked)",
    );
    expect(r["live:ceiling"]!.detail).toBe(
      "123 tokens, within the ceiling of 10000",
    );
    expect(r["live:flags"]!.detail).toContain(
      "accepted by a real invocation: -p",
    );
    expect(r["live:flags"]!.detail).toContain(
      "only checked against --help: --json-schema",
    );
    // One turn; a tool event was declared, so the turn asked for a tool call.
    const [turn, ...more] = turns();
    expect(more).toEqual([]);
    expect(turn!.args).toContain("--allowedTools");
    expect(v.live).toEqual({ turned: true, tokens: 123 });
  });

  it("reports a declared hook that did not fire, in the register of its probe", () => {
    const v = run({ FAKE_LOGGED_IN: "1", FAKE_SKIP_EVENTS: "PreToolUse" });
    const r = live(v);
    expect(r["live:hook-fired(UserPromptSubmit)"]!.status).toBe("pass");
    expect(r["live:hook-fired(PreToolUse)"]!.status).toBe("blocked");
    expect(r["live:hook-fired(PreToolUse)"]!.detail).toContain(
      "did not run during a real turn",
    );
    expect(v.ok).toBe(false);
    expect(v.blocked).toBeGreaterThanOrEqual(1);
  });

  it("never installs the hooks from the user's own settings, and never touches them", () => {
    const own = path.join(dir, "own-config");
    fs.mkdirSync(own, { recursive: true });
    const stopMarker = path.join(dir, "own-stop-hook-ran");
    const ownSettings = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `touch '${stopMarker}'` }] },
        ],
      },
    });
    fs.writeFileSync(path.join(own, "settings.json"), ownSettings);
    fs.rmSync(turnLog, { force: true });
    const v = run({ FAKE_LOGGED_IN: "1", CLAUDE_CONFIG_DIR: own });
    expect(Object.keys(live(v))).not.toContain("live:hook-fired(Stop)");
    expect(fs.existsSync(stopMarker)).toBe(false);
    expect(fs.readFileSync(path.join(own, "settings.json"), "utf8")).toBe(
      ownSettings,
    );
    expect(turns()[0]!.home).not.toBe(own);
  });

  it("removes its isolated directory afterwards", () => {
    fs.rmSync(turnLog, { force: true });
    run({ FAKE_LOGGED_IN: "1" });
    const home = turns()[0]!.home;
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(path.dirname(home))).toBe(false);
  });

  it("compares the usage the harness reported with the ceiling", () => {
    const r = live(run({ FAKE_LOGGED_IN: "1", FAKE_TOKENS: "50000" }));
    expect(r["live:ceiling"]!.status).toBe("degraded");
    expect(r["live:ceiling"]!.detail).toBe(
      "50003 tokens, over the ceiling of 10000",
    );
  });

  it("names the flag a real invocation rejected", () => {
    const r = live(
      run({ FAKE_LOGGED_IN: "1", FAKE_REJECT_FLAG: "--strict-mcp-config" }),
    );
    expect(r["live:turn"]!.status).toBe("degraded");
    expect(r["live:turn"]!.detail).toContain(
      "unknown option '--strict-mcp-config'",
    );
  });

  it("reports a turn that wrote no transcript, in the register of the transcript probe", () => {
    const m = manifest();
    (m.probes[2] as { critical?: boolean }).critical = true;
    const r = live(run({ FAKE_LOGGED_IN: "1", FAKE_NO_TRANSCRIPT: "1" }, m));
    expect(r["live:transcript"]!.status).toBe("blocked");
    expect(r["live:transcript"]!.detail).toContain("wrote no transcript");
  });

  it("asks for no tool call when no tool event is declared", () => {
    fs.rmSync(turnLog, { force: true });
    run({ FAKE_LOGGED_IN: "1" }, {
      harness,
      harnessProfile: "claude",
      probes: [
        { type: "hook-registered", event: "UserPromptSubmit", match: "x" },
      ],
    } as Manifest);
    expect(turns()[0]!.args).not.toContain("--allowedTools");
  });

  it("is n/a for a profile that declares no live run", () => {
    const { live: _omit, ...bare } = resolveProfile("claude");
    const outcome = runLive(manifest(), { harness, configDir: dir }, bare, {
      ceiling: 1,
      timeoutMs: 1000,
    });
    expect(outcome.results).toEqual([
      {
        probe: "live",
        status: "n/a",
        detail: 'harness profile "claude" declares no live run',
      },
    ]);
    expect(outcome.turned).toBe(false);
  });

  it("adds nothing live unless asked", () => {
    const v = runManifest(manifest(), { configDir: dir, date: "2026-09-11" });
    expect(v.results.some((r) => r.probe.startsWith("live"))).toBe(false);
    expect(v.live).toBeUndefined();
  });
});
