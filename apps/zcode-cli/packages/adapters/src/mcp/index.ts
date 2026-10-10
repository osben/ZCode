import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  Client,
  ClientCredentialsProvider,
  computeScopeUnion,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
  type AuthProvider,
  type OAuthClientProvider,
  type VersionNegotiationMode,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpContentBlock,
  McpOAuthConfig,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
  TraceContext,
} from "@zcode/contracts";
import { ZCODE_MCP_SERVER_REQUEST_ID_META_KEY } from "@zcode/contracts";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import {
  createOfficialMcpAuthFetch,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "./official-auth.js";
import {
  OFFICIAL_MCP_AUTH_META_KEY,
  ZCODE_OFFICIAL_MCP_AUTH_TYPE,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  type NetworkEgressEnvPolicy,
} from "./network.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import {
  createCredentialKeyPrefix,
  type McpOAuthAuthorizationContext,
  type McpOAuthRuntimeOptions,
} from "./oauth.js";
import {
  classifyInteractiveAuthorizationTrigger,
  type InteractiveAuthorizationTrigger,
} from "./oauth-errors.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import {
  createMcpDeadline,
  McpTimeoutError,
  type McpDeadline,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  withTimeout,
} from "./timeout.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// Liveness probes must finish quickly: they run on the settings-page refresh path, and a timeout
// marks the connection dead and triggers reconnect.
const MCP_PING_TIMEOUT_MS = 5_000;
const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
/**
 * Maximum number of temporary span → request ID entries. Normally each is consumed before its
 * tool call ends; only unclaimed entries (such as connection-time requests) remain. A few dozen are
 * enough, solely to prevent unbounded growth in long sessions.
 */
const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * Auth dependencies for official Server MCP. Missing trustedOrigins still fails closed;
   * authHeadersPort is optional, and requests become anonymous when absent so the server can make
   * the authoritative decision.
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * Current ZCode API origin. stdio has no `url` to validate, so only the host can supply
     * targetOrigin; the plugin cannot redirect identity headers to another origin.
     * It must match `resolveZCodeApiOrigin` in trustedOrigins, or the two checks would diverge.
     */
    resolveZCodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  workingDirectory?: string;
}

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * Identity-header payload for official stdio MCP, sent in `_meta` on every outbound protocol message.
 *
 * Failures are sent too (`ok: false` + enumerated reason); without headers, the stdio plugin will
 * not call the official endpoint. The HTTP path instead sends an unauthenticated tools/call from
 * the adapter so the ZCode server returns the authoritative structured error. Passing the reason to
 * the stdio plugin lets it distinguish "not logged in" from "no Coding Plan" for users instead of
 * silently degrading to an unexplained failure.
 */
type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  transport?: McpTransport;
}

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";

