import { constants } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { UserVisibleError } from "./errors.js";

const AUTH_ENV_FILE = "CDX_CLAUDE_AUTH_ENV_FILE";
const MAX_AUTH_ENV_FILE_BYTES = 64 * 1024;

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

export interface AuthEnvInspection {
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
}

interface AuthEnvLoad {
  inspection: AuthEnvInspection;
  values: Record<string, string>;
}

/** Returns the environment variable used to point the launcher at Claude auth dotenv material. */
export function authEnvFileVariable(): string {
  return AUTH_ENV_FILE;
}

/** Returns the sorted allowlist of dotenv keys accepted for Claude authentication. */
export function authEnvAllowedKeys(): string[] {
  return [...AUTH_ENV_ALLOWLIST].sort();
}

/** Returns configured auth values that public views must redact if Claude echoes them. */
export async function authSecretRedactionValues(environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const values: string[] = [];
  collectSensitiveValues(authEnvironmentFromProcess(environment), values);
  const file = environment[AUTH_ENV_FILE];
  if (file !== undefined && file.trim().length > 0) {
    const loaded = await loadAuthEnvironmentFile(file);
    if (authEnvInspectionOk(loaded.inspection)) {
      collectSensitiveValues(loaded.values, values);
    }
  }
  return uniqueRedactionValues(values);
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
  const loaded = await loadAuthEnvironmentFile(file);
  if (!authEnvInspectionOk(loaded.inspection)) {
    throw new UserVisibleError(loaded.inspection.error ?? "Claude auth env file is not ready.", {
      code: "auth_env_not_ready",
      field: AUTH_ENV_FILE,
      recoverable: true,
      hint: "Use an absolute private dotenv file with mode 0600 and allowlisted Claude/provider key names only."
    });
  }
  return loaded.values;
}

/** Denies delegation before ledger creation when a configured auth dotenv is invalid. */
export async function assertConfiguredAuthEnvironmentReady(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const inspection = await inspectAuthEnvironmentFile(environment);
  if (!authEnvInspectionOk(inspection)) {
    throw new UserVisibleError(inspection.error ?? "Claude auth env file is not ready.", {
      code: "auth_env_not_ready",
      field: AUTH_ENV_FILE,
      recoverable: true,
      hint: "Fix CDX_CLAUDE_AUTH_ENV_FILE or unset it to use Claude SDK default authentication."
    });
  }
}

/** Inspects configured auth dotenv readiness without returning paths or secret values. */
export async function inspectAuthEnvironmentFile(environment: NodeJS.ProcessEnv = process.env): Promise<AuthEnvInspection> {
  const file = environment[AUTH_ENV_FILE];
  if (file === undefined || file.trim().length === 0) {
    return {
      configured: false,
      absolute: false,
      exists: false,
      readable: false,
      regular_file: false,
      symlink: false,
      private_mode: false,
      owner_ok: false,
      parent_writable: false,
      size_ok: false,
      key_names: []
    };
  }
  if (!path.isAbsolute(file)) {
    return {
      configured: true,
      path_redacted: "[redacted]",
      absolute: false,
      exists: false,
      readable: false,
      regular_file: false,
      symlink: false,
      private_mode: false,
      owner_ok: false,
      parent_writable: false,
      size_ok: false,
      key_names: [],
      error: `${AUTH_ENV_FILE} must be an absolute path`
    };
  }
  return (await loadAuthEnvironmentFile(file)).inspection;
}

/** Returns allowlisted Claude auth variables already present in the current process. */
export function authEnvironmentFromProcess(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of AUTH_ENV_ALLOWLIST) {
    const value = environment[key];
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

function collectSensitiveValues(environment: Record<string, string>, values: string[]): void {
  for (const [key, value] of Object.entries(environment)) {
    if (isSensitiveAuthKey(key) && isRedactionValue(value)) {
      values.push(value);
    }
  }
}

function isSensitiveAuthKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH|HEADER|CERT|BEARER/u.test(key);
}

function isRedactionValue(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 4) {
    return false;
  }
  return normalized !== "true" && normalized !== "false";
}

function uniqueRedactionValues(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => right.length - left.length);
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

