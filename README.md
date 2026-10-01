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

my integration — harness claude 2.1.268 · peirad 0.5.0 · 2026-09-11
  ok    command-exists(claude): claude is on PATH
  ok    version: 2.1.268
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
reports `blocked`; a probe its [harness profile](https://github.com/fleetorders/peirad/blob/main/docs/harness-profiles.md) says
cannot apply reports `n/a`. Nothing throws — one drift never hides the next.

Every verdict ends with a `coverage` line naming the probe types your manifest
declares and the ones it does not. A pass means what you declared still holds;
the line keeps a two-probe manifest that passes from reading like a thorough
one. It never changes the exit code, and `--json` carries it as `coverage`.

What each probe can assert, and what an older peirad does with a newer manifest, is in
[docs/probes.md](https://github.com/fleetorders/peirad/blob/main/docs/probes.md).

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

## Commands

- `peirad --manifest peirad.json` runs the probes and prints the dated verdict; add `--json`
  for the verdict object and `--coverage` to compare the manifest with what your code uses.
- `peirad validate` reads a manifest strictly, without starting any process, and names every
  problem with its JSON path and line.
- `peirad --live` proves the declared hooks, transcript fields and flags in one real headless
  turn on the harness's own login, and removes the session it created (opt-in, spends tokens).
- `peirad --record-baseline` writes the names the harness exposes near what you declared, so
  later runs can report what moved that no probe declares.
- `peirad init` drafts a manifest from your project's files, with the file and line behind
  every entry.
- `peirad triage` pre-assesses an alarm against a rubric through the manifest's own harness,
  labelled machine-written and unverified.
- `peirad precedent` matches a work item to earlier decisions by text alone and prints the
  resolution to apply; it never acts.

Details: [commands](https://github.com/fleetorders/peirad/blob/main/docs/commands.md) · [harness profiles](https://github.com/fleetorders/peirad/blob/main/docs/harness-profiles.md) ·
[triage and precedent](https://github.com/fleetorders/peirad/blob/main/docs/triage-and-precedent.md).

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

Probe fields and the settings stack: [docs/probes.md](https://github.com/fleetorders/peirad/blob/main/docs/probes.md) · harness profiles:
[docs/harness-profiles.md](https://github.com/fleetorders/peirad/blob/main/docs/harness-profiles.md).

## Development

```sh
npm install
npm test            # vitest
npm run typecheck
npm run build       # bundle to dist/ (the published CLI)
```

The git hooks under `.githooks/` come from [etymd](https://www.npmjs.com/package/etymd) and
do nothing where it is not installed; `.githooks/*.local` runs a gitignored `local/` directory
for machine-specific checks. The design record is
[docs/decisions.md](https://github.com/fleetorders/peirad/blob/main/docs/decisions.md).

## Roadmap

What is next; what shipped is in the [changelog](https://github.com/fleetorders/peirad/blob/main/CHANGELOG.md).

- A published compatibility matrix per harness: which harness versions each release was
  verified against.
- Adapters for more harnesses beyond the first two; the manifest format is designed to
  compile to others without engine changes.
- A `--watch` mode that runs the manifest on a schedule and reports drift over time.
- An aggregated verdict across several projects, for teams running more than one agent repo.

## License

[MIT](LICENSE)
