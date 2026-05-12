import { realpath } from "node:fs/promises";
import path from "node:path";
import { JobMode } from "./contracts.js";
import { errorCode } from "./errors.js";
import { isInside, resolveInside } from "./paths.js";

const PATH_KEYS = ["file_path", "path", "notebook_path"];
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface PermissionOptions {
  signal: AbortSignal;
  toolUseID: string;
}

export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: "deny"; message: string; toolUseID?: string };

export type PermissionGate = (
  toolName: string,
  input: Record<string, unknown>,
  options: PermissionOptions
) => Promise<PermissionResult>;

export function buildPermissionGate(mode: JobMode, allowedRoot: string): PermissionGate {
  return async (toolName, input, options): Promise<PermissionResult> => {
    if (toolName === "Bash" && mode !== "patch_autonomous") {
      return {
        behavior: "deny",
        message: "Shell execution is denied outside patch_autonomous.",
        toolUseID: options.toolUseID
      };
    }

    if (mode === "research" && WRITE_TOOLS.has(toolName)) {
      return {
        behavior: "deny",
        message: "Research jobs are read-only.",
        toolUseID: options.toolUseID
      };
    }

    const requestedPath = requestedFilePath(input);
    if (requestedPath !== null) {
      const resolved = resolveInside(allowedRoot, requestedPath);
      if (!isInside(allowedRoot, resolved) || !(await realPathIsInside(allowedRoot, resolved))) {
        return {
          behavior: "deny",
          message: `File access outside ${path.resolve(allowedRoot)} is denied.`,
          toolUseID: options.toolUseID
        };
      }
    }

    return {
      behavior: "allow",
      updatedInput: input,
      toolUseID: options.toolUseID
    };
  };
}

async function realPathIsInside(root: string, candidate: string): Promise<boolean> {
  const realRoot = await realpath(root);
  const realCandidate = await realExistingPath(candidate);
  return isInside(realRoot, realCandidate);
}

async function realExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function requestedFilePath(input: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}
