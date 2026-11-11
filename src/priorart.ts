import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISCLAIMER, markDone } from "./packet.ts";
import { fetchReference, htmlToText, listReferences, pace, patentSource, readReference, referencesDir, saveReference, serp, serpKey, type Reference } from "./references.ts";

// Patents: Google Patents' own query endpoint. It is not a documented API and can change or
// refuse requests at any time, so every failure is written into the file and never thrown.
// The official USPTO search API needs a key tied to an identity-verified account; see README.
// Papers: the arXiv API. Code: GitHub repository search. Both are public and keyless.
const ENDPOINT = process.env.PATTY_PATENT_SEARCH_URL ?? "https://patents.google.com/xhr/query";
const PER_QUERY = 8;
const MAX_QUERIES = 8;
const UA = "Mozilla/5.0 (compatible; patty-mcp)";

export type Hit = { title: string; number: string; link: string; priority?: string; filed?: string; granted?: string; assignee?: string; inventor?: string; snippet?: string };
export type Other = { title: string; link: string; date?: string; note?: string };
export type QueryResult = { query: string; at: string; total?: number; hits: Hit[]; error?: string; papers: Other[]; papersError?: string; code: Other[]; codeError?: string };

const strip = (s: unknown) => htmlToText(String(s ?? "")).replace(/\s+/g, " ").trim();
const offline = () => process.env.PATTY_OFFLINE === "1";
const why = (e: unknown) => {
  const err = e as Error;
  return err.name === "TimeoutError" ? "the search timed out" : `the request failed (${err.message || err.name})`;
};

export const googlePatentsLink = (q: string) => `https://patents.google.com/?q=${encodeURIComponent(q)}`;

// Turns a SerpApi patent-search response into hits. Exported for tests.
export function hitsFromSerp(d: any, query: string): { total?: number; hits: Hit[] } {
  const rows: any[] = Array.isArray(d?.organic_results) ? d.organic_results : [];
  const hits = rows.filter((r) => r?.is_scholar !== true).slice(0, PER_QUERY).map((p): Hit => {
    const number = strip(p.publication_number ?? String(p.patent_id ?? "").replace(/^patent\/|\/[a-z]{2}$/g, ""));
    return {
      title: strip(p.title) || "(untitled)", number,
      link: number ? `https://patents.google.com/patent/${encodeURIComponent(number)}/en` : googlePatentsLink(query),
      priority: p.priority_date, filed: p.filing_date, granted: p.grant_date,
      assignee: strip(p.assignee) || undefined, inventor: strip(p.inventor) || undefined, snippet: strip(p.snippet) || undefined,
    };
  });
  const total = Number(d?.search_information?.total_results);
  return { total: Number.isFinite(total) ? total : undefined, hits };
}

async function searchPatents(query: string): Promise<{ total?: number; hits: Hit[]; error?: string }> {
  if (offline()) return { hits: [], error: "PATTY_OFFLINE=1 is set" };
  if (serpKey() && !process.env.PATTY_PATENT_SEARCH_URL) {
    try {
      return hitsFromSerp(await serp({ engine: "google_patents", q: query, num: "10" }), query);
    } catch (e) {
      return { hits: [], error: (e as Error).message };
    }
  }
  const inner = `q=${encodeURIComponent(query)}&oq=${encodeURIComponent(query)}`;
  try {
    const url = `${ENDPOINT}?url=${encodeURIComponent(inner)}&exp=`;
    let r!: Response;
    for (let attempt = 0; attempt < 2; attempt++) {
      await pace(url);
      r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.ok || ![429, 503].includes(r.status)) break;
      await new Promise((res) => setTimeout(res, 8000));
    }
    if (r.status === 429 || r.status === 503) return { hits: [], error: `the search service is refusing requests for now (HTTP ${r.status}); wait a few minutes and run this query again` };
    if (!r.ok) return { hits: [], error: `the search service answered HTTP ${r.status}` };
    const results = ((await r.json()) as any)?.results;
    const rows: any[] = (results?.cluster ?? []).flatMap((c: any) => c?.result ?? []);
    if (!results) return { hits: [], error: "the search service answered in a form Patty does not recognise" };
    const hits = rows.slice(0, PER_QUERY).map((row): Hit => {
      const p = row?.patent ?? {};
      const number = strip(p.publication_number);
      return {
        title: strip(p.title) || "(untitled)", number,
        link: number ? `https://patents.google.com/patent/${encodeURIComponent(number)}/en` : googlePatentsLink(query),
        priority: p.priority_date, filed: p.filing_date, granted: p.grant_date,
        assignee: strip(p.assignee) || undefined, inventor: strip(p.inventor) || undefined, snippet: strip(p.snippet) || undefined,
      };
    });
    return { total: typeof results.total_num_results === "number" ? results.total_num_results : undefined, hits };
  } catch (e) {
    return { hits: [], error: why(e) };
  }
}

