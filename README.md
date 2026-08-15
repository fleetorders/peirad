# dokimd

<div align="center">
  <img src="https://raw.githubusercontent.com/triartleet/dokimd/main/media/dokimd-logo.png" width="520" alt="dokimd — a manifest card and a harness card flanking a live vitals reading, an integration checked and proven to hold">
  <p>
    <a href="https://www.npmjs.com/package/dokimd"><img src="https://img.shields.io/npm/v/dokimd.svg?label=npm&color=cb3837" alt="npm version"></a>
    <a href="https://github.com/triartleet/dokimd/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/triartleet/dokimd/ci.yml?branch=main&label=CI" alt="CI"></a>
    <a href="https://github.com/triartleet/dokimd/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

**Know the moment your agent integration stops holding.**

You wired a tool into your coding agent months ago — a hook, a settings key, a
transcript reader, a script that passes the right flags. Since then the harness
shipped a dozen updates. Your integration might still work, or it might have
quietly stopped the day a flag was renamed — and nothing told you, because the
failure is silent.

dokimd contract-tests your integration against the harness you actually have
installed, right now, and prints a dated verdict that names the version it
checked.

```
$ npx dokimd --manifest dokimd.json

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

Write a small `dokimd.json` describing what your integration relies on, then run:

```sh
npx dokimd --manifest dokimd.json
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

dokimd is a generic engine plus a per-project manifest. The manifest is data —
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
