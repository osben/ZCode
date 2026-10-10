import type { WebZaiOAuthProviderConfig } from "./zaiWebOAuthProvider.js";
import {
  buildZCodeEndpointUrls,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  resolveBigModelApiOrigin,
} from "@zcode/shared";

interface WebImportMetaEnv {
  VITE_DEV_ORIGIN?: string;
  VITE_ZAI_OAUTH_CLIENT_ID?: string;
  VITE_ZAI_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_APP_ID?: string;
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
}

export interface WebZaiOAuthConfig extends WebZaiOAuthProviderConfig {
  devOrigin?: string;
  shareRedirectUri: string;
  allowDevReturnToRedirect: boolean;
}

function normalizeZaiOAuthOrigin(value: string): string {
  return new URL(value.trim()).origin;
}

function buildZaiOAuthAuthorizeUrl(origin: string | undefined): string {
  return `${normalizeZaiOAuthOrigin(origin?.trim() || "https://chat.z.ai")}/api/oauth/authorize`;
}

/**
 * BigModel authorization entry point.
 *
 * It must follow the environment: hard-coding bigmodel.cn in tests would send test accounts to the production authorization page.
 * At build time, vite.config injects VITE_BIGMODEL_OAUTH_ORIGIN using resolveBigModelApiOrigin; the
 * resolveBigModelApiOrigin({}) call here is only a final fallback (equivalent to the production origin).
 */
function buildBigModelAuthorizeUrl(origin: string | undefined): string {
  const trimmed = origin?.trim();
  return `${trimmed ? new URL(trimmed).origin : resolveBigModelApiOrigin({})}/login`;
}

function createWebZaiOAuthConfig(env: WebImportMetaEnv = {}): WebZaiOAuthConfig {
  const devOrigin = env.VITE_DEV_ORIGIN?.trim().replace(/\/$/, "");
  const zcodeEndpointUrls = buildZCodeEndpointUrls(
    env.VITE_ZCODE_BASE_URL?.trim() ||
      env.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
      DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  );

  return {
    // The current ZAI OAuth authorization entry uses the /api/oauth prefix; /auth/oauth opens the legacy entry.
    authorizeUrl: buildZaiOAuthAuthorizeUrl(env.VITE_ZAI_OAUTH_ORIGIN),
    tokenUrl: "/api/v1/oauth/token",
    // client_id appears in the authorization URL and is public configuration; VITE_ injection is allowed, but secrets/tokens are not.
    clientId: env.VITE_ZAI_OAUTH_CLIENT_ID?.trim() || "client_P8X5CMWmlaRO9gyO-KSqtg",
    bigmodelAuthorizeUrl: buildBigModelAuthorizeUrl(env.VITE_BIGMODEL_OAUTH_ORIGIN),
    // BigModel uses appId rather than client_id, and its default is "zcode", as used by Desktop.
    bigmodelAppId: env.VITE_BIGMODEL_OAUTH_APP_ID?.trim() || "zcode",
    redirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    shareRedirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    ...(devOrigin ? { devOrigin } : {}),
    allowDevReturnToRedirect: env.VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO === "true",
  };
}

const env = ((import.meta as ImportMeta & { env?: WebImportMetaEnv }).env ??
  {}) as WebImportMetaEnv;

export const WEB_ZAI_OAUTH_CONFIG: WebZaiOAuthConfig = createWebZaiOAuthConfig(env);

export function resolveWebAuthDevReturnTo(config: WebZaiOAuthConfig): string | undefined {
  return config.devOrigin ? `${config.devOrigin}/share/callback` : undefined;
}
