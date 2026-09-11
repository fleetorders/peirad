import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Manifest } from "../src/manifest.js";
import { runManifest, runLedger, observeManifest } from "../src/doctor.js";
import {
  keyPaths,
  makeBaseline,
  formatBaseline,
  readBaseline,
  compareSurface,
  type Baseline,
} from "../src/baseline.js";

// A fake harness whose version and help text the tests control, so a run can
// be recorded, the "harness" updated, and the next run compared.
let dir: string;
let harness: string;
const setHarness = (version: string, flags: string[]): void => {
  fs.writeFileSync(
    harness,
    `#!/bin/sh
case "$1" in
  --version) echo "${version}" ;;
  *) printf 'Usage: fake [options]\\n${flags.map((f) => `  ${f} <value>  a flag`).join("\\n")}\\n' ;;
esac
`,
  );
  fs.chmodSync(harness, 0o755);
};
const write = (file: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
};
const manifest = (): Manifest =>
  ({
    harness,
    probes: [
      { type: "flag-accepted", flags: ["--print"] },
      {
        type: "config-key",
        file: "settings.json",
        expect: { "voice.enabled": true },
      },
      {
        type: "transcript-field",
        glob: "projects/**/*.jsonl",
        fields: ["type"],
      },
    ],
  }) as Manifest;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-ledger-"));
  harness = path.join(dir, "fake-harness");
  setHarness("1.0.0", ["--print", "--model", "--old-flag"]);
  write("settings.json", {
    voice: { enabled: true, mode: "push" },
    env: { SOME_PRIVATE_VARIABLE: "value" },
    model: "a-model",
  });
  write("projects/p/t.jsonl", { type: "user", message: { role: "user" } });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("keyPaths", () => {
  it("walks nested objects but never into lists", () => {
    expect(
      keyPaths({ a: { b: 1, c: { d: 2 } }, list: [{ hidden: 1 }] }, 6),
    ).toEqual(["a", "a.b", "a.c", "a.c.d", "list"]);
  });

  it("stops at a key that is data rather than a name, and records no content", () => {
    const paths = keyPaths(
      { snapshot: { "/some/dir/file.ts": { size: 1 }, "x@y": 1 } },
      6,
    );
    expect(paths).toEqual(["snapshot", "snapshot.*"]);
    expect(paths.join(" ")).not.toContain("file.ts");
  });

  it("honours the depth limit", () => {
    expect(keyPaths({ a: { b: { c: { d: 1 } } } }, 2)).toEqual(["a", "a.b"]);
  });
});

describe("observing the surface", () => {
  it("records the version, flag tokens, scoped settings names and transcript fields", () => {
    const s = observeManifest(manifest(), { configDir: dir });
    expect(s.harnessVersion).toBe("1.0.0");
    expect(s.help).toEqual(["--model", "--old-flag", "--print"]);
    // Top-level names, plus the neighbourhood of what was declared (voice.*);
    // nothing under env, which the manifest never mentions.
    expect(s.settings["settings.json"]).toEqual([
      "env",
      "model",
      "voice",
      "voice.enabled",
      "voice.mode",
    ]);
    expect(s.transcripts["projects/**/*.jsonl"]).toEqual([
      "message",
      "message.role",
      "type",
    ]);
  });

  it("writes names only — never a value from the settings", () => {
    const s = observeManifest(manifest(), { configDir: dir });
    const text = JSON.stringify(s);
    expect(text).not.toContain("SOME_PRIVATE_VARIABLE");
    expect(text).not.toContain("a-model");
    expect(text).not.toContain("push");
  });
});

describe("the baseline file", () => {
  it("round-trips through its own format", () => {
    const s = observeManifest(manifest(), { configDir: dir });
    const b = makeBaseline(s, {
      recorded: "2026-09-01",
      checker: "0.0.0",
      harness: "fake",
    });
    const file = path.join(dir, "round.json");
    fs.writeFileSync(file, formatBaseline(b));
    const read = readBaseline(file);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.baseline).toEqual(b);
  });

  it("refuses a file that is not a baseline, and one from another format", () => {
    const other = path.join(dir, "other.json");
    fs.writeFileSync(other, JSON.stringify({ hello: 1 }));
    expect(readBaseline(other)).toMatchObject({ ok: false });
    const future = path.join(dir, "future.json");
    fs.writeFileSync(
      future,
      JSON.stringify({ kind: "peirad-baseline", format: 99 }),
    );
    const r = readBaseline(future);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("record it again");
  });
});

