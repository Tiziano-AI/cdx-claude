import { readFile } from "node:fs/promises";
import path from "node:path";

const AUTH_ENV_FILE = "CDX_CLAUDE_AUTH_ENV_FILE";

const AUTH_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AZURE_API_KEY",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE"
]);

/** Returns the environment variable used to point the launcher at Claude auth dotenv material. */
export function authEnvFileVariable(): string {
  return AUTH_ENV_FILE;
}

/** Loads allowlisted Claude auth variables from the current process and optional dotenv file. */
export async function claudeAuthEnvironment(): Promise<Record<string, string>> {
  const fromProcess = authEnvironmentFromProcess();
  const file = process.env[AUTH_ENV_FILE];
  if (file === undefined || file.trim().length === 0) {
    return fromProcess;
  }
  return {
    ...fromProcess,
    ...(await authEnvironmentFromFile(file))
  };
}

/** Loads allowlisted Claude auth variables from a dotenv file. */
export async function authEnvironmentFromFile(file: string): Promise<Record<string, string>> {
  if (!path.isAbsolute(file)) {
    throw new Error(`${AUTH_ENV_FILE} must be an absolute path`);
  }
  const raw = await readFile(file, "utf8");
  return parseAuthEnv(raw);
}

/** Returns allowlisted Claude auth variables already present in the current process. */
export function authEnvironmentFromProcess(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of AUTH_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

function parseAuthEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const parsed = parseLine(line);
    if (parsed === undefined) {
      continue;
    }
    if (!AUTH_ENV_ALLOWLIST.has(parsed.key)) {
      throw new Error(`unsupported Claude auth env key: ${parsed.key}`);
    }
    values[parsed.key] = parsed.value;
  }
  return values;
}

function parseLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }
  const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const separator = normalized.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  const key = normalized.slice(0, separator).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) {
    return undefined;
  }
  return {
    key,
    value: unquote(normalized.slice(separator + 1).trim())
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
