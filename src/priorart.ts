import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISCLAIMER, markDone } from "./packet.ts";
import { epoConnected, githubHeaders, pqaiKey, usptoKey } from "./keys.ts";
import { fetchReference, githubSearchGap, htmlToText, listReferences, odp, ops, opsBiblio, pace, patentSource, pqai, readReference, referencesDir, saveReference, serp, serpKey, unprefix, xmlAttr, xmlElems, type Reference } from "./references.ts";

// Patents: Google Patents' own query endpoint, or SerpApi's copy of it with the user's key. The
// endpoint is not a documented API and can change or refuse requests at any time, so every
// failure is written into the file and never thrown. With the user's own keys, the USPTO Open
// Data Portal, EPO Open Patent Services and PQAI are searched too, side by side; one failing
// never stops the others. Papers: the arXiv API. Code: GitHub repository search.
const ENDPOINT = process.env.PATTY_PATENT_SEARCH_URL ?? "https://patents.google.com/xhr/query";
const PER_QUERY = 8;
const MAX_QUERIES = 8;
const MAX_MERGED = 24;
const UA = "Mozilla/5.0 (compatible; patty-mcp)";

// sources: which patent sources returned the hit. Absent in search logs written before 0.6.0.
export type Hit = { title: string; number: string; link: string; priority?: string; filed?: string; granted?: string; assignee?: string; inventor?: string; snippet?: string; sources?: string[] };
export type Other = { title: string; link: string; date?: string; note?: string };
export type SourceResult = { name: string; total?: number; count: number; error?: string };
// patentSources: one entry per patent source searched. Absent in search logs written before 0.6.0.
export type QueryResult = { query: string; at: string; total?: number; hits: Hit[]; error?: string; patentSources?: SourceResult[]; papers: Other[]; papersError?: string; code: Other[]; codeError?: string };

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

type Found = { total?: number; hits: Hit[]; error?: string };

// Turns an Open Data Portal search response (PatentDataResponse) into hits. Granted patents
// carry the patent number without a kind code; published applications their publication number.
// Exported for tests.
export function hitsFromOdp(d: any, query: string): { total?: number; hits: Hit[] } {
  const rows: any[] = Array.isArray(d?.patentFileWrapperDataBag) ? d.patentFileWrapperDataBag : [];
  const hits = rows.slice(0, PER_QUERY).map((row): Hit => {
    const m = row?.applicationMetaData ?? {};
    const pub = String(m.earliestPublicationNumber ?? "").replace(/[\s-]/g, "").toUpperCase();
    const grant = String(m.patentNumber ?? "").replace(/[\s,]/g, "").toUpperCase();
    const number = grant ? `US${grant}` : /^US\d{11}[A-Z]\d?$/.test(pub) ? pub : "";
    const app = String(row?.applicationNumberText ?? "").trim();
    const status = [m.applicationStatusDescriptionText && `USPTO status: ${strip(m.applicationStatusDescriptionText)}`, app && `application ${app}`].filter(Boolean).join("; ");
    return {
      title: strip(m.inventionTitle) || "(untitled)", number,
      link: number ? `https://patents.google.com/patent/${encodeURIComponent(number)}/en` : googlePatentsLink(query),
      filed: m.filingDate, granted: m.grantDate, assignee: strip(m.firstApplicantName) || undefined, inventor: strip(m.firstInventorName) || undefined,
      snippet: status || undefined,
    };
  });
  const total = Number(d?.count);
  return { total: Number.isFinite(total) ? total : undefined, hits };
}

