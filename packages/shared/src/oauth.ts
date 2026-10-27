/**
 * OAuth domain type definitions.
 *
 * Sensitive information (such as appSecret) and provider default endpoint configuration
 * belong only in the provider modules under services, never in the shared layer.
 */
import {
  buildChatGptPlanAccountProviderId,
  isChatGptPlanAccountKey,
} from "./model-provider-types.js";

/** Built-in BigModel provider ID. */
export const BIGMODEL_PROVIDER_ID = "bigmodel" as const;

/** Built-in ZAI provider ID. */
export const ZAI_PROVIDER_ID = "zai" as const;

/** Credential decryption failure error prefix. */
export const CREDENTIAL_DECRYPT_ERROR_PREFIX = "凭据解密失败：" as const;

/** Stable error code for credential decryption failures. */
export const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED" as const;

/** Whether the error represents a local credential decryption failure. */
export function isCredentialDecryptError(error: unknown): boolean {
  const code = readCredentialErrorCode(error);
  if (code) {
    return code === CREDENTIAL_DECRYPT_ERROR_CODE;
  }

  // Support legacy errors and old payloads that lost their code across a boundary; new errors should carry the stable code.
  if (readCredentialErrorMessage(error).startsWith(CREDENTIAL_DECRYPT_ERROR_PREFIX)) {
    return true;
  }

  return false;
}

function readCredentialErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code ?? "");
  }

  return "";
}

function readCredentialErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return "";
}

/** ChatGPT plan (official OpenAI SIWC) OAuth provider ID; an independent identity domain. */
export const CHATGPT_OAUTH_PROVIDER_ID = "chatgpt" as const;

/** OAuth provider identifier. */
export type OAuthProviderId =
  | typeof BIGMODEL_PROVIDER_ID
  | typeof CHATGPT_OAUTH_PROVIDER_ID
  | typeof ZAI_PROVIDER_ID
  | (string & { readonly __oauthProviderBrand?: never });

/** Provider display metadata. */
export interface OAuthProviderMeta {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
}

/** OAuth start request. */
export interface OAuthStartRequest {
  provider: OAuthProviderId;
}

/** OAuth start response. */
export interface OAuthStartResponse {
  provider: OAuthProviderId;
  authorizeUrl: string;
  state: string;
}

/** Application login callback result. */
export interface OAuthSessionCallbackResult {
  kind: "session";
  provider: OAuthProviderId;
  userInfo: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
}

/** OAuth deep-link callback result carrying attribution parameters only. */
export interface OAuthAttributionCallbackResult {
  kind: "attribution";
  provider: OAuthProviderId;
  attribution: OAuthLoginAttribution;
}

/** A late deep link after polling completed the same login; callers can ignore it. */
export interface OAuthDuplicateCallbackResult {
  kind: "duplicate";
  provider: OAuthProviderId;
}

/** Normalized OAuth callback result. */
export type OAuthCallbackResult =
  | OAuthSessionCallbackResult
  | OAuthAttributionCallbackResult
  | OAuthDuplicateCallbackResult;

/** State registration used when the Main process routes a deep link. */
export interface OAuthStateRegistration {
  state: string;
  provider?: OAuthProviderId;
}

/** Normalized callback parameters. */
export interface OAuthCallbackParams {
  state: string;
  code: string;
  attribution?: OAuthLoginAttribution;
}

/** OAuth login attribution parameters from the official site redirect page or an ad link. */
export interface OAuthLoginAttribution {
  channel_id?: string;
  utm_source?: string;
  utm_campaign?: string;
}

/** Normalized token structure. */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  zcodeJwtToken?: string;
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

export type OAuthCachedSessionRestoreResult =
  | { status: "authenticated"; userInfo: UserInfo }
  | { status: "signed-out" }
  | { status: "reauthentication-required"; reason: "jwt-expired" };

/** OAuth owner 已完成会话凭据变更；不携带用户资料或 token。 */
export type OAuthSessionState = "signed-in" | "signed-out";

/** Host 在检测到 ZCode JWT 失效后通知 Renderer 展示确认并重启。 */
export const ZCODE_JWT_INVALID_BROADCAST_CHANNEL = "auth:zcode-jwt-invalid";

export type JwtExpirationResult =
  | { kind: "valid"; expiresAt: number }
  | { kind: "expired"; expiresAt: number }
  | { kind: "unknown" };

/**
 * Parse only the JWT exp claim to determine its local lifetime; this does not verify the signature.
 * Preserve compatibility with legacy or nonstandard tokens whose expiration cannot be confirmed; the server remains the authority on validity.
 */
export function resolveJwtExpiration(
  token: string,
  now = Date.now(),
  clockSkewMs = 30_000,
): JwtExpirationResult {
  try {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) {
      return { kind: "unknown" };
    }

    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return { kind: "unknown" };
    }

    const expiresAt = payload.exp * 1_000;
    return now + Math.max(0, clockSkewMs) >= expiresAt
      ? { kind: "expired", expiresAt }
      : { kind: "valid", expiresAt };
  } catch {
    return { kind: "unknown" };
  }
}

/** Normalized user information. */
export interface OAuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  rawProfile?: unknown;
}

/** Logout scope. */
export type OAuthLogoutScope = "active" | "all";

/** ChatGPT plan (SIWC) user summary for UI display. */
export interface SiwcPlanUserSummary {
  displayName: string;
  email: string | null;
  subject: string;
}

/** ChatGPT plan (SIWC) connection status. */
export interface SiwcPlanStatus {
  planUsageEntitled: boolean;
  signedIn: boolean;
  user: SiwcPlanUserSummary | null;
}

