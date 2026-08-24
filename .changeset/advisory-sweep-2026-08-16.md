---
"peirad": patch
---

Dev-dependency advisory sweep: tsup 8.3.5 → 8.5.1 (moves bundled esbuild to
0.27.7, clearing the GHSA-67mh-4wv8-2f99 moderate affecting tsup ≤8.3.6) and
vitest 2.1.8 → 2.1.9, the latest of the current 2.x line. Both are dev-only —
the published package ships only `dist/` and depends on commander and
picocolors. The remaining audit findings (vitest criticals GHSA-5xrq-8626-4rwp
and GHSA-9crc-q9x8-hgqq, vite high GHSA-fx2h-pf6j-xcff) require a vitest
semver-major bump and are tracked separately.
