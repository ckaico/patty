#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import { DISCLAIMER, PACKET_DIR, VERSION, markDone, requirePacket } from "./packet.ts";
import { PROMPT_BUILD_AROUND, PROMPT_PATENT_THIS_REPO } from "./method.ts";
import { start } from "./start.ts";
import { writeFigures } from "./figures.ts";
import { check } from "./check.ts";
import { build } from "./build.ts";
import { priorArt } from "./priorart.ts";
import { tmCheck } from "./tm.ts";
import { sources } from "./sources.ts";

const server = new McpServer(
  { name: "patty", version: VERSION },
  {
    instructions:
      `Patty prepares a US provisional patent packet, or a US trademark packet, from a software repository. ` +
      `When the user asks to patent a repo, a codebase or "this", call patty_start with kind "provisional" first and follow the method it returns: ` +
      `read the code, write EVIDENCE.md, search and chart prior art with patty_prior_art, write SPECIFICATION.md, then patty_figures, patty_check and patty_build. Never tell the user an invention is novel or patentable; report what the search found and how it differs. ` +
      `When the user wants to build around, avoid or check their code against someone else's patent, call patty_start with kind "clearance" and follow that method: fetch the patent, chart every independent claim against the code in CLAIM_CHART.md, patty_check, patty_build. Never tell the user their code is clear, safe or non-infringing; report which claim elements were and were not found. For a trademark, call patty_tm_check. The human approves the packet, then signs, pays and submits in their own USPTO account. ` +
      `Patty holds no accounts: outside services are the user's own, and patty_sources shows which are connected and how to connect the rest. Never ask for a key in chat, never type one, and never sign up for a service for the user. Never sign, submit, pay or operate a USPTO account for them. ${DISCLAIMER}`,
  },
);

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(e as Error).message ?? e}` }], isError: true });
const defaultPacket = () => join(process.cwd(), PACKET_DIR);

server.registerTool(
  "patty_start",
  {
    title: "Start a Patty packet",
    description:
      "First step for every job: patenting this repo (kind provisional), building around or checking the repo against someone else's patent (kind clearance), or a trademark (kind trademark). Creates patty-packet/ in the repo and returns the method for that job plus a repo map: source files with sizes and languages, entry points, git first and last commit dates, remotes and whether each is public, and tags. Call this before reading the code.",
    inputSchema: {
      repo_path: z.string().describe("Absolute path of the repository root."),
      kind: z.enum(["provisional", "clearance", "trademark"]).default("provisional").describe("provisional: draft a US provisional patent application from this repo and find what in it is worth protecting. clearance: chart someone else's patent against this repo, to build around it. trademark: US trademark application."),
      check_remotes: z.boolean().default(true).describe("Ask each git remote, anonymously, whether it is public. Sends no source code."),
    },
  },
  async ({ repo_path, kind, check_remotes }) => {
    try {
      return ok(await start(repo_path, kind, check_remotes));
    } catch (e) {
      return fail(e);
    }
  },
);

const packetArg = z
  .string()
  .optional()
  .describe("The packet folder patty_start reported. Defaults to patty-packet/ in the folder the server was started in.");

server.registerTool(
  "patty_prior_art",
  {
    title: "Search and read prior art",
    description:
      "Two jobs. queries: searches patents (Google Patents), papers (arXiv) and repositories (GitHub) for each query and adds the results to PRIOR_ART.md. fetch: reads references in full (patent publication numbers like US10013501B2, or URLs of papers, repositories or pages), stores each under references/ and returns its similar documents and citations to chase. Work in rounds: search, fetch the closest, chase their similar documents and citations, fetch again. Then write PRIOR_ART_CHART.md; patty_check verifies every quote in it against the stored text. Best effort: a failed search is written as \"search unavailable\" and does not block the packet. Query text is sent to those services, so phrase queries as general mechanisms, not product names or source code.",
    inputSchema: {
      queries: z.array(z.string().min(3)).max(8).optional().describe("Up to 8 searches. Phrase each the way a patent or paper would describe the mechanism."),
      fetch: z.array(z.string().min(3)).max(12).optional().describe("Publication numbers or URLs to read in full and store under references/."),
      packet_path: packetArg,
    },
  },
  async ({ queries, fetch, packet_path }) => {
    try {
      return ok(await priorArt(requirePacket(packet_path ?? defaultPacket()), queries ?? [], fetch ?? []));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "patty_figures",
  {
    title: "Draw the figures",
    description:
      'Renders patent drawings as SVG, black on white, one figure per file, into the packet\'s figures/ folder. Each figure is a JSON object with "number", "type" (flow, block or canvas) and optional "name". flow: {steps:[{n,text,decision?,side?:{n,text},side_label?,down_label?,rejoin?,back_to?}]}. block: {nodes:[{id,text,num,col,row,colspan?,rowspan?,rows?,title?}],frames?,edges:[{from,to,label?,both?}],notes?}. canvas: {width,height,items:[{box:[x,y,w,h],text,num}|{diamond:[cx,cy,w,h],text,num}|{table:[x,y,w],title,num,rows}|{arrow:[[x,y],...],label?,label_at?,both?}|{text,at:[x,y],size?,anchor?,bold?,rotate?}]}. Returns the reference numerals found in each figure and layout warnings. Calling it again with the same figure number replaces that figure.',
    inputSchema: {
      figures: z.array(z.looseObject({ number: z.number().int().min(1), type: z.enum(["flow", "block", "canvas"]), name: z.string().optional() })).min(1),
      packet_path: packetArg,
    },
  },
  async ({ figures, packet_path }) => {
    try {
      const packet = requirePacket(packet_path ?? defaultPacket());
      const out = writeFigures(packet, figures);
      markDone(packet, "figures");
      return ok(out);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "patty_check",
  {
    title: "Check the packet",
    description:
      "Lints the packet. Fails when a section of the specification has no file:line evidence, when a cited line does not exist or does not contain the cited text, when a quote in PRIOR_ART_CHART.md is not in the stored reference, when the chart's result contradicts its rows, when a reference numeral is in the specification and not in a figure or the reverse, when a placeholder remains, or when limiting language appears. patty_build will not run until this passes.",
    inputSchema: { packet_path: packetArg },
  },
  async ({ packet_path }) => {
    try {
      const r = check(requirePacket(packet_path ?? defaultPacket()));
      return { content: [{ type: "text" as const, text: r.report }], isError: !r.passed };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "patty_build",
  {
    title: "Build the filing copies",
    description:
      "For a provisional packet: writes specification.pdf and drawings.pdf (clean filing copies), COVER_SHEET.md, FILING_STEPS.md and DOCKET.md. For a clearance packet: writes CLEARANCE_REPORT.md. Runs patty_check first and refuses if it fails. Pass only facts the human has told you; anything left out is marked for the human to enter. Files nothing: the human signs, submits and pays.",
    inputSchema: {
      packet_path: packetArg,
      inventors: z.array(z.object({ name: z.string().describe("Legal name, as the human gave it."), residence: z.string().default("").describe("City and state, or city and country.") })).optional().describe("Only as told by the human. Never from git config or a guess."),
      first_public_disclosure: z.object({ date: z.string().describe("YYYY-MM-DD"), what: z.string().describe("What was made public and how the human knows the date.") }).optional(),
      nothing_public_yet: z.boolean().optional().describe("True only if the human said nothing has been public, sold or offered."),
      filed: z.object({ date: z.string().describe("YYYY-MM-DD, from the USPTO receipt"), application_number: z.string().optional() }).optional().describe("Only after the human has filed. Turns the twelve-month line in DOCKET.md into a date."),
    },
  },
  async ({ packet_path, ...facts }) => {
    try {
      const text = await build(requirePacket(packet_path ?? defaultPacket()), facts);
      return { content: [{ type: "text" as const, text }], isError: text.startsWith("patty_build refused") };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "patty_tm_check",
  {
    title: "Trademark knockout",
    description:
      "Trademark knockout for a mark: searches the USPTO register for the name as typed (through GleanMark, a third party that indexes the USPTO's daily data), and looks up exact-name domain registrations and what they serve, same-name packages (npm, PyPI, crates.io), GitHub accounts and repositories, and Wikipedia articles. Writes TM_KNOCKOUT.md and TM_FIELDS.md (mark, owner, filing basis, class and identification wording for the human to confirm, specimen checklist). It does not search sound-alikes, similar marks or logos; it links to the USPTO's own search for the human to run. The mark is sent to those lookup services. Never report a mark as clear.",
    inputSchema: {
      mark: z.string().min(1).describe("The word mark, as it would be registered."),
      goods_services: z.string().min(3).describe('Plain description of what it is used for, e.g. "downloadable software for scheduling payments by software agents".'),
      packet_path: packetArg,
    },
  },
  async ({ mark, goods_services, packet_path }) => {
    try {
      return ok(await tmCheck(packet_path ?? defaultPacket(), mark, goods_services));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "patty_sources",
  {
    title: "Connections",
    description:
      "Lists every outside service Patty can use (patent search and full text, papers, code, the trademark register), whether each is connected, and how the user connects their own account. Patty has no accounts of its own: the user signs up for, and pays, each service directly, and saves the key on their own machine. Also lists hosted patent and trademark connectors the user can add to their MCP host. With test: true, tries each connection now and, for a keyed service, reports the plan and what is left on it. Call this when the user asks what Patty is connected to, when a search comes back unavailable, or before a first real run.",
    inputSchema: { test: z.boolean().default(false).describe("Try each connection now. Uses no paid searches.") },
  },
  async ({ test }) => {
    try {
      return ok(await sources(test));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerPrompt(
  "patent-this-repo",
  {
    title: "Patent this repo",
    description: "Walks through the Patty tools in order and ends with a packet for you to sign, pay for and submit yourself.",
    argsSchema: { repo_path: z.string().optional().describe("Repository root. Defaults to the current folder.") },
  },
  ({ repo_path }) => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPT_PATENT_THIS_REPO(repo_path ?? "") } }],
  }),
);

server.registerPrompt(
  "build-around",
  {
    title: "Build around a patent",
    description: "Charts every independent claim of someone else's patent against this repo and lists what could change to take an element out.",
    argsSchema: { patents: z.string().describe("Publication numbers, e.g. US10013501B2"), repo_path: z.string().optional().describe("Repository root. Defaults to the current folder.") },
  },
  ({ patents, repo_path }) => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPT_BUILD_AROUND(patents, repo_path ?? "") } }],
  }),
);

export { server, ok, fail, defaultPacket };

if (import.meta.main) {
  await server.connect(new StdioServerTransport());
}
