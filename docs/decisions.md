# Design decisions

How peirad is shaped and why. Each entry states a decision, the reason behind it and what it
rules out. Numbers are stable: an entry that no longer shapes the code is removed and its
number is not reused. Code cites an entry as `docs/decisions.md, D-008`.

### D-001 — A generic engine driven by a per-project manifest

The tool is one generic engine plus a declarative `peirad.json` manifest that each project
ships. Knowledge about a harness or a project lives in the manifest (data), never in the
engine (code).

**Why:** the checks a project needs differ by project and by harness, and both change over
time. Keeping that knowledge as data makes adding a project or a check a manifest edit rather
than an engine change, and keeps the engine small enough to trust.

**Consequences:** every probe type must be expressible declaratively; a check that cannot be
described in a manifest does not belong in the engine.

### D-002 — Contract-test the live harness, never infer from a version number

Probes exercise the harness that is actually installed: run the command, read a real
transcript line, check the config a build accepts. They report a dated verdict and never
branch on a version string to guess behaviour.

**Why:** agent harnesses change often and unpredictably, and a version number is a poor proxy
for what a build accepts. Testing the live surface gives a correct answer for an unknown
future version for free, which version matching cannot.

**Consequences:** the tool must run in the same environment as the harness it checks. A probe
that cannot reach the live surface reports that it could not, rather than assuming.

### D-003 — Two failure registers: degraded and blocked, never silent

A drifted non-critical probe reports `degraded`; a probe marked `critical` reports `blocked`.
Neither throws: the run collects every result, and any drift produces a non-zero exit for CI
or a scheduled check. The verdict header names the harness version and peirad's own version
(`checker` in `--json`), so a reader knows which build spoke.

**Why:** silent drift is the failure this tool exists to catch, so it must never itself fail
silently. Separating "reduced" from "broken" lets a caller react proportionately, and naming
what changed, and the versions involved, is the product's value rather than an extra.

**Consequences:** every probe returns a verdict object rather than throwing; the verdict always
carries the versions it was produced under.

### D-004 — `triage` asks the manifest's harness, and keeps only evidence the alarm actually says

`peirad triage` pre-assesses an alarm against a rubric by calling the manifest's own harness
headless (prompt flag, JSON output, no tools, default model). Every reasoning point in the
output must quote a line found verbatim in the alarm; points that cannot are dropped and
counted. The command prints and exits 0 on any verdict; a failed or timed-out harness call
exits 2 with `pre-assessment unavailable: <reason>` rather than guessing.

**Why:** an assessment meant to be read unattended is only as good as its evidence being
checkable and its failures being visible. The quote guard makes fabricated evidence
self-eliminating without trusting the model to report it; the `(machine, unverified)` heading
and the print-only contract keep the human as the decider; routing the call through the same
harness the probes exercise means the tool never grows a second model dependency.

**Consequences:** all judgement criteria live in rubrics (markdown files), not the engine. The
built-in `changelog` rubric is derived from the manifest, so it stays in step with what the
project declared. A point the model cannot ground in a quoted line vanishes from the output,
so a lazy answer reads as an empty one and an unquotable answer reads as `dropped: N`.

### D-005 — Harness profiles: the invocation, the envelope and applicability travel as data

How a harness is driven headless (flags, prompt position, output format) and how its reply is
read back (a single JSON envelope or a JSONL event stream) vary per CLI family, so both live
together on a named profile the manifest selects (`harnessProfile`, inferred from the harness
name when absent; an unknown harness gets the prompt-flag and JSON-output convention, which
keeps existing manifests byte-compatible). `promptArgs` and `outputArgs` replace a profile's
argv templates for a CLI no built-in profile fits; `{prompt}` is a standalone argument, never
spliced into a flag.

A profile may also declare probe types that cannot apply to its family
(`inapplicableProbes`); those report `n/a` with the profile named. Applicability follows the
file shape, not the harness name: the settings probes are generic JSON readers, so a harness
that keeps its hooks in a JSON file of the shape they parse gets those probes, and a manifest
for it names that file.

