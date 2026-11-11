# patty-mcp

Last updated: 2026-11-10 · version 0.3.0 · not published

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

Needs [bun](https://bun.sh) 1.1 or later. Built and tested on bun 1.4.2, macOS. Node is not required.

```bash
bun install
```

```bash
claude mcp add patty -- bun "$PWD/src/index.ts"
```

Add `--scope user` to have it in every project. Any other MCP host takes the same stdio command:

```json
{ "mcpServers": { "patty": { "command": "bun", "args": ["/absolute/path/to/patty-mcp/src/index.ts"] } } }
```

Then, in any software repo, say "patent this repo" or "help me build around US1234567B2". The two prompts do the same: `patent-this-repo` and `build-around` (in Claude Code: `/mcp__patty__patent-this-repo`, `/mcp__patty__build-around`).

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `patty_start` | `repo_path`, `kind` (`provisional`, `clearance` or `trademark`), `check_remotes` | Creates `patty-packet/` in the repo and adds it to `.gitignore` when the repo is under git. Returns the drafting method and a repo map: source files with sizes and languages, entry points, first and last commit dates, remotes and whether each answers an anonymous request, tags. |
| `patty_prior_art` | `queries[]`, `fetch[]`, `packet_path` | `queries`: searches patents (Google Patents), papers (arXiv) and repositories (GitHub) and adds titled, linked results to `PRIOR_ART.md`. `fetch`: reads references in full (publication numbers or URLs), stores them under `references/` and returns each patent's similar documents and citations. A failed search is written as "Search unavailable" and does not block the packet. |
| `patty_figures` | `figures[]`, `packet_path` | Renders SVG drawings from JSON: `flow` (flowchart with decisions, side boxes, rejoin and loop-back arrows), `block` (boxes and data tables on a grid, arrows routed), `canvas` (exact coordinates). Black on white, reference numerals, one figure per file. Returns each figure's numerals and layout warnings. |
| `patty_check` | `packet_path` | The lint. See below. |
| `patty_build` | `packet_path`, optional `inventors`, `first_public_disclosure`, `nothing_public_yet`, `filed` | Runs the check. For a clearance packet, writes `CLEARANCE_REPORT.md`. For a provisional packet, writes `specification.pdf`, `drawings.pdf`, `COVER_SHEET.md`, `FILING_STEPS.md`, `DOCKET.md`. Facts not supplied are marked for the human; none are guessed. |
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
| `patty_prior_art` | `patents.google.com`, `export.arxiv.org`, `api.github.com`; for `fetch`, the reference's own page | The query text; for `fetch`, the publication number or URL. |
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
| PQAI (projectpq.ai) | Semantic patent search API | Account required. Its pricing page lists a free plan with 20 API calls a month. Not tested. |
| `patents-mcp-server` (open source, MIT) | USPTO data portal, EPO, and full-text search through Google BigQuery | Needs your own USPTO key, EPO key and Google Cloud project. Its README puts one broad full-text query at 200 to 300 GB against a 1 TB monthly free tier. Not tested. |

None of these reads a codebase, and none ties its conclusions to quotes that are checked.

### Not checked

- Patent Center and Trademark Center themselves. Both need a signed-in, identity-verified account. The steps follow the published guide, not the live screens.
- Whether Patent Center accepts these PDFs. They have embedded fonts and a 1.6 header and were rendered and read back locally, but none was uploaded, and no PDF/A validator was run.
- The USPTO Open Data Portal search API. A key needs a USPTO.gov account with ID.me verification, and its documentation page did not render in a headless browser, so nothing is wired to it. It is the official candidate for a primary source once a key exists.
- The USPTO TSDR API. From USPTO pages it looks up a mark's status by serial number with a key; it is not a name search. Not tested.
- Micro and small entity rules. The documents link to them and leave the certification to the filer.
- The class numbers and identification wording suggested in `TM_FIELDS.md`. They are starting points to look up in the Trademark ID Manual.
- "Revised Inventorship Guidance for AI-Assisted Inventions", 90 FR 54636, 28 November 2025. It exists and replaces the February 2024 guidance; only its abstract was read. It bears on who is named as an inventor, which this tool leaves to the human.
- Anything outside the United States.

## Tested

- `bun test`: 40 tests on a made-up cache repository, no network. The claim chart tests cover a paraphrased element, an uncharted independent claim, a bad code citation, a result that contradicts its rows, and a report that never says "clear". Covers the repo map, each figure type, every failure the check is meant to catch, the prior art chart rules (a quote not in the reference, a reference never fetched, a knockout reported as anything else), the build refusing a failing packet, the PDF header and fonts, the order of the last filing steps, date arithmetic, and the offline paths of the two searches.
- `bun run typecheck`: strict TypeScript.
- Figure port: six existing figures (two hand-placed diagrams, four flowcharts) were re-expressed as figure JSON and rendered; each matched the original element for element. One deliberate difference: double-headed arrows now point outward at both ends.
- The check was run against an existing hand-written provisional draft. It found one placeholder and six reference numerals that were in the figures and never in the text.
- PDFs were rendered to images and looked at. That is how a font subsetting fault was caught: letters went missing on the page while the text layer still read correctly. Fonts are embedded whole for that reason.
- End to end: a fresh Claude Code session in a copy of a real repository of about 17,000 lines, given only "patent this repo", produced a packet in 34 turns that passes `patty_check` (8 evidence entries, 53 citations, 6 figures) and ends at `FILING_STEPS.md`. The patent search was switched off for that run.
- `patty_start` on a git repository with two remotes: the public one was reported public, the other not, and a token embedded in a remote URL did not appear in the output.
- `patty_prior_art`: a live query returned titled, linked results; with the endpoint pointed at a closed port the file said "Search unavailable" and the tool did not fail.
- End to end with search on (2026-11-10): a fresh session on a made-up 39-line cache repository searched in rounds, fetched ten references, and wrote a chart of three mechanisms against four references with 21 checked quotes. Each mechanism came back with a close reference and a narrow difference, and the session reported the differences as thin. Three follow-up fetches failed with HTTP 503 and GitHub search was rate-limited on four of eight queries; both now retry or say so.
- Build-around, end to end (2026-11-10): a fresh session asked to build around a real, active cache-eviction patent on the made-up repository fetched it, charted all four independent claims (27 code citations), found no claim with every element in the code, singled out the one claim that was close and why, and listed three options with what each costs. 13 turns, about 2 minutes.
- `patty_prior_art` fetch: a patent (87,000 characters, with 25 similar documents and its citations), an arXiv paper (abstract) and a GitHub repository (README) were each stored and listed.
- `patty_tm_check` on "Argyle": reported two registered ARGYLE marks and one pending in software classes from the register, the existing company at argyle.com, and eight registered domains.

## Limits

- Software inventions only. The codebase is the disclosure.
- US provisional patent applications and US trademark applications. No non-provisional claim drafting, no design applications (a design cannot be filed as a provisional), no foreign filings.
- No submission, signing or payment, by design. No hosted version, accounts or billing.
- The prior art search is keyword search through an unofficial patent endpoint, arXiv and GitHub. Retrieval is the weak point: a reference the search never surfaces is never charted. It does not reach products, documentation, or code that is not on GitHub. Papers are stored as abstracts and repositories as READMEs.
- The claim chart is a literal reading of the claims named, against this repo. It does not cover equivalents, other patents or pending applications of the same owner, or patents outside the US. Status and expiration come from Google Patents and are unverified. Design patents are not handled: their claim is the drawings.
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
src/references.ts  reference fetching and storage    src/chart.ts  prior art chart rules
src/claimchart.ts  claim chart rules (a patent against this repo)
src/packet.ts    packet folder and STATUS.json
```

## Open decisions

- Package and repository name.
- License. None is set; `package.json` is marked private.
- No example packet is included. A packet describes an invention, and an unfiled one does not belong in a public repository.
