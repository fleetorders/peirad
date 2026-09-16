---
"peirad": patch
---

`--live` cleanup now removes only a session the run itself created.

When a manifest's `promptArgs` resume an existing conversation, the turn appends to that conversation's transcript — which passes the freshness check cleanup relied on, so the run deleted the user's earlier conversation along with its own session. Before anything runs, the live step now records which transcripts already exist where this turn's session will write one; a transcript that was already there is left in place and named, because this invocation did not create it. A session this run did create is removed exactly as before.
