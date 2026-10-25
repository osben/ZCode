import type {
  ModelReasoningContentBlock,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolCall,
  ModelUsage,
} from "@zcode/contracts";

/**
 * Aggregate an adapter model stream into a text result.
 *
 * Used by the ChatGPT plan (SIWC) path: the direct route requires stream:true on every
 * request, so non-streaming callers (title generation, compaction, subagents) are executed
 * through the streaming path and aggregated here instead of sending a non-streaming request.
 */
export async function aggregateModelStreamToTextResult(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelTextResult> {
  let text = "";
  let finishReason = "unknown";
  let usage: ModelUsage | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  const reasoningById = new Map<
    string,
    { text: string; providerOptions?: Record<string, unknown> }
  >();
  const reasoningOrder: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "reasoning_start":
        if (!reasoningById.has(event.id)) reasoningOrder.push(event.id);
        reasoningById.set(event.id, { text: "" });
        break;
      case "reasoning_delta": {
        const id = event.id ?? reasoningOrder[reasoningOrder.length - 1];
        if (id === undefined) break;
        if (!reasoningById.has(id)) {
          reasoningOrder.push(id);
          reasoningById.set(id, { text: "" });
        }
        reasoningById.get(id)!.text += event.text;
        break;
      }
      case "reasoning_end": {
        const existing = reasoningById.get(event.id);
        if (existing && event.providerMetadata) {
          existing.providerOptions = event.providerMetadata;
        }
        break;
      }
      case "tool_call":
        toolCalls.push(event.toolCall);
        break;
      case "finish":
        finishReason = event.finishReason;
        usage = event.usage;
        if (event.providerMetadata) providerMetadata = event.providerMetadata;
        break;
      case "error":
        throw event.error;
      default:
        break;
    }
  }

  const reasoning: ModelReasoningContentBlock[] | undefined =
    reasoningOrder.length > 0
      ? reasoningOrder.flatMap((id) => {
          const block = reasoningById.get(id);
          return block && block.text.length > 0
            ? [
                {
                  type: "reasoning" as const,
                  text: block.text,
                  ...(block.providerOptions ? { providerOptions: block.providerOptions } : {}),
                },
              ]
            : [];
        })
      : undefined;

  if (!usage) {
    // The finish event is the sole usage source on this path; a stream without it is malformed.
    throw new Error("Model stream ended without a finish event carrying usage.");
  }

  return {
    text,
    finishReason,
    usage,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(providerMetadata ? { providerMetadata } : {}),
  };
}
