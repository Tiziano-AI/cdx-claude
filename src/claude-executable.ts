import { resolvePathExecutable } from "./executable.js";

export const CLAUDE_CODE_EXECUTABLE_ENV = "CDX_CLAUDE_CODE_EXECUTABLE";

/** Resolves the local Claude Code executable used by the Claude Agent SDK subprocess. */
export function resolveClaudeCodeExecutablePath(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment[CLAUDE_CODE_EXECUTABLE_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    return configured;
  }
  return resolvePathExecutable("claude", environment);
}
