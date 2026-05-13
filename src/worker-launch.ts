import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { authEnvFileVariable } from "./auth-env.js";
import { CLAUDE_CODE_EXECUTABLE_ENV } from "./claude-executable.js";
import { packageRoot, PLUGIN_ROOT_ENV, stateRoot, stderrPath, stdoutPath } from "./paths.js";
import { materializeRuntime } from "./runtime-materialization.js";

/** Starts the hidden detached worker through the materialized active cdx-claude CLI path. */
export async function spawnWorker(jobId: string, workerToken: string): Promise<number> {
  const runtime = await materializeRuntime();
  const out = openSync(stdoutPath(jobId), "a");
  const err = openSync(stderrPath(jobId), "a");
  const child = spawn(runtime.node.executable, [workerCliPath(), "__worker", "--job-id", jobId], {
    detached: true,
    shell: false,
    stdio: ["ignore", out, err],
    env: workerEnvironment(workerToken, runtime.plugin_root.path)
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
  const invokedPath = process.argv[1];
  if (invokedPath !== undefined && (invokedPath.endsWith("cdx-claude") || invokedPath.endsWith("cli.js"))) {
    return invokedPath;
  }
  return path.join(packageRoot(), "dist", "src", "cli.js");
}

function workerEnvironment(workerToken: string, pluginRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    CDX_CLAUDE_HOME: stateRoot(),
    CDX_CLAUDE_WORKER_TOKEN: workerToken,
    [PLUGIN_ROOT_ENV]: pluginRoot
  };
  copyOptionalEnvironment(environment, "CDX_CLAUDE_DRIVER");
  copyOptionalEnvironment(environment, "CDX_CLAUDE_FAKE_DELAY_MS");
  copyOptionalEnvironment(environment, "CDX_CLAUDE_FAKE_ECHO_ENV_KEY");
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
