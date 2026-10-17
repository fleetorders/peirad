#!/usr/bin/env sh
# Run this hook's untracked, machine-local companion, if one exists:
# local/hooks/<hook> at the working tree's root first, then at the main
# checkout's root — a worktree carrying its own companion is honoured, and one
# without still gets the machine's. Companions are gitignored, never tracked,
# and nothing in a tracked file names them beyond this generic path.
#
# Executing one is a trust grant by design: code no repository state can show
# gates a commit or push on this machine, unaudited by this repo — stated here
# so the grant stays visible where it operates, once for every hook that
# extends it.
#
# A clone without a companion proceeds unchecked, never failed. The tracked
# hooks resolve nothing from PATH: a checker that used to be named here is now
# wired as a companion on the machines that have it — the name was the leak.
#
# Usage: companion.sh <hook> [args…]. The companion receives the args and, when
# this is the first thing the hook does, the stdin a pre-push ref list arrives
# on. Exits with the companion's own status when one ran, 0 when none did —
# exec, not `|| exit 1`, so a companion's distinct block code survives.

hook=${1:?usage: companion.sh <hook> [args…]}
shift

# No --path-format=absolute (needs git ≥ 2.31): there its failure would be
# swallowed and the companion would silently never run. Resolve relatively and
# absolutize by hand; --show-toplevel is already absolute.
tree=$(git rev-parse --show-toplevel 2>/dev/null) || tree=""
common=$(git rev-parse --git-common-dir 2>/dev/null) || common=""
case $common in
  /*) ;;
  *) [ -n "$common" ] && common=$PWD/$common ;;
esac

for root in "$tree" "${common%/.git}"; do
  [ -n "$root" ] || continue
  if [ -x "$root/local/hooks/$hook" ]; then
    exec "$root/local/hooks/$hook" "$@"
  fi
done

exit 0
