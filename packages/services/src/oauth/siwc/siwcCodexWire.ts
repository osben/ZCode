import type { SiwcPlanUsageSnapshot, SiwcPlanUsageWindow } from "@zcode/shared";
import { isChatGptPlanAccountKey } from "@zcode/shared";
import { SiwcOAuthError } from "./siwcOAuth.js";

/**
 * Pure wire surface of the codex-flavor usage grant: pinned constants, credential key
 * builders, the authorize/token/revoke requests, and the wham/usage payload mapping. The
 * endpoint is a first-party ChatGPT backend route used by the open-source Codex client
 * (codex-rs `backend-client`), not a documented public API — treat every field as versioned
 * and optional (spec: chatgpt-plan-signin.md, "Usage probe").
 */

export const SIWC_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const SIWC_CODEX_AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
export const SIWC_CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const SIWC_CODEX_REVOKE_ENDPOINT = "https://auth.openai.com/oauth/revoke";
export const SIWC_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const SIWC_CODEX_CALLBACK_PATH = "/auth/callback";
/** Byte-identical to the Codex CLI loopback redirect: the shape registered for this client. */
export const SIWC_CODEX_CALLBACK_PORT = 1455;
const SIWC_CODEX_SCOPES = "openid profile email offline_access";
/** The codex client's user agent; wham/usage sits behind Cloudflare and rejects bare clients. */
export const SIWC_CODEX_USER_AGENT = "codex_cli_rs";
/** Bounded token/revoke requests: a stalled auth.openai.com must not hang status reads or logout. */
const SIWC_CODEX_REQUEST_TIMEOUT_MS = 15_000;

/** Per-account codex-flavor credential keys in the shared credential store. */
export interface SiwcCodexCredentialKeys {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  accessExpiresAt: string;
  earliestRefreshAt: string;
}

function requireValidAccountKey(accountKey: string): string {
  const normalized = accountKey.trim();
  if (!isChatGptPlanAccountKey(normalized)) {
    throw new Error(`Invalid ChatGPT plan account key: ${normalized}`);
  }
  return normalized;
}

/** Build the per-account codex-flavor credential key set (`oauth:chatgpt-codex:<accountKey>:*`). */
export function buildSiwcCodexCredentialKeys(accountKey: string): SiwcCodexCredentialKeys {
  const key = requireValidAccountKey(accountKey);
  return {
    accessToken: `oauth:chatgpt-codex:${key}:access_token`,
    refreshToken: `oauth:chatgpt-codex:${key}:refresh_token`,
    idToken: `oauth:chatgpt-codex:${key}:id_token`,
    accountId: `oauth:chatgpt-codex:${key}:account_id`,
    accessExpiresAt: `oauth:chatgpt-codex:${key}:access_expires_at`,
    earliestRefreshAt: `oauth:chatgpt-codex:${key}:earliest_refresh_at`,
  };
}

/** Cross-process refresh lock file name of one account's codex-flavor grant. */
export function buildSiwcCodexRefreshLockFileName(accountKey: string): string {
  return `siwc-chatgpt-codex.${requireValidAccountKey(accountKey)}.refresh`;
}

