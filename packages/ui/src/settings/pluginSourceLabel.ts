import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";
import { DEFAULT_MARKETPLACE_ID } from "@/settings/recommendedPlugins.js";

// Source value used for official plugins on the agent side; treat all others (such as inline local directories) as “Built in.”
// Note: plugins installed from a marketplace have source "cache"; their actual origin is in plugin.marketplace.
const MARKETPLACE_INSTALLED_SOURCE = "cache";

/**
 * Resolve a marketplace id to a user-friendly display name:
 * prefer the name from the marketplaces overview, falling back to the raw id when missing.
 * Pure function so the catalog title bar and installed-source label can reuse the same naming logic.
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  claudeCodePluginsLabel: string,
): string {
  if (marketplaceId === DEFAULT_MARKETPLACE_ID) {
    return claudeCodePluginsLabel;
  }
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}

/**
 * Source label for an installed plugin; there are only two categories:
 * - Installed from a marketplace (source==="cache") → “Installed from {marketplace name}”;
 * - Everything else (official/inline, etc.) → “Built in.”
 */
export function resolvePluginSourceLabel(input: {
  source: string;
  marketplace: string;
  marketplaces: readonly ZCodePluginMarketplaceSummary[];
  builtinLabel: string;
  claudeCodePluginsLabel: string;
  formatFromMarketplace: (marketplaceName: string) => string;
}): string {
  if (input.source !== MARKETPLACE_INSTALLED_SOURCE) {
    return input.builtinLabel;
  }
  const marketplaceName = resolveMarketplaceDisplayName(
    input.marketplace,
    input.marketplaces,
    input.claudeCodePluginsLabel,
  );
  return input.formatFromMarketplace(marketplaceName);
}
