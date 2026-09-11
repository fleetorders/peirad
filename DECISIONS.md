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

### D-007 — A `script` probe runs repo code, and fails open on anything but its verdict

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

### D-008 — Never exit without a verdict: an unknown probe type is `n/a`, naming the engine version

**Scope:** repo · **Decided:** 2026-09-11

A manifest may name a probe type the installed engine does not know — a
manifest written for a newer release, run by an older install. That probe
renders `n/a` with the type and the peirad version in the detail line; it
never throws, and the run still prints its dated verdict. Loading validates
the shape of every probe (an object with a string `type`) and nothing more:
an unknown type name is a run-time `n/a`, not a load error. The same rule
reaches the triage caller: a harness that exits non-zero is reported with its
name, its version and its own stderr, never as a bare exit number.

**Why:** the 0.4.0 build died with a raw `TypeError` and no verdict on exactly
this input, and a scheduled caller reported "harness exited 1" with the cause
thrown away. A checker whose pitch is catching silent failure cannot itself
fail without saying what it saw. Fail-open is the contract the `script` probe
already speaks (D-007): a probe that cannot deliver a verdict says so, and
`n/a` never counts as drift.

**Consequences:** a newer manifest degrades gracefully on an older engine —
the unknown probes read as declared-but-unchecked, which is the honest
answer. A `validate` subcommand (strict, pre-spawn) remains open as a surface
decision; the loader's shape check and the `n/a` rendering cover the crash.

### D-009 — Profile inapplicability follows the file shape, not the harness name

**Scope:** repo · **Decided:** 2026-09-11 · **Supersedes** the codex consequence of D-005

D-005 declared `config-key` and `hook-registered` inapplicable under the codex
profile because that CLI's config was TOML with no JSON hooks. Codex now keeps
hooks in a JSON file in the same `hooks.<Event>[].hooks[].command` shape the
probes already parse, so the constant was wrong in fact and the probes apply;
a codex manifest names that file. `inapplicableProbes` stays as a mechanism
for a family that genuinely has no JSON surface.

**Why:** the probes are generic JSON readers; what makes them applicable is a
JSON file to read, not which harness wrote it. Declaring a check impossible
that the machine can perform is the opposite failure to the one D-005 guarded
against (a silent pass), and just as silent.

**Consequences:** a codex manifest that names a settings file which does not
exist now reports `degraded`/`blocked` ("file not found"), not `n/a` — which
is correct, since the manifest declared a dependency the install does not
carry. Tests that asserted the old `n/a` flip to assert the file-shape rule.

### D-010 — Value is measured by triggered runs against real dependencies

**Scope:** repo · **Decided:** 2026-09-11

A manifest that nobody runs is a declaration, not a check, and a manifest
that only asserts the harness binary exists tests nothing that could drift.
From 2026-09-11 the tool's value is judged only on runs fired by a trigger — a
git pre-push hook, CI, or a schedule — in projects whose manifest declares a
dependency the harness could actually break: a transcript field read, a hook
registered on an event, a flag passed. The first review of such runs is dated
2026-09-25.

**Why:** two things had been mistaken for adoption: a manifest present in a
repo, and a `doctor` script defined in its package.json — with nothing calling
it. Neither produces a verdict anyone reads. Evidence of value is a run that
printed a line which changed what someone did; that needs a trigger and a real
dependency behind it, not a wider roll-out.

**Consequences:** a drifted contract blocks a push where the hook runs until
the manifest or the wiring is fixed — that is the signal, not a nuisance to
silence. A `hook-registered` probe presupposes the hook is installed on the
machine that runs the check; an uninstalled integration is drift by definition
and is not exempted with a non-blocking run. The codex-profile applicability
fix (D-009) reaches codex manifests only after the next release; until then
those probes read `n/a` on the published build. Review question on 2026-09-25:
did any triggered run print something worth reading, and was anything caught
that nothing else would have. The wiring that fires those runs announces this
review itself and is removed unless the review keeps it (D-012).

### D-011 — A triggered check tracks the newest release, and the verdict names the checker

**Scope:** repo · **Decided:** 2026-09-11

