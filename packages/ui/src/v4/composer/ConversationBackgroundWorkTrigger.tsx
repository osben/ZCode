import { memo, useMemo } from "react";
import { ActivityIcon, MoonIcon, BotIcon, SquareTerminalIcon, Workflow } from "lucide-react";
import { TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER } from "@zcode/shared/test-ids";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { getLatestDreamWork } from "@/v4/conversationStatusPanelModel.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ComposerBackgroundWorkCounts {
  dreamCount: number;
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
}

export function getComposerBackgroundWorkCounts(
  backgroundWorks: readonly BackgroundWorkSummary[],
  runningSubagentCount = 0,
): ComposerBackgroundWorkCounts {
  let dreamCount = 0;
  let bashCount = 0;
  let workflowCount = 0;
  for (const work of backgroundWorks) {
    if (work.status !== "running") continue;
    if (work.kind === "dream") {
      dreamCount += 1;
    } else if (work.kind === "bash") {
      bashCount += 1;
    } else if (work.kind === "workflow") {
      // Count workflow runs separately; do not add them to bashCount. totalCount summarizes all three kinds of background work,
      // ensuring the badge appears when workflow runs are the only background work, so users can still open the pane and use the Stop button.
      workflowCount += 1;
    }
  }
  const subagentCount = Math.max(0, runningSubagentCount);
  return {
    dreamCount,
    bashCount,
    workflowCount,
    subagentCount,
    totalCount: dreamCount + bashCount + workflowCount + subagentCount,
  };
}

export interface ConversationBackgroundWorkTriggerProps {
  backgroundWorks: readonly BackgroundWorkSummary[];
  runningSubagentCount?: number;
  onOpen?: () => void;
  /**
   * onOpen destination:
   * for `"workflow-run"`, the tooltip says “Open workflow details”; otherwise keep the type-based “Open running …” wording.
   * The host makes the decision (it needs toolCallId and a host callback, neither visible to the badge); this component only reports it.
   */
  openTarget?: "panel" | "workflow-run";
}

function ConversationBackgroundWorkTriggerImpl({
  backgroundWorks,
  runningSubagentCount = 0,
  onOpen,
  openTarget = "panel",
}: ConversationBackgroundWorkTriggerProps) {
  const { intl } = useZCodeIntl();
  const counts = useMemo(
    () => getComposerBackgroundWorkCounts(backgroundWorks, runningSubagentCount),
    [backgroundWorks, runningSubagentCount],
  );

  const latestDream = getLatestDreamWork(backgroundWorks);
  if (!onOpen || (counts.totalCount === 0 && !latestDream)) return null;

  // Use one mixed tooltip; exact per-kind counts remain in the badge and accessible label.
  const activeKindCount = [
    counts.bashCount,
    counts.workflowCount,
    counts.subagentCount,
    counts.dreamCount,
  ].filter((count) => count > 0).length;
  const tooltip = intl.formatMessage({
    id:
      counts.totalCount === 0 && latestDream
        ? "chat.composer.backgroundWorks.tooltipDreamResult"
        : counts.dreamCount > 0 && activeKindCount === 1
          ? "chat.composer.backgroundWorks.tooltipDream"
          : openTarget === "workflow-run"
            ? "chat.composer.backgroundWorks.tooltipWorkflowDetails"
            : activeKindCount > 1
              ? "chat.composer.backgroundWorks.tooltipMixed"
              : counts.bashCount > 0
                ? "chat.composer.backgroundWorks.tooltipTerminal"
                : counts.workflowCount > 0
                  ? "chat.composer.backgroundWorks.tooltipWorkflow"
                  : "chat.composer.backgroundWorks.tooltipAgent",
  });
  const ariaLabel = intl.formatMessage(
    { id: "chat.composer.backgroundWorks.ariaLabel" },
    {
      dreamCount: String(counts.dreamCount),
      bashCount: String(counts.bashCount),
      workflowCount: String(counts.workflowCount),
      subagentCount: String(counts.subagentCount),
      count: String(counts.totalCount),
    },
  );

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}
        data-background-dream-count={counts.dreamCount}
        data-background-bash-count={counts.bashCount}
        data-background-workflow-count={counts.workflowCount}
        data-background-subagent-count={counts.subagentCount}
        data-background-total-count={counts.totalCount}
        data-background-open-target={openTarget}
        aria-label={counts.totalCount === 0 ? tooltip : ariaLabel}
        onClick={onOpen}
        className="rounded-lg px-1.5 text-ui-base text-[var(--color-foreground-subtle)] tabular-nums"
      >
        <span
          data-composer-background-layout="typed"
          className="inline-flex items-center gap-1 @max-[480px]/composer:hidden"
          aria-hidden
        >
          {/* Keep the terminal first, preserving the visual order from before workflow was split out;
              place workflow between the terminal and agents. */}
          {counts.bashCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <SquareTerminalIcon className="size-3.5" />
              <span>{counts.bashCount}</span>
            </span>
          ) : null}
          {counts.workflowCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Workflow className="size-3.5" />
              <span>{counts.workflowCount}</span>
            </span>
          ) : null}
          {counts.dreamCount > 0 || (counts.totalCount === 0 && latestDream) ? (
            <span className="inline-flex items-center gap-0.5">
              <MoonIcon className="size-3.5" />
              {counts.dreamCount > 0 ? <span>{counts.dreamCount}</span> : null}
            </span>
          ) : null}
          {counts.subagentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <BotIcon className="size-3.5" />
              <span>{counts.subagentCount}</span>
            </span>
          ) : null}
        </span>
        <span
          data-composer-background-layout="compact"
          className="hidden items-center gap-0.5 @max-[480px]/composer:inline-flex"
          aria-hidden
        >
          {counts.totalCount > 0 ? (
            <>
              <ActivityIcon className="size-3.5" />
              <span>{counts.totalCount}</span>
            </>
          ) : (
            <MoonIcon className="size-3.5" />
          )}
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ConversationBackgroundWorkTrigger = memo(ConversationBackgroundWorkTriggerImpl);
