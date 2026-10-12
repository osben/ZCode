import { createHmac } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer } from "../src/adapters/nodeServer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const key = "fixture-key";
const meta = { platform: "fixture", version: "fixture", name: "fixture" };

async function server(maxBufferedBytes: number, maxTotalBufferedBytes: number) {
  const relay = await createRelayServer({
    port: 0,
    maxBufferedBytes,
    maxTotalBufferedBytes,
    store: {
      register: async () => {
        throw new Error("Fixture does not register");
      },
      get: async (sid) => ({ sid, key }),
      touch: async () => {},
      close: async () => {},
    },
  });
  cleanup.push(relay.close);
  return relay;
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  const messages: any[] = [];
  const waiters: Array<(message: any) => void> = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiting = waiters.shift();
    if (waiting) waiting(message);
    else messages.push(message);
  });
  await once(socket, "open");
  return {
    socket,
    send: (value: unknown) => socket.send(JSON.stringify(value)),
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise<any>((resolve) => waiters.push(resolve)),
  };
}

async function pair(url: string, sid: string) {
  const authenticate = async (role: "device" | "terminal") => {
    const peer = await connect(url);
    peer.send({ type: "auth_init", role, device_sid: sid, meta });
    const challenge = await peer.next();
    peer.send({
      type: "auth_response",
      device_sid: sid,
      proof: createHmac("sha256", key)
        .update(`${challenge.nonce}|${role}|${sid}`)
        .digest("base64url"),
    });
    expect(await peer.next()).toMatchObject({ type: "auth_ack" });
    return peer;
  };
  const device = await authenticate("device");
  const terminal = await authenticate("terminal");
  expect(await device.next()).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });
  return { device, terminal };
}

function delayWriteCompletions() {
  const original = WebSocket.prototype.send;
  const complete: Array<() => void> = [];
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (data, options, callback) {
    const done = typeof options === "function" ? options : callback;
    if (done && typeof data === "string" && JSON.parse(data).type === "data") {
      // Keep real socket IO; delay only the external write-completion callback.
      original.call(this, data, {});
      complete.push(() => done());
    } else {
      original.call(this, data, options, callback);
    }
  });
  return complete;
}

it("bounds all pending writes and releases closed sockets without double-releasing late callbacks", async () => {
  const relay = await server(8000, 7000);
  const [a, b, c, d, e] = await Promise.all(
    ["a", "b", "c", "d", "e"].map((sid) => pair(relay.url, sid)),
  );
  const complete = delayWriteCompletions();
  const frame = { type: "data", payload: "x".repeat(3000) };
  a.terminal.send(frame);
  expect(await a.device.next()).toEqual(frame);
  b.terminal.send(frame);
  expect(await b.device.next()).toEqual(frame);
  const cClosed = once(c.device.socket, "close");
  c.terminal.send(frame);
  expect((await cClosed)[0]).toBe(1013);

  const aClosed = once(a.device.socket, "close");
  a.device.socket.close();
  await aClosed;
  // Receipt of the terminal's waiting status is a barrier for server-side close cleanup.
  expect(await a.terminal.next()).toMatchObject({ pair_status: "waiting" });
  d.terminal.send(frame);
  expect(await d.device.next()).toEqual(frame);
  complete[0]!();
  const eClosed = once(e.device.socket, "close");
  e.terminal.send(frame);
  expect((await eClosed)[0]).toBe(1013);
  complete[1]!();
  complete[2]!();
  d.terminal.send(frame);
  expect(await d.device.next()).toEqual(frame);
});

it("enforces the per-socket budget independently of the aggregate budget", async () => {
  const relay = await server(4000, 12000);
  const a = await pair(relay.url, "a");
  const b = await pair(relay.url, "b");
  delayWriteCompletions();
  const frame = { type: "data", payload: "x".repeat(3000) };
  a.terminal.send(frame);
  expect(await a.device.next()).toEqual(frame);
  const closed = once(a.device.socket, "close");
  a.terminal.send(frame);
  expect((await closed)[0]).toBe(1013);
  b.terminal.send(frame);
  expect(await b.device.next()).toEqual(frame);
});
