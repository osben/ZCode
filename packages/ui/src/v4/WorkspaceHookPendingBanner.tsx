import { memo, useCallback, useState, useSyncExternalStore } from "react";
import type { WorkspaceMcpAdmissionSnapshotState } from "@zcode/shared/zcode-protocol-v4";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import {
  TID_V4_WORKSPACE_MCP_PENDING_TRIGGER,
  TID_V4_WORKSPACE_MCP_PENDING_POPOVER,
  TID_V4_WORKSPACE_MCP_PENDING_UNREAD,
  TID_V4_WORKSPACE_MCP_PENDING_REVIEW,
  TID_V4_WORKSPACE_MCP_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_POPOVER,
  TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER,
  TID_V4_WORKSPACE_HOOK_PENDING_UNREAD,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
} from "@zcode/shared/test-ids";
import { Anchor, Cable } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  setPendingSettingsSectionIntent,
  setPendingSettingsPluginIntent,
} from "@/lib/settingsNavigation.js";
import { logger } from "@/logger.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  findWorkspaceHookCommandBinding,
  useWorkspaceHookReviewStore,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { sendWorkspaceHookCommand } from "@/settings/workspaceHookReviewCommands.js";

// Read/dismissed is renderer display state only and must not rewrite Runtime admission or
// Trust. A single subscription source keeps icons consistent across multiple panes of the same
// session.
type ReminderState = "read" | "dismissed";
const reminderStates = new Map<string, ReminderState>();
const reminderListeners = new Set<() => void>();
const subscribeReminder = (listener: () => void) => {
  reminderListeners.add(listener);
  return () => {
    reminderListeners.delete(listener);
  };
};
function setReminderState(key: string, state: ReminderState): void {
  reminderStates.set(key, state);
  reminderListeners.forEach((listener) => listener());
}

export interface WorkspaceHookAdmissionInfo {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export interface WorkspaceHookPendingIndicatorProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  admission: WorkspaceHookAdmissionInfo | null;
}

/** Pending-review reminder beside the composer permissions; review actions keep reusing the
 *  original command binding. */
