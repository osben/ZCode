import type { ZCodePersistedMessage, ZCodePersistedMessagePart } from "./zcode-task-types-core.js";

// ZCode runtime persists **each LLM call** within the same user turn as a separate assistant message (each with time.created/completed).
// The legacy task projection model has one assistant message per turn, and the UI follows that model (one assistant → one "Worked for X seconds" block).
// Merge adjacent assistant messages after mapping to restore the "one assistant per turn" invariant;
// This is a no-op for legacy projection data, which already strictly alternates.
//
// Also assign turnIndex explicitly by counting user messages, fixing the `toTaskChatMessages` fallback
// bug where `Math.floor(index / 2)` was wrong when there were multiple assistant messages.
export function coalesceConsecutiveZCodeAssistants(
  messages: readonly ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const merged: ZCodePersistedMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    // Synthetic timeline entries such as compact/fork/goal verifier may have the assistant role,
    // but they are message boundaries, not content from the same turn; merging them would consume the divider and add their duration to the previous reply.
    if (
      message.role === "assistant" &&
      last?.role === "assistant" &&
      !last.syntheticTimeline &&
      !message.syntheticTimeline &&
      last.goalIteration === message.goalIteration
    ) {
      merged[merged.length - 1] = mergeAssistantPair(last, message);
      continue;
    }
    merged.push(message);
  }

  let turn = -1;
  return merged.map((message) => {
    if (message.role === "user") {
      turn += 1;
    }
    const effectiveTurn = turn < 0 ? 0 : turn;
    return message.turnIndex === effectiveTurn ? message : { ...message, turnIndex: effectiveTurn };
  });
}

function mergeAssistantPair(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): ZCodePersistedMessage {
  const firstTools = first.tools ?? [];
  const nextTools = next.tools ?? [];
  const mergedTools =
    firstTools.length + nextTools.length > 0 ? [...firstTools, ...nextTools] : undefined;

  const toolIndexOffset = firstTools.length;
  const firstParts = first.parts ?? [];
  const shiftedNextParts: ZCodePersistedMessagePart[] = (next.parts ?? []).map((part) =>
    part.type === "tool-call"
      ? { type: "tool-call", toolIndex: part.toolIndex + toolIndexOffset }
      : part,
  );
  const mergedParts =
    firstParts.length + shiftedNextParts.length > 0
      ? [...firstParts, ...shiftedNextParts]
      : undefined;

  const mergedContent = first.content + next.content;
  const mergedThought =
    first.thought === undefined && next.thought === undefined
      ? undefined
      : (first.thought ?? "") + (next.thought ?? "");

  // If any call has no completed time, the entire turn is unfinished; leave duration empty so the UI shows "Working."
  const durationMs =
    first.durationMs === undefined || next.durationMs === undefined
      ? undefined
      : Math.max(next.timestamp + next.durationMs - first.timestamp, 0);

  const characterCount =
    first.characterCount === undefined && next.characterCount === undefined
      ? undefined
      : mergedContent.length;
  const mergedMessageIds = collectMergedMessageIds(first, next);

  return {
    ...first,
    content: mergedContent,
    timestamp: first.timestamp,
    model: next.model ?? first.model,
    durationMs,
    characterCount,
    interrupted: next.interrupted ?? first.interrupted,
    feedback: next.feedback ?? first.feedback,
    // A pin can land on any merged segment; carry it like feedback so merging segments cannot drop it.
    pinnedAt: next.pinnedAt ?? first.pinnedAt,
    mergedMessageIds: mergedMessageIds.length > 0 ? mergedMessageIds : undefined,
    goalIteration: next.goalIteration ?? first.goalIteration,
    attachments: next.attachments ?? first.attachments,
    tools: mergedTools,
    thought: mergedThought,
    parts: mergedParts,
    checkpointState: next.checkpointState ?? first.checkpointState,
    checkpointReason: next.checkpointReason ?? first.checkpointReason,
    checkpointUpdatedAt: next.checkpointUpdatedAt ?? first.checkpointUpdatedAt,
    bodyRefs: next.bodyRefs ?? first.bodyRefs,
    toolSlice: next.toolSlice ?? first.toolSlice,
  };
}

function collectMergedMessageIds(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): string[] {
  const ids = [
    first.id,
    ...(first.mergedMessageIds ?? []),
    next.id,
    ...(next.mergedMessageIds ?? []),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}
