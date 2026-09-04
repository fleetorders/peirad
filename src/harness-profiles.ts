/**
 * Harness profiles — how to TALK to a headless agent CLI and how to READ its
 * reply. Every CLI family wraps "one prompt in, one answer out" differently
 * (flags, event streams, envelope shapes), so the invocation and the parsing
 * travel together as data on a profile. A manifest picks one by name
 * (`harnessProfile`) or lets the harness name decide; `promptArgs`/`outputArgs`
 * override the argv templates for a CLI the profiles do not know.
 */
import type { Manifest } from "./manifest.js";

/**
 * Token/cost accounting the harness reported alongside its reply, normalized
 * across the profile envelope spellings. `null` fields mean the harness
 * reported nothing for them.
 */
export interface HarnessUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_usd: number | null;
}

export interface HarnessReply {
  /** The reply text the model produced, already unwrapped from the envelope. */
  reply: string;
  /** What the harness said the call cost, or null if it reported nothing. */
  usage: HarnessUsage | null;
}

export type ProfileParse =
  | { ok: true; value: HarnessReply }
  | { ok: false; reason: string };

/**
 * A profile's `{prompt}` placeholder must be a standalone argv element — the
 * prompt text is inserted as that one argument, never spliced into a flag.
 */
export const PROMPT_PLACEHOLDER = "{prompt}";

export interface HarnessProfile {
  /** Profile name as a manifest writes it ("claude", "codex"). */
  name: string;
  /** Argv that delivers the prompt; one element is `{prompt}`. */
  promptArgs: string[];
  /**
   * Argv appended after `promptArgs` that asks the harness for
   * machine-readable output.
   */
  outputArgs: string[];
  /** Args whose `--help` output a `flag-accepted` probe checks flags against. */
  helpArgs: string[];
  /**
   * Probe types that cannot apply to this harness family. A manifest that
   * declares one gets an `n/a` line naming the profile — never a pass.
   */
  inapplicableProbes: string[];
  /** Turn the harness's stdout into the reply text + usage. */
  parseOutput(stdout: string): ProfileParse;
}

export function parseJsonLenient(text: string): unknown {
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
 * Pull the usage block out of a single-object envelope. Accepts the common
 * field spellings (input/output tokens, cache read/write, model, cost);
 * anything absent counts as 0 / null. Returns null only when the envelope
 * carries no usage object at all.
 */
function parseEnvelopeUsage(envelope: unknown): HarnessUsage | null {
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

/** The `-p <prompt> --output-format json` convention: one JSON envelope on stdout. */
const claudeProfile: HarnessProfile = {
  name: "claude",
  promptArgs: ["-p", PROMPT_PLACEHOLDER],
  outputArgs: ["--output-format", "json"],
  helpArgs: ["--help"],
  inapplicableProbes: [],
  parseOutput(stdout) {
    let envelope: unknown;
    try {
      envelope = parseJsonLenient(stdout);
    } catch {
      return { ok: false, reason: "harness output was not JSON" };
    }
    const reply =
      envelope &&
      typeof envelope === "object" &&
      "result" in envelope &&
      typeof (envelope as { result: unknown }).result === "string"
        ? (envelope as { result: string }).result
        : JSON.stringify(envelope);
    return { ok: true, value: { reply, usage: parseEnvelopeUsage(envelope) } };
  },
};

/**
 * `codex exec`: the prompt is a positional after the subcommand, `--json`
 * prints one JSON event per line, and the final agent message plus the
 * turn's token counts are read off that stream. `--sandbox read-only` keeps
 * the assessment from touching the filesystem; `--skip-git-repo-check`
 * lets it run outside a repository.
 */
const codexProfile: HarnessProfile = {
  name: "codex",
  promptArgs: [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    PROMPT_PLACEHOLDER,
  ],
  outputArgs: ["--json"],
  helpArgs: ["exec", "--help"],
  // Codex config is TOML (~/.codex/config.toml) and has no JSON settings
  // hooks, so the settings-file probes have no counterpart there.
  inapplicableProbes: ["config-key", "hook-registered"],
  parseOutput(stdout) {
    let reply: string | null = null;
    let usage: HarnessUsage | null = null;
    let model: string | null = null;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        // An unparseable line is noise around the stream, not the stream.
        continue;
      }
      if (!ev || typeof ev !== "object") continue;
      const e = ev as Record<string, unknown>;
      if (typeof e.model === "string" && e.model) model = e.model;
      if (e.type === "item.completed") {
        const item = e.item;
        if (
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "agent_message" &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          reply = (item as { text: string }).text;
        }
      } else if (e.type === "turn.completed" && e.usage) {
        const u = e.usage as Record<string, unknown>;
        const num = (v: unknown): number =>
          typeof v === "number" && Number.isFinite(v) ? v : 0;
        usage = {
          input_tokens: num(u.input_tokens),
          cache_read_tokens: num(u.cached_input_tokens),
          cache_write_tokens: num(u.cache_write_input_tokens),
          output_tokens: num(u.output_tokens),
          model,
          cost_usd: null,
        };
      }
    }
    if (reply === null) {
      return { ok: false, reason: "harness output had no agent message" };
    }
    return { ok: true, value: { reply, usage } };
  },
};

const PROFILES: Record<string, HarnessProfile> = {
  claude: claudeProfile,
  codex: codexProfile,
};

/** Profile names a manifest may write — for errors and docs. */
export function profileNames(): string[] {
  return Object.keys(PROFILES);
}

/**
 * Pick the profile for a manifest: explicit `harnessProfile` wins, else the
 * harness name selects a known one, else the `-p` convention (the de-facto
 * default for CLIs peirad has no profile for yet). `promptArgs`/`outputArgs`
 * from the manifest replace the profile's argv templates.
 */
export function resolveProfile(
  harness: string,
  harnessProfile?: string,
  overrides?: Pick<Manifest, "promptArgs" | "outputArgs">,
): HarnessProfile {
  const name = harnessProfile ?? (harness in PROFILES ? harness : "claude");
  const base = PROFILES[name];
  if (!base) {
    throw new Error(
      `unknown harnessProfile "${name}" (known: ${profileNames().join(", ")})`,
    );
  }
  const promptArgs = overrides?.promptArgs ?? base.promptArgs;
  const outputArgs = overrides?.outputArgs ?? base.outputArgs;
  if (!promptArgs.includes(PROMPT_PLACEHOLDER)) {
    throw new Error(
      `promptArgs must contain the ${PROMPT_PLACEHOLDER} placeholder`,
    );
  }
  return { ...base, promptArgs, outputArgs };
}

/** Expand a profile argv template: the `{prompt}` element becomes the prompt. */
export function expandArgs(template: string[], prompt: string): string[] {
  return template.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a));
}
