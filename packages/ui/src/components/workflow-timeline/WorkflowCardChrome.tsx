import type { ReactNode } from "react";
import { ChevronRightIcon, ListIcon, Maximize2Icon, Workflow } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  STATUS_DOT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
  isWorkflowRunSuperseded,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Workflow-card header and footer.
 *
 * Does not use `ToolLayout`: its summary row is `inline-flex self-start` and cannot fit a right-aligned status cluster.
 * The header is one row: icon + kind label + name, with light + status label + monospaced details + [⤢] + chevron on the right.
 * When there are more stations than fit in one column, there is no rank lane; hidden stations are on the timeline's own ledge.
 */
export const WORKFLOW_CARD_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;

/** Kind label after joining to a run: the same run must have the same name on its card, end-of-turn summary, notification, and details page. */
export const WORKFLOW_RUN_KIND_ID: Record<WorkflowRunState["status"], string> = {
  pending: "chat.toolCall.workflow.card.started",
  running: "chat.toolCall.workflow.card.running",
  completed: "chat.toolCall.workflow.card.completed",
  errored: "chat.toolCall.workflow.card.errored",
  stopped: "chat.toolCall.workflow.card.stopped",
};
/**
 * Neutral kind label when the run is absent from the live projection (evicted by the eight-item cap / no journal hit during cold recovery):
 * the card says only that a run existed here and does not claim a terminal state.
 */
export const WORKFLOW_RUN_ENDED_KIND_ID = "chat.toolCall.workflow.card.ended";

/** Kind label for a run superseded by a revision. */
export const WORKFLOW_RUN_SUPERSEDED_KIND_ID = "chat.toolCall.workflow.card.superseded";

/**
 * The sole entry point for kind labels: stopped ∧ superseded means "superseded"; otherwise look up by status.
 * All three consumers (card, end-of-turn summary, legacy host run card) use this so a superseded run is not labeled "stopped" in one place and "superseded" in another.
 */
export function workflowRunKindMessageId(run: {
  status: WorkflowRunState["status"];
  stopReason?: unknown;
}): string {
  return isWorkflowRunSuperseded(run)
    ? WORKFLOW_RUN_SUPERSEDED_KIND_ID
    : WORKFLOW_RUN_KIND_ID[run.status];
}

