---
"peirad": patch
---

A malformed baseline costs a note, never the verdict; declarations no longer hide movement in other sources.

A baseline whose recorded lists hold something other than names — `"settings": {"settings.json": true}` — passed the file's shape check and then threw mid-comparison, and since baselines load automatically, the whole run exited without a verdict. Recorded lists are now validated when the file is read, and a comparison that cannot complete is contained the same way, as a note. Separately, the ledger's "declared" filter was global across every settings source and transcript glob, so declaring a key against one file hid the same key's removal from another file; declarations are now tracked per source, and movement in a file nobody declared the key against is reported.
