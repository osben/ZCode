import {
  CHATGPT_PROVIDER_ID,
  SIWC_CALLBACK_PATH,
  buildSiwcAuthorizeUrl,
  clearSiwcTokenCredentials,
  createSiwcAccountKey,
  createSiwcJwksVerifier,
  createSiwcPkcePair,
  createSiwcState,
  createSiwcNonce,
  createSiwcTokenClient,
  createSharedZCodeCredentialStore,
  isSiwcPlanUsageEntitled,
  migrateLegacySiwcCredentials,
  openUrlInBrowser,
  parseSiwcScopes,
  removeSiwcAccountRecord,
  resolveSiwcHostId,
  upsertSiwcAccountRecord,
  createLocalhostOAuthCallbackServer,
  SiwcOAuthError,
  SiwcRevokeError,
  type BrowserOpenResult,
  type SharedZCodeCredentialStore,
  type SiwcIdTokenPayload,
  type SiwcTokenClient,
} from "@zcode/adapters";
import {
  buildChatGptPlanAccountProviderId,
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountProviderAuthSourceKey,
  buildSiwcAccountProviderIdentityKey,
  buildSiwcAccountRefreshLockFileName,
} from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { EnvRecord } from "@zcode/adapters/model";
import { ZCodeCliLoginError } from "./auth-login-contract.js";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";
import { resolveStandaloneChatGptPlanProvider } from "./app/standalone-account-provider-runtime.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const REVOKE_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export interface ChatGptPlanUser {
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  readonly picture?: string;
}

export interface LoginChatGptPlanOptions {
  readonly abortSignal?: AbortSignal;
  readonly credentialStore?: SharedZCodeCredentialStore;
  readonly env?: EnvRecord;
  /** Injectable fetch for the token/JWKS endpoints (tests); defaults to global fetch. */
  readonly fetchFn?: typeof globalThis.fetch;
  readonly noBrowser?: boolean;
  readonly now?: () => number;
  readonly onAuthorizeUrl?: (data: { readonly authorizeUrl: string }) => void | Promise<void>;
  readonly onBrowserOpen?: (result: BrowserOpenResult) => void | Promise<void>;
  readonly openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  readonly personalProviderConfigPath?: string;
  readonly timeoutMs?: number;
  readonly tokenClient?: SiwcTokenClient;
}

export interface LoginChatGptPlanResult {
  /** Slot key of the signed-in account (sha256(sub) prefix). */
  readonly accountKey: string;
  /** Per-account model provider id (`account:chatgpt-plan:<accountKey>`). */
  readonly accountProviderId: string;
  readonly browser?: BrowserOpenResult;
  readonly configPath: string;
  readonly credentialsPath: string;
  readonly model: string;
  /** False when consent lacked chatgpt.tokens.use.direct: identity-only sign-in, no inference. */
  readonly planUsageEntitled: boolean;
  readonly providerId: typeof CHATGPT_PROVIDER_ID;
  readonly user: ChatGptPlanUser;
}

export interface LogoutChatGptPlanOptions {
  readonly credentialStore?: SharedZCodeCredentialStore;
  readonly env?: EnvRecord;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly tokenClient?: SiwcTokenClient;
}

export interface LogoutChatGptPlanResult {
  /** Number of signed-in accounts the logout loop processed. */
  readonly accountCount: number;
  readonly credentialsPath: string;
  /** False when any revocation endpoint could not confirm; local tokens are cleared either way. */
  readonly revoked: boolean;
  readonly signedOut: boolean;
}

/**
 * Sign in with the ChatGPT plan via OpenAI's official SIWC program: loopback + PKCE OAuth
 * with dynamic client registration, JWKS-verified id token, and shared-credential
 * persistence. Independent of the zai/bigmodel polling login and of `zcodejwttoken`.
 */
