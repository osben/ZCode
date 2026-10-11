export function resolveConversationSelectionTooltipEnabled({
  selectionActionsEnabled,
  partialShareActive,
}: {
  selectionActionsEnabled: boolean;
  partialShareActive: boolean;
}): boolean {
  // The local selection overlay changed only visual layering and did not disable the global Selection listener,
  // so underlying messages could still trigger the cross-feature toolbar. Selection mode must own message-selection interaction exclusively.
  return selectionActionsEnabled && !partialShareActive;
}

export function resolveConversationShareBackgroundScrollLocked({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // The selection panel used only a scrim to isolate body pointer events, while timeline remained
  // overflow-y-auto; background scrollbar and keyboard scrolling could still change scrollTop.
  return resolveConversationShareSelectionPanelVisible({ partialShareActive, stage, view });
}

export function resolveConversationShareSelectionPanelVisible({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // The visual overlay used to be bound to the entire partial scope and stayed active after the panel collapsed,
  // requiring local text to be raised as a workaround to fake “location complete.” Tie the overlay's lifecycle to panel visibility.
  return partialShareActive && stage === "selection" && view === "selection";
}
