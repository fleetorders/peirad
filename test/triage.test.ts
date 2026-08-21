import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assessAlarm,
  buildChangelogRubric,
  triageCommand,
} from "../src/triage.js";
import { loadManifest } from "../src/manifest.js";

const here = (f: string): string => fileURLToPath(new URL(f, import.meta.url));
const FAKE = here("./fake-harness.sh");
const ALARM = fs.readFileSync(here("./fixtures/changelog-alarm.md"), "utf8");

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
