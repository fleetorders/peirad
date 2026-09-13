---
"peirad": patch
---

Settings values in a verdict line follow the env probe's rule: a value is printed only when its key does not look like a credential and the value is short and plain — a leftover key declared `absent` that happens to hold a token is named without being echoed, and a mismatch on a credential-shaped key reports that it holds a different value without printing either side. The verdict header names the profile beside the harness only when the two differ, so a manifest whose harness string is its profile prints `harness claude 2.1.223` instead of `harness claude (claude) 2.1.223`.
