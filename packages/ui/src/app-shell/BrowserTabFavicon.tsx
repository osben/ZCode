import { useState } from "react";
import { GlobeIcon } from "lucide-react";

function BrowserTabFaviconImage({ faviconUrl }: { faviconUrl: string }) {
  const [hasFailed, setHasFailed] = useState(false);

  if (hasFailed) return <GlobeIcon className="size-3.5" />;

  return (
    <img
      src={faviconUrl}
      alt=""
      className="size-3.5 rounded-sm object-contain"
      draggable={false}
      // When the renderer loads a guest favicon directly, it sends a localhost Referer.
      // Hotlink-protected CDNs return 403; disabling the referrer matches the guest page's successful request.
      referrerPolicy="no-referrer"
      onError={() => setHasFailed(true)}
    />
  );
}

/** Favicon shared by Browser and Browser Use; keep the globe placeholder stable if the request fails. */
export function BrowserTabFavicon({ faviconUrl }: { faviconUrl?: string | null }) {
  if (!faviconUrl) return <GlobeIcon className="size-3.5" />;

  return <BrowserTabFaviconImage key={faviconUrl} faviconUrl={faviconUrl} />;
}