describe("comparing against a baseline", () => {
  const recorded = (): Baseline =>
    makeBaseline(observeManifest(manifest(), { configDir: dir }), {
      recorded: "2026-09-01",
      checker: "0.0.0",
      harness: "fake",
    });

  it("reports nothing when nothing moved", () => {
    const b = recorded();
    const report = compareSurface(
      b,
      observeManifest(manifest(), { configDir: dir }),
      manifest(),
      "peirad.baseline.json",
    );
    expect(report.moved).toEqual([]);
    expect(report.untracked).toEqual([]);
  });

  it("reports an update's undeclared movement and leaves declared names to the probes", () => {
    const b = recorded();
    // The "update": a new version, a flag gone, a flag added, the declared
    // flag removed too (that one is the flag probe's finding, not the
    // ledger's), a settings key renamed beside the declared one, and a new
    // transcript field.
    setHarness("1.1.0", ["--model", "--new-flag"]);
    write("settings.json", {
      voice: { enabled: true, mode: "push", enable: false },
      model: "a-model",
      env: {},
    });
    write("projects/p/t.jsonl", {
      type: "user",
      message: { role: "user" },
      sessionKind: "x",
    });
    try {
      const report = compareSurface(
        b,
        observeManifest(manifest(), { configDir: dir }),
        manifest(),
        "peirad.baseline.json",
      );
      const lines = report.moved.map(
        (m) =>
          `${m.change} ${m.surface}${m.where ? `(${m.where})` : ""} ${m.from ? `${m.from}→` : ""}${m.name}`,
      );
      expect(lines).toContain("changed version 1.0.0→1.1.0");
      expect(lines).toContain("added help --new-flag");
      expect(lines).toContain("removed help --old-flag");
      expect(lines).not.toContain("removed help --print");
      expect(lines).toContain("added settings(settings.json) voice.enable");
      expect(lines).toContain(
        "added transcript(projects/**/*.jsonl) sessionKind",
      );
    } finally {
      setHarness("1.0.0", ["--print", "--model", "--old-flag"]);
      write("settings.json", {
        voice: { enabled: true, mode: "push" },
        env: { SOME_PRIVATE_VARIABLE: "value" },
        model: "a-model",
      });
      write("projects/p/t.jsonl", { type: "user", message: { role: "user" } });
    }
  });

  it("names a source the baseline never recorded instead of calling it movement", () => {
    const b = recorded();
    delete (b.settings as Record<string, string[]>)["settings.json"];
    const report = compareSurface(
      b,
      observeManifest(manifest(), { configDir: dir }),
      manifest(),
      "peirad.baseline.json",
    );
    expect(report.moved).toEqual([]);
    expect(report.untracked).toEqual(["settings(settings.json)"]);
  });
});

describe("the ledger step", () => {
  it("records, then compares, and never touches the verdict's pass/fail", () => {
    const file = path.join(dir, "peirad.baseline.json");
    fs.rmSync(file, { force: true });
    const m = manifest();
    const verdict = runManifest(m, { configDir: dir, date: "2026-09-01" });
    const recordedV = runLedger(m, verdict, {
      configDir: dir,
      file,
      label: "peirad.baseline.json",
      record: true,
      explicit: false,
      date: "2026-09-01",
    });
    expect(fs.existsSync(file)).toBe(true);
    expect(recordedV.notes.join(" ")).toContain("baseline recorded");

    setHarness("2.0.0", ["--print", "--model", "--old-flag"]);
    try {
      const later = runManifest(m, { configDir: dir, date: "2026-09-11" });
      const compared = runLedger(m, later, {
        configDir: dir,
        file,
        label: "peirad.baseline.json",
        record: false,
        explicit: false,
        date: "2026-09-11",
      });
      expect(compared.baseline?.moved).toEqual([
        { surface: "version", change: "changed", name: "2.0.0", from: "1.0.0" },
      ]);
      expect(compared.ok).toBe(later.ok);
      expect(compared.degraded).toBe(later.degraded);
      expect(compared.blocked).toBe(later.blocked);
    } finally {
      setHarness("1.0.0", ["--print", "--model", "--old-flag"]);
    }
  });

  it("stays quiet without a baseline unless one was asked for by name", () => {
    const m = manifest();
    const v = runManifest(m, { configDir: dir, date: "2026-09-11" });
    const missing = path.join(dir, "nowhere.json");
    const quiet = runLedger(m, v, {
      configDir: dir,
      file: missing,
      label: "nowhere.json",
      record: false,
      explicit: false,
      date: "2026-09-11",
    });
    expect(quiet.baseline).toBeUndefined();
    expect(quiet.notes).toEqual(v.notes);
    const asked = runLedger(m, v, {
      configDir: dir,
      file: missing,
      label: "nowhere.json",
      record: false,
      explicit: true,
      date: "2026-09-11",
    });
    expect(asked.notes.join(" ")).toContain("not found");
  });
});
