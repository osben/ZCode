import {
  Client,
  ClientCredentialsProvider,
  computeScopeUnion,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SseError,
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
  McpConnectionSnapshot,
  McpConnectOptions,
  McpContentBlock,
  McpElicitationPort,
  McpElicitationTrace,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpNotificationPort,
  McpOAuthConfig,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
  McpServerConfig,
  McpServerStatus,
  McpServerToolSnapshot,
  McpToolCallResult,
  McpToolDescriptor,
  McpWaitForServerOptions,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import {
  mcpConfigKey,
  McpResourceSubscribeUnsupportedError,
  ZCODE_MCP_SERVER_REQUEST_ID_META_KEY,
} from "@zcode/contracts";
import {
  OFFICIAL_MCP_AUTH_META_KEY,
  ZCODE_OFFICIAL_MCP_AUTH_TYPE,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import { buildMcpAppsClientCapabilities } from "@zcode/shared/mcp-apps";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  type NetworkEgressEnvPolicy,
} from "./network.js";
import {
  applyMcpNodeFallbackEnv,
  type McpNodeFallback,
  type McpNodeFallbackProvider,
} from "./node-fallback.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import {
  classifyInteractiveAuthorizationTrigger,
  type InteractiveAuthorizationTrigger,
} from "./oauth-errors.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import {
  createCredentialKeyPrefix,
  type McpOAuthAuthorizationContext,
  type McpOAuthRuntimeOptions,
} from "./oauth.js";
import {
  createOfficialMcpAuthFetch,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "./official-auth.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import {
  classifyTransportError,
  countNetworkFailures,
  isRetryableCallError,
} from "./transport-errors.js";
import {
  createMcpDeadline,
  McpTimeoutError,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  withTimeout,
  type McpDeadline,
} from "./timeout.js";

const MCP_RECOVERY_ATTEMPTS = 5;
const MCP_RECOVERY_INITIAL_DELAY_MS = 1_000;
/** 内建 stdio server 在滚动窗口内最多自动重启的次数，防止"启动后很快又退出"形成循环。 */
const MCP_BUILTIN_RESTART_LIMIT = 5;
const MCP_BUILTIN_RESTART_WINDOW_MS = 10 * 60_000;
const DEFAULT_MCP_TIMEOUT_MS = 30_000;
/** Upper bound on waiting for a reconnect before a tool-call retry; the actual wait is also limited by the call's remaining budget. */
const MCP_RECONNECT_WAIT_MS = 30_000;
const MCP_TOOLS_REFRESH_ATTEMPTS = 3;
const MCP_TOOLS_REFRESH_INITIAL_DELAY_MS = 1_000;
// Liveness probes must finish quickly: they run on the settings-page refresh path, and a timeout
// marks the connection dead and triggers reconnect.
const MCP_PING_TIMEOUT_MS = 5_000;
const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
const MCP_STDIO_ERROR_MESSAGE_MAX_CHARS = 512;
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
   * Desktop Electron Node fallback: when injected by the host, stdio MCP's node/npm/npx fall back to
   * Electron and the bundled npm when missing from the user's PATH (docs/design/v2/mcp-node-fallback.md).
   * When absent, env is unchanged.
   */
  nodeFallback?: McpNodeFallbackProvider;
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
  /**
   * 会话所属 workspace 的 key，官方 MCP 授权头请求以它为身份发往 Host。受管 worktree 会话 =
   * 项目，不等于 workingDirectory（docs/git/worktree.md §9.3）。
   */
  workspaceKey?: string;
  /** 有此端口才向 server 宣告 elicitation 能力；缺省时 server 的 elicitation/create 收到 method not found。 */
  elicitation?: McpElicitationPort;
  /** Outlet for server → client notifications (resource updates / list changes / tool-list changes / logs); if absent, log at debug only. */
  notifications?: McpNotificationPort;
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

/** Server → client notification method names for subscriptions (MCP specification). */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = "notifications/tools/list_changed";
export const MCP_NOTIFICATION_RESOURCES_UPDATED = "notifications/resources/updated";
export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = "notifications/resources/list_changed";
export const MCP_NOTIFICATION_MESSAGE = "notifications/message";

interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  /** Set after receiving tools/list_changed and kept until a background refresh succeeds; failures are retried a limited number of times by that task, and once exhausted a later notification triggers it again. */
  toolsStale?: boolean;
  /** 后台 tools/list 刷新的 single-flight；同一 record 同时只有一次。 */
  toolsRefresh?: Promise<void>;
  /** 只在拿到成功的 tools/list 后设置；未设置表示"从未拿到列表"，不能当成空列表。 */
  toolsVersion?: number;
  transport?: McpTransport;
  /** 当前 client 已确认的远端订阅及同 URI 串行任务；订阅意图只在登记表。 */
  resourceSubscriptions?: Map<string, { subscribed: boolean | undefined; task?: Promise<boolean> }>;
}

/**
 * 新连接的来由。默认是首次连接或显式重连，允许交互授权；
 * recovering：远程意外断连或内建 stdio 进程意外退出，保留目录，后台有限重试，不弹交互授权；
 * oauthTrigger：工具调用遇到授权错误，先交互授权（step-up 合并 scope），保留目录。
 */
interface StartConnectionMode {
  recovering?: boolean;
  oauthTrigger?: InteractiveAuthorizationTrigger;
  /**
   * 保留了目录的记录（授权未完成就结束、来源 builtin 的 server 超过重启上限）的执行准入重连：
   * 保留目录，工具不离开模型视图。
   */
  retainTools?: boolean;
}

