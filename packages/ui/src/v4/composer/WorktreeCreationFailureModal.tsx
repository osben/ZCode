/**
 * Failure-modal host for the worktree return-to-draft flow
 * (spec: specs/composer-worktree-setup-steps.md §Return to draft on failure).
 *
 * Mounted once at the root shell. It owns the presentation decision: the modal opens only when
 * the entry's workspace is on screen and its draft view is active; otherwise a one-time action
 * toast ("Could not create the worktree — Open") defers the modal until the user returns (spec
 * decision 4). Raw Git detail lives only in the workspace-scoped memory store — never persisted,
 * never logged. Actions follow the error class (spec decision 5): configuration errors get
 * "Change branch/folder", transient errors get "Retry", and "Copy details" is always available.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { CopyIcon, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { SETTINGS_TAB_ID } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  isWorktreeConfigurationFailure,
  useWorktreeFailureReturnStore,
} from "@/store/worktreeFailureReturnStore.js";

function buildFailureDetailLines(params: {
  rawDetail: string | null;
  worktreePath?: string;
  branchName?: string;
  issueCode: string | null;
}): string[] {
  return [
    params.branchName ? `branch: ${params.branchName}` : null,
    params.worktreePath ? `path: ${params.worktreePath}` : null,
    params.issueCode ? `issue: ${params.issueCode}` : null,
    params.rawDetail,
  ].filter((line): line is string => typeof line === "string" && line.length > 0);
}

export function WorktreeCreationFailureModalDialog({
  message,
  rawDetail,
  worktreePath,
  branchName,
  issueCode,
  savedNotRestored,
  onRetry,
  onChangeDestination,
  onDismiss,
}: {
  message: string;
  rawDetail: string | null;
  worktreePath?: string;
  branchName?: string;
  issueCode: string | null;
  savedNotRestored?: boolean;
  onRetry: () => void;
  onChangeDestination: () => void;
  onDismiss: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasTechnicalDetails = Boolean(rawDetail || worktreePath || branchName || issueCode);
  const configurationFailure = isWorktreeConfigurationFailure(issueCode);

  const handleCopyDetails = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "chat.error.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }
    try {
      const detailLines = buildFailureDetailLines({
        rawDetail,
        worktreePath,
        branchName,
        issueCode,
      });
      await navigator.clipboard.writeText([message, ...detailLines].join("\n"));
      toast(intl.formatMessage({ id: "chat.error.copyFull.copied" }));
    } catch (copyError) {
      toast(
        intl.formatMessage({ id: "chat.error.copyFailed" }, { error: getErrorMessage(copyError) }),
      );
    }
  }, [branchName, intl, issueCode, message, rawDetail, worktreePath]);

  return (
    <DialogContent
      data-testid="worktree-failure-modal"
      data-issue-code={issueCode ?? "unclassified"}
      className="max-w-lg"
    >
      <DialogHeader>
        <DialogTitle>{intl.formatMessage({ id: "worktreeFailure.title" })}</DialogTitle>
        <DialogDescription className="whitespace-pre-wrap">{message}</DialogDescription>
      </DialogHeader>
      {savedNotRestored ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "worktreeFailure.savedNotRestored" })}
        </p>
      ) : null}
      {hasTechnicalDetails ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="self-start text-ui-base text-foreground-subtle underline-offset-2 hover:underline"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {intl.formatMessage({
              id: detailsOpen ? "worktreeFailure.hideDetails" : "worktreeFailure.showDetails",
            })}
          </button>
          {detailsOpen ? (
            <div className="flex flex-col gap-2">
              <pre className="max-h-48 overflow-auto rounded-xl border border-border bg-surface px-3 py-2 text-ui-base whitespace-pre-wrap text-foreground-subtle">
                {buildFailureDetailLines({ rawDetail, worktreePath, branchName, issueCode }).join(
                  "\n",
                )}
              </pre>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit gap-1.5"
                onClick={() => {
                  void handleCopyDetails();
                }}
              >
                <CopyIcon className="size-3.5" />
                {intl.formatMessage({ id: "worktreeFailure.copyDetails" })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {intl.formatMessage({ id: "worktreeFailure.dismiss" })}
        </Button>
        {configurationFailure ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="gap-1.5"
            onClick={onChangeDestination}
          >
            <SlidersHorizontal className="size-3.5" />
            {intl.formatMessage({ id: "worktreeFailure.changeDestination" })}
          </Button>
        ) : savedNotRestored ? null : (
          // Retry would submit the user's current draft, not the saved message; while the message sits
          // on the recovery card, the card is the only way to recover it (spec decision 2).
          <Button type="button" variant="default" size="sm" className="gap-1.5" onClick={onRetry}>
            <RotateCcw className="size-3.5" />
            {intl.formatMessage({ id: "worktreeFailure.retry" })}
          </Button>
        )}
      </div>
    </DialogContent>
  );
}

export function WorktreeFailureModalHost() {
  const { intl } = useZCodeIntl();
  const tabStoreApi = useTabStoreApi();
  const modalByWorkspaceKey = useWorktreeFailureReturnStore((state) => state.modalByWorkspaceKey);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspaceKey = activeWorkspaceIdentity?.trim() || activeWorkspacePath || "";
  const entry = modalByWorkspaceKey[activeWorkspaceKey] ?? null;
  // Defensive selector: fallback/test stores may lack the workspace slice entirely.
  const activeTaskId = useZCodeSessionStore((state) =>
    activeWorkspacePath && typeof state.getWorkspaceState === "function"
      ? (state.getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity?.trim() || undefined)
          ?.activeTaskId ?? null)
      : null,
  );
  const toastAnnouncedRef = useRef<string | null>(null);

  // The modal is displayable only on the entry workspace's draft screen; while the user is
  // elsewhere, announce the failure once with an action toast and defer the modal (decision 4).
  const displayable = Boolean(entry && activeTaskId === null && activeTabId !== SETTINGS_TAB_ID);
  useEffect(() => {
    if (!entry || displayable) {
      toastAnnouncedRef.current = null;
      return;
    }
    if (toastAnnouncedRef.current === entry.sessionId) return;
    toastAnnouncedRef.current = entry.sessionId;
    const workspacePath = activeWorkspacePath ?? "";
    const workspaceIdentity = activeWorkspaceIdentity?.trim() || undefined;
    toast(intl.formatMessage({ id: "worktreeFailure.toastTitle" }), {
      variant: "warning",
      dedupeKey: `worktree-failure:${entry.sessionId}`,
      actionLabel: intl.formatMessage({ id: "worktreeFailure.toastOpen" }),
      onAction: () => {
        tabStoreApi
          .getState()
          .activateTabByPath(workspacePath, workspaceIdentity ? { workspaceIdentity } : undefined);
        useZCodeSessionStore.getState().startDraft(workspacePath, undefined, workspaceIdentity);
      },
    });
  }, [activeWorkspaceIdentity, activeWorkspacePath, displayable, entry, intl]);

  // A failure in another workspace is announced with an action toast that opens that workspace
  // (decision 4); its modal waits for the user's return to that workspace's draft screen. Each
  // failed attempt is announced once.
  const awayAnnouncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const liveKeys = new Set<string>();
    for (const [workspaceKey, pending] of Object.entries(modalByWorkspaceKey)) {
      if (workspaceKey === activeWorkspaceKey) continue;
      const announceKey = `${workspaceKey}\0${pending.sessionId}\0${pending.attemptId ?? ""}`;
      liveKeys.add(announceKey);
      if (awayAnnouncedRef.current.has(announceKey)) continue;
      awayAnnouncedRef.current.add(announceKey);
      const { workspacePath, workspaceIdentity } = pending;
      toast(intl.formatMessage({ id: "worktreeFailure.toastTitle" }), {
        variant: "warning",
        dedupeKey: `worktree-failure:${pending.sessionId}`,
        actionLabel: intl.formatMessage({ id: "worktreeFailure.toastOpen" }),
        onAction: () => {
          tabStoreApi
            .getState()
            .activateTabByPath(
              workspacePath,
              workspaceIdentity ? { workspaceIdentity } : undefined,
            );
          useZCodeSessionStore.getState().startDraft(workspacePath, undefined, workspaceIdentity);
        },
      });
    }
    // Forget announcements of entries that were closed, so a later failure is announced again.
    for (const announceKey of awayAnnouncedRef.current) {
      if (!liveKeys.has(announceKey)) awayAnnouncedRef.current.delete(announceKey);
    }
  }, [activeWorkspaceKey, intl, modalByWorkspaceKey, tabStoreApi]);

  const close = useCallback(() => {
    useWorktreeFailureReturnStore.getState().closeFailureModal(activeWorkspaceKey);
  }, [activeWorkspaceKey]);

  const handleRetry = useCallback(() => {
    // Defense in depth: the draft composer submits whatever is in the editor, so Retry must never
    // run while the saved message is only on the recovery card.
    if (!entry || entry.savedNotRestored) return;
    useWorktreeFailureReturnStore.getState().requestDraftSubmit(activeWorkspaceKey);
    close();
  }, [activeWorkspaceKey, close, entry]);

  const handleChangeDestination = useCallback(() => {
    useWorktreeFailureReturnStore.getState().requestDestinationOpen(activeWorkspaceKey);
    close();
  }, [activeWorkspaceKey, close]);

  if (!entry || !displayable) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <WorktreeCreationFailureModalDialog
        key={entry.sessionId}
        message={entry.message}
        rawDetail={entry.rawDetail}
        {...(entry.worktreePath ? { worktreePath: entry.worktreePath } : {})}
        {...(entry.branchName ? { branchName: entry.branchName } : {})}
        issueCode={entry.issueCode}
        {...(entry.savedNotRestored ? { savedNotRestored: true } : {})}
        onRetry={handleRetry}
        onChangeDestination={handleChangeDestination}
        onDismiss={close}
      />
    </Dialog>
  );
}
