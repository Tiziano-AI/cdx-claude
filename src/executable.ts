import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const NODE_EXECUTABLE_ENV = "CDX_CLAUDE_NODE_EXECUTABLE";

export interface ExecutableResolution {
  executable: string;
  source: "search_path" | "process_exec_path" | "command_name";
  env_key?: string;
  current_exec_path?: string;
  rejected?: Array<{ source: string; executable: string; reason: string }>;
}

/** Returns an executable file from the current PATH without retaining stale absolute runtime paths. */
export function resolvePathExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of executableSearchDirectories(environment)) {
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Resolves the Node executable and records which runtime layer supplied it. */
export function resolveNodeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  currentExecPath = process.execPath
): ExecutableResolution {
  const rejected: Array<{ source: string; executable: string; reason: string }> = [];
  const configured = environment[NODE_EXECUTABLE_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    rejected.push({
      source: "configured",
      executable: configured,
      reason: "CDX_CLAUDE_NODE_EXECUTABLE is not a supported runtime override"
    });
  }
  const fromPath = resolvePathExecutable("node", environment);
  if (fromPath !== undefined) {
    return { executable: fromPath, source: "search_path", rejected };
  }
  if (isExecutableFile(currentExecPath)) {
    return { executable: currentExecPath, source: "process_exec_path", current_exec_path: currentExecPath, rejected };
  }
  return { executable: "node", source: "command_name", current_exec_path: currentExecPath, rejected };
}

/** Resolves the Node executable for doctor checks and detached worker launch. */
export function resolveNodeExecutablePath(
  environment: NodeJS.ProcessEnv = process.env,
  currentExecPath = process.execPath
): string {
  return resolveNodeExecutable(environment, currentExecPath).executable;
}

export function isExecutableFile(candidate: string): boolean {
  if (!existsSync(candidate)) {
    return false;
  }
  const stats = statSync(candidate);
  return stats.isFile() && (stats.mode & 0o111) !== 0;
}

function executableSearchDirectories(environment: NodeJS.ProcessEnv): string[] {
  return uniqueStrings((environment.PATH ?? "").split(path.delimiter));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value.length === 0 || !path.isAbsolute(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}
