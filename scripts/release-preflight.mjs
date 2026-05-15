#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandDetails,
  createCommandRunner,
  doctorEnvelopeOk,
  firstLine,
  parseCodexMcpCwd,
  readJson,
  readString,
  redactPath,
  withoutPrivateProofAuth,
  withoutNpmSpec
} from "./release-preflight-helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = createCommandRunner(repoRoot);
const startedAt = new Date().toISOString();
const packageJson = await readJson(path.join(repoRoot, "package.json"));
const version = readString(packageJson, "version");
const expectedInstalledRoot = path.join(homedir(), ".codex", "plugins", "cache", "cdx-claude", "cdx-claude", version);
const receipt = {
  schema_version: 1,
  command: "pnpm release:preflight",
  generated_at: startedAt,
  repo_root: redactPath(repoRoot),
  release_version: version,
  required_ok: true,
  source_candidate_ok: true,
  public_installed_complete: false,
  rows: []
};

const packRoot = await mkdtemp(path.join(tmpdir(), "cdx-claude-release-preflight-"));

try {
  await collectGit();
  await sourceGate("pnpm verify", "pnpm", ["verify"], 120_000);
  await sourceGate("uv run devtools/gate.py", "uv", ["run", "devtools/gate.py"], 120_000);
  await sourceGate("git diff --check", "git", ["diff", "--check"], 30_000);
  await collectSourceIdentity();
  await collectPackageProof();
  await collectRegistryAndInstallState();
} finally {
  await rm(packRoot, { recursive: true, force: true });
}

receipt.source_candidate_ok = receipt.rows.filter((row) => row.required).every((row) => row.ok);
receipt.public_installed_complete = publicInstalledRows().every((row) => row.ok);
receipt.required_ok = receipt.source_candidate_ok;
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!receipt.required_ok) {
  process.exitCode = 1;
}

