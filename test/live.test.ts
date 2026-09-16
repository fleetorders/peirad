import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runManifest } from "../src/doctor.js";
import { runLive, sessionIdFrom, findSessionTranscript } from "../src/live.js";
import { resolveProfile } from "../src/harness-profiles.js";
import type { Manifest } from "../src/manifest.js";

// Scripted stand-ins for both harness families. Each answers the login check,
// fires the hooks it was handed for this invocation, writes a transcript into
// whatever configuration directory its variable names, and reports usage —
// every behaviour switchable, so each live check can be made to hold or break.
const CLAUDE_LIKE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), cp = require("child_process");
const args = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR;
const log = (o) => fs.appendFileSync(process.env.FAKE_TURN_LOG, JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("9.9.9 (fake)"); process.exit(0); }
if (args[0] === "--help") { console.log("  -p, --print  --output-format <f>  --restricted  --settings <s>  --strict-mcp-config  --tools <t>  --allowedTools <t>"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN === "1" }, null, 2)); process.exit(0); }
log({ args, cwd: process.cwd() });
const reject = process.env.FAKE_REJECT_FLAG;
if (reject && args.includes(reject)) { console.error("error: unknown option '" + reject + "'"); process.exit(1); }
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const hooks = {};
const load = (file) => {
  if (!file || !fs.existsSync(file)) return;
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [e, g] of Object.entries(s.hooks || {})) (hooks[e] = hooks[e] || []).push(...g);
};
if (!args.includes("--restricted")) load(path.join(home, "settings.json"));
load(at("--settings"));
const skip = (process.env.FAKE_SKIP_EVENTS || "").split(",");
const fire = (e) => { for (const g of hooks[e] || []) for (const h of g.hooks) cp.execSync(h.command, { input: JSON.stringify({ hook_event_name: e }) }); };
const events = ["SessionStart", "UserPromptSubmit"];
if ((at("--tools") || "").includes("Bash")) events.push("PreToolUse", "PostToolUse");
events.push("Stop");
for (const e of events) if (!skip.includes(e)) fire(e);
const sid = process.env.FAKE_SESSION_ID || "11111111-2222-3333-4444-555555555555";
if (process.env.FAKE_NO_TRANSCRIPT !== "1") {
  const folder = path.join(home, "projects", process.env.FAKE_PROJECT_NAME || process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, sid + ".jsonl"), JSON.stringify({ type: "user", message: { role: "user" }, sessionId: sid }) + "\\n");
  if (process.env.FAKE_EXTRA_FILE === "1") fs.writeFileSync(path.join(folder, "memory.md"), "kept");
}
console.log(JSON.stringify({ type: "result", result: "done", session_id: sid, usage: { input_tokens: Number(process.env.FAKE_TOKENS || 120), output_tokens: 3 } }));
`;

const CODEX_LIKE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), cp = require("child_process");
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const log = (o) => fs.appendFileSync(process.env.FAKE_TURN_LOG, JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (args[0] === "login") { console.log(process.env.FAKE_LOGGED_IN === "1" ? "Logged in using ChatGPT" : "Not logged in"); process.exit(0); }
if (args[0] === "delete") {
  if (!args.includes("--force")) { console.error("Error: cannot confirm session deletion without an interactive terminal"); process.exit(1); }
  const id = args[args.length - 1];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes(id)) fs.rmSync(p); } };
  walk(path.join(home, "sessions"));
  log({ deleted: id });
  process.exit(0);
}
log({ args });
const ci = args.indexOf("-c");
const toml = ci >= 0 ? args[ci + 1] : "";
const hooks = {};
for (const m of toml.matchAll(/(\\w+)=\\[\\{(?:matcher="[^"]*",)?hooks=\\[\\{type="command",command="((?:[^"\\\\]|\\\\.)*)"\\}\\]\\}\\]/g)) hooks[m[1]] = m[2].replace(/\\\\(.)/g, "$1");
const trusted = args.includes("--dangerously-bypass-hook-trust");
for (const e of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) if (trusted && hooks[e]) cp.execSync(hooks[e], { input: "{}" });
const id = process.env.FAKE_SESSION_ID || "01a08f55-b91b-7993-8d57-b873c3aeabc7";
const file = path.join(home, "sessions", "2026", "09", "11", "rollout-2026-09-11T10-00-00-" + id + ".jsonl");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id } }) + "\\n");
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: "thread.started", thread_id: id });
ev({ type: "item.completed", item: { type: "agent_message", text: "done" } });
ev({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 10 } });
`;

