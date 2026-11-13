export const MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX = 96;

/** Official plugin opened by the built-in Sites entry in "Open tab" (it has a single surface). */
export const SITES_PLUGIN_ID = "zcode-site@zcode-plugins-official";

export type OpenTabLauncherItemId =
  | "sites"
  | "selection-side-conversation"
  | "files"
  | "review"
  | "terminal"
  | "browser"
  | "model-trajectory"
  | "model-trajectory-v2"
  | "developer-tools";

export function resolveOpenTabLauncherItemIds({
  developerToolsEnabled,
  hasActiveTask,
  hasReviewTab,
  canOpenSelectionSideConversation = false,
  canOpenSites = false,
  supportsEmbeddedBrowser = true,
}: {
  developerToolsEnabled: boolean;
  /** Model trajectory is bound to the active task's side pane tab and has no draft fallback. */
  hasActiveTask: boolean;
  hasReviewTab: boolean;
  canOpenSelectionSideConversation?: boolean;
  canOpenSites?: boolean;
  supportsEmbeddedBrowser?: boolean;
}): OpenTabLauncherItemId[] {
  const itemIds: OpenTabLauncherItemId[] = ["files"];

  if (supportsEmbeddedBrowser) {
    itemIds.push("browser");
  }

  itemIds.push("terminal");

  if (!hasReviewTab) {
    itemIds.push("review");
  }

  // The Sites panel is the UI surface of the official zcode-site plugin; product requires it as a built-in entry before the side conversation.
  if (canOpenSites) {
    itemIds.push("sites");
  }

  if (canOpenSelectionSideConversation) {
    itemIds.push("selection-side-conversation");
  }

  if (hasActiveTask) {
    itemIds.push("model-trajectory");
    itemIds.push("model-trajectory-v2");
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
    // Bugfix: the mobile remote-control side pane slides in as a transform drawer and may still be
    // outside the viewport at first measurement. Transform animation end does not fire ResizeObserver,
    // so the desktop narrow-strip optimization cannot defer the real preview here.
    return true;
  }

  if (isResizeSettling) {
    // Native video/audio entering HTML fullscreen triggers a resize; if the media node is
    // unmounted at that moment, the browser exits fullscreen immediately because the fullscreen element is gone.
    return isMediaPreview;
  }

  if (visibleInlineSizePx === null) {
    return true;
  }

  return visibleInlineSizePx >= minVisibleInlineSizePx;
}
