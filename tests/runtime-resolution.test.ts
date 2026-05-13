import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveNodeExecutablePath } from "../src/executable.js";
import { activePluginRoot, PLUGIN_ROOT_ENV, PLUGIN_VERSION } from "../src/paths.js";
import { pluginPackageCheck } from "../src/plugin-provenance.js";
import { doctor } from "../src/service.js";

test("Node discovery prefers the current PATH over a stale process executable path", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "cdx-claude-node-bin-"));
  const node = await writeExecutable(bin, "node", "echo v99.0.0");
  const staleExecPath = path.join(bin, "missing-node");

  assert.equal(resolveNodeExecutablePath({ PATH: bin }, staleExecPath), node);
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
