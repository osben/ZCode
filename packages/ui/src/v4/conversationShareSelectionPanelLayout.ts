/** Geometric constraints for the share-selection panel; CSS still adapts the panel content itself. */
export const CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX = 24;
export const CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX = 16;
/** Two candidate rows (48px each, 8px gap) plus 16px panel padding; below this height, the panel is unusable. */
export const CONVERSATION_SHARE_SELECTION_PANEL_MIN_HEIGHT_PX = 120;
export const CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY =
  "--conversation-share-selection-panel-max-height";
export const CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY =
  "--conversation-share-selection-panel-center-y";

export interface ConversationShareSelectionPanelLayoutInput {
  /** Session content container height, excluding WorkspaceHeader. */
  containerHeightPx: number;
  /** Top of the bottom composer/share dock, relative to the session content container. */
  dockStartPx: number;
}

export interface ConversationShareSelectionPanelLayout {
  centerYPx: number;
  maxHeightPx: number;
  topPx: number;
  bottomPx: number;
}

function normalizeSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Calculate the panel's maximum visible height and vertical anchor.
 *
 * When the panel contains little content, its actual height is determined by content measurement; this provides only max-height to prevent
 * its natural height from exceeding the bottom dock and covering the input area. The top baseline stays within the safe margin;
 * on a bottom collision, reduce only the panel's visible height while ScrollArea handles list scrolling.
 *
 * Do not use only `min(available container height, height above dock)`: in a short viewport or with a tall dock,
 * the latter approaches 0 and compresses the panel into an unusable sliver. Preserve a minimum height:
 * first reclaim the top safe margin, then allow overlap into the dock gap if needed, while never exceeding the container itself.
 */
export function resolveConversationShareSelectionPanelLayout({
  containerHeightPx,
  dockStartPx,
}: ConversationShareSelectionPanelLayoutInput): ConversationShareSelectionPanelLayout {
  const containerHeight = normalizeSize(containerHeightPx);
  const dockStart = Math.min(containerHeight, normalizeSize(dockStartPx));
  const unconstrainedMaxHeight = Math.max(
    0,
    containerHeight - CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX * 2,
  );
  const minHeight = Math.min(
    unconstrainedMaxHeight,
    CONVERSATION_SHARE_SELECTION_PANEL_MIN_HEIGHT_PX,
  );
  const top = Math.max(
    0,
    Math.min(
      CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX,
      dockStart - CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX - minHeight,
    ),
  );
  const availableHeight = Math.max(
    0,
    dockStart - CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX - top,
  );
  const maxHeight = Math.max(minHeight, Math.min(unconstrainedMaxHeight, availableHeight));

  return {
    centerYPx: top + maxHeight / 2,
    maxHeightPx: maxHeight,
    topPx: top,
    bottomPx: top + maxHeight,
  };
}

/** Write layout results to the shared parent container so the panel and Timeline use the same coordinate system. */
export function syncConversationShareSelectionPanelLayout(
  container: HTMLElement,
  dock: HTMLElement,
): ConversationShareSelectionPanelLayout {
  const containerRect = container.getBoundingClientRect();
  const dockRect = dock.getBoundingClientRect();
  const layout = resolveConversationShareSelectionPanelLayout({
    containerHeightPx: containerRect.height,
    dockStartPx: dockRect.top - containerRect.top,
  });
  const maxHeight = `${layout.maxHeightPx}px`;
  const centerY = `${layout.centerYPx}px`;

  if (
    container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY) !==
    maxHeight
  ) {
    container.style.setProperty(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY, maxHeight);
  }
  if (
    container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY) !==
    centerY
  ) {
    container.style.setProperty(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY, centerY);
  }

  return layout;
}
