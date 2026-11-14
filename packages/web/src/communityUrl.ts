import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildHelpAppConfigUrl,
  createHelpAppConfigReader,
  resolveOptionalZCodeAuthorization,
  resolveHelpAppConfig,
  toServiceLocale,
  type Locale,
  type ZCodeJwtTokenResolver,
} from "@zcode/shared";
import { BrowserOAuthCredentialRepo } from "#src/auth/browserOAuthCredentialRepo.js";
import localDefaultAppConfig from "../../../config/default.json" with { type: "json" };

interface ResolveWebCommunityUrlOptions {
  fetchImpl?: typeof fetch;
  localConfig?: unknown;
  endpointOrigin?: string;
  resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}

const readHelpConfig = createHelpAppConfigReader({
  fetchImpl: (input, init) => fetch(input, init),
});

export async function resolveWebHelpConfig(options: ResolveWebCommunityUrlOptions = {}) {
  const env = import.meta.env;
  const endpoint =
    options.endpointOrigin ??
    (env?.VITE_ZCODE_BASE_URL?.trim() ||
      env?.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
      DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  // The server rejects platform=web; browsers omit this optional platform parameter to avoid impersonating a desktop system.
  const url = buildHelpAppConfigUrl(endpoint, ZCODE_VERSION);
  const authorization = await resolveOptionalZCodeAuthorization(
    // 可选配置读取不能顺带清理过期或残缺的登录态；恢复/登出仍由原认证入口处理。
    options.resolveZcodeJwtToken ?? (() => new BrowserOAuthCredentialRepo().loadZCodeJwtToken()),
  );
  let remote: unknown;
  try {
    remote = await (
      options.fetchImpl
        ? createHelpAppConfigReader({ fetchImpl: options.fetchImpl })
        : readHelpConfig
    )(url, authorization ? { Authorization: authorization } : undefined);
  } catch {
    // Keep the built-in entry when the remote source is unavailable; do not use the legacy CDN as a second remote configuration source.
  }
  return resolveHelpAppConfig(remote, options.localConfig ?? localDefaultAppConfig);
}

export async function resolveWebCommunityUrl(
  locale: Locale,
  options: ResolveWebCommunityUrlOptions = {},
): Promise<string | undefined> {
  // Community links are keyed by service locale; each UI locale maps to its own entry.
  return (await resolveWebHelpConfig(options)).community_urls?.[toServiceLocale(locale)];
}
