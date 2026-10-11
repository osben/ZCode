import { ModelErrorCode } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";

export function normalizeModelToolName(
  value: unknown,
  context: Record<string, unknown>,
): string {
  if (typeof value === "string") {
    const toolName = value.trim();
    if (toolName) {
      return toolName;
    }

    const toolCallId = context.toolCallId;
    const hasClosableToolCallId =
      typeof toolCallId === "string" && toolCallId.trim().length > 0;
    if (context.providerExecuted !== true && hasClosableToolCallId) {
      // A client-executed call with an empty name can still be closed using its original id.
      // Throwing directly in the Adapter would prevent the model from receiving a tool error with
      // the same id and stop the entire turn.
      return value;
    }
  }

  throw new AiSdkModelAdapterError(
    ModelErrorCode.InvalidModelResponse,
    "Model returned an invalid tool call: tool name is empty.",
    { context },
  );
}
