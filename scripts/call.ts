#!/usr/bin/env bun
// Calls one Patty tool over stdio, the way an MCP host does.
//   bun scripts/call.ts patty_start '{"repo_path":"/path/to/repo"}'
//   bun scripts/call.ts --list
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const [tool, json] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dir, "..", "src", "index.ts")],
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});
const client = new Client({ name: "patty-call", version: "0" });
await client.connect(transport);
if (!tool || tool === "--list") {
  const t = await client.listTools();
  const p = await client.listPrompts();
  console.log("instructions:", client.getInstructions());
  console.log("tools:", t.tools.map((x) => x.name).join(", "));
  console.log("prompts:", p.prompts.map((x) => x.name).join(", "));
} else {
  const r = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} });
  for (const c of r.content as { type: string; text?: string }[]) console.log(c.text ?? JSON.stringify(c));
  if (r.isError) process.exitCode = 1;
}
await client.close();
