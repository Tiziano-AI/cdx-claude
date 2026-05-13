import { mkdir } from "node:fs/promises";
import {
  DoctorCheck,
  DoctorReport
} from "./contracts.js";
import { roleReport } from "./agents.js";
import { CLAUDE_CODE_EXECUTABLE_ENV } from "./claude-executable.js";
import {
  jobsRoot,
  packageRoot,
  rolesManifestPath,
  rolesRoot,
  stateRoot
} from "./paths.js";
import { pluginPackageCheck } from "./plugin-provenance.js";
import { runCommand } from "./process-runner.js";
import { materializeRuntime, RuntimeMaterialization } from "./runtime-materialization.js";
import { redactOperatorPath } from "./path-redaction.js";
import { sandboxCheck } from "./sandbox-support.js";

/** Reports source, installed plugin, runtime, auth, ledger, role, and sandbox readiness. */
export async function doctor(): Promise<DoctorReport> {
  const runtimeMaterialization = await materializeRuntime();
  const runtime = runtimeCheck(runtimeMaterialization);
  const claude = redactCheck(await claudeRuntimeCheck(runtimeMaterialization));
  const node = redactCheck(await nodeRuntimeCheck(runtimeMaterialization));
  const authEnv = redactCheck(authEnvCheck(runtimeMaterialization));
  const ledger = redactCheck(await ledgerCheck());
  const roles = redactCheck(await rolesCheck());
  const plugin = redactCheck(await pluginPackageCheck(runtimeMaterialization.plugin_root.path));
  const sandbox = redactCheck(sandboxCheck());
  return {
    ok: runtime.ok && claude.ok && node.ok && authEnv.ok && ledger.ok && roles.ok && plugin.ok && sandbox.ok,
    runtime,
    claude,
    node,
    auth_env: authEnv,
    ledger,
    roles,
    plugin,
    sandbox
  };
}

function runtimeCheck(runtime: RuntimeMaterialization): DoctorCheck {
  return {
    ok: runtime.ok,
    summary: runtime.ok ? `runtime materialized for ${runtime.release_identity.expected_version}` : "runtime materialization has drift",
    details: redactedRecord(runtime)
  };
}

async function nodeRuntimeCheck(runtime: RuntimeMaterialization): Promise<DoctorCheck> {
  const resolution = runtime.node;
  const check = await commandCheck(resolution.executable, ["--version"]);
  const versionOk = check.ok && nodeVersionSupported(check.summary);
  return {
    ...check,
    ok: versionOk,
    summary: versionOk ? check.summary : nodeVersionFailureSummary(check.summary),
    details: {
      ...check.details,
      resolution_source: resolution.source,
      ...(resolution.env_key === undefined ? {} : { env_key: resolution.env_key }),
      ...(resolution.current_exec_path === undefined ? {} : { current_exec_path: resolution.current_exec_path }),
      ...(resolution.rejected === undefined ? {} : { rejected: resolution.rejected })
    }
  };
}

function redactCheck(check: DoctorCheck): DoctorCheck {
  return {
    ok: check.ok,
    summary: redactOperatorPath(check.summary),
    details: redactedRecord(check.details)
  };
}

function redactedRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = redactedValue(value);
  }
  return output;
}

function redactedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactOperatorPath(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactedValue(item));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = redactedValue(nested);
    }
    return output;
  }
  return value;
}

async function claudeRuntimeCheck(runtime: RuntimeMaterialization): Promise<DoctorCheck> {
  if (runtime.claude.rejected !== undefined) {
    return {
      ok: false,
      summary: runtime.claude.rejected.reason,
      details: runtime.claude
    };
  }
  const executable = runtime.claude.executable;
  if (executable === undefined) {
    return {
      ok: true,
      summary: "Claude Agent SDK bundled executable will be used",
      details: { executable: "sdk-bundled", override_env: CLAUDE_CODE_EXECUTABLE_ENV, resolution_source: runtime.claude.source }
    };
  }
  return commandCheck(executable, ["--version"]);
}

function authEnvCheck(runtime: RuntimeMaterialization): DoctorCheck {
  const authEnv = runtime.auth_env;
  const ok = !authEnv.configured || (
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
  return {
    ok,
    summary: authEnv.configured
      ? ok
        ? "auth env file is configured and private"
        : "auth env file is not ready"
      : "auth env file is not configured; Claude SDK default auth may be used",
    details: authEnv
  };
}

async function ledgerCheck(): Promise<DoctorCheck> {
  try {
    await mkdir(jobsRoot(), { recursive: true });
    return {
      ok: true,
      summary: "ledger root is writable",
      details: { state_root: redactOperatorPath(stateRoot()), jobs_root: redactOperatorPath(jobsRoot()) }
    };
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : "ledger root is not writable",
      details: { state_root: redactOperatorPath(stateRoot()), jobs_root: redactOperatorPath(jobsRoot()) }
    };
  }
}

async function commandCheck(command: string, args: string[]): Promise<DoctorCheck> {
  try {
    const result = await runCommand(command, args, process.cwd(), 10_000, runtimeProbeEnvironment());
    return {
      ok: result.exit_code === 0,
      summary: result.exit_code === 0 ? result.stdout.trim() : `command exited ${result.exit_code}`,
      details: { command: redactOperatorPath(command), args, exit_code: result.exit_code, ...(result.timed_out === undefined ? {} : { timed_out: result.timed_out }) }
    };
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : "command check failed",
      details: { command: redactOperatorPath(command), args, exit_code: 127 }
    };
  }
}

function runtimeProbeEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL
  };
}

function nodeVersionSupported(summary: string): boolean {
  const match = /^v(?<major>\d+)\./.exec(summary);
  if (match?.groups?.major === undefined) {
    return false;
  }
  return Number.parseInt(match.groups.major, 10) >= 20;
}

function nodeVersionFailureSummary(summary: string): string {
  if (summary.length === 0 || summary.startsWith("command exited")) {
    return summary;
  }
  return `Node ${summary} does not satisfy >=20`;
}

async function rolesCheck(): Promise<DoctorCheck> {
  try {
    const report = await roleReport();
    return {
      ok: report.roles.length > 0,
      summary: `${report.roles.length} packaged delegate roles available`,
      details: { manifest: redactOperatorPath(rolesManifestPath()), roles_root: redactOperatorPath(rolesRoot()), role_count: report.roles.length, source: report.source }
    };
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : "packaged role catalogue is unavailable",
      details: { manifest: redactOperatorPath(rolesManifestPath()), package_root: redactOperatorPath(packageRoot()) }
    };
  }
}
