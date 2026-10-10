import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";

/**
 * Resolve a marketplace id to a user-friendly display name:
 * prefer the name from the marketplaces overview, falling back to the raw id when missing.
 * Pure function so the catalog title bar and installed-source label can reuse the same naming logic.
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
): string {
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}
