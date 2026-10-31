import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeElicitationRequest, ZCodePermissionOption, ZCodeProvider } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { workflowSessionModelOf } from "@/components/workflow-timeline/workflowRunSettings.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePendingInteractionTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { logger } from "@/logger.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  getTaskUiState,
  getWorkspaceState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";
import {
  pendingPermissionToLegacyRequest,
  pendingUserInputToElicitationRequest,
  pendingUserInputToViewModel,
} from "@/v4/pendingInteractionAdapter.js";
import { V4UserInputDialog } from "@/v4/V4UserInputDialog.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

export interface V4InteractionDialogsProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  isWebRemoteControl?: boolean;
  provider?: ZCodeProvider;
  snapshot: ConversationSnapshot | null;
  onCommandSettled?: (commandId: string) => void;
  onPlanInteractionAccepted?: (interactionId: string) => void;
}

export function getCurrentSessionInteractionSnapshot(
  sessionId: string,
  snapshot: ConversationSnapshot | null,
): ConversationSnapshot | null {
  return snapshot?.sessionId === sessionId ? snapshot : null;
}

export function resolveV4ElicitationRequest(
  projected: ZCodeElicitationRequest | null,
  botProgress: ZCodeElicitationRequest | null,
): ZCodeElicitationRequest | null {
  // Bug fix: the V4 snapshot retains only the original blocking request, so per-question progress after a Bot answer must override that request's projection.
  if (projected && botProgress?.requestId === projected.requestId) {
    return botProgress;
  }
  return projected;
}

export function buildV4ElicitationProgressKey(request: ZCodeElicitationRequest): string {
  return `${request.requestId}:${request.currentQuestionIndex ?? 0}:${JSON.stringify(request.answerDrafts ?? {})}`;
}

export interface InteractionAutoResolutionIntentTracker {
  markInteracted(interactionId: string): void;
  consumeSnooze(interactionId: string, autoResolutionReady: boolean): boolean;
  releaseSnooze(interactionId: string): void;
}

export function createInteractionAutoResolutionIntentTracker(): InteractionAutoResolutionIntentTracker {
  const interactedIds = new Set<string>();
  const sentIds = new Set<string>();
  return {
    markInteracted(interactionId) {
      interactedIds.add(interactionId);
    },
    consumeSnooze(interactionId, autoResolutionReady) {
      if (!autoResolutionReady || !interactedIds.has(interactionId) || sentIds.has(interactionId)) {
        return false;
      }
      sentIds.add(interactionId);
      return true;
    },
    releaseSnooze(interactionId) {
      sentIds.delete(interactionId);
    },
  };
}

/**
 * Vertical slice: connect projection.pendingInteractions to PermissionDialog/userInput dialogs.
 * Without this component after ChatView removal, conversations with tool permissions would remain blocked forever.
 */
