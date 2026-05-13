# Changelog

## 0.1.3

- Resolves Node from the current executable search path before falling back to `process.execPath`, so long-lived MCP sessions do not retain stale Homebrew Cellar paths.
- Validates plugin metadata against the current plugin release version and ignores stale inherited plugin-root projections when the active launcher `cwd` or packaged plugin is current.
- Projects the resolved Node executable and current plugin root into detached workers.

## 0.1.2

- Raises the default Claude Agent SDK usage-estimate guard to `25`.
- Keeps `max_budget_usd` as an explicit user-requested override instead of model-side tuning.
- Removes budget language from default model prompts while keeping explicit-request-only schema and skill guidance.
- Updates the Claude Agent SDK runtime dependency to `0.2.139`.

## 0.1.0

Initial public release candidate.

- Codex plugin with cache-relative MCP launcher.
- npm runtime package with one public `cdx-claude` binary.
- Non-blocking Claude delegation through persistent local ledgers.
- Packaged delegate role catalogue.
- Read-only, isolated patch, and macOS sandboxed autonomous patch modes.
