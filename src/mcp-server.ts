#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CleanupRequestSchema,
  EmptyRequestSchema,
  JobIdRequestSchema,
  ListRequestSchema,
  SandboxCanaryRequestSchema,
  StartRequestSchema,
  TailRequestSchema
} from "./contracts.js";
import { failureEnvelope, successEnvelope } from "./envelope.js";
import { UserVisibleError } from "./errors.js";
import {
  cleanupDelegation,
  diffDelegation,
  doctor,
  listDelegations,
  listRoles,
  resultDelegation,
  sandboxCanary,
  startJob,
  statusJob,
  stopDelegation,
  tailDelegation
} from "./service.js";

const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false
};

const JOB_ID_INPUT_SCHEMA = {
  type: "object",
  required: ["job_id"],
  properties: {
    job_id: { type: "string", pattern: "^claude-\\d{8}-\\d{9}-[0-9a-f]{8}$" }
  },
  additionalProperties: false
};

const ENVELOPE_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [
    {
      type: "object",
      required: ["ok", "data", "meta"],
      properties: {
        ok: { const: true },
        data: {},
        meta: metaSchema()
      },
      additionalProperties: false
    },
    {
      type: "object",
      required: ["ok", "error", "meta"],
      properties: {
        ok: { const: false },
        error: errorSchema(),
        meta: metaSchema()
      },
      additionalProperties: false
    }
  ]
};

type ToolInput = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: ToolInput) => Promise<unknown>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "claude_delegate_roles",
    title: "Claude Delegate Roles",
    description: "List packaged delegate roles available for Claude prompt selection.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    run: async (input) => {
      EmptyRequestSchema.parse(input);
      return listRoles();
    }
  },
  {
    name: "claude_delegate_start",
    title: "Start Claude Delegate",
    description: "Start a non-blocking local Claude delegation job and return a job id.",
    inputSchema: {
      type: "object",
      required: ["cwd", "prompt", "mode", "agent_role"],
      properties: {
        cwd: { type: "string" },
        prompt: { type: "string" },
        mode: { enum: ["research", "patch", "patch_autonomous"] },
        agent_role: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        allow_web: { type: "boolean" },
        title: { type: "string" },
        model: { type: "string" },
        max_budget_usd: { type: "number", exclusiveMinimum: 0, maximum: 100 }
      },
      additionalProperties: false
    },
    run: async (input) => startJob(StartRequestSchema.parse(input))
  },
  {
    name: "claude_delegate_list",
    title: "List Claude Delegates",
    description: "List persistent Claude delegation jobs.",
    inputSchema: {
      type: "object",
      properties: {
        status: { enum: ["starting", "running", "stopping", "completed", "failed", "stopped", "stale"] },
        limit: { type: "integer", minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    run: async (input) => {
      const request = ListRequestSchema.parse(input);
      return listDelegations(request.limit, request.status);
    }
  },
  {
    name: "claude_delegate_status",
    title: "Claude Delegate Status",
    description: "Inspect one Claude delegation job.",
    inputSchema: JOB_ID_INPUT_SCHEMA,
    run: async (input) => {
      const request = JobIdRequestSchema.parse(input);
      return statusJob(request.job_id);
    }
  },
  {
    name: "claude_delegate_tail",
    title: "Claude Delegate Tail",
    description: "Read recent event rows for a Claude delegation job.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string", pattern: "^claude-\\d{8}-\\d{9}-[0-9a-f]{8}$" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        after_seq: { type: "integer", minimum: 0 }
      },
      additionalProperties: false
    },
    run: async (input) => {
      const request = TailRequestSchema.parse(input);
      return tailDelegation(request.job_id, request.limit, request.after_seq);
    }
  },
  {
    name: "claude_delegate_result",
    title: "Claude Delegate Result",
    description: "Read the final result artifact and receipt for a Claude delegation job.",
    inputSchema: JOB_ID_INPUT_SCHEMA,
    run: async (input) => {
      const request = JobIdRequestSchema.parse(input);
      return resultDelegation(request.job_id);
    }
  },
  {
    name: "claude_delegate_diff",
    title: "Claude Delegate Diff",
    description: "Refresh and read a worktree diff for a patch-mode Claude delegation job.",
    inputSchema: JOB_ID_INPUT_SCHEMA,
    run: async (input) => {
      const request = JobIdRequestSchema.parse(input);
      return diffDelegation(request.job_id);
    }
  },
  {
    name: "claude_delegate_stop",
    title: "Stop Claude Delegate",
    description: "Stop a running Claude delegation worker.",
    inputSchema: JOB_ID_INPUT_SCHEMA,
    run: async (input) => {
      const request = JobIdRequestSchema.parse(input);
      return stopDelegation(request.job_id);
    }
  },
  {
    name: "claude_delegate_cleanup",
    title: "Cleanup Claude Delegate",
    description: "Remove an exported worktree and optionally its ledger.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string", pattern: "^claude-\\d{8}-\\d{9}-[0-9a-f]{8}$" },
        force: { type: "boolean" },
        remove_ledger: { type: "boolean" }
      },
      additionalProperties: false
    },
    run: async (input) => cleanupDelegation(CleanupRequestSchema.parse(input))
  },
  {
    name: "claude_delegate_sandbox_canary",
    title: "Claude Delegate Sandbox Canary",
    description: "Start a patch_autonomous Claude sandbox canary job and return proof markers to inspect.",
    inputSchema: {
      type: "object",
      required: ["agent_role"],
      properties: {
        agent_role: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        model: { type: "string" },
        max_budget_usd: { type: "number", exclusiveMinimum: 0, maximum: 100 }
      },
      additionalProperties: false
    },
    run: async (input) => sandboxCanary(SandboxCanaryRequestSchema.parse(input))
  },
  {
    name: "claude_delegate_doctor",
    title: "Claude Delegate Doctor",
    description: "Report local Claude, plugin, ledger, packaged roles, and sandbox readiness.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    run: async (input) => {
      EmptyRequestSchema.parse(input);
      return doctor();
    }
  }
];

