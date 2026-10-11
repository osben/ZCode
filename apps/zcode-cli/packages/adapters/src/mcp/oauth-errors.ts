import { InsufficientScopeError, SdkErrorCode, UnauthorizedError } from "@modelcontextprotocol/client";

/**
 * Stable identifier for an interactive authorization requirement.
 *
 * Register it with the global symbol registry using `Symbol.for`: when bundler duplication or version skew puts
 * two copies of adapter code in one process, both resolve to the same symbol, unlike `instanceof`. The SDK uses
 * the same technique at the transport auth seam (`Symbol.for("mcp.authSeamEscape")`), and
 * `markAuthSeamEscape()` preserves identity, so our brand can pass through the SDK unchanged to the orchestration layer.
 */
const INTERACTIVE_REQUIRED_BRAND = Symbol.for("zcode.mcp.oauth.interactiveAuthorizationRequired");
const TEMPORARY_REFRESH_FAILURE_BRAND = Symbol.for("zcode.mcp.oauth.temporaryRefreshFailure");

export const MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE = "MCP_OAUTH_INTERACTIVE_REQUIRED";
export const MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE =
  "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE";

export type McpOAuthInteractiveRequiredReason =
  | "no_credentials"
  | "no_refresh_token"
  | "invalid_grant"
  | "invalid_client"
  | "insufficient_scope"
  | "unauthorized"
  | "legacy_provider_seam";

export interface McpOAuthInteractiveRequiredError extends Error {
  code: typeof MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

export interface McpOAuthTemporaryRefreshFailureError extends Error {
  code: typeof MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
}

export function createInteractiveAuthorizationRequiredError(input: {
  cause?: unknown;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  serverName: string;
}): McpOAuthInteractiveRequiredError {
  const error = new Error(
    `MCP server ${input.serverName} requires interactive OAuth authorization (${input.reason})`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthInteractiveRequiredError;
  Object.defineProperty(error, INTERACTIVE_REQUIRED_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  error.reason = input.reason;
  if (input.requiredScope) error.requiredScope = input.requiredScope;
  if (input.resourceMetadataUrl) error.resourceMetadataUrl = input.resourceMetadataUrl;
  return error;
}

/**
 * Network/5xx failure during a reactive refresh.
 *
 * Keep this distinct from `interactiveRequired`: a temporary AS failure does not mean the grant is invalid, and
 * misclassifying it as a need for interactive authorization would interrupt the user needlessly. Returning the
 * old token already rejected by the resource server would guarantee a second 401.
 */
export function createTemporaryRefreshFailureError(input: {
  cause?: unknown;
  serverName: string;
}): McpOAuthTemporaryRefreshFailureError {
  const error = new Error(
    `MCP server ${input.serverName} OAuth token refresh failed temporarily`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthTemporaryRefreshFailureError;
  Object.defineProperty(error, TEMPORARY_REFRESH_FAILURE_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
  return error;
}

export function isInteractiveAuthorizationRequiredError(
  error: unknown,
): error is McpOAuthInteractiveRequiredError {
  return hasBrand(error, INTERACTIVE_REQUIRED_BRAND);
}

export function isTemporaryRefreshFailureError(
  error: unknown,
): error is McpOAuthTemporaryRefreshFailureError {
  return hasBrand(error, TEMPORARY_REFRESH_FAILURE_BRAND);
}

export interface InteractiveAuthorizationTrigger {
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

/**
 * Classify connection/runtime errors that require interactive authorization.
 *
 * With a pure AuthProvider, the SDK can produce only these deterministic authentication errors:
 * - Our own `interactiveRequired` errors (missing token, invalid_grant, invalid_client);
 * - `SdkHttpError(ClientHttpAuthentication)` when a retry still returns 401;
 * - `UnauthorizedError` when `onUnauthorized` is absent (defensive path);
 * - `InsufficientScopeError` for Streamable HTTP 403 responses (with requiredScope).
 *
 * `temporaryRefreshFailure` is explicitly excluded: it must preserve credentials and fail unchanged.
 */
export function classifyInteractiveAuthorizationTrigger(
  error: unknown,
): InteractiveAuthorizationTrigger | undefined {
  if (isTemporaryRefreshFailureError(error)) return undefined;
  if (isInteractiveAuthorizationRequiredError(error)) {
    return {
      reason: error.reason,
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl ? { resourceMetadataUrl: error.resourceMetadataUrl } : {}),
    };
  }
  if (error instanceof InsufficientScopeError) {
    return {
      reason: "insufficient_scope",
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl
        ? { resourceMetadataUrl: String(error.resourceMetadataUrl) }
        : {}),
    };
  }
  if (error instanceof UnauthorizedError) return { reason: "unauthorized" };
  if (isSdkAuthenticationHttpError(error)) return { reason: "unauthorized" };
  // Follow the cause chain: the SDK wraps errors at several seams, so classification cannot inspect only the outermost error.
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return classifyInteractiveAuthorizationTrigger(cause);
  }
  return undefined;
}

/** Still 401 after retry: `SdkHttpError(SdkErrorCode.ClientHttpAuthentication)`. Compare by code, not instanceof. */
function isSdkAuthenticationHttpError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === SdkErrorCode.ClientHttpAuthentication;
}

function hasBrand(error: unknown, brand: symbol): boolean {
  return (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
      ? (error as Record<symbol, unknown>)[brand] === true
      : false
  );
}
