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

export interface PermissionRootPolicy {
  executionRoot: string;
  additionalReadRoots: string[];
}

export function buildPermissionGate(mode: JobMode, rootPolicy: PermissionRootPolicy): PermissionGate {
  let canonicalRootPolicy: Promise<{ readRoots: string[]; writeRoots: string[] }> | undefined;
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
      canonicalRootPolicy = canonicalRootPolicy ?? canonicalizeRootPolicy(rootPolicy);
      const canonicalPolicy = await canonicalRootPolicy;
      const allowedRoots = WRITE_TOOLS.has(toolName)
        ? canonicalPolicy.writeRoots
        : canonicalPolicy.readRoots;
      const resolved = resolveInside(rootPolicy.executionRoot, requestedPath);
      if (!(await pathIsInsideAnyRoot(allowedRoots, resolved))) {
        return {
          behavior: "deny",
          message: accessDeniedMessage(toolName, rootPolicy),
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

async function canonicalizeRootPolicy(rootPolicy: PermissionRootPolicy): Promise<{ readRoots: string[]; writeRoots: string[] }> {
  const executionRoot = await realpath(rootPolicy.executionRoot);
  const additionalReadRoots = rootPolicy.additionalReadRoots.map((root) => path.resolve(root));
  return {
    readRoots: [executionRoot, ...additionalReadRoots],
    writeRoots: [executionRoot]
  };
}

async function pathIsInsideAnyRoot(roots: string[], candidate: string): Promise<boolean> {
  const realCandidate = await realExistingPath(candidate);
  for (const root of roots) {
    if (isInside(root, realCandidate)) {
      return true;
    }
  }
  return false;
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

function accessDeniedMessage(toolName: string, rootPolicy: PermissionRootPolicy): string {
  if (WRITE_TOOLS.has(toolName)) {
    return `File writes outside ${path.resolve(rootPolicy.executionRoot)} are denied.`;
  }
  const readRoots = [rootPolicy.executionRoot, ...rootPolicy.additionalReadRoots].map((root) => path.resolve(root)).join(", ");
  return `File reads outside configured read roots are denied: ${readRoots}.`;
}
