---
name: cdx-claude
description: Use when Codex should delegate bounded research or patch work to local Claude Code without blocking, then inspect job status, event tails, results, and worktree diffs before applying anything.
---

# CDX Claude

Use this skill when Codex needs Claude Code as a servant delegate.

## Contract

- Codex remains the authority owner.
- Start delegates with `claude_delegate_start`; do not call raw `claude mcp serve` tools as the product path.
- Choose an explicit `agent_role` from `claude_delegate_roles` for every start request.
- Use `research` for read-only investigation.
- Use `patch` for isolated worktree edits.
- Use `patch_autonomous` only after `claude_delegate_sandbox_canary` proves the local Claude Code native sandbox.
- Inspect with `claude_delegate_status`, `claude_delegate_tail`, `claude_delegate_result`, and `claude_delegate_diff`.
- Apply no patch until Codex has read the diff and validated it.
- Treat canary proof as side-effect proof from `claude_delegate_result`, not marker text alone.
- Treat `claude_delegate_start`, `claude_delegate_sandbox_canary`, `allow_web: true`, custom `model`, and any non-default `max_budget_usd` value as actions requiring explicit user authorization in the current task.
- Do not set or tune `max_budget_usd` proactively. Omit it unless the user explicitly requests a different Claude Agent SDK usage-estimate stop guard. The built-in default is `25`, maps to SDK `maxBudgetUsd`, and is an API-equivalent estimate guard, not a subscription billing claim.
- Treat the ledger as shared local operator state: any enabled Codex session can inspect prior cdx-claude jobs until cleanup removes them.

## Required start payload

Always pass an absolute `cwd` for the target repository or workspace:

```json
{
  "cwd": "/absolute/target/repo",
  "prompt": "Concrete delegated task.",
  "mode": "research",
  "agent_role": "evidence_cartographer",
  "allow_web": false
}
```

## Data movement

`cdx-claude` does not redact prompts, logs, events, diffs, or results. It moves product data between Codex, local Claude Code, and the local ledger.
The raw cdx-claude worker token is private control material and is not persisted or returned.
For installed plugin auth, configure `CDX_CLAUDE_AUTH_ENV_FILE` to point at a local Claude auth dotenv file instead of passing auth secrets through the plugin launcher environment.
`CDX_CLAUDE_NPM_SPEC` is a release-candidate tarball proof override only. Do not set it for production installed-plugin proof after npm publish.

## Cleanup

Use `claude_delegate_cleanup` after Codex has exported or rejected a patch. Cleanup refuses active jobs and refuses dirty terminal worktrees unless `force` is explicitly set.
