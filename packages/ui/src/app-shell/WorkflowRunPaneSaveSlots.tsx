// "Save / run again" wiring for the run side pane's status header (docs/dynamic-workflow/transcript-and-notifications.md,
// "Saving the run, and running it again").
//
// Shares one controller with the completion card (mounted via `WorkflowRunSaveSlotsBoundary`), so the
// same run says the same thing in both places; the pane adds only two things: candidates are built from
// the **parent session's** row window, and the lead message is also sent into the parent session.
// This module only builds the host description and never calls the slot hooks directly: the controller
// needs the agent, so a host without service context must not mount it.
// Split out of WorkflowRunSidePane.tsx (max-lines 400 gate).
import { useCallback, useMemo, type ReactNode } from "react";
import type { ConversationRow, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  WorkflowRunSaveSlotsBoundary,
  type WorkflowRunSaveSlots,
  type WorkflowRunSaveSlotsHost,
} from "@/components/workflow-timeline/WorkflowRunSaveControls.js";
import type { WorkflowRunSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { buildWorkflowSaveCandidatesByRunId } from "@/v4/workflowRunCardJoin.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

interface WorkflowRunPaneSaveParams {
  /** The parent session's row window: SaveWorkflow candidates that claimed this run in the transcript are read from here. */
  rows: readonly ConversationRow[] | undefined;
  run: WorkflowRunState | undefined;
  tab: WorkflowRunSidePaneTab;
}

/** The two slots in the side pane's status header: build the host description, then mount the controller through the service boundary (yielding null without service context). */
export function WorkflowRunPaneSaveSlots({
  children,
  ...params
}: WorkflowRunPaneSaveParams & {
  children: (slots: WorkflowRunSaveSlots | null) => ReactNode;
}) {
  const host = useWorkflowRunPaneSaveHost(params);
  return <WorkflowRunSaveSlotsBoundary host={host}>{children}</WorkflowRunSaveSlotsBoundary>;
}

function useWorkflowRunPaneSaveHost(params: WorkflowRunPaneSaveParams): WorkflowRunSaveSlotsHost {
  const { rows, run, tab } = params;
  // Same gray-release gate (docs/dynamic-workflow/launch.md "Gray release") as Resume; the command
  // travels over the session connection the side pane lives on (the same sendCommand as Stop / Resume).
  const { enabled } = useDynamicWorkflowAvailability();
  const { sendCommand } = useV4Conversation();
  const candidates = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(rows).get(tab.runId),
    [rows, tab.runId],
  );
  const sendLead = useCallback(
    async (text: string) => {
      // Sent into the **parent session**: this run is an event within that conversation, and distilling
      // this round into a save belongs there too.
      const ack = await sendCommand(
        createCommandEnvelope({
          type: "sendText",
          payload: { text },
          sessionId: tab.parentSessionId,
        }),
      );
      if (ack.status !== "accepted") {
        logger.warn("[workflow-run] 交给 ZCode 提炼保存的那条消息被拒", {
          reasonCode: ack.reasonCode ?? null,
          runId: tab.runId,
          status: ack.status,
        });
        // Throw back to the popover: it stays in place and re-enables the button instead of pretending the handoff succeeded.
        throw new Error(ack.reasonCode ?? ack.status);
      }
    },
    [sendCommand, tab.parentSessionId, tab.runId],
  );
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity === undefined ? {} : { workspaceIdentity: tab.workspaceIdentity }),
    ...(tab.remoteSessionId === undefined ? {} : { remoteSessionId: tab.remoteSessionId }),
    runId: tab.runId,
    // Take the display name frozen on the tab: when the projection is absent (run evicted / cold
    // start) it is the only remaining source.
    ...(tab.workflowName?.trim() ? { runName: tab.workflowName.trim() } : {}),
    ...(candidates === undefined ? {} : { candidates }),
    // The verb applies only to completed runs — "save" means "what this run produced is worth
    // keeping", a conclusion that cannot be drawn while the run is still going. The chip is not
    // gated by this: it only reports whether the file exists on disk.
    canSave: enabled && run?.status === "completed",
    sendLead,
    // Buttons in the side pane's status header all carry words (Configure / Resume / Stop); this one does too.
    verbWord: "never",
  };
}
