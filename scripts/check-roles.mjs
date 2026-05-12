#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rolesRoot = path.join(repoRoot, "roles");
const manifestPath = path.join(rolesRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const roles = Array.isArray(manifest.roles) ? manifest.roles : [];
const files = (await readdir(rolesRoot)).filter((entry) => entry.endsWith(".toml")).sort();

if (roles.length !== files.length) {
  throw new Error(`role manifest count ${roles.length} does not match TOML count ${files.length}`);
}

for (const role of roles) {
  if (typeof role.name !== "string" || typeof role.path !== "string" || typeof role.sha256 !== "string") {
    throw new Error("role manifest entry is incomplete");
  }
  const content = await readFile(path.join(rolesRoot, role.path));
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== role.sha256) {
    throw new Error(`role checksum drift: ${role.name}`);
  }
}
