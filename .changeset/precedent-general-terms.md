---
"peirad": patch
---

`peirad precedent` is described in general terms: a work item, a decisions log and resolved items. Two rail names change to plainer ones: `guarded` is now `confidential` (the word "guarded" no longer trips it; `--rail-words` entries now report `confidential`), and `machine-surface` is now `system-config`. A caller that keys on those two rail names needs the new ones; a caller that only checks whether `rail` is set is unaffected.
