/* oxlint-disable eslint(max-lines) -- One coordinator owns the SIWC loopback login, credential persistence, and refresh lifecycle together; splitting it would separate the shared lock/scope invariants this file exists to keep in one place. */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { ICredentialService } from "../../credential/credential.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { getAppConfigDir } from "../../paths.js";
import {
  buildChatGptPlanAccountProviderId,
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountProviderAuthSourceKey,
  buildSiwcAccountProviderIdentityKey,
  buildSiwcAccountRefreshLockFileName,
  isChatGptPlanAccountKey,
  SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
  SIWC_ACCOUNTS_LOCK_FILE_NAME,
  SIWC_LEGACY_CREDENTIAL_KEYS,
  type SiwcPlanAccountStatus,
  type SiwcPlanAccountsStatus,
  type SiwcPlanUserSummary,
  type SiwcStoredAccountRecord,
} from "@zcode/shared";
import {
  SIWC_CALLBACK_PATH,
  SIWC_TERMINAL_REFRESH_ERROR_CODES,
  buildSiwcAuthorizeUrl,
  createSiwcJwksVerifier,
  createSiwcPkcePair,
  createSiwcState,
  createSiwcTokenClient,
  isSiwcPlanUsageEntitled,
  parseSiwcScopes,
  redactSiwcAuthorizeUrl,
  SiwcOAuthError,
  SiwcRevokeError,
  type SiwcIdTokenClaims,
} from "./siwcOAuth.js";

const log = createServiceLogger("siwcAuthService");
const SIWC_LOGIN_TIMEOUT_MS = 5 * 60_000;
const SIWC_REFRESH_LOCK_MAX_WAIT_MS = 45_000;
const SIWC_PROACTIVE_REFRESH_MARGIN_SECONDS = 120;
const REVOKE_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/**
 * Stable per-account slot key: sha256(sub) prefix — no PII in ids, keys, or logs. Mirrors the
 * CLI adapters implementation; both sides are pinned by identical test vectors.
 */
export function createSiwcAccountKey(sub: string): string {
  const normalized = sub.trim();
  if (!normalized) throw new Error("SIWC account subject is empty");
  return createHash("sha256") // codeql[js/insufficient-password-hash] — slot id, not password storage
    .update(normalized, "utf-8")
    .digest("hex")
    .slice(0, 16);
}

/** Stable per-host agent id (shared with the CLI: same file, plain text, not a secret). */
async function resolveHostId(configDir: string): Promise<string> {
  const path = join(configDir, "siwc-host-id.txt");
  try {
    const existing = (await readFile(path, "utf-8")).trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hostId = `urn:uuid:${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${hostId}\n`, { encoding: "utf-8", mode: 0o600 });
  return hostId;
}

interface SiwcPendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  isSettled: () => boolean;
  server: Server;
  callbackUrl: string;
  issuedClientId?: string;
  timeout: NodeJS.Timeout;
  completion: Promise<{ ok: true; value: SiwcLoginCompletion } | { ok: false; error: unknown }>;
}

interface SiwcLoginCompletion {
  claims: SiwcIdTokenClaims;
  /** Authorization code captured by the loopback redirect. */
  code: string;
  issuedClientId?: string;
}

export interface SiwcAuthServiceDependencies {
  /** Overrides the credential/config directory (tests); defaults to the app config dir. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * Host-side SIWC login/logout/status coordinator for the ChatGPT plan provider.
 *
 * Multi-account: every signed-in ChatGPT account owns a credential slot
 * (`oauth:chatgpt:<accountKey>:*`) plus an index record; a login adds or re-authorizes the
 * slot derived from the verified `sub`, and logout or refresh failures touch only one
 * account. Independent of the zai/bigmodel pending-state machine: the loopback listener
 * lives in the host process; `oauth:active_provider` and `zcodejwttoken` are never touched.
 */
export class SiwcAuthService {
  private pending: SiwcPendingLogin | null = null;
  private readonly now: () => number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly inFlightToken = new Map<string, Promise<{ accessToken: string }>>();

  constructor(
    private readonly credentialService: ICredentialService,
    private readonly dependencies: SiwcAuthServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.configDir = dependencies.configDir ?? getAppConfigDir();
  }

  private readonly configDir: string;

