# patty-mcp

Last updated: 2026-11-08 · version 0.1.0 · not published

A local MCP server for software inventions. It reads a repository with you and prepares two kinds of filing packet: a US provisional patent application and a US trademark application. You approve the packet, then sign, pay and submit in your own USPTO account. The server never signs, submits or pays.

**Patty prepares documents for you to file yourself. It is not a law firm and this is not legal advice.**

## How it works

The MCP host (Claude Code, Cursor, Codex) does the reading and the writing. The server supplies the method, the file formats, the drawings, the checks and the filing copies.

1. `patty_start` returns the drafting method and a map of the repo.
2. The host reads the code and writes `EVIDENCE.md`: each mechanism with `file:line` citations.
3. The host writes `SPECIFICATION.md` from the evidence, and calls `patty_figures` for the drawings.
4. `patty_check` opens every cited line, compares every reference numeral, and fails the packet on placeholders and limiting language.
5. `patty_build` writes the PDFs, the cover sheet worksheet, the docket and the filing steps. It will not run until the check passes.

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

Then, in any software repo, say "patent this repo", or run the `patent-this-repo` prompt (in Claude Code: `/mcp__patty__patent-this-repo`).

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `patty_start` | `repo_path`, `kind` (`provisional` or `trademark`), `check_remotes` | Creates `patty-packet/` in the repo and adds it to `.gitignore` when the repo is under git. Returns the drafting method and a repo map: source files with sizes and languages, entry points, first and last commit dates, remotes and whether each answers an anonymous request, tags. |
| `patty_prior_art` | `queries[]`, `packet_path` | Searches patents for each query and writes `PRIOR_ART.md` with titled, linked results. A failed search is written as "Search unavailable" and does not block the packet. |
| `patty_figures` | `figures[]`, `packet_path` | Renders SVG drawings from JSON: `flow` (flowchart with decisions, side boxes, rejoin and loop-back arrows), `block` (boxes and data tables on a grid, arrows routed), `canvas` (exact coordinates). Black on white, reference numerals, one figure per file. Returns each figure's numerals and layout warnings. |
| `patty_check` | `packet_path` | The lint. See below. |
| `patty_build` | `packet_path`, optional `inventors`, `first_public_disclosure`, `nothing_public_yet`, `filed` | Runs the check, then writes `specification.pdf`, `drawings.pdf`, `COVER_SHEET.md`, `FILING_STEPS.md`, `DOCKET.md`. Facts not supplied are marked for the human; none are guessed. |
| `patty_tm_check` | `mark`, `goods_services`, `packet_path` | Trademark knockout: exact-name domain registrations and what they serve, same-name packages and accounts, Wikipedia. Writes `TM_KNOCKOUT.md` and `TM_FIELDS.md`. Does not search the USPTO register. |

`packet_path` defaults to `patty-packet/` in the folder the server was started in.

## The packet

```
patty-packet/
  EVIDENCE.md          each mechanism, with file:line citations into the repo   (host writes)
  SPECIFICATION.md     the disclosure                                           (host writes)
  figures/*.svg        drawings; figures/source.json keeps the JSON they came from
  PRIOR_ART.md         what the search found, with links
  specification.pdf    filing copy
  drawings.pdf         filing copy
  COVER_SHEET.md       every field the filer types into the USPTO form
  FILING_STEPS.md      numbered steps for the human, ending in sign, submit, pay
  DOCKET.md            first public disclosure, grace limit, twelve-month date
  STATUS.json          what is done, what is waiting on the human
  TM_KNOCKOUT.md, TM_FIELDS.md   trademark packet
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

`SPECIFICATION.md` uses the headings Title, Field, Background, Summary, Brief Description of the Drawings, Detailed Description (with sections numbered `### 1. Name`), Example Claims, Abstract. Reference numerals are whole numbers from 100 up. The full contract, with the figure JSON, is the text in `src/method.ts`, which `patty_start` returns.

## What `patty_check` checks

Fails the packet when:

