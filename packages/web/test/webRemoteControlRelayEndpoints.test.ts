import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlRelayEndpoints } from "#src/web-remote-control/index.js";

describe("relay endpoints for the web client", () => {
  it("sends HTTP and ws2 to the configured relay, not to the page origin", () => {
    expect(
      resolveWebRemoteControlRelayEndpoints({
        configuredRelayUrl: "wss://relay.example",
        pageOrigin: "https://web.example",
      }),
    ).toEqual({
      wsUrl: "wss://relay.example/api/v1/remote/ws2",
      httpOrigin: "https://relay.example",
    });
  });

  it("keeps an explicit ws2 URL and derives the plain-http origin from ws", () => {
    expect(
      resolveWebRemoteControlRelayEndpoints({
        configuredRelayUrl: "ws://127.0.0.1:3031/api/v1/remote/ws2",
        pageOrigin: "http://localhost:5173",
      }),
    ).toEqual({
      wsUrl: "ws://127.0.0.1:3031/api/v1/remote/ws2",
      httpOrigin: "http://127.0.0.1:3031",
    });
  });

  it("falls back to the page origin for both when nothing is configured", () => {
    for (const configuredRelayUrl of [undefined, "", "   "]) {
      expect(
        resolveWebRemoteControlRelayEndpoints({
          configuredRelayUrl,
          pageOrigin: "https://zcode.example",
        }),
      ).toEqual({
        wsUrl: "wss://zcode.example/api/v1/remote/ws2",
        httpOrigin: "https://zcode.example",
      });
    }
  });
});
