import { join } from "node:path";
import type { Server } from "node:http";
import type { SiwcPlanUsageSnapshot } from "@zcode/shared";
import { isChatGptPlanAccountKey } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { ICredentialService } from "../../credential/credential.js";
import { getAppConfigDir } from "../../paths.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import {
  createSiwcJwksVerifier,
  createSiwcPkcePair,
  createSiwcState,
  redactSiwcAuthorizeUrl,
  SiwcOAuthError,
} from "./siwcOAuth.js";
import {
  readEpoch,
  readUserJsonEmail,
  SIWC_CODEX_CALLBACK_PORT,
  SIWC_CODEX_CLIENT_ID,
  SIWC_CODEX_USAGE_URL,
  SIWC_CODEX_USER_AGENT,
  buildSiwcCodexCredentialKeys,
  buildSiwcCodexRefreshLockFileName,
  buildSiwcCodexAuthorizeUrl,
  createSiwcCodexTokenClient,
  readCodexAccountId,
  readCodexProfileEmail,
  readUsageSnapshotFromWhamPayload,
} from "./siwcCodexWire.js";
import { closeCodexLoopbackServer, listenForCodexCallback } from "./siwcCodexLoopback.js";

const log = createServiceLogger("siwcCodexUsage");

const SIWC_CODEX_LOGIN_TIMEOUT_MS = 5 * 60_000;
const SIWC_CODEX_REFRESH_LOCK_MAX_WAIT_MS = 45_000;
/** Proactive refresh margin: codex access tokens live ~10 days; refresh a day before expiry. */
const SIWC_CODEX_PROACTIVE_REFRESH_MARGIN_SECONDS = 24 * 60 * 60;
const USAGE_PROBE_THROTTLE_MS = 60_000;
const USAGE_PROBE_TIMEOUT_MS = 10_000;

export interface SiwcCodexUsageDependencies {
  /** Overrides the credential/config directory (tests); defaults to the app config dir. */
  configDir?: string;
  /** Loopback callback port (tests use an ephemeral port); production pins the codex port. */
  callbackPort?: number;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
}

interface PendingUsageLink {
  state: string;
  codeVerifier: string;
  accountKey: string;
  expectedEmail: string;
  isSettled: () => boolean;
  server: Server;
  callbackUrl: string;
  timeout: NodeJS.Timeout;
  completion: Promise<{ ok: true; value: { code: string } } | { ok: false; error: unknown }>;
}

/**
 * Per-account codex-flavor usage grants for the ChatGPT plan. Owns the explicit "Link usage"
 * flow (loopback listener on the registered codex callback shape), token persistence and
 * rotation under a per-account file lock, and the throttled `wham/usage` probe. Snapshots are
 * handed back through `onSnapshot`; the owner (SiwcAuthService) keeps them in memory. These
 * tokens never reach the inference path — SIWC remains the only model credential.
 */
export class SiwcCodexUsageService {
  private readonly configDir: string;
  private readonly callbackPort: number;
  private readonly now: () => number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly tokenClient: ReturnType<typeof createSiwcCodexTokenClient>;
  private readonly jwksVerifier: ReturnType<typeof createSiwcJwksVerifier>;
  private pending: PendingUsageLink | null = null;
  private readonly lastProbeAt = new Map<string, number>();

