import { DEFAULT_LOCALE } from "./protocol.js";
import type { Locale, LocalePreference } from "./protocol.js";

/** 外部服务（官网、反馈、社区链接、Bot 文案）只支持中英文两种语言。 */
export type ServiceLocale = "zh-CN" | "en-US";

/** 无法匹配系统语言或缺少某语言资源时使用的界面语言。 */
export const FALLBACK_UI_LOCALE: Locale = "en-US";

interface LocaleMeta {
  languagePrefix: string;
  serviceLocale: ServiceLocale;
}

// Record<Locale, …>：扩展 Locale 时编译器会要求补充对应条目。
const LOCALE_META = {
  "zh-CN": { languagePrefix: "zh", serviceLocale: "zh-CN" },
  "en-US": { languagePrefix: "en", serviceLocale: "en-US" },
} satisfies Record<Locale, LocaleMeta>;

export const SUPPORTED_LOCALES = Object.keys(LOCALE_META) as Locale[];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(LOCALE_META, value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

/** BCP-47 / POSIX 语言标签 → 支持的界面语言；无法匹配返回 null。 */
export function matchSupportedLocale(tag: string | null | undefined): Locale | null {
  const normalized = tag?.trim().split(".")[0]?.replaceAll("_", "-").toLowerCase();
  if (!normalized) {
    return null;
  }
  const languagePrefix = normalized.split("-")[0];
  return (
    SUPPORTED_LOCALES.find((locale) => LOCALE_META[locale].languagePrefix === languagePrefix) ??
    null
  );
}

/** 系统语言标签 → 界面语言；未知语言回退英文，空标签回退 emptyFallback。 */
export function resolveSystemLocale(
  tag: string | null | undefined,
  emptyFallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (!tag) {
    return emptyFallback;
  }
  return matchSupportedLocale(tag) ?? FALLBACK_UI_LOCALE;
}

export function toServiceLocale(locale: Locale): ServiceLocale {
  return LOCALE_META[locale].serviceLocale;
}