async function collectGit() {
  const head = await run("git", ["rev-parse", "HEAD"], { timeoutMs: 30_000 });
  const branch = await run("git", ["branch", "--show-current"], { timeoutMs: 30_000 });
  const status = await run("git", ["status", "--short"], { timeoutMs: 30_000 });
  const localTag = await run("git", ["rev-parse", `v${version}^{commit}`], { timeoutMs: 30_000 });
  const remoteTag = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/v${version}`], { timeoutMs: 30_000 });
  const headSha = firstLine(head.stdout);
  const localTagSha = firstLine(localTag.stdout);
  const remoteTagSha = firstLine(remoteTag.stdout).split(/\s+/u)[0] ?? "";
  addRow({
    name: "git_identity",
    surface: "git",
    required: false,
    ok: head.exit_code === 0 && branch.exit_code === 0,
    status: "observed",
    details: {
      head: firstLine(head.stdout),
      branch: firstLine(branch.stdout),
      dirty: status.stdout.trim().length > 0,
      expected_tag: `v${version}`,
      local_tag_observed: localTag.exit_code === 0,
      local_tag_points_at_head: localTagSha.length > 0 && localTagSha === headSha,
      remote_tag_observed: remoteTag.exit_code === 0 && remoteTagSha.length > 0,
      remote_tag_points_at_head: remoteTagSha.length > 0 && remoteTagSha === headSha
    }
  });
}

async function sourceGate(name, command, args, timeoutMs) {
  const result = await run(command, args, { timeoutMs });
  addRow({
    name,
    surface: "source_gate",
    required: true,
    ok: result.exit_code === 0,
    status: result.exit_code === 0 ? "pass" : "fail",
    details: commandDetails(result)
  });
}

async function collectSourceIdentity() {
  const pluginJson = await readJson(path.join(repoRoot, "plugin", ".codex-plugin", "plugin.json"));
  const marketplace = await readJson(path.join(repoRoot, ".agents", "plugins", "marketplace.json"));
  const launcher = await readFile(path.join(repoRoot, "plugin", "bin", "cdx-claude"), "utf8");
  const marketplaceRef = marketplace.plugins?.[0]?.source?.ref;
  const checks = [
    { name: "package_json", ok: readString(packageJson, "version") === version, value: readString(packageJson, "version") },
    { name: "plugin_manifest", ok: readString(pluginJson, "version") === version, value: readString(pluginJson, "version") },
    { name: "launcher_spec", ok: launcher.includes(`cdx-claude@${version}`), value: `cdx-claude@${version}` },
    { name: "marketplace_ref", ok: marketplaceRef === `v${version}`, value: marketplaceRef },
    { name: "node_override_absent", ok: !launcher.includes("CDX_CLAUDE_NODE_EXECUTABLE"), value: "CDX_CLAUDE_NODE_EXECUTABLE" },
    { name: "auth_file_pointer_forwarded", ok: launcher.includes("CDX_CLAUDE_AUTH_ENV_FILE"), value: "CDX_CLAUDE_AUTH_ENV_FILE" }
  ];
  addRow({
    name: "release_identity_alignment",
    surface: "source_identity",
    required: true,
    ok: checks.every((check) => check.ok),
    status: checks.every((check) => check.ok) ? "pass" : "fail",
    details: { checks }
  });
}

async function collectPackageProof() {
  const published = await npmVersionPublished();
  if (published.ok) {
    addRow({
      name: "npm_publish_dry_run",
      surface: "candidate_package",
      required: true,
      ok: true,
      status: "observed",
      details: {
        ...commandDetails(published.result),
        reason: "version is already published; npm dry-run is a pre-publish proof and is skipped after immutable registry publication"
      }
    });
  } else {
    const dryRun = await run("npm", ["publish", "--dry-run"], { timeoutMs: 120_000 });
    addRow({
      name: "npm_publish_dry_run",
      surface: "candidate_package",
      required: true,
      ok: dryRun.exit_code === 0,
      status: dryRun.exit_code === 0 ? "pass" : "fail",
      details: commandDetails(dryRun)
    });
  }

  const pack = await run("pnpm", ["pack", "--pack-destination", packRoot], { timeoutMs: 120_000 });
  const tarball = await findTarball();
  addRow({
    name: "pnpm_pack",
    surface: "candidate_package",
    required: true,
    ok: pack.exit_code === 0 && tarball !== undefined,
    status: pack.exit_code === 0 && tarball !== undefined ? "pass" : "fail",
    details: { ...commandDetails(pack), tarball: tarball === undefined ? undefined : redactPath(tarball) }
  });
  if (tarball === undefined) {
    return;
  }

  const fingerprint = await tarballFingerprint(tarball);
  addRow({
    name: "tarball_fingerprint",
    surface: "candidate_package",
    required: true,
    ok: fingerprint.file_count > 0,
    status: fingerprint.file_count > 0 ? "pass" : "fail",
    details: fingerprint
  });

  await tarballProof("tarball_launcher_help", ["--help"], 60_000, tarball);
  await tarballProof("tarball_doctor", ["doctor"], 60_000, tarball);
  const tools = await run("pnpm", ["mcp:tools-proof"], {
    timeoutMs: 60_000,
    env: withoutPrivateProofAuth({
      ...process.env,
      CDX_CLAUDE_NPM_SPEC: tarball,
      CDX_CLAUDE_HOME: path.join(packRoot, "mcp-tools-state")
    })
  });
  const toolsOk = tools.exit_code === 0 && tools.stdout.includes("\"ok\": true");
  addRow({
    name: "tarball_mcp_tools_schema_and_behavior",
    surface: "candidate_runtime",
    required: true,
    ok: toolsOk,
    status: toolsOk ? "pass" : "fail",
    details: commandDetails(tools)
  });
}

async function npmVersionPublished() {
  const result = await run("npm", ["view", `cdx-claude@${version}`, "version", "--json"], { timeoutMs: 30_000 });
  return {
    ok: result.exit_code === 0 && firstLine(result.stdout).replaceAll("\"", "") === version,
    result
  };
}

async function tarballProof(name, args, timeoutMs, tarball) {
  const result = await run(path.join(repoRoot, "plugin", "bin", "cdx-claude"), args, {
    timeoutMs,
    cwd: path.join(repoRoot, "plugin"),
    env: withoutPrivateProofAuth({
      ...process.env,
      CDX_CLAUDE_NPM_SPEC: tarball,
      CDX_CLAUDE_HOME: path.join(packRoot, name)
    })
  });
  addRow({
    name,
    surface: "candidate_runtime",
    required: true,
    ok: result.exit_code === 0 && (name.endsWith("_doctor") ? doctorEnvelopeOk(result.stdout) : true),
    status: result.exit_code === 0 && (name.endsWith("_doctor") ? doctorEnvelopeOk(result.stdout) : true) ? "pass" : "fail",
    details: commandDetails(result)
  });
}

async function collectRegistryAndInstallState() {
  const registry = await run("npm", ["view", `cdx-claude@${version}`, "version", "--json"], { timeoutMs: 30_000 });
  addRow({
    name: "npm_registry_identity",
    surface: "published_runtime",
    required: false,
    ok: registry.exit_code === 0 && firstLine(registry.stdout).replaceAll("\"", "") === version,
    status: registry.exit_code === 0 ? "observed" : "pending",
    details: commandDetails(registry)
  });

  const mcpRow = await run("codex", ["mcp", "get", "cdx-claude"], { timeoutMs: 30_000 });
  const mcpCwd = parseCodexMcpCwd(mcpRow.stdout);
  addRow({
    name: "codex_mcp_row",
    surface: "installed_runtime",
    required: false,
    ok: mcpRow.exit_code === 0 && mcpCwd === expectedInstalledRoot,
    status: mcpRow.exit_code === 0 ? "observed" : "pending",
    details: {
      ...commandDetails(mcpRow),
      expected_public_cache_root: redactPath(expectedInstalledRoot),
      observed_cwd: mcpCwd === undefined ? undefined : redactPath(mcpCwd),
      local_personal_observed: mcpCwd === undefined ? false : mcpCwd.includes(path.join(".codex", "plugins", "cache", "local-personal"))
    }
  });

  const installedRoot = expectedInstalledRoot;
  if (!existsSync(installedRoot)) {
    addInstalledPendingRows(installedRoot);
  } else {
    const installedEnv = withoutPrivateProofAuth(withoutNpmSpec({
      ...process.env,
      CDX_CLAUDE_HOME: path.join(packRoot, "installed-cache-state")
    }));
    const installedHelp = await run(path.join(installedRoot, "bin", "cdx-claude"), ["--help"], {
      timeoutMs: 60_000,
      cwd: installedRoot,
      env: installedEnv
    });
    addRow({
      name: "installed_cache_launcher_help",
      surface: "installed_runtime",
      required: false,
      ok: installedHelp.exit_code === 0,
      status: installedHelp.exit_code === 0 ? "observed" : "fail",
      details: commandDetails(installedHelp)
    });

    const installedTools = await run("node", [
      path.join(repoRoot, "scripts", "assert-mcp-tools.mjs"),
      path.join(installedRoot, "bin", "cdx-claude"),
      installedRoot
    ], {
      timeoutMs: 60_000,
      env: installedEnv
    });
    const installedToolsOk = installedTools.exit_code === 0 && installedTools.stdout.includes("\"ok\": true");
    addRow({
      name: "installed_cache_mcp_tools_schema",
      surface: "installed_runtime",
      required: false,
      ok: installedToolsOk,
      status: installedToolsOk ? "observed" : "fail",
      details: commandDetails(installedTools)
    });

    const installedDoctor = await run(path.join(installedRoot, "bin", "cdx-claude"), ["doctor"], {
      timeoutMs: 60_000,
      cwd: installedRoot,
      env: installedEnv
    });
    addRow({
      name: "installed_cache_doctor",
      surface: "installed_runtime",
      required: false,
      ok: installedDoctor.exit_code === 0 && doctorEnvelopeOk(installedDoctor.stdout),
      status: installedDoctor.exit_code === 0 ? "observed" : "fail",
      details: commandDetails(installedDoctor)
    });
  }

  await collectModelVisibleDoctorReceipt();
}

function addInstalledPendingRows(installedRoot) {
  for (const name of ["installed_cache_launcher_help", "installed_cache_mcp_tools_schema", "installed_cache_doctor"]) {
    addRow({
      name,
      surface: "installed_runtime",
      required: false,
      ok: false,
      status: "pending",
      details: { installed_root: redactPath(installedRoot), reason: "installed plugin cache for this version is not present" }
    });
  }
}

async function findTarball() {
  const entries = await readdir(packRoot);
  const names = entries.filter((name) => name.endsWith(".tgz") && name.includes(version)).sort();
  if (names.length === 0) {
    return undefined;
  }
  return path.join(packRoot, names[0]);
}

async function tarballFingerprint(tarball) {
  const raw = await readFile(tarball);
  const listing = await run("tar", ["-tf", tarball], { timeoutMs: 30_000 });
  const stats = await stat(tarball);
  const files = listing.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0).sort();
  return {
    tarball: redactPath(tarball),
    sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: stats.size,
    file_count: files.length,
    files: files.slice(0, 200)
  };
}

function addRow(row) {
  receipt.rows.push(row);
}

function publicInstalledRows() {
  const names = new Set([
    "npm_registry_identity",
    "codex_mcp_row",
    "installed_cache_launcher_help",
    "installed_cache_mcp_tools_schema",
    "installed_cache_doctor",
    "model_visible_mcp_doctor"
  ]);
  return receipt.rows.filter((row) => names.has(row.name));
}

async function collectModelVisibleDoctorReceipt() {
  const receiptPath = process.env.CDX_CLAUDE_MODEL_VISIBLE_DOCTOR_RECEIPT;
  if (receiptPath === undefined || receiptPath.trim().length === 0) {
    addRow({
      name: "model_visible_mcp_doctor",
      surface: "installed_runtime",
      required: false,
      ok: false,
      status: "pending",
      details: {
        instruction: "Run claude_delegate_doctor from the model-visible MCP tools after installing this version, save the redacted JSON envelope, then rerun preflight with CDX_CLAUDE_MODEL_VISIBLE_DOCTOR_RECEIPT pointing at that file."
      }
    });
    return;
  }
  const observed = await readModelVisibleDoctorReceipt(receiptPath);
  addRow({
    name: "model_visible_mcp_doctor",
    surface: "installed_runtime",
    required: false,
    ok: observed.ok,
    status: observed.ok ? "observed" : "fail",
    details: {
      receipt_path: redactPath(receiptPath),
      ...observed.details
    }
  });
}

async function readModelVisibleDoctorReceipt(receiptPath) {
  try {
    const raw = await readFile(receiptPath, "utf8");
    const parsed = JSON.parse(raw);
    return validateModelVisibleDoctor(parsed);
  } catch (error) {
    return {
      ok: false,
      details: { error: error instanceof Error ? scrubText(error.message) : "model-visible doctor receipt could not be read" }
    };
  }
}

function validateModelVisibleDoctor(parsed) {
  const envelope = extractDoctorEnvelope(parsed);
  if (envelope === undefined) {
    return { ok: false, details: { error: "receipt must be a claude_delegate_doctor JSON envelope" } };
  }
  const data = envelope.data;
  const runtimeDetails = data.runtime?.details;
  const releaseIdentity = runtimeDetails?.release_identity;
  const pluginRoot = runtimeDetails?.plugin_root;
  const pluginDetails = data.plugin?.details;
  const checks = [
    { name: "envelope_ok", ok: envelope.envelope_ok },
    { name: "command", ok: envelope.command === undefined || envelope.command === "claude_delegate_doctor" },
    { name: "doctor_data_ok", ok: data.ok === true },
    { name: "runtime_ok", ok: data.runtime?.ok === true },
    { name: "package_version", ok: releaseIdentity?.package_version === version },
    { name: "expected_version", ok: releaseIdentity?.expected_version === version },
    { name: "plugin_root_version", ok: pluginRoot?.version === version },
    { name: "plugin_root_public_cache", ok: pluginRoot?.path === redactPath(expectedInstalledRoot) && pluginRoot?.public_cache_match === true && pluginRoot?.cache_channel_ok === true },
    { name: "plugin_manifest_version", ok: pluginDetails?.manifest_version === version },
    { name: "auth_env_ok", ok: data.auth_env?.ok === true }
  ];
  return {
    ok: checks.every((check) => check.ok),
    details: {
      command: envelope.command,
      release_version: version,
      expected_public_cache_root: redactPath(expectedInstalledRoot),
      checks
    }
  };
}

function extractDoctorEnvelope(parsed) {
  if (parsed !== null && typeof parsed === "object" && parsed.ok === true && parsed.data !== null && typeof parsed.data === "object") {
    return {
      envelope_ok: true,
      command: typeof parsed.meta?.command === "string" ? parsed.meta.command : undefined,
      data: parsed.data
    };
  }
  return undefined;
}
