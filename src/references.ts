import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { epoConnected, epoKey, epoSecret, githubHeaders, githubToken, pqaiKey, serpKey, usptoKey } from "./keys.ts";
export { serpKey } from "./keys.ts";
import { today, VERSION } from "./packet.ts";

// Full text of prior art references, kept in the packet so quotes can be checked against it.
// Patents come from their Google Patents page (unofficial, public), or SerpApi's copy of it;
// EP and WO publications from EPO Open Patent Services when the user has connected it. A US
// patent's official status comes from the USPTO Open Data Portal when the user has a key.
// Papers come from the arXiv API, repositories from the GitHub API, anything else from the page.

const UA = `Mozilla/5.0 (compatible; patty-mcp/${VERSION})`;
const BODY_END = "\n## Related documents";

export type Related = { id: string; title: string; date?: string };
export type Reference = {
  slug: string; kind: "patent" | "paper" | "code" | "page"; title: string; source: string;
  date?: string; dateLabel?: string; body: string; cites?: Related[]; citedBy?: Related[]; similar?: Related[];
  status?: string; expiration?: string; owner?: string; independent?: number[]; family?: string[]; via?: string;
  // Where the Status value came from; Google Patents unless said otherwise.
  statusFrom?: string;
  // A US application number as the source gives it, e.g. US14/104,993.
  applicationNumber?: string;
  // The USPTO's own status for the application, and when that lookup did not work, why.
  usptoStatus?: string; usptoNote?: string;
};

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "...", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|claim|heading|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Each source gets its requests one at a time with a gap between them. Sent faster, Google
// Patents answers 503, arXiv 429 (it asks for one request every three seconds) and GitHub's
// unauthenticated search stops after about ten a minute.
// EPO OPS allows about 20 searches a minute while it is not busy (its X-Throttling-Control header);
// the USPTO and PQAI publish no figure that could be read, so they get a modest gap.
const GAP: Record<string, number> = { "patents.google.com": 2500, "export.arxiv.org": 3200, "api.github.com": 2200, "ops.epo.org": 3100, "api.uspto.gov": 1100, "api.projectpq.ai": 1000 };
export const githubSearchGap = () => (githubToken() ? 2200 : 6500);
const queue = new Map<string, Promise<void>>();
export function pace(url: string, gap?: number): Promise<void> {
  const host = new URL(url).hostname;
  const wait = gap ?? GAP[host] ?? 300;
  const prev = queue.get(host) ?? Promise.resolve();
  const turn = prev.then(() => undefined);
  queue.set(host, turn.then(() => new Promise<void>((res) => setTimeout(res, wait))));
  return turn;
}

async function get(url: string, accept = "text/html,*/*", ms = 25000): Promise<string> {
  if (process.env.PATTY_OFFLINE === "1") throw new Error("PATTY_OFFLINE=1 is set");
  // A busy or rate-limiting server gets two more tries, a little later each time.
  for (let attempt = 0; ; attempt++) {
    await pace(url);
    const headers = new URL(url).hostname === "api.github.com" ? githubHeaders(accept) : { "User-Agent": UA, Accept: accept };
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow", headers });
    if (r.ok) return r.text();
    if (![429, 502, 503].includes(r.status) || attempt >= 2) throw new Error(`HTTP ${r.status}${r.status === 429 || r.status === 503 ? " (the source is busy or rate-limiting; try this one again in a minute)" : ""}`);
    await new Promise((res) => setTimeout(res, 6000 * (attempt + 1)));
  }
}

export const patentNumber = (s: string): string | null => {
  const t = s.trim().toUpperCase().replace(/[\s,./-]/g, "");
  return /^[A-Z]{2}\d{5,}[A-Z]?\d?$/.test(t) ? t : null;
};

// ---------- keyed patent source ----------
// SerpApi serves Google Patents search and patent details through an account key, without the
// throttling the direct pages apply. The key is the user's own: PATTY_SERPAPI_KEY, or the
// first line of ~/.patty/serpapi_key. It is never written to a packet, a log or an error.
// Every patent source in use, in the order results are merged.
export function patentSources(): string[] {
  return [
    serpKey() ? "Google Patents through SerpApi (your key)" : "Google Patents directly (no key; it refuses requests after a burst)",
    ...(usptoKey() ? ["USPTO Open Data Portal (your key)"] : []),
    ...(epoConnected() ? ["EPO Open Patent Services (your key)"] : []),
    ...(pqaiKey() ? ["PQAI (your key)"] : []),
  ];
}
export const patentSource = () => patentSources().join("; ");

