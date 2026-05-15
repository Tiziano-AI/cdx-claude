# cdx-claude

`cdx-claude` is a Codex plugin and MCP server that lets Codex delegate bounded work to local Claude Code without blocking the current Codex turn.

Codex starts a job, receives a `job_id`, continues working, and later inspects status, event tails, results, and worktree diffs. Claude never edits the parent workspace directly.

## Install

Prerequisites:

- Codex with plugin marketplace support.
- Node.js 20 or newer.
- Node-compatible Claude Agent SDK runtime. The SDK bundled Claude Code executable is used unless `CDX_CLAUDE_CODE_EXECUTABLE` points at an explicit validated local executable.
- Anthropic-supported Claude Code or Claude Agent SDK authentication for the user running Codex.
- Git for patch modes.
- macOS for supported `patch_autonomous` sandbox proof in v0.1.6.

Install the public marketplace and plugin from GitHub after the release tag exists:

```bash
codex plugin marketplace add https://github.com/Tiziano-AI/cdx-claude.git --ref v0.1.6
```

The marketplace entry installs the `cdx-claude` plugin from the repository `plugin/` directory. The installed plugin launches a pinned npm runtime through `./bin/cdx-claude`, so first use downloads `cdx-claude@0.1.6` with npm tooling. Production Codex plugin use resolves the public npm package; `CDX_CLAUDE_NPM_SPEC` is only a release-candidate proof override for local tarballs.
If a previous `cdx-claude@local-personal` prototype is installed, disable or uninstall it before runtime proof. The active MCP row should resolve to the public Git marketplace cache, not `local-personal`.
After upgrading the marketplace ref, run `codex plugin marketplace upgrade cdx-claude` and verify `codex mcp get cdx-claude` points at the intended cache version. The skill path and active MCP row are separate runtime surfaces.

For installed plugin use with API or cloud-provider auth, put the Claude auth variables in a local dotenv file outside the repository and expose only the absolute file path to Codex:

