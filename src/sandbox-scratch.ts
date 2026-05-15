import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { errorCode } from "./errors.js";
import { isInside } from "./paths.js";

/** Returns the canonical host temp root used for sandbox canary scratch paths. */
export async function scratchTmpRoot(): Promise<string> {
  return realPathForScratchComparison(tmpdir());
}

/** Returns a removable sandbox scratch directory only when it is owned by the expected canary root. */
export async function sandboxScratchDirectory(target: string, ownerRoot: string): Promise<string | undefined> {
  const normalizedTarget = await realPathForScratchComparison(target);
  const normalizedOwnerRoot = await realPathForScratchComparison(ownerRoot);
  if (isInside(normalizedOwnerRoot, normalizedTarget) && normalizedTarget !== normalizedOwnerRoot) {
    return normalizedTarget;
  }
  return undefined;
}

/** Returns a removable sandbox scratch file only when its parent and generated basename match the canary owner. */
export async function sandboxScratchFile(
  target: string | undefined,
  basenamePrefix: string,
  scratchRoot: string
): Promise<string | undefined> {
  if (target === undefined) {
    return undefined;
  }
  const resolved = path.resolve(target);
  const normalizedParent = await realPathForScratchComparison(path.dirname(resolved));
  if (normalizedParent === scratchRoot && path.basename(resolved).startsWith(basenamePrefix)) {
    return resolved;
  }
  return undefined;
}

async function realPathForScratchComparison(target: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
      throw error;
    }
  }
  let current = resolved;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    try {
      const parentRealPath = await realpath(parent);
      return path.resolve(parentRealPath, path.relative(parent, resolved));
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
        throw error;
      }
    }
    current = parent;
  }
}
