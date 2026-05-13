# cdx-claude Agent Guide

## Role and authority

`cdx-claude` lets Codex delegate bounded work to local Claude Code. Codex remains the authority owner: it starts jobs, inspects status, reads results and diffs, decides whether work is accepted, and applies any changes outside the delegated worktree.

Treat Claude output as evidence or a candidate patch, not as accepted source truth.

## Runtime truth layers

Keep these layers separate when diagnosing, releasing, or reporting status:

- source repo: this checkout under `/Users/tiziano/Code/cdx-claude`;
- npm runtime package: `cdx-claude@<version>`;
- Git release identity: pushed commit plus tag `v<version>`;
- marketplace source: `.agents/plugins/marketplace.json` and Codex marketplace config;
- installed plugin cache: `~/.codex/plugins/cache/cdx-claude/cdx-claude/<version>/`;
- active MCP row: `codex mcp get cdx-claude`.

Do not claim a release or runtime update from source, npm, or tag evidence alone. The active MCP row must point at the intended installed cache version.

## Development commands

Use `pnpm` for all JavaScript and TypeScript work.

Canonical gates:

```bash
pnpm verify
uv run devtools/gate.py
```

Use `pnpm release:dry-run` for npm package preflight. Use `git diff --check` before committing.

## Release proof

One release identity spans `package.json`, `plugin/.codex-plugin/plugin.json`, `plugin/bin/cdx-claude`, `.agents/plugins/marketplace.json`, the npm package, and the Git tag.

`CDX_CLAUDE_NPM_SPEC` is only for release-candidate tarball proof. Unset it for public installed-runtime proof after npm publish so the plugin launcher resolves the pinned public npm package.

When testing public npm resolution, do not run `npx cdx-claude@<version>` from this repo root because the same-name local package can shadow the public package. Run public npm smoke from `/tmp` or from the installed plugin cache.

For installed runtime proof, verify all of:

- `npm view cdx-claude@<version> version --json`;
- `codex plugin marketplace upgrade cdx-claude` after changing the configured ref;
- `codex mcp get cdx-claude` points at `~/.codex/plugins/cache/cdx-claude/cdx-claude/<version>/`;
- installed launcher help with `CDX_CLAUDE_NPM_SPEC` unset;
- installed MCP `tools/list`;
- installed MCP schema for `claude_delegate_start` and `claude_delegate_sandbox_canary`;
- installed `doctor`;
- macOS sandbox canary result and side-effect proof when release scope touches autonomous mode.

Do not use `cdx-claude@local-personal` cache as public runtime proof.

## Budget and usage guard stance

`max_budget_usd` maps to the Claude Agent SDK `maxBudgetUsd` API-equivalent usage-estimate stop guard. It is not an Anthropic Console billing boundary and is not subscription spend for Claude Max or Pro users.

The default guard is `25`, the maximum is `100`, and the MCP schema intentionally does not publish a numeric schema default. Model-facing prompts must not tell Codex to tune this field. Codex must omit `max_budget_usd` unless the user explicitly requests a different guard.

## Local state and secrets

Keep `.codex/` and `.claude/` ignored and private. Do not stage local runtime state, local Claude state, plugin caches, npm caches, ledgers, auth material, or generated scratch proof directories.

Installed plugin auth uses `CDX_CLAUDE_AUTH_ENV_FILE`, which is a path to a private local dotenv file. Do not commit credentials or secret-slice instructions.

`cdx-claude` does not redact prompts, logs, events, diffs, or results. Treat job ledgers as shared local operator data and clean them with `claude_delegate_cleanup` after accepting or rejecting a job.