A wiring that fires the checker on a trigger resolves the newest published
version at run time rather than carrying a pinned one, and remembers the last
version it resolved so an unreachable registry falls back instead of failing.
Because the version now floats, the verdict header carries the checker's own
version beside the harness version, and `--json` carries it as `checker`.

**Why:** a pin is a second thing to maintain, and the maintenance is invisible
when it lapses — a fix shipped in a release reaches nobody until someone
remembers to bump a number in a file nothing tests. Resolution at run time
removes the step entirely. What a pin bought was attribution: the reader knew
which build spoke. Moving that into the verdict keeps the attribution and drops
the chore, and it serves every consumer, not only the ones that float.

**Consequences:** a check that fires on a trigger asks the registry once per
run; where the registry is unreachable and the remembered version is not
cached, the run says so and does not fail — a checker that cannot be fetched is
not evidence of drift, and conflating the two would teach the reader to ignore
the line. A release therefore reaches every triggered wiring on its next run,
which makes a bad release visible fast and unpinnable: the fix is another
release, not an edit in each consumer.

### D-012 — A wiring added to answer a question announces its own review date

**Scope:** repo · **Decided:** 2026-09-11

Any wiring installed to answer a question about the tool — rather than to check
a contract someone depends on — carries the date of the review that judges it.
From that date every run prints what the question was and the two ways to close
it: move the date and record why, or remove the wiring with the single command
that does it. The default is removal, and the runner states it.

**Why:** the failure mode of an experiment is not a wrong answer, it is no
answer — the wiring stays, stops being read, and becomes furniture that nobody
can justify or dares remove. A date in a note decays silently; a date in the
thing that runs cannot, because it speaks in the place the evidence appears.

**Consequences:** the review question from D-010 now lives in the runner as
well as in this file, and the two must move together. A wiring whose review is
passed keeps nagging until someone decides, which is the intent — the noise is
the forcing function, and silencing it without deciding is the one disallowed
response.

### D-013 — A triggered check runs the working checkout, not the published release

**Scope:** repo · **Decided:** 2026-09-11 · **Supersedes:** the version source in D-011

Where a working checkout of this tool is present on the same machine, a wiring
that fires it on a trigger runs that checkout — rebuilding it when its sources
are newer than its build — rather than fetching a published release. The
registry becomes the fallback for a machine with no checkout. Every run prints
the version, the revision, and whether the checkout had uncommitted work.

**Why:** D-011 removed the chore of bumping a pin, but kept a slower gate in
place: a fix reached a consumer only after a release, and a release is a manual,
batched act. When the tool and the thing it checks are developed in parallel,
that gate is the bottleneck — the consumer spends the whole feature cycle
testing against a build that predates the work. Running the checkout collapses
the distance to a single commit, and makes the tool's own changes visible in the
place they are supposed to matter, immediately rather than eventually.

**Consequences:** a run can no longer be identified by version alone, since the
package version is unchanged across a day of commits — the revision on the
printed line is the identifier, and `checker` in the verdict names only the
version. A checkout mid-refactor produces no verdict, which is a loud skip and
never a block: the tool being briefly broken must not start failing the pushes
of the projects that check with it. That is a deliberate asymmetry — real drift
still blocks, an absent checker never does. A release remains how a machine
without the checkout gets the work, and how anyone else does; it is no longer
how the checked projects get it.

### D-014 — A declared assertion this build cannot make is `degraded`, never a silent pass

**Scope:** repo · **Decided:** 2026-09-11

A probe may carry a field the installed engine does not understand — a manifest
written for a newer release, run by an older install. The probe still runs every
assertion it does understand, then reports `degraded` and names the field it
skipped and the engine version that did not know it. It is never `blocked`,
however `critical` the probe. Manifest-level keys the build does not know are
reported as a note instead and leave the exit code alone. A key beginning with
`_` is a comment, never a field. The strict counterpart is `peirad validate`,
which refuses an unknown field outright.

