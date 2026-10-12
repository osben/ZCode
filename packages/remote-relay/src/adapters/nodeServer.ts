import { createServer } from "node:http";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { RELAY_MAX_MESSAGE_BYTES, RELAY_MAX_CONTROL_BYTES, relayClientMessageSchema } from "@zcode/shared/web-remote-relay";
import type { RelayServer, RelayServerOptions } from "../contract.js";
import { createRelayRegistry } from "../app/relay.js";
import { relayCrypto } from "./auth.js";

function positive(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Relay limits must be positive integers.");
  return value;
}

export async function createRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const now = options.now ?? Date.now;
  const authTimeoutMs = positive(options.authTimeoutMs, 10_000);
  const maxConnections = positive(options.maxConnections, 2000);
  const maxBuffered = positive(options.maxBufferedBytes, 2 * 1024 * 1024);
  const maxTotalBuffered = positive(options.maxTotalBufferedBytes, 64 * 1024 * 1024);
  const registrationLimit = positive(options.registrationsPerMinute, 20);
  const heartbeatInterval = positive(options.heartbeatIntervalMs, 15_000);
  const heartbeatTimeout = positive(options.heartbeatTimeoutMs, 45_000);
  const sockets = new Set<WebSocket>();
  const pongs = new Map<WebSocket, number>();
  const registrationRates = new Map<string, { count: number; until: number }>();
  const registry = createRelayRegistry({ store: options.store, crypto: relayCrypto, now, authTimeoutMs });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_MESSAGE_BYTES, perMessageDeflate: false });
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    const health = path === "/healthz" || path === "/readyz";
    response.writeHead(health ? closing ? 503 : 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ status: health ? closing ? "closing" : "ok" : "not-found" }));
  });
  const normalizeIp = (value: string) => value.startsWith("::ffff:") ? value.slice(7) : value;
  const trusted = new Set((options.trustedProxies ?? []).map(normalizeIp));

  server.on("upgrade", (request, socket, head) => {
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (closing) { reject(503); return; }
    if ((request.url?.length ?? 0) > 1024 || request.url?.split("?")[0] !== "/ws") { reject(400); return; }
    if (sockets.size >= maxConnections) { reject(503); return; }
    if (request.headers.origin && !(options.allowedOrigins ?? []).includes(request.headers.origin)) { reject(403); return; }
    wsServer.handleUpgrade(request, socket, head, ws => wsServer.emit("connection", ws, request));
  });

  wsServer.on("connection", (socket: WebSocket, request) => {
    sockets.add(socket);
    pongs.set(socket, now());
    let sourceIp = normalizeIp(request.socket.remoteAddress ?? "unknown");
    const forwarded = request.headers["x-forwarded-for"];
    if (trusted.has(sourceIp) && typeof forwarded === "string" && forwarded.length <= 512) {
      for (const address of forwarded.split(",").reverse().map(value => normalizeIp(value.trim()))) {
        if (!trusted.has(sourceIp) || !isIP(address)) break;
        sourceIp = address;
      }
    }
    let pendingBytes = 0;
    let chain = Promise.resolve();
    const id = registry.connect({
      send(message, serialized) {
        if (socket.readyState !== WebSocket.OPEN) return false;
        const wire = serialized ?? JSON.stringify(message);
        const bytes = Buffer.byteLength(wire);
        const total = [...sockets].reduce((sum, peer) => sum + peer.bufferedAmount, 0);
        if (bytes > RELAY_MAX_MESSAGE_BYTES || socket.bufferedAmount + bytes > maxBuffered || total + bytes > maxTotalBuffered) {
          options.logger?.warn("transport-pressure");
          socket.close(1013, "Transport capacity exceeded.");
          return false;
        }
        socket.send(wire, error => {
          if (error) { options.logger?.warn("transport-send-failed"); registry.disconnect(id); socket.terminate(); }
        });
        return true;
      },
      close: () => socket.close(),
    });
    socket.on("pong", () => pongs.set(socket, now()));
    socket.on("error", () => { options.logger?.warn("transport-error"); registry.disconnect(id); socket.terminate(); });
    socket.on("close", () => { sockets.delete(socket); pongs.delete(socket); registry.disconnect(id); });
    socket.on("message", (raw, isBinary) => {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (isBinary || bytes.byteLength > RELAY_MAX_MESSAGE_BYTES || pendingBytes + bytes.byteLength > maxBuffered) {
        registry.reject(id, "WRONG_PARAM", "Message limit exceeded.");
        return;
      }
      pendingBytes += bytes.byteLength;
      chain = chain.then(async () => {
        if (socket.readyState !== WebSocket.OPEN || closing) return;
        const wire = bytes.toString("utf8");
        let value: unknown;
        try { value = JSON.parse(wire); } catch { registry.reject(id, "WRONG_PARAM", "Invalid JSON."); return; }
        const parsed = relayClientMessageSchema.safeParse(value);
        if (!parsed.success || (parsed.data.type !== "data" && bytes.byteLength > RELAY_MAX_CONTROL_BYTES)) {
          registry.reject(id, "WRONG_PARAM", "Invalid relay message.");
          return;
        }
        if (parsed.data.type === "device_register_init") {
          let rate = registrationRates.get(sourceIp);
          if (!rate || rate.until <= now()) {
            if (registrationRates.size >= maxConnections * 2 && !registrationRates.has(sourceIp)) {
              registry.reject(id, "INTERNAL", "Registration capacity exceeded."); return;
            }
            rate = { count: 0, until: now() + 60_000 };
            registrationRates.set(sourceIp, rate);
          }
          if (++rate.count > registrationLimit) { registry.reject(id, "INTERNAL", "Registration rate exceeded."); return; }
        }
        await registry.receive(id, parsed.data, wire);
      }).catch(() => {
        options.logger?.error("relay-operation-failed");
        registry.reject(id, "INTERNAL", "Relay operation failed.");
      }).finally(() => { pendingBytes -= bytes.byteLength; });
    });
  });

  const timer = setInterval(() => {
    registry.sweep();
    for (const [ip, rate] of registrationRates) if (rate.until <= now()) registrationRates.delete(ip);
    for (const socket of sockets) {
      if (now() - (pongs.get(socket) ?? 0) >= heartbeatTimeout) { socket.terminate(); continue; }
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, Math.min(authTimeoutMs, heartbeatInterval));
  timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 3031, options.host ?? "127.0.0.1", resolve);
    });
  } catch (error) { clearInterval(timer); await options.store.close(); throw error; }
  server.on("error", () => options.logger?.error("http-server-error"));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay address unavailable.");
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `ws://${host}:${address.port}/ws`,
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(timer);
        registry.close();
        for (const socket of sockets) socket.terminate();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await new Promise<void>(resolve => wsServer.close(() => resolve()));
        await options.store.close();
      })();
      return closePromise;
    },
  };
}
