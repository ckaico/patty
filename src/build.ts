import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bodyOf, check, parseSpec, sectionOf } from "./check.ts";
import { figureFiles } from "./figures.ts";
import { DISCLAIMER, now, readStatus, today, writeStatus } from "./packet.ts";
import { drawingsPdf, specPdf } from "./pdf.ts";

// The date the USPTO pages and rules behind these documents were last read by the maintainer.
export const SOURCES_CHECKED = "2026-11-08";
export const LINKS = {
  patentCenter: "https://patentcenter.uspto.gov/",
  newUsers: "https://www.uspto.gov/patents/apply/applying-online/getting-started-new-users",
  fees: "https://www.uspto.gov/learning-and-resources/fees-and-payment/uspto-fee-schedule",
  forms: "https://www.uspto.gov/patents/apply/forms",
  sb16: "https://www.uspto.gov/sites/default/files/documents/sb0016.pdf",
  sb15a: "https://www.uspto.gov/sites/default/files/documents/sb0015a.pdf",
  micro: "https://www.uspto.gov/patents/laws/micro-entity-status",
  provisional: "https://www.uspto.gov/patents/basics/apply/provisional-application",
  pdfGuide: "https://www.uspto.gov/patents/apply/applying-online/efs-web-pdf-guidelines",
  aiGuidance: "https://www.federalregister.gov/documents/2024/04/11/2024-07629/guidance-on-use-of-artificial-intelligence-based-tools-in-practice-before-the-united-states-patent",
};

export type BuildFacts = {
  inventors?: { name: string; residence: string }[];
  first_public_disclosure?: { date: string; what: string };
  nothing_public_yet?: boolean;
  filed?: { date: string; application_number?: string };
};

function isoDate(s: string, what: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error(`${what}: "${s}" is not a real date in YYYY-MM-DD form.`);
  return s;
}
// Same day one year on; 29 February becomes 28 February.
export function plusOneYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const day = m === 2 && d === 29 ? 28 : d;
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const weekday = (iso: string) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(iso + "T00:00:00Z").getUTCDay()];
const YOU = "**you enter this**";