**Why:** D-008 settled the neighbouring case — an unknown probe _type_ renders
`n/a`, because nothing about it was understood and nothing was claimed. An
unknown _field_ is the opposite shape: the probe runs, finds the part it
understands intact, and would hand back `pass` — a pass for an assertion nobody
made. That is precisely the silent failure this tool exists to catch, and it
would be this tool producing it. `blocked` would be the wrong register in the
other direction: it says a dependency broke, and would send a reader looking
for drift in a harness that is fine. What actually happened is that the checker
is old.

**Consequences:** an older engine meeting a newer manifest exits non-zero, and
the line says the fix is an upgrade rather than an investigation. That is a
deliberate cost: a team on mixed versions sees the split the day it appears
instead of trusting a partial check. Every probe type must keep its field list
in `PROBE_FIELDS` current — a field missing from that table reads as unknown to
its own build, which makes the table a gate on adding one.

### D-015 — A helper program is declared on the probe that already asks about PATH

**Scope:** repo · **Decided:** 2026-09-11

A feature that shells out to another program declares it as `command` on a
`command-exists` probe, rather than getting a probe type of its own. A probe
with no `command` still checks the harness, as it always did. `command-exists`
keeps reporting `degraded`/`blocked` — never `n/a` — when the program is not on
PATH, wherever the manifest is run.

**Why:** the question is identical to the one the probe already answers, and a
second type would split "is it on PATH" across two spellings. On the register:
running a manifest somewhere the harness was never installed looks like a
reason to report `n/a`, but D-010 already settled it — an uninstalled
integration is drift by definition, and exempting it would make the tool quiet
in exactly the case where nothing works at all.

**Consequences:** a public repo whose contributors do not all install the
harness cannot run this manifest from a tracked hook without failing their
pushes; the trigger belongs in a machine-local hook or a CI job where the
harness is installed. That constraint is inherited from D-010, not new here.

### D-016 — A settings probe judges the stack, and the precedence is profile data

**Scope:** repo · **Decided:** 2026-09-11

A `config-key` or `hook-registered` probe may read the harness's whole settings
stack rather than one file (`scope: "effective"`). Which files, in what order,
and how values found in several of them combine are declared as data —
`settingsLayers` and `settingsArrays` on the harness profile, overridable by a
manifest for a harness the profiles do not know — never as code branching on a
harness name. Reading one named file stays the default. A layer that will not
parse fails the probe rather than being skipped.

**Why:** a harness reads a stack and a probe read a file, so the probe was
answering a question nobody asked. Both directions were wrong: a hook moved
from project scope to user scope reported drift although nothing had broken,
and a setting a higher layer overrode reported present although the harness
never saw it — the second is the silent pass this tool exists to catch. Keeping
the stack as data follows D-001: another harness's precedence is a profile
edit, not an engine change. The unparseable layer fails rather than degrades
quietly because the effective settings are genuinely unknowable while one file
is broken, and the harness reading the same stack is no better off.

**Consequences:** the verdict must name the scope a setting came from — without
it "present" is no more informative than before — so every effective read
carries its provenance and the layers it read. The layer paths are documented
harness locations, expanded from `{home}`/`{configDir}` at run time, so nothing
in the profile names a particular machine. A stack whose files are all absent
is not an error: the merged settings are empty and the declared keys are
missing, which is the correct verdict.

### D-017 — The ledger records names near what was declared, and never reaches the exit code

**Scope:** repo · **Decided:** 2026-09-11

A run may record the surface it observed — harness version, flag tokens in the
help, settings key names, transcript field names — to `peirad.baseline.json`
beside the manifest, but only when asked (`--record-baseline`). The file is
meant to be committed. Once it exists, every run compares against it and
reports what moved that no probe declares, as a register of its own. Three
rules bound it. **It never changes the exit code.** **It records names, never
values.** **It records only near what the manifest points at:**
top-level settings names plus everything under the parent of each declared key,
and a key that is not identifier-shaped is recorded as `*` and not followed.

