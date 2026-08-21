#!/bin/sh
# Fake harness whose headless output is not JSON — exercises the
# degrade-loudly path ("pre-assessment unavailable").
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-harness 1.2.3"
  exit 0
fi

echo "sorry, I only speak prose"
