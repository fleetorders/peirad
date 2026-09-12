# peirad

<div align="center">
  <img src="https://raw.githubusercontent.com/fleetorders/peirad/main/media/peirad-logo.png" width="520" alt="peirad — a manifest card and a harness card flanking a live vitals reading, an integration checked and proven to hold">
  <p>
    <a href="https://www.npmjs.com/package/peirad"><img src="https://img.shields.io/npm/v/peirad.svg?label=npm&color=cb3837" alt="npm version"></a>
    <a href="https://github.com/fleetorders/peirad/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fleetorders/peirad/ci.yml?branch=main&label=CI" alt="CI"></a>
    <a href="https://github.com/fleetorders/peirad/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

_πεῖρα — Greek for the trial that puts a thing to the test; the root of empirical._

**Know the moment your agent integration stops holding.**

You wired a tool into your coding agent months ago — a hook, a settings key, a
transcript reader, a script that passes the right flags. Since then the harness
shipped a dozen updates. Your integration might still work, or it might have
quietly stopped the day a flag was renamed — and nothing told you, because the
failure is silent.

peirad contract-tests your integration against the harness you actually have
installed, right now, and prints a dated verdict that names the version it
checked.

```
$ npx peirad --manifest peirad.json

my integration — harness claude (claude) 2.1.223 · peirad 0.5.0 · 2026-08-15
  ok    command-exists(claude): claude is on PATH
  ok    version: 2.1.223
  ok    flag-accepted(-p,--allowedTools): all flags present in --help
  ok    config-key(settings.json): keys present: hooks.PreToolUse
  DEGR  transcript-field(projects/**/*.jsonl): schema drift — missing: message
  coverage declares command-exists, flag-accepted, config-key, transcript-field · not declared: hook-registered, script, harness-reports, env
  1 degraded — drift detected
```

It needs Node ≥ 18.17 and must run on the machine where the harness is installed
(it checks the _live_ install). It is a checker, not a fixer — it tells you what
drifted; changing it is yours.

## Quick start

Write a small `peirad.json` describing what your integration relies on, then run:

```sh
npx peirad --manifest peirad.json
```

Exit code is non-zero on any drift, so it drops straight into CI or a scheduled
check.

## What it checks

You declare probes; each runs against the live harness:

| Probe              | Confirms                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `command-exists`   | the harness binary — or a helper program — is on PATH                                                    |
| `version`          | the installed version (stamped into the verdict)                                                         |
| `flag-accepted`    | the CLI flags your automation passes still parse                                                         |
| `config-key`       | the settings you rely on exist, hold the value you expect, and the names you migrated away from are gone |
| `hook-registered`  | your hook is still wired for its event                                                                   |
| `transcript-field` | the fields your tool reads from transcripts are still present                                            |
| `script`           | a repo-provided check still passes                                                                       |
| `harness-reports`  | a fact the harness reports about itself still holds — a server connected, a doctor check passing         |
| `env`              | the variables around the harness are set, unset, hold the value, or point at what you declared           |

