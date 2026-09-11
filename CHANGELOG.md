# peirad

## 0.5.0

### Minor Changes

- b8cf68c: Declare what a setting must _be_, not only that it exists.

  - `config-key` takes `expect` (dotted key → the value it must hold, compared deeply) and `absent` (dotted keys that must not exist). An update that quietly switches a feature off is reported the day it lands, and the leftover twin of a renamed key — still parsing, still looking configured, while the harness reads the new name and runs at its default — stops passing. `keys` is now optional, and all three declarations are reported together so a wrong value never hides a leftover key.
  - `command-exists` takes `command`, naming a helper program the integration shells out to, so "the harness is installed but its helper is gone" stops reading as healthy.
  - A field this build does not understand no longer passes silently: the probe runs everything it does understand, reports `degraded`, and names the field and the engine version that skipped it. Never `blocked`, however critical the probe — an out-of-date checker is not drift in the harness (D-014). Unknown manifest-level keys are reported as a note and leave the exit code alone; keys beginning with `_` are comments.
  - The triage rubric derived from a manifest now lists declared values, declared-absent names and helper programs alongside the existing dependencies.

- cd9d5d3: The verdict as a ledger: report what moved that nobody declared.

  `peirad run --record-baseline` writes `peirad.baseline.json` beside the manifest — the harness version, the flag tokens its help carries, the settings key names around what the manifest declares, and the field names on the newest transcript — meant to be committed. Every later run compares against it and prints a third register, "moved since the baseline", listing what was added, removed or changed that no probe declares. It never changes the exit code: movement is a reason to look, and whether anything broke stays the probes' job. `--no-baseline` skips the comparison; `--baseline <file>` names another file; `--json` carries the report as `baseline`.

  The file records names, never values, and only near what the manifest points at: top-level settings names plus the neighbourhood of each declared key, so a key renamed beside the one you check is seen while the rest of a user's own settings is never written into a committed file. Keys that are data rather than names (paths, ids) are recorded as `*`. A baseline in another format is refused with the reason rather than misread, and a source the baseline never recorded is named as untracked instead of reported as movement.

- f6baaca: Every verdict names what its manifest covers. A `coverage` line lists the probe types the manifest declares and the ones this build offers that it does not (`declares command-exists, flag-accepted · not declared: hook-registered, transcript-field, …`), plus any type the build does not know. A pass means the declared contracts hold; the line keeps a two-probe manifest that passes from reading like a thorough one. It never changes the exit code; `--json` carries it as `coverage`.
- 6a53005: Derive the manifest from the project's own files.

  `peirad init` scans a project and drafts the manifest its code implies: flags passed to `claude` or `codex`, hooks registered in settings or hooks files (matched by the script they run), helper programs those hooks start, and transcript fields read by code that handles JSON lines. Every drafted probe carries `_from` — the file and line behind it — as a comment key the engine ignores, so the draft runs as it is and every entry can be traced. It prints to stdout, or writes with `-o` and never overwrites; `--harness` drafts for a named harness instead of the one the project uses most.

  `peirad run --coverage` compares an existing manifest with the same scan and names what the code uses that no probe declares, and what a probe declares that the scanned files never mention (`--scan-dir` picks the directory; `--json` carries it as `scan`). It never changes the exit code.

  The scan is deterministic and uses no model: each entry comes from a documented rule, it reads text files only, and it skips dependencies, build output and unrelated dot-directories.