**Why:** hard-coding one CLI's dialect made a second harness unwirable. The spawn and the
parsing are two halves of one contract, so they must change together or not at all, and
defaulting unknown harnesses to the existing convention makes a profile an opt-in rather than
a migration. Declaring a check impossible that the machine can perform is a silent failure of
the same kind as a silent pass.

**Consequences:** `flag-accepted` reads the help the profile points at (for example
`exec --help` rather than root `--help`). Verdicts and triage output carry the profile used,
and triage `usage` accounting is whatever the harness reports: a harness that reports token
counts but neither model nor cost renders those as absent, never invented. A manifest that
names a settings file which does not exist reports `degraded` or `blocked`, not `n/a`, because
it declared a dependency the install does not carry.

### D-006 — `precedent` matches text deterministically and never acts

`peirad precedent` matches a work item to earlier decisions by text only: no harness, no model
call. A work item is a markdown file with a `#` title and a `from:` frontmatter line naming
what raised it; a resolved item also carries a `done:` line saying how it was closed. The
item's class key is its title stem (up to the first `:` or em dash) plus its `from:` source,
both normalised (digits, parentheticals and markdown marks stripped), so recurrences of the
same alarm from the same source collapse to one class. Resolved items of the same class
outrank logged decisions, because a past resolution is paste-ready where a decision is a
rationale; among resolved items the last by filename sort is named. A decision covers the
class when the stem appears in its title or its first lines. Items whose text trips one of a
fixed list of stop topics, each called a rail (credentials, confidential material, system
configuration, registries, releases, outward actions such as pushing or sending) always report
`matched: false` with the rail named.

**Why:** precedent exists so a routine, already-decided alarm can be closed with a receipt
instead of being raised again. That is only safe when the match is reproducible (same inputs,
same answer, no model in the loop), when the command is read-only, and when it errs toward "no
match": a false "no match" costs a person a glance, a false "matched" costs a wrong automatic
resolution, so the rail list is deliberately over-broad and every match needs a quotable
earlier record.

**Consequences:** the class key is only as good as the items' title and `from:` discipline;
two items a person would call the same class but titled differently will not match, and that
failure reads as "no precedent found", never as a wrong match. Confidence is positional, not
semantic: `high` means a resolved item exists, `medium` means only a decision. The rail list is
code; a project adds its own words through `--rail-words`, and widening the built-in list is
an engine change.

### D-007 — A `script` probe runs repo code, and fails open on anything but its verdict

The `script` probe type executes an executable the manifest's own repo provides: exit 0
passes, exit 1 fails (the script's stdout is the finding, and `critical` still escalates to
blocked), and exit 2, or any other non-verdict outcome (missing, not executable, killed by the
timeout, crashed), reports `n/a`, never a fail. Running a manifest's scripts is running that
repo's code, the same trust as its npm scripts; a manifest is only as trustworthy as the repo
that ships it.

**Why:** some checks a manifest needs cannot be expressed by the built-in probes because they
have to do something: send an image, call a provider, compare a reply against a known
expectation. The exit-code contract (0 pass, 1 fail, 2 no verdict) means a probe that cannot
deliver its verdict is never read as the integration breaking, so `n/a` outranks `critical`,
and the engine stays generic because the check's logic lives in the repo's script.

**Consequences:** a repo can fold its bespoke checks into the same dated verdict as every
built-in probe; conversely, anyone running a foreign manifest is executing that repo's code by
design. The `n/a` register doubles as the script's own error channel, so a broken integration
and a broken probe are always distinguishable in the output.

### D-008 — Never exit without a verdict: an unknown probe type is `n/a`, naming the engine version

A manifest may name a probe type the installed engine does not know, as when a manifest
written for a newer release runs on an older install. That probe renders `n/a` with the type
and the peirad version in its detail line; it never throws, and the run still prints its dated
verdict. Loading validates the shape of every probe (an object with a string `type`) and
nothing more: an unknown type name is a run-time `n/a`, not a load error. The same rule
reaches the triage caller: a harness that exits non-zero is reported with its name, its
version and its own stderr, never as a bare exit number.