A non-critical probe that drifts reports `degraded`; a probe marked `critical`
reports `blocked`; a probe its [harness profile](#harness-profiles) says
cannot apply reports `n/a`. Nothing throws — one drift never hides the next.

Every verdict ends with a `coverage` line naming the probe types your manifest
declares and the ones it does not. A pass means what you declared still holds;
the line keeps a two-probe manifest that passes from reading like a thorough
one. It never changes the exit code, and `--json` carries it as `coverage`.

### Asserting a value, not just a key

A key that still exists tells you little: an update can migrate it, rename it,
or switch what it defaults to, and the feature goes quiet with nothing in the
log. `config-key` therefore takes three declarations, in any combination:

```json
{
  "type": "config-key",
  "file": "settings.json",
  "keys": ["hooks.PreToolUse"],
  "expect": { "voice.enabled": true, "permissions.defaultMode": "acceptEdits" },
  "absent": ["voice.enable"]
}
```

- `keys` — these paths must exist, with any value.
- `expect` — each path must hold exactly this value (compared deeply, so an
  object or array must match entirely; to assert one field of an object, point
  at that field with a dotted path).
- `absent` — these paths must _not_ exist. This is how you catch the leftover
  twin of a renamed setting: the old name still parses and still looks
  configured, while the harness reads the new one and runs at its default.

Every declaration is reported, so a wrong value never hides a leftover key:

```
DEGR  config-key(settings.json): voice.enabled is false (expected true) · declared absent but present: voice.enable = true
```

A feature that shells out to another program declares it, so "installed, but
its helper is gone" stops reading as healthy:

```json
{ "type": "command-exists", "command": "jq", "critical": true }
```

peirad does not re-implement your harness's own schema validation. If the
harness ships a doctor that reports unknown keys and bad types headless, use
it — what peirad adds is the assertion _your integration_ depends on, which no
harness knows about.

### When your manifest is newer than your peirad

A manifest may name a field an installed peirad has never heard of. The run
does not refuse it and does not quietly drop it: the probe runs everything it
understands, reports `degraded`, and names what it skipped.

```
DEGR  config-key(settings.json): keys present: hooks.PreToolUse — 1 declared assertion skipped: peirad 0.4.0 does not understand absent on a config-key probe; upgrade peirad
```

It is never `blocked`, however critical the probe — an out-of-date checker is
not drift in your harness, and the fix is an upgrade, not an investigation. An
unknown probe _type_ reports `n/a` the same way. Keys beginning with `_` are
comments and are never reported. To refuse unknown fields outright instead —
in CI, or to catch a typo — see [`peirad validate`](#validate-the-manifest).

### Reading the whole settings stack

Your harness does not read one settings file. It reads several — yours, the
project's, a local override beside it, a policy file an administrator
controls — and merges them in its own order. A probe that reads one of them
answers a question you did not ask: a hook moved from project scope to user
scope reads as drift though nothing broke, and a value a higher layer
overrides reads as present though the harness never sees it.

Set `scope: "effective"` and the probe merges the stack first, in the
harness's own precedence:

```json
{
  "type": "hook-registered",
  "scope": "effective",
  "event": "PreToolUse",
  "match": "agent-guard"
}
```

```
ok    hook-registered(PreToolUse~agent-guard): hook "agent-guard" registered on PreToolUse in user scope [read user, project, 2 absent]
DEGR  config-key(effective): voice.enabled is false (expected true) [read user, project, 2 absent]
```

The verdict names the scope every setting came from, and says so when a higher
layer shadows a lower one (`voice.enabled ← local (shadows user, project)`).
With `scope: "effective"` you do not name a `file` — the stack decides. A
layer that will not parse fails the probe, naming the layer: while one file is
broken the effective settings are unknowable, and your harness is in no better
position. The default is `scope: "file"`, which reads exactly the file you name.

Where peirad has no profile for your harness, declare the stack in the
manifest — lowest precedence first, with `{home}` and `{configDir}` expanded
at run time:

```json
{
  "settingsLayers": [
    { "name": "user", "path": "{home}/.myagent/settings.json" },
    { "name": "project", "path": "{configDir}/.myagent/settings.json" }
  ],
  "settingsArrays": "concat"
}
```

`settingsArrays` says what happens to a list two layers both set: `concat`
where every layer's entries apply (a harness that runs every registered hook,
whichever file declared it) or `override` where the nearest scope replaces the
rest. It is the difference between "my hook moved scope" and "my hook is dead",
so it is declared, never guessed.

### What the harness says about itself

Harnesses ship their own reports: a server list that health-checks each server,
a doctor that reads the install. peirad does not second-guess them. What a
harness cannot know is which of those facts _your_ integration relies on — so
you name the report and the facts, and the harness does the checking:

```json
{
  "type": "harness-reports",
  "report": "mcp",
  "find": [{ "name": "my-server", "status": "Connected" }],
  "critical": true
}
```

```
ok    harness-reports(mcp): claude mcp list reports name=my-server, status=Connected
DEGR  harness-reports(mcp): claude mcp list: name=my-server: status is "Needs authentication" (expected "Connected")
```

Each `find` entry is a set of fields that at least one record in the report must
match entirely. Put the field that identifies a record first (`name`, `id`,
`key`): on a miss, peirad describes the record sharing it, so the line says
what the report shows instead of only that it did not match.

The built-in profiles declare these reports — run each one yourself to see the
fields a record carries:

| Profile | Report           | Runs                    | Record fields                                             |
| ------- | ---------------- | ----------------------- | --------------------------------------------------------- |
| claude  | `mcp`            | `claude mcp list`       | `name`, `target`, `mark`, `status`                        |
| claude  | `doctor`         | `claude doctor`         | `key`, `value` (one per `Key: value` line)                |
| codex   | `mcp`            | `codex mcp list --json` | the JSON fields, e.g. `name`, `enabled`, `transport.type` |
| codex   | `doctor`         | `codex doctor --json`   | one record per check: `id`, `status`, `summary`, …        |
| codex   | `doctor-summary` | `codex doctor --json`   | the top-level document, e.g. `overallStatus`              |

A report's output is read whatever its exit code — a doctor that found a problem
usually exits non-zero while printing the report that says what. If the report
changes shape so it can no longer be read, the probe reports `n/a` and quotes
the start of the output: a report peirad cannot read says nothing either way,
so it neither passes nor blames your integration. A profile without the report
you name also reports `n/a`, listing the reports it has.

For another harness, or a report the profiles do not carry, declare it in the
manifest — `json` with an optional dotted `records` path, or `lines` with a
regular expression whose named groups become the fields:

```json
{
  "reports": {
    "servers": {
      "args": ["servers", "--list"],
      "format": "lines",
      "pattern": "^(?<name>\\S+)\\s+(?<state>\\w+)$",
      "emptyPattern": "no servers"
    }
  }
}
```

`emptyPattern` marks the output of a valid report with no records, so "nothing
configured" is not mistaken for a changed shape. Reports run in the manifest's
directory, and a server list that health-checks will start the servers it
checks — the same trust as running that project's own scripts.

### The environment around the harness

Much of what an integration relies on is not in a flag or a settings file but in
the variables around the harness: which provider endpoint it talks to, which
config directory it reads, which certificate bundle it trusts, which helper is
on PATH. A shell profile edit changes them, and the harness says nothing.

```json
{
  "type": "env",
  "set": ["ANTHROPIC_BASE_URL"],
  "unset": ["ANTHROPIC_API_KEY"],
  "matches": { "ANTHROPIC_BASE_URL": "^https://" },
  "equals": { "CLAUDE_CODE_USE_BEDROCK": "1" },
  "pointsAt": { "NODE_EXTRA_CA_CERTS": "file" },
  "critical": true
}
```

- `set` / `unset` — the variable is set and not empty, or it is absent or empty.
- `equals` / `matches` — its value is exactly this, or matches this regular
  expression.
- `pointsAt` — its value is a path to an existing `file`, `dir`, `executable`
  (a bare name is looked up on PATH) or any existing `path`. A relative value is
  resolved against the manifest's directory.

By default the probe checks the environment peirad runs in — the one a harness
started from the same place inherits. With `scope: "effective"` the variables
the harness's own settings declare (Claude Code's `env` block, across the whole
[settings stack](#reading-the-whole-settings-stack)) are laid over it, as the
harness applies them, and each line names where a value came from:

```
DEGR  env(ANTHROPIC_BASE_URL): ANTHROPIC_BASE_URL (settings: project) does not match /^https:///
```

**Values are treated as secrets.** A verdict line ends up in CI logs, so a value
is shown only when the variable's name does not look like a credential (`KEY`,
`TOKEN`, `SECRET`, `AUTH`, …) and the value is short and plain; otherwise the
line says the value differs, or does not match, without printing it.

These checks are deterministic. None of them asks a model which model or
provider it is: a model's account of itself is not evidence of how it was
configured.

The `script` probe runs an executable from the repo the manifest lives in:
exit 0 passes, exit 1 fails with the script's stdout as the finding, and
exit 2 reports `n/a` — no verdict. Any other outcome (not executable, killed
by the timeout, crashed) is read the same way: the probe fails open, so a
broken probe can only report `n/a`, never claim your integration broke —
even when marked `critical`. Running a manifest's scripts is running that
repo's code, the same trust as its npm scripts: a manifest is only as
trustworthy as the repo that ships it.

## How it works

peirad is a generic engine plus a per-project manifest. The manifest is data —
which probes to run, and the flags/keys/paths your integration depends on — so
adding a check or a new harness is a manifest edit, not an engine change. The
engine resolves the harness, runs each probe against the live install, and
returns a dated verdict.

```json
{
  "name": "my integration",
  "harness": "claude",
  "probes": [
    { "type": "command-exists", "critical": true },
    { "type": "version" },
    { "type": "flag-accepted", "flags": ["-p", "--allowedTools"] },
    {
      "type": "config-key",
      "file": "settings.json",
      "keys": ["hooks.PreToolUse"],
      "critical": true
    },
    {
      "type": "transcript-field",
      "glob": "projects/**/*.jsonl",
      "fields": ["type", "message"]
    }
  ]
}
```

Relative `file`/`glob` paths resolve against the manifest's directory, or pass
`--config-dir` to point at your harness config location. A `glob` may also
carry `{home}` and `{configDir}` templates — `{home}/.claude/projects/**/*.jsonl`
reaches the harness's own configuration directory without dragging every other
probe's base directory along. Add `--json` for a machine-readable verdict.

## Validate the manifest

A run is lenient on purpose: a field it does not understand is skipped and
named (see [When your manifest is newer than your
peirad](#when-your-manifest-is-newer-than-your-peirad)), so an older install
still delivers a verdict. `peirad validate` is the strict reading — for CI, and
for the typo a run would forgive:

```sh
npx peirad validate                  # or: -m path/to/peirad.json
```

```
peirad.json — 1 error, 1 warning · 6 probes · peirad 0.5.0
  ERR   probes[2].absnet (peirad.json:14): unknown field "absnet" on a config-key probe
  WARN  probes[4].file (peirad.json:22): "settings.json" does not exist at …/settings.json
  probes[0] command-exists
  …
```

It refuses unknown fields and probe types, values of the wrong shape, missing
required fields and probes that declare nothing — each with its JSON path and
line. It warns, without failing, about what depends on the machine rather than
the manifest: a file or script that does not exist here (you may run with
`--config-dir`), a report the harness profile does not declare, a flag entry
that does not start with `-`. Every probe is listed with the paths it will
read. No harness process is started. Exit code 0 with no errors, 1 with errors,
2 when the file is not readable JSON; `--json` prints the report. Keys beginning
with `_` are comments here too.

## Proving it in one real turn

Every probe above reads what the harness left behind: its help text, its
settings, an old transcript. `--live` makes it do the work — one minimal
headless turn — and checks what that turn produced:

```sh
npx peirad --live                          # a ceiling of 100000 tokens by default
npx peirad --live --live-ceiling 200000 --live-timeout 300
```

```
ok    live:login: signed in (claude auth status)
ok    live:turn: one turn completed
ok    live:ceiling: … tokens, within the ceiling of 100000
ok    live:flags: accepted by a real invocation: -p, --output-format
ok    live:transcript-field(projects/**/*.jsonl): fields present (type, message) …
BLOCK live:hook-fired(PreToolUse): a fixture hook on PreToolUse was passed to the turn and did not run
ok    live:cleanup: removed the turn's transcript projects/…/….jsonl and its now-empty folder
```

- **It uses the login you already have.** The turn runs on the harness's normal
  configuration directory; nothing is copied anywhere. A no-cost login check
  runs first, and a harness that is not signed in stops at `live:login` having
  spent nothing.
- **Hooks come from your manifest.** For every event a `hook-registered` probe
  declares, peirad hands the turn a fixture hook of its own, for that one
  invocation — a separate settings file, or a command-line override — and checks
  that it ran. Nothing is written into your configuration, and the hooks already
  in your settings are not what is tested. When a declared event fires only
  around a tool call, the turn asks for one harmless tool call.
- **Your own settings are set aside where the harness allows it.** Claude Code
  runs with `--restricted` and `--strict-mcp-config`, which ignore your user,
  project and local settings files and MCP servers for that turn; managed policy
  settings still apply. Codex has no such switch for its hooks file: your Codex
  config and hooks still load, and the turn passes
  `--dangerously-bypass-hook-trust` so the fixture hook can run — which also
  lets hooks in your hooks file run that you have not yet trusted.
- **The transcript is the one this turn wrote**, found by the session id the
  turn reports; your `transcript-field` declarations are read from it.
- **Flags are proven by the real invocation** where the turn carries them; the
  rest stay checked against `--help`, and the line says which.
- **Afterwards, exactly that session is removed** — Claude Code's transcript
  file, and its folder if that leaves it empty; Codex's session through
  `codex delete --force <id>`, which also clears it from Codex's own session
  index. Nothing else is touched, a session id that does not look like one is
  never used, and `live:cleanup` names what was removed or why something was
  left.
- **A failure takes the register of the probe it proves** — a hook that did not
  fire is `blocked` when its `hook-registered` probe is `critical`.

It is off by default: it is the only check that spends tokens, and even a
minimal turn can use tens of thousands of them, most served from cache. The
ceiling is compared with the usage the harness reports after the turn — a turn
cannot be stopped at a token count part-way — and `--live-timeout` kills a turn
that runs long. The model the harness reports is shown as information and never
checked. The fixture hook is a POSIX shell script.

## What moved that you never declared

A verdict answers "does what I declared still hold?". It cannot tell you what
changed around it — a flag that appeared, a settings key renamed next to the
one you check, a new field in the transcripts — because a run keeps nothing.
Record a baseline once, and later runs report that as a third register:

```sh
npx peirad --record-baseline      # writes peirad.baseline.json beside the manifest
git add peirad.baseline.json      # commit it: movement then shows up as a diff
```

```
$ npx peirad
my integration — harness claude (claude) 2.1.268 · peirad 0.5.0 · 2026-09-11
  ok    flag-accepted(-p): all flags present in --help
  ok    config-key(settings.json): values match: voice.enabled
  moved since the baseline of 2026-09-01 — undeclared, not counted as drift:
    ~ version 2.1.223 → 2.1.268
    + help --new-flag
    - settings(settings.json) voice.enable
  PASS — integration holds
```

What moved is a reason to look, not a failure: it never changes the exit code,
and anything you _did_ declare stays the probes' job, so the ledger lists only
what nobody declared. Once `peirad.baseline.json` exists every run compares
against it; `--no-baseline` skips that, and `--baseline <file>` names another
file. Record again whenever you have looked at what moved and accept it.

The baseline records **names, never values**, and only around what your
manifest points at: the harness version, the flags its help carries, the
top-level settings names plus the neighbourhood of each key you declared (so
`voice.enable` beside `voice.enabled` is seen, while keys elsewhere in your own
settings are not written into a committed file), and the field names on the
newest transcript. A key that is data rather than a name — a file path, an id —
is recorded as `*` and not followed.

## Deriving the manifest from your code

You rarely know up front everything your integration depends on — but your
project already says it. Its scripts pass flags to the harness, its settings
files register hooks, its hook commands call helper programs, its transcript
readers pull fields out of JSON lines. `peirad init` scans those files and
drafts the manifest they imply:

```sh
npx peirad init > peirad.json          # print the draft; or: -o peirad.json (never overwrites)
npx peirad init --harness codex        # draft for a named harness instead of the one used most
```

```json
{
  "type": "flag-accepted",
  "flags": ["--output-format", "-p"],
  "_from": {
    "--output-format": ["scripts/review.sh:2"],
    "-p": ["scripts/review.sh:2", "package.json:3"]
  }
}
```

Every entry carries `_from`: the file and line behind it. Keys beginning with
`_` are comments, so the draft runs as it is — but it is a draft: read it, keep
what is a real dependency, delete the rest. Write it at the project root, where
the drafted file paths resolve.

Once a manifest exists, `--coverage` compares it with the same scan on every
run and names what the code uses that no probe declares, and what a probe
declares that the files never mention:

```
$ npx peirad --coverage
  scan  48 files in .: 2 used but not declared, 1 declared but not found — not counted as drift:
    + flag --output-format scripts/review.sh:2
    + hook Stop → notify.sh .claude/settings.json:19
    - helper rg not in the scanned files — it may live elsewhere, such as a user's own settings
```

It never changes the exit code. "Not found" means only that: a hook in your own
user settings is real, and invisible to a scan of the repository.

**The scan is deterministic and uses no model.** Every entry comes from one of
these rules, so a surprising one can be traced to the line and the rule:

- **Flags** — tokens starting with `-` after `claude` or `codex` on the same
  line, up to a pipe or `;` (`--help` and `--version` are left out).
- **Hooks** — `hooks.<Event>[].hooks[].command` in any JSON file, matched by the
  file name of the script the command runs.
- **Helper programs** — the program a hook command starts, unless it is a shell
  or a path.
- **Transcript fields** — only in files that mention `.jsonl`: paths in a quoted
  `jq` program, and string keys taken as `["key"]` or `.get("key")`. These can
  catch keys from other JSON in the same file, and the draft says so.

It reads text files and skips dependencies (`node_modules`, `vendor`), build
output (`dist`, `build`, `target`) and dot-directories other than `.claude`,
`.codex`, `.github`, `.githooks` and `.husky`. A flag assembled in a variable
several lines away is not seen.

## Harness profiles

Agent CLIs disagree on how to be driven headless: one takes `-p <prompt>
--output-format json` and prints a single envelope; another wants a subcommand,
the prompt as a positional, `--json` for an event stream, and reports usage at
the end of the turn. A **harness profile** holds that shape — how to pass a
one-shot prompt, how to ask for machine-readable output, how to read the reply
and the token/cost numbers back out.

Two are built in:

- **`claude`** — `-p <prompt> --output-format json`; reply from the envelope's
  `result`, usage from its `usage` block.
- **`codex`** — `codex exec --skip-git-repo-check --sandbox read-only --color
never <prompt> --json`; reply from the final `agent_message` event, usage
  from `turn.completed`.

The manifest selects one with `harnessProfile`; when it is absent, the harness
name decides (`"harness": "codex"` gets the codex profile) and an unknown
harness falls back to the claude convention. For a CLI neither profile fits,
replace the argv templates directly — `promptArgs` must contain one `{prompt}`
element (a standalone argument, never spliced into a flag), `outputArgs` is
appended after it:

```json
{
  "harness": "my-cli",
  "harnessProfile": "codex",
  "promptArgs": ["exec", "--no-banner", "{prompt}"],
  "outputArgs": ["--json"],
  "probes": []
}
```

Profiles also say which probes can apply. The settings-file probes
(`config-key`, `hook-registered`) read JSON; under a profile whose CLI family
keeps no JSON file they report `n/a` with the profile named — declared
inapplicable, never silently passed. Both built-in profiles have one: Claude
Code's `settings.json`, and Codex's `hooks.json` (its `config.toml` is TOML
and out of `config-key`'s reach), so a codex manifest points `file` at
`hooks.json`. `flag-accepted` reads the help the profile points at (root
`--help`, or a subcommand's `exec --help` for codex).

A probe type the installed peirad does not know reports `n/a` naming the
type and the engine version — a manifest written for a newer release never
crashes an older one; upgrade peirad or remove the probe.

## Triage — does the drift matter?

`run` tells you _that_ something drifted; `triage` tells you _whether it
matters_. It reads an alarm — a changelog excerpt, a CI failure, a drift report
— against a rubric and prints a structured pre-assessment for the person who
has to decide. The assessment is machine-written and labelled unverified by
construction; nothing is edited or closed on its say-so.

```sh
npx peirad triage --alarm changelog.md --rubric changelog --manifest peirad.json
```

The model call goes through the harness named in your manifest, headless (no
tools, default model) — the same binary the probes exercise, invoked through
the manifest's [harness profile](#harness-profiles). `--rubric` takes
a markdown file, or the built-in `changelog`, which builds the rubric from your
own manifest — "did anything I declared a dependency on change?" — listing
every flag, settings key, hook and transcript field your probes rely on.

```
## Pre-assessment (machine, unverified)
Verdict: action
Confidence: high
Reasoning:
- declared flag --allowedTools is renamed — "The `--allowedTools` flag is now `--allowed-tools`; the old spelling is no longer accepted."
Draft resolution:
Rename --allowedTools to --allowed-tools in the launch script; retest the PreToolUse hook.
usage: in 4 / cached 1850 / out 220 tokens · model claude-sonnet-5 · cost $0.0123
```

Two guards keep it honest:

- **Quote guard** — every reasoning point must quote a line found verbatim in
  the alarm; points that cannot be traced are dropped and counted in a
  trailing `dropped: N unquotable point(s)` line.
- **Loud failure** — if the harness call fails or times out, the command exits
  `2` with `pre-assessment unavailable: <reason>` instead of guessing.

The harness's own accounting for the call — tokens in/cache/out, model, cost —
ends up in a trailing `usage:` line, or a `usage` object with `--format json`
(`null` when the harness reports none). Pass `--usage-log <file>` to also
append one JSON row per call to that file, so triage runs you schedule or
script can be tallied afterwards; a log that cannot be written fails the
command (exit `2`) rather than pass silently.

Exit `0` on any verdict — a verdict is information, not a failure. `--format
json` emits `{verdict, confidence, reasoning, draft, dropped, assessed_at,
harness, harness_version, profile, usage, rubric}`. A `PEIRAD_HARNESS`
environment variable overrides the manifest's harness binary (the profile
still comes from the manifest), which is handy for testing.

## Precedent — has this been ruled on before?

`triage` asks whether drift matters; `precedent` asks whether it has already
been decided. Give it a work-queue entry (markdown with a `#` title and a
`from:` frontmatter line), a decisions ledger in the `### D-00n — title` +
`**Scope:**` style, and any directories of resolved entries:

```sh
npx peirad precedent --entry queue/014-canary-drift.md --ledger DECISIONS.md --resolved queue/resolved --json
```

It derives the entry's class — the title's stem (up to the first `:` or
`—`) plus its `from:` source, with dates, versions and parentheticals
normalized away so recurrences collapse — then looks for prior rulings:
resolved entries of the same class (a past `done:` line is a paste-ready
resolution) and ledger entries whose title or scope covers the class.

```json
{
  "schema": "precedent/1",
  "matched": true,
  "class": "canary drift · nightly sweep",
  "source": "resolved",
  "id": "013-canary-drift-2026-09-03.md",
  "resolution": "re-ran the sweep twice — known clock skew; closed without changes",
  "confidence": "high"
}
```

Three properties keep it safe to run unattended. It is **read-only** — prints,
never writes, never resolves anything itself. Matching is **deterministic
text work** — no model call; the same inputs give the same answer, and every
match names the prior artefact it rests on (`confidence: high` = a resolved
sibling, `medium` = a ledger ruling only). And entries whose text trips a
**rail keyword list** — credentials, guarded material (plus any words you pass with `--rail-words`), machine surfaces,
registries, releases, outward actions — always come back `matched: false`
with the rail named. The list is deliberately over-broad: a false "no match"
costs a person a glance, a false "matched" would cost a wrong auto-resolution,
so the tool fails toward the first.

Exit `0` whether or not precedent matched — the answer is information, not a
failure. Exit `2` when inputs are unreadable (missing entry, ledger or
`--resolved` directory) or the entry has no `#` title to derive a class from.

## What it is NOT

- **Not a sandbox or a security tool.** It reports whether your wiring still
  works, including whether a security hook you rely on is still registered — it
  does not stop an attacker.
- **Not a one-shot scanner.** Run it on every harness upgrade and on a schedule;
  drift is continuous.
- **Not magic.** It checks what your manifest declares. A gap you do not declare
  is one it will not catch.

## Reference

- **Verdict statuses:** `pass`, `degraded` (non-critical drift), `blocked`
  (critical drift), `n/a` (the probe has no counterpart under the manifest's
  harness profile — declared, never a pass). Exit `0` when all pass, `1` on
  any drift.
- **`--json`** emits the full verdict object (name, harness, profile, version,
  date, and per-probe results) for programmatic use.

Roadmap: [ROADMAP.md](ROADMAP.md) · Decisions: [DECISIONS.md](DECISIONS.md)

## License

[MIT](LICENSE)
