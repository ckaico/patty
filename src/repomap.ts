import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { PACKET_DIR } from "./packet.ts";

const LANG: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".swift": "Swift", ".m": "Objective-C", ".mm": "Objective-C", ".c": "C", ".h": "C/C++ header",
  ".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".php": "PHP", ".scala": "Scala",
  ".ex": "Elixir", ".exs": "Elixir", ".erl": "Erlang", ".hs": "Haskell", ".ml": "OCaml",
  ".dart": "Dart", ".lua": "Lua", ".r": "R", ".jl": "Julia", ".zig": "Zig", ".sol": "Solidity",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".sql": "SQL", ".graphql": "GraphQL",
  ".proto": "Protobuf", ".vue": "Vue", ".svelte": "Svelte", ".html": "HTML", ".css": "CSS",
  ".scss": "CSS", ".md": "Markdown", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
};
const DOC_LANGS = new Set(["Markdown", "JSON", "YAML", "TOML", "CSS", "HTML"]);
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "vendor", ".next", ".nuxt", ".venv", "venv",
  "__pycache__", ".cache", "coverage", ".turbo", ".idea", ".vscode", "Pods", "DerivedData", PACKET_DIR,
]);
const LOCKFILES = new Set(["package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "Gemfile.lock", "composer.lock"]);
const DEPLOY_FILES = ["vercel.json", "netlify.toml", "fly.toml", "render.yaml", "Procfile", "Dockerfile", "wrangler.toml", "app.yaml", "firebase.json", "CNAME"];
const MAX_WALK = 20000;

export type FileInfo = { path: string; bytes: number; lines: number | null; lang: string };

function git(repo: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0 || r.error) return null;
  return r.stdout.trim();
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_WALK) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") {
        if (e.isDirectory() || e.name === ".DS_Store") continue;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !/^_?backups?(_|$)/i.test(e.name)) stack.push(p);
      } else if (e.isFile()) out.push(relative(root, p));
    }
  }
  return out;
}

function listFiles(repo: string, isGit: boolean): string[] {
  if (isGit) {
    const out = git(repo, ["ls-files", "-co", "--exclude-standard"]);
    if (out !== null) return out.split("\n").filter((f) => f && !f.startsWith(PACKET_DIR + "/"));
  }
  return walk(repo);
}

function countLines(path: string, bytes: number): number | null {
  if (bytes > 4_000_000) return null;
  try {
    const buf = readFileSync(path);
    if (buf.subarray(0, 4096).includes(0)) return null; // binary
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return null;
  }
}

// Strips credentials and turns ssh-style remotes into https so they can be shown and probed.
export function cleanRemote(url: string): { shown: string; https: string | null } {
  let u = url.trim();
  const scp = u.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (!/^https?:\/\//.test(u) && scp) {
    return { shown: `${scp[1]}:${scp[2]}`, https: `https://${scp[1]}/${scp[2]}` };
  }
  try {
    const p = new URL(u);
    p.username = "";
    p.password = "";
    const https = p.origin + p.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    return { shown: https, https };
  } catch {
    return { shown: u.replace(/\/\/[^@/]*@/, "//"), https: null };
  }
}

// Anonymous smart-HTTP probe: 200 means anyone can clone it. Sends no repo content.
async function probePublic(https: string): Promise<string> {
  if (process.env.PATTY_OFFLINE === "1") return "not checked (PATTY_OFFLINE=1)";
  try {
    const r = await fetch(`${https}.git/info/refs?service=git-upload-pack`, {
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "git/2.40.0" },
    });
    if (r.status === 200) return "PUBLIC: an anonymous request can read it";
    if (r.status === 401 || r.status === 403 || r.status === 404) return `not public, or missing (HTTP ${r.status} to an anonymous request)`;
    return `unknown (HTTP ${r.status})`;
  } catch (e) {
    return `not checked (${(e as Error).name === "TimeoutError" ? "timed out" : "network unavailable"})`;
  }
}

