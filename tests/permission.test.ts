import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPermissionGate } from "../src/permission.js";

test("research denies write tools", async () => {
  const gate = buildPermissionGate("research", "/tmp/repo");
  const result = await gate("Write", { file_path: "README.md" }, permissionOptions("tool-1"));
  assert.equal(result.behavior, "deny");
});

test("patch denies file access outside the allowed root", async () => {
  const gate = buildPermissionGate("patch", "/tmp/repo");
  const result = await gate("Read", { file_path: path.join(tmpdir(), "outside-cdx-claude-test.txt") }, permissionOptions("tool-2"));
  assert.equal(result.behavior, "deny");
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
    const gate = buildPermissionGate("patch", root);
    const result = await gate("Read", { file_path: "link/secret.txt" }, permissionOptions("tool-symlink"));
    assert.equal(result.behavior, "deny");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("patch denies Bash even in a worktree", async () => {
  const gate = buildPermissionGate("patch", "/tmp/repo");
  const result = await gate("Bash", { command: "cat ~/.secrets/ALL.env" }, permissionOptions("tool-3"));
  assert.equal(result.behavior, "deny");
});

test("patch_autonomous allows Bash for the native Claude sandbox", async () => {
  const gate = buildPermissionGate("patch_autonomous", "/tmp/repo");
  const result = await gate("Bash", { command: "pwd" }, permissionOptions("tool-4"));
  assert.equal(result.behavior, "allow");
});

function permissionOptions(toolUseID: string) {
  return {
    signal: new AbortController().signal,
    toolUseID
  };
}
