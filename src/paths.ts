import { homedir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT_NAME = "cdx-claude";
export const PLUGIN_VERSION = "0.1.2";

export function stateRoot(): string {
  return process.env.CDX_CLAUDE_HOME ?? path.join(homedir(), ".codex", PRODUCT_NAME);
}

export function jobsRoot(): string {
  return path.join(stateRoot(), "jobs");
}

export function worktreesRoot(): string {
  return path.join(stateRoot(), "worktrees");
}

export function jobDir(jobId: string): string {
  return path.join(jobsRoot(), jobId);
}

export function jobJsonPath(jobId: string): string {
  return path.join(jobDir(jobId), "job.json");
}

export function eventsPath(jobId: string): string {
  return path.join(jobDir(jobId), "events.jsonl");
}

export function receiptPath(jobId: string): string {
  return path.join(jobDir(jobId), "receipt.json");
}

export function resultPath(jobId: string): string {
  return path.join(jobDir(jobId), "result.md");
}

export function diffPath(jobId: string): string {
  return path.join(jobDir(jobId), "diff.patch");
}

export function stdoutPath(jobId: string): string {
  return path.join(jobDir(jobId), "stdout.log");
}

export function stderrPath(jobId: string): string {
  return path.join(jobDir(jobId), "stderr.log");
}

export function worktreePath(jobId: string): string {
  return path.join(worktreesRoot(), jobId);
}

export function tempPath(jobId: string): string {
  return path.join(stateRoot(), "tmp", jobId);
}

export function packageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "roles"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function activePluginRoot(): string {
  if (process.env.CDX_CLAUDE_PLUGIN_ROOT !== undefined && process.env.CDX_CLAUDE_PLUGIN_ROOT.trim().length > 0) {
    return path.resolve(process.env.CDX_CLAUDE_PLUGIN_ROOT);
  }
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, ".codex-plugin", "plugin.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.join(packageRoot(), "plugin");
}

export function rolesRoot(): string {
  return path.join(packageRoot(), "roles");
}

export function rolesManifestPath(): string {
  return path.join(rolesRoot(), "manifest.json");
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveInside(root: string, candidate: string): string {
  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }
  return path.resolve(root, candidate);
}
