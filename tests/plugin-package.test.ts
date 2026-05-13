import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import test from "node:test";

test("plugin MCP config uses the installed cache-relative launcher", async () => {
  const raw = await readFile(path.join("plugin", ".mcp.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) {
    throw new Error("missing mcpServers");
  }
  const servers = parsed.mcpServers;
  if (typeof servers !== "object" || servers === null || !("cdx-claude" in servers)) {
    throw new Error("missing cdx-claude MCP server");
  }
  const server = servers["cdx-claude"];
  if (typeof server !== "object" || server === null) {
    throw new Error("invalid cdx-claude MCP server");
  }
  assert.equal("command" in server ? server.command : undefined, "./bin/cdx-claude");
  assert.deepEqual("args" in server ? server.args : undefined, ["mcp", "serve"]);
  assert.equal("cwd" in server ? server.cwd : undefined, ".");
});

test("plugin package has one executable public binary and no source-anchored launch paths", async () => {
  const packageRaw = await readFile("package.json", "utf8");
  const packageJson: unknown = JSON.parse(packageRaw);
  if (typeof packageJson !== "object" || packageJson === null || !("bin" in packageJson) || !("version" in packageJson)) {
    throw new Error("missing package bin");
  }
  assert.deepEqual(packageJson.bin, { "cdx-claude": "dist/src/cli.js" });
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("missing package version");
  }

  const launcher = path.join("plugin", "bin", "cdx-claude");
  const stats = await stat(launcher);
  await access(launcher, constants.X_OK);
  assert.equal(stats.isFile(), true);
  const launcherContent = await readFile(launcher, "utf8");
  assert.ok(launcherContent.length < 10_000);
  assert.match(launcherContent, new RegExp(`cdx-claude@${packageVersion.replaceAll(".", "\\.")}`));
  assert.match(launcherContent, /CDX_CLAUDE_NPM_SPEC/);
  assert.match(launcherContent, /CDX_CLAUDE_AUTH_ENV_FILE/);
  assert.match(launcherContent, /CDX_CLAUDE_NODE_EXECUTABLE/);
  assert.match(launcherContent, /CDX_CLAUDE_PLUGIN_ROOT: process\.cwd\(\)/);
  assert.doesNotMatch(launcherContent, /CDX_CLAUDE_PLUGIN_ROOT: process\.env\.CDX_CLAUDE_PLUGIN_ROOT \?\? process\.cwd\(\)/);
  assert.match(launcherContent, /npm/);
  assert.doesNotMatch(launcherContent, /\.\.\.process\.env/);
  assert.match(launcherContent, /npm_config_userconfig/);
  assert.doesNotMatch(launcherContent, new RegExp("node_modules/"));
  assert.doesNotMatch(launcherContent, new RegExp("@anthropic-ai/claude-agent-sdk"));

  for (const file of [
    path.join("plugin", ".mcp.json"),
    path.join("plugin", ".codex-plugin", "plugin.json"),
    path.join("plugin", "bin", "cdx-claude")
  ]) {
    const content = await readFile(file, "utf8");
    assert.equal(content.includes(process.cwd()), false);
    assert.doesNotMatch(content, /dist\/src\/(cli|mcp-server|worker)\.js/);
  }
});

test("release identity is aligned across npm package, plugin manifest, launcher, and marketplace", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string; files: string[] };
  const pluginJson = JSON.parse(await readFile(path.join("plugin", ".codex-plugin", "plugin.json"), "utf8")) as {
    version: string;
    author?: { name?: string; url?: string };
    homepage?: string;
    repository?: string;
    interface?: {
      websiteURL?: string;
      privacyPolicyURL?: string;
      termsOfServiceURL?: string;
      websiteUrl?: string;
      privacyPolicyUrl?: string;
      termsOfServiceUrl?: string;
    };
  };
  const marketplace = JSON.parse(await readFile(path.join(".agents", "plugins", "marketplace.json"), "utf8")) as {
    plugins: Array<{ source: { ref: string; path: string; source: string } }>;
  };
  const launcher = await readFile(path.join("plugin", "bin", "cdx-claude"), "utf8");
  assert.equal(pluginJson.version, packageJson.version);
  assert.deepEqual(pluginJson.author, { name: "Tiziano AI", url: "https://github.com/Tiziano-AI" });
  assert.equal(pluginJson.homepage, "https://github.com/Tiziano-AI/cdx-claude");
  assert.equal(pluginJson.repository, "https://github.com/Tiziano-AI/cdx-claude");
  assert.equal(pluginJson.interface?.websiteURL, "https://github.com/Tiziano-AI/cdx-claude");
  assert.equal(pluginJson.interface?.privacyPolicyURL, "https://github.com/Tiziano-AI/cdx-claude/blob/main/PRIVACY.md");
  assert.equal(pluginJson.interface?.termsOfServiceURL, "https://github.com/Tiziano-AI/cdx-claude/blob/main/TERMS.md");
  assert.equal(pluginJson.interface?.websiteUrl, undefined);
  assert.equal(pluginJson.interface?.privacyPolicyUrl, undefined);
  assert.equal(pluginJson.interface?.termsOfServiceUrl, undefined);
  assert.equal(marketplace.plugins[0]?.source.ref, `v${packageJson.version}`);
  assert.equal(marketplace.plugins[0]?.source.path, "./plugin");
  assert.equal(marketplace.plugins[0]?.source.source, "git-subdir");
  assert.match(launcher, new RegExp(`cdx-claude@${packageJson.version.replaceAll(".", "\\.")}`));
  assert.deepEqual(packageJson.files, [
    "dist/src/",
    "roles/",
    "README.md",
    "LICENSE",
    "TERMS.md",
    "PRIVACY.md",
    "SECURITY.md"
  ]);
});

test("plugin skill tells Codex to leave the usage guard on the default path", async () => {
  const skill = await readFile(path.join("plugin", "skills", "cdx-claude", "SKILL.md"), "utf8");
  const openaiYaml = await readFile(path.join("plugin", "skills", "cdx-claude", "agents", "openai.yaml"), "utf8");
  const pluginJson = JSON.parse(await readFile(path.join("plugin", ".codex-plugin", "plugin.json"), "utf8")) as {
    interface?: { defaultPrompt?: string[] };
  };
  assert.match(skill, /Do not set or tune `max_budget_usd` proactively/);
  assert.match(skill, /Omit it unless the user explicitly requests/);
  assert.match(skill, /built-in default is `25`/);
  assert.match(skill, /do not start delegation while doctor reports red runtime checks/);
  assert.doesNotMatch(openaiYaml, /max_budget_usd|usage guard|budget/i);
  assert.ok(pluginJson.interface?.defaultPrompt?.every((prompt) => !prompt.includes("max_budget_usd")));
  assert.ok(pluginJson.interface?.defaultPrompt?.every((prompt) => !/usage guard|budget/i.test(prompt)));
});
