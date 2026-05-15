import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JobRecord } from "../src/contracts.js";
import { fileExists } from "../src/fs-util.js";
import { initializeJob } from "../src/ledger.js";
import { cleanupDelegation } from "../src/service.js";

test("cleanup removes sandbox canary scratch roots and ledger", async () => {
  const state = path.join(tmpdir(), `cdx-claude-canary-cleanup-state-${randomUUID()}`);
  const repo = path.join(tmpdir(), "cdx-claude-canary-repos", `canary-${randomUUID().slice(0, 8)}`);
  const extra = path.join(tmpdir(), "cdx-claude-canary-additional", `extra-${randomUUID().slice(0, 8)}`);
  const parentProbe = path.join(repo, "cdx-claude-parent-denied.txt");
  const deniedRead = path.join(repo, "cdx-claude-denied-read-nonce.txt");
  const tmpProbe = path.join(tmpdir(), `cdx-claude-denied-canary-${randomUUID().slice(0, 8)}.txt`);
  const tmpDeniedRead = path.join(tmpdir(), `cdx-claude-denied-read-canary-${randomUUID().slice(0, 8)}.txt`);
  const additionalRead = path.join(extra, "cdx-claude-additional-read-nonce.txt");
  const additionalWrite = path.join(extra, "cdx-claude-additional-denied.txt");
  const previousState = process.env.CDX_CLAUDE_HOME;
  process.env.CDX_CLAUDE_HOME = state;
  try {
    await mkdir(repo, { recursive: true });
    await mkdir(extra, { recursive: true });
    await writeFile(deniedRead, "denied\n", "utf8");
    await writeFile(tmpProbe, "bad\n", "utf8");
    await writeFile(tmpDeniedRead, "tmp-denied\n", "utf8");
    await writeFile(additionalRead, "extra\n", "utf8");
    const canonicalRepo = await realpath(repo);
    const canonicalExtra = await realpath(extra);
    const job = jobRecord({
      cwd: canonicalRepo,
      sandbox_canary_parent_probe_path: parentProbe,
      sandbox_canary_tmp_probe_path: tmpProbe,
      sandbox_canary_tmp_read_path: tmpDeniedRead,
      sandbox_canary_denied_read_path: deniedRead,
      sandbox_canary_additional_read_path: path.join(canonicalExtra, path.basename(additionalRead)),
      sandbox_canary_additional_write_path: path.join(canonicalExtra, path.basename(additionalWrite))
    });
    await initializeJob(job);

    const result = await cleanupDelegation({ job_id: job.job_id, force: true, remove_ledger: true });

    assert.equal(result.removed_ledger, true);
    assert.equal(await fileExists(repo), false);
    assert.equal(await fileExists(extra), false);
    assert.equal(await fileExists(tmpProbe), false);
    assert.equal(await fileExists(tmpDeniedRead), false);
    assert.equal(await fileExists(path.join(state, "jobs", job.job_id)), false);
  } finally {
    restoreOptionalEnvironment("CDX_CLAUDE_HOME", previousState);
    await rm(state, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(extra, { recursive: true, force: true });
    await rm(tmpProbe, { recursive: true, force: true });
    await rm(tmpDeniedRead, { recursive: true, force: true });
  }
});

function jobRecord(overrides: Partial<JobRecord>): JobRecord {
  return {
    job_id: `claude-20260515-000000000-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    title: "canary cleanup",
    mode: "patch_autonomous",
    status: "completed",
    cwd: "/tmp/repo",
    execution_cwd: "/tmp/worktree",
    additional_directories: [],
    additional_directory_fingerprints: [],
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    prompt: "canary",
    agent_role: "authority_guardian",
    allow_web: false,
    claude_task_ids: [],
    sandbox_canary: true,
    ...overrides
  };
}

function restoreOptionalEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
