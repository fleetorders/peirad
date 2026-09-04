# Decisions

Append-only fixture ledger for the precedent tests.

### D-201 — canary drift is the known clock skew

**Scope:** canary drift · **Decided:** 2026-08-30

A canary drift alarm from the nightly sweep is closed by re-running the sweep:
the drift is a known clock skew between the runner and the harness host, not a
regression.

**Why:** observed twice before; both cleared on the re-run.

### D-202 — manifest drift after a harness upgrade is expected once

**Scope:** manifest drift · **Decided:** 2026-09-01

A manifest drift alarm on the first run after a harness upgrade is expected:
the probes re-baseline on their next run and the alarm clears by itself.

**Why:** the upgrade lands between two scheduled runs by construction.

### D-203 — transcript probes stay in the manifest

**Scope:** transcript fields · **Decided:** 2026-09-02

Transcript fields an integration reads are declared probes, not incidental
implementation detail, so dropping one is drift and not cleanup.

**Why:** undeclared reads are exactly how silent breakage starts.
