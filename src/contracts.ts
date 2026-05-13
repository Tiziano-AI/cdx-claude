import { z } from "zod";
import path from "node:path";

export const JobModeSchema = z.enum(["research", "patch", "patch_autonomous"]);
export const JobStatusSchema = z.enum(["starting", "running", "stopping", "completed", "failed", "stopped", "stale"]);
export const JobIdSchema = z.string().regex(/^claude-\d{8}-\d{9}-[0-9a-f]{8}$/, "job_id must be a generated cdx-claude id");
export const AgentRoleNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "agent_role must be a packaged delegate role name");
export const DEFAULT_SDK_USAGE_GUARD_USD = 25;
export const MAX_SDK_USAGE_GUARD_USD = 100;

export type JobMode = z.infer<typeof JobModeSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const StartRequestSchema = z.object({
  cwd: z.string().min(1).refine((value) => path.isAbsolute(value), "cwd must be an absolute path"),
  prompt: z.string().min(1),
  mode: JobModeSchema,
  agent_role: AgentRoleNameSchema,
  allow_web: z.boolean().default(false),
  title: z.string().min(1).max(120).optional(),
  model: z.string().min(1).optional(),
  max_budget_usd: z.number().positive().max(MAX_SDK_USAGE_GUARD_USD).optional()
}).strict();

export const JobIdRequestSchema = z.object({
  job_id: JobIdSchema
}).strict();

export const TailRequestSchema = JobIdRequestSchema.extend({
  limit: z.number().int().positive().max(500).default(50),
  after_seq: z.number().int().nonnegative().optional()
}).strict();

export const ListRequestSchema = z.object({
  status: JobStatusSchema.optional(),
  limit: z.number().int().positive().max(500).default(100)
}).strict();

export const CleanupRequestSchema = JobIdRequestSchema.extend({
  force: z.boolean().default(false),
  remove_ledger: z.boolean().default(false)
}).strict();

export const SandboxCanaryRequestSchema = z.object({
  agent_role: AgentRoleNameSchema,
  model: z.string().min(1).optional(),
  max_budget_usd: z.number().positive().max(MAX_SDK_USAGE_GUARD_USD).default(DEFAULT_SDK_USAGE_GUARD_USD)
}).strict();

export const EmptyRequestSchema = z.object({}).strict();

