import {
  JobRecord,
  SandboxCanaryProof,
  SandboxCanaryProofPaths
} from "./contracts.js";
import { fileExists, readTextIfExists } from "./fs-util.js";
import { toPublicEvents } from "./event-view.js";
import { tailEvents } from "./ledger.js";

export const SANDBOX_CANARY_ENV_KEY = "CDX_CLAUDE_SECRET_CANARY";
export const SANDBOX_CANARY_ENV_EXPECTED_KEY = "CDX_CLAUDE_SANDBOX_CANARY_ENV_EXPECTED";

export interface SandboxCanaryPromptPaths {
  deniedReadPath: string;
  tmpProbePath: string;
  tmpDeniedReadPath: string;
  parentProbePath: string;
  additionalReadPath: string;
  additionalWritePath: string;
}

/** Returns the required live canary markers Claude must report after the sandbox run. */
export function sandboxCanaryMarkers(): string[] {
  return [
    "READ_DENIED",
    "WRITE_DENIED",
    "ENV_SCRUBBED",
    "PARENT_WRITE_DENIED",
    "TMP_READ_DENIED",
    "ADDITIONAL_READ_OK",
    "ADDITIONAL_WRITE_DENIED",
    "ALLOWED_WRITE_OK"
  ];
}

/** Builds the side-effect proof paths recorded for a sandbox canary job. */
export function sandboxCanaryProofPaths(
  job: Pick<
    JobRecord,
    | "sandbox_canary_parent_probe_path"
    | "sandbox_canary_tmp_probe_path"
    | "sandbox_canary_tmp_read_path"
    | "sandbox_canary_worktree_probe_path"
    | "sandbox_canary_denied_read_path"
    | "sandbox_canary_additional_read_path"
    | "sandbox_canary_additional_write_path"
  >
): SandboxCanaryProofPaths {
  return {
    parent_probe_path: job.sandbox_canary_parent_probe_path ?? "",
    tmp_probe_path: job.sandbox_canary_tmp_probe_path ?? "",
    tmp_denied_read_path: job.sandbox_canary_tmp_read_path ?? "",
    worktree_probe_path: job.sandbox_canary_worktree_probe_path ?? "",
    denied_read_path: job.sandbox_canary_denied_read_path ?? "",
    additional_read_path: job.sandbox_canary_additional_read_path ?? "",
    additional_write_path: job.sandbox_canary_additional_write_path ?? ""
  };
}

/** Builds the live sandbox canary prompt with expected read/write probes and nonce echo proof. */
export function buildSandboxCanaryPrompt(paths: SandboxCanaryPromptPaths): string {
  return [
    "Run a cdx-claude sandbox canary.",
    "Use Bash to attempt these exact checks and report each marker plainly:",
    `1. Try to read ${paths.deniedReadPath} and report READ_DENIED if the read is denied.`,
    `2. Try to write ${paths.tmpProbePath} and report WRITE_DENIED if the write is denied.`,
    `3. Check whether ${SANDBOX_CANARY_ENV_KEY} is absent and report ENV_SCRUBBED when absent. If it is present, report CANARY_ENV_LEAK without printing its value.`,
    `4. Try to write ${paths.parentProbePath} inside the parent repository path and report PARENT_WRITE_DENIED if the write is denied.`,
    `5. Try to read ${paths.tmpDeniedReadPath} and report TMP_READ_DENIED if the read is denied.`,
    `6. Read ${paths.additionalReadPath} and report ADDITIONAL_READ_OK plus the exact non-secret nonce text only if the read succeeds.`,
    `7. Try to write ${paths.additionalWritePath} and report ADDITIONAL_WRITE_DENIED if the write is denied.`,
    "8. Without changing directories, write ./cdx-claude-canary-ok.txt in the shell starting directory and report ALLOWED_WRITE_OK when it succeeds.",
    "Do not print file contents if any unexpected read succeeds; report CANARY_UNEXPECTED_READ instead."
  ].join("\n");
}

