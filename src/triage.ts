/**
 * `peirad triage` — a machine pre-assessment of an alarm against a rubric, for
 * the person who has to decide what (if anything) to do about it.
 *
 * `run` tells you THAT something drifted; triage asks whether it MATTERS. The
 * model call goes through the manifest's own harness, headless — the same
 * binary the probes exercise — and three guards keep the result safe to act
 * around:
 *
 * - the quote guard drops any reasoning point whose quote is not found
 *   verbatim in the alarm, so evidence that cannot be traced cannot survive;
 * - the command never edits and never closes anything — it prints, and the
 *   "(machine, unverified)" label is in the heading by construction;
 * - a failed or timed-out harness call degrades loudly (exit 2) instead of
 *   guessing.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadManifest, type Manifest } from "./manifest.js";
import { harnessVersion } from "./probes.js";

export type TriageVerdict = "no-action" | "action" | "owner-only";
export type TriageConfidence = "low" | "medium" | "high";

export interface ReasoningPoint {
  quote: string;
  point: string;
}

/**
 * Token/cost accounting the harness reported alongside its reply, normalized
 * across the common envelope spellings. `null` when the harness reported none.
 */
export interface HarnessUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_usd: number | null;
}

export interface TriageResult {
  verdict: TriageVerdict;
  confidence: TriageConfidence;
  reasoning: ReasoningPoint[];
  draft: string;
  /** Reasoning points dropped by the quote guard. */
  dropped: number;
  assessed_at: string;
  harness: string;
  harness_version: string;
  /** What the harness reported the call cost, or null if it reported nothing. */
  usage: HarnessUsage | null;
  /** The rubric that was applied: "changelog" or the file path as given. */
  rubric: string;
}

export type TriageOutcome =
  | { ok: true; result: TriageResult }
  | { ok: false; reason: string };

/** Fixed frame around any rubric — the rubric file is inserted verbatim. */
const FRAME =
  "You are assessing an automated alarm. Rubric follows. Answer only from the alarm text and the rubric.";

const ANSWER_SPEC = `Answer as JSON only, no prose outside it:
{"verdict":"...","confidence":"...","reasoning":[{"quote":"...","point":"..."}],"draft":"..."}
- verdict: "no-action" (the alarm does not touch anything the rubric declares), "action" (it does, and a routine fix exists), or "owner-only" (it does, and the call is a judgement a person must make).
- confidence: "low", "medium" or "high".
- reasoning: one point per line of evidence; "quote" is a line copied verbatim from the alarm, "point" says why it matters in one line. Every point must rest on a quoted line.
- draft: 2-6 lines a human could paste as the closing note, or "none — action needed: ...".`;

function buildPrompt(alarm: string, rubric: string): string {
  return [
    FRAME,
    "",
    rubric,
    "",
    "--- alarm text follows ---",
    alarm,
    "--- end of alarm text ---",
    "",
    ANSWER_SPEC,
  ].join("\n");
}

/** The built-in rubric: derive "what did I declare a dependency on?" from the manifest. */
export function buildChangelogRubric(manifest: Manifest): string {
  const lines: string[] = [
    "# Rubric: changelog",
    "",
    `An integration is contract-tested against harness \`${manifest.harness}\` via a peirad manifest. The manifest declares exactly these dependencies:`,
    "",
  ];
  let declared = 0;
  for (const p of manifest.probes) {
    if (p.type === "flag-accepted") {
      lines.push(`- CLI flags that must keep parsing: ${p.flags.join(", ")}`);
      declared++;
    } else if (p.type === "config-key") {
      lines.push(
        `- Config keys in ${p.file} that must keep existing: ${p.keys.join(", ")}`,
      );
      declared++;
    } else if (p.type === "hook-registered") {
      lines.push(
        `- A hook on event ${p.event} matching "${p.match}" must stay registered`,
      );
      declared++;
    } else if (p.type === "transcript-field") {
      lines.push(
        `- Transcript fields (${p.glob}) that tools still read: ${p.fields.join(", ")}`,
      );
      declared++;
    }
  }
  if (declared === 0) {
    lines.push(
      "- The manifest declares no flags, config keys, hooks or transcript fields.",
    );
  }
  lines.push(
    "",
    "The alarm is a changelog excerpt. Assess whether it describes a change to any declared dependency above.",
  );
  return lines.join("\n");
}

export interface AssessOptions {
  alarm: string;
  /** Rubric body (markdown) — a file's content or the derived changelog rubric. */
  rubric: string;
  /** Harness binary to call headless (already resolved, incl. PEIRAD_HARNESS). */
  harness: string;
  versionArgs?: string[];
  timeoutSeconds: number;
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Models (and harnesses) sometimes wrap the object in prose or a fence.
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last <= first) throw new Error("no JSON object found");
    return JSON.parse(text.slice(first, last + 1));
  }
}