// Turns an OPS bibliographic search response (ops:biblio-search, XML) into hits. Exported for tests.
export function hitsFromOps(xml: string): { total?: number; hits: Hit[] } {
  const x = unprefix(xml);
  const total = Number(xmlAttr(x.match(/<biblio-search\b([^>]*)>/)?.[1] ?? "", "total-result-count"));
  const hits = xmlElems(x, "exchange-document").slice(0, PER_QUERY).map((d): Hit => {
    const b = opsBiblio(`<exchange-document${d.attrs}>${d.body}</exchange-document>`);
    return {
      title: b.title || "(untitled)", number: b.number,
      link: `https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent(b.number)}`,
      priority: b.priority, filed: b.filed, assignee: b.applicant, snippet: b.abstract ? b.abstract.replace(/\s+/g, " ").slice(0, 260) : undefined,
    };
  }).filter((h) => h.number.length > 2);
  return { total: Number.isFinite(total) && total > 0 ? total : hits.length ? undefined : 0, hits };
}

// Turns a PQAI /search/102 response into hits. Papers ("npl") are left out. Exported for tests.
export function hitsFromPqai(d: any, query: string): { hits: Hit[] } {
  const rows: any[] = Array.isArray(d?.results) ? d.results : [];
  return {
    hits: rows.filter((r) => r && r.type !== "npl" && (r.id || r.publication_id)).slice(0, PER_QUERY).map((r): Hit => {
      const number = strip(r.id ?? r.publication_id).toUpperCase();
      return {
        title: strip(r.title) || "(untitled)", number,
        link: typeof r.www_link === "string" && /^https:\/\//.test(r.www_link) ? r.www_link : number ? `https://patents.google.com/patent/${encodeURIComponent(number)}/en` : googlePatentsLink(query),
        priority: r.priority_date ?? undefined, filed: r.filing_date ?? undefined, assignee: strip(r.owner) || undefined,
        inventor: Array.isArray(r.inventors) && r.inventors.length ? strip(r.inventors[0]) : undefined,
        snippet: strip(r.snippet ?? r.abstract).slice(0, 260) || undefined,
      };
    }),
  };
}

// One publication, however each source writes it: US9362380B2 and US9362380 are the same patent.
export const publicationKey = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^([A-Z]{2}\d+)[A-Z]\d?$/, "$1");

