import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertConfiguredAuthEnvironmentReady,
  authEnvironmentFromFile,
  authEnvFileVariable,
  inspectAuthEnvironmentFile
} from "../src/auth-env.js";

test("auth env inspection treats an unset pointer as ready without a path", async () => {
  const inspection = await inspectAuthEnvironmentFile({});
  assert.equal(inspection.configured, false);
  assert.equal(inspection.error, undefined);
  await assertConfiguredAuthEnvironmentReady({});
});

test("auth env inspection denies relative, missing, symlink, and broad dotenv paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cdx-claude-auth-deny-"));
  const target = path.join(root, "target.env");
  const linked = path.join(root, "linked.env");
  await writeFile(target, "ANTHROPIC_API_KEY=test-secret\n", "utf8");
  await chmod(target, 0o600);
  await symlink(target, linked);
  try {
    const key = authEnvFileVariable();
    const relative = await inspectAuthEnvironmentFile({ [key]: "relative.env" });
    assert.equal(relative.error, `${key} must be an absolute path`);

    const missing = await inspectAuthEnvironmentFile({ [key]: path.join(root, "missing.env") });
    assert.equal(missing.error, "auth env file ENOENT");

    const symlinked = await inspectAuthEnvironmentFile({ [key]: linked });
    assert.equal(symlinked.error, "auth env path must not be a symlink");

    const broad = path.join(root, "codex.env");
    await writeFile(broad, "OPENAI_API_KEY=not-for-cdx-claude\n", "utf8");
    await chmod(broad, 0o600);
    const broadInspection = await inspectAuthEnvironmentFile({ [key]: broad });
    assert.equal(broadInspection.error, "unsupported Claude auth env key: OPENAI_API_KEY");

    const malformed = path.join(root, "malformed.env");
    await writeFile(malformed, "Anthropic_API_KEY=value\n", "utf8");
    await chmod(malformed, 0o600);
    const malformedInspection = await inspectAuthEnvironmentFile({ [key]: malformed });
    assert.equal(malformedInspection.error, "malformed Claude auth env key: Anthropic_API_KEY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth env inspection enforces mode 0600 and reports key names without values or paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cdx-claude-auth-private-"));
  const authFile = path.join(root, "cdx-claude.env");
  await writeFile(authFile, "ANTHROPIC_API_KEY=test-secret\nCLAUDE_CODE_USE_BEDROCK=1\n", "utf8");
  try {
    await chmod(authFile, 0o644);
    const publicMode = await inspectAuthEnvironmentFile({ [authEnvFileVariable()]: authFile });
    assert.equal(publicMode.error, "auth env file must use mode 0600");

    await chmod(authFile, 0o400);
    const readOnlyMode = await inspectAuthEnvironmentFile({ [authEnvFileVariable()]: authFile });
    assert.equal(readOnlyMode.error, "auth env file must use mode 0600");

    await chmod(authFile, 0o600);
    const privateMode = await inspectAuthEnvironmentFile({ [authEnvFileVariable()]: authFile });
    assert.equal(privateMode.error, undefined);
    assert.deepEqual(privateMode.key_names, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"]);
    const rendered = JSON.stringify(privateMode);
    assert.equal(rendered.includes("test-secret"), false);
    assert.equal(rendered.includes(authFile), false);
    assert.match(rendered, /ANTHROPIC_API_KEY/);

    const values = await authEnvironmentFromFile(authFile);
    assert.equal(values.ANTHROPIC_API_KEY, "test-secret");

    await writeFile(authFile, `ANTHROPIC_API_KEY=${"x".repeat(70_000)}\n`, "utf8");
    await chmod(authFile, 0o600);
    const oversized = await inspectAuthEnvironmentFile({ [authEnvFileVariable()]: authFile });
    assert.equal(oversized.error, "auth env file is too large");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
