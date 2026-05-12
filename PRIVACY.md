# Privacy

`cdx-claude` is a local Codex plugin and CLI. It does not operate a hosted service and does not add a telemetry pipeline.

The product sends prompts and tool traffic to the local Claude Code runtime through the Anthropic Claude Agent SDK. Claude Code and the Claude Agent SDK handle authentication, model access, and any provider-side data handling under Anthropic's terms and settings for the user's Claude Code installation.

When the installed plugin needs API or cloud-provider authentication, `CDX_CLAUDE_AUTH_ENV_FILE` points at a local dotenv file. The plugin launcher passes only that path through npm. The runtime loads allowlisted Claude/Anthropic, Bedrock, Vertex, Foundry, certificate, and proxy variables from the file before invoking Claude and rejects unknown keys. cdx-claude does not write those auth values to job ledgers or doctor output.

`cdx-claude` writes local job ledgers under `~/.codex/cdx-claude` by default. These ledgers can contain prompts, Claude messages, command output, diffs, logs, and result files. The product does not redact this data.
Any enabled Codex session with access to the `cdx-claude` MCP tools can inspect prior jobs in that local ledger until the operator removes them. Cleanup is the retention control for job material that should not remain visible to later Codex sessions.

The plugin launcher may invoke npm tooling to run the pinned `cdx-claude` runtime package. npm may perform normal package-resolution network requests.
The launcher passes an allowlisted environment to npm instead of the full Codex MCP process environment.
