import { ZCodeStorageStartupGate } from "#src/zcode-agent/zcodeStorageStartupGate.js";
import { Emitter } from "@zcode/rpc";
import type { IDisposable } from "@zcode/rpc";
import type {
  ZCodeProtocolMethod,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolTrace,
} from "@zcode/shared";
import type { V4Method } from "@zcode/shared/zcode-protocol-v4";
import type { z } from "zod";
import type { ZCodeProtocolTransport } from "./zcodeProtocolTransport.js";

/** Method names the client can send: legacy zcodeProtocolMethods + v4/* (coexist since M3, converging on v4 in M5 wave 2). */
export type ZCodeProtocolClientMethod = ZCodeProtocolMethod | V4Method;

interface ZCodeProtocolClientOptions {
  requireStorageStartup?: boolean;
  requestTimeoutMs?: number;
}

export interface ZCodeProtocolRequestTimeoutEvent {
  method: ZCodeProtocolClientMethod;
  requestId: ZCodeProtocolRequestId;
  timeoutMs: number;
}

interface PendingRequest<T> {
  method: string;
  observation: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resumeTimeout: () => void;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  /** Where a no-op catch is attached on dispose batch rejection, preventing "cancelled counts as unhandled" (see rejectAll). */
  promise?: Promise<T>;
  resultSchema?: z.ZodType<T>;
  cleanupAbort?: () => void;
}

interface ZCodeProtocolClientRequestOptions {
  /** Observations must not affect runtime health checks or extend business-idle timeouts; defaults to business request semantics. */
  lifecycle?: "operation" | "observation";
  signal?: AbortSignal;
  trace?: ZCodeProtocolTrace;
  timeoutMs?: number;
}

export const DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS = 3 * 60_000;

class ZCodeProtocolClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ZCodeProtocolClientError";
  }
}

export class ZCodeProtocolRequestTimeoutError extends Error {
  constructor(
    readonly method: ZCodeProtocolClientMethod,
    readonly requestId: ZCodeProtocolRequestId,
    readonly timeoutMs: number,
  ) {
    super(`ZCode Protocol request timed out: ${method}`);
    this.name = "ZCodeProtocolRequestTimeoutError";
  }
}

export class ZCodeProtocolClient implements IDisposable {
  readonly storageStartup: ZCodeStorageStartupGate;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly notificationEmitter = new Emitter<ZCodeProtocolNotification>();
  private readonly requestEmitter = new Emitter<ZCodeProtocolRequest>();
  private readonly requestTimeoutEmitter = new Emitter<ZCodeProtocolRequestTimeoutEvent>();
  // Triggered when business requests return to zero; a completed observation must not keep the observed process alive.
  private readonly pendingDrainedEmitter = new Emitter<void>();
  private readonly closeEmitter = new Emitter<void>();
  private readonly disposables: IDisposable[] = [];
  private nextRequestId = 1;
  private disposed = false;
  private readonly requestTimeoutMs: number;

  /**
   * Whether the client has been disposed (true after the process is reclaimed or transport closes).
   * Callers (for example, getClient reusing an active entry) must check this before reuse,
   * to avoid sending a request through a client already reclaimed by processManager but whose onClose has not fired yet;
   * otherwise it immediately throws "ZCode Protocol client is disposed".
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  readonly onNotification = this.notificationEmitter.event;
  readonly onRequest = this.requestEmitter.event;
  readonly onRequestTimeout = this.requestTimeoutEmitter.event;
  readonly onPendingRequestsDrained = this.pendingDrainedEmitter.event;
  readonly onClose = this.closeEmitter.event;

  /** Number of requests that have not received a response yet. */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get pendingOperationRequestCount(): number {
    let count = 0;
    for (const pending of this.pending.values()) if (!pending.observation) count += 1;
    return count;
  }

  constructor(
    private readonly transport: ZCodeProtocolTransport,
    options?: ZCodeProtocolClientOptions,
  ) {
    this.storageStartup = new ZCodeStorageStartupGate(options?.requireStorageStartup ?? false);
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS;
    this.disposables.push(
      transport.onMessage((message) => this.handleMessage(message)),
      transport.onClose((event) => {
        this.storageStartup.dispose();
        const suffix = event.reason ? `: ${event.reason}` : "";
        this.rejectAll(new Error(`ZCode agent transport closed${suffix}`));
        this.closeEmitter.fire();
      }),
    );
  }

