import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

export const MCP_OAUTH_DISCOVERY_STATE_KEY = "discovery_state";
export const MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY = "discovery_state_fetched_at";

/** Discovery metadata cache lifetime. Rediscover after expiration to avoid long-term use of stale AS metadata after an endpoint change. */
export const MCP_OAUTH_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export interface McpOAuthAuthorizationContext {
  authorizationUrl: string;
  redirectUrl: string;
  serverName: string;
}

/**
 * Store the discovery record timestamp in a separate key; do not wrap `discovery_state` itself.
 *
 * The value shape of `discovery_state` must remain a bare `OAuthDiscoveryState`: CLI and Desktop upgrade
 * independently while sharing one credential file. Changing it to a `{fetched_at, state}` wrapper would make
 * an older reader see an object without `authorizationServerUrl` and silently lose the discovery cache. Adding
 * an optional key is the backward-compatible approach.
 */
export async function saveDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  state: OAuthDiscoveryState,
  now = Date.now(),
): Promise<void> {
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY)]: JSON.stringify(state),
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY)]: String(now),
  });
}

/**
 * Read an unexpired discovery record.
 *
 * If the timestamp is missing (written by an older version) or the record has expired, return `undefined` so the
 * caller rediscovers. The next save adds the timestamp and repairs the record.
 */
export async function loadDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  options: { expectedIssuer?: string; now?: number; ttlMs?: number } = {},
): Promise<OAuthDiscoveryState | undefined> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MCP_OAUTH_DISCOVERY_TTL_MS;
  const stateKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY);
  const fetchedAtKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY);
  const values = await credentialStore.loadMany([stateKey, fetchedAtKey]);
  const raw = values[stateKey];
  if (!raw) return undefined;

  const fetchedAt = Number(values[fetchedAtKey]);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt >= ttlMs) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.authorizationServerUrl !== "string") return undefined;

  const state = parsed as unknown as OAuthDiscoveryState;
  if (options.expectedIssuer && !issuersMatch(state, options.expectedIssuer)) {
    // The issuer in the canonical record differs from the cache, indicating the authorization server changed; invalidate the cache.
    return undefined;
  }
  return state;
}

function issuersMatch(state: OAuthDiscoveryState, expectedIssuer: string): boolean {
  const cachedIssuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
  if (!cachedIssuer) return false;
  return normalizeIssuer(cachedIssuer) === normalizeIssuer(expectedIssuer);
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
