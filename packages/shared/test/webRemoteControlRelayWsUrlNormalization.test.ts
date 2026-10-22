import { describe, expect, it } from "vitest";
import { WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH } from "../src/web-remote-relay/index.js";
import {
  WEB_REMOTE_CONTROL_RELAY_WS_PATH,
  normalizeConfiguredWebRemoteControlRelayWsUrl,
} from "../src/zcodeEndpoint.js";

// specs/relay-v2-migration.md §11.1: configured relay values are an origin or an explicit V2 WS URL.
describe("normalizeConfiguredWebRemoteControlRelayWsUrl", () => {
  it("maps a bare origin and the legacy V1 /ws endpoint to the V2 WS path", () => {
    for (const value of [
      "wss://relay.example.com/ws",
      "wss://relay.example.com/ws/",
      "wss://relay.example.com",
      "wss://relay.example.com/",
      "https://relay.example.com",
      " wss://relay.example.com/ws ",
    ]) {
      expect(normalizeConfiguredWebRemoteControlRelayWsUrl(value)).toBe(
        "wss://relay.example.com/api/v1/remote/ws2",
      );
    }
    expect(normalizeConfiguredWebRemoteControlRelayWsUrl("http://localhost:8787/ws")).toBe(
      "ws://localhost:8787/api/v1/remote/ws2",
    );
  });

  it("keeps an explicit WS URL verbatim", () => {
    expect(
      normalizeConfiguredWebRemoteControlRelayWsUrl("wss://relay.example.com/api/v1/remote/ws2"),
    ).toBe("wss://relay.example.com/api/v1/remote/ws2");
    expect(normalizeConfiguredWebRemoteControlRelayWsUrl("ws://localhost:8787/custom")).toBe(
      "ws://localhost:8787/custom",
    );
  });

  it("returns null when nothing is configured", () => {
    expect(normalizeConfiguredWebRemoteControlRelayWsUrl(undefined)).toBeNull();
    expect(normalizeConfiguredWebRemoteControlRelayWsUrl(null)).toBeNull();
    expect(normalizeConfiguredWebRemoteControlRelayWsUrl("   ")).toBeNull();
  });

  it("keeps an unparsable value verbatim so the transport reports it", () => {
    expect(normalizeConfiguredWebRemoteControlRelayWsUrl("not a url")).toBe("not a url");
  });

  it("uses the same WS path as the relay V2 contract", () => {
    expect(WEB_REMOTE_CONTROL_RELAY_WS_PATH).toBe(WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH);
  });
});
