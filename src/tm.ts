import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { join, resolve } from "node:path";
import { DISCLAIMER, VERSION, now, readStatus, writeStatus, type Status } from "./packet.ts";
import { SOURCES_CHECKED } from "./build.ts";

const TLDS = ["com", "net", "org", "io", "ai", "app", "dev", "co"];
const UA = `patty-mcp/${VERSION} (local trademark knockout check)`;
const offline = () => process.env.PATTY_OFFLINE === "1";

export const TM_LINKS = {
  search: "https://tmsearch.uspto.gov/search/search-information",
  center: "https://trademarkcenter.uspto.gov/",
  apply: "https://www.uspto.gov/trademarks/apply",
  basis: "https://www.uspto.gov/trademarks/apply/basis",
  idManual: "https://idm-tmng.uspto.gov/id-master-list-public.html",
  fees: "https://www.uspto.gov/trademarks/trademark-fee-information",
  feeSchedule: "https://www.uspto.gov/learning-and-resources/fees-and-payment/uspto-fee-schedule",
  specimen: "https://www.uspto.gov/trademarks/laws/specimen-refusal-and-how-overcome-refusal",
};

async function get(url: string, ms = 9000, accept = "application/json"): Promise<{ status: number; text: string } | { error: string }> {
  if (offline()) return { error: "PATTY_OFFLINE=1" };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow", headers: { "User-Agent": UA, Accept: accept } });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    const err = e as Error;
    return { error: err.name === "TimeoutError" ? "timed out" : "unreachable" };
  }
}
const json = (t: string): any => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const clip = (s: string, n = 200) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 3) + "..." : t;
};
const unent = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ");

// ---------- domains ----------
export type DomainResult = { domain: string; state: "registered" | "not found" | "unknown"; how: string; registered?: string; registrar?: string; site?: string };

// IANA's bootstrap file says which registry answers RDAP for each top-level domain.
let rdapMap: Promise<Map<string, string>> | null = null;
function rdapBase(tld: string): Promise<string | null> {
  rdapMap ??= (async () => {
    const map = new Map<string, string>();
    const r = await get("https://data.iana.org/rdap/dns.json");
    const data = "text" in r ? json(r.text) : null;
    for (const [tlds, urls] of data?.services ?? []) for (const t of tlds) map.set(String(t).toLowerCase(), String(urls[0]));
    return map;
  })();
  return rdapMap.then((m) => m.get(tld) ?? null);
}

async function siteSummary(domain: string): Promise<string | undefined> {
  const r = await get(`https://${domain}/`, 9000, "text/html,*/*");
  if ("error" in r) return undefined;
  if (r.status >= 400) return `answers HTTP ${r.status}`;
  const title = r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const desc = r.text.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? r.text.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1];
  const parts = [title && `title "${clip(unent(title), 120)}"`, desc && `description "${clip(unent(desc), 220)}"`].filter(Boolean);
  return parts.length ? `live site, ${parts.join(", ")}` : "live site, no title or description";
}

async function checkDomain(domain: string): Promise<DomainResult> {
  const tld = domain.split(".").pop()!;
  const base = await rdapBase(tld);
  let out: DomainResult = { domain, state: "unknown", how: "no registry answer" };
  if (base) {
    const r = await get(`${base.replace(/\/?$/, "/")}domain/${domain}`, 9000, "application/rdap+json, application/json");
    if ("status" in r && r.status === 200) {
      const d = json(r.text);
      const reg = (d?.events ?? []).find((e: any) => e.eventAction === "registration")?.eventDate;
      const registrar = (d?.entities ?? []).find((e: any) => (e.roles ?? []).includes("registrar"));
      const fn = registrar?.vcardArray?.[1]?.find((v: any) => v[0] === "fn")?.[3];
      out = { domain, state: "registered", how: "registry RDAP record", registered: typeof reg === "string" ? reg.slice(0, 10) : undefined, registrar: fn };
    } else if ("status" in r && r.status === 404) out = { domain, state: "not found", how: "registry RDAP has no record" };
    else out.how = "error" in r ? `registry RDAP ${r.error}` : `registry RDAP answered HTTP ${r.status}`;
  }
  if (out.state === "unknown" && !offline()) {
    // No usable registry answer: fall back to whether the name is delegated in DNS.
    try {
      const ns = await dns.resolveNs(domain);
      if (ns.length) out = { domain, state: "registered", how: "has DNS name servers (no registry record read)" };
    } catch (e) {
      if ((e as { code?: string }).code === "ENOTFOUND") out = { domain, state: "not found", how: "no DNS delegation (not proof it is free)" };
    }
  }
  if (out.state === "registered") out.site = await siteSummary(domain);
  return out;
}

