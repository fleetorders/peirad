import { Command } from "commander";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { loadManifest } from "./manifest.js";
import { runManifest, type Verdict } from "./doctor.js";

function render(v: Verdict): void {
  const mark = (s: string): string =>
    s === "pass"
      ? pc.green("ok  ")
      : s === "degraded"
        ? pc.yellow("DEGR")
        : pc.red("BLOCK");
  process.stdout.write(
    `${pc.bold(v.name)} — harness ${v.harness} ${pc.dim(v.version)} · ${v.date}\n`,
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
  .name("dokimd")
  .description(
    "Contract-test agent integrations against the harness you actually have installed.",
  );

program
  .command("run", { isDefault: true })
  .description("run a doctor manifest and print a dated verdict")
  .option("-m, --manifest <file>", "manifest path", "dokimd.json")
  .option(
    "-c, --config-dir <dir>",
    "base dir for relative file/glob probes (overrides the manifest)",
  )
  .option("--json", "emit the verdict as JSON")
  .action((opts: { manifest: string; configDir?: string; json?: boolean }) => {
    const mfPath = path.resolve(opts.manifest);
    if (!fs.existsSync(mfPath)) {
      process.stderr.write(`dokimd: manifest not found: ${opts.manifest}\n`);
      process.exit(2);
    }
    const manifest = loadManifest(mfPath);
    // Default relative probe paths to the manifest's own directory.
    const configDir =
      opts.configDir ?? manifest.configDir ?? path.dirname(mfPath);
    const date = new Date().toISOString().slice(0, 10);
    const verdict = runManifest(manifest, { configDir, date });
    if (opts.json)
      process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    else render(verdict);
    process.exit(verdict.ok ? 0 : 1);
  });

program.parse();
