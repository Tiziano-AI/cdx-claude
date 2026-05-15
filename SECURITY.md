# Security

Report security issues privately through the GitHub security advisory flow for `Tiziano-AI/cdx-claude` when available. If advisories are unavailable, open a minimal issue that requests a private contact path without publishing exploit details.

## Boundary

`cdx-claude` is not a secret scanner or general DLP product. It coordinates local Codex, local Claude Code, local Git worktrees, and local ledger files. Public response projections redact configured auth secret values and product-owned worker identity, but raw ledger files, worker logs, prompts, Claude provider handling, and non-auth product data remain unredacted.

The authority boundary is:

- Codex starts, inspects, accepts, applies, validates, and reports work.
- Claude returns evidence, results, and optional isolated worktree diffs.
- Claude never receives direct write authority over the parent workspace.

Starting a delegate, running a sandbox canary, enabling web tools, selecting a custom model, or setting any non-default `max_budget_usd` value is an operator-authorized action. Codex must omit `max_budget_usd` unless the user explicitly requests a different guard. The MCP server enforces strict request schemas, role selection, `cwd` admission, mode permissions, worker identity, and cleanup denials; it does not add a separate interactive approval system on top of Codex and Claude.

`max_budget_usd` is an SDK usage-estimate stop guard. It is not an authoritative billing boundary, and Claude Max or Pro subscription usage is governed by the user's Claude account plan and provider-side limits.

`additional_directories` expands the local data boundary intentionally. It grants Claude read/search/list access to up to 8 normalized absolute existing context roots while write tools, diffs, and patch review remain confined to `execution_cwd` or the detached worktree. Additional directories are rejected when they contain control characters, overlap the declared `cwd`, overlap the execution root, nest in each other, resolve to denied home, state, control, or credential roots, or contain denied roots. Each root is fingerprinted at admission, and the worker fails closed before Claude execution if the stored path no longer resolves to the same non-symlink directory. The normalized paths appear in public job views and raw ledger files.

`patch_autonomous` uses Claude Code native sandboxing for Bash/subprocess containment with fail-closed startup. Built-in Claude file tools are controlled separately by the cdx-claude permission gate. A Git worktree is version-control isolation, not a security sandbox.

The sandbox canary checks denied parent-read behavior with a non-secret nonce, out-of-worktree `/tmp` read denial, out-of-worktree `/tmp` write denial, parent-repository write denial, additional-directory read allowance, additional-directory write denial, canary environment scrubbing with an injected non-secret environment nonce, and allowed worktree writes.
`claude_delegate_result` includes side-effect proof for canary jobs after they reach a terminal state. A valid canary has all expected markers in observed worker output, no parent probe file, no denied `/tmp` read nonce in returned event/result text, no denied `/tmp` probe file, an allowed worktree probe file, readable additional-directory nonce evidence in observed worker output, no additional-directory write probe file, an environment-boundary event proving the parent injected the nonce and the worker allowlist omitted it, no injected environment nonce in returned event/result text, no observed `CANARY_ENV_LEAK` worker output, and no cdx-claude worker identity material in the returned event/result text. Prompt text and assistant tool-command text are not canary marker evidence, but they remain part of nonce and worker-identity leak scans.

Job ledgers are shared local operator state. Any enabled Codex session that can call this plugin can inspect persisted cdx-claude jobs until cleanup removes them. Treat the ledger as local product data with explicit retention through `claude_delegate_cleanup`, not as per-thread confidential storage.

Plugin-launched API or cloud-provider credentials flow through `CDX_CLAUDE_AUTH_ENV_FILE`. That variable contains a local file path only. The runtime reads allowlisted auth rows from an absolute regular non-symlink file with mode `0600` after npm launches the package; unknown rows are rejected so auth typos fail closed. Credential values are passed to Claude Code/SDK execution and are redacted from cdx-claude public response projections if echoed, but they are not redacted from provider handling or raw local ledger/log artifacts.

## Supported v0.1.7 proof

`patch_autonomous` is supported on macOS after `claude_delegate_sandbox_canary` proves the current local runtime. Linux and Windows are experimental until direct release proof exists.