**Why:** a checker whose pitch is catching silent failure cannot itself fail without saying
what it saw. Fail-open is the contract the `script` probe already speaks (D-007): a probe that
cannot deliver a verdict says so, and `n/a` never counts as drift.

**Consequences:** a newer manifest degrades gracefully on an older engine; the unknown probes
read as declared but unchecked, which is the honest answer. The strict counterpart, which
refuses such a manifest before anything runs, is `peirad validate` (D-023).

### D-014 — A declared assertion this build cannot make is `degraded`, never a silent pass

A probe may carry a field the installed engine does not understand. The probe still runs every
assertion it does understand, then reports `degraded` and names the field it skipped and the
engine version that did not know it. It is never `blocked`, however `critical` the probe.
Manifest-level keys the build does not know are reported as a note and leave the exit code
alone. A key beginning with `_` is a comment, never a field.

**Why:** D-008 settled the neighbouring case: an unknown probe type renders `n/a` because
nothing about it was understood and nothing was claimed. An unknown field is the opposite
shape: the probe runs, finds the part it understands intact, and would hand back `pass` for an
assertion nobody made, which is precisely the silent failure this tool exists to catch.
`blocked` would be wrong in the other direction: it says a dependency broke and would send a
reader looking for drift in a harness that is fine, when what happened is that the checker is
old.

**Consequences:** an older engine meeting a newer manifest exits non-zero, and the line says
the fix is an upgrade rather than an investigation. Every probe type keeps its field list in
`PROBE_FIELDS` current; a field missing from that table reads as unknown to its own build,
which makes the table a gate on adding one.

### D-015 — A helper program is declared on the probe that already asks about PATH

A feature that shells out to another program declares it as `command` on a `command-exists`
probe rather than getting a probe type of its own. A probe with no `command` checks the
harness binary, as before. `command-exists` reports `degraded` or `blocked`, never `n/a`, when
the program is not on PATH, wherever the manifest is run.

**Why:** the question is identical to the one the probe already answers, and a second type
would split "is it on PATH" across two spellings. Running a manifest somewhere the harness was
never installed looks like a reason to report `n/a`, but an uninstalled integration is drift
by definition, and exempting it would make the tool quiet in exactly the case where nothing
works at all.

**Consequences:** a repository whose contributors do not all install the harness cannot run
its manifest from a tracked hook without failing their pushes; the trigger belongs in a
machine-local hook or in a CI job where the harness is installed.

### D-016 — A settings probe judges the stack, and the precedence is profile data

A `config-key` or `hook-registered` probe may read the harness's whole settings stack rather
than one file (`scope: "effective"`). Which files, in what order, and how values found in
several of them combine are declared as data (`settingsLayers` and `settingsArrays` on the
harness profile, overridable by a manifest for a harness the profiles do not know), never as
code branching on a harness name. Reading one named file stays the default. A layer that will
not parse fails the probe rather than being skipped.

**Why:** a harness reads a stack, and a probe that reads one file answers a question nobody
asked, in both directions: a hook moved from project scope to user scope reported drift when
nothing had broken, and a setting a higher layer overrode reported present when the harness
never saw it. Keeping the stack as data follows D-001. The unparseable layer fails rather than
degrades quietly because the effective settings are genuinely unknowable while one file is
broken, and the harness reading the same stack is no better off.

**Consequences:** every effective read names the scope a setting came from and the layers it
read; without that, "present" says no more than before. The layer paths are documented
harness locations, expanded from `{home}` and `{configDir}` at run time, so nothing in a
profile names a particular machine. A stack whose files are all absent is not an error: the
merged settings are empty and the declared keys are missing, which is the correct verdict.

### D-017 — The baseline records names near what was declared, and never reaches the exit code

