import {
  highspeedDrawResponseSchema,
  highspeedHealthyResponseSchema,
  type HighspeedDrawRequest,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { withRequestIdHeader } from "#src/providers/api/requestIdHeaders.js";
import type { HighspeedServiceTransport } from "./highspeedCardService.js";

const DIAGNOSTIC_HEADER_NAMES = ["x-request-id", "x-trace-id", "x-span-id"] as const;
const MAX_LOG_TEXT_CHARS = 1_000;
/**
 * Upper bound on a background request's lifetime. Must be clearly larger than the 1s send-wait budget: a slow but
 * legitimate draw can still land in the background for the next turn; meanwhile connections that never return are
 * bounded and release the in-flight draw (spec §3 rule 6).
 */
export const HIGHSPEED_REQUEST_TIMEOUT_MS = 20_000;

class HighspeedBusinessResponseError extends Error {
  constructor(
    readonly operation: "draw" | "healthy",
    readonly businessCode: number,
  ) {
    super(`highspeed ${operation} failed: business code ${businessCode}`);
    this.name = "HighspeedBusinessResponseError";
  }
}

export function createHighspeedHttpTransport(options: {
  drawUrl: string;
  healthyBaseUrl: string;
  drawHeaders: () => Promise<Record<string, string>>;
  healthyHeaders: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  logger: Pick<ServiceLogger, "warn">;
  /** Lifetime cap for a single draw/healthy request; defaults to HIGHSPEED_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}): HighspeedServiceTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger;
  const requestTimeoutMs = options.requestTimeoutMs ?? HIGHSPEED_REQUEST_TIMEOUT_MS;

  async function performRequest<T>(params: {
    operation: "draw" | "healthy";
    method: "GET" | "POST";
    url: string;
    body?: HighspeedDrawRequest;
    resolveHeaders: () => Promise<Record<string, string>>;
    parse: (payload: unknown) => { success: true; data: T } | { success: false; error: Error };
  }): Promise<T> {
    const startedAt = Date.now();
    const safeUrl = sanitizeLogUrl(params.url);
    let headers: Headers;
    try {
      headers = withRequestIdHeader({
        ...(params.body ? { "content-type": "application/json" } : {}),
        ...(await params.resolveHeaders()),
      });
    } catch (error) {
      logger.warn(undefined, "Highspeed 接口请求准备失败", {
        operation: params.operation,
        method: params.method,
        url: safeUrl,
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error, params.url, safeUrl),
      });
      throw error;
    }

    const requestId = headers.get("x-request-id") ?? undefined;
    // Bug root cause: fetch previously had no deadline at all. When a proxy/server accepted the connection but never responded, the
    // Promise stayed pending forever, and HighspeedCardService.inFlightDraw was only released in that Promise's finally on settle —
    // every subsequent send reused this dead Promise, each waiting 1s before downgrading, so no new draw ever started for the rest of
    // the app's lifetime and next_draw_at could never refresh.
    // Give the request a bounded lifetime; on timeout abort → reject lets the finally run. The deadline also covers response-body
    // reads, so a server that stalls after headers is terminated too (same approach as bots/providers/providerRequest.ts).
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(
        new Error(`highspeed ${params.operation} request timed out after ${requestTimeoutMs}ms`),
      );
    }, requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(params.url, {
          method: params.method,
          headers,
          signal: controller.signal,
          ...(params.body ? { body: JSON.stringify(params.body) } : {}),
        });
      } catch (error) {
        // Bug cause: Highspeed used to pass fetch exceptions straight to RPC, with no way to tell which API or request path failed.
        // Log only the sanitized route and request id, never request headers or the body, so JWTs and task data never reach disk.
        logger.warn(undefined, "Highspeed 接口网络请求失败", {
          operation: params.operation,
          method: params.method,
          url: safeUrl,
          requestId,
          durationMs: Date.now() - startedAt,
          error: readErrorMessage(error, params.url, safeUrl),
        });
        throw error;
      }

      return await readHighspeedResponse({
        logger,
        operation: params.operation,
        method: params.method,
        rawUrl: params.url,
        safeUrl,
        requestId,
        startedAt,
        response,
        parse: params.parse,
      });
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    draw: (request) =>
      performRequest({
        operation: "draw",
        method: "POST",
        url: options.drawUrl,
        body: request,
        resolveHeaders: options.drawHeaders,
        parse: (payload) => highspeedDrawResponseSchema.safeParse(payload),
      }),
    async healthy(cardId) {
      const parsed = await performRequest({
        operation: "healthy",
        method: "GET",
        url: new URL(`${encodeURIComponent(cardId)}/healthy`, options.healthyBaseUrl).toString(),
        resolveHeaders: options.healthyHeaders,
        parse: (payload) => highspeedHealthyResponseSchema.safeParse(payload),
      });
      return {
        cardId: parsed.data.card_id,
        promptTokens: parsed.data.prompt_tokens,
        completionTokens: parsed.data.completion_tokens,
        durationSeconds: parsed.data.duration_seconds,
      };
    },
  };
}

async function readHighspeedResponse<T>(params: {
  logger: Pick<ServiceLogger, "warn">;
  operation: "draw" | "healthy";
  method: "GET" | "POST";
  rawUrl: string;
  safeUrl: string;
  requestId: string | undefined;
  startedAt: number;
  response: Response;
  parse: (payload: unknown) => { success: true; data: T } | { success: false; error: Error };
}): Promise<T> {
  const responseHeaders = readDiagnosticHeaders(params.response.headers);
  let responseText: string;
  try {
    responseText = await params.response.text();
  } catch (error) {
    logResponseFailure(params, "Highspeed 接口响应读取失败", {
      responseHeaders,
      error: readErrorMessage(error, params.rawUrl, params.safeUrl),
    });
    throw error;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch (error) {
    if (!params.response.ok) {
      logResponseFailure(params, "Highspeed 接口 HTTP 请求失败", {
        responseHeaders,
        response: summarizeResponse(responseText),
      });
      throw new Error(`highspeed ${params.operation} failed: ${params.response.status}`, {
        cause: error,
      });
    }
    logResponseFailure(params, "Highspeed 接口响应 JSON 解析失败", {
      responseHeaders,
      response: summarizeResponse(responseText),
      error: readErrorMessage(error, params.rawUrl, params.safeUrl),
    });
    throw error;
  }

  const responseSummary = summarizeResponse(payload);
  if (!params.response.ok) {
    logResponseFailure(params, "Highspeed 接口 HTTP 请求失败", {
      responseHeaders,
      response: responseSummary,
    });
    throw new Error(`highspeed ${params.operation} failed: ${params.response.status}`);
  }

  const parsed = params.parse(payload);
  if (!parsed.success) {
    logResponseFailure(params, "Highspeed 接口响应结构校验失败", {
      responseHeaders,
      response: responseSummary,
      error: truncateLogText(parsed.error.message),
    });
    throw parsed.error;
  }
  const businessCode = readBusinessCode(parsed.data);
  if (businessCode !== undefined && businessCode !== 0) {
    logResponseFailure(params, "Highspeed 接口业务失败", {
      responseHeaders,
      response: responseSummary,
    });
    // Bug root cause: the old implementation logged the non-zero business code but still returned data, letting callers cache
    // cards the backend rejected or mistake share/healthy failures for success. Business failures must propagate from the I/O boundary.
    throw new HighspeedBusinessResponseError(params.operation, businessCode);
  }
  return parsed.data;
}

function logResponseFailure(
  params: {
    logger: Pick<ServiceLogger, "warn">;
    operation: "draw" | "healthy";
    method: "GET" | "POST";
    safeUrl: string;
    requestId: string | undefined;
    startedAt: number;
    response: Response;
  },
  message: string,
  context: Record<string, unknown>,
): void {
  params.logger.warn(undefined, message, {
    operation: params.operation,
    method: params.method,
    url: params.safeUrl,
    requestId: params.requestId,
    durationMs: Date.now() - params.startedAt,
    status: params.response.status,
    statusText: params.response.statusText,
    ...context,
  });
}

function sanitizeLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-highspeed-url>";
  }
}

function readDiagnosticHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (value) result[name] = value;
  }
  return result;
}

function truncateLogText(value: string): string {
  const trimmed = value.trim();
  const truncated =
    trimmed.length > MAX_LOG_TEXT_CHARS ? `${trimmed.slice(0, MAX_LOG_TEXT_CHARS)}…` : trimmed;
  return truncated
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>")
    .replace(
      /(["']?(?:token|authorization|api[_-]?key|secret)["']?\s*[:=]\s*["'])[^"']+/gi,
      "$1<redacted>",
    );
}

function readErrorMessage(error: unknown, rawUrl: string, safeUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateLogText(message.replaceAll(rawUrl, safeUrl));
}

function summarizeResponse(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { bodyPreview: truncateLogText(String(payload ?? "")) };
  }
  const record = payload as Record<string, unknown>;
  const message = [record.msg, record.message, record.error, record.detail].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    ...(typeof record.code === "number" || typeof record.code === "string"
      ? { code: record.code }
      : {}),
    ...(message ? { message: truncateLogText(message) } : {}),
    fields: Object.keys(record).sort(),
  };
}

function readBusinessCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
