import {
  LspError,
  type LanguageServerEvent,
  type Logger,
  type LspErrorCode,
} from "@zcode/contracts";
import {
  LSP_METHOD_DID_CHANGE_CONFIGURATION,
  LSP_METHOD_EXIT,
  LSP_METHOD_INITIALIZE,
  LSP_METHOD_INITIALIZED,
  LSP_METHOD_SHUTDOWN,
} from "./constants.js";
import { buildInitializeParams, type LspInitializeParams } from "./client-capabilities.js";
import {
  buildLspProcessEnv,
  resolveLspSpawnCommand,
  type LspProcessEnvBase,
} from "./command-resolution.js";
import type { TraceContext } from "@zcode/contracts";
import { traceLogFields, type LspServerEntry } from "./server-entry.js";
import { LspServerConnection } from "./server-connection.js";
import {
  LspServerProcess,
  type LspServerProcessEvents,
  type LspSpawnFn,
} from "./server-process.js";

/** Callbacks and services the lifecycle needs. The pool wires them; the lifecycle holds no globals. */
export interface LspLifecycleDeps {
  logger: Logger;
  platform: NodeJS.Platform;
  baseEnv: LspProcessEnvBase;
  spawnImpl: LspSpawnFn;
  now(): number;
  emit(event: LanguageServerEvent): void;
  scheduleIdle(entry: LspServerEntry): void;
}

/**
 * Starts a process for `entry` and returns immediately. Initialization runs in the background and moves the
 * entry to `ready`, or to `crashed` / `not_installed` on failure. Callers never wait on this.
 */
export function startServerProcess(
  entry: LspServerEntry,
  deps: LspLifecycleDeps,
  trace?: TraceContext,
): void {
  const { server, key } = entry;
  entry.traceContext = trace;
  entry.state = "starting";
  entry.lastErrorCode = undefined;
  entry.lastErrorMessage = undefined;

  let proc: LspServerProcess;
  let params: LspInitializeParams;
  try {
    const env = buildLspProcessEnv(server, deps.baseEnv, deps.platform);
    const command = resolveLspSpawnCommand(server, {
      env,
      platform: deps.platform,
      cwd: key.workspacePath,
    });
    params = buildInitializeParams({
      server,
      workspacePath: key.workspacePath,
      platform: deps.platform,
      processId: globalThis.process.pid,
    });
    proc = new LspServerProcess({
      server,
      key,
      command,
      env,
      platform: deps.platform,
      spawnImpl: deps.spawnImpl,
      logger: deps.logger,
      settings: server.settings,
      workspaceFolders: params.workspaceFolders,
      startedAt: deps.now(),
      events: processEvents(entry, deps),
    });
  } catch (error) {
    recordStartFailure(entry, toLspError(error, "lsp_server_start_failed"), deps);
    return;
  }

  entry.process = proc;
  deps.logger.info("LSP server spawned", {
    event: "adapters.lsp.spawned",
    ...traceLogFields(trace),
    serverId: server.id,
    pid: proc.pid,
  });
  proc.rpc
    .sendRequest(LSP_METHOD_INITIALIZE, params, {
      timeoutMs: server.startupTimeoutMs,
      timeoutCode: "lsp_startup_timeout",
    })
    .then(
      (result) => onInitialized(entry, proc, result, deps),
      (error: unknown) =>
        failProcess(entry, proc, toLspError(error, "lsp_server_start_failed"), deps),
    );
}

/**
 * Graceful stop: `shutdown` request, then `exit`, then the process tree is killed if it is still alive.
 * Concurrent calls share one stop.
 */
export function stopServerProcess(entry: LspServerEntry, deps: LspLifecycleDeps): Promise<void> {
  if (entry.stopping) return entry.stopping;
  const proc = entry.process;
  if (!proc) {
    if (entry.state === "ready" || entry.state === "starting") entry.state = "stopped";
    return Promise.resolve();
  }
  entry.stopping = gracefulStop(entry, proc, deps).finally(() => {
    entry.stopping = undefined;
  });
  return entry.stopping;
}

