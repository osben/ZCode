import { describe, expect, it } from "vitest";

describe("services package entry boundaries", () => {
  it("keeps conversation-share runtime implementations out of the browser-safe root entry", async () => {
    const browserSafeEntry = await import("@zcode/services");

    expect(browserSafeEntry.IConversationShareService).toBeDefined();
    expect(browserSafeEntry.ConversationShareServiceError).toBeDefined();
    expect(browserSafeEntry).not.toHaveProperty("ConversationShareService");
    expect(browserSafeEntry).not.toHaveProperty("ConversationShareHttpClient");
  });

  it("exposes conversation-share runtime implementations from the node entry", async () => {
    const nodeEntry = await import("@zcode/services/node");

    expect(nodeEntry.ConversationShareService).toBeDefined();
    expect(nodeEntry.ConversationShareHttpClient).toBeDefined();
  });

  it("keeps the conversation-share test double out of both published entries", async () => {
    // The mock only serves unit tests; once re-exported it would ship into desktop artifacts via @zcode/services.
    const [browserSafeEntry, nodeEntry] = await Promise.all([
      import("@zcode/services"),
      import("@zcode/services/node"),
    ]);

    expect(browserSafeEntry).not.toHaveProperty("ConversationShareMockApiClient");
    expect(nodeEntry).not.toHaveProperty("ConversationShareMockApiClient");
  });
});