A run may record the surface it observed (harness version, flag tokens in the help, settings
key names, transcript field names) to `peirad.baseline.json` beside the manifest, but only
when asked (`--record-baseline`). The file is meant to be committed. Once it exists, every run
compares against it and reports what moved that no probe declares, as a register of its own.
Three rules bound it: it never changes the exit code; it records names, never values; and it
records only near what the manifest points at (top-level settings names plus everything under
the parent of each declared key), with a key that is not identifier-shaped recorded as `*` and
not followed.

**Why:** a stateless run cannot say "since when". But this is the tool's only write to disk,
into a repository where others read it, so what goes into it has to be safe to publish. Values
are where secrets live, and a user's own settings layer is personal: writing every key in it
into a team's repository would publish one person's configuration. The neighbourhood of a
declared key is also where the useful movement is, so the scope that protects privacy is the
scope that carries the signal. Non-identifier keys are data (paths, ids, plugin sources) that
would leak content and turn every new entry into noise. Movement stays out of the exit code
because a harness update moves things constantly, and a checker that fails on every release
teaches its reader to stop reading; the declared probes already say whether something broke.

**Consequences:** the baseline cannot see movement in a part of the settings no probe
mentions, deliberately. A declared name that disappears is reported by its probe, not
duplicated here. A baseline in another format is refused with the reason; a source the
manifest reads now but the baseline never recorded is named as untracked rather than diffed.
Comparing requires observing, which spawns the harness's help once more per run while a
baseline exists.

### D-018 — One generic probe reads the harness's own reports, and an unreadable report is `n/a`

What a harness says about itself (its server list, its doctor) is asserted by one probe type,
`harness-reports`, rather than a probe per report. Each profile declares its reports as data:
the arguments, and how to read the output (a JSON document with an optional records path, or
lines matched by a named-group pattern, with a pattern for a valid empty report). A manifest
may add or replace reports. The probe asserts declared facts (field sets a record must match)
and reads the output whatever the exit code. A report it cannot read, or one the profile does
not declare, is `n/a` with the reason and the start of the output.

**Why:** the harness already health-checks its servers and validates its own install;
re-implementing either would be a second opinion that drifts from the first. What the harness
cannot know is which of its facts a given integration depends on, and that is the part this
tool adds. A report whose shape changed says nothing either way about the integration, so the
honest verdict is none, with the output quoted. Exit codes are ignored when the output reads,
because a doctor that finds a problem normally exits non-zero while printing exactly the
finding a probe asserts on.

**Consequences:** a probe can only assert what a report prints; whether a server still exposes
a particular tool is not in the server list, and checking it would need a live connection this
probe does not make. A line pattern can go stale when a harness rewords its output; the cost is
an `n/a` that quotes the new output, never a false verdict, and the fix is a profile edit. On a
miss, the nearest record is weighed in declared order, so the first field of a fact names the
record. Running a report runs the harness's command in the manifest's directory, and a server
list that health-checks starts the servers it checks: the same trust boundary as the `script`
probe.

### D-019 — The environment contract is deterministic, and a variable's value is a secret until shown otherwise

An `env` probe asserts variables around the harness: set, unset, an exact value, a pattern, a
path that exists as a file, directory or executable. By default it checks the environment
peirad runs in; with `scope: "effective"` the variables the harness's settings declare are laid
over it, read across the settings stack, with the block's location kept as profile data
(`settingsEnv`). A value is printed only when the variable's name does not look like a
credential and the value is short and plain; a path is printed on a path failure under the
same name rule. No probe asks a model which model or provider it is.

**Why:** a provider endpoint, a config directory or a certificate bundle changes with a shell
edit, and the harness does not report it. These are facts a machine can check exactly, so they
are checked exactly. A model's report of its own identity is not such a fact, so treating it as
evidence would put a guess where a check belongs. The printing rule exists because a verdict is
read in CI logs: an assertion about an API key is exactly the case where echoing the value
would publish it, and "holds a different value than declared" is enough to act on.

