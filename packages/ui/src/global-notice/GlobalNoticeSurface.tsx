import { useEffect, useState, useSyncExternalStore } from "react";
import {
  browserGlobalNoticeStore,
  type GlobalNoticeStore,
} from "@/global-notice/globalNoticeStore.js";
import { HighspeedShareNoticeCard } from "@/highspeed/HighspeedShareNoticeCard.js";

const subscribeNoop = () => () => undefined;
const getNullSnapshot = () => null;

export function GlobalNoticeSurface({
  store = browserGlobalNoticeStore,
}: {
  store?: GlobalNoticeStore | null;
} = {}) {
  const [, refreshAtExpiry] = useState(0);
  const notice = useSyncExternalStore(
    store?.subscribe ?? subscribeNoop,
    store ? () => store.getVisible() : getNullSnapshot,
    getNullSnapshot,
  );

  useEffect(() => {
    if (notice?.expiresAt === undefined) return;
    const delayMs = Math.max(0, notice.expiresAt - Date.now()) + 20;
    // Bug root cause: expiresAt is only recomputed on store events, so while the page stays open
    // an expired card would remain on screen.
    const timer = window.setTimeout(() => refreshAtExpiry((revision) => revision + 1), delayMs);
    return () => window.clearTimeout(timer);
  }, [notice?.expiresAt, notice?.noticeId]);

  if (!notice) return null;

  if (notice.type === "highspeed-share" && notice.schemaVersion === 1) {
    return (
      <HighspeedShareNoticeCard notice={notice} onDismiss={() => store?.dismiss(notice.noticeId)} />
    );
  }

  // Unregistered notice types are safely ignored by the surface, preventing unknown payloads
  // from breaking the global sidebar.
  return null;
}
