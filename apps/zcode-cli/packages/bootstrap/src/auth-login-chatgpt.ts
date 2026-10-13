import {
  CHATGPT_PROVIDER_ID,
  SIWC_CALLBACK_PATH,
  buildSiwcAuthorizeUrl,
  clearSiwcTokenCredentials,
  createSiwcJwksVerifier,
  createSiwcPkcePair,
  createSiwcState,
  createSiwcNonce,
  createSiwcTokenClient,
  createSharedZCodeCredentialStore,
  isSiwcPlanUsageEntitled,
  openUrlInBrowser,
  parseSiwcScopes,
  resolveSiwcHostId,
  SIWC_CREDENTIAL_KEYS,
  createLocalhostOAuthCallbackServer,
  SiwcOAuthError,
  SiwcRevokeError,
  type BrowserOpenResult,
  type SharedZCodeCredentialStore,
  type SiwcIdTokenPayload,
  type SiwcTokenClient,
} from "@zcode/adapters";
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
import {
  CHATGPT_PLAN_PROVIDER_ID,
  resolveStandaloneChatGptPlanProvider,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountIdentityCredentialKey,
} from "./app/standalone-account-provider-runtime.js";

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
  readonly credentialsPath: string;
  /** False when the revocation endpoint could not confirm; local tokens are cleared either way. */
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
    const hostId = await resolveSiwcHostId({ env });
    const previous = await credentialStore.loadMany([
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.idToken,
      SIWC_CREDENTIAL_KEYS.userInfo,
    ]);
    const issuedClientId = previous[SIWC_CREDENTIAL_KEYS.clientId]?.trim() || undefined;
    const idTokenHint = previous[SIWC_CREDENTIAL_KEYS.idToken]?.trim() || undefined;
    const loginHint = readLoginHint(previous[SIWC_CREDENTIAL_KEYS.userInfo]);

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
        ...(issuedClientId ? { issuedClientId, idTokenHint, loginHint } : {}),
      });
      await options.onAuthorizeUrl?.({ authorizeUrl });
      throwIfAborted(signal);
      const browser = options.noBrowser
        ? undefined
        : await (options.openBrowser ?? openUrlInBrowser)(authorizeUrl);
      if (browser) await options.onBrowserOpen?.(browser);

      const callback = await waitWithAbort(callbackServer.waitForCallback(), signal);
      const callbackClientId = callback.clientId?.trim() || undefined;
      const clientId = resolveEffectiveClientId(issuedClientId, callbackClientId);
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
      try {
        await credentialStore.saveMany({
          [SIWC_CREDENTIAL_KEYS.clientId]: clientId,
          [SIWC_CREDENTIAL_KEYS.accessToken]: exchanged.accessToken,
          ...(exchanged.refreshToken
            ? { [SIWC_CREDENTIAL_KEYS.refreshToken]: exchanged.refreshToken }
            : {}),
          ...(exchanged.idToken ? { [SIWC_CREDENTIAL_KEYS.idToken]: exchanged.idToken } : {}),
          [SIWC_CREDENTIAL_KEYS.userInfo]: JSON.stringify(user),
          ...(exchanged.scope ? { [SIWC_CREDENTIAL_KEYS.scopes]: exchanged.scope } : {}),
          [SIWC_CREDENTIAL_KEYS.accessExpiresAt]: String(
            Math.floor(now() / 1000) + (exchanged.expiresInSeconds ?? 3600),
          ),
          ...(exchanged.earliestRefreshAt !== undefined
            ? { [SIWC_CREDENTIAL_KEYS.earliestRefreshAt]: String(exchanged.earliestRefreshAt) }
            : {}),
          [standaloneAccountIdentityCredentialKey(CHATGPT_PLAN_PROVIDER_ID)]: idToken.sub,
          [standaloneAccountAuthSourceCredentialKey(CHATGPT_PLAN_PROVIDER_ID)]: "oauth",
        });
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
          accountIdentity: idToken.sub,
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
        configPath: configPatch.path,
        credentialsPath: credentialStore.filePath,
        model: configPatch.mainModel,
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

/** Revoke the refresh token (best effort with backoff), then clear local SIWC tokens. */
export async function logoutChatGptPlan(
  options: LogoutChatGptPlanOptions = {},
): Promise<LogoutChatGptPlanResult> {
  const env = options.env ?? process.env;
  const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
  const tokenClient =
    options.tokenClient ??
    createSiwcTokenClient(options.fetchFn ? { fetchFn: options.fetchFn } : {});
  const current = await credentialStore.loadMany([
    SIWC_CREDENTIAL_KEYS.clientId,
    SIWC_CREDENTIAL_KEYS.refreshToken,
  ]);
  const clientId = current[SIWC_CREDENTIAL_KEYS.clientId]?.trim();
  const refreshToken = current[SIWC_CREDENTIAL_KEYS.refreshToken]?.trim();
  if (!clientId || !refreshToken) {
    return { credentialsPath: credentialStore.filePath, revoked: false, signedOut: false };
  }
  let revoked = false;
  let lastError: unknown;
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
  // Local tokens are cleared even when revocation could not be confirmed; the client id and
  // account mapping are retained so a future sign-in reuses the registered client.
  await clearSiwcTokenCredentials(credentialStore);
  if (!revoked && lastError !== undefined && env.ZCODE_DEBUG?.trim()) {
    console.warn(
      `ChatGPT plan token revocation could not be confirmed; local tokens were cleared. (${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`,
    );
  }
  return { credentialsPath: credentialStore.filePath, revoked, signedOut: true };
}

async function persistStandaloneChatGptPlanConnection(input: {
  readonly accountIdentity: string;
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
}): Promise<{ mainModel: string; path: string }> {
  const configured = await resolveStandaloneChatGptPlanProvider(input.env);
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
      providerId: configured.providerId,
      modelId: configured.modelId,
    });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return { mainModel: `${configured.providerId}/${configured.modelId}`, path };
}

function readLoginHint(userInfoRaw: string | null): string | undefined {
  if (!userInfoRaw) return undefined;
  try {
    const parsed = JSON.parse(userInfoRaw) as { email?: unknown };
    return typeof parsed.email === "string" && parsed.email.trim()
      ? parsed.email.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveEffectiveClientId(
  issuedClientId: string | undefined,
  callbackClientId: string | undefined,
): string {
  if (issuedClientId && callbackClientId && issuedClientId !== callbackClientId) {
    // A different client id on a re-auth callback means the registration was replaced; keeping
    // the stale one would break exchange and refresh.
    throw new ZCodeCliLoginError(
      "auth_failed",
      "ChatGPT plan returned an unexpected client id. Please retry login.",
    );
  }
  const clientId = callbackClientId ?? issuedClientId;
  if (!clientId) {
    throw new ZCodeCliLoginError(
      "auth_failed",
      "ChatGPT plan sign-in did not issue a client id. Please retry login.",
    );
  }
  return clientId;
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
