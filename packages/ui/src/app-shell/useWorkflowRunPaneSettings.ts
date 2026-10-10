// ============================================================
// “Configure” on the detail page.
// ============================================================
// Split from WorkflowRunSidePane.tsx to meet the max-lines rule: dialog host, toggle and anchor, plus the behavior after Apply is accepted:
// “keep the pane attached to the workflow” — as soon as the new run enters the projection, replace this tab in place with the new run's tab (same position, same name,
// without expanding a collapsed sidebar). Wait for the fact that the new run appears in the projection, not for a timeout.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionConfigState, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  useWorkflowRunSettingsPopoverState,
  type WorkflowRunSettingsAccepted,
  type WorkflowRunSettingsHost,
} from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import {
  isWorkflowRunConfigurable,
  workflowSessionModelOf,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { useV4Conversation } from "@/v4/V4ConversationContext.js";

/** Workspace scope for a run tab; preserve it when opening other tabs (actor, script, artifact, successor). */
export function workflowRunTabScope(
  tab: Pick<WorkflowRunSidePaneTab, "workspacePath" | "workspaceIdentity" | "remoteSessionId">,
): Pick<
  OpenScopedWorkflowRunSideTabRequest,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId"
> {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
  };
}

export function useWorkflowRunPaneSettings({
  enabled,
  onOpenWorkflowRun,
  run,
  runs,
  sendCommand,
  sessionConfig,
  tab,
}: {
  /** Feature rollout gate (same one as Resume). */
  enabled: boolean;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  run: WorkflowRunState | undefined;
  runs: readonly WorkflowRunState[] | undefined;
  sendCommand: ReturnType<typeof useV4Conversation>["sendCommand"];
  sessionConfig: SessionConfigState | undefined;
  tab: WorkflowRunSidePaneTab;
}) {
  const configurable = enabled && isWorkflowRunConfigurable(run);
  const popover = useWorkflowRunSettingsPopoverState();
  // If the run becomes non-configurable while the dialog is open (completed or superseded), unmount the dialog and close the toggle too — otherwise the dialog will reappear
  // if the run returns to a configurable state. setOpen(false) is a no-op when already closed, so it does not create an update loop.
  const { setOpen } = popover;
  useEffect(() => {
    if (!configurable) setOpen(false);
  }, [configurable, setOpen]);
  const sessionModel = useMemo(() => workflowSessionModelOf(sessionConfig), [sessionConfig]);
  const host = useMemo<WorkflowRunSettingsHost>(
    () => ({
      ...workflowRunTabScope(tab),
      ...(sessionModel === undefined ? {} : { sessionModel }),
      // Same as Stop / Resume: do not include baseRevision; workId ≡ runId.
      apply: (change) =>
        sendCommand(
          createCommandEnvelope({
            type: "amendWorkflowRunSettings",
            payload: { workId: tab.runId, ...change },
            sessionId: tab.parentSessionId,
          }),
        ),
    }),
    [
      sendCommand,
      sessionModel,
      tab.parentSessionId,
      tab.remoteSessionId,
      tab.runId,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );

  // Follow: the new run may not yet be in the projection when accepted (run-started arrives later), so record it now and replace the tab when it appears.
  const [follow, setFollow] = useState<WorkflowRunSettingsAccepted | undefined>(undefined);
  // An in-place revision (only changes concurrency while the run remains active) has no successor;
  // its result runId is this tab itself, so there is nothing to follow and recording it would only request replacing the tab with itself.
  const onAccepted = useCallback(
    (accepted: WorkflowRunSettingsAccepted) => {
      if (accepted.runId !== tab.runId) setFollow(accepted);
    },
    [tab.runId],
  );
  const successorArrived =
    follow !== undefined && (runs ?? []).some((candidate) => candidate.runId === follow.runId);
  useEffect(() => {
    if (follow === undefined || !successorArrived) return;
    setFollow(undefined);
    onOpenWorkflowRun?.({
      ...workflowRunTabScope(tab),
      parentSessionId: tab.parentSessionId,
      toolCallId: follow.toolCallId,
      runId: follow.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
      replaceRunId: tab.runId,
    });
  }, [
    follow,
    onOpenWorkflowRun,
    successorArrived,
    tab.parentSessionId,
    tab.remoteSessionId,
    tab.runId,
    tab.workflowName,
    tab.workspaceIdentity,
    tab.workspacePath,
  ]);

  return {
    configurable,
    host,
    onAccepted,
    popover,
  };
}
