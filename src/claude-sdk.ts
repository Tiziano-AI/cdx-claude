import { createRequire } from "node:module";

export interface ClaudeQueryInput {
  prompt: string;
  options: ClaudeOptions;
}

export interface ClaudeQuery extends AsyncIterable<unknown> {
  close: () => void;
  stopTask: (taskId: string) => Promise<void>;
}

export interface ClaudeOptions {
  abortController: AbortController;
  cwd: string;
  additionalDirectories?: string[];
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, never>;
  settingSources: [];
  skills: string[];
  plugins: [];
  strictMcpConfig: boolean;
  permissionMode: "default";
  pathToClaudeCodeExecutable?: string;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string }
  ) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID?: string }
    | { behavior: "deny"; message: string; toolUseID?: string }
  >;
  env: Record<string, string | undefined>;
  systemPrompt?: { type: "preset"; preset: "claude_code"; append: string };
  sandbox?: ClaudeSandboxSettings;
  maxTurns: number;
  agentProgressSummaries: boolean;
  model?: string;
  /** Claude Agent SDK API-equivalent usage-estimate stop guard, not authoritative billing. */
  maxBudgetUsd?: number;
}

export interface ClaudeSandboxSettings {
  enabled: boolean;
  failIfUnavailable: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  filesystem: ClaudeSandboxFilesystem;
}

export interface ClaudeSandboxFilesystem {
  allowManagedReadPathsOnly: boolean;
  allowRead: string[];
  allowWrite: string[];
  denyRead: string[];
  denyWrite: string[];
}

const require = createRequire(import.meta.url);
export function loadClaudeSdk(): { query: (input: ClaudeQueryInput) => ClaudeQuery } {
  const loaded: unknown = require("@anthropic-ai/claude-agent-sdk");
  if (!isClaudeModule(loaded)) {
    throw new Error("Claude Agent SDK did not expose query()");
  }
  return {
    query(input) {
      const result = loaded.query(input);
      if (!isClaudeQuery(result)) {
        throw new Error("Claude SDK query did not return a controllable async iterable");
      }
      return result;
    }
  };
}

function isClaudeModule(value: unknown): value is { query: (input: ClaudeQueryInput) => unknown } {
  return typeof value === "object" && value !== null && "query" in value && typeof value.query === "function";
}

function isClaudeQuery(value: unknown): value is ClaudeQuery {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    "close" in value &&
    typeof value.close === "function" &&
    "stopTask" in value &&
    typeof value.stopTask === "function"
  );
}