  /**
   * Start a login: loopback listener + PKCE + authorize URL. Default mode adds an account
   * (fresh registration, no hints — OpenAI shows its account chooser); `reauthAccountKey`
   * re-authorizes that account with its issued client id and hints. The UI opens the URL in
   * the system browser and polls `pollLogin`. The returned URL is redacted for display; the
   * browser needs the full URL, so both variants are provided.
   */
  async startLogin(options: { reauthAccountKey?: string } = {}): Promise<{
    authorizeUrl: string;
    displayAuthorizeUrl: string;
    state: string;
  }> {
    await this.cancelLogin();
    const hostId = await resolveHostId(this.configDir);
    await this.migrateLegacyCredentials();
    let issuedClientId: string | undefined;
    let idTokenHint: string | undefined;
    let loginHint: string | undefined;
    if (options.reauthAccountKey) {
      const keys = buildSiwcAccountCredentialKeys(options.reauthAccountKey);
      const stored = await this.readCredentialStrings(keys.clientId, keys.idToken, keys.userInfo);
      issuedClientId = stored[keys.clientId] ?? undefined;
      idTokenHint = stored[keys.idToken] ?? undefined;
      loginHint = readUserJsonField(stored[keys.userInfo], "email") ?? undefined;
    }

    const pkce = createSiwcPkcePair();
    const state = createSiwcState();
    const nonce = randomUUID();
    const loopback = await listenForCallback(state);
    const authorizeUrl = buildSiwcAuthorizeUrl({
      codeChallenge: pkce.codeChallenge,
      extAgentHostId: hostId,
      nonce,
      redirectUri: loopback.callbackUrl,
      state,
      ...(issuedClientId
        ? {
            issuedClientId,
            ...(idTokenHint ? { idTokenHint } : {}),
            ...(loginHint ? { loginHint } : {}),
          }
        : {}),
    });
    this.pending = {
      state,
      nonce,
      codeVerifier: pkce.codeVerifier,
      isSettled: loopback.isSettled,
      server: loopback.server,
      callbackUrl: loopback.callbackUrl,
      ...(issuedClientId ? { issuedClientId } : {}),
      timeout: setTimeout(() => void this.cancelLogin(), SIWC_LOGIN_TIMEOUT_MS),
      // Convert rejection to a result immediately, so an OAuth denial does not become an
      // unhandled rejection while the UI waits for its next poll.
      completion: loopback.completion.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    };
    return {
      authorizeUrl,
      displayAuthorizeUrl: redactSiwcAuthorizeUrl(authorizeUrl),
      state,
    };
  }

  /** null while the browser has not returned; the completion result once it has. */
  async pollLogin(): Promise<null | (SiwcPlanAccountStatus & { newUser: boolean })> {
    const pending = this.pending;
    if (!pending) return null;
    // Poll semantics: return null while the redirect has not arrived (the completion
    // promise below resolves only via the loopback) instead of blocking the caller.
    if (!pending.isSettled()) return null;
    // Claim the completed login before the token exchange so overlapping polls cannot
    // redeem the same one-time authorization code more than once.
    if (this.pending !== pending) return null;
    this.pending = null;
    clearTimeout(pending.timeout);
    try {
      const result = await pending.completion;
      if (!result.ok) throw result.error;
      const completion = result.value;
      const tokenClient = createSiwcTokenClient({ fetchFn: this.fetchFn });
      const effectiveClientId =
        completion.issuedClientId?.trim() || pending.issuedClientId?.trim() || "";
      if (!effectiveClientId) {
        throw new SiwcOAuthError({
          error: "missing_client_id",
          errorDescription: "ChatGPT plan sign-in did not issue a client id",
        });
      }
      if (
        pending.issuedClientId?.trim() &&
        completion.issuedClientId?.trim() &&
        pending.issuedClientId.trim() !== completion.issuedClientId.trim()
      ) {
        throw new SiwcOAuthError({
          error: "client_id_mismatch",
          errorDescription: "ChatGPT plan returned an unexpected client id",
        });
      }
      const exchanged = await tokenClient.exchangeCode({
        clientId: effectiveClientId,
        code: completion.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.callbackUrl,
      });
      const claims = await createSiwcJwksVerifier({ fetchFn: this.fetchFn, now: this.now }).verify(
        exchanged.idToken ?? "",
        { audience: effectiveClientId, nonce: pending.nonce },
      );
      const scopes = parseSiwcScopes(exchanged.scope);
      const persist = await this.persistLogin({
        claims,
        clientId: effectiveClientId,
        exchanged: {
          accessToken: exchanged.accessToken,
          ...(exchanged.refreshToken ? { refreshToken: exchanged.refreshToken } : {}),
          ...(exchanged.idToken ? { idToken: exchanged.idToken } : {}),
          ...(exchanged.scope ? { scopes: exchanged.scope } : {}),
          accessExpiresAt: Math.floor(this.now() / 1000) + (exchanged.expiresInSeconds ?? 3600),
          ...(exchanged.earliestRefreshAt !== undefined
            ? { earliestRefreshAt: exchanged.earliestRefreshAt }
            : {}),
        },
      });
      log.info("ChatGPT plan sign-in completed", {
        accountKey: persist.accountKey,
        entitled: isSiwcPlanUsageEntitled(scopes),
      });
      return {
        accountKey: persist.accountKey,
        newUser: persist.isNewAccount,
        signedIn: true,
        planUsageEntitled: isSiwcPlanUsageEntitled(scopes),
        user: toUserSummary(claims),
      };
    } finally {
      await closeServer(pending.server);
    }
  }

