#!/bin/sh
# Fixture for the script-probe acceptance run: a repo-provided check that
# demonstrates all three exit channels of the `script` probe contract.
#   scripts/script-probe.sh pass   → exit 0
#   scripts/script-probe.sh fail   → exit 1, stdout is the finding
#   scripts/script-probe.sh error  → exit 2, n/a (warn, never a verdict)
case "${1:-pass}" in
  pass)
    echo "CHECK PASSES — the thing this repo checks still holds"
    exit 0
    ;;
  fail)
    echo "CHECK FAILS — the thing this repo checks drifted"
    echo "  expected: the contract the integration relies on"
    exit 1
    ;;
  *)
    echo "CHECK ERROR — could not reach the thing it checks"
    exit 2
    ;;
esac
