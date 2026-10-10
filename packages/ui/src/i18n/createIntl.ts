import type { Locale } from "@zcode/shared";
import { FALLBACK_UI_LOCALE } from "@zcode/shared";

type MessageValues = Record<string, string | number>;
type MessageCatalog = Record<string, string>;

/** 简易 intl 工具：根据 id 查找翻译，支持 {key} 占位符替换与显式复数。 */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: MessageValues): string;
  /**
   * 显式复数：id 为不带后缀的复数族名，按各语言 CLDR 规则选择 `.one`/`.few`/`.many`/`.other`。
   * 自动注入 `{count}`；调用方在 values 里传入的 count 优先（保留千分位等既有格式）。
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

/** 依次在 [当前语言, 英文] 目录中查找；目录缺失某个 key 时回退英文，而不是直接展示 id。 */
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
        // 复数类别只在同一语言内有效：uk 的 one 也覆盖 21，不能拿去选英文的 one。
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
