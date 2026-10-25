import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";

export const MCP_OAUTH_CANONICAL_CREDENTIALS_KEY = "authorization_credentials";
export const MCP_OAUTH_LEGACY_CLIENT_KEY = "client_information";
export const MCP_OAUTH_LEGACY_TOKENS_KEY = "tokens";
export const MCP_OAUTH_CREDENTIALS_VERSION = 2;
export const MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS = new Set([1, MCP_OAUTH_CREDENTIALS_VERSION]);

/**
 * Canonical credential pair.
 *
 * `generation`, `obtained_at`, `expires_at`, and `issuer` are all **optional additions**, so do not bump the
 * version. Appending optional fields is backward-compatible with old readers, which can ignore unknown fields;
 * bumping the version would make older CLI/Desktop readers ignore the entire record as an unknown version and
 * fall back to the legacy mirror, losing the pair guarantee.
 */
export interface McpOAuthCanonicalCredentials {
  client_information: OAuthClientInformationMixed;
  /** Absolute expiration time (epoch ms), derived from `expires_in` and `obtained_at`. */
  expires_at?: number;
  /**
   * Random id unique to each publication.
   *
   * Do not reuse `published_by`: it is a transaction id derived from OAuth state and does not change across
   * multiple refreshes in one transaction, so it cannot support generation observation by followers or
   * invalidation CAS. The random id also prevents ABA.
   */
  generation?: string;
  /** Authorization server issuer. Stored as a field for now, but not used to key credentials. */
  issuer?: string;
  /** Token acquisition time (epoch ms). `OAuthTokens` contains only `expires_in`; without this, the actual expiration time cannot be computed across processes. */
  obtained_at?: number;
  published_by: string;
  tokens: OAuthTokens;
  version: 1 | typeof MCP_OAUTH_CREDENTIALS_VERSION;
}

export interface CanonicalCredentialSnapshot {
  clientInformation: OAuthClientInformationMixed;
  expiresAt?: number;
  generation: string;
  issuer?: string;
  obtainedAt?: number;
  /** Raw JSON used by compare-and-delete. */
  raw: string;
  tokens: OAuthTokens;
}

export function mcpOAuthCredentialKey(keyPrefix: string, name: string): string {
  return `${keyPrefix}:${name}`;
}

