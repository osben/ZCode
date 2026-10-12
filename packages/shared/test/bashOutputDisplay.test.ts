import { describe, expect, it } from "vitest";
import { zcodeSessionEventSchema } from "../src/zcode-protocol/index.js";
import { conversationRowSchema } from "../src/zcode-protocol-v4/index.js";

const display = {
  kind: "bash_output",
  output: "head",
  truncated: true,
  outputPath: "C:\\中文 空格\\output.log",
};
function parseBoth(value: unknown) {
  const event = {
    eventId: "bash-result-event",
    type: "tool.updated",
    sessionId: "session",
    seq: 1,
    timestamp: 1,
    payload: {
      kind: "result",
      toolCallId: "bash",
      toolName: "Bash",
      duration: 1,
      result: { success: true, content: "model preview", display: value },
    },
  };
  const row = {
    kind: "toolCall",
    rowId: 1,
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "bash",
    toolName: "Bash",
    inputText: "",
    status: "success",
    output: { text: "model preview", display: value },
  };
  return [zcodeSessionEventSchema.safeParse(event), conversationRowSchema.safeParse(row)];
}
describe("Bash output display wire contract", () => {
  it("preserves display on the legacy event and V4 row", () => {
    for (const parsed of parseBoth(display)) {
      expect(parsed.success).toBe(true);
      expect(JSON.stringify(parsed)).toContain(JSON.stringify(display));
    }
  });
  // Both channels give the same product result for an unreadable display — **the card has no payload** — but the rejection
  // point differs, and the point decides the cost:
  //   v3 `session/event`: the whole event is dropped; the consumer logs zod issues and continues (zcodeAgentService.ts).
  //   v4 row: display is not gated at the envelope layer (`.catch(undefined)`); the payload is dropped while the row/frame still projects.
  // v4 used to reject at the envelope layer too, but a rejection at that layer rejects the entire frame and tears down the
  // subscription (see the incident notes in zcodeProtocolV4DisplayTolerance.test.ts). Boundedness is not relaxed: out-of-bounds payloads still never reach the UI.
  it.each([
    { ...display, output: "x".repeat(150001) },
    { ...display, truncated: "true" },
    { ...display, outputPath: "" },
    { ...display, unbounded: true },
  ])("两条通道都不携带越界/畸形 display", (invalid) => {
    const [event, row] = parseBoth(invalid);
    expect(event.success).toBe(false);
    expect(row.success).toBe(true);
    if (row.success && row.data.kind === "toolCall") {
      expect(row.data.output?.display).toBeUndefined();
    }
  });
});
