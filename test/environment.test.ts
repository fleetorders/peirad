import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkPath, envNames, evaluateEnv } from "../src/environment.js";
import { safeToShow } from "../src/values.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-env-"));
  fs.writeFileSync(path.join(dir, "ca.pem"), "cert");
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dir, "tool"), 0o755);
  fs.writeFileSync(path.join(dir, "not-exec"), "data");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("what a verdict may print", () => {
  it("shows a short plain value under an ordinary name", () => {
    expect(safeToShow("PROVIDER_REGION", "eu-west-1")).toBe(true);
    expect(safeToShow("BASE_URL", "https://api.example.com/v1")).toBe(true);
  });
  it("never shows a value under a credential-shaped name", () => {
    expect(safeToShow("SERVICE_API_KEY", "abc")).toBe(false);
    expect(safeToShow("AUTH_HEADER", "x")).toBe(false);
    expect(safeToShow("OAUTH_TOKEN", "t")).toBe(false);
  });
  it("never shows a long or unusual value, whatever the name", () => {
    expect(safeToShow("MODE", "x".repeat(81))).toBe(false);
    expect(safeToShow("MODE", "has spaces in it")).toBe(false);
  });
  it("never shows a URL with a userinfo part, however plain it looks", () => {
    expect(
      safeToShow("HTTP_PROXY", "http://user:password@proxy.internal:8080"),
    ).toBe(false);
    expect(safeToShow("ALL_PROXY", "http://token@proxy.internal")).toBe(false);
    expect(safeToShow("HTTP_PROXY", "http://proxy.internal:8080")).toBe(true);
  });
});

describe("checking a path value", () => {
  const opts = (searchPath?: string) => ({ baseDir: dir, searchPath });
  it("tells a file from a directory from nothing", () => {
    expect(checkPath(path.join(dir, "ca.pem"), "file", opts())).toEqual({
      ok: true,
    });
    expect(checkPath(path.join(dir, "config"), "file", opts())).toEqual({
      ok: false,
      why: "is not a file",
    });
    expect(checkPath("config", "dir", opts())).toEqual({ ok: true });
    expect(checkPath("nowhere", "path", opts())).toEqual({
      ok: false,
      why: "does not exist",
    });
  });
  it("requires the executable bit for an executable", () => {
    expect(checkPath(path.join(dir, "tool"), "executable", opts())).toEqual({
      ok: true,
    });
    expect(checkPath(path.join(dir, "not-exec"), "executable", opts())).toEqual(
      { ok: false, why: "is not executable" },
    );
  });
  it("looks a bare executable name up on the declared PATH", () => {
    expect(checkPath("tool", "executable", opts(dir))).toEqual({ ok: true });
    expect(checkPath("tool", "executable", opts("/nonexistent"))).toEqual({
      ok: false,
      why: "is not on PATH",
    });
  });
});

describe("evaluating an environment contract", () => {
  const base = { baseDir: dir };

  it("holds when every assertion does, naming each kind that held", () => {
    const env = {
      PROVIDER_URL: "https://api.example.com",
      MODE: "strict",
      CA_BUNDLE: path.join(dir, "ca.pem"),
      PATH: dir,
    };
    const r = evaluateEnv(
      {
        set: ["PROVIDER_URL"],
        unset: ["OVERRIDE_KEY"],
        equals: { MODE: "strict" },
        matches: { PROVIDER_URL: "^https://" },
        pointsAt: { CA_BUNDLE: "file" },
      },
      env,
      base,
    );
    expect(r.problems).toEqual([]);
    expect(r.held).toEqual([
      "set: PROVIDER_URL",
      "unset as declared: OVERRIDE_KEY",
      "values match: MODE",
      "patterns match: PROVIDER_URL",
      "paths resolve: CA_BUNDLE → file",
    ]);
  });

  it("treats an empty variable as unset", () => {
    const r = evaluateEnv({ set: ["A"], unset: ["B"] }, { A: "", B: "" }, base);
    expect(r.problems).toEqual(["not set: A"]);
  });

  it("names every broken assertion, and never prints a credential's value", () => {
    const r = evaluateEnv(
      {
        set: ["MISSING"],
        unset: ["SERVICE_API_KEY"],
        equals: {
          MODE: "strict",
          SERVICE_TOKEN: "expected-token",
          HTTP_PROXY: "http://proxy.internal:8080",
        },
        matches: { URL: "^https://" },
        pointsAt: { CA_BUNDLE: "file", SECRET_PATH: "file", ALL_PROXY: "file" },
      },
      {
        SERVICE_API_KEY: "sk-live-should-never-print",
        MODE: "loose",
        SERVICE_TOKEN: "actual-token-should-never-print",
        URL: "http://plain.example.com",
        CA_BUNDLE: "/definitely/not/here.pem",
        SECRET_PATH: "/also/not/here",
        HTTP_PROXY: "http://user:password@proxy.internal:8080",
        ALL_PROXY: "http://user:password@nowhere.internal",
      },
      // baseDir given here, not the describe-level `base`: that object is
      // built before beforeAll runs, and a relative value would resolve
      // against undefined.
      { baseDir: dir },
    );
    const text = r.problems.join(" | ");
    expect(r.problems).toContain("not set: MISSING");
    expect(r.problems).toContain("set but declared unset: SERVICE_API_KEY");
    expect(r.problems).toContain('MODE is "loose" (expected "strict")');
    expect(r.problems).toContain(
      "SERVICE_TOKEN holds a different value than declared (not shown)",
    );
    expect(r.problems).toContain(
      "HTTP_PROXY holds a different value than declared (not shown)",
    );
    expect(r.problems).toContain("URL does not match /^https:///");
    expect(r.problems).toContain(
      'CA_BUNDLE does not exist: "/definitely/not/here.pem"',
    );
    expect(r.problems).toContain(
      "SECRET_PATH does not exist: (value not shown)",
    );
    expect(r.problems).toContain("ALL_PROXY does not exist: (value not shown)");
    expect(text).not.toContain("should-never-print");
    expect(text).not.toContain("/also/not/here");
    expect(text).not.toContain("user:password");
  });

  it("names where a value came from when the caller knows", () => {
    const r = evaluateEnv(
      { set: ["PROVIDER_URL"], equals: { MODE: "strict" } },
      { PROVIDER_URL: "https://x", MODE: "loose" },
      {
        ...base,
        origin: (n) => (n === "MODE" ? "settings: project" : "process"),
      },
    );
    expect(r.held).toEqual(["set: PROVIDER_URL (process)"]);
    expect(r.problems).toEqual([
      'MODE is "loose" (settings: project) (expected "strict")',
    ]);
  });

  it("reports a pattern that will not compile instead of throwing", () => {
    const r = evaluateEnv({ matches: { A: "(" } }, { A: "x" }, base);
    expect(r.problems[0]).toContain("the pattern for A does not compile");
  });

  it("lists every variable a contract names, once", () => {
    expect(
      envNames({
        set: ["A", "B"],
        equals: { B: "1" },
        pointsAt: { C: "dir" },
      }),
    ).toEqual(["A", "B", "C"]);
  });
});

