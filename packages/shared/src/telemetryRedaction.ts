/**
 * Centralized redaction of telemetry text and model identities.
 *
 * Automatically collected ARMS exception/api/click events and free-text fields in custom events may contain
 * local paths, email addresses, full URLs, and credentials. These pure functions are shared by desktop main's `beforeReport`
 * and renderer telemetry to avoid duplicating the patterns in each reporting hook.
 *
 * Keep patterns aligned with the CLI's `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts`. The files are in separate
 * workspaces and cannot depend on each other, so changes to either side must be mirrored on the other.
 */

import { decodeCustomModelValue } from "./custom-model-value.js";
import { migrateLegacyModelProviderId } from "./legacy-model-provider-identity.js";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isBuiltinModelProviderId,
  isChatGptPlanAccountProviderId,
} from "./model-provider-types.js";
import { OFFICIAL_GLM_MODEL_IDS } from "./official-glm-model-id.js";

/** Default per-field limit; ARMS truncates or rejects oversized fields, so truncate proactively to preserve the important prefix. */
export const TELEMETRY_TEXT_MAX_LENGTH = 2_048;

/** Input limit before redaction: errors may contain a full response body, so truncate before regex processing to bound CPU cost. */
const TELEMETRY_TEXT_SCAN_LIMIT = 4_096;

/** Maximum length for preserving a route segment verbatim; longer segments are treated as untrusted. */
const TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH = 128;

export interface RedactTelemetryTextOptions {
  /** Output limit, defaulting to {@link TELEMETRY_TEXT_MAX_LENGTH}. */
  maxLength?: number;
}

/**
 * Sanitize free text for reporting: remove URL queries, replace paths/email addresses/credentials with placeholders, and truncate to a bound.
 *
 * Apply only to the reporting copy; error displays, local logs, crash archives, and classification must keep using the original value.
 */
export function redactTelemetryText(
  value: string | undefined | null,
  options: RedactTelemetryTextOptions = {},
): string {
  if (typeof value !== "string" || !value) {
    return "";
  }

  const maxLength = options.maxLength ?? TELEMETRY_TEXT_MAX_LENGTH;
  const redacted = value
    .slice(0, TELEMETRY_TEXT_SCAN_LIMIT)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (match) => redactTelemetryUrl(match))
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    // Fix rationale: absolute paths in crash/exception messages expose the local username and workspace directory, so normalize them before data leaves the machine.
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "{path}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "{path}",
    )
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return redacted.slice(0, maxLength);
}

/**
 * Sanitize a URL to `protocol//host` plus a normalized route; discard the query and fragment.
 *
 * Normalize `file://` URLs and local absolute paths to `local_file`; retain only the scheme marker for `blob:`/`data:`.
 * Return `unknown` when parsing fails; never fall back to the original value.
 */
