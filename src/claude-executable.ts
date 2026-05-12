import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const CLAUDE_CODE_EXECUTABLE_ENV = "CDX_CLAUDE_CODE_EXECUTABLE";

/** Resolves the local Claude Code executable used by the Claude Agent SDK subprocess. */
export function resolveClaudeCodeExecutablePath(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment[CLAUDE_CODE_EXECUTABLE_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    return configured;
  }
  const searchPath = environment.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = path.join(directory, "claude");
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  if (!existsSync(candidate)) {
    return false;
  }
  const stats = statSync(candidate);
  return stats.isFile() && (stats.mode & 0o111) !== 0;
}