  constructor(
    private readonly credentialService: ICredentialService,
    private readonly dependencies: SiwcCodexUsageDependencies & {
      onSnapshot: (accountKey: string, snapshot: SiwcPlanUsageSnapshot) => void;
    },
  ) {
    this.configDir = dependencies.configDir ?? getAppConfigDir();
    this.callbackPort = dependencies.callbackPort ?? SIWC_CODEX_CALLBACK_PORT;
    this.now = dependencies.now ?? Date.now;
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis);
    // Built in the constructor body so the injected fetch wins over the global default.
    this.tokenClient = createSiwcCodexTokenClient({ fetchFn: this.fetchFn });
    this.jwksVerifier = createSiwcJwksVerifier({ fetchFn: this.fetchFn, now: this.now });
  }

  /** Whether the account has a linked codex-flavor usage grant (drives the settings row state). */
  async hasLinkedAccount(accountKey: string): Promise<boolean> {
    const keys = buildSiwcCodexCredentialKeys(accountKey);
    const stored = await this.readCredentialStrings(keys.accessToken, keys.refreshToken);
    return Boolean(stored[keys.accessToken] || stored[keys.refreshToken]);
  }

  /**
   * Start the "Link usage" grant for one signed-in account: loopback listener on the codex
   * callback shape + authorize URL prefilled with the slot's email. The UI opens the URL in the
   * system browser and polls `pollLink`.
   */
  async startLink(
    accountKey: string,
  ): Promise<{ authorizeUrl: string; displayAuthorizeUrl: string; state: string }> {
    await this.cancelLink();
    const normalized = accountKey.trim();
    if (!isChatGptPlanAccountKey(normalized)) {
      throw new SiwcOAuthError({
        error: "codex_usage_account_missing",
        errorDescription: "Usage link requires a signed-in ChatGPT plan account",
      });
    }
    const userInfoKey = `oauth:chatgpt:${normalized}:user_info`;
    const stored = await this.readCredentialStrings(userInfoKey);
    const rawUserInfo = stored[userInfoKey];
    if (!rawUserInfo) {
      throw new SiwcOAuthError({
        error: "codex_usage_account_missing",
        errorDescription: "Usage link requires a signed-in ChatGPT plan account",
      });
    }
    const email = readUserJsonEmail(rawUserInfo);
    if (!email) {
      throw new SiwcOAuthError({
        error: "codex_usage_account_missing",
        errorDescription: "The ChatGPT plan account has no email to bind the usage grant to",
      });
    }

    const pkce = createSiwcPkcePair();
    const state = createSiwcState();
    const loopback = await listenForCodexCallback(state, this.callbackPort);
    const authorizeUrl = buildSiwcCodexAuthorizeUrl({
      codeChallenge: pkce.codeChallenge,
      loginHint: email,
      redirectUri: loopback.callbackUrl,
      state,
    });
    this.pending = {
      state,
      codeVerifier: pkce.codeVerifier,
      accountKey: normalized,
      expectedEmail: email.toLowerCase(),
      isSettled: loopback.isSettled,
      server: loopback.server,
      callbackUrl: loopback.callbackUrl,
      timeout: setTimeout(() => void this.cancelLink(), SIWC_CODEX_LOGIN_TIMEOUT_MS),
      completion: loopback.completion.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    };
    return { authorizeUrl, displayAuthorizeUrl: redactSiwcAuthorizeUrl(authorizeUrl), state };
  }

  /** null while the browser has not returned; the linked account key once the grant settled. */
  async pollLink(): Promise<{ accountKey: string } | null> {
    const pending = this.pending;
    if (!pending) return null;
    if (!pending.isSettled()) return null;
    if (this.pending !== pending) return null;
    this.pending = null;
    clearTimeout(pending.timeout);
    try {
      const result = await pending.completion;
      if (!result.ok) throw result.error;
      const exchanged = await this.tokenClient.exchangeCode({
        code: result.value.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.callbackUrl,
      });
      if (!exchanged.idToken) {
        throw new SiwcOAuthError({
          error: "codex_usage_account_mismatch",
          errorDescription: "Codex usage grant returned no id token to verify the account",
        });
      }
      await this.jwksVerifier.verify(exchanged.idToken, { audience: SIWC_CODEX_CLIENT_ID });
      const email = readCodexProfileEmail(exchanged.idToken);
      if (!email || email.toLowerCase() !== pending.expectedEmail) {
        // Wrong account authorized for this slot: drop the partial grant so nothing half-linked
        // survives, and surface a structured error the UI can show.
        await this.clearAccount(pending.accountKey);
        throw new SiwcOAuthError({
          error: "codex_usage_account_mismatch",
          errorDescription:
            "A different ChatGPT account was authorized for usage. Retry and pick the account shown in settings.",
        });
      }
      const keys = buildSiwcCodexCredentialKeys(pending.accountKey);
      const accountId = readCodexAccountId(exchanged.idToken);
      const nowSeconds = Math.floor(this.now() / 1000);
      // Refresh rotation safety: persist the replacement refresh token before the access token.
      await this.writeCredentials({
        ...(exchanged.refreshToken ? { [keys.refreshToken]: exchanged.refreshToken } : {}),
        [keys.accessToken]: exchanged.accessToken,
        [keys.idToken]: exchanged.idToken,
        ...(accountId ? { [keys.accountId]: accountId } : {}),
        [keys.accessExpiresAt]: String(
          nowSeconds + (exchanged.expiresInSeconds ?? 10 * 24 * 60 * 60),
        ),
        ...(exchanged.earliestRefreshAt !== undefined
          ? { [keys.earliestRefreshAt]: String(exchanged.earliestRefreshAt) }
          : {}),
      });
      log.info("ChatGPT plan usage grant linked", { accountKey: pending.accountKey });
      // Probe right away so the next status read already carries usage data.
      this.lastProbeAt.delete(pending.accountKey);
      await this.probeAccount(pending.accountKey);
      return { accountKey: pending.accountKey };
    } finally {
      await closeCodexLoopbackServer(pending.server);
    }
  }

  async cancelLink(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timeout);
    await closeCodexLoopbackServer(pending.server);
  }

  /**
   * Probe every account that has a linked grant (called from status reads). Throttled per
   * account, failures silent: usage data is best-effort display state, never an error surface.
   */
  async probeAccounts(accountKeys: readonly string[]): Promise<void> {
    const now = this.now();
    await Promise.allSettled(
      accountKeys.flatMap((accountKey) => {
        const last = this.lastProbeAt.get(accountKey);
        if (last !== undefined && now - last < USAGE_PROBE_THROTTLE_MS) return [];
        this.lastProbeAt.set(accountKey, now);
        return [this.probeAccount(accountKey)];
      }),
    );
  }

  /** Best-effort revoke + clear one account's codex-flavor slot (logout / account mismatch). */
  async clearAccount(accountKey: string): Promise<void> {
    if (this.pending?.accountKey === accountKey) await this.cancelLink();
    const keys = buildSiwcCodexCredentialKeys(accountKey);
    const stored = await this.readCredentialStrings(keys.refreshToken);
    const refreshToken = stored[keys.refreshToken];
    if (refreshToken) {
      await this.tokenClient.revoke({ refreshToken });
    }
    for (const key of [
      keys.accessToken,
      keys.refreshToken,
      keys.idToken,
      keys.accountId,
      keys.accessExpiresAt,
      keys.earliestRefreshAt,
    ]) {
      await this.credentialService.delete(key);
    }
    this.lastProbeAt.delete(accountKey);
  }

  private async probeAccount(accountKey: string): Promise<void> {
    try {
      let accessToken = await this.ensureUsableAccessToken(accountKey);
      if (!accessToken) return;
      let payload = await this.fetchUsagePayload(accountKey, accessToken);
      if (payload === "unauthorized") {
        // One refresh + retry: a rejected-but-unexpired token (revocation on OpenAI's side)
        // must not permanently hide usage until the next proactive refresh window.
        accessToken = await this.refreshAccessToken(accountKey);
        if (!accessToken) return;
        payload = await this.fetchUsagePayload(accountKey, accessToken);
        if (payload === "unauthorized") return;
      }
      if (payload === null) return;
      const snapshot = readUsageSnapshotFromWhamPayload(payload);
      if (!snapshot) {
        log.debug("ChatGPT plan usage probe returned no usable windows", { accountKey });
        return;
      }
      this.dependencies.onSnapshot(accountKey, snapshot);
    } catch (error) {
      log.debug("ChatGPT plan usage probe failed", {
        accountKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** null = transport/payload failure (silent), "unauthorized" = one refresh+retry is allowed. */
  private async fetchUsagePayload(
    accountKey: string,
    accessToken: string,
  ): Promise<unknown | null | "unauthorized"> {
    const keys = buildSiwcCodexCredentialKeys(accountKey);
    const stored = await this.readCredentialStrings(keys.accountId);
    // Codex routes the probe by account/workspace id when known (personal accounts work without).
    const accountId = stored[keys.accountId];
    const response = await this.fetchFn(SIWC_CODEX_USAGE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "user-agent": SIWC_CODEX_USER_AGENT,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
      signal: AbortSignal.timeout(USAGE_PROBE_TIMEOUT_MS),
    });
    if (response.status === 401) return "unauthorized";
    if (!response.ok) {
      log.debug("ChatGPT plan usage probe request failed", { status: response.status });
      return null;
    }
    return (await response.json()) as unknown;
  }

  /** Returns a usable access token, refreshing proactively (24 h margin) when needed. */
  private async ensureUsableAccessToken(accountKey: string): Promise<string | null> {
    const keys = buildSiwcCodexCredentialKeys(accountKey);
    const stored = await this.readCredentialStrings(
      keys.accessToken,
      keys.refreshToken,
      keys.accessExpiresAt,
    );
    if (!stored[keys.refreshToken]) return null;
    const accessToken = stored[keys.accessToken];
    const expiresAt = readEpoch(stored[keys.accessExpiresAt] ?? null);
    const fresh =
      accessToken &&
      (expiresAt === null ||
        this.now() / 1000 < expiresAt - SIWC_CODEX_PROACTIVE_REFRESH_MARGIN_SECONDS);
    if (fresh && accessToken) return accessToken;
    return this.refreshAccessToken(accountKey);
  }

  /**
   * Cross-process single-flight refresh (the file lock also queues in-process callers).
   * Persists the rotated refresh token before the access token.
   */
  private async refreshAccessToken(accountKey: string): Promise<string | null> {
    return withFileLock(
      join(this.configDir, buildSiwcCodexRefreshLockFileName(accountKey)),
      async () => {
        const keys = buildSiwcCodexCredentialKeys(accountKey);
        const stored = await this.readCredentialStrings(keys.refreshToken);
        const refreshToken = stored[keys.refreshToken];
        if (!refreshToken) return null;
        const next = await this.tokenClient.refresh({ refreshToken });
        await this.writeCredentials({
          ...(next.refreshToken ? { [keys.refreshToken]: next.refreshToken } : {}),
          [keys.accessToken]: next.accessToken,
          ...(next.idToken ? { [keys.idToken]: next.idToken } : {}),
          [keys.accessExpiresAt]: String(
            Math.floor(this.now() / 1000) + (next.expiresInSeconds ?? 10 * 24 * 60 * 60),
          ),
          ...(next.earliestRefreshAt !== undefined
            ? { [keys.earliestRefreshAt]: String(next.earliestRefreshAt) }
            : {}),
        });
        return next.accessToken;
      },
      { lockMaxWaitMs: SIWC_CODEX_REFRESH_LOCK_MAX_WAIT_MS },
    );
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
}
