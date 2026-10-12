import { describe, expect, it } from "vitest";
import { userInputRowSchema } from "../src/zcode-protocol-v4/index.js";

// docs/dynamic-workflow/transcript-and-notifications.md: epilogueStart on userInput rows is a non-negative integer
// index (0 = the whole row is engine text) and may be absent (old transcripts / non-workflow sessions).
const base = {
  rowId: 1,
  entityId: "message-1",
  turnId: "turn-1",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 1,
  kind: "userInput" as const,
  origin: "realUser" as const,
  text: "Summarize\n\n---\nStandard",
};

describe("v4 userInput.epilogueStart", () => {
  it("accepts a non-negative integer, including 0, and absence", () => {
    expect(userInputRowSchema.parse({ ...base, epilogueStart: 9 }).epilogueStart).toBe(9);
    expect(userInputRowSchema.parse({ ...base, epilogueStart: 0 }).epilogueStart).toBe(0);
    expect(userInputRowSchema.parse(base)).not.toHaveProperty("epilogueStart");
  });

  it("rejects negative and fractional offsets", () => {
    expect(userInputRowSchema.safeParse({ ...base, epilogueStart: -1 }).success).toBe(false);
    expect(userInputRowSchema.safeParse({ ...base, epilogueStart: 1.5 }).success).toBe(false);
  });
});
