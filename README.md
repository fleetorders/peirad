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

my integration — harness claude 2.1.223 · 2026-08-15
  ok    command-exists(claude): claude is on PATH
  ok    version: 2.1.223
  ok    flag-accepted(-p,--allowedTools): all flags present in --help
  ok    config-key(settings.json): keys present: hooks.PreToolUse
  DEGR  transcript-field(projects/**/*.jsonl): schema drift — missing: message
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

| Probe              | Confirms                                                      |
| ------------------ | ------------------------------------------------------------- |
| `command-exists`   | the harness binary is on PATH                                 |
| `version`          | the installed version (stamped into the verdict)              |
| `flag-accepted`    | the CLI flags your automation passes still parse              |
| `config-key`       | the settings keys you rely on still exist                     |
| `hook-registered`  | your hook is still wired for its event                        |
| `transcript-field` | the fields your tool reads from transcripts are still present |

A non-critical probe that drifts reports `degraded`; a probe marked `critical`
reports `blocked`. Nothing throws — one drift never hides the next.

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
`--config-dir` to point at your harness config location. Add `--json` for a
machine-readable verdict.

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
tools, default model) — the same binary the probes exercise. `--rubric` takes
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
harness, harness_version, usage, rubric}`. A `PEIRAD_HARNESS` environment
variable overrides the manifest's harness, which is handy for testing.

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
**rail keyword list** — credentials, corporate material, machine surfaces,
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
  (critical drift). Exit `0` when all pass, `1` on any drift.
- **`--json`** emits the full verdict object (name, harness, version, date, and
  per-probe results) for programmatic use.

Roadmap: [ROADMAP.md](ROADMAP.md) · Decisions: [DECISIONS.md](DECISIONS.md)

## License

[MIT](LICENSE)
