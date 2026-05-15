import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DirectoryFingerprint } from "./contracts.js";
import { errorCode, UserVisibleError } from "./errors.js";
import { isInside, jobsRoot, stateRoot, worktreesRoot } from "./paths.js";
import { runCommand } from "./process-runner.js";

export interface AdditionalDirectoryPolicy {
  authorityRoot: string;
  executionRoot: string;
}

/** Resolves and validates a caller cwd before ledger or worker state is created. */
export async function resolveAllowedCwd(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const stats = await stat(resolved);
  if (!stats.isDirectory()) {
    throw new UserVisibleError(`cwd is not a directory: ${resolved}`);
  }
  const cwd = await realpath(resolved);
  await assertAllowedCwd(cwd);
  await assertProjectRoot(cwd);
  return cwd;
}

/** Resolves and validates read-only context roots before ledger or worker state is created. */
export async function resolveAdditionalDirectories(targets: string[], policy: AdditionalDirectoryPolicy): Promise<string[]> {
  const normalized: string[] = [];
  const normalizedAuthorityRoot = await realPathForComparison(policy.authorityRoot);
  const normalizedExecutionRoot = await realPathForComparison(policy.executionRoot);
  for (const target of targets) {
    const directory = await resolveAdditionalDirectory(target);
    if (normalized.includes(directory)) {
      continue;
    }
    assertNoScopeOverlap(directory, normalizedAuthorityRoot, "declared cwd");
    assertNoScopeOverlap(directory, normalizedExecutionRoot, "execution root");
    assertNoAdditionalRootOverlap(directory, normalized);
    normalized.push(directory);
  }
  return normalized;
}

/** Captures the immutable filesystem identities for admitted read-only roots. */
export async function directoryFingerprints(directories: string[]): Promise<DirectoryFingerprint[]> {
  return Promise.all(directories.map(directoryFingerprint));
}

/** Fails closed when a persisted read-only root no longer matches its admitted filesystem identity. */
export async function assertAdditionalDirectoriesStable(
  directories: string[],
  fingerprints: DirectoryFingerprint[]
): Promise<void> {
  if (directories.length === 0) {
    return;
  }
  if (fingerprints.length !== directories.length) {
    throw additionalDirectoryError(directories.join(", "), "additional directory identity is missing");
  }
  for (const directory of directories) {
    const expected = fingerprints.find((fingerprint) => fingerprint.path === directory);
    if (expected === undefined) {
      throw additionalDirectoryError(directory, "additional directory identity is missing");
    }
    const current = await directoryFingerprint(directory);
    if (current.device !== expected.device || current.inode !== expected.inode) {
      throw additionalDirectoryError(directory, "additional directory identity changed after job admission");
    }
  }
}

async function resolveAdditionalDirectory(target: string): Promise<string> {
  assertNoControlCharacters(target, "additional_directories");
  if (!path.isAbsolute(target)) {
    throw additionalDirectoryError(target, "additional directory must be an absolute path");
  }
  const resolved = path.resolve(target);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolved);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      throw additionalDirectoryError(resolved, "additional directory does not exist");
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw additionalDirectoryError(resolved, "additional directory is not a directory");
  }
  const directory = await realpath(resolved);
  await assertAllowedDirectory(directory, "additional_directories");
  return directory;
}

async function assertAllowedCwd(cwd: string): Promise<void> {
  assertNoControlCharacters(cwd, "cwd");
  await assertAllowedDirectory(cwd, "cwd");
}

async function directoryFingerprint(directory: string): Promise<DirectoryFingerprint> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw additionalDirectoryError(directory, "additional directory is no longer the admitted directory");
  }
  const canonical = await realpath(directory);
  if (canonical !== directory) {
    throw additionalDirectoryError(directory, "additional directory canonical path changed after job admission");
  }
  await assertAllowedDirectory(directory, "additional_directories");
  return {
    path: directory,
    device: String(stats.dev),
    inode: String(stats.ino)
  };
}

function assertNoControlCharacters(directory: string, field: "cwd" | "additional_directories"): void {
  if (!/[\u0000-\u001F\u007F]/u.test(directory)) {
    return;
  }
  if (field === "cwd") {
    throw new UserVisibleError(`cwd contains unsupported control characters: ${JSON.stringify(directory)}`, {
      code: "cwd_denied",
      field,
      recoverable: true,
      hint: "Choose an absolute git repository or worktree root path without control characters."
    });
  }
  throw additionalDirectoryError(directory, "additional directory contains unsupported control characters");
}

