import { Gauge } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import {
  RUN_STATUS_TEXT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge, formatWorkflowTokenCount } from "@/lib/workflowObservationFormat.js";
import { WorkflowRunSubagentRoster } from "@/ToolCallBlocks/renderers/get-workflow-run-roster.js";
import {
  WorkflowRunHealthLine,
  WorkflowRunPhaseTrack,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const ICON = <Gauge className="size-4 shrink-0 text-foreground-subtle" />;

export function GetWorkflowRunToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const running = context.isRunning;
  // Query errors and run execution failures are separate state layers; after a query error, do not keep showing the old display.
  const failed = !running && toolCall.status === "failed";
  const run = !running && !failed && display?.kind === "get_workflow_run" ? display : undefined;
  const fallback = typeof toolCall.output === "string" ? toolCall.output.trim() : undefined;
  const failureLabel = intl.formatMessage({ id: "chat.toolCall.status.failed" });
  const error = context.errorText || fallback || failureLabel;
  const primaryText = useMemo(
    () =>
      run ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">
            {run.label ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" })}
          </span>
          <span aria-hidden>·</span>
          {/*
            When a summary exists, let it occupy the collapsed row: “Stage 2 of 4, 5 steps settled, 2 running”
            answers more than “5/7 steps.” Let CSS (truncate) handle clipping instead of cutting characters here;
            a partial sentence has the wrong length on both narrow and wide screens. Older payloads from before
            situation summaries were added still render the step count.
          */}
          {run.summary === undefined || run.summary.length === 0 ? (
            <span className="shrink-0 tabular-nums">
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.card.steps" },
                {
                  done: run.usage.nodesCompleted + run.usage.nodesFailed,
                  total: run.usage.nodesObserved,
                },
              )}
            </span>
          ) : (
            <span className="min-w-0 truncate" data-testid="workflow-run-summary-line">
              {run.summary}
            </span>
          )}
        </span>
      ) : undefined,
    [intl, run],
  );
  const hasDetails = !running && (failed || run !== undefined || Boolean(fallback));
  const renderContent = useCallback(() => {
    if (failed || !run)
      return (
        <p
          data-testid="workflow-status-body"
          className="mb-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground-subtle"
        >
          {failed ? error : fallback}
        </p>
      );
    return <GetWorkflowRunBody display={run} theme={context.theme} />;
  }, [failed, run, error, fallback, context.theme]);
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ICON}
        showIcon={context.showIcon !== false}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: running
              ? "chat.toolCall.workflow.getRun.fetching"
              : "chat.toolCall.workflow.getRun.fetched",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        isRunning={running}
        showFailureStatus={failed}
        statusLabel={failed ? failureLabel : undefined}
        statusTooltip={failed ? error : undefined}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        renderContent={hasDetails ? renderContent : undefined}
        title={toolCall.title}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}

function GetWorkflowRunBody({
  display,
  theme,
}: {
  display: ToolCallGetWorkflowRunDisplay;
  theme: ToolCallBlockRenderContext["theme"];
}) {
  const { intl } = useZCodeIntl();
  const terminal =
    display.status === "completed" || display.status === "errored" || display.status === "stopped";
  const stopReason = readWorkflowRunStopReason(display);
  const tokens = intl.formatMessage(
    { id: "chat.toolCall.workflow.run.usage.tokens" },
    { tokens: formatWorkflowTokenCount(display.usage.spentTokens) },
  );
  let json: string | undefined;
  if (display.result !== undefined) {
    try {
      const value: unknown = JSON.parse(display.result);
      if (value !== null && typeof value === "object") json = JSON.stringify(value, null, 2);
    } catch {
      /* Use body typography for ordinary text results. */
    }
  }
  const logs = display.logTail
    .map((entry) => {
      // Prefix the event age when the journal has a recorded time; otherwise show only the body.
      // Journals from before situation tracking launched do not have this column, and an invented
      // "just now" is worse than no age. Always calculate age relative to the snapshot time.
      const age = formatWorkflowAge(display.generatedAt, entry.at);
      const prefix =
        age === undefined
          ? ""
          : `${intl.formatMessage({ id: "chat.toolCall.workflow.getRun.age" }, { age })}  `;
      return `${prefix}${entry.message}`;
    })
    .filter((line) => line.trim())
    .join("\n");
  return (
    <div className="mb-2 min-w-0 space-y-2" data-testid="workflow-status-body">
      {/*
        Put the summary assembled by the tool first: it introduces the card, and the phase rail, roster, and
        health rows below expand on it. Older payloads have no summary, so the card starts with the first item
        (result/error).
      */}
      {display.summary === undefined || display.summary.length === 0 ? null : (
        <p className="break-words text-ui-base text-foreground" data-testid="workflow-run-summary">
          {display.summary}
        </p>
      )}
      {/*
        This is one of two places that make unknown state explicit: this session does not own the run, and a
        parked question exists only in the asking process's memory. Not seeing it does not mean it does not
        exist; silence would read as “nobody is waiting for an answer.”
      */}
      {display.health?.pendingQuestionsKnown === false ? (
        <p
          className="break-words text-ui-sm text-warning"
          data-testid="workflow-run-questions-unknown"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.questionsUnknown" })}
        </p>
      ) : null}
      {display.error ? (
        <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-destructive">
          {display.error.code}: {display.error.message}
        </p>
      ) : null}
      {display.status === "completed" && display.result ? (
        json ? (
          <CodeBlock
            code={json}
            language="json"
            appTheme={theme}
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            wrapLongLines
          >
            <CodeBlockHeader language="json" className="pl-3 pr-2 pt-2" />
          </CodeBlock>
        ) : (
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground">
            {display.result}
          </p>
        )
      ) : null}
      {display.phases === undefined ? null : (
        <WorkflowRunPhaseTrack
          generatedAt={display.generatedAt}
          phases={display.phases}
          terminal={terminal}
        />
      )}
      {display.subagents === undefined ? null : (
        <WorkflowRunSubagentRoster
          generatedAt={display.generatedAt}
          subagents={display.subagents}
        />
      )}
      {display.health === undefined ? null : (
        <WorkflowRunHealthLine
          generatedAt={display.generatedAt}
          health={display.health}
          terminal={terminal}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-ui-sm text-foreground-subtlest">
        <span className={RUN_STATUS_TEXT[display.status]}>
          {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${display.status}` })}
        </span>
        {stopReason ? (
          <span data-testid="workflow-run-stop-reason">
            {intl.formatMessage({ id: workflowRunStopReasonMessageId(stopReason) })}
          </span>
        ) : null}
        <span aria-hidden>·</span>
        {!terminal ? (
          <>
            <span>
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.card.steps" },
                {
                  done: display.usage.nodesCompleted + display.usage.nodesFailed,
                  total: display.usage.nodesObserved,
                },
              )}
            </span>
            <span aria-hidden>·</span>
            <span>
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.getRun.runningNodes" },
                { count: display.usage.nodesRunning },
              )}
            </span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span>{tokens}</span>
      </div>
      {display.status !== "completed" && logs ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
          {logs}
        </pre>
      ) : null}
      {display.possiblyInterrupted ? (
        <p className="text-ui-sm text-warning">
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.interruptedHint" })}
        </p>
      ) : null}
      {display.truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {/* This card truncates roster, phase, and log rows, not diagnostics; reusing create_workflow's
              “some diagnostics were omitted” message would misstate what was omitted. */}
          {intl.formatMessage({ id: "chat.toolCall.workflow.getRun.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
