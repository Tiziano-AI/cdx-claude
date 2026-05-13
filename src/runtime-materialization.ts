import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveClaudeCodeExecutable } from "./claude-executable.js";
import { inspectAuthEnvironmentFile } from "./auth-env.js";
import { resolveNodeExecutable } from "./executable.js";
import { UserVisibleError } from "./errors.js";
import { isPublicInstalledPluginRoot, packageRoot, PLUGIN_VERSION, publicInstalledPluginRoot, resolveActivePluginRoot, stateRoot } from "./paths.js";

export interface RuntimeMaterialization {
  [key: string]: unknown;
  ok: boolean;
  launch_kind: "installed_plugin" | "local_personal_plugin" | "source_dev" | "npm_cli";
  process: {
    pid: number;
    ppid: number;
    cwd: string;
    argv1?: string;
  };
  release_identity: {
    package_version: string;
    expected_version: string;
    version_match: boolean;
    package_root: string;
  };
  plugin_root: {
    path: string;
    source: string;
    version?: string;
    version_match: boolean;
    public_cache_root: string;
    public_cache_match: boolean;
    cache_channel_ok: boolean;
    rejected: Array<{ source: string; path_redacted: string; reason: string }>;
  };
  node: {
    executable: string;
    source: string;
    env_key?: string;
    current_exec_path?: string;
    rejected?: Array<{ source: string; executable: string; reason: string }>;
  };
  claude: {
    executable?: string;
    source: string;
    env_key: string;
    rejected?: { executable: string; reason: string };
  };
  auth_env: {
    configured: boolean;
    path_redacted?: string;
    absolute: boolean;
    exists: boolean;
    readable: boolean;
    regular_file: boolean;
    symlink: boolean;
    private_mode: boolean;
    owner_ok: boolean;
    parent_writable: boolean;
    size_ok: boolean;
    key_names: string[];
    error?: string;
  };
  state_root: string;
  remediation: string[];
}

/** Materializes the current runtime origin, effective values, drift, and remediation. */
export async function materializeRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<RuntimeMaterialization> {
  const root = packageRoot();
  const packageVersion = await packageVersionFromRoot(root);
  const pluginRoot = resolveActivePluginRoot();
  const pluginVersion = await pluginVersionFromRoot(pluginRoot.plugin_root);
  const node = resolveNodeExecutable(environment);
  const claude = resolveClaudeCodeExecutable(environment);
  const authEnv = await inspectAuthEnvironmentFile(environment);
  const launchKind = launchKindFor(root, pluginRoot.plugin_root);
  const versionMatch = packageVersion === PLUGIN_VERSION;
  const pluginVersionMatch = pluginVersion === PLUGIN_VERSION;
  const cacheChannelOk = pluginCacheChannelOk(pluginRoot.plugin_root);
  const remediation = remediationRows({
    versionMatch,
    packageVersion,
    pluginVersion,
    pluginVersionMatch,
    cacheChannelOk,
    pluginRootSource: pluginRoot.source,
    rejectedCount: pluginRoot.rejected.length,
    nodeRejected: node.rejected !== undefined && node.rejected.length > 0,
    authEnvOk: authEnvOk(authEnv),
    claudeRejected: claude.rejected !== undefined
  });
  return {
    ok: versionMatch && pluginVersionMatch && cacheChannelOk && authEnvOk(authEnv) && claude.rejected === undefined && (node.rejected === undefined || node.rejected.length === 0),
    launch_kind: launchKind,
    process: {
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      ...(process.argv[1] === undefined ? {} : { argv1: process.argv[1] })
    },
    release_identity: {
      package_version: packageVersion,
      expected_version: PLUGIN_VERSION,
      version_match: versionMatch,
      package_root: root
    },
    plugin_root: {
      path: pluginRoot.plugin_root,
      source: pluginRoot.source,
      ...(pluginVersion === undefined ? {} : { version: pluginVersion }),
      version_match: pluginVersionMatch,
      public_cache_root: publicInstalledPluginRoot(),
      public_cache_match: isPublicInstalledPluginRoot(pluginRoot.plugin_root),
      cache_channel_ok: cacheChannelOk,
      rejected: pluginRoot.rejected.map((candidate) => ({
        source: candidate.source,
        path_redacted: redactPrivatePath(candidate.path),
        reason: candidate.reason
      }))
    },
    node: {
      executable: node.executable,
      source: node.source,
      ...(node.env_key === undefined ? {} : { env_key: node.env_key }),
      ...(node.current_exec_path === undefined ? {} : { current_exec_path: node.current_exec_path }),
      ...(node.rejected === undefined || node.rejected.length === 0
        ? {}
        : { rejected: node.rejected })
    },
    claude: {
      ...(claude.executable === undefined ? {} : { executable: claude.executable }),
      source: claude.source,
      env_key: claude.env_key,
      ...(claude.rejected === undefined ? {} : { rejected: claude.rejected })
    },
    auth_env: authEnv,
    state_root: stateRoot(),
    remediation
  };
}

