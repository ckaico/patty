import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { figureFiles, numeralsOf, parseSvg } from "./figures.ts";
import { now, readStatus, repoOf, writeStatus } from "./packet.ts";

export type CheckResult = { passed: boolean; errors: string[]; warnings: string[]; report: string };

// ---------- specification ----------
export type Spec = {
  lines: string[];
  h2: { title: string; start: number; end: number }[];
  sections: { num: number; title: string; start: number; end: number }[]; // "### N. ..." under Detailed Description
};

export function parseSpec(text: string): Spec {
  const lines = text.split(/\r?\n/);
  const h2: Spec["h2"] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^##\s+(.+?)\s*$/);
    if (m) h2.push({ title: m[1], start: i, end: lines.length });
  });
  h2.forEach((h, i) => (h.end = h2[i + 1]?.start ?? lines.length));
  const dd = h2.find((h) => /^detailed description/i.test(h.title));
  const sections: Spec["sections"] = [];
  if (dd) {
    for (let i = dd.start + 1; i < dd.end; i++) {
      const m = lines[i].match(/^###\s+(\d+)[.)]?\s+(.+?)\s*$/);
      if (m) sections.push({ num: Number(m[1]), title: m[2], start: i, end: dd.end });
    }
    sections.forEach((s, i) => (s.end = sections[i + 1]?.start ?? dd.end));
  }
  return { lines, h2, sections };
}

export const sectionOf = (spec: Spec, re: RegExp) => spec.h2.find((h) => re.test(h.title));
export const bodyOf = (spec: Spec, h: { start: number; end: number }) => spec.lines.slice(h.start + 1, h.end).join("\n").trim();
const noCode = (s: string) => s.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));

const REQUIRED: [RegExp, string][] = [
  [/^title/i, "Title"],
  [/^background/i, "Background"],
  [/^summary/i, "Summary"],
  [/^brief description of the drawings/i, "Brief Description of the Drawings"],
  [/^detailed description/i, "Detailed Description"],
  [/^abstract/i, "Abstract"],
];

const LIMITING: [RegExp, string][] = [
  [/\bthe\s+(?:present\s+)?invention\s+(?:is|are|comprises|consists|requires)\b/i, `"the invention is"`],
  [/\bthe\s+present\s+invention\b/i, `"the present invention"`],
  [/\bmust\b/i, `"must"`],
  [/\bessential\b/i, `"essential"`],
  [/\bcritical\b/i, `"critical"`],
  [/\balways\b/i, `"always"`],
];

const PLACEHOLDERS: [RegExp, string][] = [
  [/\[[A-Z][A-Z0-9 _.\/-]{1,40}\]/, "a bracketed placeholder"],
  [/\b(?:TODO|TBD|FIXME|XXX)\b/, "a to-do marker"],
  [/\{\{[^}]*\}\}/, "a template placeholder"],
  [/_{4,}/, "a blank to fill in"],
  [/\blorem ipsum\b/i, "filler text"],
  [/<(?:name|city|date|inventor|title|your [a-z ]+)>/i, "an angle-bracket placeholder"],
];

// Words that mark the number after them as a quantity, not a reference numeral.
const VALUE_CUES = new Set(["example", "e.g", "eg", "about", "approximately", "around", "roughly", "least", "most", "than", "exceeds", "exceed", "exceeding", "below", "above", "under", "over", "within", "every", "each", "equals", "equal", "of", "is", "are", "was", "be", "at", "by", "per", "after", "before", "first", "last", "top", "up", "nearly", "almost", "some", "only", "just", "=", "<", ">", "~"]);
// Unit words that mark the number before them as a quantity. Words that are also verbs
// ("records", "requests", "points") are left out: "step 516 records the event" is a numeral.
const UNITS = new Set(["characters", "character", "chars", "words", "tokens", "bytes", "byte", "kb", "mb", "gb", "kib", "mib", "kilobytes", "megabytes", "ms", "milliseconds", "millisecond", "seconds", "minutes", "hours", "days", "weeks", "lines", "pixels", "px", "percent", "items", "entries", "rows", "columns", "times", "elements", "bits", "digits", "dimensions", "iterations", "sentences", "paragraphs", "hz", "khz", "dpi", "ops", "operations", "bps", "kbps", "mbps", "fps"]);
// A number straight after one of these is a reference numeral whatever follows it.
const NUMERAL_CUES = new Set(["step", "steps", "block", "blocks", "operation", "operations", "stage", "stages", "numeral", "numerals", "and", "to", "through"]);

