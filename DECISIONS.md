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

### D-006 — A `script` probe runs repo code, and fails open on anything but its verdict

**Scope:** repo · **Decided:** 2026-09-01

The `script` probe type executes an executable the manifest's own repo
provides: exit 0 passes, exit 1 fails (the script's stdout is the finding,
`critical` still escalates to blocked), and exit 2 — or any other non-verdict
outcome: missing, not executable, killed by the timeout, crashed — reports
`n/a`, never a fail. The trust posture is explicit and documented: running a
manifest's scripts is running that repo's code, the same trust as its npm
scripts; a manifest is only as trustworthy as the repo that ships it.

**Why:** some checks a manifest needs cannot be expressed by the built-in
probes — they need to _do_ something (send an image, call a provider, compare
a reply against a known-by-construction expectation). The exit-code contract
(0 pass / 1 fail / 2 no-verdict) mirrors the warn-first, fail-open convention
those checks already follow: a probe that cannot deliver its verdict must
never be read as the integration breaking, so n/a outranks critical, and the
engine stays generic — the check's logic lives in the repo's script, not the
engine.

**Consequences:** a repo can now fold its bespoke checks into the same dated
verdict as every built-in probe; conversely, anyone running a foreign
manifest is executing that repo's code by design. The n/a register doubles as
the script's own error channel, so a genuinely broken integration and a
broken probe are always distinguishable in the output.