  get transportKind() {
    return this.transport.kind;
  }

  /**
   * Non-async wrapper (per code review): callers hold the Promise returned by this method, and when the inner
   * resultPromise of an async implementation propagates a rejection via return, the outer Promise independently participates in unhandledRejection detection.
   * The no-op catch must be attached at the point the final returned object is created, so it covers the timing window between the batch
   * rejection on dispose/transport close and the caller attaching .catch(). The handler only affects the unhandled verdict, not the
   * propagation of the rejection to the real awaiter; the cost is that a fire-and-forget caller forgetting to attach catch
   * no longer surfaces unhandled noise, an acceptable trade-off (all void call sites in this repo attach their own catch).
   */
  request<T = unknown>(
    method: ZCodeProtocolClientMethod,
    params?: unknown,
    resultSchema?: z.ZodType<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    const requestPromise = this.requestImpl(method, params, resultSchema, options);
    void requestPromise.catch(() => undefined);
    return requestPromise;
  }

  private async requestImpl<T = unknown>(
    method: ZCodeProtocolClientMethod,
    params?: unknown,
    resultSchema?: z.ZodType<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    this.assertNotDisposed();
    // Do not create a request or start a watchdog yet; enter the existing protocol request lifecycle only after a real COMMIT.
    if (this.storageStartup.isWaiting) await this.storageStartup.wait(options?.signal);
    this.assertNotDisposed();
    options?.signal?.throwIfAborted();
    const id = this.nextRequestId++;
    const requestKey = String(id);
    const requestTimeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const observation = options?.lifecycle === "observation";

    const resultPromise = new Promise<T>((resolve, reject) => {
      const expire = () => {
        const pending = this.pending.get(requestKey);
        pending?.cleanupAbort?.();
        this.deletePending(requestKey);
        const error = new ZCodeProtocolRequestTimeoutError(method, id, requestTimeoutMs);
        // If the subprocess is alive but its protocol event loop is unresponsive, timing out one request is not enough:
        // process manager would keep reusing this stale client and later requests such as plugins/list would repeatedly time out.
        // Send the "connection is no longer trusted" fact to the owner through a timeout event; the owner is responsible for reclaiming the process.
        // A short timeout for resource queries means only that this round has no data; it must not be escalated to reclaiming the entire Agent.
        if (!observation) {
          this.requestTimeoutEmitter.fire({ method, requestId: id, timeoutMs: requestTimeoutMs });
        }
        reject(error);
      };
      const timeout = setTimeout(expire, requestTimeoutMs);

      const abortHandler = () => {
        const pending = this.pending.get(requestKey);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pending.cleanupAbort?.();
        this.deletePending(requestKey);
        const reason = options?.signal?.reason;
        reject(
          reason instanceof Error ? reason : new DOMException("Request aborted", "AbortError"),
        );
      };
      const pending: PendingRequest<T> = {
        method,
        observation,
        timeout,
        resumeTimeout: () => {
          pending.timeout = setTimeout(expire, requestTimeoutMs);
        },
        resolve: resolve as (value: unknown) => void,
        reject,
        // Bug post-mortem: this used to reference the outer resultPromise directly inside the executor, triggering a TDZ
        // ReferenceError (the executor runs synchronously before the const assignment completes), throwing on every request.
        // The promise binding is deferred until after new Promise returns.
        resultSchema,
        cleanupAbort: () => options?.signal?.removeEventListener("abort", abortHandler),
      };
      this.pending.set(requestKey, pending as PendingRequest<unknown>);
      if (options?.signal?.aborted) {
        abortHandler();
      } else {
        options?.signal?.addEventListener("abort", abortHandler, { once: true });
      }
    });

    // pending.set inside the executor has completed synchronously; resultPromise is ready here, so bind it for
    // rejectAll to attach its no-op catch on dispose batch rejection. In the synchronous-abort case the pending entry is
    // already deleted, get returns undefined, and we skip safely.
    const registeredPending = this.pending.get(requestKey);
    if (registeredPending) {
      registeredPending.promise = resultPromise;
    }

    // A request cancelled before sending must not be written to the transport; otherwise, the server would run a model task that the client
    // has already abandoned and cannot receive a response for.
    if (!this.pending.has(requestKey)) {
      return resultPromise;
    }

    try {
      await this.transport.send({
        id,
        method,
        params,
        ...(options?.trace ? { trace: options.trace } : {}),
      });
    } catch (error) {
      const pending = this.pending.get(requestKey);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.cleanupAbort?.();
        this.deletePending(requestKey);
      }
      throw error;
    }

