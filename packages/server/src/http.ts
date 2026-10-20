/* eslint-disable max-lines -- HTTP, WebSocket, and static-asset routes are registered together to preserve one authorization order. */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import * as nodePath from "node:path";
import { basename, extname, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  ProxyChannel,
  type ISocket,
} from "@zcode/rpc";
import {
  SourceServerWorkspaceIdentityChannelServer,
  type SourceServerWorkspaceIdentityMapper,
  type TopicResourcePeers,
} from "@zcode/services/node";
import { createWindowHostControllerRuntime } from "@zcode/services/window-controller";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IBotsService,
  IProviderProvisioningTargetService,
  IZCodeTaskService,
  IWindowControllerService,
} from "@zcode/services";
import {
  botProviders,
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  serverRemoteInfoOutputSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_COMPATIBILITY_MANIFEST,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";
import { createRemoteConnectionStore } from "./remoteConnectionStore.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper,
  resourcePeers?: TopicResourcePeers,
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // Wrap with logging middleware so all RPC calls are recorded consistently.
  const loggedServer = new LoggingChannelServer(rawServer, log);
  // Workspace identity mapping is applied only when the host supplies a mapper (standalone server-cli).
  const server = workspaceIdentityMapper
    ? new SourceServerWorkspaceIdentityChannelServer(loggedServer, workspaceIdentityMapper)
    : loggedServer;
  const agentService = services.getOptional(IZCodeAgentService);
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const peer = reverseClient
    ? resourcePeers?.attach(reverseClient.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL))
    : undefined;
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(peer ? peer.wrapAgent(agentService) : agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning carries credentials across Environments and is available only to a trusted Desktop
  // host. Ordinary Web remote/replayable clients cannot access the target-write interface even if they
  // know the channel name.
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  const taskService = services.getOptional(IZCodeTaskService);
  const needsStandaloneController =
    clientMode === "web-remote-replayable" &&
    taskService &&
    !services.getOptional(IWindowControllerService);
  // This private Host observer is independent of the browser's terminal handshake
  // and route. Never publish its trusted facade as a client-accessible channel.
  const controllerConnectionScope =
    needsStandaloneController && agentService
      ? createZCodeAgentConnectionScope(agentService, {
          connectionId: `server-controller-${randomUUID()}`,
          clientMode: "desktop-continuous",
          role: "trusted-host-relay",
        })
      : undefined;
  // Standalone Web uses the same list contract as Desktop, but has no window Host
  // to register it. Keep this projection and its passive observers socket-owned.
  const controller = needsStandaloneController
    ? createWindowHostControllerRuntime({
        createId: randomUUID,
        maxSources: 64,
        maxConcurrentSourceRefreshes: 4,
        resolveSource: (scope) => ({
          scope: { kind: "local", ...scope },
          taskService,
          agentService: controllerConnectionScope?.service,
          sourceAvailability: "online",
        }),
        onSourceError: (_scope, operation, error) =>
          log("[standalone-controller]", operation, error),
      })
    : undefined;
  if (controller) {
    server.registerChannel(
      IWindowControllerService.channelName,
      ProxyChannel.fromService(controller.service),
    );
  }
  socket.onClose(() => {
    controller?.dispose();
    void controllerConnectionScope
      ?.dispose()
      .catch((error) => log("[standalone-controller] dispose failed", error));
    peer?.dispose();
    reverseClient?.dispose();
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** Remote connections opened in web mode, keyed by unguessable IDs until a WebSocket claims them. */
const remoteConnections = createRemoteConnectionStore();

const DEFAULT_HTTP_HOST = "127.0.0.1";

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export interface HttpServerOptions {
  topicResourcePeers?: TopicResourcePeers;
  serverId?: string;
  virtualProjects?: boolean;
  migrationFailedPathCount?: number;
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
  name?: string;
  host?: string;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveHttpServerId(options: HttpServerOptions = {}): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(
  options: HttpServerOptions,
  authToken: string | undefined,
): ServerRemoteInfo {
  return serverRemoteInfoOutputSchema.parse({
    serverId: resolveHttpServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    // Derived from the token only, so the advertised state cannot diverge from enforcement.
    authRequired: Boolean(authToken),
    workspaces: resolveServerWorkspaces(options),
    compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    migration: { failedPathCount: options.migrationFailedPathCount ?? 0 },
    identity: { osUser: userInfo().username, hostname: hostname() },
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      ...(options.virtualProjects ? { virtualProjects: true } : {}),
      processResourceTelemetry: true,
    },
  });
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const authorization = c.req.header("authorization");
  if (
    authorization?.startsWith("Bearer ") &&
    authorization.slice("Bearer ".length).trim() === token
  ) {
    return true;
  }
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isApiOrWsPath(pathname: string): boolean {
  return (
    pathname === "/ws" ||
    pathname.startsWith("/ws/") ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
  );
}

function tryDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const maxPathDecodeRounds = 4;

/**
 * Hono routes on decodeURI(rawPath), so `/%61pi/...` reaches `/api/...` handlers while the raw
 * URL pathname does not look protected. Check a superset of every form the router could see:
 * the routed and raw paths, repeatedly decoded, lowercased, with slashes normalized.
 */
function targetsApiOrWs(c: Context): boolean {
  for (const seed of [c.req.path, new URL(c.req.url).pathname]) {
    let current = seed;
    for (let round = 0; round <= maxPathDecodeRounds; round += 1) {
      const normalized = current
        .toLowerCase()
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/");
      if (isApiOrWsPath(normalized)) {
        return true;
      }
      const decoded = tryDecodeURIComponent(current);
      if (decoded === current) {
        break;
      }
      current = decoded;
    }
  }
  return false;
}

/** Deny by default: only GET/HEAD for static Web assets may skip the token. */
function requiresToken(c: Context): boolean {
  return (c.req.method !== "GET" && c.req.method !== "HEAD") || targetsApiOrWs(c);
}

// Drive-qualified paths ("Z:/x", "Z:\x", "Z:x") resolve on Windows to another drive, including subst
// and mapped network drives, so they are rejected before static resolution.
const DRIVE_QUALIFIED_PATH_PATTERN = /^[a-zA-Z]:/;

export function isPathDriveQualified(pathname: string): boolean {
  return DRIVE_QUALIFIED_PATH_PATTERN.test(pathname);
}

// pathApi is injectable for cross-platform tests. On Windows, path.relative returns an absolute path
// across drives (for example "Z:\marker.txt") that does not start with "..", so it was misread as
// inside the static root. An absolute relative result is always treated as outside.
export function isInsideDirectory(
  root: string,
  candidate: string,
  pathApi: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> = nodePath,
): boolean {
  const diff = pathApi.relative(root, candidate);
  if (pathApi.isAbsolute(diff)) return false;
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${pathApi.sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  // Reject drive-qualified paths before resolve, including the %3A-decoded form. Respond 404 without
  // entering the SPA fallback.
  if (isPathDriveQualified(relativePath)) {
    return null;
  }
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // Enter the SPA fallback only when no static asset matches, preserving 404 semantics for real file errors.
  }

  if (!spaFallback) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve the listen host, defaulting to loopback. Without a token, /api/rpc-host-capability and
 * /api/connect-remote are open to anyone who can reach the listener, so non-loopback binds must fail
 * closed (same rule as zcode-server-cli).
 */
export function resolveHttpListenHost(
  options: Pick<HttpServerOptions, "host" | "authToken">,
): string {
  const host = options.host?.trim() || DEFAULT_HTTP_HOST;
  if (!options.authToken?.trim() && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to listen on non-loopback host ${host} without authentication; ` +
        "set ZCODE_SERVER_AUTH_TOKEN or bind ZCODE_SERVER_HOST/HOST to 127.0.0.1",
    );
  }
  return host;
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const authToken = options.authToken?.trim() || undefined;
  const host = resolveHttpListenHost(options);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  if (authToken) {
    app.use("*", async (c, next) => {
      const validToken = hasValidLiteToken(c, authToken);
      if (!requiresToken(c) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options, authToken)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // Plain `/ws` is always terminal-client; browser or other clients cannot promote themselves to trusted
  // host by setting the legacy mode header.
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(
          ws.raw as WebSocket,
          services,
          "web-remote-replayable",
          options.workspaceIdentityMapper,
        );
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(
        ws.raw as WebSocket,
        services,
        "desktop-continuous",
        options.workspaceIdentityMapper,
        options.topicResourcePeers,
      );
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Start a remote connection in web mode.
  app.post("/api/connect-remote", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = remoteConnections.add(connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bot business failures must preserve their retryable status for the HTTP provider. Returning 200
      // would make the webhook/gateway think the message was consumed, like committing a Telegram offset
      // too early.
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  // WebSocket endpoint for remote connections, bridging remote services to the browser.
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      let claimedConnection: RemoteConnection | undefined;
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.claim(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          claimedConnection = connection;

          // Wrap remote services in a ServiceCollection and reuse exposeOnChannelServer for consistent registration.
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(
            ws.raw as WebSocket,
            remoteServices,
            "web-remote-replayable",
            options.workspaceIdentityMapper,
          );
        },
        onClose() {
          claimedConnection?.dispose();
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const spaFallback = (options.spaFallback ?? true) && !targetsApiOrWs(c);
      const filePath = await resolveStaticFile(staticRoot, pathname, spaFallback);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    const address = server.address();
    if (typeof address === "object" && address) {
      const listenHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
      log(`http://${listenHost}:${address.port}`);
    } else {
      log(`http://${host}:${port}`);
    }
  });

  injectWebSocket(server);

  return server;
}
