---
"peirad": minor
---

Harnesses are now pluggable at the invocation and envelope level. A manifest can name a harness whose CLI is not Claude-shaped: `"harness": "codex"` (or an explicit `harnessProfile`) drives `codex exec` — positional prompt, `--json` event stream, usage read from the turn's token counts — while the existing `-p … --output-format json` path is unchanged and remains the default for unknown harnesses. `promptArgs`/`outputArgs` override the argv templates for a CLI no built-in profile fits (`{prompt}` marks the prompt's slot). Probes that a harness family cannot express (`config-key`, `hook-registered` under codex) now report `n/a` with the profile named instead of passing, and `flag-accepted` reads the help the profile points at (root `--help`, or `exec --help` for codex). Verdicts and triage output record the profile used.
