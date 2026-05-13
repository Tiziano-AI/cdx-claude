import { spawn } from "node:child_process";

export interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out?: boolean;
}

/** Runs one bounded local command without a shell and captures stdout/stderr. */
export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 10_000,
  environment: NodeJS.ProcessEnv = process.env
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      resolve({
        exit_code: 124,
        stdout,
        stderr,
        timed_out: true
      });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });
}

export async function runRequired(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const result = await runCommand(command, args, cwd);
  if (result.exit_code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}
