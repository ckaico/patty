import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DISCLAIMER, VERSION } from "./packet.ts";
import { epoConnected, epoKey, epoSecret, githubHeaders, githubToken, pattyHome, pqaiKey, serpKey, usptoKey } from "./keys.ts";
import { scrub } from "./references.ts";

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
    usedFor: "The USPTO's own record. When a US patent or application is fetched, its official status is added to the stored reference; patent searches also run over the portal's application data (titles and bibliographic fields, not claims).",
    state: () => (usptoKey() ? "connected" : "not connected"),
    detail: () => (usptoKey() ? `key found (PATTY_USPTO_KEY or ${keyFile("uspto_key")})` : "no key; status comes from Google Patents only, unverified"),
    connect: `The key is free. Sign in at https://data.uspto.gov with a USPTO.gov account (the portal requires sign-in with multi-factor authentication, and keys are deactivated while the account profile is incomplete), then copy the key from its Manage API Key page. ${saveKey("uspto_key")}`,
    test: async () => {
      const key = usptoKey();
      if (!key) return "no key to test";
      // One application record, the example the portal's own OpenAPI file uses.
      let r: Response;
      try {
        r = await ping("https://api.uspto.gov/api/v1/patent/applications/14104993/meta-data", { "X-API-KEY": key, Accept: "application/json" });
      } catch {
        return "FAILED: the USPTO Open Data Portal did not answer";
      }
      const d = (await r.json().catch(() => null)) as any;
      if (r.status === 401 || r.status === 403) return `FAILED: HTTP ${r.status} (the key was refused or is not active)`;
      if (!r.ok) return scrub(`FAILED: HTTP ${r.status}${d?.errorDetails ? `: ${String(d.errorDetails).slice(0, 100)}` : ""}`, key);
      const status = d?.patentFileWrapperDataBag?.[0]?.applicationMetaData?.applicationStatusDescriptionText;
      return status ? `OK: answering (application 14104993 reads "${String(status).slice(0, 60)}")` : "OK: answering, but the record came back in a form Patty does not recognise";
    },
  },
  {
    name: "EPO Open Patent Services",
    usedFor: "Official worldwide patent data: a patent search over titles and abstracts, and the full text (claims and description) of EP and WO publications. OPS has no US full text, so US patents are never read from it.",
    state: () => (epoConnected() ? "connected" : "not connected"),
    detail: () => (epoConnected() ? `key and secret found (PATTY_EPO_KEY and PATTY_EPO_SECRET, or ${keyFile("epo_key")} and ${keyFile("epo_secret")})` : epoKey() || epoSecret() ? "only one of the key and the secret was found; both are needed" : "no key; EP and WO patents come from Google Patents"),
    connect: `Free up to a weekly data allowance (https://www.epo.org/en/service-support/ordering/fair-use). Register at https://developers.epo.org/user/register; the EPO approves each registration. Then add an app under My Apps; it shows a Consumer Key and a Consumer Secret. Copy the Consumer Key, then run: mkdir -p ~/.patty && pbpaste > ~/.patty/epo_key && chmod 600 ~/.patty/epo_key . Copy the Consumer Secret, then run: pbpaste > ~/.patty/epo_secret && chmod 600 ~/.patty/epo_secret`,
    test: async () => {
      const key = epoKey(), secret = epoSecret();
      if (!key || !secret) return "no key and secret to test";
      // Asking for an access token checks the key and secret without spending any of the data allowance.
      let r: Response;
      try {
        r = await fetch("https://ops.epo.org/3.2/auth/accesstoken", {
          method: "POST", signal: AbortSignal.timeout(15000), body: "grant_type=client_credentials",
          headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        });
      } catch {
        return "FAILED: EPO OPS did not answer";
      }
      const d = (await r.json().catch(() => null)) as any;
      if (!r.ok || !d?.access_token) return `FAILED: HTTP ${r.status} (the key and secret were refused)`;
      return `OK: the key and secret were accepted (an access token was issued; no data was requested)`;
    },
  },
  {
    name: "PQAI",
    usedFor: "Semantic (meaning-based) patent search, taking each query as written. Its API documentation says it covers US patents.",
    state: () => (pqaiKey() ? "connected" : "not connected"),
    detail: () => (pqaiKey() ? `token found (PATTY_PQAI_KEY or ${keyFile("pqai_key")})` : "no token"),
    connect: `API access comes with a paid personal plan, and its pricing page says commercial integration needs a higher plan: https://projectpq.ai/api-pricing/ . The token is shown on your PQAI account page. ${saveKey("pqai_key")}`,
    test: async () => {
      const key = pqaiKey();
      if (!key) return "no token to test";
      // One patent's data, the guide's own example number: the smallest documented call that
      // needs the token (a CPC definition answers without one). It may count as one query on your plan.
      let r: Response;
      try {
        r = await ping(`https://api.projectpq.ai/patents/US7654321B2?token=${encodeURIComponent(key)}`, { Accept: "application/json" });
      } catch {
        return "FAILED: PQAI did not answer";
      }
      if (r.ok) return "OK: the token was accepted (this may have counted as one query on your plan)";
      const text = await r.text().catch(() => "");
      let body = "";
      try {
        body = String(JSON.parse(text)?.detail ?? "");
      } catch {
        body = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      return scrub(`FAILED: HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (the token was refused)" : ""}${body ? `: ${body.slice(0, 100)}` : ""}`, key);
    },
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
  const patents = [serpKey() ? "SerpApi (connected)" : "Google Patents direct (no key; throttles)", ...(usptoKey() ? ["USPTO Open Data Portal (connected)"] : []), ...(epoConnected() ? ["EPO OPS (connected)"] : []), ...(pqaiKey() ? ["PQAI (connected)"] : [])].join(", ");
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
