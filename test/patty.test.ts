import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/start.ts";
import { parseSvg, renderFigure, writeFigures, numeralsOf } from "../src/figures.ts";
import { check } from "../src/check.ts";
import { build, plusOneYear } from "../src/build.ts";
import { cleanRemote } from "../src/repomap.ts";

// A made-up repository: a small cache with expiry. Nothing here describes a real invention.
const CACHE_TS = `// Tiny cache with expiry.
export type Entry = { value: string; expires: number; hits: number };
const MAX = 500;
const store = new Map<string, Entry>();

export function get(key: string, now: number): string | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expires < now) {
    store.delete(key);
    return null;
  }
  entry.hits++;
  return entry.value;
}

export function put(key: string, value: string, now: number, ttl: number) {
  if (store.size >= MAX) evict(now);
  store.set(key, { value, expires: now + ttl, hits: 0 });
}

// Expired entries go first; only then the least used one.
function evict(now: number) {
  for (const [k, e] of store) if (e.expires < now) store.delete(k);
  if (store.size < MAX) return;
  let worst: string | null = null, least = Infinity;
  for (const [k, e] of store) if (e.hits < least) { least = e.hits; worst = k; }
  if (worst) store.delete(worst);
}
`;

const EVIDENCE = `# Evidence

## E1. Two-stage eviction
Spec: 2
Expired entries are removed first, and a live entry is removed only if the store is still full.
- src/cache.ts:22 | Expired entries go first; only then the least used one.
- src/cache.ts:23-29 | if (store.size < MAX) return;

## E2. Store and lookup
Spec: 1
Entries carry an expiry time and a hit count. A lookup of an expired entry deletes it.
- src/cache.ts:2 | export type Entry = { value: string; expires: number; hits: number };
- src/cache.ts:9 | if (entry.expires < now) {
`;

const SPEC = `# PROVISIONAL APPLICATION FOR PATENT

## Title
Cache Eviction in Two Stages

## Field
This disclosure relates to in-memory caches.

## Background
Caches that evict only by recency can discard live entries while expired entries remain.

## Summary
In some embodiments, a store removes expired entries first and removes a live entry only when the store remains full.

## Brief Description of the Drawings
- FIG. 1 is a block diagram of a cache according to some embodiments.
- FIG. 2 is a flowchart of two-stage eviction.

## Detailed Description

### 1. System overview (FIG. 1)
A client 100 calls a cache 102 that holds an entry record 104 for each key. Each entry record 104 has an expiry time 106 and a hit count 108.

### 2. Two-stage eviction (FIG. 2)
When the store is full, for example at 500 entries, step 200 removes expired entries. Step 202 tests whether the store is still full; if not, step 203 ends the eviction. Otherwise steps 204 to 206 find and remove the entry with the lowest hit count.

### 3. Variations
The capacity may differ. The second stage may use recency in place of the hit count.

## Example Claims
1. A method comprising removing expired entries from a store and, only if the store remains full, removing a live entry.

## Abstract
A cache removes expired entries first and removes a live entry only when the store remains full.
`;

const FIGS = [
  {
    number: 1, name: "system", type: "block",
    nodes: [
      { id: "client", text: "Client", num: "100", col: 0, row: 0 },
      { id: "cache", text: "Cache", num: "102", col: 1, row: 0 },
      { id: "entry", title: "Entry record", num: "104", col: 1, row: 1, rows: [["value", ""], ["expiry time", "106"], ["hit count", "108"]] },
    ],
    edges: [{ from: "client", to: "cache", label: "get / put" }, { from: "cache", to: "entry", label: "holds" }],
  },
  {
    number: 2, name: "eviction", type: "flow",
    steps: [
      { n: "200", text: "Remove expired entries" },
      { n: "202", decision: true, text: "Store still full?", side: { n: "203", text: "Done" }, side_label: "no", down_label: "yes" },
      { n: "204", text: "Find the entry with the lowest hit count" },
      { n: "206", text: "Remove it" },
    ],
  },
];

