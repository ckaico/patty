import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DISCLAIMER, VERSION } from "./packet.ts";
import { githubHeaders, githubToken, pattyHome, serpKey } from "./keys.ts";

// Every outside service Patty can use, in one place: what it is for, whether it is connected,
// and how the user connects their own account. Patty holds no accounts of its own. Each
// service is signed up for, and paid where it charges, by the person running Patty.

type State = "connected" | "open" | "not connected" | "not wired" | "connector";
type Source = {
  name: string; usedFor: string; state: () => State; detail: () => string;
  connect?: string; test?: () => Promise<string>;
};

const offline = () => process.env.PATTY_OFFLINE === "1";
const UA = `Mozilla/5.0 (compatible; patty-mcp/${VERSION})`;
async function ping(url: string, headers: Record<string, string> = { "User-Agent": UA }): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(15000), headers });
}
const tried = async (fn: () => Promise<string>) => {
  if (offline()) return "not tested (PATTY_OFFLINE=1)";
  try {
    return await fn();
  } catch (e) {
    const err = e as Error;
    return `FAILED: ${err.name === "TimeoutError" ? "timed out" : (err.message || err.name).slice(0, 120)}`;
  }
};
const keyFile = (file: string) => `${pattyHome()}/${file}`;
const saveKey = (file: string) => `Copy the key, then run: mkdir -p ~/.patty && pbpaste > ~/.patty/${file} && chmod 600 ~/.patty/${file}`;

