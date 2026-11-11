import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const VERSION = "0.5.0";
export const PACKET_DIR = "patty-packet";
export const DISCLAIMER =
  "Patty prepares documents for you to file yourself. It is not a law firm and this is not legal advice.";

export type Kind = "provisional" | "trademark" | "clearance";

export type Status = {
  notice?: string;
  patty_version: string;
  kind: Kind;
  repo_path: string;
  created: string;
  updated: string;
  done: Record<string, string>;
  check?: { passed: boolean; at: string; errors: number; warnings: number };
  facts?: Record<string, unknown>;
  waiting_on_human: string[];
};

export const now = () => new Date().toISOString();
export const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function statusPath(packet: string) {
  return join(packet, "STATUS.json");
}

export function readStatus(packet: string): Status | null {
  const p = statusPath(packet);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Status;
  } catch {
    return null;
  }
}

export function writeStatus(packet: string, s: Status) {
  s.updated = now();
  writeFileSync(statusPath(packet), JSON.stringify(s, null, 2) + "\n");
}

// Marks a step done and replaces the list of things only the human can do.
export function markDone(packet: string, step: string, waiting?: string[]) {
  const s = readStatus(packet);
  if (!s) return;
  s.done[step] = now();
  if (waiting) s.waiting_on_human = waiting;
  writeStatus(packet, s);
}

export function initPacket(repoPath: string, kind: Kind): { packet: string; created: boolean; status: Status } {
  const packet = join(resolve(repoPath), PACKET_DIR);
  const created = !existsSync(packet);
  mkdirSync(join(packet, "figures"), { recursive: true });
  let status = readStatus(packet);
  if (!status) {
    status = {
      notice: DISCLAIMER,
      patty_version: VERSION,
      kind,
      repo_path: resolve(repoPath),
      created: now(),
      updated: now(),
      done: {},
      waiting_on_human: [],
    };
  }
  status.kind = kind;
  status.done.start = status.done.start ?? now();
  status.waiting_on_human =
    kind === "provisional"
      ? ["Nothing yet. The packet is still being drafted."]
      : kind === "clearance"
        ? ["Nothing yet. The claim chart has not been written."]
        : ["Nothing yet. The trademark check has not been run."];
  writeStatus(packet, status);
  return { packet, created, status };
}

// The repo a packet describes. Falls back to the packet's parent folder.
export function repoOf(packet: string): string {
  const s = readStatus(packet);
  if (s?.repo_path && existsSync(s.repo_path)) return s.repo_path;
  return resolve(packet, "..");
}

export function requirePacket(packetPath: string): string {
  const p = resolve(packetPath);
  if (!existsSync(p)) throw new Error(`No packet folder at ${p}. Run patty_start first.`);
  return p;
}
