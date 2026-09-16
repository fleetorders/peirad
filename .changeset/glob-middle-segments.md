---
"peirad": patch
---

A `*` in a middle path segment of a transcript glob is now honoured.

`projects/*/*.jsonl` is the natural way to write the transcript layout of a harness that keeps one folder per project, but the matcher ignored everything after the first `*` except the extension: such a pattern matched files one level too shallow, so `projects/*/x.jsonl`-shaped globs asserted their fields against the wrong file — a pass that proved nothing — or reported "no file matched" for transcripts that were plainly there. There is now one segment-aware glob implementation shared by the transcript probes, the baseline observer and the live run's session lookup: `*` matches within one path segment, a `**` segment across any number of them. `peirad validate` warns about a glob that uses characters this engine matches literally (`?`, brackets, braces), instead of leaving the mismatch silent.