export const SOURCES: Source[] = [
  {
    name: "SerpApi (Google Patents data)",
    usedFor: "Patent search, and full text of each patent: claims, description, status, citations, related applications. The dependable route for patents.",
    state: () => (serpKey() ? "connected" : "not connected"),
    detail: () => (serpKey() ? `key found (PATTY_SERPAPI_KEY or ${keyFile("serpapi_key")})` : "no key; patents fall back to the direct pages below"),
    connect: `Sign up at https://serpapi.com (plans and the free allowance: https://serpapi.com/pricing). ${saveKey("serpapi_key")}`,
    test: async () => {
      const key = serpKey();
      if (!key) return "no key to test";
      // The address carries the key, so a network error is reported without its text.
      let r: Response;
      try {
        r = await ping(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`, { Accept: "application/json" });
      } catch {
        return "FAILED: SerpApi did not answer";
      }
      const d = (await r.json().catch(() => null)) as any;
      if (!r.ok || !d || d.error) return `FAILED: ${String(d?.error ?? `HTTP ${r.status}`).slice(0, 120)}`;
      return `OK: ${d.plan_name ?? "plan not named"}, ${d.total_searches_left ?? "?"} searches left this period (checking this does not use one)`;
    },
  },
  {
    name: "Google Patents, direct pages",
    usedFor: "Patent search and full text when no SerpApi key is set. Undocumented, and it refuses requests after a burst: a real run can lose its patent comparison.",
    state: () => "open",
    detail: () => (serpKey() ? "fallback only" : "in use for patents"),
    test: async () => {
      const r = await ping("https://patents.google.com/xhr/query?url=q%3Dcache%2Beviction%26oq%3Dcache%2Beviction&exp=");
      return r.ok ? "OK: answering" : `REFUSING: HTTP ${r.status} (wait, or connect SerpApi)`;
    },
  },
  {
    name: "arXiv",
    usedFor: "Paper search; abstracts of papers fetched by URL.",
    state: () => "open",
    detail: () => "no account; one request every three seconds",
    test: async () => {
      const r = await ping("https://export.arxiv.org/api/query?search_query=all:cache&max_results=1");
      return r.ok ? "OK: answering" : `REFUSING: HTTP ${r.status}`;
    },
  },
  {
    name: "GitHub",
    usedFor: "Repository search and READMEs as prior art; same-name accounts and repositories for trademarks; whether a remote is public.",
    state: () => (githubToken() ? "connected" : "open"),
    detail: () => (githubToken() ? `token found (PATTY_GITHUB_TOKEN or ${keyFile("github_token")})` : "no token: about ten searches a minute"),
    connect: `Optional. A token with no scopes lifts the limit: create one at https://github.com/settings/tokens. ${saveKey("github_token")}`,
    test: async () => {
      const r = await ping("https://api.github.com/rate_limit", githubHeaders());
      const d = (await r.json().catch(() => null)) as any;
      if (!r.ok) return `FAILED: HTTP ${r.status}${r.status === 401 ? " (the token was rejected)" : ""}`;
      return `OK: ${d?.resources?.search?.remaining ?? "?"} of ${d?.resources?.search?.limit ?? "?"} searches left this minute`;
    },
  },
  {
    name: "GleanMark, open search",
    usedFor: "The USPTO trademark register, by name as typed. A third party's copy of the USPTO's daily data.",
    state: () => "open",
    detail: () => "no account; rate-limited",
    test: async () => {
      const c = new Client({ name: "patty-mcp", version: VERSION });
      try {
        await Promise.race([c.connect(new StreamableHTTPClientTransport(new URL(process.env.PATTY_TM_REGISTER_URL ?? "https://gleanmark.com/mcp"))), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 15000))]);
        const t = await c.listTools();
        return t.tools.some((x) => x.name === "search_trademarks") ? "OK: answering" : "FAILED: the search tool is not offered any more";
      } finally {
        c.close().catch(() => {});
      }
    },
  },
  {
    name: "Domain registries, npm, PyPI, crates.io, Wikipedia",
    usedFor: "Trademark knockout: who already uses the name.",
    state: () => "open",
    detail: () => "no accounts",
  },
  {
    name: "USPTO Open Data Portal",
    usedFor: "The official record: application status and documents. Would let Patty confirm a patent's status at the source instead of asking you to.",
    state: () => "not wired",
    detail: () => "Patty does not use it yet. The key is free but needs a USPTO.gov account verified through ID.me (https://data.uspto.gov). Its response format could not be read without a key, so nothing was built blind.",
  },
  {
    name: "EPO Open Patent Services",
    usedFor: "Official worldwide patent data, free up to a weekly allowance.",
    state: () => "not wired",
    detail: () => "Not used: its own FAQ lists no US full text, so US claims cannot be charted from it.",
  },
  {
    name: "PQAI",
    usedFor: "Semantic (meaning-based) patent search.",
    state: () => "not wired",
    detail: () => "Not used: API calls come only with a paid personal plan, and commercial use starts far higher (https://projectpq.ai/api-pricing/).",
  },
];

// Hosted services with their own sign-in. Patty cannot hold that login; the user adds each one
// to their MCP host, and the drafting method tells the host model to use whichever are present.
export const CONNECTORS: { name: string; url: string; adds: string }[] = [
  { name: "GleanMark (signed in)", url: "https://gleanmark.com/mcp", adds: "similar-mark and sound-alike search, clearance reports" },
  { name: "Clarivate CompuMark", url: "https://ipone.clarivate.com/trademarks/mcp", adds: "trademark knockout and full-text trademark search" },
  { name: "Haloo", url: "https://connect.haloo.ai/trademark-search/mcp", adds: "trademark clearance reports" },
  { name: "Clerq", url: "https://mcp.us.clerq-ip.com/mcp", adds: "natural-language and similar-patent search, patentability triage" },
  { name: "Patlytics", url: "https://mcp.patlytics.ai/mcp", adds: "similar-patent search, non-patent literature" },
  { name: "Solve Intelligence", url: "https://api.solveintelligence.com/mcp/", adds: "patent search, non-patent literature, patent law references" },
  { name: "IP Author", url: "https://mcp.ipauthor.com/mcp", adds: "prosecution history and file-wrapper analysis" },
];

export function sourcesLine(): string {
  const patents = serpKey() ? "SerpApi (connected)" : "Google Patents direct (no key; throttles)";
  return `Sources: patents via ${patents}; papers via arXiv; code via GitHub${githubToken() ? " (token)" : ""}; trademark register via GleanMark's open search. Call patty_sources to see every connection and how to add your own accounts.`;
}

export async function sources(test: boolean): Promise<string> {
  const results = new Map<string, string>();
  if (test) await Promise.all(SOURCES.filter((s) => s.test).map(async (s) => results.set(s.name, await tried(s.test!))));
  const label: Record<State, string> = { connected: "CONNECTED (your account)", open: "ON (no account needed)", "not connected": "NOT CONNECTED", "not wired": "NOT BUILT IN", connector: "SEPARATE CONNECTOR" };
  const L: string[] = ["# Patty connections", "", DISCLAIMER, "", "Patty has no accounts of its own. Each service below is yours to sign up for, and to pay where it charges. Patty reads your key from your machine when it makes a request and never stores it anywhere else.", ""];
  for (const s of SOURCES) {
    L.push(`## ${s.name}: ${label[s.state()]}`, `- Used for: ${s.usedFor}`, `- Now: ${s.detail()}`);
    if (s.connect && s.state() !== "connected") L.push(`- To connect: ${s.connect}`);
    if (results.has(s.name)) L.push(`- Live test: ${results.get(s.name)}`);
    L.push("");
  }
  L.push(
    "## Services with their own sign-in (added to your MCP host, not to Patty)",
    "",
    "These are hosted connectors. You sign in to each inside Claude (or your MCP host) and pay each provider directly; Patty cannot hold that login. When one is connected in the same session, the drafting method tells the host model to search with it as well and to bring what it finds into Patty's charts, where the quotes are checked.",
    "",
    ...CONNECTORS.map((c) => `- ${c.name} · ${c.url} · adds: ${c.adds}`),
    "",
    "None of these was tested with an account. Whether a plan allows this use, and what it costs, is on each provider's own pages.",
    "",
    `Keys live in ${pattyHome()} (one file per service, readable only by you) or in environment variables. PATTY_OFFLINE=1 turns every connection off.`,
  );
  if (!test) L.push("", "Call patty_sources with test: true to try each connection now.");
  return L.join("\n");
}