  async cancelLogin(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timeout);
    await closeServer(pending.server);
  }

  async getStatus(): Promise<SiwcPlanAccountsStatus> {
    await this.migrateLegacyCredentials();
    const accounts: SiwcPlanAccountStatus[] = [];
    for (const record of await this.readAccountIndex()) {
      const status = await this.readAccountStatus(record);
      if (status) accounts.push(status);
    }
    return { accounts };
  }

  /**
   * Revoke (best effort with backoff), then clear one account's local tokens; the client id
   * is retained and other accounts are untouched. Omitting the key revokes every account.
   * Each account's read → revoke → clear → remove transaction holds that account's
   * per-account refresh lock, so a concurrent refresh or login cannot write a rotated token
   * after the clear.
   */
  async logout(
    accountKey?: string,
  ): Promise<{ accountCount: number; revoked: boolean; signedOut: boolean }> {
    await this.migrateLegacyCredentials();
    const records = (await this.readAccountIndex()).filter((record) =>
      accountKey ? record.accountKey === accountKey : true,
    );
    if (records.length === 0) {
      return { accountCount: 0, revoked: false, signedOut: false };
    }
    const tokenClient = createSiwcTokenClient({ fetchFn: this.fetchFn });
    let allRevoked = true;
    for (const record of records) {
      // Hold the account's per-account refresh lock across read → revoke → clear → remove: a
      // concurrent refresh or login must not write a rotated token after the clear (live
      // credentials after sign-out) or race the index removal. Index removal takes the
      // accounts lock nested, keeping the shared refresh → accounts order.
      await withFileLock(
        join(this.configDir, buildSiwcAccountRefreshLockFileName(record.accountKey)),
        async () => {
          const keys = buildSiwcAccountCredentialKeys(record.accountKey);
          const stored = await this.readCredentialStrings(keys.clientId, keys.refreshToken);
          const clientId = stored[keys.clientId];
          const refreshToken = stored[keys.refreshToken];
          if (!clientId || !refreshToken) {
            // Incomplete slot (a login may persist an access token without a refresh token):
            // no revocation was attempted, so the aggregate must not report success. Clear
            // whatever token material exists before dropping the record, or resolveAccessToken
            // could keep serving a token the user signed out of.
            allRevoked = false;
            await this.clearTokenCredentials(record.accountKey);
            await this.removeAccountRecord(record.accountKey);
            return;
          }
          let revoked = false;
          for (
            let attempt = 0;
            attempt <= REVOKE_RETRY_DELAYS_MS.length && !revoked;
            attempt += 1
          ) {
            try {
              await tokenClient.revoke({ clientId, refreshToken });
              revoked = true;
            } catch (error) {
              if (error instanceof SiwcRevokeError && (error.httpStatus ?? 0) < 500) break;
              if (attempt < REVOKE_RETRY_DELAYS_MS.length) {
                await new Promise((resolve) =>
                  setTimeout(resolve, REVOKE_RETRY_DELAYS_MS[attempt]),
                );
              }
            }
          }
          if (!revoked) allRevoked = false;
          await this.clearTokenCredentials(record.accountKey);
          await this.removeAccountRecord(record.accountKey);
        },
        { lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS },
      );
    }
    log.info("ChatGPT plan signed out", {
      accountCount: records.length,
      revoked: allRevoked,
    });
    return { accountCount: records.length, revoked: allRevoked, signedOut: true };
  }