async function loadAuthEnvironmentFile(file: string): Promise<AuthEnvLoad> {
  if (!path.isAbsolute(file)) {
    return {
      inspection: unavailableInspection(false, `${AUTH_ENV_FILE} must be an absolute path`),
      values: {}
    };
  }
  try {
    const linkStats = await lstat(file);
    const stats = await stat(file);
    const parentStats = await stat(path.dirname(file));
    const readable = await isReadable(file);
    const baseInspection = {
      configured: true,
      path_redacted: "[redacted]",
      absolute: true,
      exists: true,
      readable,
      regular_file: stats.isFile(),
      symlink: linkStats.isSymbolicLink(),
      private_mode: (stats.mode & 0o777) === 0o600,
      owner_ok: ownerOk(stats.uid),
      parent_writable: (parentStats.mode & 0o022) !== 0,
      size_ok: stats.size <= MAX_AUTH_ENV_FILE_BYTES,
      key_names: []
    };
    if (!preReadAuthEnvInspectionOk(baseInspection)) {
      return {
        inspection: {
          ...baseInspection,
          error: authEnvInspectionError(baseInspection)
        },
        values: {}
      };
    }
    const raw = await readFile(file, "utf8");
    let parsed: Record<string, string>;
    try {
      parsed = parseAuthEnv(raw);
    } catch (error) {
      return {
        inspection: {
          ...baseInspection,
          error: sanitizedAuthError(error)
        },
        values: {}
      };
    }
    const inspection = {
      ...baseInspection,
      key_names: Object.keys(parsed).sort()
    };
    return {
      inspection: {
        ...inspection,
        ...(authEnvInspectionOk(inspection) ? {} : { error: authEnvInspectionError(inspection) })
      },
      values: parsed
    };
  } catch (error) {
    return {
      inspection: unavailableInspection(true, sanitizedAuthError(error)),
      values: {}
    };
  }
}

function unavailableInspection(absolute: boolean, error: string): AuthEnvInspection {
  return {
    configured: true,
    path_redacted: "[redacted]",
    absolute,
    exists: false,
    readable: false,
    regular_file: false,
    symlink: false,
    private_mode: false,
    owner_ok: false,
    parent_writable: false,
    size_ok: false,
    key_names: [],
    error
  };
}

function authEnvInspectionOk(inspection: AuthEnvInspection): boolean {
  if (!inspection.configured) {
    return true;
  }
  return (
    inspection.absolute &&
    inspection.exists &&
    inspection.readable &&
    inspection.regular_file &&
    !inspection.symlink &&
    inspection.private_mode &&
    inspection.owner_ok &&
    !inspection.parent_writable &&
    inspection.size_ok &&
    inspection.error === undefined
  );
}

function preReadAuthEnvInspectionOk(inspection: AuthEnvInspection): boolean {
  return (
    inspection.absolute &&
    inspection.exists &&
    inspection.readable &&
    inspection.regular_file &&
    !inspection.symlink &&
    inspection.private_mode &&
    inspection.owner_ok &&
    !inspection.parent_writable &&
    inspection.size_ok
  );
}

function authEnvInspectionError(inspection: AuthEnvInspection): string {
  if (!inspection.absolute) {
    return `${AUTH_ENV_FILE} must be an absolute path`;
  }
  if (!inspection.exists) {
    return "auth env file does not exist";
  }
  if (!inspection.regular_file) {
    return "auth env path must be a regular file";
  }
  if (inspection.symlink) {
    return "auth env path must not be a symlink";
  }
  if (!inspection.readable) {
    return "auth env file is not readable";
  }
  if (!inspection.private_mode) {
    return "auth env file must use mode 0600";
  }
  if (!inspection.owner_ok) {
    return "auth env file owner is not trusted";
  }
  if (inspection.parent_writable) {
    return "auth env parent directory must not be group/world writable";
  }
  if (!inspection.size_ok) {
    return "auth env file is too large";
  }
  return "auth env file is not ready";
}

function ownerOk(uid: number): boolean {
  if (typeof process.getuid !== "function") {
    return true;
  }
  const currentUid = process.getuid();
  return uid === currentUid || uid === 0;
}

async function isReadable(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return false;
    }
    throw error;
  }
}

function sanitizedAuthError(error: unknown): string {
  if (error instanceof Error && (
    error.message.startsWith("unsupported Claude auth env key: ") ||
    error.message.startsWith("malformed Claude auth env")
  )) {
    return error.message;
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return `auth env file ${error.code}`;
  }
  return "auth env file is unavailable";
}

function parseLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }
  const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const separator = normalized.indexOf("=");
  if (separator <= 0) {
    throw new Error("malformed Claude auth env row");
  }
  const key = normalized.slice(0, separator).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) {
    throw new Error(`malformed Claude auth env key: ${key}`);
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
