import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISCLAIMER, markDone } from "./packet.ts";

// Google Patents' own query endpoint. It is not a documented API and can change or
// refuse requests at any time, so every failure is written into the file and never thrown.
// The official USPTO search API needs a key tied to an identity-verified account; see README.
const ENDPOINT = process.env.PATTY_PATENT_SEARCH_URL ?? "https://patents.google.com/xhr/query";
const PER_QUERY = 8;
const MAX_QUERIES = 8;

export type Hit = { title: string; number: string; link: string; priority?: string; filed?: string; granted?: string; assignee?: string; inventor?: string; snippet?: string };
export type QueryResult = { query: string; total?: number; hits: Hit[]; error?: string };

const strip = (s: unknown) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&hellip;/g, "...").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const googlePatentsLink = (q: string) => `https://patents.google.com/?q=${encodeURIComponent(q)}`;

export async function searchOne(query: string): Promise<QueryResult> {
  if (process.env.PATTY_OFFLINE === "1") return { query, hits: [], error: "PATTY_OFFLINE=1 is set" };
  const inner = `q=${encodeURIComponent(query)}&oq=${encodeURIComponent(query)}`;
  const url = `${ENDPOINT}?url=${encodeURIComponent(inner)}&exp=`;
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; patty-mcp)", Accept: "application/json" },
    });
    if (!r.ok) return { query, hits: [], error: `the search service answered HTTP ${r.status}` };
    const data = (await r.json()) as any;
    const results = data?.results;
    const rows: any[] = (results?.cluster ?? []).flatMap((c: any) => c?.result ?? []);
    if (!results || !Array.isArray(rows)) return { query, hits: [], error: "the search service answered in a form Patty does not recognise" };
    const hits = rows.slice(0, PER_QUERY).map((row): Hit => {
      const p = row?.patent ?? {};
      const number = strip(p.publication_number);
      return {
        title: strip(p.title) || "(untitled)",
        number,
        link: number ? `https://patents.google.com/patent/${encodeURIComponent(number)}/en` : googlePatentsLink(query),
        priority: p.priority_date, filed: p.filing_date, granted: p.grant_date,
        assignee: strip(p.assignee) || undefined, inventor: strip(p.inventor) || undefined,
        snippet: strip(p.snippet) || undefined,
      };
    });
    return { query, total: typeof results.total_num_results === "number" ? results.total_num_results : undefined, hits };
  } catch (e) {
    const err = e as Error;
    return { query, hits: [], error: err.name === "TimeoutError" ? "the search timed out" : `the network request failed (${err.message || err.name})` };
  }
}

export async function priorArt(packet: string, queries: string[]): Promise<string> {
  const qs = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, MAX_QUERIES);
  if (!qs.length) throw new Error("Pass at least one query.");
  const results: QueryResult[] = [];
  for (const q of qs) {
    results.push(await searchOne(q));
    if (qs.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
  const failed = results.filter((r) => r.error).length;
  const path = join(packet, "PRIOR_ART.md");
  // Notes the human or the host model wrote under "## Notes" survive a new search.
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const notes = old.includes("\n## Notes") ? old.slice(old.indexOf("\n## Notes") + 1).trimEnd() : "## Notes\n\nNothing written yet. For each result that looks close: what it does, and how the mechanism in the specification differs.";

  const L: string[] = [
    "# Prior art search",
    "",
    DISCLAIMER,
    "",
    `Searched ${new Date().toISOString()}. Source: Google Patents (patents.google.com), through its own unofficial query endpoint. The query text below was sent to that service; no source code was.`,
    "",
    "This is a quick keyword search. It is not a patentability search and it does not cover papers, products, repositories or blog posts. Finding nothing here does not mean the idea is new.",
    "",
  ];
  results.forEach((r, i) => {
    L.push(`## Query ${i + 1}: ${r.query}`, "");
    if (r.error) {
      L.push(`Search unavailable: ${r.error}. Nothing was found or ruled out. Run it yourself: ${googlePatentsLink(r.query)}`, "");
      return;
    }
    if (!r.hits.length) {
      L.push(`No results. Try broader wording: ${googlePatentsLink(r.query)}`, "");
      return;
    }
    L.push(`${r.total !== undefined ? `${r.total} results reported; ` : ""}the first ${r.hits.length}:`, "");
    r.hits.forEach((h, n) => {
      const meta = [h.number, h.priority && `priority ${h.priority}`, h.filed && `filed ${h.filed}`, h.granted && `granted ${h.granted}`, h.assignee].filter(Boolean).join(" · ");
      L.push(`${n + 1}. [${h.title.replace(/[\[\]]/g, "")}](${h.link})`, `   ${meta}`);
      if (h.snippet) L.push(`   ${h.snippet}`);
    });
    L.push("", `All results: ${googlePatentsLink(r.query)}`, "");
  });
  L.push(
    "## Search it yourself",
    "",
    "- USPTO Patent Public Search (official, full text of US patents and published applications): https://www.uspto.gov/patents/search/patent-public-search",
    "- Google Patents: https://patents.google.com/",
    "- Espacenet (European Patent Office, worldwide): https://worldwide.espacenet.com/",
    "",
    notes,
    "",
  );
  writeFileSync(path, L.join("\n"));
  markDone(packet, "prior_art");

  const out = [`PRIOR_ART.md written: ${results.length} quer${results.length === 1 ? "y" : "ies"}, ${failed} unavailable.`, ""];
  for (const r of results) {
    if (r.error) out.push(`- "${r.query}": search unavailable (${r.error}). The packet is not blocked.`);
    else {
      out.push(`- "${r.query}": ${r.total ?? "?"} reported`);
      for (const h of r.hits) out.push(`    ${h.number} · ${h.priority ?? "no priority date"} · ${h.title} · ${h.link}`);
    }
  }
  if (failed < results.length) out.push("", `Read the close ones, then write what you found under "## Notes" in PRIOR_ART.md and make sure the specification describes the difference.`);
  if (failed) out.push("", "A failed search rules nothing out. Tell the human the search did not run and carry on with the packet.");
  return out.join("\n");
}