type NumHit = { n: number; lineNo: number; context: string };

function specNumerals(spec: Spec, dd: { start: number; end: number }): { hits: NumHit[]; ranges: [number, number][] } {
  const hits: NumHit[] = [];
  const ranges: [number, number][] = [];
  for (let i = dd.start + 1; i < dd.end; i++) {
    if (/^#/.test(spec.lines[i])) continue;
    const line = noCode(spec.lines[i]);
    const isValue = (start: number, end: number) => {
      const before = line.slice(0, start).toLowerCase().replace(/[()"'“”,]/g, " ").trim().split(/\s+/).slice(-2);
      const prev = (before[before.length - 1] ?? "").replace(/\.$/, "");
      const prev2 = (before[before.length - 2] ?? "").replace(/\.$/, "");
      if (NUMERAL_CUES.has(prev)) return false;
      if (VALUE_CUES.has(prev) || (VALUE_CUES.has(prev2) && /^(?:for|about|at|up|to|approximately)$/.test(prev))) return true;
      if (prev2 === "for" && prev === "example") return true;
      const next = (line.slice(end).match(/^\s*([A-Za-z%]+)/)?.[1] ?? "").toLowerCase();
      return UNITS.has(next);
    };
    const num = String.raw`(?<![\w.,/$#%:-])(\d{3,4})(?![\w%]|[.,:/]\d)`;
    const taken: [number, number][] = [];
    for (const m of line.matchAll(new RegExp(String.raw`${num}\s*(?:-|–|—|to|through)\s*(?<![\w.,/$#%:])(\d{3,4})(?![\w%]|[.,:/-]\d)`, "g"))) {
      const a = Number(m[1]), b = Number(m[2]);
      taken.push([m.index!, m.index! + m[0].length]);
      if (a < 100 || b <= a || isValue(m.index!, m.index! + m[0].length)) continue;
      ranges.push([a, b]);
      const context = line.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 20).trim();
      hits.push({ n: a, lineNo: i + 1, context }, { n: b, lineNo: i + 1, context });
    }
    for (const m of line.matchAll(new RegExp(String.raw`${num.replace("(?![\\w%]", "(?![\\w%-]")}`, "g"))) {
      const at = m.index!;
      if (taken.some(([s, e]) => at >= s && at < e)) continue;
      const n = Number(m[1]);
      if (n < 100 || isValue(at, at + m[0].length)) continue;
      hits.push({ n, lineNo: i + 1, context: line.slice(Math.max(0, at - 30), at + m[0].length + 20).trim() });
    }
  }
  return { hits, ranges };
}

function figRefs(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of noCode(text).matchAll(/\bFIGS?\.?\s*(\d+)((?:\s*(?:,|and|to|through|–|-)\s*\d+)*)/gi)) {
    const first = Number(m[1]);
    out.add(first);
    let prev = first;
    for (const t of m[2].matchAll(/(,|and|to|through|–|-)\s*(\d+)/g)) {
      const n = Number(t[2]);
      if (/to|through|–|-/.test(t[1])) for (let k = prev + 1; k <= n; k++) out.add(k);
      else out.add(n);
      prev = n;
    }
  }
  return out;
}

// ---------- evidence ----------
export type Citation = { path: string; start: number; end: number; text: string; lineNo: number };
export type EvidenceEntry = { name: string; lineNo: number; spec: number[]; hasSpecLine: boolean; citations: Citation[]; malformed: { lineNo: number; line: string }[] };

export function parseEvidence(text: string): EvidenceEntry[] {
  const out: EvidenceEntry[] = [];
  let cur: EvidenceEntry | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = { name: h[1], lineNo: i + 1, spec: [], hasSpecLine: false, citations: [], malformed: [] };
      out.push(cur);
      return;
    }
    if (!cur) return;
    const s = line.match(/^\s*(?:\*\*)?Spec(?:\*\*)?\s*:\s*(.*)$/i);
    if (s) {
      cur.hasSpecLine = true;
      cur.spec.push(...[...s[1].matchAll(/\d+/g)].map((m) => Number(m[0])));
      return;
    }
    const c = line.match(/^\s*[-*]\s+`?(.+?):(\d+)(?:\s*[-–]\s*(\d+))?`?\s+\|\s?(.*)$/);
    if (c) {
      const start = Number(c[2]);
      cur.citations.push({ path: c[1].trim().replace(/^`|`$/g, ""), start, end: c[3] ? Number(c[3]) : start, text: c[4], lineNo: i + 1 });
    } else if (/^\s*[-*]\s+`?[^\s|]+\.[A-Za-z0-9]+:\d+/.test(line)) cur.malformed.push({ lineNo: i + 1, line: line.trim() });
  });
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function checkCitation(repo: string, packet: string, c: Citation, cache: Map<string, string[] | null>): string | null {
  const where = `EVIDENCE.md line ${c.lineNo} (${c.path}:${c.start}${c.end !== c.start ? "-" + c.end : ""})`;
  const abs = resolve(repo, c.path);
  if (abs !== repo && !abs.startsWith(repo + sep)) return `${where}: the path leaves the repo.`;
  if (abs.startsWith(packet + sep)) return `${where}: cites the packet itself; cite source code.`;
  if (!cache.has(abs)) {
    try {
      cache.set(abs, existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8").split(/\r?\n/) : null);
    } catch {
      cache.set(abs, null);
    }
  }
  const lines = cache.get(abs);
  if (!lines) return `${where}: no such file in the repo.`;
  const total = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (c.start < 1 || c.end < c.start) return `${where}: bad line range.`;
  if (c.start > total || c.end > total) return `${where}: line ${Math.max(c.start, c.end)} does not exist; the file has ${total} lines.`;
  const want = squash(c.text);
  if (want.replace(/\s/g, "").length < 6) return `${where}: the cited text is too short to check. Copy at least a few words from the line.`;
  const have = squash(lines.slice(c.start - 1, c.end).join("\n"));
  if (have.includes(want)) return null;
  let elsewhere = "";
  for (let i = 0; i < total; i++) {
    if (squash(lines[i]).includes(want)) {
      elsewhere = ` The text is on line ${i + 1}.`;
      break;
    }
  }
  return `${where}: the cited text "${want.slice(0, 70)}${want.length > 70 ? "..." : ""}" is not ${c.end !== c.start ? "in those lines" : "on that line"}.${elsewhere}`;
}

// ---------- the check ----------
export function check(packetPath: string, record = true): CheckResult {
  const packet = resolve(packetPath);
  const repo = repoOf(packet);
  const errors: string[] = [];
  const warnings: string[] = [];
  const specPath = join(packet, "SPECIFICATION.md"), evPath = join(packet, "EVIDENCE.md");
  const figs = figureFiles(packet);

  if (!existsSync(specPath)) errors.push("SPECIFICATION.md is missing.");
  if (!existsSync(evPath)) errors.push("EVIDENCE.md is missing. Write it before the specification.");
  if (!figs.length) errors.push("There are no figures in figures/. Call patty_figures.");

  const specText = existsSync(specPath) ? readFileSync(specPath, "utf8") : "";
  const spec = parseSpec(specText);
  const dd = sectionOf(spec, /^detailed description/i);

  if (specText) {
    for (const [re, name] of REQUIRED) if (!sectionOf(spec, re)) errors.push(`SPECIFICATION.md has no "## ${name}" section.`);
    if (dd && !spec.sections.length) errors.push(`The Detailed Description has no numbered sections. Head each one "### 1. Name" so EVIDENCE.md can point at it.`);
    const nums = spec.sections.map((s) => s.num);
    const dupSec = nums.find((n, i) => nums.indexOf(n) !== i);
    if (dupSec !== undefined) errors.push(`Two sections of the Detailed Description are both numbered ${dupSec}.`);

    // placeholders and limiting language
    spec.lines.forEach((raw, i) => {
      const line = noCode(raw);
      for (const [re, what] of PLACEHOLDERS) {
        const m = line.match(re);
        if (m) errors.push(`SPECIFICATION.md line ${i + 1}: ${what} remains ("${m[0]}"). Fill it in or remove the sentence.`);
      }
      for (const [re, what] of LIMITING) {
        const m = line.match(re);
        if (m) errors.push(`SPECIFICATION.md line ${i + 1}: limiting language ${what} ("...${line.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 30).trim()}..."). Reword with "in some embodiments", "may" or "for example".`);
      }
    });

    const firstHeading = spec.lines.findIndex((l) => /^#\s/.test(l));
    if (firstHeading > 0 && spec.lines.slice(0, firstHeading).some((l) => l.trim())) warnings.push(`SPECIFICATION.md has text above its first heading. patty_build leaves that text out of the filing copy.`);
    if (firstHeading < 0) warnings.push(`SPECIFICATION.md has no top-level "# " heading.`);
    const abs = sectionOf(spec, /^abstract/i);
    if (abs) {
      const words = bodyOf(spec, abs).split(/\s+/).filter(Boolean).length;
      if (words > 150) warnings.push(`The abstract is ${words} words; keep it to 150 or fewer (37 CFR 1.72(b)).`);
      if (!words) errors.push(`The Abstract section is empty.`);
    }
    const title = sectionOf(spec, /^title/i);
    if (title) {
      const t = bodyOf(spec, title);
      if (!t) errors.push(`The Title section is empty.`);
      if (t.length > 500) warnings.push(`The title is ${t.length} characters; the limit is 500 (37 CFR 1.72(a)).`);
    }
    if (!sectionOf(spec, /claims/i)) warnings.push(`There are no example claims. A provisional does not need them, but they help whoever writes the non-provisional.`);
    if (sectionOf(spec, /^inventors?\b/i)) warnings.push(`The specification has an Inventor section. Inventor names and residences go on the cover sheet, not in the specification.`);
    if (dd && !spec.sections.some((s) => /variation|alternative/i.test(s.title))) warnings.push(`The Detailed Description has no Variations section. End with other values, other data types, other placements.`);
  }

  // evidence
  const evText = existsSync(evPath) ? readFileSync(evPath, "utf8") : "";
  const entries = parseEvidence(evText);
  const covered = new Set<number>();
  if (evText) {
    if (!entries.length) errors.push(`EVIDENCE.md has no entries. Head each mechanism "## E1. Name".`);
    evText.split(/\r?\n/).forEach((raw, i) => {
      if (/^\s*[-*]\s/.test(raw) && raw.includes(" | ")) return; // cited code may contain anything
      const line = noCode(raw);
      for (const [re, what] of PLACEHOLDERS) {
        const m = line.match(re);
        if (m) errors.push(`EVIDENCE.md line ${i + 1}: ${what} remains ("${m[0]}").`);
      }
    });
    const cache = new Map<string, string[] | null>();
    const secNums = new Set(spec.sections.map((s) => s.num));
    for (const e of entries) {
      const where = `EVIDENCE.md "${e.name}" (line ${e.lineNo})`;
      if (!e.hasSpecLine || !e.spec.length) errors.push(`${where}: no "Spec:" line saying which numbered sections of the Detailed Description it supports.`);
      for (const n of e.spec) if (specText && !secNums.has(n)) errors.push(`${where}: points at section ${n}, which the Detailed Description does not have.`);
      for (const m of e.malformed) errors.push(`EVIDENCE.md line ${m.lineNo}: this looks like a citation but has no " | " followed by the cited text. Write "- path:line | text from that line".`);
      if (!e.citations.length) errors.push(`${where}: no file:line citation. A mechanism without a citation cannot go in the specification.`);
      let good = 0;
      for (const c of e.citations) {
        const err = checkCitation(repo, packet, c, cache);
        if (err) errors.push(err);
        else good++;
      }
      if (good) for (const n of e.spec) covered.add(n);
    }
  }
  if (specText && evText) {
    for (const s of spec.sections) {
      if (/variation|alternative/i.test(s.title)) continue;
      if (!covered.has(s.num)) errors.push(`Specification section ${s.num} ("${s.title}") has no verified evidence. Add an EVIDENCE.md entry with "Spec: ${s.num}" and a file:line citation, or cut the section.`);
    }
  }

  // figures and numerals
  const figNumerals = new Map<number, Set<number>>();
  const figNumbers = figs.map((f) => f.number);
  const dupFig = figNumbers.find((n, i) => figNumbers.indexOf(n) !== i);
  if (dupFig !== undefined) errors.push(`Two files in figures/ are both FIG. ${dupFig}.`);
  for (const f of figs) {
    try {
      const d = parseSvg(readFileSync(f.path, "utf8"));
      if (d.unsupported.length) warnings.push(`figures/${f.file} has elements Patty did not draw (${d.unsupported.join(", ")}); they are left out of drawings.pdf.`);
      figNumerals.set(f.number, new Set(numeralsOf(d).map((n) => parseInt(n, 10))));
    } catch (e) {
      errors.push(`figures/${f.file} could not be read: ${(e as Error).message}`);
    }
  }
  if (specText && dd && figs.length) {
    const allFig = new Set<number>();
    for (const s of figNumerals.values()) for (const n of s) allFig.add(n);
    const { hits, ranges } = specNumerals(spec, dd);
    const inSpec = new Set(hits.map((h) => h.n));
    const reported = new Set<number>();
    for (const h of hits) {
      if (allFig.has(h.n) || reported.has(h.n)) continue;
      reported.add(h.n);
      errors.push(`SPECIFICATION.md line ${h.lineNo}: ${h.n} reads as a reference numeral ("...${h.context}...") but no figure has it. If it is a part or step, add it to a figure. If it is a quantity, write it as "for example ${h.n} <unit>".`);
    }
    for (const [fig, set] of figNumerals) {
      for (const n of [...set].sort((a, b) => a - b)) {
        if (inSpec.has(n) || ranges.some(([a, b]) => n >= a && n <= b)) continue;
        errors.push(`FIG. ${fig} has reference numeral ${n}, which the Detailed Description never mentions. Name it in the text or take it off the figure.`);
      }
    }
    const refs = figRefs(specText);
    const brief = sectionOf(spec, /^brief description of the drawings/i);
    const briefRefs = brief ? figRefs(bodyOf(spec, brief)) : new Set<number>();
    for (const n of [...refs].sort((a, b) => a - b)) if (!figNumbers.includes(n)) errors.push(`The specification refers to FIG. ${n}, but figures/ has no FIG${n} file.`);
    for (const n of figNumbers) if (!briefRefs.has(n)) errors.push(`FIG. ${n} is in figures/ but the Brief Description of the Drawings has no line for it.`);
  }

  const passed = errors.length === 0;
  const R: string[] = [];
  R.push(passed ? "patty_check: PASS" : `patty_check: FAIL (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  R.push(`Packet: ${packet}`, `Repo the citations were checked against: ${repo}`);
  if (specText) R.push(`Specification: ${specText.split(/\s+/).filter(Boolean).length} words, ${spec.sections.length} numbered sections.`);
  if (evText) R.push(`Evidence: ${entries.length} entries, ${entries.reduce((a, e) => a + e.citations.length, 0)} citations opened and compared with the files.`);
  R.push(`Figures: ${figs.length}${figs.length ? " (" + figs.map((f) => `FIG. ${f.number}`).join(", ") + ")" : ""}.`);
  if (errors.length) R.push("", "Errors (each one blocks patty_build):", ...errors.map((e) => `- ${e}`));
  if (warnings.length) R.push("", "Warnings (do not block):", ...warnings.map((w) => `- ${w}`));
  if (passed) R.push("", "What this check does not do: it confirms each citation exists and each numeral matches. It does not judge whether the specification says only what the evidence supports, or whether the invention is new. A person has to read it.");

  if (record) {
    const s = readStatus(packet);
    if (s) {
      s.check = { passed, at: now(), errors: errors.length, warnings: warnings.length };
      if (passed) s.done.check = now();
      else delete s.done.check;
      writeStatus(packet, s);
    }
  }
  return { passed, errors, warnings, report: R.join("\n") };
}
