import { spawn } from "node:child_process";

export interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
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
