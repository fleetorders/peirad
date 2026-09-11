---
"peirad": minor
---

A new probe asserts what the harness reports about itself.

`harness-reports` names a report the harness produces and the facts it must carry: `{ "type": "harness-reports", "report": "mcp", "find": [{ "name": "my-server", "status": "Connected" }] }`. The harness does the checking — its own server health check, its own doctor — and the probe asserts the facts your integration relies on. A miss names what the report shows instead (`status is "Needs authentication" (expected "Connected")`), using the record that shares the first declared field.

How to run and read each report is profile data. The claude profile declares `mcp` (`claude mcp list`) and `doctor` (`claude doctor`), both read line by line with a pattern; the codex profile declares `mcp` (`codex mcp list --json`), `doctor` (one record per check of `codex doctor --json`) and `doctor-summary` (its top-level document). A manifest can add or replace reports under `reports`, as `json` with an optional `records` path or `lines` with a named-group `pattern` and an `emptyPattern` for a valid report with nothing in it.

Output is read whatever the exit code. A report that can no longer be read — its shape changed, it timed out, it would not run — reports `n/a` quoting the start of the output, never a pass and never drift blamed on the integration; so does a report the profile does not declare, listing the ones it does.
