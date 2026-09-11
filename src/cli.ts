import { Command } from "commander";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { loadManifest } from "./manifest.js";
import {
  runLedger,
  runManifest,
  runScanCoverage,
  type Verdict,
} from "./doctor.js";
import {
  draftManifest,
  likelyHarness,
  scanProject,
  type CoverageItem,
} from "./derive.js";
import { BASELINE_FILE, type Moved } from "./baseline.js";
import { describeTypeCoverage } from "./coverage.js";
import { validateManifestFile } from "./validate.js";
import { ENGINE_VERSION } from "./probes.js";
import { triageCommand } from "./triage.js";
import { precedentCommand } from "./precedent.js";

function render(v: Verdict): void {
  const mark = (s: string): string =>
    s === "pass"
      ? pc.green("ok  ")
      : s === "degraded"
        ? pc.yellow("DEGR")
        : s === "n/a"
          ? pc.dim("n/a ")
          : pc.red("BLOCK");
  process.stdout.write(
    `${pc.bold(v.name)} — harness ${v.harness} (${v.profile}) ${pc.dim(v.version)} · ${pc.dim(`peirad ${v.checker}`)} · ${v.date}\n`,
  );
  for (const r of v.results) {
    process.stdout.write(`  ${mark(r.status)}  ${r.probe}: ${r.detail}\n`);
  }
  if (v.baseline) renderLedger(v);
  if (v.scan) renderScan(v);
  for (const note of v.notes) {
    process.stdout.write(`  ${pc.dim("note")}  ${pc.dim(note)}\n`);
  }
  process.stdout.write(
    `  ${pc.dim("coverage")} ${pc.dim(describeTypeCoverage(v.coverage))}\n`,
  );
  const summary = v.ok
    ? pc.green("PASS — integration holds")
    : `${v.blocked ? pc.red(`${v.blocked} blocked`) : ""}${v.blocked && v.degraded ? ", " : ""}${v.degraded ? pc.yellow(`${v.degraded} degraded`) : ""} — drift detected`;
  process.stdout.write(`  ${summary}\n`);
}

/** A ledger past this many lines is a harness release, not a detail — the
 * rest stays in --json. */
const LEDGER_LINES = 40;

function movedLine(m: Moved): string {
  const sign = m.change === "added" ? "+" : m.change === "removed" ? "-" : "~";
  const what =
    m.surface === "version"
      ? `version ${m.from} → ${m.name}`
      : `${m.surface}${m.where ? `(${m.where})` : ""} ${m.name}`;
  return `    ${pc.cyan(sign)} ${what}`;
}

function renderLedger(v: Verdict): void {
  const b = v.baseline!;
  if (b.moved.length === 0) {
    process.stdout.write(
      `  ${pc.dim("ledger")} ${pc.dim(`nothing undeclared moved since the baseline of ${b.recorded}`)}\n`,
    );
  } else {
    process.stdout.write(
      `  ${pc.cyan("moved")} since the baseline of ${b.recorded} — undeclared, not counted as drift:\n`,
    );
    for (const m of b.moved.slice(0, LEDGER_LINES)) {
      process.stdout.write(`${movedLine(m)}\n`);
    }
    if (b.moved.length > LEDGER_LINES) {
      process.stdout.write(
        `    ${pc.dim(`… ${b.moved.length - LEDGER_LINES} more — see --json`)}\n`,
      );
    }
  }
  if (b.untracked.length > 0) {
    process.stdout.write(
      `  ${pc.dim("ledger")} ${pc.dim(`not in the baseline yet: ${b.untracked.join(", ")} — record it again to track them`)}\n`,
    );
  }
}

function renderScan(v: Verdict): void {
  const s = v.scan!;
  const head = `${s.scanned} files in ${s.dir}${s.truncated ? " (stopped at the file limit)" : ""}`;
  if (s.undeclared.length === 0 && s.unused.length === 0) {
    process.stdout.write(
      `  ${pc.dim("scan")}  ${pc.dim(`${head}: everything the files use is declared, and everything declared is used`)}\n`,
    );
    return;
  }
  process.stdout.write(
    `  ${pc.cyan("scan")}  ${head}: ${s.undeclared.length} used but not declared, ${s.unused.length} declared but not found — not counted as drift:\n`,
  );
  const line = (sign: string, item: CoverageItem, where: string): string =>
    `    ${pc.cyan(sign)} ${item.kind} ${item.name} ${pc.dim(where)}`;
  const lines = [
    ...s.undeclared.map((u) =>
      line(
        "+",
        u,
        `${u.at[0] ?? ""}${u.at.length > 1 ? ` (+${u.at.length - 1} more)` : ""}`,
      ),
    ),
    ...s.unused.map((u) =>
      line(
        "-",
        u,
        "not in the scanned files — it may live elsewhere, such as a user's own settings",
      ),
    ),
  ];
  for (const l of lines.slice(0, LEDGER_LINES)) process.stdout.write(`${l}\n`);
  if (lines.length > LEDGER_LINES) {
    process.stdout.write(
      `    ${pc.dim(`… ${lines.length - LEDGER_LINES} more — see --json`)}\n`,
    );
  }
}

