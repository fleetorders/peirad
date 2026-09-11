---
"peirad": minor
---

A new `env` probe asserts the environment contract around the harness.

Declare which variables must be `set` or `unset`, the value a variable `equals`, a pattern it `matches`, and what it `pointsAt` — an existing `file`, `dir`, `executable` (a bare name is looked up on PATH) or `path`. By default the probe checks the environment peirad runs in; with `scope: "effective"` the variables the harness's own settings declare are laid over it across the whole settings stack, and each line names where a value came from (`(settings: project)`, `(process)`). The claude profile declares its settings' `env` block; a manifest can name one with `settingsEnv`.

Values are treated as secrets: a value appears in a verdict line only when the variable's name does not look like a credential and the value is short and plain. Nothing asks a model what it is — the checks are deterministic, and a model's account of itself is not evidence of its configuration.
