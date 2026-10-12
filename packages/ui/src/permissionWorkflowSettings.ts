// ============================================================
// The workflow confirmation dialog's "adjust settings": PermissionDialog side
// ============================================================
// docs/dynamic-workflow/launch.md "Adjusting the settings in the window" / "The options"; visuals
// and keyboard handling in docs/dynamic-workflow/presentation.md "The confirmation window".
//
// Split out of PermissionDialog.tsx: that file holds the option list shared by all confirmation
// dialogs; this one holds only the three things the workflow dialog adds — where changed settings
// are stored, which options carry them, and Shift+Tab from the option list back to the settings
// controls.

import { useCallback, useState } from "react";
import type { ZCodePermissionOption } from "@zcode/shared";
import type { WorkflowAskSettingsContent } from "@/components/workflow-timeline/workflowAskSettings.js";
import { getPermissionOptionDisplayKind } from "@/lib/permissionRequest.js";

/** Anchor attribute for the settings block: Shift+Tab from the first option lands here. */
export const WORKFLOW_PERMISSION_SETTINGS_SELECTOR = '[data-testid="workflow-permission-settings"]';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Settings changed in the dialog, and "the selected model is unavailable". Both states record the
 * requestId they belong to, and a mismatch on read counts as absent: the same dialog instance does
 * not reset via an effect when the request changes — after remount by requestId, the child reports
 * the new request's state first, and the parent's reset effect runs later and would wipe the newly
 * reported "unavailable".
 */
export function usePermissionWorkflowSettings(requestId: string) {
  const [content, setContent] = useState<{
    requestId: string;
    value: WorkflowAskSettingsContent | undefined;
  } | null>(null);
  const [blocked, setBlocked] = useState<{ requestId: string; value: boolean } | null>(null);
  const onContentChange = useCallback(
    (value: WorkflowAskSettingsContent | undefined) => setContent({ requestId, value }),
    [requestId],
  );
  const onBlockedChange = useCallback(
    (value: boolean) => setBlocked({ requestId, value }),
    [requestId],
  );
  return {
    content: content?.requestId === requestId ? content.value : undefined,
    blocked: blocked?.requestId === requestId && blocked.value,
    onBlockedChange,
    onContentChange,
  };
}

/** Settings travel only with an approval response: deny starts nothing, and Refine's next dialog retries with the model-adjusted call. */
export function isWorkflowSettingsCarrier(option: ZCodePermissionOption): boolean {
  const kind = getPermissionOptionDisplayKind(option.kind);
  return kind === "allowOnce" || kind === "allowAlways";
}

/** After settings change, the first two options state what this response carries; other descriptions unchanged. */
export function workflowAdjustedOptionDescriptionId(messageId: string | null): string | null {
  switch (messageId) {
    case "chat.permission.allowOnce.description":
      return "chat.permission.workflow.allowOnce.adjusted";
    case "chat.permission.workflow.allowForSession.description":
      return "chat.permission.workflow.allowForSession.adjusted";
    default:
      return messageId;
  }
}

/**
 * Shift+Tab on the first option: leave the option list and land on the settings block's last
 * control (the next stop when walking backwards), keeping focus order aligned with reading order.
 * Returns false when the block is absent or has no focusable controls, handing back to the option
 * list's own loop.
 */
export function focusLastWorkflowSettingsControl(root: HTMLElement | null): boolean {
  const block = root?.querySelector<HTMLElement>(WORKFLOW_PERMISSION_SETTINGS_SELECTOR);
  const controls = block?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const last = controls === undefined ? undefined : controls[controls.length - 1];
  if (last === undefined) return false;
  last.focus();
  return true;
}
