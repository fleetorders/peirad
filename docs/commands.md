# Commands beyond `run`

`validate`, the live turn (`--live`), the baseline (`--record-baseline`) and the manifest draft (`init`, `--coverage`).

## Validate the manifest

A run is lenient on purpose: a field it does not understand is skipped and
named (see [When your manifest is newer than your
peirad](https://github.com/fleetorders/peirad/blob/main/docs/probes.md#when-your-manifest-is-newer-than-your-peirad)), so an older install
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
my integration — harness claude 2.1.268 · peirad 0.5.0 · 2026-09-11
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
