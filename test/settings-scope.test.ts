import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runProbe, type ProbeContext } from "../src/probes.js";
import { runManifest } from "../src/doctor.js";
import type { Manifest } from "../src/manifest.js";
import type { SettingsLayer } from "../src/harness-profiles.js";
import {
  mergeValues,
  provenance,
  loadLayers,
  layerVars,
  effectiveSettings,
} from "../src/settings.js";

// A fixture stack under one temp dir. The layer paths are declared with
// {configDir} so no test ever reads the machine's own settings.
let dir: string;
const LAYERS: SettingsLayer[] = [
  { name: "user", path: "{configDir}/user.json" },
  { name: "project", path: "{configDir}/project.json" },
  { name: "local", path: "{configDir}/local.json" },
];
const write = (file: string, data: unknown): void =>
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
const ctx = (): ProbeContext => ({
  harness: "true",
  configDir: dir,
  settingsLayers: LAYERS,
});
const getDotted = (o: unknown, k: string): unknown =>
  k
    .split(".")
    .reduce<unknown>(
      (cur, part) =>
        cur &&
        typeof cur === "object" &&
        part in (cur as Record<string, unknown>)
          ? (cur as Record<string, unknown>)[part]
          : undefined,
      o,
    );

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-scope-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("merging a settings stack", () => {
  it("lets a higher layer win a scalar and joins lists when the harness does", () => {
    expect(mergeValues({ a: 1, b: 2 }, { b: 3 }, "concat")).toEqual({
      a: 1,
      b: 3,
    });
    expect(mergeValues([1], [2], "concat")).toEqual([1, 2]);
    expect(mergeValues([1], [2], "override")).toEqual([2]);
  });

  it("merges nested objects rather than replacing them wholesale", () => {
    expect(
      mergeValues(
        { hooks: { Pre: ["a"] }, x: 1 },
        { hooks: { Post: ["b"] } },
        "concat",
      ),
    ).toEqual({ hooks: { Pre: ["a"], Post: ["b"] }, x: 1 });
  });

  it("attributes a scalar to the layer that won and names the ones it shadowed", () => {
    write("user.json", { mode: "ask" });
    write("project.json", { mode: "acceptEdits" });
    fs.rmSync(path.join(dir, "local.json"), { force: true });
    const layers = loadLayers(LAYERS, layerVars(dir));
    expect(provenance(layers, "mode", "concat", getDotted)).toEqual({
      from: ["project"],
      shadowed: ["user"],
    });
    expect(effectiveSettings(layers, "concat")).toEqual({
      mode: "acceptEdits",
    });
  });

  it("attributes a joined list to every layer that contributed", () => {
    write("user.json", { hooks: { PreToolUse: ["from-user"] } });
    write("project.json", { hooks: { PreToolUse: ["from-project"] } });
    const layers = loadLayers(LAYERS, layerVars(dir));
    expect(provenance(layers, "hooks.PreToolUse", "concat", getDotted)).toEqual(
      {
        from: ["user", "project"],
        shadowed: [],
      },
    );
  });

  it("reads a {userConfigDir} layer where the variable points, and as absent when it is unknown", () => {
    const relocated = path.join(dir, "relocated-home");
    fs.mkdirSync(relocated);
    fs.writeFileSync(
      path.join(relocated, "settings.json"),
      JSON.stringify({ voice: { enabled: true } }),
    );
    const layer: SettingsLayer = {
      name: "user",
      path: "{userConfigDir}/settings.json",
    };
    const withDir = loadLayers([layer], {
      ...layerVars(dir),
      userConfigDir: relocated,
    });
    expect(withDir[0]).toMatchObject({ state: "read" });
    expect(effectiveSettings(withDir, "concat")).toEqual({
      voice: { enabled: true },
    });
    // No harness configuration directory known: the layer is absent under its
    // declared template, never a half-expanded path.
    const withoutDir = loadLayers([layer], layerVars(dir));
    expect(withoutDir[0]).toMatchObject({
      state: "absent",
      path: "{userConfigDir}/settings.json",
    });
  });
});

