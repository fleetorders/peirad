---
"peirad": minor
---

`peirad precedent` — new command: match a queue entry (markdown with a `#` title and a `from:` frontmatter line) to prior rulings and emit the resolution to apply. Derives the entry's class from the title stem plus `from:` source, searches resolved sibling entries (their `done:` lines, `confidence: high`) and a decisions ledger (`### D-00n` rulings, `confidence: medium`), and reports `precedent/1` JSON or a markdown block. Read-only by construction — it prints, never writes — and entries whose text trips a rail keyword list (credentials, guarded, machine surface, registry, release, outward action) always report `matched: false` with the rail named.

`--rail-words <file>` — extra whole-word keywords for the guarded rail, one per line, so a fleet's
own vocabulary for never-auto-resolve material stays in the fleet rather than in this tool; the
built-in rail reads guarded, confidential, proprietary, internal-only.
