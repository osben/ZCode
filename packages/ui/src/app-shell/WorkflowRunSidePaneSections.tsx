// ============================================================
// Section components for WorkflowRunSidePane (status header / terminal result area).
// ============================================================
// Split from WorkflowRunSidePane.tsx (eslint max-lines 400-line limit): that file handles
// data assembly and interaction wiring, while this file contains presentation-only sections. Props are fully prepared view values—it does not access
// projections, leases, or command channels.

import { workflowRunStopReasonMessageId } from "@/components/workflow-graph/run-status-presentation.js";
import { memo, type ReactNode } from "react";
import type { WorkflowRunSaveSlots } from "@/components/workflow-timeline/WorkflowRunSaveControls.js";
import {
  ArrowUpRightIcon,
  ListIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import type { WorkflowRunState, WorkflowRunUsage } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { workflowRunResultView } from "@/app-shell/workflowRunPanel.js";
import { workflowRunConcurrencyChip } from "@/app-shell/workflowRunThrottle.js";
import { WorkflowRunStatus } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { RunHolesWaitingChip } from "@/components/workflow-timeline/WorkflowHoleParts.js";
import { WorkflowTruncatedNotice } from "@/components/workflow-timeline/WorkflowTruncatedNotice.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";

const formatCount = (value: number): string => value.toLocaleString();

/**
 * Model segment of the summary row: when the run is configurable, this is a button too (underlined on hover) that opens the same "Configure" popover anchored to itself;
 * otherwise it is text with a tooltip.
 */
function SubagentModelSegment({
  children,
  className,
  configureOpen,
  onConfigureFrom,
  title,
}: {
  children: ReactNode;
  className?: string;
  configureOpen: boolean;
  onConfigureFrom?: (element: HTMLElement) => void;
  title: string;
}) {
  if (onConfigureFrom === undefined) {
    return (
      <span className={className} data-testid="workflow-run-subagent-model" title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      aria-expanded={configureOpen}
      aria-haspopup="dialog"
      className={`${className ?? ""} cursor-pointer rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40`}
      data-testid="workflow-run-subagent-model"
      onClick={(event) => onConfigureFrom(event.currentTarget)}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Status header: first row has the name and controls (Configure,
 * Resume, Stop); second row has the status indicator/label + concurrency chip—the three buttons crowd the status, so it gets its own row.
 * Below are the lineage row and summary row with the **same copy** as the chat-card footer—the same run must use the same sentence in both places.
 * If summary data is absent (chart unavailable, timeline cannot be built), fall back to the existing usage row.
 */
export const WorkflowRunStatusHeader = memo(function WorkflowRunStatusHeader({
  cancellable,
  configureOpen = false,
  onCancel,
  onConfigureFrom,
  onOpenSuccessor,
  onResume,
  rejection,
  resumable,
  run,
  saveSlots,
  subagentModel,
  summaryParts,
  title,
  usage,
}: {
  cancellable: boolean;
  /** Whether the Configure popover is open now (aria-expanded for the Configure button and model segment). */
  configureOpen?: boolean;
  onCancel: () => void;
  /**
   * Open the Configure popover anchored to the clicked element. If absent, this run cannot be configured: no Configure button and the model segment is plain text.
   */
  onConfigureFrom?: (element: HTMLElement) => void;
  /** Explanation for the latest rejected Stop/Resume; `detail` is the diagnostic carried by the ACK. */
  rejection?: { text: string; detail?: string };
  /** Open the successor that replaced this run (`run.supersededBy`); absent if the host cannot resolve the successor, leaving that row as static text. */
  onOpenSuccessor?: () => void;
  onResume: () => void;
  resumable: boolean;
  run: WorkflowRunState | undefined;
  /**
   * “Saved” chip and “Save”/“Run again” actions (docs/dynamic-workflow/transcript-and-notifications.md,
   * “Saving the run, and running it again”). The same run must use the same wording on the completion
   * card and here, so both use these nodes from the same controller. This component only positions
   * them: the verb before Stop and the chip on the second row. `null`/absent means there is no service context (render no controls).
   */
  saveSlots?: WorkflowRunSaveSlots | null;
  /**
   * Subagent model for this run: `name` is the visible label, and `title` contains the reasoning
   * level and canonical value (docs/dynamic-workflow/presentation.md, “The run pane”). The model
   * chip no longer appears on the first line of the status header—
   * the model is the first word on the second row, and both summary and fallback usage rows begin with it. If absent, there is nothing to show.
   */
  subagentModel?: { name: string; title: string };
  /** Segments in the summary row (`workflowSummaryParts`); fall back to the usage row when absent. */
  summaryParts: readonly string[] | undefined;
  title: string;
  usage: WorkflowRunUsage | undefined;
}) {
  const { intl } = useZCodeIntl();
  const saveChip = saveSlots?.leading ?? null;
  const saveVerb = saveSlots?.trailing ?? null;
  const cancelLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.cancel" });
  const resumeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.resume" });
  // Concurrency chip (docs/dynamic-workflow/concurrency.md, “What the user sees”): show it when
  // the effective ceiling (the lower of shared cap and this run's ceiling) is binding or the run
  // has a custom ceiling, and the run can be configured. Cooldown is a deadline, so tick once per second while it is active.
  const cooldownActive = run?.concurrency?.cooldownMs !== undefined;
  const now = useNowTicker(cooldownActive);
  const concurrency = workflowRunConcurrencyChip(run, now);
  // Lineage row (status header in docs/dynamic-workflow/presentation.md, “The run pane”): a retuned run says what it was changed from,
  // a superseded run points to its successor. These are not mutually exclusive (a revised run may later be superseded), so render separate rows.
  const resumedFrom = run?.resumedFrom;
  const supersededBy = run?.supersededBy;

  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        {/* The run name is an identifier: render it in monospace (DESIGN.md reserves font-mono for technical values). */}
        <span className="min-w-0 flex-1 truncate font-mono text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* Place Configure before Resume/Stop; it opens the configuration popover anchored below this button. */}
        {onConfigureFrom === undefined ? null : (
          <Button
            aria-expanded={configureOpen}
            aria-haspopup="dialog"
            data-testid="workflow-run-configure"
            onClick={(event) => onConfigureFrom(event.currentTarget)}
            size="sm"
            type="button"
            variant="outline"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.configure" })}
          </Button>
        )}
        {/* Render Resume only when the run can be resumed (see isWorkflowRunResumable); the button’s presence itself signals that the action is available. */}
        {resumable ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.resumeHint" })}
            side="bottom"
          >
            <Button
              aria-label={resumeLabel}
              data-testid="workflow-run-resume"
              onClick={onResume}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcwIcon className="size-3.5" />
              {resumeLabel}
            </Button>
          </ControlHintTooltip>
        ) : null}
        {/* Place Save / Run again before Stop: same order as the completed-card header—"keep it"
            first, "stop it" last. */}
        {saveVerb}
        {/* Stop uses the same icon as the card button (a solid square); the same action should look the same in both places. When available, its tooltip
            includes a second line explaining that the stopped run can be resumed. Since the action changed from “cancel,” make clear before clicking
            that stopping does not discard the run. When unavailable, show only the reason; there is no second line to add. */}
        <ControlHintTooltip
          title={
            cancellable
              ? cancelLabel
              : intl.formatMessage({ id: "chat.toolCall.workflow.run.cancelDisabled" })
          }
          side="bottom"
          {...(cancellable
            ? { description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }) }
            : {})}
        >
          <Button
            aria-label={cancelLabel}
            data-testid="workflow-run-cancel"
            disabled={!cancellable}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            <SquareIcon className="size-3.5 fill-current" />
            {cancelLabel}
          </Button>
        </ControlHintTooltip>
      </div>
      {/* Second row: status dot and label plus the concurrency chip. If the run is absent from the projection, omit the whole row. */}
      {run === undefined && concurrency === undefined && saveChip === null ? null : (
        <div
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2"
          data-testid="workflow-run-status-row"
        >
          {run ? <WorkflowRunStatus run={run} testId="workflow-run-status" /> : null}
          {/* “{n} holes to complete” (docs/dynamic-workflow/presentation.md, “Holes on the timeline”): use the same chip as on the card. */}
          <RunHolesWaitingChip run={run} testId="workflow-run-holes" />
          {/* Place the chip after the status label: the first row is already full with three buttons, and this chip is not an action. */}
          {saveChip}
          {/* “Max concurrency 4” shows how many subagents this run can have in flight at once—either
            the governor lowered the shared bucket below this run’s bound, or the user set this run’s
            own limit (above or below the default). This makes the reason for a fast or slow run
            immediately visible. Omit the whole block when running at the default or when the run can
            no longer be configured (completed / superseded).
            Match the status badge shape (border + text) and use the active color: this is runtime adjustment, not a failure. */}
          {concurrency === undefined ? null : (
            <span
              className="shrink-0 rounded-xs border border-warning/60 px-1.5 py-0.5 font-mono text-ui-xs leading-none text-warning"
              data-testid="workflow-run-concurrency"
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.concurrency.label" },
                { cap: String(concurrency.cap) },
              )}
              {concurrency.cooldownUntil === undefined
                ? null
                : ` · ${intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.concurrency.cooldown" },
                    { time: new Date(concurrency.cooldownUntil).toLocaleTimeString() },
                  )}`}
            </span>
          )}
        </div>
      )}

      {/* Rejected Stop/Resume: one sentence plus optional diagnostics. Use warning styling, not destructive styling; nothing happened, so nothing is broken. */}
      {rejection === undefined ? null : (
        <div
          className="mt-1.5 text-ui-xs text-warning"
          data-testid="workflow-run-rejection"
          role="status"
        >
          <span>{rejection.text}</span>
          {rejection.detail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejection.detail}
            </pre>
          )}
        </div>
      )}

      {resumedFrom === undefined ? null : (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-amends"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.amends" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={resumedFrom}>
            {resumedFrom}
          </span>
        </div>
      )}
      {supersededBy === undefined ? null : onOpenSuccessor === undefined ? (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-superseded-by"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
        </div>
      ) : (
        <button
          className="mt-1.5 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md text-left text-ui-xs text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="workflow-run-superseded-by"
          onClick={onOpenSuccessor}
          type="button"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 self-center" />
        </button>
      )}

      {summaryParts !== undefined ? (
        <div
          className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
          data-testid="workflow-run-usage"
        >
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          {summaryParts.map((part, i) => (
            <span className="flex items-center gap-x-2 tabular-nums" key={i}>
              {i > 0 ? (
                <span aria-hidden className="text-foreground-subtlest">
                  ·
                </span>
              ) : null}
              {i === 0 && subagentModel !== undefined ? (
                <SubagentModelSegment
                  configureOpen={configureOpen}
                  title={subagentModel.title}
                  {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
                >
                  {part}
                </SubagentModelSegment>
              ) : (
                <span>{part}</span>
              )}
            </span>
          ))}
        </div>
      ) : usage ? (
        // Usage is observational and has no limit to use as a denominator: show "Usage: N tokens · M steps" without a progress bar.
        <div
          className="mt-2 flex items-baseline justify-between gap-2"
          data-testid="workflow-run-usage"
        >
          {/* If the image is unavailable, omit the whole summary row; the model must still remain because it is a condition the user set for this run,
              independent of the image. Start this row with it too, using the same wording and tooltip as the summary row. */}
          <span className="flex min-w-0 items-baseline gap-2">
            {subagentModel === undefined ? null : (
              <SubagentModelSegment
                className="min-w-0 truncate text-ui-xs text-foreground-subtle"
                configureOpen={configureOpen}
                title={subagentModel.title}
                {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
              >
                {intl.formatMessage(
                  { id: "chat.toolCall.workflow.run.subagentModel.label" },
                  { model: subagentModel.name },
                )}
              </SubagentModelSegment>
            )}
            <span className="shrink-0 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.usage.label" })}
            </span>
          </span>
          <span className="font-mono text-ui-xs tabular-nums text-foreground">
            {intl.formatMessage(
              { id: "chat.toolCall.workflow.run.usage.value" },
              { tokens: formatCount(usage.spentTokens), steps: usage.nodesUsed },
            )}
          </span>
        </div>
      ) : null}
      {/* The “Showing details for n/m steps” line under the summary uses the same implementation as the card: the spine lists only instances retained in the table,
          while the count already includes instances outside it. This line explains that difference. */}
      <WorkflowTruncatedNotice className="mt-1.5" run={run} testId="workflow-run-truncated" />
    </div>
  );
});

