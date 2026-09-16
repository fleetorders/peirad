---
"peirad": patch
---

A URL with a userinfo part is never printed in a verdict line.

`HTTP_PROXY=http://user:password@host` is short and plain in the sense the environment contract's redaction check used, so a mismatch printed the password straight into the log. A value carrying `scheme://…@…` credentials is now treated as never safe to show — in the value comparisons and in the one "points at X" line that prints a path — whatever the variable's name looks like.
