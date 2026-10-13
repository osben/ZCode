import {
  SessionEventType,
  createEventId,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type TraceId,
} from "@zcode/contracts";

export interface PersistRowPinnedInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  messageId: string;
  entityId: string;
  pinned: boolean;
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

/**
 * The transcript is authoritative for persisted pins; the event only propagates the same write to the
 * live/cold projection. Pinning is idempotent: a repeat pin keeps the first pinnedAt, and unpinning an
 * unpinned message is a no-op (no transcript write, no event).
 */
export async function persistRowPinned(input: PersistRowPinnedInput): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const message = messages.find((candidate) => String(candidate.info.id) === input.messageId);
  if (!message || (message.info.role !== "assistant" && message.info.role !== "user")) {
    throw new Error("proto.staleTarget");
  }
  const metadata = { ...message.info.metadata };
  const existingPinnedAt =
    typeof metadata.pinnedAt === "number" ? (metadata.pinnedAt as number) : undefined;
  if (input.pinned) {
    if (existingPinnedAt !== undefined) return;
    metadata.pinnedAt = (input.now ?? Date.now)();
  } else {
    if (existingPinnedAt === undefined) return;
    delete metadata.pinnedAt;
  }
  const { metadata: _previousMetadata, ...infoWithoutMetadata } = message.info;
  const nextInfo = {
    ...infoWithoutMetadata,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  await input.sessionStore.saveMessage(nextInfo);

  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.RowPinnedUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: {
      entityId: input.entityId,
      pinnedAt: input.pinned ? (metadata.pinnedAt as number) : null,
    },
  };
  let persisted: SessionEvent;
  try {
    persisted = await input.eventStore.append(event);
  } catch (error) {
    // If the transcript write succeeds but event append fails, the renderer rolls back on the failure
    // ACK, while reopening would recover the pin from partially committed metadata. On append failure,
    // compensate by restoring the original message info.
    try {
      await input.sessionStore.saveMessage(message.info);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "row pin event append failed and transcript rollback failed",
      );
    }
    throw error;
  }

  try {
    input.onPersistedEvent(persisted);
  } catch (error) {
    // Once the event is durable, do not send the renderer a failure ACK: that would roll back the UI
    // against persisted truth. Let resync/hydration reconcile live projection failures, and report them
    // only through the diagnostic callback.
    input.onLiveProjectionError?.(error);
  }
}
