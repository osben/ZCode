/* Per-request dynamic identity-header injection and failure classification for official Server MCP.
 *
 * This is the only credential egress: wrap the fetch returned by createMcpTransportFetch and
 * inject headers after the SDK assembles _commonHeaders() and requestInit, immediately before
 * sending the request. This preserves existing HTTP proxy, custom CA, and No Proxy policies;
 * the wrapper decorates them instead of bypassing them.
 */
import {
  findOfficialMcpReservedHeaders,
  isOfficialMcpReservedHeaderName,
  summarizeOfficialMcpIdentityHeaders,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import type {
  Logger,
  McpOfficialProvenance,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";

/** Official-authentication error thrown by the adapter with a stable classification. Callers
 * must not branch on message text. */
export class OfficialMcpAuthError extends Error {
  constructor(
    readonly kind: OfficialMcpAuthFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "OfficialMcpAuthError";
  }
}

/**
 * Header names for correlation IDs.
 *
 * Two purposes, neither involves sending them:
 * 1. Strip them from request headers so plugin static configuration cannot inject these
 *    observability headers into official endpoints.
 * 2. Read the server-generated request ID from **response headers** and log it for end-to-end correlation.
 *
 * The client does not send these headers: the server always generates its own request ID and
 * ignores inbound values, so nobody would read them if sent.
 */
const REQUEST_ID_HEADER = "x-request-id";
const TRACE_ID_HEADER = "x-trace-id";

export interface CreateOfficialMcpAuthFetchInput {
  authHeadersPort?: OfficialMcpAuthHeadersPort;
  baseFetch: typeof globalThis.fetch;
  logger?: Logger;
  /**
   * Classification reporting hook. SDK version negotiation wraps OfficialMcpAuthError thrown
   * here as a regular Error (message is preserved but object identity is lost), so instanceof is
   * unreliable at higher layers. Report the classification where the error is thrown; do not
   * infer it by parsing error text at a higher layer (project rules prohibit routing on error text).
   */
  onAuthFailure?: (kind: OfficialMcpAuthFailureKind) => void;
  /**
   * Reporting hook for server request IDs, used to associate one with a specific `tools/call`.
   *
   * Only this layer can see response headers: above the wrapper, the MCP SDK passes only the
   * JSON-RPC result to the adapter. Therefore, to attach a request ID to an in-band failure
   * (HTTP 200 + `isError: true`, such as quota exhaustion), report it here and let the adapter
   * associate it by span.
   */
  onServerResponse?: (response: OfficialMcpServerResponseInfo) => void;
  official: McpOfficialProvenance;
  serverName: string;
  trustedOrigins: OfficialMcpTrustedOriginRegistry;
  /** MCP endpoint URL; validate Origin against each request's actual URL, not only once at connection time. */
  url: string;
  workspaceIdentity?: string;
  workspacePath?: string;
}

/** Nonsensitive facts from one official MCP response that can be used for correlation. Contains
 * no body or header values. */
export interface OfficialMcpServerResponseInfo {
  failureKind?: McpServerFailureKind;
  httpStatus: number;
  rpcMethod?: string;
  rpcToolName?: string;
  /** Server-generated `x-request-id`; absent without an HTTP response and never fabricated. */
  serverRequestId?: string;
  /** Tool-call span that initiated the request; the adapter uses it to associate request ID with the specific call. */
  spanId?: string;
  traceId?: string;
}

/**
 * Re-parse and inject identity headers before every request to a trusted Origin; fall back to
 * anonymous only if parsing fails.
 *
 * Key semantics:
 * - Validate Origin on every request. The SDK may send multiple request types on the same
 *   transport during a session; validating only at connection time leaves a gap if the URL changes.
 * - Use set semantics to overwrite reserved headers. append would create comma-separated
 *   multiple Authorization values, while "fill only when missing" would preserve unexpected
 *   existing values (such as an OAuth token written by authProvider).
 * - Use redirect: "manual" and fail on 3xx to prevent a cross-Origin redirect from carrying a
 *   Bearer Token away.
 * - Retry once after 401 only for requests where credentials were actually injected; do not
 *   retry 403/3xx.
 */
export function createOfficialMcpAuthFetch(
  input: CreateOfficialMcpAuthFetchInput,
): typeof globalThis.fetch {
  const expectedOrigin = safeOrigin(input.url);

  /**
   * Report the classification and construct an error for the call site to `throw`.
   * Do not throw here: a never-returning arrow function does not trigger TypeScript control-flow
   * narrowing (the call target needs an explicit type annotation), leaving origin / resolved as
   * union types after the throw.
   */
  const failWith = (kind: OfficialMcpAuthFailureKind, message: string): OfficialMcpAuthError => {
    input.onAuthFailure?.(kind);
    return new OfficialMcpAuthError(kind, message);
  };

  const authFetch = async (
    resource: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const requestUrl = resolveRequestUrl(resource);
    const origin = safeOrigin(requestUrl);
    if (!origin || !expectedOrigin || origin !== expectedOrigin) {
      throw failWith(
        "official_mcp_origin_untrusted",
        `official MCP request origin does not match the configured endpoint: ${input.serverName}`,
      );
    }
    const trust = await input.trustedOrigins.isTrusted({
      mcpKey: input.official.mcpKey,
      origin,
      pluginId: input.official.pluginId,
    });
    if (!trust.trusted) {
      // Fail closed: make zero network requests and do not parse credentials.
      // Include origin and pluginId in the message. Reporting only serverName makes it impossible
      // to tell what input was checked (this once caused a pluginId suffix issue to be
      // misdiagnosed as a URL configuration issue).
      throw failWith(
        "official_mcp_origin_untrusted",
        `official MCP origin is not trusted (${trust.detail ?? "unknown"}): ` +
          `${input.serverName} origin=${origin} pluginId=${input.official.pluginId}`,
      );
    }

    // Request-level debug context. Deliberately include only nonsensitive fields: RPC method,
    // request-body byte count, and path. Do not log body contents (including user queries) or
    // any header values.
    const rpc = describeJsonRpc(init?.body);
    const logBase = {
      event: "mcp.official_auth.request",
      mcpKey: input.official.mcpKey,
      mcpServerName: input.serverName,
      module: "adapters.mcp.official_auth",
      requestBodyBytes: byteLength(init?.body),
      urlPath: safePath(requestUrl),
      ...(rpc.method ? { rpcMethod: rpc.method } : {}),
      ...(rpc.id !== undefined ? { rpcId: rpc.id } : {}),
      ...(rpc.toolName ? { rpcToolName: rpc.toolName } : {}),
      ...(rpc.traceId ? { mcpTraceId: rpc.traceId } : {}),
    };

    const send = async (attempt: number): Promise<{ authApplied: boolean; response: Response }> => {
      let authHeaders: Record<string, string> = {};
      let resolveDurationMs: number | undefined;
      if (input.authHeadersPort) {
        const resolveStartedAt = Date.now();
        const resolved = await input.authHeadersPort.resolveHeaders({
          mcpKey: input.official.mcpKey,
          pluginId: input.official.pluginId,
          targetOrigin: origin,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        });
        resolveDurationMs = Date.now() - resolveStartedAt;
        if (resolved.ok) {
          authHeaders = resolved.headers;
        } else {
          // If identity cannot be resolved, still send an anonymous request so the server can
          // make the authoritative decision. The adapter does not cache old credentials or
          // misrepresent a local parsing failure as a network failure.
          input.logger?.warn("Official MCP auth headers unavailable for request", {
            ...logBase,
            attempt,
            event: "mcp.official_auth.resolve",
            fallback: "anonymous",
            reason: resolved.reason,
            resolveDurationMs,
            status: "failed",
          });
        }
      } else {
        input.logger?.warn("Official MCP auth port unavailable for request", {
          ...logBase,
          attempt,
          event: "mcp.official_auth.resolve",
          fallback: "anonymous",
          reason: "official_auth_unavailable",
          status: "failed",
        });
      }
      // Log only header names and plan dimensions, never header values. targetType is a
      // low-sensitivity enum such as PERSONAL/TEAM, but it is essential for understanding why
      // the server denied an entitlement, so retain it unchanged.
      const identity = summarizeOfficialMcpIdentityHeaders(authHeaders);
      const headers = mergeOfficialAuthHeaders(init?.headers, authHeaders);

      // Never send correlation IDs; strip them only.
      //
      // The server does not use client-supplied request IDs; it always generates its own and
      // ignores inbound headers. Therefore, nobody reads client-sent X-Request-Id / X-Trace-Id;
      // sending them would be dead code and mislead future maintainers.
      //
      // Correlate end to end in the reverse direction: read the server's x-request-id from the
      // **response header** and log it (see serverRequestId below) for server-log lookup.
      //
      // Explicitly delete these instead of leaving them alone: these headers belong to the
      // correlation/observability channel and plugin static config must not inject them into
      // official endpoints. Plugin-supplied values would appear unchanged in server and
      // intermediary logs.
      headers.delete(REQUEST_ID_HEADER);
      headers.delete(TRACE_ID_HEADER);

      input.logger?.debug("Official MCP request sending", {
        ...logBase,
        attempt,
        resolveDurationMs,
        status: "started",
        timeoutHint: describeAbortSignal(init?.signal),
        ...identity,
      });

      const sendStartedAt = Date.now();
      try {
        const response = await input.baseFetch(resource, {
          ...init,
          headers,
          // Do not follow redirects in phase one; configure the production endpoint as a canonical URL.
          redirect: "manual",
        });
        // Read the server-generated request ID from the response header. This is the **only** key
        // that can correlate client and server logs: the client does not send the header, and the
        // server does not accept inbound values.
        const serverRequestId = readServerRequestId(response);
        // Settings consumes only connection, initialize, and tools/list diagnostics. tools/call
        // may return large media, and its request ID is already projected to the tool result by
        // span. Do not clone/read the response body for the Settings page.
        const failureKind =
          rpc.method === "tools/call" ? undefined : await classifyOfficialMcpResponse(response);
        if (serverRequestId || failureKind) {
          // Report it to the adapter for correlation. Do this before logging so in-band failures
          // still receive the ID even if the log level filters out both records.
          input.onServerResponse?.({
            httpStatus: response.status,
            ...(failureKind ? { failureKind } : {}),
            ...(serverRequestId ? { serverRequestId } : {}),
            ...(rpc.method ? { rpcMethod: rpc.method } : {}),
            ...(rpc.toolName ? { rpcToolName: rpc.toolName } : {}),
            ...(rpc.spanId ? { spanId: rpc.spanId } : {}),
            ...(rpc.traceId ? { traceId: rpc.traceId } : {}),
          });
        }
        const outcome = {
          ...logBase,
          attempt,
          httpStatus: response.status,
          responseBodyBytes: numericHeader(response.headers.get("content-length")),
          sendDurationMs: Date.now() - sendStartedAt,
          ...(serverRequestId ? { serverRequestId } : {}),
        };
        if (response.ok) {
          input.logger?.debug("Official MCP response received", {
            ...outcome,
            status: "completed",
          });
        } else {
          // Non-2xx responses must be logged at warn, not only in the debug entry above.
          //
          // Production logging defaults to Info (see getDefaultMinLevel in logging/index.ts),
          // so debug entries are dropped. On error—the only time correlation is needed—the
          // server request ID would otherwise be absent from logs, forcing source-code inference
          // (as happened during investigation of the 3001 "parameter error").
          //
          // Deliberately pass the response through unchanged: the SDK still handles 4xx/5xx
          // protocol errors, while this wrapper adds a searchable log record. 401/403/3xx
          // classification errors are thrown separately below.
          input.logger?.warn("Official MCP response failed", {
            ...outcome,
            status: "failed",
          });
        }
        return { authApplied: Object.keys(authHeaders).length > 0, response };
      } catch (error) {
        // Timeout/cancellation appears as AbortError here. Distinguishing them is important for
        // identifying who stopped the request: the tool's timeout budget and user cancellation
        // both abort, but elapsed time differs relative to the budget.
        const sendDurationMs = Date.now() - sendStartedAt;
        input.logger?.warn("Official MCP request did not complete", {
          ...logBase,
          aborted: isAbortError(error),
          attempt,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "unknown",
          sendDurationMs,
          status: "failed",
        });
        throw error;
      }
    };

    let sent = await send(1);
    let response = sent.response;
    if (response.status === 401 && sent.authApplied) {
      // Retry at most once, unconditionally. The only race this can repair is credentials being
      // refreshed after the request was sent; the limit of one prevents spinning.
      input.logger?.info("Official MCP retrying once after 401", {
        ...logBase,
        attempt: 2,
        status: "started",
      });
      await discardBody(response);
      sent = await send(2);
      response = sent.response;
    }

    if (response.status === 401) {
      const baseMessage = "official MCP rejected the current credential";
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_rejected", message);
    }
    if (response.status === 403) {
      // When identity is valid but permissions/plan are insufficient, retrieving the same
      // credentials again cannot change the result.
      const baseMessage = "official MCP denied access for the current plan";
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_forbidden", message);
    }
    if (isRedirect(response.status)) {
      const baseMessage = `official MCP responded with a blocked redirect (${response.status})`;
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_redirect_blocked", message);
    }
    return response;
  };

  return authFetch as typeof globalThis.fetch;
}

const MAX_DIAGNOSTIC_RESPONSE_BYTES = 64 * 1024;

async function classifyOfficialMcpResponse(
  response: Response,
): Promise<McpServerFailureKind | undefined> {
  if (response.status === 429) return "rate_limited";
  if (response.status >= 500) return "server_internal_error";

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    return response.ok ? undefined : "connection_failed";
  }
  const text = await readBoundedResponseText(response, MAX_DIAGNOSTIC_RESPONSE_BYTES);
  if (!text) return response.ok ? undefined : "connection_failed";
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response.ok ? undefined : "connection_failed";
    }
    const record = parsed as Record<string, unknown>;
    if (record["code"] === 3001) return "server_not_found";
    if (record["code"] === 1000) return "server_unavailable";
    if (record["jsonrpc"] === "2.0" && record["error"] !== undefined) {
      const rpcError = record["error"];
      if (rpcError && typeof rpcError === "object" && !Array.isArray(rpcError)) {
        const code = (rpcError as Record<string, unknown>)["code"];
        if (code === 1006) return "not_authenticated";
        if (code === 3101) return "coding_plan_required";
      }
      return "protocol_error";
    }
  } catch {
    return response.ok ? undefined : "connection_failed";
  }
  return response.ok ? undefined : "connection_failed";
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const declaredLength = numericHeader(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) return undefined;
  const body = response.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Merge static headers and identity headers. Identity headers always overwrite (set), and
 * reserved headers left from the source are removed. Static reserved headers are already
 * rejected during parsing; enforce the rule again at this merge point.
 * Do not touch mcp-session-id / mcp-protocol-version / accept / content-type.
 */
