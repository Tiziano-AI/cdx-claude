import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { authEnvironmentFromProcess } from "./auth-env.js";
import { resolveClaudeCodeExecutablePath } from "./claude-executable.js";
import { JobRecord } from "./contracts.js";
import { ClaudeOptions, ClaudeSandboxSettings, loadClaudeSdk } from "./claude-sdk.js";
import { appendEvent, updateJob, writeResultMarkdown } from "./ledger.js";
import { buildPermissionGate } from "./permission.js";
import { jobsRoot, PLUGIN_VERSION, tempPath } from "./paths.js";

const MessageSummarySchema = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
    task_id: z.string().optional(),
    status: z.string().optional(),
    summary: z.string().optional()
  })
  .passthrough();

export async function runClaudeJob(job: JobRecord, stopSignal?: AbortSignal): Promise<void> {
  if (process.env.CDX_CLAUDE_DRIVER === "fake") {
    await runFakeJob(job, stopSignal);
    return;
  }
  await runSdkJob(job, stopSignal);
}

/** Raised when the Claude SDK returns a terminal error result instead of a success result. */
export class ClaudeResultError extends Error {
  readonly subtype: string;

  constructor(subtype: string) {
    super(`Claude SDK returned ${subtype}`);
    this.subtype = subtype;
  }
}

async function runFakeJob(job: JobRecord, stopSignal?: AbortSignal): Promise<void> {
  const echoedAuthValue = fakeEchoedEnvironmentValue();
  await appendEvent(job.job_id, "fake_start", "Fake Claude driver started", {
    execution_cwd: job.execution_cwd,
    ...(echoedAuthValue === undefined ? {} : { echoed_auth_value: echoedAuthValue })
  });
  await waitForFakeDelay(stopSignal);
  if (stopSignal?.aborted === true) {
    await appendEvent(job.job_id, "fake_stopped", "Fake Claude driver stopped");
    return;
  }
  if (job.mode !== "research") {
    await mkdir(job.execution_cwd, { recursive: true });
    await appendFile(
      path.join(job.execution_cwd, "README.md"),
      `\nFake Claude output for ${job.job_id}${echoedAuthValue === undefined ? "" : ` with ${echoedAuthValue}`}\n`,
      "utf8"
    );
  }
  await writeResultMarkdown(
    job.job_id,
    `# Claude delegate result\n\nFake driver completed job ${job.job_id}.\n${echoedAuthValue === undefined ? "" : `Echoed auth value: ${echoedAuthValue}\n`}`
  );
  await appendEvent(job.job_id, "fake_complete", "Fake Claude driver completed");
}

function fakeEchoedEnvironmentValue(): string | undefined {
  const key = process.env.CDX_CLAUDE_FAKE_ECHO_ENV_KEY;
  if (key === undefined || key.trim().length === 0) {
    return undefined;
  }
  return process.env[key];
}

async function runSdkJob(job: JobRecord, stopSignal?: AbortSignal): Promise<void> {
  await mkdir(tempPath(job.job_id), { recursive: true });
  const abortController = new AbortController();
  const options = buildClaudeOptionsForJob(job, abortController);
  const sdk = loadClaudeSdk();
  if (stopSignal?.aborted === true) {
    abortController.abort();
  }
  const stream = sdk.query({
    prompt: job.prompt,
    options
  });
  const stopListener = (): void => {
    abortController.abort();
    stream.close();
  };
  stopSignal?.addEventListener("abort", stopListener, { once: true });
  let resultText = "";
  let resultErrorSubtype: string | undefined;
  try {
    for await (const message of stream) {
      if (stopSignal?.aborted === true) {
        break;
      }
      const summary = summarizeMessage(message);
      await appendEvent(job.job_id, summary.type, summary.summary, summary.metadata);
      if (summary.session_id !== undefined) {
        await updateJob(job.job_id, { claude_session_id: summary.session_id });
      }
      if (summary.task_id !== undefined) {
        const current = await updateJob(job.job_id, {});
        if (!current.claude_task_ids.includes(summary.task_id)) {
          await updateJob(job.job_id, {
            claude_task_ids: [...current.claude_task_ids, summary.task_id]
          });
        }
      }
      const parsed = MessageSummarySchema.parse(message);
      const sdkErrorSubtype = sdkResultErrorSubtype(message);
      if (parsed.type === "result") {
        resultText = JSON.stringify(message, null, 2);
        if (sdkErrorSubtype !== undefined) {
          resultErrorSubtype = sdkErrorSubtype;
        }
      }
    }
  } finally {
    stopSignal?.removeEventListener("abort", stopListener);
  }
  if (stopSignal?.aborted === true) {
    stream.close();
    return;
  }
  await writeResultMarkdown(job.job_id, resultText.length > 0 ? resultText : "Claude completed without a result body.\n");
  if (resultErrorSubtype !== undefined) {
    throw new ClaudeResultError(resultErrorSubtype);
  }
}

