import type { FetchLike, AuthProvider } from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isCanonicalTokenNearExpiry, loadCredentialPair } from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import { refreshMcpOAuthTokensUnderLock } from "./oauth-refresh.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export interface CreateMcpOAuthTokenProviderInput {
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  serverName: string;
  serverUrl: string;
}

/**
 * Phase 1 runtime AuthProvider.
 *
 * Implements only `token()` and `onUnauthorized()`, **not** `OAuthClientProvider`: the transport's
 * `isOAuthClientProvider()` check is therefore false and `_oauthProvider` stays empty
 * (client@2.0.0 `index.mjs:4977-4980`), which means:
 *
 * - Connection setup does not run discovery or DCR and does not open a callback listener.
 * - A 401 calls our `onUnauthorized()` and retries once; the SDK's `auth()` is not involved, so all refreshes
 *   are forced through our cross-process single-flight lock.
 *
 * Never pass `OAuthClientProvider` to the runtime transport: it is wrapped by `adaptOAuthProvider`, and 401s go
 * through the SDK's `handleOAuthUnauthorized()` → `auth()`, bypassing the refresh lock and reintroducing concurrent refreshes.
 */
export function createMcpOAuthTokenProvider(
  input: CreateMcpOAuthTokenProviderInput,
): AuthProvider {
  const refreshInput = {
    credentialStore: input.credentialStore,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    keyPrefix: input.keyPrefix,
    ...(input.logger ? { logger: input.logger } : {}),
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    ...(input.config.clientId ? { staticClientId: input.config.clientId } : {}),
  };

  return {
    async token(): Promise<string | undefined> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      // Return undefined when there is no token: send the request and let onUnauthorized classify the resulting 401.
      if (!pair?.tokens) return undefined;
      if (!isCanonicalTokenNearExpiry(pair)) return pair.tokens.access_token;
      // Proactively refresh near expiration. Without a refresh token, use the current value until a 401; do not invent a refresh.
      if (!pair.tokens.refresh_token) return pair.tokens.access_token;
      return await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: false });
    },

    async onUnauthorized(): Promise<void> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      if (!pair?.tokens?.refresh_token) {
        throw createInteractiveAuthorizationRequiredError({
          reason: pair?.tokens ? "no_refresh_token" : "no_credentials",
          serverName: input.serverName,
        });
      }
      // The contract is “make the next token() return a usable token”; the SDK ignores this return value. The refresh
      // result has been published to canonical storage, and the next token() call will read it again.
      await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: true });
    },
  };
}