export function buildSiwcCodexAuthorizeUrl(input: {
  codeChallenge: string;
  loginHint?: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(SIWC_CODEX_AUTHORIZE_ENDPOINT);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", SIWC_CODEX_CLIENT_ID);
  params.set("redirect_uri", input.redirectUri);
  params.set("scope", SIWC_CODEX_SCOPES);
  params.set("code_challenge", input.codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("state", input.state);
  // Codex CLI client params; `prompt=login` is REQUIRED for multi-account safety: the Auth0
  // backend keys sessions per browser login, and a silent second grant can invalidate the
  // previous account's refresh-token family ("session takeover").
  params.set("id_token_add_organizations", "true");
  params.set("codex_cli_simplified_flow", "true");
  params.set("originator", "codex_cli_rs");
  params.set("prompt", "login");
  if (input.loginHint?.trim()) params.set("login_hint", input.loginHint.trim());
  return url.toString();
}

export interface SiwcCodexTokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresInSeconds?: number;
  earliestRefreshAt?: number;
}

export function createSiwcCodexTokenClient(options: { fetchFn?: typeof globalThis.fetch } = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  async function tokenRequest(body: Record<string, string>): Promise<SiwcCodexTokenSet> {
    const response = await fetchFn(SIWC_CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(SIWC_CODEX_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SiwcOAuthError({
        error: "codex_token_request_failed",
        errorDescription: `Codex token request failed with HTTP ${response.status}`,
        httpStatus: response.status,
        cause: detail ? new Error(detail) : undefined,
      });
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = payload["access_token"];
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new SiwcOAuthError({
        error: "codex_token_request_failed",
        errorDescription: "Codex token response carried no access token",
        httpStatus: response.status,
      });
    }
    return {
      accessToken,
      ...(typeof payload["refresh_token"] === "string" && payload["refresh_token"]
        ? { refreshToken: payload["refresh_token"] }
        : {}),
      ...(typeof payload["id_token"] === "string" && payload["id_token"]
        ? { idToken: payload["id_token"] }
        : {}),
      ...(typeof payload["expires_in"] === "number"
        ? { expiresInSeconds: payload["expires_in"] }
        : {}),
      ...(typeof payload["earliest_refresh_at"] === "number"
        ? { earliestRefreshAt: payload["earliest_refresh_at"] }
        : {}),
    };
  }

  return {
    exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
      return tokenRequest({
        grant_type: "authorization_code",
        client_id: SIWC_CODEX_CLIENT_ID,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      });
    },
    refresh(input: { refreshToken: string }) {
      return tokenRequest({
        grant_type: "refresh_token",
        client_id: SIWC_CODEX_CLIENT_ID,
        refresh_token: input.refreshToken,
      });
    },
    async revoke(input: { refreshToken: string }): Promise<boolean> {
      // The classic OAuth revocation endpoint is not part of any pinned codex contract;
      // best effort only — local clearing proceeds regardless of the outcome.
      try {
        const response = await fetchFn(SIWC_CODEX_REVOKE_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: input.refreshToken,
            token_type_hint: "refresh_token",
            client_id: SIWC_CODEX_CLIENT_ID,
          }).toString(),
          signal: AbortSignal.timeout(SIWC_CODEX_REQUEST_TIMEOUT_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  const segments = idToken.split(".");
  if (segments.length !== 3 || !segments[1]) return null;
  try {
    return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Read the account email from a codex id token. The codex flavor carries it under the
 * namespaced profile claim (plain `email` is the fallback); both are checked because the
 * claim shape is not part of a pinned contract.
 */
export function readCodexProfileEmail(idToken: string): string | null {
  const claims = decodeIdTokenPayload(idToken);
  if (!claims) return null;
  const profile = claims["https://api.openai.com/profile"];
  if (profile && typeof profile === "object" && "email" in profile) {
    const email = (profile as Record<string, unknown>)["email"];
    if (typeof email === "string" && email.trim()) return email.trim();
  }
  if (typeof claims["email"] === "string" && claims["email"].trim()) {
    return claims["email"];
  }
  return null;
}

/**
 * Read the ChatGPT account/workspace id used for backend routing (the `ChatGPT-Account-ID`
 * request header). Present in the auth claim of codex id tokens; optional.
 */
export function readCodexAccountId(idToken: string): string | null {
  const claims = decodeIdTokenPayload(idToken);
  if (!claims) return null;
  const auth = claims["chatgpt_account_id"];
  if (typeof auth === "string" && auth.trim()) return auth.trim();
  const namespaced = claims["https://api.openai.com/auth"];
  if (namespaced && typeof namespaced === "object") {
    const accountId = (namespaced as Record<string, unknown>)["chatgpt_account_id"];
    if (typeof accountId === "string" && accountId.trim()) return accountId.trim();
  }
  return null;
}

/**
 * Parse one wham/usage window; mirrors the header-capture tolerance rules. `reset_after_seconds`
 * stands in for a missing `reset_at`, counted from the capture time.
 */
function readUsageWindow(value: unknown, capturedAtMs: number): SiwcPlanUsageWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const window = value as Record<string, unknown>;
  const usedPercent = window["used_percent"];
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  if (usedPercent < 0 || usedPercent > 100) return undefined;
  const windowSeconds = readPositiveInt(window["limit_window_seconds"]);
  const resetAfterSeconds = readPositiveInt(window["reset_after_seconds"]);
  const resetAtSeconds =
    readPositiveInt(window["reset_at"]) ??
    (resetAfterSeconds !== undefined
      ? Math.round(capturedAtMs / 1000) + resetAfterSeconds
      : undefined);
  return {
    usedPercent,
    ...(windowSeconds !== undefined ? { windowMinutes: Math.round(windowSeconds / 60) } : {}),
    ...(resetAtSeconds !== undefined
      ? { resetsAt: new Date(resetAtSeconds * 1000).toISOString() }
      : {}),
  };
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** Map a wham/usage payload to the shared snapshot; the primary (5h) window is required. */
export function readUsageSnapshotFromWhamPayload(
  payload: unknown,
  capturedAtMs: number = Date.now(),
): SiwcPlanUsageSnapshot | null {
  if (typeof payload !== "object" || payload === null) return null;
  const rateLimit = (payload as Record<string, unknown>)["rate_limit"];
  if (typeof rateLimit !== "object" || rateLimit === null) return null;
  const windows = rateLimit as Record<string, unknown>;
  const primary = readUsageWindow(windows["primary_window"], capturedAtMs);
  if (!primary) return null;
  const secondary = readUsageWindow(windows["secondary_window"], capturedAtMs);
  const planType = (payload as Record<string, unknown>)["plan_type"];
  const limitReached = windows["limit_reached"];
  return {
    primary,
    ...(secondary ? { secondary } : {}),
    ...(typeof planType === "string" && planType.trim() ? { planType: planType.trim() } : {}),
    ...(typeof limitReached === "boolean" ? { limitReached } : {}),
  };
}

export function readUserJsonEmail(rawUserInfo: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawUserInfo);
    if (typeof parsed !== "object" || parsed === null) return null;
    const email = (parsed as Record<string, unknown>)["email"];
    return typeof email === "string" && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

export function readEpoch(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
