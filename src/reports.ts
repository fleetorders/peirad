/**
 * What a harness says about itself.
 *
 * Harnesses ship their own reports — a server list with a health check, a
 * doctor that reads the install and the settings. Re-implementing any of that
 * would be a second opinion that drifts from the first. What a harness cannot
 * know is which of those facts YOUR integration relies on: that a particular
 * server is connected, that the config loads, that the install method is the
 * one your tooling expects. A `harness-reports` probe names the report and the
 * facts; the harness does the checking.
 *
 * How to run and read each report is profile data (`reports`), overridable per
 * manifest. When a report's shape changes so it can no longer be read, the
 * probe says `n/a` and names what it could not read — never a pass, and never
 * a failure blamed on your integration for what is a change in the report.
 */
import { spawnSync } from "node:child_process";
import { deepEqual, fold, getDotted, show } from "./values.js";

/** One named report a harness can produce, and how to read it. */
export interface HarnessReport {
  /** Argv after the harness binary, e.g. ["mcp", "list", "--json"]. */
  args: string[];
  /**
   * "json": stdout carries one JSON document. "lines": each output line that
   * matches `pattern` is one record, its named groups the fields.
   */
  format: "json" | "lines";
  /**
   * json only: dotted path to the records — an array, or an object whose
   * values are the records (a report keyed by check id). Absent, a top-level
   * array's elements are the records, and a top-level object is one record.
   */
  records?: string;
  /** lines only: a regular expression with named groups. */
  pattern?: string;
  /**
   * lines only: output matching this is a valid report with no records ("no
   * servers configured") — without it, zero matching lines reads as a report
   * whose shape changed.
   */
  emptyPattern?: string;
  /** Kill the command after this many ms (default 60_000). */
  timeoutMs?: number;
}

export type ReportRecord = Record<string, unknown>;

export type ReportParse =
  | { ok: true; records: ReportRecord[] }
  | { ok: false; reason: string };

export type ReportRead =
  | { ok: true; records: ReportRecord[]; command: string }
  | { ok: false; reason: string; command: string };

const DEFAULT_TIMEOUT_MS = 60_000;

const isRecord = (v: unknown): v is ReportRecord =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** First lines of output, for a reason that has to show what was not read. */
const preview = (text: string): string => {
  const head = fold(text, 2, 160);
  return head ? ` — output began: ${head}` : " — no output";
};

/** A JSON document out of output that may carry noise around it — a wrapper
 * announcing itself, a progress line — trusting nothing but the document. */
function parseJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the bracketed slice
  }
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error("no JSON document");
  const start = Math.min(...starts);
  const end = text.lastIndexOf(text[start] === "{" ? "}" : "]");
  if (end <= start) throw new Error("no complete JSON document");
  return JSON.parse(text.slice(start, end + 1));
}

/** Turn a report's output into records, or say exactly why it cannot. */
export function parseReport(
  out: { stdout: string; stderr: string },
  report: HarnessReport,
): ReportParse {
  if (report.format === "json") {
    let doc: unknown;
    try {
      doc = parseJsonDocument(out.stdout);
    } catch (e) {
      return {
        ok: false,
        reason: `expected JSON, found ${(e as Error).message}${preview(out.stdout)}`,
      };
    }
    const at = report.records ? getDotted(doc, report.records) : doc;
    if (Array.isArray(at)) {
      // An element that is not an object is a changed shape, not a record to
      // drop: filtering it out would turn "the report is unreadable" into a
      // valid empty report — a readability-only probe would then PASS a
      // schema it never read.
      const invalid = at.filter((x) => !isRecord(x)).length;
      if (invalid > 0) {
        return {
          ok: false,
          reason: `${invalid} of ${at.length} entries are not objects — the report's shape changed`,
        };
      }
      return { ok: true, records: at as ReportRecord[] };
    }
    if (isRecord(at)) {
      if (report.records) {
        const values = Object.values(at);
        const invalid = values.filter((x) => !isRecord(x)).length;
        if (invalid > 0) {
          return {
            ok: false,
            reason: `${invalid} of ${values.length} entries at "${report.records}" are not objects — the report's shape changed`,
          };
        }
        return { ok: true, records: values as ReportRecord[] };
      }
      return { ok: true, records: [at] };
    }
    const keys = isRecord(doc) ? Object.keys(doc).slice(0, 8).join(", ") : "";
    return {
      ok: false,
      reason: report.records
        ? `no records at "${report.records}"${keys ? ` (top-level keys: ${keys})` : ""}`
        : "the JSON document holds no records",
    };
  }
  if (report.format !== "lines") {
    return {
      ok: false,
      reason: `unknown report format "${String(report.format)}"`,
    };
  }
  if (!report.pattern) {
    return { ok: false, reason: `a "lines" report needs a "pattern"` };
  }
  let re: RegExp;
  try {
    re = new RegExp(report.pattern);
  } catch (e) {
    return {
      ok: false,
      reason: `pattern does not compile: ${(e as Error).message}`,
    };
  }
  const text = `${out.stdout}\n${out.stderr}`;
  const records: ReportRecord[] = [];
  for (const line of text.split("\n")) {
    const m = re.exec(line.trimEnd());
    if (m?.groups) {
      records.push(
        Object.fromEntries(
          Object.entries(m.groups).map(([k, v]) => [k, (v ?? "").trim()]),
        ),
      );
    }
  }
  if (records.length > 0) return { ok: true, records };
  if (report.emptyPattern && new RegExp(report.emptyPattern).test(text)) {
    return { ok: true, records: [] };
  }
  return {
    ok: false,
    reason: `no line matched the declared pattern${preview(text)}`,
  };
}

