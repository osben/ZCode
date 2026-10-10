import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** Installed-package identity: determines the app name, app id, Electron data directory, and update policy; independent of the backend `ZCodeEnv` axis. */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// In non-build environments (such as mocha in E2E tests), define is unavailable; use typeof checks and fallbacks to avoid ReferenceError.
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;

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

// Restored because hard-coding false would leave runtime-configured analytics/ARMS permanently idle.
// Keep the feature available; runtime endpoint checks at each egress decide whether network reporting occurs, and nothing is reported when unconfigured.
export const ZCODE_TELEMETRY_ENABLED: boolean = true;

/** Analytics event reporting endpoint: supplied by a runtime environment variable, disabled if unset, and not embedded in build artifacts. */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_TELEMETRY_REPORT_ENDPOINT ?? "") : "";

/** ARMS RUM endpoint: supplied by a runtime environment variable, disabled if unset, and not embedded in build artifacts. */
export const ZCODE_ARMS_RUM_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_ARMS_RUM_ENDPOINT ?? "") : "";

/** Maps local runtime state and compile-time ZCODE_ENV to an environment label recognized by the ARMS console. */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
