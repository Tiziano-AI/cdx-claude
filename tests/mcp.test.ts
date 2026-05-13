import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runRequired } from "../src/process-runner.js";
import { PLUGIN_VERSION } from "../src/paths.js";
import { EXPECTED_TOOL_NAMES } from "../src/tool-names.js";

test("mcp tools list exposes only the wrapper delegation tools", async () => {
  const transport = new StdioClientTransport({
    command: "./bin/cdx-claude",
    args: ["mcp", "serve"],
    cwd: "plugin",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CDX_CLAUDE_HOME: "/tmp/cdx-claude-mcp-test",
      CDX_CLAUDE_NPM_SPEC: process.cwd()
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "cdx-claude-test", version: PLUGIN_VERSION });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, EXPECTED_TOOL_NAMES);
    const startTool = tools.tools.find((tool) => tool.name === "claude_delegate_start");
    assert.deepEqual(startTool?.inputSchema.required, ["cwd", "prompt", "mode", "agent_role"]);
    const startProperties = startTool?.inputSchema.properties as Record<string, { default?: unknown; description?: string }> | undefined;
    assert.equal(startProperties?.max_budget_usd?.default, undefined);
    assert.match(startProperties?.max_budget_usd?.description ?? "", /Do not set this field unless the user explicitly requested/);
    const canaryTool = tools.tools.find((tool) => tool.name === "claude_delegate_sandbox_canary");
    const canaryProperties = canaryTool?.inputSchema.properties as Record<string, { default?: unknown; description?: string }> | undefined;
    assert.equal(canaryProperties?.max_budget_usd?.default, undefined);
    assert.match(canaryProperties?.max_budget_usd?.description ?? "", /Do not set this field unless the user explicitly requested/);
    assert.equal(JSON.stringify(startTool?.outputSchema).includes("\"oneOf\""), true);
  } finally {
    await client.close();
  }
});

test("mcp tool calls return stable success and denial envelopes", async () => {
  const transport = new StdioClientTransport({
    command: "./bin/cdx-claude",
    args: ["mcp", "serve"],
    cwd: "plugin",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CDX_CLAUDE_HOME: "/tmp/cdx-claude-mcp-call-test",
      CDX_CLAUDE_NPM_SPEC: process.cwd()
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "cdx-claude-test", version: PLUGIN_VERSION });
  try {
    await client.connect(transport);
    const success = await client.callTool({ name: "claude_delegate_roles", arguments: {} });
    const successEnvelope = success.structuredContent as { ok: boolean; data?: { roles: unknown[] }; meta?: { schema_version: number } };
    assert.equal(successEnvelope.ok, true);
    assert.equal(successEnvelope.meta?.schema_version, 1);
    assert.ok((successEnvelope.data?.roles.length ?? 0) > 0);

    const denial = await client.callTool({ name: "claude_delegate_status", arguments: { job_id: "claude-20260510-120000000-abcdef12" } });
    const denialEnvelope = denial.structuredContent as { ok: boolean; error?: { code: string; recoverable: boolean }; meta?: { schema_version: number } };
    assert.equal(denialEnvelope.ok, false);
    assert.equal(denialEnvelope.meta?.schema_version, 1);
    assert.equal(typeof denialEnvelope.error?.code, "string");
  } finally {
    await client.close();
  }
});

