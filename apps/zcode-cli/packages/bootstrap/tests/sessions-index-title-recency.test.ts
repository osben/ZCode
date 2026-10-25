// sessions-index titleUpdatedAt (docs/ui/task-title-authority.md "Title recency"): the value travels with the title it describes.
import { describe, expect, it } from "vitest";
import type { EventId, SessionEvent, SessionId, TraceId } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import {
  SessionsIndexProjection,
  deriveSessionSummary,
} from "../src/zcode-protocol-v4/sessions-index-projection.js";

function createdOnlySnapshot(sessionId: string) {
  const event: SessionEvent = {
    id: `event-${sessionId}-1` as EventId,
    sessionId: sessionId as SessionId,
    type: SessionEventType.SessionCreated,
    payload: { mode: "default", contextWindow: 200_000 },
    timestamp: new Date(1_700_000_000_000),
    traceId: "trace-1" as TraceId,
    sequenceNumber: 1,
  } as SessionEvent;
  const projection = new ProductProjection(sessionId, "epoch-1");
  projection.applyEvent(event);
  return projection.getSnapshot();
}

describe("sessions-index titleUpdatedAt", () => {
  it("carries the derive extra value and omits the field when the source has none", () => {
    const snapshot = createdOnlySnapshot("s1");
    const withValue = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
      titleUpdatedAt: 777,
    });
    const withoutValue = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });

    expect(withValue.titleUpdatedAt).toBe(777);
    expect("titleUpdatedAt" in withoutValue).toBe(false);
  });

  it("keeps a custom title together with its recency when a live projection would demote it", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    index.seed({
      sessionId: "s1",
      workspaceId: "ws-1",
      title: "Manual rename",
      titleSource: "custom",
      titleUpdatedAt: 500,
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt: 100,
      createdAt: 10,
    });

    index.upsertFromConversation(createdOnlySnapshot("s1"), {
      createdAt: 10,
      lastActivityAt: 100,
      titleUpdatedAt: 1,
    });

    const merged = index.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(merged?.title).toBe("Manual rename");
    expect(merged?.titleUpdatedAt).toBe(500);
  });

  it("keeps the previous recency only while the title is unchanged", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    index.seed({
      sessionId: "s1",
      workspaceId: "ws-1",
      title: "Old generated",
      titleSource: "generated",
      titleUpdatedAt: 500,
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt: 100,
      createdAt: 10,
    });

    // Same title, no value supplied: the previous recency describes the same title and is kept.
    const snapshot = createdOnlySnapshot("s1");
    snapshot.meta.title = "Old generated";
    snapshot.meta.titleSource = "generated";
    index.upsertFromConversation(snapshot, { createdAt: 10, lastActivityAt: 100 });
    expect(index.getSnapshot().sessions.find((s) => s.sessionId === "s1")?.titleUpdatedAt).toBe(500);

    // Title changed without a supplied value: the old recency no longer describes it, so it is dropped.
    snapshot.meta.title = "New generated";
    index.upsertFromConversation(snapshot, { createdAt: 10, lastActivityAt: 100 });
    const changed = index.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(changed?.title).toBe("New generated");
    expect(changed?.titleUpdatedAt).toBeUndefined();
  });
});