export function redactTelemetryUrl(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "unknown";
  }
  if (/^blob:/iu.test(raw)) {
    return "blob";
  }
  if (/^data:/iu.test(raw)) {
    return "data";
  }
  // Bug cause: enumerating common root directories misses valid POSIX absolute paths such as /opt, /root, and /mnt.
  if (/^file:/iu.test(raw) || /^[a-zA-Z]:[\\/]/u.test(raw) || raw.startsWith("/")) {
    return "local_file";
  }

  try {
    // Bug cause: unconditionally adding `https://` makes plain text such as `!!!` parse as a host and echo back unchanged.
    // Parse only inputs that already have a scheme or look like host[:port][/path].
    const candidate = raw.includes("://")
      ? raw
      : /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(?:[/?#]|$)/iu.test(raw)
        ? `https://${raw}`
        : "";
    if (!candidate) {
      return "unknown";
    }
    const parsed = new URL(candidate);
    if (parsed.protocol === "file:" || !parsed.host) {
      return "local_file";
    }
    const route = parsed.pathname
      .split("/")
      .map((segment) => redactTelemetryRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "unknown";
  }
}

function redactTelemetryRouteSegment(segment: string): string {
  if (!segment) {
    return segment;
  }
  if (
    // Email addresses, long numeric IDs, hashes, and UUIDs are high-cardinality identifiers and must not remain in routes.
    /@/u.test(segment) ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH);
}

/** Historical built-in models outside the official GLM list; these remain stable IDs published by ZCode, not user-defined names. */
const TELEMETRY_LEGACY_BUILTIN_MODEL_IDS: readonly string[] = ["charglm-4", "codegeex-4", "emohaa"];

/**
 * Telemetry model allowlist: only stable built-in model IDs listed here may enter telemetry unchanged.
 *
 * The allowlist is independent of the runtime catalog returned by accounts, but is sourced from the manually maintained official GLM list.
 * Fix rationale: a previously copied list omitted GLM-5.3 / GLM-5.3-Flash / GLM-5V-Turbo, causing flagship models to be
 * reported as `custom` in plan_* / perf_ui_*. Deriving from the official list prevents the two sources from drifting apart.
 */
export const TELEMETRY_SAFE_BUILTIN_MODEL_IDS: ReadonlySet<string> = new Set([
  ...OFFICIAL_GLM_MODEL_IDS.map((id) => id.toLowerCase()),
  ...TELEMETRY_LEGACY_BUILTIN_MODEL_IDS,
]);

export type TelemetryProviderScope = "builtin" | "custom" | "unknown";

export interface TelemetryProviderIdentity {
  providerId: string;
  providerScope: TelemetryProviderScope;
}

/**
 * Legacy report identities (`builtin:zai` / `builtin:zai-start-plan`, etc.) are fixed IDs owned by ZCode.
 *
 * Fix rationale: when the V4 supervisor projects /report detail, legacyTelemetryProviderId maps runtime
 * `account:*` identities to these legacy values, and plan_ttft / perf_ui_* reuse the same detail. Recognizing only `account:*`
 * would classify all built-in users as custom providers and normalize them to `custom`. Reuse the shared one-way migration table;
 * unknown `builtin:` prefixes still count as custom and cannot bypass the allowlist by prefix alone.
 */
function isLegacyBuiltinTelemetryProviderId(providerId: string): boolean {
  const migrated = migrateLegacyModelProviderId(providerId);
  return migrated !== undefined && migrated !== providerId;
}

/** Preserve stable IDs for built-in providers; custom provider names are user-defined and would expose private names and create high cardinality. */
export function resolveTelemetryProviderScope(
  providerId: string | undefined | null,
): TelemetryProviderIdentity {
  const normalized = providerId?.trim();
  if (!normalized) {
    return { providerId: "", providerScope: "unknown" };
  }
  // Per-account ChatGPT plan ids are a stable per-user pseudonym (sha256(sub) prefix); report
  // only the family id so telemetry cannot link events to one ChatGPT account.
  if (isChatGptPlanAccountProviderId(normalized)) {
    return { providerId: BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan, providerScope: "builtin" };
  }
  if (isBuiltinModelProviderId(normalized) || isLegacyBuiltinTelemetryProviderId(normalized)) {
    return { providerId: normalized, providerScope: "builtin" };
  }
  return { providerId: "custom", providerScope: "custom" };
}

/**
 * Extract the bare model ID from an encoded `custom:<providerId>:<modelName>` value or a composite `<providerId>/<modelId>` value.
 * The bare ID is used only to check the allowlist; no provider portion is reported unchanged.
 */
function extractBareModelId(value: string): string {
  const decoded = decodeCustomModelValue(value);
  if (decoded) {
    return decoded.modelName ?? "";
  }
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(separator + 1) : value;
}

/**
 * Preserve only built-in model IDs in the allowlist.
 *
 * Report models from custom providers and models not in the allowlist under built-in providers as `custom`.
 * Report an empty string when provider scope is unknown or the model is missing, matching the existing empty-value convention.
 */
export function resolveTelemetryModelId(
  providerScope: TelemetryProviderScope,
  modelId: string | undefined | null,
): string {
  const normalized = modelId?.trim();
  if (!normalized || providerScope === "unknown") {
    return "";
  }
  if (providerScope === "custom") {
    return "custom";
  }
  // Fix rationale: supervisor-projected detail.model_name is a `<providerId>/<modelId>` composite or
  // a `custom:` encoded value, so looking up the whole string always misses; extract the bare model ID first.
  const bareModelId = extractBareModelId(normalized).toLowerCase();
  return TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has(bareModelId) ? bareModelId : "custom";
}

/**
 * Normalize cases where only a model value is available and there is no separate provider field.
 *
 * Supports three forms: an encoded `custom:<providerId>[:<modelName>]` value, a composite `<providerId>/<modelId>` value,
 * and a bare model ID. Bare IDs are checked directly against the allowlist and otherwise fall back to `custom`. This satisfies
 * the requirement to default new built-in models to `custom` until they are added to the allowlist, without requiring callers to pass a provider.
 */
export function sanitizeTelemetryModelValue(value: string | undefined | null): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }

  // The `custom:` prefix itself indicates a non-built-in provider; there is no need to decode its user-defined name.
  const decoded = decodeCustomModelValue(normalized);
  if (decoded) {
    return resolveTelemetryModelId(
      resolveTelemetryProviderScope(decoded.providerId).providerScope,
      decoded.modelName,
    );
  }

  const separator = normalized.indexOf("/");
  if (separator > 0) {
    const { providerScope } = resolveTelemetryProviderScope(normalized.slice(0, separator));
    return resolveTelemetryModelId(providerScope, normalized.slice(separator + 1));
  }

  return resolveTelemetryModelId("builtin", normalized);
}
