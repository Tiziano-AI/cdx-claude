# Release

The release identity is one semver value shared by `package.json`, `plugin/.codex-plugin/plugin.json`, the plugin launcher npm spec, the marketplace ref, npm publish, and the Git tag.

## Preflight

```bash
pnpm install
pnpm verify
uv run devtools/gate.py
npm publish --dry-run
```

Create a local tarball and prove the plugin launcher uses it:

```bash
PACK_DIR=$(mktemp -d)
pnpm pack --pack-destination "$PACK_DIR"
CDX_CLAUDE_NPM_SPEC="$PACK_DIR/cdx-claude-0.1.3.tgz" plugin/bin/cdx-claude --help
```

Run direct MCP `tools/list` through `plugin/bin/cdx-claude mcp serve` with `CDX_CLAUDE_NPM_SPEC` pointing at the local tarball and assert only the wrapper tools are present.

```bash
CDX_CLAUDE_NPM_SPEC="$TARBALL" pnpm mcp:tools-proof
```

Run `doctor` through the same tarball. In npm-runtime-only mode, the plugin check can report `ok:false` when plugin metadata is unavailable, but the command returns a structured success envelope with `data.ok:false` instead of an internal error.

```bash
CDX_CLAUDE_NPM_SPEC="$TARBALL" plugin/bin/cdx-claude doctor
```

`CDX_CLAUDE_NPM_SPEC` is release-candidate proof only. Unset it for the final installed Codex proof after npm publish so the launcher resolves the public npm package selected by its pinned version.

## GitHub

Push `main` and tag `v0.1.3` only after preflight passes.

```bash
gh repo create Tiziano-AI/cdx-claude --public --source . --remote origin --push
git tag v0.1.3
git push origin v0.1.3
```

## npm

The npm package name is `cdx-claude`.

```bash
npm login
npm publish --access public
npx -y cdx-claude@0.1.3 --help
```

If `cdx-claude` is unavailable at publish time, stop and choose a new package name before changing the plugin launcher.

## Codex install proof

```bash
codex plugin marketplace add Tiziano-AI/cdx-claude --ref v0.1.3
codex mcp get cdx-claude
```

Then run direct installed-cache MCP `tools/list` and one macOS `claude_delegate_sandbox_canary` live proof.
The active MCP row must resolve to `~/.codex/plugins/cache/cdx-claude/cdx-claude/0.1.3/`. Any older `cdx-claude@local-personal` install is legacy inventory and must be disabled or uninstalled through Codex plugin controls before claiming public runtime proof.

The installed-cache proof has two distinct phases:

- release-candidate proof: run the installed cache launcher with `CDX_CLAUDE_NPM_SPEC` pointing at the local tarball before npm publish;
- public-runtime proof: after npm publish, run `npx -y cdx-claude@0.1.3 --help`, installed-cache MCP `tools/list`, `doctor`, and the sandbox canary with `CDX_CLAUDE_NPM_SPEC` unset.