// A secret must never reach a message, even if a server echoes it back.
export function scrub(text: string, ...secrets: (string | null)[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join("[key]");
  return t;
}
const failed = (e: unknown) => ((e as Error).name === "TimeoutError" ? "timed out" : "network error");

export async function serp(params: Record<string, string>): Promise<any> {
  const key = serpKey();
  if (!key) throw new Error("no SerpApi key is set");
  const url = `https://serpapi.com/search.json?${new URLSearchParams({ ...params, api_key: key })}`;
  await pace(url, 400);
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(40000), headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error(`SerpApi did not answer (${(e as Error).name === "TimeoutError" ? "timed out" : "network error"})`);
  }
  const data = (await r.json().catch(() => null)) as any;
  if (!r.ok || !data || data.error) throw new Error(`SerpApi: ${String(data?.error ?? `HTTP ${r.status}`).slice(0, 160)}`);
  return data;
}

// ---------- USPTO Open Data Portal ----------
// Official USPTO application data (the Patent File Wrapper API), from the OpenAPI file at
// data.uspto.gov/swagger/swagger.yaml. The key goes in the X-API-KEY header to api.uspto.gov
// and nowhere else. A 404 is the documented answer for "no matching records".
const ODP = "https://api.uspto.gov";
export async function odp(path: string): Promise<any> {
  const key = usptoKey();
  if (!key) throw new Error("no USPTO Open Data Portal key is set");
  const url = `${ODP}${path}`;
  await pace(url);
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "X-API-KEY": key, Accept: "application/json" } });
  } catch (e) {
    throw new Error(`the USPTO Open Data Portal did not answer (${failed(e)})`);
  }
  if (r.status === 404) return { count: 0, patentFileWrapperDataBag: [] };
  const data = (await r.json().catch(() => null)) as any;
  if (r.ok && data) return data;
  const why = r.status === 401 || r.status === 403 ? " (the key was refused; the portal deactivates keys whose USPTO.gov profile is incomplete)" : r.status === 429 ? " (rate-limiting; try again in a minute)" : "";
  const detail = data?.errorDetails ?? data?.message ?? data?.error;
  throw new Error(scrub(`USPTO Open Data Portal: HTTP ${r.status}${why}${detail ? `: ${String(detail).slice(0, 160)}` : ""}`, key));
}

// "US14/104,993" or "US:14/104,993" -> "14104993". Only US application numbers.
export function usptoApplicationNumber(raw: string | undefined): string | null {
  const m = String(raw ?? "").trim().toUpperCase().match(/^US:?\s*(\d{2})\s*\/\s*([\d,]{3,9})$/);
  return m ? m[1] + m[2].replace(/,/g, "") : null;
}

