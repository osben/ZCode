import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebRemoteControlDeviceTransport } from "../../desktop/src/main/webRemoteControlTransport.js";
import { createNodeWebRemoteControlRelayAuthProvider } from "../../desktop/src/main/webRemoteControlRelayAuthProvider.js";
import { WebRemoteControlTerminalTransport } from "../../web/src/webRemoteControlTransport.js";
import { createBrowserWebRemoteControlRelayAuthProvider } from "../../web/src/webRemoteControlRelayAuthProvider.js";
import { createRelayServer } from "../src/adapters/nodeServer.js";

// Desktop 的遥测间接读取 Electron app；Node 集成测试只替换原生边界，保留真实传输和认证。
vi.mock("electron", async () => {
  const { tmpdir } = await import("node:os");
  return { app: { isPackaged: false, getPath: () => tmpdir() } };
});

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});

it("pairs the unmodified Desktop and browser transports with real HMAC proofs", async () => {
  const records = new Map<string, { sid: string; key: string }>();
  const server = await createRelayServer({
    port: 0,
    store: {
      register: async (_mid, key) => {
        const record = { sid: "compat-device", key };
        records.set(record.sid, record);
        return record;
      },
      get: async (sid) => records.get(sid),
      close: async () => {},
    },
  });
  close.push(server.close);
  let registered: (auth: { deviceSid: string; passHash: string }) => void;
  const authReady = new Promise<{ deviceSid: string; passHash: string }>((resolve) => {
    registered = resolve;
  });
  let devicePaired: () => void;
  const deviceReady = new Promise<void>((resolve) => {
    devicePaired = resolve;
  });
  let received: (payload: unknown) => void;
  const input = new Promise<unknown>((resolve) => {
    received = resolve;
  });
  const errors: string[] = [];
  const authProvider = createNodeWebRemoteControlRelayAuthProvider();
  const device = new WebRemoteControlDeviceTransport({
    relayWsUrl: server.url,
    deviceMid: "compat-machine",
    auth: {
      mode: "register",
      passHash: authProvider.createPassHash(authProvider.createPassword()),
    },
    meta: { platform: "fixture", version: "fixture", name: "fixture" },
    authProvider,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    onRegisteredAuth: (auth) => registered(auth),
    onStateChange: (state) => {
      if (state === "paired") devicePaired();
    },
    onPayload: (payload) => received(payload),
    onError: (error) => errors.push(error.message),
    onInvalidPersistedAuth: async () => {
      throw new Error("Unexpected compatibility auth reset");
    },
  });
  close.push(() => device.dispose());
  device.start();
  const auth = await authReady;
  let browserPaired: () => void;
  const browserReady = new Promise<void>((resolve) => {
    browserPaired = resolve;
  });
  const browser = new WebRemoteControlTerminalTransport({
    relayWsUrl: server.url,
    ...auth,
    WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
    authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
    onStateChange: (state) => {
      if (state === "paired") browserPaired();
    },
    onPayload: () => {},
    onFailure: (failure) => errors.push(failure.reason),
    onError: (error) => errors.push(error.message),
    reloadPage: () => errors.push("unexpected reload"),
  });
  close.push(() => browser.dispose());
  browser.start();
  await Promise.all([deviceReady, browserReady]);
  const payload = { zcode_type: "workspace-list-request" as const, requestId: "compat-request" };
  expect(browser.sendPayload(payload)).toBe(true);
  expect(await input).toEqual(payload);
  expect(errors).toEqual([]);
});
