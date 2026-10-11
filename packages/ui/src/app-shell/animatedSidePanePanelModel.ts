export const MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX = 96;

export type OpenTabLauncherItemId =
  | "selection-side-conversation"
  | "review"
  | "terminal"
  | "browser"
  | "developer-tools";

export function resolveOpenTabLauncherItemIds({
  developerToolsEnabled,
  hasReviewTab,
  canOpenSelectionSideConversation = false,
  supportsEmbeddedBrowser = true,
}: {
  developerToolsEnabled: boolean;
  hasReviewTab: boolean;
  canOpenSelectionSideConversation?: boolean;
  supportsEmbeddedBrowser?: boolean;
}): OpenTabLauncherItemId[] {
  const itemIds: OpenTabLauncherItemId[] = [];

  if (canOpenSelectionSideConversation) {
    itemIds.push("selection-side-conversation");
  }

  if (!hasReviewTab) {
    itemIds.push("review");
  }

  itemIds.push("terminal");

  if (supportsEmbeddedBrowser) {
    itemIds.push("browser");
  }

  if (developerToolsEnabled) {
    itemIds.push("developer-tools");
  }

  return itemIds;
}

export function shouldOfferSelectionSideConversation({
  activeTaskId,
  isMobileTextInputViewport,
  mobileOverlay,
}: {
  activeTaskId: string | null;
  isMobileTextInputViewport: boolean;
  mobileOverlay: boolean;
}): boolean {
  return Boolean(activeTaskId && !mobileOverlay && !isMobileTextInputViewport);
}

export function resolveAnimatedSidePanePanelLayout({ mobileOverlay }: { mobileOverlay: boolean }) {
  if (mobileOverlay) {
    return {
      collapsedSize: "0px",
      defaultSize: "100%",
      maxSize: "100%",
      minSize: "0px",
      useResizablePanel: false,
    };
  }

  return {
    collapsedSize: "0px",
    defaultSize: "0px",
    maxSize: "65%",
    minSize: "240px",
    useResizablePanel: true,
  };
}

export function shouldRenderPreviewPaneHeavyContent({
  isActiveTab,
  isMediaPreview = false,
  isMobileOverlay = false,
  isResizeSettling = false,
  isSidePaneVisible,
  minVisibleInlineSizePx = MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
  visibleInlineSizePx,
}: {
  isActiveTab: boolean;
  isMediaPreview?: boolean;
  isMobileOverlay?: boolean;
  isResizeSettling?: boolean;
  isSidePaneVisible: boolean;
  minVisibleInlineSizePx?: number;
  visibleInlineSizePx: number | null;
}) {
  if (!isSidePaneVisible || !isActiveTab) {
    return false;
  }

  if (isMobileOverlay) {
    // Bugfix: The mobile remote-control side panel slides in as a transform drawer and may still be outside the viewport during its first measurement.
    // A transform animation does not trigger ResizeObserver when it ends, so do not use the desktop narrow-rail optimization to defer the actual preview.
    return true;
  }

  if (isResizeSettling) {
    // Native video/audio entering HTML fullscreen triggers resize. If the media node is unmounted then,
    // the browser exits fullscreen immediately because the fullscreen element disappeared.
    return isMediaPreview;
  }

  if (visibleInlineSizePx === null) {
    return true;
  }

  return visibleInlineSizePx >= minVisibleInlineSizePx;
}
