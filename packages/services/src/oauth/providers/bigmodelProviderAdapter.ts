import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

interface BigModelZcodeTokenEnvelope {
  code?: number;
  msg?: string;
  data?: {
    token?: string | null;
    access_token?: string | null;
    accessToken?: string | null;
    bigmodel?: {
      access_token?: string | null;
      accessToken?: string | null;
      refresh_token?: string | null;
      refreshToken?: string | null;
    } | null;
  } | null;
}

interface BigModelCustomerInfo {
  customerNumber?: unknown;
  customerName?: unknown;
  nickName?: unknown;
  avatar?: unknown;
}

/** Maximum wait allowed for OAuth startup restoration (1 minute). */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
const log = createServiceLogger("bigmodelOAuth");

function maskOAuthCode(code: string): string {
  if (code.length <= 8) {
    return "*".repeat(code.length);
  }

  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function readOptionalString(value: unknown): string | undefined {
  // BigModel userinfo is remote runtime data; an exception value must not be trimmed or persisted as a display field.
  return typeof value === "string" ? value : undefined;
}

function readTrimmedString(value: unknown): string {
  return readOptionalString(value)?.trim() || "";
}

function resolveBigModelDisplayName(customer: BigModelCustomerInfo): string {
  const customerName = readTrimmedString(customer.customerName);
  const nickName = readTrimmedString(customer.nickName);
  return customerName || nickName || "user";
}

/** BigModel OAuth protocol adapter. */
export class BigModelProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = BIGMODEL_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
  }

  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // polling ready already returned the BigModel business token; do not perform Z.AI's second business-token exchange.
    return tokenSet;
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    // BigModel production callbacks historically used authCode; newer versions may fall back to code.
    // Support both fields so a parameter rename in the console does not immediately break client login.
    const code = parsed.searchParams.get("authCode") ?? parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");

    if (!code || !state) {
      throw new Error("OAuth 回调缺少 authCode/code 或 state 参数");
    }

    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    const query = new URLSearchParams({
      redirect: context.redirectUri,
      appId: this.config.appId,
      state: context.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    _context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const tokenSet = await this.exchangeZcodeJwtToken(params, _context);

    return {
      ...tokenSet,
    };
  }

  private async exchangeZcodeJwtToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    log.info(undefined, "zcode token request", {
      method: "POST",
      url: this.config.tokenUrl,
      headers: { "Content-Type": "application/json" },
      body: {
        provider: BIGMODEL_PROVIDER_ID,
        code: maskOAuthCode(params.code),
        codeLength: params.code.length,
        redirect_uri: context.redirectUri,
        state: context.state,
      },
    });

    try {
      const payload = await readApiJson<BigModelZcodeTokenEnvelope>(
        this.apiClient,
        this.config.tokenUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The backend token route for zcode JWTs parses the request using OAuth callback authorization-code semantics.
          // BigModel Start Plan must not exchange access_token again during later balance queries,
          // or the body will differ from the Z.AI login flow and trigger HTTP 400. Use the shared OAuth provider enum
          // to avoid guessing identity from redirect_uri when more providers are added to the frontend/backend.
          body: JSON.stringify({
            provider: BIGMODEL_PROVIDER_ID,
            code: params.code,
            redirect_uri: context.redirectUri,
            state: context.state,
          }),
        },
      );
      if (payload.code !== undefined && payload.code !== 0) {
        // BigModel's one-time authCode is now used only by the zcode token route.
        // If this fails, do not continue saving a partial login state or Start Plan will still appear disconnected.
        log.warn(undefined, "zcode token business response rejected", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error(
          payload.msg?.trim() || `BigModel zcode token 交换失败（code: ${payload.code}）`,
        );
      }
      const zcodeJwtToken = payload.data?.token?.trim() || "";
      if (!zcodeJwtToken) {
        log.warn(undefined, "zcode token response missing data.token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error("BigModel zcode token 交换失败：响应缺少 data.token");
      }
      const accessToken = resolveBigModelBusinessAccessToken(payload);
      if (!accessToken) {
        // Paid Coding Plan subscriptions still call BigModel business endpoints and must use
        // the BigModel business access token; the zcode JWT belongs only in zcodejwttoken for Start Plan.
        // If the zcode JWT is stored in oauth:bigmodel:access_token, subscription previews will consistently report "token expired".
        log.warn(undefined, "zcode token response missing bigmodel access token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error("BigModel zcode token 交换失败：响应缺少 data.bigmodel.access_token");
      }

      const refreshToken =
        payload.data?.bigmodel?.refresh_token?.trim() ??
        payload.data?.bigmodel?.refreshToken?.trim() ??
        "";
      return {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        zcodeJwtToken,
      };
    } catch (error) {
      // BigModel callback code is single-use; the client must not consume it first by calling
      // tokenByAuthCode. Abort login if the zcode token exchange fails, and record the trace headers.
      log.warn(undefined, "zcode token request failed", {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError
          ? {
              method: error.method,
              status: error.status,
              url: error.url,
              responseHeaders: error.responseHeaders ?? {},
            }
          : {}),
      });
      throw error;
    }
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    if (tokenSet.zcodeJwtToken && tokenSet.accessToken === tokenSet.zcodeJwtToken) {
      // After removing tokenByAuthCode, no BigModel access token is available during the callback.
      // A zcode JWT cannot call the bigmodel.cn customer endpoint, so avoid an unnecessary failed authorization request.
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    const userinfoPayload = await readApiJson<{
      data?: BigModelCustomerInfo;
    }>(this.apiClient, this.config.userinfoUrl, {
      method: "GET",
      // Startup session restoration depends on this userinfo validation path.
      // Without a timeout, the network request could remain pending and leave the UI showing "restoring" indefinitely.
      // Set a fixed one-minute timeout so failure settles promptly and loading cannot continue forever.
      timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
      headers: {
        // BigModel's customer information endpoint requires the raw token in Authorization;
        // a Bearer prefix consistently causes authorization failure.
        Authorization: tokenSet.accessToken,
        "Content-Type": "application/json",
      },
    });
    const customer = userinfoPayload.data;

    if (!customer) {
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    // BigModel customerName is the account's actual display name; nickName is only a fallback.
    // An empty string is equivalent to missing in the API, so trim before choosing to avoid a blank account display name.
    const username = resolveBigModelDisplayName(customer);

    return {
      id: readOptionalString(customer.customerNumber) ?? "unknown",
      username,
      displayName: username,
      avatarUrl: readOptionalString(customer.avatar),
    };
  }

  async loadLegacyTokenSet(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null> {
    const accessToken = await loadCredential("auth_token");
    if (!accessToken) {
      return null;
    }

    const refreshToken = await loadCredential("refresh_token");

    // Legacy BigModel login state stored only auth_token/refresh_token;
    // without compatibility handling in the provider, upgrades would incorrectly treat it as "no token".
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(`BigModel OAuth 异常: ${String(error)}`);
  }
}

function resolveBigModelBusinessAccessToken(payload: BigModelZcodeTokenEnvelope): string {
  return (
    payload.data?.bigmodel?.access_token?.trim() ??
    payload.data?.bigmodel?.accessToken?.trim() ??
    payload.data?.access_token?.trim() ??
    payload.data?.accessToken?.trim() ??
    ""
  );
}
