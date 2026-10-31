import type {
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelId,
  ModelProviderId,
} from "@zcode/contracts";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { getStatusCode, unwrapRetryError } from "./failure-inspection.js";

const EMPTY_ASSISTANT_CONTENT_FALLBACK = "(no content)";
const REJECTED_REASONING_FALLBACK = "[Thinking removed]";

// Older history retains the builtin identity, while current selections have moved to account
// identities; Individual/Team may also use different IDs. Recognize only these explicit identities
// for the same service during reasoning replay; do not change model selection or authentication.
// Do not reuse plan display groups: Start/Off-Peak/API access are outside this signature compatibility scope.
const REASONING_PROVIDER_GROUPS: readonly (readonly string[])[] = [
  [
    "builtin:zai-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  ],
  [
    "builtin:bigmodel-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  ],
];

export function normalizeReasoningHistory(
  messages: ModelInputMessage[],
  targetModel?: { modelId: ModelId; providerId: ModelProviderId },
): ModelInputMessage[] {
  const compatibleHistory = removeCrossModelReasoning(messages, targetModel);
  const withoutOrphans = removeAssistantsMergingNeighbors(
    compatibleHistory,
    isReasoningOnlyAssistant,
  );
  const withoutTrailingReasoning = removeTrailingReasoning(withoutOrphans);
  const withoutWhitespaceOnlyAssistants = removeAssistantsMergingNeighbors(
    withoutTrailingReasoning,
    isWhitespaceOnlyAssistant,
  );
  return repairEmptyAssistantContent(withoutWhitespaceOnlyAssistants);
}

export function removeRejectedReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const filtered = filterReasoningBlocks(messages, isSignedOrRedactedReasoning);
  if (filtered === messages) return messages;

  const result = filtered.slice();
  for (let index = 0; index < filtered.length; index += 1) {
    if (filtered[index] === messages[index]) continue;

    const message = filtered[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    let content = message.content.filter(
      (block) => block.type !== "text" || block.text.trim().length > 0,
    );
    if (!hasToolCalls(message) && content.every((block) => block.type === "reasoning")) {
      content = [...content, { type: "text", text: REJECTED_REASONING_FALLBACK }];
    }
    result[index] = { ...message, content };
  }
  return result;
}

export function repairReasoningHistoryAfterSignatureRejection(
  projectedMessages: ModelInputMessage[],
  error: unknown,
): ModelInputMessage[] | undefined {
  if (!isThinkingSignatureRejection(error)) return undefined;

  // The caller passes a copy already structurally normalized at the logical request entry point.
  // Only clean up rejected signatures here; do not run structural passes again, which would remove
  // the assistant placeholder just added and change turn boundaries.
  const repaired = removeRejectedReasoning(projectedMessages);
  return repaired === projectedMessages ? undefined : repaired;
}

export function isThinkingSignatureRejection(error: unknown): boolean {
  const unwrapped = unwrapRetryError(error);
  if (getStatusCode(unwrapped) !== 400) return false;

  // The provider has no dedicated error code for this 400. Match only the confirmed narrow message
  // patterns so other invalid_request errors are not mistaken for fixable history that should retry.
  const message = errorMessage(unwrapped).toLowerCase();
  if (message.includes("signature in thinking block")) return true;

  const namesThinkingBlock =
    message.includes("thinking block") ||
    message.includes("`thinking`") ||
    message.includes("redacted_thinking");
  const namesSignatureFailure =
    message.includes("cannot be modified") || message.includes("invalid signature");
  return namesThinkingBlock && namesSignatureFailure;
}

function removeCrossModelReasoning(
  messages: ModelInputMessage[],
  targetModel: { modelId: ModelId; providerId: ModelProviderId } | undefined,
): ModelInputMessage[] {
  if (!targetModel) return messages;

  return filterReasoningBlocks(messages, (block, message) => {
    if (!message.providerId || !message.modelId) return false;
    if (
      message.modelId === targetModel.modelId &&
      areReasoningProvidersCompatible(message.providerId, targetModel.providerId)
    ) {
      return false;
    }
    return isSignedOrRedactedReasoning(block);
  });
}

function areReasoningProvidersCompatible(
  source: ModelProviderId,
  target: ModelProviderId,
): boolean {
  return (
    source === target ||
    REASONING_PROVIDER_GROUPS.some((group) => group.includes(source) && group.includes(target))
  );
}

function filterReasoningBlocks(
  messages: ModelInputMessage[],
  shouldRemove: (block: ModelReasoningContentBlock, message: ModelInputMessage) => boolean,
): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const content = message.content.filter(
      (block) => block.type !== "reasoning" || !shouldRemove(block, message),
    );
    if (content.length === message.content.length) continue;

    result ??= messages.slice();
    // Filter only reasoning blocks here, preserving message order and structure; a separate stage
    // handles structural repairs.
    result[index] = { ...message, content };
  }

  return result ?? messages;
}