// Turns an Open Data Portal application response (PatentDataResponse) into one status line.
// Exported for tests.
export function usptoStatusFromOdp(d: any): string | null {
  const row = (Array.isArray(d?.patentFileWrapperDataBag) ? d.patentFileWrapperDataBag : [])[0];
  const m = row?.applicationMetaData;
  if (!m?.applicationStatusDescriptionText) return null;
  const parts = [
    m.applicationStatusDate && `status date ${m.applicationStatusDate}`,
    row.applicationNumberText && `application ${row.applicationNumberText}`,
    m.patentNumber && `patent ${m.patentNumber}${m.grantDate ? ` granted ${m.grantDate}` : ""}`,
  ].filter(Boolean);
  return `${String(m.applicationStatusDescriptionText).trim()}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

// Adds the USPTO's own status to a US patent reference. Never fails the fetch.
async function addUsptoStatus(ref: Reference): Promise<void> {
  if (ref.kind !== "patent" || !/^US/.test(ref.slug) || !usptoKey()) return;
  const app = usptoApplicationNumber(ref.applicationNumber);
  const grant = ref.slug.match(/^US(\d{5,8})[BES]\d?$/)?.[1];
  if (!app && !grant) {
    ref.usptoNote = "not checked: no US application number was found for it";
    return;
  }
  try {
    const d = app
      ? await odp(`/api/v1/patent/applications/${app}/meta-data`)
      : await odp(`/api/v1/patent/applications/search?${new URLSearchParams({ q: `applicationMetaData.patentNumber:${grant}`, limit: "1" })}`);
    const s = usptoStatusFromOdp(d);
    if (s) ref.usptoStatus = s;
    else ref.usptoNote = `not checked: the Open Data Portal has no record for ${app ? `application ${app}` : `patent ${grant}`}`;
  } catch (e) {
    ref.usptoNote = `not checked: ${(e as Error).message}`;
  }
}

// ---------- EPO Open Patent Services ----------
// From the OPS v3.2 reference guide (version 1.3.20) and its OpenAPI file. The consumer key and
// secret are exchanged for a bearer token (OAuth client credentials) at the auth endpoint; the
// token lasts about twenty minutes and is kept in memory only. OPS answers in XML.
const OPS = "https://ops.epo.org/3.2";
let opsToken: { value: string; until: number; for: string } | null = null;
// Queries start together; they share one sign-in request instead of each making its own.
let opsSignIn: Promise<string> | null = null;
function opsAccessToken(renew = false): Promise<string> {
  const key = epoKey();
  if (!renew && opsToken && opsToken.for === key && Date.now() < opsToken.until) return Promise.resolve(opsToken.value);
  if (!opsSignIn) opsSignIn = opsRequestToken().finally(() => (opsSignIn = null));
  return opsSignIn;
}
async function opsRequestToken(): Promise<string> {
  const key = epoKey(), secret = epoSecret();
  if (!key || !secret) throw new Error("no EPO OPS key and secret are set");
  let r: Response;
  try {
    r = await fetch(`${OPS}/auth/accesstoken`, {
      method: "POST", signal: AbortSignal.timeout(20000), body: "grant_type=client_credentials",
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    });
  } catch (e) {
    throw new Error(`EPO OPS did not answer the sign-in request (${failed(e)})`);
  }
  const text = await r.text();
  let d: any = null;
  try {
    d = JSON.parse(text);
  } catch {}
  if (!r.ok || !d?.access_token) {
    const msg = opsMessage(text) || d?.error_description || d?.error;
    throw new Error(scrub(`EPO OPS refused the key and secret (HTTP ${r.status}${msg ? `: ${String(msg).slice(0, 100)}` : ""})`, key, secret));
  }
  opsToken = { value: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 1199) * 1000 - 60000, for: key };
  return opsToken.value;
}
const opsMessage = (xml: string) => xml.match(/<(?:\w+:)?message>([\s\S]*?)<\/(?:\w+:)?message>/)?.[1]?.trim() ?? "";

// One OPS request. Returns the body, or null for a 404 (OPS's answer for "nothing found").
export async function ops(path: string, accept: string, headers: Record<string, string> = {}): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const token = await opsAccessToken(attempt > 0);
    const url = `${OPS}/rest-services${path}`;
    await pace(url);
    let r: Response;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(40000), headers: { Authorization: `Bearer ${token}`, Accept: accept, ...headers } });
    } catch (e) {
      throw new Error(`EPO OPS did not answer (${failed(e)})`);
    }
    const text = await r.text();
    if (r.ok) return text;
    if (r.status === 404) return null;
    // An expired token is answered with invalid_access_token; get a new one once.
    if (attempt === 0 && (r.status === 400 || r.status === 401) && /invalid_access_token|expired/i.test(text)) continue;
    const quota = r.headers.get("X-Rejection-Reason");
    const msg = opsMessage(text);
    throw new Error(scrub(`EPO OPS: HTTP ${r.status}${msg ? ` (${msg.slice(0, 140)})` : ""}${quota ? `; quota reached: ${quota}` : ""}`, epoKey(), epoSecret(), token));
  }
}

// OPS XML carries namespace prefixes (ops:, ftxt:); they are dropped before reading it.
export const unprefix = (xml: string) => xml.replace(/<(\/?)[\w-]+:(?=[\w-])/g, "<$1");
type Elem = { attrs: string; body: string };
export const xmlElems = (xml: string, tag: string): Elem[] =>
  [...xml.matchAll(new RegExp(`<${tag}(?=[\\s>/])([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "g"))].map((m) => ({ attrs: m[1], body: m[2] ?? "" }));
export const xmlAttr = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const inEnglish = (list: Elem[]) => list.find((e) => xmlAttr(e.attrs, "lang")?.toLowerCase() === "en") ?? list[0];
const isoDate = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d || undefined);
const textOf = (xml?: string) => htmlToText(xml ?? "").replace(/\s*\n\s*/g, "\n").trim();

