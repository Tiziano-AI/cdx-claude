import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT_NAME = "cdx-claude";
export const PLUGIN_VERSION = "0.1.6";
export const PLUGIN_ROOT_ENV = "CDX_CLAUDE_PLUGIN_ROOT";

export interface PluginRootResolution {
  plugin_root: string;
  source: "cwd" | "configured" | "packaged" | "installed_cache" | "module_ancestor" | "fallback";
  rejected: Array<{ source: string; path: string; reason: string }>;
}

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
  return resolveActivePluginRoot().plugin_root;
}

export function resolveActivePluginRoot(): PluginRootResolution {
  const rejected: Array<{ source: string; path: string; reason: string }> = [];
  const candidates = pluginRootCandidates();
  for (const candidate of candidates) {
    if (isCurrentPluginRoot(candidate.path)) {
      return { plugin_root: candidate.path, source: candidate.source, rejected };
    }
    rejected.push({
      source: candidate.source,
      path: candidate.path,
      reason: pluginRootRejectionReason(candidate.path)
    });
  }
  const fallback = path.join(packageRoot(), "plugin");
  return {
    plugin_root: fallback,
    source: "fallback",
    rejected
  };
}

function pluginRootCandidates(): Array<{
  source: "cwd" | "configured" | "packaged" | "installed_cache" | "module_ancestor";
  path: string;
}> {
  const values: Array<{
    source: "cwd" | "configured" | "packaged" | "installed_cache" | "module_ancestor";
    path: string | undefined;
  }> = [
    { source: "cwd", path: findPluginAncestor(process.cwd()) },
    { source: "configured", path: configuredPluginRoot() },
    { source: "packaged", path: path.join(packageRoot(), "plugin") },
    { source: "installed_cache", path: installedCodexPluginRoot() },
    { source: "module_ancestor", path: findPluginAncestor(path.dirname(fileURLToPath(import.meta.url))) }
  ];
  const seen = new Set<string>();
  const result: Array<{
    source: "cwd" | "configured" | "packaged" | "installed_cache" | "module_ancestor";
    path: string;
  }> = [];
  for (const value of values) {
    if (value.path === undefined) {
      continue;
    }
    const resolved = path.resolve(value.path);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push({ source: value.source, path: resolved });
  }
  return result;
}

function configuredPluginRoot(): string | undefined {
  const configured = process.env[PLUGIN_ROOT_ENV];
  if (configured === undefined || configured.trim().length === 0) {
    return undefined;
  }
  return path.resolve(configured);
}

function installedCodexPluginRoot(): string {
  return path.join(homedir(), ".codex", "plugins", "cache", PRODUCT_NAME, PRODUCT_NAME, PLUGIN_VERSION);
}

/** Returns the public marketplace cache root expected for the active release. */
export function publicInstalledPluginRoot(): string {
  return installedCodexPluginRoot();
}

/** Reports whether a plugin root is the public marketplace cache for the active release. */
export function isPublicInstalledPluginRoot(pluginRoot: string): boolean {
  return path.resolve(pluginRoot) === path.resolve(installedCodexPluginRoot());
}

function findPluginAncestor(start: string): string | undefined {
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, ".codex-plugin", "plugin.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

function isCurrentPluginRoot(pluginRoot: string): boolean {
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    return false;
  }
  const parsed = readPluginManifest(manifestPath);
  if (parsed === undefined) {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "name" in parsed &&
    parsed.name === PRODUCT_NAME &&
    "version" in parsed &&
    parsed.version === PLUGIN_VERSION
  );
}

function pluginRootRejectionReason(pluginRoot: string): string {
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    return "missing plugin manifest";
  }
  const parsed = readPluginManifest(manifestPath);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return "unreadable plugin manifest";
  }
  if (!("name" in parsed) || parsed.name !== PRODUCT_NAME) {
    return "plugin name does not match cdx-claude";
  }
  if (!("version" in parsed) || parsed.version !== PLUGIN_VERSION) {
    const actual = "version" in parsed && typeof parsed.version === "string" ? parsed.version : "unknown";
    return `plugin manifest version ${actual} does not match ${PLUGIN_VERSION}`;
  }
  return "plugin root is not current";
}

function readPluginManifest(manifestPath: string): unknown {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || isNodeError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
