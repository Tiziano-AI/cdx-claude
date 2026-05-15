#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXPECTED_TOOL_NAMES } from "../dist/src/tool-names.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const explicitCommand = process.argv[2];
const explicitCwd = process.argv[3];
const configuredNpmSpec = process.env.CDX_CLAUDE_NPM_SPEC;
const proofStateRoot = await mkdtemp(path.join(tmpdir(), "cdx-claude-mcp-tools-proof-"));
const runtime = runtimeTarget();
const transport = new StdioClientTransport({
  command: runtime.command,
  args: runtime.args,
  cwd: runtime.cwd,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CDX_CLAUDE_HOME: proofStateRoot,
    ...(runtime.runBehaviorProof ? { CDX_CLAUDE_DRIVER: "fake" } : {}),
    ...(runtime.pluginRoot === undefined ? {} : { CDX_CLAUDE_PLUGIN_ROOT: runtime.pluginRoot })
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
      name: "start_no_additional_properties",
      ok: startTool?.inputSchema.additionalProperties === false
    },
    {
      name: "start_no_camelcase_additional_directories",
      ok: schemaProperty(startTool, "additionalDirectories") === undefined
    },
    {
      name: "start_additional_directories_no_default",
      ok: schemaProperty(startTool, "additional_directories")?.default === undefined
    },
    {
      name: "start_additional_directories_max_items",
      ok: schemaProperty(startTool, "additional_directories")?.maxItems === 8
    },
    {
      name: "start_additional_directories_items_absolute_pattern",
      ok: schemaProperty(startTool, "additional_directories")?.items?.pattern === "^/"
    },
    {
      name: "start_additional_directories_read_only_authorized_description",
      ok: descriptionIncludes(startTool, "additional_directories", "read-only") &&
        descriptionIncludes(startTool, "additional_directories", "authorized") &&
        descriptionIncludes(startTool, "additional_directories", "absolute path")
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
  const behaviorChecks = runtime.runBehaviorProof
    ? await runBehaviorChecks(client)
    : [{ name: "behavior_skipped_for_explicit_runtime", ok: true }];
  const ok = JSON.stringify(names) === JSON.stringify(EXPECTED_TOOL_NAMES) &&
    schemaChecks.every((check) => check.ok) &&
    behaviorChecks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, tool_count: names.length, tools: names, schema_checks: schemaChecks, behavior_checks: behaviorChecks }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  await client.close();
  await rm(proofStateRoot, { recursive: true, force: true });
}

function schemaProperty(tool, property) {
  const properties = tool?.inputSchema.properties;
  if (properties === undefined || typeof properties !== "object" || properties === null) {
    return undefined;
  }
  return properties[property];
}

function descriptionIncludes(tool, property, expected) {
  const description = schemaProperty(tool, property)?.description;
  return typeof description === "string" && description.includes(expected);
}

function runtimeTarget() {
  if (explicitCommand !== undefined) {
    return {
      command: explicitCommand,
      args: ["mcp", "serve"],
      cwd: explicitCwd ?? path.join(repoRoot, "plugin"),
      pluginRoot: undefined,
      runBehaviorProof: process.env.CDX_CLAUDE_MCP_BEHAVIOR_PROOF === "1"
    };
  }
  if (configuredNpmSpec !== undefined && configuredNpmSpec.trim().length > 0) {
    return {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["exec", "--yes", "--package", configuredNpmSpec, "--", "cdx-claude", "mcp", "serve"],
      cwd: path.join(repoRoot, "plugin"),
      pluginRoot: path.join(repoRoot, "plugin"),
      runBehaviorProof: true
    };
  }
  return {
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "src", "cli.js"), "mcp", "serve"],
    cwd: repoRoot,
    pluginRoot: undefined,
    runBehaviorProof: true
  };
}