/** Run a report and read it. Output is read whatever the exit code: a doctor
 * that found a problem often exits non-zero while still printing the report
 * that says what. The exit code is only named when the output was unreadable. */
export function readReport(
  harness: string,
  report: HarnessReport,
  cwd: string,
): ReportRead {
  const command = [harness, ...report.args].join(" ");
  const timeout = report.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = spawnSync(harness, report.args, {
    cwd,
    encoding: "utf8",
    timeout,
    input: "",
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      command,
      reason:
        code === "ETIMEDOUT"
          ? `timed out after ${timeout}ms`
          : `could not run: ${code ?? r.error.message}`,
    };
  }
  const parsed = parseReport(
    { stdout: r.stdout ?? "", stderr: r.stderr ?? "" },
    report,
  );
  if (parsed.ok) return { ok: true, records: parsed.records, command };
  const exit = r.status !== 0 ? ` (exit ${r.status})` : "";
  return { ok: false, command, reason: `${parsed.reason}${exit}` };
}

/** One declared fact, and whether any record carries it. */
export interface FindResult {
  entry: Record<string, unknown>;
  matched: boolean;
  /** The record that shares the most declared fields, when one shares any —
   * so a miss can say "status is X" rather than only "not found". */
  nearest?: { record: ReportRecord; mismatched: string[] };
}

export function evaluateFind(
  records: readonly ReportRecord[],
  find: readonly Record<string, unknown>[],
): FindResult[] {
  return find.map((entry) => {
    const fields = Object.entries(entry);
    // Nearest is weighed in DECLARED order: the first field names the record
    // (a name, an id, a key), so a record sharing it outranks any number of
    // records that merely share a later field — "design is not connected"
    // rather than "browser is not called design".
    let best:
      | { record: ReportRecord; score: number; mismatched: string[] }
      | undefined;
    for (const record of records) {
      const mismatched: string[] = [];
      let score = 0;
      fields.forEach(([k, v], i) => {
        if (deepEqual(getDotted(record, k), v))
          score += 2 ** (fields.length - i);
        else mismatched.push(k);
      });
      if (mismatched.length === 0) return { entry, matched: true };
      if (score > 0 && (!best || score > best.score)) {
        best = { record, score, mismatched };
      }
    }
    return best
      ? {
          entry,
          matched: false,
          nearest: { record: best.record, mismatched: best.mismatched },
        }
      : { entry, matched: false };
  });
}

/** "name=playwright, status=Connected" */
export function describeEntry(entry: Record<string, unknown>): string {
  return Object.entries(entry)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : show(v)}`)
    .join(", ");
}

/** A miss, said as specifically as the report allows. */
export function describeMiss(
  result: FindResult,
  records: readonly ReportRecord[],
): string {
  if (result.nearest) {
    const { record, mismatched } = result.nearest;
    const anchor = Object.keys(result.entry).find(
      (k) => !mismatched.includes(k),
    );
    const diffs = mismatched
      .map(
        (k) =>
          `${k} is ${show(getDotted(record, k))} (expected ${show(result.entry[k])})`,
      )
      .join(", ");
    return `${anchor ? `${anchor}=${describeEntry({ [anchor]: result.entry[anchor] }).split("=")[1]}: ` : ""}${diffs}`;
  }
  // Nothing shares a single declared field: list what the report does carry
  // under the first declared field, so the reader can see a rename at a glance.
  const first = Object.keys(result.entry)[0];
  const seen = first
    ? records
        .map((r) => getDotted(r, first))
        .filter((v) => v !== undefined)
        .slice(0, 5)
        .map((v) => (typeof v === "string" ? v : show(v)))
    : [];
  const count = `${records.length} ${records.length === 1 ? "record" : "records"}`;
  return `no record has ${describeEntry(result.entry)} (read ${count}${seen.length > 0 ? `; ${first}: ${seen.join(", ")}` : ""})`;
}
