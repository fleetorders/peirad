import { describe, it, expect } from "vitest";
import { typeCoverage, describeTypeCoverage } from "../src/coverage.js";
import type { Manifest } from "../src/manifest.js";

const manifest = (types: string[]): Manifest =>
  ({ harness: "x", probes: types.map((type) => ({ type })) }) as Manifest;

describe("probe-type coverage", () => {
  it("names the contract types a manifest declares and the ones it does not", () => {
    const c = typeCoverage(
      manifest(["command-exists", "version", "flag-accepted", "config-key"]),
    );
    expect(c).toEqual({
      declared: ["command-exists", "flag-accepted", "config-key"],
      undeclared: [
        "transcript-field",
        "hook-registered",
        "script",
        "harness-reports",
        "env",
      ],
      unknown: [],
    });
    expect(describeTypeCoverage(c)).toBe(
      "declares command-exists, flag-accepted, config-key · not declared: transcript-field, hook-registered, script, harness-reports, env",
    );
  });

  it("never counts version as a contract, declared or not", () => {
    const c = typeCoverage(manifest(["version"]));
    expect(c.declared).toEqual([]);
    expect(c.undeclared).not.toContain("version");
    expect(describeTypeCoverage(c)).toMatch(/^declares no contract probes · /);
  });

  it("lists a type this build does not know separately", () => {
    const c = typeCoverage(manifest(["command-exists", "future-probe"]));
    expect(c.unknown).toEqual(["future-probe"]);
    expect(describeTypeCoverage(c)).toContain(
      "unknown to this build: future-probe",
    );
  });
});

describe("coverage on the verdict", () => {
  it("is on every verdict and never changes whether it passes", async () => {
    const { runManifest } = await import("../src/doctor.js");
    const v = runManifest(
      { harness: "true", probes: [{ type: "command-exists" }] },
      { configDir: ".", date: "2026-09-11" },
    );
    expect(v.ok).toBe(true);
    expect(v.coverage.declared).toEqual(["command-exists"]);
    expect(v.coverage.undeclared).toContain("hook-registered");
  });
});
