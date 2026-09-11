# Roadmap

A living list — items get done, dropped, or reordered. Deleted when stale rather
than left to rot. What exists today is described in the README, not here.

## Now

- More probe types: environment/model-slot resolution and MCP-server presence.
- Assert a setting's value and a renamed key's absence, and declare the helper
  programs a feature shells out to. _Shipped 2026-09-11._
- A published compatibility matrix per harness (verified-against versions).

## Next

- Adapters for more harnesses beyond the first (the manifest format is designed
  to compile to others without engine changes).
- A `--watch` mode that runs the manifest on a schedule and reports drift over
  time.

## Later

- Aggregated multi-project verdict for teams running several agent repos.
