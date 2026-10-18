import type { Readable, Writable } from "node:stream";
import { LspError, type Logger } from "@zcode/contracts";
import {
  LSP_JSON_RPC_INTERNAL_ERROR,
  LSP_JSON_RPC_METHOD_NOT_FOUND,
  LSP_JSON_RPC_REQUEST_CANCELLED,
  LSP_JSON_RPC_VERSION,
  LSP_LOG_PAYLOAD_MAX_CHARS,
  LSP_METHOD_CANCEL_REQUEST,
  LSP_METHOD_LOG_MESSAGE,
  LSP_METHOD_PROGRESS,
} from "./constants.js";
import {
  encodeJsonRpcFrame,
  JsonRpcFrameDecoder,
  JsonRpcFramingError,
  JsonRpcResponseError,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./json-rpc.js";

export interface LspRpcRequestOptions {
  signal?: AbortSignal;
  /** Undefined means no local timeout. */
  timeoutMs?: number;
  /** Error code used when the local timeout fires (`lsp_request_timeout` or `lsp_startup_timeout`). */
  timeoutCode: "lsp_request_timeout" | "lsp_startup_timeout";
}

export interface LspJsonRpcConnectionOptions {
  serverId: string;
  stdin: Writable;
  stdout: Readable;
  logger: Logger;
  /** Answers a server-to-client request. Throw `JsonRpcResponseError` to pick the error code. */
  handleServerRequest: (method: string, params: unknown) => unknown | Promise<unknown>;
  /** Called once when the byte stream stops being valid LSP; the owner must treat the server as crashed. */
  onProtocolError: (error: JsonRpcFramingError) => void;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: LspError): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type NotificationHandler = (params: unknown) => void;

/**
 * JSON-RPC over one child process's stdio. It owns request ids, timeouts, cancellation and
 * dispatch. It knows nothing about LSP lifecycle; the pool decides what a closed connection means.
 */
export class LspJsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly subscribers = new Map<string, Set<NotificationHandler>>();
  private readonly decoder = new JsonRpcFrameDecoder();
  private closedError: LspError | undefined;

  constructor(private readonly options: LspJsonRpcConnectionOptions) {
    options.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // A write to a dead process emits EPIPE here; the exit handler owns the consequence.
    options.stdin.on("error", (error: Error) => {
      this.options.logger.debug("LSP stdin write failed", {
        event: "adapters.lsp.stdin_error",
        serverId: this.options.serverId,
        code: (error as NodeJS.ErrnoException).code,
      });
    });
  }

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  get inFlightCount(): number {
    return this.pending.size;
  }

  sendRequest<T = unknown>(
    method: string,
    params: unknown,
    options: LspRpcRequestOptions,
  ): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (options.signal?.aborted) {
      return Promise.reject(
        new LspError("lsp_cancelled", `${method} was cancelled before sending`),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (options.timeoutMs !== undefined) {
        const timeoutMs = options.timeoutMs;
        request.timer = setTimeout(() => {
          this.cancelPending(
            id,
            new LspError(options.timeoutCode, `${method} timed out after ${timeoutMs} ms`),
            true,
          );
        }, timeoutMs);
      }
      if (options.signal) {
        const signal = options.signal;
        request.signal = signal;
        request.onAbort = () => {
          this.cancelPending(id, new LspError("lsp_cancelled", `${method} was cancelled`), true);
        };
        signal.addEventListener("abort", request.onAbort, { once: true });
      }
      this.pending.set(id, request);
      this.write({ jsonrpc: LSP_JSON_RPC_VERSION, id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.write({ jsonrpc: LSP_JSON_RPC_VERSION, method, params });
  }

  subscribe(method: string, handler: NotificationHandler): () => void {
    let handlers = this.subscribers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  /** Rejects every in-flight request with `error`. Idempotent; later requests reject with the same error. */
  close(error: LspError): void {
    if (this.closedError) return;
    this.closedError = error;
    // Map iteration tolerates deleting the entry just visited, so no snapshot array is needed.
    for (const id of this.pending.keys()) {
      this.cancelPending(id, error, false);
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closedError) return;
    let messages: JsonRpcMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.options.onProtocolError(error as JsonRpcFramingError);
      return;
    }
    for (const message of messages) {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    this.logPayload("in", message);
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === "string") {
      if (hasId) {
        void this.answerServerRequest(message.id as JsonRpcId, message.method, message.params);
      } else {
        this.dispatchNotification(message.method, message.params);
      }
      return;
    }
    if (hasId) this.settleResponse(message.id as JsonRpcId, message);
  }

  private settleResponse(id: JsonRpcId, message: JsonRpcMessage): void {
    const request = this.pending.get(id);
    if (!request) {
      this.options.logger.debug("LSP response for unknown request id", {
        event: "adapters.lsp.unknown_response",
        serverId: this.options.serverId,
      });
      return;
    }
    this.removePending(id, request);
    if (message.error) {
      request.reject(this.toResponseError(request.method, message.error));
      return;
    }
    request.resolve(message.result);
  }

  private async answerServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    let response: JsonRpcMessage;
    try {
      const result = await this.options.handleServerRequest(method, params);
      response = { jsonrpc: LSP_JSON_RPC_VERSION, id, result: result ?? null };
    } catch (error) {
      const code = error instanceof JsonRpcResponseError ? error.code : LSP_JSON_RPC_INTERNAL_ERROR;
      response = {
        jsonrpc: LSP_JSON_RPC_VERSION,
        id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      };
    }
    if (!this.closedError) this.write(response);
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (method === LSP_METHOD_LOG_MESSAGE || method === LSP_METHOD_PROGRESS) {
      this.options.logger.debug("LSP server notification", {
        event: "adapters.lsp.notification",
        serverId: this.options.serverId,
        method,
      });
    }
    for (const handler of this.subscribers.get(method) ?? []) {
      try {
        handler(params);
      } catch (error) {
        this.options.logger.warn("LSP notification handler threw", {
          event: "adapters.lsp.notification_handler_failed",
          serverId: this.options.serverId,
          method,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private cancelPending(id: JsonRpcId, error: LspError, notifyServer: boolean): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.removePending(id, request);
    if (notifyServer && !this.closedError) {
      this.notify(LSP_METHOD_CANCEL_REQUEST, { id });
    }
    request.reject(error);
  }

  private removePending(id: JsonRpcId, request: PendingRequest): void {
    this.pending.delete(id);
    if (request.timer !== undefined) clearTimeout(request.timer);
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener("abort", request.onAbort);
    }
  }

  private toResponseError(method: string, error: JsonRpcErrorObject): LspError {
    if (error.code === LSP_JSON_RPC_REQUEST_CANCELLED) {
      return new LspError("lsp_cancelled", `${method} was cancelled by the server`);
    }
    const unsupported = error.code === LSP_JSON_RPC_METHOD_NOT_FOUND;
    return new LspError(
      unsupported ? "lsp_operation_unsupported" : "lsp_request_failed",
      `${this.options.serverId} ${unsupported ? "does not support" : "rejected"} ${method} (code ${error.code}): ${error.message}`,
    );
  }

  private write(message: JsonRpcMessage): void {
    this.logPayload("out", message);
    try {
      this.options.stdin.write(encodeJsonRpcFrame(message));
    } catch (error) {
      this.options.logger.debug("LSP stdin write threw", {
        event: "adapters.lsp.stdin_error",
        serverId: this.options.serverId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private logPayload(direction: "in" | "out", message: JsonRpcMessage): void {
    const text = JSON.stringify(message) ?? "";
    this.options.logger.debug("LSP JSON-RPC message", {
      event: "adapters.lsp.jsonrpc",
      serverId: this.options.serverId,
      direction,
      payload:
        text.length > LSP_LOG_PAYLOAD_MAX_CHARS
          ? `${text.slice(0, LSP_LOG_PAYLOAD_MAX_CHARS)}...`
          : text,
    });
  }
}