/** Terminal area: untracked hint / completed artifact preview / error panel for failure or cancellation. Each is absent for other terminal states. */
export const WorkflowRunResultSections = memo(function WorkflowRunResultSections({
  result,
}: {
  result: ReturnType<typeof workflowRunResultView>;
}) {
  const { intl } = useZCodeIntl();

  return (
    <>
      {/* The run is absent from the projection because it was evicted or predates a cold-start CLI. Say only that live state is gone; do not imply the run disappeared. */}
      {result.kind === "absent" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-untracked"
        >
          <div className="text-ui-base text-foreground">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.title" })}
          </div>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.body" })}
          </p>
        </div>
      ) : null}

      {/* Result / failure panel */}
      {result.kind === "completed" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-result"
        >
          <div className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.title" })}
          </div>
          {result.preview === undefined ? (
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.completedHint" })}
            </p>
          ) : (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground">
              {result.preview}
            </pre>
          )}
        </div>
      ) : null}

      {result.kind === "error" ? (
        <div
          className="shrink-0 border-b border-destructive/40 px-4 py-3"
          data-testid="workflow-run-error"
        >
          <div className="text-ui-xs font-medium text-destructive">
            {intl.formatMessage({
              id:
                result.status === "stopped"
                  ? "chat.toolCall.workflow.run.result.stoppedTitle"
                  : "chat.toolCall.workflow.run.result.erroredTitle",
            })}
            {result.status === "stopped" && result.stopReason ? (
              <span
                className="font-normal text-foreground-subtle"
                data-testid="workflow-run-stop-reason"
              >
                {" · "}
                {intl.formatMessage({ id: workflowRunStopReasonMessageId(result.stopReason) })}
              </span>
            ) : null}
          </div>
          {/*
            The projection stores `WorkflowErrorJson.message` in `error`—the run-settled branch in product-projection.ts
            reads only `.message` (`code` is discarded), and the engine messages are short plain-language text:
            “run cancelled,” “typed ask ended without submitting a result,” and “node count exceeded the limit of 100.” So render it as
            body text rather than a monospace code block (DESIGN.md reserves font-mono for paths, commands, code, identifiers,
            and terminal data). Keep pre-wrap so any newlines in the message are preserved.
            There is no `code` to show and no other destination in the panel: the event log has been removed (2026-09-04
            user instruction; see docs/dynamic-workflow/presentation.md), and the structured payload
            remains only in the journal for the model and CLI, not for the person viewing this panel.
          */}
          <p
            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground"
            data-testid="workflow-run-error-message"
          >
            {result.message ??
              intl.formatMessage({ id: "chat.toolCall.workflow.run.result.noError" })}
          </p>
        </div>
      ) : null}
    </>
  );
});
