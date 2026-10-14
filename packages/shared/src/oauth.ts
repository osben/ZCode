/**
 * OAuth domain type definitions.
 *
 * Sensitive information (such as appSecret) and provider default endpoint configuration
 * belong only in the provider modules under services, never in the shared layer.
 */

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

/** The Host notifies the Renderer to show a confirmation and restart after detecting an invalid ZCode JWT. */
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
export interface SiwcLoginCompletionResult extends SiwcPlanStatus {
  newUser: boolean;
}
