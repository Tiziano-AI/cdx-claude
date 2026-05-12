#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rolesRoot = path.join(repoRoot, "roles");
const upstreamRepo = process.env.CDX_AGENTS_REPO;
if (!upstreamRepo || upstreamRepo.trim().length === 0) {
  throw new Error("CDX_AGENTS_REPO must point at the upstream cdx-agents checkout.");
}
const upstreamCommit = execFileSync("git", ["-C", upstreamRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const output = execFileSync("cdx-agents", ["--json", "list"], { encoding: "utf8" });
const parsed = JSON.parse(output);
if (parsed.ok !== true) {
  throw new Error("cdx-agents role list is unhealthy");
}
const sourceRoles = parsed.data.source_roles;
await mkdir(rolesRoot, { recursive: true });
const roles = [];
for (const role of sourceRoles) {
  const sourcePath = role.path;
  const fileName = `${role.name}.toml`;
  const roleToml = await readFile(sourcePath, "utf8");
  await writeFile(path.join(rolesRoot, fileName), roleToml, "utf8");
  roles.push({
    name: role.name,
    description: role.description,
    contract: role.contract ?? {},
    model_policy: role.model_policy,
    path: fileName,
    sha256: createHash("sha256").update(roleToml).digest("hex")
  });
}
const manifest = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  upstream: {
    name: "cdx-agents",
    repository: "https://github.com/Tiziano-AI/cdx-agents",
    commit: upstreamCommit
  },
  role_count: roles.length,
  roles
};
await writeFile(path.join(rolesRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
