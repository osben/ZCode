import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type Locale,
  type LocalePreference,
} from "./protocol.js";

/** Native name of each language, used by the language picker; not part of the i18n string table, so it shows in any UI language. */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  "zh-CN": "中文简体",
  "en-US": "English",
  "ja-JP": "日本語",
  "ru-RU": "Русский",
  "ko-KR": "한국어",
  "uk-UA": "Українська",
};

/** External services (website, feedback, community links, Bot copy) support only English and Chinese. */
export type ServiceLocale = "zh-CN" | "en-US";

/** UI language used when the system language cannot be matched or a language resource is missing. */
export const FALLBACK_UI_LOCALE: Locale = "en-US";

interface LocaleMeta {
  languagePrefix: string;
  serviceLocale: ServiceLocale;
}

// Record<Locale, …>: the compiler requires a matching entry whenever Locale is extended.
const LOCALE_META = {
  "zh-CN": { languagePrefix: "zh", serviceLocale: "zh-CN" },
  "en-US": { languagePrefix: "en", serviceLocale: "en-US" },
  "ja-JP": { languagePrefix: "ja", serviceLocale: "en-US" },
  "ru-RU": { languagePrefix: "ru", serviceLocale: "en-US" },
  "ko-KR": { languagePrefix: "ko", serviceLocale: "en-US" },
  "uk-UA": { languagePrefix: "uk", serviceLocale: "en-US" },
} satisfies Record<Locale, LocaleMeta>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(LOCALE_META, value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

/** BCP-47 / POSIX language tag → supported UI language; returns null when there is no match. */
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

/** System language tag → UI language; unknown languages fall back to English, and empty tags fall back to emptyFallback. */
export function resolveSystemLocale(
  tag: string | null | undefined,
  emptyFallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (!tag) {
    return emptyFallback;
  }
  return matchSupportedLocale(tag) ?? FALLBACK_UI_LOCALE;
}

/**
 * Maps a system/browser language tag (such as navigator.language, app.getLocale(), or an Intl locale) to a supported UI language.
 * "Follow system" goes through here: zh*→zh-CN, ja*→ja-JP, ru*→ru-RU, ko*→ko-KR, uk*→uk-UA; anything else and empty values→en-US.
 * Each call site used to write `startsWith("zh") ? "zh-CN" : "en-US"` on its own, which made it easy to miss a language when adding one.
 */
export function resolveLocaleFromLanguageTag(tag: string | null | undefined): Locale {
  const lower = tag?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  const primary = lower.split("-")[0] ?? "";
  switch (primary) {
    case "zh":
      return "zh-CN";
    case "ja":
      return "ja-JP";
    case "ru":
      return "ru-RU";
    case "ko":
      return "ko-KR";
    case "uk":
      return "uk-UA";
    default:
      return "en-US";
  }
}

/**
 * Use only for scenarios that have just Chinese and English content (official site and doc links, server contracts that return only
 * Chinese or English content, bot messages, and so on): Chinese maps to Chinese, and every other language maps to English. Note that X-Client-Language does not use this; its header must carry the real UI language.
 */
export function toZhOrEnLocale(locale: Locale | null | undefined): "zh-CN" | "en-US" {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

export function toServiceLocale(locale: Locale): ServiceLocale {
  return LOCALE_META[locale].serviceLocale;
}

/*
 * ---- setting.json 界面语言存储格式（降级兼容） ----
 *
 * 原因：v3.17.x 及更早版本的设置 schema 是 `locale: z.enum(["zh-CN","en-US"])`、
 * `localePreference: z.enum(["system","zh-CN","en-US"])` 且没有 catch；读到 ja-JP 等新值时
 * safeParse 失败，settingService 会把**整份设置**当默认值返回，下一次任意写入还会把默认值写回磁盘。
 * 降级或测试版/正式版共用 setting.json 时就会丢光全部设置。
 *
 * 所以落盘时：
 * - 旧字段 `locale` / `localePreference` 只写旧版本认识的值（中英或 system）；
 * - 新字段 `uiLocale` / `uiLocalePreference` 保存真实选择（旧版本 z.object 默认 strip，会忽略它们）。
 * 读取时新字段优先，缺失或与旧字段对不上时才回落旧字段。内存里的 AppSettings.locale /
 * localePreference 始终是真实语言，所以 X-Client-Language 等消费方不需要感知这层转换。
 * 详见 docs/i18n/ui-locales.md「setting.json 存储格式与降级兼容」。
 */
/** 旧版本（v3.17.x 及更早）设置 schema 能识别的 locale 值。 */
export type LegacyPersistedLocale = "zh-CN" | "en-US";
/** 旧版本设置 schema 能识别的 localePreference 值。 */
export type LegacyPersistedLocalePreference = "system" | LegacyPersistedLocale;

/** setting.json 中与界面语言相关的落盘字段。 */
export interface PersistedSettingsLocaleFields {
  /** 旧字段：只存中英，保证旧版本能解析。 */
  locale: LegacyPersistedLocale;
  /** 旧字段：只存 system/中/英。 */
  localePreference: LegacyPersistedLocalePreference;
  /** 新字段：真实界面语言。 */
  uiLocale: Locale;
  /** 新字段：真实界面语言偏好。 */
  uiLocalePreference: LocalePreference;
}

/**
 * localePreference 写入旧字段时的降级值：system/中/英照写，其它语言写 en-US。
 * 不降级成 system：旧版本跟随系统时会把解析出的中/英写回 locale，中文系统上会变成中文，
 * 离用户「选了非中文语言」的意图更远；en-US 与 locale 的降级值一致，也是新语言的文案回退语言。
 */
export function toLegacyPersistedLocalePreference(
  preference: LocalePreference,
): LegacyPersistedLocalePreference {
  return preference === "system" ? "system" : toZhOrEnLocale(preference);
}

/**
 * 内存设置 → setting.json 落盘字段。settingService 写盘的唯一入口。
 * localePreference 缺失（AppSettings 类型上可选）时不写偏好字段，保持原有「缺失即 system」语义。
 */
export function toPersistedSettingsLocaleFields(settings: {
  locale: Locale;
  localePreference?: LocalePreference;
}): Pick<PersistedSettingsLocaleFields, "locale" | "uiLocale"> &
  Partial<Pick<PersistedSettingsLocaleFields, "localePreference" | "uiLocalePreference">> {
  return {
    locale: toZhOrEnLocale(settings.locale),
    uiLocale: settings.locale,
    ...(settings.localePreference === undefined
      ? {}
      : {
          localePreference: toLegacyPersistedLocalePreference(settings.localePreference),
          uiLocalePreference: settings.localePreference,
        }),
  };
}

/**
 * setting.json 原始字段 → 真实界面语言（新字段优先）。
 *
 * 新字段只有在「降级后等于旧字段」时才采信：旧版本会 strip 掉新字段，正常不会出现不一致；
 * 若用户手改了旧字段（或未来某个只认旧字段的写入者改了它），以旧字段为准，避免新字段把它盖回去。
 * 旧字段缺失时直接用新字段。旧字段本身是 ja-JP 等新值（本特性开发期间内部测试写入）时照常识别，
 * 下次写盘由 toPersistedSettingsLocaleFields 迁移成新格式。
 */
export function resolvePersistedUiLocale(raw: Record<string, unknown>): unknown {
  const { uiLocale, locale } = raw;
  if (isLocale(uiLocale) && (locale === undefined || toZhOrEnLocale(uiLocale) === locale)) {
    return uiLocale;
  }
  return locale;
}

/** 同 resolvePersistedUiLocale，作用于 localePreference / uiLocalePreference。 */
export function resolvePersistedUiLocalePreference(raw: Record<string, unknown>): unknown {
  const { uiLocalePreference, localePreference } = raw;
  if (
    isLocalePreference(uiLocalePreference) &&
    (localePreference === undefined ||
      toLegacyPersistedLocalePreference(uiLocalePreference) === localePreference)
  ) {
    return uiLocalePreference;
  }
  return localePreference;
}

/** 旧字段里是否存着旧版本不认识的值（需要尽快迁移写盘，否则降级会重置全部设置）。 */
export function hasLegacyIncompatiblePersistedLocale(raw: Record<string, unknown>): boolean {
  const { locale, localePreference } = raw;
  return (
    (locale !== undefined && locale !== "zh-CN" && locale !== "en-US") ||
    (localePreference !== undefined &&
      localePreference !== "system" &&
      localePreference !== "zh-CN" &&
      localePreference !== "en-US")
  );
}