// Merges the hits of every source, taking each source's first hit, then each one's second, and so
// on, so no source is buried under another. A publication found by several sources is listed once,
// with every source that found it.
export function mergeHits(lists: { source: string; hits: Hit[] }[], cap = MAX_MERGED): Hit[] {
  const out: Hit[] = [];
  const seen = new Map<string, Hit>();
  const depth = Math.max(0, ...lists.map((l) => l.hits.length));
  for (let i = 0; i < depth; i++) {
    for (const l of lists) {
      const h = l.hits[i];
      if (!h) continue;
      const key = h.number ? publicationKey(h.number) : `title:${h.title.toLowerCase()}`;
      const had = seen.get(key);
      if (!had) {
        const copy = { ...h, sources: [l.source] };
        seen.set(key, copy);
        out.push(copy);
        continue;
      }
      if (!had.sources!.includes(l.source)) had.sources!.push(l.source);
      // Prefer a number with its kind code, which is what a fetch needs.
      if (h.number.length > had.number.length && publicationKey(h.number) === publicationKey(had.number)) {
        had.number = h.number;
        if (/patents\.google\.com\/patent\//.test(had.link)) had.link = h.link;
      }
      for (const f of ["priority", "filed", "granted", "assignee", "inventor", "snippet"] as const) if (!had[f] && h[f]) had[f] = h[f];
    }
  }
  return out.slice(0, cap);
}

// Each client names itself in its errors; under a per-source heading that would say it twice.
const bare = (e: unknown, name: string) => (e as Error).message.replace(new RegExp(`^${name}: `), "");

const odpQuery = (q: string, n: number) => keywords(q, n).join(" AND ");
async function searchOdp(query: string): Promise<Found> {
  try {
    // All the telling words first; if nothing matches, fewer.
    let found: Found = { hits: [] };
    for (const n of [4, 2]) {
      const params = `q=${encodeURIComponent(odpQuery(query, n))}&limit=${PER_QUERY}&fields=applicationNumberText,applicationMetaData`;
      found = hitsFromOdp(await odp(`/api/v1/patent/applications/search?${params}`), query);
      if (found.hits.length) break;
    }
    return found;
  } catch (e) {
    return { hits: [], error: bare(e, "USPTO Open Data Portal") };
  }
}

// CQL over title and abstract: ta all "w1 w2 w3" needs every word, so fewer words on a second try.
const opsQuery = (q: string, n: number) => `ta all "${keywords(q, n).join(" ")}"`;
async function searchOps(query: string): Promise<Found> {
  try {
    let found: Found = { hits: [] };
    for (const n of [5, 3]) {
      const xml = await ops(`/published-data/search/biblio?q=${encodeURIComponent(opsQuery(query, n))}`, "application/exchange+xml", { "X-OPS-Range": `1-${PER_QUERY}` });
      found = xml ? hitsFromOps(xml) : { total: 0, hits: [] };
      if (found.hits.length) break;
    }
    return found;
  } catch (e) {
    return { hits: [], error: bare(e, "EPO OPS") };
  }
}

// PQAI takes the query as written: it searches by meaning, not by keyword.
async function searchPqai(query: string): Promise<Found> {
  try {
    return hitsFromPqai(await pqai("/search/102/", { q: query, n: String(PER_QUERY), type: "patent" }), query);
  } catch (e) {
    return { hits: [], error: bare(e, "PQAI") };
  }
}

// Every connected patent source, side by side. Each source keeps its own pacing, so sources run
// in parallel while each host still sees one request at a time.
async function searchPatents(query: string): Promise<Found & { patentSources: SourceResult[] }> {
  if (offline()) return { hits: [], error: "PATTY_OFFLINE=1 is set", patentSources: [] };
  const custom = !!process.env.PATTY_PATENT_SEARCH_URL;
  const runs: { name: string; run: () => Promise<Found> }[] = [
    { name: serpKey() && !custom ? "Google Patents (SerpApi)" : "Google Patents", run: () => searchGoogle(query) },
    ...(!custom && usptoKey() ? [{ name: "USPTO ODP", run: () => searchOdp(query) }] : []),
    ...(!custom && epoConnected() ? [{ name: "EPO OPS", run: () => searchOps(query) }] : []),
    ...(!custom && pqaiKey() ? [{ name: "PQAI", run: () => searchPqai(query) }] : []),
  ];
  const results = await Promise.all(runs.map(async (s) => ({ name: s.name, found: await s.run() })));
  const patentSources = results.map((r): SourceResult => ({ name: r.name, total: r.found.total, count: r.found.hits.length, ...(r.found.error ? { error: r.found.error } : {}) }));
  const hits = mergeHits(results.map((r) => ({ source: r.name, hits: r.found.hits })));
  const failures = results.filter((r) => r.found.error);
  const error = failures.length === results.length ? (results.length === 1 ? failures[0].found.error : failures.map((r) => `${r.name}: ${r.found.error}`).join("; ")) : undefined;
  return { total: results[0].found.total, hits, ...(error ? { error } : {}), patentSources };
}

async function searchGoogle(query: string): Promise<Found> {
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
    await pace(ghUrl, githubSearchGap());
    const r = await fetch(ghUrl, { signal: AbortSignal.timeout(15000), headers: githubHeaders() });
    if (r.status === 403 || r.status === 429) return { code: [], codeError: "GitHub is rate-limiting unauthenticated search; run this query again in a minute" };
    if (!r.ok) return { code: [], codeError: `GitHub answered HTTP ${r.status}` };
    const items: any[] = ((await r.json()) as any)?.items ?? [];
    return { code: items.map((it): Other => ({ title: it.full_name, link: it.html_url, date: String(it.created_at ?? "").slice(0, 10), note: `${it.stargazers_count} stars. ${strip(it.description ?? "")}`.slice(0, 260) })) };
  } catch (e) {
    return { code: [], codeError: why(e) };
  }
}

