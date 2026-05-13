#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "claude_delegate_cleanup",
  "claude_delegate_diff",
  "claude_delegate_doctor",
  "claude_delegate_list",
  "claude_delegate_result",
  "claude_delegate_roles",
  "claude_delegate_sandbox_canary",
  "claude_delegate_start",
  "claude_delegate_status",
  "claude_delegate_stop",
  "claude_delegate_tail"
];

const command = process.argv[2] ?? "./bin/cdx-claude";
const cwd = process.argv[3] ?? "plugin";
const transport = new StdioClientTransport({
  command,
  args: ["mcp", "serve"],
  cwd,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CDX_CLAUDE_HOME: process.env.CDX_CLAUDE_HOME ?? "/tmp/cdx-claude-mcp-tools-proof",
    CDX_CLAUDE_NPM_SPEC: process.env.CDX_CLAUDE_NPM_SPEC
  },
  stderr: "pipe"
});
const client = new Client({ name: "cdx-claude-tools-proof", version: "0.1.3" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const ok = JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS);
  console.log(JSON.stringify({ ok, tool_count: names.length, tools: names }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  await client.close();
}
