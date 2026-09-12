/**
 * Harness profiles — how to TALK to a headless agent CLI and how to READ its
 * reply. Every CLI family wraps "one prompt in, one answer out" differently
 * (flags, event streams, envelope shapes), so the invocation and the parsing
 * travel together as data on a profile. A manifest picks one by name
 * (`harnessProfile`) or lets the harness name decide; `promptArgs`/`outputArgs`
 * override the argv templates for a CLI the profiles do not know, and
 * `settingsLayers` overrides where that CLI keeps its settings stack.
 */
import os from "node:os";
import path from "node:path";
import type { Manifest } from "./manifest.js";
import type { HarnessReport } from "./reports.js";
import type { LiveProfile } from "./live.js";

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

/**
 * One file in a harness's settings stack. `path` is a template: `{home}` and
 * `{configDir}` expand at run time, so nothing here names a particular
 * machine. A layer may spell its path differently per platform.
 */
export interface SettingsLayer {
  /** How the layer is named in a verdict line ("user", "project", "managed"). */
  name: string;
  path: string;
  /** Overrides `path` on the platforms it names (keys are `process.platform`). */
  platformPaths?: Record<string, string>;
}

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
  /**
   * The settings files this harness reads, LOWEST precedence first. A probe
   * with `scope: "effective"` merges them in this order before it looks, so a
   * setting is judged where the harness actually reads it rather than in
   * whichever single file a manifest happened to name. An empty stack means
   * the profile declares none, and such a probe reports `n/a`.
   */
  settingsLayers: SettingsLayer[];
  /**
   * How values found in more than one layer combine. `concat` for a harness
   * that runs every registered hook whatever scope declared it; `override`
   * where the nearest scope replaces the others outright.
   */
  settingsArrays: ArrayMerge;
  /**
   * Reports this harness produces about itself, by name, and how to read
   * each — the facts a `harness-reports` probe asserts come from here. A
   * report the harness does not have is simply not declared.
   */
  reports: Record<string, HarnessReport>;
  /**
   * Dotted path to the block of environment variables the harness's own
   * settings declare and applies to its sessions — absent where the harness
   * has no such block in a file peirad can read.
   */
  settingsEnv?: string;
  /**
   * How to drive this harness through one isolated turn for `--live`: the
   * variable that relocates its configuration, a no-cost login check, where
   * fixture hooks and the transcript go. Absent, a live run reports `n/a`.
   */
  live?: LiveProfile;
  /** Turn the harness's stdout into the reply text + usage. */
  parseOutput(stdout: string): ProfileParse;
}

/** How a harness combines list values found in more than one settings layer. */
export type ArrayMerge = "concat" | "override";

/** The harness's configuration directory as the harness itself resolves it:
 * the variable that relocates it (profile data) wins when set, else the
 * default with `{home}` expanded. The settings stack and the live run must
 * agree on where this is, or a probe can report a passing setting from a
 * configuration the harness never loads. */
