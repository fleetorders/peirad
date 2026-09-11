---
"peirad": minor
---

`--live` now runs on the harness's own configuration, with the login you already have.

A fresh configuration directory has no login for a harness signed in the usual way, so the live turn could not run for most users. It now uses the harness's normal configuration directory and copies nothing anywhere. The fixture hooks reach the turn as an overlay for that one invocation — a separate settings file for Claude Code, a command-line config override for Codex — and are never written into your files. Claude Code runs with `--restricted` and `--strict-mcp-config`, which set your user, project and local settings and MCP servers aside for the turn; Codex has no such switch for its hooks file, so your Codex config and hooks still load, and the turn's hook-trust bypass also lets untrusted hooks in that file run.

The transcript is found by the session id the turn reports, your `transcript-field` declarations are read from it, and then exactly that session is removed — Claude Code's transcript file (and its folder if now empty), or Codex's session through `codex delete --force <id>` so Codex's own session index stays consistent. A new `live:cleanup` line names what was removed or why something was left. The default `--live-ceiling` is now 100000 tokens.

The codex profile's usage report now counts cached tokens once: `input_tokens` is the uncached part, as the claude profile reports it. The usage line and log from `triage` under the codex profile change accordingly.
