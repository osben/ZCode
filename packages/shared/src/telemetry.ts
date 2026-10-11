export interface TelemetryRendererContext {
  clientTimezone: string;
  clientLanguage: string;
  screenResolution: string;
}

export interface TelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export interface RendererTelemetryEventPayload extends TelemetryEventPayload {
  context: TelemetryRendererContext;
}

export interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number;
  properties?: Record<string, string | number | boolean | undefined>;
}

/** Final arguments actually passed by desktop main to armsRum.sendCustom. */
export interface FinalArmsCustomEventPayload {
  name: string;
  type: "custom";
  group: string;
  value: number;
  properties: Record<string, string>;
}

/** Main-process in-memory record readable only by the E2E test bridge. */
export interface FinalArmsCustomEventE2EEntry {
  sequence: number;
  recordedAt: number;
  payload: FinalArmsCustomEventPayload;
}

export interface ConfigureFinalArmsCustomEventE2ERequest {
  /** Still enters the ring when matched, but does not call the real armsRum.sendCustom. */
  suppressedEventNames: string[];
}

/**
 * Before URL configuration enters product telemetry, extract only the hostname.
 * Invalid values and non-HTTP(S) schemes return an empty string, preventing full URLs, userinfo, or arbitrary text from entering the payload.
 */
export function resolveSafeTelemetryHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Raw errors may contain secrets in arbitrary formats; discard them entirely rather than guessing secret boundaries with regex. */
export function sanitizeTelemetryErrorMessage(value: string | null | undefined): string {
  return value ? "[redacted]" : "";
}

function sanitizeLoginHostname(value: string): string {
  const hostname = resolveSafeTelemetryHostname(value);
  if (hostname) return hostname;
  // Core must remain idempotent even when the UI has already extracted the hostname; accept only an exact hostname, not protocol-less paths or credentials.
  const normalized = value.trim().toLowerCase();
  return normalized && resolveSafeTelemetryHostname(`https://${normalized}`) === normalized
    ? normalized
    : "";
}

/** Sanitize only the reporting copy; do not modify business errors, authorization URLs, or caller-owned details. */
export function sanitizeTelemetryEventDetail(
  elementName: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      key === "error_msg"
        ? sanitizeTelemetryErrorMessage(value)
        : elementName === "app_login_ck" && key === "login_url"
          ? sanitizeLoginHostname(value)
          : value,
    ]),
  );
}

interface TelemetryScreenLike {
  width: number;
  height: number;
}

interface TelemetryWindowLike {
  intlLocale?: string;
  timeZone?: string;
  screen: TelemetryScreenLike;
}

export function collectTelemetryRendererContext(
  options?: TelemetryWindowLike,
): TelemetryRendererContext {
  const resolvedIntlOptions =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions() : undefined;
  const timeZone = options?.timeZone ?? resolvedIntlOptions?.timeZone ?? "UTC";
  const clientLanguage = options?.intlLocale ?? resolvedIntlOptions?.locale ?? "en-US";
  const runtimeScreen = (globalThis as { screen?: TelemetryScreenLike }).screen;
  const screen = options?.screen ?? runtimeScreen ?? { width: 0, height: 0 };

  return {
    clientTimezone: timeZone,
    clientLanguage,
    screenResolution: `${screen.width}x${screen.height}`,
  };
}
