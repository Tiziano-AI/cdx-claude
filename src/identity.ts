import { createHash, timingSafeEqual } from "node:crypto";

/** Returns the persisted one-way worker identity digest for a private worker token. */
export function workerTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Verifies a private worker token against the persisted job identity digest. */
export function workerTokenMatches(token: string, expectedHash: string | undefined): boolean {
  if (expectedHash === undefined) {
    return false;
  }
  const actual = Buffer.from(workerTokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
