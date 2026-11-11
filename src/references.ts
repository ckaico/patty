import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { today, VERSION } from "./packet.ts";

// Full text of prior art references, kept in the packet so quotes can be checked against it.
// Patents come from their Google Patents page (unofficial, public); papers from the arXiv API;
// repositories from the GitHub API; anything else from the page itself.

const UA = `Mozilla/5.0 (compatible; patty-mcp/${VERSION})`;
const BODY_END = "\n## Related documents";

export type Related = { id: string; title: string; date?: string };
export type Reference = {
  slug: string; kind: "patent" | "paper" | "code" | "page"; title: string; source: string;
  date?: string; dateLabel?: string; body: string; cites?: Related[]; citedBy?: Related[]; similar?: Related[];
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

async function get(url: string, accept = "text/html,*/*", ms = 25000): Promise<string> {
  if (process.env.PATTY_OFFLINE === "1") throw new Error("PATTY_OFFLINE=1 is set");
  // A busy or rate-limiting server gets two more tries, a little later each time.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow", headers: { "User-Agent": UA, Accept: accept } });
    if (r.ok) return r.text();
    if (![429, 502, 503].includes(r.status) || attempt >= 2) throw new Error(`HTTP ${r.status}${r.status === 429 || r.status === 503 ? " (the source is busy or rate-limiting; try this one again in a minute)" : ""}`);
    await new Promise((res) => setTimeout(res, 2500 * (attempt + 1)));
  }
}

export const patentNumber = (s: string): string | null => {
  const t = s.trim().toUpperCase().replace(/[\s,./-]/g, "");
  return /^[A-Z]{2}\d{5,}[A-Z]?\d?$/.test(t) ? t : null;
};

async function fetchPatent(id: string): Promise<Reference> {
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
  const abstract = section("abstract"), claims = section("claims"), description = section("description");
  if (!abstract && !claims && !description) throw new Error("the page had no abstract, claims or description");
  const body = [`## Abstract\n${abstract}`, `## Claims\n${claims.replace(/^Claims\s*\(\d+\)\s*/i, "")}`, `## Description\n${description.replace(/^Description\s*/i, "")}`].join("\n\n");
  return { slug: id, kind: "patent", title, source, date: priority ?? filing, dateLabel: priority ? "priority date" : "filing date", body, cites: rows("backwardReferencesOrig"), citedBy: rows("forwardReferencesOrig"), similar: rows("similarDocuments") };
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

export type StoredReference = { slug: string; title: string; source: string; date: string; kind: string; body: string };
export function readReference(packet: string, slug: string): StoredReference | null {
  const path = join(referencesDir(packet), `${slug}.txt`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const head = (k: string) => text.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1] ?? "";
  const start = text.indexOf("\n\n");
  const end = text.indexOf(BODY_END);
  return { slug, title: head("Title"), source: head("Source"), date: head("Date"), kind: head("Kind"), body: text.slice(start < 0 ? 0 : start, end < 0 ? undefined : end) };
}
export function listReferences(packet: string): string[] {
  const dir = referencesDir(packet);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)).sort();
}

// Quotes are compared after flattening case, whitespace, quote marks and dashes; nothing else is forgiven.
export const flatten = (s: string) =>
  s.toLowerCase().replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[‐-―−]/g, "-").replace(/­/g, "").replace(/\s+/g, " ").trim();