function entryPoints(repo: string, files: FileInfo[]): string[] {
  const out: string[] = [];
  const has = (p: string) => existsSync(join(repo, p));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      for (const k of ["main", "module", "browser"]) if (typeof pkg[k] === "string") out.push(`package.json ${k}: ${pkg[k]}`);
      if (typeof pkg.bin === "string") out.push(`package.json bin: ${pkg.bin}`);
      else if (pkg.bin) for (const [k, v] of Object.entries(pkg.bin)) out.push(`package.json bin ${k}: ${v}`);
      for (const k of ["start", "dev", "serve", "build"]) if (pkg.scripts?.[k]) out.push(`package.json script ${k}: ${pkg.scripts[k]}`);
    } catch {}
  }
  for (const p of ["pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "Gemfile", "pom.xml", "build.gradle", "Package.swift"]) if (has(p)) out.push(`${p} (build manifest)`);
  const names = /^(index|main|app|server|cli|__main__|manage)\.[a-z]+$/i;
  for (const f of files) {
    const depth = f.path.split("/").length;
    if (depth <= 3 && names.test(basename(f.path)) && !DOC_LANGS.has(f.lang) ) out.push(`${f.path} (${f.lines ?? "?"} lines)`);
    else if (depth <= 2 && /^index\.html$/i.test(basename(f.path))) out.push(`${f.path} (page entry)`);
  }
  for (const p of DEPLOY_FILES) if (has(p)) out.push(`${p} (deploy config: a sign this may be publicly deployed)`);
  if (existsSync(join(repo, ".github", "workflows"))) out.push(".github/workflows (CI or deploy)");
  return [...new Set(out)].slice(0, 40);
}

export async function repoMap(repo: string, checkRemotes: boolean): Promise<string> {
  const isGit = git(repo, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const paths = listFiles(repo, isGit);
  const files: FileInfo[] = [];
  let skippedBinary = 0;
  for (const p of paths) {
    const abs = join(repo, p);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ext = extname(p).toLowerCase();
    const lang = LANG[ext] ?? "";
    if (LOCKFILES.has(basename(p)) || /\.min\.(js|css)$/.test(p) || /\.map$/.test(p)) continue;
    const lines = lang ? countLines(abs, st.size) : null;
    if (!lang) {
      skippedBinary++;
      continue;
    }
    files.push({ path: p, bytes: st.size, lines, lang });
  }

  const code = files.filter((f) => !DOC_LANGS.has(f.lang)).sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0));
  const docs = files.filter((f) => DOC_LANGS.has(f.lang)).sort((a, b) => b.bytes - a.bytes);
  const byLang = new Map<string, { n: number; lines: number }>();
  for (const f of code) {
    const e = byLang.get(f.lang) ?? { n: 0, lines: 0 };
    e.n++;
    e.lines += f.lines ?? 0;
    byLang.set(f.lang, e);
  }

  const L: string[] = [];
  L.push(`# Repo map: ${repo}`, "");
  L.push(`${code.length} source files, ${docs.length} markup/config/doc files, ${skippedBinary} other files not listed (binary, media, unknown type).`);
  if (paths.length >= MAX_WALK) L.push(`The walk stopped at ${MAX_WALK} files; this map is incomplete.`);
  L.push("");
  L.push("## Languages");
  for (const [lang, e] of [...byLang.entries()].sort((a, b) => b[1].lines - a[1].lines)) L.push(`- ${lang}: ${e.n} files, ${e.lines} lines`);
  L.push("");
  L.push("## Entry points and manifests");
  const eps = entryPoints(repo, files);
  L.push(...(eps.length ? eps.map((e) => `- ${e}`) : ["- none recognised; start from the largest source files"]));
  L.push("");
  L.push("## Source files, largest first (read these; mechanisms live here)");
  const CAP = 150;
  for (const f of code.slice(0, CAP)) L.push(`- ${f.path} · ${f.lang} · ${f.lines ?? "?"} lines · ${f.bytes} bytes`);
  if (code.length > CAP) L.push(`- ... and ${code.length - CAP} smaller source files not listed`);
  L.push("");
  L.push("## Docs, markup and config (read after the code, not before)");
  for (const f of docs.slice(0, 40)) L.push(`- ${f.path} · ${f.lang} · ${f.bytes} bytes`);
  if (docs.length > 40) L.push(`- ... and ${docs.length - 40} more`);
  L.push("");

  L.push("## Git and disclosure evidence");
  if (!isGit) {
    L.push("- Not a git repository. There is no commit history to date the work from.");
    L.push("- Dates of first public disclosure are unverified; ask the human.");
  } else {
    const dates = git(repo, ["log", "--format=%aI"]);
    if (dates) {
      const all = dates.split("\n").filter(Boolean);
      L.push(`- Commits: ${all.length}. First commit: ${all[all.length - 1]}. Last commit: ${all[0]}.`);
    } else L.push("- No commits yet.");
    const remotes = git(repo, ["remote", "-v"]) ?? "";
    const seen = new Map<string, { shown: string; https: string | null }>();
    for (const line of remotes.split("\n")) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (m) seen.set(m[1], cleanRemote(m[2]));
    }
    if (!seen.size) L.push("- Remotes: none. Nothing in git shows this code was published.");
    for (const [name, r] of seen) {
      const state = checkRemotes && r.https ? await probePublic(r.https) : "not checked";
      L.push(`- Remote ${name}: ${r.shown} · ${state}`);
    }
    if ([...seen.values()].length) {
      L.push("  A public remote is evidence the code was disclosed. Git does not record the date a repo became public; that date is unverified until the human confirms it.");
    }
    const tags = git(repo, ["for-each-ref", "--sort=creatordate", "--format=%(refname:short) %(creatordate:iso-strict)", "refs/tags"]);
    if (tags) {
      const t = tags.split("\n").filter(Boolean);
      L.push(`- Tags (${t.length}), oldest first: ${t.slice(0, 30).join("; ")}${t.length > 30 ? "; ..." : ""}`);
      L.push("  Release and deploy tags are candidate disclosure dates. Unverified until the human confirms what each one made public.");
    } else L.push("- Tags: none.");
  }
  L.push("- A deploy, post, talk, demo or sale can disclose the invention without leaving a trace in the repo. Only the human knows.");
  return L.join("\n");
}
