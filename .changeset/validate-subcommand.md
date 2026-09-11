---
"peirad": minor
---

`peirad validate` reads a manifest strictly, before anything is run.

A run stays lenient — a field it does not understand is skipped and named — so a manifest written for a newer release still gets a verdict on an older install. `validate` is the strict counterpart for CI and for catching typos: it refuses an unknown field, an unknown probe type, a value of the wrong shape, a missing required field and a probe that declares nothing, each with its JSON path and line (`probes[2].absent (peirad.json:31): unknown field "absent" on a flag-accepted probe`). It lists every probe with the paths it will read, and warns — without failing — about a file or script that does not exist yet, a report the harness profile does not declare, and a flag-shaped entry that is not a flag. No harness process is started. Exit 0 when there are no errors, 1 when there are, 2 when the file cannot be read as JSON; `--json` prints the report.
