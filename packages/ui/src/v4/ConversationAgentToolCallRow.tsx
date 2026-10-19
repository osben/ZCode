import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { TID_V4_ROW, TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { getSubagentToolUsage, subscribeSubagentToolUsage } from "@/lib/messageTelemetry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { getAgentPrimaryText } from "@/ToolCallBlocks/renderers/agentHelpers.js";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

export function openSubagentSessionFromSummary({
  backgrounded: _backgrounded = false,
  childSessionId,
  context,
  subagentType,
  title,
}: {
  backgrounded?: boolean;
  childSessionId?: string;
  context: ConversationRowRenderContext;
  subagentType: string;
  title: string;
}): boolean {
  const parentSessionId = context.sessionId;
  const onOpenSubagentSession = context.onOpenSubagentSession;
  if (!childSessionId || !parentSessionId || !onOpenSubagentSession) {
    return false;
  }

  onOpenSubagentSession({
    rootSessionId: context.rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId,
    subagentType,
    title,
  });
  return true;
}

export function ConversationAgentToolCallRow({
  item,
  context,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "agentToolCall" }>;
  context: ConversationRowRenderContext;
}) {
  const { intl, locale } = useZCodeIntl();
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(item.row), [item.row]);
  const childSessionId = item.subagentRow.childSessionId;
  const subagentType = item.subagentRow.subagentType;
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath: context.workspacePath,
    ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    ...(context.workspaceRemoteSessionId
      ? { remoteSessionId: context.workspaceRemoteSessionId }
      : {}),
  });
  const usageSessionKey =
    context.sessionId && conversationTelemetry
      ? conversationTelemetry.getSubagentUsageSessionKey(context.sessionId)
      : "";
  const toolCallId = item.row.toolCallId;
  const subscribeUsage = useCallback(
    (listener: () => void) =>
      usageSessionKey
        ? subscribeSubagentToolUsage(usageSessionKey, toolCallId, listener)
        : () => {},
    [usageSessionKey, toolCallId],
  );
  const getUsage = useCallback(
    () => getSubagentToolUsage(usageSessionKey, toolCallId),
    [usageSessionKey, toolCallId],
  );
  const usage = useSyncExternalStore(subscribeUsage, getUsage, getUsage);
  const [now, setNow] = useState(() => Date.now());
  const isSubagentRunning = item.subagentRow.status === "running";
  useEffect(() => {
    if (!isSubagentRunning || item.subagentRow.startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isSubagentRunning, item.subagentRow.startedAt]);

  const durationEnd = item.subagentRow.endedAt ?? (isSubagentRunning ? now : undefined);
  const durationMs =
    item.subagentRow.startedAt !== undefined && durationEnd !== undefined
      ? Math.max(0, durationEnd - item.subagentRow.startedAt)
      : undefined;
  const durationLabel = formatConversationWorkDuration(durationMs, intl, locale);
  const inputCount = usage ? formatCompactTokenNumber(locale, usage.inputTokens) : null;
  const outputCount = usage ? formatCompactTokenNumber(locale, usage.outputTokens) : null;
  const inlineStats =
    usage || durationLabel ? (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-foreground-subtlest tabular-nums">
        {usage ? (
          <>
            <span
              className="inline-flex items-center gap-1"
              role="img"
              aria-label={`${intl.formatMessage({ id: "settings.usage.detail.inputTokens" })}: ${usage.inputTokens}`}
            >
              <ArrowDownToLine aria-hidden className="size-3.5" />
              {inputCount}
            </span>
            <span
              className="inline-flex items-center gap-1"
              role="img"
              aria-label={`${intl.formatMessage({ id: "settings.usage.detail.outputTokens" })}: ${usage.outputTokens}`}
            >
              <ArrowUpFromLine aria-hidden className="size-3.5" />
              {outputCount}
            </span>
          </>
        ) : null}
        {durationLabel ? (
          <>
            {usage ? <span aria-hidden>·</span> : null}
            <span>{durationLabel}</span>
          </>
        ) : null}
      </span>
    ) : null;
  const summaryTextVersion = [
    usage?.inputTokens ?? "",
    usage?.outputTokens ?? "",
    usage?.totalTokens ?? "",
    durationLabel ?? "",
  ].join(":");
  // Reuse the Agent summary row's title resolver so the visible title matches exactly in the right tab and on click.
  const title = getAgentPrimaryText(toolCallNode.toolCall, "");
  const canOpenChildSession = Boolean(
    childSessionId && context.sessionId && context.onOpenSubagentSession,
  );
  const handleOpenChildSession = useCallback(() => {
    runUserAction({
      input: { featureId: "conversation.subagent", action: "open_side_pane", trigger: "button" },
      operation: () =>
        openSubagentSessionFromSummary({ childSessionId, context, subagentType, title }),
      completed: { resultSource: "local_commit" },
      failureStage: "subagent_open",
    });
  }, [childSessionId, context, subagentType, title]);
  const agentSummaryAction = useMemo(
    () =>
      canOpenChildSession && childSessionId
        ? {
            onActivate: handleOpenChildSession,
            testId: testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId),
          }
        : undefined,
    [canOpenChildSession, childSessionId, handleOpenChildSession],
  );

  // Agent and regular tool rows are both part of the workflow. Do not add extra px-4 to the paired wrapper,
  // or its horizontal indentation will differ from an unpaired toolCall row.
  return (
    <div
      data-row-id={item.row.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.row.rowId))}
    >
      <ToolCallBlock
        toolCallNode={toolCallNode}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        agentSummaryAction={agentSummaryAction}
        authoritativeAgentType={subagentType}
        agentUsageSummary={inlineStats}
        agentUsageSummaryVersion={summaryTextVersion}
      />
    </div>
  );
}
