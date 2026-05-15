import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAdditionalDirectories, resolveAllowedCwd } from "../src/cwd-policy.js";
import { runRequired } from "../src/process-runner.js";

test("additional directories reject execution root overlap and nested roots", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-root-policy-overlap-"));
  const executionRoot = path.join(sandbox, "execution");
  const extra = path.join(sandbox, "extra");
  const nested = path.join(extra, "nested");
  try {
    await mkdir(executionRoot);
    await mkdir(nested, { recursive: true });
    const policy = rootPolicy(executionRoot);
    await assert.rejects(() => resolveAdditionalDirectories([executionRoot], policy), /overlaps the declared cwd/);
    await assert.rejects(() => resolveAdditionalDirectories([sandbox], policy), /overlaps the declared cwd/);
    await assert.rejects(() => resolveAdditionalDirectories([extra, nested], policy), /must not overlap or nest/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("additional directories reject missing path, filesystem root, and home root", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-root-policy-basic-deny-"));
  const executionRoot = path.join(sandbox, "execution");
  const missingRoot = path.join(sandbox, "missing");
  try {
    await mkdir(executionRoot);
    const policy = rootPolicy(executionRoot);
    await assert.rejects(() => resolveAdditionalDirectories([missingRoot], policy), /does not exist/);
    await assert.rejects(() => resolveAdditionalDirectories([path.parse(executionRoot).root], policy), /denied control or credential root/);
    await assert.rejects(() => resolveAdditionalDirectories([homedir()], policy), /denied control or credential root/);
    await assert.rejects(() => resolveAdditionalDirectories(["/etc"], policy), /denied control or credential root/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("additional directories reject state roots and symlinks to denied roots", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-root-policy-deny-"));
  const executionRoot = path.join(sandbox, "execution");
  const contextRoot = path.join(sandbox, "context");
  const stateRoot = path.join(contextRoot, "state");
  const stateLink = path.join(sandbox, "state-link");
  const previousHome = process.env.CDX_CLAUDE_HOME;
  process.env.CDX_CLAUDE_HOME = stateRoot;
  try {
    await mkdir(executionRoot);
    await mkdir(stateRoot, { recursive: true });
    await symlink(stateRoot, stateLink);
    const policy = rootPolicy(executionRoot);
    await assert.rejects(() => resolveAdditionalDirectories([stateRoot], policy), /denied control or credential root/);
    await assert.rejects(() => resolveAdditionalDirectories([stateLink], policy), /denied control or credential root/);
    await assert.rejects(() => resolveAdditionalDirectories([contextRoot], policy), /denied control or credential root/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.CDX_CLAUDE_HOME;
    } else {
      process.env.CDX_CLAUDE_HOME = previousHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("additional directories reject parents of future state roots", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-root-policy-future-deny-"));
  const executionRoot = path.join(sandbox, "execution");
  const contextRoot = path.join(sandbox, "context");
  const previousHome = process.env.CDX_CLAUDE_HOME;
  process.env.CDX_CLAUDE_HOME = path.join(contextRoot, "future-state");
  try {
    await mkdir(executionRoot);
    await mkdir(contextRoot);
    await assert.rejects(() => resolveAdditionalDirectories([contextRoot], rootPolicy(executionRoot)), /denied control or credential root/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.CDX_CLAUDE_HOME;
    } else {
      process.env.CDX_CLAUDE_HOME = previousHome;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("additional directories accept safe symlinks and dedupe normalized roots", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-root-policy-safe-link-"));
  const executionRoot = path.join(sandbox, "execution");
  const safeRoot = path.join(sandbox, "safe");
  const safeLink = path.join(sandbox, "safe-link");
  try {
    await mkdir(executionRoot);
    await mkdir(safeRoot);
    await symlink(safeRoot, safeLink);
    assert.deepEqual(await resolveAdditionalDirectories([safeLink, safeRoot], rootPolicy(executionRoot)), [await realpath(safeRoot)]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("additional directories reject future execution root overlap through a symlinked parent", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-root-policy-future-execution-"));
  const authorityRoot = path.join(sandbox, "authority");
  const realWorktreeParent = path.join(sandbox, "real-worktrees");
  const linkedWorktreeParent = path.join(sandbox, "linked-worktrees");
  try {
    await mkdir(authorityRoot);
    await mkdir(realWorktreeParent);
    await symlink(realWorktreeParent, linkedWorktreeParent);
    await assert.rejects(
      () => resolveAdditionalDirectories([realWorktreeParent], {
        authorityRoot,
        executionRoot: path.join(linkedWorktreeParent, "future-job")
      }),
      /overlaps the execution root/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("cwd must be a real git worktree root, not a fake .git directory", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-cwd-policy-git-"));
  const repo = path.join(sandbox, "repo");
  const fake = path.join(sandbox, "fake");
  try {
    await bootstrapRepo(repo);
    await mkdir(fake);
    await writeFile(path.join(fake, ".git"), "not a git repository\n", "utf8");
    assert.equal(await resolveAllowedCwd(repo), await realpath(repo));
    await assert.rejects(() => resolveAllowedCwd(fake), /cwd is not a git project root/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

function rootPolicy(root: string) {
  return {
    authorityRoot: root,
    executionRoot: root
  };
}

async function bootstrapRepo(repo: string): Promise<void> {
  await runRequired("git", ["init", "-b", "main", repo], tmpdir());
  await runRequired("git", ["config", "user.name", "CDX Claude Test"], repo);
  await runRequired("git", ["config", "user.email", "cdx-claude@example.invalid"], repo);
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  await runRequired("git", ["add", "README.md"], repo);
  await runRequired("git", ["commit", "-m", "initial"], repo);
}