function processEvents(entry: LspServerEntry, deps: LspLifecycleDeps): LspServerProcessEvents {
  return {
    onSpawnError: (proc, error) => handleSpawnError(entry, proc, error, deps),
    onExit: (proc, code, signal) => {
      if (proc.stopRequested) return;
      const detail = `exited (code ${code ?? "none"}, signal ${signal ?? "none"})`;
      const error = proc.initialized
        ? new LspError("lsp_server_crashed", `${proc.server.id} ${detail}`)
        : new LspError(
            "lsp_server_start_failed",
            `${proc.server.id} ${detail} before initialization`,
          );
      failProcess(entry, proc, error, deps);
    },
    onProtocolError: (proc, error) => {
      deps.logger.warn("LSP stream is not valid JSON-RPC; treating server as crashed", {
        event: "adapters.lsp.protocol_error",
        serverId: proc.server.id,
        pid: proc.pid,
        message: error.message,
      });
      const code = proc.initialized ? "lsp_server_crashed" : "lsp_server_start_failed";
      failProcess(
        entry,
        proc,
        new LspError(code, `${proc.server.id} sent an invalid LSP frame`),
        deps,
      );
    },
  };
}

function onInitialized(
  entry: LspServerEntry,
  proc: LspServerProcess,
  result: unknown,
  deps: LspLifecycleDeps,
): void {
  if (proc.stopRequested) return;
  proc.initializeCapabilities = asRecord(asRecord(result).capabilities);
  proc.initialized = true;
  proc.rpc.notify(LSP_METHOD_INITIALIZED, {});
  if (proc.server.settings !== undefined) {
    proc.rpc.notify(LSP_METHOD_DID_CHANGE_CONFIGURATION, { settings: proc.server.settings });
  }
  entry.state = "ready";
  entry.lastErrorCode = undefined;
  entry.lastErrorMessage = undefined;
  const connection = new LspServerConnection(proc, () => {
    entry.lastUsedAt = deps.now();
  });
  entry.connection = connection;
  deps.logger.info("LSP server ready", {
    event: "adapters.lsp.ready",
    ...traceLogFields(entry.traceContext),
    serverId: proc.server.id,
    pid: proc.pid,
    durationMs: deps.now() - proc.startedAt,
  });
  deps.emit({ type: "ready", serverId: proc.server.id, key: entry.key, connection });
  deps.scheduleIdle(entry);
}

function handleSpawnError(
  entry: LspServerEntry,
  proc: LspServerProcess,
  error: NodeJS.ErrnoException,
  deps: LspLifecycleDeps,
): void {
  if (proc.stopRequested) return;
  proc.stopRequested = true;
  detach(entry, proc);
  const serverId = proc.server.id;
  if (error.code === "ENOENT") {
    const message = `command "${proc.server.command}" was not found`;
    entry.state = "not_installed";
    entry.notInstalledAt = deps.now();
    entry.lastErrorCode = "lsp_server_not_installed";
    entry.lastErrorMessage = message;
    deps.logger.warn("LSP server command is not installed", {
      event: "adapters.lsp.not_installed",
      ...traceLogFields(entry.traceContext),
      serverId,
    });
    proc.rpc.close(new LspError("lsp_server_not_installed", `${serverId}: ${message}`));
    return;
  }
  const message = `failed to spawn (${error.code ?? "unknown error"})`;
  entry.state = "crashed";
  entry.lastErrorCode = "lsp_server_start_failed";
  entry.lastErrorMessage = message;
  deps.logger.warn("LSP server failed to spawn", {
    event: "adapters.lsp.start_failed",
    serverId,
    code: error.code,
  });
  proc.rpc.close(new LspError("lsp_server_start_failed", `${serverId}: ${message}`));
}

/**
 * Single place where a process is declared finished for a failure. Later events for the same process
 * (its `exit`, rejected pending requests) see `stopRequested` and do nothing.
 */
