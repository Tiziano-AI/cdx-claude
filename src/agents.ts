import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { NormalizedStartRequest, RoleReport, RoleSummary } from "./contracts.js";
import { UserVisibleError } from "./errors.js";
import { rolesManifestPath, rolesRoot } from "./paths.js";

const RoleContractSchema = z.record(z.string(), z.unknown()).default({});

const PackagedRoleSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  contract: RoleContractSchema,
  model_policy: z.string().optional(),
  path: z.string().min(1),
  sha256: z.string().min(64)
});

const RoleManifestSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().min(1),
  upstream: z.record(z.string(), z.unknown()),
  role_count: z.number().int().positive(),
  roles: z.array(PackagedRoleSchema)
});

export type PackagedRole = z.infer<typeof PackagedRoleSchema>;

export interface ResolvedAgentRole {
  role: PackagedRole;
  role_toml: string;
  prompt: string;
}

/** Returns the packaged role catalogue used for delegate prompt selection. */
export async function roleReport(): Promise<RoleReport> {
  const catalogue = await readPackagedRoleCatalogue();
  return {
    source: catalogue.source,
    roles: catalogue.roles.map(roleSummary)
  };
}

/** Loads and validates the caller-selected packaged role TOML for a Claude delegate job. */
export async function resolveAgentRole(
  request: NormalizedStartRequest,
  executionCwd: string,
  additionalDirectories: string[]
): Promise<ResolvedAgentRole> {
  const catalogue = await readPackagedRoleCatalogue();
  const role = catalogue.roles.find((candidate) => candidate.name === request.agent_role);
  if (role === undefined) {
    throw new UserVisibleError(`delegate role is not available: ${request.agent_role}`, {
      code: "agent_role_not_found",
      field: "agent_role",
      recoverable: true,
      hint: "Call claude_delegate_roles or run cdx-claude roles."
    });
  }
  const roleToml = await readFile(rolePath(role), "utf8");
  return {
    role,
    role_toml: roleToml,
    prompt: buildAgentPrompt(role, roleToml, request, executionCwd, additionalDirectories)
  };
}

interface Catalogue {
  source: Record<string, unknown>;
  roles: PackagedRole[];
}

async function readPackagedRoleCatalogue(): Promise<Catalogue> {
  const parsed = RoleManifestSchema.parse(JSON.parse(await readFile(rolesManifestPath(), "utf8")));
  if (parsed.role_count !== parsed.roles.length) {
    throw new UserVisibleError("packaged role manifest count does not match role entries.", {
      code: "role_manifest_invalid",
      recoverable: false,
      hint: "Run pnpm roles:sync and pnpm roles:check from the source checkout."
    });
  }
  return {
    source: {
      schema_version: parsed.schema_version,
      generated_at: parsed.generated_at,
      upstream: parsed.upstream,
      role_count: parsed.role_count
    },
    roles: parsed.roles
  };
}

function rolePath(role: PackagedRole): string {
  const candidate = path.join(rolesRoot(), role.path);
  const relative = path.relative(rolesRoot(), candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UserVisibleError(`delegate role path escapes role root: ${role.name}`, {
      code: "agent_role_invalid",
      field: "agent_role",
      recoverable: false
    });
  }
  return candidate;
}

function roleSummary(role: PackagedRole): RoleSummary {
  return {
    name: role.name,
    description: role.description,
    path: role.path,
    contract: role.contract
  };
}

function buildAgentPrompt(
  role: PackagedRole,
  roleToml: string,
  request: NormalizedStartRequest,
  executionCwd: string,
  additionalDirectories: string[]
): string {
  const additionalRootLines = additionalDirectories.length === 0
    ? ["- Additional read-only roots: none"]
    : [
        "- Additional read-only roots:",
        ...additionalDirectories.map((directory) => `  - ${displayPath(directory)}`)
      ];
  return [
    "You are Claude Code running as a cdx-claude servant delegate for Codex.",
    "",
    "cdx-claude authority contract:",
    "- Codex is the authority owner. You return evidence, results, and isolated worktree diffs for Codex to inspect.",
    "- Do not edit the parent workspace. Patch modes operate only in the provided execution worktree.",
    "- Do not stage, commit, push, publish, install, or mutate runtime plugin/cache surfaces unless the task explicitly asks for worktree file edits that demonstrate a patch.",
    "- Do not spawn, invoke, or delegate to other agents. You are the selected role for this job.",
    "- Stay within the execution root, declared read-only roots, and the tools made available by cdx-claude.",
    "- Treat additional roots as read-only context. Do not write, edit, create, delete, move, or stage files there.",
    "- cdx-claude does not redact prompts, logs, events, diffs, or results; treat outputs as product data moving between Codex and Claude.",
    "",
    "Job context:",
    `- Role: ${role.name}`,
    `- Role path: roles/${role.path}`,
    `- Mode: ${request.mode}`,
    `- Title: ${request.title ?? request.prompt.slice(0, 80)}`,
    `- Execution root: ${displayPath(executionCwd)}`,
    ...additionalRootLines,
    `- Web tools enabled: ${request.allow_web}`,
    "",
    "Selected packaged delegate role TOML follows verbatim:",
    "```toml",
    roleToml.trimEnd(),
    "```",
    "",
    "Output contract:",
    "- Be concise, evidence-grounded, and explicit about uncertainty.",
    "- For research jobs, do not edit files.",
    "- For patch jobs, make only task-scoped worktree edits and summarize the diff.",
    "- Final output must tell Codex what was proven, what changed if anything, and what remains blocked."
  ].join("\n");
}

function displayPath(value: string): string {
  return JSON.stringify(value);
}
