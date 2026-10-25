import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthCachedSessionRestoreResult,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import { toUserInfo } from "./zaiWebOAuthProvider.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ZAI_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
const ZAI_USER_INFO_KEY = "oauth:zai:user_info";
const BIGMODEL_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const BIGMODEL_USER_INFO_KEY = "oauth:bigmodel:user_info";
const OAUTH_PENDING_LOGINS_KEY = "oauth_pending_logins";
// Multiple tabs in the same browser can start logins at the same time; keep only the most recent few so abandoned logins do not pile up.
const MAX_PENDING_LOGINS = 5;

/** Login providers supported by this repository. Private share owner identity is provider-specific, so both providers must be able to sign in. */
export type WebOAuthProviderId = typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID;

export function isWebOAuthProviderId(value: unknown): value is WebOAuthProviderId {
  return value === ZAI_PROVIDER_ID || value === BIGMODEL_PROVIDER_ID;
}

/**
 * Each provider uses its own key segment.
 *
 * Do not reuse one "neutral" key set: zai's two keys already carry the /remote login state in production, and changing them would
 * sign out every logged-in user on release day. Adding a bigmodel prefix is risk-free and costs only one extra mapping.
 */
function providerKeys(provider: WebOAuthProviderId): { accessToken: string; userInfo: string } {
  return provider === BIGMODEL_PROVIDER_ID
    ? { accessToken: BIGMODEL_ACCESS_TOKEN_KEY, userInfo: BIGMODEL_USER_INFO_KEY }
    : { accessToken: ZAI_ACCESS_TOKEN_KEY, userInfo: ZAI_USER_INFO_KEY };
}

interface BrowserOAuthCredentialRepoStorage {
  localStorage: Storage;
}

/** One login redirect that left the app: the callback page uses it to validate state and exchange the token with the same provider and redirect URI. */
export interface PendingOAuthLogin {
  nonce: string;
  provider: WebOAuthProviderId;
  redirectUri: string;
}

function isPendingOAuthLogin(value: unknown): value is PendingOAuthLogin {
  if (!value || typeof value !== "object") return false;
  const login = value as Partial<Record<keyof PendingOAuthLogin, unknown>>;
  return (
    typeof login.nonce === "string" &&
    hasText(login.nonce) &&
    isWebOAuthProviderId(login.provider) &&
    typeof login.redirectUri === "string" &&
    hasText(login.redirectUri)
  );
}

interface BrowserOAuthCredentialRepoOptions {
  now?: () => number;
}

interface WebZaiTokenSet {
  zcodeJwtToken: string;
  zaiAccessToken: string;
  expiresAt?: number;
}

function getBrowserStorage(): BrowserOAuthCredentialRepoStorage {
  return { localStorage: window.localStorage };
}

