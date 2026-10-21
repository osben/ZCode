import { afterEach, describe, expect, it } from "vitest";
import {
  startRelay,
  TestSocket,
  upgradeStatus,
  type RelayHarness,
} from "./support/relayHarness.js";

const cleanup: RelayHarness[] = [];
afterEach(async () => {
  for (const harness of cleanup.splice(0)) await harness.close();
});

async function relay(overrides?: Parameters<typeof startRelay>[0]) {
  const harness = await startRelay(overrides);
  cleanup.push(harness);
  return harness;
}

/** Opens a device socket for a registered SID and waits for auth_ack. */
async function device(harness: RelayHarness, bearer: string, sid: string) {
  const socket = await harness.connect(bearer, "device");
  socket.send({
    type: "auth_init",
    device_sid: sid,
    meta: { name: "laptop", platform: "mac", version: "1.0.0" },
  });
  const ack = await socket.next("auth_ack");
  return { socket, ack };
}

async function terminal(harness: RelayHarness, bearer: string, sid: string) {
  const socket = await harness.connect(bearer, "terminal");
  socket.send({ type: "auth_init", device_sid: sid });
  const ack = await socket.next("auth_ack");
  return { socket, ack };
}

describe("pairing and forwarding", () => {
  it("pairs a device with a terminal, forwards data both ways and answers heartbeats", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);

    const dev = await device(harness, bearer, sid);
    expect(dev.ack).toMatchObject({ device_sid: sid, pair_status: "waiting" });

    const term = await terminal(harness, bearer, sid);
    expect(term.ack).toMatchObject({ device_sid: sid, pair_status: "matched" });
    expect(term.ack.terminal_sid).not.toBe("");
    expect(await dev.socket.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });

    term.socket.send({ type: "data", payload: { step: 1 } });
    expect(await dev.socket.next("data")).toMatchObject({ payload: { step: 1 } });
    dev.socket.send({ type: "data", payload: { step: 2 } });
    expect(await term.socket.next("data")).toMatchObject({ payload: { step: 2 } });

    dev.socket.send({ type: "pair_status_query", client_ts: 1 });
    expect(await dev.socket.next("pair_status_ack")).toMatchObject({
      pair_status: "matched",
      terminal_sid: term.ack.terminal_sid,
    });
    term.socket.send({ type: "pair_status_query" });
    expect(await term.socket.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });

    dev.socket.terminate();
    term.socket.terminate();
  });

  it("pairs when the terminal authenticates before the device", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const term = await terminal(harness, bearer, sid);
    expect(term.ack.pair_status).toBe("waiting");
    const dev = await device(harness, bearer, sid);
    expect(dev.ack.pair_status).toBe("matched");
    expect(await term.socket.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });
    dev.socket.terminate();
    term.socket.terminate();
  });

  it("tells the terminal the device is offline, closes it, and lets the device reconnect", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const dev = await device(harness, bearer, sid);
    const term = await terminal(harness, bearer, sid);
    await dev.socket.next("pair_status_ack");

    dev.socket.terminate();
    expect(await term.socket.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
    expect(await term.socket.next("error")).toMatchObject({ code: "DEVICE_OFFLINE" });
    expect(await term.socket.closedWith()).toBeTypeOf("number");

    const again = await device(harness, bearer, sid);
    expect(again.ack.pair_status).toBe("waiting");
    const reconnectedTerminal = await terminal(harness, bearer, sid);
    expect(reconnectedTerminal.ack.pair_status).toBe("matched");
    again.socket.terminate();
    reconnectedTerminal.socket.terminate();
  });

  it("tells the device it is waiting when the terminal disconnects and keeps the device open", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const dev = await device(harness, bearer, sid);
    const term = await terminal(harness, bearer, sid);
    await dev.socket.next("pair_status_ack");
    term.socket.terminate();
    expect(await dev.socket.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
    dev.socket.send({ type: "pair_status_query" });
    expect(await dev.socket.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
    dev.socket.terminate();
  });

  it("replaces an older owner of the same slot with KICKED, and its late close keeps the new owner", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const first = await device(harness, bearer, sid);
    const term = await terminal(harness, bearer, sid);
    await first.socket.next("pair_status_ack");

    const second = await device(harness, bearer, sid);
    expect(await first.socket.next("error")).toMatchObject({ code: "KICKED" });
    expect(await first.socket.closedWith()).toBeTypeOf("number");
    expect(await term.socket.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });

    // The old socket's close has already been processed by now; the new owner must still receive traffic.
    term.socket.send({ type: "data", payload: "still-routed" });
    expect(await second.socket.next("data")).toMatchObject({ payload: "still-routed" });
    second.socket.send({ type: "pair_status_query" });
    expect(await second.socket.next("pair_status_ack")).toMatchObject({ pair_status: "matched" });
    second.socket.terminate();
    term.socket.terminate();
  });

  it("answers AUTH_FAILED and closes for an unknown or foreign device SID", async () => {
    const harness = await relay();
    const owner = await harness.relayJwt("user-1");
    const { device_sid: sid } = await harness.register(owner);

    const unknown = await harness.connect(await harness.relayJwt("user-1"), "device");
    unknown.send({ type: "auth_init", device_sid: "no-such-device" });
    expect(await unknown.next("error")).toMatchObject({ code: "AUTH_FAILED" });
    expect(await unknown.closedWith()).toBeTypeOf("number");

    const foreign = await harness.connect(await harness.relayJwt("user-2"), "terminal");
    foreign.send({ type: "auth_init", device_sid: sid });
    expect(await foreign.next("error")).toMatchObject({ code: "AUTH_FAILED" });
    expect(await foreign.closedWith()).toBeTypeOf("number");
  });

  it("answers AUTH_FAILED after a device was deleted and closes the socket", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    await harness.api("POST", "/api/v1/remote/device/delete", {
      bearer,
      body: { device_sid: sid },
    });
    const socket = await harness.connect(bearer, "device");
    socket.send({ type: "auth_init", device_sid: sid });
    expect(await socket.next("error")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("refuses to delete a device while it is online and deletes it after it goes offline", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const dev = await device(harness, bearer, sid);
    expect(
      await harness.api("POST", "/api/v1/remote/device/delete", {
        bearer,
        body: { device_sid: sid },
      }),
    ).toMatchObject({ status: 400, body: { code: 3005 } });
    dev.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      await harness.api("POST", "/api/v1/remote/device/delete", {
        bearer,
        body: { device_sid: sid },
      }),
    ).toMatchObject({ status: 200, body: { code: 0 } });
  });

  it("reports online state and the device's self-reported meta in the device list", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const dev = await device(harness, bearer, sid);
    const listed = await harness.api("GET", "/api/v1/remote/device", { bearer });
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        device_sid: sid,
        online: true,
        meta: { name: "laptop", platform: "mac", version: "1.0.0" },
      }),
    ]);
    dev.socket.terminate();
  });

  it("answers INTERNAL without closing when data arrives while the peer is absent", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const dev = await device(harness, bearer, sid);
    dev.socket.send({ type: "data", payload: "nobody-listening" });
    expect(await dev.socket.next("error")).toMatchObject({ code: "INTERNAL" });
    dev.socket.send({ type: "pair_status_query" });
    expect(await dev.socket.next("pair_status_ack")).toMatchObject({ pair_status: "waiting" });
    dev.socket.terminate();
  });
});

