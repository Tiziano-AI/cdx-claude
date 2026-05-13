import {
  DiffReport,
  EventRecord,
  EventRecordSchema,
  JobView,
  JobViewSchema,
  ResultReport,
  SandboxCanaryProof,
  SandboxCanaryProofPaths,
  SandboxCanaryReport
} from "./contracts.js";
import { authSecretRedactionValues } from "./auth-env.js";

/** Projects public surfaces with configured Claude auth secret values redacted. */
export async function redactAuthSecretsInJobView(job: JobView): Promise<JobView> {
  const secrets = await authSecretRedactionValues();
  return redactJobView(job, secrets);
}

/** Projects public event tails with configured Claude auth secret values redacted. */
export async function redactAuthSecretsInEvents(events: EventRecord[]): Promise<EventRecord[]> {
  const secrets = await authSecretRedactionValues();
  return events.map((event) => EventRecordSchema.parse(redactUnknown(event, secrets)));
}

/** Projects public result reports with configured Claude auth secret values redacted. */
export async function redactAuthSecretsInResultReport(report: ResultReport): Promise<ResultReport> {
  const secrets = await authSecretRedactionValues();
  return {
    job: redactJobView(report.job, secrets),
    result_markdown: redactText(report.result_markdown, secrets),
    receipt: report.receipt,
    diff_available: report.diff_available,
    ...(report.sandbox_canary_proof === undefined ? {} : { sandbox_canary_proof: redactSandboxCanaryProof(report.sandbox_canary_proof, secrets) })
  };
}

/** Projects public diff reports with configured Claude auth secret values redacted. */
export async function redactAuthSecretsInDiffReport(report: DiffReport): Promise<DiffReport> {
  const secrets = await authSecretRedactionValues();
  return {
    job: redactJobView(report.job, secrets),
    diff: redactText(report.diff, secrets),
    diff_path: redactText(report.diff_path, secrets)
  };
}

/** Projects sandbox canary reports with configured Claude auth secret values redacted. */
export async function redactAuthSecretsInSandboxCanaryReport(report: SandboxCanaryReport): Promise<SandboxCanaryReport> {
  const secrets = await authSecretRedactionValues();
  return {
    job: redactJobView(report.job, secrets),
    expected_markers: report.expected_markers.map((marker) => redactText(marker, secrets)),
    proof_paths: redactSandboxCanaryProofPaths(report.proof_paths, secrets)
  };
}

function redactJobView(job: JobView, secrets: string[]): JobView {
  return JobViewSchema.parse(redactUnknown(job, secrets));
}

function redactSandboxCanaryProof(proof: SandboxCanaryProof, secrets: string[]): SandboxCanaryProof {
  return {
    ok: proof.ok,
    status: redactText(proof.status, secrets),
    markers_present: proof.markers_present,
    missing_markers: proof.missing_markers.map((marker) => redactText(marker, secrets)),
    denied_read_nonce_absent: proof.denied_read_nonce_absent,
    parent_write_absent: proof.parent_write_absent,
    tmp_write_absent: proof.tmp_write_absent,
    worktree_write_present: proof.worktree_write_present,
    worker_token_leaked: proof.worker_token_leaked,
    paths: redactSandboxCanaryProofPaths(proof.paths, secrets)
  };
}

function redactSandboxCanaryProofPaths(paths: SandboxCanaryProofPaths, secrets: string[]): SandboxCanaryProofPaths {
  return {
    parent_probe_path: redactText(paths.parent_probe_path, secrets),
    tmp_probe_path: redactText(paths.tmp_probe_path, secrets),
    worktree_probe_path: redactText(paths.worktree_probe_path, secrets),
    denied_read_path: redactText(paths.denied_read_path, secrets)
  };
}

function redactUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets));
  }
  if (isPlainRecord(value)) {
    return redactRecord(value, secrets);
  }
  return value;
}

function redactRecord(record: Record<string, unknown>, secrets: string[]): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = redactUnknown(value, secrets);
  }
  return redacted;
}

function redactText(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
