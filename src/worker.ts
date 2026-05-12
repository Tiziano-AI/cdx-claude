#!/usr/bin/env node
import { collectWorktreeDiff } from "./git.js";
import { appendEvent, isTerminalStatus, readJob, updateJob } from "./ledger.js";
import { ClaudeResultError, runClaudeJob } from "./claude-driver.js";
import { errorMessage } from "./errors.js";
import { nowIso } from "./time.js";
import { workerTokenMatches } from "./identity.js";
import { claudeAuthEnvironment } from "./auth-env.js";

/** Runs the hidden detached-worker entrypoint for one persisted job. */
export async function runWorker(argv: string[]): Promise<number> {
  const jobId = parseJobId(argv);
  const workerToken = parseWorkerToken(argv);
  delete process.env.CDX_CLAUDE_WORKER_TOKEN;
  const stopController = new AbortController();
  let stopping = false;

  process.on("SIGTERM", () => {
    stopping = true;
    stopController.abort();
    void appendEvent(jobId, "stop_signal_received", "Worker received stop signal", {
      pid: process.pid
    }).catch(() => undefined);
  });

  try {
    const job = await readJob(jobId);
    if (isTerminalStatus(job.status)) {
      return 0;
    }
    if (!workerTokenMatches(workerToken, job.worker_token_hash)) {
      await appendEvent(job.job_id, "worker_token_denied", "Worker token did not match job identity", {
        pid: process.pid
      });
      return 1;
    }
    const runningAt = nowIso();
    await updateJob(job.job_id, {
      status: "running",
      worker_claimed_at: runningAt,
      worker_last_seen_at: runningAt
    });
    await appendEvent(job.job_id, "worker_running", "Worker entered execution", {
      pid: process.pid
    });
    await applyClaudeAuthEnvironment();
    await runClaudeJob(job, stopController.signal);
    await updateJob(job.job_id, { worker_last_seen_at: nowIso() });
    const latest = await readJob(job.job_id);
    if (isTerminalStatus(latest.status)) {
      return latest.worker_exit_code ?? 0;
    }
    if (latest.worktree_path !== undefined) {
      await collectWorktreeDiff(latest.job_id, latest.worktree_path);
    }
    if (stopping || stopController.signal.aborted) {
      await updateJob(job.job_id, {
        status: "stopped",
        worker_exit_code: 0,
        worker_exited_at: nowIso(),
        terminal_at: nowIso(),
        terminal_reason: "stop signal received"
      });
      await appendEvent(job.job_id, "stopped", "Worker stopped");
    } else {
      await updateJob(job.job_id, {
        status: "completed",
        worker_exit_code: 0,
        worker_exited_at: nowIso(),
        terminal_at: nowIso(),
        terminal_reason: "completed"
      });
      await appendEvent(job.job_id, "completed", "Worker completed");
    }
    return 0;
  } catch (error) {
    const status = stopping || stopController.signal.aborted ? "stopped" : "failed";
    const terminalReason = error instanceof ClaudeResultError ? error.subtype : "worker failed";
    await updateJob(jobId, {
      status,
      error: errorMessage(error),
      worker_exit_code: status === "stopped" ? 0 : 1,
      worker_exited_at: nowIso(),
      terminal_at: nowIso(),
      terminal_reason: status === "stopped" ? "stop signal received" : terminalReason
    });
    await appendEvent(jobId, status, errorMessage(error));
    return status === "stopped" ? 0 : 1;
  }
}

async function applyClaudeAuthEnvironment(): Promise<void> {
  const auth = await claudeAuthEnvironment();
  for (const [key, value] of Object.entries(auth)) {
    process.env[key] = value;
  }
}

function parseJobId(args: string[]): string {
  const index = args.indexOf("--job-id");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.trim().length === 0) {
    throw new Error("missing --job-id");
  }
  return value;
}

function parseWorkerToken(_args: string[]): string {
  const environmentToken = process.env.CDX_CLAUDE_WORKER_TOKEN;
  if (environmentToken !== undefined && environmentToken.trim().length > 0) {
    return environmentToken;
  }
  throw new Error("missing CDX_CLAUDE_WORKER_TOKEN");
}
