import { setTimeout as delay } from "node:timers/promises";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRelayV2 } from "@zcode/shared/testing/fake-relay-v2";
import {
  WebRemoteControlTerminalTransport,
  createWebRemoteControlV2TokenClient,
} from "#src/web-remote-control/index.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(
  options: Parameters<typeof createFakeRelayV2>[0] = { users: { jwt: "user-1" } },
  terminalJwt = "jwt",
  tokenFetcher = fetch,
) {
  const relay = await createFakeRelayV2(options);
  cleanup.push(() => relay.close());
  const request = async (path: string, body: unknown) =>
    (
      await (
        await fetch(`${relay.httpUrl}/api/v1/remote/${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()
    ).data;
  const { device_sid: sid } = await request("device", { device_mid: "desktop-mid" });
  const { token } = await request("token", { role: "device" });
  const device = new WebSocket(`${relay.wsUrl}?token=${token}`);
  cleanup.push(() => device.close());
  const received: unknown[] = [];
  device.addEventListener("message", (e) => received.push(JSON.parse(e.data)));
  await new Promise<void>((resolve) =>
    device.addEventListener("open", () => {
      device.send(JSON.stringify({ type: "auth_init", device_sid: sid }));
      resolve();
    }),
  );
  await vi.waitFor(() =>
    expect(received).toContainEqual(expect.objectContaining({ type: "auth_ack" })),
  );
  const states: string[] = [];
  const failures: unknown[] = [];
  const onSendReady = vi.fn();
  const terminal = new WebRemoteControlTerminalTransport({
    relayWsUrl: relay.wsUrl,
    deviceSid: sid,
    deviceMid: "desktop-mid",
    getToken: (signal) =>
      createWebRemoteControlV2TokenClient(relay.httpUrl, tokenFetcher)(terminalJwt, signal),
    onPayload: vi.fn(),
    onStateChange: (state) => states.push(state),
    onFailure: (failure) => failures.push(failure),
    onError: vi.fn(),
    onSendReady,
    reloadPage: vi.fn(),
  });
  cleanup.push(() => terminal.dispose());
  return { relay, terminal, states, failures, sid, received, onSendReady };
}

function controlledTransport() {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    send = vi.fn();
    close() {
      this.readyState = 3;
    }
    constructor() {
      super();
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    receive(value: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
  }
  const states: string[] = [];
  const failures: unknown[] = [];
  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: "wss://relay.example/api/v1/remote/ws2",
    deviceSid: "sid",
    getToken: async () => "one-use",
    WebSocketCtor: FakeSocket as unknown as typeof WebSocket,
    heartbeatAckTimeoutMs: 60000,
    onPayload: vi.fn(),
    onStateChange: (state) => states.push(state),
    onFailure: (failure) => failures.push(failure),
    onError: vi.fn(),
    reloadPage: vi.fn(),
  });
  cleanup.push(() => transport.dispose());
  return { transport, sockets, states, failures };
}

describe("terminal and V2 fake relay wire-level contract", () => {
  it("after the first token body is cut off midway, retries with backoff, obtains a new token, and actually pairs", async () => {
    let partialResponse: ServerResponse | undefined;
    const server = createServer((_request, response) => {
      partialResponse = response;
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": 300 });
      response.write('{"code":0,"msg":"","data":{"token":"');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP test address");
    const tokenFetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (tokenFetcher.mock.calls.length > 1) return fetch(input, init);
      const response = await fetch(`http://127.0.0.1:${address.port}/token`, init);
      // Confirm that fetch has delivered the 200 response headers before cutting the body, to avoid degrading into the existing connection-failure test.
      partialResponse?.destroy();
      return response;
    });
    const h = await fixture(undefined, "jwt", tokenFetcher);
    h.terminal.start();
    await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"), { timeout: 3_000 });
    expect(tokenFetcher).toHaveBeenCalledTimes(2);
    expect(h.states).toContain("reconnecting");
    expect(h.failures).toEqual([]);
    expect(h.relay.messages).toContainEqual(
      expect.objectContaining({
        role: "terminal",
        message: expect.objectContaining({ type: "auth_init", device_sid: h.sid }),
      }),
    );
  });

  it("one-time terminal token → auth_init without role/proof → business passthrough after pairing", async () => {
    const h = await fixture();
    h.terminal.start();
    await vi.waitFor(() => expect(h.states).toContain("paired"));
    expect(h.relay.httpCalls).toContainEqual(
      expect.objectContaining({ path: "/api/v1/remote/token", body: { role: "terminal" } }),
    );
    const auth = h.relay.messages.find((r) => r.role === "terminal")?.message;
    expect(auth).toEqual({
      type: "auth_init",
      device_sid: h.sid,
      meta: { platform: "web", version: "web", name: "mobile-browser" },
      client_ts: expect.any(Number),
    });
    expect((auth as { client_ts: number }).client_ts).toBeLessThan(253402300800);
    expect(
      h.terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "mobile-bootstrap" }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(h.received).toContainEqual(
        expect.objectContaining({
          type: "data",
          payload: { zcode_type: "bootstrap-request", requestId: "mobile-bootstrap" },
        }),
      ),
    );
    expect(h.failures).toEqual([]);
  });
  it("5-second heartbeat carries no SID; after 15 seconds without an ACK, closes the old connection and requests a new token", async () => {
    let drop = false;
    const h = await fixture({
      users: { jwt: "user-1" },
      onMessage: (r) =>
        r.role === "terminal" &&
        (r.message as { type: string }).type === "pair_status_query" &&
        drop
          ? { drop: true }
          : undefined,
    });
    h.terminal.start();
    await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // Recovery probing restarts the shared heartbeat, avoiding the random offset already sampled by the first scheduling.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    h.terminal.suspend();
    const recovery = h.terminal.recoverConnection();
    await delay(60);
    await recovery;
    await vi.advanceTimersByTimeAsync(5000);
    await delay(60);
    const queries = h.relay.messages.filter(
      (r) => r.role === "terminal" && (r.message as { type: string }).type === "pair_status_query",
    );
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries.at(-1)?.message).toEqual({
      type: "pair_status_query",
      client_ts: Math.floor(Date.now() / 1000),
    });
    drop = true;
    const tokens = () =>
      h.relay.httpCalls.filter((r) => (r.body as { role?: string }).role === "terminal").length;
    await vi.advanceTimersByTimeAsync(14999);
    await delay(60);
    expect(tokens()).toBe(1);
    await vi.advanceTimersByTimeAsync(1501);
    await delay(100);
    expect(tokens()).toBe(2);
    expect(h.onSendReady).toHaveBeenLastCalledWith({ kind: "reconnected-socket" });
  });

  it("network and 5xx errors keep 500ms exponential backoff, capped at 10 seconds", async () => {
    let fail: "server" | "network" | undefined = "server";
    const h = await fixture({
      users: { jwt: "user-1" },
      onHttp: (call) =>
        (call.body as { role?: string }).role === "terminal" && fail
          ? fail === "server"
            ? { status: 503 }
            : { networkError: true }
          : undefined,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    h.terminal.start();
    await delay(60);
    const tokens = () =>
      h.relay.httpCalls.filter((r) => (r.body as { role?: string }).role === "terminal").length;
    let count = 1;
    for (const ms of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
      await vi.advanceTimersByTimeAsync(ms - 1);
      await delay(30);
      expect(tokens()).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      await delay(60);
      expect(tokens()).toBe(++count);
      fail = "network";
    }
    fail = undefined;
    await vi.advanceTimersByTimeAsync(10000);
    await delay(100);
    expect(h.states.at(-1)).toBe("paired");
    expect(h.failures).toEqual([]);
  });

  it.each([401, 403])(
    "token HTTP %s stops retrying; returning to the foreground cannot revive a terminal state",
    async (status) => {
      const h = await fixture({
        users: { jwt: "user-1" },
        onHttp: (call) =>
          (call.body as { role?: string }).role === "terminal" ? { status } : undefined,
      });
      h.terminal.start();
      await vi.waitFor(() =>
        expect(h.failures).toEqual([
          { reason: status === 401 ? "auth-required" : "relay-unavailable", message: undefined },
        ]),
      );
      await expect(h.terminal.recoverConnection()).rejects.toThrow();
      h.terminal.recoverInBackground();
      expect(h.states.at(-1)).toBe("error");
    },
  );

  it("an account-ownership error across accounts is not retried; WRONG_PARAM keeps the parameter-error classification", async () => {
    const h = await fixture({ users: { jwt: "owner", other: "other" } }, "other");
    h.terminal.start();
    await vi.waitFor(() =>
      expect(h.failures).toContainEqual({ reason: "device-not-owned", message: undefined }),
    );
    const f = await fixture({
      users: { jwt: "owner" },
      onMessage: (r) => (r.role === "terminal" ? { error: "WRONG_PARAM" } : undefined),
    });
    f.terminal.start();
    await vi.waitFor(() =>
      expect(f.failures).toContainEqual({
        reason: "invalid-mobile-connection",
        message: undefined,
      }),
    );
  });

  it("the first KICKED waits 2~5 seconds and requests a token again; the second one terminates as session-conflict", async () => {
    const h = await fixture();
    h.terminal.start();
    await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    h.relay.sendError({ role: "terminal" }, "KICKED");
    await delay(60);
    const tokens = () =>
      h.relay.httpCalls.filter((r) => (r.body as { role?: string }).role === "terminal").length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(tokens()).toBe(1);
    await vi.advanceTimersByTimeAsync(3001);
    await delay(100);
    expect(h.states.at(-1)).toBe("paired");
    expect(tokens()).toBe(2);
    h.relay.sendError({ role: "terminal" }, "KICKED");
    await delay(60);
    expect(h.failures).toEqual([{ reason: "session-conflict", message: undefined }]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(tokens()).toBe(2);
  });

  it("a late token arriving after dispose cannot create a socket", async () => {
    let resolveToken!: (value: string) => void;
    const getToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const ctor = vi.fn();
    const terminal = new WebRemoteControlTerminalTransport({
      relayWsUrl: "wss://relay.example/api/v1/remote/ws2",
      deviceSid: "sid",
      getToken,
      WebSocketCtor: ctor as unknown as typeof WebSocket,
      onPayload: vi.fn(),
      onStateChange: vi.fn(),
      onFailure: vi.fn(),
      onError: vi.fn(),
      reloadPage: vi.fn(),
    });
    terminal.start();
    terminal.dispose();
    resolveToken("late-token");
    await Promise.resolve();
    expect(ctor).not.toHaveBeenCalled();
  });
  it("after suspending a socket with an unfinished handshake, a late open/ACK must not trigger pairing in the background", async () => {
    const h = controlledTransport();
    h.transport.start();
    await Promise.resolve();
    const socket = h.sockets[0];
    h.transport.suspend();
    socket.open();
    socket.receive({ type: "auth_ack", device_sid: "sid", pair_status: "matched" });
    await Promise.resolve();
    expect(socket.send).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toBe("suspended");
  });

  it("waiting near timeout gets KICKED, and the new connection restarts the timer without keeping the old generation's timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = controlledTransport();
    h.transport.start();
    await Promise.resolve();
    h.sockets[0].open();
    h.sockets[0].receive({ type: "auth_ack", device_sid: "sid", pair_status: "waiting" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29000);
    h.sockets[0].receive({ type: "error", code: "KICKED" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3500);
    h.sockets[1].open();
    h.sockets[1].receive({ type: "auth_ack", device_sid: "sid", pair_status: "waiting" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29999);
    expect(h.failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.failures).toContainEqual(expect.objectContaining({ reason: "desktop-disconnected" }));
  });
});
