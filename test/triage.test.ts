import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessAlarm,
  buildChangelogRubric,
  triageCommand,
} from "../src/triage.js";
import { loadManifest } from "../src/manifest.js";

const here = (f: string): string => fileURLToPath(new URL(f, import.meta.url));
const FAKE = here("./fake-harness.sh");
const NOUSAGE = here("./fake-harness-nousage.sh");
const ALARM = fs.readFileSync(here("./fixtures/changelog-alarm.md"), "utf8");

const FAKE_USAGE = {
  input_tokens: 12,
  cache_read_tokens: 34,
  cache_write_tokens: 5,
  output_tokens: 67,
  model: "fake-model-x",
  cost_usd: 0.0123,
};

// Capture what triageCommand prints so assertions run against real output.
let out = "";
let err = "";
const origEnv = process.env.PEIRAD_HARNESS;

afterEach(() => {
  vi.restoreAllMocks();
  process.env.PEIRAD_HARNESS = origEnv;
});

function capture(): void {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err += String(c);
    return true;
  });
}

describe("buildChangelogRubric", () => {
  it("lists every contract the manifest declares", () => {
    const manifest = loadManifest(here("./fixtures/peirad.json"));
    const rubric = buildChangelogRubric(manifest);
    expect(rubric).toContain("claude");
    expect(rubric).toContain("-p, --allowedTools");
    expect(rubric).toContain("hooks.PreToolUse");
    expect(rubric).toContain("PreToolUse");
    expect(rubric).toContain("agent-guard");
    expect(rubric).toContain("type, message");
  });
});

