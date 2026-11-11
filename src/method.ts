import { DISCLAIMER } from "./packet.ts";

// The drafting method patty_start returns. The host model reads the code and writes
// the packet files; the tools draw, lint and build.
export const PROVISIONAL_METHOD = `# Patty: drafting method for a US provisional patent application (software)

${DISCLAIMER}

You (the host model) read the code and write the packet files. Patty's tools draw the
figures, lint the packet and build the filing copies. The human reads and approves the
packet, then signs, pays and submits in their own USPTO account. You never sign, submit
or pay, and you do not operate a USPTO account for them.

## Method
1. Read the code before any pitch, README or marketing. Mechanisms live in code;
   examiners reject ideas and allow mechanisms.
2. Hunt for the non-obvious: data structures with invariants, indexes, one-directional
   rules, thresholds, reconciliation logic, anything with a comment explaining why. The
   strongest mechanism is often a function no pitch mentions.
3. Write EVIDENCE.md first: each mechanism in two sentences with file:line. The
   specification may only state what the evidence supports.
4. Describe what the code does in general terms, then give the code's real numbers as
   examples ("for example six tokens").
5. Use "in some embodiments". Never "the invention is". Never "must".
6. Give every component and step a reference numeral and use it in both text and figure.
7. End the description with a variations section: other values, other data types, other
   placements.
8. Include a few illustrative claims and an abstract. A provisional does not need claims;
   they help whoever writes the non-provisional.
9. Lead the summary with the strongest mechanism, not the product frame.
10. State facts about dates and status as known or unverified. Never guess a filing date,
    a fee or a deadline.

## Order of work
Pass packet_path (the packet folder reported at the top of this message) to every Patty tool.
1. Read the repo map below, then read the source files themselves, largest and most
   central first. Read whole files, not excerpts, for anything you will cite.
2. Write patty-packet/EVIDENCE.md (format below). Rank mechanisms strongest first.
3. Search for prior art, in rounds, before you write the specification:
   a. Call patty_prior_art with queries: two or three per strong mechanism, each phrased
      the way a patent or paper would describe it, in different words each time. Describe
      the general mechanism; do not send product names or code.
   b. Call patty_prior_art with fetch: the publication numbers or URLs of the closest
      results. Each fetched patent comes back with its similar documents and citations.
   c. Chase: fetch the most promising of those. The closest reference is usually one or
      two steps from the first hit. Stop when a round turns up nothing closer.
   d. Read each fetched file under references/: abstract and claims first, then search
      the description for each element.
   e. Write patty-packet/PRIOR_ART_CHART.md (format below). Be hard on your own
      mechanism: if a reference has the element in other words, that is a "yes".
   If a mechanism is knocked out, do not lead with it. Build the specification around
   what the closest references lack, and say what that difference is.
   If the search was unavailable, say so to the human and carry on without a chart.
4. Write patty-packet/SPECIFICATION.md (format below).
5. Call patty_figures with one figure per drawing.
6. Call patty_check. Fix every error it reports and call it again until it passes.
7. Call patty_build. Pass what the human has told you (inventors, first public
   disclosure). Do not invent any of it; leave out what you do not know.
8. Tell the human what is in the packet, the result for each mechanism in the prior art
   chart (knocked out, closest reference and difference, or nothing close found), what
   you could not verify, and that FILING_STEPS.md is theirs to follow. Stop there.

## EVIDENCE.md format (patty_check parses this)
\`\`\`
# Evidence

## E1. Short name of the mechanism
Spec: 3, 7
Two sentences: what the code does and why it is not the obvious way.
- src/cache.ts:41 | if (entry.expires < now) {
- src/cache.ts:88-120 | function evict(
\`\`\`
- "Spec:" lists the numbered sections of the Detailed Description this entry supports.
  Every numbered section except Variations needs at least one entry.
- Each citation is \`- path:line | text\` or \`- path:start-end | text\`. The path is
  relative to the repo root. The text after " | " is copied from the cited line or range;
  patty_check opens the file and fails the packet if the text is not there. Whitespace
  differences are ignored, nothing else is.
- Every entry needs at least one citation.

## PRIOR_ART_CHART.md format (patty_check parses this)
\`\`\`
# Prior art chart

## M1. Short name of the mechanism
Evidence: E1
- A. First element, one plain clause.
- B. Second element.
- C. Third element.

### US10013501B2
- A: yes | words copied from the reference that show it has A
- B: partly | words copied from the reference
- C: no

### arxiv-2401.01234
- A: yes | words copied from the reference
- B: no
- C: no

Result: closest US10013501B2; differs in B, C
Protect: yes | a competitor matching this feature would have to do B, and B shows in the product's behaviour
\`\`\`
- Break each mechanism into 2 to 6 elements. An element is one thing the code does that a
  reference either has or lacks.
- A reference heading is the name patty_prior_art gave it when it was fetched. Only
  fetched references can be charted.
- Every element gets a row under every reference: "yes | quote", "partly | quote" or "no".
  The quote is copied from the stored reference text; patty_check fails the packet if the
  words are not there. A "no" is your reading of the whole reference; say "no" only after
  searching the file for the element in other words.
- Result is one of exactly three forms:
  "Result: knocked out by <reference>" when one reference has every element;
  "Result: closest <reference>; differs in B, C";
  "Result: nothing close found".
- Protect is your call on whether the mechanism is worth the cost of protecting: "yes",
  "maybe" or "no", then the reason. Weigh four things. Does a real difference survive
  the chart, or is it a small variation? Would a competitor have to copy this to match
  the product? Could the owner tell from outside that someone had copied it (if not, a
  trade secret may serve better than a patent)? Is it likely to stay in the product? A
  knocked-out mechanism is "no". The human can overrule it; say what you weighed.
- If the closest reference is a patent that is still in force and the code does what
  its claims say, tell the human, and offer to chart its claims against the code (the
  build-around workflow: patty_start with kind "clearance").
- Chart every evidence entry. Never write that a mechanism is novel or patentable. The
  chart says what was found and how it differs; a search that finds nothing is not a
  clearance.

## SPECIFICATION.md format (patty_check parses this)
Use these second-level headings, in this order:
\`\`\`
# PROVISIONAL APPLICATION FOR PATENT
## Title
## Cross-Reference to Related Applications
## Field
## Background
## Summary
## Brief Description of the Drawings
## Detailed Description
### 1. System overview (FIG. 1)
### 2. ...
### N. Variations
## Example Claims
## Abstract
\`\`\`
- Number the sections of the Detailed Description "### 1. Name". EVIDENCE.md refers to
  these numbers.
- "Brief Description of the Drawings" has one line per figure: "- FIG. 1 is ...".
- Reference numerals are whole numbers from 100 up. Figure 1 uses 100 to 199, figure 2
  uses 200 to 299, and so on. Write the numeral straight after the name of the part or
  after "step": "a document store 102", "steps 306 and 307", "steps 308 to 316". Every
  numeral in a figure appears in the Detailed Description and the reverse.
- Write quantities so they cannot be mistaken for numerals: "for example 300 characters",
  "about 300 words". A bare number of 100 or more with no "for example" or "about" before
  it and no unit after it is read as a reference numeral.
- Do not put inventor names, addresses or dates in the specification. Those go on the
  cover sheet, which patty_build writes from what the human tells you.
- No placeholders ("[CITY]", "TODO", "TBD"). If a fact is unknown, leave the sentence out.
- No limiting language: "the invention is", "the present invention", "must", "essential",
  "critical", "always". Use "in some embodiments", "may", "for example".
- Keep the abstract to 150 words or fewer.

## Figures (patty_figures)
One JSON object per figure. All figures are black on white, one figure per file.
- flow: a flowchart laid out for you.
  { "number": 3, "type": "flow", "steps": [
    { "n": "300", "text": "Receive request", "back_to": null },
    { "n": "302", "decision": true, "text": "Quoted text still\\npresent?",
      "side": { "n": "303", "text": "Mark conflict" }, "side_label": "no", "down_label": "yes",
      "rejoin": "306" },
    { "n": "304", "text": "Apply" }, { "n": "306", "text": "Record event" } ] }
  A decision's "side" box hangs to the right. "rejoin" names the later step the side box
  flows back into. "back_to" on a step draws a loop arrow up the left side to an earlier
  step. Break long text with \\n; lines are also wrapped for you.
- block: boxes and data tables on a grid, with arrows routed for you.
  { "number": 1, "type": "block",
    "nodes": [ { "id": "store", "text": "Document store", "num": "102", "col": 0, "row": 0 },
               { "id": "gate", "text": "Apply gate", "num": "114", "col": 1, "row": 0 },
               { "id": "rec", "title": "Record", "num": "120", "col": 0, "row": 1,
                 "rows": [["id", ""], ["version counter", "122"]] } ],
    "frames": [ { "text": "CLIENT", "num": "100", "cols": [0, 1], "rows": [0, 1] } ],
    "edges": [ { "from": "gate", "to": "store", "label": "spans" } ],
    "notes": ["Optional caption lines under the drawing"] }
  A node with "rows" is drawn as a data table: each row is [field, numeral or ""].
  "colspan" and "rowspan" make a node cover several cells. "both": true on an edge draws
  heads at both ends. "dash": true draws a dashed outline.
- canvas: exact coordinates, for a drawing the other two cannot lay out.
  { "number": 2, "type": "canvas", "width": 816, "height": 760, "items": [
    { "box": [60, 60, 200, 70], "text": "Name", "num": "200" },
    { "diamond": [300, 200, 240, 80], "text": "Test?", "num": "202" },
    { "table": [60, 300, 300], "title": "Span", "num": "204", "rows": [["text", "206"]] },
    { "arrow": [[160, 130], [160, 300]], "label": "contains", "label_at": [195, 220] },
    { "text": "caption", "at": [408, 640], "size": 11 } ] }
patty_figures returns warnings (text wider than its box, an arrow crossing a box). Fix
them and call it again; the files are overwritten.

## What the human has to supply
Ask once, plainly, and carry on with the drafting while you wait:
- the legal name and residence (city, state or country) of every inventor;
- the first date anything about this was public (a deploy, a public repo, a post, a talk,
  a demo to people not under confidence), and whether anything was sold or offered;
- whether they qualify as a micro or small entity (they certify this themselves).
If they have not answered, leave those fields out. patty_build marks them for the human
on the cover sheet. Never fill them from a guess, from git config or from a README.
`;