// "Google Patents (SerpApi) 1234 reported, 8 listed; EPO OPS unavailable (...)"
function perSource(r: QueryResult): string {
  return (r.patentSources ?? []).map((s) => (s.error ? `${s.name} unavailable (${s.error})` : `${s.name} ${s.total !== undefined ? `${s.total} reported, ` : ""}${s.count} listed`)).join("; ");
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
    const several = (r.patentSources?.length ?? 0) > 1;
    if (r.error) L.push(`Search unavailable: ${r.error}. Nothing was found or ruled out. Run it yourself: ${googlePatentsLink(r.query)}`, "");
    else {
      for (const s of r.patentSources ?? []) if (s.error) L.push(`Search unavailable from ${s.name}: ${s.error}. Nothing was found or ruled out there.`, "");
      if (several) L.push(`Per source: ${perSource(r)}.`, "");
      if (!r.hits.length) L.push(`No results. Try broader wording: ${googlePatentsLink(r.query)}`, "");
      else {
        L.push(several ? `${r.hits.length} publications, each listed once with every source that found it:` : `${r.total !== undefined ? `${r.total} results reported; ` : ""}the first ${r.hits.length}:`, "");
        r.hits.forEach((h, n) => {
          const meta = [h.number, h.priority && `priority ${h.priority}`, h.filed && `filed ${h.filed}`, h.granted && `granted ${h.granted}`, h.assignee, h.sources?.length && `from ${h.sources.join(", ")}`].filter(Boolean).join(" · ");
          L.push(`${n + 1}. [${h.title.replace(/[\[\]]/g, "")}](${h.link})`, `   ${meta}`);
          if (h.snippet) L.push(`   ${h.snippet}`);
        });
        L.push("", `All results: ${googlePatentsLink(r.query)}`, "");
      }
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
    const partly = fresh.filter((r) => !r.error && r.patentSources?.some((s) => s.error)).length;
    out.push(`Searched ${fresh.length} quer${fresh.length === 1 ? "y" : "ies"}; patent search unavailable for ${failed}${partly ? `; one or more patent sources unavailable for ${partly} more` : ""}.`, "");
    for (const r of fresh) {
      out.push(`Query: "${r.query}"`);
      if (r.error) out.push(`  patents: search unavailable (${r.error}). The packet is not blocked.`);
      else {
        out.push(r.patentSources && r.patentSources.length > 1 ? `  patents: ${perSource(r)}` : `  patents: ${r.total ?? "?"} reported`);
        for (const h of r.hits) out.push(`    ${h.number} · ${h.priority ?? "no priority date"} · ${h.title}${h.sources?.length ? ` · ${h.sources.join(", ")}` : ""}`);
      }
      if (r.papersError !== "skipped") out.push(r.papersError ? `  papers: unavailable (${r.papersError})` : `  papers: ${r.papers.length}`, ...r.papers.map((o) => `    ${o.link} · ${o.date} · ${o.title}`));
      if (r.codeError !== "skipped") out.push(r.codeError ? `  code: unavailable (${r.codeError})` : `  code: ${r.code.length}`, ...r.code.map((o) => `    ${o.link} · ${o.note}`));
    }
    out.push("");
    if (failed || partly) out.push("A failed search rules nothing out. Tell the human the search did not run and carry on with the packet.", "");
  }

  const got: Reference[] = [];
  for (const id of ids) {
    try {
      const ref = await fetchReference(id);
      const path = saveReference(packet, ref);
      got.push(ref);
      out.push(`Fetched ${ref.slug} · ${ref.kind} · ${ref.date ?? "no date"} (${ref.dateLabel ?? ""}) · ${ref.title}${ref.via ? ` · via ${ref.via}` : ""}`,
        ...(ref.kind === "patent" ? [`  status ${ref.status ?? "not listed"} · expiration ${ref.expiration ?? "not listed"} · owner ${ref.owner ?? "not listed"} · independent claims ${ref.independent?.join(", ") || "not identified"}`] : []),
        ...(ref.usptoStatus ? [`  USPTO status (official): ${ref.usptoStatus}`] : ref.usptoNote ? [`  USPTO status: ${ref.usptoNote}`] : []),
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