function failProcess(
  entry: LspServerEntry,
  proc: LspServerProcess,
  error: LspError,
  deps: LspLifecycleDeps,
): void {
  if (proc.stopRequested) return;
  proc.stopRequested = true;
  const wasInitialized = proc.initialized;
  detach(entry, proc);
  const message = wasInitialized ? error.message : withStderrTail(error.message, proc.stderrTail);
  entry.state = "crashed";
  entry.lastErrorCode = error.code;
  entry.lastErrorMessage = message;
  proc.rpc.close(new LspError("lsp_server_crashed", message, { cause: error }));
  if (wasInitialized) {
    deps.logger.info("LSP server crashed", {
      event: "adapters.lsp.crashed",
      ...traceLogFields(entry.traceContext),
      serverId: proc.server.id,
      pid: proc.pid,
      durationMs: deps.now() - proc.startedAt,
      code: error.code,
    });
    deps.emit({ type: "crashed", serverId: proc.server.id, key: entry.key });
  } else {
    deps.logger.warn("LSP server failed to start", {
      event: "adapters.lsp.start_failed",
      ...traceLogFields(entry.traceContext),
      serverId: proc.server.id,
      pid: proc.pid,
      code: error.code,
    });
  }
  proc.terminate().catch((killError: unknown) => {
    deps.logger.warn("LSP process tree kill failed", {
      event: "adapters.lsp.kill_failed",
      serverId: proc.server.id,
      pid: proc.pid,
      message: killError instanceof Error ? killError.message : String(killError),
    });
  });
}

async function gracefulStop(
  entry: LspServerEntry,
  proc: LspServerProcess,
  deps: LspLifecycleDeps,
): Promise<void> {
  const serverId = proc.server.id;
  const stopStartedAt = deps.now();
  const shutdownTimeoutMs = proc.server.shutdownTimeoutMs;
  proc.stopRequested = true;
  clearIdle(entry);
  if (proc.initialized && !proc.exited) {
    try {
      await proc.rpc.sendRequest(LSP_METHOD_SHUTDOWN, undefined, {
        timeoutMs: shutdownTimeoutMs,
        timeoutCode: "lsp_request_timeout",
      });
    } catch (error) {
      deps.logger.warn("LSP shutdown request did not complete; sending exit", {
        event: "adapters.lsp.shutdown_failed",
        serverId,
        code: error instanceof LspError ? error.code : undefined,
      });
    }
    proc.rpc.notify(LSP_METHOD_EXIT);
    await proc.waitForExit(shutdownTimeoutMs);
  }
  if (!proc.exited) {
    deps.logger.warn("LSP server did not exit in time; killing process tree", {
      event: "adapters.lsp.forced_kill",
      serverId,
      pid: proc.pid,
    });
  }
  try {
    await proc.terminate();
  } catch (error) {
    deps.logger.warn("LSP process tree kill failed", {
      event: "adapters.lsp.kill_failed",
      serverId,
      pid: proc.pid,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  proc.rpc.close(new LspError("lsp_server_unavailable", `${serverId} was stopped`));
  detach(entry, proc);
  entry.state = "stopped";
  deps.logger.info("LSP server stopped", {
    event: "adapters.lsp.stopped",
    serverId,
    pid: proc.pid,
    durationMs: deps.now() - stopStartedAt,
  });
  deps.emit({ type: "stopped", serverId, key: entry.key });
}

/** Records a failure that happened before any process existed (for example `command` resolution). */
function recordStartFailure(entry: LspServerEntry, error: LspError, deps: LspLifecycleDeps): void {
  entry.state = "crashed";
  entry.lastErrorCode = error.code;
  entry.lastErrorMessage = error.message;
  deps.logger.warn("LSP server failed to start", {
    event: "adapters.lsp.start_failed",
    ...traceLogFields(entry.traceContext),
    serverId: entry.server.id,
    code: error.code,
  });
}

function detach(entry: LspServerEntry, proc: LspServerProcess): void {
  if (entry.process === proc) {
    entry.process = undefined;
    entry.connection = undefined;
  }
  clearIdle(entry);
}

function clearIdle(entry: LspServerEntry): void {
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function withStderrTail(message: string, stderrTail: string): string {
  const tail = stderrTail.trim();
  return tail.length === 0 ? message : `${message}; stderr tail: ${tail}`;
}

function toLspError(error: unknown, fallback: LspErrorCode): LspError {
  if (error instanceof LspError) return error;
  return new LspError(fallback, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
