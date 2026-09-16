---
"peirad": patch
---

A transcript glob can point outside the base directory with `{home}` and `{configDir}`.

A harness keeps its transcripts in its own configuration directory and its project hooks in the project — no single relative base directory expresses both, so a drafted manifest found either the hooks or the transcripts, never both. A `transcript-field` glob now expands `{home}` and `{configDir}` templates (`{home}/.claude/projects/**/*.jsonl`), and `peirad init` drafts exactly that shape, so the draft works from the project directory its hook probes read.
