---
"peirad": minor
---

The `version` probe can now judge the version, not just record it: `minimum` declares a floor.

```json
{ "type": "version", "minimum": "2.1.277", "critical": true }
```

The floor is compared numerically on major.minor.patch, tolerating the shapes version strings come in — a `v` prefix, a preamble (`my-harness 2.1.277`), a missing patch. A harness older than the floor fails with both sides named (`harness 2.1.100 is older than the manifest's floor 2.1.277`); a version string that cannot be parsed fails too, because "unknown" is a broken integration, not a satisfying one. Without `minimum` the probe records the version and never judges it, exactly as before.

An integration is often only real from some version on — a repo whose entire behavioral contract rides on its instruction file, which the harness only began loading natively in a given release, is silently instruction-free on anything older, and every check built on those instructions no-ops while the record-only probe calls the integration healthy. The floor turns that day into a verdict line.