```bash
cat > /absolute/path/to/private/cdx-claude.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Set the file mode to `0600`, then set `CDX_CLAUDE_AUTH_ENV_FILE=/absolute/path/to/private/cdx-claude.env` in the Codex environment that launches the plugin. The plugin launcher passes that path through npm; the runtime loads the allowlisted auth variables only after the npm launcher has started `cdx-claude`.

For CLI-only debugging against the public npm package:

```bash
cd /tmp
npx -y cdx-claude@0.1.6 --help
```

Run public npm smoke tests outside this repository so the same-name local package cannot shadow the public package. A pure `npx cdx-claude@<version> doctor` is diagnostic only because the npm package intentionally does not ship Codex plugin metadata; installed-runtime readiness is proven from the Codex plugin cache after marketplace upgrade.

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
- `patch_autonomous`: isolated git worktree edits plus Bash through Claude Code native sandboxing. v0.1.6 supports this mode on macOS after a fresh sandbox canary proof.

Every `claude_delegate_start` request requires an absolute git repository or worktree root `cwd` and an explicit `agent_role`. Call `claude_delegate_roles` first to list packaged roles. Jobs use no web tools unless `allow_web` is true. Use optional `additional_directories` when Claude needs to read disjoint context directories without changing the single execution/git root.
Starting jobs, running canaries, selecting a custom `model`, setting `allow_web: true`, or setting any non-default `max_budget_usd` value are operator-authorized actions. Codex should not set or tune `max_budget_usd` proactively, and should omit it unless the user explicitly requests a different Claude Agent SDK usage-estimate guard. Plugin default prompts intentionally avoid budget language; the skill and MCP schema only define the explicit-request-only override stance.

Minimal start payload:

```json
{
  "cwd": "/absolute/target/repo",
  "prompt": "Inspect the lifecycle contract and report risks.",
  "mode": "research",
  "agent_role": "workflow_ledger",
  "allow_web": false
}
```

Authorized extra-root payload:

```json
{
  "cwd": "/absolute/target/repo",
  "additional_directories": ["/absolute/context/repo"],
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

The ledger is a local operator data store, not a private per-thread vault. Any enabled Codex session that can call the `cdx-claude` MCP tools can list jobs and inspect prior cdx-claude prompts, event tails, results, diffs, and logs until those ledgers are cleaned up. Use `claude_delegate_cleanup` after accepting or rejecting a job when prior job material should not remain visible to future Codex sessions.

`claude_delegate_stop` records `stopping`, aborts the detached worker's SDK query, and lets the worker or stale recovery write terminal `stopped` or `stale`. Cleanup is denied while a job is `starting`, `running`, or `stopping`.

`cdx-claude` is not a general safety or DLP layer; data moves between Codex, local Claude Code, and local ledger files. Public job, tail, result, diff, and canary responses redact configured auth secret values if Claude echoes them, plus product-owned worker identity. Raw ledger files, worker logs, prompts, Claude provider handling, and non-auth product data remain unredacted.

`max_budget_usd` maps to the Claude Agent SDK `maxBudgetUsd` API-equivalent usage-estimate stop guard. It is not an Anthropic Console billing claim and is not subscription spend for Claude Max or Pro users. If omitted, `cdx-claude` sets `max_budget_usd` to `25`; values above `100` are rejected. The MCP schema does not publish `25` as a schema default because model callers should not fill this field unless the user explicitly asks for a different guard. Claude Code and the Claude Agent SDK own authentication, model access, provider data handling, and provider-side limits. `cdx-claude` does not broker Claude.ai login or credentials.

`claude_delegate_doctor` resolves runtime materialization, Node, Claude Code policy, auth-env status, plugin metadata, the ledger, packaged roles, and sandbox readiness from the active runtime. Node is PATH-first and ignores stale `CDX_CLAUDE_NODE_EXECUTABLE` values for executable selection, but a present retired override keeps runtime materialization red until it is removed. Claude uses the SDK bundled executable unless `CDX_CLAUDE_CODE_EXECUTABLE` is explicitly configured and valid. The doctor must report `data.ok: true` with matching package, plugin manifest, exact public marketplace cache root, and process identity before delegation starts.

`cwd` must be a git project or worktree root. `cdx-claude` denies filesystem root, home, cdx-claude state, Codex state, broad user-control directories, common home credential roots, and system credential/control roots such as `/etc`, `/private/etc`, `/var/db`, `/private/var/db`, `/var/log`, `/private/var/log`, `/Library`, and `/System` before creating a ledger or worker.

`additional_directories` is a read-only context list with up to 8 entries. Entries must be absolute existing directories without control characters and are stored after realpath normalization with per-root filesystem identity fingerprints. They may be non-git directories, but cannot overlap the declared `cwd`, overlap the execution root, nest in each other, point at denied home or system control/credential roots, or contain denied home or system control/credential roots. The worker fails closed if a stored extra root changes identity before Claude execution. They are exposed in public job views as operator-visible scope because cdx-claude is not a DLP layer. Writes and diffs stay confined to `execution_cwd` or the detached worktree.

## Development

```bash
pnpm install
pnpm verify
uv run devtools/gate.py
git diff --check
pnpm release:preflight
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
CDX_CLAUDE_NPM_SPEC=/tmp/cdx-claude-pack/cdx-claude-0.1.6.tgz plugin/bin/cdx-claude --help
```

Run MCP tools, schema, and source/tarball behavior proof with isolated temporary state and no private auth env file:

```bash
CDX_CLAUDE_NPM_SPEC=/tmp/cdx-claude-pack/cdx-claude-0.1.6.tgz pnpm mcp:tools-proof
```

Unset `CDX_CLAUDE_NPM_SPEC` for production installed-plugin proof after npm publish. The final public runtime proof must exercise the npm package selected by `plugin/bin/cdx-claude`, not a local tarball override.

After the model-visible `claude_delegate_doctor` is green, save its redacted JSON envelope and rerun `pnpm release:preflight` with `CDX_CLAUDE_MODEL_VISIBLE_DOCTOR_RECEIPT=/path/to/model-visible-doctor.json` to make the final receipt include that proof.

## Release

See `RELEASE.md`. The first public release requires all of:

- `pnpm verify`
- `uv run devtools/gate.py`
- `pnpm release:preflight`
- local tarball plugin launcher `--help`
- source/tarball MCP tools, schema, and behavior proof
- installed-cache MCP tools/schema proof after publish and marketplace upgrade
- Codex marketplace install from a Git tag
- one macOS local Claude sandbox canary after explicit live-run authorization
