import { DEFAULT_LOCALE } from "./protocol.js";
import type { Locale, LocalePreference } from "./protocol.js";

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
  "uk-UA": { languagePrefix: "uk", serviceLocale: "en-US" },
} satisfies Record<Locale, LocaleMeta>;

export const SUPPORTED_LOCALES = Object.keys(LOCALE_META) as Locale[];

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

export function toServiceLocale(locale: Locale): ServiceLocale {
  return LOCALE_META[locale].serviceLocale;
}
