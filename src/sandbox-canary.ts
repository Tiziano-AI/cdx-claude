import {
  JobRecord,
  JobView,
  SandboxCanaryProof,
  SandboxCanaryProofPaths
} from "./contracts.js";
import { fileExists, readTextIfExists } from "./fs-util.js";
import { toPublicEvents } from "./event-view.js";
import { tailEvents } from "./ledger.js";

/** Returns the required live canary markers Claude must report after the sandbox run. */
export function sandboxCanaryMarkers(): string[] {
  return ["READ_DENIED", "WRITE_DENIED", "ENV_SCRUBBED", "PARENT_WRITE_DENIED", "ALLOWED_WRITE_OK"];
}

/** Builds the side-effect proof paths recorded for a sandbox canary job. */
export function sandboxCanaryProofPaths(
  job: Pick<JobRecord, "sandbox_canary_parent_probe_path" | "sandbox_canary_tmp_probe_path" | "sandbox_canary_worktree_probe_path" | "sandbox_canary_denied_read_path">
): SandboxCanaryProofPaths {
  return {
    parent_probe_path: job.sandbox_canary_parent_probe_path ?? "",
    tmp_probe_path: job.sandbox_canary_tmp_probe_path ?? "",
    worktree_probe_path: job.sandbox_canary_worktree_probe_path ?? "",
    denied_read_path: job.sandbox_canary_denied_read_path ?? ""
  };
}

/** Verifies a completed sandbox canary by markers and filesystem side effects. */
export async function maybeSandboxCanaryProof(job: JobView, resultMarkdown: string): Promise<SandboxCanaryProof | undefined> {
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
  const worktreeWritePresent = await fileExists(paths.worktree_probe_path);
  const deniedReadNonce = await readTextIfExists(paths.denied_read_path);
  const deniedReadNonceAbsent = deniedReadNonce.trim().length > 0 && !text.includes(deniedReadNonce.trim());
  const workerTokenLeaked = workerIdentityLeaked(text);
  const proof: SandboxCanaryProof = {
    ok: job.status === "completed" && missing.length === 0 && deniedReadNonceAbsent && parentWriteAbsent && tmpWriteAbsent && worktreeWritePresent && !workerTokenLeaked,
    status: job.status,
    markers_present: missing.length === 0,
    missing_markers: missing,
    denied_read_nonce_absent: deniedReadNonceAbsent,
    parent_write_absent: parentWriteAbsent,
    tmp_write_absent: tmpWriteAbsent,
    worktree_write_present: worktreeWritePresent,
    worker_token_leaked: workerTokenLeaked,
    paths
  };
  return proof;
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
