import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

// specs/acp-agent-runtime.md "S3": an external agent tool call reaches the conversation as a tool row
// with its ACP title, its status, and its output.
function harness() {
  const projection = new ProductProjection("acp-tool", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "acp-tool",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "read", messageId: "user-1" });
  return { projection, apply };
}

describe("ACP tool row product projection", () => {
  it("projects a scheduled ACP tool with its title, then its result", () => {
    const { projection, apply } = harness();
    apply(SessionEventType.ToolCallScheduled, {
      toolCallId: "tool-1",
      toolName: "acp:read",
      title: "Read a.txt",
      input: { path: "a.txt" },
      schedule: { parallelGroups: [["tool-1"]], executionOrder: ["tool-1"] },
    });
    apply(SessionEventType.ToolCallStarted, { toolCallId: "tool-1", toolName: "acp:read" });
    apply(SessionEventType.ToolCallResult, {
      toolCallId: "tool-1",
      result: { success: true, content: "file body" },
      duration: 1,
    });
    const row = projection
      .getSnapshot()
      .rows.window.find((candidate) => candidate.kind === "toolCall") as ToolCallRow | undefined;
    expect(row).toBeDefined();
    expect(row).toMatchObject({ toolName: "acp:read", title: "Read a.txt", status: "success" });
  });
});
