import type {
  CompactBoundaryPayload,
  MessagePart,
  MessageId,
  MessageWithParts,
} from "@zcode/contracts";
import { invalidateRuntimeTokenUsage } from "./message-history.js";

export function compactActiveSessionMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
  includePreservedSegment: boolean,
): MessageWithParts[] {
  // Pre-request announcements before a summary were written in the same transaction before the
  // summary; restore them when declared by the compaction part.
  const leadingIds = new Set(compactLeadingMessageIds(messages[boundaryIndex]!));
  const activeMessages = [
    ...messages.slice(0, boundaryIndex).filter((message) => leadingIds.has(message.info.id)),
    ...messages.slice(boundaryIndex),
  ];
  if (!includePreservedSegment) return activeMessages;

  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
  const preservedMessages = compactPreservedSegmentMessages(messages, boundaryIndex);
  if (!boundary?.preservedSegment || preservedMessages.length === 0) {
    return activeMessages;
  }

  const anchorIndex = activeMessages.findIndex(
    (message) => message.info.id === boundary.preservedSegment?.anchorMessageId,
  );
  const insertIndex =
    anchorIndex >= 0 ? anchorIndex + 1 : activeMessages.indexOf(messages[boundaryIndex]!) + 1;
  return [
    ...activeMessages.slice(0, insertIndex),
    ...preservedMessages,
    ...activeMessages.slice(insertIndex),
  ];
}

/** Read the pre-request announcements declared by the compaction part; a malformed on-disk shape counts as undeclared. */
function compactLeadingMessageIds(message: MessageWithParts): MessageId[] {
  for (const part of message.parts) {
    if (part.type !== "compaction" || !part.compactBoundary) continue;
    const ids: unknown = part.metadata?.compactLeadingMessageIds;
    return Array.isArray(ids) && ids.every((id) => typeof id === "string")
      ? (ids as MessageId[])
      : [];
  }
  return [];
}

export function compactPreservedSegmentMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
): MessageWithParts[] {
  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
  const segment = boundary?.preservedSegment;
  if (!segment) return [];

  const headIndex = messages.findIndex((message) => message.info.id === segment.headMessageId);
  const tailIndex = messages.findIndex((message) => message.info.id === segment.tailMessageId);
  if (headIndex < 0 || tailIndex < headIndex || tailIndex >= boundaryIndex) {
    return [];
  }

  // A preserved segment can fall inside the previous compact's preserved segment, where the head
  // sits before the previous summary in storage and the range crosses its pre-request
  // announcements. Those announcements are in the first group after compaction and always get
  // summarized by the next compact, so they never appear in the live preserved segment; skip them
  // per each summary's declaration.
  const leadingIds = new Set(messages.flatMap(compactLeadingMessageIds));
  return messages
    .slice(headIndex, tailIndex + 1)
    .filter(
      (message) => isCompactPreservableSessionMessage(message) && !leadingIds.has(message.info.id),
    )
    .map(cloneCompactPreservedSessionMessage);
}

function cloneCompactPreservedSessionMessage(message: MessageWithParts): MessageWithParts {
  if (message.info.role !== "assistant") return message;
  return {
    ...message,
    info: {
      ...message.info,
      tokens: invalidateRuntimeTokenUsage(message.info.tokens),
    },
  };
}

export function compactBoundaryFromMessage(
  message: MessageWithParts,
): CompactBoundaryPayload | undefined {
  for (const part of message.parts) {
    if (part.type === "compaction" && part.compactBoundary) {
      return part.compactBoundary;
    }
  }
  return undefined;
}

export function isCompactPreservableSessionMessage(message: MessageWithParts): boolean {
  // The UI timeline also uses the assistant role but is not part of a model turn; do not let it shift the start of the retained group.
  if (message.info.semantics?.providerVisibility === "hidden") return false;
  if (message.parts.some((part) => part.type === "compaction")) {
    return false;
  }
  // synthetic/model-only describes input identity and UI visibility only; selected replies, task results, and
  // attachments are not included in the summary, so cold recovery must not discard them again based on these flags.
  if (message.info.role === "assistant" && message.info.error) {
    return false;
  }
  return message.info.role === "user" || message.info.role === "assistant";
}

export function isActiveCompactionBoundaryPart(part: MessagePart): boolean {
  return part.type === "compaction" && (Boolean(part.compactBoundary) || !part.timelineStatus);
}
