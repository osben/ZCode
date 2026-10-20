import { describe, expect, it, vi } from "vitest";
import { createWebRemoteControlRelayBearer } from "#src/main/web-remote-relay/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("web remote relay bearer", () => {
  it("exchanges the identity token once at POST /api/v1/remote/session and returns the relay JWT", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ code: 0, msg: "", data: { jwt: "relay-jwt-1", expires_in: 300 } }),
    );
    const bearer = createWebRemoteControlRelayBearer({ fetcher, now: createClock().now });

    const jwt = await bearer.getJwt({
      relayOrigin: "https://relay.example.com",
      identityJwt: "identity-token",
      signal: new AbortController().signal,
    });

    expect(jwt).toBe("relay-jwt-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://relay.example.com/api/v1/remote/session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ identity_token: "identity-token" });
  });

  it("reuses the cached relay JWT until shortly before expiry, then exchanges again", async () => {
    const clock = createClock();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: "", data: { jwt: "relay-1", expires_in: 300 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: "", data: { jwt: "relay-2", expires_in: 300 } }),
      );
    const bearer = createWebRemoteControlRelayBearer({ fetcher, now: clock.now });
    const input = {
      relayOrigin: "https://relay.example.com",
      identityJwt: "identity-token",
      signal: new AbortController().signal,
    };

    expect(await bearer.getJwt(input)).toBe("relay-1");
    clock.advance(200_000);
    expect(await bearer.getJwt(input)).toBe("relay-1");
    clock.advance(100_000);
    expect(await bearer.getJwt(input)).toBe("relay-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight exchange between concurrent callers", async () => {
    let release: (() => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              jsonResponse({ code: 0, msg: "", data: { jwt: "relay-shared", expires_in: 300 } }),
            );
        }),
    );
    const bearer = createWebRemoteControlRelayBearer({ fetcher, now: createClock().now });
    const input = {
      relayOrigin: "https://relay.example.com",
      identityJwt: "identity-token",
      signal: new AbortController().signal,
    };

    const first = bearer.getJwt(input);
    const second = bearer.getJwt(input);
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();

    await expect(Promise.all([first, second])).resolves.toEqual(["relay-shared", "relay-shared"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("drops the cached JWT when invalidated, forcing a new exchange", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: "", data: { jwt: "relay-old", expires_in: 300 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: "", data: { jwt: "relay-new", expires_in: 300 } }),
      );
    const bearer = createWebRemoteControlRelayBearer({ fetcher, now: createClock().now });
    const input = {
      relayOrigin: "https://relay.example.com",
      identityJwt: "identity-token",
      signal: new AbortController().signal,
    };

    expect(await bearer.getJwt(input)).toBe("relay-old");
    bearer.invalidate();
    expect(await bearer.getJwt(input)).toBe("relay-new");
  });

  it("maps a rejected identity to auth-required without exposing the response body or token", async () => {
    const fetcher = vi.fn(
      async () => new Response("identity-token rejected by upstream", { status: 401 }),
    );
    const bearer = createWebRemoteControlRelayBearer({ fetcher, now: createClock().now });

    const error = await bearer
      .getJwt({
        relayOrigin: "https://relay.example.com",
        identityJwt: "identity-token",
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: "auth-required", retryable: false });
    expect(String((error as Error).message)).not.toContain("identity-token");
  });

  it("treats an envelope without a usable JWT as a retryable relay failure", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ code: 0, msg: "", data: { expires_in: 300 } }),
    );
    const bearer = createWebRemoteControlRelayBearer({ fetcher, now: createClock().now });

    await expect(
      bearer.getJwt({
        relayOrigin: "https://relay.example.com",
        identityJwt: "identity-token",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ message: "relay-unavailable" });
  });
});