export function harnessConfigDir(
  live: LiveProfile,
  env: NodeJS.ProcessEnv,
): string {
  const fromEnv = env[live.configDir.env];
  return path.resolve(
    fromEnv && fromEnv.length > 0
      ? fromEnv
      : live.configDir.default.replace(/\{home\}/g, os.homedir()),
  );
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
  // Lowest precedence first: the user's own settings, then the project's,
  // then the local override beside it, then the machine policy file an
  // administrator controls. Hook lists JOIN across scopes — every registered
  // hook runs, whichever file declared it — so a hook that merely moved scope
  // is not drift. The user layer lives in the harness's own configuration
  // directory, relocation variable honoured, exactly where the harness reads
  // it (`{userConfigDir}`).
  settingsLayers: [
    { name: "user", path: "{userConfigDir}/settings.json" },
    { name: "project", path: "{configDir}/.claude/settings.json" },
    { name: "local", path: "{configDir}/.claude/settings.local.json" },
    {
      name: "managed",
      path: "/etc/claude-code/managed-settings.json",
      platformPaths: {
        darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
        win32: "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
      },
    },
  ],
  settingsArrays: "concat",
  // Both reports print text, so each line is read with a pattern. The server
  // list health-checks approved servers as it prints them; "No MCP servers
  // configured" is its valid empty answer, not a changed shape.
  reports: {
    mcp: {
      args: ["mcp", "list"],
      format: "lines",
      pattern:
        "^(?<name>\\S.*?): (?<target>.*?) - (?<mark>\\S+) (?<status>.+)$",
      emptyPattern: "No MCP servers configured",
    },
    doctor: {
      args: ["doctor"],
      format: "lines",
      pattern: "^(?<key>[A-Z][^:]*): (?<value>.+)$",
    },
  },
  // Variables under `env` in any settings layer are applied to the session,
  // over the environment the harness was started in.
  settingsEnv: "env",
  // The turn runs on the user's own configuration and login. `--restricted`
  // ignores the user, project and local settings files while `--settings`
  // still applies, and `--strict-mcp-config` drops MCP servers; the fixture
  // hooks arrive in that separate settings file. The transcript is named by
  // the session id the JSON envelope reports.
  live: {
    authCheck: { args: ["auth", "status"], loggedIn: '"loggedIn":\\s*true' },
    hooksOverlay: { kind: "settings-file", args: ["--settings", "{file}"] },
    turnArgs: ["--restricted", "--strict-mcp-config"],
    toolEvents: ["PreToolUse", "PostToolUse"],
    toolArgs: ["--tools", "Bash", "--allowedTools", "Bash(true)"],
    plainEvents: ["SessionStart", "UserPromptSubmit", "Stop"],
    plainPrompt: "Reply with the single word: done",
    toolPrompt:
      "Use the Bash tool to run the command `true`, then reply with the single word: done",
    sessionId: { field: "session_id" },
    configDir: { env: "CLAUDE_CONFIG_DIR", default: "{home}/.claude" },
    transcript: "projects/*/{session}.jsonl",
    removeSession: { kind: "file", removeEmptyParent: true },
  },
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
  // Codex keeps its hooks in a JSON file (`hooks.json` beside its config) in
  // the same `hooks.<Event>[].hooks[].command` shape the settings probes
  // already read, so `config-key` and `hook-registered` apply — a manifest
  // points `file` at that JSON. Only `config.toml` (TOML) is out of reach.
  inapplicableProbes: [],
  // One JSON layer, in the user's own configuration directory — the same
  // place the live run resolves, relocation variable honoured. A
  // single-layer stack still answers the question a probe with `scope:
  // "effective"` asks — it just answers it with one file, and says so.
  settingsLayers: [{ name: "user", path: "{userConfigDir}/hooks.json" }],
  settingsArrays: "concat",
  // Both reports have a JSON form. The doctor keys its checks by id, so the
  // records are that object's values; each carries its own `id`.
  reports: {
    mcp: { args: ["mcp", "list", "--json"], format: "json" },
    doctor: { args: ["doctor", "--json"], format: "json", records: "checks" },
    "doctor-summary": { args: ["doctor", "--json"], format: "json" },
  },
  // No switch sets the user's hooks file aside, so the fixture hooks arrive as
  // a command-line config override and the user's own config still loads.
  // Overlay hooks have no recorded trust, so the turn bypasses hook trust for
  // this one invocation. Sessions are also indexed outside their files, so
  // they are removed through the harness's own delete command.
  live: {
    authCheck: { args: ["login", "status"], loggedIn: "^Logged in" },
    hooksOverlay: { kind: "config-override", args: ["-c", "{value}"] },
    turnArgs: ["--dangerously-bypass-hook-trust"],
    toolEvents: ["PreToolUse", "PostToolUse"],
    toolArgs: [],
    plainEvents: ["UserPromptSubmit", "Stop"],
    plainPrompt: "Reply with the single word: done",
    toolPrompt:
      "Run the shell command `true`, then reply with the single word: done",
    sessionId: { event: "thread.started", field: "thread_id" },
    configDir: { env: "CODEX_HOME", default: "{home}/.codex" },
    transcript: "sessions/**/rollout-*-{session}.jsonl",
    removeSession: {
      kind: "command",
      args: ["delete", "--force", "{session}"],
    },
  },
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
        // This stream counts cached tokens inside input_tokens; normalised so
        // input_tokens is the uncached part, as the other profiles report it —
        // otherwise a total adds the cache twice.
        const cached = num(u.cached_input_tokens);
        usage = {
          input_tokens: Math.max(0, num(u.input_tokens) - cached),
          cache_read_tokens: cached,
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
  overrides?: Pick<
    Manifest,
    | "promptArgs"
    | "outputArgs"
    | "settingsLayers"
    | "settingsArrays"
    | "reports"
    | "settingsEnv"
  >,
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
  return {
    ...base,
    promptArgs,
    outputArgs,
    settingsLayers: overrides?.settingsLayers ?? base.settingsLayers,
    settingsArrays: overrides?.settingsArrays ?? base.settingsArrays,
    reports: { ...base.reports, ...(overrides?.reports ?? {}) },
    settingsEnv: overrides?.settingsEnv ?? base.settingsEnv,
  };
}

/** Expand a profile argv template: the `{prompt}` element becomes the prompt. */
export function expandArgs(template: string[], prompt: string): string[] {
  return template.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a));
}