// The fields Patty uses from one OPS exchange-document. Exported for the search parser.
export function opsBiblio(docXml: string) {
  const x = unprefix(docXml);
  const head = x.match(/<exchange-document\b([^>]*)>/)?.[1] ?? "";
  const pub = xmlElems(xmlElems(x, "publication-reference")[0]?.body ?? "", "document-id");
  const docdb = pub.find((d) => xmlAttr(d.attrs, "document-id-type") === "docdb")?.body ?? "";
  const pick = (body: string, tag: string) => textOf(xmlElems(body, tag)[0]?.body);
  const country = xmlAttr(head, "country") ?? pick(docdb, "country");
  const number = `${country}${xmlAttr(head, "doc-number") ?? pick(docdb, "doc-number")}${xmlAttr(head, "kind") ?? pick(docdb, "kind")}`;
  const priorities = xmlElems(x, "priority-claim").map((p) => pick(p.body, "date")).filter((d) => /^\d{8}$/.test(d)).sort();
  const appDate = pick(xmlElems(x, "application-reference")[0]?.body ?? "", "date");
  const applicants = xmlElems(x, "applicant");
  const applicant = applicants.find((a) => xmlAttr(a.attrs, "data-format") === "original") ?? applicants[0];
  return {
    number, title: textOf(inEnglish(xmlElems(x, "invention-title"))?.body), abstract: textOf(inEnglish(xmlElems(x, "abstract"))?.body),
    published: isoDate(pick(docdb, "date")), priority: isoDate(priorities[0]), filed: isoDate(appDate),
    applicant: applicant ? pick(applicant.body, "name").replace(/\s*\[[A-Z]{2}\]$/, "") || undefined : undefined,
  };
}

// Claims come as <claim num="0001"><claim-text>...</claim-text></claim>, or, in the text-only
// format, as one block with the numbers inside the text. Both are split into numbered claims.
export function claimsFromOps(xml: string): { n: number; text: string }[] {
  const x = unprefix(xml);
  const set = inEnglish(xmlElems(x, "claims"));
  if (!set) return [];
  const items = xmlElems(set.body, "claim").map((c, i) => ({ n: Number(xmlAttr(c.attrs, "num")) || i + 1, text: textOf(c.body).replace(/\s*\n\s*/g, " ") }));
  if (items.length !== 1 || !/(^|\s)2\s?\.\s/.test(items[0].text)) return items.filter((c) => c.text).map((c) => ({ n: c.n, text: c.text.replace(/^\d+\s?\.\s*/, "") }));
  const all = items[0].text;
  const out: { n: number; text: string }[] = [];
  let from = 0;
  for (let n = 1; ; n++) {
    const next = all.slice(from).search(new RegExp(`(^|\\s)${n + 1}\\s?\\.\\s`));
    const piece = next < 0 ? all.slice(from) : all.slice(from, from + next);
    out.push({ n, text: piece.trim().replace(new RegExp(`^${n}\\s?\\.\\s*`), "") });
    if (next < 0) break;
    from += next;
  }
  return out.filter((c) => c.text);
}

export function descriptionFromOps(xml: string): string {
  const d = inEnglish(xmlElems(unprefix(xml), "description"));
  return d ? textOf(d.body) : "";
}

// Turns OPS biblio, claims and description responses into a stored reference. Exported for tests.
export function referenceFromOps(id: string, biblioXml: string, claimsXml: string, descriptionXml: string): Reference {
  const doc = xmlElems(unprefix(biblioXml), "exchange-document")[0];
  const b = opsBiblio(doc ? `<exchange-document${doc.attrs}>${doc.body}</exchange-document>` : biblioXml);
  const independent: number[] = [];
  const claimBlocks = claimsFromOps(claimsXml).map((c) => {
    const text = `${c.n}. ${c.text}`;
    const dep = isDependent(text);
    if (!dep) independent.push(c.n);
    return `### Claim ${c.n} (${dep ? "dependent" : "independent"})\n${text}`;
  });
  const description = descriptionFromOps(descriptionXml);
  const body = [`## Abstract\n${b.abstract}`, `## Claims\n${claimBlocks.join("\n\n")}`, `## Description\n${description || "Not retrieved. Read it at the source before relying on a \"no\"."}`].join("\n\n");
  return {
    slug: id, kind: "patent", title: b.title || id, source: `https://worldwide.espacenet.com/patent/search?q=pn%3D${id}`,
    date: b.priority ?? b.filed, dateLabel: b.priority ? "priority date" : "filing date", body, owner: b.applicant, independent,
    via: "EPO Open Patent Services", statusFrom: "EPO OPS",
  };
}

