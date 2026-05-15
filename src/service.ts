import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CleanupRequest,
  DEFAULT_SDK_USAGE_GUARD_USD,
  DiffReport,
  EventRecord,
  JobRecord,
  JobView,
  NormalizedStartRequest,
  ResultReport,
  RoleReport,
  SandboxCanaryRequest,
  SandboxCanaryReport,
  StartRequest,
  StartRequestSchema
} from "./contracts.js";
import { resolveAgentRole, roleReport } from "./agents.js";
import { errorCode, UserVisibleError } from "./errors.js";
import { readTextIfExists, removePath } from "./fs-util.js";
import {
  collectWorktreeDiff,
  createDetachedWorktree,
  hasWorktreeChanges,
  inspectGitContext,
  removeWorktree
} from "./git.js";
import {
  appendEvent,
  initializeJob,
  isActiveStatus,
  isTerminalStatus,
  listJobs,
  readJob,
  readReceipt,
  readResultMarkdown,
  refreshStaleJob,
  markReceiptDiffExported,
  removeLedger,
  tailEvents,
  updateJob
} from "./ledger.js";
import {
  diffPath,
  PLUGIN_VERSION,
  tempPath,
  worktreePath
} from "./paths.js";
import { runRequired } from "./process-runner.js";
import { nowIso } from "./time.js";
import { assertRuntimeReadyForDelegation } from "./runtime-materialization.js";
import { workerTokenHash } from "./identity.js";
import { toJobView } from "./job-view.js";
import { toPublicEvents } from "./event-view.js";
import { directoryFingerprints, resolveAdditionalDirectories, resolveAllowedCwd } from "./cwd-policy.js";
import {
  buildSandboxCanaryPrompt,
  maybeSandboxCanaryProof,
  SANDBOX_CANARY_ENV_EXPECTED_KEY,
  SANDBOX_CANARY_ENV_KEY,
  sandboxCanaryMarkers,
  sandboxCanaryProofPaths
} from "./sandbox-canary.js";
import { sandboxScratchDirectory, sandboxScratchFile, scratchTmpRoot } from "./sandbox-scratch.js";
import { sandboxPlatformSupported } from "./sandbox-support.js";
import { spawnWorker } from "./worker-launch.js";
import {
  redactAuthSecretsInDiffReport,
  redactAuthSecretsInEvents,
  redactAuthSecretsInJobView,
  redactAuthSecretsInResultReport,
  redactAuthSecretsInSandboxCanaryReport
} from "./auth-redaction.js";

export async function startJob(request: StartRequest): Promise<JobView> {
  const startRequest = StartRequestSchema.parse(request);
  if (!path.isAbsolute(startRequest.cwd)) {
    throw new UserVisibleError("cwd must be an absolute path.");
  }
  if (startRequest.mode === "patch_autonomous" && !sandboxPlatformSupported()) {
    throw new UserVisibleError(`patch_autonomous is supported only on macOS in cdx-claude v${PLUGIN_VERSION}.`, {
      code: "sandbox_platform_unsupported",
      field: "mode",
      recoverable: true,
      hint: "Use research or patch mode, or run on macOS with Claude Code native sandbox support."
    });
  }
  const cwd = await resolveAllowedCwd(startRequest.cwd);

  const now = nowIso();
  const jobId = `claude-${now.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "")}-${randomUUID().slice(0, 8)}`;
  let executionCwd = cwd;
  let baseCommit: string | undefined;
  let parentDirty: boolean | undefined;
  let worktree: string | undefined;
  let gitContext: Awaited<ReturnType<typeof inspectGitContext>> | undefined;

  if (startRequest.mode !== "research") {
    gitContext = await inspectGitContext(cwd);
    baseCommit = gitContext.head;
    parentDirty = gitContext.dirty;
    worktree = worktreePath(jobId);
    executionCwd = worktree;
  }
  const additionalDirectories = await resolveAdditionalDirectories(startRequest.additional_directories, {
    authorityRoot: cwd,
    executionRoot: executionCwd
  });
  const additionalDirectoryFingerprints = await directoryFingerprints(additionalDirectories);
  await assertRuntimeReadyForDelegation();
  const resolvedRole = await resolveAgentRole(startRequest, executionCwd, additionalDirectories);
  if (gitContext !== undefined) {
    worktree = await createDetachedWorktree(jobId, gitContext);
    executionCwd = worktree;
  }

  const workerToken = randomBytes(32).toString("hex");
  const job = buildJobRecord({
    jobId,
    request: startRequest,
    cwd,
    executionCwd,
    additionalDirectories,
    additionalDirectoryFingerprints,
    now,
    baseCommit,
    parentDirty,
    worktree,
    agentDescription: resolvedRole.role.description,
    agentPrompt: resolvedRole.prompt,
    agentRolePath: `roles/${resolvedRole.role.path}`,
    workerTokenHash: workerTokenHash(workerToken)
  });
  await initializeJob(job);
  await appendEvent(jobId, "created", "Delegation job created", {
    mode: startRequest.mode,
    cwd,
    execution_cwd: executionCwd,
    additional_directories: additionalDirectories
  });
  const workerPid = await spawnWorker(jobId, workerToken);
  const started = await updateJob(jobId, {
    worker_pid: workerPid,
    worker_started_at: nowIso()
  });
  await appendEvent(jobId, "worker_started", "Detached worker started", {
    worker_pid: workerPid
  });
  return redactAuthSecretsInJobView(toJobView(started));
}

