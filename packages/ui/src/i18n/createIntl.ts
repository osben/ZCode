import type { Locale } from "@zcode/shared";
import { FALLBACK_UI_LOCALE } from "@zcode/shared";

type MessageValues = Record<string, string | number>;
type MessageCatalog = Record<string, string>;

/** Lightweight intl utility: looks up translations by ID, supports {key} placeholders and explicit plural forms. */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: MessageValues): string;
  /**
   * Explicit plurals: the ID is the unsuffixed plural family name; choose `.one`/`.few`/`.many`/`.other` by each language's CLDR rules.
   * Automatically inject `{count}`; a count supplied in values takes precedence (preserving existing formatting such as grouping separators).
   */
  formatPlural(descriptor: { id: string }, count: number, values?: MessageValues): string;
}

const pluralRulesCache = new Map<Locale, Intl.PluralRules>();

function getPluralRules(locale: Locale): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

function interpolate(message: string, values: MessageValues | undefined): string {
  if (!values) {
    return message;
  }
  let result = message;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

/** Look up keys in [current language, English] order; fall back to English when a locale lacks a key instead of displaying the ID. */
export function createIntl(
  locale: Locale,
  catalogs: Partial<Record<Locale, MessageCatalog>>,
): IntlInstance {
  const chain = [...new Set<Locale>([locale, FALLBACK_UI_LOCALE])].flatMap((catalogLocale) => {
    const messages = catalogs[catalogLocale];
    return messages ? [{ locale: catalogLocale, messages }] : [];
  });

  function lookup(id: string): string | undefined {
    for (const { messages } of chain) {
      const message = messages[id];
      if (message !== undefined) {
        return message;
      }
    }
    return undefined;
  }

  return {
    formatMessage({ id }, values) {
      return interpolate(lookup(id) ?? id, values);
    },
    formatPlural({ id }, count, values) {
      const mergedValues = { count, ...values };
      for (const { locale: catalogLocale, messages } of chain) {
        // Plural categories are valid only within the same language: Ukrainian one also covers 21 and cannot select English one.
        const category = getPluralRules(catalogLocale).select(count);
        const message = messages[`${id}.${category}`] ?? messages[`${id}.other`];
        if (message !== undefined) {
          return interpolate(message, mergedValues);
        }
      }
      return `${id}.other`;
    },
  };
}
