# Decisions

Append-only. Each entry records a decision, why it went that way, and what it
forecloses. Supersede an entry with a new one; never rewrite its substance.

### D-001 — A generic engine driven by a per-project manifest

**Scope:** repo · **Decided:** 2026-08-15

The tool is one generic engine plus a declarative `peirad.json` manifest that
each project ships. Harness- and project-specific knowledge lives in the
manifest (data), never in the engine (code).

**Why:** the checks a project needs differ by project and by harness, and both
change over time. Keeping that knowledge as data means adding a project or a new
check is a manifest edit, not an engine change — and the engine stays small
enough to trust.

**Consequences:** every probe type must be expressible declaratively; a check
that cannot be described in a manifest does not belong in the engine.

### D-002 — Contract-test the live harness, never infer from a version number

**Scope:** repo · **Decided:** 2026-08-15

Probes exercise the harness that is actually installed — run the command, read a
real transcript line, check the config a build accepts — and report a dated
verdict. They never branch on a version string to guess behavior.

**Why:** agent harnesses change often and unpredictably; a version number is a
poor proxy for what a build actually accepts. Testing the live surface gives a
correct answer for an unknown future version for free, which version-matching
cannot.

**Consequences:** the tool must run in the same environment as the harness it
checks; a probe that cannot reach the live surface reports that it could not,
rather than assuming.

### D-003 — Two failure registers: degraded and blocked, never silent

**Scope:** repo · **Decided:** 2026-08-15

A drifted non-critical probe reports `degraded`; a probe marked `critical`
reports `blocked`. Neither throws — the run collects every result — and any
drift produces a non-zero exit for use in CI or a scheduled check.

**Why:** silent drift is the failure this tool exists to catch, so it must never
itself fail silently. Separating "reduced" from "broken" lets a caller react
proportionately, and naming what changed (and the version checked) is the
product's value, not an extra.

**Consequences:** every probe returns a verdict object rather than throwing; the
verdict always carries the harness version it was checked against.

### D-004 — triage asks the manifest's harness, and only keeps evidence the alarm actually says

**Scope:** repo · **Decided:** 2026-08-22

`peirad triage` pre-assesses an alarm against a rubric by calling the
manifest's own harness headless (`-p … --output-format json`, no tools,
default model). Every reasoning point in the output must quote a line found
verbatim in the alarm — points that cannot are dropped and counted. The
command prints and exits 0 on any verdict; a failed or timed-out harness call
exits 2 with `pre-assessment unavailable: <reason>` rather than guessing.

**Why:** an assessment meant to be read unattended is only as good as its
evidence being checkable and its failures being visible. The quote guard makes
fabricated evidence self-eliminating without trusting the model to self-report
it; the `(machine, unverified)` heading and the print-only contract keep the
human as the decider; routing the call through the same harness the probes
exercise means the tool never grows a second model dependency.

**Consequences:** all judgement criteria live in rubrics (markdown files), not
the engine — the built-in `changelog` rubric is derived from the manifest, so
it stays in sync with what the project declared. A point the model cannot
ground in a quoted line vanishes from the output, so a lazy answer reads as an
empty one, and an unquotable answer reads as `dropped: N`.

### D-005 — Harness profiles: the invocation and the envelope travel as data

**Scope:** repo · **Decided:** 2026-08-30

How a harness is driven headless (flags, prompt position, output format) and
how its reply is read back (single JSON envelope vs a JSONL event stream) vary
per CLI family, so both live together on a named profile the manifest selects
(`harnessProfile`, inferred from the harness name when absent — `codex` gets
the codex shape, anything unknown gets the `-p … --output-format json`
convention, which keeps existing manifests byte-compatible). `promptArgs` /
`outputArgs` replace a profile's argv templates for a CLI no built-in profile
fits; `{prompt}` is a standalone argument, never spliced into a flag.

**Why:** hardcoding one CLI's dialect made `"harness": "codex"` unwirable —
the spawn and the parsing are two halves of one contract, so they must change
together or not at all. Defaulting unknown harnesses to the existing
convention means a profile is only ever an opt-in, never a migration.

**Consequences:** a profile also declares which probes can apply: under codex,
`config-key` and `hook-registered` (JSON-settings probes) report `n/a` with
the profile named rather than passing, and `flag-accepted` reads the help the
profile points at (`exec --help`, not root `--help`). Verdicts and triage
output carry the profile used, and the triage `usage` accounting is whatever
the harness reports — codex reports token counts but neither model nor cost,
so those render as absent rather than invented.

### D-006 — precedent matches text deterministically and never acts

**Scope:** repo · **Decided:** 2026-09-04

`peirad precedent` matches a queue entry to prior rulings by text only — no
harness, no model call. The entry's class key is its title stem (the first
`#` heading up to the first `:` or `—`) plus its `from:` frontmatter
source, both normalized — digits, parentheticals and markdown marks stripped —
so recurrences of the same alarm from the same recurring source collapse to
one class. Resolved siblings (same class, carrying a `done:` line) outrank
ledger rulings, because a past resolution is paste-ready where a ruling is a
rationale; among siblings the last by filename sort is named. Ledger coverage
means the stem appears in the ruling's title or `**Scope:**` line. Entries
whose text trips a fixed rail keyword list — credentials, guarded, machine
surface, registry, release, outward action — always report `matched: false`
with the rail named.

**Why:** precedent exists so a routine, already-ruled alarm can be closed with
a receipt instead of re-litigated. That is only safe when the match is
reproducible (same inputs, same answer, no model in the loop), when the
command is read-only, and when it errs toward "no match": a false "no match"
costs a person a glance, a false "matched" costs a wrong auto-resolution, so
the rail list is deliberately over-broad and every match needs a quoteable
prior artefact.

**Consequences:** the class key is only as good as the queue's title/from
discipline — two entries a person would call the same class but titles
differently will not match, and that failure reads as "no precedent found",
never as a wrong match. Confidence is positional, not semantic: `high` means
a sibling resolution exists, `medium` means only a ruling. The rail list is
code; widening it is an engine change and a new decision, not configuration.
