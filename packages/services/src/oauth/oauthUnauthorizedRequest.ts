import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { resolveBigModelUserinfoUrl } from "#src/oauth/providers/bigmodelProviderConfig.js";
import { resolveZaiUserinfoUrl } from "#src/oauth/providers/zaiProviderConfig.js";

import {
  isSameOAuthAccountMaterial,
  type OAuthAccountMaterial,
} from "#src/oauth/repo/oauthCredentialRepo.js";

function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    const url = new URL(resolve());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const OAUTH_BUSINESS_PREFIXES = ["/api/biz/", "/api/pay/"] as const;

async function isCurrentBusinessOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;

  const provider = await options.credentialService.load("oauth:active_provider");
  if (!(await isOAuthBusinessRequest({ ...options, provider }))) return false;

  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    return false;
  // The platform may change while reading from disk; do not use a 401 from a token left by the previous platform to clear the current login.
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}

export async function isOAuthBusinessRequest(options: {
  input: string | URL;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  provider?: string | null;
}): Promise<boolean> {
  const provider =
    options.provider ?? (await options.credentialService?.load("oauth:active_provider"));
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return false;
  const env = options.env ?? process.env;
  const requestUrl = tryResolveHttpUrl(() => options.input);
  if (!requestUrl) return false;
  const buildBusinessUrl = (path: string) =>
    provider === BIGMODEL_PROVIDER_ID
      ? buildBigModelApiUrl(env, path)
      : buildRuntimeZaiBusinessUrl(env, path);
  // 业务 token 也用于 PAT 签发和支付；仅检查三条身份接口会让这些入口的失效漏掉。
  // 域名/环境及 token 精确匹配仍由当前凭据分类器负责，模型 PAT 不会被当成登录 token。
  if (
    OAUTH_BUSINESS_PREFIXES.some((path) => {
      const expected = tryResolveHttpUrl(() => buildBusinessUrl(path));
      return (
        expected !== null &&
        requestUrl.origin === expected.origin &&
        requestUrl.pathname.startsWith(expected.pathname)
      );
    })
  )
    return true;
  const userinfo = tryResolveHttpUrl(() =>
    provider === BIGMODEL_PROVIDER_ID
      ? resolveBigModelUserinfoUrl(env)
      : resolveZaiUserinfoUrl(env),
  );
  return (
    userinfo !== null &&
    requestUrl.origin === userinfo.origin &&
    requestUrl.pathname === userinfo.pathname
  );
}

/** Host 私有的只读身份核验材料，不进入 RPC、配置或日志。 */
export async function resolveOAuthBusinessCredentialValidationRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<{ url: string; authorization: string; emptyBodyMeansInvalid: boolean } | null> {
  const provider = await options.credentialService.load("oauth:active_provider");
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return null;
  if (!(await isCurrentBusinessOAuthCredentialRequest(options))) return null;
  if ((await options.credentialService.load("oauth:active_provider")) !== provider) return null;
  const env = options.env ?? process.env;
  const url = tryResolveHttpUrl(() =>
    provider === BIGMODEL_PROVIDER_ID
      ? buildBigModelApiUrl(env, "/api/biz/customer/getCustomerInfo")
      : buildRuntimeZaiBusinessUrl(env, "/api/biz/customer/getCustomerInfo"),
  );
  if (!url) return null;
  const token = options.headers
    .get("authorization")!
    .trim()
    .replace(/^Bearer\s+/i, "");
  return {
    url: url.toString(),
    // 两平台 customerInfo 都要求裸业务 token；加 Bearer 会把格式拒绝误判成登录失效。
    authorization: token,
    // BigModel 注销后 customerInfo 返回零字节200；不扩散到 ZAI 或任意空业务响应。
    emptyBodyMeansInvalid: provider === BIGMODEL_PROVIDER_ID,
  };
}

export async function isCurrentOAuthBusinessCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return isCurrentBusinessOAuthCredentialRequest(options);
}

/** Identifies only business JWTs that belong to the same primary session; a failure from a PAT or a dual-JWT request is not read as association loss. */
export async function resolveAssociatedOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  loadMaterial: () => Promise<OAuthAccountMaterial | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<OAuthAccountMaterial | null> {
  if (
    !(await isOAuthBusinessRequest({
      input: options.input,
      provider: BIGMODEL_PROVIDER_ID,
      env: options.env,
    }))
  )
    return null;
  const authorization = options.headers.get("authorization")?.trim();
  if (!authorization) return null;
  const material = await options.loadMaterial();
  if (!material || material.loginProvider === BIGMODEL_PROVIDER_ID) return null;
  const token = material.accessToken.trim();
  if (!token || (authorization !== token && authorization !== `Bearer ${token}`)) return null;
  return isSameOAuthAccountMaterial(material, await options.loadMaterial()) ? material : null;
}

// This only identifies candidate requests; OAuthService must recheck them inside the session-change queue before signing out, rather than relying on a stale async snapshot.
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;
  return isCurrentBusinessOAuthCredentialRequest(options);
}
