import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { diffDelegation, cleanupDelegation, startJob, statusJob, stopDelegation, tailDelegation } from "../src/service.js";
import { initializeJob, readJob, tailEvents } from "../src/ledger.js";
import { runRequired } from "../src/process-runner.js";
import { runWorker } from "../src/worker.js";
import { workerTokenHash } from "../src/identity.js";

test("patch jobs run in a detached worktree and expose diffs", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  try {
    await bootstrapRepo(repo);
    const job = await startJob({
      cwd: repo,
      prompt: "append fake output",
      mode: "patch",
      agent_role: "repo_alignment_reviewer",
      allow_web: false
    });
    assert.equal(job.status, "starting");
    assert.equal("worker_token" in job, false);
    assert.equal("worker_token_hash" in job, false);
    assert.equal("agent_prompt" in job, false);
    assert.ok(job.worktree_path);
    const stored = await readJob(job.job_id);
    assert.equal("worker_token" in stored, false);
    assert.match(stored.worker_token_hash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(stored.max_budget_usd, 25);
    assert.match(stored.agent_prompt ?? "", new RegExp(`Execution root: ${escapeRegExp(job.worktree_path)}`));
    assert.doesNotMatch(stored.agent_prompt ?? "", new RegExp(`Execution root: ${escapeRegExp(repo)}`));
    const completed = await waitForCompletion(job.job_id);
    assert.equal(completed.status, "completed");
    assert.notEqual(completed.worktree_path, repo);
    const parentReadme = await readFile(path.join(repo, "README.md"), "utf8");
    assert.equal(parentReadme, "# fixture\n");
    await writeFile(path.join(completed.worktree_path ?? "", "NEW.md"), "new file\n", "utf8");
    const diff = await diffDelegation(job.job_id);
    assert.match(diff.diff, /Fake Claude output/);
    assert.match(diff.diff, /new file mode 100644/);
    assert.match(diff.diff, /new file/);
    await assert.rejects(() => cleanupDelegation({ job_id: job.job_id, force: false, remove_ledger: false }));
    const cleanup = await cleanupDelegation({ job_id: job.job_id, force: true, remove_ledger: true });
    assert.equal(cleanup.removed_worktree, true);
    assert.equal(cleanup.removed_ledger, true);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("stop aborts a running detached worker", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-stop-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  process.env.CDX_CLAUDE_FAKE_DELAY_MS = "5000";
  try {
    await bootstrapRepo(repo);
    const job = await startJob({
      cwd: repo,
      prompt: "wait until stopped",
      mode: "research",
      agent_role: "workflow_ledger",
      allow_web: false
    });
    const stored = await readJob(job.job_id);
    assert.ok(stored.worker_pid);
    await waitForEvent(job.job_id, "worker_running");
    const events = await tailDelegation(job.job_id, 100);
    assert.equal(JSON.stringify(events).includes("worker_token"), false);
    assert.equal(JSON.stringify(events).includes("worker_pid"), false);
    assert.equal(JSON.stringify(events).includes("\"pid\""), false);
    const stopped = await stopDelegation(job.job_id);
    assert.equal(stopped.status, "stopping");
    await waitForEvent(job.job_id, "stopped");
    await waitForPidExit(stored.worker_pid);
    const final = await statusJob(job.job_id);
    assert.equal(final.status, "stopped");
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    delete process.env.CDX_CLAUDE_FAKE_DELAY_MS;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch_autonomous starts in a worktree instead of direct parent edits", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-autonomous-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  try {
    await bootstrapRepo(repo);
    const job = await startJob({
      cwd: repo,
      prompt: "autonomous fake patch",
      mode: "patch_autonomous",
      agent_role: "authority_guardian",
      allow_web: false
    });
    assert.equal(job.status, "starting");
    assert.ok(job.worktree_path);
    const completed = await waitForCompletion(job.job_id);
    assert.equal(completed.status, "completed");
    const parentReadme = await readFile(path.join(repo, "README.md"), "utf8");
    assert.equal(parentReadme, "# fixture\n");
    const diff = await diffDelegation(job.job_id);
    assert.match(diff.diff, /Fake Claude output/);
    await cleanupDelegation({ job_id: job.job_id, force: true, remove_ledger: true });
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("start persists selected packaged role TOML in the Claude prompt", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-role-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  try {
    await bootstrapRepo(repo);
    const job = await startJob({
      cwd: repo,
      prompt: "inspect lifecycle",
      mode: "research",
      agent_role: "workflow_ledger",
      allow_web: true
    });
    const stored = await readJob(job.job_id);
    assert.equal(stored.agent_role, "workflow_ledger");
    assert.equal(stored.allow_web, true);
    assert.match(stored.agent_prompt ?? "", /Selected packaged delegate role TOML follows verbatim/);
    assert.match(stored.agent_prompt ?? "", /name = "workflow_ledger"/);
    await waitForCompletion(job.job_id);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("unknown agent roles fail before a worker is spawned", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-role-deny-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  try {
    await bootstrapRepo(repo);
    await assert.rejects(() =>
      startJob({
        cwd: repo,
        prompt: "inspect",
        mode: "research",
        agent_role: "not_a_real_role",
        allow_web: false
      })
    );
    const entries = await readdir(state).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("sensitive control roots are denied before ledger mutation", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-sensitive-deny-test-"));
  const codexRoot = path.join(sandbox, ".codex");
  const state = path.join(codexRoot, "cdx-claude");
  process.env.CDX_CLAUDE_HOME = state;
  try {
    await mkdir(state, { recursive: true });
    await assert.rejects(() =>
      startJob({
        cwd: state,
        prompt: "inspect",
        mode: "research",
        agent_role: "workflow_ledger",
        allow_web: false
      })
    );
    await assert.rejects(() =>
      startJob({
        cwd: codexRoot,
        prompt: "inspect",
        mode: "research",
        agent_role: "workflow_ledger",
        allow_web: false
      })
    );
    const entries = await readdir(state).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("cleanup refuses active jobs even when forced", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-cleanup-active-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  process.env.CDX_CLAUDE_FAKE_DELAY_MS = "5000";
  try {
    await bootstrapRepo(repo);
    const job = await startJob({
      cwd: repo,
      prompt: "wait",
      mode: "research",
      agent_role: "workflow_ledger",
      allow_web: false
    });
    await assert.rejects(() => cleanupDelegation({ job_id: job.job_id, force: true, remove_ledger: true }));
    await waitForEvent(job.job_id, "worker_running");
    await assert.rejects(() => cleanupDelegation({ job_id: job.job_id, force: true, remove_ledger: true }));
    await stopDelegation(job.job_id);
    await waitForEvent(job.job_id, "stopped");
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    delete process.env.CDX_CLAUDE_FAKE_DELAY_MS;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch_autonomous is denied before ledger mutation on unsupported platforms", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-platform-deny-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_TEST_PLATFORM = "linux";
  try {
    await bootstrapRepo(repo);
    await assert.rejects(() =>
      startJob({
        cwd: repo,
        prompt: "autonomous fake patch",
        mode: "patch_autonomous",
        agent_role: "authority_guardian",
        allow_web: false
      })
    );
    const entries = await readdir(state).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_TEST_PLATFORM;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("worker token mismatch does not terminally mutate a job", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-worker-token-test-"));
  const state = path.join(sandbox, "state");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_WORKER_TOKEN = "bad-token";
  try {
    const jobId = "claude-20260510-120000000-abcdef12";
    await initializeJob({
      job_id: jobId,
      title: "token mismatch",
      mode: "research",
      status: "starting",
      cwd: sandbox,
      execution_cwd: sandbox,
      created_at: "2026-05-10T12:00:00.000Z",
      updated_at: "2026-05-10T12:00:00.000Z",
      prompt: "do work",
      agent_role: "workflow_ledger",
      allow_web: false,
      claude_task_ids: [],
      worker_token_hash: workerTokenHash("good-token")
    });
    const exitCode = await runWorker(["--job-id", jobId]);
    const stored = await readJob(jobId);
    assert.equal(exitCode, 1);
    assert.equal(stored.status, "starting");
    const events = await tailEvents(jobId, 10);
    assert.equal(events.some((event) => event.type === "worker_token_denied"), true);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_WORKER_TOKEN;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("public event tails omit cdx-claude worker identity metadata", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-event-view-test-"));
  const state = path.join(sandbox, "state");
  process.env.CDX_CLAUDE_HOME = state;
  try {
    const jobId = "claude-20260510-120000000-abcdef12";
    await initializeJob({
      job_id: jobId,
      title: "event view",
      mode: "research",
      status: "completed",
      cwd: sandbox,
      execution_cwd: sandbox,
      created_at: "2026-05-10T12:00:00.000Z",
      updated_at: "2026-05-10T12:00:00.000Z",
      prompt: "inspect events",
      agent_role: "workflow_ledger",
      allow_web: false,
      claude_task_ids: [],
      worker_token_hash: workerTokenHash("good-token")
    });
    await appendRawIdentityEvent(jobId);
    const publicEvents = await tailDelegation(jobId, 10);
    const text = JSON.stringify(publicEvents);
    assert.equal(text.includes("worker_pid"), false);
    assert.equal(text.includes("worker_token_hash"), false);
    assert.equal(text.includes("worker_token"), false);
    assert.equal(text.includes("\"pid\""), false);
    assert.match(text, /safe/);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function appendRawIdentityEvent(jobId: string): Promise<void> {
  const { appendEvent } = await import("../src/ledger.js");
  await appendEvent(jobId, "worker_running", "Worker entered execution", {
    pid: 123,
    worker_pid: 456,
    worker_token: "raw",
    worker_token_hash: workerTokenHash("raw"),
    nested: { pid: 789, safe: true }
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

async function waitForCompletion(jobId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = await statusJob(jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "stopped") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return statusJob(jobId);
}

async function waitForEvent(jobId: string, type: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const events = await tailDelegation(jobId, 100);
    if (events.some((event) => event.type === type)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for event ${type}`);
}

async function waitForPidExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`process did not exit: ${pid}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
