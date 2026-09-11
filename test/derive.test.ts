import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanProject,
  draftManifest,
  compareWithScan,
  likelyHarness,
  type Scan,
} from "../src/derive.js";
import type { Manifest } from "../src/manifest.js";

let root: string;
let scan: Scan;
const put = (rel: string, text: string): void => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-derive-"));
  put(
    "scripts/review.sh",
    `#!/bin/sh\nclaude -p "$PROMPT" --output-format json --allowedTools "Bash(git:*)" | jq -r '.result'\n`,
  );
  put("scripts/version.sh", "#!/bin/sh\nclaude --version\n");
  put(
    "scripts/report.mjs",
    `import { spawn } from "node:child_process";\nspawn("codex", ["exec", "--json", "--skip-git-repo-check", prompt]);\n`,
  );
  put(
    "src/reader.py",
    `# reads the harness's .jsonl transcripts\nfor line in open(path):\n    rec = json.loads(line)\n    kind = rec.get("type")\n    msg = rec["message"]\n`,
  );
  put("hooks/read.sh", "#!/bin/sh\njq -r '.message.content' session.jsonl\n");
  put(
    ".claude/settings.json",
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: 'node "$CLAUDE_PROJECT_DIR"/hooks/guard.mjs',
                },
              ],
            },
          ],
          Stop: [
            { hooks: [{ type: "command", command: "jq -c . >> log.txt" }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  put(
    ".codex/hooks.json",
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: "sh .codex/guard.sh" }] }] },
    }),
  );
  put(
    "package.json",
    JSON.stringify({ scripts: { ask: "claude -p --model sonnet" } }, null, 2),
  );
  put("bin/tool", "#!/bin/sh\nclaude --print --verbose\n");
  // Places a scan must not read.
  put("node_modules/dep/index.js", "claude -p --should-not-appear\n");
  put("dist/cli.js", "claude --also-not-appear\n");
  put("README.md", "claude -p --not-from-docs\n");
  put(".cache/tool.sh", "claude --not-from-dot-dirs\n");
  scan = scanProject(root);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("scanning a project", () => {
  it("collects the flags passed to each harness, with file and line", () => {
    expect(Object.keys(scan.flags.claude!).sort()).toEqual([
      "--allowedTools",
      "--model",
      "--output-format",
      "--print",
      "--verbose",
      "-p",
    ]);
    expect(scan.flags.claude!["--output-format"]).toEqual([
      "scripts/review.sh:2",
    ]);
    expect(scan.flags.claude!["-p"]).toEqual([
      "package.json:3",
      "scripts/review.sh:2",
    ]);
    expect(Object.keys(scan.flags.codex!).sort()).toEqual([
      "--json",
      "--skip-git-repo-check",
    ]);
  });

  it("ignores dependencies, build output, docs, tool caches and trivial flags", () => {
    const all = JSON.stringify(scan.flags);
    for (const f of [
      "--should-not-appear",
      "--also-not-appear",
      "--not-from-docs",
      "--not-from-dot-dirs",
      "--version",
      "-r",
    ]) {
      expect(all).not.toContain(`"${f}"`);
    }
  });

  it("reads hooks from settings files, matched by the script they run", () => {
    expect(
      scan.hooks.map((h) => `${h.harness} ${h.event} ${h.match} ${h.at}`),
    ).toEqual([
      "claude PreToolUse guard.mjs .claude/settings.json:9",
      "claude Stop jq .claude/settings.json:19",
      "codex PreToolUse guard.sh .codex/hooks.json:1",
    ]);
  });

  it("names the helper programs hook commands call, but not the shell", () => {
    expect(Object.keys(scan.helpers).sort()).toEqual(["jq", "node"]);
  });

  it("collects transcript fields only from code that reads JSON lines", () => {
    expect(Object.keys(scan.transcriptFields).sort()).toEqual([
      "message",
      "message.content",
      "type",
    ]);
    expect(scan.transcriptFields.type).toEqual(["src/reader.py:4"]);
    expect(Object.keys(scan.transcriptFields)).not.toContain("result");
  });

  it("picks the harness the project leans on", () => {
    expect(likelyHarness(scan)).toBe("claude");
  });
});