function removeAssistantsMergingNeighbors(
  messages: ModelInputMessage[],
  shouldRemove: (message: ModelInputMessage) => boolean,
): ModelInputMessage[] {
  const result: ModelInputMessage[] = [];
  let removedBefore = false;
  for (const message of messages) {
    if (shouldRemove(message)) {
      removedBefore = true;
      continue;
    }
    const previous = result.at(-1);
    // After the removal, the user messages on both sides are concatenated directly downstream and
    // the previous text would lack a trailing "\n", so merge here.
    // Root cause: merge only the pair adjacent to the deletion point; other adjacent user messages
    // are already joined by the request layer, and re-merging the whole run would add an extra "\n" to each pair.
    if (removedBefore && canMergeAdjacentUserMessages(previous, message)) {
      result[result.length - 1] = mergeUserMessagePair(previous, message);
    } else {
      result.push(message);
    }
    removedBefore = false;
  }
  return result.length === messages.length ? messages : result;
}

function isReasoningOnlyAssistant(message: ModelInputMessage): boolean {
  if (message.role !== "assistant" || hasToolCalls(message)) return false;
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.every((block) => block.type === "reasoning");
}

function removeTrailingReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return messages;

  let end = last.content.length;
  while (end > 0 && last.content[end - 1]?.type === "reasoning") {
    end -= 1;
  }
  if (end === last.content.length) return messages;

  const result = messages.slice();
  result[result.length - 1] = {
    ...last,
    content: last.content.slice(0, end),
  };
  return result;
}

function isWhitespaceOnlyAssistant(message: ModelInputMessage): boolean {
  if (message.role !== "assistant" || hasToolCalls(message)) return false;
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.every(
    (block) =>
      block.type === "text" &&
      (block.text.trim().length === 0 || block.text.trim() === EMPTY_ASSISTANT_CONTENT_FALLBACK),
  );
}

function repairEmptyAssistantContent(messages: ModelInputMessage[]): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    if (
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      message.content.length > 0 ||
      hasToolCalls(message)
    ) {
      continue;
    }

    result ??= messages.slice();
    result[index] = {
      ...message,
      content: [{ type: "text", text: EMPTY_ASSISTANT_CONTENT_FALLBACK }],
    };
  }

  return result ?? messages;
}

function mergeUserMessagePair(
  previous: ModelInputMessage,
  message: ModelInputMessage,
): ModelInputMessage {
  const merged: ModelInputMessage = {
    role: "user",
    content: mergeUserContent(previous.content, message.content),
  };
  const cacheControl = message.cacheControl ?? previous.cacheControl;
  if (cacheControl) merged.cacheControl = { ...cacheControl };
  return merged;
}

function canMergeAdjacentUserMessages(
  previous: ModelInputMessage | undefined,
  next: ModelInputMessage,
): previous is ModelInputMessage & { role: "user" } {
  if (previous?.role !== "user" || next.role !== "user") return false;
  return !isToolResultUserMessage(previous) && !isToolResultUserMessage(next);
}

function isToolResultUserMessage(message: ModelInputMessage): boolean {
  return message.role === "user" && Boolean(message.toolCallId || message.toolName);
}

function mergeUserContent(
  previous: ModelMessageContent,
  next: ModelMessageContent,
): ModelMessageContentBlock[] {
  const previousBlocks = contentAsBlocks(previous);
  const nextBlocks = contentAsBlocks(next);
  const previousLast = previousBlocks.at(-1);
  const nextFirst = nextBlocks[0];

  if (previousLast?.type === "text" && nextFirst?.type === "text") {
    previousBlocks[previousBlocks.length - 1] = {
      ...previousLast,
      text: `${previousLast.text}\n`,
    };
  }

  return [...previousBlocks, ...nextBlocks];
}

function contentAsBlocks(content: ModelMessageContent): ModelMessageContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function isSignedOrRedactedReasoning(block: ModelReasoningContentBlock): boolean {
  const anthropic = anthropicOptions(block.providerOptions);
  return (
    (typeof anthropic.signature === "string" && anthropic.signature.length > 0) ||
    typeof anthropic.redactedData === "string"
  );
}

function hasToolCalls(message: ModelInputMessage): boolean {
  return (message.toolCalls?.length ?? 0) > 0;
}

function anthropicOptions(providerOptions: unknown): Record<string, unknown> {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return {};
  }
  const anthropic = (providerOptions as Record<string, unknown>).anthropic;
  return anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
    ? (anthropic as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}
