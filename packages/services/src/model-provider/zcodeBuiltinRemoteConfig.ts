import { downloadZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "@zcode/provider-node";
import type { ApiClient, ZCodeJwtTokenResolver } from "@zcode/shared";

export interface FetchZCodeBuiltinRemoteReleaseOptions {
  readonly apiClient: ApiClient;
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly signal?: AbortSignal;
  readonly resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}

/** Services only injects the existing network assembly; provider-node is the sole implementation of URL, budget, and Release validation. */
export async function fetchZCodeBuiltinRemoteRelease(
  options: FetchZCodeBuiltinRemoteReleaseOptions,
): Promise<ZCodeBuiltinRelease | null> {
  return downloadZCodeBuiltinRelease({
    endpointOrigin: options.endpointOrigin,
    appVersion: options.appVersion,
    platform: options.platform,
    signal: options.signal,
    resolveZcodeJwtToken: options.resolveZcodeJwtToken,
    request: (url, init) => options.apiClient.request(url, init),
  });
}
