#!/usr/bin/env node
import {
  CleanupRequestSchema,
  DEFAULT_SDK_USAGE_GUARD_USD,
  EmptyRequestSchema,
  JobIdRequestSchema,
  ListRequestSchema,
  SandboxCanaryRequestSchema,
  StartRequestSchema,
  TailRequestSchema
} from "./contracts.js";
import { failureEnvelope, successEnvelope } from "./envelope.js";
import { UserVisibleError } from "./errors.js";
import { serveMcp } from "./mcp-server.js";
import { runWorker } from "./worker.js";
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

const args = process.argv.slice(2);

try {
  await runCli(args);
} catch (error) {
  writeJson(failureEnvelope(commandName(args), error));
  process.exitCode = 1;
}

/** Routes the public cdx-claude CLI, including the MCP server subcommand. */
async function runCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    writeHelp();
    return;
  }

  if (argv[0] === "mcp" && argv[1] === "serve") {
    await serveMcp();
    return;
  }
  if (argv[0] === "__worker") {
    process.exitCode = await runWorker(argv.slice(1));
    return;
  }

  const command = commandName(argv);
  const data = await dispatch(argv);
  writeJson(successEnvelope(command, data));
}

async function dispatch(argv: string[]): Promise<unknown> {
  if (argv[0] === "doctor") {
    EmptyRequestSchema.parse(readFlags(argv.slice(1)));
    return doctor();
  }
  if (argv[0] === "roles") {
    EmptyRequestSchema.parse(readFlags(argv.slice(1)));
    return listRoles();
  }
  if (argv[0] === "sandbox" && argv[1] === "canary") {
    return sandboxCanary(SandboxCanaryRequestSchema.parse(readFlags(argv.slice(2))));
  }
  if (argv[0] === "jobs") {
    return dispatchJobs(argv.slice(1));
  }
  throw new UserVisibleError(`unknown command: ${argv.join(" ")}`, {
    code: "unknown_command",
    recoverable: true,
    hint: "Run cdx-claude --help."
  });
}

async function dispatchJobs(argv: string[]): Promise<unknown> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "start") {
    return startJob(StartRequestSchema.parse(readFlags(rest)));
  }
  if (subcommand === "list") {
    const request = ListRequestSchema.parse(readFlags(rest));
    return listDelegations(request.limit, request.status);
  }
  if (subcommand === "status") {
    const request = parseJobId(rest);
    return statusJob(request.job_id);
  }
  if (subcommand === "tail") {
    const flags = readFlags(rest.slice(1));
    const request = TailRequestSchema.parse({ job_id: rest[0], ...flags });
    return tailDelegation(request.job_id, request.limit, request.after_seq);
  }
  if (subcommand === "result") {
    const request = parseJobId(rest);
    return resultDelegation(request.job_id);
  }
  if (subcommand === "diff") {
    const request = parseJobId(rest);
    return diffDelegation(request.job_id);
  }
  if (subcommand === "stop") {
    const request = parseJobId(rest);
    return stopDelegation(request.job_id);
  }
  if (subcommand === "cleanup") {
    const flags = readFlags(rest.slice(1));
    const request = CleanupRequestSchema.parse({ job_id: rest[0], ...flags });
    return cleanupDelegation(request);
  }
  throw new UserVisibleError(`unknown jobs command: ${subcommand ?? ""}`, {
    code: "unknown_command",
    recoverable: true,
    hint: "Run cdx-claude --help."
  });
}

function parseJobId(argv: string[]): { job_id: string } {
  if (argv.length !== 1) {
    throw new UserVisibleError("Expected exactly one job_id argument.", {
      code: "invalid_input",
      recoverable: true
    });
  }
  return JobIdRequestSchema.parse({ job_id: argv[0] });
}

function readFlags(argv: string[]): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === undefined) {
      continue;
    }
    if (!raw.startsWith("--")) {
      throw new UserVisibleError(`Unexpected positional argument: ${raw}`, {
        code: "invalid_input",
        recoverable: true
      });
    }
    const key = raw.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values[key] = true;
      continue;
    }
    values[key] = parseFlagValue(next);
    index += 1;
  }
  return values;
}

function parseFlagValue(value: string): string | number | boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "") {
    return numeric;
  }
  return value;
}

function commandName(argv: string[]): string {
  if (argv.length === 0) {
    return "help";
  }
  if (argv[0] === "jobs" || argv[0] === "plugin" || argv[0] === "sandbox" || argv[0] === "mcp") {
    return [argv[0], argv[1]].filter((value) => value !== undefined).join(" ");
  }
  return argv[0] ?? "unknown";
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeHelp(): void {
  process.stdout.write(
    [
      "cdx-claude",
      "",
      "Commands:",
      "  cdx-claude mcp serve",
      "  cdx-claude doctor",
      "  cdx-claude roles",
      "  cdx-claude jobs start --cwd /repo --prompt 'task' --mode research --agent-role evidence_cartographer",
      `    Omit --max-budget-usd unless the user explicitly requested a non-default SDK usage-estimate guard; default ${DEFAULT_SDK_USAGE_GUARD_USD}.`,
      "  cdx-claude jobs list [--status running] [--limit 50]",
      "  cdx-claude jobs status <job_id>",
      "  cdx-claude jobs tail <job_id> [--limit 50]",
      "  cdx-claude jobs result <job_id>",
      "  cdx-claude jobs diff <job_id>",
      "  cdx-claude jobs stop <job_id>",
      "  cdx-claude jobs cleanup <job_id> [--force] [--remove-ledger]",
      "  cdx-claude sandbox canary --agent-role authority_guardian",
      `    Omit --max-budget-usd unless the user explicitly requested a non-default SDK usage-estimate guard; default ${DEFAULT_SDK_USAGE_GUARD_USD}.`,
      ""
    ].join("\n")
  );
}