async function assertAllowedDirectory(directory: string, field: "cwd" | "additional_directories"): Promise<void> {
  const home = await realpath(homedir());
  if (directory === path.parse(directory).root || directory === home) {
    throw sensitiveDirectoryError(directory, field);
  }
  const deniedRoots = [
    stateRoot(),
    jobsRoot(),
    worktreesRoot(),
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    path.join(home, ".secrets"),
    path.join(home, ".ssh"),
    path.join(home, ".config"),
    path.join(home, ".npm"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".gcloud"),
    path.join(home, ".docker"),
    path.join(home, ".kube"),
    path.join(home, ".gnupg"),
    path.join(home, ".claude.json"),
    path.join(home, ".gemini"),
    path.join(home, "Downloads"),
    path.join(home, "Library"),
    path.join(home, "Library", "Keychains"),
    path.join(home, "Library", "Application Support"),
    "/etc",
    "/private/etc",
    "/var/db",
    "/private/var/db",
    "/var/log",
    "/private/var/log",
    "/Library",
    "/System"
  ];
  const stateParent = path.dirname(stateRoot());
  if (path.basename(stateParent) === ".codex") {
    deniedRoots.push(stateParent);
  }
  for (const root of deniedRoots) {
    const realRoot = await realPathForComparison(root);
    if (isInside(realRoot, directory) || isInside(directory, realRoot)) {
      throw sensitiveDirectoryError(directory, field);
    }
  }
}

function assertNoScopeOverlap(directory: string, root: string, label: "declared cwd" | "execution root"): void {
  if (isInside(root, directory) || isInside(directory, root)) {
    throw additionalDirectoryError(directory, `additional directory overlaps the ${label}`);
  }
}

function assertNoAdditionalRootOverlap(directory: string, existing: string[]): void {
  for (const root of existing) {
    if (isInside(root, directory) || isInside(directory, root)) {
      throw additionalDirectoryError(directory, "additional directories must not overlap or nest");
    }
  }
}

async function assertProjectRoot(cwd: string): Promise<void> {
  const projectRoot = await gitProjectRoot(cwd);
  if (projectRoot === cwd) {
    return;
  }
  throw new UserVisibleError(`cwd is not a git project root: ${cwd}`, {
    code: "cwd_not_project",
    field: "cwd",
    recoverable: true,
    hint: "Choose a git repository or worktree root. cdx-claude does not delegate against broad arbitrary directories."
  });
}

async function gitProjectRoot(cwd: string): Promise<string | undefined> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.exit_code !== 0) {
    return undefined;
  }
  const root = result.stdout.trim();
  if (root.length === 0) {
    return undefined;
  }
  return await realPathIfExists(root) ?? path.resolve(root);
}

async function realPathIfExists(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

async function realPathForComparison(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const exact = await realPathIfExists(resolved);
  if (exact !== undefined) {
    return exact;
  }
  let current = resolved;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    const parentRealPath = await realPathIfExists(parent);
    if (parentRealPath !== undefined) {
      return path.resolve(parentRealPath, path.relative(parent, resolved));
    }
    current = parent;
  }
}

function sensitiveDirectoryError(directory: string, field: "cwd" | "additional_directories"): UserVisibleError {
  return new UserVisibleError(`${field} is a cdx-claude denied control or credential root: ${directory}`, {
    code: field === "cwd" ? "cwd_denied" : "additional_directory_denied",
    field,
    recoverable: true,
    hint: field === "cwd"
      ? "Choose a project repository instead of home, filesystem root, Codex state, cdx-claude state, or credential directories."
      : "Choose an absolute context directory that is not filesystem root, home, Codex or Claude state, cdx-claude state, a system credential/control root, the execution root, or a parent of those denied roots."
  });
}

function additionalDirectoryError(directory: string, reason: string): UserVisibleError {
  return new UserVisibleError(`${reason}: ${directory}`, {
    code: "additional_directory_denied",
    field: "additional_directories",
    recoverable: true,
    hint: "Choose absolute, existing, non-overlapping read-only context directories outside denied control and credential roots."
  });
}
