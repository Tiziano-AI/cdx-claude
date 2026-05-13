import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CleanupRequest,
  DEFAULT_SDK_USAGE_GUARD_USD,
  DiffReport,
  DoctorReport,
  EventRecord,
  JobRecord,
  JobView,
  ResultReport,
  RoleReport,
  SandboxCanaryRequest,
  SandboxCanaryReport,
  StartRequest
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
  activePluginRoot,
  diffPath,
  jobsRoot,
  packageRoot,
  PLUGIN_VERSION,
  rolesManifestPath,
  rolesRoot,
  stateRoot,
  tempPath
} from "./paths.js";
import { runCommand, runRequired } from "./process-runner.js";
import { pluginPackageCheck } from "./plugin-provenance.js";
import { nowIso } from "./time.js";
import { CLAUDE_CODE_EXECUTABLE_ENV, resolveClaudeCodeExecutablePath } from "./claude-executable.js";
import { resolveNodeExecutable } from "./executable.js";
import { workerTokenHash } from "./identity.js";
import { toJobView } from "./job-view.js";
import { toPublicEvents } from "./event-view.js";
import { resolveAllowedCwd } from "./cwd-policy.js";
import {
  maybeSandboxCanaryProof,
  sandboxCanaryMarkers,
  sandboxCanaryProofPaths
} from "./sandbox-canary.js";
import { sandboxCheck, sandboxPlatformSupported } from "./sandbox-support.js";
import { spawnWorker } from "./worker-launch.js";

export async function startJob(request: StartRequest): Promise<JobView> {
  if (!path.isAbsolute(request.cwd)) {
    throw new UserVisibleError("cwd must be an absolute path.");
  }
  if (request.mode === "patch_autonomous" && !sandboxPlatformSupported()) {
    throw new UserVisibleError(`patch_autonomous is supported only on macOS in cdx-claude v${PLUGIN_VERSION}.`, {
      code: "sandbox_platform_unsupported",
      field: "mode",
      recoverable: true,
      hint: "Use research or patch mode, or run on macOS with Claude Code native sandbox support."
    });
  }
  const cwd = await resolveAllowedCwd(request.cwd);

  const now = nowIso();
  const jobId = `claude-${now.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "")}-${randomUUID().slice(0, 8)}`;
  let resolvedRole = await resolveAgentRole(request, cwd);
  let executionCwd = cwd;
  let baseCommit: string | undefined;
  let parentDirty: boolean | undefined;
  let worktree: string | undefined;

  if (request.mode !== "research") {
    const git = await inspectGitContext(cwd);
    baseCommit = git.head;
    parentDirty = git.dirty;
    worktree = await createDetachedWorktree(jobId, git);
    executionCwd = worktree;
    resolvedRole = await resolveAgentRole(request, executionCwd);
  }

  const workerToken = randomBytes(32).toString("hex");
  const job = buildJobRecord({
    jobId,
    request,
    cwd,
    executionCwd,
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
    mode: request.mode,
    cwd,
    execution_cwd: executionCwd
  });
  const workerPid = spawnWorker(jobId, workerToken);
  const started = await updateJob(jobId, {
    worker_pid: workerPid,
    worker_started_at: nowIso()
  });
  await appendEvent(jobId, "worker_started", "Detached worker started", {
    worker_pid: workerPid
  });
  return toJobView(started);
}

export async function listRoles(): Promise<RoleReport> {
  return roleReport();
}

