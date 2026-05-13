import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCodeExecutable } from "../src/claude-executable.js";
import { resolveNodeExecutable, resolveNodeExecutablePath } from "../src/executable.js";
import { activePluginRoot, PLUGIN_ROOT_ENV, PLUGIN_VERSION } from "../src/paths.js";
import { pluginPackageCheck } from "../src/plugin-provenance.js";
import { materializeRuntime } from "../src/runtime-materialization.js";
import { doctor } from "../src/doctor.js";

test("Node discovery prefers the current PATH over a stale process executable path", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "cdx-claude-node-bin-"));
  const node = await writeExecutable(bin, "node", "echo v99.0.0");
  const staleExecPath = path.join(bin, "missing-node");

  assert.equal(resolveNodeExecutablePath({ PATH: bin }, staleExecPath), node);
});

test("Node discovery records and ignores the retired Node executable override", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "cdx-claude-node-override-bin-"));
  const node = await writeExecutable(bin, "node", "echo v99.0.0");
  const environment = {
    PATH: bin,
    CDX_CLAUDE_NODE_EXECUTABLE: "/opt/homebrew/Cellar/node/26.0.0/bin/node"
  };
  const resolution = resolveNodeExecutable(environment);
  assert.equal(resolution.executable, node);
  assert.equal(resolution.source, "search_path");
  assert.deepEqual(resolution.rejected, [
    {
      source: "configured",
      executable: "/opt/homebrew/Cellar/node/26.0.0/bin/node",
      reason: "CDX_CLAUDE_NODE_EXECUTABLE is not a supported runtime override"
    }
  ]);
  const runtime = await materializeRuntime(environment);
  assert.equal(runtime.ok, false);
  assert.equal(runtime.remediation.some((row) => row.includes("CDX_CLAUDE_NODE_EXECUTABLE")), true);
});

test("Node discovery skips relative PATH entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cdx-claude-relative-path-"));
  const relativeBin = path.join(root, "bin");
  await mkdir(relativeBin, { recursive: true });
  const relativeNode = await writeExecutable(relativeBin, "node", "echo should-not-run");
  const currentNode = await writeExecutable(root, "node-current", "echo v88.0.0");
  await withProcessState({}, root, async () => {
    const resolution = resolveNodeExecutable({ PATH: "bin" }, currentNode);
    assert.equal(resolution.executable, currentNode);
    assert.equal(resolution.source, "process_exec_path");
    assert.notEqual(resolution.executable, relativeNode);
    assert.notEqual(resolution.executable, path.resolve("bin", "node"));
  });
});

test("Claude executable policy defaults to the SDK bundle and validates explicit overrides", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cdx-claude-explicit-claude-"));
  const executable = await writeExecutable(directory, "claude", "echo 2.1.140");
  try {
    assert.deepEqual(resolveClaudeCodeExecutable({}), {
      source: "sdk_bundled",
      env_key: "CDX_CLAUDE_CODE_EXECUTABLE"
    });
    const relative = resolveClaudeCodeExecutable({ CDX_CLAUDE_CODE_EXECUTABLE: "claude" });
    assert.equal(relative.rejected?.reason, "configured executable must be an absolute path");
    const linked = path.join(directory, "claude-link");
    await symlink(executable, linked);
    const symlinked = resolveClaudeCodeExecutable({ CDX_CLAUDE_CODE_EXECUTABLE: linked });
    assert.equal(symlinked.rejected?.reason, "configured executable must not be a symlink");
    const valid = resolveClaudeCodeExecutable({ CDX_CLAUDE_CODE_EXECUTABLE: executable });
    assert.equal(valid.executable, executable);
    assert.equal(valid.source, "configured");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor reports the late-bound Node executable used for readiness", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "cdx-claude-doctor-bin-"));
  const state = await mkdtemp(path.join(tmpdir(), "cdx-claude-doctor-state-"));
  const node = await writeExecutable(bin, "node", "echo v99.0.0");

  await withProcessState(
    {
      PATH: bin,
      CDX_CLAUDE_HOME: state,
      [PLUGIN_ROOT_ENV]: undefined
    },
    undefined,
    async () => {
      const report = await doctor();
      assert.equal(report.node.ok, true);
      assert.equal(report.node.summary, "v99.0.0");
      assert.equal(report.node.details.command, node);
      assert.equal(report.node.details.resolution_source, "search_path");
    }
  );
});