**Consequences:** some mismatches are reported without the value that would make them obvious,
the cost of never leaking one; the variable name is always there. The name heuristic can hide a
harmless value under a credential-like name; it cannot show a secret under one. The process
scope checks peirad's own environment, which matches the harness's only when both start from
the same place; a harness launched by a desktop app or a service manager may see a different
environment, and running the check from where the harness runs is the fix.

### D-021 — Every verdict names the probe types its manifest declares, and the ones it does not

A verdict carries a coverage line: the probe types this build offers that the manifest
declares, the ones it does not, and any type the manifest names that the build does not know.
`version` is left out of both lists, since it stamps the verdict rather than checking a
dependency. The line never changes the exit code.

**Why:** a pass says only that what was declared still holds. A manifest that declares only
that the harness binary exists passes exactly as one that pins flags, hooks and transcript
fields does, and the reader cannot tell the two apart. Listing the undeclared types is read
straight off the manifest, so it can be on every run without being wrong about anything.

**Consequences:** the list is relative to the running build's probe types, so it grows as
types are added and an older build lists fewer. It is not a score and has no threshold: an
integration may rightly need only two probe types, and the line only makes that choice
visible. Naming what the project's own code uses but never declared needs a scan of the code,
which lives in its own command (D-022) rather than on every verdict.

### D-022 — The manifest is derived by a deterministic scan with a line behind every entry, and its coverage report only proposes

`peirad init` drafts a manifest from a project's files using a fixed set of pattern rules
(flags after a harness name, hooks in the JSON hooks shape, helper programs those hooks start,
transcript fields in code that mentions JSON lines) and writes the file and line behind every
entry into a `_from` comment key. It never overwrites a file. `run --coverage` compares a
manifest with the same scan and reports both directions, used but undeclared and declared but
not found, without touching the exit code. No model reads the code.

**Why:** an integration's dependencies are already written down in the code that has them;
asking a maintainer to restate them from memory is why manifests stay thin. A model could read
the code more cleverly, but a proposal nobody can trace to a line is a guess, and a checker
built on "silent failure is the enemy" cannot hand out untraceable entries. Rules that fit in
one file are predictable: the same project always drafts the same manifest, and a wrong entry
points at the rule that produced it. The comparison stays out of the exit code because the
scan sees only the repository; a hook in a user's own settings is a real dependency the scan
cannot see, so its findings are proposals for a maintainer, not verdicts.

**Consequences:** some dependencies are invisible to the rules (a flag assembled in a variable
lines away, a harness invoked through a wrapper with another name) and some findings are
noise, most of all transcript fields taken from other JSON in the same file; the draft labels
that entry. The `_from` key relies on the comment convention from D-014, so a drafted manifest
runs unchanged and warns nothing under `validate`. Drafted paths are relative to the scanned
directory, so the draft belongs at its root.

### D-023 — A strict `validate` is the counterpart of the lenient run, and splits errors from warnings by what they depend on

`peirad validate` reads a manifest without starting any process. It refuses an unknown field,
an unknown probe type, a value of the wrong shape, a missing required field and a probe that
declares nothing, each with its JSON path and line, and exits 1. It warns without failing
about what depends on the machine rather than the manifest: a file or script that does not
exist at the resolved path, a report name the harness profile does not declare, a flag entry
that does not start with `-`. Comment keys (`_`) are ignored, as in a run. The strict schema is
data kept in step with the run's field table by a test.

**Why:** the run forgives an unknown field so a newer manifest still gets a verdict on an
older install (D-014), and that leniency is only safe beside something strict; otherwise a
misspelt field becomes a `degraded` line that reads like drift in the harness, discovered at
the first scheduled run instead of in review. Line numbers matter because the manifest is
nested JSON. The error and warning split follows what a finding depends on: a wrong shape is
wrong on every machine, while a settings file that does not exist yet may exist where the
check actually runs.

**Consequences:** every new probe field needs a check here as well as a row in the run's
field table, and the parity test fails until both exist. `validate` judges against the running
build, so a manifest naming a profile or probe type from a newer release fails it on an older
one, while the run on that build still degrades gracefully. It accepts JSON only, exactly as
the runner loads it.