- 2745386: Settings probes can read the harness's whole settings stack, not one file.

  `config-key` and `hook-registered` take `scope: "effective"`: the layers a harness merges — user, project, a local override, a managed policy file — are merged first, in the harness's own precedence, and the probe looks at the result. A hook that moved between scopes stops reading as drift; a value a higher layer overrides stops reading as present. The verdict names the scope each setting came from (`voice.enabled ← local (shadows user)`), which layers were read and how many were absent, and fails the probe naming the layer when one will not parse.

  The precedence is data on the harness profile, not code: `settingsLayers` (lowest precedence first, with `{home}` and `{configDir}` expanded at run time) and `settingsArrays` (`concat` where every layer's entries apply, `override` where the nearest scope replaces the rest). A manifest can declare both for a harness the built-in profiles do not know. `file` is now optional on both probes — with `scope: "effective"` the stack decides, and a file-scope probe that names none reports `n/a`.

- 5314b89: A new `env` probe asserts the environment contract around the harness.

  Declare which variables must be `set` or `unset`, the value a variable `equals`, a pattern it `matches`, and what it `pointsAt` — an existing `file`, `dir`, `executable` (a bare name is looked up on PATH) or `path`. By default the probe checks the environment peirad runs in; with `scope: "effective"` the variables the harness's own settings declare are laid over it across the whole settings stack, and each line names where a value came from (`(settings: project)`, `(process)`). The claude profile declares its settings' `env` block; a manifest can name one with `settingsEnv`.

  Values are treated as secrets: a value appears in a verdict line only when the variable's name does not look like a credential and the value is short and plain. Nothing asks a model what it is — the checks are deterministic, and a model's account of itself is not evidence of its configuration.

- 5540d44: A new probe asserts what the harness reports about itself.

  `harness-reports` names a report the harness produces and the facts it must carry: `{ "type": "harness-reports", "report": "mcp", "find": [{ "name": "my-server", "status": "Connected" }] }`. The harness does the checking — its own server health check, its own doctor — and the probe asserts the facts your integration relies on. A miss names what the report shows instead (`status is "Needs authentication" (expected "Connected")`), using the record that shares the first declared field.

  How to run and read each report is profile data. The claude profile declares `mcp` (`claude mcp list`) and `doctor` (`claude doctor`), both read line by line with a pattern; the codex profile declares `mcp` (`codex mcp list --json`), `doctor` (one record per check of `codex doctor --json`) and `doctor-summary` (its top-level document). A manifest can add or replace reports under `reports`, as `json` with an optional `records` path or `lines` with a named-group `pattern` and an `emptyPattern` for a valid report with nothing in it.

  Output is read whatever the exit code. A report that can no longer be read — its shape changed, it timed out, it would not run — reports `n/a` quoting the start of the output, never a pass and never drift blamed on the integration; so does a report the profile does not declare, listing the ones it does.

- 5efaca5: `--live` now runs on the harness's own configuration, with the login you already have.

  A fresh configuration directory has no login for a harness signed in the usual way, so the live turn could not run for most users. It now uses the harness's normal configuration directory and copies nothing anywhere. The fixture hooks reach the turn as an overlay for that one invocation — a separate settings file for Claude Code, a command-line config override for Codex — and are never written into your files. Claude Code runs with `--restricted` and `--strict-mcp-config`, which set your user, project and local settings and MCP servers aside for the turn; Codex has no such switch for its hooks file, so your Codex config and hooks still load, and the turn's hook-trust bypass also lets untrusted hooks in that file run.

  The transcript is found by the session id the turn reports, your `transcript-field` declarations are read from it, and then exactly that session is removed — Claude Code's transcript file (and its folder if now empty), or Codex's session through `codex delete --force <id>` so Codex's own session index stays consistent. A new `live:cleanup` line names what was removed or why something was left. The default `--live-ceiling` is now 100000 tokens.

  The codex profile's usage report now counts cached tokens once: `input_tokens` is the uncached part, as the claude profile reports it. The usage line and log from `triage` under the codex profile change accordingly.

- 9ba8d4b: `peirad run --live` proves the contracts in one real turn.

  The harness is driven through one minimal headless turn in a fresh temporary configuration directory, with a fixture hook registered for every event the manifest's `hook-registered` probes declare — never the hooks already in the user's settings. The verdict then gains `live:` lines: whether a login resolved there, whether the turn completed (the model the harness reports is shown as information, never checked), its reported token usage against `--live-ceiling` (default 10000), which declared flags the real invocation carried, the manifest's `transcript-field` declarations read from the transcript this turn wrote, and whether each fixture hook actually ran. A failed live check takes the register of the probe it proves, so it counts toward the exit code like any other.

  It is off by default, as the only check that spends tokens. Nothing is copied into the temporary directory — no settings, never a credential — and it is removed afterwards. Before any turn, a no-cost login check runs inside it: a harness signed in only through its default configuration directory has no login there, and the run stops at `live:login` with `n/a`, having spent nothing. `--live-timeout` (default 180 seconds) kills a turn that runs long. How each harness is driven — the variable that relocates its configuration, the login check, where hooks and transcripts go, the turn's extra arguments — is profile data; `--json` carries `live: { turned, tokens }`.

- d6bd3b8: Probe fidelity: five shipped defects fixed, one profile constant corrected.

  - `transcript-field` now samples the newest matching transcript by mtime, not the first by name, and names the sampled file and its date in the detail line — an old transcript beside a new one no longer reports drift the current build does not have.
  - `flag-accepted` matches whole tokens of the help output, so `--allowed` no longer passes against `--allowedTools` and `-p` no longer passes against `--print`.
  - An unknown probe type renders `n/a` naming the type and the peirad version instead of crashing the run with a `TypeError`; loading validates every probe's shape (an object with a string `type`). A manifest written for a newer release degrades gracefully on an older install.
  - `triage` reports a failed harness call with the harness name, its version and its own stderr (`harness "claude" (2.1.267) exited 1: …`) instead of a bare exit number.
  - The verdict carries the resolved path of the harness binary (`path`, also in `--json`), and `command-exists` prints it.
  - The codex profile no longer declares `config-key` and `hook-registered` inapplicable: Codex keeps hooks in a JSON file of the same shape, so a codex manifest points `file` at it (D-009).

- d8df606: `peirad validate` reads a manifest strictly, before anything is run.

  A run stays lenient — a field it does not understand is skipped and named — so a manifest written for a newer release still gets a verdict on an older install. `validate` is the strict counterpart for CI and for catching typos: it refuses an unknown field, an unknown probe type, a value of the wrong shape, a missing required field and a probe that declares nothing, each with its JSON path and line (`probes[2].absent (peirad.json:31): unknown field "absent" on a flag-accepted probe`). It lists every probe with the paths it will read, and warns — without failing — about a file or script that does not exist yet, a report the harness profile does not declare, and a flag-shaped entry that is not a flag. No harness process is started. Exit 0 when there are no errors, 1 when there are, 2 when the file cannot be read as JSON; `--json` prints the report.

- ad2df28: The verdict names the checker that produced it: the header carries `peirad <version>` beside the harness version, and `--json` carries it as `checker`. A wiring pinned to one release knows which build spoke; one that tracks the newest release did not, and a line nobody can attribute to a build is not evidence.

## 0.4.0

### Minor Changes

- bf776c5: New `script` probe type: the manifest names a repo-relative executable (plus optional args and `timeoutMs`), and the doctor pass runs it — exit 0 passes, exit 1 fails with the script's stdout as the finding, and exit 2 (or any other non-verdict outcome: not executable, killed by the timeout, crashed) reports `n/a` — no verdict. The probe fails open: a broken probe can only report `n/a`, never block — even when marked critical. Running a manifest's scripts is running that repo's code, the same trust as its npm scripts.

## 0.3.0

### Minor Changes

- 81f4122: Harnesses are now pluggable at the invocation and envelope level. A manifest can name a harness whose CLI is not Claude-shaped: `"harness": "codex"` (or an explicit `harnessProfile`) drives `codex exec` — positional prompt, `--json` event stream, usage read from the turn's token counts — while the existing `-p … --output-format json` path is unchanged and remains the default for unknown harnesses. `promptArgs`/`outputArgs` override the argv templates for a CLI no built-in profile fits (`{prompt}` marks the prompt's slot). Probes that a harness family cannot express (`config-key`, `hook-registered` under codex) now report `n/a` with the profile named instead of passing, and `flag-accepted` reads the help the profile points at (root `--help`, or `exec --help` for codex). Verdicts and triage output record the profile used.
- ef91fd4: `peirad precedent` — new command: match a queue entry (markdown with a `#` title and a `from:` frontmatter line) to prior rulings and emit the resolution to apply. Derives the entry's class from the title stem plus `from:` source, searches resolved sibling entries (their `done:` lines, `confidence: high`) and a decisions ledger (`### D-00n` rulings, `confidence: medium`), and reports `precedent/1` JSON or a markdown block. Read-only by construction — it prints, never writes — and entries whose text trips a rail keyword list (credentials, guarded, machine surface, registry, release, outward action) always report `matched: false` with the rail named.

  `--rail-words <file>` — extra whole-word keywords for the guarded rail, one per line, so a fleet's
  own vocabulary for never-auto-resolve material stays in the fleet rather than in this tool; the
  built-in rail reads guarded, confidential, proprietary, internal-only.

