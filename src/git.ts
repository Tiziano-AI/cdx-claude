import { mkdir } from "node:fs/promises";
import path from "node:path";
import { UserVisibleError } from "./errors.js";
import { diffPath, worktreePath } from "./paths.js";
import { runCommand, runRequired } from "./process-runner.js";
import { atomicWriteText } from "./fs-util.js";

export interface GitContext {
  root: string;
  head: string;
  dirty: boolean;
}

export async function inspectGitContext(cwd: string): Promise<GitContext> {
  const rootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
  if (rootResult.exit_code !== 0) {
    throw new UserVisibleError(`cwd is not inside a git repository: ${cwd}`);
  }
  const root = rootResult.stdout.trim();
  const headResult = await runRequired("git", ["rev-parse", "HEAD"], root);
  const statusResult = await runRequired("git", ["status", "--porcelain"], root);
  return {
    root,
    head: headResult.stdout.trim(),
    dirty: statusResult.stdout.trim().length > 0
  };
}

export async function createDetachedWorktree(jobId: string, git: GitContext): Promise<string> {
  const target = worktreePath(jobId);
  await mkdir(path.dirname(target), { recursive: true });
  await runRequired("git", ["worktree", "add", "--detach", target, git.head], git.root);
  return target;
}

export async function collectWorktreeDiff(jobId: string, worktree: string): Promise<string> {
  const tracked = await runRequired("git", ["diff", "--binary", "HEAD"], worktree);
  const untracked = await untrackedDiff(worktree);
  const diff = [tracked.stdout, untracked].filter((part) => part.length > 0).join("\n");
  await atomicWriteText(diffPath(jobId), diff);
  return diff;
}

export async function hasWorktreeChanges(worktree: string): Promise<boolean> {
  const result = await runRequired("git", ["status", "--porcelain"], worktree);
  return result.stdout.trim().length > 0;
}

export async function removeWorktree(repoRoot: string, worktree: string, force: boolean): Promise<void> {
  const args = force ? ["worktree", "remove", "--force", worktree] : ["worktree", "remove", worktree];
  await runRequired("git", args, repoRoot);
}

async function untrackedDiff(worktree: string): Promise<string> {
  const listed = await runRequired("git", ["ls-files", "--others", "--exclude-standard", "-z"], worktree);
  const files = listed.stdout.split("\0").filter((entry) => entry.length > 0);
  const diffs: string[] = [];
  for (const file of files) {
    const result = await runCommand("git", ["diff", "--binary", "--no-index", "--", "/dev/null", file], worktree);
    if (result.exit_code !== 0 && result.exit_code !== 1) {
      throw new Error(`git diff --no-index failed for ${file}: ${result.stderr.trim()}`);
    }
    diffs.push(result.stdout);
  }
  return diffs.join("\n");
}
