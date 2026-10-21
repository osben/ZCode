import { useCallback, useState } from "react";
import { Check, ChevronRight, FolderOpen, GitBranch } from "lucide-react";
import { claimsRemoteWorkspaceIdentity, rebaseRemoteWorkspaceIdentity } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { formatWorktreeAddCommand } from "@/v4/worktreeCommandText.js";
import {
  bindRemoteWorkspaceIdentity,
  unbindRemoteWorkspaceIdentity,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

/**
 * Persistent second timeline item after Host activation clears the preparation marker: the same
 * reasoning-style collapsible as the setup card (specs/composer-worktree-setup-steps.md, Timeline
 * presentation), with the created summary and open action on the trigger line and the path plus
 * the executed Git command in the details.
 */
export function ConversationWorktreeCreatedNotice({
  branchName,
  currentBranchName,
  path,
  workspaceIdentity,
  remoteSessionId,
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
  onOpenWorktree?: (path: string, workspaceIdentity?: string) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const openLabel = intl.formatMessage({ id: "commandCenter.worktree.openExisting" });
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
                  {intl.formatMessage(
                    { id: "worktreeSetup.summaryCreated" },
                    { branch: displayBranchName || path },
                  )}
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
            {onOpenWorktree ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-md"
                    className="size-8 shrink-0"
                    aria-label={openLabel}
                    onClick={() => void handleOpenWorktree()}
                  >
                    <FolderOpen aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{openLabel}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <CollapsibleContent className="w-full">
            <div className="w-full space-y-2 pt-3 ml-2 border-border border-l pl-3.5 text-ui-sm text-foreground-subtlest">
              <div className="flex items-center gap-2">
                <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                <span className="break-all">{path}</span>
              </div>
              {branchName ? (
                <div className="flex w-full flex-col gap-1">
                  <span className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "worktreeSetup.commandLabel" })}
                  </span>
                  <code
                    data-worktree-created-command="true"
                    className="block w-full break-all rounded-md border border-border bg-surface px-2 py-1 font-mono text-ui-xs text-foreground-subtle"
                  >
                    {formatWorktreeAddCommand({
                      branchName,
                      targetPath: path,
                    })}
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
