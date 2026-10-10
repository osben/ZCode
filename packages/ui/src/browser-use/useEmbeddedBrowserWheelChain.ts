import { useEffect, type RefObject } from "react";
import {
  EmbeddedBrowserWebviewChannels,
  type EmbeddedBrowserWheelBoundaryPayload,
} from "@zcode/shared";
import { logger } from "@/logger.js";

function validatedDelta(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Continue two-dimensional wheel scrolling from a guest that has reached its boundary into the free-size host canvas. */
export function useEmbeddedBrowserWheelChain({
  browserRegionRef,
  isResponsiveMode,
  webview,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  isResponsiveMode: boolean;
  webview: ElectronWebviewTag | null;
}): void {
  useEffect(() => {
    if (!webview) return;

    const handleGuestIpcMessage = (event: ElectronWebviewIpcMessageEvent): void => {
      if (!isResponsiveMode || event.channel !== EmbeddedBrowserWebviewChannels.WheelBoundary) {
        return;
      }
      const payload = event.args[0] as Partial<EmbeddedBrowserWheelBoundaryPayload> | undefined;
      // The IPC payload may omit fields or contain non-finite numbers, so do not pass it directly to the host canvas scroll handler.
      const deltaX = validatedDelta(payload?.deltaX);
      const deltaY = validatedDelta(payload?.deltaY);
      if (deltaX === 0 && deltaY === 0) return;

      const responsiveCanvas = browserRegionRef.current?.querySelector<HTMLElement>(
        '[data-responsive-browser-mode="active"]',
      );
      if (!responsiveCanvas) return;
      // Wheel events from an Electron `<webview>` guest do not bubble to the host DOM; the fixed preload
      // sends a message only when the page cannot consume more scrolling on that axis, and the outer free-size canvas continues the scroll chain here.
      responsiveCanvas.scrollBy({ behavior: "auto", left: deltaX, top: deltaY });
      // Wheel events are as frequent as message streams, so use debug only; production builds do not persist them.
      logger.debug("[browser-use] guest wheel 续接自由尺寸画布", {
        deltaX,
        deltaY,
        scrollLeft: responsiveCanvas.scrollLeft,
        scrollTop: responsiveCanvas.scrollTop,
      });
    };

    webview.addEventListener("ipc-message", handleGuestIpcMessage);
    return () => webview.removeEventListener("ipc-message", handleGuestIpcMessage);
  }, [browserRegionRef, isResponsiveMode, webview]);
}