describe("the env probe", () => {
  // Imported lazily so the pure-function tests above never depend on the
  // probe wiring.
  const load = async () => ({
    ...(await import("../src/probes.js")),
    ...(await import("../src/doctor.js")),
  });
  const LAYERS = [
    { name: "user", path: "{configDir}/user.json" },
    { name: "project", path: "{configDir}/project.json" },
  ];
  const writeLayer = (file: string, data: unknown): void =>
    fs.writeFileSync(path.join(dir, file), JSON.stringify(data));

  it("passes on the process environment it is given", async () => {
    const { runProbe } = await load();
    const r = runProbe(
      {
        type: "env",
        set: ["PROVIDER_URL"],
        matches: { PROVIDER_URL: "^https://" },
      },
      {
        harness: "true",
        configDir: dir,
        env: { PROVIDER_URL: "https://api.example.com" },
      },
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.probe).toBe("env(PROVIDER_URL)");
  });

  it("degrades, or blocks when critical, and keeps a credential's value out of the line", async () => {
    const { runProbe } = await load();
    const spec = {
      type: "env" as const,
      unset: ["SERVICE_API_KEY"],
    };
    const ctx = {
      harness: "true",
      configDir: dir,
      env: { SERVICE_API_KEY: "sk-should-never-print" },
    };
    const soft = runProbe(spec, ctx, []);
    expect(soft.status).toBe("degraded");
    expect(soft.detail).toBe("set but declared unset: SERVICE_API_KEY");
    const hard = runProbe({ ...spec, critical: true }, ctx, []);
    expect(hard.status).toBe("blocked");
    expect(JSON.stringify(hard)).not.toContain("should-never-print");
  });

  it("is n/a when nothing is declared", async () => {
    const { runProbe } = await load();
    const r = runProbe(
      { type: "env" },
      { harness: "true", configDir: dir, env: {} },
      [],
    );
    expect(r.status).toBe("n/a");
  });

  it("lays the settings' variables over the process, naming the layer that set each", async () => {
    const { runProbe } = await load();
    writeLayer("user.json", { env: { MODE: "loose" } });
    writeLayer("project.json", {
      env: { PROVIDER_URL: "https://override.example.com", MODE: "strict" },
    });
    const r = runProbe(
      {
        type: "env",
        scope: "effective",
        set: ["HOME_DIR"],
        equals: { MODE: "strict" },
        matches: { PROVIDER_URL: "^https://override" },
      },
      {
        harness: "true",
        profileName: "claude",
        configDir: dir,
        settingsLayers: LAYERS,
        env: { PROVIDER_URL: "http://process.example.com", HOME_DIR: "/x" },
      },
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("set: HOME_DIR (process)");
    expect(r.detail).toContain("values match: MODE (settings: project)");
    expect(r.detail).toContain("read user, project");
  });

  it("is n/a under a profile with no environment block in its settings", async () => {
    const { runProbe } = await load();
    const r = runProbe(
      { type: "env", scope: "effective", set: ["X"] },
      {
        harness: "true",
        profileName: "codex",
        configDir: dir,
        settingsLayers: LAYERS,
        env: { X: "1" },
      },
      [],
    );
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain("declares no environment block");
  });

  it("fails naming the layer when the settings will not parse", async () => {
    const { runProbe } = await load();
    fs.writeFileSync(path.join(dir, "project.json"), "{ nope");
    const r = runProbe(
      { type: "env", scope: "effective", set: ["X"] },
      {
        harness: "true",
        profileName: "claude",
        configDir: dir,
        settingsLayers: LAYERS,
        env: { X: "1" },
      },
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain('settings layer "project" will not parse');
    writeLayer("project.json", {});
  });

  it("knows its own fields, so a full declaration is never reported as skipped", async () => {
    const { runManifest } = await load();
    const v = runManifest(
      {
        harness: "true",
        probes: [
          {
            type: "env",
            set: ["PATH"],
            unset: ["PEIRAD_TEST_UNSET_VARIABLE"],
            equals: {},
            matches: {},
            pointsAt: {},
            scope: "process",
          },
        ],
      },
      { configDir: dir, date: "2026-09-11" },
    );
    expect(v.results[0]!.status).toBe("pass");
    expect(v.results[0]!.detail).not.toContain("skipped");
  });
});
