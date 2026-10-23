import { logger } from "@/logger.js";
import {
  V4_PRIMARY_PANE_ID,
  effectiveFocusedPaneId,
  findPaneIdForSession,
  paneBindingMatchesSession,
  paneWorkspaceKey,
  usePaneLayoutStore,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import {
  buildWorkbenchSessionKey,
  useWorkbenchGroupStore,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";

export interface WorkbenchSessionTarget extends PaneWorkspaceScope {
  readonly sessionId: string;
  readonly readOnly?: boolean;
  readonly selectionSideChat?: boolean;
}

function targetBinding(target: WorkbenchSessionTarget): WorkbenchSessionBinding {
  const { sessionId, readOnly, selectionSideChat, ...workspaceScope } = target;
  return {
    workspaceScope,
    sessionId,
    ...(readOnly ? { readOnly: true } : {}),
    ...(selectionSideChat ? { selectionSideChat: true } : {}),
  };
}

function draftPrimaryOwnsLayout(shellBinding: WorkbenchSessionBinding | null): boolean {
  const layout = usePaneLayoutStore.getState();
  if (Object.keys(layout.panes).length === 0) {
    return false;
  }
  return (
    !shellBinding ||
    Object.values(layout.panes).some((binding) =>
      paneBindingMatchesSession(binding, shellBinding.workspaceScope, shellBinding.sessionId),
    )
  );
}

export function selectWorkbenchSession(
  shellBinding: WorkbenchSessionBinding | null,
  target: WorkbenchSessionTarget,
): void {
  const groups = useWorkbenchGroupStore.getState();
  const layout = usePaneLayoutStore.getState();
  const binding = targetBinding(target);
  if (
    !groups.activeGroupId &&
    !groups.sessionIndex[buildWorkbenchSessionKey(target, target.sessionId)] &&
    draftPrimaryOwnsLayout(shellBinding)
  ) {
    const existingPaneId = findPaneIdForSession(layout, target, target.sessionId);
    const paneId = existingPaneId ?? effectiveFocusedPaneId(layout);
    if (existingPaneId) {
      layout.focusPane(existingPaneId);
      const existingBinding = layout.panes[existingPaneId];
      if ((binding.readOnly || binding.selectionSideChat) && existingBinding) {
        layout.replacePaneBinding(existingPaneId, {
          workspaceScope: binding.workspaceScope,
          sessionId: binding.sessionId,
          ...(binding.readOnly ? { readOnly: true } : {}),
          ...(binding.selectionSideChat ? { selectionSideChat: true } : {}),
        });
      }
    } else if (paneId !== V4_PRIMARY_PANE_ID && layout.panes[paneId]) {
      const previousSessionId = layout.panes[paneId]?.sessionId ?? null;
      // Switching shell activeTaskId first would put the new session into the primary draft;
      // atomically replace the focused secondary pane's full binding first.
      layout.replacePaneBinding(paneId, {
        workspaceScope: binding.workspaceScope,
        sessionId: binding.sessionId,
        ...(binding.readOnly ? { readOnly: true } : {}),
        ...(binding.selectionSideChat ? { selectionSideChat: true } : {}),
      });
      logger.debug("[v4-workbench] draft split focused pane replaced", {
        paneId,
        previousSessionId,
        sessionId: binding.sessionId,
        workspaceKey: paneWorkspaceKey(binding.workspaceScope),
      });
    }
  }
  groups.openSessionFromSidebar(binding);
}
