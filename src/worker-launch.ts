import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { authEnvFileVariable } from "./auth-env.js";
import { CLAUDE_CODE_EXECUTABLE_ENV } from "./claude-executable.js";
import { NODE_EXECUTABLE_ENV, resolveNodeExecutablePath } from "./executable.js";
import { activePluginRoot, packageRoot, PLUGIN_ROOT_ENV, stateRoot, stderrPath, stdoutPath } from "./paths.js";

/** Starts the hidden detached worker through the active cdx-claude CLI path. */
export function spawnWorker(jobId: string, workerToken: string): number {
  const out = openSync(stdoutPath(jobId), "a");
  const err = openSync(stderrPath(jobId), "a");
  const child = spawn(resolveNodeExecutablePath(), [workerCliPath(), "__worker", "--job-id", jobId], {
    detached: true,
    shell: false,
    stdio: ["ignore", out, err],
    env: workerEnvironment(workerToken)
  });
  closeSync(out);
  closeSync(err);
  child.unref();
  if (child.pid === undefined) {
    throw new Error("worker process did not expose a pid");
  }
  return child.pid;
}

function workerCliPath(): string {
  if (process.env.CDX_CLAUDE_WORKER_CLI !== undefined && process.env.CDX_CLAUDE_WORKER_CLI.length > 0) {
    return process.env.CDX_CLAUDE_WORKER_CLI;
  }
  const invokedPath = process.argv[1];
  if (invokedPath !== undefined && (invokedPath.endsWith("cdx-claude") || invokedPath.endsWith("cli.js"))) {
    return invokedPath;
  }
  return path.join(packageRoot(), "dist", "src", "cli.js");
}

function workerEnvironment(workerToken: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    CDX_CLAUDE_HOME: stateRoot(),
    CDX_CLAUDE_WORKER_TOKEN: workerToken,
    [NODE_EXECUTABLE_ENV]: resolveNodeExecutablePath(),
    [PLUGIN_ROOT_ENV]: activePluginRoot()
  };
  copyOptionalEnvironment(environment, "CDX_CLAUDE_DRIVER");
  copyOptionalEnvironment(environment, "CDX_CLAUDE_FAKE_DELAY_MS");
  copyOptionalEnvironment(environment, CLAUDE_CODE_EXECUTABLE_ENV);
  copyOptionalEnvironment(environment, authEnvFileVariable());
  return environment;
}

function copyOptionalEnvironment(environment: NodeJS.ProcessEnv, key: string): void {
  const value = process.env[key];
  if (value !== undefined && value.trim().length > 0) {
    environment[key] = value;
  }
}
