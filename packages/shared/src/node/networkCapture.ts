import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { ClientRequest } from "node:http";
import {
  sanitizeNetworkCaptureUrl,
  type NetworkCaptureBatch,
  type NetworkRequestRecord,
} from "../networkCapture.js";

const excluded = new AsyncLocalStorage<boolean>();
/** MCP's HTTP/SSE/OAuth calls share this async context; the original fetch's proxy and certificate policies are unaffected. */
export function withoutNetworkCapture<T>(operation: () => T): T {
  return excluded.run(true, operation);
}

/** Subscribes only to request-creation events; when capture is off it holds no listeners or timers and reads no streams. */
export function createNodeNetworkCapture(
  processType: NetworkRequestRecord["processType"],
  onBatch: (batch: NetworkCaptureBatch) => void,
): { setCaptureId(captureId: string | null): void } {
  let captureId: string | null = null;
  let records: NetworkRequestRecord[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!captureId) return;
    const batch = { captureId, records, dropped };
    records = [];
    dropped = 0;
    // A diagnostic consumer exiting or throwing must not break business requests.
    try {
      onBatch(batch);
    } catch {
      /* Drop the observation only */
    }
  };
  const record = (method: string, rawUrl: string) => {
    if (!captureId || excluded.getStore() || method === "CONNECT") return;
    if (records.length >= 100) {
      dropped++;
      return;
    }
    const url = sanitizeNetworkCaptureUrl(rawUrl);
    if (!url) return;
    records.push({
      timestamp: Date.now(),
      processType,
      pid: process.pid,
      method: method.slice(0, 32),
      url,
    });
    timer ??= setTimeout(flush, 250);
    timer.unref();
  };
  const undici = (message: unknown) => {
    try {
      const { request } = message as {
        request: { method: string; origin: string; path: string; upgrade?: string };
      };
      const url = new URL(request.path, request.origin);
      if (request.upgrade?.toLowerCase() === "websocket")
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      record(request.method, url.href);
    } catch {
      /* Diagnostic events from non-standard clients do not affect the request */
    }
  };
  const http = (message: unknown) => {
    try {
      const { request } = message as { request: ClientRequest };
      // A forward proxy's path is already an absolute URL; the proxy address must not be treated as the target address.
      const url = new URL(
        request.path,
        `${request.protocol}//${String(request.getHeader("host") ?? request.host)}`,
      );
      if (String(request.getHeader("upgrade")).toLowerCase() === "websocket")
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      record(request.method, url.href);
    } catch {
      /* Ignore only unrecognizable metadata */
    }
  };
  return {
    setCaptureId(next) {
      if (captureId === next) return;
      if (captureId) {
        channel("undici:request:create").unsubscribe(undici);
        channel("http.client.request.start").unsubscribe(http);
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      records = [];
      dropped = 0;
      captureId = next;
      if (captureId) {
        channel("undici:request:create").subscribe(undici);
        channel("http.client.request.start").subscribe(http);
      }
    },
  };
}