// EP and WO publication numbers in the epodoc form OPS takes: EP1000000.A1, WO2019123456.A1.
export const opsNumber = (id: string) => {
  const m = id.match(/^(EP|WO)(\d{6,})([A-Z]\d?)?$/);
  return m ? `${m[1]}${m[2]}${m[3] ? `.${m[3]}` : ""}` : null;
};

async function fetchPatentOps(id: string): Promise<Reference> {
  const base = `/published-data/publication/epodoc/${opsNumber(id)}`;
  const biblio = await ops(`${base}/biblio`, "application/exchange+xml");
  if (!biblio) throw new Error("EPO OPS has no record of this publication number");
  const claims = (await ops(`${base}/claims`, "application/fulltext+xml")) ?? "";
  const description = (await ops(`${base}/description`, "application/fulltext+xml")) ?? "";
  const ref = referenceFromOps(id, biblio, claims, description);
  if (!ref.body.includes("### Claim")) throw new Error("EPO OPS returned no claims for this publication");
  return ref;
}

// ---------- PQAI ----------
// Semantic search over patents, from the API guide at api.projectpq.ai/docs. The token is a
// query parameter, so a failed request is reported without its address.
export async function pqai(route: string, params: Record<string, string>): Promise<any> {
  const key = pqaiKey();
  if (!key) throw new Error("no PQAI token is set");
  const url = `https://api.projectpq.ai${route}?${new URLSearchParams({ ...params, token: key })}`;
  await pace(url);
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(40000), headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error(`PQAI did not answer (${failed(e)})`);
  }
  const text = await r.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (r.ok && data) return data;
  const msg = typeof data === "string" ? data : data?.message ?? data?.error ?? data?.detail;
  throw new Error(scrub(`PQAI: HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (the token was refused)" : ""}${msg ? `: ${String(msg).slice(0, 140)}` : ""}`, key));
}

const isDependent = (text: string) => /^\d+\.\s.{0,140}\b(?:of|in|to|by|as claimed in|as recited in|according to)\s+(?:any\s+(?:one\s+)?of\s+)?claims?\s+\d+/i.test(text);

// Turns a SerpApi patent-details response into a stored reference. Exported for tests.
export function referenceFromSerp(id: string, d: any, descriptionHtml: string): Reference {
  const independent: number[] = [];
  const claimBlocks = (Array.isArray(d.claims) ? d.claims : []).map((raw: unknown, i: number) => {
    const text = String(raw).replace(/\s*\n\s*/g, " ").trim();
    const n = Number(text.match(/^(\d+)\./)?.[1] ?? i + 1);
    const dep = isDependent(text);
    if (!dep) independent.push(n);
    return `### Claim ${n} (${dep ? "dependent" : "independent"})\n${text}`;
  });
  const apps: any[] = Object.values(d.worldwide_applications ?? {}).flat();
  const mine = apps.find((a) => a?.this_app);
  const events: any[] = Array.isArray(d.events) ? d.events : [];
  const expiry = events.find((e) => /expiration/i.test(String(e?.title ?? "")))?.date;
  const rel = (rows: any[] | undefined): Related[] => (rows ?? []).filter((r) => r?.publication_number).map((r) => ({ id: String(r.publication_number), title: String(r.title ?? ""), date: r.priority_date ?? r.publication_date }));
  const family = [
    ...(d.child_applications ?? []).map((c: any) => `${c.relation_type ?? "Child"} of this one: ${c.representative_publication ?? c.application_number} (filed ${c.filing_date ?? "?"}) ${c.title ?? ""}`),
    ...apps.filter((a) => !a?.this_app && a?.country_code === "US" && a?.document_id).map((a) => `Same family: ${String(a.document_id).replace(/^patent\/|\/en$/g, "")} · ${a.legal_status ?? "status not listed"}`),
  ];
  const description = htmlToText(descriptionHtml);
  const body = [`## Abstract\n${String(d.abstract ?? "").trim()}`, `## Claims\n${claimBlocks.join("\n\n")}`, `## Description\n${description || "Not retrieved. Read it at the source before relying on a \"no\"."}`].join("\n\n");
  return {
    slug: id, kind: "patent", title: String(d.title ?? id).trim(), source: `https://patents.google.com/patent/${id}/en`,
    date: d.priority_date ?? d.filing_date, dateLabel: d.priority_date ? "priority date" : "filing date", body,
    cites: rel(d.patent_citations?.original), citedBy: rel(d.cited_by?.original), similar: rel((d.similar_documents ?? []).filter((x: any) => x?.is_patent !== false)),
    status: mine?.legal_status, expiration: expiry, owner: Array.isArray(d.assignees) ? d.assignees[0] : undefined, independent, family, via: "SerpApi",
    applicationNumber: d.application_number ?? mine?.application_number,
  };
}

