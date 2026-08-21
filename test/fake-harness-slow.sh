#!/bin/sh
# Fake harness that never answers in time — exercises the timeout path.
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-harness 1.2.3"
  exit 0
fi

sleep 30