export function mergeOfficialAuthHeaders(
  incoming: HeadersInit | undefined,
  authHeaders: Record<string, string>,
): Headers {
  const merged = new Headers();
  const authHeaderNames = new Set(Object.keys(authHeaders).map((name) => name.toLowerCase()));
  new Headers(incoming ?? {}).forEach((value, name) => {
    const normalized = name.toLowerCase();
    // Identity headers are written uniformly afterward; discard other reserved headers (such as
    // Authorization written by authProvider).
    if (authHeaderNames.has(normalized)) return;
    if (
      isOfficialMcpReservedHeaderName(normalized) &&
      normalized !== "mcp-session-id" &&
      normalized !== "mcp-protocol-version"
    ) {
      return;
    }
    merged.set(name, value);
  });
  for (const [name, value] of Object.entries(authHeaders)) {
    merged.set(name, value);
  }
  return merged;
}

/** Shared by the adapter when parsing config, so the parse and merge blacklist has one source. */
export { findOfficialMcpReservedHeaders };

function resolveRequestUrl(resource: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.toString();
  return resource.url;
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    // A credential-bearing URL and its origin are not the same trust surface; reject it as untrusted.
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Read the request ID returned in the server response header; return undefined if absent. */
function readServerRequestId(response: Response): string | undefined {
  const value = response.headers.get(REQUEST_ID_HEADER)?.trim();
  return value ? value : undefined;
}

/**
 * Add the server request ID to a classified error message.
 *
 * Classified tool-call errors are shown directly to the caller in compact `message - requestId`
 * form. Connection-time request IDs are added by the adapter's structured status diagnostic to
 * avoid duplication before/after SDK wrapping.
 */
function withServerRequestId(message: string, response: Response): string {
  const requestId = readServerRequestId(response);
  return requestId ? `${message} - ${requestId}` : message;
}

/** Request path without the query string. The query may contain user content, so discard it. */
function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "(unparsable)";
  }
}