async function fetchPatentKeyed(id: string): Promise<Reference> {
  const d = await serp({ engine: "google_patents_details", patent_id: `patent/${id}/en` });
  let html = "";
  if (typeof d.description_link === "string" && d.description_link.startsWith("https://serpapi.com/")) {
    for (const u of [d.description_link, `${d.description_link}?api_key=${encodeURIComponent(serpKey()!)}`]) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
        if (r.ok) {
          html = await r.text();
          break;
        }
      } catch {}
    }
  }
  const ref = referenceFromSerp(id, d, html);
  if (!ref.body.includes("### Claim")) throw new Error("SerpApi returned no claims for this patent");
  return ref;
}

// EP and WO publications are read from EPO OPS first when it is connected: it is the EPO's own
// full text. OPS has no US full text, so US patents never go there.
async function fetchPatent(id: string): Promise<Reference> {
  let ref: Reference;
  if (epoConnected() && opsNumber(id)) {
    try {
      ref = await fetchPatentOps(id);
    } catch (e) {
      try {
        ref = await fetchPatentGoogle(id);
      } catch (e2) {
        throw new Error(`EPO OPS: ${(e as Error).message}; and Google Patents: ${(e2 as Error).message}`);
      }
      ref.via = `${ref.via ?? "the Google Patents page"}, because EPO OPS failed (${(e as Error).message})`;
    }
  } else ref = await fetchPatentGoogle(id);
  await addUsptoStatus(ref);
  return ref;
}

async function fetchPatentGoogle(id: string): Promise<Reference> {
  if (serpKey()) {
    try {
      return await fetchPatentKeyed(id);
    } catch (e) {
      // Fall through to the direct page; if that fails too, report both.
      try {
        const ref = await fetchPatentDirect(id);
        ref.via = `the direct page, because the keyed source failed (${(e as Error).message})`;
        return ref;
      } catch (e2) {
        throw new Error(`${(e as Error).message}; and the direct page: ${(e2 as Error).message}`);
      }
    }
  }
  return fetchPatentDirect(id);
}

