import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer } from "../src/adapters/nodeServer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const meta = { platform: "fixture", version: "fixture", name: "fixture" };

async function connect(url: string) {
  const socket = new WebSocket(url);
  const queued: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queued.push(value);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
  });
  return {
    socket,
    send: (value: unknown) => socket.send(JSON.stringify(value)),
    next: () =>
      queued.length
        ? Promise.resolve(queued.shift())
        : new Promise<any>((resolve) => waiters.push(resolve)),
  };
}

async function fixtureServer(overrides: Record<string, unknown> = {}) {
  const records = new Map<string, { sid: string; key: string }>();
  const server = await createRelayServer({
    port: 0,
    store: {
      register: async (mid: string, key: string) => {
        const identity = `${mid}:${key}`;
        const record = records.get(identity) ?? { sid: `device-${records.size + 1}`, key };
        records.set(identity, record);
        return record;
      },
      get: async (sid: string) => [...records.values()].find((record) => record.sid === sid),
      touch: async () => {},
      close: async () => {},
    },
    ...overrides,
  });
  cleanup.push(server.close);
  return server;
}

async function registered(url: string, key = "fixture-key") {
  const device = await connect(url);
  device.send({ type: "device_register_init", device_mid: "shared-machine", pass_hash: key, meta });
  const ack = await device.next();
  expect(ack.type).toBe("device_register_ack");
  expect(await authenticate(device, ack.device_sid, key, "device")).toMatchObject({
    pair_status: "waiting",
  });
  return { device, sid: ack.device_sid as string, key };
}

async function paired(url: string, key = "fixture-key") {
  const target = await registered(url, key);
  const terminal = await connect(url);
  expect(await authenticate(terminal, target.sid, key, "terminal")).toMatchObject({
    pair_status: "matched",
  });
  await target.device.next();
  return { ...target, terminal };
}

async function authenticate(
  peer: Awaited<ReturnType<typeof connect>>,
  sid: string,
  key: string,
  role: "device" | "terminal",
) {
  peer.send({ type: "auth_init", role, device_sid: sid, meta });
  const challenge = await peer.next();
  expect(challenge.type).toBe("auth_challenge");
  peer.send({
    type: "auth_response",
    device_sid: sid,
    proof: createHmac("sha256", key)
      .update(`${challenge.nonce}|${role}|${sid}`)
      .digest("base64url"),
  });
  return peer.next();
}

