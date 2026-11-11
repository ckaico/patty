import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { initPacket, PACKET_DIR, readStatus, writeStatus, type Kind } from "./packet.ts";
import { CLEARANCE_METHOD, PROVISIONAL_METHOD, TRADEMARK_METHOD } from "./method.ts";
import { repoMap } from "./repomap.ts";

// Keeps the packet out of version control: an unfiled disclosure should not be pushed.
function ignorePacket(repo: string): string {
  const gi = join(repo, ".gitignore");
  const isGit = existsSync(join(repo, ".git"));
  if (!existsSync(gi) && !isGit) return "No .gitignore written (not a git repository).";
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (cur.split("\n").some((l) => l.trim().replace(/^\//, "").replace(/\/$/, "") === PACKET_DIR)) {
    return `.gitignore already lists ${PACKET_DIR}/.`;
  }
  appendFileSync(gi, `${cur && !cur.endsWith("\n") ? "\n" : ""}${PACKET_DIR}/\n`);
  return `Added ${PACKET_DIR}/ to .gitignore so an unfiled disclosure is not pushed.`;
}

export async function start(repoPath: string, kind: Kind, checkRemotes = true): Promise<string> {
  const repo = resolve(repoPath);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`Not a folder: ${repo}`);
  const { packet, created } = initPacket(repo, kind);
  const ignored = ignorePacket(repo);
  const head = [
    `Packet folder: ${packet} (${created ? "created" : "already existed; nothing in it was overwritten"})`,
    ignored,
    "",
  ];
  if (kind === "trademark") return [...head, TRADEMARK_METHOD].join("\n");
  const map = await repoMap(repo, checkRemotes);
  // The docket repeats what the repo shows about disclosure.
  const status = readStatus(packet);
  if (status) {
    const section = map.split("## Git and disclosure evidence\n")[1] ?? "";
    status.facts = { ...(status.facts ?? {}), repo_evidence: section.split("\n").filter((l) => l.trim()) };
    writeStatus(packet, status);
  }
  return [...head, kind === "clearance" ? CLEARANCE_METHOD : PROVISIONAL_METHOD, "", map].join("\n");
}
