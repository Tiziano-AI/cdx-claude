import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupDelegation, startJob, statusJob } from "../src/service.js";
import { readJob, tailEvents } from "../src/ledger.js";
import { runRequired } from "../src/process-runner.js";

test("start normalizes and exposes read-only additional directories", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-additional-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  const extra = path.join(sandbox, "context");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  try {
    await bootstrapRepo(repo);
    await mkdir(extra);
    await writeFile(path.join(extra, "notes.txt"), "context\n", "utf8");
    const realExtra = await realpath(extra);
    const job = await startJob({
      cwd: repo,
      additional_directories: [extra, extra],
      prompt: "inspect lifecycle",
      mode: "research",
      agent_role: "workflow_ledger",
      allow_web: false
    });
    assert.deepEqual(job.additional_directories, [realExtra]);
    const stored = await readJob(job.job_id);
    assert.deepEqual(stored.additional_directories, [realExtra]);
    assert.match(stored.agent_prompt ?? "", /Additional read-only roots:/);
    assert.match(stored.agent_prompt ?? "", new RegExp(escapeRegExp(realExtra)));
    const events = await tailEvents(job.job_id, 10);
    assert.deepEqual(events[0]?.metadata.additional_directories, [realExtra]);
    await waitForCompletion(job.job_id);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("start denies invalid additional directories before ledger or worktree mutation", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-additional-deny-test-"));
  const contextRoot = path.join(sandbox, "context");
  const state = path.join(contextRoot, "state");
  const repo = path.join(sandbox, "repo");
  const file = path.join(sandbox, "not-a-directory.txt");
  const missing = path.join(sandbox, "missing");
  const control = path.join(sandbox, "bad\ncontext");
  const extra = path.join(sandbox, "extra");
  const nested = path.join(extra, "nested");
  const stateLink = path.join(sandbox, "state-link");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  try {
    await bootstrapRepo(repo);
    await mkdir(state, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(file, "not a directory\n", "utf8");
    await symlink(state, stateLink);
    const deniedInputs = [
      [file],
      [missing],
      [control],
      [extra, nested],
      [path.parse(sandbox).root],
      [homedir()],
      ["/etc"],
      [state],
      [stateLink],
      [contextRoot]
    ];
    for (const additionalDirectories of deniedInputs) {
      await assert.rejects(() =>
        startJob({
          cwd: repo,
          additional_directories: additionalDirectories,
          prompt: "inspect",
          mode: "research",
          agent_role: "workflow_ledger",
          allow_web: false
        })
      );
      await assertNoDelegationArtifacts(state);
    }
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("path admission failures win before private runtime or auth readiness checks", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-path-first-test-"));
  const state = path.join(sandbox, "state");
  const repo = path.join(sandbox, "repo");
  const missing = path.join(sandbox, "missing-context");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  process.env.CDX_CLAUDE_AUTH_ENV_FILE = "relative-auth.env";
  try {
    await bootstrapRepo(repo);
    await assert.rejects(
      () =>
        startJob({
          cwd: repo,
          additional_directories: [missing],
          prompt: "inspect",
          mode: "research",
          agent_role: "workflow_ledger",
          allow_web: false
        }),
      /additional directory/
    );
    await assertNoDelegationArtifacts(state);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    delete process.env.CDX_CLAUDE_AUTH_ENV_FILE;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch modes deny cwd overlap common-parent workarounds and accept disjoint extra roots", async () => {
  for (const mode of ["patch", "patch_autonomous"] as const) {
    const sandbox = await mkdtemp(path.join(tmpdir(), `cdx-claude-${mode}-additional-test-`));
    const state = path.join(sandbox, "state");
    const project = path.join(sandbox, "project");
    const repo = path.join(project, "repo");
    const child = path.join(repo, "child");
    const extra = path.join(sandbox, "context");
    const previousPlatform = process.env.CDX_CLAUDE_TEST_PLATFORM;
    process.env.CDX_CLAUDE_HOME = state;
    process.env.CDX_CLAUDE_DRIVER = "fake";
    process.env.CDX_CLAUDE_TEST_PLATFORM = "darwin";
    try {
      await bootstrapRepo(repo);
      await mkdir(child);
      await mkdir(extra);
      for (const overlappingRoot of [repo, child, project]) {
        await assert.rejects(() =>
          startJob({
            cwd: repo,
            additional_directories: [overlappingRoot],
            prompt: "inspect",
            mode,
            agent_role: "workflow_ledger",
            allow_web: false
          }),
          /overlaps/
        );
        await assertNoDelegationArtifacts(state);
      }
      const realExtra = await realpath(extra);
      const job = await startJob({
        cwd: repo,
        additional_directories: [extra],
        prompt: "inspect",
        mode,
        agent_role: "workflow_ledger",
        allow_web: false
      });
      assert.deepEqual(job.additional_directories, [realExtra]);
      await waitForCompletion(job.job_id);
      await cleanupDelegation({ job_id: job.job_id, force: true, remove_ledger: true });
    } finally {
      delete process.env.CDX_CLAUDE_HOME;
      delete process.env.CDX_CLAUDE_DRIVER;
      restoreEnv("CDX_CLAUDE_TEST_PLATFORM", previousPlatform);
      await rm(sandbox, { recursive: true, force: true });
    }
  }
});

async function assertNoDelegationArtifacts(state: string): Promise<void> {
  const jobs = await readdir(path.join(state, "jobs")).catch(() => []);
  const worktrees = await readdir(path.join(state, "worktrees")).catch(() => []);
  assert.deepEqual(jobs, []);
  assert.deepEqual(worktrees, []);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
