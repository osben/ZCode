import type { Locale } from "@zcode/shared";
import type { ServiceLocale } from "@zcode/shared";

/**
 * Maps the UI locale to the two-locale type used by marketing, feedback, rewards and
 * coding-plan services. uk-UA has no service-side copy, so it uses the English copy.
 */
export function toServiceLocale(locale: Locale | null | undefined): ServiceLocale {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}
