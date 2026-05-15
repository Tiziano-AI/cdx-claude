import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runRequired } from "../src/process-runner.js";

test("cli help documents the public mcp serve command", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /cdx-claude mcp serve/);
  assert.match(result.stdout, /--additional-directory/);
  assert.match(result.stdout, /default 25/);
  assert.doesNotMatch(result.stdout, /__worker/);
});

test("cli jobs start maps repeatable additional directory flags", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-cli-extra-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  const extra = path.join(sandbox, "context");
  try {
    await bootstrapRepo(repo);
    await mkdir(extra);
    await writeFile(path.join(extra, "notes.txt"), "context\n", "utf8");
    const realExtra = await realpath(extra);
    const result = await runCli([
      "jobs",
      "start",
      "--cwd",
      repo,
      "--additional-directory",
      extra,
      "--prompt",
      "inspect",
      "--mode",
      "research",
      "--agent-role",
      "workflow_ledger"
    ], {
      CDX_CLAUDE_HOME: state,
      CDX_CLAUDE_DRIVER: "fake"
    });
    assert.equal(result.exit_code, 0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { additional_directories: string[] };
    };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.additional_directories, [realExtra]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("cli jobs start rejects camelCase additional directory aliases before ledger creation", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-cli-camelcase-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  const extra = path.join(sandbox, "context");
  try {
    await bootstrapRepo(repo);
    await mkdir(extra);
    const result = await runCli([
      "jobs",
      "start",
      "--cwd",
      repo,
      "--additionalDirectories",
      extra,
      "--prompt",
      "inspect",
      "--mode",
      "research",
      "--agent-role",
      "workflow_ledger"
    ], {
      CDX_CLAUDE_HOME: state,
      CDX_CLAUDE_DRIVER: "fake"
    });
    assert.equal(result.exit_code, 1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "invalid_input");
    assert.equal(existsSync(path.join(state, "jobs")), false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("cli roles returns the stable JSON envelope", async () => {
  const result = await runCli(["roles"]);
  assert.equal(result.exit_code, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { roles: Array<{ name: string }> };
    meta: { schema_version: number; command: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.meta.schema_version, 1);
  assert.equal(parsed.meta.command, "roles");
  assert.ok(parsed.data.roles.some((role) => role.name === "workflow_ledger"));
});

test("cli doctor falls back from an invalid plugin root without throwing internal errors", async () => {
  const result = await runCli(["doctor"], {
    CDX_CLAUDE_PLUGIN_ROOT: path.join(process.cwd(), "does-not-exist"),
    CDX_CLAUDE_CODE_EXECUTABLE: path.join(process.cwd(), "missing-claude")
  });
  assert.equal(result.exit_code, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { ok: boolean; claude: { ok: boolean }; plugin: { ok: boolean } };
    meta: { schema_version: number; command: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.ok, false);
  assert.equal(parsed.data.claude.ok, false);
  assert.equal(parsed.data.plugin.ok, true);
  assert.equal(parsed.meta.command, "doctor");
  assert.equal(result.stdout.includes(process.cwd()), false);
});

test("cli doctor reports ledger failures inside the readiness report", async () => {
  const result = await runCli(["doctor"], {
    CDX_CLAUDE_HOME: path.join("/dev", "null", "cdx-claude")
  });
  assert.equal(result.exit_code, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { ok: boolean; ledger: { ok: boolean } };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.ok, false);
  assert.equal(parsed.data.ledger.ok, false);
});

test("cli sandbox canary requires an explicit role", async () => {
  const result = await runCli(["sandbox", "canary"]);
  assert.equal(result.exit_code, 1);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "invalid_input");
});

test("cli rejects extra arguments on strict public commands", async () => {
  for (const args of [
    ["roles", "--extra", "true"],
    ["doctor", "--extra", "true"],
    ["jobs", "status", "claude-20260510-120000000-abcdef12", "extra"],
    ["jobs", "result", "claude-20260510-120000000-abcdef12", "extra"],
    ["jobs", "tail", "claude-20260510-120000000-abcdef12", "extra"],
    ["jobs", "cleanup", "claude-20260510-120000000-abcdef12", "extra"]
  ]) {
    const result = await runCli(args);
    assert.equal(result.exit_code, 1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "invalid_input");
  }
});

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const repoRoot = process.cwd();
    const child = spawn(path.resolve("plugin/bin/cdx-claude"), args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CDX_CLAUDE_NPM_SPEC: repoRoot,
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exit_code: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function bootstrapRepo(repo: string): Promise<void> {
  await runRequired("git", ["init", "-b", "main", repo], tmpdir());
  await runRequired("git", ["config", "user.name", "CDX Claude Test"], repo);
  await runRequired("git", ["config", "user.email", "cdx-claude@example.invalid"], repo);
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await runRequired("git", ["add", "README.md"], repo);
  await runRequired("git", ["commit", "-m", "initial"], repo);
}
