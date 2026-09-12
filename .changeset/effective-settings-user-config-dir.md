---
"peirad": patch
---

Effective settings now follow the harness's configuration-directory override.

A `scope: "effective"` probe read the user layer beneath the home directory (`~/.claude/settings.json`), ignoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME` — the variables the live run already honours — so it could report a passing setting from a configuration the harness never loads. The user layer of each built-in profile is declared with a `{userConfigDir}` template that resolves exactly where the harness resolves it: the relocation variable when set, the default beneath the home directory otherwise. A manifest's own `settingsLayers` may use the template too.