const program = new Command();
program
  .name("peirad")
  .description(
    "Contract-test agent integrations against the harness you actually have installed.",
  );

program
  .command("run", { isDefault: true })
  .description("run a doctor manifest and print a dated verdict")
  .option("-m, --manifest <file>", "manifest path", "peirad.json")
  .option(
    "-c, --config-dir <dir>",
    "base dir for relative file/glob probes (overrides the manifest)",
  )
  .option("--json", "emit the verdict as JSON")
  .option(
    "--record-baseline",
    "write the observed surface to the baseline file, to commit beside the manifest",
  )
  .option(
    "--baseline <file>",
    `baseline to compare against or record to (default: ${BASELINE_FILE} beside the manifest)`,
  )
  .option("--no-baseline", "skip the baseline comparison even if one exists")
  .option(
    "--live",
    "also drive the harness through one real turn in an isolated configuration directory (spends tokens)",
  )
  .option(
    "--coverage",
    "scan the project's own files for what they use that the manifest does not declare, and the reverse",
  )
  .option(
    "--scan-dir <dir>",
    "directory --coverage scans (default: the manifest's directory)",
  )
  .option("--live-ceiling <tokens>", "token ceiling for the live turn", "10000")
  .option(
    "--live-timeout <seconds>",
    "kill the live turn after this long",
    "180",
  )
  .action(
    (opts: {
      manifest: string;
      configDir?: string;
      json?: boolean;
      recordBaseline?: boolean;
      baseline?: string | false;
      live?: boolean;
      liveCeiling: string;
      liveTimeout: string;
      coverage?: boolean;
      scanDir?: string;
    }) => {
      const mfPath = path.resolve(opts.manifest);
      if (!fs.existsSync(mfPath)) {
        process.stderr.write(`peirad: manifest not found: ${opts.manifest}\n`);
        process.exit(2);
      }
      const manifest = loadManifest(mfPath);
      // Default relative probe paths to the manifest's own directory.
      const configDir =
        opts.configDir ?? manifest.configDir ?? path.dirname(mfPath);
      const date = new Date().toISOString().slice(0, 10);
      const ceiling = Number(opts.liveCeiling);
      const timeout = Number(opts.liveTimeout);
      if (
        opts.live &&
        !(
          Number.isFinite(ceiling) &&
          ceiling > 0 &&
          Number.isFinite(timeout) &&
          timeout > 0
        )
      ) {
        process.stderr.write(
          `peirad: --live-ceiling and --live-timeout must be positive numbers\n`,
        );
        process.exit(2);
      }
      let verdict: Verdict;
      try {
        verdict = runManifest(manifest, {
          configDir,
          date,
          live: opts.live ? { ceiling, timeoutMs: timeout * 1000 } : undefined,
        });
        // The ledger is opt-out once a baseline exists and opt-in to write;
        // either way it never touches the exit code below.
        if (opts.baseline !== false || opts.recordBaseline) {
          const named = typeof opts.baseline === "string";
          const file = named
            ? path.resolve(opts.baseline as string)
            : path.join(path.dirname(mfPath), BASELINE_FILE);
          verdict = runLedger(manifest, verdict, {
            configDir,
            file,
            label: path.relative(process.cwd(), file) || BASELINE_FILE,
            record: opts.recordBaseline === true,
            explicit: named,
            date,
          });
        }
        if (opts.coverage) {
          const dir = path.resolve(opts.scanDir ?? path.dirname(mfPath));
          verdict = runScanCoverage(manifest, verdict, {
            dir,
            label: path.relative(process.cwd(), dir) || ".",
          });
        }
      } catch (e) {
        process.stderr.write(`peirad: ${String(e)}\n`);
        process.exit(2);
      }
      if (opts.json)
        process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
      else render(verdict);
      process.exit(verdict.ok ? 0 : 1);
    },
  );

