import path from "node:path";
import { lstatSync, statSync } from "node:fs";
import { isExecutableFile } from "./executable.js";

export const CLAUDE_CODE_EXECUTABLE_ENV = "CDX_CLAUDE_CODE_EXECUTABLE";

export interface ClaudeCodeExecutableResolution {
  executable?: string;
  source: "configured" | "sdk_bundled";
  env_key: typeof CLAUDE_CODE_EXECUTABLE_ENV;
  rejected?: { executable: string; reason: string };
}

/** Resolves the local Claude Code executable used by the Claude Agent SDK subprocess. */
export function resolveClaudeCodeExecutablePath(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveClaudeCodeExecutable(environment).executable;
}

/** Resolves Claude Code executable policy; SDK-bundled Claude is the default. */
export function resolveClaudeCodeExecutable(
  environment: NodeJS.ProcessEnv = process.env
): ClaudeCodeExecutableResolution {
  const configured = environment[CLAUDE_CODE_EXECUTABLE_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    const validationError = validateConfiguredExecutable(configured);
    if (validationError === undefined) {
      return {
        executable: configured,
        source: "configured",
        env_key: CLAUDE_CODE_EXECUTABLE_ENV
      };
    }
    return {
      source: "sdk_bundled",
      env_key: CLAUDE_CODE_EXECUTABLE_ENV,
      rejected: {
        executable: configured,
        reason: validationError
      }
    };
  }
  return {
    source: "sdk_bundled",
    env_key: CLAUDE_CODE_EXECUTABLE_ENV
  };
}

function validateConfiguredExecutable(executable: string): string | undefined {
  if (!path.isAbsolute(executable)) {
    return "configured executable must be an absolute path";
  }
  if (!isExecutableFile(executable)) {
    return "configured executable is missing or not executable";
  }
  const linkStats = lstatSync(executable);
  if (linkStats.isSymbolicLink()) {
    return "configured executable must not be a symlink";
  }
  const stats = statSync(executable);
  if ((stats.mode & 0o022) !== 0) {
    return "configured executable must not be group/world writable";
  }
  if (!ownerOk(stats.uid)) {
    return "configured executable owner is not trusted";
  }
  const parentStats = statSync(path.dirname(executable));
  if ((parentStats.mode & 0o022) !== 0) {
    return "configured executable parent directory must not be group/world writable";
  }
  return undefined;
}

function ownerOk(uid: number): boolean {
  if (typeof process.getuid !== "function") {
    return true;
  }
  const currentUid = process.getuid();
  return uid === currentUid || uid === 0;
}