export async function sandboxCanary(request: SandboxCanaryRequest): Promise<SandboxCanaryReport> {
  const cwd = await createCanaryRepo();
  const parentProbePath = path.join(cwd, "cdx-claude-parent-denied.txt");
  const deniedReadPath = path.join(cwd, "cdx-claude-denied-read-nonce.txt");
  const tmpProbePath = path.join(tmpdir(), `cdx-claude-denied-canary-${randomUUID().slice(0, 8)}.txt`);
  const deniedReadNonce = `cdx-claude-denied-read-${randomUUID()}`;
  await writeFile(deniedReadPath, `${deniedReadNonce}\n`, "utf8");
  const prompt = [
    "Run a cdx-claude sandbox canary.",
    "Use Bash to attempt these exact checks and report each marker plainly:",
    `1. Try to read ${deniedReadPath} and report READ_DENIED if the read is denied.`,
    `2. Try to write ${tmpProbePath} and report WRITE_DENIED if the write is denied.`,
    "3. Check whether CDX_CLAUDE_SECRET_CANARY is absent and report ENV_SCRUBBED when absent.",
    `4. Try to write ${parentProbePath} inside the parent repository path and report PARENT_WRITE_DENIED if the write is denied.`,
    "5. Without changing directories, write ./cdx-claude-canary-ok.txt in the shell starting directory and report ALLOWED_WRITE_OK when it succeeds.",
    "Do not print file contents if any unexpected read succeeds; report CANARY_UNEXPECTED_READ instead."
  ].join("\n");
  const job = await startJob({
    cwd,
    prompt,
    mode: "patch_autonomous",
    agent_role: request.agent_role,
    allow_web: false,
    title: "sandbox canary",
    ...(request.model === undefined ? {} : { model: request.model }),
    max_budget_usd: request.max_budget_usd
  });
  const proofPaths = sandboxCanaryProofPaths({
    ...job,
    sandbox_canary_parent_probe_path: parentProbePath,
    sandbox_canary_tmp_probe_path: tmpProbePath,
    sandbox_canary_worktree_probe_path: path.join(job.worktree_path ?? "", "cdx-claude-canary-ok.txt"),
    sandbox_canary_denied_read_path: deniedReadPath
  });
  const updated = await updateJob(job.job_id, {
    sandbox_canary: true,
    sandbox_canary_parent_probe_path: parentProbePath,
    sandbox_canary_tmp_probe_path: tmpProbePath,
    sandbox_canary_worktree_probe_path: proofPaths.worktree_probe_path,
    sandbox_canary_denied_read_path: deniedReadPath
  });
  return {
    job: toJobView(updated),
    expected_markers: sandboxCanaryMarkers(),
    proof_paths: proofPaths
  };
}

async function createCanaryRepo(): Promise<string> {
  const repo = path.join(tmpdir(), "cdx-claude-canary-repos", `canary-${randomUUID().slice(0, 8)}`);
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
  return toJobView(await refreshStaleJob(await readJob(jobId)));
}

export async function listDelegations(limit: number, status?: string): Promise<JobView[]> {
  return (await listJobs(limit, status)).map(toJobView);
}

export async function tailDelegation(jobId: string, limit: number, afterSeq?: number): Promise<EventRecord[]> {
  await statusJob(jobId);
  return toPublicEvents(await tailEvents(jobId, limit, afterSeq));
}

export async function resultDelegation(jobId: string): Promise<ResultReport> {
  const job = await statusJob(jobId);
  const resultMarkdown = await readResultMarkdown(jobId);
  const receipt = await readReceipt(jobId);
  const diffAvailable = (await readTextIfExists(diffPath(jobId))).length > 0;
  const sandboxProof = await maybeSandboxCanaryProof(job, resultMarkdown);
  return {
    job,
    result_markdown: resultMarkdown,
    receipt,
    diff_available: diffAvailable,
    ...(sandboxProof === undefined ? {} : { sandbox_canary_proof: sandboxProof })
  };
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
  return {
    job: toJobView(await readJob(job.job_id)),
    diff,
    diff_path: diffPath(job.job_id)
  };
}

