---
"peirad": minor
---

New `script` probe type: the manifest names a repo-relative executable (plus optional args and `timeoutMs`), and the doctor pass runs it — exit 0 passes, exit 1 fails with the script's stdout as the finding, and exit 2 (or any other non-verdict outcome: not executable, killed by the timeout, crashed) reports `n/a` — no verdict. The probe fails open: a broken probe can only report `n/a`, never block — even when marked critical. Running a manifest's scripts is running that repo's code, the same trust as its npm scripts.
