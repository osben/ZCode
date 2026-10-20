import { LSP_METHOD_PULL_DIAGNOSTICS } from "./constants.js";
import {
  type LanguageServerAcquireResult,
  type LanguageServerEvent,
  type LanguageServerKey,
  type LanguageServerPort,
  type LanguageServerStatus,
  type Logger,
  type ResolvedLspServer,
  type TraceContext,
} from "@zcode/contracts";
import {
  LSP_DEFAULT_IDLE_SHUTDOWN_MS,
  LSP_DEFAULT_MAX_RUNNING_SERVERS,
  LSP_DEFAULT_NOT_INSTALLED_RETRY_MS,
  LSP_DEFAULT_UNAVAILABLE_RETRY_MS,
  LSP_LOGGER_MODULE,
} from "./constants.js";
import {
  buildLspProcessEnv,
  isLspCommandInstalled,
  type LspProcessEnvBase,
} from "./command-resolution.js";
import { createServerEntry, type LspServerEntry } from "./server-entry.js";
import {
  startServerProcess,
  stopServerProcess,
  type LspLifecycleDeps,
} from "./server-lifecycle.js";
import { defaultLspSpawn, type LspSpawnFn } from "./server-process.js";

export interface LanguageServerPoolOptions {
  logger?: Logger;
  /** Parent environment; sanitized like MCP stdio before `server.env` is overlaid. */
  baseEnv: LspProcessEnvBase;
  platform?: NodeJS.Platform;
  /** A server with no lease for this long is stopped. */
  idleShutdownMs?: number;
  /** At most this many servers run at once; the least recently used idle one is stopped first. */
  maxRunningServers?: number;
  now?: () => number;
  /** Injection point for tests; production uses `child_process.spawn`. */
  spawnImpl?: LspSpawnFn;
  /** After `not_installed`, acquire retries the spawn only once this much time has passed. */
  notInstalledRetryMs?: number;
  /** After the restart budget runs out, acquire makes one more start only once this much time has passed. */
  unavailableRetryMs?: number;
}

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => NOOP_LOGGER,
};

/** Pool key from spec §4: the root must match too, not only the identity. */
export function languageServerPoolKey(server: ResolvedLspServer, key: LanguageServerKey): string {
  return `${server.id}\0${key.identityKey}\0${key.workspacePath}`;
}