/** Denies delegation before ledger creation when the active runtime materialization is red. */
export async function assertRuntimeReadyForDelegation(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = await materializeRuntime(environment);
  if (!runtime.ok) {
    throw new UserVisibleError("cdx-claude runtime is not ready; run claude_delegate_doctor and fix red runtime rows before delegation.", {
      code: "runtime_not_ready",
      recoverable: true,
      hint: runtime.remediation.join(" ") || "Restart or reinstall the active cdx-claude plugin runtime."
    });
  }
}

function launchKindFor(root: string, pluginRoot: string): "installed_plugin" | "local_personal_plugin" | "source_dev" | "npm_cli" {
  if (isLocalPersonalPluginRoot(pluginRoot)) {
    return "local_personal_plugin";
  }
  if (isPublicInstalledPluginRoot(pluginRoot)) {
    return "installed_plugin";
  }
  if (root === process.cwd() || pluginRoot === path.join(root, "plugin")) {
    return "source_dev";
  }
  return "npm_cli";
}

function pluginCacheChannelOk(pluginRoot: string): boolean {
  if (!isCodexPluginCacheRoot(pluginRoot)) {
    return true;
  }
  return isPublicInstalledPluginRoot(pluginRoot);
}

function isCodexPluginCacheRoot(pluginRoot: string): boolean {
  return pluginRoot.includes(path.join(".codex", "plugins", "cache"));
}

function isLocalPersonalPluginRoot(pluginRoot: string): boolean {
  return pluginRoot.includes(path.join(".codex", "plugins", "cache", "local-personal"));
}

async function packageVersionFromRoot(root: string): Promise<string> {
  const raw = await readFile(path.join(root, "package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    return parsed.version;
  }
  return "unknown";
}

async function pluginVersionFromRoot(root: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
      return parsed.version;
    }
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxError || isNodeError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function authEnvOk(authEnv: RuntimeMaterialization["auth_env"]): boolean {
  if (!authEnv.configured) {
    return true;
  }
  return (
    authEnv.absolute &&
    authEnv.exists &&
    authEnv.readable &&
    authEnv.regular_file &&
    !authEnv.symlink &&
    authEnv.private_mode &&
    authEnv.owner_ok &&
    !authEnv.parent_writable &&
    authEnv.size_ok &&
    authEnv.error === undefined
  );
}

function remediationRows(input: {
  versionMatch: boolean;
  packageVersion: string;
  pluginVersion: string | undefined;
  pluginVersionMatch: boolean;
  cacheChannelOk: boolean;
  pluginRootSource: string;
  rejectedCount: number;
  nodeRejected: boolean;
  authEnvOk: boolean;
  claudeRejected: boolean;
}): string[] {
  const rows: string[] = [];
  if (!input.versionMatch) {
    rows.push(`package runtime version ${input.packageVersion} does not match expected ${PLUGIN_VERSION}; restart or reinstall the active MCP runtime.`);
  }
  if (!input.pluginVersionMatch) {
    rows.push(`plugin manifest version ${input.pluginVersion ?? "unknown"} does not match expected ${PLUGIN_VERSION}; upgrade the Codex marketplace install.`);
  }
  if (!input.cacheChannelOk) {
    rows.push("active plugin root is not the public cdx-claude marketplace cache for this release; disable local-personal inventory or upgrade the public marketplace install.");
  }
  if (input.pluginRootSource !== "cwd" && input.pluginRootSource !== "installed_cache" && input.pluginRootSource !== "packaged") {
    rows.push("plugin root was not resolved from the active cwd, installed cache, or packaged plugin; inspect Codex MCP process cwd.");
  }
  if (input.rejectedCount > 0) {
    rows.push("one or more plugin-root candidates were rejected; inspect runtime.plugin_root.rejected for stale cache or inherited env drift.");
  }
  if (input.nodeRejected) {
    rows.push("remove CDX_CLAUDE_NODE_EXECUTABLE from launcher or shell environment; Node is resolved from PATH and process.execPath only.");
  }
  if (!input.authEnvOk) {
    rows.push("fix CDX_CLAUDE_AUTH_ENV_FILE: use an absolute private dotenv path with mode 0600 and allowlisted key names only.");
  }
  if (input.claudeRejected) {
    rows.push("remove or repair CDX_CLAUDE_CODE_EXECUTABLE; omit it to use the Claude Agent SDK bundled executable.");
  }
  return rows;
}

function redactPrivatePath(value: string): string {
  const home = process.env.HOME;
  if (home !== undefined && value.startsWith(home)) {
    return value.replace(home, "~");
  }
  return value;
}
