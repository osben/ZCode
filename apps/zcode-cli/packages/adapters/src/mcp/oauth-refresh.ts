import { dirname, join } from "node:path";
import {
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  selectResourceURL,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type { Logger } from "@zcode/contracts";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  invalidateCanonicalCredentials,
  loadCredentialPair,
  publishCanonicalCredentials,
  type CredentialPairSnapshot,
} from "./oauth-credentials.js";
import {
  createInteractiveAuthorizationRequiredError,
  createTemporaryRefreshFailureError,
} from "./oauth-errors.js";
import { sanitizeKeyPrefix } from "./oauth-lease.js";
import { loadDiscoveryRecord, saveDiscoveryRecord } from "./oauth-shared.js";

/**
 * Refresh lock acquisition budget.
 *
 * Must cover the network budget under the lock (one discovery plus one token request), or waiters may time out
 * before the winner publishes a result. `withFileLock` defaults to only 8 seconds (privateFilePersistence.ts:9), which is insufficient.
 */
const REFRESH_LOCK_MAX_WAIT_MS = 45_000;

interface RefreshMcpOAuthTokensInput {
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  /**
   * reactive = triggered by `onUnauthorized` after a 401.
   *
   * Determines behavior on network failure: proactive refresh (near expiration) can fail soft and return the
   * current token because the resource server has not rejected it yet. Reactive refresh cannot: the token was
   * just rejected, so returning it guarantees another 401 and a `ClientHttpAuthentication` error, and would
   * misclassify a temporary AS failure as a need for interactive authorization.
   */
  reactive: boolean;
  serverName: string;
  serverUrl: string;
  /** Statically configured clientId. When present, `invalid_client` cannot be recovered through interactive authorization. */
  staticClientId?: string;
}

interface ResolvedAsMetadata {
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  resource?: URL;
}

/**
 * Refresh the access token under a cross-process single-flight lock and return a usable access token.
 *
 * Concurrent refresh issue: multiple CLI processes share one credential file, but `withFileLock` covers only
 * credential reads/writes, not the network token exchange. When the access token expires, concurrent processes
 * refresh with the same refresh token and trigger the authorization server's rotation reuse detection, revoking
 * the entire token family and forcing reauthorization.
 */
export async function refreshMcpOAuthTokensUnderLock(
  input: RefreshMcpOAuthTokensInput,
): Promise<string> {
  const observedGeneration = (await loadCredentialPair(input.credentialStore, input.keyPrefix))
    ?.generation;
  const lockPath = resolveRefreshLockPath(input.credentialStore.filePath, input.keyPrefix);

  try {
    return await withFileLock(
      lockPath,
      async () => await refreshLocked(input, observedGeneration),
      {
        lockMaxWaitMs: REFRESH_LOCK_MAX_WAIT_MS,
      },
    );
  } catch (error) {
    if (!isZCodeFileLockTimeoutError(error)) throw error;
    // A lock timeout does not mean refresh failed; the winner may have published a result. Re-read first and reuse it if the generation changed and a token exists.
    const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);
    if (current?.tokens && current.generation !== observedGeneration) {
      return current.tokens.access_token;
    }
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
}