let dir: string;
let claude: string;
let codex: string;
let home: string;
let codexHome: string;
let turnLog: string;

const claudeManifest = (): Manifest =>
  ({
    harness: claude,
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
    ],
  }) as Manifest;

const run = (
  fake: Record<string, string>,
  m: Manifest = claudeManifest(),
  ceiling = 100_000,
) =>
  runManifest(m, {
    configDir: dir,
    date: "2026-09-11",
    live: {
      ceiling,
      timeoutMs: 20_000,
      env: {
        ...process.env,
        FAKE_TURN_LOG: turnLog,
        CLAUDE_CONFIG_DIR: home,
        CODEX_HOME: codexHome,
        ...fake,
      },
    },
  });

const live = (v: ReturnType<typeof run>) =>
  Object.fromEntries(
    v.results
      .filter((r) => r.probe.startsWith("live"))
      .map((r) => [r.probe, r]),
  );

const log = (): Record<string, unknown>[] =>
  fs.existsSync(turnLog)
    ? fs
        .readFileSync(turnLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const sessionFiles = (base: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(base, p));
    }
  };
  walk(base);
  return out.sort();
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-live-test-"));
  claude = path.join(dir, "claude-like");
  codex = path.join(dir, "codex-like");
  fs.writeFileSync(claude, CLAUDE_LIKE);
  fs.writeFileSync(codex, CODEX_LIKE);
  fs.chmodSync(claude, 0o755);
  fs.chmodSync(codex, 0o755);
  home = path.join(dir, "claude-home");
  codexHome = path.join(dir, "codex-home");
  fs.mkdirSync(home);
  fs.mkdirSync(codexHome);
  turnLog = path.join(dir, "turns.log");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the live turn on the harness's own configuration", () => {
  it("refuses before any turn when the harness is not signed in", () => {
    fs.rmSync(turnLog, { force: true });
    const v = run({ FAKE_LOGGED_IN: "0" });
    expect(Object.keys(live(v))).toEqual(["live:login"]);
    expect(live(v)["live:login"]!.status).toBe("n/a");
    expect(live(v)["live:login"]!.detail).toContain("nothing was spent");
    expect(v.live).toEqual({ turned: false, tokens: null });
    expect(log()).toEqual([]);
  });

  it("runs one turn with overlay hooks for the manifest's events, checks it, and removes exactly its session", () => {
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
      "live:cleanup",
    ]);
    for (const result of Object.values(r)) expect(result.status).toBe("pass");
    const args = log()[0]!.args as string[];
    for (const flag of [
      "--restricted",
      "--strict-mcp-config",
      "--settings",
      "--tools",
      "--allowedTools",
    ]) {
      expect(args).toContain(flag);
    }
    expect(r["live:ceiling"]!.detail).toBe(
      "123 tokens, within the ceiling of 100000",
    );
    expect(r["live:flags"]!.detail).toContain(
      "accepted by a real invocation: -p",
    );
    expect(r["live:cleanup"]!.detail).toContain(
      "removed the turn's transcript",
    );
    expect(r["live:cleanup"]!.detail).toContain("now-empty folder");
    expect(sessionFiles(home)).toEqual([]);
    expect(v.live).toEqual({ turned: true, tokens: 123 });
  });

  it("sets the user's own settings aside and never touches the rest of their directory", () => {
    const stopMarker = path.join(dir, "own-stop-hook-ran");
    const own = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `touch '${stopMarker}'` }] },
        ],
      },
    });
    fs.writeFileSync(path.join(home, "settings.json"), own);
    fs.mkdirSync(path.join(home, "projects", "another-project"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, "projects", "another-project", "keep.jsonl"),
      "{}\n",
    );
    try {
      run({ FAKE_LOGGED_IN: "1" });
      expect(fs.existsSync(stopMarker)).toBe(false);
      expect(fs.readFileSync(path.join(home, "settings.json"), "utf8")).toBe(
        own,
      );
      expect(sessionFiles(home)).toEqual([
        path.join("projects", "another-project", "keep.jsonl"),
        "settings.json",
      ]);
    } finally {
      fs.rmSync(path.join(home, "settings.json"), { force: true });
      fs.rmSync(path.join(home, "projects"), { recursive: true, force: true });
    }
  });

  it("keeps a folder that still holds something else", () => {
    const r = live(run({ FAKE_LOGGED_IN: "1", FAKE_EXTRA_FILE: "1" }));
    expect(r["live:cleanup"]!.status).toBe("pass");
    expect(r["live:cleanup"]!.detail).not.toContain("now-empty folder");
    const left = sessionFiles(home);
    expect(left).toHaveLength(1);
    expect(left[0]!.endsWith("memory.md")).toBe(true);
    fs.rmSync(path.join(home, "projects"), { recursive: true, force: true });
  });

  it("never removes a conversation that existed before the turn (a resumed session)", () => {
    const sid = "33333333-4444-5555-6666-777777777777";
    // The session's transcript is already there when the turn begins — as it
    // is when a manifest's promptArgs resume an existing conversation. The
    // turn rewrites that same file, so freshness alone cannot tell a session
    // this invocation created from one it merely continued.
    const folder = path.join(home, "projects", "resumed");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${sid}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "user", sessionId: sid }) + "\n",
    );
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(file, old, old);
    try {
      const r = live(
        run({
          FAKE_LOGGED_IN: "1",
          FAKE_SESSION_ID: sid,
          FAKE_PROJECT_NAME: "resumed",
        }),
      );
      expect(r["live:cleanup"]!.status).toBe("n/a");
      expect(r["live:cleanup"]!.detail).toContain(
        "already existed when the turn began",
      );
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(path.join(home, "projects"), { recursive: true, force: true });
    }
  });

  it("reports a declared hook that did not fire, in the register of its probe", () => {
    const v = run({ FAKE_LOGGED_IN: "1", FAKE_SKIP_EVENTS: "PreToolUse" });
    expect(live(v)["live:hook-fired(PreToolUse)"]!.status).toBe("blocked");
    expect(live(v)["live:hook-fired(UserPromptSubmit)"]!.status).toBe("pass");
    expect(v.ok).toBe(false);
  });

  it("compares reported usage with the ceiling", () => {
    const r = live(
      run(
        { FAKE_LOGGED_IN: "1", FAKE_TOKENS: "50000" },
        claudeManifest(),
        10_000,
      ),
    );
    expect(r["live:ceiling"]!.status).toBe("degraded");
    expect(r["live:ceiling"]!.detail).toBe(
      "50003 tokens, over the ceiling of 10000",
    );
  });

  it("names a flag a real invocation rejected, and removes nothing", () => {
    const r = live(
      run({ FAKE_LOGGED_IN: "1", FAKE_REJECT_FLAG: "--restricted" }),
    );
    expect(r["live:turn"]!.status).toBe("degraded");
    expect(r["live:turn"]!.detail).toContain("unknown option '--restricted'");
    expect(r["live:cleanup"]!.status).toBe("n/a");
    expect(r["live:cleanup"]!.detail).toContain("nothing removed");
  });

  it("reports a turn that wrote no transcript, and has nothing to remove", () => {
    const m = claudeManifest();
    (m.probes[2] as { critical?: boolean }).critical = true;
    const r = live(run({ FAKE_LOGGED_IN: "1", FAKE_NO_TRANSCRIPT: "1" }, m));
    expect(r["live:transcript"]!.status).toBe("blocked");
    expect(r["live:cleanup"]!.detail).toContain("nothing to remove");
  });

  it("never uses a session id that does not look like one to find or remove anything", () => {
    const r = live(
      run({ FAKE_LOGGED_IN: "1", FAKE_SESSION_ID: "../../escape" }),
    );
    expect(r["live:transcript"]!.detail).toContain("reported no session id");
    expect(r["live:cleanup"]!.detail).toContain("nothing removed");
    expect(sessionFiles(home).some((f) => f.includes("escape"))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
  });

  it("removes its own temporary working directory", () => {
    fs.rmSync(turnLog, { force: true });
    run({ FAKE_LOGGED_IN: "1" });
    expect(fs.existsSync(log()[0]!.cwd as string)).toBe(false);
  });

  it("asks for no tool call when no tool event is declared", () => {
    fs.rmSync(turnLog, { force: true });
    run({ FAKE_LOGGED_IN: "1" }, {
      harness: claude,
      harnessProfile: "claude",
      probes: [
        { type: "hook-registered", event: "UserPromptSubmit", match: "x" },
      ],
    } as Manifest);
    expect(log()[0]!.args as string[]).not.toContain("--tools");
  });

  it("resolves a relative harness path before changing directories", () => {
    // The live run works from a temporary directory; a harness named relative
    // to where peirad was started must be made absolute first, or the login
    // check dies of ENOENT and reports a harness that is signed in as not.
    const rel = path.relative(process.cwd(), claude);
    fs.rmSync(turnLog, { force: true });
    const outcome = runLive(
      claudeManifest(),
      { harness: rel, configDir: dir },
      resolveProfile("claude"),
      {
        ceiling: 100_000,
        timeoutMs: 20_000,
        env: {
          ...process.env,
          FAKE_TURN_LOG: turnLog,
          CLAUDE_CONFIG_DIR: home,
          FAKE_LOGGED_IN: "1",
        },
      },
    );
    const r = Object.fromEntries(
      outcome.results
        .filter((x) => x.probe.startsWith("live"))
        .map((x) => [x.probe, x]),
    );
    expect(r["live:login"]!.status).toBe("pass");
    expect(r["live:turn"]!.status).toBe("pass");
    fs.rmSync(path.join(home, "projects"), { recursive: true, force: true });
  });

  it("reports an event no scenario can trigger as unchecked, not drift", () => {
    // PreCompact fires on an action the fixture never requests, so a fixture
    // hook on it not running says nothing about the integration; Stop fires
    // on every plain turn, so its hook not running still reads as drift.
    const v = run({ FAKE_LOGGED_IN: "1" }, {
      harness: claude,
      harnessProfile: "claude",
      probes: [
        { type: "hook-registered", event: "PreCompact", match: "x" },
        { type: "hook-registered", event: "Stop", match: "x", critical: true },
      ],
    } as Manifest);
    const r = live(v);
    expect(r["live:hook-fired(PreCompact)"]!.status).toBe("n/a");
    expect(r["live:hook-fired(PreCompact)"]!.detail).toContain(
      "no scenario this run drives",
    );
    expect(r["live:hook-fired(Stop)"]!.status).toBe("pass");
    expect(v.results.some((x) => x.status === "blocked")).toBe(false);
  });
});

