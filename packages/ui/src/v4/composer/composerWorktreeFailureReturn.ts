/**
 * Return-to-draft hand-off for a failed worktree creation
 * (spec: specs/composer-worktree-setup-steps.md §Return to draft on failure).
 *
 * The renderer that issued the send and still owns the armed submission is the single owner of the
 * automatic return. This module runs the event order: verify ownership (armed continuation in this
 * process + current attempt), transfer the recovery record and staged attachments into the draft
 * pending scope in one write, settle the Host marker (failed, then cancelled — both through the
 * existing updateWorktreePreparation command with its attempt CAS), tombstone the preparing session
 * through the existing deleteTask Hide path, discard the local pipeline entry, navigate (or leave a
 * toast when the user is elsewhere), and open the failure modal from the workspace-scoped store.
 *
 * Ordering constraints (spec): the session is never removed before the recovery transfer is safely
 * written and the Git attempt is settled; the worktree directory is never deleted; raw Git detail
 * lives only in the modal store (memory). Every fallback leaves the existing failed-row path intact.
 */
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import {
  moveComposerAttachmentScopeItems,
  readComposerAttachmentScope,
} from "@/store/composerAttachmentUploadStore.js";
import {
  peekWorktreeSendContinuation,
  releaseWorktreeSendContinuation,
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
  type ComposerWorktreeCreationParams,
} from "@/store/composerWorktreePipelineStore.js";
import { resolveRegisteredWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import {
  V4_DRAFT_SCOPE_ROOT,
  V4_WORKTREE_RECOVERY_PENDING_SCOPE,
  getV4WorktreeRecoveryScope,
  moveV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { buildV4WorktreeIntentFromParams } from "@/v4/composer/composerRecoveryRecord.js";
import type { IServiceAccessor } from "@zcode/services";

/** Failures already taken over by the hand-off (idempotency across runner re-entry). */
const handledFailureKeys = new Set<string>();

function failureKey(workspaceKey: string, sessionId: string, attemptId?: string): string {
  return `${workspaceKey}\0${sessionId}\0${attemptId ?? ""}`;
}

export interface ComposerWorktreeFailureReturnContext {
  workspaceKey: string;
  sessionId: string;
  attemptId?: string;
  params: ComposerWorktreeCreationParams;
  failureMessage: string;
  issueCode: string | null;
  rawDetail: string | null;
}

/** Whether the main draft scope is content-empty (auto-restore is allowed only then, spec decision 2). */
function isMainDraftEmpty(workspaceKey: string, params: ComposerWorktreeCreationParams): boolean {
  const draft = readV4ComposerDraft(
    params.workspacePath,
    params.workspaceIdentity,
    V4_DRAFT_SCOPE_ROOT,
  );
  const stagedDraftAttachments = readComposerAttachmentScope(
    `${workspaceKey}\0${V4_DRAFT_SCOPE_ROOT}`,
  );
  return (
    !draft?.text.trim() &&
    !draft?.recoveryAttachments?.length &&
    !draft?.recoveryContexts &&
    stagedDraftAttachments.length === 0
  );
}

async function sendPreparationUpdate(
  services: IServiceAccessor,
  context: ComposerWorktreeFailureReturnContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const agentService = services.zcodeAgentService;
  await ensureAgentV4ConnectionHandshake(agentService);
  const envelope = createCommandEnvelope({
    type: "updateWorktreePreparation",
    sessionId: context.sessionId,
    payload: payload as never,
  });
  const ack = await agentService.sendConversationCommandV4({
    workspacePath: context.params.workspacePath,
    ...(context.params.workspaceIdentity
      ? { workspaceIdentity: context.params.workspaceIdentity }
      : {}),
    envelope,
  });
  if (ack.status !== "accepted") {
    throw new Error(ack.reasonCode ?? "Worktree preparation update was rejected");
  }
}

/**
 * Run the return-to-draft hand-off for a freshly failed pipeline entry. Returns true when the
 * hand-off took ownership. Every abort path leaves the existing failed-row behavior in place.
 */
export function initiateComposerWorktreeFailureReturn(
  context: ComposerWorktreeFailureReturnContext,
): boolean {
  const { workspaceKey, sessionId, attemptId, params } = context;
  const key = failureKey(workspaceKey, sessionId, attemptId);
  if (handledFailureKeys.has(key)) return false;
  // Live-renderer ownership: only the process holding the armed submission for this session
  // returns automatically; reloads, other windows, and reconcile keep the failed row.
  if (!peekWorktreeSendContinuation(workspaceKey, sessionId)) return false;
  const entry = selectComposerWorktreePipeline(
    useComposerWorktreePipelineStore.getState(),
    workspaceKey,
    sessionId,
  );
  if (!entry || entry.attemptId !== attemptId || entry.status !== "failed" || !entry.params) {
    return false;
  }
  const submissionId = params.submissionId;
  if (!submissionId) return false;
  const sessionRecoveryScope = getV4WorktreeRecoveryScope(sessionId, submissionId);
  const record = readV4ComposerDraft(
    params.workspacePath,
    params.workspaceIdentity,
    sessionRecoveryScope,
  );
  // Nothing safely transferable yet: the queue-time write is missing, so keep the failed-row path.
  if (!record) return false;

  const attachmentIds = (record.recoveryAttachments ?? []).map((item) => item.id);
  const draftEmpty = isMainDraftEmpty(workspaceKey, params);
  // The transfer is one storage write (record move) plus the matching attachment-scope move; the
  // pending scope is what the draft screen's recovery card and the auto-restore consume.
  // Attachments follow the record only when the record move succeeded.
  const pendingScope = `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:${submissionId}`;
  const moveRecoveryRecord = (from: string, to: string): boolean => {
    if (!moveV4ComposerDraft(params.workspacePath, params.workspaceIdentity, from, to)) {
      return false;
    }
    moveComposerAttachmentScopeItems(
      `${workspaceKey}\0${from}`,
      `${workspaceKey}\0${to}`,
      attachmentIds,
    );
    return true;
  };
  if (!moveRecoveryRecord(sessionRecoveryScope, pendingScope)) return false;
  // Enrich the transferred record with the worktree intent so Retry/Change prefills; the record
  // stays continuously present (already moved), and a failed enrich write only drops the prefill.
  persistV4ComposerDraft(params.workspacePath, params.workspaceIdentity, pendingScope, {
    ...record,
    worktreeIntent: buildV4WorktreeIntentFromParams(params),
  });

  // From here the entry is marked: the composer's queued-send effect must not run its own failure
  // handling (Host report + restoreForRetry) for this attempt, or it would re-create the
  // session-scope record the transfer just moved.
  if (
    !useComposerWorktreePipelineStore
      .getState()
      .setReturningToDraft(workspaceKey, sessionId, attemptId, true)
  ) {
    // The entry moved on between the ownership check and the mark; revert the transfer.
    moveRecoveryRecord(pendingScope, sessionRecoveryScope);
    return false;
  }
  handledFailureKeys.add(key);

  void (async () => {
    let services: IServiceAccessor | null = null;
    try {
      services = resolveRegisteredWorkspaceServices({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      if (!services) throw new Error("workspace-services-unavailable");
      // Sequence failed → cancelled so the preparation guard never observes a failed mutation
      // after cancellation; a rejected failure report is tolerated (the marker may already hold it).
      try {
        await sendPreparationUpdate(services, context, {
          status: "failed",
          failureMessage: context.failureMessage,
          expectedAttemptId: attemptId,
        });
      } catch (error) {
        logger.warn("[WorktreeFailureReturn] preparation failure report was rejected", {
          workspaceKey,
          sessionId,
          error: getErrorMessage(error),
        });
      }
      await sendPreparationUpdate(services, context, {
        status: "cancelled",
        expectedAttemptId: attemptId,
      });
    } catch (error) {
      // The Host refused the hand-off (stale attempt or transport): fall back to the failed-row
      // path by reverting the takeover. The transferred record stays visible as the draft screen's
      // recovery card, so the frozen submission remains recoverable either way.
      logger.warn("[WorktreeFailureReturn] hand-off was rejected by the Host; falling back", {
        workspaceKey,
        sessionId,
        error: getErrorMessage(error),
      });
      handledFailureKeys.delete(key);
      useComposerWorktreePipelineStore
        .getState()
        .setReturningToDraft(workspaceKey, sessionId, attemptId, false);
      return;
    }
    // Tombstone through the existing Hide path (session-deletion-cascade.md): tasks.deleted=1
    // hides the preparing session from every sidebar list while the CLI session row is retained.
    // A failure here is logged and tolerated: the return UX proceeds, the row may linger.
    try {
      await services?.zcodeTaskService.deleteTask({
        taskId: sessionId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
    } catch (error) {
      logger.warn("[WorktreeFailureReturn] preparing-session tombstone failed", {
        workspaceKey,
        sessionId,
        error: getErrorMessage(error),
      });
    }
    useComposerWorktreePipelineStore.getState().discard(workspaceKey, sessionId, attemptId);
    releaseWorktreeSendContinuation(workspaceKey, sessionId);
    useWorktreeFailureReturnStore.getState().openFailureModal(workspaceKey, {
      sessionId,
      ...(attemptId ? { attemptId } : {}),
      submissionId,
      issueCode: context.issueCode,
      message: context.failureMessage,
      rawDetail: context.rawDetail,
      ...(params.targetPath ? { worktreePath: params.targetPath } : {}),
      branchName: params.branchName,
      ...(draftEmpty ? {} : { savedNotRestored: true }),
      savedAt: Date.now(),
    });
    // Navigate only when the failed session is this workspace's current view; never yank the
    // user out of another session or workspace (they get the action toast from the modal host).
    const workspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(params.workspacePath, params.workspaceIdentity);
    if (workspaceState.activeTaskId === sessionId) {
      useZCodeSessionStore
        .getState()
        .startDraft(params.workspacePath, undefined, params.workspaceIdentity);
    }
    if (draftEmpty) {
      useWorktreeFailureReturnStore.getState().requestDraftRestore(workspaceKey);
    }
  })();
  return true;
}
