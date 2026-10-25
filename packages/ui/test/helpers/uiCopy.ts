import type { Locale } from "@zcode/shared";
import enUS from "@/i18n/locales/en-US.js";

export const TEST_LOCALE: Locale = "en-US";

export function expectedCopy(key: string, values?: Record<string, string | number>): string {
  const message = enUS[key];
  if (message === undefined) {
    throw new Error(`Missing en-US UI copy for catalog key: ${key}`);
  }

  return Object.entries(values ?? {}).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    message,
  );
}
