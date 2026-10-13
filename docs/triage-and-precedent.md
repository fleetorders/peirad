# Triage and precedent

Two commands that read text and never act: `triage` asks whether a drift matters, `precedent` asks whether it was already decided.

## Triage — does the drift matter?

`run` tells you _that_ something drifted; `triage` tells you _whether it
matters_. It reads an alarm — a changelog excerpt, a CI failure, a drift report
— against a rubric and prints a structured pre-assessment for the person who
has to decide. The assessment is machine-written and labelled unverified by
construction; nothing is edited or closed on its say-so.

```sh
npx peirad triage --alarm changelog.md --rubric changelog --manifest peirad.json
```

The model call goes through the harness named in your manifest, headless (no
tools, default model) — the same binary the probes exercise, invoked through
the manifest's [harness profile](https://github.com/fleetorders/peirad/blob/main/docs/harness-profiles.md). `--rubric` takes
a markdown file, or the built-in `changelog`, which builds the rubric from your
own manifest — "did anything I declared a dependency on change?" — listing
every flag, settings key, hook and transcript field your probes rely on.

```
## Pre-assessment (machine, unverified)
Verdict: action
Confidence: high
Reasoning:
- declared flag --allowedTools is renamed — "The `--allowedTools` flag is now `--allowed-tools`; the old spelling is no longer accepted."
Draft resolution:
Rename --allowedTools to --allowed-tools in the launch script; retest the PreToolUse hook.
usage: in 4 / cached 1850 / out 220 tokens · model claude-sonnet-5 · cost $0.0123
```

Two guards keep it honest:

- **Quote guard** — every reasoning point must quote a line found verbatim in
  the alarm; points that cannot be traced are dropped and counted in a
  trailing `dropped: N unquotable point(s)` line.
- **Loud failure** — if the harness call fails or times out, the command exits
  `2` with `pre-assessment unavailable: <reason>` instead of guessing.

The harness's own accounting for the call — tokens in/cache/out, model, cost —
ends up in a trailing `usage:` line, or a `usage` object with `--format json`
(`null` when the harness reports none). Pass `--usage-log <file>` to also
append one JSON row per call to that file, so triage runs you schedule or
script can be tallied afterwards; a log that cannot be written fails the
command (exit `2`) rather than pass silently.

Exit `0` on any verdict — a verdict is information, not a failure. `--format
json` emits `{verdict, confidence, reasoning, draft, dropped, assessed_at,
harness, harness_version, profile, usage, rubric}`. A `PEIRAD_HARNESS`
environment variable overrides the manifest's harness binary (the profile
still comes from the manifest), which is handy for testing.

## Precedent — has this been ruled on before?

`triage` asks whether drift matters; `precedent` asks whether it has already
been decided. Give it a work item (a markdown file with a `#` title and a
`from:` frontmatter line naming the source that raised it), a decisions log
in the `### D-<n> — title` + `**Scope:**` style, and any directories of
resolved work items (each carrying a `done:` line that says how it was closed):

```sh
npx peirad precedent --entry issues/014-canary-drift.md --ledger docs/decisions.md --resolved issues/closed --json
```

It derives the entry's class — the title's stem (up to the first `:` or
`—`) plus its `from:` source, with dates, versions and parentheticals
normalized away so recurrences collapse — then looks for earlier decisions:
resolved items of the same class (a past `done:` line is a paste-ready
resolution) and decisions whose title or scope covers the class.

```json
{
  "schema": "precedent/1",
  "matched": true,
  "class": "canary drift · scheduled sweep",
  "source": "resolved",
  "id": "013-canary-drift-2026-09-03.md",
  "resolution": "re-ran the sweep twice — known clock skew; closed without changes",
  "confidence": "high"
}
```

Three properties keep it safe to run unattended. It is **read-only** — prints,
never writes, never resolves anything itself. Matching is **deterministic
text work** — no model call; the same inputs give the same answer, and every
match names the earlier record it rests on (`confidence: high` = a resolved
item, `medium` = a decision only). And items whose text trips a
**rail keyword list** — credentials, confidential material (plus any words you
pass with `--rail-words`), system configuration, registries, releases, outward
actions — always come back `matched: false`
with the rail named. The list is deliberately over-broad: a false "no match"
costs a person a glance, a false "matched" would cost a wrong auto-resolution,
so the tool fails toward the first.

Exit `0` whether or not precedent matched — the answer is information, not a
failure. Exit `2` when inputs are unreadable (missing item, decisions log or
`--resolved` directory) or the item has no `#` title to derive a class from.