export function V4InteractionDialogs({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isWebRemoteControl = false,
  provider,
  snapshot,
  onCommandSettled,
  onPlanInteractionAccepted,
}: V4InteractionDialogsProps) {
  const { sendCommand } = useV4Conversation();
  const connectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.connect);
  const disconnectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.disconnect);
  const upsertWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.upsert);
  const clearWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.clear);
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  // On task switch, sessionId updates first and the old task snapshot may remain for one frame.
  // Using the old snapshot directly would mark the current task's renderer-local question draft as stale and clear it.
  const currentSnapshot = getCurrentSessionInteractionSnapshot(sessionId, snapshot);
  // Name of the “Session model” item in the workflow confirmation dialog (same source as the run card’s “Configure” popover).
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(currentSnapshot?.config),
    [currentSnapshot?.config],
  );
  // Bug cause: workspaceHookReview is a special interaction handled by Settings/Hooks and cannot be rendered by the generic Dialog;
  // It can coexist with permission/userInput, so always reading [0] could hide a later interaction that actually needs a dialog.
  // Select the first interaction this component can render while preserving permission/userInput queue order.
  const pending =
    currentSnapshot?.pendingInteractions.find(
      (interaction) =>
        interaction.payload.kind === "permission" || interaction.payload.kind === "userInput",
    ) ?? null;
  const workspaceHookReview = currentSnapshot?.pendingInteractions.find(
    (interaction) => interaction.payload.kind === "workspaceHookReview",
  );
  const notificationEnabled = useZCodeStoreWithDefault((state) => state.notificationEnabled, true);
  const botElicitationProgress = useZCodeSessionStore(
    (state) =>
      getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
        .elicitationRequest,
  );
  const localElicitationDraft = useZCodeSessionStore((state) => {
    if (!pending || pending.payload.kind !== "userInput") return undefined;
    return getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
      .elicitationFormDraftsByRequestId[pending.interactionId];
  });
  usePendingInteractionTaskNotifications({
    snapshot: currentSnapshot,
    enabled: notificationEnabled,
    platform,
    formatMessage: intl.formatMessage,
  });
  useEffect(() => {
    connectWorkspaceHookCommands(sessionId, {
      sessionId,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      sendCommand,
      onCommandSettled,
    });
    return () => disconnectWorkspaceHookCommands(sessionId, sendCommand);
  }, [
    connectWorkspaceHookCommands,
    disconnectWorkspaceHookCommands,
    onCommandSettled,
    sendCommand,
    sessionId,
    workspaceIdentity,
    remoteSessionId,
    workspacePath,
  ]);
  useEffect(() => {
    if (!workspaceHookReview || workspaceHookReview.payload.kind !== "workspaceHookReview") {
      clearWorkspaceHookReview(sessionId);
      return;
    }
    upsertWorkspaceHookReview(sessionId, {
      request: workspaceHookReview.payload,
      workspacePath,
      sendCommand,
      onCommandSettled,
    });
    // Soft gate: do not force navigation to Settings/Hooks.
    // The user actively opens Hooks settings via the WorkspaceHookPendingIndicator's review button.
  }, [
    clearWorkspaceHookReview,
    onCommandSettled,
    sendCommand,
    sessionId,
    upsertWorkspaceHookReview,
    workspaceHookReview,
    workspacePath,
  ]);
  const autoResolutionIntentRef = useRef(createInteractionAutoResolutionIntentTracker());
  const loggedSnoozeSourceIdsRef = useRef(new Set<string>());
  const [permissionResponse, setPermissionResponse] = useState<{
    interactionId: string;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  const permissionResponseFlight = useRef<string | null>(null);

  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      answer: {
        optionId?: string;
        freeText?: string;
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      },
    ) => {
      const envelope = createCommandEnvelope({
        type: "resolveInteraction",
        sessionId,
        payload: { interactionId, answer },
      });
      // Do not persist permission/freeText/content; the registry stores only a digest for reconciliation after a lost ACK.
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        const accepted =
          ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
        if (!accepted) {
          logger.warn("[v4-interaction] resolveInteraction 被拒绝", {
            interactionId,
            status: ack.status,
            reasonCode: ack.reasonCode,
          });
        }
        return accepted;
      } catch (error) {
        logger.error("[v4-interaction] resolveInteraction 失败", { interactionId, error });
        return false;
      } finally {
        onCommandSettled?.(envelope.commandId);
      }
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const snoozeAutoResolution = useCallback(
    async (interactionId: string) => {
      return sendInteractionAutoResolutionSnooze({
        sessionId,
        interactionId,
        sendCommand,
        source: "dialog",
        onCommandSettled,
      });
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  const persistElicitationDraft = useCallback(
    (requestId: string, draft: ElicitationFormDraft) => {
      useZCodeSessionStore
        .getState()
        .setTaskElicitationFormDraft(workspacePath, sessionId, requestId, draft, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  const removeElicitationDraft = useCallback(
    (requestId: string) => {
      useZCodeSessionStore
        .getState()
        .removeTaskElicitationFormDraft(workspacePath, sessionId, requestId, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    if (!currentSnapshot) return;
    const activeRequestIds = new Set(
      currentSnapshot.pendingInteractions
        .filter((interaction) => interaction.payload.kind === "userInput")
        .map((interaction) => interaction.interactionId),
    );
    const taskUiState = getTaskUiState(
      getWorkspaceState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity),
      sessionId,
    );
    for (const requestId of Object.keys(taskUiState.elicitationFormDraftsByRequestId)) {
      if (!activeRequestIds.has(requestId)) {
        // Another client may answer or auto-close the request while the task is not visible; when returning to the task,
        // use snapshot.pendingInteractions as the authority and clear stale renderer drafts.
        removeElicitationDraft(requestId);
      }
    }
  }, [currentSnapshot, removeElicitationDraft, sessionId, workspaceIdentity, workspacePath]);

  const sendSnoozeOnce = useCallback(
    async (interactionId: string, autoResolutionReady: boolean) => {
      // The first userInput and autoResolution durable event may arrive in adjacent frames. If not ready, retain
      // the tracker intent but return false to the dialog so a later real action can retry; the ready-state effect sends it again.
      if (!autoResolutionReady) return false;
      if (!autoResolutionIntentRef.current.consumeSnooze(interactionId, autoResolutionReady)) {
        return true;
      }
      try {
        const accepted = await snoozeAutoResolution(interactionId);
        if (!accepted) autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return accepted;
      } catch {
        autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return false;
      }
    },
    [snoozeAutoResolution],
  );

  useEffect(() => {
    // PermissionRequested may emit userInput before the autoResolution durable event arrives.
    // If the user completes the first subquestion between those frames, record local intent and send it once the registry is ready.
    if (pending) {
      void sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
    }
  }, [pending?.autoResolution, pending?.interactionId, sendSnoozeOnce]);

  if (!pending) {
    return null;
  }

  // workspaceHookReview must be handled by the inline Trust action in Settings/Hooks; never downgrade it to a generic Dialog.
  if (pending.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (pending.payload.kind === "permission") {
    const request = pendingPermissionToLegacyRequest(sessionId, {
      ...pending,
      payload: pending.payload,
    });
    return (
      // Consecutive permission requests reuse input focus state; rebuild it per interaction.
      <PermissionDialog
        key={pending.interactionId}
        request={request}
        permissionMode={currentSnapshot?.config?.mode}
        workspacePath={workspacePath}
        {...(workspaceIdentity === undefined ? {} : { workspaceIdentity })}
        {...(remoteSessionId === undefined ? {} : { remoteSessionId })}
        {...(workflowSessionModel === undefined ? {} : { workflowSessionModel })}
        isWebRemoteControl={isWebRemoteControl}
        provider={provider}
        responding={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.pending
        }
        responseError={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.failed
            ? intl.formatMessage({ id: "chat.permission.responseFailed" })
            : undefined
        }
        onRespond={(_requestId, option: ZCodePermissionOption, feedback, content) => {
          if (permissionResponseFlight.current === pending.interactionId) return;
          const interactionId = pending.interactionId;
          permissionResponseFlight.current = interactionId;
          setPermissionResponse({ interactionId, pending: true, failed: false });
          // content: Settings changed in the workflow confirmation dialog, included only in the approval response (docs/dynamic-workflow/launch.md
          // "Adjusting the settings in the window").
          void resolveInteraction(interactionId, {
            optionId: option.optionId,
            ...(feedback ? { freeText: feedback } : {}),
            ...(content === undefined ? {} : { content }),
          }).then((accepted) => {
            if (permissionResponseFlight.current !== interactionId) return;
            permissionResponseFlight.current = null;
            setPermissionResponse({ interactionId, pending: false, failed: !accepted });
          });
        }}
      />
    );
  }

  const projectedElicitationRequest = pendingUserInputToElicitationRequest(sessionId, {
    ...pending,
    payload: pending.payload,
  });
  const elicitationRequest = resolveV4ElicitationRequest(
    projectedElicitationRequest,
    botElicitationProgress,
  );
  if (elicitationRequest) {
    const isExitPlanMode = pending.payload.toolName?.trim().toLowerCase() === "exitplanmode";
    const isAskUserQuestion =
      pending.payload.toolName?.trim().toLowerCase() === "askuserquestion" ||
      pending.autoResolution !== undefined;
    return (
      <ElicitationDialog
        key={buildV4ElicitationProgressKey(elicitationRequest)}
        request={elicitationRequest}
        initialFormDraft={
          botElicitationProgress?.requestId === elicitationRequest.requestId
            ? undefined
            : localElicitationDraft
        }
        onFormDraftChange={persistElicitationDraft}
        autoResolution={isAskUserQuestion ? pending.autoResolution : undefined}
        onFirstInteraction={
          isAskUserQuestion
            ? (source) => {
                if (!loggedSnoozeSourceIdsRef.current.has(pending.interactionId)) {
                  loggedSnoozeSourceIdsRef.current.add(pending.interactionId);
                  logger.debug("[v4-interaction] AskUserQuestion 请求暂停自动结束", {
                    interactionId: pending.interactionId,
                    source,
                  });
                }
                autoResolutionIntentRef.current.markInteracted(pending.interactionId);
                return sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
              }
            : undefined
        }
        onRespond={(_requestId, action, content) => {
          void resolveInteraction(pending.interactionId, {
            action,
            ...(content ? { content } : {}),
          }).then((accepted) => {
            if (!accepted) return;
            removeElicitationDraft(pending.interactionId);
            if (isExitPlanMode) {
              // Plan receipt ACK and replayable pending cleanup are separate async paths.
              // Report only the accepted Plan interaction here; the mobile pane triggers recovery while it still sees the old authoritative state.
              onPlanInteractionAccepted?.(pending.interactionId);
            }
          });
        }}
      />
    );
  }

  const model = pendingUserInputToViewModel({
    ...pending,
    payload: pending.payload,
  });
  return (
    <V4UserInputDialog
      model={model}
      onSubmit={(answer) => {
        void resolveInteraction(pending.interactionId, answer);
      }}
    />
  );
}