test("mcp invalid inputs return product failure envelopes", async () => {
  const transport = new StdioClientTransport({
    command: "./bin/cdx-claude",
    args: ["mcp", "serve"],
    cwd: "plugin",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CDX_CLAUDE_HOME: "/tmp/cdx-claude-mcp-invalid-test",
      CDX_CLAUDE_NPM_SPEC: process.cwd()
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "cdx-claude-test", version: PLUGIN_VERSION });
  try {
    await client.connect(transport);
    for (const call of [
      { name: "claude_delegate_start", arguments: { cwd: ".", prompt: "x", mode: "research" } },
      { name: "claude_delegate_start", arguments: { cwd: ".", prompt: "x", mode: "research", agent_role: "workflow_ledger" } },
      { name: "claude_delegate_start", arguments: { cwd: "/tmp", prompt: "x", mode: "research", agent_role: "workflow_ledger", max_budget_usd: 0 } },
      { name: "claude_delegate_start", arguments: { cwd: "/tmp", prompt: "x", mode: "research", agent_role: "workflow_ledger", max_budget_usd: 101 } },
      { name: "claude_delegate_status", arguments: { job_id: "../../outside" } },
      { name: "claude_delegate_start", arguments: { cwd: "/tmp", prompt: "x", mode: "research", agent_role: "not_a_real_role" } },
      { name: "claude_delegate_roles", arguments: { extra: true } },
      { name: "claude_delegate_list", arguments: { extra: true } },
      { name: "claude_delegate_sandbox_canary", arguments: {} },
      { name: "claude_delegate_doctor", arguments: { extra: true } }
    ]) {
      const response = await client.callTool(call);
      assert.equal(response.isError, undefined);
      const envelope = response.structuredContent as { ok: boolean; error?: { code: string }; meta?: { schema_version: number } };
      assert.equal(envelope.ok, false);
      assert.equal(typeof envelope.error?.code, "string");
      assert.equal(envelope.meta?.schema_version, 1);
    }
  } finally {
    await client.close();
  }
});

test("mcp start/status/result/cleanup works through the public wrapper", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-mcp-positive-test-"));
  const repo = path.join(sandbox, "repo");
  const state = path.join(sandbox, "state");
  await bootstrapRepo(repo);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/cli.js", "mcp", "serve"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CDX_CLAUDE_HOME: state,
      CDX_CLAUDE_DRIVER: "fake"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "cdx-claude-positive-test", version: PLUGIN_VERSION });
  try {
    await client.connect(transport);
    const started = await client.callTool({
      name: "claude_delegate_start",
      arguments: {
        cwd: repo,
        prompt: "make a fake patch",
        mode: "patch",
        agent_role: "repo_alignment_reviewer"
      }
    });
    const startEnvelope = started.structuredContent as { ok: boolean; data?: { job_id: string; worktree_path?: string } };
    assert.equal(startEnvelope.ok, true);
    assert.equal(typeof startEnvelope.data?.job_id, "string");
    assert.equal(JSON.stringify(startEnvelope).includes("worker_token"), false);
    assert.equal(JSON.stringify(startEnvelope).includes("worker_pid"), false);
    const jobId = startEnvelope.data?.job_id ?? "";
    await waitForMcpCompletion(client, jobId);
    const result = await client.callTool({ name: "claude_delegate_result", arguments: { job_id: jobId } });
    const resultEnvelope = result.structuredContent as { ok: boolean; data?: { result_markdown: string } };
    assert.equal(resultEnvelope.ok, true);
    assert.match(resultEnvelope.data?.result_markdown ?? "", /Fake driver completed/);
    const tail = await client.callTool({ name: "claude_delegate_tail", arguments: { job_id: jobId, limit: 100 } });
    assert.equal(JSON.stringify(tail.structuredContent).includes("worker_pid"), false);
    assert.equal(JSON.stringify(tail.structuredContent).includes("\"pid\""), false);
    const parentReadme = await readFile(path.join(repo, "README.md"), "utf8");
    assert.equal(parentReadme, "# fixture\n");
    const cleanup = await client.callTool({ name: "claude_delegate_cleanup", arguments: { job_id: jobId, force: true, remove_ledger: true } });
    const cleanupEnvelope = cleanup.structuredContent as { ok: boolean };
    assert.equal(cleanupEnvelope.ok, true);
  } finally {
    await client.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForMcpCompletion(client: Client, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await client.callTool({ name: "claude_delegate_status", arguments: { job_id: jobId } });
    const envelope = response.structuredContent as { ok: boolean; data?: { status: string } };
    if (envelope.data?.status === "completed" || envelope.data?.status === "failed" || envelope.data?.status === "stopped") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for MCP job ${jobId}`);
}

async function bootstrapRepo(repo: string): Promise<void> {
  await runRequired("git", ["init", "-b", "main", repo], tmpdir());
  await runRequired("git", ["config", "user.name", "CDX Claude Test"], repo);
  await runRequired("git", ["config", "user.email", "cdx-claude@example.invalid"], repo);
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await runRequired("git", ["add", "README.md"], repo);
  await runRequired("git", ["commit", "-m", "initial"], repo);
}