function byteLength(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

function numericHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Extract **structural** fields from a JSON-RPC request body for log correlation: method / id /
 * tool name for tools\_call / trace\_id from `_meta`.
 * Deliberately omit `params.arguments`: that contains user input (such as search terms) and is
 * not considered low sensitivity.
 *
 * trace\_id exists only on `tools/call`: the SDK sends `initialize` / `tools/list` during
 * connection setup without `_meta`, so those requests have a request ID but no trace ID. This is
 * expected, not a defect.
 */
function describeJsonRpc(body: unknown): {
  id?: number | string;
  method?: string;
  spanId?: string;
  toolName?: string;
  traceId?: string;
} {
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined;
    const params = isPlainRecord(record.params) ? record.params : undefined;
    const toolName = params && typeof params.name === "string" ? params.name : undefined;
    // mcpRequestMeta writes trace into params._meta (with both flat keys and com.zcode/ namespaced keys).
    const meta = params && isPlainRecord(params._meta) ? params._meta : undefined;
    const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : undefined;
    // span is the "one tool call" unit: traceId spans the entire top-level session and is shared
    // by multiple calls within it, so correlating with traceId would mix them up.
    const spanId = meta && typeof meta.span_id === "string" ? meta.span_id : undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      ...(method ? { method } : {}),
      ...(spanId ? { spanId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(traceId ? { traceId } : {}),
    };
  } catch {
    return {};
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * **Nonsensitive summary** of identity headers: names, whether they are paired, and the
 * targetType enum. Never log Authorization or api-key values, not even truncated values; log
 * retention is outside our control.
 */
function describeAbortSignal(signal: AbortSignal | null | undefined): string {
  if (!signal) return "none";
  return signal.aborted ? "already-aborted" : "armed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Failure to discard the body does not affect classification.
  }
}
