---
"peirad": minor
---

The verdict as a ledger: report what moved that nobody declared.

`peirad run --record-baseline` writes `peirad.baseline.json` beside the manifest — the harness version, the flag tokens its help carries, the settings key names around what the manifest declares, and the field names on the newest transcript — meant to be committed. Every later run compares against it and prints a third register, "moved since the baseline", listing what was added, removed or changed that no probe declares. It never changes the exit code: movement is a reason to look, and whether anything broke stays the probes' job. `--no-baseline` skips the comparison; `--baseline <file>` names another file; `--json` carries the report as `baseline`.

The file records names, never values, and only near what the manifest points at: top-level settings names plus the neighbourhood of each declared key, so a key renamed beside the one you check is seen while the rest of a user's own settings is never written into a committed file. Keys that are data rather than names (paths, ids) are recorded as `*`. A baseline in another format is refused with the reason rather than misread, and a source the baseline never recorded is named as untracked instead of reported as movement.