describe("relay through real WebSocket connections", () => {
  it("timestamps only valid admitted proofs, excluding invalid proofs and duplicate devices", async () => {
    const record = { sid: "admitted-device", key: "fixture-key" };
    const touches: string[] = [];
    const server = await fixtureServer({
      store: {
        register: async () => record,
        get: async () => record,
        touch: async (sid: string) => {
          touches.push(sid);
        },
        close: async () => {},
      },
    });
    const invalid = await connect(server.url);
    expect(await authenticate(invalid, record.sid, "invalid-key", "terminal")).toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(touches).toEqual([]);
    const device = await connect(server.url);
    expect(await authenticate(device, record.sid, record.key, "device")).toMatchObject({
      type: "auth_ack",
      pair_status: "waiting",
    });
    expect(touches).toEqual([record.sid]);
    const duplicate = await connect(server.url);
    expect(await authenticate(duplicate, record.sid, record.key, "device")).toMatchObject({
      code: "KICKED",
    });
    expect(touches).toEqual([record.sid]);
    const browser = await connect(server.url);
    expect(await authenticate(browser, record.sid, record.key, "terminal")).toMatchObject({
      type: "auth_ack",
      pair_status: "matched",
    });
    expect(touches).toEqual([record.sid, record.sid]);
  });

  it("keeps the active browser when the authentication timestamp cannot be committed", async () => {
    const record = { sid: "store-failure-device", key: "fixture-key" };
    let failTouch = false;
    const server = await fixtureServer({
      store: {
        register: async () => record,
        get: async () => record,
        touch: async () => {
          if (failTouch) throw new Error("Fixture store unavailable");
        },
        close: async () => {},
      },
    });
    const device = await connect(server.url);
    await authenticate(device, record.sid, record.key, "device");
    const browser = await connect(server.url);
    await authenticate(browser, record.sid, record.key, "terminal");
    await device.next();
    failTouch = true;
    const replacement = await connect(server.url);
    expect(await authenticate(replacement, record.sid, record.key, "terminal")).toMatchObject({
      type: "error",
      code: "INTERNAL",
    });
    browser.send({ type: "data", payload: "original-browser-still-active" });
    expect(await device.next()).toMatchObject({
      type: "data",
      payload: "original-browser-still-active",
    });
  });

  it("reserves the device admission while persistence waits and ignores a late result after disconnect", async () => {
    const record = { sid: "pending-device", key: "fixture-key" };
    let complete: () => void;
    let entered: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const touching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let delayTouch = true;
    const server = await fixtureServer({
      store: {
        register: async () => record,
        get: async () => record,
        touch: async () => {
          if (delayTouch) {
            entered();
            await pending;
          }
        },
        close: async () => {},
      },
    });
    const first = await connect(server.url);
    first.send({ type: "auth_init", role: "device", device_sid: record.sid, meta });
    const challenge = await first.next();
    first.send({
      type: "auth_response",
      device_sid: record.sid,
      proof: createHmac("sha256", record.key)
        .update(`${challenge.nonce}|device|${record.sid}`)
        .digest("base64url"),
    });
    await touching;
    const duplicate = await connect(server.url);
    expect(await authenticate(duplicate, record.sid, record.key, "device")).toMatchObject({
      code: "KICKED",
    });
    delayTouch = false;
    // The pending socket closes while its store operation is still in flight.
    const closed = new Promise<void>((resolve) => first.socket.once("close", resolve));
    first.socket.close();
    await closed;
    const replacement = await connect(server.url);
    expect(await authenticate(replacement, record.sid, record.key, "device")).toMatchObject({
      type: "auth_ack",
      pair_status: "waiting",
    });
    complete!();
    replacement.send({ type: "pair_status_query", device_sid: record.sid });
    expect(await replacement.next()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
    });
  });

  it("isolates two registrations sharing one machine ID", async () => {
    const server = await fixtureServer();
    const a = await paired(server.url, "key-a");
    const b = await paired(server.url, "key-b");
    expect(a.sid).not.toBe(b.sid);
    a.terminal.send({ type: "data", payload: { window: "a" } });
    expect(await a.device.next()).toEqual({ type: "data", payload: { window: "a" } });
    b.device.send({ type: "pair_status_query", device_sid: b.sid });
    expect(await b.device.next()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "matched",
    });
    b.terminal.send({ type: "data", payload: { window: "b" } });
    expect(await b.device.next()).toEqual({ type: "data", payload: { window: "b" } });
  });

  it("replaces an authenticated browser without late close detaching its replacement", async () => {
    const server = await fixtureServer();
    const target = await paired(server.url);
    const replacement = await connect(server.url);
    expect(await authenticate(replacement, target.sid, target.key, "terminal")).toMatchObject({
      pair_status: "matched",
    });
    expect(await target.terminal.next()).toMatchObject({ type: "error", code: "KICKED" });
    await target.device.next();
    if (target.terminal.socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => target.terminal.socket.once("close", resolve));
    }
    replacement.send({ type: "data", payload: { replacement: true } });
    expect(await target.device.next()).toEqual({ type: "data", payload: { replacement: true } });
  });

  it("rejects invalid authentication without disturbing the active browser", async () => {
    const server = await fixtureServer();
    const target = await paired(server.url);
    const attacker = await connect(server.url);
    expect(await authenticate(attacker, target.sid, "wrong-key", "terminal")).toMatchObject({
      code: "AUTH_FAILED",
    });
    target.terminal.send({ type: "data", payload: "still-active" });
    expect(await target.device.next()).toEqual({ type: "data", payload: "still-active" });
  });

  it("keeps the existing Desktop when another device claims its SID", async () => {
    const server = await fixtureServer();
    const target = await paired(server.url);
    const duplicate = await connect(server.url);
    expect(await authenticate(duplicate, target.sid, target.key, "device")).toMatchObject({
      code: "KICKED",
    });
    target.device.send({ type: "data", payload: "original-desktop" });
    expect(await target.terminal.next()).toEqual({ type: "data", payload: "original-desktop" });
  });

  it("rejects data before authorization and expired challenges", async () => {
    let time = 1;
    const server = await fixtureServer({ now: () => time });
    const unauthenticated = await connect(server.url);
    unauthenticated.send({ type: "data", payload: "forbidden" });
    expect(await unauthenticated.next()).toMatchObject({ code: "WRONG_PARAM" });
    const target = await registered(server.url);
    const terminal = await connect(server.url);
    terminal.send({ type: "auth_init", device_sid: target.sid, role: "terminal", meta });
    const challenge = await terminal.next();
    time += 10_000;
    terminal.send({
      type: "auth_response",
      device_sid: target.sid,
      proof: createHmac("sha256", target.key)
        .update(`${challenge.nonce}|terminal|${target.sid}`)
        .digest("base64url"),
    });
    expect(await terminal.next()).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("preserves a full 1 MiB envelope and rejects one byte beyond the transport limit", async () => {
    const server = await fixtureServer();
    const target = await paired(server.url);
    const overhead = Buffer.byteLength(JSON.stringify({ type: "data", payload: "" }));
    const payload = "x".repeat(1024 * 1024 - overhead);
    target.terminal.send({ type: "data", payload });
    expect(await target.device.next()).toEqual({ type: "data", payload });
    const closed = new Promise<void>((resolve) => target.terminal.socket.once("close", resolve));
    target.terminal.send({ type: "data", payload: payload + "x" });
    await closed;
    expect(await target.device.next()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
    });
  });

  it("bounds outbound pressure without inventing a data acknowledgement", async () => {
    const server = await fixtureServer({ maxTotalBufferedBytes: 1024 });
    const target = await paired(server.url);
    const closed = new Promise<void>((resolve) => target.device.socket.once("close", resolve));
    target.terminal.send({ type: "data", payload: "x".repeat(2000) });
    await closed;
    expect(await target.terminal.next()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
    });
  });

  it("does not let forged proxy headers bypass registration admission", async () => {
    const server = await fixtureServer({ registrationsPerMinute: 1 });
    await registered(server.url);
    const second = new WebSocket(server.url, { headers: { "X-Forwarded-For": "203.0.113.2" } });
    const reply = new Promise<any>((resolve) =>
      second.once("message", (raw) => resolve(JSON.parse(raw.toString()))),
    );
    await new Promise<void>((resolve) => second.once("open", resolve));
    second.send(
      JSON.stringify({
        type: "device_register_init",
        device_mid: "other",
        pass_hash: "other-key",
        meta,
      }),
    );
    expect(await reply).toMatchObject({ type: "error", code: "INTERNAL" });
    second.terminate();
  });

  it("registers, authenticates both roles and forwards opaque payloads", async () => {
    const records = new Map<string, { sid: string; key: string }>();
    const server = await createRelayServer({
      port: 0,
      store: {
        register: async (_mid: string, key: string) => {
          const record = { sid: "fixture-device", key };
          records.set(record.sid, record);
          return record;
        },
        get: async (sid: string) => records.get(sid),
        touch: async () => {},
        close: async () => {},
      },
    });
    cleanup.push(server.close);
    const device = await connect(server.url);
    device.send({
      type: "device_register_init",
      device_mid: "machine-1",
      pass_hash: "fixture-key",
      meta,
    });
    const registered = await device.next();
    expect(registered).toMatchObject({ type: "device_register_ack", device_sid: "fixture-device" });
    expect(
      await authenticate(device, registered.device_sid, "fixture-key", "device"),
    ).toMatchObject({ type: "auth_ack", pair_status: "waiting" });
    const terminal = await connect(server.url);
    expect(
      await authenticate(terminal, registered.device_sid, "fixture-key", "terminal"),
    ).toMatchObject({ type: "auth_ack", pair_status: "matched" });
    expect(await device.next()).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });
    const payload = { arbitrary: ["opaque", 42], zcode_type: "future-payload" };
    terminal.send({ type: "data", payload });
    expect(await device.next()).toEqual({ type: "data", payload });
    device.send({ type: "data", payload: { response: true } });
    expect(await terminal.next()).toEqual({ type: "data", payload: { response: true } });
  });
});