**Why:** a stateless run cannot say "since when", which was the gap; but this is
the tool's first write to disk, and the file lives in a repository where others
read it, so what goes into it has to be safe to publish. Values are where
secrets live. A user's own settings layer is personal: under an effective read
it is part of what the probe sees, and writing every key in it into a team's
repository would publish one person's configuration. The neighbourhood of a
declared key is also where the useful movement is — a key renamed beside the
one you check — so the scope that protects privacy is the scope that carries
the signal. Non-identifier keys are data (file paths, ids, plugin sources): they
would leak content and turn every new entry into noise. Movement stays out of
the exit code because a harness update moves things constantly, and a checker
that fails on every release teaches its reader to stop reading; the declared
probes already say whether something broke.

**Consequences:** the ledger cannot see movement in a part of the settings no
probe mentions — deliberately. A declared name that disappears is reported by
its probe, not duplicated by the ledger. A baseline written in another format is
refused with the reason; a source the manifest reads now but the baseline never
recorded is named as untracked rather than diffed. Comparing requires observing,
which spawns the harness's help once more per run while a baseline exists.

### D-018 — One generic probe reads the harness's own reports, and an unreadable report is `n/a`

**Scope:** repo · **Decided:** 2026-09-11

What a harness says about itself — its server list, its doctor — is asserted by
one probe type, `harness-reports`, rather than a probe per report. Each profile
declares its reports as data: the arguments, and how to read the output (a JSON
document with an optional records path, or lines matched by a named-group
pattern, with a pattern for a valid empty report). A manifest may add or replace
reports. The probe asserts declared facts — field sets a record must match —
and reads the output whatever the exit code. A report it cannot read, or one the
profile does not declare, is `n/a` with the reason and the start of the output.

**Why:** the harness already health-checks its servers and validates its own
install; re-implementing either would be a second opinion that drifts from the
first. What the harness cannot know is which of its facts a given integration
depends on, and that is the part this tool adds. A separate server probe would
have been the same mechanism with a narrower name, and the next report would
have wanted its own. A report whose shape changed says nothing either way about
the integration: passing would be silent, and failing would blame the
integration for a change in the report, so the honest verdict is none, with the
output quoted so the reader sees why. Exit codes are ignored when the output
reads, because a doctor that finds a problem normally exits non-zero while
printing exactly the finding a probe asserts on.

**Consequences:** a probe can only assert what a report prints — whether a
server still exposes a particular tool is not in the server list, and checking
it would need a live connection this probe does not make. A line pattern in a
profile can go stale when a harness rewords its output; the cost is an `n/a`
that quotes the new output, never a false verdict, and the fix is a profile
edit. On a miss, the nearest record is weighed in declared order, so the first
field of a fact names the record. Running a report runs the harness's command
in the manifest's directory, and a server list that health-checks starts the
servers it checks — the same trust boundary as the `script` probe.

### D-019 — The environment contract is deterministic, and a variable's value is a secret until shown otherwise

**Scope:** repo · **Decided:** 2026-09-11

An `env` probe asserts variables around the harness — set, unset, an exact
value, a pattern, a path that exists as a file, directory or executable. By
default it checks the environment peirad runs in; with `scope: "effective"`
the variables the harness's settings declare are laid over it, read across the
settings stack, with the block's location kept as profile data
(`settingsEnv`). A value is printed only when the variable's name does not look
like a credential and the value is short and plain; a path is printed on a
path failure under the same name rule. No probe asks a model which model or
provider it is.

**Why:** a provider endpoint, a config directory or a certificate bundle
changes with a shell edit, and the harness does not report it. These are facts
a machine can check exactly, so they are checked exactly. A model's report of
its own identity is not such a fact — the harness's own accounting has labelled
calls wrongly — so treating it as evidence would put a guess where a check
belongs. The printing rule exists because a verdict is written to be read in CI
logs: an assertion about an API key is exactly the case where echoing the value
would publish it, and "holds a different value than declared" is enough to act
on.

**Consequences:** some mismatches are reported without the value that would
make them obvious — the cost of never leaking one, and the variable name is
always there. The name heuristic can hide a harmless value under a
credential-like name; it cannot show a secret under one. The process scope
checks peirad's own environment, which matches the harness's only when both are
started from the same place — a harness launched by a desktop app or a service
manager may see a different environment, and running the check from where the
harness runs is the fix, as for every other probe.

### D-020 — The live turn copies nothing into its isolated directory, and refuses before spending when it finds no login there