export function createLanguageServerPool(options: LanguageServerPoolOptions): LanguageServerPort {
  const logger = (options.logger ?? NOOP_LOGGER).child({ module: LSP_LOGGER_MODULE });
  const platform = options.platform ?? process.platform;
  const idleShutdownMs = options.idleShutdownMs ?? LSP_DEFAULT_IDLE_SHUTDOWN_MS;
  const maxRunningServers = options.maxRunningServers ?? LSP_DEFAULT_MAX_RUNNING_SERVERS;
  const notInstalledRetryMs = options.notInstalledRetryMs ?? LSP_DEFAULT_NOT_INSTALLED_RETRY_MS;
  const unavailableRetryMs = options.unavailableRetryMs ?? LSP_DEFAULT_UNAVAILABLE_RETRY_MS;
  const now = options.now ?? Date.now;
  const listeners = new Set<(event: LanguageServerEvent) => void>();
  const entries = new Map<string, LspServerEntry>();

  const emit = (event: LanguageServerEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn("LSP lifecycle listener threw", {
          event: "adapters.lsp.listener_failed",
          serverId: event.serverId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const deps: LspLifecycleDeps = {
    logger,
    platform,
    baseEnv: options.baseEnv,
    spawnImpl: options.spawnImpl ?? defaultLspSpawn,
    now,
    emit,
    scheduleIdle: (entry) => scheduleIdleCheck(entry, idleShutdownMs),
  };

  function acquire(
    server: ResolvedLspServer,
    key: LanguageServerKey,
    options?: { trace?: TraceContext },
  ): LanguageServerAcquireResult {
    const entry = getOrCreateEntry(server, key);
    entry.lastUsedAt = now();
    if (entry.stopping) return { state: "starting" };
    switch (entry.state) {
      case "ready":
        return entry.connection
          ? { state: "ready", connection: entry.connection }
          : { state: "starting" };
      case "starting":
        return { state: "starting" };
      case "stopped":
        return startFresh(entry, options?.trace);
      case "not_installed":
        if (now() < (entry.notInstalledAt ?? 0) + notInstalledRetryMs) return failedResult(entry);
        return startFresh(entry, options?.trace);
      case "crashed":
        if (server.restartOnCrash && entry.restarts < server.maxRestarts) {
          entry.restarts += 1;
          logger.info("LSP server restarting", {
            event: "adapters.lsp.restart",
            serverId: server.id,
            restarts: entry.restarts,
          });
          return startFresh(entry, options?.trace);
        }
        markUnavailable(entry);
        return failedResult(entry);
      case "unavailable":
        // A failed start is often fixed outside ZCode (dependencies installed in a fresh worktree),
        // so the budget is not final: one attempt per window, still triggered only by an acquire.
        if (entry.unavailableAt === undefined || now() < entry.unavailableAt + unavailableRetryMs) {
          return failedResult(entry);
        }
        entry.unavailableAt = undefined;
        logger.info("LSP server retrying after unavailable window", {
          event: "adapters.lsp.retry",
          serverId: server.id,
          restarts: entry.restarts,
        });
        return startFresh(entry, options?.trace);
    }
  }

  function markUnavailable(entry: LspServerEntry): void {
    entry.state = "unavailable";
    // restartOnCrash: false is the user's choice of no restarts, so that unavailable stays final.
    entry.unavailableAt = entry.server.restartOnCrash ? now() : undefined;
    logger.warn("LSP server unavailable after failed starts", {
      event: "adapters.lsp.unavailable",
      serverId: entry.server.id,
      restarts: entry.restarts,
      lastErrorCode: entry.lastErrorCode,
      ...(entry.unavailableAt === undefined ? {} : { retryAfterMs: unavailableRetryMs }),
    });
  }

  function startFresh(
    entry: LspServerEntry,
    trace: TraceContext | undefined,
  ): LanguageServerAcquireResult {
    ensureCapacity(entry);
    startServerProcess(entry, deps, trace);
    return entry.state === "starting" ? { state: "starting" } : failedResult(entry);
  }

  function failedResult(entry: LspServerEntry): LanguageServerAcquireResult {
    if (entry.state === "unavailable") {
      const detail = entry.lastErrorMessage ? `: ${entry.lastErrorMessage}` : "";
      const last = entry.lastErrorCode ? ` (last error: ${entry.lastErrorCode}${detail})` : "";
      return {
        state: "failed",
        code: "lsp_server_unavailable",
        message: `${entry.server.id} is unavailable after ${entry.restarts} restarts${last}`,
      };
    }
    return {
      state: "failed",
      code: entry.lastErrorCode ?? "lsp_server_unavailable",
      message: entry.lastErrorMessage ?? `${entry.server.id} is ${entry.state}`,
    };
  }

  function getOrCreateEntry(server: ResolvedLspServer, key: LanguageServerKey): LspServerEntry {
    const poolKey = languageServerPoolKey(server, key);
    const existing = entries.get(poolKey);
    if (existing) {
      existing.server = server;
      existing.key = key;
      return existing;
    }
    const created = createServerEntry(poolKey, key, server, now());
    entries.set(poolKey, created);
    return created;
  }

  /**
   * Makes room before a start: while `maxRunningServers` processes run, stops the least recently used one
   * that has no request in flight. When every candidate is busy the cap is exceeded and a warning is logged.
   */
  function ensureCapacity(target: LspServerEntry): void {
    // Servers still stopping hold a live process, so they count toward the cap; they just cannot
    // be evicted again. Without this a burst of starts overshoots the cap while victims shut down.
    const live = [...entries.values()].filter(
      (entry) => entry !== target && entry.process !== undefined,
    );
    const running = live.filter((entry) => entry.stopping === undefined);
    const excess = live.length - maxRunningServers + 1;
    if (excess <= 0) return;
    const idle = running
      .filter((entry) => (entry.process?.rpc.inFlightCount ?? 0) === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    if (idle.length < excess) {
      logger.warn("LSP running-server cap exceeded because every server has requests in flight", {
        event: "adapters.lsp.cap_exceeded",
        running: running.length,
        maxRunningServers,
      });
    }
    for (const victim of idle.slice(0, excess)) {
      logger.info("LSP server evicted by LRU cap", {
        event: "adapters.lsp.evicted",
        serverId: victim.server.id,
      });
      void stopEntry(victim);
    }
  }

  function scheduleIdleCheck(entry: LspServerEntry, delayMs: number): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    const timer = setTimeout(() => onIdleCheck(entry), delayMs);
    timer.unref();
    entry.idleTimer = timer;
  }

  function onIdleCheck(entry: LspServerEntry): void {
    entry.idleTimer = undefined;
    if (!entry.process || entry.stopping) return;
    const inFlight = entry.process.rpc.inFlightCount;
    const idleFor = now() - entry.lastUsedAt;
    if (inFlight === 0 && idleFor >= idleShutdownMs) {
      logger.info("LSP server idle, stopping", {
        event: "adapters.lsp.idle_stop",
        serverId: entry.server.id,
      });
      void stopEntry(entry);
      return;
    }
    scheduleIdleCheck(entry, inFlight > 0 ? idleShutdownMs : Math.max(1, idleShutdownMs - idleFor));
  }

  function stopEntry(entry: LspServerEntry): Promise<void> {
    return stopServerProcess(entry, deps).catch((error: unknown) => {
      logger.warn("LSP server stop failed", {
        event: "adapters.lsp.stop_failed",
        serverId: entry.server.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    acquire,
    async isInstalled(server: ResolvedLspServer): Promise<boolean> {
      return isLspCommandInstalled(server, {
        env: buildLspProcessEnv(server, options.baseEnv, platform),
        platform,
        cwd: process.cwd(),
      });
    },
    onEvent(listener: (event: LanguageServerEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    status(): LanguageServerStatus[] {
      return [...entries.values()].map((entry) => {
        const capabilities = entry.process?.initializeCapabilities ?? {};
        const pull =
          capabilities.diagnosticProvider !== undefined && capabilities.diagnosticProvider !== false
            ? true
            : (entry.process?.registry.hasMethod(LSP_METHOD_PULL_DIAGNOSTICS) ?? false);
        return {
          serverId: entry.server.id,
          identityKey: entry.key.identityKey,
          workspacePath: entry.key.workspacePath,
          state: entry.state,
          restarts: entry.restarts,
          diagnosticsMode: pull ? "pull" : "unknown",
          lastErrorCode: entry.lastErrorCode,
        };
      });
    },
    async stopAll(): Promise<void> {
      await Promise.all([...entries.values()].map((entry) => stopEntry(entry)));
    },
  };
}
