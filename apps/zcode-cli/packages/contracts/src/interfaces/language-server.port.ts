// ============================================================
// LanguageServerPort - long-lived language server processes
// ============================================================
// Spec: apps/zcode-cli/docs/design/v2/tool/19-lsp.md §4-§5.
// The adapter owns processes, JSON-RPC framing, capabilities and restarts.
// Core owns documents and diagnostics and only talks through this port.

import type { LanguageServerStatus, LspErrorCode, ResolvedLspServer } from "../lsp/index.js";
import type { TraceContext } from "../tracing/tracer.js";

/** Pool key: identity alone is not enough, the root must match too (spec §4). */
export interface LanguageServerKey {
  /** `workspaceIdentity?.trim() || workspacePath`. */
  identityKey: string;
  /** Absolute workspace root used for `rootUri`. */
  workspacePath: string;
}

export interface LanguageServerRequestOptions {
  signal?: AbortSignal;
  /** Overrides the server's requestTimeout downward; never upward. */
  timeoutMs?: number;
}

export interface LanguageServerConnection {
  readonly server: ResolvedLspServer;
  readonly key: LanguageServerKey;
  /** `InitializeResult.capabilities` as returned by the server. */
  readonly capabilities: Readonly<Record<string, unknown>>;
  /**
   * Sends a request. Rejects with `LspError` (`lsp_request_timeout`, `lsp_cancelled`,
   * `lsp_server_crashed`). Cancellation sends `$/cancelRequest`.
   */
  request<T = unknown>(
    method: string,
    params: unknown,
    options?: LanguageServerRequestOptions,
  ): Promise<T>;
  notify(method: string, params: unknown): void;
  /** Subscribes to server notifications; returns an unsubscribe function. */
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

export type LanguageServerAcquireResult =
  | { state: "ready"; connection: LanguageServerConnection }
  | { state: "starting" }
  | { state: "failed"; code: LspErrorCode; message: string };

export type LanguageServerEvent =
  | {
      type: "ready";
      serverId: string;
      key: LanguageServerKey;
      connection: LanguageServerConnection;
    }
  | { type: "stopped" | "crashed"; serverId: string; key: LanguageServerKey };

export interface LanguageServerPort {
  /**
   * Returns immediately. Starts the server when it is not running; never waits for
   * initialization (spec §5: startup never blocks a tool call).
   */
  acquire(
    server: ResolvedLspServer,
    key: LanguageServerKey,
    options?: { trace?: TraceContext },
  ): LanguageServerAcquireResult;
  /** Resolves `command` on PATH (PATHEXT on Windows) without starting anything. */
  isInstalled(server: ResolvedLspServer): Promise<boolean>;
  /** Lifecycle events for ready/stopped/crashed transitions; returns an unsubscribe function. */
  onEvent(listener: (event: LanguageServerEvent) => void): () => void;
  status(): LanguageServerStatus[];
  /** Graceful shutdown of every server (global toggle off, runtime exit). */
  stopAll(): Promise<void>;
}
