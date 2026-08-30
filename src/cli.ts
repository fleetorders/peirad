import { Command } from "commander";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { loadManifest } from "./manifest.js";
import { runManifest, type Verdict } from "./doctor.js";
import { triageCommand } from "./triage.js";

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
    `${pc.bold(v.name)} — harness ${v.harness} (${v.profile}) ${pc.dim(v.version)} · ${v.date}\n`,
  );
  for (const r of v.results) {
    process.stdout.write(`  ${mark(r.status)}  ${r.probe}: ${r.detail}\n`);
  }
  const summary = v.ok
    ? pc.green("PASS — integration holds")
    : `${v.blocked ? pc.red(`${v.blocked} blocked`) : ""}${v.blocked && v.degraded ? ", " : ""}${v.degraded ? pc.yellow(`${v.degraded} degraded`) : ""} — drift detected`;
  process.stdout.write(`  ${summary}\n`);
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
  .action((opts: { manifest: string; configDir?: string; json?: boolean }) => {
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
    let verdict: Verdict;
    try {
      verdict = runManifest(manifest, { configDir, date });
    } catch (e) {
      process.stderr.write(`peirad: ${String(e)}\n`);
      process.exit(2);
    }
    if (opts.json)
      process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    else render(verdict);
    process.exit(verdict.ok ? 0 : 1);
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

program.parse();
