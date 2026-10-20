import type { IntlInstance } from "./IntlProvider.js";

/**
 * Upstream's intl instance has no plural support, but upstream catalogs carry explicit plural
 * families (`<id>.one`, `<id>.few`, `<id>.many`, `<id>.other`). This helper picks the family member
 * with Intl.PluralRules and falls back to `<id>.other`, then to the bare `<id>`.
 * Temporary fork bridge (UI-1): the fork's `formatPlural` call sites use this helper until the i18n
 * PR reconciles fork keys. Recorded in specs/ui-upstream-sync-ledger.md.
 */
export function formatPluralMessage(
  intl: Pick<IntlInstance, "formatMessage">,
  id: string,
  count: number,
  values?: Record<string, string | number>,
): string {
  const category = new Intl.PluralRules().select(count);
  const withCount = { count, ...values };
  for (const candidate of [`${id}.${category}`, `${id}.other`, id]) {
    const message = intl.formatMessage({ id: candidate }, withCount);
    if (message !== candidate) {
      return message;
    }
  }
  return intl.formatMessage({ id }, withCount);
}
