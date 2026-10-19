import { useCallback } from "react";
import { FolderOpen, Split } from "lucide-react";
import { claimsRemoteWorkspaceIdentity, rebaseRemoteWorkspaceIdentity } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Persistent first-in-history summary after Host activation clears the preparation marker. */
export function ConversationWorktreeCreatedNotice({
  branchName,
  currentBranchName,
  path,
  workspaceIdentity,
  onOpenWorktree,
}: {
  branchName?: string;
  /** Undefined until Git status loads; null when the current worktree has no branch. */
  currentBranchName?: string | null;
  path: string;
  /** Parent workspace identity; a remote parent yields a remote identity for the worktree path. */
  workspaceIdentity?: string;
  onOpenWorktree?: (path: string, workspaceIdentity?: string) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const openLabel = intl.formatMessage({ id: "commandCenter.worktree.openExisting" });
  // The creation-time branch stays until Git status is known, so a later branch switch is shown.
  const displayBranchName = currentBranchName === undefined ? branchName : currentBranchName;

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
    if (worktreeIdentity === null && claimsRemoteWorkspaceIdentity(parentIdentity)) {
      openFailed();
      return;
    }
    try {
      await onOpenWorktree(path, worktreeIdentity ?? undefined);
    } catch {
      openFailed();
    }
  }, [onOpenWorktree, openFailed, path, workspaceIdentity]);

  return (
    <div
      data-worktree-created="true"
      className="mx-4 my-3 flex min-h-10 w-auto max-w-2xl items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-ui-sm text-foreground"
      role="status"
    >
      <TooltipProvider>
        <Split className="size-3.5 shrink-0 rotate-90 text-foreground-subtle" aria-hidden="true" />
        <span className="shrink-0 font-medium">
          {intl.formatMessage({ id: "worktreeSetup.created" })}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 truncate text-ui-caption text-foreground-subtle">
              {displayBranchName || path}
            </span>
          </TooltipTrigger>
          <TooltipContent>{path}</TooltipContent>
        </Tooltip>
        {onOpenWorktree ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                className="size-10 shrink-0"
                aria-label={openLabel}
                onClick={() => void handleOpenWorktree()}
              >
                <FolderOpen aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{openLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </TooltipProvider>
    </div>
  );
}
