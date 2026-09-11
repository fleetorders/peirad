import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runProbe, type ProbeContext } from "../src/probes.js";
import { runManifest } from "../src/doctor.js";
import { resolveProfile } from "../src/harness-profiles.js";
import type { Manifest } from "../src/manifest.js";
import {
  parseReport,
  evaluateFind,
  describeMiss,
  type HarnessReport,
} from "../src/reports.js";

// Output shapes as the two harness families print them, with neutral names.
const MCP_LINES = [
  "Checking MCP server health…",
  "",
  "plugin:design:design: https://mcp.example.com/mcp (HTTP) - ! Needs authentication",
  "browser: /opt/tools/browser-mcp  - ✔ Connected",
].join("\n");

const DOCTOR_LINES = [
  "Claude Code doctor",
  "",
  "Running: native (9.9.9)",
  "Config install method: native",
  "Auto-updates: enabled",
  "",
  "No installation issues found.",
].join("\n");

const MCP_JSON = JSON.stringify([
  { name: "browser", enabled: true, transport: { type: "stdio" } },
  { name: "search", enabled: false, transport: { type: "http" } },
]);

const DOCTOR_JSON = JSON.stringify({
  overallStatus: "warn",
  checks: {
    "config.load": { id: "config.load", status: "ok" },
    "auth.credentials": { id: "auth.credentials", status: "warn" },
  },
});

const out = (stdout: string, stderr = "") => ({ stdout, stderr });

describe("reading a report", () => {
  const claude = resolveProfile("claude").reports;
  const codex = resolveProfile("codex").reports;

  it("reads the line-shaped server list, names with colons included", () => {
    const r = parseReport(out(MCP_LINES), claude.mcp!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toEqual([
      {
        name: "plugin:design:design",
        target: "https://mcp.example.com/mcp (HTTP)",
        mark: "!",
        status: "Needs authentication",
      },
      {
        name: "browser",
        target: "/opt/tools/browser-mcp",
        mark: "✔",
        status: "Connected",
      },
    ]);
  });

  it("treats the empty server list as a valid report with no records", () => {
    const r = parseReport(
      out("No MCP servers configured. Use `claude mcp add` to add a server.\n"),
      claude.mcp!,
    );
    expect(r).toEqual({ ok: true, records: [] });
  });

  it("reads key: value doctor lines", () => {
    const r = parseReport(out(DOCTOR_LINES), claude.doctor!);
    expect(r.ok && r.records).toContainEqual({
      key: "Config install method",
      value: "native",
    });
  });

  it("reads a JSON array, and a JSON object keyed by id", () => {
    const list = parseReport(out(MCP_JSON), codex.mcp!);
    expect(list.ok && list.records.map((x) => x.name)).toEqual([
      "browser",
      "search",
    ]);
    const checks = parseReport(out(DOCTOR_JSON), codex.doctor!);
    expect(checks.ok && checks.records.map((x) => x.id)).toEqual([
      "config.load",
      "auth.credentials",
    ]);
    const summary = parseReport(out(DOCTOR_JSON), codex["doctor-summary"]!);
    expect(summary.ok && summary.records[0]!.overallStatus).toBe("warn");
  });

  it("finds the JSON document behind a line of noise", () => {
    const r = parseReport(
      out(`a wrapper announcing itself\n${MCP_JSON}\n`),
      codex.mcp!,
    );
    expect(r.ok && r.records).toHaveLength(2);
  });

  it("says what it could not read when a report changes shape", () => {
    const lines = parseReport(
      out("Servers:\n  browser (connected)\n"),
      claude.mcp!,
    );
    expect(lines.ok).toBe(false);
    if (!lines.ok) {
      expect(lines.reason).toContain("no line matched the declared pattern");
      expect(lines.reason).toContain("Servers:");
    }
    const json = parseReport(out("not json at all"), codex.mcp!);
    expect(json.ok).toBe(false);
    if (!json.ok) expect(json.reason).toContain("expected JSON");
    const moved = parseReport(
      out(JSON.stringify({ results: {} })),
      codex.doctor!,
    );
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.reason).toContain("top-level keys: results");
  });

  it("refuses a lines report with no pattern, or one that will not compile", () => {
    const none = parseReport(out("x"), { args: [], format: "lines" });
    expect(none.ok).toBe(false);
    const bad = parseReport(out("x"), {
      args: [],
      format: "lines",
      pattern: "(",
    });
    expect(bad.ok).toBe(false);
  });
});

describe("matching declared facts", () => {
  const records = [
    { name: "browser", status: "Connected" },
    { name: "design", status: "Needs authentication" },
  ];

  it("matches an entry whose every field a record carries", () => {
    const [r] = evaluateFind(records, [
      { name: "browser", status: "Connected" },
    ]);
    expect(r!.matched).toBe(true);
  });

  it("names the nearest record's differing value on a miss", () => {
    const [r] = evaluateFind(records, [
      { name: "design", status: "Connected" },
    ]);
    expect(r!.matched).toBe(false);
    expect(describeMiss(r!, records)).toBe(
      'name=design: status is "Needs authentication" (expected "Connected")',
    );
  });

  it("lists what the report does carry when nothing shares a field", () => {
    const [r] = evaluateFind(records, [{ name: "search", status: "Up" }]);
    expect(describeMiss(r!, records)).toBe(
      "no record has name=search, status=Up (read 2 records; name: browser, design)",
    );
  });
});