// Paper and repository search need all words to match, so a long query is cut to its most telling words.
const STOP = new Set("a an and the of for to in on by with from then than that this which first when where into over under using use used via as at is are be or not its their each any all one two method system apparatus device process based".split(" "));
const keywords = (q: string, n: number) => [...new Set(q.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, n);

async function searchPapers(query: string): Promise<{ papers: Other[]; papersError?: string }> {
  if (offline()) return { papers: [], papersError: "PATTY_OFFLINE=1 is set" };
  if (process.env.PATTY_PATENT_SEARCH_URL) return { papers: [], papersError: "skipped" };
  try {
    let xml = "";
    // Fewer words on the second try, if the first matched nothing.
    for (const n of [5, 3]) {
      const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(keywords(query, n).map((w) => `all:${w}`).join(" AND "))}&max_results=5&sortBy=relevance`;
      await pace(url);
      const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": UA } });
      if (r.status === 429) return { papers: [], papersError: "arXiv is rate-limiting; run this query again in a minute" };
      if (!r.ok) return { papers: [], papersError: `arXiv answered HTTP ${r.status}` };
      xml = await r.text();
      if (xml.includes("<entry>")) break;
    }
    const papers = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m): Other => {
      const pick = (tag: string) => strip(m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "");
      return { title: pick("title"), link: pick("id").replace(/^http:/, "https:").replace(/v\d+$/, ""), date: pick("published").slice(0, 10), note: pick("summary").slice(0, 260) };
    });
    return { papers };
  } catch (e) {
    return { papers: [], papersError: why(e) };
  }
}

async function searchCode(query: string): Promise<{ code: Other[]; codeError?: string }> {
  if (offline()) return { code: [], codeError: "PATTY_OFFLINE=1 is set" };
  if (process.env.PATTY_PATENT_SEARCH_URL) return { code: [], codeError: "skipped" };
  try {
    // One request per query: unauthenticated GitHub search allows about ten a minute.
    const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(keywords(query, 3).join(" ") + " in:name,description")}&per_page=5`;
    await pace(ghUrl, 6500);
    const r = await fetch(ghUrl, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": UA, Accept: "application/vnd.github+json" } });
    if (r.status === 403 || r.status === 429) return { code: [], codeError: "GitHub is rate-limiting unauthenticated search; run this query again in a minute" };
    if (!r.ok) return { code: [], codeError: `GitHub answered HTTP ${r.status}` };
    const items: any[] = ((await r.json()) as any)?.items ?? [];
    return { code: items.map((it): Other => ({ title: it.full_name, link: it.html_url, date: String(it.created_at ?? "").slice(0, 10), note: `${it.stargazers_count} stars. ${strip(it.description ?? "")}`.slice(0, 260) })) };
  } catch (e) {
    return { code: [], codeError: why(e) };
  }
}

export async function searchOne(query: string): Promise<QueryResult> {
  const [p, a, c] = await Promise.all([searchPatents(query), searchPapers(query), searchCode(query)]);
  return { query, at: new Date().toISOString(), ...p, ...a, ...c };
}

// Every search is kept, so a second round of queries adds to the first instead of replacing it.
const logPath = (packet: string) => join(referencesDir(packet), "search.json");
export function readSearchLog(packet: string): QueryResult[] {
  try {
    return existsSync(logPath(packet)) ? (JSON.parse(readFileSync(logPath(packet), "utf8")) as QueryResult[]) : [];
  } catch {
    return [];
  }
}

function writePriorArt(packet: string, log: QueryResult[]) {
  const path = join(packet, "PRIOR_ART.md");
  // Notes written under "## Notes" survive a new search.
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const notes = old.includes("\n## Notes") ? old.slice(old.indexOf("\n## Notes") + 1).trimEnd() : "## Notes\n\nNothing written yet.";
  const L: string[] = [
    "# Prior art search",
    "",
    DISCLAIMER,
    "",
    `Sources: ${patentSource()} for patents, arXiv for papers, GitHub for repositories. The query text was sent to those services; no source code was.`,
    "",
    "This is a keyword search. It is not a patentability search. Finding nothing here does not mean the idea is new: most software prior art is in products, documentation and code that no search of this kind reaches. PRIOR_ART_CHART.md compares the closest references found with each mechanism, element by element.",
    "",
  ];
  log.forEach((r, i) => {
    L.push(`## Query ${i + 1}: ${r.query}`, "", `Searched ${r.at}.`, "", "### Patents", "");
    if (r.error) L.push(`Search unavailable: ${r.error}. Nothing was found or ruled out. Run it yourself: ${googlePatentsLink(r.query)}`, "");
    else if (!r.hits.length) L.push(`No results. Try broader wording: ${googlePatentsLink(r.query)}`, "");
    else {
      L.push(`${r.total !== undefined ? `${r.total} results reported; ` : ""}the first ${r.hits.length}:`, "");
      r.hits.forEach((h, n) => {
        const meta = [h.number, h.priority && `priority ${h.priority}`, h.filed && `filed ${h.filed}`, h.granted && `granted ${h.granted}`, h.assignee].filter(Boolean).join(" · ");
        L.push(`${n + 1}. [${h.title.replace(/[\[\]]/g, "")}](${h.link})`, `   ${meta}`);
        if (h.snippet) L.push(`   ${h.snippet}`);
      });
      L.push("", `All results: ${googlePatentsLink(r.query)}`, "");
    }
    const other = (label: string, rows: Other[], err?: string) => {
      if (err === "skipped") return;
      L.push(`### ${label}`, "");
      if (err) L.push(`Search unavailable: ${err}.`, "");
      else if (!rows.length) L.push("No results.", "");
      else {
        rows.forEach((o, n) => L.push(`${n + 1}. [${o.title.replace(/[\[\]]/g, "")}](${o.link})${o.date ? ` · ${o.date}` : ""}`, ...(o.note ? [`   ${o.note}`] : [])));
        L.push("");
      }
    };
    other("Papers (arXiv)", r.papers ?? [], r.papersError);
    other("Code (GitHub repositories)", r.code ?? [], r.codeError);
  });
  const refs = listReferences(packet).map((s) => readReference(packet, s)!).filter(Boolean);
  L.push("## References read in full", "");
  if (!refs.length) L.push("None fetched yet.", "");
  else {
    for (const r of refs) L.push(`- ${r.slug} · ${r.title} · ${r.date} · ${r.source} · stored at references/${r.slug}.txt`);
    L.push("");
  }
  L.push(
    "## Search it yourself",
    "",
    "- USPTO Patent Public Search (official, full text of US patents and published applications): https://www.uspto.gov/patents/search/patent-public-search",
    "- Google Patents: https://patents.google.com/",
    "- Espacenet (European Patent Office, worldwide): https://worldwide.espacenet.com/",
    "- Google Scholar, for papers: https://scholar.google.com/",
    "",
    notes,
    "",
  );
  writeFileSync(path, L.join("\n"));
}

export async function priorArt(packet: string, queries: string[] = [], fetch: string[] = []): Promise<string> {
  const qs = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, MAX_QUERIES);
  const ids = [...new Set(fetch.map((f) => f.trim()).filter(Boolean))].slice(0, 12);
  if (!qs.length && !ids.length) throw new Error("Pass queries to search, or fetch to read references in full, or both.");
  mkdirSync(referencesDir(packet), { recursive: true });
  const out: string[] = [];

  let log = readSearchLog(packet);
  const fresh: QueryResult[] = [];
  // Queries start together; pacing is per source, so each source still gets them one at a time.
  fresh.push(...(await Promise.all(qs.map((q) => searchOne(q)))));
  out.push(`Patent source: ${patentSource()}.`, "");
  if (fresh.length) {
    log = [...log.filter((old) => !fresh.some((f) => f.query === old.query)), ...fresh];
    writeFileSync(logPath(packet), JSON.stringify(log, null, 1) + "\n");
    const failed = fresh.filter((r) => r.error).length;
    out.push(`Searched ${fresh.length} quer${fresh.length === 1 ? "y" : "ies"}; patent search unavailable for ${failed}.`, "");
    for (const r of fresh) {
      out.push(`Query: "${r.query}"`);
      if (r.error) out.push(`  patents: search unavailable (${r.error}). The packet is not blocked.`);
      else {
        out.push(`  patents: ${r.total ?? "?"} reported`);
        for (const h of r.hits) out.push(`    ${h.number} · ${h.priority ?? "no priority date"} · ${h.title}`);
      }
      if (r.papersError !== "skipped") out.push(r.papersError ? `  papers: unavailable (${r.papersError})` : `  papers: ${r.papers.length}`, ...r.papers.map((o) => `    ${o.link} · ${o.date} · ${o.title}`));
      if (r.codeError !== "skipped") out.push(r.codeError ? `  code: unavailable (${r.codeError})` : `  code: ${r.code.length}`, ...r.code.map((o) => `    ${o.link} · ${o.note}`));
    }
    out.push("");
    if (failed) out.push("A failed search rules nothing out. Tell the human the search did not run and carry on with the packet.", "");
  }

  const got: Reference[] = [];
  for (const id of ids) {
    try {
      const ref = await fetchReference(id);
      const path = saveReference(packet, ref);
      got.push(ref);
      out.push(`Fetched ${ref.slug} · ${ref.kind} · ${ref.date ?? "no date"} (${ref.dateLabel ?? ""}) · ${ref.title}${ref.via ? ` · via ${ref.via}` : ""}`,
        ...(ref.kind === "patent" ? [`  status ${ref.status ?? "not listed"} · expiration ${ref.expiration ?? "not listed"} · owner ${ref.owner ?? "not listed"} · independent claims ${ref.independent?.join(", ") || "not identified"}`] : []),
        ...(ref.family?.length ? [`  related applications: ${ref.family.slice(0, 6).join(" | ")}`] : []), `  full text: ${path} (${ref.body.length} characters)`);
      const chase = (label: string, rows?: { id: string; title: string; date?: string }[]) => {
        if (rows?.length) out.push(`  ${label}: ${rows.slice(0, 8).map((r) => `${r.id}${r.date ? ` (${r.date})` : ""} ${r.title}`).join("; ")}`);
      };
      chase("similar documents", ref.similar);
      chase("cited by this one", ref.cites);
      chase("citing this one", ref.citedBy);
    } catch (e) {
      out.push(`Could not fetch ${id}: ${(e as Error).message}. It cannot be charted until its text is in references/.`);
    }
  }
  writePriorArt(packet, log);
  markDone(packet, "prior_art");

  out.push("", "PRIOR_ART.md updated.");
  if (fresh.some((r) => r.hits.length || r.papers.length || r.code.length) && !ids.length) {
    out.push("Next: pick the closest results for each mechanism and call patty_prior_art again with fetch: [publication numbers or URLs] to read them in full. Then chase: each fetched patent lists similar documents and citations, and the closest reference is often one step away from the first hit.");
  }
  if (got.length) out.push("Next: read each fetched reference (abstract and claims first, then search the description for each element), then write PRIOR_ART_CHART.md. Quotes in the chart are checked against these files.");
  return out.join("\n");
}
