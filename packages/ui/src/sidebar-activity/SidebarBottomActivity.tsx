import { MarketingBanner } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { useMarketingBannerVisible } from "@/components/marketing-touch/useMarketingBannerVisible.js";
import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

/**
 * Arbitration layer for the shared bottom-left activity slot: the only place in the UI that depends on
 * both the marketing-touch and global-notice systems, concentrating this coupling in a single point so
 * the two feature modules never import each other (avoiding a circular dependency).
 *
 * A pure read-only projection holding no state: while the claim-token banner is visible it owns the slot
 * and overlays on top; only after the banner disappears / closes does the same slot show the highspeed
 * share card. Priority: claim-token banner > highspeed global notice. When neither is visible,
 * GlobalNoticeSurface returns null and the slot produces no extra DOM.
 */
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  const bannerVisible = useMarketingBannerVisible();
  if (bannerVisible) return <MarketingBanner />;
  // Without injection, GlobalNoticeSurface falls back to its default browserGlobalNoticeStore.
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
