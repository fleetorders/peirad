import { Command } from "commander";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { loadManifest } from "./manifest.js";
import { runLedger, runManifest, type Verdict } from "./doctor.js";
import { BASELINE_FILE, type Moved } from "./baseline.js";
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
  for (const note of v.notes) {
    process.stdout.write(`  ${pc.dim("note")}  ${pc.dim(note)}\n`);
  }
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
