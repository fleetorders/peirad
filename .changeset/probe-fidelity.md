---
"peirad": minor
---

Probe fidelity: five shipped defects fixed, one profile constant corrected.

- `transcript-field` now samples the newest matching transcript by mtime, not the first by name, and names the sampled file and its date in the detail line — an old transcript beside a new one no longer reports drift the current build does not have.
- `flag-accepted` matches whole tokens of the help output, so `--allowed` no longer passes against `--allowedTools` and `-p` no longer passes against `--print`.
- An unknown probe type renders `n/a` naming the type and the peirad version instead of crashing the run with a `TypeError`; loading validates every probe's shape (an object with a string `type`). A manifest written for a newer release degrades gracefully on an older install.
- `triage` reports a failed harness call with the harness name, its version and its own stderr (`harness "claude" (2.1.267) exited 1: …`) instead of a bare exit number.
- The verdict carries the resolved path of the harness binary (`path`, also in `--json`), and `command-exists` prints it.
- The codex profile no longer declares `config-key` and `hook-registered` inapplicable: Codex keeps hooks in a JSON file of the same shape, so a codex manifest points `file` at it (D-009).
