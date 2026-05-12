import { EventRecord } from "./contracts.js";

const CONTROL_IDENTITY_KEYS = new Set(["pid", "worker_pid", "worker_token", "worker_token_hash"]);

/** Projects persisted event rows to the public tail surface without cdx-claude worker identity. */
export function toPublicEvents(events: EventRecord[]): EventRecord[] {
  return events.map((event) => ({
    ...event,
    metadata: sanitizeValue(event.metadata)
  }));
}

function sanitizeValue(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
    return sanitizeRecord(value);
  }
  return {};
}

function sanitizeNested(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeNested);
  }
  if (isPlainRecord(value)) {
    return sanitizeRecord(value);
  }
  return value;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CONTROL_IDENTITY_KEYS.has(key)) {
      sanitized[key] = sanitizeNested(value);
    }
  }
  return sanitized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
