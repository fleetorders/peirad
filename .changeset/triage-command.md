---
"peirad": minor
---

Add `peirad triage`: pre-assess an alarm (a changelog excerpt, a CI failure, a drift report) against a rubric and print a structured, unverified-labelled assessment for the person deciding. The model call goes through the manifest's own harness headless; a quote guard drops any reasoning point whose quote is not found verbatim in the alarm; harness failures exit 2 with `pre-assessment unavailable`. Ships a built-in `changelog` rubric derived from the manifest, `--format md|json`, and a `PEIRAD_HARNESS` override for tests.