function hasText(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Browser OAuth credential repository: centralizes localStorage reads and writes so auth-state checks do not spread across business logic. */
export class BrowserOAuthCredentialRepo {
  private readonly localStorage: Storage;
  private readonly now: () => number;

  constructor(
    storage: BrowserOAuthCredentialRepoStorage = getBrowserStorage(),
    options: BrowserOAuthCredentialRepoOptions = {},
  ) {
    this.localStorage = storage.localStorage;
    this.now = options.now ?? Date.now;
  }

  saveTokenSet(tokenSet: WebZaiTokenSet | OAuthTokenSet, provider: WebOAuthProviderId): void {
    const accessToken =
      "zaiAccessToken" in tokenSet ? tokenSet.zaiAccessToken : tokenSet.accessToken;
    const zcodeJwtToken = tokenSet.zcodeJwtToken;

    this.localStorage.setItem(providerKeys(provider).accessToken, accessToken);
    if (zcodeJwtToken) {
      this.localStorage.setItem(ZCODE_JWT_TOKEN_KEY, zcodeJwtToken);
    } else {
      this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    }
  }

  saveUserInfo(user: unknown, provider: WebOAuthProviderId): void {
    const rawUserInfo = JSON.stringify(user);
    this.localStorage.setItem(providerKeys(provider).userInfo, rawUserInfo);
  }

  setActiveProvider(provider: WebOAuthProviderId | null): void {
    if (!provider) {
      this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
      return;
    }

    this.localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
  }

  getActiveProvider(): OAuthProviderId | null {
    return this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
  }

  loadCachedSession(): UserInfo | null {
    const result = this.loadCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  /**
   * Read-only account display data (account row on the device page). This is not a login gate: it does not validate the JWT or clear partial credentials,
   * otherwise rendering the list could sign the user out early. Login state is still decided by loadCachedSessionState and the JWT.
   */
  loadActiveAccount(): { provider: WebOAuthProviderId; userInfo: UserInfo } | null {
    try {
      const provider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
      if (!isWebOAuthProviderId(provider)) return null;
      const rawUserInfo = this.localStorage.getItem(providerKeys(provider).userInfo);
      if (!hasText(rawUserInfo)) return null;
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      return userInfo ? { provider, userInfo } : null;
    } catch {
      return null;
    }
  }

  loadCachedSessionState(): OAuthCachedSessionRestoreResult {
    const activeProvider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
    const zcodeJwtToken = this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY);
    // Only one activeProvider exists at a time (switching providers means logging in again and overwriting it), so use it to select the key segment.
    const keys = isWebOAuthProviderId(activeProvider) ? providerKeys(activeProvider) : null;
    const accessToken = keys ? this.localStorage.getItem(keys.accessToken) : null;
    const rawUserInfo = keys ? this.localStorage.getItem(keys.userInfo) : null;

    if (!keys || !hasText(zcodeJwtToken) || !hasText(accessToken) || !hasText(rawUserInfo)) {
      if (this.hasAnyStoredCredential()) {
        this.clearAll();
      }
      return { status: "signed-out" };
    }

    if (resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      // Web localStorage previously checked only whether the JWT existed, which restored a fake logged-in state after expiry.
      this.clearAll();
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    try {
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      if (userInfo) {
        return { status: "authenticated", userInfo };
      }
    } catch {
      // localStorage may contain corrupt JSON left by an older version or by manual edits.
      // Treat it as signed out and clear the partial state, so the Web remote-control entry does not mistake it for a logged-in session and connect.
    }

    this.clearAll();
    return { status: "signed-out" };
  }

  loadZCodeJwtToken(): string | null {
    const session = this.loadCachedSessionState();
    if (session.status !== "authenticated") return null;
    return this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY)?.trim() || null;
  }

  private hasAnyStoredCredential(): boolean {
    return Boolean(
      this.localStorage.getItem(ACTIVE_PROVIDER_KEY) ||
      this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_USER_INFO_KEY) ||
      this.localStorage.getItem(BIGMODEL_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(BIGMODEL_USER_INFO_KEY),
    );
  }

  clearAll(): void {
    this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
    this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    // Clear both providers' key segments together: switching providers must not leave fragments of the previous identity,
    // otherwise loadCachedSessionState could read a half-complete credential set.
    this.localStorage.removeItem(ZAI_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(ZAI_USER_INFO_KEY);
    this.localStorage.removeItem(BIGMODEL_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(BIGMODEL_USER_INFO_KEY);
  }

  /**
   * Remember this login redirect, keyed by nonce.
   *
   * Fix: the nonce, provider and redirect URI used to live in the initiating page's sessionStorage. On some mobile browsers the OAuth
   * callback does not open in the tab that started the login, or that tab is rebuilt after the OS reclaims it. The callback page cannot read the nonce and fails with
   * "OAuth CSRF check failed" before the token exchange, and re-login fails the same way. Storing them in same-origin localStorage lets any tab in the same browser
   * complete the callback. The nonce is still random and single-use, so CSRF strength is unchanged.
   */
  savePendingLogin(login: PendingOAuthLogin): void {
    const logins = this.readPendingLogins().filter((pending) => pending.nonce !== login.nonce);
    this.writePendingLogins([...logins, login].slice(-MAX_PENDING_LOGINS));
  }

  /** Take and delete the login record for this nonce; if none matches, leave other tabs' records untouched. */
  takePendingLogin(nonce: string): PendingOAuthLogin | null {
    const logins = this.readPendingLogins();
    const login = logins.find((pending) => pending.nonce === nonce);
    if (!login) return null;
    this.writePendingLogins(logins.filter((pending) => pending !== login));
    return login;
  }

  private readPendingLogins(): PendingOAuthLogin[] {
    const raw = this.localStorage.getItem(OAUTH_PENDING_LOGINS_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isPendingOAuthLogin) : [];
    } catch {
      // A corrupt record must not be treated as this login; the next login attempt overwrites the whole value.
      return [];
    }
  }

  private writePendingLogins(logins: PendingOAuthLogin[]): void {
    if (logins.length > 0) {
      this.localStorage.setItem(OAUTH_PENDING_LOGINS_KEY, JSON.stringify(logins));
    } else {
      this.localStorage.removeItem(OAUTH_PENDING_LOGINS_KEY);
    }
  }
}
