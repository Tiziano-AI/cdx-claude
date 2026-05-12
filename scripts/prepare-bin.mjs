#!/usr/bin/env node
import { chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await chmod(path.join(repoRoot, "dist", "src", "cli.js"), 0o755);
