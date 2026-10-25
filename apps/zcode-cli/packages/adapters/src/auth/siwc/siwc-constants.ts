/** Shared identifiers for the "Sign in with ChatGPT" (SIWC) plan provider. */

/** OAuth provider id; chatgpt is an identity domain independent of zai/bigmodel. */
export const CHATGPT_PROVIDER_ID = "chatgpt";

export const SIWC_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
export const SIWC_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
export const SIWC_OPENID_CONFIGURATION_URL =
  "https://auth.openai.com/.well-known/openid-configuration";
export const SIWC_ISSUER = "https://auth.openai.com";

/**
 * Dynamic-client bootstrap id used only for the first registration of an account.
 * The loopback callback returns the issued real client id (oaiapp_...), which must be
 * persisted and used for every later OAuth call.
 */
export const SIWC_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

/** Real application name sent as agent_name_hint on first registration only. */
export const SIWC_AGENT_NAME_HINT = "ZCode";

/** Resource indicator (RFC 8707); the access token audience is this URL. */
export const SIWC_RESOURCE = "https://api.openai.com/v1";

export const SIWC_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/** Scope that grants plan-backed inference; without it the login is identity-only. */
export const SIWC_PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";

/** Loopback redirect path; the host must be the literal 127.0.0.1 (localhost is rejected). */
export const SIWC_CALLBACK_PATH = "/callback";

/** Refresh tokens rotate on every use; terminal failure codes that force a full re-sign-in. */
export const SIWC_TERMINAL_REFRESH_ERROR_CODES: readonly string[] = [
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
];
