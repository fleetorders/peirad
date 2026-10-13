# Harness profiles

Agent CLIs disagree on how to be driven headless: one takes `-p <prompt>
--output-format json` and prints a single envelope; another wants a subcommand,
the prompt as a positional, `--json` for an event stream, and reports usage at
the end of the turn. A **harness profile** holds that shape — how to pass a
one-shot prompt, how to ask for machine-readable output, how to read the reply
and the token/cost numbers back out.

Two are built in:

- **`claude`** — `-p <prompt> --output-format json`; reply from the envelope's
  `result`, usage from its `usage` block.
- **`codex`** — `codex exec --skip-git-repo-check --sandbox read-only --color
never <prompt> --json`; reply from the final `agent_message` event, usage
  from `turn.completed`.

The manifest selects one with `harnessProfile`; when it is absent, the harness
name decides (`"harness": "codex"` gets the codex profile) and an unknown
harness falls back to the claude convention. For a CLI neither profile fits,
replace the argv templates directly — `promptArgs` must contain one `{prompt}`
element (a standalone argument, never spliced into a flag), `outputArgs` is
appended after it:

```json
{
  "harness": "my-cli",
  "harnessProfile": "codex",
  "promptArgs": ["exec", "--no-banner", "{prompt}"],
  "outputArgs": ["--json"],
  "probes": []
}
```

Profiles also say which probes can apply. The settings-file probes
(`config-key`, `hook-registered`) read JSON; under a profile whose CLI family
keeps no JSON file they report `n/a` with the profile named — declared
inapplicable, never silently passed. Both built-in profiles have one: Claude
Code's `settings.json`, and Codex's `hooks.json` (its `config.toml` is TOML
and out of `config-key`'s reach), so a codex manifest points `file` at
`hooks.json`. `flag-accepted` reads the help the profile points at (root
`--help`, or a subcommand's `exec --help` for codex).

A probe type the installed peirad does not know reports `n/a` naming the
type and the engine version — a manifest written for a newer release never
crashes an older one; upgrade peirad or remove the probe.
