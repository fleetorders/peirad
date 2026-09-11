/**
 * Exercise the contracts: one real turn.
 *
 * Every other probe reads what the harness left behind — help text, settings,
 * an old transcript. This one makes the harness do the thing: one minimal
 * headless turn, with a fixture hook on every event the manifest declares. Then
 * it checks what that turn actually produced: the transcript it wrote, the hooks
 * that fired, the flags the real invocation carried.
 *
 * It is the only place a model is involved, so it is opt-in and bounded:
 *
 * - The turn runs on the harness's normal configuration, with the login the
 *   user already has — nothing is copied anywhere. A no-cost login check runs
 *   first, so a harness that is not signed in spends nothing.
 * - The hook list comes from the MANIFEST, never from the user's settings, and
 *   reaches the turn as an overlay for that one invocation — a separate
 *   settings file or a command-line override — never written into the user's
 *   files. Where the harness has a switch that sets the user's own settings
 *   aside, the profile passes it.
 * - The transcript is found by the session id the turn itself reports, read,
 *   and then removed — exactly that session, and nothing else.
 * - The harness's usage report is compared to a token ceiling; the model it
 *   reports is shown as information, never checked.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "./manifest.js";
import {
  expandArgs,
  parseJsonLenient,
  type HarnessProfile,
} from "./harness-profiles.js";
import {
  checkTranscriptFile,
  type ProbeContext,
  type ProbeResult,
  type ProbeStatus,
} from "./probes.js";
import { globRegExp, globRoot } from "./glob.js";
import { fold, getDotted } from "./values.js";

/** How a harness is driven through one live turn — profile data. */
export interface LiveProfile {
  /** A command that reports the login without spending anything, and a
   * pattern (multiline) its output matches when signed in. */
  authCheck: { args: string[]; loggedIn: string };
  /**
   * How fixture hooks reach the turn without touching the user's files:
   * `settings-file` writes a settings file in a temporary directory and passes
   * its path (`{file}`); `config-override` passes an inline TOML value
   * (`{value}`).
   */
  hooksOverlay: { kind: "settings-file" | "config-override"; args: string[] };
  /** Argv added to every live turn — the switches that set the user's own
   * settings aside, where the harness has them. */
  turnArgs: string[];
  /** Hook events that fire only around a tool call. */
  toolEvents: string[];
  /** Argv added when a tool event must fire. */
  toolArgs: string[];
  /** The prompt when no tool event is declared. */
  plainPrompt: string;
  /** The prompt when one is: a single harmless tool call. */
  toolPrompt: string;
  /** Where the turn reports its session id: a dotted field of a JSON
   * envelope, or of the first event of a given type in a JSON-lines stream. */
  sessionId: { event?: string; field: string };
  /** The harness's configuration directory: the variable that relocates it,
   * and where it is otherwise (`{home}` expands). */
  configDir: { env: string; default: string };
  /** The turn's transcript, relative to the configuration directory:
   * `*` within a path segment, `**` across segments, `{session}` the id. */
  transcript: string;
  /**
   * How the turn's session is removed afterwards: the transcript file (and
   * its folder, when that leaves it empty), or the harness's own delete
   * command (`{session}` expands) where the harness also indexes sessions
   * elsewhere and a bare file removal would leave it inconsistent.
   */
  removeSession:
    | { kind: "file"; removeEmptyParent?: boolean }
    | { kind: "command"; args: string[] };
}

export interface LiveOptions {
  /** Tokens the turn may use, as the harness reports them. */
  ceiling: number;
  /** Kill the turn after this many ms. */
  timeoutMs: number;
  /** The environment the harness starts with; `process.env` when absent. */
  env?: NodeJS.ProcessEnv;
}

export interface LiveOutcome {
  results: ProbeResult[];
  /** Tokens the harness reported, or null when no turn ran or it reported
   * none. */
  tokens: number | null;
  /** Whether a turn was started at all — false means nothing was spent. */
  turned: boolean;
}

/** A session id peirad will use to find or remove anything. Anything else —
 * a path, an empty string, an unexpected shape — is never used. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const tomlString = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tomlKey = (s: string): string =>
  /^[A-Za-z0-9_-]+$/.test(s) ? s : tomlString(s);

/** The register for a failed live check: blocked when the manifest marks a
 * probe of the same kind critical, degraded otherwise. */