export function createCredentialGeneration(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Migration-period baseline: old records have no `generation`, so use a stable hash of the raw canonical content.
 * A content change means the generation changed, which is enough for followers to determine whether it advanced.
 */
export function resolveCredentialGeneration(
  canonical: McpOAuthCanonicalCredentials,
  raw: string,
): string {
  if (typeof canonical.generation === "string" && canonical.generation.length > 0) {
    return canonical.generation;
  }
  return `legacy-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

export function isCanonicalCredentials(value: unknown): value is McpOAuthCanonicalCredentials {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(value.version)
  ) {
    return false;
  }
  if (typeof value.published_by !== "string" || value.published_by.length === 0) return false;
  if (!isRecord(value.client_information) || !isRecord(value.tokens)) return false;
  return (
    typeof value.client_information.client_id === "string" &&
    typeof value.tokens.access_token === "string" &&
    typeof value.tokens.token_type === "string"
  );
}

/**
 * Read only the canonical pair; do not derive a value through legacy compatibility rules.
 *
 * The Phase 2 baseline generation and Phase 1 refresh need only canonical credentials; interleaved compatibility
 * with the legacy mirror remains in the provider.
 */
export async function loadCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CanonicalCredentialSnapshot | undefined> {
  const key = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const raw = await credentialStore.load(key);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isCanonicalCredentials(parsed)) return undefined;
  return {
    clientInformation: parsed.client_information,
    ...(parsed.expires_at === undefined ? {} : { expiresAt: parsed.expires_at }),
    generation: resolveCredentialGeneration(parsed, raw),
    ...(parsed.issuer === undefined ? {} : { issuer: parsed.issuer }),
    ...(parsed.obtained_at === undefined ? {} : { obtainedAt: parsed.obtained_at }),
    raw,
    tokens: parsed.tokens,
  };
}

export interface PublishCanonicalCredentialsInput {
  clientInformation: OAuthClientInformationMixed;
  issuer?: string;
  obtainedAt?: number;
  publishedBy: string;
  tokens: OAuthTokens;
}

export interface PublishedCanonicalCredentials {
  canonical: McpOAuthCanonicalCredentials;
  generation: string;
  legacyClientRaw: string;
  legacyTokensRaw: string;
  raw: string;
}

/**
 * Atomically publish the canonical pair and legacy mirror.
 *
 * The client and refresh token must come from the same authorization, so all three keys must be written together
 * inside one cross-process read-modify-write critical section in the shared credential store. Separate writes
 * could leave the client and token from different transactions. Maintain the legacy mirror during the compatibility
 * window so older CLI/Desktop versions can still read credentials.
 */
export async function publishCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  input: PublishCanonicalCredentialsInput,
): Promise<PublishedCanonicalCredentials> {
  const obtainedAt = input.obtainedAt ?? Date.now();
  const expiresAt =
    typeof input.tokens.expires_in === "number" && Number.isFinite(input.tokens.expires_in)
      ? obtainedAt + input.tokens.expires_in * 1000
      : undefined;
  const generation = createCredentialGeneration();
  const canonical: McpOAuthCanonicalCredentials = {
    client_information: input.clientInformation,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    generation,
    ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
    obtained_at: obtainedAt,
    published_by: input.publishedBy,
    tokens: input.tokens,
    version: MCP_OAUTH_CREDENTIALS_VERSION,
  };
  const raw = JSON.stringify(canonical);
  const legacyClientRaw = JSON.stringify(input.clientInformation);
  const legacyTokensRaw = JSON.stringify(input.tokens);
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]: raw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY)]: legacyClientRaw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY)]: legacyTokensRaw,
  });
  return { canonical, generation, legacyClientRaw, legacyTokensRaw, raw };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Safety margin for determining whether an access token is nearing expiration. */
export const MCP_OAUTH_EXPIRY_SKEW_MS = 30_000;

/**
 * Whether to refresh the token before placing it in a request header.
 *
 * Treat credentials without `expires_at` (old records or a server response without `expires_in`) as nearing
 * expiration. `OAuthTokens` has no acquisition time, so the actual expiration cannot be calculated; it is safer
 * to acquire the lock and try one refresh than to send a possibly expired token.
 */
export function isCanonicalTokenNearExpiry(
  snapshot: Pick<CanonicalCredentialSnapshot, "expiresAt">,
  now = Date.now(),
  skewMs = MCP_OAUTH_EXPIRY_SKEW_MS,
): boolean {
  if (snapshot.expiresAt === undefined) return true;
  return now >= snapshot.expiresAt - skewMs;
}

export type CanonicalInvalidationScope = "tokens" | "all";

/**
 * Conditionally invalidate based on the canonical snapshot.
 *
 * Delete only if the current canonical value still equals `expectedRaw`; if another transaction has published a
 * new pair, abandon this invalidation entirely so it cannot delete the winner. `tokens` preserves the legacy client
 * as a seed for reauthorization; `all` is for `invalid_client`, where the client and token must both be discarded.
 */
export async function invalidateCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  expectedRaw: string,
  scope: CanonicalInvalidationScope,
): Promise<boolean> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const keysToDelete = [
    canonicalKey,
    mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY),
  ];
  if (scope === "all") {
    keysToDelete.push(mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY));
  }
  return await credentialStore.deleteManyIfValue(canonicalKey, expectedRaw, keysToDelete);
}

export interface CredentialPairSnapshot {
  clientInformation?: OAuthClientInformationMixed;
  expiresAt?: number;
  /** Use the canonical generation when available; derive it from content for legacy-only records, still allowing change detection. */
  generation?: string;
  issuer?: string;
  obtainedAt?: number;
  /** Raw canonical JSON; undefined for legacy-only records (canonical CAS is unavailable). */
  raw?: string;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

/**
 * Read the canonical record and legacy mirror, then derive a usable pair using compatibility rules.
 */
export async function loadCredentialPair(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CredentialPairSnapshot | undefined> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const legacyClientKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY);
  const legacyTokensKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY);
  const values = await credentialStore.loadMany([canonicalKey, legacyClientKey, legacyTokensKey]);
  return deriveCredentialPair({
    canonicalRaw: values[canonicalKey] ?? undefined,
    legacyClientRaw: values[legacyClientKey] ?? undefined,
    legacyTokensRaw: values[legacyTokensKey] ?? undefined,
  });
}

/**
 * Pair derivation rules during the compatibility window (pure function, no I/O).
 *
 * Keep this as a pure function so callers that already hold a raw snapshot (the provider needs the raw value for
 * compare-and-delete) can reuse the same rules instead of rereading the credential file. Duplicating these
 * interleaved compatibility branches in two places would inevitably cause them to drift.
 *
 * Background: during the compatibility window, CLI and Desktop may be different versions. Older processes write
 * only the legacy key, while newer ones write canonical plus mirror. These rules determine whether, without a
 * generation in the old format, a legacy change can be proven to belong to the same authorization.
 */
export function deriveCredentialPair(input: {
  canonicalRaw?: string;
  legacyClientRaw?: string;
  legacyTokensRaw?: string;
}): CredentialPairSnapshot | undefined {
  const canonicalParsed = parseJson<unknown>(input.canonicalRaw);
  const canonical =
    canonicalParsed !== undefined && isCanonicalCredentials(canonicalParsed)
      ? canonicalParsed
      : undefined;
  const legacyClient = parseJson<OAuthClientInformationMixed>(input.legacyClientRaw);
  const legacyTokens = parseJson<OAuthTokens>(input.legacyTokensRaw);

  if (canonical && input.canonicalRaw) {
    const canonicalSnapshot: CredentialPairSnapshot = {
      clientInformation: canonical.client_information,
      ...(canonical.expires_at === undefined ? {} : { expiresAt: canonical.expires_at }),
      generation: resolveCredentialGeneration(canonical, input.canonicalRaw),
      ...(canonical.issuer === undefined ? {} : { issuer: canonical.issuer }),
      ...(canonical.obtained_at === undefined ? {} : { obtainedAt: canonical.obtained_at }),
      raw: input.canonicalRaw,
      source: "canonical",
      tokens: canonical.tokens,
    };
    if (canonical.version === 1) {
      const canAdoptLegacyTokens =
        legacyTokens !== undefined &&
        (!legacyClient || isDeepStrictEqual(legacyClient, canonical.client_information));
      if (canAdoptLegacyTokens) {
        return {
          clientInformation: legacyClient ?? canonical.client_information,
          source: "legacy",
          tokens: legacyTokens,
        };
      }
      // v1 removes the legacy mirror, so its absence is the normal steady state. Applying v2's mirror invalidation rule
      // here would discard a still-valid canonical token and force every upgraded user to reauthorize.
      return canonicalSnapshot;
    }
    if (!legacyTokens) {
      // After an old provider invalidates tokens, keep them invalid; do not revive an old token from canonical storage.
      return { clientInformation: legacyClient, source: "legacy" };
    }
    if (isDeepStrictEqual(legacyTokens, canonical.tokens)) {
      return legacyClient ? canonicalSnapshot : { source: "legacy", tokens: legacyTokens };
    }
    if (legacyClient && isDeepStrictEqual(legacyClient, canonical.client_information)) {
      // If the client has not changed, the legacy token can be confirmed as a refresh result from the old provider for the same identity.
      return { clientInformation: legacyClient, source: "legacy", tokens: legacyTokens };
    }
    // If both client and token changed without a generation, they cannot be proven to come from the same transaction.
    // Keep the client for reauthorization; never guess by combining authentication credentials.
    return { clientInformation: legacyClient, source: "legacy" };
  }

  if (!legacyClient && !legacyTokens) return undefined;
  return {
    clientInformation: legacyClient,
    source: "legacy",
    ...(legacyTokens ? { tokens: legacyTokens } : {}),
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