async function fetchPatentDirect(id: string): Promise<Reference> {
  const source = `https://patents.google.com/patent/${id}/en`;
  const html = await get(source);
  const section = (name: string) => htmlToText(html.match(new RegExp(`<section itemprop="${name}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "");
  const title = htmlToText(html.match(/<meta name="DC.title" content="([^"]*)"/)?.[1] ?? "").trim() || id;
  const priority = html.match(/<time itemprop="priorityDate"[^>]*>([^<]*)/)?.[1];
  const filing = html.match(/<time itemprop="filingDate"[^>]*>([^<]*)/)?.[1];
  const rows = (prop: string): Related[] =>
    [...html.matchAll(new RegExp(`<tr itemprop="${prop}"[^>]*>([\\s\\S]*?)</tr>`, "g"))].map((m) => ({
      id: (m[1].match(/itemprop="publicationNumber">([^<]*)/)?.[1] ?? "").trim(),
      title: htmlToText(m[1].match(/itemprop="title">([^<]*)/)?.[1] ?? ""),
      date: m[1].match(/itemprop="priorityDate">([^<]*)/)?.[1],
    })).filter((r) => r.id);
  const abstract = section("abstract"), description = section("description");
  // Each claim is kept apart and marked independent or dependent, so a claim chart can be checked claim by claim.
  const claimsHtml = html.match(/<section itemprop="claims"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
  const starts = [...claimsHtml.matchAll(/<div[^>]*\bid="CLM-\d+"[^>]*\bnum="0*(\d+)"[^>]*>/g)];
  const independent: number[] = [];
  const claimBlocks = starts.map((m, i) => {
    const n = Number(m[1]);
    const text = htmlToText(claimsHtml.slice(m.index!, starts[i + 1]?.index ?? claimsHtml.length)).replace(/\s*\n\s*/g, " ").trim();
    const before = claimsHtml.slice(Math.max(0, m.index! - 80), m.index!);
    const dependent = /claim-dependent/.test(before) || /^\d+\.\s.{0,140}\b(?:of|in|to|by)\s+(?:any\s+(?:one\s+)?of\s+)?claims?\s+\d+/i.test(text);
    if (!dependent) independent.push(n);
    return `### Claim ${n} (${dependent ? "dependent" : "independent"})\n${text}`;
  });
  const claims = claimBlocks.length ? claimBlocks.join("\n\n") : section("claims").replace(/^Claims\s*\(\d+\)\s*/i, "");
  if (!abstract && !claims && !description) throw new Error("the page had no abstract, claims or description");
  const body = [`## Abstract\n${abstract}`, `## Claims\n${claims}`, `## Description\n${description.replace(/^Description\s*/i, "")}`].join("\n\n");
  const prop = (name: string) => htmlToText(html.match(new RegExp(`itemprop="${name}"[^>]*>([^<]*)`))?.[1] ?? "").trim() || undefined;
  return {
    slug: id, kind: "patent", title, source, date: priority ?? filing, dateLabel: priority ? "priority date" : "filing date", body,
    cites: rows("backwardReferencesOrig"), citedBy: rows("forwardReferencesOrig"), similar: rows("similarDocuments"),
    status: prop("status") ?? prop("ifiStatus"), expiration: html.match(/<time itemprop="expiration"[^>]*>([^<]*)/)?.[1] ?? prop("expiration"), owner: prop("assigneeCurrent") ?? prop("assigneeOriginal"), independent,
    applicationNumber: html.match(/<meta name="citation_patent_application_number" content="([^"]*)"/)?.[1],
  };
}

async function fetchArxiv(id: string): Promise<Reference> {
  const xml = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, "application/atom+xml");
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) throw new Error("arXiv has no such paper");
  const pick = (tag: string) => htmlToText(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "");
  return { slug: `arxiv-${id.replace(/[^\w.]/g, "-")}`, kind: "paper", title: pick("title"), source: `https://arxiv.org/abs/${id}`, date: pick("published").slice(0, 10), dateLabel: "first posted", body: `## Abstract\n${pick("summary")}\n\nOnly the abstract is stored. Read the full paper at the source before relying on a "no".` };
}

async function fetchGithub(owner: string, repo: string): Promise<Reference> {
  const meta = JSON.parse(await get(`https://api.github.com/repos/${owner}/${repo}`, "application/vnd.github+json"));
  let readme = "";
  try {
    readme = await get(`https://api.github.com/repos/${owner}/${repo}/readme`, "application/vnd.github.raw");
  } catch {}
  return { slug: `github-${owner}-${repo}`.replace(/[^\w.-]/g, "-").slice(0, 70), kind: "code", title: `${meta.full_name}: ${meta.description ?? ""}`.trim(), source: meta.html_url, date: String(meta.created_at ?? "").slice(0, 10), dateLabel: "repository created", body: `## Description\n${meta.description ?? ""}\n\n## README\n${readme.slice(0, 200000)}\n\nOnly the README is stored, not the code.` };
}