function failFor(
  manifest: Manifest,
  type: string,
  event?: string,
): ProbeStatus {
  const critical = manifest.probes.some(
    (p) =>
      p.type === type &&
      "critical" in p &&
      p.critical === true &&
      (event === undefined ||
        (p.type === "hook-registered" && p.event === event)),
  );
  return critical ? "blocked" : "degraded";
}

/** The session id a turn reported, when it looks like one. */
export function sessionIdFrom(
  stdout: string,
  spec: LiveProfile["sessionId"],
): string | null {
  let raw: unknown;
  if (spec.event) {
    for (const line of stdout.split("\n")) {
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        ev &&
        typeof ev === "object" &&
        (ev as { type?: unknown }).type === spec.event
      ) {
        raw = getDotted(ev, spec.field);
        break;
      }
    }
  } else {
    try {
      raw = getDotted(parseJsonLenient(stdout), spec.field);
    } catch {
      raw = undefined;
    }
  }
  return typeof raw === "string" && SESSION_ID.test(raw) ? raw : null;
}

/** The harness's configuration directory, as the turn will use it. */
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

/** The transcript file of one session: the newest file under the declared
 * pattern whose path names that session and that was written since `since`. */
export function findSessionTranscript(
  configDir: string,
  pattern: string,
  session: string,
  since: number,
): { file: string; mtime: Date } | null {
  if (!SESSION_ID.test(session)) return null;
  const matcher = globRegExp(pattern, { session });
  let best: { file: string; mtime: Date } | null = null;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const rel = path.relative(configDir, full).split(path.sep).join("/");
        if (!matcher.test(rel)) continue;
        let mtime: Date;
        try {
          mtime = fs.statSync(full).mtime;
        } catch {
          continue; // vanished between listing and stat — not a verdict
        }
        if (mtime.getTime() < since - 2_000) continue;
        if (!best || mtime > best.mtime) best = { file: full, mtime };
      }
    }
  };
  walk(globRoot(configDir, pattern));
  return best;
}

/** Remove exactly the turn's session, and say what was removed or left. */
function removeSession(
  live: LiveProfile,
  harness: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  configDir: string,
  file: string,
  session: string,
): ProbeResult {
  const rel = path.relative(configDir, file);
  const label = "live:cleanup";
  if (
    rel.startsWith("..") ||
    path.isAbsolute(rel) ||
    !path.basename(file).includes(session)
  ) {
    return {
      probe: label,
      status: "n/a",
      detail: `left ${file} in place — it is not plainly the turn's own session inside the configuration directory`,
    };
  }
  if (live.removeSession.kind === "command") {
    const args = live.removeSession.args.map((a) =>
      a === "{session}" ? session : a,
    );
    const r = spawnSync(harness, args, {
      env,
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      input: "",
    });
    const command = [harness, ...args].join(" ");
    if (!fs.existsSync(file)) {
      return {
        probe: label,
        status: "pass",
        detail: `removed the turn's session ${rel} (${command})`,
      };
    }
    const why = r.error
      ? `could not run (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`
      : `exited ${r.status}${`${r.stderr ?? ""}${r.stdout ?? ""}`.trim() ? `: ${fold(`${r.stderr ?? ""}${r.stdout ?? ""}`)}` : ""}`;
    return {
      probe: label,
      status: "n/a",
      detail: `left the turn's session ${rel} in place — ${command} ${why}`,
    };
  }
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("not a regular file");
    fs.rmSync(file);
  } catch (e) {
    return {
      probe: label,
      status: "n/a",
      detail: `left ${rel} in place — ${(e as Error).message}`,
    };
  }
  let folder = "";
  if (live.removeSession.removeEmptyParent) {
    const parent = path.dirname(file);
    const up = path.relative(configDir, parent);
    if (up && !up.startsWith("..") && !path.isAbsolute(up)) {
      try {
        fs.rmdirSync(parent);
        folder = " and its now-empty folder";
      } catch {
        // not empty: something else lives there, so it stays
      }
    }
  }
  return {
    probe: label,
    status: "pass",
    detail: `removed the turn's transcript ${rel}${folder}`,
  };
}

