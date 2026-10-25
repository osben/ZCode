import { describe, expect, it } from "vitest";
import { aggregateModelStreamToTextResult } from "../src/model/stream-to-text-result.js";
import type { ModelStreamEvent } from "@zcode/contracts";

async function fromEvents(events: readonly ModelStreamEvent[]) {
  return aggregateModelStreamToTextResult(
    (async function* () {
      for (const event of events) yield event;
    })(),
  );
}

describe("stream-to-text-result aggregation (SIWC streaming enforcement)", () => {
  it("aggregates text, reasoning, tool calls, and finish into a text result", async () => {
    const result = await fromEvents([
      { type: "start" },
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "thinking " },
      { type: "reasoning_delta", id: "r1", text: "hard" },
      { type: "reasoning_end", id: "r1", providerMetadata: { encrypted: "abc" } },
      { type: "text_start", id: "t1" },
      { type: "text_delta", id: "t1", text: "Hello " },
      { type: "text_delta", id: "t1", text: "world" },
      { type: "text_end", id: "t1" },
      {
        type: "tool_call",
        toolCall: { id: "call_1", name: "read_file", input: { path: "a.ts" } },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5 },
        providerMetadata: { requestId: "req_1" },
      },
    ]);
    expect(result.text).toBe("Hello world");
    expect(result.finishReason).toBe("tool-calls");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.reasoning).toEqual([
      { type: "reasoning", text: "thinking hard", providerOptions: { encrypted: "abc" } },
    ]);
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(result.providerMetadata).toEqual({ requestId: "req_1" });
  });

  it("propagates stream error events", async () => {
    const failure = new Error("stream broke");
    await expect(fromEvents([{ type: "start" }, { type: "error", error: failure }])).rejects.toBe(
      failure,
    );
  });

  it("rejects streams that end without a finish/usage event", async () => {
    await expect(
      fromEvents([{ type: "start" }, { type: "text_delta", text: "partial" }]),
    ).rejects.toThrow(/finish event/u);
  });
});
