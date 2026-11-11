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
3. Call patty_prior_art with 3 to 6 queries, one per strong mechanism, phrased the way a
   patent would phrase it. Read what comes back; if something is close, say so in
   PRIOR_ART.md under "Notes" and make sure the specification describes the difference.
4. Write patty-packet/SPECIFICATION.md (format below).
5. Call patty_figures with one figure per drawing.
6. Call patty_check. Fix every error it reports and call it again until it passes.
7. Call patty_build. Pass what the human has told you (inventors, first public
   disclosure). Do not invent any of it; leave out what you do not know.
8. Tell the human what is in the packet, what you could not verify, and that
   FILING_STEPS.md is theirs to follow. Stop there.

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

export const PROMPT_PATENT_THIS_REPO = (repo: string) => `Patent this repo with Patty${repo ? ` (repo: ${repo})` : ""}.

Work through the Patty tools in this order and do not skip the check:
1. patty_start with kind "provisional". Read the method it returns and follow it.
2. Read the source code. Write patty-packet/EVIDENCE.md, strongest mechanism first.
3. patty_prior_art with a query per strong mechanism.
4. Write patty-packet/SPECIFICATION.md.
5. patty_figures for the drawings.
6. patty_check, fix, repeat until it passes.
7. patty_build.

Then tell me what the packet covers, strongest first, what you could not verify, and what
is left for me. I sign, pay and submit myself; do not do any of that for me.`;
