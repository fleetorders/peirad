---
"peirad": minor
---

Derive the manifest from the project's own files.

`peirad init` scans a project and drafts the manifest its code implies: flags passed to `claude` or `codex`, hooks registered in settings or hooks files (matched by the script they run), helper programs those hooks start, and transcript fields read by code that handles JSON lines. Every drafted probe carries `_from` — the file and line behind it — as a comment key the engine ignores, so the draft runs as it is and every entry can be traced. It prints to stdout, or writes with `-o` and never overwrites; `--harness` drafts for a named harness instead of the one the project uses most.

`peirad run --coverage` compares an existing manifest with the same scan and names what the code uses that no probe declares, and what a probe declares that the scanned files never mention (`--scan-dir` picks the directory; `--json` carries it as `scan`). It never changes the exit code.

The scan is deterministic and uses no model: each entry comes from a documented rule, it reads text files only, and it skips dependencies, build output and unrelated dot-directories.