**Scope:** repo · **Decided:** 2026-09-11

`--live` drives the harness through one headless turn in a fresh temporary
configuration directory, removed afterwards. The fixture hooks it registers are
derived from the manifest's `hook-registered` probes, never from the user's
settings. Nothing is copied into the directory: not settings, and never a
credential. Before the turn, a login check that spends nothing runs inside the
directory; when it finds no login, the live run reports `n/a` and stops. The
token ceiling is compared with the usage the harness reports once the turn
ends; a timeout bounds the turn's duration. A failed live check takes the
register of the manifest probe it proves. How a harness is driven is profile
data (`live`).

**Why:** the point of a live turn is to prove what the manifest declares, so
the hooks under test must be the declared ones — installing the hooks a user
already has would make every run pass on whatever happens to be configured.
Isolation is what makes the run safe to repeat: a fixture hook written into a
user's real settings is a change to their harness, which this tool does not
make. The same isolation is why credentials stay out. A harness whose login is
tied to its default configuration directory has no login in a fresh one, and
the only ways around that inside the directory are to copy the credential in or
to point the run at the user's real directory; the first spreads a secret into
a temporary tree, the second gives up the isolation. Refusing at a check that
costs nothing turns that into a line the reader can act on, before a single
token is spent. The ceiling cannot be enforced part-way through a turn, so it
is honest to compare after rather than to promise a cap.