- a numbered section of the Detailed Description (other than Variations) has no evidence entry with a citation that verifies;
- a cited file or line does not exist, the path leaves the repo, or the cited text is not on the cited line;
- a reference numeral is in the Detailed Description and in no figure, or in a figure and never in the text;
- the text refers to a figure that does not exist, or a figure has no line in the Brief Description of the Drawings;
- a placeholder remains (`[CITY]`, `TODO`, `TBD`, `____`, `{{...}}`);
- limiting language appears: "the invention is", "the present invention", "must", "essential", "critical", "always";
- a required section is missing or empty.

Warns on an abstract over 150 words, a title over 500 characters, text above the first heading, an inventor section in the specification, and missing claims or variations.

What it does not do: it does not judge whether the specification says only what the evidence supports, whether the description is accurate, or whether anything is new. Telling a quantity from a reference numeral is a heuristic: a number of 100 or more counts as a quantity when "for example", "about" or a similar word comes before it, or a unit such as "characters" or "ms" comes after it. "critical" also fails in "critical section"; reword.

## Network use

The server sends no source code anywhere and has no telemetry. It makes these requests, and no others:

| Tool | Request | What is sent |
|---|---|---|
| `patty_start` | Each git remote's host, `info/refs`, anonymously | The remote URL with credentials removed. Skip with `check_remotes: false`. |
| `patty_prior_art` | `patents.google.com` | The query text. |
| `patty_tm_check` | `data.iana.org`, the registry RDAP server for each domain, DNS, the candidate domains' own home pages, `registry.npmjs.org`, `pypi.org`, `crates.io`, `api.github.com`, `en.wikipedia.org` | The mark, as a name. |

`PATTY_OFFLINE=1` turns every request off; the affected files then say "search unavailable". `PATTY_PATENT_SEARCH_URL` points the patent search at another endpoint with the same response shape.

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
| Trademark search | `tmsearch.uspto.gov` | A web application. No public search API is documented on it. |
| Trademark basis and specimens | USPTO filing basis page; USPTO specimens page | Use in commerce needs dates of first use and a specimen per class; an intent-to-use application registers only after an allegation of use. A specimen is a real example of use; mock-ups and draft pages are refused; a webpage specimen carries its URL and access date. |

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

- `bun test`: 24 tests on a made-up cache repository, no network. Covers the repo map, each figure type, every failure the check is meant to catch, the build refusing a failing packet, the PDF header and fonts, the order of the last filing steps, date arithmetic, and the offline paths of the two searches.
- `bun run typecheck`: strict TypeScript.
- Figure port: six existing figures (two hand-placed diagrams, four flowcharts) were re-expressed as figure JSON and rendered; each matched the original element for element. One deliberate difference: double-headed arrows now point outward at both ends.
- The check was run against an existing hand-written provisional draft. It found one placeholder and six reference numerals that were in the figures and never in the text.
- PDFs were rendered to images and looked at. That is how a font subsetting fault was caught: letters went missing on the page while the text layer still read correctly. Fonts are embedded whole for that reason.
- End to end: a fresh Claude Code session in a copy of a real repository of about 17,000 lines, given only "patent this repo", produced a packet in 34 turns that passes `patty_check` (8 evidence entries, 53 citations, 6 figures) and ends at `FILING_STEPS.md`. The patent search was switched off for that run.
- `patty_start` on a git repository with two remotes: the public one was reported public, the other not, and a token embedded in a remote URL did not appear in the output.
- `patty_prior_art`: a live query returned titled, linked results; with the endpoint pointed at a closed port the file said "Search unavailable" and the tool did not fail.
- `patty_tm_check` on "Argyle": reported the existing company at argyle.com and eight registered domains.

## Limits

- Software inventions only. The codebase is the disclosure.
- US provisional patent applications and US trademark applications. No non-provisional claim drafting, no design applications (a design cannot be filed as a provisional), no foreign filings.
- No submission, signing or payment, by design. No hosted version, accounts or billing.
- The prior art search is a keyword search of patents through an unofficial endpoint. It is not a patentability search and does not cover papers, products or repositories.
- The trademark knockout cannot see the USPTO register.
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
src/packet.ts    packet folder and STATUS.json
```

## Open decisions

- Package and repository name.
- License. None is set; `package.json` is marked private.
- No example packet is included. A packet describes an invention, and an unfiled one does not belong in a public repository.
