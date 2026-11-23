import type { Hook } from "@zcode/shared";
import { CircleAlert } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Use the same conditions as the inline Trust button in HooksList, avoiding a second review state for risk notices. */
export function requiresWorkspaceHookTrust(hook: Hook): boolean {
  return Boolean(hook.workspaceHook) && hook.workspaceHook?.trustState !== "trusted_persistent";
}

export function hasWorkspaceHooksRequiringReview(hooks: readonly Hook[]): boolean {
  return hooks.some(requiresWorkspaceHookTrust);
}

export function shouldShowWorkspaceHookTrustNotice({
  hooks,
  loadedWorkspaceKey,
  rpcReady,
  targetWorkspaceKey,
}: {
  hooks: readonly Hook[];
  loadedWorkspaceKey: string | null;
  rpcReady: boolean;
  targetWorkspaceKey: string | null;
}): boolean {
  // hooksStore is a singleton and may retain the previous workspace's hooks during connection after a workspace switch.
  // Show safety notices only when the current target is ready and its snapshot key matches, preventing A's risk from being attributed to B while it connects.
  return (
    rpcReady &&
    targetWorkspaceKey !== null &&
    loadedWorkspaceKey === targetWorkspaceKey &&
    hasWorkspaceHooksRequiringReview(hooks)
  );
}

/**
 * Display risk information for the current scope only; existing components still handle review, navigation, and toggle interactions.
 * worktreeSourcePath: when the settings page discovers declarations by managed worktree, notes that the trust record is shared with the source repository (D23).
 */
export function WorkspaceHookTrustNotice({
  hooks,
  worktreeSourcePath,
}: {
  hooks: readonly Hook[];
  worktreeSourcePath?: string;
}) {
  const { intl } = useZCodeIntl();

  if (!hasWorkspaceHooksRequiringReview(hooks)) return null;

  return (
    <div
      role="note"
      data-testid="workspace-hook-trust-notice"
      className="flex w-full items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-ui-base text-foreground"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p>{intl.formatMessage({ id: "settings.hooks.review.notice" })}</p>
        {worktreeSourcePath ? (
          <p
            data-testid="workspace-hook-worktree-notice"
            className="break-words text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage(
              { id: "settings.hooks.review.worktreeNotice" },
              { path: worktreeSourcePath },
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