    return resultPromise;
  }

  async notify(method: ZCodeProtocolClientMethod, params?: unknown): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ method, params });
  }

  async respond(id: ZCodeProtocolRequestId, result: unknown): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ id, result });
  }

  async respondError(
    id: ZCodeProtocolRequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ id, error });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    this.transport.dispose();
  }

  async disposeAndWait(): Promise<void> {
    const wasDisposed = this.disposed;
    if (!wasDisposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    if (this.transport.disposeAndWait) {
      await this.transport.disposeAndWait();
      return;
    }
    if (!wasDisposed) {
      this.transport.dispose();
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if ("result" in message && "id" in message) {
      this.resolveResponse(
        (message as { id: ZCodeProtocolRequestId; result: unknown }).id,
        (message as { result: unknown }).result,
      );
      return;
    }

    if ("error" in message && "id" in message) {
      const errorMessage = message as {
        id: ZCodeProtocolRequestId;
        error: { code: number; message: string; data?: unknown };
      };
      this.rejectResponse(
        errorMessage.id,
        new ZCodeProtocolClientError(
          errorMessage.error.message,
          errorMessage.error.code,
          errorMessage.error.data,
        ),
      );
      return;
    }

    if ("method" in message && "id" in message) {
      this.requestEmitter.fire(message as ZCodeProtocolRequest);
      return;
    }

    if ("method" in message) {
      if (
        message.method === "startup/storageState" &&
        this.storageStartup.accept((message as ZCodeProtocolNotification).params)
      ) {
        // Custom/legacy deployment commands cannot declare capabilities in advance; the first request may already have been sent. Only the first valid startup frame
        // can pause these timers, which resume when ready; later notifications cannot extend the lifetime after this process has reached a terminal state.
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          if (this.storageStartup.snapshot?.phase === "ready") pending.resumeTimeout();
        }
        if (this.storageStartup.snapshot?.phase === "failed") {
          this.rejectAll(
            new Error(`SQLite startup failed: ${this.storageStartup.snapshot.errorCode}`),
          );
        }
      }
      this.notificationEmitter.fire(message as ZCodeProtocolNotification);
    }
  }

  private resolveResponse(id: ZCodeProtocolRequestId, result: unknown): void {
    const requestKey = String(id);
    const pending = this.pending.get(requestKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pending.cleanupAbort?.();
    this.deletePending(requestKey);

    try {
      const parsed = pending.resultSchema ? pending.resultSchema.parse(result) : result;
      pending.resolve(parsed);
    } catch (error) {
      pending.reject(
        error instanceof Error
          ? error
          : new Error(`ZCode Protocol response parse failed: ${pending.method}`),
      );
    }
  }

  private rejectResponse(id: ZCodeProtocolRequestId, error: Error): void {
    const requestKey = String(id);
    const pending = this.pending.get(requestKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pending.cleanupAbort?.();
    this.deletePending(requestKey);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    const hadPending = this.pendingOperationRequestCount > 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.cleanupAbort?.();
      // Bug cause: dispose batch rejection happens outside the caller's await (for example, dispose racing an in-flight
      // observation long poll), and the rejection is flagged unhandledRejection before the caller handles it (a vitest run-level
      // failure, equivalent to an unhandled-rejection crash in production). A rejection caused by dispose means "cancelled", so attach a no-op catch here;
      // the real awaiter still receives the rejection as usual, and the timeout/abort paths are unaffected and still reported.
      void pending.promise?.catch(() => undefined);
      pending.reject(error);
    }
    this.pending.clear();
    if (hadPending && !this.disposed) {
      this.pendingDrainedEmitter.fire();
    }
  }

  private deletePending(requestKey: string): void {
    const pending = this.pending.get(requestKey);
    if (!this.pending.delete(requestKey)) {
      return;
    }
    if (!pending?.observation && this.pendingOperationRequestCount === 0 && !this.disposed) {
      this.pendingDrainedEmitter.fire();
    }
  }

  private disposeLocalResources(): void {
    this.rejectAll(new Error("ZCode Protocol client disposed"));
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.storageStartup.dispose();
    this.notificationEmitter.dispose();
    this.requestEmitter.dispose();
    this.requestTimeoutEmitter.dispose();
    this.pendingDrainedEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("ZCode Protocol client is disposed");
    }
  }
}
