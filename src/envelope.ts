import {
  FailureEnvelope,
  ResponseMeta,
  SuccessEnvelope
} from "./contracts.js";
import { toErrorEnvelope } from "./errors.js";
import { nowIso } from "./time.js";

/** Builds the stable public success envelope shared by MCP and CLI surfaces. */
export function successEnvelope<T>(command: string, data: T): SuccessEnvelope<T> {
  return {
    ok: true,
    data,
    meta: responseMeta(command)
  };
}

/** Builds the stable public failure envelope shared by MCP and CLI surfaces. */
export function failureEnvelope(command: string, error: unknown): FailureEnvelope {
  return {
    ok: false,
    error: toErrorEnvelope(error),
    meta: responseMeta(command)
  };
}

function responseMeta(command: string): ResponseMeta {
  return {
    schema_version: 1,
    command,
    generated_at: nowIso()
  };
}