export const WorkspaceHookPendingIndicator = memo(function WorkspaceHookPendingIndicator({
  sessionId,
  workspacePath,
  workspaceIdentity,
  admission,
}: WorkspaceHookPendingIndicatorProps) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const commandBindings = useWorkspaceHookReviewStore((state) => state.commandBindings);
  const [open, setOpen] = useState(false);
  const reminderKey = JSON.stringify([sessionId, admission?.bundleDigest]);
  const reminderState = useSyncExternalStore(subscribeReminder, () =>
    reminderStates.get(reminderKey),
  );
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setReminderState(reminderKey, "read");
  };

  const handleReview = useCallback(() => {
    setOpen(false);
    // Open settings in two steps: set the settings intent, then open the tab (following V4ComposerToolbar's handleOpenModelProviderSettings).
    setPendingSettingsSectionIntent("hooks");
    openSettingsTab?.();

    // Send requestWorkspaceHookReview through the command binding.
    // This channel exists to preserve command access when there is no pending-review interaction.
    const binding = findWorkspaceHookCommandBinding(
      commandBindings,
      workspacePath,
      workspaceIdentity,
    );
    if (binding && admission) {
      const payload = {
        sessionId,
        workspaceIdentity: admission.workspaceIdentity ?? workspaceIdentity ?? workspacePath,
        bundleDigest: admission.bundleDigest,
      };
      void sendWorkspaceHookCommand(
        binding as Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
        sessionId,
        "requestWorkspaceHookReview",
        payload,
      ).catch((error) => {
        // Command failure does not block navigation — the user has reached settings and can continue manually.
        logger.warn("[workspace-hook-pending] requestWorkspaceHookReview 发送失败", {
          sessionId,
          bundleDigest: admission.bundleDigest,
          error,
        });
      });
    }
  }, [admission, commandBindings, openSettingsTab, sessionId, workspaceIdentity, workspacePath]);

  const handleDismiss = useCallback(() => {
    if (admission) {
      runUserAction({
        input: { featureId: "conversation.blocking.hook", action: "dismiss", trigger: "button" },
        operation: () => {
          setOpen(false);
          setReminderState(reminderKey, "dismissed");
        },
        completed: { resultSource: "local_commit" },
        failureStage: "hook_dismiss",
      });
    }
  }, [admission, reminderKey]);

  if (!admission || admission.pendingCount <= 0 || reminderState === "dismissed") {
    return null;
  }
  const message = intl.formatMessage(
    { id: "chat.workspaceHookPending.message" },
    { count: admission.pendingCount },
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          data-testid={TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER}
          aria-label={intl.formatMessage({ id: "chat.workspaceHookPending.label" })}
          aria-description={message}
          className="relative text-foreground-subtle"
        >
          <Anchor className="size-4" />
          {!reminderState ? (
            <span
              data-testid={TID_V4_WORKSPACE_HOOK_PENDING_UNREAD}
              aria-hidden="true"
              className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-brand"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        data-testid={TID_V4_WORKSPACE_HOOK_PENDING_POPOVER}
        aria-label={intl.formatMessage({ id: "chat.workspaceHookPending.label" })}
        className="w-80 max-w-[calc(100vw-24px)] gap-3 border-popover-border p-3"
      >
        <p className="text-ui-sm text-foreground">{message}</p>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid={TID_V4_WORKSPACE_HOOK_PENDING_DISMISS}
            className="rounded-lg text-foreground-subtle"
            onClick={handleDismiss}
          >
            {intl.formatMessage({ id: "chat.workspaceHookPending.dismiss" })}
          </Button>
          <Button
            type="button"
            data-testid={TID_V4_WORKSPACE_HOOK_PENDING_REVIEW}
            className="rounded-lg"
            onClick={handleReview}
          >
            {intl.formatMessage({ id: "chat.workspaceHookPending.review" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
});

export const WorkspaceMcpPendingIndicator = memo(function WorkspaceMcpPendingIndicator({
  sessionId,
  workspacePath,
  workspaceIdentity,
  admission,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  admission: WorkspaceMcpAdmissionSnapshotState;
}) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const [open, setOpen] = useState(false);
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  // MCP and Hook share the renderer subscription machinery; the kind and workspace take part
  // in the key so read/dismissed states do not overwrite each other.
  const reminderKey = JSON.stringify(["mcp", workspaceKey, sessionId, admission.bundleDigest]);
  const reminderState = useSyncExternalStore(subscribeReminder, () =>
    reminderStates.get(reminderKey),
  );
  if (
    admission.pendingCount <= 0 ||
    (admission.workspaceIdentity && admission.workspaceIdentity !== workspaceKey) ||
    reminderState === "dismissed"
  )
    return null;
  const message = intl.formatMessage(
    { id: "chat.workspaceMcpPending.message" },
    { count: admission.pendingCount },
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setReminderState(reminderKey, "read");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          data-testid={TID_V4_WORKSPACE_MCP_PENDING_TRIGGER}
          aria-label={intl.formatMessage({ id: "chat.workspaceMcpPending.label" })}
          aria-description={message}
          className="relative text-foreground-subtle"
        >
          <Cable className="size-4" />
          {!reminderState ? (
            <span
              data-testid={TID_V4_WORKSPACE_MCP_PENDING_UNREAD}
              aria-hidden="true"
              className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-brand"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        data-testid={TID_V4_WORKSPACE_MCP_PENDING_POPOVER}
        aria-label={intl.formatMessage({ id: "chat.workspaceMcpPending.label" })}
        className="w-80 max-w-[calc(100vw-24px)] gap-3 border-popover-border p-3"
      >
        <p className="text-ui-sm text-foreground">{message}</p>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid={TID_V4_WORKSPACE_MCP_PENDING_DISMISS}
            className="rounded-lg text-foreground-subtle"
            onClick={() => {
              setOpen(false);
              setReminderState(reminderKey, "dismissed");
              logger.info("[workspace-mcp-pending] dismissed", { sessionId, workspaceKey });
            }}
          >
            {intl.formatMessage({ id: "chat.workspaceMcpPending.dismiss" })}
          </Button>
          <Button
            type="button"
            data-testid={TID_V4_WORKSPACE_MCP_PENDING_REVIEW}
            className="rounded-lg"
            disabled={!openSettingsTab}
            onClick={() => {
              setOpen(false);
              // Pin the navigation to the current workspace; do not reuse whatever other target
              // the settings page last viewed.
              setPendingSettingsPluginIntent("mcps", { scopeKey: workspaceKey });
              openSettingsTab?.();
              logger.info("[workspace-mcp-pending] open settings", { sessionId, workspaceKey });
            }}
          >
            {intl.formatMessage({ id: "chat.workspaceMcpPending.review" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
});
