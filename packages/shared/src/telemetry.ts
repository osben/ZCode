import { z } from "zod";
import { redactTelemetryText } from "./telemetryRedaction.js";

const pluginDimensionEnums: Record<string, readonly string[]> = {
  schema_version: ["1"],
  result: ["success", "failure", "cancelled", "noop", "partial"],
  source_type: ["builtin", "official_cdn", "personal", "unknown"],
  publisher_type: ["official", "community", "unknown"],
  entry: [
    "store_list",
    "store_detail",
    "side_pane_market",
    "recommended_prompt",
    "recommended_ui",
    "component_settings",
    "unknown",
  ],
  trigger: ["user", "dependency", "automatic", "restore", "sync"],
  scope: ["user", "workspace", "unknown"],
  client_kind: ["desktop", "mobile", "unknown"],
  workspace_kind: ["local", "remote"],
  remote_kind: ["", "ssh", "wsl", "docker", "server"],
  error_category: ["diagnostic", "transport", "timeout", "cancelled", "unknown"],
  plugin_component: ["skill", "mcp", "agent", "command", "hook", "lsp", "ui"],
  remove_cache: ["true", "false", "unknown"],
  action: [
    "install",
    "uninstall",
    "update",
    "restore",
    "enable",
    "disable",
    "configure",
    "reset_config",
    "source_add",
    "source_remove",
    "source_refresh",
    "sync",
    "store_view",
    "detail_view",
    "search",
    "ui_open_request",
    "ui_ready",
    "ui_close",
    "ui_tool_call",
  ],
};
const pluginIdentifierKeys = new Set([
  "plugin_id",
  "marketplace",
  "version_before",
  "version_after",
  "batch_id",
]);
const pluginNumericKeys = new Set(["duration_ms", "target_count", "result_count"]);
export const PLUGIN_TELEMETRY_EVENTS = [
  "plugin_lifecycle",
  "plugin_discovery",
  "plugin_usage",
  "plugin_runtime_error",
] as const;

/** 只清洗上报副本；拒绝任意配置/URL/路径和自由错误文本。 */
export function sanitizePluginTelemetryDetail(
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).filter(([key, value]) => {
      if (pluginDimensionEnums[key]) return pluginDimensionEnums[key].includes(value);
      if (pluginNumericKeys.has(key)) return /^\d{1,15}$/.test(value);
      return (
        pluginIdentifierKeys.has(key) &&
        value.length <= 256 &&
        /^[A-Za-z0-9@._+:-]+$/.test(value) &&
        redactTelemetryText(value) === value
      );
    }),
  );
}

/** 手机只转发发现行为；管理结果由同一个 Desktop Host 产生。 */
export const mobilePluginDiscoveryTelemetrySchema = z
  .object({
    elementName: z.literal("plugin_discovery"),
    eventRegion: z.literal("app"),
    eventType: z.literal("view"),
    context: z
      .object({
        clientTimezone: z.string().max(128),
        clientLanguage: z.string().max(128),
        screenResolution: z.string().max(64),
      })
      .strict(),
    eventExtraDetail: z
      .object({
        schema_version: z.literal("1"),
        action: z.enum(["store_view", "detail_view", "search"]),
        entry: z.enum(["store_list", "store_detail", "side_pane_market"]),
        client_kind: z.literal("mobile"),
        plugin_id: z
          .string()
          .regex(/^[A-Za-z0-9@._+:-]+$/)
          .max(256)
          .optional(),
        result_count: z
          .string()
          .regex(/^\d{1,15}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type MobilePluginDiscoveryTelemetry = z.infer<typeof mobilePluginDiscoveryTelemetrySchema>;

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

const MAX_TELEMETRY_SKILL_NAME_LENGTH = 64;
const TELEMETRY_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * 只用于已解析的 Skill 名称，不能据此信任模型请求参数。
 * 不 trim 或截断，以免把敏感文本残片变成看似合法的标识；出网时再次检查同一规则。
 */
export function sanitizeTelemetrySkillName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TELEMETRY_SKILL_NAME_LENGTH ||
    !TELEMETRY_SKILL_NAME_PATTERN.test(value) ||
    redactTelemetryText(value) !== value
  ) {
    return "unknown";
  }
  return value;
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
  if ((PLUGIN_TELEMETRY_EVENTS as readonly string[]).includes(elementName))
    return sanitizePluginTelemetryDetail(detail);
  return Object.fromEntries(
    Object.entries(detail)
      .filter(
        ([key, value]) =>
          elementName !== "agent_step" ||
          (key !== "plugin_id" && key !== "plugin_component") ||
          key in sanitizePluginTelemetryDetail({ [key]: value }),
      )
      .map(([key, value]) => [
        key,
        key === "error_msg"
          ? sanitizeTelemetryErrorMessage(value)
          : key === "skill_name"
            ? sanitizeTelemetrySkillName(value)
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
