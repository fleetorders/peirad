import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseEntry,
  classKey,
  normalizeKeyPart,
  parseLedger,
  detectRail,
  findPrecedent,
  precedentCommand,
} from "../src/precedent.js";

const here = (f: string): string => fileURLToPath(new URL(f, import.meta.url));
const FIX = (f: string): string => here(`./fixtures/precedent/${f}`);
const read = (f: string): string => fs.readFileSync(FIX(f), "utf8");

// Capture what precedentCommand prints so assertions run against real output.
let out = "";
let err = "";

function capture(): void {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err += String(c);
    return true;
  });
}

describe("class key", () => {
  it("takes the title stem up to the first ':' or ' — ' and the from source", () => {
    const key = classKey(parseEntry(read("canary-drift-entry.md")));
    expect(key).toEqual({
      stem: "canary drift",
      from: "nightly sweep",
      display: "canary drift · nightly sweep",
    });
  });

  it("normalizes dates, parentheticals and markdown marks away", () => {
    expect(normalizeKeyPart("nightly sweep 2026-09-04 (rerun)")).toBe(
      "nightly sweep",
    );
    expect(normalizeKeyPart("`peirad precedent` — the _command_")).toBe(
      "peirad precedent — the command",
    );
  });

  it("keeps the whole heading as stem when there is no delimiter", () => {
    const e = parseEntry(
      "---\nfrom: ci\n---\n\n# one long alarm title\nbody\n",
    );
    expect(classKey(e).stem).toBe("one long alarm title");
  });
});

describe("parseLedger", () => {
  it("splits the ledger into rulings with scope and first paragraph", () => {
    const ledger = parseLedger(read("ledger.md"));
    expect(ledger.map((l) => l.id)).toEqual(["D-201", "D-202", "D-203"]);
    const d201 = ledger.find((l) => l.id === "D-201");
    expect(d201?.scope).toContain("canary drift");
    expect(d201?.firstParagraph).toContain("closed by re-running the sweep");
    // The block ends where the next ruling begins — no bleed.
    expect(d201?.firstParagraph).not.toContain("manifest");
  });
});

describe("detectRail", () => {
  it("prefers the most sensitive rail when several hit", () => {
    expect(detectRail("push the new api key to the host")).toBe("credentials");
  });

  it("names the rail its text trips", () => {
    expect(detectRail("publish 0.3.0 to npm")).toBe("release");
    expect(detectRail("deploy to the shared registry")).toBe("registry");
    expect(detectRail("nothing actionable here")).toBeNull();
  });
});

describe("findPrecedent", () => {
  const SIBLINGS = [
    {
      file: "012-canary-drift-2026-09-02.md",
      text: read("resolved/012-canary-drift-2026-09-02.md"),
    },
    {
      file: "013-canary-drift-2026-09-03.md",
      text: read("resolved/013-canary-drift-2026-09-03.md"),
    },
    {
      file: "014-canary-drift-2026-09-04.md",
      text: read("resolved/014-canary-drift-2026-09-04.md"),
    },
  ];

  it("matches the newest resolved sibling and carries its done line", () => {
    const r = findPrecedent(
      read("canary-drift-entry.md"),
      read("ledger.md"),
      SIBLINGS,
    );
    expect(r.matched).toBe(true);
    expect(r.source).toBe("resolved");
    // 014 sorts last but is pending — no done line, so it cannot match.
    expect(r.id).toBe("013-canary-drift-2026-09-03.md");
    expect(r.confidence).toBe("high");
    expect(r.resolution).toContain("known clock skew");
  });

  it("falls back to a ledger ruling at medium confidence", () => {
    const r = findPrecedent(
      read("manifest-drift-entry.md"),
      read("ledger.md"),
      SIBLINGS,
    );
    expect(r.matched).toBe(true);
    expect(r.source).toBe("ledger");
    expect(r.id).toBe("D-202");
    expect(r.confidence).toBe("medium");
    expect(r.resolution).toContain("expected");
  });

  it("reports no match with the class named when nothing covers it", () => {
    const entry =
      "---\nfrom: ci run 2026-09-04\n---\n\n# mystery alarm: nothing like this before\n\nbody\n";
    const r = findPrecedent(entry, read("ledger.md"), SIBLINGS);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('class "mystery alarm · ci run"');
  });

  it("refuses to match a rail class, naming the rail", () => {
    const r = findPrecedent(
      read("release-entry.md"),
      read("ledger.md"),
      SIBLINGS,
    );
    expect(r.matched).toBe(false);
    expect(r.rail).toBe("release");
    expect(r.reason).toContain("never auto-resolved");
  });
});

describe("precedentCommand", () => {
  it("emits json where .matched is true and names the sibling", () => {
    capture();
    const code = precedentCommand({
      entry: FIX("canary-drift-entry.md"),
      ledger: FIX("ledger.md"),
      resolved: [FIX("resolved")],
      json: true,
    });
    expect(code).toBe(0);
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(j.schema).toBe("precedent/1");
    expect(j.matched).toBe(true);
    expect(j.id).toBe("013-canary-drift-2026-09-03.md");
    expect(j.rail).toBeNull();
  });

  it("emits json where a release entry is unmatched with rail: release", () => {
    capture();
    const code = precedentCommand({
      entry: FIX("release-entry.md"),
      ledger: FIX("ledger.md"),
      resolved: [FIX("resolved")],
      json: true,
    });
    expect(code).toBe(0);
    const j = JSON.parse(out) as Record<string, unknown>;
    expect(j.matched).toBe(false);
    expect(j.rail).toBe("release");
  });

  it("prints the md block with the unverified heading", () => {
    capture();
    const code = precedentCommand({
      entry: FIX("canary-drift-entry.md"),
      ledger: FIX("ledger.md"),
      resolved: [FIX("resolved")],
    });
    expect(code).toBe(0);
    expect(out.startsWith("## Precedent (machine, unverified)\n")).toBe(true);
    expect(out).toContain("Class: canary drift · nightly sweep\n");
    expect(out).toContain(
      "Matched: yes (high) — sibling 013-canary-drift-2026-09-03.md",
    );
    expect(out).toContain("Resolution to apply:");
  });

  it("searches several --resolved dirs", () => {
    capture();
    const code = precedentCommand({
      entry: FIX("canary-drift-entry.md"),
      ledger: FIX("ledger.md"),
      resolved: [here("./fixtures"), FIX("resolved")],
      json: true,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).matched).toBe(true);
  });

  it("exits 2 on a missing entry, ledger or resolved dir", () => {
    capture();
    expect(
      precedentCommand({
        entry: "test/fixtures/precedent/no-such-entry.md",
        ledger: FIX("ledger.md"),
      }),
    ).toBe(2);
    expect(err).toContain("entry not found");
    expect(
      precedentCommand({
        entry: FIX("canary-drift-entry.md"),
        ledger: "test/fixtures/precedent/no-such-ledger.md",
      }),
    ).toBe(2);
    expect(err).toContain("ledger not found");
    expect(
      precedentCommand({
        entry: FIX("canary-drift-entry.md"),
        ledger: FIX("ledger.md"),
        resolved: ["test/fixtures/precedent/no-such-dir"],
      }),
    ).toBe(2);
    expect(err).toContain("resolved dir not found");
  });

  it("exits 2 when the entry has no title to derive a class from", () => {
    capture();
    const code = precedentCommand({
      entry: FIX("title-less-entry.md"),
      ledger: FIX("ledger.md"),
    });
    expect(code).toBe(2);
    expect(err).toContain("no `#` title");
  });
});
