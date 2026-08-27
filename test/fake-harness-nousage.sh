#!/bin/sh
# Fake agent harness whose envelope carries NO usage block, model or cost —
# the shape triage must report honestly as "not reported by the harness".
# The canned assessment itself is the same as fake-harness.sh's.
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-harness 1.2.3"
  exit 0
fi

printf '%s\n' '{"type":"result","result":"{\"verdict\":\"no-action\",\"confidence\":\"low\",\"reasoning\":[],\"draft\":\"none\"}"}'
