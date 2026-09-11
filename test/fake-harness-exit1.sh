#!/bin/sh
# Fake harness for the non-zero-exit triage test
# (PEIRAD_HARNESS=test/fake-harness-exit1.sh). Answers "--version" with a
# canned string like test/fake-harness.sh does, then fails the headless call
# the way a logged-out harness does: two lines on stderr, exit 1 — the cause
# assessAlarm must carry into its reason instead of a bare exit number.
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-harness-exit1 1.2.3"
  exit 0
fi

echo "auth: not logged in" >&2
echo 'run `claude login`' >&2
exit 1