describe("a harness that takes hooks as a config override and deletes its own sessions", () => {
  const manifest = (): Manifest =>
    ({
      harness: codex,
      harnessProfile: "codex",
      probes: [
        {
          type: "hook-registered",
          event: "UserPromptSubmit",
          match: "x",
          file: "none.json",
        },
        {
          type: "hook-registered",
          event: "PreToolUse",
          match: "x",
          file: "none.json",
        },
      ],
    }) as Manifest;

  it("fires overlay hooks, finds the session by its event, and removes it with the harness's delete", () => {
    fs.mkdirSync(path.join(codexHome, "sessions", "2026", "09", "10"), {
      recursive: true,
    });
    const other = path.join(
      codexHome,
      "sessions",
      "2026",
      "09",
      "10",
      "rollout-2026-09-10T09-00-00-aaaaaaaa-0000-0000-0000-000000000000.jsonl",
    );
    fs.writeFileSync(other, "{}\n");
    fs.rmSync(turnLog, { force: true });
    const r = live(run({ FAKE_LOGGED_IN: "1" }, manifest()));
    expect(r["live:hook-fired(UserPromptSubmit)"]!.status).toBe("pass");
    expect(r["live:hook-fired(PreToolUse)"]!.status).toBe("pass");
    expect(r["live:ceiling"]!.detail).toBe(
      "1010 tokens, within the ceiling of 100000",
    );
    expect(r["live:cleanup"]!.status).toBe("pass");
    expect(r["live:cleanup"]!.detail).toContain(
      "delete --force 01a08f55-b91b-7993-8d57-b873c3aeabc7",
    );
    expect(
      log().some((e) => e.deleted === "01a08f55-b91b-7993-8d57-b873c3aeabc7"),
    ).toBe(true);
    expect(sessionFiles(codexHome)).toEqual([path.relative(codexHome, other)]);
    const turnArgs = log().find((e) => Array.isArray(e.args))!.args as string[];
    expect(turnArgs).toContain("--dangerously-bypass-hook-trust");
    expect(turnArgs[turnArgs.indexOf("-c") + 1]).toMatch(
      /^hooks=\{UserPromptSubmit=\[/,
    );
  });
});

describe("pieces of the live run", () => {
  it("reads a session id from an envelope field or from an event", () => {
    expect(
      sessionIdFrom('{"session_id":"0526b31f-0a85-4714-89fe-b45c4032d04b"}', {
        field: "session_id",
      }),
    ).toBe("0526b31f-0a85-4714-89fe-b45c4032d04b");
    expect(
      sessionIdFrom(
        'noise\n{"type":"thread.started","thread_id":"01a08f55-b91b-7993"}\n',
        {
          event: "thread.started",
          field: "thread_id",
        },
      ),
    ).toBe("01a08f55-b91b-7993");
    expect(
      sessionIdFrom('{"session_id":"../x"}', { field: "session_id" }),
    ).toBeNull();
  });

  it("finds only the named session's file, written since the turn began", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-find-"));
    try {
      const day = path.join(base, "sessions", "2026", "09", "11");
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, "rollout-a-11111111-aaaa.jsonl"), "{}");
      fs.writeFileSync(path.join(day, "rollout-b-22222222-bbbb.jsonl"), "{}");
      const found = findSessionTranscript(
        base,
        "sessions/**/rollout-*-{session}.jsonl",
        "22222222-bbbb",
        Date.now() - 60_000,
      );
      expect(path.basename(found!.file)).toBe("rollout-b-22222222-bbbb.jsonl");
      expect(
        findSessionTranscript(
          base,
          "sessions/**/rollout-*-{session}.jsonl",
          "22222222-bbbb",
          Date.now() + 60_000,
        ),
      ).toBeNull();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("counts cached tokens once for a stream that includes them in its input count", () => {
    const parsed = resolveProfile("codex").parseOutput(
      [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 600,
            output_tokens: 10,
          },
        }),
      ].join("\n"),
    );
    expect(parsed.ok && parsed.value.usage).toMatchObject({
      input_tokens: 400,
      cache_read_tokens: 600,
      output_tokens: 10,
    });
  });

  it("is n/a for a profile that declares no live run", () => {
    const { live: _omit, ...bare } = resolveProfile("claude");
    const outcome = runLive(
      claudeManifest(),
      { harness: claude, configDir: dir },
      bare,
      { ceiling: 1, timeoutMs: 1000 },
    );
    expect(outcome.results).toEqual([
      {
        probe: "live",
        status: "n/a",
        detail: 'harness profile "claude" declares no live run',
      },
    ]);
  });

  it("adds nothing live unless asked", () => {
    const v = runManifest(claudeManifest(), {
      configDir: dir,
      date: "2026-09-11",
    });
    expect(v.results.some((r) => r.probe.startsWith("live"))).toBe(false);
    expect(v.live).toBeUndefined();
  });

  it("skips a transcript that vanished between listing and stat", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-find-"));
    try {
      const day = path.join(base, "sessions", "2026", "09", "11");
      fs.mkdirSync(day, { recursive: true });
      // Both files match the pattern for the same session; the first is made
      // to vanish at the stat, as a concurrent writer rotating files can do.
      const gone = path.join(day, "rollout-a-22222222-bbbb.jsonl");
      const there = path.join(day, "rollout-b-22222222-bbbb.jsonl");
      fs.writeFileSync(gone, "{}");
      fs.writeFileSync(there, "{}");
      const real = fs.statSync;
      const spy = vi.spyOn(fs, "statSync").mockImplementation(((
        p: unknown,
        o: unknown,
      ) =>
        p === gone
          ? (() => {
              throw new Error("ENOENT: vanished");
            })()
          : (real as (a: unknown, b: unknown) => ReturnType<typeof real>)(
              p,
              o,
            )) as unknown as typeof fs.statSync);
      try {
        const found = findSessionTranscript(
          base,
          "sessions/**/rollout-*-{session}.jsonl",
          "22222222-bbbb",
          Date.now() - 60_000,
        );
        expect(path.basename(found!.file)).toBe(
          "rollout-b-22222222-bbbb.jsonl",
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps every deterministic result when the live step itself fails", () => {
    const plain = runManifest(claudeManifest(), {
      configDir: dir,
      date: "2026-09-11",
    });
    const spy = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, mkdtemp");
    });
    try {
      const v = run({ FAKE_LOGGED_IN: "1" });
      const strip = (x: typeof v): typeof v.results =>
        x.results.filter((r) => !r.probe.startsWith("live"));
      // The same deterministic verdict the run delivers without --live, plus
      // one n/a line for the live step — never a lost verdict (D-008).
      expect(strip(v)).toEqual(strip(plain));
      expect(v.results.filter((r) => r.probe.startsWith("live"))).toEqual([
        {
          probe: "live",
          status: "n/a",
          detail: expect.stringContaining("could not complete"),
        },
      ]);
      expect(v.live).toEqual({ turned: false, tokens: null });
      expect(v.ok).toBe(plain.ok);
    } finally {
      spy.mockRestore();
    }
  });
});
