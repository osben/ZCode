import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  parseWebRemoteControlRelayV2HttpResponse,
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
} from "@zcode/shared/web-remote-relay";
import { createRelayServer } from "../../src/adapters/nodeServer.js";
import { createRelayDeviceStore } from "../../src/adapters/deviceStore.js";
import { createRelaySessionService } from "../../src/adapters/session.js";
import type { RelayServerOptions, RelayServer } from "../../src/contract.js";
import { ENROLLMENT_SECRET, identityKey, ISSUER, loginJwt, relaySigningKey } from "./keys.js";

export interface HttpResult {
  status: number;
  headers: Headers;
  body: { code: number; msg: string; data?: unknown };
}

export interface RelayHarness {
  server: RelayServer;
  /** Origin-only HTTP base, e.g. http://127.0.0.1:41234. */
  http: string;
  /** Issues an account login JWT for a user, as the desktop or terminal login would hold. */
  login(userId?: string): string;
  /** Exchanges a login JWT for a relay JWT through POST /session. */
  relayJwt(userId?: string): Promise<string>;
  api(
    method: string,
    path: string,
    options?: { bearer?: string; body?: unknown; rawBody?: string; origin?: string },
  ): Promise<HttpResult>;
  /** Requests a one-time token for the role and opens a WebSocket with it. */
  connect(bearer: string, role: "device" | "terminal"): Promise<TestSocket>;
  /** Registers a device for the user and returns its record. */
  register(bearer: string, mid?: string): Promise<{ device_sid: string }>;
  close(): Promise<void>;
}

export const DEFAULT_TEST_LIMITS = {
  registrationsPerMinute: 10_000,
  authTimeoutMs: 15_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 45_000,
} as const;

/** Starts a real relay on loopback with a temporary SQLite file and a fixture login issuer. */
export async function startRelay(
  overrides: Partial<RelayServerOptions> & {
    allowedOrigins?: readonly string[];
    identityMode?: "zai-jwt" | "device-key";
    /** Shared relay signing key so two harnesses can prove cross-mode JWT rejection. */
    signingKey?: Record<string, unknown>;
  } = {},
): Promise<RelayHarness> {
  const { identityMode = "zai-jwt", signingKey, ...serverOverrides } = overrides;
  const directory = await mkdtemp(join(tmpdir(), "relay-harness-"));
  const identity = identityKey("EdDSA", "login-1");
  const store = await createRelayDeviceStore({ path: join(directory, "relay.sqlite") });
  const session = createRelaySessionService({
    signingKeys: [signingKey ?? relaySigningKey("relay-1").privateJwk],
    ttlSeconds: 3600,
    identity:
      identityMode === "device-key"
        ? { mode: "device-key", enrollmentSecret: ENROLLMENT_SECRET, keys: store }
        : { issuer: ISSUER, userClaim: "sub", keys: [identity.publicJwk] },
    now: () => Date.now(),
  });
  const server = await createRelayServer({
    ...DEFAULT_TEST_LIMITS,
    port: 0,
    host: "127.0.0.1",
    store,
    session,
    ...serverOverrides,
  });
  const http = server.url.replace(/^ws:/, "http:").replace(/\/api\/v1\/remote\/ws2$/, "");

  const harness: RelayHarness = {
    server,
    http,
    login(userId = "user-1") {
      return loginJwt(identity, "EdDSA", { sub: userId }, Math.floor(Date.now() / 1000));
    },
    async relayJwt(userId = "user-1") {
      const result = await harness.api("POST", "/api/v1/remote/session", {
        body: { identity_token: harness.login(userId) },
      });
      const data = result.body.data as { jwt: string };
      return data.jwt;
    },
    async api(method, path, options = {}) {
      const headers: Record<string, string> = {};
      if (options.bearer !== undefined) headers.Authorization = `Bearer ${options.bearer}`;
      if (options.origin !== undefined) headers.Origin = options.origin;
      let payload: string | undefined;
      if (options.rawBody !== undefined) payload = options.rawBody;
      else if (options.body !== undefined) payload = JSON.stringify(options.body);
      if (payload !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${http}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text.length ? (JSON.parse(text) as HttpResult["body"]) : { code: -1, msg: "" },
      };
    },
    async connect(bearer, role) {
      const token = await harness.api("POST", "/api/v1/remote/token", {
        bearer,
        body: { role },
      });
      const issued = parseWebRemoteControlRelayV2HttpResponse("token", token.body);
      if (!issued || issued.code !== 0) throw new Error(`token request failed: ${token.status}`);
      return TestSocket.open(`${server.url}?token=${encodeURIComponent(issued.data.token)}`);
    },
    async register(bearer, mid = "mid-fixture") {
      const result = await harness.api("POST", "/api/v1/remote/device", {
        bearer,
        body: { device_mid: mid },
      });
      const record = result.body.data as { device_sid: string };
      return record;
    },
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return harness;
}

/** WebSocket client that parses every relay frame with the shared V2 schema and fails on drift. */
export class TestSocket {
  private readonly inbox: WebRemoteControlRelayV2IncomingMessage[] = [];
  private readonly waiters: Array<(message: WebRemoteControlRelayV2IncomingMessage) => void> = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private closeResult?: { code: number; reason: string };

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const parsed = parseWebRemoteControlRelayV2IncomingMessage(JSON.parse(raw.toString()));
      if (!parsed) throw new Error(`relay sent a frame outside the V2 schema: ${raw.toString()}`);
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.inbox.push(parsed);
    });
    this.closed = new Promise((resolve) => {
      socket.once("close", (code, reason) => {
        this.closeResult = { code, reason: reason.toString() };
        resolve(this.closeResult);
      });
    });
  }

  static async open(url: string): Promise<TestSocket> {
    const socket = new WebSocket(url);
    const client = new TestSocket(socket);
    await once(socket, "open");
    return client;
  }

  send(frame: Record<string, unknown>) {
    this.socket.send(JSON.stringify(frame));
  }

  sendRaw(data: string | Buffer, binary = false) {
    this.socket.send(data, { binary });
  }

  /** Returns the next frame, optionally of a given type. Times out after 3 seconds. */
  next<T extends WebRemoteControlRelayV2IncomingMessage["type"]>(
    type?: T,
  ): Promise<Extract<WebRemoteControlRelayV2IncomingMessage, { type: T }>> {
    const matches = (message: WebRemoteControlRelayV2IncomingMessage) =>
      type === undefined || message.type === type;
    const index = this.inbox.findIndex(matches);
    if (index >= 0) {
      const [message] = this.inbox.splice(index, 1);
      return Promise.resolve(message as never);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${type ?? "frame"}`)),
        3000,
      );
      const waiter = (message: WebRemoteControlRelayV2IncomingMessage) => {
        if (!matches(message)) {
          this.waiters.push(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(message as never);
      };
      this.waiters.push(waiter);
    });
  }

  /** Resolves with the close code once the socket has closed. */
  async closedWith(): Promise<number> {
    return (await this.closed).code;
  }

  terminate() {
    this.socket.terminate();
  }
}

/** Rejected upgrade status code, or undefined when the upgrade succeeded. */
export async function upgradeStatus(url: string): Promise<number | undefined> {
  const socket = new WebSocket(url);
  return new Promise((resolve) => {
    socket.once("open", () => {
      socket.close();
      resolve(undefined);
    });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
    });
    socket.once("error", () => resolve(undefined));
  });
}
