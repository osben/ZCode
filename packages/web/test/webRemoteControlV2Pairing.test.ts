import { describe, expect, it, vi } from "vitest";
import { createWebRemoteControlV2PairingClient } from "#src/web-remote-control/index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("pairing code exchange", () => {
  it("posts only the pairing code and returns the relay JWT", async () => {
    const fetcher = vi.fn(async () =>
      json({ code: 0, msg: "ok", data: { jwt: "relay-jwt", expires_in: 3600 } }),
    );
    const client = createWebRemoteControlV2PairingClient("https://relay.example.com", fetcher);
    expect(await client.exchange("code-1", new AbortController().signal)).toBe("relay-jwt");
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://relay.example.com/api/v1/remote/session");
    expect(JSON.parse(String(init.body))).toEqual({ pairing_code: "code-1" });
  });

  it("maps rejection to auth-required and server errors to relay-unavailable without leaking text", async () => {
    const reject = createWebRemoteControlV2PairingClient("https://r.example", async () =>
      json({ code: 401, msg: "secret-detail" }, 401),
    );
    await expect(reject.exchange("code", new AbortController().signal)).rejects.toMatchObject({
      reason: "auth-required",
    });
    const down = createWebRemoteControlV2PairingClient("https://r.example", async () => {
      throw new Error("code-leak");
    });
    const error = await down.exchange("code", new AbortController().signal).catch((e) => e);
    expect(error).toMatchObject({ reason: "relay-unavailable" });
    expect(String(error.message)).not.toContain("code-leak");
  });
});
