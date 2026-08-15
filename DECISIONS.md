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
