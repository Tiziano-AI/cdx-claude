# Changelog

## 0.1.8

- Restricts the sandbox canary `CANARY_ENV_LEAK` failure marker to raw tool-result content so negated final prose does not falsely fail a canary whose environment nonce stays scrubbed.
- Keeps secret and nonce leak detection fail-closed across all public result and event text.

## 0.1.7

- Corrects the first canary verifier false positive by excluding prompt and assistant tool-command text from marker evidence while preserving nonce and worker-identity leak scans.

## 0.1.6

- Adds optional `additional_directories` as normalized, bounded, read-only Claude context roots while keeping `cwd` singular as the execution, git, and worktree authority.
- Carries additional-directory scope through request admission, MCP schema, job projections, permission gates, Claude SDK options, autonomous sandbox read/write lists, docs, and proof scripts.
- Extends sandbox canary proof with additional-directory read allowance and write denial evidence.

## 0.1.5

- Makes `pnpm release:preflight` post-publish aware: once the exact package version exists on npm, the immutable registry identity satisfies the required package-publication row instead of rerunning `npm publish --dry-run` against an already-published version.

## 0.1.4

- Adds runtime materialization to doctor so source version, npm package version, plugin manifest version, installed cache root, process identity, Node policy, Claude executable policy, auth-env status, and remediation are reported from one canonical context.
- Makes the Claude Agent SDK bundled executable the default and treats `CDX_CLAUDE_CODE_EXECUTABLE` as an explicit validated override.
- Retires `CDX_CLAUDE_NODE_EXECUTABLE` as a launcher/runtime override; Node is resolved from the current executable search path before falling back to the running process executable.
- Adds strict `CDX_CLAUDE_AUTH_ENV_FILE` validation with key-name-only doctor output, mode `0600` enforcement, broad-dotenv rejection, and pre-ledger delegation denial for invalid configured auth files.
- Adds `pnpm release:preflight` for redacted release receipts covering source gates, version identity, tarball proof, MCP tools/schema, doctor proof, registry/install observations, and pending model-visible proof rows.
- Updates the skill to require a green model-visible doctor with matching runtime/plugin versions before delegation starts.

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
