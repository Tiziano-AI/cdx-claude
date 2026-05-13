#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXPECTED_TOOL_NAMES } from "../dist/src/tool-names.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
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
    CDX_CLAUDE_NPM_SPEC: process.env.CDX_CLAUDE_NPM_SPEC,
    CDX_CLAUDE_AUTH_ENV_FILE: process.env.CDX_CLAUDE_AUTH_ENV_FILE
  },
  stderr: "pipe"
});
const client = new Client({ name: "cdx-claude-tools-proof", version: packageJson.version });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const startTool = listed.tools.find((tool) => tool.name === "claude_delegate_start");
  const canaryTool = listed.tools.find((tool) => tool.name === "claude_delegate_sandbox_canary");
  const schemaChecks = [
    {
      name: "start_required",
      ok: JSON.stringify(startTool?.inputSchema.required) === JSON.stringify(["cwd", "prompt", "mode", "agent_role"])
    },
    {
      name: "start_budget_no_default",
      ok: schemaProperty(startTool, "max_budget_usd")?.default === undefined
    },
    {
      name: "start_budget_maximum",
      ok: schemaProperty(startTool, "max_budget_usd")?.maximum === 100
    },
    {
      name: "canary_required",
      ok: JSON.stringify(canaryTool?.inputSchema.required) === JSON.stringify(["agent_role"])
    },
    {
      name: "canary_budget_no_default",
      ok: schemaProperty(canaryTool, "max_budget_usd")?.default === undefined
    }
  ];
  const ok = JSON.stringify(names) === JSON.stringify(EXPECTED_TOOL_NAMES) && schemaChecks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, tool_count: names.length, tools: names, schema_checks: schemaChecks }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  await client.close();
}

function schemaProperty(tool, property) {
  const properties = tool?.inputSchema.properties;
  if (properties === undefined || typeof properties !== "object" || properties === null) {
    return undefined;
  }
  return properties[property];
}
