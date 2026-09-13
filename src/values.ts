/**
 * Small helpers for reading JSON-shaped values and printing them in a verdict
 * line. They live apart from the probes so every reader of harness output —
 * the probes, the ledger, the report probe — shares one definition of "the
 * value at this path" and "the same value".
 */

/** The value at a dotted path, or `undefined` when any segment is missing. */
export function getDotted(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (
      cur &&
      typeof cur === "object" &&
      part in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Deep JSON equality — an expected value is met exactly, not approximately.
 * A caller that wants to assert one field of an object points at that field
 * with a dotted key instead of half-matching the whole object. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ka = Object.keys(ao);
    return (
      ka.length === Object.keys(bo).length &&
      ka.every((k) => k in bo && deepEqual(ao[k], bo[k]))
    );
  }
  return false;
}

/** A value as it appears in a verdict line: JSON, kept short enough that a
 * nested object cannot push the finding off the edge of the report. */
export function show(value: unknown, maxChars = 60): string {
  if (value === undefined) return "absent";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// A key that looks like it holds a credential never has its value printed,
// whatever the value looks like.
const SECRET_NAME =
  /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|SIGNATURE/i;
// A value short and plain enough to be a setting rather than a secret.
const PLAIN_VALUE = /^[\w.:@/+-]{1,80}$/;

/** Whether a name looks like it holds a credential — the name test behind
 * every rule that prints a value from the user's configuration. */
export function looksLikeCredential(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Whether a value read from the user's own configuration may appear in a
 * verdict line: the name must not look like a credential, and the value must
 * be short and plain. A string is tested as it stands; anything else as it
 * renders. One rule for settings values and env values alike — a verdict line
 * lands in CI logs either way. */
export function safeToShow(name: string, value: unknown): boolean {
  const text = typeof value === "string" ? value : show(value);
  return !looksLikeCredential(name) && PLAIN_VALUE.test(text);
}

/** Fold raw process output into one reportable line: leading non-empty lines,
 * joined with " · ", capped so a chatty finding can't wreck the render. */
export function fold(out: string, maxLines = 3, maxChars = 300): string {
  const joined = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(" · ");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}
