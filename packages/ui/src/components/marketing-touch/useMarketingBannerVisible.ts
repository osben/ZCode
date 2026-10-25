import { useContext, useSyncExternalStore } from "react";
import { isMarketingBannerRenderable } from "@/components/marketing-touch/marketingTouchController.js";
import { MarketingTouchContext } from "@/components/marketing-touch/MarketingTouchProvider.js";

// When the controller is absent, use a noop subscription with a constant false snapshot, matching GlobalNoticeSurface's null-safe pattern.
const subscribeNoop = () => () => {};

/**
 * Read-only subscription for the arbiter (SidebarBottomActivity) to whether the bottom-left
 * claim-token banner is visible; the judgment source is still controller.store and this hook holds
 * no state of its own.
 */
export function useMarketingBannerVisible(): boolean {
  const controller = useContext(MarketingTouchContext);
  return useSyncExternalStore(
    controller ? controller.store.subscribe : subscribeNoop,
    () => (controller ? isMarketingBannerRenderable(controller.store.getState().banner) : false),
    () => false,
  );
}