async function fetchPage(url: string): Promise<Reference> {
  const u = new URL(url);
  const html = await get(url);
  const title = htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || u.hostname;
  const text = htmlToText(html);
  if (text.length < 200) throw new Error("the page had almost no text (it may need a browser to render)");
  const slug = (u.hostname.replace(/^www\./, "") + u.pathname).replace(/[^\w.]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
  return { slug, kind: "page", title, source: url, body: `## Page text\n${text.slice(0, 400000)}` };
}

export async function fetchReference(idOrUrl: string): Promise<Reference> {
  const s = idOrUrl.trim();
  const pn = patentNumber(s) ?? patentNumber(s.match(/patents\.google\.com\/patent\/([A-Za-z0-9]+)/)?.[1] ?? "");
  if (pn) return fetchPatent(pn);
  const ax = s.match(/arxiv\.org\/(?:abs|pdf|html)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?$/i)?.[1] ?? s.match(/^arxiv[:-]([\w.\/-]+)$/i)?.[1];
  if (ax) return fetchArxiv(ax);
  const gh = s.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (gh) return fetchGithub(gh[1], gh[2]);
  if (/^https?:\/\//.test(s)) return fetchPage(s);
  throw new Error(`"${s}" is not a patent publication number (like US10013501B2) or a URL`);
}

const list = (label: string, rows?: Related[]) => (rows?.length ? [`### ${label}`, ...rows.slice(0, 40).map((r) => `- ${r.id}${r.date ? ` (${r.date})` : ""} ${r.title}`), ""] : []);

export function referencesDir(packet: string) {
  return join(packet, "references");
}

export function saveReference(packet: string, ref: Reference): string {
  const dir = referencesDir(packet);
  mkdirSync(dir, { recursive: true });
  const text = [
    `Reference: ${ref.slug}`,
    `Title: ${ref.title}`,
    `Kind: ${ref.kind}`,
    `Source: ${ref.source}`,
    `Date: ${ref.date ? `${ref.date} (${ref.dateLabel}, as the source lists it)` : "not known"}`,
    `Fetched: ${today()}`,
    ...(ref.kind === "patent"
      ? [
          ref.statusFrom === "EPO OPS"
            ? `Status: ${ref.status ?? "not listed"} (EPO OPS bibliographic data carries no legal status; confirm in the European Patent Register or the national register before relying on it)`
            : `Status: ${ref.status ?? "not listed"} (as Google Patents lists it; confirm in USPTO Patent Center before relying on it)`,
          ...(ref.applicationNumber ? [`Application number: ${ref.applicationNumber}`] : []),
          ...(ref.usptoStatus ? [`USPTO status (official, checked ${today()}): ${ref.usptoStatus}`] : ref.usptoNote ? [`USPTO status: ${ref.usptoNote}`] : []),
          `Expiration: ${ref.expiration ?? "not listed"}`,
          `Owner: ${ref.owner ?? "not listed"}`,
          `Independent claims: ${ref.independent?.length ? ref.independent.join(", ") : "not identified"}`,
          ...(ref.family?.length ? [`Related applications: ${ref.family.join(" | ")}`] : []),
        ]
      : []),
    "",
    ref.body,
    BODY_END,
    "",
    ...list("Cited by this document", ref.cites),
    ...list("Documents citing this one", ref.citedBy),
    ...list("Similar documents (as the source lists them)", ref.similar),
  ].join("\n");
  const path = join(dir, `${ref.slug}.txt`);
  writeFileSync(path, text);
  return path;
}

export type StoredReference = { slug: string; title: string; source: string; date: string; kind: string; body: string; status: string; usptoStatus: string; expiration: string; owner: string; independent: number[]; claims: Map<number, string> };
export function readReference(packet: string, slug: string): StoredReference | null {
  const path = join(referencesDir(packet), `${slug}.txt`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const head = (k: string) => text.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1] ?? "";
  const start = text.indexOf("\n\n");
  const end = text.indexOf(BODY_END);
  const body = text.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
  const claims = new Map<number, string>();
  const claimSection = body.slice(body.indexOf("\n## Claims"), body.indexOf("\n## Description") < 0 ? undefined : body.indexOf("\n## Description"));
  for (const m of claimSection.matchAll(/### Claim (\d+) \((?:in)?dependent\)\n([\s\S]*?)(?=\n### Claim \d+ |$)/g)) claims.set(Number(m[1]), m[2].trim());
  return {
    slug, title: head("Title"), source: head("Source"), date: head("Date"), kind: head("Kind"), body,
    status: head("Status"), usptoStatus: head("USPTO status \\(official, checked [\\d-]+\\)"), expiration: head("Expiration"), owner: head("Owner"),
    independent: [...head("Independent claims").matchAll(/\d+/g)].map((m) => Number(m[0])), claims,
  };
}
export function listReferences(packet: string): string[] {
  const dir = referencesDir(packet);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)).sort();
}

// Quotes are compared after flattening case, whitespace, quote marks and dashes; nothing else is forgiven.
export const flatten = (s: string) =>
  s.toLowerCase().replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[‐-―−]/g, "-").replace(/­/g, "").replace(/\s+/g, " ").trim();
