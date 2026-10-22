import { useEffect, useId } from "react";
import { logger } from "@/logger.js";
import {
  moveComposerAttachmentScopeItems,
  useComposerAttachmentUploadStore,
} from "@/store/composerAttachmentUploadStore.js";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { rehydrateComposerRecoveryAttachments } from "@/v4/composer/composerRecoveryAttachments.js";
import {
  clearV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  persistV4ComposerDraft,
  subscribeV4ComposerDrafts,
  getV4FirstSubmissionVersion,
  isV4FirstSubmissionActive,
  type V4ComposerDraft,
} from "./composerDraftStore.js";

// The user bubble itself is the timeline's optimistic first-input row
// (specs/first-submission-instant-ux.md P1). Beneath it, via the afterFirstUserInputSlot and
// before the worktree context row, only states the user must act on or wait out knowingly
// render — never an in-progress label (spec: Status under the message).
function firstSubmissionStatusMessageId(
  status: NonNullable<V4ComposerDraft["firstSubmission"]>["status"] | undefined,
  active: boolean,
): string | null {
  if (status === "failed") return "chat.error.sendFailed";
  if (status === "unknown") return "firstSubmission.unknown";
  // An active submission is still moving; the optimistic turn is the feedback.
  if (status === "sending" && !active) return "firstSubmission.synchronizing";
  return null;
}

export function FirstSubmissionStatus({
  draft,
  active,
}: {
  draft: V4ComposerDraft;
  active: boolean;
}) {
  const { intl } = useZCodeIntl();
  const pending = draft.firstSubmission;
  const contextCount = Object.values(draft.recoveryContexts ?? {}).reduce(
    (count, items) => count + (items?.length ?? 0),
    0,
  );
  const messageId = firstSubmissionStatusMessageId(pending?.status, active);
  if (contextCount === 0 && !messageId) return null;
  return (
    <div
      data-first-submission={pending?.submissionId}
      className="flex flex-col items-end gap-2 px-4 pt-2 text-ui-base"
    >
      {contextCount > 0 ? (
        <span className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm">
          {intl.formatMessage({ id: "firstSubmission.contexts" }, { count: contextCount })}
        </span>
      ) : null}
      {messageId ? (
        <div
          role="status"
          data-first-submission-status="true"
          className={
            pending?.status === "failed"
              ? "flex items-center gap-2 text-ui-sm text-destructive"
              : "flex items-center gap-2 text-ui-sm text-foreground-subtle"
          }
        >
          {intl.formatMessage({ id: messageId })}
        </div>
      ) : null}
    </div>
  );
}

