import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Keys are the user's own, one per service they chose to sign up for. Each is read from an
// environment variable or from the first line of a file in ~/.patty, at the moment a request
// is made. A key is never written to a packet, a log or an error message.
export const pattyHome = () => process.env.PATTY_HOME ?? join(homedir(), ".patty");

export function readKey(file: string, env: string): string | null {
  if (process.env.PATTY_OFFLINE === "1") return null;
  const fromEnv = process.env[env]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const path = join(pattyHome(), file);
    return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/)[0].trim() || null : null;
  } catch {
    return null;
  }
}

export const serpKey = () => readKey("serpapi_key", "PATTY_SERPAPI_KEY");
export const githubToken = () => readKey("github_token", "PATTY_GITHUB_TOKEN");

// A token lifts GitHub's unauthenticated limits. It is sent only to api.github.com.
export function githubHeaders(accept = "application/vnd.github+json"): Record<string, string> {
  const t = githubToken();
  return { "User-Agent": "patty-mcp", Accept: accept, ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