export async function listRoles(): Promise<RoleReport> {
  return roleReport();
}

export async function sandboxCanary(request: SandboxCanaryRequest): Promise<SandboxCanaryReport> {
  const scratchRoot = await scratchTmpRoot();
  const cwd = await createCanaryRepo(scratchRoot);
  const parentProbePath = path.join(cwd, "cdx-claude-parent-denied.txt");
  const deniedReadPath = path.join(cwd, "cdx-claude-denied-read-nonce.txt");
  const additionalRoot = path.join(scratchRoot, "cdx-claude-canary-additional", `extra-${randomUUID().slice(0, 8)}`);
  const additionalReadPath = path.join(additionalRoot, "cdx-claude-additional-read-nonce.txt");
  const additionalWritePath = path.join(additionalRoot, "cdx-claude-additional-denied.txt");
  const tmpProbePath = path.join(scratchRoot, `cdx-claude-denied-canary-${randomUUID().slice(0, 8)}.txt`);
  const tmpDeniedReadPath = path.join(scratchRoot, `cdx-claude-denied-read-canary-${randomUUID().slice(0, 8)}.txt`);
  const deniedReadNonce = `cdx-claude-denied-read-${randomUUID()}`;
  const tmpDeniedReadNonce = `cdx-claude-denied-tmp-read-${randomUUID()}`;
  const additionalReadNonce = `cdx-claude-additional-read-${randomUUID()}`;
  const environmentNonce = `cdx-claude-env-${randomUUID()}`;
  await writeFile(deniedReadPath, `${deniedReadNonce}\n`, "utf8");
  await writeFile(tmpDeniedReadPath, `${tmpDeniedReadNonce}\n`, "utf8");
  await mkdir(additionalRoot, { recursive: true });
  await writeFile(additionalReadPath, `${additionalReadNonce}\n`, "utf8");
  const prompt = buildSandboxCanaryPrompt({
    deniedReadPath,
    tmpProbePath,
    tmpDeniedReadPath,
    parentProbePath,
    additionalReadPath,
    additionalWritePath
  });
  const previousEnvironmentNonce = process.env[SANDBOX_CANARY_ENV_KEY];
  const previousExpectedEnvironment = process.env[SANDBOX_CANARY_ENV_EXPECTED_KEY];
  process.env[SANDBOX_CANARY_ENV_KEY] = environmentNonce;
  process.env[SANDBOX_CANARY_ENV_EXPECTED_KEY] = "1";
  let job: JobView;
  try {
    job = await startJob({
      cwd,
      additional_directories: [additionalRoot],
      prompt,
      mode: "patch_autonomous",
      agent_role: request.agent_role,
      allow_web: false,
      title: "sandbox canary",
      ...(request.model === undefined ? {} : { model: request.model }),
      max_budget_usd: request.max_budget_usd
    });
  } finally {
    restoreOptionalEnvironment(SANDBOX_CANARY_ENV_KEY, previousEnvironmentNonce);
    restoreOptionalEnvironment(SANDBOX_CANARY_ENV_EXPECTED_KEY, previousExpectedEnvironment);
  }
  const proofPaths = sandboxCanaryProofPaths({
    ...job,
    sandbox_canary_parent_probe_path: parentProbePath,
    sandbox_canary_tmp_probe_path: tmpProbePath,
    sandbox_canary_tmp_read_path: tmpDeniedReadPath,
    sandbox_canary_worktree_probe_path: path.join(job.worktree_path ?? "", "cdx-claude-canary-ok.txt"),
    sandbox_canary_denied_read_path: deniedReadPath,
    sandbox_canary_additional_read_path: additionalReadPath,
    sandbox_canary_additional_write_path: additionalWritePath
  });
  const updated = await updateJob(job.job_id, {
    sandbox_canary: true,
    sandbox_canary_parent_probe_path: parentProbePath,
    sandbox_canary_tmp_probe_path: tmpProbePath,
    sandbox_canary_tmp_read_path: tmpDeniedReadPath,
    sandbox_canary_worktree_probe_path: proofPaths.worktree_probe_path,
    sandbox_canary_denied_read_path: deniedReadPath,
    sandbox_canary_additional_read_path: additionalReadPath,
    sandbox_canary_additional_write_path: additionalWritePath,
    sandbox_canary_env_nonce: environmentNonce
  });
  return redactAuthSecretsInSandboxCanaryReport({
    job: toJobView(updated),
    expected_markers: sandboxCanaryMarkers(),
    proof_paths: proofPaths
  });
}

