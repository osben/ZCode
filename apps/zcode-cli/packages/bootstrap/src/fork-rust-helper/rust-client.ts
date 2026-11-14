import { randomUUID } from "node:crypto";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import type { ZCodeProtocolMessage } from "@zcode/shared";

/** Helper → Rust notification that abandons one of the helper's requests (specs/fork-rust-node-helper.md F3). */
export const FORK_RUST_HELPER_CANCEL_REQUEST = "helper/cancelRequest";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** A Rust answer that failed; `data.type` carries Node's `CoreErrorType` when Rust gives one. */
export class ForkRustRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ForkRustRequestError";
  }
}

const CORE_ERROR_TYPES: ReadonlySet<string> = new Set(Object.values(CoreErrorType));

/**
 * Maps a refused Rust answer to the error Node's callers test for: `authorizeAppTool` callers check
 * `isCoreError(error)` and its type (mcp-ui handlers, plugin-mention-items.ts).
 */
export function toNodeError(error: unknown): unknown {
  if (!(error instanceof ForkRustRequestError)) return error;
  const type = (error.data as { type?: unknown } | undefined)?.type;
  if (typeof type === "string" && CORE_ERROR_TYPES.has(type))
    return createCoreError(type as CoreErrorType, error.message);
  return error;
}

/**
 * The helper's requests to the Rust agent. Rust answers on the same stdio link; an abort sends
 * `helper/cancelRequest {requestKey}` (the link has no JSON-RPC cancel) and rejects at once.
 */
export class ForkRustHelperClient {
  private readonly pending = new Map<string, Pending>();
  private closed: Error | undefined;

  constructor(private readonly send: (message: unknown) => void) {}

  request<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    signal?.throwIfAborted();
    const id = `helper-${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        this.send({ method: FORK_RUST_HELPER_CANCEL_REQUEST, params: { requestKey: id } });
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.send({ id, method, params: { ...params, requestKey: id } });
    });
  }

  /** Settles a pending request from Rust's answer; false when the message is not one. */
  handleResponse(message: ZCodeProtocolMessage): boolean {
    if ("method" in message || !("id" in message)) return false;
    const pending = this.pending.get(String(message.id));
    if (!pending) return "result" in message || "error" in message;
    this.pending.delete(String(message.id));
    if ("error" in message && message.error) {
      const { code, message: text, data } = message.error as {
        code: number;
        message: string;
        data?: unknown;
      };
      pending.reject(new ForkRustRequestError(code, text, data));
    } else pending.resolve((message as { result?: unknown }).result);
    return true;
  }

  /** The link closed: every pending request fails, and later ones fail at once. */
  close(reason: Error): void {
    this.closed = reason;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }
}
