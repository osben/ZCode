import { describe, expect, it, vi } from "vitest";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";

// specs/acp-agent-runtime.md "S6": only an ACP agent session has a config binding, so a subscribe of any
// other session must not reach the binding store (a synchronous database read on the worker).

function publisherFor(provider: string) {
  return {
    getSnapshot: () => ({ config: { provider } }),
    seedExternalAgentConfig: vi.fn(),
  };
}

function gatewayWith(getSeed: ReturnType<typeof vi.fn>) {
  // The seed step uses only `host`, so the gateway is built without the rest of its wiring.
  const gateway = Object.create(ConversationV4Gateway.prototype) as {
    host: unknown;
    seedPublisherExternalAgentConfig(
      sessionId: string,
      publisher: ReturnType<typeof publisherFor>,
    ): Promise<void>;
  };
  gateway.host = { getSessionExternalAgentConfigSeed: getSeed, onError: vi.fn() };
  return gateway;
}

describe("external agent config seed gate", () => {
  it("does not read the binding store for a non-ACP session", async () => {
    const getSeed = vi.fn(async () => null);
    const publisher = publisherFor("deepseek");
    await gatewayWith(getSeed).seedPublisherExternalAgentConfig("zc-plain", publisher);
    expect(getSeed).not.toHaveBeenCalled();
    expect(publisher.seedExternalAgentConfig).not.toHaveBeenCalled();
  });

  it("reads the binding and seeds the projection for an ACP session", async () => {
    const seed = { agentId: "opencode", options: [] };
    const getSeed = vi.fn(async () => seed);
    const publisher = publisherFor("acp:opencode");
    await gatewayWith(getSeed).seedPublisherExternalAgentConfig("zc-acp", publisher);
    expect(getSeed).toHaveBeenCalledWith("zc-acp", "acp:opencode");
    expect(publisher.seedExternalAgentConfig).toHaveBeenCalledWith(seed);
  });
});
