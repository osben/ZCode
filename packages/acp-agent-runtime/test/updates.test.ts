import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { mapSessionUpdate } from "../src/index.js";

const asUpdate = (value: object): SessionUpdate => value as unknown as SessionUpdate;

describe("mapSessionUpdate", () => {
  it("maps text message and thought chunks", () => {
    expect(
      mapSessionUpdate(
        asUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      ),
    ).toEqual({ type: "message_chunk", text: "hi" });
    expect(
      mapSessionUpdate(
        asUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      ),
    ).toEqual({ type: "thought_chunk", text: "hmm" });
  });

  it("ignores non-text chunks and user echoes", () => {
    expect(
      mapSessionUpdate(
        asUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }),
      ),
    ).toBeNull();
    expect(
      mapSessionUpdate(
        asUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } }),
      ),
    ).toBeNull();
  });

  it("maps tool calls and updates", () => {
    const call = mapSessionUpdate(
      asUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Edit File",
        kind: "edit",
        status: "pending",
      }),
    );
    expect(call?.type).toBe("tool_call");
    if (call?.type === "tool_call") {
      expect(call.toolCall.toolCallId).toBe("t1");
      expect(call.toolCall.title).toBe("Edit File");
      expect(call.toolCall.kind).toBe("edit");
      expect(call.toolCall.status).toBe("pending");
    }
    const update = mapSessionUpdate(
      asUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    );
    expect(update?.type).toBe("tool_call_update");
    if (update?.type === "tool_call_update") {
      expect(update.toolCall.status).toBe("completed");
      expect(update.toolCall.title).toBe("");
    }
  });

  it("maps plans, usage, titles and commands", () => {
    const plan = mapSessionUpdate(
      asUpdate({
        sessionUpdate: "plan",
        entries: [{ content: "step", priority: "high", status: "pending" }],
      }),
    );
    expect(plan?.type).toBe("plan");
    if (plan?.type === "plan") expect(plan.entries[0]?.content).toBe("step");

    const usage = mapSessionUpdate(
      asUpdate({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0 } }),
    );
    expect(usage?.type).toBe("usage");
    if (usage?.type === "usage") {
      expect(usage.used).toBe(10);
      expect(usage.size).toBe(100);
      expect(usage.cost).toEqual({ amount: 0 });
    }

    expect(
      mapSessionUpdate(asUpdate({ sessionUpdate: "session_info_update", title: "T" })),
    ).toEqual({ type: "session_title", title: "T" });
    expect(
      mapSessionUpdate(asUpdate({ sessionUpdate: "session_info_update", title: null })),
    ).toBeNull();

    const commands = mapSessionUpdate(
      asUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "cmd", description: "d" }],
      }),
    );
    expect(commands?.type).toBe("available_commands");
  });

  it("returns null for unsupported update kinds without throwing", () => {
    expect(mapSessionUpdate(asUpdate({ sessionUpdate: "notice" }))).toBeNull();
    expect(mapSessionUpdate(asUpdate({ sessionUpdate: "plan_removed" }))).toBeNull();
    expect(mapSessionUpdate(asUpdate({ sessionUpdate: "something-unknown" }))).toBeNull();
  });
});