/** ChatGPT plan (SIWC) login start result; displayAuthorizeUrl masks id_token_hint/login_hint. */
export interface SiwcLoginStart {
  authorizeUrl: string;
  displayAuthorizeUrl: string;
  state: string;
}

/** ChatGPT plan (SIWC) login poll result; null while the browser has not returned. */
export interface SiwcLoginCompletionResult extends SiwcPlanAccountStatus {
  newUser: boolean;
}

/**
 * Multi-account SIWC credential key names. Pure string builders live here so the
 * Desktop host service and the CLI resolver (deliberately duplicated SIWC stacks)
 * cannot drift; both are pinned by mirrored tests.
 */

/** Credential index of signed-in ChatGPT plan accounts (JSON array, not a secret). */
export const SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY = "oauth:chatgpt:accounts" as const;

/** Per-account SIWC credential keys in the shared credential store. */
export interface SiwcAccountCredentialKeys {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  userInfo: string;
  scopes: string;
  accessExpiresAt: string;
  earliestRefreshAt: string;
}

function requireValidSiwcAccountKey(accountKey: string): string {
  const normalized = accountKey.trim();
  if (!isChatGptPlanAccountKey(normalized)) {
    throw new Error(`Invalid ChatGPT plan account key: ${normalized}`);
  }
  return normalized;
}

/** Build the per-account SIWC credential key set (`oauth:chatgpt:<accountKey>:*`). */
export function buildSiwcAccountCredentialKeys(accountKey: string): SiwcAccountCredentialKeys {
  const key = requireValidSiwcAccountKey(accountKey);
  return {
    clientId: `oauth:chatgpt:${key}:client_id`,
    accessToken: `oauth:chatgpt:${key}:access_token`,
    refreshToken: `oauth:chatgpt:${key}:refresh_token`,
    idToken: `oauth:chatgpt:${key}:id_token`,
    userInfo: `oauth:chatgpt:${key}:user_info`,
    scopes: `oauth:chatgpt:${key}:scopes`,
    accessExpiresAt: `oauth:chatgpt:${key}:access_expires_at`,
    earliestRefreshAt: `oauth:chatgpt:${key}:earliest_refresh_at`,
  };
}

/** Account-provider identity key of one ChatGPT plan account slot. */
export function buildSiwcAccountProviderIdentityKey(accountKey: string): string {
  return `account-provider:${buildChatGptPlanAccountProviderId(accountKey)}:identity`;
}

/** Account-provider auth-source key of one ChatGPT plan account slot. */
export function buildSiwcAccountProviderAuthSourceKey(accountKey: string): string {
  return `account-provider:${buildChatGptPlanAccountProviderId(accountKey)}:auth-source`;
}

/** Cross-process refresh lock file name of one ChatGPT plan account (host and CLI must match). */
export function buildSiwcAccountRefreshLockFileName(accountKey: string): string {
  return `siwc-chatgpt.${requireValidSiwcAccountKey(accountKey)}.refresh`;
}

/**
 * Cross-process lock guarding shared SIWC account-file mutations (legacy migration and the
 * account-index read-merge-write). Host and CLI must use the same name; the lock file lives
 * next to the shared credentials file in both processes.
 */
export const SIWC_ACCOUNTS_LOCK_FILE_NAME = "siwc-chatgpt.accounts" as const;

/** Pre-multi-account flat credential keys; read-only input for the one-time migration. */
export const SIWC_LEGACY_CREDENTIAL_KEYS = {
  clientId: "oauth:chatgpt:client_id",
  accessToken: "oauth:chatgpt:access_token",
  refreshToken: "oauth:chatgpt:refresh_token",
  idToken: "oauth:chatgpt:id_token",
  userInfo: "oauth:chatgpt:user_info",
  scopes: "oauth:chatgpt:scopes",
  accessExpiresAt: "oauth:chatgpt:access_expires_at",
  earliestRefreshAt: "oauth:chatgpt:earliest_refresh_at",
  providerIdentity: "account-provider:account:chatgpt-plan:identity",
  providerAuthSource: "account-provider:account:chatgpt-plan:auth-source",
} as const;

/** Signed-in account descriptor persisted in the account index (no secrets). */
export interface SiwcStoredAccountRecord {
  accountKey: string;
  sub: string;
  email: string | null;
  name: string | null;
  addedAt: string;
}

/**
 * One ChatGPT plan usage window (5-hour primary or weekly secondary) captured
 * passively from model response headers. `resetsAt` is the RFC3339 string kept
 * verbatim from the `x-codex-*-reset-at` header.
 */
export interface SiwcPlanUsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

/** Latest ChatGPT plan usage snapshot of one account (primary 5h window; weekly secondary when reported). */
export interface SiwcPlanUsageSnapshot {
  primary: SiwcPlanUsageWindow;
  secondary?: SiwcPlanUsageWindow;
}

/** Connection status of one signed-in ChatGPT plan account (user is always present). */
export interface SiwcPlanAccountStatus extends Omit<SiwcPlanStatus, "user"> {
  accountKey: string;
  user: SiwcPlanUserSummary;
}

/** An indexed ChatGPT plan account whose tokens were revoked or expired; it needs a fresh sign-in. */
export interface SiwcPlanReconnectAccount {
  accountKey: string;
  user: SiwcPlanUserSummary;
}

/** Aggregate status across all signed-in ChatGPT plan accounts. */
export interface SiwcPlanAccountsStatus {
  accounts: readonly SiwcPlanAccountStatus[];
  /**
   * Accounts still in the index without tokens (terminal refresh failure). Kept apart from
   * `accounts`, which feeds the provider registry and entitlement, so they never become
   * selectable models (specs/chatgpt-plan-signin.md "Reconnect required").
   */
  reconnectRequired?: readonly SiwcPlanReconnectAccount[];
}
