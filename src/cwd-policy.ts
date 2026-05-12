import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { errorCode, UserVisibleError } from "./errors.js";
import { jobsRoot, stateRoot, worktreesRoot } from "./paths.js";

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

async function assertAllowedCwd(cwd: string): Promise<void> {
  const home = await realpath(homedir());
  if (cwd === path.parse(cwd).root || cwd === home) {
    throw sensitiveCwdError(cwd);
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
    path.join(home, "Library", "Keychains"),
    path.join(home, "Library", "Application Support")
  ];
  const stateParent = path.dirname(stateRoot());
  if (path.basename(stateParent) === ".codex") {
    deniedRoots.push(stateParent);
  }
  for (const root of deniedRoots) {
    const realRoot = await realPathIfExists(root);
    if (realRoot !== undefined && isInside(realRoot, cwd)) {
      throw sensitiveCwdError(cwd);
    }
  }
}

async function assertProjectRoot(cwd: string): Promise<void> {
  if (await isGitWorktree(cwd)) {
    return;
  }
  throw new UserVisibleError(`cwd is not a git project root: ${cwd}`, {
    code: "cwd_not_project",
    field: "cwd",
    recoverable: true,
    hint: "Choose a git repository or worktree root. cdx-claude does not delegate against broad arbitrary directories."
  });
}

async function isGitWorktree(cwd: string): Promise<boolean> {
  const gitDir = await realPathIfExists(path.join(cwd, ".git"));
  return gitDir !== undefined;
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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sensitiveCwdError(cwd: string): UserVisibleError {
  return new UserVisibleError(`cwd is a cdx-claude denied control or credential root: ${cwd}`, {
    code: "cwd_denied",
    field: "cwd",
    recoverable: true,
    hint: "Choose a project repository instead of home, filesystem root, Codex state, cdx-claude state, or credential directories."
  });
}
