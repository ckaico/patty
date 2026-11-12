# Patty

Version 0.6.0

A local MCP server for software inventions. It reads a repository with you and does three jobs:

- **Patent this repo.** Finds the mechanisms in the code, compares each with the closest prior art it can find, records whether each is worth protecting, and prepares a US provisional patent application.
- **Build around a patent.** Charts every independent claim of someone else's patent against the code, element by element, and shows where a change would take an element out.
- **Trademark.** Knockout check and the fields for a US trademark application.

You approve what it prepares, then sign, pay and submit in your own USPTO account. The server never signs, submits or pays. It never says an invention is novel or patentable, or that code is clear of a patent.

**Patty prepares documents for you to file yourself. It is not a law firm and this is not legal advice.**

## How it works

The MCP host (Claude Code, Cursor, Codex) does the reading and the writing. The server supplies the method, the file formats, the drawings, the checks and the filing copies.

1. `patty_start` returns the drafting method and a map of the repo.
2. The host reads the code and writes `EVIDENCE.md`: each mechanism with `file:line` citations.
3. `patty_prior_art` searches patents, papers and repositories, then fetches the closest references in full, with their similar documents and citations to chase. The host writes `PRIOR_ART_CHART.md`: each mechanism broken into elements, each reference marked yes, partly or no per element, with a quote for every yes and partly.
4. The host writes `SPECIFICATION.md` around what the closest references lack, and calls `patty_figures` for the drawings.
5. `patty_check` opens every cited line of code, looks for every chart quote in the stored reference text, compares every reference numeral, and fails the packet on placeholders and limiting language.
6. `patty_build` writes the PDFs, the cover sheet worksheet, the docket and the filing steps. It will not run until the check passes.

### Building around a patent

1. `patty_start` with kind `clearance` returns that method and the repo map.
2. `patty_prior_art` with `fetch` stores the patent: status, expiration, owner, and each claim marked independent or dependent.
3. The host writes `CLAIM_CHART.md`: each independent claim split into elements in the claim's own words, each element marked found in the code (with `file:line`) or not found (with the reason), and options for taking an element out.
4. `patty_check` compares the claim wording with the stored patent, opens every code citation, requires every independent claim to be charted, and requires the result to match the rows.
5. `patty_build` writes `CLEARANCE_REPORT.md`.

A product is covered by a claim only if it has every element of it. The chart shows which elements the code has. It is a literal reading, not a freedom-to-operate opinion.

## Install

