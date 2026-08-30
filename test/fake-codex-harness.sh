#!/bin/sh
# Fake non-Claude harness for the profile tests (PEIRAD_HARNESS=…/fake-codex-harness.sh
# with a manifest whose profile is "codex"). Speaks the codex exec shape:
# the prompt arrives as a positional after "exec", machine-readable output is
# requested with --json, and the reply is a JSONL event stream — one
# agent_message item (the canned assessment, same quotes as fake-harness.sh so
# the quote-guard behaviour is exercised on this path too) plus a turn.completed
# usage event. The script validates the invocation shape itself and fails the
# call (exit 1) if triage sent Claude-shaped argv.
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-codex 9.8.7"
  exit 0
fi

[ "${1:-}" = "exec" ] || { echo "expected 'exec' as first arg" >&2; exit 1; }

json=0
prompt=""
skipnext=0
for a in "$@"; do
  if [ "$skipnext" = "1" ]; then
    skipnext=0
    continue
  fi
  case "$a" in
    --json) json=1 ;;
    # Flags that take a separate value argument (their value is not the prompt).
    --sandbox|--color|-s|-m) skipnext=1 ;;
    -*) : ;;
    *) prompt="$a" ;;
  esac
done

[ "$json" = "1" ] || { echo "expected --json in argv" >&2; exit 1; }
case "$prompt" in
  *"--- alarm text follows ---"*) : ;;
  *)
    echo "prompt did not arrive as a positional argument" >&2
    exit 1
    ;;
esac

# When PEIRAD_FAKE_ARGV_FILE is set, record the exact argv triage sent —
# the profile tests assert the invocation shape through it.
if [ -n "${PEIRAD_FAKE_ARGV_FILE:-}" ]; then
  printf '%s\n' "$@" > "$PEIRAD_FAKE_ARGV_FILE"
fi

printf '%s\n' '{"type":"thread.started"}'
printf '%s\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"verdict\":\"action\",\"confidence\":\"high\",\"reasoning\":[{\"quote\":\"The `--allowedTools` flag is now `--allowed-tools`; the old spelling is no longer accepted.\",\"point\":\"declared flag --allowedTools is renamed\"},{\"quote\":\"Hooks now receive a `tool_input` object instead of separate fields.\",\"point\":\"declared hook payload shape changed\"},{\"quote\":\"THIS LINE APPEARS NOWHERE IN THE ALARM\",\"point\":\"speculative point that must be dropped\"}],\"draft\":\"Rename --allowedTools to --allowed-tools in the launch script, then re-run peirad; retest the PreToolUse hook against the new tool_input payload.\"}"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":21,"cached_input_tokens":8,"cache_write_input_tokens":2,"output_tokens":43,"reasoning_output_tokens":0}}'
