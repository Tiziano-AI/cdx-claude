import { homedir } from "node:os";

/** Redacts the operator home prefix while preserving enough path shape for runtime diagnostics. */
export function redactOperatorPath(value: string): string {
  const home = homedir();
  if (home.length > 1 && value.startsWith(home)) {
    return value.replace(home, "~");
  }
  return value;
}
