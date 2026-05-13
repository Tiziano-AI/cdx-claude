# Security

Report security issues privately through the GitHub security advisory flow for `Tiziano-AI/cdx-claude` when available. If advisories are unavailable, open a minimal issue that requests a private contact path without publishing exploit details.

## Boundary

`cdx-claude` is not a secret scanner, redaction layer, or DLP product. It coordinates local Codex, local Claude Code, local Git worktrees, and local ledger files.

The authority boundary is:

- Codex starts, inspects, accepts, applies, validates, and reports work.
- Claude returns evidence, results, and optional isolated worktree diffs.
- Claude never receives direct write authority over the parent workspace.

Starting a delegate, running a sandbox canary, enabling web tools, selecting a custom model, or setting any non-default `max_budget_usd` value is an operator-authorized action. Codex must omit `max_budget_usd` unless the user explicitly requests a different guard. The MCP server enforces strict request schemas, role selection, `cwd` admission, mode permissions, worker identity, and cleanup denials; it does not add a separate interactive approval system on top of Codex and Claude.

`max_budget_usd` is an SDK usage-estimate stop guard. It is not an authoritative billing boundary, and Claude Max or Pro subscription usage is governed by the user's Claude account plan and provider-side limits.

`patch_autonomous` uses Claude Code native sandboxing for Bash/subprocess containment with fail-closed startup. Built-in Claude file tools are controlled separately by the cdx-claude permission gate. A Git worktree is version-control isolation, not a security sandbox.

The sandbox canary checks denied parent-read behavior with a non-secret nonce, out-of-worktree `/tmp` write denial, parent-repository write denial, canary environment scrubbing, and allowed worktree writes.
`claude_delegate_result` includes side-effect proof for canary jobs after they reach a terminal state. A valid canary has all expected markers, no parent probe file, no denied `/tmp` probe file, an allowed worktree probe file, and no cdx-claude worker identity material in the returned event/result text.

Job ledgers are shared local operator state. Any enabled Codex session that can call this plugin can inspect persisted cdx-claude jobs until cleanup removes them. Treat the ledger as local product data with explicit retention through `claude_delegate_cleanup`, not as per-thread confidential storage.

Plugin-launched API or cloud-provider credentials flow through `CDX_CLAUDE_AUTH_ENV_FILE`. That variable contains a local file path only. The runtime reads allowlisted auth rows from the file after npm launches the package; unknown rows are rejected so auth typos fail closed. Credential values are passed to Claude Code/SDK execution and are not product-redacted from provider handling by cdx-claude.

## Supported v0.1.2 proof

`patch_autonomous` is supported on macOS after `claude_delegate_sandbox_canary` proves the current local runtime. Linux and Windows are experimental until direct release proof exists.
