import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type EventId,
  type MessageWithParts,
  type SessionEvent,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { buildColdFileChangeSummaries } from "../src/zcode-protocol-v4/cold-file-change-summaries.js";
import * as coldEventMerge from "../src/zcode-protocol-v4/cold-event-merge.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

const { loadPersistedConversationMaterialization, mergeColdConversationEvents } = coldEventMerge;

function userMessage(id: string, text: string, created: number, turnId: string): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: "s1" as never,
      role: "user",
      time: { created },
      agent: "default",
      model: { providerID: "p" as never, modelID: "m" as never },
      anchor: { turnId: turnId as never, origin: "realUser" },
    },
    parts: [
      {
        id: `${id}-text` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "text",
        text,
      },
    ],
  };
}

function assistantMessage(
  id: string,
  parentId: string,
  text: string,
  created: number,
  turnId: string,
): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: "s1" as never,
      role: "assistant",
      time: { created, completed: created + 1 },
      parentID: parentId as never,
      modelID: "m" as never,
      providerID: "p" as never,
      mode: "default",
      agent: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      anchor: { turnId: turnId as never },
    },
    parts: [
      {
        id: `${id}-text` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "text",
        text,
      },
    ],
  };
}

function event(
  sequenceNumber: number,
  type: SessionEvent["type"],
  payload: unknown,
  turnId?: string,
): SessionEvent {
  return {
    id: `live-${sequenceNumber}` as EventId,
    sessionId: "s1" as SessionId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type,
    timestamp: new Date(10_000 + sequenceNumber),
    traceId: "trace-live" as TraceId,
    sequenceNumber,
    payload,
  };
}

function reduce(events: readonly SessionEvent[]): ProductProjection {
  const projection = new ProductProjection("s1", "cold-merge");
  for (const item of events) projection.applyEvent(item);
  return projection;
}

const HOOK_LIFECYCLE_EVENT_TYPES_FOR_TEST = new Set<SessionEvent["type"]>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);


describe("cold replay of an external agent context reset", () => {
  it("replays the reset divider before the turn it started, not at the end of the transcript", () => {
    const turnId = "runtime-turn-reset";
    const user = userMessage("u-reset", "continue", 1_000, turnId);
    const notice = event(
      1,
      SessionEventType.SystemMessage,
      { type: "external_agent_context_reset", content: "opencode" },
      turnId,
    );

    const merged = mergeColdConversationEvents({
      memoryEvents: [notice],
      messages: [user, assistantMessage("a-reset", user.info.id, "back again", 1_200, turnId)],
      sessionId: "s1",
    });

    const rows = reduce(merged.events).getSnapshot().rows.window;
    const markerIndex = rows.findIndex(
      (row) => row.kind === "timelineMarker" && row.marker.type === "agentContextReset",
    );
    const userIndex = rows.findIndex((row) => row.kind === "userInput");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeLessThan(userIndex);
    expect(rows.filter((row) => row.kind === "timelineMarker")).toHaveLength(1);
  });
});