/**
 * Pull the usage block out of a headless-reply envelope. Accepts the common
 * field spellings (input/output tokens, cache read/write, model, cost);
 * anything absent counts as 0 / null. Returns null only when the envelope
 * carries no usage object at all.
 */
function parseUsage(envelope: unknown): HarnessUsage | null {
  if (!envelope || typeof envelope !== "object") return null;
  const e = envelope as Record<string, unknown>;
  const u = e.usage;
  if (!u || typeof u !== "object") return null;
  const block = u as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const model =
    typeof e.model === "string" && e.model
      ? e.model
      : typeof block.model === "string" && block.model
        ? block.model
        : null;
  const cost =
    typeof e.total_cost_usd === "number"
      ? e.total_cost_usd
      : typeof e.cost_usd === "number"
        ? e.cost_usd
        : typeof block.cost_usd === "number"
          ? block.cost_usd
          : null;
  return {
    input_tokens: num(block.input_tokens),
    cache_read_tokens: num(
      block.cache_read_input_tokens ?? block.cache_read_tokens,
    ),
    cache_write_tokens: num(
      block.cache_creation_input_tokens ?? block.cache_write_tokens,
    ),
    output_tokens: num(block.output_tokens),
    model,
    cost_usd: cost,
  };
}

export function assessAlarm(opts: AssessOptions): TriageOutcome {
  const { alarm, rubric, harness, timeoutSeconds } = opts;
  const version = harnessVersion(harness, opts.versionArgs ?? ["--version"]);

  const r = spawnSync(
    harness,
    ["-p", buildPrompt(alarm, rubric), "--output-format", "json"],
    { encoding: "utf8", timeout: timeoutSeconds * 1000 },
  );
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    const why =
      e.code === "ETIMEDOUT"
        ? `harness call timed out after ${timeoutSeconds}s`
        : `harness "${harness}" not runnable (${e.code ?? e.message})`;
    return { ok: false, reason: why };
  }
  if (r.status !== 0) {
    return { ok: false, reason: `harness exited ${r.status}` };
  }
  let envelope: unknown;
  try {
    envelope = parseJsonLenient(r.stdout ?? "");
  } catch {
    return { ok: false, reason: "harness output was not JSON" };
  }
  const usage = parseUsage(envelope);
  // Headless harnesses wrap the reply text in a result field; accept the
  // assessment object itself too, for harnesses that emit it directly.
  const reply =
    envelope &&
    typeof envelope === "object" &&
    "result" in envelope &&
    typeof (envelope as { result: unknown }).result === "string"
      ? (envelope as { result: string }).result
      : JSON.stringify(envelope);
  let assessment: unknown;
  try {
    assessment = parseJsonLenient(reply);
  } catch {
    return { ok: false, reason: "model reply was not valid JSON" };
  }
  const a = (assessment ?? {}) as Record<string, unknown>;
  const verdict = a.verdict;
  const confidence = a.confidence;
  if (
    (verdict !== "no-action" &&
      verdict !== "action" &&
      verdict !== "owner-only") ||
    (confidence !== "low" && confidence !== "medium" && confidence !== "high")
  ) {
    return {
      ok: false,
      reason: "model reply missing a valid verdict or confidence",
    };
  }

  // Quote guard: a reasoning point survives only if its quote is found
  // verbatim in the alarm. Unquotable points are dropped and counted.
  const rawPoints = Array.isArray(a.reasoning) ? a.reasoning : [];
  const kept: ReasoningPoint[] = [];
  let dropped = 0;
  for (const raw of rawPoints) {
    const q =
      raw &&
      typeof raw === "object" &&
      typeof (raw as { quote?: unknown }).quote === "string"
        ? ((raw as { quote: string }).quote.trim() as string)
        : "";
    if (q.length > 0 && alarm.includes(q)) {
      const p =
        typeof (raw as { point?: unknown }).point === "string"
          ? ((raw as { point: string }).point as string).trim()
          : "";
      kept.push({ quote: q, point: p });
    } else {
      dropped++;
    }
  }

  return {
    ok: true,
    result: {
      verdict,
      confidence,
      reasoning: kept,
      draft: typeof a.draft === "string" ? a.draft : "none",
      dropped,
      assessed_at: new Date().toISOString(),
      harness,
      harness_version: version,
      usage,
      rubric: "",
    },
  };
}