export async function build(packetPath: string, given: BuildFacts): Promise<string> {
  const packet = resolve(packetPath);
  const result = check(packet);
  if (!result.passed) {
    return `patty_build refused: the packet does not pass patty_check. Fix these and run it again.\n\n${result.report}`;
  }
  const status = readStatus(packet);
  const facts: BuildFacts = { ...((status?.facts as BuildFacts) ?? {}) };
  if (given.inventors?.length) facts.inventors = given.inventors;
  if (given.first_public_disclosure) {
    isoDate(given.first_public_disclosure.date, "first_public_disclosure.date");
    facts.first_public_disclosure = given.first_public_disclosure;
    delete facts.nothing_public_yet;
  }
  if (given.nothing_public_yet) {
    facts.nothing_public_yet = true;
    delete facts.first_public_disclosure;
  }
  if (given.filed) {
    isoDate(given.filed.date, "filed.date");
    facts.filed = given.filed;
  }

  const specMd = readFileSync(join(packet, "SPECIFICATION.md"), "utf8");
  const spec = parseSpec(specMd);
  const title = bodyOf(spec, sectionOf(spec, /^title/i)!).replace(/\s+/g, " ").trim();
  const figs = figureFiles(packet).map((f) => ({ number: f.number, file: f.file, svg: readFileSync(f.path, "utf8") }));

  const sp = await specPdf(specMd, title);
  const dr = await drawingsPdf(figs, title);
  writeFileSync(join(packet, "specification.pdf"), sp.bytes);
  writeFileSync(join(packet, "drawings.pdf"), dr.bytes);
  const warnings = [...sp.warnings, ...dr.warnings];

  // ----- COVER_SHEET.md -----
  const inv = facts.inventors ?? [];
  const told = "as told to Patty; confirm";
  const C: string[] = [
    "# Cover sheet: what you type into the USPTO form",
    "",
    DISCLAIMER,
    "",
    `Prepared ${today()}. Nothing has been filed. This is a worksheet, not the form itself.`,
    "",
    `The form is the Provisional Application for Patent Cover Sheet, PTO/SB/16 (${LINKS.sb16}), or the application data screens in Patent Center, which ask for the same things. The fields are the ones 37 CFR 1.51(c)(1) lists.`,
    "",
    "| Field | What to enter | Where this came from |",
    "|---|---|---|",
    "| Type of application | Provisional application for patent, 35 U.S.C. 111(b) | fixed |",
    `| Title of the invention | ${title} | SPECIFICATION.md |`,
  ];
  if (inv.length) {
    inv.forEach((p, i) => {
      C.push(`| Inventor ${i + 1}: legal name | ${p.name} | ${told} |`);
      C.push(`| Inventor ${i + 1}: residence (city and state, or city and country) | ${p.residence || YOU} | ${p.residence ? told : "not known to Patty"} |`);
    });
  } else {
    C.push(`| Inventor: legal name, for every inventor | ${YOU} | not known to Patty |`);
    C.push(`| Inventor: residence (city and state, or city and country) | ${YOU} | not known to Patty |`);
  }
  C.push(
    `| Correspondence address (or your USPTO customer number) | ${YOU} | not known to Patty |`,
    `| Attorney or agent name and registration number | Leave blank unless a registered practitioner is filing for you | fixed |`,
    `| Docket number | Optional. Any label you choose | optional |`,
    `| U.S. Government agency with a property interest | ${YOU}: answer "No" only if no federal agency or federal contract funded the work | not known to Patty |`,
    `| Entity status | ${YOU}: undiscounted, small or micro. You certify this yourself. Micro entity needs form PTO/SB/15A (${LINKS.sb15a}); read the conditions at ${LINKS.micro} | not known to Patty |`,
    `| Specification: number of pages | ${sp.pages} | counted from specification.pdf |`,
    `| Drawings: number of sheets | ${dr.sheets} | counted from drawings.pdf |`,
    "",
    "Use exactly the same inventor name on every USPTO filing you make. Every person who contributed to the conception of what is described has to be named; a provisional names all of the inventors.",
    "",
  );
  writeFileSync(join(packet, "COVER_SHEET.md"), C.join("\n"));

  // ----- DOCKET.md -----
  const D: string[] = ["# Docket", "", DISCLAIMER, "", `Written ${today()}. Dates are marked with where they came from. A date Patty was told is not a verified date.`, "", "| Event | Date | Basis |", "|---|---|---|"];
  const dis = facts.first_public_disclosure;
  if (dis) {
    const limit = plusOneYear(dis.date);
    D.push(`| First public disclosure | ${dis.date} | As told to Patty, unverified: ${dis.what.replace(/\|/g, "/")} |`);
    D.push(`| Last day to file in the US and still rely on the one-year grace period | ${limit} (${weekday(limit)}) | Computed: one year after the disclosure date above (35 U.S.C. 102(b)(1)). It is only as good as that date. File well before it. |`);
  } else if (facts.nothing_public_yet) {
    D.push(`| First public disclosure | None yet | As told to Patty, unverified |`);
    D.push(`| US grace-period limit | Not running | No disclosure reported. The first public disclosure, sale or offer for sale starts a one-year clock (35 U.S.C. 102(b)(1)). |`);
  } else {
    D.push(`| First public disclosure | **Unknown. You confirm this.** | Patty was not told. |`);
    D.push(`| US grace-period limit | One year after the first public disclosure | Not computed, because the disclosure date is unknown (35 U.S.C. 102(b)(1)). |`);
  }
  if (facts.filed) {
    const due = plusOneYear(facts.filed.date);
    D.push(`| Provisional filed | ${facts.filed.date}${facts.filed.application_number ? `, application ${facts.filed.application_number}` : ""} | As told to Patty; check it against your USPTO filing receipt |`);
    D.push(`| Non-provisional due | ${due} (${weekday(due)}) | Computed: twelve months after the filing date above (35 U.S.C. 119(e)). If that day is a Saturday, Sunday or federal holiday the period runs to the next business day. The period cannot be extended. |`);
  } else {
    D.push(`| Provisional filed | Not filed | |`);
    D.push(`| Non-provisional due | Twelve months after the provisional filing date | Not computed, because nothing has been filed (35 U.S.C. 119(e)). Run patty_build again with the filing date and this line becomes a date. |`);
  }
  D.push("");
  const ev = (status?.facts as { repo_evidence?: string[] } | undefined)?.repo_evidence ?? [];
  D.push("## What the repo shows about disclosure", "", "Read by patty_start. None of this is a verified disclosure date.", "", ...(ev.length ? ev : ["- Nothing was recorded."]), "");
  D.push(
    "## Things only you know",
    "",
    "- Any deploy, public repo, post, video, talk or demo to people who were not under confidence, and its date.",
    "- Any sale or offer for sale, and its date.",
    `- Filing outside the US: a public disclosure made before you file, although protected in the United States, may preclude patenting in foreign countries (USPTO, ${LINKS.provisional}).`,
    "",
  );
  writeFileSync(join(packet, "DOCKET.md"), D.join("\n"));

  // ----- FILING_STEPS.md -----
  const F: string[] = [
    "# Filing steps",
    "",
    DISCLAIMER,
    "",
    "You do every step below yourself, in your own USPTO account. Patty does not sign, pay or submit, and neither may any other tool or person on your behalf: your USPTO.gov account is yours alone, and a signature has to be typed by the person it names (37 CFR 1.4(d)(2)(i)).",
    "",
    "## Before you open the USPTO site",
    "",
    "1. Read SPECIFICATION.md from start to finish. Whatever is not in the text and drawings on the filing date cannot be added later. If something you want protected is missing, have it added and run patty_check and patty_build again.",
    "2. Open EVIDENCE.md and spot-check a few citations against your code. patty_check confirmed each cited line exists; it did not judge whether the description is accurate.",
    ...(result.chartPresent
      ? [
          "3. Read PRIOR_ART_CHART.md, then PRIOR_ART.md. The chart compares each mechanism with the closest references found, element by element; every quote in it was checked against the reference text. What it concluded:",
          ...result.outcomes.map((o) => `   - ${o.name}: ${o.verdict}${o.ref ? ` (${o.ref}${o.refTitle ? `, "${o.refTitle}"` : ""}${o.refDate ? `, ${o.refDate}` : ""})` : ""}`),
          "   Open the closest reference for the mechanism you care most about and read it yourself. This is a keyword search plus a comparison, not a patentability opinion: it cannot see products, documentation or code that are not indexed, and it does not judge obviousness or subject-matter eligibility. A registered patent practitioner can.",
        ]
      : ["3. Read PRIOR_ART.md. No comparison with prior art was made for this packet, so nothing here says whether the mechanisms are new. Run the searches linked in that file before you file."]),
    "4. Fix the dates in DOCKET.md. Confirm nothing was public, sold or offered earlier than it says.",
    "5. Fill in every field marked \"you enter this\" in COVER_SHEET.md, and decide your entity status.",
    `6. Open specification.pdf (${sp.pages} pages) and drawings.pdf (${dr.sheets} sheets) and look at every page. These are the files you upload.`,
    "",
    "## In Patent Center",
    "",
    `7. Sign in at ${LINKS.patentCenter} with your own USPTO.gov account. Patent Center is for registered users only: the account needs identity verification and two-step sign-in (${LINKS.newUsers}). Do this days ahead; Patty cannot create or verify the account.`,
    "8. Start a new submission and choose Utility Provisional.",
    `9. Enter the application data from COVER_SHEET.md: title, every inventor's legal name and residence, correspondence address. Patent Center's own screens collect this; the alternative is to upload a completed form PTO/SB/16 (${LINKS.sb16}).`,
    "10. Upload specification.pdf with the document description Specification, and drawings.pdf with the description Drawings. Patent Center assigns a description from a file name that contains Specification or Drawing; check that it did.",
    `11. On the fee screen, choose your entity status. Micro entity needs a signed certification, form PTO/SB/15A (${LINKS.sb15a}), uploaded with the application. The fee is the provisional application filing fee, 37 CFR 1.16(d); the amount depends on entity status. Patty does not quote fees: confirm on the current USPTO fee schedule (${LINKS.fees}).`,
    "12. **Sign.** Wherever a form or screen asks for a signature, type your own name between forward slashes yourself, for example /Jane Q. Inventor/. Nobody and nothing else may type it for you.",
    "13. **Submit.** Review the summary screen, then submit. Save the submission receipt: it shows the application number, the confirmation number and the receipt date.",
    "14. **Pay.** Pay the filing fee in the same session and save the payment receipt. Patent Center lets you skip payment, and its guide warns that additional fees may then be incurred.",
    "",
    "## After you file",
    "",
    "- Put the receipts in this folder. Run patty_build again with the filing date, and DOCKET.md will show the date the non-provisional is due.",
    "- A provisional is not examined and never becomes a patent by itself. A non-provisional application claiming its benefit has to be filed within twelve months, and that period cannot be extended.",
    "- \"Patent pending\" may be used for what the provisional describes, during those twelve months.",
    "",
    "## What these steps were checked against",
    "",
    `Read on ${SOURCES_CHECKED}: the Patent Center User Guide (September 2025 edition), the USPTO provisional application page (${LINKS.provisional}), the USPTO forms page (${LINKS.forms}), the Patent Center PDF Guidelines (${LINKS.pdfGuide}), 37 CFR 1.4, 1.51, 1.52 and 1.84 on eCFR, and the USPTO guidance on AI-based tools, 89 FR 25609 (${LINKS.aiGuidance}). Patent Center itself was not opened, because that needs a signed-in account. Screens change: if a screen differs from a step here, follow the screen.`,
    "",
  ];
  writeFileSync(join(packet, "FILING_STEPS.md"), F.join("\n"));

  if (status) {
    status.facts = { ...(status.facts ?? {}), ...facts };
    status.done.build = now();
    status.waiting_on_human = facts.filed
      ? ["File the non-provisional before the date in DOCKET.md, or let the provisional lapse on purpose."]
      : [
          "Read SPECIFICATION.md and approve it.",
          "Confirm the dates in DOCKET.md.",
          "Complete the fields marked \"you enter this\" in COVER_SHEET.md.",
          "Follow FILING_STEPS.md: sign, submit and pay in your own USPTO account.",
        ];
    writeStatus(packet, status);
  }

  const out = [
    "patty_build: done. Nothing has been filed.",
    `Packet: ${packet}`,
    `- specification.pdf: ${sp.pages} pages, fonts embedded, PDF 1.6`,
    `- drawings.pdf: ${dr.sheets} sheets`,
    "- COVER_SHEET.md, DOCKET.md, FILING_STEPS.md",
  ];
  if (result.chartPresent) out.push("", "Prior art chart:", ...result.outcomes.map((o) => `- ${o.name}: ${o.verdict}${o.ref ? ` [${o.ref}]` : ""}`));
  else out.push("", "No prior art chart: nothing in this packet says whether the mechanisms are new. Say so to the human.");
  const unknown: string[] = [];
  if (!inv.length) unknown.push("inventor names and residences");
  if (!dis && !facts.nothing_public_yet) unknown.push("the first public disclosure date");
  if (unknown.length) out.push("", `Not known to Patty, left for the human: ${unknown.join("; ")}. Ask them; do not guess.`);
  if (warnings.length) out.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
  out.push("", "Next: the human reads the packet and follows FILING_STEPS.md. They sign, submit and pay themselves. Do not do any of that for them.");
  return out.join("\n");
}
