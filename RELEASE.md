# Release

The release identity is one semver value shared by `package.json`, `plugin/.codex-plugin/plugin.json`, the plugin launcher npm spec, `.agents/plugins/marketplace.json`, npm publish, the Git tag, the installed plugin cache, and the model-visible MCP doctor.

## Preflight

Run the canonical source and candidate proof before publishing:

```bash
pnpm install
pnpm verify
uv run devtools/gate.py
git diff --check
pnpm release:preflight
```

`pnpm release:preflight` emits a redacted JSON receipt. It proves source gates, version alignment, pre-publish npm dry-run packaging or already-published npm registry identity, a `pnpm pack` tarball fingerprint, tarball launcher help, source/tarball MCP tools/schema/behavior proof, and tarball doctor. It also records npm registry identity, the active Codex MCP row, installed-cache launcher/schema/doctor state when that cache exists, and the model-visible MCP doctor row. A zero exit proves `source_candidate_ok`, not final release completion. Missing post-publish surfaces are reported as pending until `public_installed_complete` is true.

`CDX_CLAUDE_NPM_SPEC` is release-candidate proof only. Unset it for final installed Codex proof after npm publish so the launcher resolves the public npm package selected by its pinned version.

## GitHub

Push `main` and tag `v0.1.8` only after preflight passes.

```bash
git tag v0.1.8
git push origin main
git push origin v0.1.8
```

## npm

The npm package name is `cdx-claude`.

```bash
npm publish --access public
cd /tmp
npx -y cdx-claude@0.1.8 --help
```

Run public npm smoke tests outside this repository so the same-name local package cannot shadow the public package. Pure npm `doctor` is diagnostic, not installed-plugin readiness proof, because the npm package intentionally does not ship Codex plugin metadata.

## Codex install proof

Use one marketplace source identity. This repository uses the Git URL source:

```bash
codex plugin marketplace add https://github.com/Tiziano-AI/cdx-claude.git --ref v0.1.8
codex plugin marketplace upgrade cdx-claude
codex mcp get cdx-claude
```

The active MCP row must resolve exactly to `~/.codex/plugins/cache/cdx-claude/cdx-claude/0.1.8/`. A same-version `local-personal/.../cdx-claude/0.1.8/` cache is not public runtime proof. Any older `cdx-claude@local-personal` install is legacy inventory and must stay disabled or be removed through Codex plugin controls before claiming public runtime proof.

Final public-runtime proof has `CDX_CLAUDE_NPM_SPEC` unset and includes:

```bash
unset CDX_CLAUDE_NPM_SPEC
pnpm release:preflight
codex mcp get cdx-claude
~/.codex/plugins/cache/cdx-claude/cdx-claude/0.1.8/bin/cdx-claude --help
~/.codex/plugins/cache/cdx-claude/cdx-claude/0.1.8/bin/cdx-claude doctor
node scripts/assert-mcp-tools.mjs ~/.codex/plugins/cache/cdx-claude/cdx-claude/0.1.8/bin/cdx-claude ~/.codex/plugins/cache/cdx-claude/cdx-claude/0.1.8
```

The direct installed-cache `assert-mcp-tools.mjs` command proves installed tools and schema. Source and tarball `pnpm mcp:tools-proof` additionally run fake-driver behavior checks with private auth env/file variables scrubbed from the proof runtime.

Then run the model-visible `claude_delegate_doctor`. It must report the current runtime version, installed plugin root, auth-env status, Node policy, Claude executable policy, and `data.ok: true`. A macOS `claude_delegate_sandbox_canary` is required only when autonomous sandbox behavior changes.

To fold model-visible proof into the release receipt, save the redacted `claude_delegate_doctor` JSON envelope and rerun:

```bash
CDX_CLAUDE_MODEL_VISIBLE_DOCTOR_RECEIPT=/path/to/model-visible-doctor.json pnpm release:preflight
```

## Rollback

Rollback uses immutable release identities. Repoint the marketplace ref to the last known-good tag, run `codex plugin marketplace upgrade cdx-claude`, verify `codex mcp get cdx-claude`, run direct installed-cache doctor, then run the model-visible doctor. Do not rewrite Git tags or unpublish npm packages as rollback.