describe("assessAlarm", () => {
  it("parses the verdict and applies the quote guard", () => {
    const outcome = assessAlarm({
      alarm: ALARM,
      rubric: "# rubric\nassess the alarm.",
      harness: FAKE,
      timeoutSeconds: 20,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.verdict).toBe("action");
    expect(outcome.result.confidence).toBe("high");
    expect(outcome.result.reasoning).toHaveLength(2);
    expect(outcome.result.dropped).toBe(1);
    expect(outcome.result.harness_version).toBe("fake-harness 1.2.3");
  });

  it("captures the usage block the harness reported", () => {
    const outcome = assessAlarm({
      alarm: ALARM,
      rubric: "# rubric\nassess the alarm.",
      harness: FAKE,
      timeoutSeconds: 20,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.usage).toEqual(FAKE_USAGE);
  });

  it("reports null usage when the envelope carries no usage block", () => {
    const outcome = assessAlarm({
      alarm: ALARM,
      rubric: "# rubric",
      harness: NOUSAGE,
      timeoutSeconds: 20,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.usage).toBeNull();
  });

  it("degrades loudly when the harness output is not JSON", () => {
    const outcome = assessAlarm({
      alarm: ALARM,
      rubric: "# rubric",
      harness: here("./fake-harness-garbage.sh"),
      timeoutSeconds: 20,
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "harness output was not JSON",
    });
  });

  it("degrades loudly when the harness call times out", () => {
    const outcome = assessAlarm({
      alarm: ALARM,
      rubric: "# rubric",
      harness: here("./fake-harness-slow.sh"),
      timeoutSeconds: 1,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("timed out after 1s");
  });
});

describe("triageCommand", () => {
  it("prints the md block with heading, verdict, quotes and drop count", () => {
    capture();
    process.env.PEIRAD_HARNESS = FAKE;
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: "changelog",
      manifest: here("./fixtures/peirad.json"),
      format: "md",
      timeout: "20",
    });
    expect(code).toBe(0);
    expect(out.startsWith("## Pre-assessment (machine, unverified)\n")).toBe(
      true,
    );
    expect(out).toContain("Verdict: action\n");
    expect(out).toContain("Confidence: high\n");
    expect(out).toContain('"The `--allowedTools` flag is now');
    expect(out).toContain("dropped: 1 unquotable point(s)");
  });

  it("prints a usage line with tokens, model and cost", () => {
    capture();
    process.env.PEIRAD_HARNESS = FAKE;
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: "changelog",
      manifest: here("./fixtures/peirad.json"),
      format: "md",
      timeout: "20",
    });
    expect(code).toBe(0);
    expect(out).toContain(
      "usage: in 12 / cached 39 / out 67 tokens · model fake-model-x · cost $0.0123",
    );
  });

  it("says so plainly when the harness reported no usage", () => {
    capture();
    process.env.PEIRAD_HARNESS = NOUSAGE;
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: "changelog",
      manifest: here("./fixtures/peirad.json"),
      format: "md",
      timeout: "20",
    });
    expect(code).toBe(0);
    expect(out).toContain("usage: not reported by the harness");
  });

  it("emits parseable json carrying the verdict and rubric name", () => {
    capture();
    process.env.PEIRAD_HARNESS = FAKE;
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: "changelog",
      manifest: here("./fixtures/peirad.json"),
      format: "json",
      timeout: "20",
    });
    expect(code).toBe(0);
    const j = JSON.parse(out) as { verdict: string; rubric: string };
    expect(j.verdict).toBe("action");
    expect(j.rubric).toBe("changelog");
  });

  it("carries the usage object in json output", () => {
    capture();
    process.env.PEIRAD_HARNESS = FAKE;
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: "changelog",
      manifest: here("./fixtures/peirad.json"),
      format: "json",
      timeout: "20",
    });
    expect(code).toBe(0);
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(j.usage).toEqual(FAKE_USAGE);
  });

  it("appends one JSON row per call to --usage-log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-usage-"));
    const log = path.join(dir, "usage.jsonl");
    try {
      capture();
      process.env.PEIRAD_HARNESS = FAKE;
      for (let i = 0; i < 2; i++) {
        expect(
          triageCommand({
            alarm: here("./fixtures/changelog-alarm.md"),
            rubric: "changelog",
            manifest: here("./fixtures/peirad.json"),
            format: "md",
            timeout: "20",
            usageLog: log,
          }),
        ).toBe(0);
      }
      const rows = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          harness: FAKE,
          harness_version: "fake-harness 1.2.3",
          rubric: "changelog",
          verdict: "action",
          usage: FAKE_USAGE,
        });
        expect(typeof row.ts).toBe("string");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 when the usage log cannot be written", () => {
    capture();
    process.env.PEIRAD_HARNESS = FAKE;
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: "changelog",
      manifest: here("./fixtures/peirad.json"),
      format: "md",
      timeout: "20",
      usageLog: "/no/such/dir/usage.jsonl",
    });
    expect(code).toBe(2);
    expect(err).toContain("cannot write usage log");
  });

  it("accepts a rubric file and reports its path as the rubric", () => {
    capture();
    process.env.PEIRAD_HARNESS = FAKE;
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: here("./fixtures/rubric.md"),
      manifest: here("./fixtures/peirad.json"),
      format: "json",
      timeout: "20",
    });
    expect(code).toBe(0);
    const j = JSON.parse(out) as { rubric: string };
    expect(j.rubric).toBe(here("./fixtures/rubric.md"));
  });

  it("exits 2 with the unavailable line when the harness fails", () => {
    capture();
    process.env.PEIRAD_HARNESS = "/usr/bin/false";
    const code = triageCommand({
      alarm: here("./fixtures/changelog-alarm.md"),
      rubric: "changelog",
      manifest: here("./fixtures/peirad.json"),
      format: "md",
      timeout: "20",
    });
    expect(code).toBe(2);
    expect(err).toContain("pre-assessment unavailable: harness exited 1");
  });

  it("exits 2 on a missing alarm or rubric file", () => {
    capture();
    process.env.PEIRAD_HARNESS = FAKE;
    expect(
      triageCommand({
        alarm: "test/fixtures/no-such-alarm.md",
        rubric: "changelog",
        manifest: here("./fixtures/peirad.json"),
        format: "md",
        timeout: "20",
      }),
    ).toBe(2);
    expect(err).toContain("alarm not found");
    expect(
      triageCommand({
        alarm: here("./fixtures/changelog-alarm.md"),
        rubric: "test/fixtures/no-such-rubric.md",
        manifest: here("./fixtures/peirad.json"),
        format: "md",
        timeout: "20",
      }),
    ).toBe(2);
    expect(err).toContain("rubric not found");
  });
});