async function runBehaviorChecks(client) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-mcp-tools-behavior-"));
  const repo = path.join(sandbox, "repo");
  const extra = path.join(sandbox, "context");
  let jobId = "";
  try {
    await bootstrapRepo(repo);
    await mkdir(extra);
    await writeFile(path.join(extra, "notes.txt"), "context\n", "utf8");
    const realExtra = await realpath(extra);
    const started = await client.callTool({
      name: "claude_delegate_start",
      arguments: {
        cwd: repo,
        additional_directories: [extra],
        prompt: "prove normalized additional directories",
        mode: "patch",
        agent_role: "repo_alignment_reviewer"
      }
    });
    const startEnvelope = envelopeRecord(started.structuredContent);
    jobId = stringField(startEnvelope.data, "job_id");
    const statusEnvelope = jobId.length === 0
      ? {}
      : envelopeRecord((await waitForCompletion(client, jobId)).structuredContent);
    const listEnvelope = jobId.length === 0
      ? {}
      : envelopeRecord((await client.callTool({
        name: "claude_delegate_list",
        arguments: { limit: 10 }
      })).structuredContent);
    const resultEnvelope = jobId.length === 0
      ? {}
      : envelopeRecord((await client.callTool({
        name: "claude_delegate_result",
        arguments: { job_id: jobId }
      })).structuredContent);
    const diffEnvelope = jobId.length === 0
      ? {}
      : envelopeRecord((await client.callTool({
        name: "claude_delegate_diff",
        arguments: { job_id: jobId }
      })).structuredContent);
    const cleanupEnvelope = jobId.length === 0
      ? {}
      : envelopeRecord((await client.callTool({
        name: "claude_delegate_cleanup",
        arguments: { job_id: jobId, force: true, remove_ledger: true }
      })).structuredContent);
    const cleanupStatusEnvelope = jobId.length === 0
      ? {}
      : envelopeRecord((await client.callTool({
        name: "claude_delegate_status",
        arguments: { job_id: jobId }
      })).structuredContent);
    const ledgerPath = jobId.length === 0 ? "" : path.join(proofStateRoot, "jobs", jobId);
    return [
      { name: "start_behavior_ok", ok: startEnvelope.ok === true },
      { name: "start_additional_directories_normalized", ok: stringArrayEquals(startEnvelope.data?.additional_directories, [realExtra]) },
      { name: "start_no_camelcase_additional_directories", ok: !JSON.stringify(startEnvelope).includes("additionalDirectories") },
      { name: "status_behavior_completed", ok: stringField(statusEnvelope.data, "status") === "completed" },
      { name: "status_additional_directories_normalized", ok: stringArrayEquals(statusEnvelope.data?.additional_directories, [realExtra]) },
      { name: "list_additional_directories_normalized", ok: listIncludesJobWithAdditionalDirectories(listEnvelope.data, jobId, [realExtra]) },
      { name: "result_behavior_ok", ok: resultEnvelope.ok === true },
      { name: "result_additional_directories_normalized", ok: stringArrayEquals(resultEnvelope.data?.job?.additional_directories, [realExtra]) },
      { name: "diff_additional_directories_normalized", ok: stringArrayEquals(diffEnvelope.data?.job?.additional_directories, [realExtra]) },
      { name: "cleanup_behavior_ok", ok: cleanupEnvelope.ok === true },
      { name: "cleanup_status_denied", ok: cleanupStatusEnvelope.ok === false },
      { name: "cleanup_removed_ledger", ok: ledgerPath.length > 0 && !(await pathExists(ledgerPath)) }
    ];
  } catch (error) {
    return [{ name: "behavior_exception", ok: false, error: error instanceof Error ? error.message : "unknown behavior proof error" }];
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function waitForCompletion(client, jobId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await client.callTool({ name: "claude_delegate_status", arguments: { job_id: jobId } });
    const envelope = envelopeRecord(response.structuredContent);
    const status = stringField(envelope.data, "status");
    if (status === "completed" || status === "failed" || status === "stopped") {
      return response;
    }
    await sleep(100);
  }
  return client.callTool({ name: "claude_delegate_status", arguments: { job_id: jobId } });
}

async function bootstrapRepo(repo) {
  await runGit(["init", "-b", "main", repo], tmpdir());
  await runGit(["config", "user.name", "CDX Claude Tools Proof"], repo);
  await runGit(["config", "user.email", "cdx-claude@example.invalid"], repo);
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await runGit(["add", "README.md"], repo);
  await runGit(["commit", "-m", "initial"], repo);
}

async function runGit(args, cwd) {
  await execFileAsync("git", args, { cwd });
}

function envelopeRecord(value) {
  return value !== null && typeof value === "object" ? value : {};
}

function stringField(value, field) {
  if (value !== null && typeof value === "object" && typeof value[field] === "string") {
    return value[field];
  }
  return "";
}

function stringArrayEquals(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function listIncludesJobWithAdditionalDirectories(value, jobId, expected) {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((job) => envelopeRecord(job).job_id === jobId && stringArrayEquals(envelopeRecord(job).additional_directories, expected));
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}