export async function loginChatGptPlan(
  options: LoginChatGptPlanOptions = {},
): Promise<LoginChatGptPlanResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadlineMs = now() + timeoutMs;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  let timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
    const tokenClient =
      options.tokenClient ??
      createSiwcTokenClient(options.fetchFn ? { fetchFn: options.fetchFn } : {});
    const hostId = await resolveSiwcHostId({
      filePath: join(dirname(credentialStore.filePath), "siwc-host-id.txt"),
    });
    // Add-account semantics: migrate any legacy flat credentials, then authorize WITHOUT
    // id_token_hint/login_hint so OpenAI offers the account chooser. Whichever account the
    // browser returns is added (new sub) or re-authorized (known sub, slot fully rewritten).
    await migrateLegacySiwcCredentials(credentialStore);

    const pkce = createSiwcPkcePair();
    const state = createSiwcState();
    const nonce = createSiwcNonce();
    const callbackServer = await createLocalhostOAuthCallbackServer({
      callbackPath: SIWC_CALLBACK_PATH,
      state,
    });
    try {
      const authorizeUrl = buildSiwcAuthorizeUrl({
        redirectUri: callbackServer.callbackUrl,
        state,
        nonce,
        codeChallenge: pkce.codeChallenge,
        extAgentHostId: hostId.hostId,
      });
      await options.onAuthorizeUrl?.({ authorizeUrl });
      throwIfAborted(signal);
      const browser = options.noBrowser
        ? undefined
        : await (options.openBrowser ?? openUrlInBrowser)(authorizeUrl);
      if (browser) await options.onBrowserOpen?.(browser);

      const callback = await waitWithAbort(callbackServer.waitForCallback(), signal);
      // Add-account mode registers fresh, so the issued client id always comes from the
      // callback redirect.
      const clientId = callback.clientId?.trim();
      if (!clientId) {
        throw new ZCodeCliLoginError(
          "auth_failed",
          "ChatGPT plan sign-in did not issue a client id. Please retry login.",
        );
      }
      throwIfAborted(signal);

      const exchanged = await tokenClient.exchangeCode({
        clientId,
        code: callback.code,
        codeVerifier: pkce.codeVerifier,
        redirectUri: callbackServer.callbackUrl,
      });
      throwIfAborted(signal);

      const idToken = await verifyIdToken(options, tokenClient, exchanged.idToken, clientId, nonce);
      const scopes = parseSiwcScopes(exchanged.scope);
      const user: ChatGptPlanUser = {
        sub: idToken.sub,
        ...(idToken.email ? { email: idToken.email } : {}),
        ...(idToken.name ? { name: idToken.name } : {}),
        ...(idToken.picture ? { picture: idToken.picture } : {}),
      };
      const accountKey = createSiwcAccountKey(idToken.sub);
      const accountProviderId = buildChatGptPlanAccountProviderId(accountKey);
      const keys = buildSiwcAccountCredentialKeys(accountKey);
      try {
        // Slot replacement mirrors the host: under the per-account refresh lock (an in-flight
        // refresh of the previous registration must not interleave), and the previous
        // registration's optional token fields are DELETED when this exchange omits them —
        // a same-subject re-login can issue a new client id without a refresh token, and a
        // stale refresh token beside the new client id would send a mismatched pair.
        // The index upsert commits inside the same critical section so slot and index become
        // visible together: the migration takes the same lock order (refresh → accounts), and
        // an index record committed after the refresh lock was released could lose the race to it.
        await withFileLock(
          join(dirname(credentialStore.filePath), buildSiwcAccountRefreshLockFileName(accountKey)),
          async () => {
            const entries: Record<string, string> = {
              [keys.clientId]: clientId,
              [keys.accessToken]: exchanged.accessToken,
              ...(exchanged.refreshToken ? { [keys.refreshToken]: exchanged.refreshToken } : {}),
              ...(exchanged.idToken ? { [keys.idToken]: exchanged.idToken } : {}),
              [keys.userInfo]: JSON.stringify(user),
              ...(exchanged.scope ? { [keys.scopes]: exchanged.scope } : {}),
              [keys.accessExpiresAt]: String(
                Math.floor(now() / 1000) + (exchanged.expiresInSeconds ?? 3600),
              ),
              ...(exchanged.earliestRefreshAt !== undefined
                ? { [keys.earliestRefreshAt]: String(exchanged.earliestRefreshAt) }
                : {}),
              [buildSiwcAccountProviderIdentityKey(accountKey)]: idToken.sub,
              [buildSiwcAccountProviderAuthSourceKey(accountKey)]: "oauth",
            };
            await credentialStore.saveMany(entries);
            // Unwritten optional token fields are stale from the previous registration.
            for (const key of [keys.refreshToken, keys.idToken, keys.scopes, keys.earliestRefreshAt]) {
              if (entries[key] === undefined) await credentialStore.delete(key);
            }
            await upsertSiwcAccountRecord(credentialStore, {
              accountKey,
              sub: idToken.sub,
              email: user.email ?? null,
              name: user.name ?? null,
              addedAt: new Date(now()).toISOString(),
            });
          },
        );
      } catch (error) {
        throw new ZCodeCliLoginError(
          "credential_write_failed",
          "Login succeeded but writing credentials failed.",
          { cause: error },
        );
      }
      throwIfAborted(signal);
      let configPatch: { mainModel: string; path: string };
      try {
        configPatch = await persistStandaloneChatGptPlanConnection({
          accountProviderId,
          credentialStore,
          env,
          personalProviderConfigPath: options.personalProviderConfigPath,
        });
      } catch (error) {
        throw new ZCodeCliLoginError(
          "config_update_failed",
          "Login succeeded but updating ZCode config failed.",
          { cause: error },
        );
      }
      return {
        ...(browser ? { browser } : {}),
        accountKey,
        accountProviderId,
        configPath: configPatch.path,
        credentialsPath: credentialStore.filePath,
        model: configPatch.mainModel,
        /** False when consent lacked chatgpt.tokens.use.direct: identity-only sign-in, no inference. */
        planUsageEntitled: isSiwcPlanUsageEntitled(scopes),
        providerId: CHATGPT_PROVIDER_ID,
        user,
      };
    } finally {
      await callbackServer.close();
    }
  } catch (error) {
    if (error instanceof SiwcOAuthError) {
      throw new ZCodeCliLoginError(
        "auth_failed",
        `ChatGPT plan authorization failed: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Revoke every signed-in ChatGPT plan account (best effort with backoff), then clear each
 * account's local tokens. CLI logout is all-accounts by design: predictable and matching the
 * "logged out from the ChatGPT plan" command semantics. Each account's read → revoke →
 * clear → remove transaction holds that account's per-account refresh lock, so a concurrent
 * refresh or login cannot write a rotated token after the clear.
 */
export async function logoutChatGptPlan(
  options: LogoutChatGptPlanOptions = {},
): Promise<LogoutChatGptPlanResult> {
  const env = options.env ?? process.env;
  const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
  const tokenClient =
    options.tokenClient ??
    createSiwcTokenClient(options.fetchFn ? { fetchFn: options.fetchFn } : {});
  const accounts = await migrateLegacySiwcCredentials(credentialStore);
  if (accounts.length === 0) {
    return { accountCount: 0, credentialsPath: credentialStore.filePath, revoked: false, signedOut: false };
  }
  let allRevoked = true;
  let lastError: unknown;
  for (const account of accounts) {
    // Hold the account's per-account refresh lock across read → revoke → clear → remove: a
    // concurrent refresh or login must not write a rotated token after the clear (live
    // credentials after sign-out) or race the index removal. Index removal takes the accounts
    // lock nested, keeping the shared refresh → accounts order.
    await withFileLock(
      join(
        dirname(credentialStore.filePath),
        buildSiwcAccountRefreshLockFileName(account.accountKey),
      ),
      async () => {
        const keys = buildSiwcAccountCredentialKeys(account.accountKey);
        const current = await credentialStore.loadMany([keys.clientId, keys.refreshToken]);
        const clientId = current[keys.clientId]?.trim();
        const refreshToken = current[keys.refreshToken]?.trim();
        if (clientId && refreshToken) {
          let revoked = false;
          for (let attempt = 0; attempt <= REVOKE_RETRY_DELAYS_MS.length; attempt += 1) {
            if (attempt > 0) await delay(REVOKE_RETRY_DELAYS_MS[attempt - 1]!);
            try {
              await tokenClient.revoke({ clientId, refreshToken });
              revoked = true;
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;
              // Already-invalid tokens answer empty 200; 4xx means the token is gone for good.
              if (error instanceof SiwcRevokeError && (error.httpStatus ?? 0) < 500) break;
            }
          }
          if (!revoked) allRevoked = false;
        } else {
          // No revocation was attempted for an incomplete slot; the aggregate must not report
          // a successful revocation.
          allRevoked = false;
        }
        // Local tokens and the index record are cleared even when revocation could not be
        // confirmed; only the issued client id stays in the slot.
        await clearSiwcTokenCredentials(credentialStore, account.accountKey);
        await removeSiwcAccountRecord(credentialStore, account.accountKey);
      },
    );
  }
  if (!allRevoked && lastError !== undefined && env.ZCODE_DEBUG?.trim()) {
    console.warn(
      `ChatGPT plan token revocation could not be confirmed; local tokens were cleared. (${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`,
    );
  }
  return {
    accountCount: accounts.length,
    credentialsPath: credentialStore.filePath,
    revoked: allRevoked,
    signedOut: true,
  };
}

async function persistStandaloneChatGptPlanConnection(input: {
  readonly accountProviderId: string;
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
}): Promise<{ mainModel: string; path: string }> {
  const configured = await resolveStandaloneChatGptPlanProvider(input.env);
  const providerId = input.accountProviderId;
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({ personalRepository });
  try {
    await repository.saveConfiguredDefault({
      providerId,
      modelId: configured.modelId,
    });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return { mainModel: `${providerId}/${configured.modelId}`, path };
}

async function verifyIdToken(
  options: LoginChatGptPlanOptions,
  tokenClient: SiwcTokenClient,
  idToken: string | undefined,
  clientId: string,
  nonce: string,
): Promise<SiwcIdTokenPayload> {
  if (!idToken) {
    throw new ZCodeCliLoginError("auth_failed", "ChatGPT plan sign-in returned no id token.");
  }
  const verifier = createSiwcJwksVerifier(options.fetchFn ? { fetchFn: options.fetchFn } : {});
  try {
    return await verifier.verify(idToken, { audience: clientId, nonce });
  } catch (error) {
    throw new ZCodeCliLoginError(
      "auth_failed",
      `ChatGPT plan id token verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
