import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flatten, readReference } from "./references.ts";

// CLAIM_CHART.md: someone else's patent against this repo. Each independent claim is split
// into elements in the claim's own words, and each element is marked found in the code
// (with a file:line citation) or not found (with the reason). The claim words are checked
// against the stored patent text and the citations against the repo.

export const CLAIM_CHART_FILE = "CLAIM_CHART.md";

type Row = { letter: string; status: "yes" | "partly" | "no"; rest: string; lineNo: number };
type Section = { slug: string; claim: number; lineNo: number; elements: { letter: string; text: string; lineNo: number }[]; rows: Row[]; result?: { kind: "all" | "missing" | "unknown"; letters: string[]; raw: string; lineNo: number } };
export type ClaimOutcome = { slug: string; claim: number; verdict: string; allFound: boolean };
export type PatentSummary = { slug: string; title: string; status: string; expiration: string; owner: string; source: string; independent: number[] };
export type ClaimChartCheck = { present: boolean; errors: string[]; warnings: string[]; outcomes: ClaimOutcome[]; patents: PatentSummary[]; citations: number };
export type CiteChecker = (path: string, start: number, end: number, text: string, where: string) => string | null;

export function parseClaimChart(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(/^##\s+`?([A-Za-z]{2}[\w]+)`?,?\s+claim\s+(\d+)\s*$/i);
    if (h) {
      cur = { slug: h[1].toUpperCase(), claim: Number(h[2]), lineNo: i + 1, elements: [], rows: [] };
      out.push(cur);
      return;
    }
    if (/^##\s/.test(line)) {
      cur = null; // any other heading (notes, options) is free text
      return;
    }
    if (!cur) return;
    const res = line.match(/^\s*(?:\*\*)?Result(?:\*\*)?\s*:\s*(.*)$/i);
    if (res) {
      const raw = res[1].trim();
      const miss = raw.match(/^not found in the code\s*:\s*(.+)$/i);
      if (/^every element found in the code/i.test(raw)) cur.result = { kind: "all", letters: [], raw, lineNo: i + 1 };
      else if (miss) cur.result = { kind: "missing", letters: [...miss[1].matchAll(/\b([A-Z])\b/g)].map((m) => m[1]), raw, lineNo: i + 1 };
      else cur.result = { kind: "unknown", letters: [], raw, lineNo: i + 1 };
      return;
    }
    const row = line.match(/^\s*[-*]\s+([A-Z])\s*:\s*(yes|partly|no)\b\s*(?:\|\s?(.*))?$/i);
    if (row) {
      cur.rows.push({ letter: row[1].toUpperCase(), status: row[2].toLowerCase() as Row["status"], rest: (row[3] ?? "").trim(), lineNo: i + 1 });
      return;
    }
    const el = line.match(/^\s*[-*]\s+([A-Z])[.)]\s+(.+)$/);
    if (el) cur.elements.push({ letter: el[1], text: el[2].trim().replace(/^["“]|["”]$/g, ""), lineNo: i + 1 });
  });
  return out;
}

const notInForce = (status: string) => /expired|abandon|withdrawn|ceased|lapsed|revoked|rejected/i.test(status);

