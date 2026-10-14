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
import { CHATGPT_OAUTH_PROVIDER_ID } from "@zcode/shared";
import {
  SIWC_CALLBACK_PATH,
  SIWC_CREDENTIAL_KEYS,
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

export interface SiwcPlanUserSummary {
  displayName: string;
  email: string | null;
  subject: string;
}

export interface SiwcPlanStatus {
  planUsageEntitled: boolean;
  signedIn: boolean;
  user: SiwcPlanUserSummary | null;
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
 * Independent of the zai/bigmodel pending-state machine: the loopback listener lives in the
 * host process, credentials use the same `oauth:chatgpt:*` keys as the CLI (one shared
 * store, one identity domain; `oauth:active_provider` and `zcodejwttoken` are never touched).
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
   * Start a login: loopback listener + PKCE + authorize URL. The UI opens the URL in the
   * system browser and polls `pollChatGptPlanLogin`. The returned URL is redacted for
   * display; the browser needs the full URL, so both variants are provided.
   */
  async startLogin(): Promise<{
    authorizeUrl: string;
    displayAuthorizeUrl: string;
    state: string;
  }> {
    await this.cancelLogin();
    const hostId = await resolveHostId(this.configDir);
    const stored = await this.readCredentialStrings(
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.idToken,
      SIWC_CREDENTIAL_KEYS.userInfo,
    );
    const issuedClientId = stored[SIWC_CREDENTIAL_KEYS.clientId] ?? undefined;
    const idTokenHint = stored[SIWC_CREDENTIAL_KEYS.idToken] ?? undefined;
    const loginHint = readLoginHint(stored[SIWC_CREDENTIAL_KEYS.userInfo]);

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
  async pollLogin(): Promise<null | (SiwcPlanStatus & { newUser: boolean })> {
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
      await this.persistLogin({
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
        entitled: isSiwcPlanUsageEntitled(scopes),
      });
      return {
        signedIn: true,
        planUsageEntitled: isSiwcPlanUsageEntitled(scopes),
        user: toUserSummary(claims),
        newUser: true,
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

  async getStatus(): Promise<SiwcPlanStatus> {
    const stored = await this.readCredentialStrings(
      SIWC_CREDENTIAL_KEYS.accessToken,
      SIWC_CREDENTIAL_KEYS.refreshToken,
      SIWC_CREDENTIAL_KEYS.scopes,
      SIWC_CREDENTIAL_KEYS.userInfo,
    );
    const accessToken = stored[SIWC_CREDENTIAL_KEYS.accessToken];
    const refreshToken = stored[SIWC_CREDENTIAL_KEYS.refreshToken];
    if (!accessToken && !refreshToken) {
      return { signedIn: false, planUsageEntitled: false, user: null };
    }
    return {
      signedIn: true,
      planUsageEntitled: isSiwcPlanUsageEntitled(
        parseSiwcScopes(stored[SIWC_CREDENTIAL_KEYS.scopes]),
      ),
      user: readUserSummary(stored[SIWC_CREDENTIAL_KEYS.userInfo]),
    };
  }

  /** Revoke (best effort with backoff), then clear local tokens; retains the client id. */
  async logout(): Promise<{ revoked: boolean; signedOut: boolean }> {
    const stored = await this.readCredentialStrings(
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.refreshToken,
    );
    const clientId = stored[SIWC_CREDENTIAL_KEYS.clientId];
    const refreshToken = stored[SIWC_CREDENTIAL_KEYS.refreshToken];
    if (!clientId || !refreshToken) {
      return { revoked: false, signedOut: false };
    }
    const tokenClient = createSiwcTokenClient({ fetchFn: this.fetchFn });
    let revoked = false;
    for (let attempt = 0; attempt <= REVOKE_RETRY_DELAYS_MS.length && !revoked; attempt += 1) {
      try {
        await tokenClient.revoke({ clientId, refreshToken });
        revoked = true;
      } catch (error) {
        if (error instanceof SiwcRevokeError && (error.httpStatus ?? 0) < 500) break;
        if (attempt < REVOKE_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) => setTimeout(resolve, REVOKE_RETRY_DELAYS_MS[attempt]));
        }
      }
    }
    await this.clearTokenCredentials();
    log.info("ChatGPT plan signed out", { revoked });
    return { revoked, signedOut: true };
  }

  /**
   * Resolve a request-time access token (host answer for provider runtime headers):
   * proactive refresh before expiry, cross-process single-flight via the SAME lock file the
   * CLI resolver uses, rotation-aware persistence, terminal failures clear tokens.
   */
  async resolveAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const existing = this.inFlightToken.get(CHATGPT_OAUTH_PROVIDER_ID);
    if (existing) return (await existing).accessToken;
    const pending = this.resolveAccessTokenLocked(options.forceRefresh === true).finally(() =>
      this.inFlightToken.delete(CHATGPT_OAUTH_PROVIDER_ID),
    );
    this.inFlightToken.set(CHATGPT_OAUTH_PROVIDER_ID, pending);
    return (await pending).accessToken;
  }

  /**
   * Stable account-scope fingerprint (account-switch detection), identical to the CLI
   * resolver: hashes the issued client id and account subject, never the rotating token.
   */
  async resolveAccountScope(): Promise<string> {
    const stored = await this.readCredentialStrings(
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.userInfo,
    );
    const clientId = stored[SIWC_CREDENTIAL_KEYS.clientId] ?? "";
    let subject = clientId;
    const rawUser = stored[SIWC_CREDENTIAL_KEYS.userInfo];
    if (rawUser) {
      try {
        const parsed = JSON.parse(rawUser) as { sub?: unknown };
        if (typeof parsed.sub === "string" && parsed.sub.trim()) subject = parsed.sub.trim();
      } catch {
        // Fall back to the client id for the fingerprint input.
      }
    }
    return createHash("sha256") // codeql[js/insufficient-password-hash]
      .update(JSON.stringify([CHATGPT_OAUTH_PROVIDER_ID, "chatgpt", clientId, subject]))
      .digest("hex");
  }

  private async resolveAccessTokenLocked(forceRefresh: boolean): Promise<{ accessToken: string }> {
    let state = await this.readTokenState();
    if (!state.accessToken && !state.refreshToken) {
      throw new Error("ChatGPT plan credentials are missing; sign in in Settings.");
    }
    if (!forceRefresh && state.accessToken && isAccessUsable(state, this.now())) {
      return { accessToken: state.accessToken };
    }
    state = await this.refreshUnderLock(state);
    if (!state.accessToken || !isAccessUsable(state, this.now())) {
      throw new Error("ChatGPT plan token refresh did not produce a usable token; sign in again.");
    }
    return { accessToken: state.accessToken };
  }

  private async refreshUnderLock(observed: SiwcTokenState): Promise<SiwcTokenState> {
    // Same lock file as the CLI resolver: Desktop and CLI refreshes must serialize or the
    // rotation reuse detector revokes the token family.
    const lockPath = join(this.configDir, "siwc-chatgpt.refresh");
    try {
      return await withFileLock(lockPath, () => this.refreshLocked(observed), {
        lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS,
      });
    } catch (error) {
      if (!isZCodeFileLockTimeoutError(error)) throw error;
      const current = await this.readTokenState();
      if (current.accessToken && isAccessUsable(current, this.now())) return current;
      throw error;
    }
  }

  private async refreshLocked(observed: SiwcTokenState): Promise<SiwcTokenState> {
    const current = await this.readTokenState();
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
        ...(response.refreshToken
          ? { [SIWC_CREDENTIAL_KEYS.refreshToken]: response.refreshToken }
          : {}),
        [SIWC_CREDENTIAL_KEYS.accessToken]: response.accessToken,
        ...(response.idToken ? { [SIWC_CREDENTIAL_KEYS.idToken]: response.idToken } : {}),
        ...(response.scope ? { [SIWC_CREDENTIAL_KEYS.scopes]: response.scope } : {}),
        [SIWC_CREDENTIAL_KEYS.accessExpiresAt]: String(
          Math.floor(this.now() / 1000) + (response.expiresInSeconds ?? 3600),
        ),
        ...(response.earliestRefreshAt !== undefined
          ? { [SIWC_CREDENTIAL_KEYS.earliestRefreshAt]: String(response.earliestRefreshAt) }
          : {}),
      });
      const after = await this.readTokenState();
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
        await this.clearTokenCredentials();
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
  }): Promise<void> {
    await this.writeCredentials({
      [SIWC_CREDENTIAL_KEYS.clientId]: input.clientId,
      [SIWC_CREDENTIAL_KEYS.accessToken]: input.exchanged.accessToken,
      ...(input.exchanged.refreshToken
        ? { [SIWC_CREDENTIAL_KEYS.refreshToken]: input.exchanged.refreshToken }
        : {}),
      ...(input.exchanged.idToken
        ? { [SIWC_CREDENTIAL_KEYS.idToken]: input.exchanged.idToken }
        : {}),
      [SIWC_CREDENTIAL_KEYS.userInfo]: JSON.stringify(toStoredUser(input.claims)),
      ...(input.exchanged.scopes ? { [SIWC_CREDENTIAL_KEYS.scopes]: input.exchanged.scopes } : {}),
      [SIWC_CREDENTIAL_KEYS.accessExpiresAt]: String(input.exchanged.accessExpiresAt),
      ...(input.exchanged.earliestRefreshAt !== undefined
        ? { [SIWC_CREDENTIAL_KEYS.earliestRefreshAt]: String(input.exchanged.earliestRefreshAt) }
        : {}),
      [`account-provider:account:chatgpt-plan:identity`]: input.claims.sub,
      [`account-provider:account:chatgpt-plan:auth-source`]: "oauth",
    });
  }

  private async clearTokenCredentials(): Promise<void> {
    for (const key of [
      SIWC_CREDENTIAL_KEYS.accessToken,
      SIWC_CREDENTIAL_KEYS.refreshToken,
      SIWC_CREDENTIAL_KEYS.idToken,
      SIWC_CREDENTIAL_KEYS.scopes,
      SIWC_CREDENTIAL_KEYS.accessExpiresAt,
      SIWC_CREDENTIAL_KEYS.earliestRefreshAt,
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

  private async readTokenState(): Promise<SiwcTokenState> {
    const stored = await this.readCredentialStrings(
      SIWC_CREDENTIAL_KEYS.accessToken,
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.refreshToken,
      SIWC_CREDENTIAL_KEYS.accessExpiresAt,
    );
    return {
      accessToken: stored[SIWC_CREDENTIAL_KEYS.accessToken] ?? null,
      clientId: stored[SIWC_CREDENTIAL_KEYS.clientId] ?? null,
      refreshToken: stored[SIWC_CREDENTIAL_KEYS.refreshToken] ?? null,
      accessExpiresAt: readEpoch(stored[SIWC_CREDENTIAL_KEYS.accessExpiresAt] ?? null),
    };
  }
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

function readUserSummary(raw: string | null | undefined): SiwcPlanUserSummary | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { sub?: unknown; name?: unknown; email?: unknown };
    if (typeof parsed.sub !== "string" || !parsed.sub.trim()) return null;
    return {
      subject: parsed.sub,
      displayName:
        (typeof parsed.name === "string" && parsed.name.trim()) ||
        (typeof parsed.email === "string" && parsed.email) ||
        parsed.sub,
      email: typeof parsed.email === "string" ? parsed.email : null,
    };
  } catch {
    return null;
  }
}

function readLoginHint(userInfoRaw: string | null | undefined): string | undefined {
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
    // The system browser keeps its keep-alive socket to the loopback open after the
    // success page; a bare close() waits it out (observed ~11s) and delays the login
    // completion returned to the UI. The response is already flushed, so dropping the
    // remaining connections immediately is safe for this one-shot server.
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