describe("config-key with scope: effective", () => {
  beforeAll(() => {
    write("user.json", { voice: { enabled: false }, limits: { max: 1 } });
    write("project.json", { voice: { enabled: true } });
    fs.rmSync(path.join(dir, "local.json"), { force: true });
  });

  it("judges the value the harness actually reads, not the first file", () => {
    const r = runProbe(
      {
        type: "config-key",
        scope: "effective",
        expect: { "voice.enabled": true },
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("voice.enabled ← project (shadows user)");
  });

  it("names which layers it read and how many were not there", () => {
    const r = runProbe(
      { type: "config-key", scope: "effective", keys: ["limits.max"] },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("read user, project");
    expect(r.detail).toContain("1 absent");
  });

  it("fails when a layer will not parse, naming the layer", () => {
    fs.writeFileSync(path.join(dir, "local.json"), "{ not json");
    const r = runProbe(
      { type: "config-key", scope: "effective", keys: ["limits.max"] },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain('settings layer "local" will not parse');
    fs.rmSync(path.join(dir, "local.json"), { force: true });
  });

  it("is n/a when the profile declares no stack at all", () => {
    const r = runProbe(
      { type: "config-key", scope: "effective", keys: ["x"] },
      { harness: "true", configDir: dir, settingsLayers: [] },
      [],
    );
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain("declares no settings stack");
  });

  it("is n/a when a file-scope probe names no file", () => {
    const r = runProbe({ type: "config-key", keys: ["x"] }, ctx(), []);
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain('no "file" declared');
  });

  it("reads the user layer where the harness's configuration variable points", () => {
    // The claude profile keeps its user settings in the harness's own
    // configuration directory; when CLAUDE_CONFIG_DIR relocates it, the
    // effective read must follow — a stack that kept reading beneath {home}
    // would pass a setting the harness itself never loads.
    const relocated = path.join(dir, "claude-config");
    fs.mkdirSync(relocated, { recursive: true });
    fs.writeFileSync(
      path.join(relocated, "settings.json"),
      JSON.stringify({ voice: { enabled: true } }),
    );
    const real = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = relocated;
    try {
      const r = runProbe(
        { type: "config-key", scope: "effective", keys: ["voice.enabled"] },
        { harness: "claude", configDir: dir, profileName: "claude" },
        [],
      );
      expect(r.status).toBe("pass");
      expect(r.detail).toContain("voice.enabled ← user");
    } finally {
      if (real === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = real;
    }
  });
});

describe("hook-registered with scope: effective", () => {
  it("finds a hook that moved from project scope to user scope", () => {
    write("user.json", {
      hooks: { PreToolUse: [{ hooks: [{ command: "sh agent-guard.sh" }] }] },
    });
    write("project.json", { other: true });
    const r = runProbe(
      {
        type: "hook-registered",
        scope: "effective",
        event: "PreToolUse",
        match: "agent-guard",
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("in user scope");
  });

  it("keeps a hook registered in either scope while the lists join", () => {
    write("user.json", {
      hooks: { PreToolUse: [{ hooks: [{ command: "sh agent-guard.sh" }] }] },
    });
    write("project.json", {
      hooks: { PreToolUse: [{ hooks: [{ command: "sh other.sh" }] }] },
    });
    const r = runProbe(
      {
        type: "hook-registered",
        scope: "effective",
        event: "PreToolUse",
        match: "agent-guard",
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
  });

  it("reports a hook a higher layer overrides as drift, not as present", () => {
    // A harness whose nearest scope REPLACES the list: the hook is written in
    // the settings, reads as configured, and never runs. The single-file probe
    // called that a pass.
    write("user.json", {
      hooks: { PreToolUse: [{ hooks: [{ command: "sh agent-guard.sh" }] }] },
    });
    write("project.json", {
      hooks: { PreToolUse: [{ hooks: [{ command: "sh other.sh" }] }] },
    });
    const v = runManifest(
      {
        harness: "true",
        settingsLayers: LAYERS,
        settingsArrays: "override",
        probes: [
          {
            type: "hook-registered",
            scope: "effective",
            event: "PreToolUse",
            match: "agent-guard",
            critical: true,
          },
        ],
      } as unknown as Manifest,
      { configDir: dir, date: "2026-09-11" },
    );
    expect(v.results[0]!.status).toBe("blocked");
    expect(v.results[0]!.detail).toContain("is in user scope");
    expect(v.results[0]!.detail).toContain("a higher layer overrides");
  });

  it("passes the same stack where the harness joins the lists instead", () => {
    const v = runManifest(
      {
        harness: "true",
        settingsLayers: LAYERS,
        probes: [
          {
            type: "hook-registered",
            scope: "effective",
            event: "PreToolUse",
            match: "agent-guard",
          },
        ],
      } as unknown as Manifest,
      { configDir: dir, date: "2026-09-11" },
    );
    expect(v.results[0]!.status).toBe("pass");
  });

  it("says the hook is nowhere when no layer carries it", () => {
    write("user.json", { hooks: {} });
    write("project.json", { hooks: {} });
    const r = runProbe(
      {
        type: "hook-registered",
        scope: "effective",
        event: "PreToolUse",
        match: "agent-guard",
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("no PreToolUse hook matching");
  });
});

describe("the stack as manifest data", () => {
  it("takes the manifest's layers over the profile's", () => {
    write("user.json", { declared: "by the manifest" });
    write("project.json", {});
    const v = runManifest(
      {
        harness: "true",
        settingsLayers: LAYERS,
        probes: [
          { type: "config-key", scope: "effective", keys: ["declared"] },
        ],
      } as unknown as Manifest,
      { configDir: dir, date: "2026-09-11" },
    );
    expect(v.results[0]!.status).toBe("pass");
    expect(v.results[0]!.detail).toContain("declared ← user");
  });

  it("expands {home} in a declared layer path without reading it by accident", () => {
    const layers = loadLayers(
      [{ name: "user", path: "{home}/peirad-does-not-exist.json" }],
      layerVars(dir),
    );
    expect(layers[0]!.path.startsWith(os.homedir())).toBe(true);
    expect(layers[0]!.state).toBe("absent");
  });
});