/** resources/list item: pass through standard fields only (including _meta) and discard SDK-added runtime fields. */
function pickResourceDescriptor(
  resource: unknown,
  includeUri = true,
): {
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
} {
  const item = isRecord(resource) ? resource : {};
  return {
    ...(includeUri ? { uri: typeof item.uri === "string" ? item.uri : "" } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.title === "string" ? { title: item.title } : {}),
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
  };
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
    createAdapter: ({ connectionContext, workingDirectory, workspaceKey }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
        ...(workspaceKey ? { workspaceKey } : {}),
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpNodeFallbackProvider,
  type CreateMcpNodeFallbackProviderOptions,
  type McpNodeFallback,
  type McpNodeFallbackProvider,
} from "./node-fallback.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";
export {
  createInMemoryMcpToolCatalog,
  type InMemoryMcpToolCatalogOptions,
} from "./tool-catalog-cache.js";

/** Elicitation mode allowlist (MCP form and compatibility aliases). */
const SUPPORTED_ELICITATION_MODES = new Set(["form", "openai/form", "openaiForm"]);
export function isSupportedElicitationMode(mode: unknown): boolean {
  return mode === undefined || (typeof mode === "string" && SUPPORTED_ELICITATION_MODES.has(mode));
}

class NodeMcpAdapter implements McpPort {
  private readonly adapterInstanceId = randomUUID();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionContext?: McpConnectionContext;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly mcpOAuth?: McpOAuthRuntimeOptions;
  private readonly network?: NetworkEgressEnvPolicy;
  private readonly nodeFallback?: McpNodeFallbackProvider;
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
  /** 内建 stdio server 最近的自动重启时刻；非恢复的连接清零。 */
  private readonly builtinRestarts = new Map<string, number[]>();
  /** waitForServer 的授权边界 waiter：启动转为 OAuth pending 时由 onAuthorizationRequired 唤醒。 */
  private readonly authorizationWaiters = new Map<string, Set<() => void>>();
  private readonly workingDirectory?: string;
  private readonly workspaceKey?: string;
  private readonly elicitation?: McpElicitationPort;
  private readonly notifications?: McpNotificationPort;
  /** Resource-subscription registry: serverName → uri → subscriberKey; single owner, counted at the connection layer. */
  private readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();
  /** Cumulative tools/list_changed count; runtime uses it to determine whether to register tools again. */
  /** Incremented each time a server's tool list is successfully replaced; used as McpServerToolSnapshot.toolsVersion. */
  private toolsVersionCounter = 0;
  private readonly snapshotListeners = new Set<() => void>();
  private snapshotNotificationPending = false;
  /** Late call errors after close() must not start a reconnect. */
  private closed = false;

  onSnapshotChanged(listener: () => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  private notifySnapshot(): void {
    if (this.snapshotNotificationPending) return;
    this.snapshotNotificationPending = true;
    queueMicrotask(() => {
      this.snapshotNotificationPending = false;
      for (const listener of this.snapshotListeners) {
        // Before the fix, a throwing listener became an uncaught exception in the microtask (the CLI exits on fatal errors),
        // and later listeners never received the notification. The dispatch boundary isolates each subscriber and logs errors at error level.
        try {
          listener();
        } catch (error) {
          this.logger?.error(
            "MCP snapshot listener failed",
            error instanceof Error ? error : new Error(String(error)),
            { event: "mcp.snapshot.listener_failed" },
          );
        }
      }
    });
  }

  /** Trace of the tool call each server is currently running; elicitation uses it to attach to the session / tool row. */
  private readonly activeCallTraces = new Map<string, McpElicitationTrace>();

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
    this.nodeFallback = options.nodeFallback;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
    this.workspaceKey = options.workspaceKey;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
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
    // Synchronously retire old records and register all new ones first; a new config must not read or cache the old catalog.
    const disconnecting = Array.from(this.records.keys())
      .filter((name) => !configuredNames.has(name))
      .map((name) => this.disconnectServer(name));
    const connecting = Object.entries(servers).map(([name, config]) =>
      this.connectServer(name, config, options),
    );
    await Promise.all([...disconnecting, ...connecting]);

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
    const existing = this.records.get(name);
    // 相同配置只复用当前记录；显式断开后的记录不再代表这份配置，需要重新连接。
    if (
      existing &&
      existing.status.status !== "disconnected" &&
      mcpConfigKey(existing.config) === mcpConfigKey(config)
    ) {
      return options.revalidate
        ? this.revalidateConnection(name, existing, options)
        : this.waitForSharedConnection(name, existing, options);
    }
    return this.startConnection(name, config, options);
  }

  private async startConnection(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions,
    mode: StartConnectionMode = {},
  ): Promise<McpServerStatus> {
    const { recovering = false, oauthTrigger, retainTools = false } = mode;
    // 修复原因：close() 等待旧连接关闭期间，修复前仍可登记新记录；close 随后清空记录，
    // 新连接完成时读不到记录而抛 TypeError。关闭后不再启动连接，也不登记记录。
    if (this.closed) return this.createStatus(config, "disconnected");
    // 恢复、调用期授权与授权失败后的重连都保留已公告的目录，避免 pending 期间工具被误判为消失。
    const keepTools = recovering || oauthTrigger !== undefined || retainTools;
    // 配置变化、显式重连等非恢复连接重新开始计数。
    if (!recovering) this.builtinRestarts.delete(name);
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
    const previous = this.records.get(name);

    if (config.enabled === false) {
      const status = this.createStatus(config, "disabled");
      this.records.set(name, { config, status, tools: [] });
      this.notifySnapshot();
      await this.closeRecord(name, previous);
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
    const connectingStatus = this.createStatus(config, "connecting");
    const record: McpServerRecord = {
      abortController,
      config,
      status: keepTools
        ? this.createStatus(config, "connecting", { toolCount: previous?.tools.length })
        : connectingStatus,
      tools: keepTools ? (previous?.tools ?? []) : [],
      toolsVersion: keepTools ? previous?.toolsVersion : undefined,
    };
    // 修复原因：过去先 await 关闭旧连接再登记新记录，这段间隙里 waitForServer 只能看到旧的
    // connected/failed 记录，会立即报告"已结束"。现在同步登记新的 connecting 记录，再关闭旧记录对象。
    this.records.set(name, record);
    this.notifySnapshot();
    const connecting = (async () => {
      if (previous) await this.closeRecord(name, previous);
      let status = record.status;
      const attempts = recovering ? MCP_RECOVERY_ATTEMPTS : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0)
          await waitForMcpRetry(
            MCP_RECOVERY_INITIAL_DELAY_MS * 2 ** (attempt - 1),
            abortController.signal,
          );
        if (abortController.signal.aborted || !this.isCurrentConnection(name, generation))
          return this.records.get(name)?.status ?? record.status;
        status = await this.openServerConnection({
          config,
          generation,
          name,
          interactive: !recovering,
          oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
          ...(attempt === 0 && oauthTrigger ? { oauthTrigger } : {}),
          abortController,
          timeoutMs,
          workingDirectory: options.workingDirectory ?? this.workingDirectory,
        });
        // 需要授权时结束恢复：恢复期不弹交互授权，重试也不会成功。
        if (
          status.status === "connected" ||
          status.status === "disabled" ||
          status.status === "untrusted" ||
          status.failureKind === "official_origin_untrusted" ||
          status.failureKind === "oauth_authorization_failed"
        )
          break;
      }
      return status;
    })()
      .catch((error) => {
        if (abortController.signal.aborted || !this.isCurrentConnection(name, generation))
          return this.records.get(name)?.status ?? record.status;
        return this.failConnection({ name, config, generation, startedAt, error });
      })
      .then((status) => {
        // 连接任务末尾是失败的唯一提交方；修复前 failConnection 也提交，订阅者会收到两次终态。
        if (this.isCurrentConnection(name, generation) && record.status.status !== "connected") {
          this.commitUnavailable(name, record, status);
        }
        return this.records.get(name)?.status ?? status;
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

  private async revalidateConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus> {
    const state = record.status.status;
    // 进行中的连接/恢复/授权只报告当前状态，重复刷新不能替换已有任务。
    if (state === "connecting" || state === "disabled" || state === "untrusted") {
      return record.status;
    }
    if (state === "connected") {
      // 探测无副作用；caller 取消只结束自己的等待，探测结果仍由失效入口处理。
      const alive = await withTimeout(
        this.pingServer(name),
        undefined,
        "MCP server revalidation cancelled",
        options.signal,
      ).catch(() => undefined);
      if (alive !== false) return this.records.get(name)?.status ?? record.status;
    }
    const current = this.records.get(name);
    // 远程探测失败已由失效入口换成恢复记录：报告当前状态，不替换恢复，也不等它结束。
    if (current !== record) return current?.status ?? record.status;
    return this.startConnection(name, record.config, { ...options, revalidate: false });
  }

  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    const record = this.records.get(name);
    if (!record) return undefined;

    this.nextConnectionGeneration(name);
    const status = this.createStatus(record.config, "disconnected");
    this.records.set(name, {
      config: record.config,
      status,
      tools: [],
    });
    this.notifySnapshot();
    // 关闭只操作旧记录对象；迟到完成不能覆盖随后建立的新连接。
    await this.closeRecord(name, record);
    return status;
  }

  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Object.entries(this.getToolSnapshot()).map(([name, record]) => [name, record.status]),
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
      // 探测失败与 transport 断连共用失效入口：远程保留 pending 目录进入恢复，stdio 进入 failed。
      // 修复前 stdio 只把状态改成 disconnected，既不关闭仍在运行的进程，也不发布终态。
      const { client, transport } = record;
      if (this.invalidateConnection(name, generation, client) && record.config.type === "stdio")
        void this.closeClientAndTransport(name, client, transport);
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
    // 只读当前快照：标脏的 server 由后台刷新推进，调用方不能被刷新退避拖住。
    return Object.values(this.getToolSnapshot()).flatMap((record) => record.tools ?? []);
  }

  getToolSnapshot(): Record<string, McpServerToolSnapshot> {
    const snapshot: Record<string, McpServerToolSnapshot> = {};
    for (const [name, record] of this.records) {
      // 只读内存，不发起 I/O：标脏的 server 由 list_changed 通知触发刷新，本次仍返回旧列表。
      // 保留目录的不可用记录（见 retainsCatalog）快照照常输出。
      const retainsTools =
        ["connected", "connecting"].includes(record.status.status) ||
        retainsCatalog(record.config, record.status);
      snapshot[name] = {
        status: { ...record.status },
        ...(record.toolsVersion === undefined || !retainsTools
          ? {}
          : { tools: [...record.tools], toolsVersion: String(record.toolsVersion) }),
      };
    }
    return snapshot;
  }

  async waitForServer(
    name: string,
    options: McpWaitForServerOptions,
  ): Promise<{ timedOut: boolean }> {
    options.signal?.throwIfAborted();
    // 修复原因：MCP App 打开也传 reconnect，过去会走授权失败重连并发起交互授权；授权只挂在执行准入上。
    const connecting = options.reconnect
      ? (this.connectionTask(name) ??
        (options.reauthorize ? this.reconnectAfterAuthorizationFailure(name) : undefined))
      : this.records.get(name)?.connecting;
    const record = this.records.get(name);
    if (!connecting || record?.status.authorization) return { timedOut: false };
    const authorization = this.watchAuthorizationLink(name);
    try {
      // 复用同一个启动 Promise；成功、失败或转为授权 pending 都代表"本次等待结束"，结果由调用方读快照。
      await withTimeout(
        Promise.race([
          connecting.then(
            () => undefined,
            () => undefined,
          ),
          authorization.published,
        ]),
        options.timeoutMs,
        `MCP server ${name} startup wait timed out after ${options.timeoutMs}ms`,
        options.signal,
      );
      return { timedOut: false };
    } catch (error) {
      if (error instanceof McpTimeoutError) return { timedOut: true };
      throw error;
    } finally {
      authorization.dispose();
    }
  }

  /** 授权链接发布时结束等待；只登记 waiter，不取消授权或共享连接。 */
  private watchAuthorizationLink(name: string): { published: Promise<void>; dispose(): void } {
    const published = Promise.withResolvers<void>();
    const waiters = this.authorizationWaiters.get(name) ?? new Set<() => void>();
    this.authorizationWaiters.set(name, waiters);
    waiters.add(published.resolve);
    return {
      published: published.promise,
      dispose: () => {
        waiters.delete(published.resolve);
        if (waiters.size === 0 && this.authorizationWaiters.get(name) === waiters) {
          this.authorizationWaiters.delete(name);
        }
      },
    };
  }

  /**
   * 授权未完成就结束（到期、失败）的记录保留了目录；执行准入时按普通连接重连一次，单飞靠 record.connecting。
   * 修复前这种状态没有任何重连入口，server 永久停在 needs-auth。期间已在别处完成授权就用最新凭据直接连上；
   * 仍需授权则发起交互授权，链接发布后等待方立即结束。只在执行准入（reauthorize）时触发，MCP App 打开不触发。
   */
  private reconnectAfterAuthorizationFailure(name: string): Promise<McpServerStatus> | undefined {
    const record = this.records.get(name);
    if (
      !record ||
      record.connecting ||
      record.status.failureKind !== "oauth_authorization_failed" ||
      record.toolsVersion === undefined
    )
      return undefined;
    return this.startConnection(name, record.config, {}, { retainTools: true });
  }

  private refreshTools(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return Promise.resolve();
    if (!record.toolsStale || record.status.status !== "connected") return Promise.resolve();
    record.toolsRefresh ??= Promise.resolve().then(() => this.runToolsRefresh(name, record));
    return record.toolsRefresh;
  }

  private async runToolsRefresh(name: string, record: McpServerRecord): Promise<void> {
    // 刷新期间再收到 list_changed 会重新置脏，循环再拉一轮，保证最后一次通知不丢。
    // dirty 循环退出与清理任务槽必须同步，避免 Promise finally 前的新通知丢失。
    try {
      let failures = 0;
      while (record.toolsStale) {
        const client = record.client;
        if (!client || this.records.get(name) !== record || record.status.status !== "connected") {
          return;
        }
        record.toolsStale = false;
        const timeoutMs = record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
        try {
          const listed = await withTimeout(
            client.listTools(),
            timeoutMs,
            `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
          );
          const tools = listed.tools.map((tool) =>
            normalizeMcpToolDescriptor(
              name,
              tool,
              record.config.timeoutMs,
              record.config.type === "http" &&
                record.config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
              record.config.alwaysLoad,
            ),
          );
          if (!this.commitConnected(name, record, client, tools, record.status)) return;
          failures = 0;
          this.logger?.info("MCP tool list refreshed after list_changed", {
            event: "mcp.tools.refreshed",
            mcpServerName: name,
            toolCount: record.tools.length,
          });
        } catch (error) {
          // 只留 dirty 会让一次性通知永久丢失；由连接所有者有限重试，读快照仍为纯读取。
          record.toolsStale = true;
          this.logger?.warn("MCP tool list refresh failed", {
            event: "mcp.tools.refresh_failed",
            mcpServerName: name,
            error: error instanceof Error ? error.message : String(error),
          });
          if (
            ++failures >= MCP_TOOLS_REFRESH_ATTEMPTS ||
            this.records.get(name) !== record ||
            record.abortController?.signal.aborted
          )
            return;
          try {
            await waitForMcpRetry(
              MCP_TOOLS_REFRESH_INITIAL_DELAY_MS * 2 ** (failures - 1),
              record.abortController?.signal,
            );
          } catch {
            return;
          } // 连接关闭或换代后，重试任务随 owner 取消。
        }
      }
    } finally {
      record.toolsRefresh = undefined;
    }
  }

  /** `resources/list`, passing through pagination cursors. */
  async listResources(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourcesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/list",
      options,
    );
    const result = await record.client.listResources(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resources: (result.resources ?? []).map((resource) => {
        const { uri, ...rest } = pickResourceDescriptor(resource);
        return { uri: uri ?? "", ...rest };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listResourceTemplates(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourceTemplatesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/templates/list",
      options,
    );
    const result = await record.client.listResourceTemplates(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
        const item = template as Record<string, unknown>;
        return {
          uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
          ...pickResourceDescriptor(item, false),
        };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  /**
   * Subscriptions counted by (serverName, uri). If multiple sessions share one connection, subscribe to the server only once;
   * if the server does not declare resources.subscribe capability, return McpResourceSubscribeUnsupportedError.
   */
  async subscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const registration = this.resourceSubscriptions.begin(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    try {
      const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
        request.serverName,
        "resources/subscribe",
        options,
      );
      if (!record.client.getServerCapabilities()?.resources?.subscribe) {
        throw new McpResourceSubscribeUnsupportedError(request.serverName);
      }
      await waitWithinMcpDeadline(
        this.syncResourceSubscription(request.serverName, record, request.uri),
        deadline,
        timeoutMessage,
        options.signal,
      );
      options.signal?.throwIfAborted();
      registration.commit();
    } catch (error) {
      // 单次取消不能删掉同 key 已成功或仍在等待的登记；仅归零时收敛远端副作用。
      if (registration.release()) {
        void this.unsubscribeOnServer(request.serverName, request.uri, {});
      }
      throw error;
    }
    this.logger?.info("MCP resource subscribed", {
      event: "mcp.resource.subscribe",
      mcpServerName: request.serverName,
      uri: request.uri,
      status: "completed",
    });
  }

  async unsubscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    const removed = this.resourceSubscriptions.remove(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    if (!removed?.last) return;
    await this.unsubscribeOnServer(request.serverName, request.uri, options);
  }

  async unsubscribeResourcesBySubscriber(subscriberKeyPrefix: string): Promise<number> {
    const released = this.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
    for (const { serverName, uri } of released) {
      await this.unsubscribeOnServer(serverName, uri, {});
    }
    return released.length;
  }

  /** Registry snapshot (tests / diagnostics): serverName → uri → subscriber count. */
  resourceSubscriptionCounts(): Record<string, Record<string, number>> {
    return this.resourceSubscriptions.counts();
  }

  private async unsubscribeOnServer(
    serverName: string,
    uri: string,
    options: McpCallToolOptions,
  ): Promise<void> {
    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") return;
    try {
      const sent = await waitWithinMcpDeadline(
        this.syncResourceSubscription(serverName, record, uri),
        createMcpDeadline(options.timeoutMs ?? record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS),
        `MCP resources/unsubscribe ${serverName} timed out`,
        options.signal,
      );
      // 远端本来就没有订阅时不发 RPC；修复前这种情况也记录"退订完成"，日志与实际请求不符。
      if (!sent) return;
      this.logger?.info("MCP resource unsubscribed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        status: "completed",
      });
    } catch (error) {
      // Log unsubscribe failures only: the registry is already clear, so extra server notifications will be dropped because there are no subscribers.
      this.logger?.warn("MCP resource unsubscribe failed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }

  /** Remote side effects for the same URI complete in order; the registry is read at send time. Returns whether a subscribe/unsubscribe request was actually sent. */
  private syncResourceSubscription(
    serverName: string,
    record: McpServerRecord,
    uri: string,
  ): Promise<boolean> {
    const client = record.client;
    const states = (record.resourceSubscriptions ??= new Map());
    const state: { subscribed: boolean | undefined; task?: Promise<boolean> } = states.get(uri) ?? {
      subscribed: false,
    };
    states.set(uri, state);
    // The previous request's error is handled by its caller or the recovery entry point; later intents still need a chance to converge.
    const task = (state.task ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (
          this.records.get(serverName) !== record ||
          !client ||
          record.client !== client ||
          record.status.status !== "connected"
        )
          throw new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
        record.abortController?.signal.throwIfAborted();
        const subscribed = this.resourceSubscriptions.subscribers(serverName, uri).length > 0;
        if (subscribed === state.subscribed) return false;
        const options = {
          signal: record.abortController?.signal,
          timeout: record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        };
        try {
          if (subscribed) await client.subscribeResource({ uri }, options);
          else await client.unsubscribeResource({ uri }, options);
          state.subscribed = subscribed;
          return true;
        } catch (error) {
          // When the server explicitly rejects, the remote state is unchanged; other failures do not prove the remote did not execute, so the next request must re-confirm.
          // Before the fix a rejection was also marked unknown, which then sent one pointless extra unsubscribe.
          if (!isPeerAnsweredError(error)) state.subscribed = undefined;
          throw error;
        }
      })
      .finally(() => {
        if (state.task !== task) return;
        state.task = undefined;
        if (state.subscribed === false) states.delete(uri);
      });
    state.task = task;
    return task;
  }

  private async resolveForResourceRequest(
    serverName: string,
    operation: string,
    options: McpCallToolOptions,
  ): Promise<{
    record: McpServerRecord & { client: McpClient };
    deadline: McpDeadline;
    timeoutMessage: string;
  }> {
    const timeoutMs =
      options.timeoutMs ?? this.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    return { record, deadline, timeoutMessage };
  }

  /**
   * Server-initiated notifications. Subscription notifications include the current subscriberKey (the host uses it to split by session);
   * tools/list_changed marks the server stale and refreshes it in the background; the SDK discards notifications when no port is provided.
   */
  private installNotificationHandlers(client: McpClient, serverName: string): void {
    const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
      .setNotificationHandler;
    if (typeof setNotificationHandler !== "function") return;
    // SDK 2.x: the first argument is the notification method name (the spec method is passed as a string); schema is an optional second argument.
    const typed = client as unknown as {
      setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
    };
    typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
      const record = this.records.get(serverName);
      // 按 client 身份核对来源：被替换的旧连接迟到的通知不能给同名新连接标脏。
      if (!record || record.client !== client) return;
      record.toolsStale = true;
      // 各 server 独立在后台刷新，下一次正常请求读快照时采用。
      void this.refreshTools(serverName);
      this.notifications?.onNotification({ kind: "toolListChanged", serverName });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
      const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
      if (typeof uri !== "string") return;
      this.notifications?.onNotification({
        kind: "resourceUpdated",
        serverName,
        uri,
        subscribers: this.resourceSubscriptions.subscribers(serverName, uri),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
      this.notifications?.onNotification({
        kind: "resourceListChanged",
        serverName,
        subscribers: this.resourceSubscriptions.allSubscribers(serverName),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
      const params = (notification as { params?: Record<string, unknown> }).params ?? {};
      this.notifications?.onNotification({
        kind: "loggingMessage",
        serverName,
        level: typeof params.level === "string" ? params.level : "info",
        ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
        data: params.data,
      });
    });
  }

  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    if (options.appConnection) {
      // MCP App 只能在打开时的连接上执行：换代后拒绝，不重试，也不在调用中做授权恢复。
      const snapshot = this.appConnectionSnapshot(request.serverName);
      const current = this.records.get(request.serverName);
      if (
        !snapshot ||
        snapshot.identity !== options.appConnection.identity ||
        snapshot.generation !== options.appConnection.generation ||
        !current?.client
      )
        throw new Error("MCP App connection changed");
      options.signal?.throwIfAborted();
      return await this.callToolOnClient(
        current.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    }

    // 模型调用晚绑定当前 client：同配置重连后的新连接直接可用，不固定连接身份。
    const record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    // 只有调用开始时已分配 session 的 404 才表示会话过期；无状态 server 的 404 是普通错误。
    const hadSessionId =
      record.transport instanceof StreamableHTTPClientTransport &&
      record.transport.sessionId !== undefined;
    try {
      return await this.callToolOnClient(
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    } catch (error) {
      const trigger =
        record.config.type !== "stdio" && resolveAuthorizationCodeOAuthConfig(record.config)
          ? classifyInteractiveAuthorizationTrigger(error)
          : undefined;
      if (!trigger && !isRetryableCallError(error, { type: record.config.type, hadSessionId }))
        throw error;
      const revived = await this.reconnectForRetry({
        name: request.serverName,
        record,
        toolName: request.toolName,
        deadline,
        timeoutMessage,
        options,
        ...(trigger ? { trigger } : {}),
      });
      if (!revived) throw error;
      return await this.callToolOnClient(
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    }
  }

  /**
   * The single entry point before a tool-call retry: if its own record is still the current one, start a reconnect first
   * (auth errors go through call-time authorization), then wait for the current connection task for
   * `min(reconnect wait cap, remaining budget)`. Before the fix, session expiry, unsent calls and authorization
   * loss each had their own recovery path and target check; now only whether the connection still belongs to this call is checked:
   * adapter not closed, same config key, connected, tool still present, lease holder allows it.
   */
  private async reconnectForRetry(input: {
    name: string;
    record: McpServerRecord & { client: McpClient };
    toolName: string;
    deadline: McpDeadline;
    timeoutMessage: string;
    options: McpCallToolOptions;
    trigger?: InteractiveAuthorizationTrigger;
  }): Promise<(McpServerRecord & { client: McpClient }) | undefined> {
    const { name, record, options } = input;
    if (this.closed) return undefined;
    if (this.records.get(name) === record && record.status.status === "connected") {
      if (input.trigger) {
        this.logger?.warn("MCP tool call requires OAuth authorization", {
          event: "mcp.oauth.tool_call.authorization_required",
          mcpServerName: name,
          oauthTriggerReason: input.trigger.reason,
          status: "started",
          toolName: input.toolName,
        });
        void this.startConnection(name, record.config, {}, { oauthTrigger: input.trigger });
      } else {
        // A server-side connection close does not trigger onerror; invalidate the current connection here.
        this.invalidateConnection(name, this.connectionGenerations.get(name) ?? 0, record.client);
      }
    }
    const pending = this.records.get(name);
    // Once the authorization link is published, stop waiting: this call ends with the original error, core rewrites the result by needs-auth state, and authorization continues in the background.
    if (pending?.connecting && !pending.status.authorization) {
      const capAt = Date.now() + MCP_RECONNECT_WAIT_MS;
      const authorization = this.watchAuthorizationLink(name);
      try {
        await waitWithinMcpDeadline(
          // Fix reason: call-time authorization waits for the user to act in the browser; before the fix the call waited the full 30 s and ended as a tool timeout,
          // so the model did not know user authorization was needed. Publishing the link now ends the wait.
          Promise.race([pending.connecting.then(() => undefined), authorization.published]),
          { ...input.deadline, expiresAt: Math.min(input.deadline.expiresAt, capAt) },
          input.timeoutMessage,
          options.signal,
        );
      } catch (error) {
        // Fix reason: before the fix, hitting the reconnect wait cap first reported "tool timeout" and the model assumed the tool itself timed out; return the original error.
        // If the call's own budget expires first it is still a tool timeout.
        if (!(error instanceof McpTimeoutError) || capAt >= input.deadline.expiresAt) throw error;
        return undefined;
      } finally {
        authorization.dispose();
      }
    }
    options.signal?.throwIfAborted();
    const current = this.records.get(name);
    if (
      this.closed ||
      !current?.client ||
      current.status.status !== "connected" ||
      mcpConfigKey(current.config) !== mcpConfigKey(record.config) ||
      !current.tools.some((tool) => tool.toolName === input.toolName) ||
      options.retryAllowed?.() === false
    )
      return undefined;
    return current as McpServerRecord & { client: McpClient };
  }

  /**
   * Read a plugin UI `ui://` resource. Shares the connection wait / disconnect reconnect skeleton with callTool (resolveConnectedRecord)
   * so it uses the same connection and OAuth recovery path; no tool-level OAuth retry: a resource-read failure bubbles up directly
   * and the UI falls back to a regular card.
   */
  async readResource(
    request: McpReadResourceRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpReadResourceResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    const result = await record.client.readResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      contents: (result.contents ?? []).map((content) => {
        const item = content as Record<string, unknown>;
        return {
          uri: typeof item.uri === "string" ? item.uri : request.uri,
          ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          ...(typeof item.text === "string" ? { text: item.text } : {}),
          ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
          ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
        };
      }),
    };
  }

  /**
   * Shared by callTool / readResource: await the shared connecting task, reconnect a disconnected record once,
   * and return a connected record. Extracted so resource reads and tool calls use exactly the same recovery path.
   */
  private async resolveConnectedRecord(
    serverName: string,
    deadline: McpDeadline,
    timeoutMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<McpServerRecord & { client: McpClient }> {
    const pending = this.connectionTask(serverName);
    if (pending) {
      // The wait limits only this caller's budget; the connection task is held by the record and must not cancel other leases' connections.
      await waitWithinMcpDeadline(
        pending.then(() => undefined),
        deadline,
        timeoutMessage,
        signal,
      );
    }

    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") {
      throw new Error(`MCP server is not connected: ${serverName}`);
    }
    return record as McpServerRecord & { client: McpClient };
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
      ...(this.workspaceKey ? { workspaceKey: this.workspaceKey } : {}),
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

  /** Server-initiated elicitation/create: attach to the session of that server's active tool call and pass to the host's question port. */
  private installElicitationHandler(client: McpClient, serverName: string): void {
    const port = this.elicitation;
    const setRequestHandler = (client as unknown as { setRequestHandler?: unknown })
      .setRequestHandler;
    if (!port || typeof setRequestHandler !== "function") return;
    (
      client as unknown as {
        setRequestHandler(
          method: "elicitation/create",
          handler: (request: {
            params: { message: string; requestedSchema?: unknown };
          }) => Promise<unknown>,
        ): void;
      }
    ).setRequestHandler("elicitation/create", async (request) => {
      // Accept absent / "form" / compatibility values "openai/form" / "openaiForm"; decline other modes such as url.
      const mode = (request.params as { mode?: unknown }).mode;
      if (!isSupportedElicitationMode(mode)) {
        this.logger?.warn("MCP elicitation mode not supported, declining", {
          event: "mcp.elicitation.unsupported_mode",
          mcpServerName: serverName,
          mode: String(mode),
        });
        return { action: "decline" };
      }
      const trace = this.activeCallTraces.get(serverName);
      const result = await port.requestElicitation({
        serverName,
        message: request.params.message,
        requestedSchema: request.params.requestedSchema,
        ...(trace ? { trace } : {}),
      });
      return result.action === "accept"
        ? { action: "accept", content: result.content ?? {} }
        : { action: result.action };
    });
  }

  /** Register the trace during the call so server-initiated elicitation in this interval can be attached to the session / tool row. */
  private async callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    this.activeCallTraces.set(request.serverName, {
      ...(request.trace?.sessionId ? { sessionId: String(request.trace.sessionId) } : {}),
      ...(request.trace?.turnId ? { turnId: String(request.trace.turnId) } : {}),
      ...(request.trace?.traceId ? { traceId: String(request.trace.traceId) } : {}),
    });
    try {
      return await this.callToolOnClientInner(client, request, timeoutMs, signal, onProgress);
    } finally {
      this.activeCallTraces.delete(request.serverName);
    }
  }

  private async callToolOnClientInner(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
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
          ...(request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath
            ? { _meta: mcpRequestMeta(request) }
            : {}),
        },
        {
          signal,
          timeout: timeoutMs,
          // Progress notifications reset the timeout (A8): a long task that keeps reporting progress will not be interrupted by timeoutMs; total duration is bounded by tool-level _meta.timeoutMs.
          resetTimeoutOnProgress: true,
          ...(onProgress
            ? {
                onprogress: (notification: {
                  progress: number;
                  total?: number;
                  message?: string;
                }) =>
                  onProgress({
                    progress: notification.progress,
                    ...(notification.total !== undefined ? { total: notification.total } : {}),
                    ...(notification.message !== undefined
                      ? { message: notification.message }
                      : {}),
                  }),
              }
            : {}),
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

  /** Called on execution admission and MCP App open: reuse the existing task; reconnect records that were explicitly disconnected or whose stdio dropped unexpectedly. */
  private connectionTask(name: string): Promise<McpServerStatus> | undefined {
    const record = this.records.get(name);
    if (!record || record.connecting) return record?.connecting;
    if (
      record.status.status === "disconnected" ||
      record.status.failureKind === "unexpected_disconnect"
    )
      // A record that kept its catalog (a built-in server over the restart limit) keeps the catalog during reconnect; other records have no catalog and behave as before.
      return this.startConnection(
        name,
        record.config,
        {},
        { retainTools: record.toolsVersion !== undefined },
      );
    return undefined;
  }

  /** Invalidation first revokes execution eligibility and registers recovery; all events and probes share this one transition. */
  private invalidateConnection(name: string, generation: number, client: McpClient): boolean {
    const record = this.records.get(name);
    if (!this.isCurrentConnection(name, generation) || record?.client !== client) return false;
    if (record.status.status !== "connected") {
      // A discovery response and a disconnect may arrive back to back; a candidate already closed must not later be committed as ready.
      record.client = undefined;
      return false;
    }
    // 修复原因：内建 node_repl 进程被外部终止（例如 `pkill -f node`）后过去按普通 stdio 进入 failed。
    // 会话视图在下一步撤下它的工具，模型不再调用，执行准入重连到不了；同 workspace 的新会话
    // 也复用这条 failed 记录，整个 workspace 的 node_repl 一直不可用。内建 server 不在设置页列出，
    // 用户也无法手动重连，所以由 adapter 立即走后台恢复，并限制重启频率。
    if (
      record.config.type === "http" ||
      record.config.type === "sse" ||
      this.admitBuiltinRestart(name, record.config)
    ) {
      // 同步关闭旧 client：在途请求（包括触发失效的那次）一律以连接关闭结束，HTTP 调用据此重试一次；
      // 结果不取决于关闭任务与各请求错误传播的先后。
      client.onclose = undefined;
      void client.close().catch(() => undefined);
      // 同步登记 pending 并保留有效目录；关闭旧连接、有限重试由同一任务完成。
      void this.startConnection(name, record.config, {}, { recovering: true });
    } else {
      this.nextConnectionGeneration(name);
      record.abortController?.abort(new Error("MCP connection closed"));
      this.commitUnavailable(
        name,
        record,
        this.createStatus(record.config, "failed", {
          error: "MCP server connection closed unexpectedly",
          errorCode: "ConnectionClosed",
          failureKind: "unexpected_disconnect",
        }),
      );
    }
    return true;
  }

  /**
   * 来源 builtin 的 stdio server 意外退出后能否自动重启：窗口内未到上限就登记这一次。
   * builtin 包括宿主注入的 node_repl 和官方市场插件声明的 server。
   */
  private admitBuiltinRestart(name: string, config: McpServerConfig): boolean {
    if (config.type !== "stdio" || config.source?.kind !== "builtin") return false;
    const now = Date.now();
    const recent = (this.builtinRestarts.get(name) ?? []).filter(
      (restartedAt) => now - restartedAt < MCP_BUILTIN_RESTART_WINDOW_MS,
    );
    const admitted = recent.length < MCP_BUILTIN_RESTART_LIMIT;
    if (admitted) recent.push(now);
    else
      this.logger?.warn("MCP built-in server restart limit reached", {
        event: "mcp.server.restart.limit_reached",
        mcpServerName: name,
        restartCount: recent.length,
        windowMs: MCP_BUILTIN_RESTART_WINDOW_MS,
      });
    this.builtinRestarts.set(name, recent);
    return admitted;
  }

  async close(): Promise<void> {
    this.closed = true;
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      this.nextConnectionGeneration(name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
    this.records.clear();
    this.snapshotListeners.clear();
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

    // 共享任务的失败保留原样；只有本 caller 的等待取消/超时转换成状态返回。
    const outcome = connecting.then(
      (status) => ({ status }),
      (error: unknown) => ({ error }),
    );
    return withTimeout(
      outcome,
      options.oauthAuthorizationTimeoutMs,
      "MCP connection wait timed out",
      options.signal,
    )
      .catch(() => ({ status: this.records.get(name)?.status ?? record.status }))
      .then((result) => {
        if ("error" in result) throw result.error;
        return result.status;
      });
  }

  private async openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    /** false 表示恢复期：遇到需要交互授权的错误直接失败，不打开授权页面。 */
    interactive: boolean;
    oauthAuthorizationTimeoutMs?: number;
    /** 工具调用遇到授权错误：先完成交互授权再建立连接。 */
    oauthTrigger?: InteractiveAuthorizationTrigger;
    abortController: AbortController;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus> {
    const {
      config,
      generation,
      name,
      interactive,
      oauthAuthorizationAttempted = false,
      oauthAuthorizationTimeoutMs,
      abortController,
      timeoutMs,
      workingDirectory,
    } = input;
    const signal = abortController.signal;
    const startedAt = Date.now();
    if (input.oauthTrigger && config.type !== "stdio") {
      const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
      if (oauthConfig)
        return this.authorizeThenConnect(input, config, oauthConfig, input.oauthTrigger, startedAt);
    }
    let client: McpClient | undefined;
    let connectDurationMs: number | undefined;
    let getRecentStderr: (() => string | undefined) | undefined;
    let listToolsDurationMs: number | undefined;
    let transport: McpTransport | undefined;
    let failureKind: McpServerFailureKind =
      config.type === "stdio" ? "process_start_failed" : "network_unreachable";

    try {
      // Root cause (MR !3089 review CR-02): the first stdio connection must prepare the node fallback (file IO)
      // first; it used to be awaited bare inside createTransport, outside the connection timeout and
      // cancellation — stuck IO left the connection hanging in connecting forever.
      const nodeFallback =
        config.type === "stdio" && this.nodeFallback
          ? await withTimeout(
              this.nodeFallback.resolve(),
              timeoutMs,
              `MCP server ${name} node fallback preparation timed out after ${timeoutMs}ms`,
              signal,
            )
          : undefined;
      const transportBundle = await this.createTransport(
        config,
        name,
        generation,
        oauthAuthorizationTimeoutMs,
        workingDirectory,
        signal,
        nodeFallback,
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
          capabilities: {
            // MCP Apps specification: the host declares renderable UI mimeTypes through `extensions["io.modelcontextprotocol/ui"]`;
            // the official SDK server uses this to decide whether to send UI resources (getUiCapability).
            ...buildMcpAppsClientCapabilities(),
            // Advertise only form mode (not url mode); the server uses this to choose an elicitation form.
            ...(this.elicitation ? { elicitation: { form: {} } } : {}),
          },
        },
      );
      this.installElicitationHandler(client, name);
      this.installNotificationHandlers(client, name);
      this.updateCurrentRecord(name, generation, {
        client,
        transport,
      });

      let mcpTransportPid: number | undefined;
      let mcpProcessIdentity:
        | ReturnType<NonNullable<CreateMcpAdapterOptions["telemetry"]>["recordProcessStarted"]>
        | undefined;
      // stdio MCP 子进程死亡（如 node_repl 被 REPL cell 的异步错误击穿）不能完全
      // 静默——不记日志、状态停留在 connected，后续调用只会抛裸的 "Not connected"。
      // 挂 onclose 把意外断连显式化；主动关闭路径会先清掉 onclose（见 closeClientAndTransport）。
      client.onclose = () => {
        if (!this.invalidateConnection(name, generation, client!)) return;
        const recentStderr = getRecentStderr?.();
        const processExit = getStdioTransportExitInfo(transport);
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
          transport: config.type,
          ...(recentStderr ? { stderr: recentStderr } : {}),
        });
        if (
          config.type === "stdio" &&
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
      if (config.type === "sse" || config.type === "http") {
        // SDK 不为 SSE 断流或 HTTP 会话过期派发 onclose，统一交给连接恢复 owner。
        // 修复前任何带 session 的 404 都重建连接；只实现 POST 的有状态 server 对 GET 返回 404，
        // 连接会在 discovery 期间被反复判死。GET 打开事件流失败现在只记日志。
        client.onerror = (error) => {
          if (config.type === "sse") {
            if (error instanceof SseError) this.invalidateConnection(name, generation, client!);
            return;
          }
          if (!(transport instanceof StreamableHTTPClientTransport)) return;
          const kind = classifyTransportError(error, { sessionId: transport.sessionId });
          if (kind === "session_expired") this.invalidateConnection(name, generation, client!);
          else if (kind === "stream_open_failed")
            this.logger?.debug("MCP server event stream unavailable", {
              event: "mcp.server.event_stream_unavailable",
              mcpServerName: name,
              httpStatus: error instanceof SdkHttpError ? error.status : undefined,
            });
        };
      }

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
          config.alwaysLoad,
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
      const record = this.records.get(name)!;
      if (!this.commitConnected(name, record, client, tools, status))
        throw new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
      this.connectionDiagnosticByServer.delete(name);
      // Notifications during discovery only mark stale; after ready the producer continues, and the consuming snapshot does not backfill.
      void this.refreshTools(name);
      mcpTransportPid = getStdioTransportPid(transport);
      mcpProcessIdentity =
        mcpTransportPid != null && this.connectionContext
          ? this.telemetry?.recordProcessStarted({
              connectionId: this.connectionContext.mcpConnectionId,
              pid: mcpTransportPid,
            })
          : undefined;
      // Previously, connection logs recorded only transport, so after auto negotiation it was
      // impossible to tell whether modern or legacy was used. Record both configured policy and SDK
      // handshake result so `auto` is not mistaken for the final protocol version.
      // Connection-pool context and stdio transport PID previously were not in the same event, so
      // they could not be correlated with the session, workspace, protocol version, and real child process;
      // stdio PID identifies only the final session transport, not the probe child.
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
      if (trigger && authorizationCodeOAuthConfig && !interactive) {
        // 恢复期不打开授权页面：修复前 5 次恢复各自发起一次交互授权。结果对模型表现为 needs-auth，
        // 由用户在设置页显式重连或下一次工具调用时授权。
        return this.failConnection({
          client,
          config,
          connectDurationMs,
          error,
          failureKind: "oauth_authorization_failed",
          generation,
          getRecentStderr,
          listToolsDurationMs,
          name,
          startedAt,
          transport,
        });
      }
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

  /** 调用期授权：Phase 2 交互授权成功后再按普通连接建立，失败收敛为 oauth_authorization_failed。 */
  private async authorizeThenConnect(
    input: Parameters<NodeMcpAdapter["openServerConnection"]>[0],
    config: Extract<McpServerConfig, { type: "http" | "sse" }>,
    oauthConfig: AuthorizationCodeOAuthConfig,
    trigger: InteractiveAuthorizationTrigger,
    startedAt: number,
  ): Promise<McpServerStatus> {
    const outcome = await this.runInteractiveOAuthAuthorization({
      config,
      generation: input.generation,
      name: input.name,
      oauthConfig,
      serverUrl: config.url,
      signal: input.abortController.signal,
      trigger,
    });
    if (outcome.status === "authorized" || outcome.status === "already-authorized") {
      return this.openServerConnection({
        ...input,
        oauthTrigger: undefined,
        oauthAuthorizationAttempted: true,
      });
    }
    return this.failConnection({
      config,
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
      // 修复原因：授权事务到期时 withTimeout 抛 McpTimeoutError，修复前这里先判为 connection_timeout，
      // 覆盖调用方传入的 oauth_authorization_failed：目录被清空，授权失败后的重连入口也不会触发。
      (error instanceof McpTimeoutError &&
      fallbackFailureKind !== "tool_list_failed" &&
      fallbackFailureKind !== "oauth_authorization_failed"
        ? "connection_timeout"
        : undefined) ??
      fallbackFailureKind ??
      "connection_failed";
    const displayMessage = responseDiagnostic?.serverRequestId
      ? `${message} - ${responseDiagnostic.serverRequestId}`
      : message;
    const recentStderr = getRecentStderr?.();
    // 子进程缺依赖等错误只写 stderr，SDK 通常只返回 Connection closed。
    // 把同一次连接的脱敏诊断带给设置页；只展示证据，不按错误文本改变失败分类或重试。
    const statusMessage =
      config.type === "stdio"
        ? [
            sanitizeMcpStdioStderr(displayMessage).slice(0, MCP_STDIO_ERROR_MESSAGE_MAX_CHARS),
            recentStderr,
          ]
            .filter(Boolean)
            .join("\n\n")
        : displayMessage;
    const status = this.createStatus(config, "failed", {
      error: statusMessage,
      errorCode: connectionErrorCode(error),
      failureKind,
      ...(responseDiagnostic?.serverRequestId
        ? { serverRequestId: responseDiagnostic.serverRequestId }
        : {}),
    });
    const mcpTransportPid = getStdioTransportPid(transport);
    await this.closeClientAndTransport(name, client, transport);
    if (!this.isCurrentConnection(name, generation)) {
      return this.records.get(name)?.status ?? status;
    }
    const record = this.records.get(name)!;
    record.client = undefined;
    record.transport = undefined;
    // 终态只由连接任务末尾提交一次；恢复的单次失败也不是 server 终态。
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
    nodeFallback?: McpNodeFallback,
  ): Promise<{ transport: McpTransport }> {
    if (config.type === "stdio") {
      return {
        transport: new ProcessTreeStdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd
            ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
            : (workingDirectory ?? this.workingDirectory),
          // The fallback merges after the server env: when a plugin brings its own PATH, the shim directory is still appended at the end.
          env: applyMcpNodeFallbackEnv(
            {
              ...buildMcpStdioEnv({ env: this.env, network: this.network }),
              ...config.env,
            },
            nodeFallback,
          ),
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

    // 服务端停掉时 HTTP/SSE 不派发 onclose；连续网络失败由同一失效入口进入恢复。
    const onNetworkFailures = () => {
      const client = this.records.get(serverName)?.client;
      if (client) this.invalidateConnection(serverName, generation, client);
    };
    const fetch = countNetworkFailures(
      createMcpTransportFetch({
        env: this.env,
        network: this.network,
      }),
      onNetworkFailures,
    );
    if (config.type === "http") {
      const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          // On the official-auth path authProvider must be undefined: do not persist OAuth
          // credentials, start a localhost callback server, or route 401/403 into the authorization flow.
          authProvider: this.createOAuthClientProvider(serverName, config),
          fetch: officialAuthFetch
            ? countNetworkFailures(officialAuthFetch, onNetworkFailures)
            : fetch,
          requestInit: config.headers ? { headers: config.headers } : undefined,
          // GET 事件流中断不代表 MCP session 失效；SDK 只恢复该流，保留并行 POST。
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
      ...(this.workspaceKey ? { workspaceKey: this.workspaceKey } : {}),
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
        // 授权 pending 是启动等待的结束边界：只结束 waiter，不取消授权或共享连接。
        if (this.isCurrentConnection(serverName, generation)) {
          for (const wake of this.authorizationWaiters.get(serverName) ?? []) wake();
        }
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

  private async closeRecord(
    name: string,
    record: McpServerRecord | undefined = this.records.get(name),
  ): Promise<void> {
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

  private readonly appConnectionListeners = new Map<string, Set<() => void>>();
  onAppConnectionInvalidated(name: string, listener: () => void): () => void {
    const listeners = this.appConnectionListeners.get(name) ?? new Set();
    listeners.add(listener);
    this.appConnectionListeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.appConnectionListeners.delete(name);
    };
  }
  async waitForAppConnection(
    name: string,
  ): Promise<{ identity: string; generation: number } | null> {
    const record = this.records.get(name);
    if (!record) return null;
    const generation = this.connectionGenerations.get(name) ?? 0;
    // Session restore completes before the MCP handshake; reuse the existing connection task so the first open does not misjudge connecting as failure.
    await record.connecting;
    return this.isCurrentConnection(name, generation) ? this.appConnectionSnapshot(name) : null;
  }

  appConnectionSnapshot(name: string): { identity: string; generation: number } | null {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") return null;
    // Expose only a summary to the host; credentials from configuration must not enter the protocol or logs. Config identity and connection reuse use the same key.
    return {
      identity: createHash("sha256")
        .update(
          JSON.stringify([
            process.platform,
            process.execPath,
            this.workingDirectory ?? "",
            name,
            mcpConfigKey(record.config),
          ]),
        )
        .digest("hex"),
      generation: this.connectionGenerations.get(name) ?? 0,
    };
  }

  private nextConnectionGeneration(name: string): number {
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);
    // eslint-disable-next-line unicorn/no-useless-spread -- A callback may add or remove listeners; keep the recipient set fixed for this notification.
    for (const listener of [...(this.appConnectionListeners.get(name) ?? [])]) listener();
    return generation;
  }

  private isCurrentConnection(name: string, generation: number): boolean {
    return this.connectionGenerations.get(name) === generation;
  }

  /** discovery 与目录刷新共用提交：先验证来源，再一次写入状态、目录和任务槽，最后通知。 */
  private commitConnected(
    name: string,
    record: McpServerRecord,
    client: McpClient,
    tools: McpToolDescriptor[],
    status: McpServerStatus,
  ): boolean {
    if (
      this.records.get(name) !== record ||
      record.client !== client ||
      record.abortController?.signal.aborted ||
      status.status !== "connected"
    )
      return false;
    record.status = { ...status, toolCount: tools.length };
    record.tools = tools;
    record.toolsVersion = ++this.toolsVersionCounter;
    record.connecting = undefined;
    this.notifySnapshot();
    return true;
  }

  /** 终态与目录一次写入；迟到任务只能结束自己的记录。 */
  private commitUnavailable(name: string, record: McpServerRecord, status: McpServerStatus): void {
    if (this.records.get(name) !== record) return;
    record.status = status;
    // 修复原因：授权未完成就结束、内建 server 超过重启上限时，修复前清空目录，工具离开模型视图，
    // 执行准入的重连没有入口。这两种保留目录，下一次执行准入重连；其他失败仍清空。
    if (!retainsCatalog(record.config, status)) {
      record.tools = [];
      record.toolsVersion = undefined;
    }
    record.connecting = undefined;
    this.notifySnapshot();
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
    this.notifySnapshot();
  }

  private createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      errorCode?: string;
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
      errorCode: extra.errorCode,
      failureKind: extra.failureKind,
      protocolEra: extra.protocolEra,
      serverRequestId: extra.serverRequestId,
    };
  }
}

/**
 * 不可用但保留目录的记录：授权未完成就结束，或来源 builtin 的 server 超过自动重启上限。
 * 工具留在会话视图里，下一次执行准入重连；其他失败清空目录。
 */
function retainsCatalog(config: McpServerConfig, status: McpServerStatus): boolean {
  return (
    status.failureKind === "oauth_authorization_failed" ||
    (status.failureKind === "unexpected_disconnect" && config.source?.kind === "builtin")
  );
}

function connectionErrorCode(error: unknown): string | undefined {
  if (error instanceof McpTimeoutError) return "CONNECT_TIMEOUT";
  if (!error || typeof error !== "object") return undefined;
  // 内部分组名不是端点错误码；只读取结构化诊断，不从错误文案猜测。
  const diagnostic = error as { status?: unknown; code?: unknown; cause?: { code?: unknown } };
  const code = diagnostic.status ?? diagnostic.code ?? diagnostic.cause?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
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
    // Subagent / workflow-child calls carry the top-level session that derived them, so a workspace-shared
    // server can let the child share state with the parent session (docs plugin viewer spec §8.2).
    ...(request.trace?.rootSessionId ? { root_session_id: request.trace.rootSessionId } : {}),
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
  let truncated = false;
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
        truncated = true;
      }
    },
    read() {
      // 尾部截断可能把 VE_SPEECH_MCP_TOKEN=... 切成 KEN=...，键名正则匹配不到会泄露值。
      // 截断后丢弃第一行残片，保证脱敏看到的每一行都完整。
      // 行边界含 \r（进度条只用 \r 刷新）。尾部完全没有换行时（单个超长行），
      // 空白/分隔符可能位于带引号的凭证值内部（KEN="a b" 的 b），从那里恢复会丢失键名和引号上下文而泄露后缀，
      // 没有可靠的字段边界就不输出，只保留传输错误。
      if (!truncated) return value;
      const lineEnd = value.search(/[\r\n]/);
      return lineEnd < 0 ? "" : value.slice(lineEnd + 1);
    },
  };
}

function sanitizeMcpStdioStderr(text: string): string {
  text = stripVTControlCharacters(text);
  // 插件常给敏感环境变量加前缀，例如 API_TOKEN、VE_SPEECH_MCP_TOKEN，不能只匹配裸 token。
  const sensitiveKey = String.raw`(?:[a-z0-9_.-]*[_-])?(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  // 引号中的凭证可能包含空格或转义引号，必须整体替换，不能只遮住第一个词。
  const quotedValue = String.raw`(["'])(?:\\.|(?!\2)[^\\\r\n])*\2`;
  result = result.replace(
    new RegExp(String.raw`(["']${sensitiveKey}["']\s*:\s*)${quotedValue}`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(String.raw`(\b${sensitiveKey}\b\s*[:=]\s*)${quotedValue}`, "gi"),
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

export {
  createDynamicMcpConfigSource,
  createMcpConfigSourceRegistry,
  type McpConfigSourceRegistry,
  type McpConfigurationSourceOptions,
} from "./config-source.js";

/** 重连与目录刷新共用可取消退避；只控制重试频率，不承担状态同步。 */
function waitForMcpRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
