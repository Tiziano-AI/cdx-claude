import { appendFile, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  EventRecord,
  EventRecordSchema,
  JobStatus,
  JobRecord,
  JobRecordSchema,
  Receipt,
  ReceiptSchema
} from "./contracts.js";
import {
  atomicWriteJson,
  atomicWriteText,
  ensureDir,
  fileExists,
  readJsonWithSchema,
  readTextIfExists,
  removePath
} from "./fs-util.js";
import { errorCode } from "./errors.js";
import { eventsPath, jobDir, jobJsonPath, jobsRoot, receiptPath, resultPath } from "./paths.js";
import { nowIso } from "./time.js";
import { runCommand } from "./process-runner.js";

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const TERMINAL_STATUSES = new Set<JobStatus>(["completed", "failed", "stopped", "stale"]);
const ACTIVE_STATUSES = new Set<JobStatus>(["starting", "running", "stopping"]);

/** Returns true when the status is terminal and must not be replaced by later worker or operator races. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Returns true when a worker can still be executing or starting for the job. */
export function isActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export async function initializeJob(job: JobRecord): Promise<void> {
  await ensureDir(jobDir(job.job_id));
  await atomicWriteJson(jobJsonPath(job.job_id), job);
  const receipt: Receipt = {
    job_id: job.job_id,
    next_seq: 0,
    created_at: job.created_at,
    updated_at: job.updated_at,
    exported_diff: false
  };
  await atomicWriteJson(receiptPath(job.job_id), receipt);
  await atomicWriteText(eventsPath(job.job_id), "");
  await atomicWriteText(resultPath(job.job_id), "");
}

export async function readJob(jobId: string): Promise<JobRecord> {
  return readJsonWithSchema(jobJsonPath(jobId), JobRecordSchema);
}

export async function writeJob(job: JobRecord): Promise<void> {
  await atomicWriteJson(jobJsonPath(job.job_id), { ...job, updated_at: nowIso() });
}

export async function updateJob(jobId: string, update: Partial<JobRecord>): Promise<JobRecord> {
  return withJobLock(jobId, async () => {
    const current = await readJob(jobId);
    if (update.status !== undefined && update.status !== current.status && isTerminalStatus(current.status)) {
      return current;
    }
    const timestamp = nowIso();
    const terminalUpdate =
      update.status !== undefined && isTerminalStatus(update.status) && update.terminal_at === undefined
        ? { terminal_at: timestamp }
        : {};
    const next = JobRecordSchema.parse({ ...current, ...update, ...terminalUpdate, updated_at: timestamp });
    await atomicWriteJson(jobJsonPath(jobId), next);
    return next;
  });
}

export async function readReceipt(jobId: string): Promise<Receipt> {
  return readJsonWithSchema(receiptPath(jobId), ReceiptSchema);
}

export async function appendEvent(
  jobId: string,
  type: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): Promise<EventRecord> {
  return withJobLock(jobId, async () => {
    const receipt = await readReceipt(jobId);
    const event: EventRecord = {
      seq: receipt.next_seq,
      timestamp: nowIso(),
      type,
      summary,
      metadata
    };
    await appendFile(eventsPath(jobId), `${JSON.stringify(event)}\n`, "utf8");
    await atomicWriteJson(receiptPath(jobId), {
      ...receipt,
      next_seq: receipt.next_seq + 1,
      updated_at: nowIso()
    });
    return event;
  });
}

export async function markReceiptDiffExported(jobId: string): Promise<void> {
  await withJobLock(jobId, async () => {
    const receipt = await readReceipt(jobId);
    await atomicWriteJson(receiptPath(jobId), {
      ...receipt,
      exported_diff: true,
      updated_at: nowIso()
    });
  });
}

export async function listJobs(limit: number, status?: string): Promise<JobRecord[]> {
  await ensureDir(jobsRoot());
  let entries: string[];
  try {
    entries = await readdir(jobsRoot());
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const jobs: JobRecord[] = [];
  for (const entry of entries) {
    const target = path.join(jobsRoot(), entry, "job.json");
    if (await fileExists(target)) {
      const job = await readJsonWithSchema(target, JobRecordSchema);
      if (status === undefined || job.status === status) {
        jobs.push(await refreshStaleJob(job));
      }
    }
  }
  return jobs
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, limit);
}

export async function tailEvents(jobId: string, limit: number, afterSeq?: number): Promise<EventRecord[]> {
  const content = await readTextIfExists(eventsPath(jobId));
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const events = lines.map((line) => EventRecordSchema.parse(JSON.parse(line)));
  const filtered = afterSeq === undefined ? events : events.filter((event) => event.seq > afterSeq);
  return filtered.slice(-limit);
}

export async function readResultMarkdown(jobId: string): Promise<string> {
  return readTextIfExists(resultPath(jobId));
}

export async function writeResultMarkdown(jobId: string, content: string): Promise<void> {
  await atomicWriteText(resultPath(jobId), content);
}

export async function removeLedger(jobId: string): Promise<void> {
  await removePath(jobDir(jobId));
}

export async function refreshStaleJob(job: JobRecord): Promise<JobRecord> {
  if (!isActiveStatus(job.status)) {
    return job;
  }
  if (job.worker_pid === undefined) {
    return markJobStale(job, "worker pid is missing");
  }
  if (await workerIdentityIsAlive(job)) {
    return job;
  }
  return markJobStale(job, "worker process is no longer alive or no longer matches the job identity");
}

async function markJobStale(job: JobRecord, reason: string): Promise<JobRecord> {
  if (isTerminalStatus(job.status)) {
    return job;
  }
  const updated = await updateJob(job.job_id, {
    status: "stale",
    terminal_at: nowIso(),
    terminal_reason: reason,
    error: reason
  });
  await appendEvent(job.job_id, "worker_stale", "Worker process is no longer alive", {
    worker_pid: job.worker_pid,
    reason
  });
  return updated;
}

async function workerIdentityIsAlive(job: JobRecord): Promise<boolean> {
  if (!processIsAlive(job.worker_pid)) {
    return false;
  }
  if (job.worker_token_hash === undefined) {
    return false;
  }
  const result = await runCommand("ps", ["-p", String(job.worker_pid), "-o", "command="], process.cwd());
  if (result.exit_code !== 0) {
    return false;
  }
  const command = result.stdout;
  return command.includes(job.job_id) && command.includes("__worker");
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function withJobLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
  const target = path.join(jobDir(jobId), ".ledger.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  while (handle === undefined) {
    try {
      handle = await open(target, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        if (await recoverStaleLock(target)) {
          continue;
        }
        throw new Error(`timed out waiting for ledger lock: ${jobId}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close();
    await rm(target, { force: true });
  }
}

async function recoverStaleLock(target: string): Promise<boolean> {
  const content = await readTextIfExists(target);
  const pid = Number.parseInt(content.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || processIsAlive(pid)) {
    return false;
  }
  await rm(target, { force: true });
  return true;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
