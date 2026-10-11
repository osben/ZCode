import type { ZCodePluginStoreListing } from "./zcode-protocol/index.js";

const CANONICAL_PLUGIN_NAME_ACRONYMS: Readonly<Record<string, string>> = {
  aws: "AWS",
  mcp: "MCP",
  zcode: "ZCode",
};

/** Match localized listing fields exactly first, then fall back to the language prefix. */
export function resolveLocalizedText(
  locale: string,
  base: string | undefined,
  i18n: Record<string, string> | undefined,
): string | undefined {
  if (i18n) {
    const exact = i18n[locale];
    if (exact) return exact;
    const language = locale.split("-")[0];
    if (language) {
      const match = Object.entries(i18n).find(([key]) => key.split("-")[0] === language);
      if (match?.[1]) return match[1];
    }
  }
  return base;
}

export function formatCanonicalPluginName(name: string, locale: string): string {
  return name
    .trim()
    .split(/[-_]+/u)
    .filter(Boolean)
    .map(
      (part) =>
        CANONICAL_PLUGIN_NAME_ACRONYMS[part.toLowerCase()] ??
        `${part.charAt(0).toLocaleUpperCase(locale)}${part.slice(1)}`,
    )
    .join(" ");
}

/**
 * Trust user-visible plugin names only from listings associated with the full Plugin ID;
 * fall back to the canonical slug only when no listing is available. Do not infer official
 * product names from a bare manifest name, which could cause same-named marketplace plugins
 * to overwrite one another.
 */
export function resolvePluginDisplayName(
  plugin: { name: string; listing?: ZCodePluginStoreListing },
  locale: string,
): string {
  return (
    resolveLocalizedText(locale, plugin.listing?.displayName, plugin.listing?.displayNameI18n) ??
    formatCanonicalPluginName(plugin.name, locale)
  );
}
