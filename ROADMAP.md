# Roadmap

A living list — items get done, dropped, or reordered. Deleted when stale rather
than left to rot. What exists today is described in the README, not here.

## Now

- Assert a setting's value and a renamed key's absence, and declare the helper
  programs a feature shells out to. _Shipped 2026-09-11._
- Judge settings where the harness reads them: merge the settings stack in its
  own precedence (`scope: "effective"`). _Shipped 2026-09-11._
- Report what moved that nobody declared, against a committed baseline of the
  observed surface (`--record-baseline`). _Shipped 2026-09-11._
- Assert what the harness reports about itself — a server connected, a doctor
  check passing — through one generic probe (`harness-reports`). _Shipped
  2026-09-11._
- Assert the environment contract around the harness — variables set, unset,
  holding a value, pointing at a real file — without printing secrets (`env`).
  _Shipped 2026-09-11._
- A published compatibility matrix per harness (verified-against versions).

## Next

- Adapters for more harnesses beyond the first (the manifest format is designed
  to compile to others without engine changes).
- A `--watch` mode that runs the manifest on a schedule and reports drift over
  time.

## Later

- Aggregated multi-project verdict for teams running several agent repos.
