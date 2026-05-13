import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DoctorCheck } from "./contracts.js";
import { errorMessage } from "./errors.js";
import { PLUGIN_VERSION } from "./paths.js";

const EXPECTED_TOOLS = [
  "claude_delegate_cleanup",
  "claude_delegate_diff",
  "claude_delegate_doctor",
  "claude_delegate_list",
  "claude_delegate_result",
  "claude_delegate_roles",
  "claude_delegate_sandbox_canary",
  "claude_delegate_start",
  "claude_delegate_status",
  "claude_delegate_stop",
  "claude_delegate_tail"
];

interface PluginManifest {
  name: string | undefined;
  version: string | undefined;
}

interface PluginMcpFile {
  command: string | undefined;
  args: unknown[];
  cwd: string | undefined;
}

export async function pluginPackageCheck(pluginRoot: string): Promise<DoctorCheck> {
  try {
    const manifest = await readManifest(pluginRoot);
    const mcp = await readMcp(pluginRoot);
    const executable = await executableCheck(pluginRoot);
    const launcher = await launcherCheck(pluginRoot);
    const noForbiddenPaths = await forbiddenPathCheck(pluginRoot);
    const validMcp =
      mcp.command === "./bin/cdx-claude" &&
      mcp.args.length === 2 &&
      mcp.args[0] === "mcp" &&
      mcp.args[1] === "serve" &&
      mcp.cwd === ".";
    const validManifest = manifest.name === "cdx-claude" && manifest.version === PLUGIN_VERSION;
    const ok = validManifest && validMcp && executable.ok && launcher.ok && noForbiddenPaths.ok;
    return {
      ok,
      summary: ok ? "plugin package is cache-relative and executable" : "plugin package is not cache-relative",
      details: {
        plugin_root: pluginRoot,
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        expected_version: PLUGIN_VERSION,
        command: mcp.command,
        args: mcp.args,
        cwd: mcp.cwd,
        executable: executable.ok,
        launcher: launcher.details,
        forbidden_path_count: noForbiddenPaths.details.count
      }
    };
  } catch (error) {
    return {
      ok: false,
      summary: "plugin package metadata is unavailable in this runtime",
      details: {
        plugin_root: pluginRoot,
        error: errorMessage(error),
        npm_runtime_only: true
      }
    };
  }
}

export async function installedMcpToolsCheck(pluginRoot: string): Promise<DoctorCheck> {
  const transport = new StdioClientTransport({
    command: "./bin/cdx-claude",
    args: ["mcp", "serve"],
    cwd: pluginRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CDX_CLAUDE_HOME: process.env.CDX_CLAUDE_HOME ?? path.join(tmpdir(), "cdx-claude-doctor")
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "cdx-claude-doctor", version: PLUGIN_VERSION });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const ok = JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS);
    return {
      ok,
      summary: ok ? "installed launcher exposes only wrapper tools" : "installed launcher tool surface drifted",
      details: {
        plugin_root: pluginRoot,
        tool_count: names.length,
        tools: names
      }
    };
  } finally {
    await client.close();
  }
}

async function readManifest(pluginRoot: string): Promise<PluginManifest> {
  const raw = await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return { name: undefined, version: undefined };
  }
  return {
    name: "name" in parsed && typeof parsed.name === "string" ? parsed.name : undefined,
    version: "version" in parsed && typeof parsed.version === "string" ? parsed.version : undefined
  };
}

async function readMcp(pluginRoot: string): Promise<PluginMcpFile> {
  const raw = await readFile(path.join(pluginRoot, ".mcp.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) {
    return { command: undefined, args: [], cwd: undefined };
  }
  const servers = parsed.mcpServers;
  if (typeof servers !== "object" || servers === null || !("cdx-claude" in servers)) {
    return { command: undefined, args: [], cwd: undefined };
  }
  const server = servers["cdx-claude"];
  if (typeof server !== "object" || server === null) {
    return { command: undefined, args: [], cwd: undefined };
  }
  return {
    command: "command" in server && typeof server.command === "string" ? server.command : undefined,
    args: "args" in server && Array.isArray(server.args) ? server.args : [],
    cwd: "cwd" in server && typeof server.cwd === "string" ? server.cwd : undefined
  };
}

async function executableCheck(pluginRoot: string): Promise<DoctorCheck> {
  const executable = path.join(pluginRoot, "bin", "cdx-claude");
  try {
    const stats = await stat(executable);
    await access(executable, constants.X_OK);
    return {
      ok: stats.isFile(),
      summary: "plugin launcher is executable",
      details: { path: executable, mode: stats.mode }
    };
  } catch (error) {
    return {
      ok: false,
      summary: "plugin launcher is missing or not executable",
      details: { path: executable, error: errorMessage(error) }
    };
  }
}

async function launcherCheck(pluginRoot: string): Promise<DoctorCheck> {
  const executable = path.join(pluginRoot, "bin", "cdx-claude");
  const content = await readFile(executable, "utf8");
  const expectedSpec = `cdx-claude@${PLUGIN_VERSION}`;
  const ok =
    content.length < 10_000 &&
    content.includes(expectedSpec) &&
    content.includes("CDX_CLAUDE_NPM_SPEC") &&
    content.includes("npm") &&
    !content.includes("node_modules/") &&
    !content.includes("@anthropic-ai/claude-agent-sdk");
  return {
    ok,
    summary: ok ? "plugin launcher is a small pinned npm launcher" : "plugin launcher is not the expected npm launcher",
    details: {
      path: executable,
      bytes: content.length,
      expected_spec: expectedSpec,
      has_override: content.includes("CDX_CLAUDE_NPM_SPEC")
    }
  };
}

async function forbiddenPathCheck(pluginRoot: string): Promise<DoctorCheck> {
  const forbidden = [
    path.join("/", "Users", "tiziano", "Code", "cdx-claude"),
    path.join("dist", "src", "cli.js"),
    path.join("dist", "src", "mcp-server.js"),
    path.join("dist", "src", "worker.js")
  ];
  const files = await listFiles(pluginRoot);
  let count = 0;
  for (const file of files) {
    const content = await readFile(path.join(pluginRoot, file), "utf8");
    for (const value of forbidden) {
      if (content.includes(value)) {
        count += 1;
      }
    }
  }
  return {
    ok: count === 0,
    summary: count === 0 ? "plugin metadata has no source-anchored launch paths" : "plugin metadata contains source-anchored launch paths",
    details: { plugin_root: pluginRoot, count }
  };
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}