program
  .command("validate")
  .description(
    "read a manifest strictly — unknown fields, wrong shapes, probes that declare nothing — without running anything",
  )
  .option("-m, --manifest <file>", "manifest path", "peirad.json")
  .option(
    "-c, --config-dir <dir>",
    "base dir for relative file and script paths (overrides the manifest)",
  )
  .option("--json", "emit the report as JSON")
  .action((opts: { manifest: string; configDir?: string; json?: boolean }) => {
    const file = path.resolve(opts.manifest);
    const label = path.relative(process.cwd(), file) || opts.manifest;
    const report = validateManifestFile(file, { configDir: opts.configDir });
    const code = !report.ok ? 2 : report.errors.length > 0 ? 1 : 0;
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ ...report, file: label }, null, 2)}\n`,
      );
      process.exit(code);
    }
    if (!report.ok) {
      process.stderr.write(`peirad: ${label}: ${report.fatal}\n`);
      process.exit(code);
    }
    const count = (n: number, one: string): string =>
      `${n} ${one}${n === 1 ? "" : "s"}`;
    const status =
      report.errors.length > 0
        ? pc.red(count(report.errors.length, "error"))
        : pc.green("valid");
    const warned =
      report.warnings.length > 0
        ? `, ${pc.yellow(count(report.warnings.length, "warning"))}`
        : "";
    process.stdout.write(
      `${pc.bold(label)} — ${status}${warned} · ${count(report.probes.length, "probe")} · ${pc.dim(`peirad ${ENGINE_VERSION}`)}\n`,
    );
    const where = (f: { path: string; line: number | null }): string =>
      `${f.path}${f.line ? ` (${label}:${f.line})` : ""}`;
    for (const e of report.errors) {
      process.stdout.write(`  ${pc.red("ERR ")}  ${where(e)}: ${e.message}\n`);
    }
    for (const w of report.warnings) {
      process.stdout.write(
        `  ${pc.yellow("WARN")}  ${where(w)}: ${w.message}\n`,
      );
    }
    for (const probe of report.probes) {
      process.stdout.write(
        `  ${pc.dim(`probes[${probe.index}]`)} ${probe.type}${probe.resolved.length > 0 ? pc.dim(` → ${probe.resolved.join(", ")}`) : ""}\n`,
      );
    }
    process.exit(code);
  });

program
  .command("init")
  .description(
    "draft a manifest from the project's own files — a deterministic scan, no model",
  )
  .option("-d, --dir <dir>", "project directory to scan", ".")
  .option(
    "--harness <name>",
    "harness to draft for (default: the one the project uses most)",
  )
  .option(
    "-o, --output <file>",
    "write the draft to this file instead of printing it (never overwrites)",
  )
  .action((opts: { dir: string; harness?: string; output?: string }) => {
    const dir = path.resolve(opts.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      process.stderr.write(`peirad: not a directory: ${opts.dir}\n`);
      process.exit(2);
    }
    const scan = scanProject(dir);
    const harness = opts.harness ?? likelyHarness(scan);
    if (!harness) {
      process.stderr.write(
        `peirad: scanned ${scan.scanned} files and found no harness invocation or hook — pass --harness to draft anyway\n`,
      );
      process.exit(2);
    }
    const draft = draftManifest(scan, harness, path.basename(dir));
    const text = `${JSON.stringify(draft, null, 2)}\n`;
    const summary = `drafted ${draft.probes.length} probes for ${harness} from ${scan.scanned} files${scan.truncated ? " (stopped at the file limit)" : ""} — each carries _from, the file and line behind it; review before relying on it`;
    if (opts.output) {
      const out = path.resolve(opts.output);
      if (fs.existsSync(out)) {
        process.stderr.write(
          `peirad: ${opts.output} exists — refusing to overwrite it\n`,
        );
        process.exit(2);
      }
      fs.writeFileSync(out, text);
      process.stderr.write(`${summary}\nwrote ${opts.output}\n`);
    } else {
      process.stdout.write(text);
      process.stderr.write(`${summary}\n`);
    }
    process.exit(0);
  });

program
  .command("triage")
  .description("pre-assess an alarm against a rubric (machine, unverified)")
  .requiredOption(
    "--alarm <file|->",
    "alarm text to assess (file, or - for stdin)",
  )
  .requiredOption(
    "--rubric <file|changelog>",
    "rubric markdown file, or 'changelog' to derive it from the manifest",
  )
  .option(
    "--manifest <file>",
    "manifest path (harness + changelog rubric)",
    "peirad.json",
  )
  .option("--format <md|json>", "output format", "md")
  .option("--timeout <seconds>", "harness call timeout in seconds", "120")
  .option(
    "--usage-log <file>",
    "append one JSON row per call (tokens, model, cost) to this file",
  )
  .action(
    (opts: {
      alarm: string;
      rubric: string;
      manifest: string;
      format: string;
      timeout: string;
      usageLog?: string;
    }) => {
      process.exit(triageCommand(opts));
    },
  );

program
  .command("precedent")
  .description(
    "match a queue entry to prior rulings and emit the resolution to apply (read-only)",
  )
  .requiredOption(
    "--entry <file>",
    "queue entry (markdown) to find precedent for",
  )
  .requiredOption(
    "--ledger <file>",
    "decisions ledger (markdown) with D-entries",
  )
  .option(
    "--resolved <dir...>",
    "directories of resolved entries to search for siblings",
  )
  .option(
    "--rail-words <file>",
    "extra whole-word keywords for the guarded rail, one per line (a fleet's own vocabulary stays in the fleet)",
  )
  .option("--json", "emit the precedent as JSON")
  .action(
    (opts: {
      entry: string;
      ledger: string;
      resolved?: string[];
      railWords?: string;
      json?: boolean;
    }) => {
      process.exit(precedentCommand(opts));
    },
  );

program.parse();
