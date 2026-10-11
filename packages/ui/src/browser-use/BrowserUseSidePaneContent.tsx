import type { BrowserViewScreenshotSurfacePreparePayload } from "@zcode/shared";
import type { CSSProperties } from "react";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import { cn } from "@/components/lib/utils.js";
import { TabsContent } from "@/components/ui/tabs.js";
import type { BrowserSidePaneMetadata, BrowserUseSidePaneTab } from "@/lib/workspaceSidePane.js";

export interface BrowserUseSidePaneContentProps {
  tab: BrowserUseSidePaneTab;
  onOpenPermissionSettings?: (origin: string) => void;
  isPanelVisible: boolean;
  isSelected: boolean;
  isCurrentTask: boolean;
  screenshotSurfaceRequest: BrowserViewScreenshotSurfacePreparePayload | null;
  initialUrl?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  residencyGeneration?: number;
  onUrlChange(url: string): void;
  onPageMetadataChange(metadata: BrowserSidePaneMetadata): void;
}

/** TabsContent dedicated to browser-use: keep its real compositing layout for an inactive tab only while preparing a screenshot. */
export function BrowserUseSidePaneContent({
  tab,
  onOpenPermissionSettings,
  isPanelVisible,
  isSelected,
  isCurrentTask,
  screenshotSurfaceRequest,
  initialUrl,
  workspacePath,
  workspaceIdentity,
  residencyGeneration,
  onUrlChange,
  onPageMetadataChange,
}: BrowserUseSidePaneContentProps): React.JSX.Element {
  // The screenshot surface cannot rely on a collapsed ResizablePanel for its dimensions: when the panel width is 0, Electron
  // Chromium treats the guest as having no compositor surface and capturePage fails. Temporarily pin the same
  // TabsContent to a composited layer inside the window and isolate it visually with near-zero opacity; moving it entirely outside the window
  // makes Viz treat it as offscreen and continue returning UnknownVizError. It does not participate in the right-side layout or unmount the guest.
  const screenshotSurfaceStyle: CSSProperties | undefined = screenshotSurfaceRequest
    ? {
        position: "fixed",
        left: 0,
        top: 0,
        // When the pinned layer exceeds the window, Fit assumes the viewport can be fully shown; on Windows high-DPI displays,
        // Chromium clips guest raster outside the visible area, and normalizing the native screenshot then stretches it horizontally.
        // Cap it at the host window so Fit scales to the actually visible canvas while preserving the logical viewport and user preference.
        width: `${screenshotSurfaceRequest.viewport.width}px`,
        height: `${screenshotSurfaceRequest.viewport.height + 48}px`,
        maxWidth: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vw",
        maxHeight: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vh",
        pointerEvents: "none",
        // opacity=0 makes Chromium discard the guest layer; 0.001 keeps the compositor surface while remaining visually invisible.
        opacity: 0.001,
      }
    : undefined;

  return (
    <TabsContent
      value={tab.id}
      forceMount
      aria-hidden={!isSelected}
      inert={!isSelected ? true : undefined}
      data-browser-use-tab-id={tab.tabId}
      data-browser-screenshot-surface-state={screenshotSurfaceRequest ? "preparing" : undefined}
      className={cn(
        "h-full min-h-0 bg-background",
        isSelected
          ? "relative z-10 flex"
          : screenshotSurfaceRequest
            ? "pointer-events-none fixed z-0 flex overflow-hidden"
            : "hidden",
      )}
      style={screenshotSurfaceStyle}
    >
      <UnifiedBrowserView
        browserKey={tab.tabId}
        onOpenPermissionSettings={onOpenPermissionSettings}
        isResidencyRestore={tab.residency === "restoring"}
        isVisible={isPanelVisible && isSelected}
        isSelected={isSelected}
        isCurrentTask={isCurrentTask}
        screenshotSurfaceRequest={screenshotSurfaceRequest}
        initialUrl={initialUrl}
        faviconUrl={tab.faviconUrl}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceKey={tab.workspaceKey ?? (workspaceIdentity?.trim() || workspacePath)}
        remoteSessionId={tab.remoteSessionId ?? undefined}
        sessionId={tab.sessionId}
        residencyGeneration={tab.residencyGeneration ?? residencyGeneration}
        browserUseOperationUntil={tab.browserUseOperationUntil}
        browserResizeBaselineVersion={tab.browserUseResizeBaselineVersion}
        onUrlChange={onUrlChange}
        onPageMetadataChange={onPageMetadataChange}
      />
    </TabsContent>
  );
}
