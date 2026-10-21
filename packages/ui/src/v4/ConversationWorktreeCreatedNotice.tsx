import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  SquarePen,
} from "lucide-react";
import {
  claimsRemoteWorkspaceIdentity,
  rebaseRemoteWorkspaceIdentity,
  type EditorInfo,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { isFileManagerOpenTarget } from "@/lib/openWithEditors.js";
import { formatHomeRelativePath } from "@/lib/path.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { logger } from "@/logger.js";
import { getFileManagerLabel } from "@/workspace-file-tree/helpers.js";
import { formatWorktreeAddCommand } from "@/v4/worktreeCommandText.js";
import {
  bindRemoteWorkspaceIdentity,
  unbindRemoteWorkspaceIdentity,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

/**
 * Persistent second timeline item after Host activation clears the preparation marker: the same
 * reasoning-style collapsible as the setup card (specs/composer-worktree-setup-steps.md, Timeline
 * presentation), with `Worktree · <branch>` and a worktree actions menu on the trigger line and the
 * path plus the executed Git command in the details.
 */
export function ConversationWorktreeCreatedNotice({
  branchName,
  currentBranchName,
  path,
  workspaceIdentity,
  remoteSessionId,
  homePath,
  onOpenWorktree,
}: {
  branchName?: string;
  /** Undefined until Git status loads; null when the current worktree has no branch. */
  currentBranchName?: string | null;
  path: string;
  /** Parent workspace identity; a remote parent yields a remote identity for the worktree path. */
  workspaceIdentity?: string;
  /** Pane's remote session id when it has one; the parent identity binding is the fallback, as in the pane's own routing. */
  remoteSessionId?: string | null;
  /** Home directory reported by the parent workspace's Host; display-only `~` shortening. */
  homePath?: string;
  /** Opens the worktree as its own project tab with an empty draft ("New task in this worktree"). */
  onOpenWorktree?: (path: string, workspaceIdentity?: string) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const actionsLabel = intl.formatMessage({ id: "worktreeSetup.actions" });
  const displayPath = formatHomeRelativePath(path, homePath);
  // Native reveal/editor opens take a local path; a remote parent's worktree path lives on the remote
  // Host, so those items are hidden there (and on Web, where the platform cannot open local files).
  const isRemoteParent =
    claimsRemoteWorkspaceIdentity(workspaceIdentity?.trim() ?? "") ||
    Boolean(remoteSessionId?.trim());
  const canOpenNative = Boolean(platform?.canOpenLocalFiles) && !isRemoteParent;
  const editor = useWorktreeEditor(canOpenNative ? platform : null);
  // The creation-time branch stays until Git status is known, so a later branch switch is shown.
  const displayBranchName = currentBranchName === undefined ? branchName : currentBranchName;
  const [createdOpen, setCreatedOpen] = useState(false);

  const openFailed = useCallback(() => {
    toast(intl.formatMessage({ id: "commandCenter.worktree.openFailed" }, { path }), {
      durationMs: 10_000,
    });
  }, [intl, path]);

  const handleOpenWorktree = useCallback(async () => {
    if (!onOpenWorktree) return;
    const parentIdentity = workspaceIdentity?.trim() ?? "";
    // Remote identities embed the path, so the worktree needs its own identity on the same
    // authority. A local parent has no remote identity and opens by path alone. A parent that
    // claims a remote identity but does not parse must fail closed: falling back to the path
    // would hand the remote filesystem path to the local workspace opener.
    const worktreeIdentity = rebaseRemoteWorkspaceIdentity(parentIdentity, path);
    if (
      (worktreeIdentity === null && claimsRemoteWorkspaceIdentity(parentIdentity)) ||
      (worktreeIdentity === null && Boolean(remoteSessionId?.trim()))
    ) {
      openFailed();
      return;
    }
    // A remote worktree tab resolves its session only through the identity binding. Resolve the
    // parent's session with the same resolver the pane uses for its own routing: the remoteSessionId
    // prop first, then the parent identity binding (restored and split panes omit the prop). Only an
    // attached session counts, so a remote disconnect fails closed. Failing before any bind keeps a
    // failed open from leaving a stale identity binding behind.
    let previousIdentityBinding: string | undefined;
    if (worktreeIdentity !== null) {
      const parentRemoteSessionId = resolveWorkspaceRemoteSessionId(
        {
          // The identity is non-empty here, so the resolver's path fallback never applies.
          workspacePath: path,
          workspaceIdentity: parentIdentity,
          ...(remoteSessionId?.trim() ? { remoteSessionId: remoteSessionId.trim() } : {}),
        },
        useRemoteWorkspaceSessionStore.getState(),
      );
      if (!parentRemoteSessionId) {
        openFailed();
        return;
      }
      const bindings = useRemoteWorkspaceSessionStore.getState().sessionIdByWorkspaceIdentity;
      previousIdentityBinding = bindings[worktreeIdentity];
      bindRemoteWorkspaceIdentity(worktreeIdentity, parentRemoteSessionId);
    }
    try {
      await onOpenWorktree(path, worktreeIdentity ?? undefined);
    } catch {
      // Restore the prior binding on a rejected open: remove a binding this click created, or put
      // back the session an existing binding pointed to.
      if (worktreeIdentity !== null) {
        if (previousIdentityBinding) {
          bindRemoteWorkspaceIdentity(worktreeIdentity, previousIdentityBinding);
        } else {
          unbindRemoteWorkspaceIdentity(worktreeIdentity);
        }
      }
      openFailed();
    }
  }, [onOpenWorktree, openFailed, path, remoteSessionId, workspaceIdentity]);

  const handleReveal = useCallback(async () => {
    if (!platform || !canOpenNative) return;
    const result = await platform.openInFileManager(path).catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result.success) return;
    logger.warn("[ConversationWorktreeCreatedNotice] reveal worktree failed", {
      error: result.error ?? "unknown-error",
    });
    toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
  }, [canOpenNative, intl, path, platform]);

  const handleOpenInEditor = useCallback(async () => {
    if (!platform || !editor) return;
    const result = await platform
      .openInEditor(editor.id, path, { pathKind: "directory" })
      .catch((error: unknown) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    if (result.success) return;
    logger.warn("[ConversationWorktreeCreatedNotice] open worktree in editor failed", {
      editorId: editor.id,
      error: result.error ?? "unknown-error",
    });
    toast(intl.formatMessage({ id: "commandCenter.worktree.openFailed" }, { path }), {
      durationMs: 10_000,
    });
  }, [editor, intl, path, platform]);

  const copyText = useCallback(
    async (text: string, copiedMessage: string) => {
      try {
        if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
          throw new Error("clipboard-unavailable");
        }
        await navigator.clipboard.writeText(text);
        toast(copiedMessage);
      } catch (error) {
        logger.warn("[ConversationWorktreeCreatedNotice] copy failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "worktreeSetup.copyFailed" }));
      }
    },
    [intl],
  );

  const command = branchName ? formatWorktreeAddCommand({ branchName, targetPath: path }) : null;

  return (
    <div
      data-worktree-created="true"
      className="flex w-full flex-col items-start gap-2 text-ui-sm text-foreground"
      role="status"
    >
      <TooltipProvider>
        <Collapsible
          open={createdOpen}
          onOpenChange={setCreatedOpen}
          className="flex w-full flex-col"
        >
          <div className="flex w-full items-center gap-1">
            <CollapsibleTrigger className="group/worktree-created inline-flex min-w-0 flex-1 items-center gap-2 self-start text-left text-ui-base transition-colors">
              <GitBranch className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className="shrink-0 whitespace-nowrap font-medium text-foreground-subtlest">
                  {intl.formatMessage({ id: "worktreeSetup.collapsibleLabel" })}
                </span>
                <span className="font-normal text-foreground-subtlest">·</span>
                <span
                  data-worktree-created-summary="true"
                  data-worktree-setup-step="ready"
                  className="min-w-0 truncate font-normal text-foreground-subtlest"
                >
                  {displayBranchName || displayPath}
                </span>
              </span>
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-foreground-subtlest transition-opacity transition-transform",
                  createdOpen
                    ? "rotate-90 opacity-100"
                    : "rotate-0 opacity-0 group-hover/worktree-created:opacity-100",
                )}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-md"
                      className="size-8 shrink-0 text-foreground-subtlest"
                      aria-label={actionsLabel}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>{actionsLabel}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-52">
                {canOpenNative ? (
                  <DropdownMenuItem onSelect={() => void handleReveal()}>
                    <FolderOpen aria-hidden="true" />
                    {getFileManagerLabel(intl)}
                  </DropdownMenuItem>
                ) : null}
                {canOpenNative && editor ? (
                  <DropdownMenuItem onSelect={() => void handleOpenInEditor()}>
                    <img src={editor.iconDataUrl} alt="" className="size-4 shrink-0" />
                    {intl.formatMessage({ id: "appHeader.openInEditor" }, { editor: editor.name })}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onSelect={() =>
                    void copyText(path, intl.formatMessage({ id: "worktreeSetup.pathCopied" }))
                  }
                >
                  <Copy aria-hidden="true" />
                  {intl.formatMessage({ id: "appHeader.copyPath" })}
                </DropdownMenuItem>
                {onOpenWorktree ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void handleOpenWorktree()}>
                      <SquarePen aria-hidden="true" />
                      {intl.formatMessage({ id: "worktreeSetup.newTaskInWorktree" })}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <CollapsibleContent className="w-full">
            {/* No w-full here: with ml-2 it would overflow the column and clip the command box. */}
            <div
              data-worktree-created-details="true"
              className="min-w-0 space-y-2 pt-3 ml-2 border-border border-l pl-3.5 text-ui-sm text-foreground-subtlest"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span data-worktree-created-path="true" className="min-w-0 break-all">
                      {displayPath}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{path}</TooltipContent>
                </Tooltip>
              </div>
              {command ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-1">
                    <span className="text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage({ id: "worktreeSetup.commandLabel" })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0 text-foreground-subtlest"
                      aria-label={intl.formatMessage({ id: "worktreeSetup.copyCommand" })}
                      title={intl.formatMessage({ id: "worktreeSetup.copyCommand" })}
                      onClick={() =>
                        void copyText(
                          command,
                          intl.formatMessage({ id: "worktreeSetup.commandCopied" }),
                        )
                      }
                    >
                      <Copy className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                  <code
                    data-worktree-created-command="true"
                    className="block break-all rounded-md border border-border bg-surface px-2 py-1 font-mono text-ui-xs text-foreground-subtlest"
                  >
                    {command}
                  </code>
                </div>
              ) : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </TooltipProvider>
    </div>
  );
}

/** The user's last selected code editor for the worktree directory, else the first installed one. */
function useWorktreeEditor(platform: ReturnType<typeof useOptionalPlatform>): EditorInfo | null {
  const [installedEditors, setInstalledEditors] = useState<EditorInfo[]>([]);

  useEffect(() => {
    if (!platform) {
      setInstalledEditors([]);
      return;
    }
    let disposed = false;
    platform
      .getInstalledEditors()
      .then((editors) => {
        if (!disposed) setInstalledEditors(editors);
      })
      .catch((error: unknown) => {
        logger.warn("[ConversationWorktreeCreatedNotice] list installed editors failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [platform]);

  return useMemo(
    () =>
      resolveWorkspaceEditorSelection({
        // Reveal already covers file managers, so the editor item names a real editor or terminal.
        installedEditors: installedEditors.filter((editor) => !isFileManagerOpenTarget(editor)),
        selectedEditorId: readLastSelectedEditorId(),
      }).selectedEditor,
    [installedEditors],
  );
}
