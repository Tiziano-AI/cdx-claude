import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JobRecord } from "../src/contracts.js";
import { buildClaudeOptionsForJob, sdkResultErrorSubtype } from "../src/claude-driver.js";
import { authEnvironmentFromFile } from "../src/auth-env.js";

test("allow_web is the only path that exposes Claude web tools", () => {
  const withoutWeb = buildClaudeOptionsForJob(jobRecord({ allow_web: false }), new AbortController());
  assert.equal(withoutWeb.tools.includes("WebFetch"), false);
  assert.equal(withoutWeb.tools.includes("WebSearch"), false);

  const withWeb = buildClaudeOptionsForJob(jobRecord({ allow_web: true }), new AbortController());
  assert.equal(withWeb.tools.includes("WebFetch"), true);
  assert.equal(withWeb.tools.includes("WebSearch"), true);
});

test("patch_autonomous configures Bash only with fail-closed native sandboxing", () => {
  const options = buildClaudeOptionsForJob(jobRecord({ mode: "patch_autonomous" }), new AbortController());
  assert.equal(options.tools.includes("Bash"), true);
  assert.equal(options.disallowedTools.includes("Bash"), false);
  assert.equal(options.allowedTools.length, 0);
  assert.equal(options.permissionMode, "default");
  assert.equal(options.sandbox?.enabled, true);
  assert.equal(options.sandbox?.failIfUnavailable, true);
  assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
  assert.ok(options.sandbox?.filesystem?.denyRead?.includes("/tmp/repo"));
  assert.ok(options.sandbox?.filesystem?.denyWrite?.includes("/tmp/repo"));
});

test("patch mode removes Bash while keeping file edit tools", () => {
  const options = buildClaudeOptionsForJob(jobRecord({ mode: "patch" }), new AbortController());
  assert.equal(options.tools.includes("Edit"), true);
  assert.equal(options.tools.includes("Bash"), false);
  assert.equal(options.disallowedTools.includes("Bash"), true);
});

test("sdk options forward the API-equivalent usage guard", () => {
  const options = buildClaudeOptionsForJob(jobRecord({ max_budget_usd: 25 }), new AbortController());
  assert.equal(options.maxBudgetUsd, 25);
});

test("sdk options omit the Claude executable unless an explicit override is configured", async () => {
  const originalExecutable = process.env.CDX_CLAUDE_CODE_EXECUTABLE;
  delete process.env.CDX_CLAUDE_CODE_EXECUTABLE;
  try {
    const options = buildClaudeOptionsForJob(jobRecord({}), new AbortController());
    assert.equal(options.pathToClaudeCodeExecutable, undefined);
  } finally {
    if (originalExecutable === undefined) {
      delete process.env.CDX_CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CDX_CLAUDE_CODE_EXECUTABLE = originalExecutable;
    }
  }
});

test("sdk options pass only an explicit local Claude Code executable override", async () => {
  const originalExecutable = process.env.CDX_CLAUDE_CODE_EXECUTABLE;
  const directory = path.join(tmpdir(), `cdx-claude-executable-${process.pid}`);
  const executable = path.join(directory, "claude");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  try {
    process.env.CDX_CLAUDE_CODE_EXECUTABLE = executable;
    const options = buildClaudeOptionsForJob(jobRecord({}), new AbortController());
    assert.equal(options.pathToClaudeCodeExecutable, executable);
  } finally {
    if (originalExecutable === undefined) {
      delete process.env.CDX_CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CDX_CLAUDE_CODE_EXECUTABLE = originalExecutable;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("auth env files pass only allowlisted Claude provider keys", async () => {
  const directory = path.join(tmpdir(), `cdx-claude-auth-env-${process.pid}`);
  const authFile = path.join(directory, "auth.env");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(authFile, "ANTHROPIC_API_KEY='test-key'\nCLAUDE_CODE_USE_VERTEX=true\n", "utf8");
  await chmod(authFile, 0o600);
  try {
    const env = await authEnvironmentFromFile(authFile);
    assert.deepEqual(env, {
      ANTHROPIC_API_KEY: "test-key",
      CLAUDE_CODE_USE_VERTEX: "true"
    });
    await writeFile(authFile, "NOT_ALLOWED=value\n", "utf8");
    await chmod(authFile, 0o600);
    await assert.rejects(() => authEnvironmentFromFile(authFile), /unsupported Claude auth env key/);
    await assert.rejects(() => authEnvironmentFromFile("relative.env"), /absolute path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sdk result errors are classified before worker completion", () => {
  assert.equal(
    sdkResultErrorSubtype({
      type: "result",
      subtype: "error_max_budget_usd"
    }),
    "error_max_budget_usd"
  );
  assert.equal(
    sdkResultErrorSubtype({
      type: "result",
      subtype: "success"
    }),
    undefined
  );
});

function jobRecord(overrides: Partial<JobRecord>): JobRecord {
  return {
    job_id: "claude-20260510-120000000-abcdef12",
    title: "driver",
    mode: "research",
    status: "running",
    cwd: "/tmp/repo",
    execution_cwd: "/tmp/repo",
    created_at: "2026-05-10T12:00:00.000Z",
    updated_at: "2026-05-10T12:00:00.000Z",
    prompt: "do work",
    agent_role: "workflow_ledger",
    agent_prompt: "role prompt",
    allow_web: false,
    claude_task_ids: [],
    ...overrides
  };
}
