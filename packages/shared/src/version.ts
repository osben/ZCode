// Injected by each bundler through define to avoid cross-bundler compatibility issues with runtime JSON imports.
// In non-build environments (such as mocha in E2E tests), define is unavailable;
// use typeof checks and a fallback to avoid ReferenceError.
declare const __ZCODE_VERSION__: string;
declare const __ZCODE_COMMIT__: string;
declare const __ZCODE_BUILD_TIME__: string;

export const ZCODE_VERSION: string =
  typeof __ZCODE_VERSION__ !== "undefined" ? __ZCODE_VERSION__ : "0.0.0-dev";
export const ZCODE_COMMIT: string =
  typeof __ZCODE_COMMIT__ !== "undefined" ? __ZCODE_COMMIT__ : "unknown";
export const ZCODE_BUILD_TIME: string =
  typeof __ZCODE_BUILD_TIME__ !== "undefined" ? __ZCODE_BUILD_TIME__ : "unknown";

// A fork version looks like 3.15.1-fork.2: local display and remote asset identity use the full
// version, but the z.ai backend gates behavior by semver (e.g. the OAuth site decides deep links
// by app_version) and would rank a -fork.N suffix below the official release on the same baseline.
// Version strings sent to the backend keep only the upstream baseline; other prereleases (such as
// the dev fallback version) are not fork markers and stay unchanged.
export function stripZcodeForkVersionSuffix(version: string): string {
  const match = /^(\d+\.\d+\.\d+)-fork\.\d+$/.exec(version.trim());
  return match ? match[1]! : version;
}

export const ZCODE_UPSTREAM_BASE_VERSION: string = stripZcodeForkVersionSuffix(ZCODE_VERSION);
