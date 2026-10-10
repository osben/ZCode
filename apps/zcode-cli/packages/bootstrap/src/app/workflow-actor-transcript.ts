// ============================================================
// Two actor-transcript operations: boundary counting and seed-prefix copying (amend-resume).
// ============================================================
//
// Keep both operations in one module because they share a **payload-level** invariant:
//
//   Boundary N ⇒ copy the first N messages from the source session to get exactly the complete transcript through that ask.
//
// This holds only because counting and copying use the **same access surface**
// ({@link ActorTranscriptStore.messages}), which is also what core reads when
// rehydrating through `resumeFromStore` (core/src/runtime/methods/resume.ts). If any of
// the three readers uses a different measure (for example, counting only the active
// branch or counting parts), they will see different boundary lengths. The copied
// transcript will then be one message too long or short, silently misaligning what the
// model sees with the boundary recorded in the journal. Therefore, **change the counting
// rule in all three places together**.
//
// The key property of a count offset (rather than a message-id range) is that it is
// **invariant under prefix copying**: message ids change in the new session, but the
// count does not. The copied ask's boundary therefore remains valid as-is in the new
// session, which enables chained revisions (B copies from A, then C copies from B).

import {
  createMessageId,
  createPartId,
  type Logger,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type PartId,
  type SessionId,
} from "@zcode/contracts";
import { cloneMessageForFork, clonePartForFork } from "@zcode/core";
import { WorkflowError, type ActorSessionSeed } from "@zcode/dynamic-workflow";

/**
 * Session-transcript access needed by the driver: read all messages for a session and write a message / part.
 *
 * This is a strict structural subset of {@link import("@zcode/contracts").SessionStorePort},
 * so production can pass the session store directly. The reason for narrowing it is the
 * same as for the run service's journal / task-link ports: the driver needs only these
 * three methods, and declaring the whole store would make “the driver depends on every
 * session-storage capability” literally true.
 */
export interface ActorTranscriptStore {
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveMessage(input: MessageInfo): Promise<void>;
  savePart(input: MessagePart): Promise<void>;
}

/**
 * Number of **persisted** messages in an actor session (the value recorded as the ask boundary).
 *
 * Count only persisted messages: the driver reads this after an exchange, and runtime
 * message persistence has already been awaited within the turn (core's persistMessage /
 * persistPart), so the persisted count is the exchange's full output.
 */
export async function countActorTranscript(
  store: ActorTranscriptStore,
  sessionId: SessionId,
): Promise<number> {
  return (await store.messages({ sessionID: sessionId })).length;
}

/**
 * Copy the first `seed.messageCount` messages from the source session (including their parts) into the target session.
 *
 * Three properties:
 *
 * 1. **The source remains read-only.** Give every copied message and part a new id:
 *    `message.id` / `part.id` are database-wide primary keys, and `saveMessage` upserts
 *    by id, changing `session_id` on a collision (adapters' messages.ts). Reusing ids
 *    would not copy the predecessor transcript; it would **move** it. New ids require
 *    remapping `parentID` and embedded part anchors too, which core's fork cloners
 *    {@link cloneMessageForFork} / {@link clonePartForFork} already handle. A fork does
 *    the same operation—copy transcript values to another session so the child can
 *    continue with local ids—so reuse those helpers rather than duplicating them.
 * 2. **Idempotent, and never write into a session that has already started.** Both skip rules are required:
 *
 *    - If the target already has ≥ messageCount messages, skip the entire copy. This is
 *      the resume-after-crash case for a revision run: the session id is deterministic
 *      from (runId, actorRef), and reattachment returns the session containing both the
 *      copied and newly produced messages. Copying again would duplicate the context.
 *    - Also skip if the target contains any message that is **not** a seed id for this
 *      session (see {@link seededMessageId}). A session containing only seed messages
 *      is a partially copied prefix and can still be completed. A session containing
 *      anything else has its own history and must not be changed at all.
 *
 *    The second rule prevents **recopying after the boundary grows**. `inFlight.messageBoundary`
 *    is the predecessor's current message count and the only import-cache value that is
 *    not a journal fact (see the header of dynamic-workflow-import.ts). It can grow
 *    between builds if the predecessor is resumed and writes more turns, or a delayed
 *    background notification arrives. A normal stop → resume of the revision run then
 *    brings a larger M here. If the target already has live messages but fewer than M in
 *    total, the old rule recopies 0..M-1: the first N upserts match existing seed ids
 *    (harmless), but N..M-1 get **new ids**, appending predecessor messages **after** the
 *    target's own history (`message.sequence` uses `max+1` on insert in adapters'
 *    messages.ts). This silently creates out-of-order context that does not belong to
 *    this subagent. “Modify only sessions containing seed ids” closes this once at the
 *    copy point and applies to any future non-journal fact without proving each one
 *    cannot grow.
 * 3. **Fail loudly when data is missing.** If the source session does not exist (reads as
 *    empty) or is shorter than the boundary, the store cannot fulfill the seed that the
 *    service constructed from journal facts. This indicates corruption, not a
 *    degradable condition. The degradable case is handled by the service gate: a chain
 *    candidate with a missing session should already have been discarded there.
 *
 * @returns Number of messages copied; `undefined` means skipped. Both skip rules share
 *          this return value because the caller handles them identically: do not hydrate
 *          a second time (see seedActorSession in workflow-driver-transcript.ts).
 */
