---
"peirad": minor
---

`peirad triage` now surfaces what the harness said the call cost. The markdown output ends with a `usage:` line (tokens in/cache/out, model, cost), `--format json` carries the same data as a `usage` object (`null` when the harness reports none), and a new `--usage-log <file>` option appends one JSON row per call for later tallying — a log that cannot be written fails the command instead of passing silently.