test("active plugin root prefers the current plugin cwd over a stale inherited root", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-plugin-roots-"));
  const stale = path.join(sandbox, "0.1.1");
  const current = path.join(sandbox, PLUGIN_VERSION);
  await writePluginRoot(stale, "0.1.1");
  await writePluginRoot(current, PLUGIN_VERSION);

  await withProcessState({ [PLUGIN_ROOT_ENV]: stale }, current, async () => {
    assert.equal(activePluginRoot(), await realpath(current));
  });
});

test("active plugin root falls back to the packaged plugin before a stale inherited root", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-source-root-"));
  const stale = path.join(sandbox, "stale");
  const sourcePluginRoot = path.resolve("plugin");
  await writePluginRoot(stale, "0.1.1");

  await withProcessState({ [PLUGIN_ROOT_ENV]: stale }, sandbox, async () => {
    assert.equal(activePluginRoot(), sourcePluginRoot);
  });
});

test("plugin package check rejects a stale manifest version", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-stale-plugin-"));
  const stale = path.join(sandbox, "0.1.1");
  await writePluginRoot(stale, "0.1.1");

  const check = await pluginPackageCheck(stale);
  assert.equal(check.ok, false);
  assert.equal(check.details.manifest_version, "0.1.1");
  assert.equal(check.details.expected_version, PLUGIN_VERSION);
});

test("runtime materialization reports rejected stale plugin roots and remediation", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-runtime-materialization-"));
  const stale = path.join(sandbox, "0.1.1");
  await writePluginRoot(stale, "0.1.1");
  await withProcessState({ [PLUGIN_ROOT_ENV]: stale }, process.cwd(), async () => {
    const runtime = await materializeRuntime();
    assert.equal(runtime.release_identity.expected_version, PLUGIN_VERSION);
    assert.equal(runtime.plugin_root.version_match, true);
    assert.equal(runtime.plugin_root.rejected.some((candidate) => candidate.reason.includes("0.1.1")), true);
    assert.equal(runtime.remediation.some((row) => row.includes("rejected")), true);
  });
});

test("runtime materialization rejects same-version local-personal plugin cache as public proof", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cdx-claude-local-personal-cache-"));
  const localPersonal = path.join(sandbox, ".codex", "plugins", "cache", "local-personal", "cdx-claude", PLUGIN_VERSION);
  await writePluginRoot(localPersonal, PLUGIN_VERSION);
  await withProcessState({ [PLUGIN_ROOT_ENV]: undefined }, localPersonal, async () => {
    const runtime = await materializeRuntime();
    assert.equal(runtime.launch_kind, "local_personal_plugin");
    assert.equal(runtime.plugin_root.version_match, true);
    assert.equal(runtime.plugin_root.cache_channel_ok, false);
    assert.equal(runtime.ok, false);
    assert.equal(runtime.remediation.some((row) => row.includes("local-personal")), true);
  });
});

async function writeExecutable(directory: string, name: string, body: string): Promise<string> {
  const executable = path.join(directory, name);
  await writeFile(executable, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function writePluginRoot(root: string, version: string): Promise<void> {
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "cdx-claude", version })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, ".mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        "cdx-claude": {
          command: "./bin/cdx-claude",
          args: ["mcp", "serve"],
          cwd: "."
        }
      }
    })}\n`,
    "utf8"
  );
  const launcher = path.join(root, "bin", "cdx-claude");
  await writeFile(
    launcher,
    [
      "#!/usr/bin/env node",
      "process.env.CDX_CLAUDE_NPM_SPEC;",
      `const runtimeSpec = "cdx-claude@${version}";`,
      "console.log('npm', runtimeSpec);"
    ].join("\n"),
    "utf8"
  );
  await chmod(launcher, 0o755);
}

async function withProcessState(
  environment: Record<string, string | undefined>,
  cwd: string | undefined,
  run: () => Promise<void>
): Promise<void> {
  const previousCwd = process.cwd();
  const previousEnvironment = new Map<string, string | undefined>();
  for (const key of Object.keys(environment)) {
    previousEnvironment.set(key, process.env[key]);
  }
  try {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (cwd !== undefined) {
      process.chdir(cwd);
    }
    await run();
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of previousEnvironment.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