  /**
   * Resolve a request-time access token for one account (host answer for provider runtime
   * headers): proactive refresh before expiry, cross-process single-flight via the SAME
   * per-account lock file the CLI resolver uses, rotation-aware persistence, terminal
   * failures clear that account's tokens only.
   */
  async resolveAccessToken(
    accountKey: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    const existing = this.inFlightToken.get(accountKey);
    if (existing) return (await existing).accessToken;
    const pending = this.resolveAccessTokenLocked(
      accountKey,
      options.forceRefresh === true,
    ).finally(() => this.inFlightToken.delete(accountKey));
    this.inFlightToken.set(accountKey, pending);
    return (await pending).accessToken;
  }

  /**
   * Stable account-scope fingerprint (account-switch detection), identical to the CLI
   * resolver: hashes the per-account provider id, issued client id, and account subject —
   * never the rotating token.
   */
  async resolveAccountScope(accountKey: string): Promise<string> {
    const keys = buildSiwcAccountCredentialKeys(accountKey);
    const stored = await this.readCredentialStrings(keys.clientId, keys.userInfo);
    const clientId = stored[keys.clientId] ?? "";
    // Fingerprint input falls back to the client id when no user info is stored.
    const subject = readUserJsonField(stored[keys.userInfo], "sub") ?? clientId;
    const providerId = buildChatGptPlanAccountProviderId(accountKey);
    return createHash("sha256") // codeql[js/insufficient-password-hash]
      .update(JSON.stringify([providerId, "chatgpt", clientId, subject]))
      .digest("hex");
  }

  private async resolveAccessTokenLocked(
    accountKey: string,
    forceRefresh: boolean,
  ): Promise<{ accessToken: string }> {
    await this.migrateLegacyCredentials();
    let state = await this.readTokenState(accountKey);
    if (!state.accessToken && !state.refreshToken) {
      throw new Error("ChatGPT plan credentials are missing; sign in in Settings.");
    }
    if (!forceRefresh && state.accessToken && isAccessUsable(state, this.now())) {
      return { accessToken: state.accessToken };
    }
    state = await this.refreshUnderLock(accountKey, state);
    if (!state.accessToken || !isAccessUsable(state, this.now())) {
      throw new Error("ChatGPT plan token refresh did not produce a usable token; sign in again.");
    }
    return { accessToken: state.accessToken };
  }

  private async refreshUnderLock(
    accountKey: string,
    observed: SiwcTokenState,
  ): Promise<SiwcTokenState> {
    // Same per-account lock file as the CLI resolver: Desktop and CLI refreshes of one
    // account must serialize or the rotation reuse detector revokes the token family.
    const lockPath = join(this.configDir, buildSiwcAccountRefreshLockFileName(accountKey));
    try {
      return await withFileLock(lockPath, () => this.refreshLocked(accountKey, observed), {
        lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS,
      });
    } catch (error) {
      if (!isZCodeFileLockTimeoutError(error)) throw error;
      const current = await this.readTokenState(accountKey);
      if (current.accessToken && isAccessUsable(current, this.now())) return current;
      throw error;
    }
  }

  private async refreshLocked(
    accountKey: string,
    observed: SiwcTokenState,
  ): Promise<SiwcTokenState> {
    const keys = buildSiwcAccountCredentialKeys(accountKey);
    const current = await this.readTokenState(accountKey);
    if (!current.clientId || !current.refreshToken) {
      throw new Error("ChatGPT plan credentials are incomplete; sign in again.");
    }
    if (
      current.accessToken &&
      current.accessToken !== (observed.accessToken ?? null) &&
      isAccessUsable(current, this.now())
    ) {
      return current;
    }
    try {
      const response = await createSiwcTokenClient({ fetchFn: this.fetchFn }).refresh({
        clientId: current.clientId,
        refreshToken: current.refreshToken,
      });
      await this.writeCredentials({
        ...(response.refreshToken ? { [keys.refreshToken]: response.refreshToken } : {}),
        [keys.accessToken]: response.accessToken,
        ...(response.idToken ? { [keys.idToken]: response.idToken } : {}),
        ...(response.scope ? { [keys.scopes]: response.scope } : {}),
        [keys.accessExpiresAt]: String(
          Math.floor(this.now() / 1000) + (response.expiresInSeconds ?? 3600),
        ),
        ...(response.earliestRefreshAt !== undefined
          ? { [keys.earliestRefreshAt]: String(response.earliestRefreshAt) }
          : {}),
      });
      const after = await this.readTokenState(accountKey);
      if (!after.accessToken) {
        throw new Error("ChatGPT plan credentials disappeared during refresh");
      }
      return after;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "error" in error
          ? (error as { error?: unknown }).error
          : undefined;
      if (typeof code === "string" && SIWC_TERMINAL_REFRESH_ERROR_CODES.includes(code)) {
        await this.clearTokenCredentials(accountKey);
        throw new Error("ChatGPT plan sign-in expired or was revoked; sign in again.");
      }
      throw error;
    }
  }