export async function seedActorTranscript(input: {
  logger?: Logger;
  seed: ActorSessionSeed;
  store: ActorTranscriptStore;
  targetSessionId: SessionId;
}): Promise<number | undefined> {
  const { logger, seed, store, targetSessionId } = input;
  const existing = await store.messages({ sessionID: targetSessionId });
  if (existing.length >= seed.messageCount) return undefined;
  if (!holdsOnlySeedMessages(existing, targetSessionId)) {
    // Record this case: reaching here means the seed boundary grew since last time, and this is the only place that can detect it.
    logger?.warn?.("Dynamic workflow actor session already has its own history; seeding skipped", {
      event: "dynamic_workflow.actor.seed_skipped_live_session",
      existingMessageCount: existing.length,
      messageCount: seed.messageCount,
      module: "bootstrap.app",
      sessionId: targetSessionId,
    });
    return undefined;
  }

  const source = await store.messages({ sessionID: seed.sourceSessionId as SessionId });
  if (source.length < seed.messageCount) {
    throw new WorkflowError(
      "DriverError",
      `Cannot seed the subagent transcript: source session ${seed.sourceSessionId} has only ` +
        `${source.length} messages, but the boundary requires the first ${seed.messageCount}.`,
      { mismatch: { expected: String(seed.messageCount), got: String(source.length) } },
    );
  }

  // Map old ids to new ids for the assistant's parentID and embedded part anchors. The
  // prefix is contiguous, so any earlier message referenced by the current message is
  // already in the map (indices strictly increase).
  const messageIds = new Map<MessageId, MessageId>();
  for (let index = 0; index < seed.messageCount; index++) {
    const message = source[index]!;
    const nextMessageId = seededMessageId(targetSessionId, index);
    const cloned = cloneMessageForFork(message.info, {
      forkedSessionId: targetSessionId,
      messageIdMap: messageIds,
      nextMessageId,
    });
    messageIds.set(message.info.id, nextMessageId);
    await store.saveMessage(cloned);
    for (const [partIndex, part] of message.parts.entries()) {
      await store.savePart(
        clonePartForFork(part, {
          forkedSessionId: targetSessionId,
          messageIdMap: messageIds,
          nextMessageId,
          nextPartId: seededPartId(targetSessionId, index, partIndex),
        }),
      );
    }
  }
  return seed.messageCount;
}

/**
 * Whether the target session contains **only** seed copies for this session (entry i is exactly {@link seededMessageId} for index i).
 *
 * Use ids rather than count or time: seed ids are deterministic from (target session,
 * index), so whether a message was copied here can be answered without a clock or any
 * other information beyond read order. An empty session returns true (nothing has been
 * copied yet, so copying is allowed). `messages()` returns sequence order, and seeds
 * are written by index, so the index is the position.
 */
function holdsOnlySeedMessages(
  existing: readonly MessageWithParts[],
  targetSessionId: SessionId,
): boolean {
  return existing.every(
    (message, index) => message.info.id === seededMessageId(targetSessionId, index),
  );
}

/**
 * Deterministic id for a seed copy, derived from (target session, prefix index).
 *
 * Deterministic ids provide **recoverability after partial copies**: if copying crashes
 * halfway through, reattachment upserts existing rows with the same ids instead of
 * creating duplicates. The session id already includes runId and actorRef, so copies in
 * different target sessions cannot collide.
 */
function seededMessageId(targetSessionId: SessionId, index: number): MessageId {
  return createMessageId(`${targetSessionId}-seed-${index}`);
}

function seededPartId(targetSessionId: SessionId, index: number, partIndex: number): PartId {
  return createPartId(`${targetSessionId}-seed-${index}-${partIndex}`);
}
