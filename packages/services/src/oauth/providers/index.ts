import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, type ApiClient } from "@zcode/shared";
import type { OAuthRuntimeConfig } from "../runtimeConfig.js";
import { BigModelProviderAdapter } from "./bigmodelProviderAdapter.js";
import type { OAuthProviderAdapter } from "./providerAdapter.js";
import { ZaiProviderAdapter } from "./zaiProviderAdapter.js";

/** Create available provider adapters from runtime configuration. */
export function createOAuthProviderAdapters(
  config: OAuthRuntimeConfig,
  options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
  const adapters: OAuthProviderAdapter[] = [];
  const apiClient = options.apiClient;
  if (!apiClient) {
    throw new Error(
      "ApiClient 注入缺失：OAuth provider adapters 必须通过 Providers 传入 apiClient",
    );
  }

  for (const providerConfig of config.providers) {
    switch (providerConfig.id) {
      case BIGMODEL_PROVIDER_ID:
        adapters.push(new BigModelProviderAdapter(providerConfig, apiClient));
        break;
      case ZAI_PROVIDER_ID:
        adapters.push(new ZaiProviderAdapter(providerConfig, apiClient));
        break;
      default:
        // Ignore unknown providers so one configuration error does not break all sign-in capabilities.
        break;
    }
  }

  return adapters;
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";
