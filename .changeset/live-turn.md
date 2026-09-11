---
"peirad": minor
---

`peirad run --live` proves the contracts in one real turn.

The harness is driven through one minimal headless turn in a fresh temporary configuration directory, with a fixture hook registered for every event the manifest's `hook-registered` probes declare — never the hooks already in the user's settings. The verdict then gains `live:` lines: whether a login resolved there, whether the turn completed (the model the harness reports is shown as information, never checked), its reported token usage against `--live-ceiling` (default 10000), which declared flags the real invocation carried, the manifest's `transcript-field` declarations read from the transcript this turn wrote, and whether each fixture hook actually ran. A failed live check takes the register of the probe it proves, so it counts toward the exit code like any other.

It is off by default, as the only check that spends tokens. Nothing is copied into the temporary directory — no settings, never a credential — and it is removed afterwards. Before any turn, a no-cost login check runs inside it: a harness signed in only through its default configuration directory has no login there, and the run stops at `live:login` with `n/a`, having spent nothing. `--live-timeout` (default 180 seconds) kills a turn that runs long. How each harness is driven — the variable that relocates its configuration, the login check, where hooks and transcripts go, the turn's extra arguments — is profile data; `--json` carries `live: { turned, tokens }`.