export function checkClaimChart(packet: string, cite: CiteChecker, required: boolean): ClaimChartCheck {
  const path = join(packet, CLAIM_CHART_FILE);
  const r: ClaimChartCheck = { present: existsSync(path), errors: [], warnings: [], outcomes: [], patents: [], citations: 0 };
  if (!r.present) {
    if (required) r.errors.push(`${CLAIM_CHART_FILE} is missing. Fetch the patent with patty_prior_art (fetch) and chart each independent claim against the code.`);
    return r;
  }
  const sections = parseClaimChart(readFileSync(path, "utf8"));
  if (!sections.length) r.errors.push(`${CLAIM_CHART_FILE} has no claims charted. Head each one "## US1234567B2 claim 1".`);
  const bySlug = new Map<string, Section[]>();
  for (const s of sections) bySlug.set(s.slug, [...(bySlug.get(s.slug) ?? []), s]);

  for (const [slug, list] of bySlug) {
    const ref = readReference(packet, slug);
    if (!ref || ref.kind !== "patent") {
      r.errors.push(`${CLAIM_CHART_FILE} line ${list[0].lineNo}: references/${slug}.txt is not a stored patent. Fetch it with patty_prior_art (fetch) first; claims cannot be charted from memory.`);
      continue;
    }
    r.patents.push({ slug, title: ref.title, status: ref.status, expiration: ref.expiration, owner: ref.owner, source: ref.source, independent: ref.independent });
    if (notInForce(ref.status)) r.warnings.push(`${slug} is listed as "${ref.status.split(" (")[0]}". A patent that is not in force cannot be infringed from then on; confirm the status at the USPTO before relying on it.`);
    for (const n of ref.independent) if (!list.some((s) => s.claim === n)) r.errors.push(`${slug}: claim ${n} is independent and is not charted. Every independent claim has to be charted; avoiding one does not avoid the others.`);

    for (const s of list) {
      const where = `${CLAIM_CHART_FILE} line ${s.lineNo} (${slug} claim ${s.claim})`;
      const claimText = ref.claims.get(s.claim);
      if (!claimText) {
        r.errors.push(`${where}: the stored patent has no claim ${s.claim}.`);
        continue;
      }
      const flat = flatten(claimText);
      if (s.elements.length < 2) r.errors.push(`${where}: split the claim into its elements, one per line, "- A. ...", in the claim's own words.`);
      let covered = 0;
      for (const e of s.elements) {
        const q = flatten(e.text.replace(/[;,.]?\s*(?:and)?\s*$/i, ""));
        if (q.replace(/\s/g, "").length < 12) r.errors.push(`${CLAIM_CHART_FILE} line ${e.lineNo}: element ${e.letter} is too short. Copy the limitation from the claim.`);
        else if (!flat.includes(q)) r.errors.push(`${CLAIM_CHART_FILE} line ${e.lineNo}: element ${e.letter} is not the claim's own words ("${e.text.slice(0, 70)}${e.text.length > 70 ? "..." : ""}"). Copy it exactly from claim ${s.claim} in references/${slug}.txt; a paraphrase can drop a limitation.`);
        else covered += q.length;
      }
      // Elements that together leave out much of the claim hide limitations that could have been avoided or met.
      if (s.elements.length >= 2 && covered < flat.length * 0.6) r.warnings.push(`${where}: the elements quote ${Math.round((covered / flat.length) * 100)}% of the claim's text. Check that no limitation was left out.`);
      const letters = s.elements.map((e) => e.letter);
      for (const l of letters) if (!s.rows.some((x) => x.letter === l)) r.errors.push(`${where}: no row for element ${l}. Write "- ${l}: yes | path:line | code", "- ${l}: partly | path:line | code" or "- ${l}: no | why not".`);
      for (const row of s.rows) {
        if (!letters.includes(row.letter)) r.errors.push(`${CLAIM_CHART_FILE} line ${row.lineNo}: element ${row.letter} is not in this claim's element list.`);
        if (row.status === "no") {
          if (row.rest.replace(/\s/g, "").length < 10) r.errors.push(`${CLAIM_CHART_FILE} line ${row.lineNo}: a "no" needs the reason after " | ": what the code does instead, or that nothing in the repo does this.`);
          continue;
        }
        const c = row.rest.match(/^`?(.+?):(\d+)(?:\s*[-–]\s*(\d+))?`?\s+\|\s?(.*)$/);
        if (!c) {
          r.errors.push(`${CLAIM_CHART_FILE} line ${row.lineNo}: "${row.status}" needs the code that does it: "| path:line | text from that line".`);
          continue;
        }
        const err = cite(c[1].trim(), Number(c[2]), c[3] ? Number(c[3]) : Number(c[2]), c[4], `${CLAIM_CHART_FILE} line ${row.lineNo}`);
        if (err) r.errors.push(err);
        else r.citations++;
      }
      const missing = letters.filter((l) => s.rows.find((x) => x.letter === l)?.status === "no");
      const text = (l: string) => s.elements.find((e) => e.letter === l)?.text ?? "?";
      const res = s.result;
      if (!res) r.errors.push(`${where}: no "Result:" line. Write "Result: every element found in the code" or "Result: not found in the code: B, D".`);
      else if (res.kind === "unknown") r.errors.push(`${CLAIM_CHART_FILE} line ${res.lineNo}: "Result: ${res.raw}" is not one of the two forms: "every element found in the code", "not found in the code: B, D".`);
      else if (!missing.length && res.kind !== "all") r.errors.push(`${CLAIM_CHART_FILE} line ${res.lineNo}: no element is marked "no", so the result has to be "every element found in the code". A "partly" counts as found.`);
      else if (missing.length && (res.kind !== "missing" || res.letters.slice().sort().join() !== missing.slice().sort().join())) r.errors.push(`${CLAIM_CHART_FILE} line ${res.lineNo}: the rows mark ${missing.join(", ")} as not found, so the result has to be "not found in the code: ${missing.join(", ")}".`);
      if (!missing.length) {
        r.outcomes.push({ slug, claim: s.claim, allFound: true, verdict: "EVERY ELEMENT FOUND in the code" });
        if (!notInForce(ref.status)) r.warnings.push(`${slug} claim ${s.claim}: every element of the claim was found in the code. Do not ship or sell this as it stands on the strength of this file. Change the code so that one whole element is gone, or take it to a patent attorney.`);
      } else r.outcomes.push({ slug, claim: s.claim, allFound: false, verdict: `not found in the code: ${missing.map((l) => `${l} ("${text(l).slice(0, 90)}")`).join("; ")}` });
    }
  }
  return r;
}
