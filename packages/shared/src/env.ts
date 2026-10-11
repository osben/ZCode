import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** Installed-package identity: determines the app name, app id, Electron data directory, and update policy; independent of the backend `ZCodeEnv` axis. */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// In non-build environments (such as mocha in E2E tests), define is unavailable; use typeof checks and fallbacks to avoid ReferenceError.
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;
declare const __ZCODE_ARMS_RUM_ENDPOINT__: string;
declare const __ZCODE_TELEMETRY_REPORT_ENDPOINT__: string;
declare const __ZCODE_AUTO_UPDATE_ENABLED__: boolean;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__ : undefined,
);

/**
 * By default, identity follows the backend environment (test → preview, production → production).
 * Desktop builds explicitly inject preview with `ZCODE_PREVIEW_IDENTITY=1` to produce a Preview package connected to the production backend;
 * bundles without an injected define (web, CLI, tests) retain the legacy single-axis semantics.
 */
export function normalizeZCodeProductFlavor(
  value: string | undefined,
  zcodeEnv: ZCodeEnv,
): ZCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const ZCODE_PRODUCT_FLAVOR = normalizeZCodeProductFlavor(
  typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" ? __ZCODE_PRODUCT_FLAVOR__ : undefined,
  ZCODE_ENV,
);
export const ZCODE_APP_VERSION_ENV = "ZCODE_APP_VERSION" as const;
export const ZCODE_BUILD_COMMIT_ID_ENV = "ZCODE_BUILD_COMMIT_ID" as const;

// ── Runtime environment variables (not bundled at compile time; read from process.env on startup) ──
// Enables debug mode; the value is the inspect-brk port, e.g. ZCODE_DEBUG=9230.
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;

// ── Build-time optional capabilities (see docs/desktop/build-time-optional-capabilities.md); off by default when not injected ──
/** ARMS RUM reporting endpoint; when empty, the SDK initializes with enable=false and reports nothing. */
export const ZCODE_ARMS_RUM_ENDPOINT: string =
  typeof __ZCODE_ARMS_RUM_ENDPOINT__ !== "undefined" ? __ZCODE_ARMS_RUM_ENDPOINT__ : "";
/** Event reporting (analytics warehouse) endpoint; nothing is reported when empty. */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT: string =
  typeof __ZCODE_TELEMETRY_REPORT_ENDPOINT__ !== "undefined"
    ? __ZCODE_TELEMETRY_REPORT_ENDPOINT__
    : "";
/** Whether desktop auto-update is enabled. */
export const ZCODE_AUTO_UPDATE_ENABLED: boolean =
  typeof __ZCODE_AUTO_UPDATE_ENABLED__ !== "undefined" ? __ZCODE_AUTO_UPDATE_ENABLED__ : false;

/** Maps local runtime state and compile-time ZCODE_ENV to an environment label recognized by the ARMS console. */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
