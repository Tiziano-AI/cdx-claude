#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const version = packageJson.version;
const outfile = path.join(repoRoot, "plugin", "bin", "cdx-claude");

await mkdir(path.dirname(outfile), { recursive: true });
await writeFile(outfile, launcher(version), "utf8");
await chmod(outfile, 0o755);

function launcher(version) {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const requestedSpec = process.env.CDX_CLAUDE_NPM_SPEC;
const runtimeSpec = requestedSpec && requestedSpec.trim().length > 0 ? requestedSpec : "cdx-claude@${version}";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const emptyNpmConfig = path.join(tmpdir(), "cdx-claude-empty-npmrc");
const env = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  TEMP: process.env.TEMP ?? tmpdir(),
  TMP: process.env.TMP ?? tmpdir(),
  USER: process.env.USER ?? "",
  LOGNAME: process.env.LOGNAME ?? "",
  SHELL: process.env.SHELL ?? "",
  TERM: process.env.TERM ?? "",
  CDX_CLAUDE_HOME: process.env.CDX_CLAUDE_HOME,
  CDX_CLAUDE_CODE_EXECUTABLE: process.env.CDX_CLAUDE_CODE_EXECUTABLE,
  CDX_CLAUDE_PLUGIN_ROOT: process.cwd(),
  CDX_CLAUDE_AUTH_ENV_FILE: process.env.CDX_CLAUDE_AUTH_ENV_FILE,
  npm_config_userconfig: emptyNpmConfig,
  NPM_CONFIG_USERCONFIG: emptyNpmConfig,
  npm_config_audit: "false",
  npm_config_fund: "false"
};
if (process.platform === "win32") {
  env.SystemRoot = process.env.SystemRoot ?? "";
  env.ComSpec = process.env.ComSpec ?? "";
}
const result = spawnSync(npm, ["exec", "--yes", "--package", runtimeSpec, "--", "cdx-claude", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  shell: false
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
`;
}
