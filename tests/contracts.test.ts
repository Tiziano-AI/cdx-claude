import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JobRecord } from "../src/contracts.js";
import { JobIdRequestSchema, SandboxCanaryRequestSchema, StartRequestSchema } from "../src/contracts.js";
import { appendEvent, initializeJob, tailEvents } from "../src/ledger.js";

test("start requests require an absolute cwd", () => {
  const parsed = StartRequestSchema.safeParse({
    cwd: ".",
    prompt: "research this",
    mode: "research",
    agent_role: "evidence_cartographer"
  });
  assert.equal(parsed.success, false);
});

test("start requests require an explicit agent role", () => {
  const parsed = StartRequestSchema.safeParse({
    cwd: "/tmp",
    prompt: "research this",
    mode: "research"
  });
  assert.equal(parsed.success, false);
});

test("job id requests reject path traversal", () => {
  const parsed = JobIdRequestSchema.safeParse({
    job_id: "../../outside"
  });
  assert.equal(parsed.success, false);
});

test("public request schemas reject unknown keys and require canary roles", () => {
  assert.equal(
    StartRequestSchema.safeParse({
      cwd: "/tmp/repo",
      prompt: "research this",
      mode: "research",
      agent_role: "evidence_cartographer",
      extra: true
    }).success,
    false
  );
  assert.equal(SandboxCanaryRequestSchema.safeParse({}).success, false);
  assert.equal(
    JobIdRequestSchema.safeParse({
      job_id: "claude-20260510-120000000-abcdef12",
      extra: true
    }).success,
    false
  );
});

test("ledger appends monotonic event sequence numbers under concurrent writers", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-ledger-test-"));
  const state = path.join(sandbox, "state");
  process.env.CDX_CLAUDE_HOME = state;
  try {
    const jobId = "claude-20260510-120000000-abcdef12";
    const now = "2026-05-10T12:00:00.000Z";
    const job: JobRecord = {
      job_id: jobId,
      title: "concurrent ledger",
      mode: "research",
      status: "running",
      cwd: sandbox,
      execution_cwd: sandbox,
      created_at: now,
      updated_at: now,
      prompt: "record events",
      agent_role: "workflow_ledger",
      allow_web: false,
      claude_task_ids: []
    };
    await initializeJob(job);
    await Promise.all(
      Array.from({ length: 20 }, async (_unused, index) => {
        await appendEvent(jobId, "event", `event ${index}`);
      })
    );
    const events = await tailEvents(jobId, 20);
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: 20 }, (_unused, index) => index)
    );
  } finally {
    delete process.env.CDX_CLAUDE_HOME;
    await rm(sandbox, { recursive: true, force: true });
  }
});