async function refreshLocked(
  input: RefreshMcpOAuthTokensInput,
  observedGeneration: string | undefined,
): Promise<string> {
  const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);

  // Coalesce: if another process refreshed while this one waited for the lock, reuse its token without a second request. This is key to avoiding rotation reuse detection.
  if (current?.tokens && current.generation !== observedGeneration) {
    return current.tokens.access_token;
  }
  if (!current?.tokens) {
    // If the generation changed but the winner left no token (for example, it received invalid_grant), do not silently
    // return “no credentials”; switch to interactive authorization.
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_credentials",
      serverName: input.serverName,
    });
  }
  const refreshToken = current.tokens.refresh_token;
  const clientInformation = current.clientInformation;
  if (!refreshToken || !clientInformation) {
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_refresh_token",
      serverName: input.serverName,
    });
  }

  let resolved: ResolvedAsMetadata;
  try {
    resolved = await resolveAsMetadata(input, current);
  } catch (error) {
    // A discovery failure must never be treated as an invalid grant.
    return failSoft(input, current, error);
  }

  try {
    const next = await refreshAuthorization(resolved.authorizationServerUrl, {
      clientInformation,
      refreshToken,
      ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
      ...(resolved.resource ? { resource: resolved.resource } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    const published = await publishCanonicalCredentials(input.credentialStore, input.keyPrefix, {
      clientInformation,
      ...(current.issuer ? { issuer: current.issuer } : {}),
      publishedBy: `refresh:${input.keyPrefix}`,
      tokens: next,
    });
    input.logger?.info("MCP OAuth access token refreshed", {
      event: "mcp.oauth.refresh.completed",
      credentialKeyPrefix: input.keyPrefix,
      mcpServerName: input.serverName,
      processId: process.pid,
      publishedGeneration: published.generation.slice(0, 12),
      reactive: input.reactive,
      refreshTokenRotated: next.refresh_token !== refreshToken,
      status: "completed",
    });
    return next.access_token;
  } catch (error) {
    return await handleRefreshFailure(input, current, error);
  }
}

async function handleRefreshFailure(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): Promise<never | string> {
  const oauthErrorCode = error instanceof OAuthError ? error.code : undefined;
  input.logger?.warn("MCP OAuth access token refresh failed", {
    event: "mcp.oauth.refresh.failed",
    credentialKeyPrefix: input.keyPrefix,
    credentialSource: current.source,
    mcpServerName: input.serverName,
    oauthErrorCode,
    processId: process.pid,
    reactive: input.reactive,
    status: "failed",
  });

  if (oauthErrorCode === OAuthErrorCode.InvalidGrant) {
    // Deterministic failure: the refresh token was revoked or expired. Clear tokens with CAS and
    // keep the client as a seed for reauthorization.
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "tokens",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_grant",
      serverName: input.serverName,
    });
  }

  if (
    oauthErrorCode === OAuthErrorCode.InvalidClient ||
    oauthErrorCode === OAuthErrorCode.UnauthorizedClient
  ) {
    if (input.staticClientId) {
      // An invalid_client from a statically configured client cannot be fixed through interactive
      // authorization: Phase 2 would use the same client and loop. Report it as a configuration error.
      throw new Error(
        `MCP server ${input.serverName} OAuth client was rejected by the authorization server (invalid_client). ` +
          `The configured clientId is not usable; fix the MCP oauth configuration.`,
        { cause: error },
      );
    }
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "all",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_client",
      serverName: input.serverName,
    });
  }

  return failSoft(input, current, error);
}

/**
 * Nondeterministic failures (network, 5xx, `server_error`).
 *
 * Proactive refresh returns the current value: the token has not been rejected, so let the request
 * proceed and leave the final decision to the 401 path.
 * Reactive refresh must throw a temporary error: the current token was just rejected, so returning
 * it would cause another 401.
 */
function failSoft(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): string {
  if (input.reactive || !current.tokens) {
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
  return current.tokens.access_token;
}

/**
 * Resolve authorization server metadata and the validated resource.
 *
 * Discovery records have a TTL and are shared with Phase 2. The `resource` must be resolved and
 * included in the refresh request (RFC 8707). The SDK includes it in its own refresh flow; after
 * bypassing `auth()`, we must add it ourselves or the audience binding is lost.
 */
async function resolveAsMetadata(
  input: Pick<
    RefreshMcpOAuthTokensInput,
    "credentialStore" | "fetchFn" | "keyPrefix" | "serverUrl"
  >,
  current: Pick<CredentialPairSnapshot, "issuer">,
): Promise<ResolvedAsMetadata> {
  const cached = await loadDiscoveryRecord(input.credentialStore, input.keyPrefix, {
    ...(current.issuer ? { expectedIssuer: current.issuer } : {}),
  });
  const discovered: OAuthDiscoveryState =
    cached ??
    (await discoverOAuthServerInfo(input.serverUrl, {
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    }));
  if (!cached) {
    await saveDiscoveryRecord(input.credentialStore, input.keyPrefix, discovered);
  }

  const resource = await selectResourceURL(
    input.serverUrl,
    // selectResourceURL only reads validateResourceURL from the provider; no provider is available
    // here, so an empty stub is sufficient.
    {} as never,
    discovered.resourceMetadata,
  );
  return {
    authorizationServerUrl: discovered.authorizationServerUrl,
    ...(discovered.authorizationServerMetadata
      ? { metadata: discovered.authorizationServerMetadata }
      : {}),
    ...(resource ? { resource } : {}),
  };
}

/**
 * Path to the refresh lock file.
 *
 * Keep it separate from the credentials file: inside the lock we call
 * `publishCanonicalCredentials`, which locks credentials.json itself. Reusing the same path would
 * deadlock on reentry. The basename contains only a hash and hyphens (Windows filenames forbid
 * colons).
 */
function resolveRefreshLockPath(credentialsFilePath: string, keyPrefix: string): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.refresh`);
}