  private async persistLogin(input: {
    claims: SiwcIdTokenClaims;
    clientId: string;
    exchanged: {
      accessToken: string;
      refreshToken?: string;
      idToken?: string;
      scopes?: string;
      accessExpiresAt: number;
      earliestRefreshAt?: number;
    };
  }): Promise<{ accountKey: string; isNewAccount: boolean }> {
    const accountKey = createSiwcAccountKey(input.claims.sub);
    const keys = buildSiwcAccountCredentialKeys(accountKey);
    const existing = (await this.readAccountIndex()).some(
      (record) => record.accountKey === accountKey,
    );
    // Slot replacement runs under the SAME per-account refresh lock as refreshUnderLock: an
    // in-flight refresh of the previous registration must not interleave (read old pair,
    // then overwrite the freshly saved tokens, or delete the new grant on a terminal error).
    // The index upsert commits inside the same critical section so slot and index become
    // visible together: the migration takes the same lock order (refresh → accounts), and an
    // index record committed after the refresh lock was released could lose the race to it.
    await withFileLock(
      join(this.configDir, buildSiwcAccountRefreshLockFileName(accountKey)),
      async () => {
        await this.replaceAccountSlot(accountKey, input);
        await this.upsertAccountRecord({
          accountKey,
          sub: input.claims.sub,
          email: input.claims.email ?? null,
          name: input.claims.name ?? null,
          addedAt: new Date(this.now()).toISOString(),
        });
      },
      { lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS },
    );
    return { accountKey, isNewAccount: !existing };
  }

  /**
   * Replace one account's slot with a fresh registration. The previous registration's
   * optional token fields are DELETED when the new exchange omits them — a same-subject
   * re-login can issue a new client id with no refresh token, and keeping the old client's
   * refresh token next to the new client id would send a mismatched pair on the next
   * refresh or revocation (and a terminal refresh error would clear the NEW grant).
   * Caller holds the per-account refresh lock.
   */
  private async replaceAccountSlot(
    accountKey: string,
    input: {
      claims: SiwcIdTokenClaims;
      clientId: string;
      exchanged: {
        accessToken: string;
        refreshToken?: string;
        idToken?: string;
        scopes?: string;
        accessExpiresAt: number;
        earliestRefreshAt?: number;
      };
    },
  ): Promise<void> {
    const keys = buildSiwcAccountCredentialKeys(accountKey);
    const entries: Record<string, string> = {
      [keys.clientId]: input.clientId,
      [keys.accessToken]: input.exchanged.accessToken,
      ...(input.exchanged.refreshToken
        ? { [keys.refreshToken]: input.exchanged.refreshToken }
        : {}),
      ...(input.exchanged.idToken ? { [keys.idToken]: input.exchanged.idToken } : {}),
      [keys.userInfo]: JSON.stringify(toStoredUser(input.claims)),
      ...(input.exchanged.scopes ? { [keys.scopes]: input.exchanged.scopes } : {}),
      [keys.accessExpiresAt]: String(input.exchanged.accessExpiresAt),
      ...(input.exchanged.earliestRefreshAt !== undefined
        ? { [keys.earliestRefreshAt]: String(input.exchanged.earliestRefreshAt) }
        : {}),
      [buildSiwcAccountProviderIdentityKey(accountKey)]: input.claims.sub,
      [buildSiwcAccountProviderAuthSourceKey(accountKey)]: "oauth",
    };
    const staleKeys = [keys.refreshToken, keys.idToken, keys.scopes, keys.earliestRefreshAt].filter(
      (key) => entries[key] === undefined,
    );
    await this.writeCredentials(entries);
    for (const key of staleKeys) await this.credentialService.delete(key);
  }

