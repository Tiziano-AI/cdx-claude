import { JobRecord, JobView, JobViewSchema } from "./contracts.js";

/** Maps internal ledger records to the public job view allowlist. */
export function toJobView(job: JobRecord): JobView {
  const view: JobView = {
    job_id: job.job_id,
    title: job.title,
    mode: job.mode,
    status: job.status,
    cwd: job.cwd,
    execution_cwd: job.execution_cwd,
    additional_directories: job.additional_directories,
    created_at: job.created_at,
    updated_at: job.updated_at,
    prompt: job.prompt,
    agent_role: job.agent_role,
    allow_web: job.allow_web,
    claude_task_ids: job.claude_task_ids
  };
  copyOptionalJobViewFields(job, view);
  return JobViewSchema.parse(view);
}

function copyOptionalJobViewFields(job: JobRecord, view: JobView): void {
  if (job.agent_description !== undefined) {
    view.agent_description = job.agent_description;
  }
  if (job.agent_role_path !== undefined) {
    view.agent_role_path = job.agent_role_path;
  }
  if (job.base_commit !== undefined) {
    view.base_commit = job.base_commit;
  }
  if (job.parent_dirty !== undefined) {
    view.parent_dirty = job.parent_dirty;
  }
  if (job.worktree_path !== undefined) {
    view.worktree_path = job.worktree_path;
  }
  if (job.stop_requested_at !== undefined) {
    view.stop_requested_at = job.stop_requested_at;
  }
  if (job.terminal_at !== undefined) {
    view.terminal_at = job.terminal_at;
  }
  if (job.terminal_reason !== undefined) {
    view.terminal_reason = job.terminal_reason;
  }
  if (job.claude_session_id !== undefined) {
    view.claude_session_id = job.claude_session_id;
  }
  if (job.model !== undefined) {
    view.model = job.model;
  }
  if (job.max_budget_usd !== undefined) {
    view.max_budget_usd = job.max_budget_usd;
  }
  if (job.sandbox_canary !== undefined) {
    view.sandbox_canary = job.sandbox_canary;
  }
  if (job.sandbox_canary_parent_probe_path !== undefined) {
    view.sandbox_canary_parent_probe_path = job.sandbox_canary_parent_probe_path;
  }
  if (job.sandbox_canary_tmp_probe_path !== undefined) {
    view.sandbox_canary_tmp_probe_path = job.sandbox_canary_tmp_probe_path;
  }
  if (job.sandbox_canary_tmp_read_path !== undefined) {
    view.sandbox_canary_tmp_read_path = job.sandbox_canary_tmp_read_path;
  }
  if (job.sandbox_canary_worktree_probe_path !== undefined) {
    view.sandbox_canary_worktree_probe_path = job.sandbox_canary_worktree_probe_path;
  }
  if (job.sandbox_canary_denied_read_path !== undefined) {
    view.sandbox_canary_denied_read_path = job.sandbox_canary_denied_read_path;
  }
  if (job.sandbox_canary_additional_read_path !== undefined) {
    view.sandbox_canary_additional_read_path = job.sandbox_canary_additional_read_path;
  }
  if (job.sandbox_canary_additional_write_path !== undefined) {
    view.sandbox_canary_additional_write_path = job.sandbox_canary_additional_write_path;
  }
  if (job.error !== undefined) {
    view.error = job.error;
  }
}