**Consequences:** a user signed in only through the harness's default
configuration directory cannot use `--live` until the harness has a login it
reads from the environment. A single turn can exceed a small ceiling on its own
(a harness's system prompt and tool descriptions count), and the verdict then
says so. Flags the turn does not carry remain checked against help text only.
The turn's extra arguments and prompts are declared from each harness's help
text; if a build rejects one, `live:turn` fails naming the harness's own error.
The codex profile passes that harness's hook-trust bypass, scoped to the one
invocation whose only hook is peirad's fixture.

### D-021 — Every verdict names the probe types its manifest declares, and the ones it does not

**Scope:** repo · **Decided:** 2026-09-11

A verdict carries a coverage line: the probe types this build offers that the
manifest declares, the ones it does not, and any type the manifest names that
the build does not know. `version` is left out of both lists, since it stamps
the verdict rather than checking a dependency. The line never changes the exit
code.

**Why:** a pass says only that what was declared still holds. A manifest that
declares that the harness binary exists passes exactly as a manifest that pins
flags, hooks and transcript fields does, and the reader of the verdict cannot
tell the two apart. Listing the undeclared types costs no inference about the
project — it is read straight off the manifest — so it can be on every run
without being wrong about anything.

**Consequences:** the list is relative to the running build's probe types, so
it grows as probe types are added, and an older build lists fewer. It is not a
score and has no threshold: an integration may rightly need only two probe
types, and the line only makes that choice visible. Naming what the project's
own code uses but never declared is a different question, which needs a scan
of the code; that lives in its own command rather than on every verdict.

### D-022 — The manifest is derived by a deterministic scan with a line behind every entry, and its coverage report only proposes

**Scope:** repo · **Decided:** 2026-09-11

`peirad init` drafts a manifest from a project's files using a fixed set of
pattern rules — flags after a harness name, hooks in the JSON hooks shape,
helper programs those hooks start, transcript fields in code that mentions
JSON lines — and writes the file and line behind every entry into a `_from`
comment key. It never overwrites a file. `run --coverage` compares a manifest
with the same scan and reports both directions — used but undeclared, declared
but not found — without touching the exit code. No model reads the code.

**Why:** an integration's dependencies are already written down in the code
that has them; asking a maintainer to restate them from memory is why manifests
stay thin. A model could read the code more cleverly, but a proposal nobody can
trace to a line is a guess, and a checker built on "silent failure is the
enemy" cannot hand out untraceable entries. Rules that fit in one file are
predictable: the same project always drafts the same manifest, and a wrong
entry points at the rule that produced it. The comparison stays out of the exit
code because the scan sees only the repository — a hook in a user's own
settings is a real dependency the scan cannot see — so its findings are
proposals for a maintainer, not verdicts.

**Consequences:** some dependencies are invisible to the rules — a flag
assembled in a variable lines away, a harness invoked through a wrapper with a
different name — and some findings are noise, most of all transcript fields
taken from other JSON in the same file; the draft labels that entry. The `_from`
key relies on the comment convention from D-014, so a drafted manifest runs
unchanged on this build and warns nothing under `validate`. Drafted file paths
are relative to the scanned directory, so the draft belongs at its root.

### D-023 — A strict `validate` is the counterpart of the lenient run, and splits errors from warnings by what they depend on

**Scope:** repo · **Decided:** 2026-09-11 · **Settles** the surface left open in D-008

`peirad validate` reads a manifest without starting any process. It refuses an
unknown field, an unknown probe type, a value of the wrong shape, a missing
required field and a probe that declares nothing, each with its JSON path and
line, and exits 1. It warns without failing about what depends on the machine
rather than the manifest: a file or script that does not exist at the resolved
path, a report name the harness profile does not declare, a flag entry that
does not start with `-`. Comment keys (`_`) are ignored, as in a run. The
strict schema is data kept in step with the run's field table by a test.

**Why:** the run forgives an unknown field so a newer manifest still gets a
verdict on an older install (D-014), and that leniency is only safe beside
something strict — otherwise a misspelt field becomes a `degraded` line that
reads like drift in the harness, discovered at the first scheduled run instead
of in review. Line numbers matter because the manifest is nested JSON: a finding
that names `probes[2]` without a line makes the reader count braces. The
error/warning split follows what a finding depends on. A wrong shape is wrong on
every machine; a settings file that does not exist yet may exist where the
check actually runs, and failing validation for it would make a correct
manifest fail in the repository where it is written.

**Consequences:** every new probe field needs a check here as well as a row in
the run's field table, and the parity test fails until both exist. `validate`
judges against the running build, so a manifest naming a profile or probe type
from a newer release fails it on an older one — the strict answer by design,
while the run on that build still degrades gracefully. It accepts JSON only,
exactly as the runner loads it.

### D-024 — The live turn runs on the harness's own configuration with the user's settings set aside, and removes exactly the session it created

**Scope:** repo · **Decided:** 2026-09-11 · **Supersedes:** the isolated directory and the login consequence of D-020

The live turn runs against the harness's normal configuration directory, with
the login the user already has; nothing is copied anywhere, and the no-cost
login check still runs first. The fixture hooks reach the turn as an overlay
for that one invocation — a separate settings file, or a command-line config
override — and are never written into the user's files. Where the harness has a
switch that sets the user's own settings aside, the profile passes it. The
turn's transcript is found by the session id the turn reports, read, and then
removed: the file itself, and its folder if that leaves it empty, or through the
harness's own delete command where the harness indexes sessions outside their
files. A value that does not look like a session id is never used to find or
remove anything, and nothing else is touched. The default token ceiling is 100000. How each of these works per harness is profile data.

**Why:** a fresh directory has no login for a harness signed in the usual way,
so D-020's isolation made the live run unusable for the people it is for, and
the alternatives were a credential passed into every run or a second login
kept only for testing. An overlay keeps the user's files unwritten, and setting
the user's own settings aside keeps the check about what the manifest declared
rather than what happens to be configured. A turn writes a transcript into the
real directory, so it has to be removed or every run leaves one behind; the
session id is the only safe way to name that one file among many. Removing a
session through the harness's own command where the harness also indexes it
matters because deleting only the file would leave the harness inconsistent —
an inconsistency this tool would have created and would itself report.

**Consequences:** isolation is weaker than a separate directory. Managed policy
settings apply to the turn, and where a harness has no switch to set the user's
hooks aside (the codex profile), the user's own config and hooks load, and the
hook-trust bypass the overlay needs also lets untrusted hooks in the user's
hooks file run. Cleanup that cannot be done is reported as `n/a` naming what was
left, never as drift. Measured usage for a minimal turn varies widely between
harnesses, which is why the ceiling default is generous and stays a
command-line value. The same change normalises the codex profile's usage report
so `input_tokens` counts only uncached input, as the other profile reports it;
before, any total added that harness's cache twice.