/** Starts the cdx-claude MCP wrapper server on stdio. */
export async function serveMcp(): Promise<void> {
  const server = new Server(
    {
      name: "cdx-claude",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map(toMcpTool)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return renderEnvelope(failureEnvelope(request.params.name, new UserVisibleError(`unknown tool: ${request.params.name}`, {
        code: "unknown_tool",
        recoverable: false
      })));
    }
    const input = request.params.arguments ?? {};
    return mcpEnvelope(tool.name, async () => tool.run(input));
  });

  await server.connect(new StdioServerTransport());
}

async function mcpEnvelope(command: string, action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return renderEnvelope(successEnvelope(command, await action()));
  } catch (error) {
    return renderEnvelope(failureEnvelope(command, normalizeMcpError(error)));
  }
}

function normalizeMcpError(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return new UserVisibleError(z.prettifyError(error), {
      code: "invalid_input",
      recoverable: true
    });
  }
  return error;
}

function renderEnvelope(envelope: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(envelope, null, 2)
      }
    ],
    structuredContent: envelope as { [x: string]: unknown }
  };
}

function toMcpTool(definition: ToolDefinition): Tool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema as Tool["inputSchema"],
    outputSchema: ENVELOPE_OUTPUT_SCHEMA as Tool["outputSchema"]
  };
}

function metaSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["schema_version", "command", "generated_at"],
    properties: {
      schema_version: { const: 1 },
      command: { type: "string" },
      generated_at: { type: "string" }
    },
    additionalProperties: false
  };
}

function errorSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["code", "message", "recoverable"],
    properties: {
      code: { type: "string" },
      message: { type: "string" },
      field: { type: "string" },
      recoverable: { type: "boolean" },
      hint: { type: "string" }
    },
    additionalProperties: false
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await serveMcp();
}
