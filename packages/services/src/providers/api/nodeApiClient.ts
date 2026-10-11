import {
  ApiError,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  rewriteZCodeEndpointUrl,
  type ApiClient,
  type ApiRequestInit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildZCodeSourceHeaders } from "../sourceHeaders.js";
import { withRequestIdHeader } from "./requestIdHeaders.js";

const log = createServiceLogger("node-api-client");

interface NodeApiClientOptions {
  fetchImpl?: typeof fetch;
  onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  isZcodeJwtRequest?: (input: string | URL, headers: Headers) => boolean | Promise<boolean>;
  isBusinessUnauthorizedRequest?: (
    input: string | URL,
    headers: Headers,
  ) => boolean | Promise<boolean>;
  businessUnauthorizedObservationTimeoutMs?: number;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
}

const DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS = 1000;
const MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES = 64 * 1024;

function readChunkWithinTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

async function hasBusinessUnauthorizedCode(
  response: Response,
  timeoutMs: number,
): Promise<boolean> {
  // Business endpoints wrap expired logins in HTTP 200, so status alone is not enough; read a
  // clone to avoid consuming the caller's body. A continuous SSE stream has no complete JSON
  // body, and the observer must not wait for the stream to end or introduce resume semantics.
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
    return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const body = response.clone().body;
    if (!body) return false;
    reader = body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let bytes = 0;
    let text = "";
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      const result = await readChunkWithinTimeout(reader, remainingMs);
      if (!result) return false;
      if (result.done) break;
      if (!result.value) return false;
      bytes += result.value.byteLength;
      if (bytes > MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES) return false;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    const payload: unknown = JSON.parse(text);
    return (
      typeof payload === "object" && payload !== null && "code" in payload && payload.code === 401
    );
  } catch {
    // An empty body, HTML, or corrupt JSON only proves the request is abnormal; do not clear the
    // login state based on it.
    return false;
  } finally {
    // The observed copy is best-effort; on timeout, size overrun, or parse failure cancel
    // promptly instead of holding the connection.
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function readHeaderKeys(headers: RequestInit["headers"] | undefined): string[] {
  if (!headers) {
    return [];
  }
  return [...new Headers(headers).keys()].sort();
}

function isRequestForEndpoint(input: string | URL, endpointOrigin: string): boolean {
  try {
    return new URL(resolveUrl(input)).origin === normalizeZCodeEndpointOrigin(endpointOrigin);
  } catch {
    return false;
  }
}

function withZCodeEndpointHeaders(
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] {
  const next = new Headers(buildZCodeSourceHeaders());
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      next.set(key, value);
    });
  }

  if (next.get("HTTP-Referer") === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    next.set("HTTP-Referer", endpointOrigin);
  }
  return next;
}

function resolveRequestHeaders(
  requestInput: string | URL,
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] | undefined {
  if (!isRequestForEndpoint(requestInput, endpointOrigin)) {
    return headers;
  }

  // Previously, only some ZCode backend request paths added source headers manually.
  // Inject them consistently at the ApiClient boundary based on endpoint origin to avoid omissions in OAuth/config/billing/snapshot paths.
  return withZCodeEndpointHeaders(headers, endpointOrigin);
}

export class NodeApiClient implements ApiClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  private readonly onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  private readonly isZcodeJwtRequest?: NodeApiClientOptions["isZcodeJwtRequest"];
  private readonly isBusinessUnauthorizedRequest?: NodeApiClientOptions["isBusinessUnauthorizedRequest"];
  private readonly businessUnauthorizedObservationTimeoutMs: number;

  constructor(options: NodeApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.onZcodeJwtInvalid = options.onZcodeJwtInvalid;
    this.isZcodeJwtRequest = options.isZcodeJwtRequest;
    this.isBusinessUnauthorizedRequest = options.isBusinessUnauthorizedRequest;
    this.businessUnauthorizedObservationTimeoutMs =
      options.businessUnauthorizedObservationTimeoutMs ??
      DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS;
    this.resolveZCodeEndpointOrigin = options.resolveZCodeEndpointOrigin;
  }

  async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
    const endpointOrigin = this.resolveZCodeEndpointOrigin
      ? await this.resolveZCodeEndpointOrigin()
      : undefined;
    const activeEndpointOrigin = endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    const requestInput = rewriteZCodeEndpointUrl(input, activeEndpointOrigin);
    const url = resolveUrl(requestInput);
    const method = resolveMethod(init);
    const timeoutMs = init?.timeoutMs;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    let didTimeout = false;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            didTimeout = true;
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const signal = controller
        ? init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        : init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const fetchImpl = this.fetchImpl ?? globalThis.fetch;
      const requestHeaders = withRequestIdHeader(
        resolveRequestHeaders(requestInput, init?.headers, activeEndpointOrigin),
      );
      if (isRequestForEndpoint(requestInput, activeEndpointOrigin)) {
        // For debugging, record header keys only so sensitive values such as Authorization/token are not persisted.
        log.debug(undefined, "zcode endpoint request headers prepared", {
          headerKeys: readHeaderKeys(requestHeaders),
          method,
          url,
        });
      }
      const response = await fetchImpl(requestInput, {
        ...init,
        headers: requestHeaders,
        ...(signal ? { signal } : {}),
      });
      if ((response.status === 401 || response.status === 200) && this.onZcodeJwtInvalid) {
        try {
          const requestHeadersForObservation = new Headers(requestHeaders);
          const isCurrentZCodeJwtRequest = await this.isZcodeJwtRequest?.(
            requestInput,
            requestHeadersForObservation,
          );
          if (
            isCurrentZCodeJwtRequest &&
            (response.status === 401 ||
              ((await this.isBusinessUnauthorizedRequest?.(
                requestInput,
                requestHeadersForObservation,
              )) &&
                (await hasBusinessUnauthorizedCode(
                  response,
                  this.businessUnauthorizedObservationTimeoutMs,
                ))))
          ) {
            this.onZcodeJwtInvalid(requestInput, requestHeadersForObservation);
          }
        } catch (error) {
          log.warn("zcode jwt invalid response observation failed", { error });
        }
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError({
          message:
            didTimeout && timeoutMs ? `Request timed out after ${timeoutMs}ms` : error.message,
          url,
          method,
          cause: error,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError({
        message,
        url,
        method,
        cause: error,
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function createNodeApiClient(options: NodeApiClientOptions = {}): ApiClient {
  return new NodeApiClient(options);
}
