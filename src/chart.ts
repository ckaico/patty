import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flatten, readReference } from "./references.ts";

// PRIOR_ART_CHART.md: each mechanism broken into elements, and each reference read in full
// marked yes / partly / no per element, with a quote for every yes and partly. The quotes are
// checked against the stored reference text, the same way code citations are checked.

export type Row = { letter: string; status: "yes" | "partly" | "no"; quote: string; lineNo: number };
export type ChartRef = { slug: string; lineNo: number; rows: Row[] };
export type Mechanism = {
  name: string; lineNo: number; evidence: string[]; hasEvidenceLine: boolean;
  elements: { letter: string; text: string }[]; refs: ChartRef[];
  result?: { kind: "knocked" | "closest" | "nothing" | "unknown"; ref?: string; letters: string[]; raw: string; lineNo: number };
  protect?: { call: string; reason: string; lineNo: number };
};
export type ChartOutcome = { name: string; verdict: string; ref?: string; refTitle?: string; refDate?: string; protect?: string };
export type ChartCheck = { present: boolean; errors: string[]; warnings: string[]; outcomes: ChartOutcome[]; mechanisms: number; references: number; quotes: number };

export const CHART_FILE = "PRIOR_ART_CHART.md";

export function parseChart(text: string): Mechanism[] {
  const out: Mechanism[] = [];
  let mech: Mechanism | null = null, ref: ChartRef | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const h2 = line.match(/^##\s+(.+?)\s*$/), h3 = line.match(/^###\s+`?([^\s`]+)`?\s*$/);
    if (h2 && !line.startsWith("###")) {
      mech = { name: h2[1], lineNo: i + 1, evidence: [], hasEvidenceLine: false, elements: [], refs: [] };
      out.push(mech);
      ref = null;
      return;
    }
    if (!mech) return;
    if (h3) {
      ref = { slug: h3[1], lineNo: i + 1, rows: [] };
      mech.refs.push(ref);
      return;
    }
    const ev = line.match(/^\s*(?:\*\*)?Evidence(?:\*\*)?\s*:\s*(.*)$/i);
    if (ev) {
      mech.hasEvidenceLine = true;
      mech.evidence.push(...[...ev[1].matchAll(/E\d+/gi)].map((m) => m[0].toUpperCase()));
      return;
    }
    const res = line.match(/^\s*(?:\*\*)?Result(?:\*\*)?\s*:\s*(.*)$/i);
    if (res) {
      const raw = res[1].trim();
      const k = raw.match(/^knocked out by\s+`?([^\s`.;,]+(?:\.[^\s`.;,]+)*)/i);
      const c = raw.match(/^closest\s+`?([^\s`;,]+)`?[;,]?\s+differs in\s+(.+)$/i);
      if (k) mech.result = { kind: "knocked", ref: k[1], letters: [], raw, lineNo: i + 1 };
      else if (c) mech.result = { kind: "closest", ref: c[1], letters: [...c[2].matchAll(/\b([A-Z])\b/g)].map((m) => m[1]), raw, lineNo: i + 1 };
      else if (/^nothing close found/i.test(raw)) mech.result = { kind: "nothing", letters: [], raw, lineNo: i + 1 };
      else mech.result = { kind: "unknown", letters: [], raw, lineNo: i + 1 };
      ref = null;
      return;
    }
    const pr = line.match(/^\s*(?:\*\*)?Protect(?:\*\*)?\s*:\s*(\w+)\s*(?:\|\s?(.*))?$/i);
    if (pr) {
      mech.protect = { call: pr[1].toLowerCase(), reason: (pr[2] ?? "").trim(), lineNo: i + 1 };
      ref = null;
      return;
    }
    const row = line.match(/^\s*[-*]\s+([A-Z])\s*:\s*(yes|partly|no)\b\s*(?:\|\s?(.*))?$/i);
    if (row && ref) {
      ref.rows.push({ letter: row[1].toUpperCase(), status: row[2].toLowerCase() as Row["status"], quote: (row[3] ?? "").trim().replace(/^["“]|["”]$/g, ""), lineNo: i + 1 });
      return;
    }
    const el = line.match(/^\s*[-*]\s+([A-Z])[.)]\s+(.+)$/);
    if (el && !ref) mech.elements.push({ letter: el[1], text: el[2].trim() });
  });
  return out;
}

export function checkChart(packet: string, evidenceIds: string[], searchFoundSomething: boolean, searchRan: boolean): ChartCheck {
  const path = join(packet, CHART_FILE);
  const r: ChartCheck = { present: existsSync(path), errors: [], warnings: [], outcomes: [], mechanisms: 0, references: 0, quotes: 0 };
  if (!r.present) {
    if (searchFoundSomething) r.errors.push(`${CHART_FILE} is missing. The search returned results and nothing compares them with the mechanisms. Fetch the closest references with patty_prior_art (fetch) and write the chart.`);
    else if (searchRan) r.warnings.push(`There is no ${CHART_FILE}, because the prior art search was unavailable or found nothing. Nothing in this packet says whether the mechanisms are new.`);
    else r.warnings.push(`No prior art search was run, so there is no ${CHART_FILE}. Nothing in this packet says whether the mechanisms are new.`);
    return r;
  }
  const mechs = parseChart(readFileSync(path, "utf8"));
  r.mechanisms = mechs.length;
  if (!mechs.length) r.errors.push(`${CHART_FILE} has no mechanisms. Head each one "## M1. Name".`);
  const seenRefs = new Set<string>(), charted = new Set<string>();
  for (const m of mechs) {
    const where = `${CHART_FILE} "${m.name}" (line ${m.lineNo})`;
    if (!m.hasEvidenceLine || !m.evidence.length) r.errors.push(`${where}: no "Evidence:" line naming the EVIDENCE.md entries it charts (for example "Evidence: E1").`);
    for (const e of m.evidence) {
      charted.add(e);
      if (evidenceIds.length && !evidenceIds.includes(e)) r.errors.push(`${where}: points at ${e}, which EVIDENCE.md does not have.`);
    }
    if (m.elements.length < 2) r.errors.push(`${where}: break the mechanism into at least two elements, one per line, "- A. ...", "- B. ...". One element cannot show a difference.`);
    const letters = m.elements.map((e) => e.letter);
    const allYes: string[] = [];
    for (const ref of m.refs) {
      const stored = readReference(packet, ref.slug);
      seenRefs.add(ref.slug);
      const rw = `${CHART_FILE} line ${ref.lineNo} (${ref.slug})`;
      if (!stored) {
        r.errors.push(`${rw}: references/${ref.slug}.txt does not exist. Fetch it with patty_prior_art (fetch) before charting it; a reference Patty has not stored cannot be quoted.`);
        continue;
      }
      const body = flatten(stored.body);
      for (const l of letters) if (!ref.rows.some((x) => x.letter === l)) r.errors.push(`${rw}: no row for element ${l}. Every element needs "yes | quote", "partly | quote" or "no".`);
      for (const row of ref.rows) {
        if (!letters.includes(row.letter)) r.errors.push(`${CHART_FILE} line ${row.lineNo}: element ${row.letter} is not in this mechanism's element list.`);
        if (row.status === "no") continue;
        const q = flatten(row.quote);
        if (q.replace(/\s/g, "").length < 12) r.errors.push(`${CHART_FILE} line ${row.lineNo}: "${row.status}" needs a quote from ${ref.slug} after " | ", at least a few words long.`);
        else if (!body.includes(q)) r.errors.push(`${CHART_FILE} line ${row.lineNo}: the quote "${row.quote.slice(0, 80)}${row.quote.length > 80 ? "..." : ""}" is not in references/${ref.slug}.txt. Copy the words exactly, or change the row to "no".`);
        else r.quotes++;
      }
      if (letters.length && letters.every((l) => ref.rows.find((x) => x.letter === l)?.status === "yes")) allYes.push(ref.slug);
    }
    const res = m.result;
    const meta = (slug?: string) => {
      const s = slug ? readReference(packet, slug) : null;
      return { ref: slug, refTitle: s?.title, refDate: s?.date };
    };
    if (!res) r.errors.push(`${where}: no "Result:" line. Write "Result: knocked out by <reference>", "Result: closest <reference>; differs in B, C" or "Result: nothing close found".`);
    else if (res.kind === "unknown") r.errors.push(`${CHART_FILE} line ${res.lineNo}: "Result: ${res.raw}" is not one of the three forms: "knocked out by <reference>", "closest <reference>; differs in B, C", "nothing close found".`);
    else if (res.kind === "knocked") {
      if (!allYes.includes(res.ref!)) r.errors.push(`${CHART_FILE} line ${res.lineNo}: says knocked out by ${res.ref}, but the chart does not mark every element "yes" for it.`);
      r.outcomes.push({ name: m.name, verdict: `KNOCKED OUT by ${res.ref}: one reference has every element`, ...meta(res.ref) });
      r.warnings.push(`"${m.name}" is knocked out by ${res.ref}: a single reference has every element. Do not present it as new. Cut it, or narrow it to what that reference lacks.`);
    } else if (allYes.length) {
      r.errors.push(`${where}: ${allYes[0]} is marked "yes" for every element, so the result has to be "knocked out by ${allYes[0]}". If an element is in fact missing from it, change that row.`);
    } else if (res.kind === "closest") {
      const ref = m.refs.find((x) => x.slug === res.ref);
      if (!ref) r.errors.push(`${CHART_FILE} line ${res.lineNo}: ${res.ref} is not one of the references charted under this mechanism.`);
      else {
        if (!res.letters.length) r.errors.push(`${CHART_FILE} line ${res.lineNo}: name the elements it differs in, by letter.`);
        for (const l of res.letters) if (ref.rows.find((x) => x.letter === l)?.status === "yes") r.errors.push(`${CHART_FILE} line ${res.lineNo}: says it differs in ${l}, but ${l} is marked "yes" for ${res.ref}.`);
      }
      const diff = res.letters.map((l) => `${l} (${m.elements.find((e) => e.letter === l)?.text ?? "?"})`).join("; ");
      r.outcomes.push({ name: m.name, verdict: `closest reference lacks: ${diff}`, ...meta(res.ref) });
    } else {
      if (!m.refs.length) r.warnings.push(`"${m.name}": "nothing close found" with no reference compared. That reports a search, not a comparison.`);
      r.outcomes.push({ name: m.name, verdict: `nothing close found among ${m.refs.length} reference${m.refs.length === 1 ? "" : "s"} read; not a clearance` });
    }
  }
  // The call on whether each mechanism is worth protecting is the host's judgment, written down so the human can disagree with it.
  mechs.forEach((m, i) => {
    const p = m.protect;
    const where = `${CHART_FILE} "${m.name}"`;
    if (!p) r.errors.push(`${where}: no "Protect:" line. Write "Protect: yes | reason", "Protect: maybe | reason" or "Protect: no | reason".`);
    else if (!["yes", "maybe", "no"].includes(p.call)) r.errors.push(`${CHART_FILE} line ${p.lineNo}: Protect is "yes", "maybe" or "no", then " | " and the reason.`);
    else if (p.reason.replace(/\s/g, "").length < 15) r.errors.push(`${CHART_FILE} line ${p.lineNo}: give the reason after " | ": what a competitor would have to copy, and whether you could tell from outside that they had.`);
    else if (m.result?.kind === "knocked" && p.call !== "no") r.errors.push(`${CHART_FILE} line ${p.lineNo}: "${m.name}" is knocked out, so Protect has to be "no".`);
    else if (r.outcomes[i]) r.outcomes[i].protect = `${p.call}: ${p.reason}`;
  });
  r.references = seenRefs.size;
  for (const e of evidenceIds) if (!charted.has(e)) r.warnings.push(`EVIDENCE.md entry ${e} is not charted against any prior art in ${CHART_FILE}.`);
  return r;
}
