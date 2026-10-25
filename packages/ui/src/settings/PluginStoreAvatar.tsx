import type { ReactNode } from "react";
import { PluginIcon } from "@/components/PluginIcon.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/**
 * Marketplace-entry avatar: prefer listing.icon (HTTPS only), falling back on load failure or absence to
 * a neutral Blocks icon inside a rounded-square `bg-surface` container. This avoids excess decorative color for Plugins without images
 * and matches the outer shape of real icons, preventing a circle/square shift on image-load failure.
 * The design asset is only the graphic; the semantic outer container provides the themed background. Applying
 * dark:invert to the full image would invert brand colors such as Android green, so retain the asset's original colors.
 */
export function PluginStoreAvatar({
  item,
  className,
  iconClassName,
  fallbackIcon,
}: {
  item: Pick<StorePluginItem, "name" | "listing"> & Partial<Pick<StorePluginItem, "id">>;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  return (
    <PluginIcon
      src={item.listing?.icon}
      pluginId={item.id}
      className={className}
      iconClassName={iconClassName}
      fallbackIcon={fallbackIcon}
    />
  );
}