// ---------- same-name packages, accounts, companies ----------
type Finding = { where: string; found: boolean | null; detail: string; link?: string };

async function checkNames(slug: string, mark: string): Promise<Finding[]> {
  const enc = encodeURIComponent(slug);
  const [npm, pypi, crates, gh, repos, wiki] = await Promise.all([
    get(`https://registry.npmjs.org/${enc}`),
    get(`https://pypi.org/pypi/${enc}/json`),
    get(`https://crates.io/api/v1/crates/${enc}`),
    get(`https://api.github.com/users/${enc}`),
    get(`https://api.github.com/search/repositories?q=${encodeURIComponent(mark)}+in:name&sort=stars&order=desc&per_page=5`),
    get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(mark)}&srlimit=6&format=json`),
  ]);
  const F: Finding[] = [];
  const simple = (where: string, r: typeof npm, link: string, detail: (d: any) => string) => {
    if ("error" in r) F.push({ where, found: null, detail: `not checked (${r.error})` });
    else if (r.status === 200) F.push({ where, found: true, detail: clip(detail(json(r.text)) || "exists"), link });
    else if (r.status === 404) F.push({ where, found: false, detail: "no exact match" });
    else F.push({ where, found: null, detail: `not checked (HTTP ${r.status})` });
  };
  simple(`npm package "${slug}"`, npm, `https://www.npmjs.com/package/${enc}`, (d) => d?.description ?? "");
  simple(`PyPI package "${slug}"`, pypi, `https://pypi.org/project/${enc}/`, (d) => d?.info?.summary ?? "");
  simple(`crates.io crate "${slug}"`, crates, `https://crates.io/crates/${enc}`, (d) => d?.crate?.description ?? "");
  simple(`GitHub account "${slug}"`, gh, `https://github.com/${enc}`, (d) => [d?.type, d?.name, d?.bio, d?.blog, d?.public_repos !== undefined && `${d.public_repos} public repos`].filter(Boolean).join(" · "));
  if ("status" in repos && repos.status === 200) {
    const items: any[] = json(repos.text)?.items ?? [];
    if (!items.length) F.push({ where: "GitHub repositories with the mark in the name", found: false, detail: "none" });
    for (const it of items) F.push({ where: "GitHub repository", found: true, detail: clip(`${it.full_name} · ${it.stargazers_count} stars · ${it.description ?? "no description"}`), link: it.html_url });
  } else F.push({ where: "GitHub repositories with the mark in the name", found: null, detail: `not checked (${"error" in repos ? repos.error : "HTTP " + repos.status})` });
  if ("status" in wiki && wiki.status === 200) {
    const items: any[] = json(wiki.text)?.query?.search ?? [];
    if (!items.length) F.push({ where: "Wikipedia", found: false, detail: "no articles" });
    for (const it of items) F.push({ where: "Wikipedia article", found: true, detail: clip(`${it.title}: ${unent(String(it.snippet ?? "").replace(/<[^>]+>/g, ""))}`, 240), link: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(it.title).replace(/ /g, "_"))}` });
  } else F.push({ where: "Wikipedia", found: null, detail: `not checked (${"error" in wiki ? wiki.error : "HTTP " + wiki.status})` });
  return F;
}

// ---------- class suggestion ----------
function classHints(goods: string): string[] {
  const g = goods.toLowerCase();
  const dl = /download|app\b|apps\b|mobile|desktop|install|sdk|librar|plugin|plug-in|cli\b|command.line|package|extension|firmware/.test(g);
  const online = /saas|online|cloud|hosted|web\b|website|platform|api\b|service|server|subscription|browser/.test(g);
  const out: string[] = [];
  if (dl || !online) out.push(`Class 9, if people download or install it. Starting point for the wording: "Downloadable software for ${goods.replace(/^(downloadable |online )?software (for|that) /i, "")}".`);
  if (online || !dl) out.push(`Class 42, if people use it online without downloading it. Starting point for the wording: "Providing online non-downloadable software for ${goods.replace(/^(downloadable |online )?software (for|that) /i, "")}".`);
  return out;
}

// ---------- the check ----------
export async function tmCheck(packetPath: string, mark: string, goods: string): Promise<string> {
  const packet = resolve(packetPath);
  mark = mark.trim();
  goods = goods.trim().replace(/\.$/, "");
  if (!mark) throw new Error("Pass the mark.");
  if (!goods) throw new Error("Pass goods_services: a plain description of what the mark is used for.");
  mkdirSync(packet, { recursive: true });
  const slug = mark.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
  if (!slug) throw new Error("The mark has no letters or digits to check as a name.");
  const hyphen = mark.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const names = [...new Set([slug, hyphen])].filter(Boolean);

  const domains = await Promise.all(names.flatMap((n) => TLDS.map((t) => checkDomain(`${n}.${t}`))));
  const findings = await checkNames(slug, mark);
  const allFailed = offline() || (domains.every((d) => d.state === "unknown") && findings.every((f) => f.found === null));

  const taken = domains.filter((d) => d.state === "registered");
  const live = taken.filter((d) => d.site?.startsWith("live site"));
  const stand: string[] = [];
  for (const d of live) stand.push(`${d.domain} is registered${d.registered ? ` (since ${d.registered})` : ""} and serves a ${d.site}.`);
  for (const f of findings) if (f.found && /package|crate|account/.test(f.where)) stand.push(`${f.where} exists: ${f.detail}`);

  const K: string[] = [
    `# Trademark knockout: ${mark}`,
    "",
    DISCLAIMER,
    "",
    `Checked ${new Date().toISOString()} for: ${goods}.`,
    "",
    "A knockout looks for the obvious conflicts: the same name already in use where your customers would see it. It is not a clearance search. **It did not search the USPTO register**, because the USPTO offers no public search API; you run that search yourself with the link below. Whether two marks conflict turns on how alike the marks are and how related the goods or services are. That is a judgment for you or a trademark attorney, not for this file.",
    "",
  ];
  if (allFailed) K.push("**Search unavailable.** No lookup got an answer, so nothing was found and nothing was ruled out. Run it again when the network is up.", "");
  K.push("## What stands out", "");
  K.push(...(stand.length ? stand.map((s) => `- ${s}`) : [allFailed ? "- Nothing could be checked." : "- No exact-name domain with a live site, package or account turned up. That is not a clearance."]), "");
  K.push("## Domains", "", "| Domain | State | Registered | Registrar | What it serves | How Patty knows |", "|---|---|---|---|---|---|");
  for (const d of domains) K.push(`| ${d.domain} | ${d.state} | ${d.registered ?? ""} | ${(d.registrar ?? "").replace(/\|/g, "/")} | ${(d.site ?? "").replace(/\|/g, "/")} | ${d.how} |`);
  K.push("", "A registered domain is not a trademark, and a free domain does not clear one. A live business on the exact name, in a field near yours, is the thing to look at.", "");
  K.push("## Same-name packages, accounts and articles", "");
  for (const f of findings) K.push(`- ${f.where}: ${f.found === true ? "FOUND" : f.found === false ? "none" : "unknown"}. ${f.detail}${f.link ? ` ${f.link}` : ""}`);
  K.push(
    "",
    "## Searches you run yourself",
    "",
    `- USPTO trademark search (the register, live and dead marks): ${TM_LINKS.search} . Search the exact mark, then spellings that sound the same, then the mark with your field's common words.`,
    `- A web search for "${mark}" with words from your field, to find businesses using the name without a registration.`,
    "- Your state's business name records, and app stores if you ship an app.",
    "",
  );
  writeFileSync(join(packet, "TM_KNOCKOUT.md"), K.join("\n"));

  const F: string[] = [
    `# Trademark application fields: ${mark}`,
    "",
    DISCLAIMER,
    "",
    "Everything marked **you** is yours to decide and enter. You file in your own USPTO.gov account, and you enter your own signature: an electronic signature has to be personally entered by the person named as the signer (37 CFR 2.193).",
    "",
    "| Field | Value | Notes |",
    "|---|---|---|",
    `| Mark | ${mark} | As given to Patty. Check spelling and spacing before you file. |`,
    "| Mark format | **you**: standard characters (the words alone), or a special form (a logo or stylised lettering) | |",
    "| Owner name | **you** | The person or company that owns the mark and controls how it is used. |",
    "| Owner type and where organised | **you** | Individual, LLC, corporation, and the state or country. |",
    "| Owner address and email | **you** | |",
    `| Filing basis | **you**: use in commerce, section 1(a), or intent to use, section 1(b) | 1(a) needs the dates of first use and a specimen for each class. A 1(b) application does not register until you later file an allegation of use, with a further fee. ${TM_LINKS.basis} |`,
    `| Goods or services, as described to Patty | ${goods} | |`,
    "| International class and identification wording | **you**, from the ID Manual | See the starting points below. |",
    "| Specimen (1(a) only) | **you** | See the checklist below. |",
    `| Fee | Per class. Confirm on the current USPTO fee schedule: ${TM_LINKS.fees} | Patty does not quote fees. Choosing wording from the ID Manual, rather than typing your own, avoids a surcharge listed on that page. |`,
    "",
    "## Class and wording: starting points, not checked against the ID Manual",
    "",
    ...classHints(goods).map((h) => `- ${h}`),
    `- Look the wording up in the Trademark ID Manual and use an entry from it: ${TM_LINKS.idManual}`,
    "- Software sold both ways can need both classes. Each class is a separate fee.",
    "",
    "## Specimen checklist (use in commerce)",
    "",
    "- It shows the mark as you actually use it, directly associated with the goods or services.",
    "- A webpage specimen includes the URL and the date it was accessed or printed.",
    "- For downloadable software: a page or screen that shows the mark together with the means to download or buy the software.",
    "- For online software: a page or sign-in screen that shows the mark with the service being offered or used.",
    "- It is a real example of use. A mock-up, a digitally altered image or a draft of a website is not accepted.",
    `- USPTO specimen guidance: ${TM_LINKS.specimen}`,
    "",
    "## Filing",
    "",
    "1. Read TM_KNOCKOUT.md and run the USPTO search yourself.",
    "2. Fill in the fields above.",
    `3. Sign in to Trademark Center with your own USPTO.gov account (${TM_LINKS.center}; start at ${TM_LINKS.apply}). The account needs identity verification; do that ahead of time.`,
    "4. Enter the application. **Sign** it yourself. **Pay** the fee. **Submit.** Patty does none of these.",
    "",
    `Sources read on ${SOURCES_CHECKED}: the USPTO trademark fee page, the USPTO specimen page, 37 CFR 2.193 on eCFR, and the USPTO trademark search site. The class wording above and the Trademark Center screens were not checked.`,
    "",
  ];
  writeFileSync(join(packet, "TM_FIELDS.md"), F.join("\n"));

  let status: Status | null = readStatus(packet);
  if (!status) {
    status = { notice: DISCLAIMER, patty_version: VERSION, kind: "trademark", repo_path: existsSync(resolve(packet, "..")) ? resolve(packet, "..") : packet, created: now(), updated: now(), done: {}, waiting_on_human: [] };
  }
  status.done.tm_check = now();
  status.facts = { ...(status.facts ?? {}), trademark: { mark, goods_services: goods } };
  if (status.kind === "trademark") status.waiting_on_human = ["Run the USPTO trademark search yourself (link in TM_KNOCKOUT.md).", "Complete TM_FIELDS.md.", "File in your own USPTO account: sign, pay and submit."];
  writeStatus(packet, status);

  const out = [`TM_KNOCKOUT.md and TM_FIELDS.md written to ${packet}.`, ""];
  if (allFailed) out.push("Search unavailable: no lookup got an answer. Nothing was ruled out.");
  else {
    out.push("What stands out:", ...(stand.length ? stand.map((s) => `- ${s}`) : ["- No exact-name live site, package or account found. Not a clearance."]), "");
    out.push(`Domains registered: ${taken.map((d) => d.domain).join(", ") || "none found"}.`);
    out.push(`Domains with no record: ${domains.filter((d) => d.state === "not found").map((d) => d.domain).join(", ") || "none"}.`);
    const unk = domains.filter((d) => d.state === "unknown").map((d) => d.domain);
    if (unk.length) out.push(`Could not tell: ${unk.join(", ")}.`);
  }
  out.push("", `The USPTO register was NOT searched (no public search API). The human runs that search: ${TM_LINKS.search}`, "Do not tell the human the mark is clear. Tell them what was found and what was not checked.");
  return out.join("\n");
}