### D-024 — The live turn runs on the harness's own configuration with the user's settings set aside, and removes exactly the session it created

`--live` drives the harness through one headless turn to prove what the manifest declares.
The fixture hooks it registers are derived from the manifest's `hook-registered` probes, never
from the user's settings, and reach the turn as an overlay for that one invocation (a separate
settings file, or a command-line config override); they are never written into the user's
files. The turn runs against the harness's normal configuration directory with the login the
user already has; nothing is copied anywhere, and a login check that spends nothing runs
first, reporting `n/a` when there is no login. Where the harness has a switch that sets the
user's own settings aside, the profile passes it. The turn's transcript is found by the
session id the turn reports, read, and then removed: the file itself, and its folder if that
leaves it empty, or through the harness's own delete command where the harness indexes
sessions outside their files. A value that does not look like a session id is never used to
find or remove anything. The token ceiling (default 100000) is compared with the usage the
harness reports once the turn ends, and a timeout bounds the turn. A failed live check takes
the register of the manifest probe it proves. How each of these works per harness is profile
data (`live`).

**Why:** the hooks under test must be the declared ones; installing the hooks a user already
has would make every run pass on whatever happens to be configured. A fresh, isolated
configuration directory would have no login for a harness signed in the usual way, and the
alternatives were a credential passed into every run or a second login kept only for testing;
an overlay keeps the user's files unwritten, and setting the user's own settings aside keeps
the check about what the manifest declared. A turn writes a transcript into the real
directory, so it has to be removed or every run leaves one behind, and the session id is the
only safe way to name that one file among many. Removing a session through the harness's own
command, where the harness also indexes it, avoids leaving the harness inconsistent. The
ceiling cannot be enforced part-way through a turn, so it is honest to compare afterwards
rather than to promise a cap.

**Consequences:** isolation is weaker than a separate directory: managed policy settings
apply to the turn, and where a harness has no switch to set the user's hooks aside, the
user's own config and hooks load, and the hook-trust bypass the overlay needs also lets
untrusted hooks in the user's hooks file run. Cleanup that cannot be done is reported as `n/a`
naming what was left, never as drift. A single minimal turn can exceed a small ceiling on its
own, which is why the default is generous and stays a command-line value. Flags the turn does
not carry remain checked against help text only, and if a build rejects one of the turn's
arguments, `live:turn` fails naming the harness's own error.

### D-025 — This tool checks what the caller cannot; it never replaces a guard inside the call

A project that drives an agent CLI itself usually guards its own calls: it strips environment
variables from the child so a call cannot be diverted onto another vendor or a metered key, it
runs in a scratch directory so the CLI does not load that project's own agent contract, hooks
and servers into a one-answer call, and it kills a child that hangs. peirad replaces none of
that and is never offered as a substitute for it. It observes and reports; it cannot shape
another process's environment, its working directory or its lifetime. What it checks is the
surface such a guard depends on and cannot verify for itself: that the binary is there, that
the flags the invocation passes still parse, that a declared hook is live in the harness's
merged settings, that a declared server still connects, that a transcript still carries the
fields a reader reads.

**Why:** the two look alike from a distance and are different jobs. A guard makes the wrong
call impossible at the moment it is made; a checker says whether the ground the caller stands
on has moved. Trading the first for the second exchanges a guarantee for a report, and it can
invert the verdict: a guard that strips a variable per call works precisely because the
variable may be present in the environment, so a check asserting that variable is absent fails
on a machine where everything is fine.

**Consequences:** a proposal to replace a project's own guard with a manifest is refused, and
a manifest is offered beside the guard instead. New probe types are judged by one question:
could the caller plausibly have written this check inside its own process? Where it could, the
check belongs there. Where it could not (the harness's merged settings, what the harness
reports about itself, the schema of what it wrote) it belongs here. peirad is never a fixer,
never a daemon, and never a substitute for enforcement at the call site.