Needs [bun](https://bun.sh) 1.1 or later. Node is not required.

In Claude Code, one line:

```bash
claude mcp add patty -- bunx github:ckaico/patty
```

Add `--scope user` to have it in every project. In any other MCP host the server is the stdio command `bunx github:ckaico/patty`:

```json
{ "mcpServers": { "patty": { "command": "bunx", "args": ["github:ckaico/patty"] } } }
```

Then open a software repo and say "patent this repo".

`bunx` keeps the copy it first downloaded. To install or move to a specific release, pin its tag: `bunx github:ckaico/patty#v0.6.0`.

### From a clone

To work on Patty itself, or to pin a copy, clone the repository and run it from its folder:

```bash
git clone https://github.com/ckaico/patty && cd patty
```

```bash
bun install
```

```bash
claude mcp add patty -- bun "$PWD/src/index.ts"
```

Add `--scope user` to have it in every project. Any other MCP host takes the same stdio command:

```json
{ "mcpServers": { "patty": { "command": "bun", "args": ["/absolute/path/to/patty/src/index.ts"] } } }
```

### Connections

Patty has no accounts of its own. Every outside service is the user's: they sign up, they pay where it charges, and the key stays on their machine. `patty_sources` shows the whole picture, and with `test: true` tries each connection and reports what is left on a keyed plan.

| Service | Used for | Account |
|---|---|---|
| SerpApi | Patent search and full text (Google Patents data) | Your key. Recommended. |
| Google Patents, direct pages | The same, when no key is set | None. Throttles. |
| arXiv | Papers | None |
| GitHub | Code as prior art; same-name accounts | None; an optional token lifts the search limit |
| GleanMark, open search | USPTO trademark register by name | None |
| Domain registries, npm, PyPI, crates.io, Wikipedia | Trademark knockout | None |
| USPTO Open Data Portal | Official status of a US patent or application when it is fetched; an extra patent search over application data | Your key (free; USPTO.gov account) |
| EPO Open Patent Services | An extra patent search over titles and abstracts; claims and description of EP and WO publications | Your key and secret (free up to a weekly allowance; EPO approves registration) |
| PQAI | An extra, meaning-based patent search that takes each query as written | Your token (paid plan) |

Keys go in `~/.patty/`, one file per service (`serpapi_key`, `github_token`, `uspto_key`, `epo_key` and `epo_secret`, `pqai_key`), or in `PATTY_SERPAPI_KEY`, `PATTY_GITHUB_TOKEN`, `PATTY_USPTO_KEY`, `PATTY_EPO_KEY` and `PATTY_EPO_SECRET`, `PATTY_PQAI_KEY`. `PATTY_HOME` moves the folder. They are read when a request is made and never written to a packet or an error message.

Hosted patent and trademark connectors with their own sign-in (GleanMark, Clarivate CompuMark, Haloo, Clerq, Patlytics, Solve Intelligence, IP Author) are not something Patty can log in to. The user adds them to their MCP host. When one is present in the session, the drafting method tells the host model to search with it too and to bring what it finds into Patty's charts, where quotes are checked. None was tested with an account.

### A dependable patent source (recommended)

Without a key, patents come from Google Patents' own pages, which refuse requests after a burst; on one real run that cut the patent comparison off entirely. With a [SerpApi](https://serpapi.com) key, the same search and the same full text come through their API. Their pricing page lists a free plan of 250 searches a month; a run on a mid-sized repo used about 40 patent requests.

Put the key in a file only you can read. Copy it from your SerpApi dashboard, then:

```bash
mkdir -p ~/.patty && pbpaste > ~/.patty/serpapi_key && chmod 600 ~/.patty/serpapi_key
```

`PATTY_SERPAPI_KEY` in the environment works too. The key is read when a request is made; it is never written to a packet or an error message. With a key set, patent queries and publication numbers go to serpapi.com, which queries Google Patents.

### Official and semantic patent sources (optional)

Each of these is searched alongside Google Patents when its key is present. Results are merged, a publication found by several sources is listed once, and each hit says which sources found it. One source failing is reported on its own line and does not stop the others.

- **USPTO Open Data Portal.** Sign in at [data.uspto.gov](https://data.uspto.gov) with a USPTO.gov account and copy the key from Manage API Key into `~/.patty/uspto_key`. When a US patent is fetched, the stored reference gets a line `USPTO status (official, checked <date>): ...`, read by application number. Its search runs over application data (titles and bibliographic fields), not claims.
- **EPO Open Patent Services.** Register at [developers.epo.org](https://developers.epo.org/user/register), add an app, and save its Consumer Key in `~/.patty/epo_key` and its Consumer Secret in `~/.patty/epo_secret`. The search runs over titles and abstracts. EP and WO publications are then fetched from OPS in full. US patents never are: OPS has no US full text.
- **PQAI.** API access comes with a paid plan, and commercial integration needs a higher one ([projectpq.ai/api-pricing](https://projectpq.ai/api-pricing/)). Save the token from your account page in `~/.patty/pqai_key`.

`patty_sources` with `test: true` checks each one with the cheapest call it offers.

Then, in any software repo, say "patent this repo" or "help me build around US1234567B2". The two prompts do the same: `patent-this-repo` and `build-around` (in Claude Code: `/mcp__patty__patent-this-repo`, `/mcp__patty__build-around`).

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `patty_start` | `repo_path`, `kind` (`provisional`, `clearance` or `trademark`), `check_remotes` | Creates `patty-packet/` in the repo and adds it to `.gitignore` when the repo is under git. Returns the drafting method and a repo map: source files with sizes and languages, entry points, first and last commit dates, remotes and whether each answers an anonymous request, tags. |
| `patty_prior_art` | `queries[]`, `fetch[]`, `packet_path` | `queries`: searches patents (Google Patents, plus the USPTO Open Data Portal, EPO OPS and PQAI where connected, merged with each hit's sources), papers (arXiv) and repositories (GitHub) and adds titled, linked results to `PRIOR_ART.md`. `fetch`: reads references in full (publication numbers or URLs), stores them under `references/` and returns each patent's similar documents and citations. A failed search is written as "Search unavailable" and does not block the packet. |
| `patty_figures` | `figures[]`, `packet_path` | Renders SVG drawings from JSON: `flow` (flowchart with decisions, side boxes, rejoin and loop-back arrows), `block` (boxes and data tables on a grid, arrows routed), `canvas` (exact coordinates). Black on white, reference numerals, one figure per file. Returns each figure's numerals and layout warnings. |
| `patty_check` | `packet_path` | The lint. See below. |
| `patty_build` | `packet_path`, optional `inventors`, `first_public_disclosure`, `nothing_public_yet`, `filed` | Runs the check. For a clearance packet, writes `CLEARANCE_REPORT.md`. For a provisional packet, writes `specification.pdf`, `drawings.pdf`, `COVER_SHEET.md`, `FILING_STEPS.md`, `DOCKET.md`. Facts not supplied are marked for the human; none are guessed. |
| `patty_sources` | `test` | Lists every outside service Patty can use, whether it is connected, and how to connect your own account. With `test`, tries each one. |
| `patty_tm_check` | `mark`, `goods_services`, `packet_path` | Trademark knockout: the USPTO register for the name as typed (through GleanMark, a third party), exact-name domain registrations and what they serve, same-name packages and accounts, Wikipedia. Writes `TM_KNOCKOUT.md` and `TM_FIELDS.md`. Does not search sound-alikes, similar marks or logos. |

`packet_path` defaults to `patty-packet/` in the folder the server was started in.

## The packet

```
patty-packet/
  EVIDENCE.md          each mechanism, with file:line citations into the repo   (host writes)
  SPECIFICATION.md     the disclosure                                           (host writes)
  figures/*.svg        drawings; figures/source.json keeps the JSON they came from
  PRIOR_ART.md         what the searches found, with links
  PRIOR_ART_CHART.md   each mechanism against the closest references, element by element   (host writes)
  references/*.txt     full text of each reference read; references/search.json is the search log
  specification.pdf    filing copy
  drawings.pdf         filing copy
  COVER_SHEET.md       every field the filer types into the USPTO form
  FILING_STEPS.md      numbered steps for the human, ending in sign, submit, pay
  DOCKET.md            first public disclosure, grace limit, twelve-month date
  STATUS.json          what is done, what is waiting on the human
  TM_KNOCKOUT.md, TM_FIELDS.md   trademark packet
  CLAIM_CHART.md, CLEARANCE_REPORT.md   building around a patent
```

The numbered steps end sign, submit, pay, in that order, because that is the order of Patent Center's screens: the fee is paid after the submission receipt.

No example packet is included in this repository. A packet describes an invention, and an unfiled one does not belong in a public repository.

### File formats

`EVIDENCE.md` entries look like this. The text after ` | ` has to be on the cited line or inside the cited range; only whitespace differences are forgiven.

```
## E1. Two-stage eviction
Spec: 2
Expired entries are removed first, and a live entry is removed only if the store is still full.
- src/cache.ts:22 | Expired entries go first; only then the least used one.
- src/cache.ts:23-29 | if (store.size < MAX) return;
```

`PRIOR_ART_CHART.md` looks like this. A reference can be charted only after `patty_prior_art` has fetched it, and every quote has to be in the stored text.

```
## M1. Two-stage eviction
Evidence: E1
- A. Expired entries are removed before any live entry.
- B. A live entry is removed only if the store is still full.

### US0000001A
- A: yes | entries whose time to live has elapsed are deleted before any other entry
- B: no

Result: closest US0000001A; differs in B
```

The result line has three forms: `knocked out by <reference>` (one reference has every element), `closest <reference>; differs in B, C`, and `nothing close found`. There is no form that says a mechanism is new. Each mechanism also carries `Protect: yes | reason`, `maybe` or `no`: the host's call on whether it is worth the cost of protecting, weighing whether a real difference survives, whether a competitor would have to copy it, and whether copying could be seen from outside. A knocked-out mechanism has to be `no`.

`CLAIM_CHART.md` looks like this. Elements are copied from the claim; a paraphrase fails.

```
## US0000009B2 claim 1
- A. maintaining a data store that stores data for a plurality of tenants
- B. storing an entry in an in-memory cache with an expiry time

- A: no | one store for one user; nothing in src/ carries a tenant identifier
- B: yes | src/cache.ts:19 | store.set(key, { value, expires: now + ttl, hits: 0 });

Result: not found in the code: A
```

The result is `every element found in the code` or `not found in the code: A, D`. There is no form that says the code is clear.

`SPECIFICATION.md` uses the headings Title, Field, Background, Summary, Brief Description of the Drawings, Detailed Description (with sections numbered `### 1. Name`), Example Claims, Abstract. Reference numerals are whole numbers from 100 up. The full contract, with the figure JSON, is the text in `src/method.ts`, which `patty_start` returns.

## What `patty_check` checks

Fails the packet when:

- a numbered section of the Detailed Description (other than Variations) has no evidence entry with a citation that verifies;
- a cited file or line does not exist, the path leaves the repo, or the cited text is not on the cited line;
- a quote in the prior art chart is not in the stored reference, a charted reference was never fetched, or an element has no row;
- the chart's result contradicts its rows: a reference marked yes for every element has to be reported as a knockout;
- the search returned results and there is no chart;
- a mechanism has no `Protect:` line, or a knocked-out one is not marked `no`;
- in a claim chart: an element is not the claim's own words, an independent claim is not charted, a code citation does not verify, a "no" has no reason, or the result does not match the rows;
- a reference numeral is in the Detailed Description and in no figure, or in a figure and never in the text;
- the text refers to a figure that does not exist, or a figure has no line in the Brief Description of the Drawings;
- a placeholder remains (`[CITY]`, `TODO`, `TBD`, `____`, `{{...}}`);
- limiting language appears: "the invention is", "the present invention", "must", "essential", "critical", "always";
- a required section is missing or empty.

Warns, loudly, when a mechanism is knocked out; cutting or narrowing it is the human's decision. Warns when no search ran. Also warns on an abstract over 150 words, a title over 500 characters, text above the first heading, an inventor section in the specification, and missing claims or variations.

What it does not do: it does not judge whether the specification says only what the evidence supports, whether the description is accurate, whether a quote really discloses the element it is set against, or whether anything is new, non-obvious or eligible. A "no" in either chart is the host model's reading and is not checked; in a claim chart the whole result rests on it. `Protect` is a judgment, recorded so the human can disagree with it. Telling a quantity from a reference numeral is a heuristic: a number of 100 or more counts as a quantity when "for example", "about" or a similar word comes before it, or a unit such as "characters" or "ms" comes after it. "critical" also fails in "critical section"; reword.

## Network use

The server sends no source code anywhere and has no telemetry. It makes these requests, and no others:

| Tool | Request | What is sent |
|---|---|---|
| `patty_start` | Each git remote's host, `info/refs`, anonymously | The remote URL with credentials removed. Skip with `check_remotes: false`. |
| `patty_prior_art` | `serpapi.com` when a key is set, otherwise `patents.google.com`; `export.arxiv.org`, `api.github.com`; with your keys, `api.uspto.gov`, `ops.epo.org`, `api.projectpq.ai`; for `fetch`, the reference's own page, or `ops.epo.org` for EP and WO publications, and `api.uspto.gov` for a US patent's status | The query text (the full text to PQAI, the most telling words to the USPTO and EPO); for `fetch`, the publication number or URL, and to the USPTO the application or patent number. |
| `patty_sources` with `test` | Each service above, once | Nothing of yours: a fixed example query or number, and your key to its own service. |
| `patty_tm_check` | `gleanmark.com` (register lookup), `data.iana.org`, the registry RDAP server for each domain, DNS, the candidate domains' own home pages, `registry.npmjs.org`, `pypi.org`, `crates.io`, `api.github.com`, `en.wikipedia.org` | The mark, as a name. |

`PATTY_OFFLINE=1` turns every request off; the affected files then say "search unavailable". `PATTY_PATENT_SEARCH_URL` points the patent search at another endpoint with the same response shape. `PATTY_TM_REGISTER_URL` does the same for the register lookup.

A query describes the mechanism being searched for. For an unfiled invention, that is a description of it sent to a search service. Phrase queries as general mechanisms, or set `PATTY_OFFLINE=1` and search by hand.

What the host model does with your code is the host's business, not this server's.

## Checked against primary sources

Read on 2026-11-08. Each row says what was read and what it showed. The generated documents state no fee amounts; the amounts here are a dated observation, not something the code uses.

| Topic | Source | What it showed |
|---|---|---|
| Provisional filing fee | USPTO fee schedule, "Effective January 19, 2025 (Last revised November 1, 2026)" | Fee codes 1005/2005/3005, 37 CFR 1.16(d): $325 undiscounted, $130 small entity, $65 micro entity. |
| Trademark application fee | USPTO trademark fee information page | Base application $350 per class; surcharges for insufficient information and for free-form identification text. |
| Form numbers | USPTO patent forms page | PTO/SB/16 is the Provisional Application for Patent Cover Sheet, with a Patent Center version marked recommended. PTO/SB/15A is the Certification of Micro Entity Status, gross income basis. |
| Cover sheet contents | 37 CFR 1.51(c)(1) (eCFR, title 37 current to 2026-11-05); USPTO provisional application page | Application type, inventor names and residences, title, attorney or agent and docket number if any, correspondence address, any US Government interest. All inventors are named. |
| Specification format | 37 CFR 1.52, 1.72 (eCFR) | Margins of at least 2.0 cm top, right and bottom and 2.5 cm left; 1.5 or double line spacing; nonscript font; pages numbered consecutively; claims and abstract each start on a separate sheet; abstract preferably 150 words or fewer; title at most 500 characters. |
| Drawing format | 37 CFR 1.84(g), (i), (t) (eCFR) | Margins of at least 2.5 cm top and left, 1.5 cm right, 1.0 cm bottom; a wide view may be turned so the top of the sheet is on the right-hand side; sheets numbered as sheet/total at the top of the sight. |
| Signatures | 37 CFR 1.4(d)(2)(i), 2.193, 11.18 (eCFR) | The person signing inserts their own S-signature between forward slashes. A trademark electronic signature is personally entered by the person named as signatory. |
| AI tools and filing | USPTO, "Guidance on Use of Artificial Intelligence-Based Tools in Practice Before the USPTO", 89 FR 25609, 11 April 2024 | A signature has to be personally entered by a natural person and cannot be applied by a tool. A USPTO.gov account belongs to one individual and may not be shared. |
| Patent Center | Patent Center User Guide, September 2025 edition; USPTO Patent Center page | Registered users only, with identity verification (required for all users since 11 September 2025) and two-step sign-in. New submission, Utility Provisional. Application data, upload documents, calculate fees, confirm and submit, submission receipt, pay fees. PDF limit 25 MB. Files named Specification or Drawing get that document description. |
| PDF requirements | Patent Center PDF Guidelines (page last updated 2 October 2024) | Letter or A4; PDF version 1.1 to 1.6; all fonts embedded and licensed for embedding; no encryption, no layers. |
| Twelve-month period | 35 U.S.C. 119(e) (govinfo, 2024 edition); USPTO provisional application page | Twelve months from the provisional filing date, moved to the next business day when it falls on a Saturday, Sunday or federal holiday; not extendable. |
| Grace period | 35 U.S.C. 102(b)(1) (govinfo, 2024 edition); USPTO provisional application page | Disclosures by the inventor one year or less before the effective filing date are excepted. The USPTO page adds that such a disclosure may preclude patenting in foreign countries. |
| Patent search | Live requests | `https://patents.google.com/xhr/query?url=<encoded query>&exp=` returned JSON without a key. It is undocumented and can change. `search.patentsview.org` no longer resolves and `patentsview.org/apis` redirects to the USPTO Open Data Portal. `api.uspto.gov/api/v1/patent/applications/search` answered 401 without a key. |
| Trademark search | `tmsearch.uspto.gov`; USPTO "Trademark search system updates" page (updated 5 October 2026) | A web application. No public search API is documented on it. Signed in, it has a beta image search: upload artwork, get similar marks. |
| Trademark register lookup | Live requests to `gleanmark.com/mcp`, 2026-11-10 | Answers `search_trademarks` without a sign-in (its own page states 10 requests a minute). Returned 27 records for "Argyle", including two registered marks in classes 9 and 42, with data through 2026-11-09. Its similar-marks tool needs a sign-in and was not tested. |
| USPTO Open Data Portal | `data.uspto.gov/swagger/swagger.yaml` and `odp-common-base.yaml` (the portal's OpenAPI files), read 2026-11-11 in a browser; the portal's front page | Search is `GET /api/v1/patent/applications/search` with `q` (boolean AND, OR, NOT, phrases, `field:value`), `limit`, `fields`; one record is `GET /api/v1/patent/applications/{number}/meta-data`; both answer `PatentDataResponse` (`count`, `patentFileWrapperDataBag[].applicationMetaData` with `applicationStatusDescriptionText`, `applicationStatusDate`, `patentNumber`, `inventionTitle`, `earliestPublicationNumber`). The key goes in `X-API-KEY`. 404 means no matching records. Since 18 June 2026 the portal itself needs a signed-in USPTO.gov account with multi-factor authentication, and keys of accounts with an incomplete profile were deactivated on 8 October 2026. The "ODP API Query Spec" PDF was fetched but its text could not be extracted, so it was not used. Without a key the API answers 401. |
| EPO Open Patent Services | OPS v3.2 reference guide, version 1.3.20 (June 2024); OPS OpenAPI file `ops.epo.org/wsdl/ops.yaml`; the OPS page on epo.org; `fulltext-documents.xsd` and `exchange-documents.xsd`, all read 2026-11-11 | OAuth client credentials: `POST /3.2/auth/accesstoken` with the key and secret as Basic authentication, a token good for about 20 minutes. Bibliographic search is `GET /published-data/search/biblio?q=<CQL>`, `ta` being title or abstract in English, range in `X-OPS-Range`. Claims and description are `/published-data/publication/epodoc/<number>/claims` and `/description`. Full text covers EP, WO and a list of European national offices, not the US. Free up to a weekly data allowance; about 20 searches a minute when the service is not busy. Without credentials the sign-in answers 401 and a search 403. |
| PQAI | API usage guide at `api.projectpq.ai/docs`; the API and API pricing pages on projectpq.ai; PQAI's open-source server (`github.com/pqaidevteam/pqai`, `core/api.py`, `core/documents.py`, `core/results.py`), read 2026-11-11 | Search is `GET /search/102/` with `q`, `n`, `type=patent` and `token`; the answer is `results`, each with `id`, `type`, `title`, `abstract`, `publication_date`, `filing_date`, `priority_date`, `owner`, `inventors`, `www_link`, `score`. The guide says the data is US patents only for now. API access comes with a paid plan; the pricing page lists commercial use on its highest plan only. Without a token, search and patent data answer 401. The fields of each result come from the open-source server, not from the guide. |
| Paper and code search | Live requests, 2026-11-10 | The arXiv API and GitHub repository search answer without a key. OpenAlex refused anonymous search as rate-limited. |
| Patent full text | Live requests, 2026-11-10 | A Google Patents page carries abstract, claims, description, citations in both directions and a "similar documents" list. Undocumented, like the search endpoint. |
| Trademark basis and specimens | USPTO filing basis page; USPTO specimens page | Use in commerce needs dates of first use and a specimen per class; an intent-to-use application registers only after an allegation of use. A specimen is a real example of use; mock-ups and draft pages are refused; a webpage specimen carries its URL and access date. |

### Other patent and trademark MCP servers, surveyed 2026-11-10

None was run with an account. What is said here comes from their own listings, plus one unauthenticated request to each endpoint.

| Server | What it offers | Access |
|---|---|---|
| GleanMark | USPTO trademark register search, similar-mark and clearance tools | Name search open without sign-in; the rest needs an account. Patty uses the open search. |
| Clarivate CompuMark, Haloo | Trademark knockout and clearance | Sign-in required. Not tested. |
| Clerq, Patlytics, Solve Intelligence, IP Author | Similar-patent search, non-patent literature, patentability triage, claim charts | Sign-in required. Built for law firms and in-house teams; no published individual price found. Not tested. |
| PQAI (projectpq.ai) | Semantic patent search API | Paid plan required for API access. Patty can now use it with your own token. Not tested with one. |
| `patents-mcp-server` (open source, MIT) | USPTO data portal, EPO, and full-text search through Google BigQuery | Needs your own USPTO key, EPO key and Google Cloud project. Its README puts one broad full-text query at 200 to 300 GB against a 1 TB monthly free tier. Not tested. |

None of these reads a codebase, and none ties its conclusions to quotes that are checked.

### Not checked

- Patent Center and Trademark Center themselves. Both need a signed-in, identity-verified account. The steps follow the published guide, not the live screens.
- Whether Patent Center accepts these PDFs. They have embedded fonts and a 1.6 header and were rendered and read back locally, but none was uploaded, and no PDF/A validator was run.
- The USPTO Open Data Portal, EPO OPS and PQAI with a real key. Each was built from its published documentation and tested against responses shaped like it; see Limits.
- The USPTO TSDR API. From USPTO pages it looks up a mark's status by serial number with a key; it is not a name search. Not tested.
- Micro and small entity rules. The documents link to them and leave the certification to the filer.
- The class numbers and identification wording suggested in `TM_FIELDS.md`. They are starting points to look up in the Trademark ID Manual.
- "Revised Inventorship Guidance for AI-Assisted Inventions", 90 FR 54636, 28 November 2025. It exists and replaces the February 2024 guidance; only its abstract was read. It bears on who is named as an inventor, which this tool leaves to the human.
- Anything outside the United States.

## Tested

- `patty_sources` with `test: true`, live, no keys set: the direct patent pages, arXiv, GitHub and GleanMark each answered; SerpApi, the USPTO Open Data Portal, EPO OPS and PQAI reported no key.
- With made-up keys for the USPTO, EPO and PQAI (2026-11-11), live: a search reported each of the three as refused on its own line (HTTP 403, 401 and 401), an EP fetch, refused by OPS, went on to Google Patents and reported both failures, `patty_sources` reported each test as failed, and no key appeared in any output. That exercises the error paths only; no real key has been used.
- `bun test`: 54 tests on a small sample cache repository, no network. They cover the repo map, each figure type, every failure the check is meant to catch, the prior art chart rules (a quote not in the reference, a reference never fetched, a knockout reported as anything else), the build refusing a failing packet, the PDF header and fonts, the order of the last filing steps, date arithmetic, and the offline paths of the two searches. The claim chart tests cover a paraphrased element, an uncharted independent claim, a bad code citation, a result that contradicts its rows, and a report that never says "clear".
- `bun run typecheck`: strict TypeScript.
- Figure port: six existing figures (two hand-placed diagrams, four flowcharts) were re-expressed as figure JSON and rendered; each matched the original element for element. One deliberate difference: double-headed arrows now point outward at both ends.
- The check was run against an existing hand-written provisional draft. It found one placeholder and six reference numerals that were in the figures and never in the text.
- PDFs were rendered to images and looked at. That is how a font subsetting fault was caught: letters went missing on the page while the text layer still read correctly. Fonts are embedded whole for that reason.
- End to end: a fresh Claude Code session in a copy of a real repository of about 17,000 lines, given only "patent this repo", produced a packet in 34 turns that passes `patty_check` (8 evidence entries, 53 citations, 6 figures) and ends at `FILING_STEPS.md`. The patent search was switched off for that run.
- `patty_start` on a git repository with two remotes: the public one was reported public, the other not, and a token embedded in a remote URL did not appear in the output.
- `patty_prior_art`: a live query returned titled, linked results; with the endpoint pointed at a closed port the file said "Search unavailable" and the tool did not fail.
- End to end with search on (2026-11-10): a fresh session on a 39-line sample cache repository searched in rounds, fetched ten references, and wrote a chart of three mechanisms against four references with 21 checked quotes. Each mechanism came back with a close reference and a narrow difference, and the session reported the differences as thin. Three follow-up fetches failed with HTTP 503 and GitHub search was rate-limited on four of eight queries; both now retry or say so.
- Build-around, end to end (2026-11-10): a fresh session asked to build around a real, active cache-eviction patent on the sample repository fetched it, charted all four independent claims (27 code citations), found no claim with every element in the code, singled out the one claim that was close and why, and listed three options with what each costs. 13 turns, about 2 minutes.
- `patty_prior_art` fetch: a patent (87,000 characters, with 25 similar documents and its citations), an arXiv paper (abstract) and a GitHub repository (README) were each stored and listed.
- `patty_tm_check` on "Argyle": reported two registered ARGYLE marks and one pending in software classes from the register, the existing company at argyle.com, and eight registered domains.

## Limits

- Software inventions only. The codebase is the disclosure.
- US provisional patent applications and US trademark applications. No non-provisional claim drafting, no design applications (a design cannot be filed as a provisional), no foreign filings.
- No submission, signing or payment, by design. No hosted version, accounts or billing.
- The prior art search is keyword search through an unofficial patent endpoint, arXiv and GitHub. Retrieval is the weak point: a reference the search never surfaces is never charted. It does not reach products, documentation, or code that is not on GitHub. Papers are stored as abstracts and repositories as READMEs.
- The claim chart is a literal reading of the claims named, against this repo. It does not cover equivalents, other patents or pending applications of the same owner, or patents outside the US. Status and expiration come from Google Patents and are unverified. With a USPTO key, the stored patent also carries the USPTO's own application status; it does not show maintenance fees paid or an expiration date. Design patents are not handled: their claim is the drawings.
- Without a key, the patent source throttles. On a real run of 21 queries in six minutes, Google Patents began answering 503 after the first eight and refused every full-text fetch, so no patent was charted; it was still refusing an hour later. Requests are spaced per source and a refusal is reported as such, but the keyless route is not dependable for a real run. The SerpApi route is the fix. It was written from SerpApi's published response format and its parsers are tested against that format; **it has not been run with a live key.**
- The USPTO Open Data Portal route (status lookup and search) was written from the portal's published OpenAPI files and is tested against responses shaped like them; **it has not been run with a live key.** Its search is a keyword match over application data, not claims or full text.
- The EPO OPS route (search, and EP and WO full text) was written from the OPS reference guide and its XML schemas and is tested against responses shaped like them; **it has not been run with a live key and secret.** The claims parser handles the two layouts the schema allows, one element per claim and one block of numbered text; a third layout would show up as a reference with no claims, which is refused and falls back to Google Patents. OPS has no US full text, and a reference read from it carries no citations, similar documents or legal status.
- The PQAI route was written from PQAI's API guide and, for the fields of each result, its open-source server code; **it has not been run with a live token.** The hosted service could return fields the open-source server does not.
- The chart can show that something is not new. It cannot show that something is new, and it says nothing about obviousness or subject-matter eligibility.
- The trademark knockout sees the register only through a third party's copy, and only for the name as typed.
- Drawings are block diagrams, data tables and flowcharts. Fonts in the PDFs are Tinos and Arimo (SIL Open Font License 1.1, from the `@expo-google-fonts` packages).
- Markdown in the specification is limited to headings, paragraphs, `- ` lists, bold, italic and inline code.

## Development

```bash
bun test
```

```bash
bun run typecheck
```

```bash
bun scripts/call.ts --list
```

`scripts/call.ts` calls one tool over stdio the way a host does: `bun scripts/call.ts patty_check '{"packet_path":"/path/to/patty-packet"}'`.

```
src/index.ts     server, tool and prompt registration
src/method.ts    the drafting method and file-format contract
src/start.ts     patty_start        src/repomap.ts   repo map
src/figures.ts   patty_figures      src/check.ts     patty_check
src/build.ts     patty_build        src/pdf.ts       PDF writers
src/priorart.ts  patty_prior_art    src/tm.ts        patty_tm_check
src/sources.ts   patty_sources      src/keys.ts      where keys are read from
src/references.ts  reference fetching and storage    src/chart.ts  prior art chart rules
src/claimchart.ts  claim chart rules (a patent against this repo)
src/packet.ts    packet folder and STATUS.json
```

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
