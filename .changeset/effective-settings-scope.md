---
"peirad": minor
---

Settings probes can read the harness's whole settings stack, not one file.

`config-key` and `hook-registered` take `scope: "effective"`: the layers a harness merges — user, project, a local override, a managed policy file — are merged first, in the harness's own precedence, and the probe looks at the result. A hook that moved between scopes stops reading as drift; a value a higher layer overrides stops reading as present. The verdict names the scope each setting came from (`voice.enabled ← local (shadows user)`), which layers were read and how many were absent, and fails the probe naming the layer when one will not parse.

The precedence is data on the harness profile, not code: `settingsLayers` (lowest precedence first, with `{home}` and `{configDir}` expanded at run time) and `settingsArrays` (`concat` where every layer's entries apply, `override` where the nearest scope replaces the rest). A manifest can declare both for a harness the built-in profiles do not know. `file` is now optional on both probes — with `scope: "effective"` the stack decides, and a file-scope probe that names none reports `n/a`.
