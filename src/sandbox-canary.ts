import {
  EventRecord,
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
  const allPublicText = `${resultMarkdown}\n${JSON.stringify(events)}`;
  const observedOutputText = sandboxCanaryObservedOutputText(resultMarkdown, events);
  const toolOutputText = sandboxCanaryToolOutputText(events);
  const markers = sandboxCanaryMarkers();
  const missing = markers.filter((marker) => !observedOutputText.includes(marker));
  const paths = sandboxCanaryProofPaths(job);
  const parentWriteAbsent = !(await fileExists(paths.parent_probe_path));
  const tmpWriteAbsent = !(await fileExists(paths.tmp_probe_path));
  const tmpReadNonce = await readTextIfExists(paths.tmp_denied_read_path);
  const tmpReadNonceAbsent = tmpReadNonce.trim().length > 0 && !allPublicText.includes(tmpReadNonce.trim());
  const worktreeWritePresent = await fileExists(paths.worktree_probe_path);
  const deniedReadNonce = await readTextIfExists(paths.denied_read_path);
  const deniedReadNonceAbsent = deniedReadNonce.trim().length > 0 && !allPublicText.includes(deniedReadNonce.trim());
  const additionalReadNonce = await readTextIfExists(paths.additional_read_path);
  const additionalReadNoncePresent = additionalReadNonce.trim().length > 0 && observedOutputText.includes(additionalReadNonce.trim());
  const additionalWriteAbsent = !(await fileExists(paths.additional_write_path));
  const envCanaryNonce = job.sandbox_canary_env_nonce ?? "";
  const envBoundary = sandboxCanaryEnvironmentBoundary(events);
  const envCanaryParentInjected = envBoundary.parent_injected;
  const envCanaryWorkerAbsent = envBoundary.worker_absent;
  const envCanaryNonceAbsent = envCanaryNonce.length > 0 &&
    !allPublicText.includes(envCanaryNonce) &&
    !toolOutputText.includes("CANARY_ENV_LEAK");
  const workerTokenLeaked = workerIdentityLeaked(allPublicText);
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

function sandboxCanaryObservedOutputText(resultMarkdown: string, events: EventRecord[]): string {
  const chunks = [resultMarkdown];
  for (const event of events) {
    if (event.type === "result" || event.type === "success") {
      chunks.push(event.summary);
    }
    appendObservedMetadataText(event.metadata, chunks);
  }
  return chunks.join("\n");
}

function sandboxCanaryToolOutputText(events: EventRecord[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    appendToolOutputText(event.metadata, chunks, false);
  }
  return chunks.join("\n");
}

function appendObservedMetadataText(value: unknown, chunks: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      appendObservedMetadataText(item, chunks);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  if (value.type === "tool_result" && typeof value.content === "string") {
    chunks.push(value.content);
  }
  if (value.type === "text" && typeof value.text === "string") {
    chunks.push(value.text);
  }
  if (isPlainRecord(value.tool_use_result)) {
    const stdout = value.tool_use_result.stdout;
    const stderr = value.tool_use_result.stderr;
    if (typeof stdout === "string") {
      chunks.push(stdout);
    }
    if (typeof stderr === "string") {
      chunks.push(stderr);
    }
  }
  if (typeof value.result === "string") {
    chunks.push(value.result);
  }
  for (const nested of Object.values(value)) {
    appendObservedMetadataText(nested, chunks);
  }
}

function appendToolOutputText(value: unknown, chunks: string[], insideToolOutput: boolean): void {
  if (typeof value === "string") {
    if (insideToolOutput) {
      chunks.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      appendToolOutputText(item, chunks, insideToolOutput);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  if (value.tool_use_result !== undefined) {
    appendToolOutputText(value.tool_use_result, chunks, true);
  }
  if (value.type === "tool_result") {
    appendToolOutputText(value.content, chunks, true);
  }
  for (const nested of Object.values(value)) {
    appendToolOutputText(nested, chunks, insideToolOutput);
  }
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