export const CLEARANCE_METHOD = `# Patty: building around someone else's patent

${DISCLAIMER}

The human has named one or more patents. Your job is to show, claim by claim, what this
repo does and does not do of what each patent claims, and where a change would take a
whole element out. You never write that the code is clear, safe or non-infringing. You
write what was found, element by element, and what was not checked.

How a claim works: a product is covered by a claim only if it has every element of that
claim. Take one whole element out and that claim is not literally met. Dependent claims
add elements to an independent claim, so a product that avoids an independent claim
avoids its dependents. Every independent claim has to be avoided separately.

## Order of work
Pass packet_path (the packet folder reported at the top of this message) to every Patty tool.
1. Call patty_prior_art with fetch: the publication numbers the human named. Each stored
   file starts with the patent's status, expiration, owner and its independent claims.
2. Tell the human at once if a patent is listed as expired, abandoned or only a pending
   application, or is not a US patent. Status comes from Google Patents and is
   unverified; the human confirms it at the USPTO.
3. Read the claims in references/, then the description for how the patent uses each
   term. Read the repo code that does the same job.
4. Write patty-packet/CLAIM_CHART.md (format below), one section per independent claim.
5. Call patty_check. Fix every error and call it again until it passes.
6. For each claim where every element was found, or where the only "no" is thin, write
   options under a "## Options" heading in CLAIM_CHART.md: for each, which element it
   removes, what the code would do instead, and what the product loses. Prefer removing
   an element outright over swapping in a close substitute: a court can treat a close
   substitute as the element. A better design that does not need the element at all is
   the strongest answer.
7. Call patty_build. It writes CLEARANCE_REPORT.md for the human.
8. Tell the human, per patent and per claim: every element found, or which elements were
   not found and why; the options; and what was not checked. Stop there.
If the human then changes the code, run steps 3 to 7 again: the chart is of the code as
it is, and citations are re-checked every time.
If the human is designing something new and there is no code yet, chart the planned
design: mark an element "no" with the design decision that avoids it, and say plainly
that the chart describes a plan, not code.

## CLAIM_CHART.md format (patty_check parses this)
\`\`\`
# Claim chart

## US10013501B2 claim 1
- A. maintaining, by a computing system, a multi-tenant data store that stores data for a plurality of tenants
- B. maintaining, by the computing system, an in-memory cache for the multi-tenant data store
- C. receiving, by the computing system, a store request to store data in an entry of the in-memory cache

- A: no | there is one store for one user; nothing in src/ carries a tenant identifier
- B: partly | src/cache.ts:4 | const store = new Map<string, Entry>();
- C: yes | src/cache.ts:18 | export function put(key: string, value: string, now: number, ttl: number) {

Result: not found in the code: A

## Options
Free text: what could change, which element it removes, what it costs.
\`\`\`
- One section per independent claim, headed "## <publication number> claim <n>".
- Elements are the claim's own words, copied from the stored patent; patty_check fails a
  paraphrase. Split the whole claim, preamble included; leave nothing out.
- Every element gets a row: "yes | path:line | code text" or "partly | path:line | code
  text" when the code does it, "no | reason" when it does not. Citations are opened and
  compared, like EVIDENCE.md. When unsure between partly and no, write partly.
- Result is one of exactly two forms: "Result: every element found in the code", or
  "Result: not found in the code: A, D" naming every element marked no. A partly counts
  as found.
- Read each term the way the patent's description uses it, not the narrowest way.
`;

