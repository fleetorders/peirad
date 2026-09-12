---
"peirad": patch
---

A harness report whose entries are not objects is refused, not emptied.

Reading a JSON report silently dropped every entry that was not an object, so an output like `["server-one"]` became a valid report with zero records — and a `harness-reports` probe with no `find` passed a schema it never read. Non-object entries are now a changed shape: the probe says `n/a` and names how many entries were not objects, never a pass.