export const EventRecordSchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  type: z.string().min(1),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const JobRecordSchema = z.object({
  job_id: JobIdSchema,
  title: z.string().min(1),
  mode: JobModeSchema,
  status: JobStatusSchema,
  cwd: z.string().min(1),
  execution_cwd: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  prompt: z.string().min(1),
  agent_role: AgentRoleNameSchema,
  agent_description: z.string().min(1).optional(),
  agent_prompt: z.string().min(1).optional(),
  agent_role_path: z.string().min(1).optional(),
  allow_web: z.boolean().default(false),
  base_commit: z.string().min(1).optional(),
  parent_dirty: z.boolean().optional(),
  worktree_path: z.string().min(1).optional(),
  worker_pid: z.number().int().positive().optional(),
  worker_token_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  worker_started_at: z.string().optional(),
  worker_claimed_at: z.string().optional(),
  worker_last_seen_at: z.string().optional(),
  worker_exited_at: z.string().optional(),
  worker_exit_code: z.number().int().optional(),
  stop_requested_at: z.string().optional(),
  terminal_at: z.string().optional(),
  terminal_reason: z.string().min(1).optional(),
  claude_session_id: z.string().min(1).optional(),
  claude_task_ids: z.array(z.string()).default([]),
  model: z.string().min(1).optional(),
  max_budget_usd: z.number().positive().max(MAX_SDK_USAGE_GUARD_USD).optional(),
  sandbox_canary: z.boolean().optional(),
  sandbox_canary_parent_probe_path: z.string().min(1).optional(),
  sandbox_canary_tmp_probe_path: z.string().min(1).optional(),
  sandbox_canary_worktree_probe_path: z.string().min(1).optional(),
  sandbox_canary_denied_read_path: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

export const JobViewSchema = z.object({
  job_id: JobIdSchema,
  title: z.string().min(1),
  mode: JobModeSchema,
  status: JobStatusSchema,
  cwd: z.string().min(1),
  execution_cwd: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  prompt: z.string().min(1),
  agent_role: AgentRoleNameSchema,
  agent_description: z.string().min(1).optional(),
  agent_role_path: z.string().min(1).optional(),
  allow_web: z.boolean().default(false),
  base_commit: z.string().min(1).optional(),
  parent_dirty: z.boolean().optional(),
  worktree_path: z.string().min(1).optional(),
  stop_requested_at: z.string().optional(),
  terminal_at: z.string().optional(),
  terminal_reason: z.string().min(1).optional(),
  claude_session_id: z.string().min(1).optional(),
  claude_task_ids: z.array(z.string()).default([]),
  model: z.string().min(1).optional(),
  max_budget_usd: z.number().positive().max(MAX_SDK_USAGE_GUARD_USD).optional(),
  sandbox_canary: z.boolean().optional(),
  sandbox_canary_parent_probe_path: z.string().min(1).optional(),
  sandbox_canary_tmp_probe_path: z.string().min(1).optional(),
  sandbox_canary_worktree_probe_path: z.string().min(1).optional(),
  sandbox_canary_denied_read_path: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

export const ReceiptSchema = z.object({
  job_id: z.string().min(1),
  next_seq: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  exported_diff: z.boolean().default(false)
});

export type StartRequest = z.infer<typeof StartRequestSchema>;
export type CleanupRequest = z.infer<typeof CleanupRequestSchema>;
export type SandboxCanaryRequest = z.infer<typeof SandboxCanaryRequestSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type JobView = z.infer<typeof JobViewSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;

export interface DoctorReport {
  ok: boolean;
  claude: DoctorCheck;
  node: DoctorCheck;
  ledger: DoctorCheck;
  roles: DoctorCheck;
  plugin: DoctorCheck;
  sandbox: DoctorCheck;
}

export interface DoctorCheck {
  ok: boolean;
  summary: string;
  details: Record<string, unknown>;
}

export interface ResultReport {
  job: JobView;
  result_markdown: string;
  receipt: Receipt;
  diff_available: boolean;
  sandbox_canary_proof?: SandboxCanaryProof;
}

export interface DiffReport {
  job: JobView;
  diff: string;
  diff_path: string;
}

export interface RoleReport {
  source: Record<string, unknown>;
  roles: RoleSummary[];
}

export interface RoleSummary {
  name: string;
  description: string;
  path: string;
  contract: Record<string, unknown>;
}

export interface SandboxCanaryReport {
  job: JobView;
  expected_markers: string[];
  proof_paths: SandboxCanaryProofPaths;
}

export interface SandboxCanaryProof {
  ok: boolean;
  status: string;
  markers_present: boolean;
  missing_markers: string[];
  denied_read_nonce_absent: boolean;
  parent_write_absent: boolean;
  tmp_write_absent: boolean;
  worktree_write_present: boolean;
  worker_token_leaked: boolean;
  paths: SandboxCanaryProofPaths;
}

export interface SandboxCanaryProofPaths {
  parent_probe_path: string;
  tmp_probe_path: string;
  worktree_probe_path: string;
  denied_read_path: string;
}

export interface ResponseMeta {
  schema_version: 1;
  command: string;
  generated_at: string;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: ResponseMeta;
}

export interface FailureEnvelope {
  ok: false;
  error: ErrorEnvelope;
  meta: ResponseMeta;
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  field?: string;
  recoverable: boolean;
  hint?: string;
}

const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().optional(),
  recoverable: z.boolean(),
  hint: z.string().optional()
});

const ResponseMetaSchema = z.object({
  schema_version: z.literal(1),
  command: z.string(),
  generated_at: z.string()
});

export const EnvelopeOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: z.unknown(),
    meta: ResponseMetaSchema
  }),
  z.object({
    ok: z.literal(false),
    error: ErrorEnvelopeSchema,
    meta: ResponseMetaSchema
  })
]);
