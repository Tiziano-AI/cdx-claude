import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { directoryFingerprints } from "../src/cwd-policy.js";
import { initializeJob, readJob, tailEvents } from "../src/ledger.js";
import { buildPermissionGate } from "../src/permission.js";
import { workerTokenHash } from "../src/identity.js";
import { runWorker } from "../src/worker.js";

test("permission gate denies an additional root swapped to a symlink after admission", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-root-swap-test-"));
  const root = path.join(sandbox, "root");
  const extra = path.join(sandbox, "extra");
  const outside = path.join(sandbox, "outside");
  try {
    await mkdir(root);
    await mkdir(extra);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
    const realExtra = await realpath(extra);
    const gate = buildPermissionGate("patch", { executionRoot: root, additionalReadRoots: [realExtra] });
    await rm(extra, { recursive: true, force: true });
    await symlink(outside, extra);

    const result = await gate("Read", { file_path: path.join(extra, "secret.txt") }, permissionOptions("tool-root-swap"));

    assert.equal(result.behavior, "deny");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("worker fails before Claude execution when an admitted additional root changes identity", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-root-swap-test-"));
  const state = path.join(sandbox, "state");
  const root = path.join(sandbox, "root");
  const extra = path.join(sandbox, "extra");
  const outside = path.join(sandbox, "outside");
  process.env.CDX_CLAUDE_HOME = state;
  process.env.CDX_CLAUDE_DRIVER = "fake";
  process.env.CDX_CLAUDE_WORKER_TOKEN = "good-token";
  try {
    await mkdir(root);
    await mkdir(extra);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
    const realExtra = await realpath(extra);
    const fingerprints = await directoryFingerprints([realExtra]);
    await rm(extra, { recursive: true, force: true });
    await symlink(outside, extra);
    const jobId = "claude-20260515-000000001-abcdef12";
    await initializeJob({
      job_id: jobId,
      title: "root swap",
      mode: "research",
      status: "starting",
      cwd: root,
      execution_cwd: root,
      additional_directories: [realExtra],
      additional_directory_fingerprints: fingerprints,
      created_at: "2026-05-15T00:00:00.000Z",
      updated_at: "2026-05-15T00:00:00.000Z",
      prompt: "do work",
      agent_role: "workflow_ledger",
      allow_web: false,
      claude_task_ids: [],
      worker_token_hash: workerTokenHash("good-token")
    });

    const exitCode = await runWorker(["--job-id", jobId]);
    const stored = await readJob(jobId);
    const events = await tailEvents(jobId, 20);

    assert.equal(exitCode, 1);
    assert.equal(stored.status, "failed");
    assert.match(stored.error ?? "", /additional directory/);
    assert.equal(events.some((event) => event.type === "fake_start"), false);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    delete process.env.CDX_CLAUDE_DRIVER;
    delete process.env.CDX_CLAUDE_WORKER_TOKEN;
    await rm(sandbox, { recursive: true, force: true });
  }
});

function permissionOptions(toolUseID: string) {
  return {
    signal: new AbortController().signal,
    toolUseID
  };
}
