import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import {
  createLocalhostOAuthCallbackServer,
  type LocalhostOAuthCallbackServer,
} from "../auth/localhost-callback.js";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import {
  deriveCredentialPair,
  isCanonicalCredentials,
  isRecord,
  MCP_OAUTH_CANONICAL_CREDENTIALS_KEY,
  MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS,
  publishCanonicalCredentials,
  type McpOAuthCanonicalCredentials,
} from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import {
  loadDiscoveryRecord,
  saveDiscoveryRecord,
  type McpOAuthAuthorizationContext,
} from "./oauth-shared.js";

const DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface CredentialSnapshot<T> {
  raw: string;
  value: T;
}

interface StoredCredentialPair {
  clientInformation?: OAuthClientInformationMixed;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

type TransactionClientSource = "canonical" | "legacy" | "registered";
type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export type { McpOAuthAuthorizationContext };

export interface McpOAuthRuntimeOptions {
  authorizationTimeoutMs?: number;
  credentialStore?: SharedZCodeCredentialStore;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
}

export interface McpOAuthSession {
  close(): Promise<void>;
  readonly provider: OAuthClientProvider;
  readonly timeoutMs: number;
  hasPendingAuthorization(): boolean;
  waitForAuthorizationCallback(): Promise<URLSearchParams>;
}

export async function createMcpAuthorizationCodeOAuthSession(input: {
  adapterInstanceId?: string;
  config: McpAuthorizationCodeOAuthConfig;
  logger?: Logger;
  options?: McpOAuthRuntimeOptions;
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthSession> {
  const state = randomBytes(24).toString("base64url");
  const callbackPath = normalizeCallbackPath(input.config.redirectPath, input.serverName);
  const callbackServer = await createLocalhostOAuthCallbackServer({
    callbackPath,
    state,
  });
  const credentialStore = input.options?.credentialStore ?? createSharedZCodeCredentialStore();
  const keyPrefix = createCredentialKeyPrefix(input.serverName, input.serverUrl, input.config);
  const provider = new ZCodeMcpAuthorizationCodeProvider({
    adapterInstanceId: input.adapterInstanceId,
    callbackServer,
    config: input.config,
    credentialStore,
    keyPrefix,
    logger: input.logger,
    onAuthorizationRequired: input.options?.onAuthorizationRequired,
    openAuthorizationUrl: input.options?.openAuthorizationUrl,
    serverName: input.serverName,
    state,
  });

  return {
    close: async () => {
      await callbackServer.close();
      await provider.close();
    },
    provider,
    timeoutMs: input.options?.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
    hasPendingAuthorization: () => provider.hasPendingAuthorization(),
    waitForAuthorizationCallback: async () => {
      const callback = await callbackServer.waitForCallback();
      return new URL(callback.url).searchParams;
    },
  };
}

class ZCodeMcpAuthorizationCodeProvider implements OAuthClientProvider {
  private readonly adapterInstanceId?: string;
  private readonly callbackServer: LocalhostOAuthCallbackServer;
  private readonly config: McpAuthorizationCodeOAuthConfig;
  private readonly credentialStore: SharedZCodeCredentialStore;
  private readonly keyPrefix: string;
  private readonly logger?: Logger;
  private readonly onAuthorizationRequired?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly openAuthorizationUrl?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly serverName: string;
  private readonly stateValue: string;
  private readonly transactionId: string;
  private canonicalSnapshot?: CredentialSnapshot<McpOAuthCanonicalCredentials>;
  private credentialSnapshotsLoaded = false;
  private legacyClientSnapshot?: CredentialSnapshot<OAuthClientInformationMixed>;
  private legacyTokensSnapshot?: CredentialSnapshot<OAuthTokens>;
  private storedCredentialPair?: StoredCredentialPair;
  private storedCredentialPairLoaded = false;
  private pendingAuthorization = false;
  private transactionClientInformation?: OAuthClientInformationMixed;
  private transactionClientSource?: TransactionClientSource;
  private verifierPersisted = false;

  constructor(input: {
    adapterInstanceId?: string;
    callbackServer: LocalhostOAuthCallbackServer;
    config: McpAuthorizationCodeOAuthConfig;
    credentialStore: SharedZCodeCredentialStore;
    keyPrefix: string;
    logger?: Logger;
    onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    serverName: string;
    state: string;
  }) {
    this.adapterInstanceId = input.adapterInstanceId;
    this.callbackServer = input.callbackServer;
    this.config = input.config;
    this.credentialStore = input.credentialStore;
    this.keyPrefix = input.keyPrefix;
    this.logger = input.logger;
    this.onAuthorizationRequired = input.onAuthorizationRequired;
    this.openAuthorizationUrl = input.openAuthorizationUrl;
    this.serverName = input.serverName;
    this.stateValue = input.state;
    this.transactionId = createHash("sha256").update(input.state).digest("hex");
  }

  get redirectUrl(): string {
    return this.callbackServer.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? `ZCode ${this.serverName}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      ...(this.config.clientSecret ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    if (this.transactionClientInformation) {
      return this.transactionClientInformation;
    }

    const storedPair = await this.loadStoredCredentialPair();
    if (storedPair?.clientInformation) {
      this.transactionClientInformation = storedPair.clientInformation;
      this.transactionClientSource = storedPair.source;
      return this.transactionClientInformation;
    }

    // Reason for the fix (root-cause 2 transition seam): returning undefined makes the SDK perform dynamic registration immediately, but DCR ownership
    // has moved entirely to Phase 2. Without a client there can be no refresh token, so interactive authorization is required;
    // throw interactiveRequired here instead of leaving an unused registration on the authorization server.
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_credentials",
      serverName: this.serverName,
    });
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    // Reason for the fix: the MCP SDK reads the provider again during authorization-code exchange.
    // Pin the dynamic-registration result to the provider instance for the current state; also persist it as the legacy client
    // to seed recovery if the provider is rebuilt. The rest of this transaction reads only the in-memory value, so concurrent registrations cannot overwrite it.
    await this.credentialStore.save(
      this.key("client_information"),
      JSON.stringify(clientInformation),
    );
    this.transactionClientInformation = clientInformation;
    this.transactionClientSource = "registered";
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.loadStoredCredentialPair())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const clientInformation = await this.clientInformation();
    if (!clientInformation) {
      throw new Error(`Missing MCP OAuth client information for ${this.serverName}`);
    }
    const previousTokens = this.storedCredentialPair?.tokens;
    // Publish through the shared helper so Phase 2 and this provider write exactly the same canonical shape
    // (including a generation unique to each publication). The client and refresh token must come from the same authorization;
    // the three keys are still written atomically inside one cross-process read-modify-write critical section.
    const published = await publishCanonicalCredentials(this.credentialStore, this.keyPrefix, {
      clientInformation,
      publishedBy: this.transactionId,
      tokens,
    });
    this.canonicalSnapshot = { raw: published.raw, value: published.canonical };
    this.legacyClientSnapshot = { raw: published.legacyClientRaw, value: clientInformation };
    this.legacyTokensSnapshot = { raw: published.legacyTokensRaw, value: tokens };
    this.credentialSnapshotsLoaded = true;
    this.storedCredentialPair = {
      clientInformation,
      source: "legacy",
      tokens,
    };
    this.storedCredentialPairLoaded = true;
    this.transactionClientSource = "canonical";
    // Reason for the fix: authorization and refresh previously emitted no success event, so logs showed only authorization.required
    // and could not tell whether a refresh succeeded. Record only safe identifiers and shapes; never log token plaintext.
    this.logger?.info("MCP OAuth credentials published", {
      event: "mcp.oauth.credentials.published",
      ...this.logContext(),
      clientIdHash: hashIdentifier(clientInformation.client_id),
      grantKind: previousTokens ? "refresh" : "authorization_code",
      hasRefreshToken: Boolean(tokens.refresh_token),
      publishedGeneration: published.generation.slice(0, 12),
      refreshTokenRotated: Boolean(
        previousTokens?.refresh_token &&
          tokens.refresh_token &&
          previousTokens.refresh_token !== tokens.refresh_token,
      ),
      status: "completed",
      tokenExpiresInSeconds: tokens.expires_in,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorization = true;
    // Reason for the fix (root-cause 2 transition seam): this provider reuses a persisted DCR client whose redirect_uris
    // are fixed to the random port used at registration, so `authorizationUrl` may combine an old client_id with a new redirect_uri.
    // Under RFC 6749 §4.1.2.1 the authorization server rejects the redirect and renders an error page; the callback never arrives and retry cannot recover.
    // So do not expose this URL or open the browser here; throw interactiveRequired so the adapter orchestration layer
    // can start a fresh DCR authorization transaction in Phase 2 (docs/mcp-oauth-two-phase.md §4.7).
    this.logger?.warn("MCP OAuth authorization handed off to interactive transaction", {
      event: "mcp.oauth.authorization.handoff",
      ...this.logContext(),
      callbackPort: Number(new URL(this.redirectUrl).port),
      status: "cancelled",
    });
    void authorizationUrl;
    throw createInteractiveAuthorizationRequiredError({
      reason: "legacy_provider_seam",
      serverName: this.serverName,
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.credentialStore.save(this.verifierKey(), codeVerifier);
    this.verifierPersisted = true;
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = await this.credentialStore.load(this.verifierKey());
    if (!codeVerifier) {
      throw new Error(`Missing MCP OAuth PKCE verifier for ${this.serverName}`);
    }
    this.verifierPersisted = true;
    return codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    // Share the same timestamped discovery record with Phase 2; otherwise one side could refresh AS metadata while the other
    // continues using an old cache with no TTL.
    await saveDiscoveryRecord(this.credentialStore, this.keyPrefix, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return await loadDiscoveryRecord(this.credentialStore, this.keyPrefix);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    // Reason for the fix: refresh failures used to be classified only inside the SDK, leaving no trace in ZCode and making it impossible to distinguish
    // expired tokens, revoked tokens, client mismatch, and temporary server errors afterward (see the observability gap in docs/analysis).
    // The SDK does not pass OAuth error codes to the provider, but each invalidation scope maps to one of them:
    // tokens ← invalid_grant；client/all ← invalid_client / unauthorized_client。
    this.logger?.warn("MCP OAuth credentials invalidated", {
      event: "mcp.oauth.credentials.invalidated",
      ...this.logContext(),
      invalidationScope: scope,
      status: "failed",
    });
    if (scope === "all" || scope === "client" || scope === "tokens") {
      await this.invalidateCredentialSnapshot(scope);
    }
    if (scope === "all" || scope === "verifier") {
      await this.clearVerifier();
    }
    if (scope === "all" || scope === "discovery") {
      await this.credentialStore.delete(this.key("discovery_state"));
    }
  }

  hasPendingAuthorization(): boolean {
    return this.pendingAuthorization;
  }

  async close(): Promise<void> {
    // Reason for the fix: a PKCE verifier belongs only to the current state. On adapter timeout or shutdown, clean up this transaction,
    // but do not delete the verifier awaited by another concurrent authorization for the same MCP configuration. Cleanup is best-effort:
    // after token exchange succeeds, lock timeout or a corrupt file must not turn the main path into a connection failure.
    try {
      await this.clearVerifier();
    } catch (error) {
      this.logger?.warn("MCP OAuth verifier cleanup failed", {
        event: "mcp.oauth.verifier.cleanup_failed",
        adapterInstanceId: this.adapterInstanceId,
        error: error instanceof Error ? error.message : String(error),
        mcpServerName: this.serverName,
        oauthStateId: this.transactionId.slice(0, 16),
        processId: process.pid,
        status: "failed",
      });
    }
    this.transactionClientInformation = undefined;
    this.transactionClientSource = undefined;
    this.resetCredentialSnapshots();
  }

  private async invalidateCredentialSnapshot(scope: "all" | "client" | "tokens"): Promise<void> {
    await this.loadCredentialSnapshots();
    const canonicalSnapshot = this.canonicalSnapshot;
    const expectedValues: Record<string, string> = {};
    if (canonicalSnapshot) {
      expectedValues[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)] = canonicalSnapshot.raw;
    }
    if ((scope === "all" || scope === "client") && this.legacyClientSnapshot) {
      expectedValues[this.key("client_information")] = this.legacyClientSnapshot.raw;
    }
    if (
      (scope === "all" || scope === "client" || scope === "tokens") &&
      this.legacyTokensSnapshot
    ) {
      expectedValues[this.key("tokens")] = this.legacyTokensSnapshot.raw;
    }
    const deleted = await this.credentialStore.deleteIfValues(expectedValues);
    const canonicalDeleted = canonicalSnapshot
      ? deleted[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]
      : undefined;
    this.logger?.warn("MCP OAuth credential snapshot invalidation resolved", {
      event: "mcp.oauth.credentials.invalidate_snapshot",
      ...this.logContext(),
      canonicalDeleted,
      // canonicalDeleted=false means compare-and-delete failed: another transaction published a new pair,
      // and this invalidation must preserve the winner. This is a normal concurrency outcome, not an error.
      hadCanonicalSnapshot: Boolean(canonicalSnapshot),
      invalidationScope: scope,
      legacyClientDeleted: deleted[this.key("client_information")],
      legacyTokensDeleted: deleted[this.key("tokens")],
      status: canonicalDeleted === false ? "cancelled" : "completed",
    });

    if (scope === "all" || scope === "client") {
      this.transactionClientInformation = undefined;
      this.transactionClientSource = undefined;
    } else if (
      this.transactionClientSource === "canonical" ||
      (canonicalSnapshot && this.transactionClientSource === "legacy")
    ) {
      if (canonicalDeleted === false) {
        // Reason for the fix: if another process replaced the current snapshot, the losing process must not delete the new pair. Clear the local cache
        // so the SDK's same retry rereads the client/tokens published by the winning transaction.
        this.transactionClientInformation = undefined;
        this.transactionClientSource = undefined;
      } else if (canonicalDeleted === true) {
        // The token is invalid, but the dynamic client can still be used to reauthorize this provider.
        this.transactionClientSource = "registered";
      }
    }

    this.resetCredentialSnapshots();
  }

  private async loadCredentialSnapshots(): Promise<void> {
    if (this.credentialSnapshotsLoaded) return;
    const canonicalKey = this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
    const legacyClientKey = this.key("client_information");
    const legacyTokensKey = this.key("tokens");
    const values = await this.credentialStore.loadMany([
      canonicalKey,
      legacyClientKey,
      legacyTokensKey,
    ]);
    const parsedCanonicalSnapshot = await this.parseJsonSnapshot<McpOAuthCanonicalCredentials>(
      canonicalKey,
      values[canonicalKey],
    );
    let canonicalSnapshot: CredentialSnapshot<McpOAuthCanonicalCredentials> | undefined;
    if (
      parsedCanonicalSnapshot &&
      isRecord(parsedCanonicalSnapshot.value) &&
      typeof parsedCanonicalSnapshot.value.version === "number" &&
      !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(parsedCanonicalSnapshot.value.version)
    ) {
      // Reason for the fix: CLI and desktop upgrade independently but share the credential file. Older versions must ignore unknown versions,
      // not delete canonical pairs written by newer versions as if they were corrupt.
    } else if (parsedCanonicalSnapshot && !isCanonicalCredentials(parsedCanonicalSnapshot.value)) {
      await this.credentialStore.deleteIfValue(canonicalKey, parsedCanonicalSnapshot.raw);
    } else {
      canonicalSnapshot = parsedCanonicalSnapshot;
    }
    const legacyClientSnapshot = await this.parseJsonSnapshot<OAuthClientInformationMixed>(
      legacyClientKey,
      values[legacyClientKey],
    );
    const legacyTokensSnapshot = await this.parseJsonSnapshot<OAuthTokens>(
      legacyTokensKey,
      values[legacyTokensKey],
    );

    // Reason for the fix: reading shared credentials can throw on lock timeout or transient I/O failure. Publish the cache and loaded flag only after a complete snapshot succeeds,
    // so the next call for this provider will retry.
    this.canonicalSnapshot = canonicalSnapshot;
    this.legacyClientSnapshot = legacyClientSnapshot;
    this.legacyTokensSnapshot = legacyTokensSnapshot;
    this.credentialSnapshotsLoaded = true;
  }

  private async parseJsonSnapshot<T>(
    key: string,
    raw: string | null | undefined,
  ): Promise<CredentialSnapshot<T> | undefined> {
    if (!raw) return undefined;
    try {
      return { raw, value: JSON.parse(raw) as T };
    } catch {
      await this.credentialStore.deleteIfValue(key, raw);
      return undefined;
    }
  }

  private async loadStoredCredentialPair(): Promise<StoredCredentialPair | undefined> {
    if (this.storedCredentialPairLoaded) return this.storedCredentialPair;
    await this.loadCredentialSnapshots();
    // Delegate to the shared pure function: the interleaved compatibility rules for canonical and legacy mirrors must have one implementation or the two copies will
    // diverge. Derive from the snapshot already read instead of reading the credential file again; keep the snapshot in this class because
    // compare-and-delete needs the original value read by the caller.
    const pair = deriveCredentialPair({
      canonicalRaw: this.canonicalSnapshot?.raw,
      legacyClientRaw: this.legacyClientSnapshot?.raw,
      legacyTokensRaw: this.legacyTokensSnapshot?.raw,
    });
    this.storedCredentialPair = pair
      ? {
          ...(pair.clientInformation ? { clientInformation: pair.clientInformation } : {}),
          source: pair.source,
          ...(pair.tokens ? { tokens: pair.tokens } : {}),
        }
      : undefined;
    this.storedCredentialPairLoaded = true;
    return this.storedCredentialPair;
  }


  private resetCredentialSnapshots(): void {
    this.canonicalSnapshot = undefined;
    this.credentialSnapshotsLoaded = false;
    this.legacyClientSnapshot = undefined;
    this.legacyTokensSnapshot = undefined;
    this.storedCredentialPair = undefined;
    this.storedCredentialPairLoaded = false;
  }

  private async loadJson<T>(name: string): Promise<T | undefined> {
    const raw = await this.credentialStore.load(this.key(name));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.credentialStore.deleteIfValue(this.key(name), raw);
      return undefined;
    }
  }

  private async saveJson(name: string, value: unknown): Promise<void> {
    await this.credentialStore.save(this.key(name), JSON.stringify(value));
  }

  private key(name: string): string {
    return `${this.keyPrefix}:${name}`;
  }

  /** Concurrency diagnostics may log only safe identifiers: PID, adapter ID, credential-key prefix, and short state hash. */
  private logContext(): Record<string, unknown> {
    return {
      adapterInstanceId: this.adapterInstanceId,
      credentialKeyPrefix: this.keyPrefix,
      mcpServerName: this.serverName,
      oauthStateId: this.transactionId.slice(0, 16),
      processId: process.pid,
    };
  }

  private verifierKey(): string {
    return this.key(`code_verifier:${this.stateValue}`);
  }

  private async clearVerifier(): Promise<void> {
    if (!this.verifierPersisted) return;
    await this.credentialStore.delete(this.verifierKey());
    this.verifierPersisted = false;
  }
}

/** Redacted summary for logs: identifiers such as client_id are represented by hash prefixes, never their original values. */
function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeCallbackPath(value: string | undefined, serverName: string): string {
  const fallback = `/oauth/callback/mcp/${encodeURIComponent(serverName)}`;
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

export function createCredentialKeyPrefix(
  serverName: string,
  serverUrl: string,
  config: McpAuthorizationCodeOAuthConfig,
): string {
  // OAuth tokens and dynamic client registration depend on authorization semantics; reauthorize when scope/client/redirect changes.
  const hash = createHash("sha256")
    .update(
      [
        serverName,
        serverUrl,
        config.clientId ?? "",
        config.scope ?? "",
        config.redirectPath ?? "",
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 24);
  return `mcp:oauth:${hash}`;
}