/** Run-level status: light + label, always paired (invariant 3). */
export function WorkflowRunStatus({
  className,
  status,
  run,
  testId,
}: {
  /** Falls back to `run.status` when absent; at least one is supplied. */
  status?: WorkflowRunState["status"];
  /**
   * Source object with `stopReason` (projected run/join summary): when `stopped`, the reason label follows the status label.
   * Read by shape rather than depending on a specific protocol type.
   *
   * `resumable` is a **state bit** supplied with the run from CLI.
   * When present and true, add a label after the reason. The UI must never infer it from status: "stopped" does not imply resumable.
   */
  run?:
    | { status: WorkflowRunState["status"]; stopReason?: unknown; resumable?: unknown }
    | undefined;
  className?: string;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const effectiveStatus = status ?? run?.status ?? "pending";
  const reason =
    run === undefined ? undefined : readWorkflowRunStopReason({ ...run, status: effectiveStatus });
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className={cn("wf-lamp size-2 shrink-0 rounded-full", RUN_STATUS_DOT[effectiveStatus])}
      />
      {/* Transition status labels by value: the old label exits and the new one enters (see the “Hover and motion” note, Kind section). */}
      <span
        className={cn("wf-swap text-ui-sm", RUN_STATUS_TEXT[effectiveStatus])}
        data-testid={testId}
        key={effectiveStatus}
      >
        {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${effectiveStatus}` })}
      </span>
      {reason ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-reason` : undefined}
        >
          · {intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}
        </span>
      ) : null}
      {/* The third label says this run can continue. “Stop” describes only the action, not its consequence; put that consequence back
          in the status row so users know they have not lost anything without opening the details first. */}
      {run?.resumable === true ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-resumable` : undefined}
        >
          · {intl.formatMessage({ id: "chat.toolCall.workflow.run.resumable" })}
        </span>
      ) : null}
    </span>
  );
}

/** Static status (not yet joined to a run): hollow ring + one label ("compiled"). */
export function WorkflowStaticStatus({ word }: { word: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT.pending)} />
      <span className="text-ui-sm text-foreground-subtle" data-testid="workflow-card-static-status">
        {word}
      </span>
    </span>
  );
}

export function WorkflowCardHeader({
  detail,
  detailTitle,
  expanded,
  kind,
  leading,
  live = false,
  name,
  onOpenDetails,
  onToggle,
  status,
  toggleLabel: toggleLabelOverride,
  trailing,
}: {
  /** Kind label; when it is a string, key by its text (a text change remounts and plays wf-swap). */
  kind: ReactNode;
  name: string;
  /** Shimmer for a running kind label (same expression as ToolLayout's isRunning). */
  live?: boolean;
  status?: ReactNode;
  detail?: string;
  /** Tooltip for details; supplied only when the subagent model exists (reasoning level and canonical string are shown here). */
  detailTitle?: string;
  /** Slot before status (the pending-question chip in the end-of-turn summary). */
  leading?: ReactNode;
  /** Slot after details and before ⤢ (the end-of-turn summary places Resume in the header). */
  trailing?: ReactNode;
  onOpenDetails?: () => void;
  expanded: boolean;
  /** Absent means it cannot collapse (forceOpen / canToggle=false). */
  onToggle?: () => void;
  /** Accessible name for the chevron; absent means "Expand/Collapse tool details" on tool cards. */
  toggleLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const openLabel = intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" });
  const toggleLabel =
    toggleLabelOverride ??
    intl.formatMessage({
      id: expanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
    });
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-ui-base"
      data-testid="workflow-card-header"
    >
      {WORKFLOW_CARD_ICON}
      {/* Swap kind labels by text (keyed by label, with the old label exiting as the new one enters). Wrap the wf-swap transition around the shimmer’s
          animated-gradient-text **outside**: background-clip:text clips only this layer’s text.
          Once a child is promoted to its own layer by a transform/opacity animation, its text becomes transparent and the header shows only a blank gap. */}
      <span className="shrink-0 whitespace-nowrap font-medium" data-testid="workflow-card-kind">
        <span className="wf-swap" key={typeof kind === "string" ? kind : undefined}>
          <span className={live ? "animated-gradient-text" : "text-foreground"}>{kind}</span>
        </span>
      </span>
      <span
        // This is UI text; card headers shared by tool summaries and cancellation statuses need the same adjustment.
        className="min-w-0 flex-1 truncate text-foreground-subtle"
        data-testid="workflow-card-name"
        title={name}
      >
        {name}
      </span>
      {/* The right group can shrink, and only the details string should give way: chips, status, and buttons are shrink-0 (built into the Button base class).
          Set min-w-0 + truncate on the details string so all negative space falls there and Configure / Stop / ⤢ stay inside the card.
          The group’s min-w-0 is required; do not remove it as redundant. A flex item’s automatic minimum size equals
          min-content, and truncate’s `white-space:nowrap` makes the details string’s min-content equal its full text width.
          Neither `overflow:hidden` nor the child’s min-w-0 makes it smaller. Without min-w-0 on the group, its minimum width
          is the full details string plus the buttons; it will not shrink at all, and the buttons still overflow the card (the issue fixed here).
          Browser measurements while narrowing the card: before the fix, buttons overflowed below 520px; after the fix, there is no overflow above 290px.
          With a pending-question chip, the threshold is 380px; the chip is also shrink-0 and raises the overall minimum width. */}
      <span className="flex min-w-0 items-center gap-2">
        {leading}
        {status}
        {detail === undefined || detail.length === 0 ? null : (
          <span
            className="min-w-0 truncate text-ui-base tabular-nums text-foreground-subtlest"
            data-testid="workflow-card-detail"
            {...(detailTitle === undefined ? {} : { title: detailTitle })}
          >
            {detail}
          </span>
        )}
        {trailing}
        {onOpenDetails === undefined ? null : (
          <ControlHintTooltip title={openLabel} side="top">
            <Button
              aria-label={openLabel}
              data-testid="workflow-card-open-details"
              onClick={onOpenDetails}
              size="icon-md"
              type="button"
              variant="ghost"
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        )}
        {onToggle === undefined ? null : (
          <Button
            aria-expanded={expanded}
            aria-label={toggleLabel}
            data-testid="workflow-card-toggle"
            onClick={onToggle}
            size="icon-md"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon
              className={cn("size-4 transition-transform", expanded && "rotate-90")}
            />
          </Button>
        )}
      </span>
    </div>
  );
}

/** Footer summary row: light + status label + checklist icon + segments separated by `·` + trailing control (Resume for failures). */
export function WorkflowCardFooter({
  parts = [],
  status,
  trailing,
}: {
  status: WorkflowRunState["status"];
  /** Summary segments; if absent or empty, render only the light, status label, and trailing control. */
  parts?: readonly string[];
  trailing?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
      data-testid="workflow-card-footer"
    >
      <WorkflowRunStatus status={status} />
      {parts.length > 0 ? (
        <>
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 tabular-nums">
            {parts.map((part, i) => (
              <span className="flex items-center gap-x-2" key={i}>
                {i > 0 ? (
                  <span aria-hidden className="text-foreground-subtlest">
                    ·
                  </span>
                ) : null}
                <span>{part}</span>
              </span>
            ))}
          </span>
        </>
      ) : null}
      {trailing}
    </div>
  );
}