export const TRADEMARK_METHOD = `# Patty: method for a US trademark application packet

${DISCLAIMER}

1. Call patty_tm_check with the mark and a plain description of the goods or services
   ("downloadable software for ...", "online software for ..."). Pass packet_path if the
   packet is not in the current folder.
2. Read TM_KNOCKOUT.md with the human. A knockout only finds the obvious conflicts; it is
   not a clearance search and it cannot see the USPTO register. The human runs the USPTO
   trademark search themselves through the link in the file.
3. Go through TM_FIELDS.md with the human: owner, filing basis, class, identification
   wording, specimen. Fill in only what they tell you.
4. The human files in their own USPTO account. They sign, pay and submit. You never do.
`;

export const PROMPT_BUILD_AROUND = (patents: string, repo: string) => `Help me build around ${patents || "a patent"} with Patty${repo ? ` (repo: ${repo})` : ""}.

1. patty_start with kind "clearance". Read the method it returns and follow it.
2. patty_prior_art with fetch: the patent numbers. Tell me each one's status, expiration and owner first.
3. Chart every independent claim against my code in patty-packet/CLAIM_CHART.md.
4. patty_check until it passes, then patty_build.

Then tell me, claim by claim, which elements my code has and which it does not, the options for
taking a whole element out, and what you did not check. Do not tell me I am clear or safe.`;

export const PROMPT_PATENT_THIS_REPO = (repo: string) => `Patent this repo with Patty${repo ? ` (repo: ${repo})` : ""}.

Work through the Patty tools in this order and do not skip the check:
1. patty_start with kind "provisional". Read the method it returns and follow it.
2. Read the source code. Write patty-packet/EVIDENCE.md, strongest mechanism first.
3. patty_prior_art in rounds: search, fetch the closest references, chase their similar
   documents and citations. Then write patty-packet/PRIOR_ART_CHART.md.
4. Write patty-packet/SPECIFICATION.md around what the closest references lack.
5. patty_figures for the drawings.
6. patty_check, fix, repeat until it passes.
7. patty_build.

Then tell me what the packet covers, strongest first, what the prior art chart found for
each mechanism, what you could not verify, and what is left for me. I sign, pay and submit myself; do not do any of that for me.`;
