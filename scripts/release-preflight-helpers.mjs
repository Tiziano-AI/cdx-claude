import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** Creates the timeout-bounded command runner used by release preflight receipts. */
export function createCommandRunner(defaultCwd) {
  return function run(command, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? defaultCwd;
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        resolve({ command, args, exit_code: 124, stdout, stderr, timed_out: true, duration_ms: Date.now() - started });
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ command, args, exit_code: 127, stdout, stderr: error.message, duration_ms: Date.now() - started });
      });
      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ command, args, exit_code: exitCode ?? 1, stdout, stderr, duration_ms: Date.now() - started });
      });
    });
  };
}

/** Returns redacted command output suitable for public release receipts. */
export function commandDetails(result) {
  return {
    command: redactPath(result.command),
    args: result.args.map((arg) => redactPath(arg)),
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    timed_out: result.timed_out === true,
    stdout_head: scrubText(result.stdout).slice(0, 1000),
    stderr_head: scrubText(result.stderr).slice(0, 1000)
  };
}

/** Reads a JSON file from disk. */
export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Reads a string property from a parsed JSON object. */
export function readString(value, key) {
  if (typeof value === "object" && value !== null && key in value && typeof value[key] === "string") {
    return value[key];
  }
  return "";
}

/** Returns the first trimmed output line. */
export function firstLine(value) {
  return value.trim().split(/\r?\n/u)[0] ?? "";
}

/** Returns a copy of the environment without release-candidate npm overrides. */
export function withoutNpmSpec(environment) {
  const copy = { ...environment };
  delete copy.CDX_CLAUDE_NPM_SPEC;
  return copy;
}

/** Returns a proof environment that cannot load private Claude auth dotenv material. */
export function withoutPrivateProofAuth(environment) {
  const copy = { ...environment };
  delete copy.CDX_CLAUDE_AUTH_ENV_FILE;
  for (const key of Object.keys(copy)) {
    if (isAuthEnvironmentKey(key)) {
      delete copy[key];
    }
  }
  return copy;
}

/** Extracts and normalizes the cwd row from `codex mcp get` output. */
export function parseCodexMcpCwd(stdout) {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("cwd:")) {
      continue;
    }
    const value = trimmed.slice("cwd:".length).trim();
    if (value.length === 0) {
      return undefined;
    }
    return normalizePluginRoot(value);
  }
  return undefined;
}

/** Returns whether stdout is a successful cdx-claude doctor JSON envelope. */
export function doctorEnvelopeOk(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.ok === true && parsed?.data?.ok === true;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      return false;
    }
    return false;
  }
}

/** Redacts operator-local home and temp roots from receipt fields. */
export function redactPath(value) {
  const home = homedir();
  const temporaryRoot = tmpdir();
  return value.replaceAll(home, "~").replaceAll(temporaryRoot, "$TMPDIR");
}

function normalizePluginRoot(value) {
  const expanded = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  const stripped = expanded.endsWith("/.") ? expanded.slice(0, -2) : expanded;
  return path.resolve(stripped);
}

function scrubText(value) {
  let scrubbed = value;
  for (const [key, envValue] of Object.entries(process.env)) {
    if (envValue === undefined || envValue.length < 4) {
      continue;
    }
    if (/TOKEN|SECRET|PASSWORD|KEY|COOKIE|AUTH|CREDENTIAL|PROXY|HEADER|CERT|BEARER/u.test(key)) {
      scrubbed = scrubbed.replaceAll(envValue, "[redacted]");
    }
  }
  return redactPath(scrubbed);
}

function isAuthEnvironmentKey(key) {
  return key.startsWith("ANTHROPIC_") ||
    key.startsWith("CLAUDE_CODE_") ||
    key.startsWith("AWS_") ||
    key.startsWith("AZURE_") ||
    key === "GOOGLE_APPLICATION_CREDENTIALS" ||
    key === "HTTPS_PROXY" ||
    key === "HTTP_PROXY" ||
    key === "NO_PROXY" ||
    key === "NODE_EXTRA_CA_CERTS" ||
    key === "SSL_CERT_FILE";
}
