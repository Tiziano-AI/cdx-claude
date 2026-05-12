import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JobRecord } from "../src/contracts.js";
import { initializeJob, appendEvent } from "../src/ledger.js";
import { toJobView } from "../src/job-view.js";
import { maybeSandboxCanaryProof, sandboxCanaryMarkers } from "../src/sandbox-canary.js";

test("sandbox canary proof requires markers and side effects", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-canary-proof-test-"));
  const state = path.join(sandbox, "state");
  const worktree = path.join(sandbox, "worktree");
  const deniedRead = path.join(sandbox, "parent", "denied-read.txt");
  const parentProbe = path.join(sandbox, "parent", "denied-write.txt");
  const tmpProbe = path.join(sandbox, "tmp-denied-write.txt");
  const worktreeProbe = path.join(worktree, "cdx-claude-canary-ok.txt");
  process.env.CDX_CLAUDE_HOME = state;
  try {
    await mkdir(path.dirname(deniedRead), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(deniedRead, "nonce-value\n", "utf8");
    await writeFile(worktreeProbe, "ok\n", "utf8");
    const job = jobRecord({
      sandbox_canary_denied_read_path: deniedRead,
      sandbox_canary_parent_probe_path: parentProbe,
      sandbox_canary_tmp_probe_path: tmpProbe,
      sandbox_canary_worktree_probe_path: worktreeProbe
    });
    await initializeJob(job);
    await appendEvent(job.job_id, "result", sandboxCanaryMarkers().join(" "), {
      pid: 123,
      worker_pid: 456
    });
    const proof = await maybeSandboxCanaryProof(toJobView(job), "all markers present");
    assert.equal(proof?.ok, true);
    assert.equal(proof?.denied_read_nonce_absent, true);

    await writeFile(parentProbe, "bad\n", "utf8");
    const failed = await maybeSandboxCanaryProof(toJobView(job), "all markers present nonce-value");
    assert.equal(failed?.ok, false);
    assert.equal(failed?.parent_write_absent, false);
    assert.equal(failed?.denied_read_nonce_absent, false);
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    await rm(sandbox, { recursive: true, force: true });
  }
});

function jobRecord(overrides: Partial<JobRecord>): JobRecord {
  return {
    job_id: "claude-20260510-120000000-abcdef12",
    title: "canary",
    mode: "patch_autonomous",
    status: "completed",
    cwd: "/tmp/repo",
    execution_cwd: "/tmp/worktree",
    created_at: "2026-05-10T12:00:00.000Z",
    updated_at: "2026-05-10T12:00:00.000Z",
    prompt: "canary",
    agent_role: "authority_guardian",
    allow_web: false,
    claude_task_ids: [],
    sandbox_canary: true,
    ...overrides
  };
}
