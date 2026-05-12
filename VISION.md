# cdx-claude Vision

`cdx-claude` gives Codex a narrow, inspectable delegation system for local Claude Code. Codex stays the authority owner. Claude is a servant delegate that returns evidence, progress, and optional isolated worktree patches for Codex to review, validate, and apply.

## Outcomes

- Codex starts Claude work without blocking the current turn.
- Codex lists jobs, inspects progress, reads results, fetches diffs, stops jobs, and cleans up worktrees through one MCP surface.
- Claude never edits the parent workspace directly.
- Work survives Codex MCP server restarts through a persistent local ledger under the operator's Codex home.
- Public users install one Codex plugin. The plugin carries its Claude delegate role catalogue and launches a pinned npm runtime.
- The plugin exposes a small Codex-owned MCP surface instead of forwarding raw `claude mcp serve` tools.

## Users

- Codex users who also run local Claude Code and want Claude as a non-blocking delegate.
- Codex sessions that need durable Claude work without rereading the original chat.
- Plugin authors who need a reference for cache-relative Codex plugin MCP packaging.

## Non-goals

- Replace Codex native subagents.
- Expose raw Claude Code MCP tools.
- Let Claude mutate the parent workspace directly.
- Claim redaction, data-loss prevention, or secret filtering beyond the data handling already performed by Codex, Claude Code, and the local machine.
- Claim cross-platform autonomous shell support before non-macOS sandbox proof exists.
