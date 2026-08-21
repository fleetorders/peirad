#!/bin/sh
# Fake agent harness for the triage tests (PEIRAD_HARNESS=test/fake-harness.sh).
# Answers "--version" with a canned version, and every headless "-p" call with
# a canned assessment envelope: two quotes that appear verbatim in
# test/fixtures/changelog-alarm.md and one that appears nowhere (dropped by
# the quote guard).
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-harness 1.2.3"
  exit 0
fi

printf '%s\n' '{"type":"result","result":"{\"verdict\":\"action\",\"confidence\":\"high\",\"reasoning\":[{\"quote\":\"The `--allowedTools` flag is now `--allowed-tools`; the old spelling is no longer accepted.\",\"point\":\"declared flag --allowedTools is renamed\"},{\"quote\":\"Hooks now receive a `tool_input` object instead of separate fields.\",\"point\":\"declared hook payload shape changed\"},{\"quote\":\"THIS LINE APPEARS NOWHERE IN THE ALARM\",\"point\":\"speculative point that must be dropped\"}],\"draft\":\"Rename --allowedTools to --allowed-tools in the launch script, then re-run peirad; retest the PreToolUse hook against the new tool_input payload.\"}"}'
