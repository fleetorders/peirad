/**
 * Exercise the contracts: one real turn.
 *
 * Every other probe reads what the harness left behind — help text, settings,
 * an old transcript. This one makes the harness do the thing: one minimal
 * headless turn, in a configuration directory of its own, with a fixture hook
 * on every event the manifest declares. Then it checks what that turn actually
 * produced: the transcript it wrote, the hooks that fired, the flags the real
 * invocation carried.
 *
 * It is the only place a model is involved, so it is opt-in and bounded:
 *
 * - The hook list comes from the MANIFEST, never from the user's settings — a
 *   check that installs whatever is already configured proves nothing about
 *   what the integration declared.
 * - The configuration directory is a fresh temporary one, removed afterwards.
 *   Nothing is copied into it from the user's own — no settings, and never a
 *   credential. A harness that cannot find a login there is refused by a check
 *   that costs nothing, before any turn runs.
 * - The harness's own usage report is compared to a token ceiling, and the
 *   model it reports is shown as information, never checked: a model's
 *   account of itself is not evidence.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "./manifest.js";
import { expandArgs, type HarnessProfile } from "./harness-profiles.js";
import {
  newestMatch,
  runProbe,
  type ProbeContext,
  type ProbeResult,
  type ProbeStatus,
} from "./probes.js";
import { fold } from "./values.js";

/** How a harness is driven through one isolated turn — profile data. */
export interface LiveProfile {
  /** The environment variable that points the harness at a configuration
   * directory. */
  configDirEnv: string;
  /** A command that reports the login without spending anything, and a
   * pattern (multiline) its output matches when logged in. */
  authCheck: { args: string[]; loggedIn: string };
  /** Where fixture hooks are written inside the configuration directory, in
   * the `hooks.<Event>[].hooks[].command` shape. */
  hooksFile: string;
  /** Where the turn's transcript lands, relative to the configuration
   * directory. */
  transcriptGlob: string;
  /** Hook events that fire only around a tool call. */
  toolEvents: string[];
  /** Argv added to every live turn. */
  turnArgs: string[];
  /** Argv added when a tool event must fire. */
  toolArgs: string[];
  /** The prompt when no tool event is declared. */
  plainPrompt: string;
  /** The prompt when one is: it asks for a single harmless tool call. */
  toolPrompt: string;
}

export interface LiveOptions {
  /** Tokens the turn may use, as the harness reports them. */
  ceiling: number;
  /** Kill the turn after this many ms. */
  timeoutMs: number;
  /** The environment the harness starts with; `process.env` when absent. The
   * configuration-directory variable is always replaced. */
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

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The register for a failed live check: blocked when the manifest marks any
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peirad-live-"));
  try {
    const configDir = path.join(root, "config");
    const work = path.join(root, "work");
    fs.mkdirSync(configDir);
    fs.mkdirSync(work);
    const env = {
      ...(opts.env ?? process.env),
      [live.configDirEnv]: configDir,
    };
    const results: ProbeResult[] = [];

    // 1. Login, at no cost. Nothing is copied in, so a harness whose login
    //    lives in its configuration directory is refused here.
    const auth = spawnSync(ctx.harness, live.authCheck.args, {
      env,
      cwd: work,
      encoding: "utf8",
      timeout: 30_000,
      input: "",
    });
    const authOut = `${auth.stdout ?? ""}\n${auth.stderr ?? ""}`;
    const authCommand = [ctx.harness, ...live.authCheck.args].join(" ");
    if (auth.error || !new RegExp(live.authCheck.loggedIn, "m").test(authOut)) {
      return {
        results: [
          {
            probe: "live:login",
            status: "n/a",
            detail:
              `no login inside an isolated configuration directory (${authCommand}) — no turn ran, nothing was spent. ` +
              `peirad never copies credentials into it; give the harness a login it reads from the environment, then run again`,
          },
        ],
        tokens: null,
        turned: false,
      };
    }
    results.push({
      probe: "live:login",
      status: "pass",
      detail: `a login resolves inside the isolated configuration directory (${authCommand})`,
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
      `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$1" >> ${quote(marker)}\n`,
    );
    fs.chmodSync(script, 0o755);
    if (events.length > 0) {
      const hooks = Object.fromEntries(
        events.map((event) => [
          event,
          [
            {
              matcher: "*",
              hooks: [
                { type: "command", command: `sh ${quote(script)} ${event}` },
              ],
            },
          ],
        ]),
      );
      const file = path.join(configDir, live.hooksFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ hooks }, null, 2)}\n`);
    }

    // 3. The turn.
    const needsTool = events.some((e) => live.toolEvents.includes(e));
    const args = [
      ...expandArgs(
        profile.promptArgs,
        needsTool ? live.toolPrompt : live.plainPrompt,
      ),
      ...profile.outputArgs,
      ...live.turnArgs,
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
    const tokens = usage
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
            detail:
              tokens <= opts.ceiling
                ? `${tokens} tokens, within the ceiling of ${opts.ceiling}`
                : `${tokens} tokens, over the ceiling of ${opts.ceiling}`,
          },
    );

    // 4. Flags: the ones the manifest declares that a real invocation carried.
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

    // 5. The transcript this turn wrote — the declared fields are read from
    //    it, not from whichever old transcript happens to be newest elsewhere.
    const transcript = newestMatch(configDir, live.transcriptGlob);
    const fresh = transcript && transcript.mtime.getTime() >= started - 2_000;
    const fieldProbes = manifest.probes.filter(
      (p) => p.type === "transcript-field",
    );
    if (!fresh) {
      results.push({
        probe: "live:transcript",
        status: failFor(manifest, "transcript-field"),
        detail: `the turn wrote no transcript under ${live.transcriptGlob}`,
      });
    } else if (fieldProbes.length === 0) {
      results.push({
        probe: "live:transcript",
        status: "pass",
        detail: `the turn wrote ${path.relative(configDir, transcript.file)}`,
      });
    } else {
      for (const spec of fieldProbes) {
        const r = runProbe(
          { ...spec, glob: live.transcriptGlob },
          { ...ctx, configDir },
          [],
        );
        results.push({ ...r, probe: `live:${r.probe}` });
      }
    }

    // 6. Hooks: did each declared event's fixture hook actually run?
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
              detail: `a fixture hook on ${event} was registered and did not run during a real turn${needsTool && live.toolEvents.includes(event) ? " (the turn was asked for one tool call)" : ""}`,
            },
      );
    }

    return { results, tokens, turned: true };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
