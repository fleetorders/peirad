---
"peirad": minor
---

Declare what a setting must _be_, not only that it exists.

- `config-key` takes `expect` (dotted key → the value it must hold, compared deeply) and `absent` (dotted keys that must not exist). An update that quietly switches a feature off is reported the day it lands, and the leftover twin of a renamed key — still parsing, still looking configured, while the harness reads the new name and runs at its default — stops passing. `keys` is now optional, and all three declarations are reported together so a wrong value never hides a leftover key.
- `command-exists` takes `command`, naming a helper program the integration shells out to, so "the harness is installed but its helper is gone" stops reading as healthy.
- A field this build does not understand no longer passes silently: the probe runs everything it does understand, reports `degraded`, and names the field and the engine version that skipped it. Never `blocked`, however critical the probe — an out-of-date checker is not drift in the harness (D-014). Unknown manifest-level keys are reported as a note and leave the exit code alone; keys beginning with `_` are comments.
- The triage rubric derived from a manifest now lists declared values, declared-absent names and helper programs alongside the existing dependencies.
