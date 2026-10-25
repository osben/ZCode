import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "./zcodeEndpoint.js";
import { stripZcodeForkVersionSuffix } from "./version.js";

export const ZCODE_SOURCE_HEADERS = {
  "User-Agent": "ZCode/unknown",
  "HTTP-Referer": DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  "X-Title": "Z Code@electron",
} as const;

export interface BuildZCodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeZCodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildZCodeSourceHeadersFromContext(
  options: BuildZCodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  // Send only the upstream baseline version outward: the prerelease suffix of a fork version
  // (e.g. 3.15.1-fork.2) makes the z.ai backend's semver gating classify it as lower than the
  // official release of the same baseline, so it is stripped uniformly at the egress point.
  const appVersion = normalizeZCodeSourceHeaderValue(options.appVersion);
  const wireAppVersion = appVersion ? stripZcodeForkVersionSuffix(appVersion) : undefined;
  const arch = normalizeZCodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeZCodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeZCodeSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeZCodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeZCodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  const osVersion = normalizeZCodeSourceHeaderValue(options.osVersion);
  const platform = normalizeZCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeZCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeZCodeSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...ZCODE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `ZCode/${wireAppVersion ?? "unknown"}`,
    ...(wireAppVersion ? { "X-ZCode-App-Version": wireAppVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
