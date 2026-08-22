# peirad

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