async function createCanaryRepo(scratchRoot: string): Promise<string> {
  const repo = path.join(scratchRoot, "cdx-claude-canary-repos", `canary-${randomUUID().slice(0, 8)}`);
  await mkdir(repo, { recursive: true });
  await runRequired("git", ["init", "-b", "main", repo], process.cwd());
  await runRequired("git", ["config", "user.name", "CDX Claude Canary"], repo);
  await runRequired("git", ["config", "user.email", "cdx-claude@example.invalid"], repo);
  await writeFile(path.join(repo, "README.md"), "# cdx-claude sandbox canary\n", "utf8");
  await runRequired("git", ["add", "README.md"], repo);
  await runRequired("git", ["commit", "-m", "initial canary"], repo);
  return repo;
}

export async function statusJob(jobId: string): Promise<JobView> {
  return redactAuthSecretsInJobView(toJobView(await refreshStaleJob(await readJob(jobId))));
}

export async function listDelegations(limit: number, status?: string): Promise<JobView[]> {
  const views = (await listJobs(limit, status)).map(toJobView);
  return Promise.all(views.map((view) => redactAuthSecretsInJobView(view)));
}

export async function tailDelegation(jobId: string, limit: number, afterSeq?: number): Promise<EventRecord[]> {
  await statusJob(jobId);
  return redactAuthSecretsInEvents(toPublicEvents(await tailEvents(jobId, limit, afterSeq)));
}

export async function resultDelegation(jobId: string): Promise<ResultReport> {
  const job = await statusJob(jobId);
  const resultMarkdown = await readResultMarkdown(jobId);
  const receipt = await readReceipt(jobId);
  const diffAvailable = (await readTextIfExists(diffPath(jobId))).length > 0;
  const sandboxProof = await maybeSandboxCanaryProof(await readJob(jobId), resultMarkdown);
  return redactAuthSecretsInResultReport({
    job,
    result_markdown: resultMarkdown,
    receipt,
    diff_available: diffAvailable,
    ...(sandboxProof === undefined ? {} : { sandbox_canary_proof: sandboxProof })
  });
}

export async function diffDelegation(jobId: string): Promise<DiffReport> {
  const job = await statusJob(jobId);
  if (job.worktree_path === undefined) {
    throw new UserVisibleError("Job has no worktree diff.");
  }
  const diff = await collectWorktreeDiff(job.job_id, job.worktree_path);
  await appendEvent(job.job_id, "diff_exported", "Worktree diff exported", {
    bytes: diff.length,
    diff_path: diffPath(job.job_id)
  });
  await updateJob(job.job_id, {});
  await markReceiptDiffExported(job.job_id);
  return redactAuthSecretsInDiffReport({
    job: toJobView(await readJob(job.job_id)),
    diff,
    diff_path: diffPath(job.job_id)
  });
}

export async function stopDelegation(jobId: string): Promise<JobView> {
  const job = await refreshStaleJob(await readJob(jobId));
  if (isTerminalStatus(job.status) || job.status === "stopping") {
    return redactAuthSecretsInJobView(toJobView(job));
  }
  if (job.worker_pid === undefined) {
    return redactAuthSecretsInJobView(toJobView(await updateJob(jobId, {
      status: "stale",
      terminal_at: nowIso(),
      terminal_reason: "worker pid is missing",
      error: "worker pid is missing"
    })));
  }
  const current = await readJob(jobId);
  if (current.worker_pid === undefined || current.worker_token_hash === undefined) {
    return redactAuthSecretsInJobView(toJobView(await updateJob(jobId, {
      status: "stale",
      terminal_at: nowIso(),
      terminal_reason: "worker identity is incomplete",
      error: "worker identity is incomplete"
    })));
  }
  const stopping = await updateJob(jobId, {
    status: "stopping",
    stop_requested_at: nowIso(),
    terminal_reason: "stop requested"
  });
  try {
    process.kill(current.worker_pid, "SIGTERM");
    await appendEvent(jobId, "stop_requested", "Stop signal sent", { worker_pid: current.worker_pid });
    return redactAuthSecretsInJobView(toJobView(stopping));
  } catch (error) {
    if (errorCode(error) === "ESRCH") {
      await appendEvent(jobId, "worker_stale", "Worker process is no longer alive", {
        worker_pid: current.worker_pid
      });
      return redactAuthSecretsInJobView(toJobView(await updateJob(jobId, {
        status: "stale",
        terminal_at: nowIso(),
        terminal_reason: "worker process is no longer alive",
        error: "worker process is no longer alive"
      })));
    }
    throw error;
  }
}

