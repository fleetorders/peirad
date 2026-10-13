# Probes in depth

What each probe can assert, how the settings stack is read, what the harness-reports and env probes see, and what an older peirad does with a newer manifest. The probe table itself is in the [README](https://github.com/fleetorders/peirad#what-it-checks).

## Asserting a value, not just a key

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

Settings values follow the env probe's rule: a value appears in a verdict line
only when its key does not look like a credential and the value is short and
plain — a leftover key that happens to hold a token is named without being
echoed (`legacy.apiToken = value not shown`), and a mismatch on such a key
reports that it holds a different value without printing either side.

A feature that shells out to another program declares it, so "installed, but
its helper is gone" stops reading as healthy:

```json
{ "type": "command-exists", "command": "jq", "critical": true }
```

peirad does not re-implement your harness's own schema validation. If the
harness ships a doctor that reports unknown keys and bad types headless, use
it — what peirad adds is the assertion _your integration_ depends on, which no
harness knows about.

## When your manifest is newer than your peirad

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
in CI, or to catch a typo — see [`peirad validate`](https://github.com/fleetorders/peirad/blob/main/docs/commands.md#validate-the-manifest).

## Reading the whole settings stack

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
  "match": "command-guard"
}
```

```
ok    hook-registered(PreToolUse~command-guard): hook "command-guard" registered on PreToolUse in user scope [read user, project, 2 absent]
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

## What the harness says about itself

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

## The environment around the harness

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