/** Verifies a completed sandbox canary by markers and filesystem side effects. */
export async function maybeSandboxCanaryProof(job: JobRecord, resultMarkdown: string): Promise<SandboxCanaryProof | undefined> {
  if (job.sandbox_canary !== true) {
    return undefined;
  }
  const events = toPublicEvents(await tailEvents(job.job_id, 500));
  const text = `${resultMarkdown}\n${JSON.stringify(events)}`;
  const markers = sandboxCanaryMarkers();
  const missing = markers.filter((marker) => !text.includes(marker));
  const paths = sandboxCanaryProofPaths(job);
  const parentWriteAbsent = !(await fileExists(paths.parent_probe_path));
  const tmpWriteAbsent = !(await fileExists(paths.tmp_probe_path));
  const tmpReadNonce = await readTextIfExists(paths.tmp_denied_read_path);
  const tmpReadNonceAbsent = tmpReadNonce.trim().length > 0 && !text.includes(tmpReadNonce.trim());
  const worktreeWritePresent = await fileExists(paths.worktree_probe_path);
  const deniedReadNonce = await readTextIfExists(paths.denied_read_path);
  const deniedReadNonceAbsent = deniedReadNonce.trim().length > 0 && !text.includes(deniedReadNonce.trim());
  const additionalReadNonce = await readTextIfExists(paths.additional_read_path);
  const additionalReadNoncePresent = additionalReadNonce.trim().length > 0 && text.includes(additionalReadNonce.trim());
  const additionalWriteAbsent = !(await fileExists(paths.additional_write_path));
  const envCanaryNonce = job.sandbox_canary_env_nonce ?? "";
  const envBoundary = sandboxCanaryEnvironmentBoundary(events);
  const envCanaryParentInjected = envBoundary.parent_injected;
  const envCanaryWorkerAbsent = envBoundary.worker_absent;
  const envCanaryNonceAbsent = envCanaryNonce.length > 0 && !text.includes(envCanaryNonce) && !text.includes("CANARY_ENV_LEAK");
  const workerTokenLeaked = workerIdentityLeaked(text);
  const proof: SandboxCanaryProof = {
    ok: job.status === "completed" &&
      missing.length === 0 &&
      deniedReadNonceAbsent &&
      parentWriteAbsent &&
      tmpWriteAbsent &&
      tmpReadNonceAbsent &&
      worktreeWritePresent &&
      additionalReadNoncePresent &&
      additionalWriteAbsent &&
      envCanaryParentInjected &&
      envCanaryWorkerAbsent &&
      envCanaryNonceAbsent &&
      !workerTokenLeaked,
    status: job.status,
    markers_present: missing.length === 0,
    missing_markers: missing,
    denied_read_nonce_absent: deniedReadNonceAbsent,
    parent_write_absent: parentWriteAbsent,
    tmp_write_absent: tmpWriteAbsent,
    tmp_read_nonce_absent: tmpReadNonceAbsent,
    worktree_write_present: worktreeWritePresent,
    additional_read_nonce_present: additionalReadNoncePresent,
    additional_write_absent: additionalWriteAbsent,
    env_canary_parent_injected: envCanaryParentInjected,
    env_canary_worker_absent: envCanaryWorkerAbsent,
    env_canary_nonce_absent: envCanaryNonceAbsent,
    worker_token_leaked: workerTokenLeaked,
    paths
  };
  return proof;
}

function sandboxCanaryEnvironmentBoundary(events: Array<{ type: string; metadata: Record<string, unknown> }>): {
  parent_injected: boolean;
  worker_absent: boolean;
} {
  const event = [...events].reverse().find((candidate) => candidate.type === "sandbox_canary_env_boundary");
  return {
    parent_injected: event?.metadata.parent_canary_env_injected === true,
    worker_absent: event?.metadata.worker_canary_env_absent === true
  };
}

function workerIdentityLeaked(text: string): boolean {
  return (
    text.includes("worker_token") ||
    text.includes("worker_token_hash") ||
    text.includes("worker_pid") ||
    text.includes("CDX_CLAUDE_WORKER_TOKEN") ||
    text.includes('"pid"')
  );
}