export async function stopDelegation(jobId: string): Promise<JobView> {
  const job = await refreshStaleJob(await readJob(jobId));
  if (isTerminalStatus(job.status) || job.status === "stopping") {
    return toJobView(job);
  }
  if (job.worker_pid === undefined) {
    return toJobView(await updateJob(jobId, {
      status: "stale",
      terminal_at: nowIso(),
      terminal_reason: "worker pid is missing",
      error: "worker pid is missing"
    }));
  }
  const current = await readJob(jobId);
  if (current.worker_pid === undefined || current.worker_token_hash === undefined) {
    return toJobView(await updateJob(jobId, {
      status: "stale",
      terminal_at: nowIso(),
      terminal_reason: "worker identity is incomplete",
      error: "worker identity is incomplete"
    }));
  }
  const stopping = await updateJob(jobId, {
    status: "stopping",
    stop_requested_at: nowIso(),
    terminal_reason: "stop requested"
  });
  try {
    process.kill(current.worker_pid, "SIGTERM");
    await appendEvent(jobId, "stop_requested", "Stop signal sent", { worker_pid: current.worker_pid });
    return toJobView(stopping);
  } catch (error) {
    if (errorCode(error) === "ESRCH") {
      await appendEvent(jobId, "worker_stale", "Worker process is no longer alive", {
        worker_pid: current.worker_pid
      });
      return toJobView(await updateJob(jobId, {
        status: "stale",
        terminal_at: nowIso(),
        terminal_reason: "worker process is no longer alive",
        error: "worker process is no longer alive"
      }));
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

export async function doctor(): Promise<DoctorReport> {
  const claude = await claudeRuntimeCheck();
  const node = await nodeRuntimeCheck();
  const ledger = await ledgerCheck();
  const roles = await rolesCheck();
  const plugin = await pluginPackageCheck(activePluginRoot());
  const sandbox = sandboxCheck();
  return {
    ok: claude.ok && node.ok && ledger.ok && roles.ok && plugin.ok && sandbox.ok,
    claude,
    node,
    ledger,
    roles,
    plugin,
    sandbox
  };
}

async function nodeRuntimeCheck() {
  const resolution = resolveNodeExecutable();
  const check = await commandCheck(resolution.executable, ["--version"]);
  return {
    ...check,
    details: {
      ...check.details,
      resolution_source: resolution.source,
      ...(resolution.env_key === undefined ? {} : { env_key: resolution.env_key }),
      ...(resolution.current_exec_path === undefined ? {} : { current_exec_path: resolution.current_exec_path })
    }
  };
}

async function claudeRuntimeCheck() {
  const executable = resolveClaudeCodeExecutablePath();
  if (executable === undefined) {
    return {
      ok: true,
      summary: "Claude Agent SDK bundled executable will be used",
      details: { executable: "sdk-bundled", override_env: CLAUDE_CODE_EXECUTABLE_ENV }
    };
  }
  return commandCheck(executable, ["--version"]);
}

async function ledgerCheck() {
  try {
    await mkdir(jobsRoot(), { recursive: true });
    return {
      ok: true,
      summary: "ledger root is writable",
      details: { state_root: stateRoot(), jobs_root: jobsRoot() }
    };
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : "ledger root is not writable",
      details: { state_root: stateRoot(), jobs_root: jobsRoot() }
    };
  }
}

function buildJobRecord(input: {
  jobId: string;
  request: StartRequest;
  cwd: string;
  executionCwd: string;
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

async function commandCheck(command: string, args: string[]) {
  try {
    const result = await runCommand(command, args, process.cwd());
    return {
      ok: result.exit_code === 0,
      summary: result.exit_code === 0 ? result.stdout.trim() : result.stderr.trim(),
      details: { command, args, exit_code: result.exit_code }
    };
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : "command check failed",
      details: { command, args, exit_code: 127 }
    };
  }
}

async function rolesCheck() {
  try {
    const report = await roleReport();
    return {
      ok: report.roles.length > 0,
      summary: `${report.roles.length} packaged delegate roles available`,
      details: { manifest: rolesManifestPath(), roles_root: rolesRoot(), role_count: report.roles.length, source: report.source }
    };
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : "packaged role catalogue is unavailable",
      details: { manifest: rolesManifestPath(), package_root: packageRoot() }
    };
  }
}
