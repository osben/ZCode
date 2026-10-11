import type { Logger } from "@zcode/contracts";

interface NormalizeModelToolInputOptions {
  logger?: Logger;
  source: "generateText" | "streamText";
  toolName?: string;
}

export function normalizeModelToolInput(
  input: unknown,
  options: NormalizeModelToolInputOptions,
): unknown {
  if (input === undefined) {
    return {};
  }
  if (input === null) {
    // Upstream first parses the valid JSON literal "null" into native null. Use the same recovery
    // semantics as parsing a string containing null, and do not fabricate the original length.
    warnAndRecoverMalformedToolInput(new TypeError("Model tool input must not be null"), options, {
      inputType: "null",
    });
    return {};
  }
  if (typeof input !== "string") {
    return input;
  }
  if (input.length === 0) {
    return {};
  }

  try {
    const normalizedInput = JSON.parse(stripByteOrderMark(input));
    if (normalizedInput === null) {
      // JSON null is syntactically valid but cannot represent tool arguments. Fall back to an empty
      // object, as with malformed JSON, and let the existing tool schema determine the outcome.
      throw new TypeError("Model tool input must not be null");
    }
    return normalizedInput;
  } catch (error) {
    warnAndRecoverMalformedToolInput(error, options, {
      inputLength: input.length,
    });
    // The AI SDK already provided the final tool-call. Throwing invalid_model_response here would
    // incorrectly escalate an argument error into a failed model request. After strict parsing fails,
    // fall back only to an empty object and let the regular tool schema decide whether to return an
    // error result or continue execution.
    return {};
  }
}

function warnAndRecoverMalformedToolInput(
  error: unknown,
  options: NormalizeModelToolInputOptions,
  inputContext: { inputLength: number } | { inputType: "null" },
): void {
  options.logger?.warn("Model tool input JSON normalization failed", {
    event: "model.tool_input.normalize_failed",
    ...inputContext,
    module: "adapters.model.tool-input-normalization",
    parseErrorType: parseErrorType(error),
    recovery: "empty_object",
    source: options.source,
    status: "failed",
    toolName: options.toolName,
  });
}

function stripByteOrderMark(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

function parseErrorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}
