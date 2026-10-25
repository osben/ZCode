import { ArrowUpRightIcon } from "lucide-react";
import { useMemo } from "react";
import { WORKFLOW_CARD_ICON } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

/**
 * Completion row already included in the run (docs/dynamic-workflow/presentation.md, “The fill row”): “Hole completed · {name} · {k} stages
 * · {m} subagents ↗”. Counts are what this completion **added**, not totals for the whole run; the hole type is not shown.
 */
export interface WorkflowFillSummary {
  name: string;
  phases: number;
  agents: number;
}

export function WorkflowToolSummary({
  toolCallId,
  summary,
  onOpen,
  amend = false,
  fill,
}: {
  toolCallId: string;
  summary: WorkflowRunCardSummary;
  onOpen?: () => void;
  /** AmendWorkflow initiating row: replace the type label with "Workflow adjusted." */
  amend?: boolean;
  /** FillWorkflowHole row: hole wording and completion counts; `amend` is ignored when this is present. */
  fill?: WorkflowFillSummary;
}) {
  const { intl } = useZCodeIntl();
  // ToolLayout is memoized: inline JSX for primaryText would break memoization on every render (caught by the reactStableReferences test).
  // The count refers only to subagents; if the host provides no subagent count, leave that part empty and show only ↗.
  const agents = fill === undefined ? summary.agents : fill.agents;
  const primaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        {fill === undefined ? null : (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate" data-testid="workflow-summary-hole-name">
              {fill.name}
            </span>
            <span aria-hidden>·</span>
            <span data-testid="workflow-summary-hole-phases">
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.hole.phasesAdded" },
                { count: fill.phases },
              )}
            </span>
          </>
        )}
        <span aria-hidden>·</span>
        <span
          data-testid="workflow-summary-agents"
          className={
            onOpen
              ? "inline-flex items-center gap-2 group-hover/tool-summary:text-foreground group-focus-visible/tool-summary:text-foreground"
              : "inline-flex items-center gap-2"
          }
        >
          {agents === undefined
            ? null
            : intl.formatPlural({ id: "chat.toolCall.workflow.card.agents" }, agents)}
          {onOpen ? <ArrowUpRightIcon aria-hidden className="size-4 shrink-0" /> : null}
        </span>
      </span>
    ),
    [agents, fill, intl, onOpen],
  );
  const kindId =
    fill !== undefined
      ? "chat.toolCall.workflow.hole.filled"
      : amend
        ? "chat.toolCall.workflow.amend.amended"
        : "chat.toolCall.workflow.ran";
  return (
    <div
      data-testid="workflow-tool-summary"
      data-tool-call-id={toolCallId}
      data-workflow-run-id={summary.runId}
    >
      <ToolLayout
        toolId={toolCallId}
        icon={WORKFLOW_CARD_ICON}
        kindLabel={intl.formatMessage({ id: kindId })}
        canToggle={false}
        primaryText={primaryText}
        summaryAction={
          onOpen
            ? {
                ariaLabel: intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" }),
                onActivate: onOpen,
              }
            : undefined
        }
      />
    </div>
  );
}