/** The fixture hooks as the overlay argv a profile declares. */
function overlayArgs(
  live: LiveProfile,
  events: string[],
  script: string,
  root: string,
): string[] {
  if (events.length === 0) return [];
  const command = (event: string): string =>
    `sh ${shellQuote(script)} ${event}`;
  if (live.hooksOverlay.kind === "settings-file") {
    const hooks = Object.fromEntries(
      events.map((event) => [
        event,
        [
          {
            ...(live.toolEvents.includes(event) ? { matcher: "*" } : {}),
            hooks: [{ type: "command", command: command(event) }],
          },
        ],
      ]),
    );
    const file = path.join(root, "fixture-settings.json");
    fs.writeFileSync(file, `${JSON.stringify({ hooks }, null, 2)}\n`);
    return live.hooksOverlay.args.map((a) => (a === "{file}" ? file : a));
  }
  const value = `hooks={${events
    .map(
      (event) =>
        `${tomlKey(event)}=[{${live.toolEvents.includes(event) ? `matcher="*",` : ""}hooks=[{type="command",command=${tomlString(command(event))}}]}]`,
    )
    .join(",")}}`;
  return live.hooksOverlay.args.map((a) => (a === "{value}" ? value : a));
}

export function runLive(
  manifest: Manifest,
  ctx: ProbeContext,
  profile: HarnessProfile,
  opts: LiveOptions,
): LiveOutcome {
  const live = profile.live;
  if (!live) {
    return {
      results: [
        {
          probe: "live",
          status: "n/a",
          detail: `harness profile "${profile.name}" declares no live run`,
        },
      ],
      tokens: null,
      turned: false,
    };
  }
  const env = opts.env ?? process.env;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-live-"));
  try {
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const results: ProbeResult[] = [];

    // 1. Login, at no cost, on the harness's own configuration.
    const auth = spawnSync(ctx.harness, live.authCheck.args, {
      env,
      cwd: work,
      encoding: "utf8",
      timeout: 30_000,
      input: "",
    });
    const authCommand = [ctx.harness, ...live.authCheck.args].join(" ");
    if (
      auth.error ||
      !new RegExp(live.authCheck.loggedIn, "m").test(
        `${auth.stdout ?? ""}\n${auth.stderr ?? ""}`,
      )
    ) {
      return {
        results: [
          {
            probe: "live:login",
            status: "n/a",
            detail: `the harness is not signed in (${authCommand}) — no turn ran, nothing was spent; sign in with the harness itself and run again`,
          },
        ],
        tokens: null,
        turned: false,
      };
    }
    results.push({
      probe: "live:login",
      status: "pass",
      detail: `signed in (${authCommand})`,
    });

    // 2. Fixture hooks for exactly the events the manifest declares.
    const events = [
      ...new Set(
        manifest.probes.flatMap((p) =>
          p.type === "hook-registered" ? [p.event] : [],
        ),
      ),
    ];
    const marker = path.join(root, "hooks-fired.log");
    const script = path.join(root, "fixture-hook.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$1" >> ${shellQuote(marker)}\n`,
    );
    fs.chmodSync(script, 0o755);

    // 3. The turn.
    const needsTool = events.some((e) => live.toolEvents.includes(e));
    const args = [
      ...expandArgs(
        profile.promptArgs,
        needsTool ? live.toolPrompt : live.plainPrompt,
      ),
      ...profile.outputArgs,
      ...live.turnArgs,
      ...overlayArgs(live, events, script, root),
      ...(needsTool ? live.toolArgs : []),
    ];
    const invokedFlags = args
      .filter((a) => a.startsWith("-"))
      .map((a) => a.split("=")[0]!);
    const started = Date.now();
    const turn = spawnSync(ctx.harness, args, {
      env,
      cwd: work,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      input: "",
    });
    const session = sessionIdFrom(turn.stdout ?? "", live.sessionId);
    const configDir = harnessConfigDir(live, env);
    const transcript = session
      ? findSessionTranscript(configDir, live.transcript, session, started)
      : null;
    let tokens: number | null = null;

    try {
      if (turn.error || turn.status !== 0) {
        const code = (turn.error as NodeJS.ErrnoException | undefined)?.code;
        const why =
          code === "ETIMEDOUT"
            ? `timed out after ${opts.timeoutMs}ms`
            : turn.error
              ? `could not run (${code ?? turn.error.message})`
              : `exited ${turn.status}${turn.stderr?.trim() ? `: ${fold(turn.stderr)}` : ""}`;
        results.push({
          probe: "live:turn",
          status: failFor(manifest, "flag-accepted"),
          detail: `a real invocation with ${invokedFlags.join(" ")} did not complete — ${why}`,
        });
        return { results, tokens: null, turned: true };
      }

      const parsed = profile.parseOutput(turn.stdout ?? "");
      const usage = parsed.ok ? parsed.value.usage : null;
      tokens = usage
        ? usage.input_tokens +
          usage.cache_read_tokens +
          usage.cache_write_tokens +
          usage.output_tokens
        : null;
      results.push({
        probe: "live:turn",
        status: parsed.ok ? "pass" : failFor(manifest, "flag-accepted"),
        detail: parsed.ok
          ? `one turn completed${usage?.model ? ` · the harness reported model ${usage.model} (information, not checked)` : ""}`
          : `the turn completed but its output could not be read: ${parsed.reason}`,
      });
      results.push(
        tokens === null
          ? {
              probe: "live:ceiling",
              status: "n/a",
              detail: `the harness reported no usage — spend against the ceiling of ${opts.ceiling} tokens is unknown`,
            }
          : {
              probe: "live:ceiling",
              status: tokens <= opts.ceiling ? "pass" : "degraded",
              detail: `${tokens} tokens, ${tokens <= opts.ceiling ? "within" : "over"} the ceiling of ${opts.ceiling}`,
            },
      );

      // Flags: the declared ones a real invocation carried.
      const declaredFlags = [
        ...new Set(
          manifest.probes.flatMap((p) =>
            p.type === "flag-accepted" ? p.flags : [],
          ),
        ),
      ];
      if (declaredFlags.length > 0) {
        const exercised = declaredFlags.filter((f) => invokedFlags.includes(f));
        const rest = declaredFlags.filter((f) => !invokedFlags.includes(f));
        results.push({
          probe: "live:flags",
          status: exercised.length > 0 ? "pass" : "n/a",
          detail:
            exercised.length > 0
              ? `accepted by a real invocation: ${exercised.join(", ")}${rest.length > 0 ? ` · not part of the turn, so only checked against --help: ${rest.join(", ")}` : ""}`
              : `no declared flag is part of the live turn (${declaredFlags.join(", ")}) — they stay checked against --help only`,
        });
      }

      // The transcript this turn wrote, found by its own session id.
      const fieldProbes = manifest.probes.flatMap((p) =>
        p.type === "transcript-field" ? [p] : [],
      );
      if (!session) {
        results.push({
          probe: "live:transcript",
          status: failFor(manifest, "transcript-field"),
          detail: `the turn reported no session id, so the transcript it wrote cannot be told apart from any other`,
        });
      } else if (!transcript) {
        results.push({
          probe: "live:transcript",
          status: failFor(manifest, "transcript-field"),
          detail: `the turn wrote no transcript matching ${live.transcript} for session ${session}`,
        });
      } else if (fieldProbes.length === 0) {
        results.push({
          probe: "live:transcript",
          status: "pass",
          detail: `the turn wrote ${path.relative(configDir, transcript.file)}`,
        });
      } else {
        for (const spec of fieldProbes) {
          const r = checkTranscriptFile(spec, transcript, configDir);
          results.push({ ...r, probe: `live:${r.probe}` });
        }
      }

      // Hooks: did each declared event's fixture hook actually run?
      const fired = fs.existsSync(marker)
        ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean)
        : [];
      for (const event of events) {
        results.push(
          fired.includes(event)
            ? {
                probe: `live:hook-fired(${event})`,
                status: "pass",
                detail: `a fixture hook on ${event} ran during a real turn`,
              }
            : {
                probe: `live:hook-fired(${event})`,
                status: failFor(manifest, "hook-registered", event),
                detail: `a fixture hook on ${event} was passed to the turn and did not run${needsTool && live.toolEvents.includes(event) ? " (the turn was asked for one tool call)" : ""}`,
              },
        );
      }
      return { results, tokens, turned: true };
    } finally {
      // 4. Remove exactly the turn's session — whether or not the checks held,
      //    and only once the transcript has been read.
      if (session && transcript) {
        results.push(
          removeSession(
            live,
            ctx.harness,
            env,
            work,
            configDir,
            transcript.file,
            session,
          ),
        );
      } else {
        results.push({
          probe: "live:cleanup",
          status: "n/a",
          detail: session
            ? `nothing to remove — no transcript for session ${session} was found`
            : `nothing removed — the turn reported no session id, and nothing else is touched`,
        });
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
