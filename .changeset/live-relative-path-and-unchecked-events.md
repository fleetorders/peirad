---
"peirad": patch
---

A relative harness path survives the live turn's working directory, and an undrivable hook event is unchecked rather than drift.

The live run works from a temporary directory, so a harness named by a path relative to where peirad was started — which the deterministic probes resolve fine — failed its first spawn there and reported a signed-in harness as not signed in. The path is made absolute, against the directory the run started in, before anything spawns.

And a declared hook event that fires only on an action no scenario this run performs — a compact, a subagent stop — used to read as drift when its fixture hook predictably did not run. The profile now declares which events a minimal turn exercises; an event outside both lists reports `n/a`, registered and unchecked, instead of blocking a healthy integration.