/** Returns the SDK result error subtype when a message represents terminal Claude failure. */
export function sdkResultErrorSubtype(message: unknown): string | undefined {
  const parsed = MessageSummarySchema.parse(message);
  if (parsed.type === "result" && parsed.subtype !== undefined && parsed.subtype !== "success") {
    return parsed.subtype;
  }
  return undefined;
}

/** Builds the Claude Agent SDK options for a job without starting the SDK process. */
export function buildClaudeOptionsForJob(job: JobRecord, abortController: AbortController): ClaudeOptions {
  const tools = allToolsForJob(job);
  const claudeExecutable = resolveClaudeCodeExecutablePath();
  const base: ClaudeOptions = {
    abortController,
    cwd: job.execution_cwd,
    tools,
    allowedTools: [],
    disallowedTools: job.mode === "patch_autonomous" ? [] : ["Bash"],
    mcpServers: {},
    settingSources: [],
    skills: [],
    plugins: [],
    strictMcpConfig: true,
    permissionMode: "default",
    ...(claudeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: claudeExecutable }),
    canUseTool: buildPermissionGate(job.mode, job.execution_cwd),
    env: claudeEnvironment(job.job_id),
    ...(job.agent_prompt === undefined
      ? {}
      : { systemPrompt: { type: "preset", preset: "claude_code", append: job.agent_prompt } }),
    maxTurns: 50,
    agentProgressSummaries: true,
    ...(job.mode === "patch_autonomous" ? { sandbox: sandboxForJob(job) } : {})
  };
  return {
    ...base,
    ...(job.model === undefined ? {} : { model: job.model }),
    ...(job.max_budget_usd === undefined ? {} : { maxBudgetUsd: job.max_budget_usd })
  };
}

async function waitForFakeDelay(stopSignal?: AbortSignal): Promise<void> {
  const milliseconds = Number.parseInt(process.env.CDX_CLAUDE_FAKE_DELAY_MS ?? "0", 10);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || stopSignal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    stopSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function toolsForMode(mode: JobRecord["mode"]): string[] {
  const fileTools = mode === "research"
    ? ["Read", "Grep", "Glob", "LS"]
    : mode === "patch_autonomous"
      ? ["Read", "Grep", "Glob", "LS", "Edit", "Write", "MultiEdit", "Bash"]
      : ["Read", "Grep", "Glob", "LS", "Edit", "Write", "MultiEdit"];
  return fileTools;
}

function webToolsForJob(job: JobRecord): string[] {
  if (!job.allow_web) {
    return [];
  }
  return ["WebFetch", "WebSearch"];
}

function allToolsForJob(job: JobRecord): string[] {
  return [...toolsForMode(job.mode), ...webToolsForJob(job)];
}

function claudeEnvironment(jobId: string): Record<string, string | undefined> {
  return {
    ...authEnvironmentFromProcess(),
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: tempPath(jobId),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: `cdx-claude/${PLUGIN_VERSION}`
  };
}

function sandboxForJob(job: JobRecord): ClaudeSandboxSettings {
  const home = homedir();
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowManagedReadPathsOnly: true,
      allowRead: [job.execution_cwd, tempPath(job.job_id)],
      allowWrite: [job.execution_cwd, tempPath(job.job_id)],
      denyRead: [
        job.cwd,
        home,
        path.join(home, ".secrets"),
        path.join(home, ".ssh"),
        path.join(home, ".codex"),
        path.join(home, ".claude.json"),
        path.join(home, ".gemini")
      ],
      denyWrite: [
        job.cwd,
        jobsRoot(),
        path.join(home, ".secrets"),
        path.join(home, ".ssh"),
        path.join(home, ".codex", "config.toml"),
        path.join(home, ".codex", "auth.json"),
        path.join(home, ".claude.json"),
        path.join(home, ".gemini")
      ]
    }
  };
}

function summarizeMessage(message: unknown): {
  type: string;
  summary: string;
  metadata: Record<string, unknown>;
  session_id?: string;
  task_id?: string;
} {
  const parsed = MessageSummarySchema.parse(message);
  const type = parsed.subtype ?? parsed.type;
  const summary = parsed.summary ?? parsed.status ?? parsed.subtype ?? parsed.type;
  return {
    type,
    summary,
    metadata: { message },
    ...(parsed.session_id === undefined ? {} : { session_id: parsed.session_id }),
    ...(parsed.task_id === undefined ? {} : { task_id: parsed.task_id })
  };
}