export async function cleanupDelegation(request: CleanupRequest): Promise<{ job_id: string; removed_worktree: boolean; removed_ledger: boolean }> {
  const job = await statusJob(request.job_id);
  if (isActiveStatus(job.status)) {
    throw new UserVisibleError("Cleanup is denied while the job is active.", {
      code: "job_active",
      recoverable: true,
      hint: "Stop the job and wait for a terminal status before cleanup."
    });
  }
  let removedWorktree = false;
  if (job.worktree_path !== undefined) {
    const changed = await hasWorktreeChanges(job.worktree_path);
    if (changed && !request.force) {
      throw new UserVisibleError("Worktree has unexported changes; pass force to remove it.");
    }
    await removeWorktree(job.cwd, job.worktree_path, request.force);
    removedWorktree = true;
    await appendEvent(job.job_id, "worktree_removed", "Worktree removed", {
      worktree_path: job.worktree_path
    });
  }
  await removePath(tempPath(job.job_id));
  await removeSandboxCanaryScratch(job);
  if (request.remove_ledger && !request.force) {
    throw new UserVisibleError("Ledger removal requires force.", {
      code: "ledger_removal_requires_force",
      recoverable: true,
      hint: "Inspect or export the job first, then pass force when ledger deletion is intentional."
    });
  }
  if (request.remove_ledger) {
    await removeLedger(job.job_id);
    return { job_id: job.job_id, removed_worktree: removedWorktree, removed_ledger: true };
  }
  await updateJob(job.job_id, { worktree_path: undefined });
  return { job_id: job.job_id, removed_worktree: removedWorktree, removed_ledger: false };
}

async function removeSandboxCanaryScratch(job: JobView): Promise<void> {
  if (job.sandbox_canary !== true) {
    return;
  }
  const scratchRoot = await scratchTmpRoot();
  const canaryRepoRoot = path.join(scratchRoot, "cdx-claude-canary-repos");
  const canaryAdditionalRoot = path.join(scratchRoot, "cdx-claude-canary-additional");
  const additionalRoot = job.sandbox_canary_additional_read_path === undefined
    ? undefined
    : path.dirname(job.sandbox_canary_additional_read_path);
  for (const target of [
    await sandboxScratchDirectory(job.cwd, canaryRepoRoot),
    additionalRoot === undefined ? undefined : await sandboxScratchDirectory(additionalRoot, canaryAdditionalRoot),
    await sandboxScratchFile(job.sandbox_canary_tmp_probe_path, "cdx-claude-denied-canary-", scratchRoot),
    await sandboxScratchFile(job.sandbox_canary_tmp_read_path, "cdx-claude-denied-read-canary-", scratchRoot)
  ]) {
    if (target !== undefined) {
      await removePath(target);
    }
  }
}

function buildJobRecord(input: {
  jobId: string;
  request: NormalizedStartRequest;
  cwd: string;
  executionCwd: string;
  additionalDirectories: string[];
  additionalDirectoryFingerprints: Awaited<ReturnType<typeof directoryFingerprints>>;
  now: string;
  baseCommit: string | undefined;
  parentDirty: boolean | undefined;
  worktree: string | undefined;
  agentDescription: string;
  agentPrompt: string;
  agentRolePath: string;
  workerTokenHash: string;
}): JobRecord {
  const title = input.request.title ?? input.request.prompt.slice(0, 80);
  return {
    job_id: input.jobId,
    title,
    mode: input.request.mode,
    status: "starting",
    cwd: input.cwd,
    execution_cwd: input.executionCwd,
    additional_directories: input.additionalDirectories,
    additional_directory_fingerprints: input.additionalDirectoryFingerprints,
    created_at: input.now,
    updated_at: input.now,
    prompt: input.request.prompt,
    agent_role: input.request.agent_role,
    agent_description: input.agentDescription,
    agent_prompt: input.agentPrompt,
    agent_role_path: input.agentRolePath,
    allow_web: input.request.allow_web,
    worker_token_hash: input.workerTokenHash,
    claude_task_ids: [],
    max_budget_usd: input.request.max_budget_usd ?? DEFAULT_SDK_USAGE_GUARD_USD,
    ...(input.baseCommit === undefined ? {} : { base_commit: input.baseCommit }),
    ...(input.parentDirty === undefined ? {} : { parent_dirty: input.parentDirty }),
    ...(input.worktree === undefined ? {} : { worktree_path: input.worktree }),
    ...(input.request.model === undefined ? {} : { model: input.request.model })
  };
}

function restoreOptionalEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
