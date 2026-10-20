import { memo } from "react";
import {
  TID_V4_PANE_WORKSPACE_BADGE,
  TID_V4_SESSION_TITLE,
  TID_V4_SPLIT_CLOSE,
} from "@zcode/shared/test-ids";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

/** Ownership badge for a pane in another workspace (extend this for multi-path badges in cross-workspace sessions). */
export interface PaneWorkspaceBadge {
  /** Display name (workspacePath basename). */
  label: string;
  /** Full path (tooltip). */
  workspacePath: string;
  /** Remote workspace (SSH/WSL/Docker) indicator. */
  remote: boolean;
}

export interface ConversationHeaderProps {
  /** meta.title; used only for tests/observable projection, with no placeholder header rendered. */
  title: string;
  /** Split a new draft pane to the right (the host omits this at the leaf limit). */
  onSplitRight?: () => void;
  /** Split a new draft pane below. */
  onSplitDown?: () => void;
  /** Close this pane (sent only for non-primary panes; closing a pane does not stop the session). */
  onClosePane?: () => void;
  /** Ownership badge for a pane in another workspace (sent when the pane workspace differs from the shell's current workspace). */
  workspaceBadge?: PaneWorkspaceBadge;
}

/**
 * Pane chrome does not take layout height; split/close actions float in the upper-right corner.
 * Keep the title data node for E2E projection reads without restoring the old toolbar.
 */
function ConversationHeaderImpl({ title, onClosePane, workspaceBadge }: ConversationHeaderProps) {
  const { intl } = useZCodeIntl();
  const hasFloatingActions = Boolean(workspaceBadge) || Boolean(onClosePane);

  return (
    <>
      <span data-testid={TID_V4_SESSION_TITLE} data-title={title} className="sr-only" />
      {hasFloatingActions ? (
        <div
          data-v4-pane-actions="floating"
          className="pointer-events-none absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1"
        >
          {workspaceBadge ? (
            <span
              data-testid={TID_V4_PANE_WORKSPACE_BADGE}
              data-remote={workspaceBadge.remote ? "true" : "false"}
              title={workspaceBadge.workspacePath}
              className="pointer-events-auto flex h-7 max-w-[10rem] shrink items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-2 font-mono text-ui-base text-[var(--color-foreground-subtle)] shadow-md"
            >
              <span className="truncate">{workspaceBadge.label}</span>
              {workspaceBadge.remote ? (
                <span className="shrink-0">{intl.formatMessage({ id: "v4Pane.remote" })}</span>
              ) : null}
            </span>
          ) : null}
          {/* 2026-07-13: the product temporarily hides pane chrome split actions; keep the callback interface and underlying capability for future restoration. */}
          {/* {onSplitRight ? (
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              data-testid={TID_V4_SPLIT_OPEN}
              onClick={onSplitRight}
              title={intl.formatMessage({ id: "v4Pane.splitRightTitle" })}
              aria-label={intl.formatMessage({ id: "v4Pane.splitRight" })}
              className="pointer-events-auto bg-[var(--color-popover)] shadow-md"
            >
              <SquareSplitHorizontalIcon className="size-4" />
            </Button>
          ) : null} */}
          {/* {onSplitDown ? (
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              data-testid={TID_V4_SPLIT_DOWN}
              onClick={onSplitDown}
              title={intl.formatMessage({ id: "v4Pane.splitDownTitle" })}
              aria-label={intl.formatMessage({ id: "v4Pane.splitDown" })}
              className="pointer-events-auto bg-[var(--color-popover)] shadow-md"
            >
              <SquareSplitVerticalIcon className="size-4" />
            </Button>
          ) : null} */}
          {onClosePane ? (
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              data-testid={TID_V4_SPLIT_CLOSE}
              onClick={() =>
                runUserAction({
                  input: { featureId: "task.layout", action: "close_pane", trigger: "button" },
                  operation: onClosePane,
                  completed: { resultSource: "local_commit" },
                  failureStage: "pane_close",
                })
              }
              title={intl.formatMessage({ id: "v4Pane.closePaneTitle" })}
              aria-label={intl.formatMessage({ id: "v4Pane.closePane" })}
              className="pointer-events-auto bg-[var(--color-popover)] shadow-md"
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export const ConversationHeader = memo(ConversationHeaderImpl);
