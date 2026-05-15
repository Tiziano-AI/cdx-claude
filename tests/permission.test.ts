import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPermissionGate } from "../src/permission.js";

test("research denies write tools", async () => {
  const gate = buildPermissionGate("research", rootPolicy("/tmp/repo"));
  const result = await gate("Write", { file_path: "README.md" }, permissionOptions("tool-1"));
  assert.equal(result.behavior, "deny");
});

test("patch denies file access outside the allowed root", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-outside-test-"));
  const root = path.join(sandbox, "root");
  await mkdir(root);
  try {
    const gate = buildPermissionGate("patch", rootPolicy(root));
    const result = await gate("Read", { file_path: path.join(tmpdir(), "outside-cdx-claude-test.txt") }, permissionOptions("tool-2"));
    assert.equal(result.behavior, "deny");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch allows reads in additional roots but denies writes there", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-extra-test-"));
  const root = path.join(sandbox, "root");
  const extra = path.join(sandbox, "extra");
  await mkdir(root);
  await mkdir(extra);
  await writeFile(path.join(extra, "context.txt"), "context\n", "utf8");
  const realExtra = await realpath(extra);
  try {
    const gate = buildPermissionGate("patch", rootPolicy(root, [realExtra]));
    const read = await gate("Read", { file_path: path.join(extra, "context.txt") }, permissionOptions("tool-extra-read"));
    assert.equal(read.behavior, "allow");
    const write = await gate("Write", { file_path: path.join(extra, "new.txt") }, permissionOptions("tool-extra-write"));
    assert.equal(write.behavior, "deny");
    const rootWrite = await gate("Write", { file_path: "new.txt" }, permissionOptions("tool-root-write"));
    assert.equal(rootWrite.behavior, "allow");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("permission gate denies reads when an additional root disappears before first tool use", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-extra-missing-test-"));
  const root = path.join(sandbox, "root");
  const extra = path.join(sandbox, "extra");
  await mkdir(root);
  await mkdir(extra);
  try {
    const gate = buildPermissionGate("patch", rootPolicy(root, [extra]));
    await rm(extra, { recursive: true, force: true });
    const result = await gate("Read", { file_path: path.join(extra, "context.txt") }, permissionOptions("tool-extra-missing"));
    assert.equal(result.behavior, "deny");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("permission gate applies the full read and write tool path matrix to additional roots in every mode", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-matrix-test-"));
  const root = path.join(sandbox, "root");
  const extra = path.join(sandbox, "extra");
  const outside = path.join(sandbox, "outside");
  await mkdir(root);
  await mkdir(extra);
  await mkdir(outside);
  await writeFile(path.join(extra, "context.txt"), "context\n", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
  const realExtra = await realpath(extra);
  try {
    for (const mode of ["research", "patch", "patch_autonomous"] as const) {
      const gate = buildPermissionGate(mode, rootPolicy(root, [realExtra]));
      for (const readTool of ["Read", "Grep", "Glob", "LS"]) {
        const allowed = await gate(readTool, { path: extra }, permissionOptions(`tool-${mode}-${readTool}-extra`));
        assert.equal(allowed.behavior, "allow");
        const denied = await gate(readTool, { path: outside }, permissionOptions(`tool-${mode}-${readTool}-outside`));
        assert.equal(denied.behavior, "deny");
      }
      for (const writeTool of ["Write", "Edit", "MultiEdit"]) {
        const denied = await gate(writeTool, { file_path: path.join(extra, "new.txt") }, permissionOptions(`tool-${mode}-${writeTool}-extra`));
        assert.equal(denied.behavior, "deny");
        const rootWrite = await gate(writeTool, { file_path: `${writeTool}.txt` }, permissionOptions(`tool-${mode}-${writeTool}-root`));
        assert.equal(rootWrite.behavior, mode === "research" ? "deny" : "allow");
      }
      const notebookDenied = await gate("NotebookEdit", { notebook_path: path.join(extra, "notes.ipynb") }, permissionOptions(`tool-${mode}-NotebookEdit-extra`));
      assert.equal(notebookDenied.behavior, "deny");
      const notebookAllowed = await gate("NotebookEdit", { notebook_path: "notes.ipynb" }, permissionOptions(`tool-${mode}-NotebookEdit-root`));
      assert.equal(notebookAllowed.behavior, mode === "research" ? "deny" : "allow");
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch denies symlink escapes from the allowed root", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-test-"));
  const root = path.join(sandbox, "root");
  const outside = path.join(sandbox, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
  await symlink(outside, path.join(root, "link"));
  try {
    const gate = buildPermissionGate("patch", rootPolicy(root));
    const result = await gate("Read", { file_path: "link/secret.txt" }, permissionOptions("tool-symlink"));
    assert.equal(result.behavior, "deny");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch allows canonical absolute paths for a symlinked execution root", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-canonical-test-"));
  const realRoot = path.join(sandbox, "real-root");
  const rootLink = path.join(sandbox, "root-link");
  const file = path.join(realRoot, "README.md");
  await mkdir(realRoot);
  await writeFile(file, "content\n", "utf8");
  await symlink(realRoot, rootLink);
  try {
    const gate = buildPermissionGate("patch", rootPolicy(rootLink));
    const result = await gate("Read", { file_path: file }, permissionOptions("tool-canonical"));
    assert.equal(result.behavior, "allow");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch denies symlink escapes from additional roots", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-permission-extra-link-test-"));
  const root = path.join(sandbox, "root");
  const extra = path.join(sandbox, "extra");
  const outside = path.join(sandbox, "outside");
  await mkdir(root);
  await mkdir(extra);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
  await symlink(outside, path.join(extra, "link"));
  try {
    const gate = buildPermissionGate("patch", rootPolicy(root, [extra]));
    const result = await gate("Read", { file_path: path.join(extra, "link", "secret.txt") }, permissionOptions("tool-extra-symlink"));
    assert.equal(result.behavior, "deny");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch denies Bash even in a worktree", async () => {
  const gate = buildPermissionGate("patch", rootPolicy("/tmp/repo"));
  const result = await gate("Bash", { command: "cat ~/.secrets/ALL.env" }, permissionOptions("tool-3"));
  assert.equal(result.behavior, "deny");
});

test("patch_autonomous allows Bash for the native Claude sandbox", async () => {
  const gate = buildPermissionGate("patch_autonomous", rootPolicy("/tmp/repo"));
  const result = await gate("Bash", { command: "pwd" }, permissionOptions("tool-4"));
  assert.equal(result.behavior, "allow");
});

function rootPolicy(executionRoot: string, additionalReadRoots: string[] = []) {
  return { executionRoot, additionalReadRoots };
}

function permissionOptions(toolUseID: string) {
  return {
    signal: new AbortController().signal,
    toolUseID
  };
}
