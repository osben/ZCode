import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import type { McpTelemetryTracker } from "./telemetry.js";

const DEFAULT_IDLE_GRACE_MS = 30_000;

export interface CreateMcpAdapterForPoolInput {
  connectionContext: McpConnectionContext;
  config: McpServerConfig;
  serverName: string;
  workingDirectory?: string;
}

export interface McpConnectionContext {
  mcpConnectionId: string;
  mcpIsolation: "session" | "workspace";
  sessionId?: string;
  workspaceKey?: string;
}

export interface McpConnectionPoolOptions {
  createAdapter(input: CreateMcpAdapterForPoolInput): McpPort;
  idleGraceMs?: number;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
}

export interface McpConnectionPool {
  acquireLease(options?: { leaseId?: string; sessionId?: string }): McpPort;
  close(): Promise<void>;
  stats(): { activeConnections: number; pendingCloseConnections: number };
}

interface PoolEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  connectionContext: McpConnectionContext;
  connecting: Promise<McpServerStatus>;
  key: string;
  refs: Set<string>;
  /** Concurrent liveness checks for the same entry share one probe, avoiding duplicate pings/reconnections. */
  revalidating?: Promise<void>;
  controller: AbortController;
  closing?: Promise<void>;
  serverName: string;
}

export function createMcpConnectionPool(options: McpConnectionPoolOptions): McpConnectionPool {
  const entries = new Map<string, PoolEntry>();
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const logger = options.logger?.child({ module: "adapters.mcp.pool" });
  let closed = false;
  let leaseSequence = 0;

  const closeEntry = (entry: PoolEntry): Promise<void> => {
    entry.closing ??= (async () => {
      if (entry.closeTimer) clearTimeout(entry.closeTimer);
      entry.closeTimer = undefined;
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      entry.controller.abort(new Error("MCP connection closed"));
      try {
        await entry.adapter.close();
        logger?.info("MCP pooled connection closed", {
          ...entry.connectionContext,
          event: "mcp.pool.connection.closed",
          mcpServerName: entry.serverName,
          status: "completed",
        });
      } finally {
        options.telemetry?.unregisterConnection({
          connectionId: entry.connectionContext.mcpConnectionId,
        });
      }
    })();
    return entry.closing;
  };
  const closeIdleEntry = (entry: PoolEntry): void => {
    void closeEntry(entry).catch((error: unknown) =>
      logger?.warn("MCP pooled connection close failed", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.close.failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const scheduleClose = (entry: PoolEntry): void => {
    if (entry.closeTimer) return;
    if (idleGraceMs <= 0) {
      closeIdleEntry(entry);
      return;
    }
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = undefined;
      if (entry.refs.size === 0) closeIdleEntry(entry);
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };

  // The settings page's mcpPort is a process-level `protocol-settings` lease. connectionKey contains only
  // serverName + leaseId + config, so when config is unchanged each mcp/list call hits the same entry and returns
  // the already-resolved promise from the first connection—without reconnecting, probing, or logging. Stopped
  // HTTP/SSE MCP servers do not dispatch onclose, so the settings page would keep showing “connected and available”
  // no matter how often it refreshed. When revalidation is explicitly requested, check that the connection is still
  // alive and reconnect in place if it is dead (preserving entry identity so other leases sharing it are not interrupted as “not leased”).
  const revalidateEntry = async (
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void> => {
    if (entry.revalidating) {
      await entry.revalidating;
      return;
    }
    const run = (async () => {
      const connected = await entry.connecting.then(
        () => true,
        () => false,
      );
      const state = connected
        ? (await entry.adapter.status())[entry.serverName]?.status
        : undefined;
      // Do not disturb an in-progress handshake (including pending OAuth authorization) or explicit disabled/pending-trust states:
      // reconnecting would invalidate the authorization URL and PKCE/state already open in the browser.
      if (state === "connecting" || state === "disabled" || state === "untrusted") {
        return;
      }
      if (state === "connected") {
        const alive = (await entry.adapter.pingServer?.(entry.serverName)) ?? true;
        if (alive) {
          logger?.debug("MCP pooled connection revalidated", {
            ...entry.connectionContext,
            event: "mcp.pool.connection.revalidated",
            mcpServerName: entry.serverName,
            status: "completed",
          });
          return;
        }
      }
      logger?.warn("MCP pooled connection is stale; reconnecting", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.stale",
        mcpConnectionState: state ?? "unknown",
        mcpServerName: entry.serverName,
        status: "started",
      });
      entry.controller.signal.throwIfAborted();
      entry.connecting = entry.adapter.connectServer(entry.serverName, config, {
        ...connectOptions,
        signal: entry.controller.signal,
      });
      // status()/the caller awaiting entry.connecting already reports failures; do not surface them again here.
      await entry.connecting.catch(() => undefined);
    })();
    entry.revalidating = run.finally(() => {
      entry.revalidating = undefined;
    });
    await entry.revalidating;
  };

  const acquireLease = (leaseOptions: { leaseId?: string; sessionId?: string } = {}): McpPort => {
    if (closed) throw new Error("MCP connection pool is closed");
    const leaseId = `${++leaseSequence}:${leaseOptions.leaseId ?? "lease"}`;
    const sessionId = leaseOptions.sessionId?.trim() || undefined;
    const leased = new Map<string, string>();
    const configuredServers = new Map<string, McpServerConfig>();
    const appListeners = new Map<string, Set<{ listener: () => void; off: () => void }>>();
    const invalidateApps = (serverName: string) => {
      const watchers = appListeners.get(serverName);
      appListeners.delete(serverName);
      for (const watcher of watchers ?? []) {
        watcher.off();
        watcher.listener();
      }
    };
    let leaseClosed = false;
    const leaseShutdown = new AbortController();
    let leaseClose: Promise<void> | undefined;
    const assertOpen = () => {
      if (leaseClosed || closed) throw new Error("MCP session lease is closed");
    };
    const callerSignal = (signal?: AbortSignal) =>
      signal ? AbortSignal.any([leaseShutdown.signal, signal]) : leaseShutdown.signal;
    const wait = async <T>(work: Promise<T>, signal = leaseShutdown.signal): Promise<T> => {
      signal.throwIfAborted();
      let abort: (() => void) | undefined;
      try {
        const value = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
        signal.throwIfAborted();
        return value;
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
      }
    };
    let sessionStartupReported = false;

    const requireEntry = (serverName: string): PoolEntry => {
      assertOpen();
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (serverName: string, immediate = false): Promise<void> | undefined => {
      const key = leased.get(serverName);
      if (!key) return;
      leased.delete(serverName);
      invalidateApps(serverName);
      const entry = entries.get(key);
      if (!entry) return;
      if (!entry.refs.delete(leaseId)) return;
      options.telemetry?.releaseOwner({
        connectionId: entry.connectionContext.mcpConnectionId,
        ownerId: leaseId,
      });
      logger?.info("MCP connection lease released", {
        ...entry.connectionContext,
        event: "mcp.pool.lease.released",
        mcpLeaseId: leaseId,
        mcpServerName: serverName,
        refCount: entry.refs.size,
        ...(sessionId ? { sessionId } : {}),
      });
      if (entry.refs.size === 0) {
        if (immediate && entry.connectionContext.mcpIsolation === "session")
          return closeEntry(entry);
        scheduleClose(entry);
      }
    };

    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      assertOpen();
      const signal = callerSignal(connectOptions.signal);
      signal.throwIfAborted();
      const key = connectionKey({
        config,
        connectOptions,
        leaseId,
        serverName,
      });
      const previousKey = leased.get(serverName);
      let entry = entries.get(key);
      const reused = entry !== undefined;
      let ownerAdded = false;
      if (entry) {
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.closeTimer = undefined;
        const previousRefCount = entry.refs.size;
        entry.refs.add(leaseId);
        ownerAdded = entry.refs.size !== previousRefCount;
      } else {
        // Pool, adapter, and stdio PID logs previously had no stable correlation key, so it was
        // impossible to trace a session to its MCP child process. Fix the connection context when the
        // entry is created; later leases share the same ID.
        const connectionContext = createConnectionContext({
          config,
          connectOptions,
          sessionId,
        });
        options.telemetry?.registerConnection({
          connectionId: connectionContext.mcpConnectionId,
          isolation: connectionContext.mcpIsolation,
          serverName,
          ...(config.source
            ? {
                source:
                  config.source.kind === "user" || config.source.kind === "workspace"
                    ? "custom"
                    : config.source.kind,
              }
            : {}),
        });
        const adapter = options.createAdapter({
          connectionContext,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
        });
        // The connection belongs to the pool and must not inherit the first session's close
        // signal, or it would abort the other leases along with it.
        const controller = new AbortController();
        entry = {
          adapter,
          controller,
          connectionContext,
          connecting: adapter.connectServer(serverName, config, {
            ...connectOptions,
            signal: controller.signal,
          }),
          key,
          refs: new Set([leaseId]),
          serverName,
        };
        entries.set(key, entry);
        ownerAdded = true;
        logger?.info("MCP pooled connection created", {
          ...connectionContext,
          event: "mcp.pool.connection.created",
          mcpServerName: serverName,
          transport: config.type,
        });
      }
      if (previousKey && previousKey !== key) {
        invalidateApps(serverName);
        const previous = entries.get(previousKey);
        if (previous) {
          if (previous.refs.delete(leaseId)) {
            options.telemetry?.releaseOwner({
              connectionId: previous.connectionContext.mcpConnectionId,
              ownerId: leaseId,
            });
            logger?.info("MCP connection lease released", {
              ...previous.connectionContext,
              event: "mcp.pool.lease.released",
              mcpLeaseId: leaseId,
              mcpServerName: serverName,
              refCount: previous.refs.size,
              ...(sessionId ? { sessionId } : {}),
            });
            if (previous.refs.size === 0) scheduleClose(previous);
          }
        }
      }
      leased.set(serverName, key);
      if (ownerAdded) {
        options.telemetry?.acquireOwner({
          connectionId: entry.connectionContext.mcpConnectionId,
          ownerId: leaseId,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      if (previousKey !== key) {
        // Workspace-isolated connections can be shared by multiple sessions, so the first session
        // cannot be recorded as the sole owner. Record each lease lifecycle to represent this many-to-one
        // relationship accurately.
        logger?.info("MCP connection lease acquired", {
          ...entry.connectionContext,
          event: "mcp.pool.lease.acquired",
          mcpLeaseId: leaseId,
          mcpServerName: serverName,
          refCount: entry.refs.size,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      // The reference is registered before any wait; even with close and revalidate
      // interleaving, no late lease can appear.
      if (reused && connectOptions.revalidate)
        await wait(revalidateEntry(entry, config, connectOptions), signal);
      return await wait(entry.connecting, signal);
    };

    const snapshot = async (): Promise<McpConnectionSnapshot> => {
      assertOpen();
      const statuses: Record<string, McpServerStatus> = {};
      const tools: McpToolDescriptor[] = [];
      for (const [serverName, key] of leased) {
        const entry = entries.get(key);
        if (!entry) continue;
        const status = (await entry.adapter.status())[serverName];
        if (status) statuses[serverName] = status;
        tools.push(...(await entry.adapter.listTools()));
      }
      assertOpen();
      if (sessionId && !sessionStartupReported) {
        sessionStartupReported = true;
        const enabledServers = [...configuredServers].filter(
          ([, config]) => config.enabled !== false,
        );
        const connectedCount = enabledServers.filter(
          ([serverName]) => statuses[serverName]?.status === "connected",
        ).length;
        options.telemetry?.recordSessionStartup({
          configuredCount: enabledServers.length,
          connectedCount,
          failedCount: enabledServers.length - connectedCount,
          processCount: enabledServers.filter(
            ([serverName, config]) =>
              config.type === "stdio" && statuses[serverName]?.status === "connected",
          ).length,
          sessionId,
        });
      }
      return { statuses, tools };
    };

    return {
      async waitForAppConnection(serverName) {
        const key = leased.get(serverName);
        if (!key) return null;
        const entry = entries.get(key);
        if (!entry) return null;
        const connecting = entry.connecting;
        try {
          await wait(connecting);
          const source = entry.adapter.waitForAppConnection
            ? await wait(entry.adapter.waitForAppConnection(serverName))
            : (entry.adapter.appConnectionSnapshot?.(serverName) ?? null);
          // The shared connection may still be held by other sessions; the end of a wait must
          // not revive this session's already-released or re-sourced lease.
          return !leaseClosed &&
            leased.get(serverName) === key &&
            entries.get(key) === entry &&
            entry.connecting === connecting
            ? source
            : null;
        } catch (error) {
          if (leaseClosed) return null;
          throw error;
        }
      },
      appConnectionSnapshot(serverName) {
        const key = leased.get(serverName);
        return key ? (entries.get(key)?.adapter.appConnectionSnapshot?.(serverName) ?? null) : null;
      },
      onAppConnectionInvalidated(serverName, listener) {
        const entry = requireEntry(serverName);
        const watchers = appListeners.get(serverName) ?? new Set();
        const watcher = {
          listener,
          off: entry.adapter.onAppConnectionInvalidated?.(serverName, listener) ?? (() => {}),
        };
        watchers.add(watcher);
        appListeners.set(serverName, watchers);
        return () => {
          watcher.off();
          watchers.delete(watcher);
          if (!watchers.size) appListeners.delete(serverName);
        };
      },
      async callTool(
        request: McpCallToolRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpToolCallResult> {
        return await requireEntry(request.serverName).adapter.callTool(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async readResource(
        request: McpReadResourceRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpReadResourceResult> {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.readResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.readResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      // Resource listing and subscriptions use the adapter in the same entry; the registry lives in the adapter (connection layer) and is shared across sessions.
      async listResources(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResources) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResources(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async listResourceTemplates(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResourceTemplates) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResourceTemplates(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async subscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.subscribeResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        await adapter.subscribeResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async unsubscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.unsubscribeResource) return;
        await adapter.unsubscribeResource(request, {
          ...callOptions,
          signal: callerSignal(callOptions?.signal),
        });
      },
      async unsubscribeResourcesBySubscriber(prefix) {
        let released = 0;
        const seen = new Set<string>();
        for (const key of leased.values()) {
          if (seen.has(key)) continue;
          seen.add(key);
          const adapter = entries.get(key)?.adapter;
          if (adapter?.unsubscribeResourcesBySubscriber) {
            released += await adapter.unsubscribeResourcesBySubscriber(prefix);
          }
        }
        return released;
      },
      close(): Promise<void> {
        leaseClosed = true;
        leaseShutdown.abort(new Error("MCP session lease closed"));
        leaseClose ??= Promise.allSettled(
          [...leased.keys()].map((name) => release(name, true)),
        ).then((results) => {
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length) throw new AggregateError(errors, "MCP lease cleanup failed");
        });
        return leaseClose;
      },
      async connectConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        assertOpen();
        callerSignal(connectOptions.signal).throwIfAborted();
        configuredServers.clear();
        for (const [serverName, config] of Object.entries(servers)) {
          configuredServers.set(serverName, config);
        }
        const configuredNames = new Set(Object.keys(servers));
        for (const serverName of [...leased.keys()]) {
          if (!configuredNames.has(serverName)) release(serverName);
        }
        await Promise.all(
          Object.entries(servers).map(([serverName, config]) =>
            acquire(serverName, config, connectOptions),
          ),
        );
        callerSignal(connectOptions.signal).throwIfAborted();
        return await wait(snapshot(), callerSignal(connectOptions.signal));
      },
      async connectServer(
        serverName: string,
        config: McpServerConfig,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpServerStatus> {
        return await acquire(serverName, config, connectOptions);
      },
      async disconnectServer(serverName: string): Promise<McpServerStatus | undefined> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        const status = entry ? (await entry.adapter.status())[serverName] : undefined;
        release(serverName);
        return status
          ? {
              ...status,
              status: "disconnected",
              toolCount: 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return (await snapshot()).tools;
      },
      toolListRevision(): number {
        let revision = 0;
        for (const key of new Set(leased.values())) {
          revision += entries.get(key)?.adapter.toolListRevision?.() ?? 0;
        }
        return revision;
      },
      async pingServer(serverName: string, pingOptions?: { timeoutMs?: number }): Promise<boolean> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        if (!entry) return false;
        return (await entry.adapter.pingServer?.(serverName, pingOptions)) ?? true;
      },
      async status(): Promise<Record<string, McpServerStatus>> {
        return (await snapshot()).statuses;
      },
    };
  };

  return {
    acquireLease,
    async close(): Promise<void> {
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      await Promise.all(pending.map(closeEntry));
    },
    stats() {
      return {
        activeConnections: entries.size,
        pendingCloseConnections: [...entries.values()].filter((entry) => entry.refs.size === 0)
          .length,
      };
    },
  };
}

function createConnectionContext(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  sessionId?: string;
}): McpConnectionContext {
  const mcpIsolation = input.config.isolation === "workspace" ? "workspace" : "session";
  const workspaceKey = resolveWorkspaceKey(input.connectOptions);
  return {
    mcpConnectionId: randomUUID(),
    mcpIsolation,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(mcpIsolation === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

function resolveWorkspaceKey(connectOptions: McpConnectOptions): string | undefined {
  return (
    connectOptions.workspaceIdentity?.trim() || connectOptions.workingDirectory?.trim() || undefined
  );
}

function connectionKey(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  leaseId: string;
  serverName: string;
}): string {
  // Isolate by session by default; reuse across sessions only for stateless servers that explicitly
  // declare workspace isolation.
  const scope =
    input.config.isolation === "workspace"
      ? (resolveWorkspaceKey(input.connectOptions) ?? "")
      : input.leaseId;
  return [input.serverName, scope, stableStringify(input.config)].join("\u0000");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