describe("tokens and the upgrade", () => {
  it("rejects a reused token with 401 before upgrade", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);
    const issued = await harness.api("POST", "/api/v1/remote/token", {
      bearer,
      body: { role: "device" },
    });
    const token = (issued.body.data as { token: string }).token;
    const url = `${harness.server.url}?token=${token}`;
    const first = await TestSocket.open(url);
    first.send({ type: "auth_init", device_sid: sid });
    await first.next("auth_ack");
    expect(await upgradeStatus(url)).toBe(401);
    first.terminate();
  });

  it("rejects a missing, unknown or expired token with 401 before upgrade", async () => {
    const harness = await relay();
    expect(await upgradeStatus(harness.server.url)).toBe(401);
    expect(await upgradeStatus(`${harness.server.url}?token=never-issued`)).toBe(401);
  });

  it("refuses a wrong path with 400 and a foreign Web origin with 403", async () => {
    const harness = await relay({ allowedOrigins: ["https://zcode.example.invalid"] });
    const wrongPath = harness.server.url.replace("/api/v1/remote/ws2", "/ws");
    expect(await upgradeStatus(`${wrongPath}?token=x`)).toBe(400);
    const bearer = await harness.relayJwt();
    const issued = await harness.api("POST", "/api/v1/remote/token", {
      bearer,
      body: { role: "device" },
    });
    const token = (issued.body.data as { token: string }).token;
    const socket = new (await import("ws")).WebSocket(`${harness.server.url}?token=${token}`, {
      headers: { Origin: "https://attacker.example.invalid" },
    });
    const status = await new Promise<number | undefined>((resolve) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
      socket.once("open", () => resolve(undefined));
      socket.once("error", () => resolve(undefined));
    });
    expect(status).toBe(403);
  });
});

describe("frame validation and the auth deadline", () => {
  it("answers WRONG_PARAM and closes for traffic before auth_init", async () => {
    const harness = await relay();
    const socket = await harness.connect(await harness.relayJwt(), "device");
    socket.send({ type: "data", payload: "too-early" });
    expect(await socket.next("error")).toMatchObject({ code: "WRONG_PARAM" });
    expect(await socket.closedWith()).toBeTypeOf("number");
  });

  it("answers WRONG_PARAM for a second auth_init, a binary frame, invalid JSON and unknown fields", async () => {
    const harness = await relay();
    const bearer = await harness.relayJwt();
    const { device_sid: sid } = await harness.register(bearer);

    const second = await device(harness, bearer, sid);
    second.socket.send({ type: "auth_init", device_sid: sid });
    expect(await second.socket.next("error")).toMatchObject({ code: "WRONG_PARAM" });
    second.socket.terminate();

    const binary = await harness.connect(bearer, "terminal");
    binary.sendRaw(Buffer.from([1, 2, 3]), true);
    expect(await binary.next("error")).toMatchObject({ code: "WRONG_PARAM" });

    const invalidJson = await harness.connect(bearer, "terminal");
    invalidJson.sendRaw("{not json");
    expect(await invalidJson.next("error")).toMatchObject({ code: "WRONG_PARAM" });

    const extraField = await harness.connect(bearer, "device");
    extraField.send({ type: "auth_init", device_sid: sid, role: "terminal" });
    expect(await extraField.next("error")).toMatchObject({ code: "WRONG_PARAM" });
  });

  it("closes an unauthenticated socket when the auth deadline passes", async () => {
    const harness = await relay({ authTimeoutMs: 150, heartbeatIntervalMs: 50 });
    const socket = await harness.connect(await harness.relayJwt(), "device");
    expect(await socket.next("error")).toMatchObject({ code: "AUTH_FAILED" });
    expect(await socket.closedWith()).toBeTypeOf("number");
  });
});
