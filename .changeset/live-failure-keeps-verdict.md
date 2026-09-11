---
"peirad": patch
---

An unexpected failure inside `--live` no longer throws away the verdict.

The live step touches your real configuration directory, so it is also the one step with failures no fixture foresaw — a temp directory that cannot be created, a transcript that vanishes between listing and reading. Any such error used to escape the run: the CLI printed one line and exited 2, discarding every deterministic probe result that had already been collected. A failure of the live step is now contained to a single `live: n/a` line naming what went wrong; the rest of the verdict stands, and the exit code follows the probes' own registers. A transcript file that disappears mid-walk is skipped, like the same race already was elsewhere.
