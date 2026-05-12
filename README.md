# cdx-claude

`cdx-claude` is a Codex plugin and MCP server that lets Codex delegate bounded work to local Claude Code without blocking the current Codex turn.

Codex starts a job, receives a `job_id`, continues working, and later inspects status, event tails, results, and worktree diffs. Claude never edits the parent workspace directly.

## Install

Prerequisites:

- Codex with plugin marketplace support.
- Node.js 20 or newer.
- Node-compatible Claude Agent SDK runtime. The SDK bundled Claude Code executable is used when no local `claude` executable or `CDX_CLAUDE_CODE_EXECUTABLE` override is found.
- Anthropic-supported Claude Code or Claude Agent SDK authentication for the user running Codex.
- Git for patch modes.
- macOS for supported `patch_autonomous` sandbox proof in v0.1.0.

Install the public marketplace and plugin from GitHub after the release tag exists:

```bash
codex plugin marketplace add Tiziano-AI/cdx-claude --ref v0.1.0
```

The marketplace entry installs the `cdx-claude` plugin from the repository `plugin/` directory. The installed plugin launches a pinned npm runtime through `./bin/cdx-claude`, so first use may download `cdx-claude@0.1.0` with npm tooling.

For installed plugin use with API or cloud-provider auth, put the Claude auth variables in a local dotenv file and expose only the file path to Codex:

```bash
cat > ~/.secrets/cdx-claude.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Then set `CDX_CLAUDE_AUTH_ENV_FILE=/Users/you/.secrets/cdx-claude.env` in the Codex environment that launches the plugin. The plugin launcher passes that path through npm; the runtime loads the allowlisted auth variables only after the npm launcher has started `cdx-claude`.

For CLI-only debugging after npm publish:

```bash
npx -y cdx-claude@0.1.0 --help
npx -y cdx-claude@0.1.0 doctor
```

## MCP tools

- `claude_delegate_start`
- `claude_delegate_roles`
- `claude_delegate_list`
- `claude_delegate_status`
- `claude_delegate_tail`
- `claude_delegate_result`
- `claude_delegate_diff`
- `claude_delegate_stop`
- `claude_delegate_cleanup`
- `claude_delegate_sandbox_canary`
- `claude_delegate_doctor`

## Job modes

- `research`: read-only Claude research inside the target root.
- `patch`: isolated git worktree edits, no shell.
- `patch_autonomous`: isolated git worktree edits plus Bash through Claude Code native sandboxing. v0.1.0 supports this mode on macOS after a fresh sandbox canary proof.

Every `claude_delegate_start` request requires an absolute `cwd` and an explicit `agent_role`. Call `claude_delegate_roles` first to list packaged roles. Jobs use no web tools unless `allow_web` is true.

Example start payload:

```json
{
  "cwd": "/absolute/target/repo",
  "prompt": "Inspect the lifecycle contract and report risks.",
  "mode": "research",
  "agent_role": "workflow_ledger",
  "allow_web": false
}
```

## Runtime state

Job state lives under the operator's Codex home by default:

```text
~/.codex/cdx-claude/jobs/<job_id>/
~/.codex/cdx-claude/worktrees/<job_id>/
```

Each job writes `job.json`, `events.jsonl`, `result.md`, optional `diff.patch`, logs, and `receipt.json`.
Public status, list, result, diff, and canary responses omit the internal worker identity hash and full appended role prompt. Public event tails strip cdx-claude worker control identity keys such as `pid`, `worker_pid`, `worker_token`, and `worker_token_hash`. The raw worker token is passed only through the private worker environment and is not persisted.

`claude_delegate_stop` records `stopping`, aborts the detached worker's SDK query, and lets the worker or stale recovery write terminal `stopped` or `stale`. Cleanup is denied while a job is `starting`, `running`, or `stopping`.

`cdx-claude` does not redact prompts, logs, events, diffs, or results. It is not a safety or DLP layer; data moves between Codex, local Claude Code, and local ledger files.

`max_budget_usd` is a Claude Agent SDK cost-estimate guard, not a billing claim. If omitted, `cdx-claude` sets `max_budget_usd` to `1`; values above `100` are rejected. Claude Code and the Claude Agent SDK own authentication, model access, provider data handling, and provider-side limits. `cdx-claude` does not broker Claude.ai login or credentials.

`cwd` must be a git project or worktree root. `cdx-claude` denies filesystem root, home, cdx-claude state, Codex state, broad user-control directories, and common credential roots before creating a ledger or worker.

## Development

```bash
pnpm install
pnpm verify
uv run devtools/gate.py
```

Refresh the embedded role snapshot from an installed upstream `cdx-agents` development environment:

```bash
pnpm roles:sync
```

Build the plugin launcher and runtime:

```bash
pnpm build
```

Create a local npm tarball for plugin-launcher proof before publishing:

```bash
pnpm pack --pack-destination /tmp/cdx-claude-pack
CDX_CLAUDE_NPM_SPEC=/tmp/cdx-claude-pack/cdx-claude-0.1.0.tgz plugin/bin/cdx-claude --help
```

Run a direct MCP tool-list proof through the plugin launcher:

```bash
CDX_CLAUDE_NPM_SPEC=/tmp/cdx-claude-pack/cdx-claude-0.1.0.tgz pnpm mcp:tools-proof
```

## Release

See `RELEASE.md`. The first public release requires all of:

- `pnpm verify`
- `uv run devtools/gate.py`
- `npm publish --dry-run`
- local tarball plugin launcher `--help`
- direct plugin launcher MCP `tools/list`
- Codex marketplace install from a Git tag
- one macOS local Claude sandbox canary after explicit live-run authorization