  private async clearTokenCredentials(accountKey: string): Promise<void> {
    const keys = buildSiwcAccountCredentialKeys(accountKey);
    for (const key of [
      keys.accessToken,
      keys.refreshToken,
      keys.idToken,
      keys.scopes,
      keys.accessExpiresAt,
      keys.earliestRefreshAt,
    ]) {
      await this.credentialService.delete(key);
    }
  }

  private async writeCredentials(entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.credentialService.save(key, value);
    }
  }

  private async readCredentialStrings(...keys: string[]): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    for (const key of keys) {
      const value = await this.credentialService.load(key);
      result[key] = value?.trim() ? value : null;
    }
    return result;
  }

  private async readTokenState(accountKey: string): Promise<SiwcTokenState> {
    const keys = buildSiwcAccountCredentialKeys(accountKey);
    const stored = await this.readCredentialStrings(
      keys.accessToken,
      keys.clientId,
      keys.refreshToken,
      keys.accessExpiresAt,
    );
    return {
      accessToken: stored[keys.accessToken] ?? null,
      clientId: stored[keys.clientId] ?? null,
      refreshToken: stored[keys.refreshToken] ?? null,
      accessExpiresAt: readEpoch(stored[keys.accessExpiresAt] ?? null),
    };
  }

  private async readAccountStatus(
    record: SiwcStoredAccountRecord,
  ): Promise<SiwcPlanAccountStatus | null> {
    const keys = buildSiwcAccountCredentialKeys(record.accountKey);
    const stored = await this.readCredentialStrings(
      keys.accessToken,
      keys.refreshToken,
      keys.scopes,
    );
    if (!stored[keys.accessToken] && !stored[keys.refreshToken]) return null;
    return {
      accountKey: record.accountKey,
      signedIn: true,
      planUsageEntitled: isSiwcPlanUsageEntitled(parseSiwcScopes(stored[keys.scopes])),
      user: {
        displayName: record.name ?? record.email ?? record.sub,
        email: record.email,
        subject: record.sub,
      },
    };
  }

  private async readAccountIndex(): Promise<readonly SiwcStoredAccountRecord[]> {
    const raw = await this.credentialService.load(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY);
    if (!raw?.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry) => (isAccountRecord(entry) ? [entry] : []));
    } catch {
      return [];
    }
  }

  private async writeAccountIndex(records: readonly SiwcStoredAccountRecord[]): Promise<void> {
    await this.credentialService.save(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY, JSON.stringify(records));
  }

  /**
   * Index mutations run under the same cross-process accounts lock as the CLI store: the
   * shared credentials file is mutated by both processes, and an unlocked read-merge-write
   * interleaving would drop one side's account entry.
   */
  private withAccountsLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.configDir, SIWC_ACCOUNTS_LOCK_FILE_NAME), operation, {
      lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS,
    });
  }

  private async upsertAccountRecord(record: SiwcStoredAccountRecord): Promise<void> {
    await this.withAccountsLock(async () => {
      const existing = await this.readAccountIndex();
      const next: SiwcStoredAccountRecord[] = [];
      let replaced = false;
      for (const item of existing) {
        if (item.accountKey === record.accountKey) {
          next.push({ ...record, addedAt: item.addedAt || record.addedAt });
          replaced = true;
        } else {
          next.push(item);
        }
      }
      if (!replaced) next.push(record);
      await this.writeAccountIndex(next);
    });
  }

  private async removeAccountRecord(accountKey: string): Promise<void> {
    await this.withAccountsLock(async () => {
      const next = (await this.readAccountIndex()).filter(
        (record) => record.accountKey !== accountKey,
      );
      await this.writeAccountIndex(next);
    });
  }

  /**
   * One-time migration of the pre-multi-account flat credentials into the single legacy
   * account's slot. Idempotent; absent legacy keys are a no-op. Runs under the same
   * cross-process locks as the CLI store and preserves an already-initialized destination
   * slot: a delayed second migrator replaying consumed legacy tokens over a freshly rotated
   * slot would trip refresh_token_reused and invalidate the login.
   *
   * Lock order (shared with the CLI store): the per-account refresh lock FIRST, then the
   * accounts lock. The migration writes the destination slot, so it must serialize with
   * login/refresh slot writes; otherwise a login that replaced the slot without its index
   * record committed yet could be overwritten by the legacy bundle here.
   */
  private async migrateLegacyCredentials(): Promise<void> {
    const legacy = SIWC_LEGACY_CREDENTIAL_KEYS;
    const triggers = await this.readCredentialStrings(
      legacy.clientId,
      legacy.refreshToken,
      legacy.userInfo,
    );
    if (
      !triggers[legacy.clientId]?.trim() &&
      !triggers[legacy.refreshToken]?.trim() &&
      !triggers[legacy.userInfo]?.trim()
    ) {
      return;
    }
    const migrate = () => this.withAccountsLock(() => this.migrateLegacyCredentialsLocked());
    // Same account-key formula the migration itself uses, so the refresh lock covers the exact
    // slot the copy would land in. Without a derivable key the migration is a no-op: keep the
    // accounts-lock-only path.
    const candidateSub =
      readUserJsonField(triggers[legacy.userInfo], "sub")?.trim() ||
      triggers[legacy.clientId]?.trim() ||
      "";
    if (!candidateSub) {
      await migrate();
      return;
    }
    await withFileLock(
      join(this.configDir, buildSiwcAccountRefreshLockFileName(createSiwcAccountKey(candidateSub))),
      migrate,
      { lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS },
    );
  }

  private async migrateLegacyCredentialsLocked(): Promise<void> {
    const legacy = SIWC_LEGACY_CREDENTIAL_KEYS;
    const flat = await this.readCredentialStrings(
      legacy.clientId,
      legacy.accessToken,
      legacy.refreshToken,
      legacy.idToken,
      legacy.userInfo,
      legacy.scopes,
      legacy.accessExpiresAt,
      legacy.earliestRefreshAt,
      legacy.providerIdentity,
      legacy.providerAuthSource,
    );
    if (!flat[legacy.clientId] && !flat[legacy.refreshToken] && !flat[legacy.userInfo]) return;
    const rawUser = flat[legacy.userInfo] ?? null;
    const sub = readUserJsonField(rawUser, "sub") ?? flat[legacy.clientId] ?? null;
    if (!sub) return;
    const accountKey = createSiwcAccountKey(sub);
    const keys = buildSiwcAccountCredentialKeys(accountKey);
    const mapping: ReadonlyArray<readonly [string | null, string]> = [
      [flat[legacy.clientId] ?? null, keys.clientId],
      [flat[legacy.accessToken] ?? null, keys.accessToken],
      [flat[legacy.refreshToken] ?? null, keys.refreshToken],
      [flat[legacy.idToken] ?? null, keys.idToken],
      [flat[legacy.userInfo] ?? null, keys.userInfo],
      [flat[legacy.scopes] ?? null, keys.scopes],
      [flat[legacy.accessExpiresAt] ?? null, keys.accessExpiresAt],
      [flat[legacy.earliestRefreshAt] ?? null, keys.earliestRefreshAt],
      [flat[legacy.providerIdentity] ?? null, buildSiwcAccountProviderIdentityKey(accountKey)],
      [flat[legacy.providerAuthSource] ?? null, buildSiwcAccountProviderAuthSourceKey(accountKey)],
    ];
    // Commit protocol (interruption-safe): copy the full legacy bundle into the slot, then
    // write the index record as the commit marker, then delete the legacy keys. An
    // interrupted migration (sequential saves can stop mid-bundle) leaves the index absent,
    // so the next attempt re-copies the same source values; a slot whose index record exists
    // was fully migrated or written by a later login/refresh — replaying consumed legacy
    // values over it would corrupt the token family, so only the stale legacy keys go.
    const indexed = (await this.readAccountIndex()).some(
      (record) => record.accountKey === accountKey,
    );
    if (!indexed) {
      const entries: Record<string, string> = {};
      for (const [value, key] of mapping) {
        if (value !== null) entries[key] = value;
      }
      if (Object.keys(entries).length > 0) await this.writeCredentials(entries);
      // Inline index write: the accounts lock is already held here, and upsertAccountRecord
      // would re-acquire it (file locks are not reentrant).
      const index = await this.readAccountIndex();
      if (!index.some((record) => record.accountKey === accountKey)) {
        await this.writeAccountIndex([
          ...index,
          {
            accountKey,
            sub,
            email: readUserJsonField(rawUser, "email"),
            name: readUserJsonField(rawUser, "name"),
            addedAt: new Date(this.now()).toISOString(),
          },
        ]);
      }
    }
    for (const key of [
      legacy.clientId,
      legacy.accessToken,
      legacy.refreshToken,
      legacy.idToken,
      legacy.userInfo,
      legacy.scopes,
      legacy.accessExpiresAt,
      legacy.earliestRefreshAt,
      legacy.providerIdentity,
      legacy.providerAuthSource,
    ]) {
      await this.credentialService.delete(key);
    }
  }
}