- 2cac5bc: `peirad triage` now surfaces what the harness said the call cost. The markdown output ends with a `usage:` line (tokens in/cache/out, model, cost), `--format json` carries the same data as a `usage` object (`null` when the harness reports none), and a new `--usage-log <file>` option appends one JSON row per call for later tallying — a log that cannot be written fails the command instead of passing silently.

### Patch Changes

- 2ad8369: Dev-dependency advisory sweep: tsup 8.3.5 → 8.5.1 (moves bundled esbuild to
  0.27.7, clearing the GHSA-67mh-4wv8-2f99 moderate affecting tsup ≤8.3.6) and
  vitest 2.1.8 → 2.1.9, the latest of the current 2.x line. Both are dev-only —
  the published package ships only `dist/` and depends on commander and
  picocolors. The remaining audit findings (vitest criticals GHSA-5xrq-8626-4rwp
  and GHSA-9crc-q9x8-hgqq, vite high GHSA-fx2h-pf6j-xcff) require a vitest
  semver-major bump and are tracked separately.
- 9d1894a: package.json now ships repository/homepage/bugs links pointing at the fleetorders GitHub org — the npm page gains a Repository link.

## 0.2.0

### Minor Changes

- 8ebf033: Add `peirad triage`: pre-assess an alarm (a changelog excerpt, a CI failure, a drift report) against a rubric and print a structured, unverified-labelled assessment for the person deciding. The model call goes through the manifest's own harness headless; a quote guard drops any reasoning point whose quote is not found verbatim in the alarm; harness failures exit 2 with `pre-assessment unavailable`. Ships a built-in `changelog` rubric derived from the manifest, `--format md|json`, and a `PEIRAD_HARNESS` override for tests.

## 0.1.0

### Minor Changes

- Initial release: contract-test an agent-harness integration against the
  harness actually installed. Probes for command presence, version,
  CLI flags, config keys, registered hooks, and transcript fields; a dated
  verdict naming the version checked; `degraded` vs `blocked` registers and a
  non-zero exit on any drift, for CI or scheduled use.
