import { downloadZCodeBuiltinRelease, type ZCodeBuiltinDownloadResult } from "@zcode/provider-node";
import type { ApiClient, ZCodeJwtTokenResolver } from "@zcode/shared";

export interface FetchZCodeBuiltinRemoteReleaseOptions {
  readonly apiClient: ApiClient;
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly signal?: AbortSignal;
  readonly resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
  readonly reuseUrl?: string;
}

/** Services only injects the existing network assembly; provider-node is the sole implementation of URL, budget, and Release validation. */
export async function fetchZCodeBuiltinRemoteRelease(
  options: FetchZCodeBuiltinRemoteReleaseOptions,
): Promise<ZCodeBuiltinDownloadResult> {
  return downloadZCodeBuiltinRelease({
    endpointOrigin: options.endpointOrigin,
    appVersion: options.appVersion,
    platform: options.platform,
    signal: options.signal,
    resolveZcodeJwtToken: options.resolveZcodeJwtToken,
    request: (url, init) => options.apiClient.request(url, init),
    ...(options.reuseUrl ? { reuseUrl: options.reuseUrl } : {}),
  });
}
