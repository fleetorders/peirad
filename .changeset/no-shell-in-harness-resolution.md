---
"peirad": patch
---

The harness name is resolved on PATH directly, never through a shell.

`command-exists` used to find the harness by asking a shell to run `command -v <harness>`, with the manifest's `harness` string unquoted on the command line. A nonsense string containing shell syntax was evaluated as such — `true; echo marker` reported the marker's output as the resolved path and read as installed. Resolution now searches PATH for an executable file (or checks a path directly), shared with the environment contract's own `executable` lookup, so a harness string is only ever a file name to find: ordinary names and paths resolve exactly as before, and a string that names nothing reports drift instead of a false pass.