export function ComposerWorktreeRecovery({
  workspacePath,
  workspaceIdentity,
  scopeId,
  editorEmpty,
  attachments,
  retryBlockedReason,
  onRestore,
  onRetry,
  onRemove,
  onDiscardAttachments,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  scopeId: string;
  editorEmpty: boolean;
  attachments: readonly { id: string; filename: string }[];
  /** Why the ordinary submit would not run now (shared predicate); Retry is disabled with it. */
  retryBlockedReason?: string | null;
  onRestore: (draft: V4ComposerDraft) => void;
  /** Restore-then-submit over the frozen first submission (specs/first-submission-instant-ux.md, Retry surface). */
  onRetry: (draft: V4ComposerDraft, recoveryScope: string) => void;
  /** Return the frozen text to the editor and delete the record; never a Host call. */
  onRemove: (draft: V4ComposerDraft, recoveryScope: string) => void;
  onDiscardAttachments: (ids: string[], scope: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  useSyncExternalStore(
    subscribeV4ComposerDrafts,
    // The first-submission version also bumps on active-flag changes, which gate the card.
    () => getV4FirstSubmissionVersion(workspacePath, workspaceIdentity),
    () => null,
  );
  const saved = readV4WorktreeRecoveryDrafts(workspacePath, workspaceIdentity, scopeId)[0];
  const recoveryScope = saved?.scope ?? "";
  const draft = saved?.draft;
  const retryBlockedReasonId = useId();
  const recoveryFiles = useComposerAttachmentUploadStore(
    (state) => state.scopes[`${workspaceIdentity?.trim() || workspacePath}\0${recoveryScope}`],
  );
  // Clipboard-text attachments that persisted their path metadata re-hydrate from the temporary
  // file instead of demanding a reattach (spec §Return to draft on failure); idempotent, so it is
  // safe to run on every record change.
  const manifest = draft?.recoveryAttachments ?? [];
  useEffect(() => {
    if (!draft || !recoveryScope) return;
    rehydrateComposerRecoveryAttachments({
      workspaceKey: workspaceIdentity?.trim() || workspacePath,
      recoveryScope,
      manifest,
    });
  }, [draft, manifest, recoveryScope, workspaceIdentity, workspacePath]);
  if (!draft) return null;
  const firstSubmission = draft.firstSubmission;
  // A live submission owns its record (the retry freeze also marks it active, which hides the card,
  // so no "already clicked" lock is needed).
  if (
    firstSubmission &&
    isV4FirstSubmissionActive(workspacePath, workspaceIdentity, firstSubmission.submissionId)
  )
    return null;
  // sending/unknown has an unresolved sendText command: reconciled by its original id, never
  // resent under a new one (FSL rule 4), so only Remove is offered until reconciliation decides.
  const outcomeUnresolved =
    firstSubmission?.status === "sending" || firstSubmission?.status === "unknown";
  const missing = (draft.recoveryAttachments ?? []).filter(
    (file) =>
      ![...attachments, ...(recoveryFiles ?? [])].some(
        (item) => item.id === file.id || item.filename === file.filename,
      ),
  );
  const occupied =
    !editorEmpty ||
    attachments.some(
      (item) =>
        !(draft.recoveryAttachments ?? []).some(
          (file) =>
            file.id === item.id ||
            (file.filename === item.filename &&
              !(recoveryFiles ?? []).some((owned) => owned.id === file.id)),
        ),
    );
  return (
    <div
      data-testid="composer-worktree-recovery"
      className="m-2 rounded-md border border-border p-3 text-ui-sm"
    >
      <p>{intl.formatMessage({ id: "composerRecovery.title" })}</p>
      {/* A first submission's message is already the optimistic turn above; do not repeat it. */}
      {!firstSubmission ? (
        <>
          <p className="whitespace-pre-wrap text-foreground-subtle">{draft.text}</p>
          {(draft.recoveryAttachments ?? []).map((file) => (
            <span className="mr-2" key={file.id}>
              {file.filename}
            </span>
          ))}
        </>
      ) : null}
      {occupied ? (
        <p>
          {intl.formatMessage({
            id: firstSubmission
              ? "composerRecovery.retryOccupied"
              : "composerRecovery.editorOccupied",
          })}
        </p>
      ) : null}
      {missing.length ? <p>{intl.formatMessage({ id: "composerRecovery.reattach" })}</p> : null}
      {firstSubmission && !outcomeUnresolved && retryBlockedReason ? (
        <p
          id={retryBlockedReasonId}
          data-testid="composer-first-submission-retry-blocked"
          className="text-foreground-subtle"
        >
          {retryBlockedReason}
        </p>
      ) : null}
      <div className="mt-2 flex gap-2">
        {firstSubmission && outcomeUnresolved ? null : firstSubmission ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="composer-first-submission-retry"
            disabled={occupied || missing.length > 0 || retryBlockedReason !== null}
            aria-describedby={retryBlockedReason ? retryBlockedReasonId : undefined}
            onClick={() => {
              if (retryBlockedReason) return;
              // The record stays: the retry freeze overwrites it in place so the turn never blinks.
              moveComposerAttachmentScopeItems(
                `${workspaceIdentity?.trim() || workspacePath}\0${recoveryScope}`,
                `${workspaceIdentity?.trim() || workspacePath}\0${scopeId}`,
                (recoveryFiles ?? []).map((item) => item.id),
              );
              onRetry(draft, recoveryScope);
            }}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={occupied || missing.length > 0}
            onClick={() => {
              moveComposerAttachmentScopeItems(
                `${workspaceIdentity?.trim() || workspacePath}\0${recoveryScope}`,
                `${workspaceIdentity?.trim() || workspacePath}\0${scopeId}`,
                (recoveryFiles ?? []).map((item) => item.id),
              );
              onRestore(draft);
              clearV4ComposerDraft(workspacePath, workspaceIdentity, recoveryScope);
            }}
          >
            {intl.formatMessage({ id: "composerRecovery.restore" })}
          </Button>
        )}
        {missing.length ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              persistV4ComposerDraft(workspacePath, workspaceIdentity, recoveryScope, {
                ...draft,
                recoveryAttachments: (draft.recoveryAttachments ?? []).filter(
                  (file) => !missing.includes(file),
                ),
              })
            }
          >
            {intl.formatMessage({ id: "composerRecovery.removeMissing" })}
          </Button>
        ) : null}
        {firstSubmission ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="composer-first-submission-remove"
            disabled={occupied}
            onClick={() => {
              moveComposerAttachmentScopeItems(
                `${workspaceIdentity?.trim() || workspacePath}\0${recoveryScope}`,
                `${workspaceIdentity?.trim() || workspacePath}\0${scopeId}`,
                (recoveryFiles ?? []).map((item) => item.id),
              );
              onRemove(draft, recoveryScope);
            }}
          >
            {intl.formatMessage({ id: "firstSubmission.remove" })}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void onDiscardAttachments(
                (draft.recoveryAttachments ?? []).map((item) => item.id),
                recoveryScope,
              )
                .then(() => clearV4ComposerDraft(workspacePath, workspaceIdentity, recoveryScope))
                .catch((error: unknown) => {
                  logger.warn("[composer-recovery] Could not discard attachments", error);
                  toast(getErrorMessage(error));
                });
            }}
          >
            {intl.formatMessage({ id: "composerRecovery.dismiss" })}
          </Button>
        )}
      </div>
    </div>
  );
}