describe("the harness-reports probe", () => {
  let dir: string;
  let harness: string;
  const reports: Record<string, HarnessReport> = {
    mcp: resolveProfile("claude").reports.mcp!,
    checks: { args: ["doctor", "--json"], format: "json", records: "checks" },
  };
  const ctx = (): ProbeContext => ({ harness, configDir: dir, reports });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-reports-"));
    harness = path.join(dir, "fake-harness");
    fs.writeFileSync(path.join(dir, "mcp.txt"), `${MCP_LINES}\n`);
    fs.writeFileSync(path.join(dir, "doctor.json"), DOCTOR_JSON);
    // A doctor that found a problem exits non-zero and still prints its
    // report — the probe must read it anyway.
    fs.writeFileSync(
      harness,
      `#!/bin/sh
here=$(dirname "$0")
case "$1" in
  mcp) cat "$here/mcp.txt" ;;
  doctor) cat "$here/doctor.json"; exit 1 ;;
  *) exit 2 ;;
esac
`,
    );
    fs.chmodSync(harness, 0o755);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes when the report carries every declared fact", () => {
    const r = runProbe(
      {
        type: "harness-reports",
        report: "mcp",
        find: [{ name: "browser", status: "Connected" }],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
    expect(r.probe).toBe("harness-reports(mcp)");
    expect(r.detail).toContain("reports name=browser, status=Connected");
  });

  it("degrades, or blocks when critical, naming what the report says instead", () => {
    const spec = {
      type: "harness-reports" as const,
      report: "mcp",
      find: [{ name: "plugin:design:design", status: "Connected" }],
    };
    const soft = runProbe(spec, ctx(), []);
    expect(soft.status).toBe("degraded");
    expect(soft.detail).toContain('status is "Needs authentication"');
    expect(runProbe({ ...spec, critical: true }, ctx(), []).status).toBe(
      "blocked",
    );
  });

  it("reads a report whose command exits non-zero", () => {
    const r = runProbe(
      {
        type: "harness-reports",
        report: "checks",
        find: [{ id: "config.load", status: "ok" }],
      },
      ctx(),
      [],
    );
    expect(r.status).toBe("pass");
  });

  it("is n/a naming what it could not read when the report changes shape", () => {
    fs.writeFileSync(path.join(dir, "mcp.txt"), "Servers:\n  browser (up)\n");
    try {
      const r = runProbe(
        {
          type: "harness-reports",
          report: "mcp",
          find: [{ name: "browser", status: "Connected" }],
          critical: true,
        },
        ctx(),
        [],
      );
      expect(r.status).toBe("n/a");
      expect(r.detail).toContain('could not read the "mcp" report');
      expect(r.detail).toContain("Servers:");
    } finally {
      fs.writeFileSync(path.join(dir, "mcp.txt"), `${MCP_LINES}\n`);
    }
  });

  it("is n/a where the profile has no such report, and says which it has", () => {
    const r = runProbe(
      { type: "harness-reports", report: "plugins" },
      ctx(),
      [],
    );
    expect(r.status).toBe("n/a");
    expect(r.detail).toContain('declares no "plugins" report');
    expect(r.detail).toContain("mcp, checks");
  });

  it("only asserts readability when no facts are declared", () => {
    const r = runProbe({ type: "harness-reports", report: "mcp" }, ctx(), []);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("2 records");
  });

  it("takes a manifest's own reports alongside the profile's", () => {
    const v = runManifest(
      {
        harness,
        harnessProfile: "claude",
        reports: {
          checks: {
            args: ["doctor", "--json"],
            format: "json",
            records: "checks",
          },
        },
        probes: [
          {
            type: "harness-reports",
            report: "checks",
            find: [{ id: "auth.credentials" }],
          },
          {
            type: "harness-reports",
            report: "mcp",
            find: [{ name: "browser" }],
          },
        ],
      } as unknown as Manifest,
      { configDir: dir, date: "2026-09-11" },
    );
    expect(v.results.map((r) => r.status)).toEqual(["pass", "pass"]);
  });
});

describe("nearest record, weighed in declared order", () => {
  it("prefers the record sharing the first declared field over one sharing a later field", () => {
    const records = [
      { name: "a", status: "Connected", kind: "stdio" },
      { name: "b", status: "Failed", kind: "http" },
    ];
    const [r] = evaluateFind(records, [
      { name: "b", status: "Connected", kind: "stdio" },
    ]);
    expect(r!.nearest!.record.name).toBe("b");
  });
});
