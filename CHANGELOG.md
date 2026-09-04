# peirad

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
