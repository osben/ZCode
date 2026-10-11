import { useCallback, type RefObject } from "react";
import {
  BROWSER_VIEW_RESTORE_BOOTSTRAP_URL,
  TID_BROWSER_WEBVIEW,
  type BrowserViewportSize,
} from "@zcode/shared";
import { TriangleAlertIcon } from "lucide-react";
import { ResponsiveBrowserViewport } from "@/browser-use/ResponsiveBrowserViewport.js";
import {
  resolveResponsiveBrowserGuestLayout,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import { cn } from "@/components/lib/utils.js";
import {
  BrowserEmptyState,
  BrowserGuestFailureState,
  BrowserLoadErrorState,
} from "@/EmbeddedBrowserPaneParts.js";
import {
  DEFAULT_BROWSER_URL,
  isCertificateBrowserLoadErrorCode,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

export function BrowserViewportSurface({
  browserRegionRef,
  browserState,
  desktopZoomFactor,
  isResidencyRestore,
  formatMessage,
  isEmptyBrowserState,
  isComposed,
  isResponsiveMode,
  isViewportEmulated = isResponsiveMode,
  onRetryGuest,
  onRetryLoad,
  onViewportResize,
  onViewportSizeChange,
  onWebviewRef,
  shouldMountWebview = true,
  showResizeWarning,
  webviewGeneration,
  viewportSize,
  viewportZoom,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  browserState: BrowserState;
  desktopZoomFactor: number;
  isResidencyRestore: boolean;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isEmptyBrowserState: boolean;
  isComposed: boolean;
  isResponsiveMode: boolean;
  isViewportEmulated?: boolean;
  onRetryGuest: () => void;
  onRetryLoad: () => void;
  onViewportResize: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  onWebviewRef: (node: ElectronWebviewTag | null) => void;
  shouldMountWebview?: boolean;
  showResizeWarning: boolean;
  webviewGeneration: number;
  viewportSize: BrowserViewportSize;
  viewportZoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { guestFailure } = browserState;
  // A guest process-level failure takes precedence over a load error: the former means there is no display at all, while the latter only means this navigation was rejected.
  const loadError = !guestFailure && browserState.errorMessage ? browserState.errorMessage : null;
  // A natural viewport has no metrics that lock its logical size; a temporary responsive frame does not mean the guest can expand.
  const responsiveGuestLayout = resolveResponsiveBrowserGuestLayout(desktopZoomFactor);
  const responsiveGuestLayoutScale = isViewportEmulated ? responsiveGuestLayout.layoutScale : 1;
  const responsiveGuestTransformScale = isViewportEmulated
    ? responsiveGuestLayout.transformScale
    : 1;
  const needsResponsiveGuestLayout = isResponsiveMode && responsiveGuestLayoutScale !== 1;
  const responsiveGuestLayoutSize = `calc(100% * ${responsiveGuestLayoutScale})`;
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      onWebviewRef(node);
    },
    [onWebviewRef],
  );

  return (
    <div
      ref={browserRegionRef}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {showResizeWarning ? (
        <div
          role="status"
          aria-live="polite"
          data-browser-resize-warning="visible"
          className="pointer-events-none absolute top-2 right-2 left-2 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-xl border border-popover-border bg-popover px-3 py-2 text-ui-base font-medium text-foreground shadow-md"
        >
          <span
            aria-hidden="true"
            data-browser-resize-warning-accent="visible"
            className="h-5 w-0.5 shrink-0 rounded-full bg-warning"
          />
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
          <span>{formatMessage({ id: "browser.resizeDuringOperationWarning" })}</span>
        </div>
      ) : null}
      <ResponsiveBrowserViewport
        active={isResponsiveMode}
        desktopZoomFactor={desktopZoomFactor}
        isComposed={isComposed}
        onResize={onViewportResize}
        onViewportSizeChange={onViewportSizeChange}
        viewportSize={viewportSize}
        zoom={viewportZoom}
      >
        {guestFailure ? (
          <BrowserGuestFailureState
            formatMessage={formatMessage}
            guestFailure={guestFailure}
            onRetry={onRetryGuest}
          />
        ) : loadError ? (
          <BrowserLoadErrorState
            errorMessage={loadError}
            formatMessage={formatMessage}
            isCertificateError={isCertificateBrowserLoadErrorCode(browserState.loadErrorCode)}
            onRetry={onRetryLoad}
          />
        ) : isEmptyBrowserState ? (
          <BrowserEmptyState
            key="empty-state"
            browserState={browserState}
            formatMessage={formatMessage}
            isGuestStarting={shouldMountWebview && !browserState.isReady}
          />
        ) : null}
        {/* The free-size toggle changes only the CSS dimensions of the stable frame; do not conditionally replace the webview’s parent hierarchy,
            or the Electron guest will be recreated and page history lost. Continue hiding the webview directly on a blank page so the empty state stays visible.
            Electron 41 also requires nodeintegrationinsubframes to be declared when creating the guest so child frames on real navigations load the fixed preload.
            If allowpopups is setAttribute’d in the ref callback, the guest is already attached and target=_blank is silently blocked at the
            Chromium permission boundary. React must output the string attribute before inserting the node; the type assertion only
            avoids a React DOM warning caused by @types/react modeling this Electron boolean attribute as a boolean.
            Increment generation only after the guest renderer crashes; ordinary switching/resizing must keep reusing the same node.
            When a new human tab and an about:blank guest mount in the same frame, Electron’s separate compositor surface
            may paint a white first frame before the host’s hidden style takes effect. Create the human guest only after navigation is confirmed;
            once created, keep the guest mounted stably. */}
        {shouldMountWebview ? (
          <webview
            key={`webview:${webviewGeneration}`}
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            src={isResidencyRestore ? BROWSER_VIEW_RESTORE_BOOTSTRAP_URL : DEFAULT_BROWSER_URL}
            partition="persist:zcode-embedded-browser"
            nodeintegrationinsubframes="true"
            data-browser-compositor-scale={isResponsiveMode ? desktopZoomFactor : undefined}
            data-browser-layout-scale={isResponsiveMode ? responsiveGuestLayoutScale : undefined}
            data-browser-transform-scale={
              isResponsiveMode ? responsiveGuestTransformScale : undefined
            }
            data-testid={TID_BROWSER_WEBVIEW}
            data-browser-resize-dimmed={showResizeWarning ? "true" : undefined}
            className={cn(
              "browser-use-viewport h-full min-h-0 w-full",
              isEmptyBrowserState || guestFailure || loadError ? "hidden" : "inline-flex",
            )}
            // Electron's separate `<webview>` guest surface composes page zoom asymmetrically: when zooming in,
            // the main process's CDP metrics scale corrects rasterization; when zooming out, expand the layout by 1 / zoom before scaling.
            // Absolute positioning keeps the compensation layout from affecting Fit's scroll extent.
            // This changes only host layout/composition; guest zoom, CSS viewport, DPR, and Browser Use readback remain unchanged.
            style={{
              // The web canvas uses white by default to match browser conventions. Set only the webview element's background here;
              // do not add an overlay or inject/override styles in the guest page.
              backgroundColor: "#fff",
              // Electron's guest surface may complete its first composition before the Tailwind hidden class applies,
              // causing a new tab to flash white for one frame; inline visibility during creation closes this timing gap.
              ...(isEmptyBrowserState ? { visibility: "hidden" as const } : {}),
              ...(isResponsiveMode
                ? {
                    ...(needsResponsiveGuestLayout
                      ? {
                          height: responsiveGuestLayoutSize,
                          left: 0,
                          position: "absolute" as const,
                          top: 0,
                          width: responsiveGuestLayoutSize,
                        }
                      : {}),
                    ...(responsiveGuestTransformScale !== 1
                      ? {
                          transform: `scale(${responsiveGuestTransformScale})`,
                          transformOrigin: "top left",
                        }
                      : {}),
                  }
                : {}),
            }}
          />
        ) : null}
      </ResponsiveBrowserViewport>
    </div>
  );
}