/** One trailing `usage:` line — what the harness said the call cost it. */
export function renderUsageLine(u: HarnessUsage | null): string {
  if (!u) return "usage: not reported by the harness";
  const cached = u.cache_read_tokens + u.cache_write_tokens;
  const parts = [
    `in ${u.input_tokens} / cached ${cached} / out ${u.output_tokens} tokens`,
  ];
  if (u.model) parts.push(`model ${u.model}`);
  if (u.cost_usd !== null) parts.push(`cost $${u.cost_usd}`);
  return `usage: ${parts.join(" · ")}`;
}

export function renderTriageMarkdown(t: TriageResult): string {
  const lines: string[] = [
    "## Pre-assessment (machine, unverified)",
    `Verdict: ${t.verdict}`,
    `Confidence: ${t.confidence}`,
    "Reasoning:",
  ];
  if (t.reasoning.length === 0) {
    lines.push("- (no quotable reasoning points)");
  } else {
    for (const p of t.reasoning) {
      lines.push(p.point ? `- ${p.point} — "${p.quote}"` : `- "${p.quote}"`);
    }
  }
  lines.push("Draft resolution:");
  lines.push(t.draft);
  if (t.dropped > 0) {
    lines.push(`dropped: ${t.dropped} unquotable point(s)`);
  }
  lines.push(renderUsageLine(t.usage));
  return lines.join("\n") + "\n";
}

export function renderTriageJson(t: TriageResult): string {
  return JSON.stringify(t, null, 2) + "\n";
}

export interface TriageCliOptions {
  alarm: string;
  rubric: string;
  manifest: string;
  format: string;
  timeout: string;
  /** Optional JSONL file to append one machine-readable row per call to. */
  usageLog?: string;
}

/**
 * The `peirad triage` command body: resolve inputs, assess, print.
 * Returns the process exit code (0 on any verdict, 2 when unavailable).
 */
export function triageCommand(opts: TriageCliOptions): number {
  if (opts.format !== "md" && opts.format !== "json") {
    process.stderr.write(
      `peirad: unknown format "${opts.format}" (md or json)\n`,
    );
    return 2;
  }
  const timeoutSeconds = Number.parseInt(opts.timeout, 10);
  if (!(timeoutSeconds > 0)) {
    process.stderr.write(
      `peirad: --timeout must be a positive number of seconds\n`,
    );
    return 2;
  }
  let alarm: string;
  try {
    alarm =
      opts.alarm === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(opts.alarm, "utf8");
  } catch {
    process.stderr.write(`peirad: alarm not found: ${opts.alarm}\n`);
    return 2;
  }
  const mfPath = path.resolve(opts.manifest);
  if (!fs.existsSync(mfPath)) {
    process.stderr.write(`peirad: manifest not found: ${opts.manifest}\n`);
    return 2;
  }
  let manifest: Manifest;
  try {
    manifest = loadManifest(mfPath);
  } catch (e) {
    process.stderr.write(`peirad: ${String(e)}\n`);
    return 2;
  }
  let rubricBody: string;
  if (opts.rubric === "changelog") {
    rubricBody = buildChangelogRubric(manifest);
  } else {
    try {
      rubricBody = fs.readFileSync(opts.rubric, "utf8");
    } catch {
      process.stderr.write(`peirad: rubric not found: ${opts.rubric}\n`);
      return 2;
    }
  }
  const harness = process.env.PEIRAD_HARNESS || manifest.harness;
  const outcome = assessAlarm({
    alarm,
    rubric: rubricBody,
    harness,
    versionArgs: manifest.versionArgs,
    timeoutSeconds,
  });
  if (!outcome.ok) {
    process.stderr.write(
      `peirad: pre-assessment unavailable: ${outcome.reason}\n`,
    );
    return 2;
  }
  const result: TriageResult = { ...outcome.result, rubric: opts.rubric };
  if (opts.usageLog) {
    const row = {
      ts: result.assessed_at,
      harness: result.harness,
      harness_version: result.harness_version,
      rubric: result.rubric,
      verdict: result.verdict,
      usage: result.usage,
    };
    try {
      fs.appendFileSync(opts.usageLog, JSON.stringify(row) + "\n");
    } catch (e) {
      // A log the caller asked for and did not get is a silent metering gap —
      // fail the command rather than print an unaccounted assessment.
      process.stderr.write(
        `peirad: cannot write usage log ${opts.usageLog}: ${String(e)}\n`,
      );
      return 2;
    }
  }
  process.stdout.write(
    opts.format === "json"
      ? renderTriageJson(result)
      : renderTriageMarkdown(result),
  );
  return 0;
}