class NodeMcpAdapter implements McpPort {
  private readonly adapterInstanceId = randomUUID();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionContext?: McpConnectionContext;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly mcpOAuth?: McpOAuthRuntimeOptions;
  private readonly network?: NetworkEgressEnvPolicy;
  private readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  private readonly telemetry?: McpTelemetryTracker;
  private readonly connectionGenerations = new Map<string, number>();
  private credentialStore?: SharedZCodeCredentialStore;
  /**
   * Temporary slot for official-auth failure classification. Do not read it from the error object:
   * SDK version negotiation wraps OfficialMcpAuthError as a plain Error, invalidating instanceof.
   * Classification by error text is also forbidden. Write it where the error is thrown, then
   * failConnection consumes and immediately clears it.
   */
  private readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();
  /**
   * span → server request ID. Only official MCP writes this (the auth fetch wrapper is the only
   * place that can see response headers); it lets in-band failures (HTTP 200 + `isError`) include
   * the ID in the tool result.
   *
   * Key by span, not traceId: traceId covers the whole top-level session and is shared by multiple
   * calls in that session, causing cross-association. span is scoped to one tool call.
   *
   * Bounded and consumed immediately: if no matching span exists (for example initialize / tools/list
   * have no `_meta`), let the entry age out. Never fall back to "most recent"; that would attach the
   * previous call's ID to this call's failure.
   */
  private readonly serverRequestIdBySpan = new Map<string, string>();
  private readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();
  private readonly records = new Map<string, McpServerRecord>();
  private readonly workingDirectory?: string;

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
  }

  async connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options: McpConnectOptions = {},
  ): Promise<McpConnectionSnapshot> {
    const startedAt = Date.now();
    const serverNames = Object.keys(servers);
    this.logger?.info("MCP configured servers connection started", {
      event: "mcp.configured_servers.connect.started",
      serverCount: serverNames.length,
      serverNames,
      status: "started",
    });
    const configuredNames = new Set(Object.keys(servers));
    await Promise.all(
      Array.from(this.records.keys())
        .filter((name) => !configuredNames.has(name))
        .map((name) => this.disconnectServer(name)),
    );

    await Promise.all(
      Object.entries(servers).map(([name, config]) => {
        const record = this.records.get(name);
        if (
          record?.connecting &&
          record.status.status === "connecting" &&
          record.status.authorization &&
          isDeepStrictEqual(record.config, config)
        ) {
          // Full reconciliation of the same configuration may overlap OAuth callback waiting.
          // Reconnecting closes the original session, invalidating the authorization URL, PKCE/state,
          // and callback already open in the browser. Connection lifecycle can be shared, but the
          // session's 15-second wait budget and AbortSignal must not inherit the settings page's 5-minute budget.
          return this.waitForSharedConnection(name, record, options);
        }
        return this.connectServer(name, config, options);
      }),
    );

    const statuses = await this.status();
    const tools = await this.listTools();
    const statusCounts = Object.values(statuses).reduce<Record<string, number>>(
      (counts, status) => {
        counts[status.status] = (counts[status.status] ?? 0) + 1;
        return counts;
      },
      {},
    );
    this.logger?.info("MCP configured servers connection completed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.configured_servers.connect.completed",
      serverCount: serverNames.length,
      status: "completed",
      statusCounts,
      toolCount: tools.length,
    });
    return {
      statuses,
      tools,
    };
  }

  async connectServer(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerStatus> {
    const startedAt = Date.now();
    const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const generation = this.nextConnectionGeneration(name);
    this.lastOfficialAuthKind.delete(name);
    this.connectionDiagnosticByServer.delete(name);
    this.logger?.info("MCP server connection started", {
      event: "mcp.server.connect.started",
      mcpServerName: name,
      status: "started",
      timeoutMs,
      transport: config.type,
    });
    await this.closeRecord(name);

    if (config.enabled === false) {
      const status = this.createStatus(config, "disabled");
      this.records.set(name, { config, status, tools: [] });
      this.logger?.info("MCP server connection skipped", {
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connect.skipped",
        mcpServerName: name,
        status: "completed",
        transport: config.type,
      });
      return status;
    }

    const abortController = new AbortController();
    const abortExternal = () => {
      abortController.abort(
        options.signal?.reason instanceof Error ? options.signal.reason : undefined,
      );
    };
    if (options.signal?.aborted) {
      abortExternal();
    } else {
      options.signal?.addEventListener("abort", abortExternal, { once: true });
    }

    const connectingStatus = this.createStatus(config, "connecting");
    const record: McpServerRecord = {
      abortController,
      config,
      status: connectingStatus,
      tools: [],
    };
    this.records.set(name, record);
    const connecting = this.openServerConnection({
      config,
      generation,
      name,
      oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
      signal: abortController.signal,
      timeoutMs,
      workingDirectory: options.workingDirectory,
    }).finally(() => {
      options.signal?.removeEventListener("abort", abortExternal);
    });
    record.connecting = connecting;
    // Previously `oauthAuthorizationTimeoutMs` (the session's 15 seconds) was treated as the OAuth
    // transaction lifetime, closing the callback listener after 15 seconds. Users could not finish
    // browser authorization in time (observed successful authorization took about 74 seconds).
    // It is now only **this caller's wait budget**: at the deadline return the current snapshot
    // (including the authorization URL), while the background connection and 300-second auth
    // transaction continue.
    return await this.waitForSharedConnection(name, record, options);
  }

  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    const record = this.records.get(name);
    if (!record) return undefined;

    this.nextConnectionGeneration(name);
    await this.closeRecord(name);
    const status = this.createStatus(record.config, "disconnected");
    this.records.set(name, {
      config: record.config,
      status,
      tools: [],
    });
    return status;
  }

  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Array.from(this.records.entries()).map(([name, record]) => [name, record.status]),
    );
  }

  // Stopping an HTTP/SSE MCP server does not dispatch onclose (there is no persistent stream to
  // close), leaving the record `connected`. Settings refresh would keep returning this stale,
  // "quietly dead" snapshot, making the refresh button look broken. ping is a base MCP protocol
  // method used to make transport liveness explicit.
  async pingServer(name: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") {
      return false;
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    const generation = this.connectionGenerations.get(name) ?? 0;
    try {
      await record.client.ping({ timeout: timeoutMs });
      return true;
    } catch (error) {
      // A JSON-RPC error from the server (for example, ping is unsupported) means the connection
      // itself is alive and must not be torn down.
      if (isPeerAnsweredError(error)) {
        return true;
      }
      if (!this.isCurrentConnection(name, generation)) return false;
      const current = this.records.get(name);
      if (current && current.client === record.client) {
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server did not answer ping",
          failureKind: "unexpected_disconnect",
        });
      }
      this.logger?.warn("MCP server ping failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.server.ping.failed",
        mcpServerName: name,
        status: "failed",
        transport: record.config.type,
      });
      return false;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return Array.from(this.records.values()).flatMap((record) => record.tools);
  }

  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const initialRecord = this.records.get(request.serverName);
    const timeoutMs =
      options.timeoutMs ?? initialRecord?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    const pending = initialRecord?.connecting;
    if (pending) {
      // `connecting` is a shared connection/OAuth-recovery task owned by the adapter. A plain await
      // made tool-caller timeout/abort ineffective; aborting the underlying task would close the
      // callback listener shared by other callers. Limit only this waiter; the record lifecycle
      // continues to own the shared task.
      await waitWithinMcpDeadline(pending, deadline, timeoutMessage, options.signal);
    }

    // Previously there was no recovery after a stdio MCP child process died (for example, an async
    // error crashed node_repl): the connection was created only with the session and not recreated
    // on resume, so the session's tools failed forever. Reconnect a disconnected record once before
    // calling it. Server-process state (such as REPL variables) cannot be restored, but the tool becomes available again.
    const disconnected = this.records.get(request.serverName);
    if (disconnected && disconnected.status.status === "disconnected") {
      await waitWithinMcpDeadline(
        this.reconnectForCall(request.serverName, disconnected.config),
        deadline,
        timeoutMessage,
        options.signal,
      );
    }

    const record = this.records.get(request.serverName);
    if (!record?.client || record.status.status !== "connected") {
      throw new Error(`MCP server is not connected: ${request.serverName}`);
    }

    try {
      return await this.callToolOnClient(
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
      );
    } catch (error) {
      // If a token expires, is revoked, or lacks scope after connection, these auth errors used to
      // bubble up unchanged, exposing a raw error to users with no recovery; OAuth recovery existed
      // only during startup connect. Runtime and connection setup now share the same Phase 2 → Phase 1 orchestration.
      const trigger = classifyInteractiveAuthorizationTrigger(error);
      if (trigger && record.config.type !== "stdio") {
        return await this.recoverToolCallAuthorization({
          error,
          record,
          request,
          deadline,
          timeoutMessage,
          trigger,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      // Handle the race before onclose is dispatched: the SDK throws plain "Not connected" when the
      // transport is already down. Reconnect and retry once only for this definite disconnect
      // error; let all others bubble up unchanged.
      if (!(error instanceof Error) || error.message !== "Not connected") throw error;
      try {
        await waitWithinMcpDeadline(
          this.reconnectForCall(request.serverName, record.config),
          deadline,
          timeoutMessage,
          options.signal,
        );
      } catch (reconnectError) {
        this.logger?.warn("MCP server reconnect failed", {
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          event: "mcp.server.reconnect.failed",
          mcpServerName: request.serverName,
          status: "failed",
        });
        throw error;
      }
      const revived = this.records.get(request.serverName);
      if (!revived?.client || revived.status.status !== "connected") throw error;
      return await this.callToolOnClient(
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
      );
    }
  }

  /** Connection diagnostics are stored per server; tool-call request IDs remain isolated by span. */
  private rememberServerResponse(
    serverName: string,
    response: OfficialMcpServerResponseInfo,
  ): void {
    if (
      !response.spanId &&
      response.rpcMethod !== "tools/call" &&
      this.records.get(serverName)?.status.status === "connecting"
    ) {
      if (response.failureKind) {
        this.connectionDiagnosticByServer.set(serverName, {
          failureKind: response.failureKind,
          ...(response.serverRequestId ? { serverRequestId: response.serverRequestId } : {}),
        });
      }
      return;
    }
    if (!response.spanId) return;
    if (!response.serverRequestId) return;
    // A 401 retry creates two responses for the same span; later writes overwrite earlier ones, so
    // the final response is retained, which is the one to report.
    this.serverRequestIdBySpan.set(response.spanId, response.serverRequestId);
    while (this.serverRequestIdBySpan.size > MAX_TRACKED_SERVER_REQUEST_IDS) {
      const oldest = this.serverRequestIdBySpan.keys().next();
      if (oldest.done) break;
      this.serverRequestIdBySpan.delete(oldest.value);
    }
  }

  /** Get and clear the request ID for this span. Return undefined when absent; do not guess a fallback. */
  private takeServerRequestId(spanId: string | undefined): string | undefined {
    if (!spanId) return undefined;
    const requestId = this.serverRequestIdBySpan.get(spanId);
    if (requestId !== undefined) this.serverRequestIdBySpan.delete(spanId);
    return requestId;
  }

  /**
   * Resolve the identity header for this outbound official-stdio-MCP protocol message.
   * `undefined` means "not an official stdio server"; in that case this key must never appear in
   * `_meta`, or identity headers would be broadcast to an arbitrary third-party plugin.
   */
  private async resolveOfficialStdioAuthMeta(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<OfficialMcpAuthMetaPayload | undefined> {
    if (config.type !== "stdio" || !isOfficialAuthConfig(config) || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    const resolveZCodeApiOrigin = this.officialMcpAuth?.resolveZCodeApiOrigin;
    const logBase = {
      event: "mcp.official_auth.stdio_meta",
      mcpKey: official.mcpKey,
      mcpServerName: serverName,
      module: "adapters.mcp",
    };
    const fail = (reason: OfficialMcpAuthFailureReason): OfficialMcpAuthMetaPayload => {
      // Intentionally do not write lastOfficialAuthKind: failConnection reads that map to classify
      // **connection failures**. A missing stdio identity header does not fail the connection; if
      // recorded here, it could remain until the server disconnects for another reason (such as
      // child-process death) and be logged as the cause, which would mislead. This path is observable
      // through its own event below and the reason sent to the plugin.
      this.logger?.warn("Official MCP stdio auth headers unavailable", {
        ...logBase,
        reason,
        status: "failed",
      });
      return { ok: false, reason };
    };

    // Standalone CLI has no host auth port. Do not silently omit this key: the plugin cannot
    // distinguish "host does not support auth" from "host supports it but I am not logged in";
    // only an explicit reason enables the correct user-facing message.
    if (!authHeadersPort || !trustedOrigins || !resolveZCodeApiOrigin) {
      return fail("official_auth_unavailable");
    }

    // stdio has no URL; the host supplies the origin rather than the plugin. isTrusted is a trivial
    // true assertion here, but still must be called: it validates https, rejects URLs with
    // username/password, and respects the dev-loopback switch.
    //
    // These calls used to be unguarded. Origin resolution depends on settings / runtime environment,
    // and isTrusted is injected; either may throw. Letting the exception bubble would bypass failure
    // classification, so the plugin would not receive `{ok:false, reason}`. That reason is a
    // cross-adapter / host / UI contract that controls messaging and retry behavior. Map failures to
    // official_auth_unavailable: if the host cannot resolve a trusted origin, official auth is
    // unavailable to the plugin. Error text is logged only and never controls flow.
    let targetOrigin: string;
    let trust: Awaited<ReturnType<OfficialMcpTrustedOriginRegistry["isTrusted"]>>;
    try {
      targetOrigin = resolveZCodeApiOrigin();
      trust = await trustedOrigins.isTrusted({
        mcpKey: official.mcpKey,
        origin: targetOrigin,
        pluginId: official.pluginId,
      });
    } catch (error) {
      this.logger?.warn("Official MCP stdio origin resolution failed", {
        ...logBase,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        pluginId: official.pluginId,
      });
      return fail("official_auth_unavailable");
    }
    if (!trust.trusted) {
      this.logger?.warn("Official MCP stdio origin is not trusted", {
        ...logBase,
        detail: trust.detail ?? "unknown",
        pluginId: official.pluginId,
        targetOrigin,
      });
      return fail("official_mcp_origin_untrusted");
    }

    const resolved = await authHeadersPort.resolveHeaders({
      mcpKey: official.mcpKey,
      pluginId: official.pluginId,
      targetOrigin,
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!resolved.ok) return fail(resolved.reason);

    // Record only header names and plan tier, never header values; log retention is uncontrolled.
    this.logger?.debug("Official MCP stdio auth headers attached", {
      ...logBase,
      identityHeaderNames: Object.keys(resolved.headers)
        .map((name) => name.toLowerCase())
        .sort(),
      ...(resolved.headers["Bigmodel-Target-Type"]
        ? { identityTargetType: resolved.headers["Bigmodel-Target-Type"] }
        : {}),
      status: "completed",
    });
    return { ok: true, headers: resolved.headers };
  }

  private async callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<McpToolCallResult> {
    // Tool calls previously had no logs: on timeout, we could not see the budget or distinguish a
    // slow server from a short client budget. Record budget and elapsed time, but only parameter
    // keys (values may contain user input).
    const logBase = {
      event: "mcp.tool.call",
      mcpServerName: request.serverName,
      mcpToolName: request.toolName,
      module: "adapters.mcp",
      timeoutMs,
    };
    const argumentKeys = Object.keys(request.arguments ?? {}).sort();
    this.logger?.debug("MCP tool call started", {
      ...logBase,
      argumentKeys,
      status: "started",
    });

    const startedAt = Date.now();
    try {
      const result = await client.callTool(
        {
          name: request.toolName,
          arguments: request.arguments ?? {},
          ...((request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath)
            ? { _meta: mcpRequestMeta(request) }
            : {}),
        },
        {
          signal,
          timeout: timeoutMs,
          resetTimeoutOnProgress: true,
        },
      );

      const durationMs = Date.now() - startedAt;
      const isError = typeof result.isError === "boolean" ? result.isError : false;
      // Official MCP in-band failures (quota exhausted, no plan) are HTTP 200 + isError, so the
      // wrapper's non-2xx warning does not cover them. The wrapper is also the only place that can
      // see the request ID, so retrieve it by span here.
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      const outcome = {
        ...logBase,
        contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
        durationMs,
        hasStructuredContent: result.structuredContent !== undefined,
        // Business failures (isError) must be counted separately from transport failures.
        isError,
        ...(serverRequestId ? { serverRequestId } : {}),
      };
      if (isError) {
        // Previously, in-band failures were logged only at debug, while production logger's lowest
        // level is Info. Quota exhaustion and similar failures were completely invisible in production logs.
        this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
      } else {
        this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
      }

      const meta = isRecord(result._meta) ? result._meta : undefined;
      return {
        content: Array.isArray(result.content)
          ? (result.content as McpContentBlock[])
          : [{ type: "text", text: "" }],
        structuredContent: result.structuredContent,
        isError: typeof result.isError === "boolean" ? result.isError : undefined,
        // Attach only on failures; on success this is noise. Never overwrite a key already supplied by the server.
        _meta:
          isError && serverRequestId
            ? { ...meta, [ZCODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
            : meta,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      // Identify timeouts: SDK timeout throws MCP error code -32001 (RequestTimeout), while a
      // lower-level fetch abort throws AbortError. Both should be clearly recognizable instead of
      // leaving only a raw message.
      const timedOut =
        /timed?\s*out|timeout/i.test(message) ||
        (error instanceof Error && error.name === "AbortError");
      // Include the request ID for transport failures too: SDK messages for 4xx/5xx do not contain it.
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      this.logger?.warn("MCP tool call failed", {
        ...logBase,
        argumentKeys,
        durationMs,
        error: message,
        ...(serverRequestId ? { serverRequestId } : {}),
        errorName: error instanceof Error ? error.name : "unknown",
        status: "failed",
        timedOut,
        // Duration near the budget means we timed out; well below it means the peer or network failed.
        ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
      });
      throw error;
    }
  }

  private async reconnectForCall(name: string, config: McpServerConfig): Promise<void> {
    this.logger?.warn("MCP server reconnecting after lost connection", {
      event: "mcp.server.reconnect.started",
      mcpServerName: name,
      status: "started",
      transport: config.type,
    });
    await this.connectServer(name, config);
  }

  /**
   * Runtime authentication recovery: Phase 2 interactive authorization → Phase 1 reconnect → retry
   * the original tool call safely at most once.
   *
   * Shares `runInteractiveOAuthAuthorization` with connection setup, so single-flight, fencing, and
   * caller-budget semantics are identical.
   */
  private async recoverToolCallAuthorization(input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpToolCallResult> {
    const { record, request } = input;
    const config = record.config;
    if (config.type === "stdio") throw input.error;
    const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (!oauthConfig) throw input.error;

    this.logger?.warn("MCP tool call requires OAuth authorization", {
      event: "mcp.oauth.tool_call.authorization_required",
      mcpServerName: request.serverName,
      oauthTriggerReason: input.trigger.reason,
      status: "started",
      toolName: request.toolName,
    });

    const recovery = this.ensureToolCallAuthorizationRecovery({
      config,
      name: request.serverName,
      oauthConfig,
      record,
      trigger: input.trigger,
    });
    const recoveredStatus = await waitWithinMcpDeadline(
      recovery,
      input.deadline,
      input.timeoutMessage,
      input.signal,
    );
    if (recoveredStatus.status !== "connected") {
      throw input.error;
    }

    const revived = this.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw input.error;
    return await this.callToolOnClient(
      revived.client,
      request,
      remainingMcpDeadlineMs(input.deadline, input.timeoutMessage),
      input.signal,
    );
  }

  /**
   * Create or reuse runtime OAuth recovery. The adapter-owned record holds the full Phase 2 → Phase 1
   * operation; tool callers may wait but cannot terminate the shared transaction with their own AbortSignal.
   */
  private ensureToolCallAuthorizationRecovery(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const current = this.records.get(input.name);
    if (
      current?.connecting &&
      current.status.status === "connecting" &&
      isDeepStrictEqual(current.config, input.config)
    ) {
      return current.connecting;
    }

    const generation = this.nextConnectionGeneration(input.name);
    const abortController = new AbortController();
    const recoveryRecord: McpServerRecord = {
      abortController,
      config: input.config,
      status: this.createStatus(input.config, "connecting", {
        toolCount: input.record.tools.length,
      }),
      // Runtime tools were already advertised to core. Preserve their descriptors during recovery
      // so the settings page / borrowed port does not report that the tools disappeared.
      tools: input.record.tools,
    };
    this.records.set(input.name, recoveryRecord);
    const connecting = this.runToolCallAuthorizationRecovery({
      abortController,
      config: input.config,
      generation,
      name: input.name,
      oauthConfig: input.oauthConfig,
      previousClient: input.record.client,
      previousTransport: input.record.transport,
      trigger: input.trigger,
    });
    recoveryRecord.connecting = connecting;
    return connecting;
  }

  private async runToolCallAuthorizationRecovery(input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const startedAt = Date.now();
    try {
      // The original transport handshake and token are invalid; the shared owner must retire them.
      // Do not call connectServer, or closeRecord would abort recoveryRecord's own controller and
      // cancel itself.
      await this.closeClientAndTransport(input.name, input.previousClient, input.previousTransport);
      const outcome = await this.runInteractiveOAuthAuthorization({
        config: input.config,
        generation: input.generation,
        name: input.name,
        oauthConfig: input.oauthConfig,
        serverUrl: input.config.url,
        signal: input.abortController.signal,
        trigger: input.trigger,
      });
      if (outcome.status === "authorized" || outcome.status === "already-authorized") {
        return await this.openServerConnection({
          config: input.config,
          generation: input.generation,
          name: input.name,
          oauthAuthorizationAttempted: true,
          signal: input.abortController.signal,
          timeoutMs: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        });
      }
      return await this.failConnection({
        config: input.config,
        error:
          outcome.status === "pending"
            ? new Error(
                `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
              )
            : outcome.error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    } catch (error) {
      // Defensive boundary: the shared recovery promise must be a total operation. Any future
      // orchestration exception must settle the record as failed, not leave a rejected connecting
      // promise that contaminates later snapshots.
      return await this.failConnection({
        config: input.config,
        error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    }
  }

  async close(): Promise<void> {
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      this.nextConnectionGeneration(name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
    this.records.clear();
    this.connectionDiagnosticByServer.clear();
    this.logger?.info("MCP adapter closed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.adapter.closed",
      serverCount,
      status: "completed",
    });
  }

  private waitForSharedConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus> {
    const connecting = record.connecting;
    if (!connecting) return Promise.resolve(record.status);
    if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
      return connecting;
    }

    let abortHandler: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const currentStatus = () => this.records.get(name)?.status ?? record.status;
    const waiters: Promise<McpServerStatus>[] = [connecting];

    const timeoutMs = options.oauthAuthorizationTimeoutMs;
    if (timeoutMs !== undefined) {
      waiters.push(
        new Promise((resolvePromise) => {
          timeoutId = setTimeout(() => resolvePromise(currentStatus()), timeoutMs);
        }),
      );
    }
    if (options.signal) {
      waiters.push(
        new Promise((resolvePromise) => {
          if (options.signal?.aborted) {
            resolvePromise(currentStatus());
            return;
          }
          abortHandler = () => resolvePromise(currentStatus());
          options.signal?.addEventListener("abort", abortHandler, {
            once: true,
          });
        }),
      );
    }

    return Promise.race(waiters).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    });
  }

  private async openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus> {
    const {
      config,
      generation,
      name,
      oauthAuthorizationAttempted = false,
      oauthAuthorizationTimeoutMs,
      signal,
      timeoutMs,
      workingDirectory,
    } = input;
    const startedAt = Date.now();
    let client: McpClient | undefined;
    let connectDurationMs: number | undefined;
    let getRecentStderr: (() => string | undefined) | undefined;
    let listToolsDurationMs: number | undefined;
    let transport: McpTransport | undefined;
    let failureKind: McpServerFailureKind =
      config.type === "stdio" ? "process_start_failed" : "network_unreachable";

    try {
      const transportBundle = await this.createTransport(
        config,
        name,
        generation,
        oauthAuthorizationTimeoutMs,
        workingDirectory,
        signal,
      );
      transport = transportBundle.transport;
      getRecentStderr = this.attachStdioLogging(name, transport);
      client = new Client(
        {
          name: this.clientName,
          version: this.clientVersion,
        },
        {
          versionNegotiation: resolveVersionNegotiation(config, timeoutMs),
        },
      );
      this.updateCurrentRecord(name, generation, {
        client,
        transport,
      });

      const connectStartedAt = Date.now();
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        `MCP server ${name} connection timed out after ${timeoutMs}ms`,
        signal,
      );
      connectDurationMs = Date.now() - connectStartedAt;

      failureKind = "tool_list_failed";
      const listToolsStartedAt = Date.now();
      const listed = await withTimeout(
        client.listTools(),
        timeoutMs,
        `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
        signal,
      );
      listToolsDurationMs = Date.now() - listToolsStartedAt;
      const tools = listed.tools.map((tool) =>
        normalizeMcpToolDescriptor(
          name,
          tool,
          config.timeoutMs,
          // Set only for HTTP. This flag controls whether to **trust structured result identifiers**
          // (quota exhausted / no plan), so the criterion is who produced the result:
          //   - HTTP: result comes from the ZCode backend. The fetch wrapper validates origin for
          //     each request; login state is resolved only for tools/call, and the same trusted
          //     backend returns structured coding_plan_required when missing.
          //   - stdio: result comes from the plugin process and can forge
          //     `{"error_code":"quota_exceeded"}`, showing a misleading "quota exhausted / get Coding
          //     Plan" message above the user's input.
          // The old check `type !== "sse"` also included stdio, making this gate ineffective there.
          // This prevents **result forgery**, not credential leakage (origin validation handles that).
          config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
        ),
      );
      const negotiatedProtocolEra = client.getProtocolEra();
      const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
      const status = this.createStatus(config, "connected", {
        protocolEra: negotiatedProtocolEra,
        toolCount: tools.length,
      });
      if (!this.isCurrentConnection(name, generation)) {
        await this.closeClientAndTransport(name, client, transport);
        return this.records.get(name)?.status ?? status;
      }
      this.connectionDiagnosticByServer.delete(name);
      this.records.set(name, {
        client,
        config,
        status,
        tools,
        transport,
      });
      const mcpTransportPid = getStdioTransportPid(transport);
      const mcpProcessIdentity =
        mcpTransportPid != null && this.connectionContext
          ? this.telemetry?.recordProcessStarted({
              connectionId: this.connectionContext.mcpConnectionId,
              pid: mcpTransportPid,
            })
          : undefined;
      // Death of a stdio MCP child process (for example, an async REPL cell error crashing node_repl)
      // must not be silent: without a log, status remains connected and later calls throw a raw
      // "Not connected." Attach onclose to make unexpected disconnects explicit; active close clears
      // onclose first (see closeClientAndTransport).
      client.onclose = () => {
        if (!this.isCurrentConnection(name, generation)) return;
        const current = this.records.get(name);
        if (!current || current.client !== client) return;
        const recentStderr = getRecentStderr?.();
        const processExit = getStdioTransportExitInfo(transport);
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server connection closed unexpectedly",
          failureKind: "unexpected_disconnect",
        });
        this.logger?.warn("MCP server connection lost", {
          ...this.connectionContext,
          event: "mcp.server.connection_lost",
          mcpServerName: name,
          ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
          ...(mcpProcessIdentity ?? {}),
          ...(processExit
            ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
            : {}),
          status: "failed",
          transport: current.config.type,
          ...(recentStderr ? { stderr: recentStderr } : {}),
        });
        if (
          current.config.type === "stdio" &&
          this.connectionContext &&
          (processExit || !isStdioTransportProcessAlive(transport))
        ) {
          this.telemetry?.recordProcessCrashed({
            connectionId: this.connectionContext.mcpConnectionId,
            exitCode: processExit?.exitCode ?? null,
            signal: processExit?.signal ?? null,
          });
        }
      };
      // Previously, connection logs recorded only transport, so after auto negotiation it was
      // impossible to tell whether modern or legacy was used. Record both configured policy and SDK
      // handshake result so `auto` is not mistaken for the final protocol version.
      // Connection-pool context and stdio transport PID previously were not in the same event, so
      // they could not be correlated with the session,
      // workspace, protocol version, and real child process; stdio PID identifies only the final
      // session transport, not the probe child.
      this.logger?.info("MCP server connected", {
        ...this.connectionContext,
        connectDurationMs,
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connected",
        listToolsDurationMs,
        mcpClientName: this.clientName,
        mcpClientVersion: this.clientVersion,
        mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
        mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
        mcpServerName: name,
        ...(mcpProcessIdentity ?? {}),
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
        status: "completed",
        toolCount: tools.length,
        transport: config.type,
      });
      return status;
    } catch (error) {
      // Previously this waited on a listener opened by the old provider and hard-closed it using the
      // session's 15-second budget. 15 seconds is the caller's wait budget, not the authorization
      // transaction lifetime. Now determine whether interactive auth is needed by error type and
      // hand it to an independent Phase 2 transaction (separate lock, fresh DCR, 300-second transaction TTL).
      const trigger = oauthAuthorizationAttempted
        ? undefined
        : classifyInteractiveAuthorizationTrigger(error);
      const authorizationCodeOAuthConfig =
        trigger && config.type !== "stdio"
          ? resolveAuthorizationCodeOAuthConfig(config)
          : undefined;
      if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
        // On negotiation failure the SDK has closed the transport, so it cannot be reused; Phase 2 also needs no transport.
        await this.closeClientAndTransport(name, client, transport);
        const outcome = await this.runInteractiveOAuthAuthorization({
          config,
          generation,
          name,
          oauthConfig: authorizationCodeOAuthConfig,
          serverUrl: config.url,
          signal,
          trigger,
        });
        if (outcome.status === "authorized" || outcome.status === "already-authorized") {
          return await this.openServerConnection({
            ...input,
            oauthAuthorizationAttempted: true,
          });
        }
        // Client/transport were closed before entering Phase 2, so do not pass them again. Preserve
        // failureKind for diagnostics so the settings page can distinguish "authorization not
        // completed" from network/process failures.
        return this.failConnection({
          config,
          connectDurationMs,
          error:
            outcome.status === "pending"
              ? new Error(
                  `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
                )
              : outcome.error,
          failureKind: "oauth_authorization_failed",
          generation,
          getRecentStderr,
          listToolsDurationMs,
          name,
          startedAt,
        });
      }
      // `protocol_negotiation_failed` and its UI text already existed in shared/i18n, but the
      // adapter never produced that classification. Under auto/pin, a hard failure in the SDK's
      // server/discover probe (for example, a Feishu project MCP returns nonstandard JSON-RPC error
      // HTTP 200 + id:null for an unknown method, whose body fails JSONRPCMessageSchema) fell back
      // to `network_unreachable`, misleading the settings page. Identify SDK negotiation failures
      // by structured error type (SdkErrorCode / isInstance), without matching error text;
      // withTimeout does not wrap errors (timeout.ts passes rejection through), and the cause chain
      // is only a defensive fallback.
      const negotiationFailureKind = isProtocolNegotiationFailure(error)
        ? ("protocol_negotiation_failed" as const)
        : undefined;
      return this.failConnection({
        client,
        config,
        connectDurationMs,
        error,
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
        transport,
        failureKind: negotiationFailureKind ?? failureKind,
      });
    }
  }

  /**
   * Phase 2: interactive authorization.
   *
   * Authorization transaction lifetime is 300 seconds, independent of the caller's wait budget
   * (session: 15 seconds). Caller-side wait limits are applied by `connectServer` /
   * `waitForSharedConnection`; this method does not know about caller budgets.
   */
  private async runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome> {
    try {
      const oauthOptions = this.createAuthorizationCodeOAuthOptions(
        input.config,
        input.name,
        input.generation,
      );
      const credentialStore = oauthOptions?.credentialStore ?? createSharedZCodeCredentialStore();
      const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
      // Final scope for 403 step-up must be the union of config ∪ token.scope ∪ challenge. If
      // reauthorization includes only challenge scopes, the authorization server may revoke scopes
      // granted earlier; the next request can then receive a different challenge and 403 again,
      // creating an authorization loop. Token responses may omit scope (RFC 6749 §3.3), so scopes
      // declared in config must be included explicitly rather than relying only on the token echo.
      let requestedScope: string | undefined = input.oauthConfig.scope;
      if (input.trigger.requiredScope) {
        const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
        requestedScope = computeScopeUnion(
          input.oauthConfig.scope,
          currentPair?.tokens?.scope,
          input.trigger.requiredScope,
        );
      }
      return await runMcpInteractiveAuthorization({
        adapterInstanceId: this.adapterInstanceId,
        config: input.oauthConfig,
        credentialStore,
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        // For 403 step-up, when requiredScope is a strict superset of the current token scope,
        // refresh cannot add scope (RFC 6749 §6). Force reauthorization or the new scope would be
        // silently discarded and the request would 403 again.
        ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
        keyPrefix,
        logger: this.logger,
        ...(oauthOptions?.onAuthorizationRequired
          ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
          : {}),
        ...(oauthOptions?.openAuthorizationUrl
          ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
          : {}),
        ...(requestedScope ? { requestedScope } : {}),
        ...(input.trigger.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
          : {}),
        serverName: input.name,
        serverUrl: input.serverUrl,
        signal: input.signal,
        transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
      });
    } catch (error) {
      // This method's return type models orchestration failures as outcomes. Previously, errors from
      // credential load, authz lease, or follower callback rejected directly, bypassing
      // failConnection and leaving status=connecting with a rejected record.connecting, while
      // failing the whole connectConfiguredServers batch.
      this.logger?.warn("MCP OAuth authorization orchestration failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        event: "mcp.oauth.authorization.orchestration_failed",
        mcpServerName: input.name,
        status: "failed",
      });
      return { status: "failed", error };
    }
  }

  private async failConnection(input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  }): Promise<McpServerStatus> {
    const {
      client,
      config,
      connectDurationMs,
      error,
      failureKind: fallbackFailureKind,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
    } = input;
    const message = error instanceof Error ? error.message : String(error);
    // Persist stable classifications for official MCP auth failures in logs. failConnection used
    // to record only error.message, but most classifications do not appear in the message (only
    // auth-port failures did), so `official_mcp_origin_untrusted` / `official_auth_rejected` could
    // not be found in production logs.
    const officialAuthKind =
      (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
      this.lastOfficialAuthKind.get(name);
    this.lastOfficialAuthKind.delete(name);
    const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
    this.connectionDiagnosticByServer.delete(name);
    const failureKind =
      (officialAuthKind === "official_mcp_origin_untrusted"
        ? "official_origin_untrusted"
        : undefined) ??
      responseDiagnostic?.failureKind ??
      (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
        ? "connection_timeout"
        : undefined) ??
      fallbackFailureKind ??
      "connection_failed";
    const displayMessage = responseDiagnostic?.serverRequestId
      ? `${message} - ${responseDiagnostic.serverRequestId}`
      : message;
    const status = this.createStatus(config, "failed", {
      error: displayMessage,
      failureKind,
      ...(responseDiagnostic?.serverRequestId
        ? { serverRequestId: responseDiagnostic.serverRequestId }
        : {}),
    });
    const recentStderr = getRecentStderr?.();
    const mcpTransportPid = getStdioTransportPid(transport);
    await this.closeClientAndTransport(name, client, transport);
    if (!this.isCurrentConnection(name, generation)) {
      return this.records.get(name)?.status ?? status;
    }
    this.records.set(name, { config, status, tools: [] });
    this.logger?.warn("MCP server connection failed", {
      ...this.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      error: displayMessage,
      event: "mcp.server.failed",
      listToolsDurationMs,
      mcpServerName: name,
      ...(officialAuthKind ? { officialAuthKind } : {}),
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "failed",
      ...(recentStderr ? { stderr: recentStderr } : {}),
      transport: config.type,
    });
    return status;
  }

  private async createTransport(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    _oauthAuthorizationTimeoutMs?: number,
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ transport: McpTransport }> {
    if (config.type === "stdio") {
      return {
        transport: new ProcessTreeStdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd
            ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
            : (workingDirectory ?? this.workingDirectory),
          env: {
            ...buildMcpStdioEnv({ env: this.env, network: this.network }),
            ...config.env,
          },
          stderr: "pipe",
          ...(isOfficialAuthConfig(config) && config.official
            ? {
                requestMetaProvider: async () => {
                  const authMeta = await this.resolveOfficialStdioAuthMeta(
                    serverName,
                    config,
                    signal,
                  );
                  return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
                },
              }
            : {}),
        }),
      };
    }

    const fetch = createMcpTransportFetch({
      env: this.env,
      network: this.network,
    });
    if (config.type === "http") {
      const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          // On the official-auth path authProvider must be undefined: do not persist OAuth
          // credentials, start a localhost callback server, or route 401/403 into the authorization flow.
          authProvider: this.createOAuthClientProvider(serverName, config),
          fetch: officialAuthFetch ?? fetch,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        }),
      };
    }

    return {
      transport: new SSEClientTransport(new URL(config.url), {
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  /**
   * Dynamic fetch for official-auth MCP. Returning undefined means use the normal MCP path.
   *
   * Fail closed if trusted-origin dependencies are missing. The auth port may be absent: the
   * wrapper still validates origin, and requests become anonymous for authoritative server-side checks.
   */
  private createOfficialAuthFetch(
    config: McpServerConfig,
    serverName: string,
    generation: number,
  ): typeof globalThis.fetch | undefined {
    if (!isOfficialAuthConfig(config) || config.type !== "http" || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    if (!trustedOrigins) {
      return (() => {
        throw new OfficialMcpAuthError(
          "official_auth_unavailable",
          `official MCP trusted origin registry is not available in this runtime: ${serverName}`,
        );
      }) as unknown as typeof globalThis.fetch;
    }
    return createOfficialMcpAuthFetch({
      baseFetch: createMcpTransportFetch({ env: this.env, network: this.network }),
      official,
      onAuthFailure: (kind) => this.lastOfficialAuthKind.set(serverName, kind),
      onServerResponse: (response) => {
        if (this.isCurrentConnection(serverName, generation)) {
          this.rememberServerResponse(serverName, response);
        }
      },
      serverName,
      trustedOrigins,
      url: config.url,
      ...(authHeadersPort ? { authHeadersPort } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
    });
  }

  /**
   * Runtime auth provider.
   *
   * Previously, this created a full OAuth session for any HTTP/SSE MCP without an Authorization
   * header. Before returning, that session called `listen(0)` to start a callback server—even when
   * credentials were valid and no authorization was needed. A full `OAuthClientProvider` also sent
   * 401 through the SDK's `auth()`, bypassing our single-flight refresh lock.
   *
   * Now authorization_code always uses a plain AuthProvider: passive connection starts no listener,
   * discovery, or DCR; interactive authorization happens only in the Phase 2 transaction.
   */
  private createOAuthClientProvider(
    serverName: string,
    config: McpServerConfig,
  ): AuthProvider | OAuthClientProvider | undefined {
    if (config.type === "stdio") return undefined;
    // Official auth and OAuth are mutually exclusive: official MCP failures can only be resolved
    // through ZCode login / plan. Passing any authProvider would incorrectly route 401 into MCP authorization.
    if (isOfficialAuthConfig(config)) return undefined;
    const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (authorizationCodeOAuthConfig) {
      return createMcpOAuthTokenProvider({
        config: authorizationCodeOAuthConfig,
        credentialStore: this.resolveCredentialStore(),
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
        ...(this.logger ? { logger: this.logger } : {}),
        serverName,
        serverUrl: config.url,
      });
    }
    if (config.oauth?.type === "client_credentials") {
      return new ClientCredentialsProvider({
        clientId: config.oauth.clientId,
        clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
        clientSecret: config.oauth.clientSecret,
        scope: config.oauth.scope,
      });
    }
    return undefined;
  }

  private resolveCredentialStore(): SharedZCodeCredentialStore {
    this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedZCodeCredentialStore();
    return this.credentialStore;
  }

  private createAuthorizationCodeOAuthOptions(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    oauthAuthorizationTimeoutMs?: number,
  ): McpOAuthRuntimeOptions | undefined {
    if (config.type === "stdio") return this.mcpOAuth;
    return {
      ...this.mcpOAuth,
      authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
      onAuthorizationRequired: async (context) => {
        this.updateCurrentRecordStatus(serverName, generation, {
          authorization: createOAuthAuthorizationStatus(context),
          status: "connecting",
        });
        await this.mcpOAuth?.onAuthorizationRequired?.(context);
      },
    };
  }

  private attachStdioLogging(name: string, transport: McpTransport): () => string | undefined {
    const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
    const stderr = (
      transport as {
        stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
      }
    ).stderr;
    stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer.append(text);
      this.logger?.debug("MCP stdio stderr", {
        event: "mcp.stdio.stderr",
        mcpServerName: name,
        stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
      });
    });
    return () => {
      const text = stderrBuffer.read();
      if (!text) return undefined;
      // A bare Connection closed in production logs cannot identify why a stdio MCP child process
      // exited. Attach trailing stderr only to failure events and redact it first to avoid logging
      // credentials or high-frequency output in production.
      return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
    };
  }

  private async closeRecord(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
    if (!record.client && !record.transport) return;
    await this.closeClientAndTransport(name, record.client, record.transport);
  }

  private async closeClientAndTransport(
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void> {
    const startedAt = Date.now();
    const mcpTransportPid = getStdioTransportPid(transport);
    // Remove the connection_lost listener before intentional close so normal cleanup is not
    // reported as an unexpected disconnect.
    if (client) client.onclose = undefined;
    // MCP SDK close guarantees only that the direct stdio child exits. An MCP server launched by an
    // npx/npm wrapper or the chrome-devtools-mcp watchdog may remain; explicitly clean up the process
    // tree first, then call SDK close to clean protocol state.
    await this.terminateStdioProcessTree(name, transport);

    try {
      await client?.close();
    } catch (error) {
      this.logger?.debug("MCP client close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.client.close.failed",
        mcpServerName: name,
      });
    }

    try {
      await transport?.close();
    } catch (error) {
      this.logger?.debug("MCP transport close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.transport.close.failed",
        mcpServerName: name,
      });
    }
    if (
      this.connectionContext &&
      transport instanceof ProcessTreeStdioClientTransport &&
      !transport.processAlive
    ) {
      this.telemetry?.recordProcessClosed({
        connectionId: this.connectionContext.mcpConnectionId,
      });
    }
    this.logger?.info("MCP server closed", {
      ...this.connectionContext,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.closed",
      mcpServerName: name,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "completed",
    });
  }

  private async terminateStdioProcessTree(name: string, transport?: McpTransport): Promise<void> {
    const pid = getStdioTransportPid(transport);
    if (pid == null) return;

    try {
      await terminateMcpStdioProcessTree(pid);
    } catch (error) {
      this.logger?.warn("MCP stdio process tree cleanup failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.stdio.process_tree_cleanup.failed",
        mcpServerName: name,
        mcpTransportPid: pid,
        pid,
        status: "failed",
      });
    }
  }

  private nextConnectionGeneration(name: string): number {
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);
    return generation;
  }

  private isCurrentConnection(name: string, generation: number): boolean {
    return this.connectionGenerations.get(name) === generation;
  }

  private updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    Object.assign(record, patch);
  }

  private updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    record.status = {
      ...record.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  private createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    } = {},
  ): McpServerStatus {
    return {
      status,
      transport: config.type,
      toolCount: extra.toolCount ?? 0,
      updatedAt: new Date().toISOString(),
      authorization: extra.authorization,
      error: extra.error,
      failureKind: extra.failureKind,
      protocolEra: extra.protocolEra,
      serverRequestId: extra.serverRequestId,
    };
  }
}

function mcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // Exposed through nodeRepl.requestMeta. All ZCode MCP servers may ignore these extension keys;
  // the node_repl browser bridge uses them as the only correlation back to the current
  // BrowserControlPort session. runtime_scope cannot be inferred from the child session ID and
  // must be explicitly passed through by the runtime that executes the tool.
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.zcode/request-context": requestContext,
  };
}

function resolveVersionNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.protocolVersion === "2026-07-28") return { pin: "2026-07-28" };
  // The deprecated SSE transport only supports the legacy era; an explicit modern pin must still
  // fail rather than silently downgrade.
  if (config.type === "sse") return "legacy";
  if (config.protocolVersion === "legacy") return "legacy";
  return "auto";
}

/**
 * Stable identification of SDK version-negotiation failures (auto/pin server/discover probe).
 *
 * Use structured checks; never match error text:
 * - `SdkError(SdkErrorCode.EraNegotiationFailed)`: hard probe failure (including malformed HTTP 200
 *   responses from nonstandard legacy servers that fail transport-layer Zod validation and enter
 *   the network-error branch in normalizeReply).
 * - `UnsupportedProtocolVersionError`: recognized modern error; server rejected the pinned version.
 */
function isProtocolNegotiationFailure(error: unknown): boolean {
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed) {
    return true;
  }
  if (UnsupportedProtocolVersionError.isInstance(error)) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return isProtocolNegotiationFailure(cause);
  }
  return false;
}

function formatVersionNegotiationMode(config: McpServerConfig): string {
  const mode = resolveVersionNegotiationMode(config);
  return typeof mode === "object" ? mode.pin : mode;
}

function resolveVersionNegotiation(
  config: McpServerConfig,
  timeoutMs: number,
): VersionNegotiationOptions {
  const mode = resolveVersionNegotiationMode(config);
  if (mode === "legacy") return { mode };

  // A pin has no legacy fallback, so the probe is the only initialize path. Reusing auto's 5-second
  // protection limit would ignore the server's long-connection budget and silently remove node_repl
  // from the tool pool during a normal cold start taking more than 5 seconds.
  const probeTimeoutMs =
    typeof mode === "object"
      ? Math.max(1, Math.floor(timeoutMs))
      : Math.min(MAX_MCP_VERSION_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));

  return {
    mode,
    probe: {
      // Reason: SDK stdio auto/pin starts a disposable sibling first. With the SDK's default 60s
      // timeout, ZCode's total connection timeout may expire first and leave the probe behind,
      // while also leaving no budget for legacy initialize.
      timeoutMs: probeTimeoutMs,
    },
  };
}

function createOAuthAuthorizationStatus(
  context: McpOAuthAuthorizationContext,
): NonNullable<McpServerStatus["authorization"]> {
  return {
    type: "oauth_authorization_code",
    authorizationUrl: context.authorizationUrl,
    startedAt: new Date().toISOString(),
  };
}

function resolveAuthorizationCodeOAuthConfig(
  config: McpServerConfig,
): AuthorizationCodeOAuthConfig | undefined {
  if (config.type === "stdio") return undefined;
  // Official auth and MCP OAuth are mutually exclusive. This must precede all existing branches:
  // official MCP has no oauth field and forbids static authorization headers. Without this early
  // return it would fall through to the authorization_code default below and show MCP authorization
  // UI on 401, though official-auth failures can only be resolved through ZCode login / plan, not
  // through the target MCP's OAuth authorization.
  if (isOfficialAuthConfig(config)) return undefined;
  if (config.oauth?.type === "authorization_code") return config.oauth;
  if (config.oauth?.type === "client_credentials") return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;

  // Newly configured HTTP/SSE MCPs often store only a URL. OAuth support should be triggered by
  // server WWW-Authenticate / discovery, not require an oauth field in configuration.
  return {
    type: "authorization_code",
  };
}

/**
 * True when auth.type/provider matches exactly and provenance exists; missing provenance means the
 * configuration did not come from the Plugin loader.
 *
 * Covers both http and stdio: their credential-delivery channels differ, but the "official auth"
 * determination is the same. Callers interested in only one form must also check `config.type`
 * (for example, createOfficialAuthFetch handles http only, while _meta injection handles stdio only).
 */
function isOfficialAuthConfig(config: McpServerConfig): boolean {
  return (
    (config.type === "http" || config.type === "stdio") &&
    config.auth?.type === "zcode_official" &&
    config.auth.provider === "jwt_token" &&
    config.official !== undefined
  );
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
      }
    },
    read() {
      return value;
    },
  };
}

function sanitizeMcpStdioStderr(text: string): string {
  const sensitiveKey = String.raw`(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  result = result.replace(
    new RegExp(`(["']${sensitiveKey}["']\\s*:\\s*)(["'])(?:(?!\\2).)*\\2`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}

function getStdioTransportPid(transport?: McpTransport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) return undefined;
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function getStdioTransportExitInfo(transport?: McpTransport):
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | undefined {
  return transport instanceof ProcessTreeStdioClientTransport ? transport.processExit : undefined;
}

function isStdioTransportProcessAlive(transport?: McpTransport): boolean {
  return transport instanceof ProcessTreeStdioClientTransport && transport.processAlive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A JSON-RPC error response from the server (numeric code) means the request reached it and the
// connection is alive. SDK-local errors (SdkError, string codes REQUEST_TIMEOUT / CONNECTION_CLOSED /
// NOT_CONNECTED / SEND_FAILED) indicate a broken transport. Check code type as a fallback when
// instanceof fails across multiple SDK instances.
function isPeerAnsweredError(error: unknown): boolean {
  if (error instanceof ProtocolError) return true;
  return isRecord(error) && typeof error.code === "number";
}