describe("the draft manifest", () => {
  it("proposes a probe per finding, each carrying where it came from", () => {
    const m = draftManifest(scan, "claude", "fixture");
    expect(m.name).toBe("fixture (draft)");
    expect(m.probes.map((p) => p.type)).toEqual([
      "command-exists",
      "version",
      "flag-accepted",
      "hook-registered",
      "hook-registered",
      "command-exists",
      "command-exists",
      "transcript-field",
    ]);
    const flags = m.probes[2] as unknown as {
      flags: string[];
      _from: Record<string, string[]>;
    };
    expect(flags.flags[0]).toBe("--allowedTools");
    expect(flags._from["--model"]).toEqual(["package.json:3"]);
    const hook = m.probes[3] as unknown as {
      file: string;
      match: string;
      _from: string;
    };
    expect(hook).toMatchObject({
      file: ".claude/settings.json",
      match: "guard.mjs",
      _from: ".claude/settings.json:9",
    });
    const transcript = m.probes[7] as unknown as {
      glob: string;
      fields: string[];
    };
    expect(transcript.glob).toBe("projects/**/*.jsonl");
  });

  it("is deterministic: the same project drafts the same manifest", () => {
    expect(draftManifest(scanProject(root), "claude", "fixture")).toEqual(
      draftManifest(scan, "claude", "fixture"),
    );
  });
});

describe("coverage against an existing manifest", () => {
  const existing: Manifest = {
    harness: "claude",
    probes: [
      {
        type: "flag-accepted",
        flags: ["-p", "--dangerously-skip-permissions"],
      },
      {
        type: "hook-registered",
        file: ".claude/settings.json",
        event: "PreToolUse",
        match: "guard.mjs",
      },
      {
        type: "hook-registered",
        file: ".claude/settings.json",
        event: "SessionStart",
        match: "banner.sh",
      },
      { type: "command-exists", command: "rg" },
      {
        type: "transcript-field",
        glob: "projects/**/*.jsonl",
        fields: ["type", "sessionId"],
      },
    ],
  };

  it("names what the code uses that no probe declares, with where", () => {
    const { undeclared } = compareWithScan(existing, scan);
    const names = undeclared.map((u) => `${u.kind}:${u.name}`);
    expect(names).toContain("flag:--output-format");
    expect(names).toContain("hook:Stop → jq");
    expect(names).toContain("helper:node");
    expect(names).toContain("transcript-field:message.content");
    expect(names).not.toContain("flag:-p");
    expect(names).not.toContain("hook:PreToolUse → guard.mjs");
    expect(undeclared.find((u) => u.name === "--model")!.at).toEqual([
      "package.json:3",
    ]);
  });

  it("names what is declared that the scanned files never mention", () => {
    const { unused } = compareWithScan(existing, scan);
    expect(unused.map((u) => `${u.kind}:${u.name}`)).toEqual([
      "flag:--dangerously-skip-permissions",
      "hook:SessionStart → banner.sh",
      "helper:rg",
      "transcript-field:sessionId",
    ]);
  });
});

describe("the scan on a verdict", () => {
  it("attaches both directions and never changes whether the run passes", async () => {
    const { runManifest, runScanCoverage } = await import("../src/doctor.js");
    const m: Manifest = {
      harness: "true",
      probes: [{ type: "command-exists" }],
    };
    const v = runManifest(m, { configDir: root, date: "2026-09-11" });
    const scanned = runScanCoverage({ ...m, harness: "claude" }, v, {
      dir: root,
      label: ".",
    });
    expect(scanned.ok).toBe(v.ok);
    expect(scanned.degraded).toBe(v.degraded);
    expect(scanned.scan!.dir).toBe(".");
    expect(scanned.scan!.scanned).toBeGreaterThan(5);
    expect(scanned.scan!.undeclared.map((u) => u.name)).toContain("-p");
  });
});
