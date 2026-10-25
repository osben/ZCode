import type { BrowserCommandResult } from "@zcode/shared";

export type BrowserCommandDone = (
  partial: Omit<BrowserCommandResult, "elapsedMs">,
) => BrowserCommandResult;

/** Create a structured error for an unknown ref (suggest taking a snapshot first). */
export function refNotFound(ref: string): Omit<BrowserCommandResult, "elapsedMs"> {
  return {
    ok: false,
    error: {
      code: "ref_not_found",
      message: `ref ${ref} not found (take a fresh snapshot() first)`,
    },
  };
}

/** Helper for creating a structured execution_error result. */
export function executionError(message: string): Omit<BrowserCommandResult, "elapsedMs"> {
  return { ok: false, error: { code: "execution_error", message } };
}
