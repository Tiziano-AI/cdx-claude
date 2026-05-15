import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JobRecord } from "../src/contracts.js";
import { initializeJob, appendEvent } from "../src/ledger.js";
import { buildSandboxCanaryPrompt, maybeSandboxCanaryProof, sandboxCanaryMarkers } from "../src/sandbox-canary.js";

test("sandbox canary prompt requests additional read nonce evidence", () => {
  const prompt = buildSandboxCanaryPrompt({
    deniedReadPath: "/tmp/repo/denied-read.txt",
    tmpProbePath: "/tmp/denied-write.txt",
    tmpDeniedReadPath: "/tmp/denied-read.txt",
    parentProbePath: "/tmp/repo/parent-write.txt",
    additionalReadPath: "/tmp/context/read-nonce.txt",
    additionalWritePath: "/tmp/context/denied-write.txt"
  });
  assert.match(prompt, /TMP_READ_DENIED/);
  assert.match(prompt, /ADDITIONAL_READ_OK plus the exact non-secret nonce text/);
  assert.match(prompt, /CANARY_ENV_LEAK without printing its value/);
  assert.match(prompt, /Do not print file contents if any unexpected read succeeds/);
});

test("sandbox canary proof requires markers and side effects", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-canary-proof-test-"));
  const state = path.join(sandbox, "state");
  const worktree = path.join(sandbox, "worktree");
  const deniedRead = path.join(sandbox, "parent", "denied-read.txt");
  const parentProbe = path.join(sandbox, "parent", "denied-write.txt");
  const tmpProbe = path.join(sandbox, "tmp-denied-write.txt");
  const tmpDeniedRead = path.join(sandbox, "tmp-denied-read.txt");
  const worktreeProbe = path.join(worktree, "cdx-claude-canary-ok.txt");
  const additionalRead = path.join(sandbox, "extra", "read-nonce.txt");
  const additionalWrite = path.join(sandbox, "extra", "denied-write.txt");
  process.env.CDX_CLAUDE_HOME = state;
  try {
    await mkdir(path.dirname(deniedRead), { recursive: true });
    await mkdir(path.dirname(additionalRead), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(deniedRead, "nonce-value\n", "utf8");
    await writeFile(tmpDeniedRead, "tmp-nonce-value\n", "utf8");
    await writeFile(additionalRead, "additional-nonce\n", "utf8");
    await writeFile(worktreeProbe, "ok\n", "utf8");
    const initializePassingCanaryJob = async (jobId: string): Promise<JobRecord> => {
      const candidate = jobRecord({
        job_id: jobId,
        sandbox_canary_denied_read_path: deniedRead,
        sandbox_canary_parent_probe_path: parentProbe,
        sandbox_canary_tmp_probe_path: tmpProbe,
        sandbox_canary_tmp_read_path: tmpDeniedRead,
        sandbox_canary_worktree_probe_path: worktreeProbe,
        sandbox_canary_additional_read_path: additionalRead,
        sandbox_canary_additional_write_path: additionalWrite,
        sandbox_canary_env_nonce: "env-nonce-value"
      });
      await initializeJob(candidate);
      await appendEvent(candidate.job_id, "sandbox_canary_env_boundary", "Sandbox canary environment boundary checked", {
        parent_canary_env_injected: true,
        worker_canary_env_absent: true
      });
      await appendEvent(candidate.job_id, "assistant", "assistant", {
        message: {
          message: {
            content: [
              {
                type: "text",
                text: `${sandboxCanaryMarkers().join(" ")} additional-nonce`
              }
            ]
          }
        }
      });
      return candidate;
    };
    const job = jobRecord({
      sandbox_canary_denied_read_path: deniedRead,
      sandbox_canary_parent_probe_path: parentProbe,
      sandbox_canary_tmp_probe_path: tmpProbe,
      sandbox_canary_tmp_read_path: tmpDeniedRead,
      sandbox_canary_worktree_probe_path: worktreeProbe,
      sandbox_canary_additional_read_path: additionalRead,
      sandbox_canary_additional_write_path: additionalWrite,
      sandbox_canary_env_nonce: "env-nonce-value"
    });
    await initializeJob(job);
    await appendEvent(job.job_id, "sandbox_canary_env_boundary", "Sandbox canary environment boundary checked", {
      parent_canary_env_injected: true,
      worker_canary_env_absent: true
    });
    await appendEvent(job.job_id, "assistant", "assistant", {
      message: {
        message: {
          content: [
            {
              type: "tool_use",
              input: {
                command: `${sandboxCanaryMarkers().join(" ")} CANARY_ENV_LEAK`
              }
            }
          ]
        }
      }
    });
    const commandOnlyProof = await maybeSandboxCanaryProof(job, "no worker markers");
    assert.equal(commandOnlyProof?.markers_present, false);
    assert.equal(commandOnlyProof?.env_canary_nonce_absent, true);

    await appendEvent(job.job_id, "assistant", "assistant", {
      message: {
        message: {
          content: [
            {
              type: "text",
              text: `${sandboxCanaryMarkers().join(" ")} additional-nonce`
            }
          ]
        }
      }
    });
    await appendEvent(job.job_id, "result", "success", {
      pid: 123,
      worker_pid: 456
    });
    const proof = await maybeSandboxCanaryProof(job, "all markers present");
    assert.equal(proof?.ok, true);
    assert.equal(proof?.denied_read_nonce_absent, true);
    assert.equal(proof?.tmp_read_nonce_absent, true);
    assert.equal(proof?.additional_read_nonce_present, true);
    assert.equal(proof?.additional_write_absent, true);
    assert.equal(proof?.env_canary_parent_injected, true);
    assert.equal(proof?.env_canary_worker_absent, true);
    assert.equal(proof?.env_canary_nonce_absent, true);

    const negatedFinalProse = await maybeSandboxCanaryProof(job, "all markers present CANARY_ENV_LEAK - not triggered");
    assert.equal(negatedFinalProse?.ok, true);
    assert.equal(negatedFinalProse?.env_canary_nonce_absent, true);

    await appendEvent(job.job_id, "user", "user", {
      message: {
        message: {
          content: [
            {
              type: "text",
              text: "CANARY_ENV_LEAK"
            }
          ]
        }
      }
    });
    const textOnlyLeakToken = await maybeSandboxCanaryProof(job, "all markers present");
    assert.equal(textOnlyLeakToken?.ok, true);
    assert.equal(textOnlyLeakToken?.env_canary_nonce_absent, true);

    const publicNonceLeak = await maybeSandboxCanaryProof(job, "all markers present env-nonce-value");
    assert.equal(publicNonceLeak?.ok, false);
    assert.equal(publicNonceLeak?.env_canary_nonce_absent, false);

    const contentOnlyLeakJob = await initializePassingCanaryJob("claude-20260510-120000000-aabbccdd");
    await appendEvent(contentOnlyLeakJob.job_id, "user", "user", {
      message: {
        message: {
          content: [
            {
              type: "tool_result",
              content: "CANARY_ENV_LEAK"
            }
          ]
        }
      }
    });
    const contentOnlyLeak = await maybeSandboxCanaryProof(contentOnlyLeakJob, "all markers present");
    assert.equal(contentOnlyLeak?.ok, false);
    assert.equal(contentOnlyLeak?.env_canary_nonce_absent, false);

    const stringToolUseResultLeakJob = await initializePassingCanaryJob("claude-20260510-120000000-bbccddee");
    await appendEvent(stringToolUseResultLeakJob.job_id, "user", "user", {
      message: {
        tool_use_result: "CANARY_ENV_LEAK"
      }
    });
    const stringToolUseResultLeak = await maybeSandboxCanaryProof(stringToolUseResultLeakJob, "all markers present");
    assert.equal(stringToolUseResultLeak?.ok, false);
    assert.equal(stringToolUseResultLeak?.env_canary_nonce_absent, false);

    await appendEvent(job.job_id, "user", "user", {
      message: {
        message: {
          content: [
            {
              type: "tool_result",
              content: "CANARY_ENV_LEAK"
            }
          ]
        },
        tool_use_result: {
          stdout: "CANARY_ENV_LEAK",
          stderr: ""
        }
      }
    });
    const observedLeak = await maybeSandboxCanaryProof(job, "all markers present");
    assert.equal(observedLeak?.env_canary_nonce_absent, false);

    const stderrLeakJob = await initializePassingCanaryJob("claude-20260510-120000000-fedcba98");
    await appendEvent(stderrLeakJob.job_id, "assistant", "assistant", {
      message: {
        tool_use_result: {
          stdout: "",
          stderr: "CANARY_ENV_LEAK"
        }
      }
    });
    const stderrLeak = await maybeSandboxCanaryProof(stderrLeakJob, "all markers present");
    assert.equal(stderrLeak?.ok, false);
    assert.equal(stderrLeak?.env_canary_nonce_absent, false);

    await writeFile(parentProbe, "bad\n", "utf8");
    await writeFile(additionalWrite, "bad\n", "utf8");
    await appendEvent(job.job_id, "sandbox_canary_env_boundary", "Sandbox canary environment boundary checked", {
      parent_canary_env_injected: false,
      worker_canary_env_absent: false
    });
    const failed = await maybeSandboxCanaryProof(job, "all markers present nonce-value tmp-nonce-value env-nonce-value CANARY_ENV_LEAK");
    assert.equal(failed?.ok, false);
    assert.equal(failed?.parent_write_absent, false);
    assert.equal(failed?.denied_read_nonce_absent, false);
    assert.equal(failed?.tmp_read_nonce_absent, false);
    assert.equal(failed?.additional_write_absent, false);
    assert.equal(failed?.env_canary_parent_injected, false);
    assert.equal(failed?.env_canary_worker_absent, false);
    assert.equal(failed?.env_canary_nonce_absent, false);
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
    additional_directories: [],
    additional_directory_fingerprints: [],
    created_at: "2026-05-10T12:00:00.000Z",
    updated_at: "2026-05-10T12:00:00.000Z",
    prompt: "canary",
    agent_role: "authority_guardian",
    allow_web: false,
    claude_task_ids: [],
    sandbox_canary: true,
    sandbox_canary_env_nonce: "env-nonce-value",
    ...overrides
  };
}