let repo: string, packet: string;
const write = (name: string, text: string) => writeFileSync(join(packet, name), text);

beforeAll(async () => {
  process.env.PATTY_OFFLINE = "1";
  repo = mkdtempSync(join(tmpdir(), "patty-test-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "cache.ts"), CACHE_TS);
  const out = await start(repo, "provisional", false);
  packet = join(repo, "patty-packet");
  expect(out).toContain("src/cache.ts");
  write("EVIDENCE.md", EVIDENCE);
  write("SPECIFICATION.md", SPEC);
  writeFigures(packet, FIGS);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("patty_start", () => {
  test("creates the packet and a repo map", async () => {
    expect(existsSync(join(packet, "STATUS.json"))).toBe(true);
    const out = await start(repo, "provisional", false);
    expect(out).toContain("already existed");
    expect(out).toContain("Not a git repository");
    expect(out).toContain("Patty prepares documents for you to file yourself");
  });
  test("remote URLs lose their credentials", () => {
    expect(cleanRemote("https://user:secret@github.com/acme/widget.git").shown).toBe("https://github.com/acme/widget");
    expect(cleanRemote("git@github.com:acme/widget.git").https).toBe("https://github.com/acme/widget");
  });
});

describe("patty_figures", () => {
  test("numerals are read back from the SVG", () => {
    const flow = renderFigure(FIGS[1]);
    expect(flow.numerals).toEqual(["200", "202", "203", "204", "206"]);
    expect(numeralsOf(parseSvg(flow.svg))).toEqual(flow.numerals);
    expect(flow.svg).toContain("FIG. 2");
    expect(renderFigure(FIGS[0]).numerals).toEqual(["100", "102", "104", "106", "108"]);
  });
  test("a side box can rejoin and a step can loop back", () => {
    const r = renderFigure({ number: 3, type: "flow", steps: [
      { n: "300", text: "Start" },
      { n: "302", decision: true, text: "Ready?", side: { n: "303", text: "Wait" }, rejoin: "306" },
      { n: "304", text: "Work" },
      { n: "306", text: "Finish", back_to: "300" },
    ] });
    expect(r.warnings).toEqual([]);
    expect(parseSvg(r.svg).prims.filter((p) => p.k === "arrow").length).toBe(6);
  });
  test("a return line goes round a side box that is in its way", () => {
    const r = renderFigure({ number: 5, type: "flow", steps: [
      { n: "500", decision: true, text: "Same?", side: { n: "501", text: "Restore" }, rejoin: "506" },
      { n: "502", decision: true, text: "Found?", side: { n: "503", text: "Leave alone" }, rejoin: "508" },
      { n: "504", text: "Replace" },
      { n: "506", text: "Record" },
      { n: "508", text: "Report" },
    ] });
    const arrows = parseSvg(r.svg).prims.filter((p) => p.k === "arrow") as { pts: [number, number][] }[];
    const boxes = parseSvg(r.svg).prims.filter((p) => p.k === "rect") as { x: number; y: number; w: number; h: number }[];
    for (const a of arrows) for (let i = 0; i < a.pts.length - 1; i++) {
      const [x1, y1] = a.pts[i], [x2, y2] = a.pts[i + 1];
      for (const b of boxes) {
        const inside = Math.max(x1, x2) > b.x + 1 && Math.min(x1, x2) < b.x + b.w - 1 && Math.max(y1, y2) > b.y + 1 && Math.min(y1, y2) < b.y + b.h - 1;
        expect(inside).toBe(false);
      }
    }
  });
  test("canvas figures take exact coordinates and warn about overflow", () => {
    const r = renderFigure({ number: 4, type: "canvas", width: 400, height: 300, items: [
      { box: [20, 20, 60, 40], text: "A label far too long for the box", num: "400" },
      { arrow: [[80, 40], [200, 40]], label: "x", label_at: [140, 34] },
    ] });
    expect(r.numerals).toEqual(["400"]);
    expect(r.warnings.length).toBe(1);
  });
  test("bad input is refused with a reason", () => {
    expect(() => renderFigure({ number: 1, type: "pie" })).toThrow(/flow, block, canvas/);
    expect(() => renderFigure({ number: 1, type: "block", nodes: [{ id: "a", col: 0, row: 0 }], edges: [{ from: "a", to: "b" }] })).toThrow(/does not exist/);
  });
});

describe("patty_check", () => {
  const failsWith = (file: string, original: string, changed: string, pattern: RegExp) => {
    write(file, changed);
    const r = check(packet, false);
    write(file, original);
    expect(r.passed).toBe(false);
    expect(r.errors.join("\n")).toMatch(pattern);
  };
  test("the fixture passes", () => {
    const r = check(packet, false);
    expect(r.errors).toEqual([]);
    expect(r.passed).toBe(true);
  });
  test("a changed line number fails", () => failsWith("EVIDENCE.md", EVIDENCE, EVIDENCE.replace("src/cache.ts:9 |", "src/cache.ts:10 |"), /not on that line\. The text is on line 9/));
  test("a line past the end of the file fails", () => failsWith("EVIDENCE.md", EVIDENCE, EVIDENCE.replace("src/cache.ts:9 |", "src/cache.ts:900 |"), /does not exist/));
  test("a missing file fails", () => failsWith("EVIDENCE.md", EVIDENCE, EVIDENCE.replace("src/cache.ts:2 |", "src/nope.ts:2 |"), /no such file/));
  test("a path outside the repo fails", () => failsWith("EVIDENCE.md", EVIDENCE, EVIDENCE.replace("src/cache.ts:2 |", "../../etc/hosts:2 |"), /leaves the repo/));
  test("a section with no evidence fails", () => failsWith("EVIDENCE.md", EVIDENCE, EVIDENCE.replace("Spec: 2", "Spec: 1"), /section 2 .* has no verified evidence/));
  test("a placeholder fails", () => failsWith("SPECIFICATION.md", SPEC, SPEC.replace("in-memory caches", "caches in [CITY]"), /placeholder remains/));
  test("limiting language fails", () => {
    for (const phrase of ["The invention is a cache.", "The store must be full.", "This step is essential.", "Expiry is critical.", "The first stage always runs."]) {
      failsWith("SPECIFICATION.md", SPEC, SPEC.replace("The capacity may differ.", phrase), /limiting language/);
    }
  });
  test("a numeral in the text and not in a figure fails", () => failsWith("SPECIFICATION.md", SPEC, SPEC.replace("a cache 102", "a cache 102 with an index 110"), /110 reads as a reference numeral/));
  test("a numeral in a figure and not in the text fails", () => failsWith("SPECIFICATION.md", SPEC, SPEC.replace(" and a hit count 108", ""), /FIG\. 1 has reference numeral 108/));
  test("a quantity is not taken for a numeral", () => {
    write("SPECIFICATION.md", SPEC.replace("The capacity may differ.", "The capacity may be about 900 entries, or a threshold of 250, or 4,096 bytes."));
    const r = check(packet, false);
    write("SPECIFICATION.md", SPEC);
    expect(r.errors).toEqual([]);
  });
  test("a figure the text never introduces fails", () => failsWith("SPECIFICATION.md", SPEC, SPEC.replace("- FIG. 2 is a flowchart of two-stage eviction.\n", ""), /FIG\. 2 is in figures\/ but the Brief Description/));
});

describe("prior art chart", () => {
  const REF = `Reference: US0000001A
Title: Cache with expiry
Kind: patent
Source: https://example.invalid/US0000001A
Date: 2001-01-01 (priority date, as the source lists it)
Fetched: 2026-01-01

## Abstract
A cache in which entries whose time to live has elapsed are deleted before any other entry.

## Claims
1. A method comprising deleting the least recently used entry when the cache is full.

## Related documents

### Similar documents (as the source lists them)
- US0000002A lowest hit count eviction
`;
  const CHART = `# Prior art chart

## M1. Two-stage eviction
Evidence: E1
- A. Expired entries are removed before any live entry.
- B. A live entry is removed only if the store is still full.
- C. The live entry removed is the one with the lowest hit count.

### US0000001A
- A: yes | entries whose time to live has elapsed are deleted before any other entry
- B: no
- C: partly | deleting the least recently used entry when the cache is full

Result: closest US0000001A; differs in B, C

## M2. Store and lookup
Evidence: E2
- A. Entries carry an expiry time.
- B. A lookup of an expired entry deletes it.

Result: nothing close found
`;
  const withChart = (chart: string | null, fn: (r: ReturnType<typeof check>) => void, log?: unknown) => {
    mkdirSync(join(packet, "references"), { recursive: true });
    writeFileSync(join(packet, "references", "US0000001A.txt"), REF);
    if (log) writeFileSync(join(packet, "references", "search.json"), JSON.stringify(log));
    if (chart !== null) write("PRIOR_ART_CHART.md", chart);
    try {
      fn(check(packet, false));
    } finally {
      rmSync(join(packet, "references"), { recursive: true, force: true });
      rmSync(join(packet, "PRIOR_ART_CHART.md"), { force: true });
    }
  };
  test("a chart whose quotes are in the reference passes and reports each result", () =>
    withChart(CHART, (r) => {
      expect(r.errors).toEqual([]);
      expect(r.outcomes.map((o) => o.verdict)).toEqual([
        "closest reference lacks: B (A live entry is removed only if the store is still full.); C (The live entry removed is the one with the lowest hit count.)",
        "nothing close found among 0 references read; not a clearance",
      ]);
      expect(r.report).toContain("2 quotes found in the stored reference text");
    }));
  test("a quote that is not in the reference fails", () =>
    withChart(CHART.replace("deleted before any other entry", "deleted before live entries, in two stages"), (r) => expect(r.errors.join("\n")).toMatch(/is not in references\/US0000001A\.txt/)));
  test("a quote from the related-documents list does not count", () =>
    withChart(CHART.replace("- C: partly | deleting the least recently used entry when the cache is full", "- C: yes | lowest hit count eviction"), (r) => expect(r.errors.join("\n")).toMatch(/is not in references/)));
  test("a reference that was never fetched cannot be charted", () =>
    withChart(CHART.replace("### US0000001A", "### US9999999B2"), (r) => expect(r.errors.join("\n")).toMatch(/references\/US9999999B2\.txt does not exist/)));
  test("every element yes means knocked out, whatever the result line says", () =>
    withChart(CHART.replace("- B: no", "- B: yes | deleting the least recently used entry when the cache is full").replace("- C: partly", "- C: yes"), (r) => expect(r.errors.join("\n")).toMatch(/has to be "knocked out by US0000001A"/)));
  test("a knockout is reported loudly but is the human's call", () =>
    withChart(CHART.replace("- B: no", "- B: yes | deleting the least recently used entry when the cache is full").replace("- C: partly", "- C: yes").replace("Result: closest US0000001A; differs in B, C", "Result: knocked out by US0000001A"), (r) => {
      expect(r.errors).toEqual([]);
      expect(r.warnings.join("\n")).toMatch(/knocked out by US0000001A/);
    }));
  test("a missing row and a made-up result form fail", () => {
    withChart(CHART.replace("- B: no\n", ""), (r) => expect(r.errors.join("\n")).toMatch(/no row for element B/));
    withChart(CHART.replace("Result: nothing close found", "Result: novel"), (r) => expect(r.errors.join("\n")).toMatch(/not one of the three forms/));
  });
  test("search results with no chart block the build; no search only warns", () => {
    const hit = [{ query: "q", at: "2026-01-01", hits: [{ title: "t", number: "US0000001A", link: "x" }], papers: [], code: [] }];
    withChart(null, (r) => expect(r.errors.join("\n")).toMatch(/PRIOR_ART_CHART\.md is missing/), hit);
    withChart(null, (r) => {
      expect(r.errors).toEqual([]);
      expect(r.warnings.join("\n")).toMatch(/No prior art search was run/);
    });
  });
});

describe("patty_build", () => {
  test("refuses while the check fails", async () => {
    write("SPECIFICATION.md", SPEC.replace("in-memory caches", "caches in [CITY]"));
    const out = await build(packet, {});
    write("SPECIFICATION.md", SPEC);
    expect(out).toStartWith("patty_build refused");
    expect(existsSync(join(packet, "specification.pdf"))).toBe(false);
  });
  test("writes the filing copies and leaves the filing to the human", async () => {
    const out = await build(packet, { first_public_disclosure: { date: "2024-02-29", what: "test value" } });
    expect(out).toStartWith("patty_build: done. Nothing has been filed.");
    for (const f of ["specification.pdf", "drawings.pdf"]) {
      const bytes = readFileSync(join(packet, f));
      expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.6");
      expect(bytes.includes("/FontFile2")).toBe(true);
      expect(bytes.includes("/Encrypt")).toBe(false);
    }
    const steps = readFileSync(join(packet, "FILING_STEPS.md"), "utf8");
    const numbered = steps.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(numbered.slice(-3).map((l) => l.match(/\*\*(\w+)\.\*\*/)?.[1])).toEqual(["Sign", "Submit", "Pay"]);
    expect(steps).toContain("confirm on the current USPTO fee schedule");
    expect(steps).not.toMatch(/\$\s?\d/);
    const docket = readFileSync(join(packet, "DOCKET.md"), "utf8");
    expect(docket).toContain("2025-02-28");
    expect(docket).toContain("unverified");
    const cover = readFileSync(join(packet, "COVER_SHEET.md"), "utf8");
    expect(cover).toContain("Cache Eviction in Two Stages");
    expect(cover).toContain("you enter this");
    for (const f of ["FILING_STEPS.md", "DOCKET.md", "COVER_SHEET.md"]) expect(readFileSync(join(packet, f), "utf8")).toContain("It is not a law firm and this is not legal advice.");
    const status = JSON.parse(readFileSync(join(packet, "STATUS.json"), "utf8"));
    expect(status.done.build).toBeString();
    expect(status.waiting_on_human.join(" ")).toContain("sign, submit and pay");
  });
  test("dates", () => {
    expect(plusOneYear("2026-10-25")).toBe("2027-10-25");
    expect(plusOneYear("2024-02-29")).toBe("2025-02-28");
  });
});

describe("patty_prior_art and patty_tm_check without a network", () => {
  test("a failed search is written down and does not throw", async () => {
    const { priorArt } = await import("../src/priorart.ts");
    const out = await priorArt(packet, ["cache eviction of expired entries before live entries"]);
    expect(out).toContain("search unavailable");
    expect(readFileSync(join(packet, "PRIOR_ART.md"), "utf8")).toContain("Search unavailable");
    expect(check(packet, false).passed).toBe(true);
  });
  test("the knockout says it could not check, and never says clear", async () => {
    const { tmCheck } = await import("../src/tm.ts");
    const out = await tmCheck(packet, "Examplemark", "online software for testing");
    expect(out).toContain("Search unavailable");
    const k = readFileSync(join(packet, "TM_KNOCKOUT.md"), "utf8");
    expect(k).toContain("The USPTO register was not searched");
    expect(readFileSync(join(packet, "TM_FIELDS.md"), "utf8")).toContain("Class 42");
  });
});