function isAccountRecord(value: unknown): value is SiwcStoredAccountRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SiwcStoredAccountRecord>;
  return (
    typeof candidate.accountKey === "string" &&
    isChatGptPlanAccountKey(candidate.accountKey) &&
    typeof candidate.sub === "string" &&
    candidate.sub.trim() !== ""
  );
}

interface SiwcTokenState {
  accessToken: string | null;
  clientId: string | null;
  refreshToken: string | null;
  accessExpiresAt: number | null;
}

function isAccessUsable(state: SiwcTokenState, nowMs: number): boolean {
  if (!state.accessToken) return false;
  if (state.accessExpiresAt === null) return true;
  return nowMs / 1000 < state.accessExpiresAt - SIWC_PROACTIVE_REFRESH_MARGIN_SECONDS;
}

function readEpoch(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toStoredUser(claims: SiwcIdTokenClaims): Record<string, string | null> {
  return {
    sub: claims.sub,
    email: claims.email ?? null,
    name: claims.name ?? null,
    picture: claims.picture ?? null,
  };
}

function toUserSummary(claims: SiwcIdTokenClaims): SiwcPlanUserSummary {
  return {
    subject: claims.sub,
    displayName: claims.name ?? claims.email ?? claims.sub,
    email: claims.email ?? null,
  };
}

function readUserJsonField(userInfoRaw: string | null | undefined, field: string): string | null {
  if (!userInfoRaw) return null;
  try {
    const parsed = JSON.parse(userInfoRaw) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

interface LoopbackHandle {
  callbackUrl: string;
  isSettled: () => boolean;
  server: Server;
  completion: Promise<SiwcLoginCompletion>;
}

/**
 * Minimal loopback listener (literal 127.0.0.1; SIWC rejects localhost): validates state,
 * answers the browser, and settles a completion promise with the code + issued client id.
 */
function listenForCallback(state: string): Promise<LoopbackHandle> {
  let settleCompletion: (
    completion: SiwcLoginCompletion | PromiseLike<SiwcLoginCompletion>,
  ) => void = () => undefined;
  let rejectCompletion: (reason: unknown) => void = () => undefined;
  let settled = false;
  const completion = new Promise<SiwcLoginCompletion>((resolve, reject) => {
    settleCompletion = resolve;
    rejectCompletion = reject;
  });

  const server = createServer((request, response) => {
    const respond = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(message);
    };
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== SIWC_CALLBACK_PATH) {
        respond(404, "Unknown callback path.");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        respond(400, "Authorization state mismatch.");
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        respond(400, "Authorization failed. You may close this window and return to the app.");
        if (!settled) {
          settled = true;
          rejectCompletion(
            new SiwcOAuthError({
              error: oauthError,
              ...(url.searchParams.get("error_description")
                ? { errorDescription: url.searchParams.get("error_description")! }
                : {}),
            }),
          );
        }
        return;
      }
      const code = url.searchParams.get("code")?.trim();
      if (!code) {
        respond(400, "Authorization callback is missing a code.");
        return;
      }
      respond(200, "Authorization successful! You may close this window and return to the app.");
      if (!settled) {
        settled = true;
        const issuedClientId = url.searchParams.get("client_id")?.trim() || undefined;
        settleCompletion({
          code,
          claims: EMPTY_CLAIMS,
          ...(issuedClientId ? { issuedClientId } : {}),
        });
      }
    } catch (error) {
      respond(500, "Authorization failed.");
      if (!settled) {
        settled = true;
        rejectCompletion(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  return new Promise<LoopbackHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to resolve the SIWC loopback callback address."));
        return;
      }
      resolve({
        callbackUrl: `http://127.0.0.1:${address.port}${SIWC_CALLBACK_PATH}`,
        isSettled: () => settled,
        server,
        completion,
      });
    });
  });
}

const EMPTY_CLAIMS: SiwcIdTokenClaims = { sub: "" };

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    // Stop accepting callbacks before dropping the browser's remaining keep-alive socket;
    // closeAllConnections alone leaves a window for another connection to be accepted.
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
