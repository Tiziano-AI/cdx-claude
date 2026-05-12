import { z } from "zod";
import { ErrorEnvelope } from "./contracts.js";

const ErrorCodeSchema = z.object({ code: z.string() }).passthrough();

export class UserVisibleError extends Error {
  public readonly code: string;
  public readonly field: string | undefined;
  public readonly recoverable: boolean;
  public readonly hint: string | undefined;

  public constructor(
    message: string,
    options: { code?: string; field?: string; recoverable?: boolean; hint?: string } = {}
  ) {
    super(message);
    this.name = "UserVisibleError";
    this.code = options.code ?? "invalid_input";
    this.field = options.field;
    this.recoverable = options.recoverable ?? true;
    this.hint = options.hint;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function errorCode(error: unknown): string | null {
  const parsed = ErrorCodeSchema.safeParse(error);
  if (parsed.success) {
    return parsed.data.code;
  }
  return null;
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof UserVisibleError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      ...(error.field === undefined ? {} : { field: error.field }),
      ...(error.hint === undefined ? {} : { hint: error.hint })
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_input",
      message: z.prettifyError(error),
      recoverable: true
    };
  }
  return {
    code: "internal_error",
    message: errorMessage(error),
    recoverable: false
  };
}
