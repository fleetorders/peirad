#!/bin/sh
# Test fixture: a repo-provided check that exercises all three exit channels of the
# `script` probe contract.
#   test/fixtures/script-probe.sh pass   → exit 0
#   test/fixtures/script-probe.sh fail   → exit 1, stdout is the finding
#   test/fixtures/script-probe.sh error  → exit 2, n/a (no verdict)
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
