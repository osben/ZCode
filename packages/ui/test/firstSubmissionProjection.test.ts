import { describe, expect, it } from "vitest";
import { hasAcceptedInputProjection } from "@/v4/conversationProjectionStore.js";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

function snapshot(rows: unknown[], queue: unknown[] = []): ConversationSnapshot {
  return { rows: { window: rows }, queue: { items: queue } } as ConversationSnapshot;
}

describe("first input preview reconciliation (FSL05)", () => {
  it("matches an authoritative user row by original command, independently of ACK order", () => {
    expect(hasAcceptedInputProjection(null, "original")).toBe(false);
    const row = {
      kind: "userInput",
      origin: "realUser",
      sourceCommandId: "original",
      text: "Same text",
    };
    expect(hasAcceptedInputProjection(snapshot([row]), "original")).toBe(true);
    expect(hasAcceptedInputProjection(snapshot([row]), "different-command")).toBe(false);
  });
  it("matches accepted queued input before a transcript row exists", () => {
    expect(
      hasAcceptedInputProjection(snapshot([], [{ sourceCommandId: "original" }]), "original"),
    ).toBe(true);
  });
  it("does not replace the preview with a synthetic row or another command's identical text", () => {
    expect(
      hasAcceptedInputProjection(
        snapshot([
          {
            kind: "userInput",
            origin: "synthetic",
            sourceCommandId: "original",
            text: "Same text",
          },
        ]),
        "original",
      ),
    ).toBe(false);
    expect(
      hasAcceptedInputProjection(
        snapshot([
          { kind: "userInput", origin: "realUser", sourceCommandId: "other", text: "Same text" },
        ]),
        "original",
      ),
    ).toBe(false);
  });
});
