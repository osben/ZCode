import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH,
  parseWebRemoteControlRelayV2OutgoingMessage,
} from "@zcode/shared/web-remote-relay";
import type { RelayServer, RelayServerOptions } from "../contract.js";
import { createRelayRegistry } from "../app/relay.js";
import { createRelayHttpApi, RELAY_API_PREFIX, type RelayHttpResponse } from "../app/http.js";
import { RelayTokenStore, type RelayTokenGrant } from "../domain/tokens.js";

/** Largest client frame the relay accepts (V2 contract: 1 MiB text). */
const MAX_FRAME_BYTES = 1_048_576;
const MAX_HTTP_BODY_BYTES = 16 * 1024;
const WS_PATH = WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH;

function positive(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Relay limits must be positive integers.");
  return value;
}

export async function createRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const now = options.now ?? Date.now;
  const authTimeoutMs = positive(options.authTimeoutMs, 15_000);
  const maxConnections = positive(options.maxConnections, 2000);
  const maxBuffered = positive(options.maxBufferedBytes, 2 * 1024 * 1024);
  const maxTotalBuffered = positive(options.maxTotalBufferedBytes, 64 * 1024 * 1024);
  const registrationLimit = positive(options.registrationsPerMinute, 20);
  const heartbeatInterval = positive(options.heartbeatIntervalMs, 15_000);
  const heartbeatTimeout = positive(options.heartbeatTimeoutMs, 45_000);
  const sockets = new Set<WebSocket>();
  let totalOutboundBytes = 0;
  const pongs = new Map<WebSocket, number>();
  const rateWindows = new Map<string, { count: number; until: number }>();
  const grants = new WeakMap<IncomingMessage, RelayTokenGrant>();
  const tokens = new RelayTokenStore({
    now,
    randomToken: () => randomBytes(16).toString("base64url"),
  });
  const registry = createRelayRegistry({
    devices: options.store,
    now,
    authTimeoutMs,
    randomId: randomUUID,
  });
  const httpApi = createRelayHttpApi({
    devices: options.store,
    live: registry,
    tokens,
    session: options.session,
    now,
  });
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const normalizeIp = (value: string) => (value.startsWith("::ffff:") ? value.slice(7) : value);
  const trusted = new Set((options.trustedProxies ?? []).map(normalizeIp));
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  function sourceIp(request: IncomingMessage): string {
    let address = normalizeIp(request.socket.remoteAddress ?? "unknown");
    const forwarded = request.headers["x-forwarded-for"];
    if (trusted.has(address) && typeof forwarded === "string" && forwarded.length <= 512) {
      for (const candidate of forwarded
        .split(",")
        .reverse()
        .map((value) => normalizeIp(value.trim()))) {
        if (!trusted.has(address) || !isIP(candidate)) break;
        address = candidate;
      }
    }
    return address;
  }

  /** Fixed-window limit per source address for anonymous POSTs (session exchange and device registration). */
  function allowAnonymousWrite(address: string): boolean {
    let window = rateWindows.get(address);
    if (!window || window.until <= now()) {
      if (rateWindows.size >= maxConnections * 2 && !rateWindows.has(address)) return false;
      window = { count: 0, until: now() + 60_000 };
      rateWindows.set(address, window);
    }
    window.count += 1;
    return window.count <= registrationLimit;
  }

  function corsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }

  function writeJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(JSON.stringify(body));
  }

  async function readBody(
    request: IncomingMessage,
  ): Promise<{ body: unknown; bodyError: boolean }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_HTTP_BODY_BYTES) return { body: undefined, bodyError: true };
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return { body: undefined, bodyError: false };
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")), bodyError: false };
    } catch {
      return { body: undefined, bodyError: true };
    }
  }

  const server = createServer(async (request, response) => {
    const path = request.url?.split("?")[0] ?? "";
    const headers = corsHeaders(request);
    if (path === "/healthz" || path === "/readyz") {
      writeJson(response, closing ? 503 : 200, { status: closing ? "closing" : "ok" }, {});
      return;
    }
    if (!path.startsWith(`${RELAY_API_PREFIX}/`)) {
      writeJson(response, 404, { status: "not-found" }, {});
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (closing) {
      writeJson(response, 503, { code: 503, msg: "closing" }, headers);
      return;
    }
    try {
      const { body, bodyError } = await readBody(request);
      const authorization = request.headers.authorization;
      const bearer = authorization?.match(/^Bearer (.+)$/i)?.[1];
      const anonymousWrite =
        request.method === "POST" &&
        (path === `${RELAY_API_PREFIX}/session` || path === `${RELAY_API_PREFIX}/device`);
      let result: RelayHttpResponse;
      if (anonymousWrite && !allowAnonymousWrite(sourceIp(request))) {
        result = { status: 429, body: { code: 4029, msg: "rate limited" } };
      } else {
        result = await httpApi.handle({
          method: request.method ?? "GET",
          path,
          ...(bearer === undefined ? {} : { bearer }),
          body,
          bodyError,
        });
      }
      writeJson(response, result.status, result.body, headers);
    } catch {
      options.logger?.error("relay-http-failed");
      writeJson(response, 500, { code: 500, msg: "internal error" }, headers);
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const reject = (status: number, reason: string) => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (closing) {
      reject(503, "Unavailable");
      return;
    }
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if ((request.url?.length ?? 0) > 2048 || url.pathname !== WS_PATH) {
      reject(400, "Bad Request");
      return;
    }
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      reject(403, "Forbidden");
      return;
    }
    if (sockets.size >= maxConnections) {
      reject(503, "Unavailable");
      return;
    }
    // Consume the one-time token before the upgrade. A failed upgrade does not restore it.
    const grant = tokens.consume(url.searchParams.get("token") ?? "");
    if (!grant) {
      reject(401, "Unauthorized");
      return;
    }
    grants.set(request, grant);
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit("connection", ws, request));
  });

  wsServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const grant = grants.get(request);
    if (!grant) {
      socket.terminate();
      return;
    }
    sockets.add(socket);
    pongs.set(socket, now());
    let pendingBytes = 0;
    let outboundBytes = 0;
    const pendingWrites = new Set<() => void>();
    let chain = Promise.resolve();
    const id = registry.connect(
      {
        send(message) {
          if (socket.readyState !== WebSocket.OPEN) return false;
          const wire = JSON.stringify(message);
          const bytes = Buffer.byteLength(wire);
          if (
            bytes > MAX_FRAME_BYTES ||
            outboundBytes + bytes > maxBuffered ||
            totalOutboundBytes + bytes > maxTotalBuffered
          ) {
            options.logger?.warn("transport-pressure");
            socket.close(1013, "Transport capacity exceeded.");
            return false;
          }
          // Reserve before IO; completion and close release the same frame exactly once.
          outboundBytes += bytes;
          totalOutboundBytes += bytes;
          const release = () => {
            if (!pendingWrites.delete(release)) return;
            outboundBytes -= bytes;
            totalOutboundBytes -= bytes;
          };
          pendingWrites.add(release);
          const failed = () => {
            options.logger?.warn("transport-send-failed");
            registry.disconnect(id);
            socket.terminate();
          };
          try {
            socket.send(wire, (error) => {
              release();
              if (error) failed();
            });
          } catch {
            release();
            failed();
            return false;
          }
          return true;
        },
        close: () => socket.close(),
      },
      grant,
    );
    socket.on("pong", () => pongs.set(socket, now()));
    socket.on("error", () => {
      options.logger?.warn("transport-error");
      registry.disconnect(id);
      socket.terminate();
    });
    socket.on("close", () => {
      for (const release of pendingWrites) release();
      sockets.delete(socket);
      pongs.delete(socket);
      registry.disconnect(id);
    });
    socket.on("message", (raw, isBinary) => {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (
        isBinary ||
        bytes.byteLength > MAX_FRAME_BYTES ||
        pendingBytes + bytes.byteLength > maxBuffered
      ) {
        registry.reject(id, "WRONG_PARAM", "Message limit exceeded.");
        return;
      }
      pendingBytes += bytes.byteLength;
      chain = chain
        .then(async () => {
          if (socket.readyState !== WebSocket.OPEN || closing) return;
          let value: unknown;
          try {
            value = JSON.parse(bytes.toString("utf8"));
          } catch {
            registry.reject(id, "WRONG_PARAM", "Invalid JSON.");
            return;
          }
          const frame = parseWebRemoteControlRelayV2OutgoingMessage(value);
          if (!frame) {
            registry.reject(id, "WRONG_PARAM", "Invalid relay message.");
            return;
          }
          await registry.receive(id, frame);
        })
        .catch(() => {
          options.logger?.error("relay-operation-failed");
          registry.reject(id, "INTERNAL", "Relay operation failed.");
        })
        .finally(() => {
          pendingBytes -= bytes.byteLength;
        });
    });
  });

  const timer = setInterval(
    () => {
      registry.sweep();
      for (const [address, window] of rateWindows)
        if (window.until <= now()) rateWindows.delete(address);
      for (const socket of sockets) {
        if (now() - (pongs.get(socket) ?? 0) >= heartbeatTimeout) {
          socket.terminate();
          continue;
        }
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    },
    Math.min(authTimeoutMs, heartbeatInterval),
  );
  timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 3031, options.host ?? "127.0.0.1", resolve);
    });
  } catch (error) {
    clearInterval(timer);
    await options.store.close();
    throw error;
  }
  server.on("error", () => options.logger?.error("http-server-error"));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay address unavailable.");
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `ws://${host}:${address.port}${WS_PATH}`,
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(timer);
        registry.close();
        for (const socket of sockets) socket.terminate();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await new Promise<void>((resolve) => wsServer.close(() => resolve()));
        await options.store.close();
      })();
      return closePromise;
    },
  };
}
