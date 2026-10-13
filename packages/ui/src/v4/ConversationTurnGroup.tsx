import { BotTopicPreparation } from "@/v4/BotTopicPreparation.js";
import { useBotTopicInterruption } from "@/v4/botGroupDeliveryContext.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
/* eslint-disable max-lines -- The turn group must maintain the strict row order of regular assistant content and background results in one place; splitting it would duplicate the actions/preview/tail protocol. */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";
import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_BACKGROUND_RESULT_TITLE,
  TID_CHAT_LOADING,
  TID_V4_ROW,
  testId,
  type HighspeedMessageMeta,
  type ZCodeApiRetryStatus,
} from "@zcode/shared";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRowTarget,
  WorkflowNotificationMeta,
} from "@zcode/shared/zcode-protocol-v4";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { ChatApiRetryStatus } from "@/chat-input-toolbar/display.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { MessageActions } from "@/components/ai-elements/message.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import {
  CronCreateAutomationCard,
  isCronAutomationCardToolCall,
  readCronCreateAutomationSummary,
  type CronCreateAutomationSummary,
} from "@/ToolCallBlocks/renderers/cron-create.js";
import {
  isOffPeakCreateToolCall,
  OffPeakCreateTaskCard,
  readOffPeakCreateTaskSummary,
  type OffPeakCreateTaskSummary,
} from "@/ToolCallBlocks/renderers/offpeak-create.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { HighspeedShareDialog } from "@/highspeed/HighspeedShareNoticeCard.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";
import {
  aggregateHighspeedCardMetrics,
  getHighspeedTurnByCommandId,
  getHighspeedTurnVersion,
  subscribeHighspeedTurns,
  type HighspeedShareMetrics,
} from "@/highspeed/highspeedTurnStore.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";
import {
  buildAssistantWorkRenderItems,
  ENABLE_CHANGES_TOOL_CALL_GROUPING,
  ENABLE_CUA_TOOL_CALL_GROUPING,
  ENABLE_EXPLORE_TOOL_CALL_GROUPING,
  ENABLE_TERMINAL_TOOL_CALL_GROUPING,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import { WorkflowNotificationToolRow } from "@/v4/WorkflowNotificationToolRow.js";
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
import { resolveWorkflowTurnDigests } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";
import { ConversationAssistantTextActions } from "@/v4/ConversationRowView.js";
import { readAssistantFeedback } from "@/v4/ConversationRowView.js";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
  RowPinChangeHandler,
} from "@/v4/ConversationRowView.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type {
  AssistantWorkRow,
  ConversationTurnFlowItem,
  ConversationTurnRenderUnit,
  ConversationTurnWorkSegment,
} from "@/v4/conversationTurnRenderUnits.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import {
  resolveSegmentStreamingContent,
  useStreamingThroughput,
} from "@/v4/conversationStreamingThroughput.js";
import { formatTokensPerSecond, useSessionThroughput } from "@/hooks/useSessionThroughput.js";
import { ConversationTurnRow, resolveAssistantCopyText } from "@/v4/ConversationTurnRow.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

interface ConversationTurnGroupProps {
  unit: ConversationTurnRenderUnit;
  /** Shared UI clock for the timeline; removes the running purple shimmer immediately at the Highspeed expiry boundary. */
  nowMs?: number;
  /** Injected by Timeline only for the current live turn; historical turns never carry runtime retry state. */
  apiRetry?: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  /** Display-only pin bookmark toggle (setRowPinned); threaded like onEdit so user rows can unpin. */
  onPinChange?: RowPinChangeHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** Show the selection control for this turn to the left of the body during the share-selection stage. */
  shareSelection?: {
    eligibleRowIds: ReadonlySet<number>;
    selectedRowIds: ReadonlySet<number>;
    onToggle: (rowId: number) => void;
  };
}

interface CronAutomationTurnCard {
  rowId: number;
  toolCallId: string;
  automation: CronCreateAutomationSummary;
}

interface OffPeakTurnCard {
  rowId: number;
  toolCallId: string;
  task: OffPeakCreateTaskSummary;
}

const MIN_VISIBLE_API_RETRY_ATTEMPT = 3;

interface HighspeedOutputFooterProps {
  generatedLabel: string;
  shareLabel: string;
  shareAriaLabel: string;
  shareEnabled: boolean;
  sharePending: boolean;
  onShare: () => void;
}

function HighspeedOutputFooter({
  generatedLabel,
  shareLabel,
  shareAriaLabel,
  shareEnabled,
  sharePending,
  onShare,
}: HighspeedOutputFooterProps) {
  return (
    <div
      data-highspeed-output-footer="true"
      className="relative flex w-full items-center justify-center py-[18px] opacity-80"
    >
      <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border" />
      <div className="relative flex items-center gap-2 bg-background px-3">
        <span className="text-ui-base text-foreground-subtle">{generatedLabel}</span>
        {shareEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="default"
            className="h-7 gap-1 rounded-[8px] bg-black/5 px-2 py-1 text-ui-base font-medium leading-5 text-foreground hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            data-highspeed-output-share="true"
            disabled={sharePending}
            aria-label={shareAriaLabel}
            onClick={onShare}
          >
            <EyeIcon
              className="size-4 text-foreground/85"
              strokeWidth={4 / 3}
              aria-hidden="true"
              data-highspeed-output-share-icon="true"
            />
            {shareLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function toRetryStatus(apiRetry: ApiRetryState): ZCodeApiRetryStatus {
  const attempt = Math.max(1, Math.floor(apiRetry.attempt));
  // v4 maxAttempts includes the initial request, while the UI shows retry count; displaying it directly would make
  // the default 10 retries appear as 1/11.
  const maxRetries = Math.max(Math.floor(apiRetry.maxAttempts) - 1, attempt);
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs: 0,
    errorStatus: null,
    error: apiRetry.reasonCode,
  };
}

function TurnChatLoadingSlot({
  apiRetry,
  eligible,
}: {
  apiRetry: ApiRetryState | null;
  eligible: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const retryStatus = useMemo(() => (apiRetry ? toRetryStatus(apiRetry) : null), [apiRetry]);
  // The first two brief recoveries are equivalent to normal loading from the user’s perspective. Keep the apiRetry runtime state, but show the counter only
  // from the third retry onward. This must be settled before the retry/loading branch; otherwise it leaves an empty slot
  // instead of falling back to ChatLoading.
  const visibleRetryStatus =
    retryStatus && retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT ? retryStatus : null;
  if (!visibleRetryStatus && !eligible) return null;
  return (
    <div data-zcode-chat-loading-slot="true" className="min-h-5">
      {visibleRetryStatus ? (
        <ChatApiRetryStatus apiRetry={visibleRetryStatus} intl={intl} locale={locale} />
      ) : (
        // running is the authoritative fact for ChatLoading; a separate quiet timer would repeatedly restart visibility on projection
        // updates and make the UI lag behind the actual state.
        <ChatLoading loading data-testid={TID_CHAT_LOADING} size="sm" />
      )}
    </div>
  );
}

function ConversationExploreGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "exploreGroup" }>;
  context: ConversationRowRenderContext;
}) {
  // The explore group row already sits inside the turn container’s shared padding; adding px-4 again
  // would make some tools in the same sequence more indented than others.
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
      />
    </div>
  );
}

function ConversationToolGroupRow({
  item,
  context,
}: {
  item: Extract<
    ConversationAssistantWorkRenderItem,
    { kind: "cuaGroup" | "executeGroup" | "changesGroup" }
  >;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>) => (
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  const visibleCuaEvents = useMemo(
    () =>
      item.kind === "cuaGroup"
        ? item.events.filter(
            (event) =>
              event.kind !== "reasoning" ||
              isConversationReasoningRowVisible(event.row.rowId, context),
          )
        : undefined,
    [context, item],
  );
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        // In the history/background compatibility path, passing only a virtual parent node means the grouped projection consumes these
        // Assistant message/reasoning items without giving them to the renderer, permanently losing them when expanded.
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={item.kind === "cuaGroup" ? renderAssistantMessage : undefined}
        renderCuaReasoning={item.kind === "cuaGroup" ? renderReasoning : undefined}
      />
    </div>
  );
}

function ConversationCuaGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationTurnFlowItem, { kind: "cuaGroup" }>;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "reasoning" }>) => (
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  const visibleCuaEvents = useMemo(
    () =>
      item.events.filter(
        (event) =>
          event.kind !== "reasoning" || isConversationReasoningRowVisible(event.row.rowId, context),
      ),
    [context, item.events],
  );
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={renderAssistantMessage}
        renderCuaReasoning={renderReasoning}
      />
    </div>
  );
}

function ConversationAssistantWorkItems({
  rows,
  context,
  stageTailIsRunning = false,
  assistantCodeCommentProjectionEnabled = false,
  historyContainer,
}: {
  rows: readonly AssistantWorkRow[];
  context: ConversationRowRenderContext;
  stageTailIsRunning?: boolean;
  /** The body of a running turn may temporarily appear in the history renderer and still needs to hide specialized protocol text. */
  assistantCodeCommentProjectionEnabled?: boolean;
  historyContainer?: {
    chunkKey: string;
    open: boolean;
  };
}) {
  const showReasoning = context.messageStreamShowReasoning === true;
  const firstReasoningRowId = context.messageStreamFirstReasoningRowId;
  const items = useMemo(
    () =>
      buildAssistantWorkRenderItems(
        rows,
        {
          messageStreamShowReasoning: showReasoning,
          ...(firstReasoningRowId !== undefined
            ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
            : {}),
        },
        {
          stageTailIsRunning,
          enableCuaGrouping: ENABLE_CUA_TOOL_CALL_GROUPING,
          enableExploreGrouping:
            context.toolGroupingExploreEnabled ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING,
          enableTerminalGrouping:
            context.toolGroupingTerminalEnabled ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING,
          enableChangesGrouping:
            context.toolGroupingChangesEnabled ?? ENABLE_CHANGES_TOOL_CALL_GROUPING,
        },
      ),
    [
      context.toolGroupingChangesEnabled,
      context.toolGroupingExploreEnabled,
      context.toolGroupingTerminalEnabled,
      stageTailIsRunning,
      firstReasoningRowId,
      rows,
      showReasoning,
    ],
  );

  // The history shell cannot be created before projection here: when CUA consumes the original message
  // or a running shell is classified later, it leaves pt-5 and an empty gap-4 container. Create CollapsibleContent only after confirming
  // that the inner content contains renderable items, so the shell disappears with the content.
  if (items.length === 0) {
    return null;
  }

  // Group consecutive work items (tools/explore/reasoning) in a shared gap-4 container (matching the old tool-call-group),
  // replacing the parent’s inherited gap-5/gap-2 plus per-row py-2, which produced double and inconsistent spacing.
  const content = (
    <div className="flex flex-col gap-4">
      {items.map((item) =>
        item.kind === "row" ? (
          <ConversationTurnRow
            key={item.key}
            row={item.row}
            context={context}
            hideAssistantActions={item.row.kind === "assistantText"}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        ) : item.kind === "agentToolCall" ? (
          <ConversationAgentToolCallRow key={item.key} item={item} context={context} />
        ) : item.kind === "exploreGroup" ? (
          <ConversationExploreGroupRow key={item.key} item={item} context={context} />
        ) : (
          <ConversationToolGroupRow key={item.key} item={item} context={context} />
        ),
      )}
    </div>
  );

  if (!historyContainer) {
    return content;
  }

  return (
    <CollapsibleContent
      data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, historyContainer.chunkKey)}
      data-history-open={String(historyContainer.open)}
    >
      <div className="pt-5">{content}</div>
    </CollapsibleContent>
  );
}

function resolveCronAutomationTurnCards(
  rows: readonly AssistantWorkRow[],
): CronAutomationTurnCard[] {
  let cards: CronAutomationTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }

    const normalizedToolName = row.toolName.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (normalizedToolName === "crondelete") {
      const deletedAutomationId = readCronDeleteAutomationId(row);
      if (deletedAutomationId) {
        // Counting only successful Create/Update items this turn ignores a later CronDelete, leaving an already
        // revoked intermediate result promoted as a successful turn-tail card.
        cards = cards.filter((card) => card.automation.automationId !== deletedAutomationId);
      }
      continue;
    }

    const node = toolCallRowToLegacyNode(row);
    if (!isCronAutomationCardToolCall(node.toolCall)) {
      continue;
    }

    const automation = readCronCreateAutomationSummary(node.toolCall);
    if (!automation) {
      continue;
    }

    if (automation.automationId) {
      cards = cards.filter((card) => card.automation.automationId !== automation.automationId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      automation,
    });
  }

  return cards;
}

// Collect only this turn’s status === "success" OffPeakCreate items; for duplicate IDs, keep the latest.
// Deliberately do not reuse resolveCronAutomationTurnCards: it includes CronDelete revocation filtering, which has no matching tool in OffPeak.
function resolveOffPeakTurnCards(rows: readonly AssistantWorkRow[]): OffPeakTurnCard[] {
  let cards: OffPeakTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }
    const node = toolCallRowToLegacyNode(row);
    if (!isOffPeakCreateToolCall(node.toolCall)) {
      continue;
    }
    const task = readOffPeakCreateTaskSummary(node.toolCall);
    if (!task) {
      continue;
    }
    if (task.offPeakTaskId) {
      cards = cards.filter((card) => card.task.offPeakTaskId !== task.offPeakTaskId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      task,
    });
  }

  return cards;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function readCronDeleteAutomationId(
  row: Extract<AssistantWorkRow, { kind: "toolCall" }>,
): string | undefined {
  for (const candidate of [row.output?.text, row.input, row.inputText]) {
    const record = parseJsonRecord(candidate);
    const id = record?.id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

function CronAutomationTurnCards({
  cards,
  context,
}: {
  cards: readonly CronAutomationTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <CronCreateAutomationCard
          key={`${card.rowId}:${card.toolCallId}`}
          automation={card.automation}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function OffPeakTurnCards({
  cards,
  context,
}: {
  cards: readonly OffPeakTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <OffPeakCreateTaskCard
          key={`${card.rowId}:${card.toolCallId}`}
          task={card.task}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function AssistantHistoryStatus({
  segment,
  open,
  context,
  highspeed,
  highspeedMeta,
  sourceCommandIds,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  context: ConversationRowRenderContext;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
  sourceCommandIds: readonly string[];
}) {
  const { intl, locale } = useZCodeIntl();
  const topicInterrupted = useBotTopicInterruption(sourceCommandIds);
  const durationLabel = formatConversationWorkDuration(
    segment.workStatus?.durationMs,
    intl,
    locale,
  );
  const isRunning = segment.workStatus?.state === "running";
  const { tokensPerSecond } = useSessionThroughput({
    // Poll throughput only for running segments; do not backfill a final value for “worked N” on completed segments,
    // which would leave stale facts from outside the polling period in history rows.
    enabled: isRunning,
    sessionId: context.sessionId,
    workspaceIdentity: context.workspaceIdentity,
    workspacePath: context.workspacePath,
  });
  // During streaming (including thinking), prefer a live estimate: an exact value is produced only when a request
  // completes, so it will not refresh during a single long response. Estimate from the streaming row using the cumulative
  // average (cumulative tokens / cumulative duration), display it with a ~ prefix, and fall back to the exact value after
  // the character stream has been quiet (tool execution/request gap) longer than the window.
  const segmentStreamingContent = resolveSegmentStreamingContent(segment.assistantWorkRows);
  const streamingTokensPerSecond = useStreamingThroughput({
    enabled: isRunning,
    contentKey: segmentStreamingContent.key,
    text: segmentStreamingContent.text,
  });
  const isEstimate = streamingTokensPerSecond !== null;
  const throughputTokensPerSecond = isEstimate ? streamingTokensPerSecond : tokensPerSecond;
  const savedDurationLabel =
    segment.workStatus?.state === "completed" &&
    highspeedMeta?.savedDurationMs !== undefined &&
    highspeedMeta.savedDurationMs > 0
      ? formatConversationWorkDuration(highspeedMeta.savedDurationMs, intl, locale)
      : null;
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({
          id: topicInterrupted ? "chat.history.topicInterrupted" : "chat.history.stopped",
        })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel ?? "" })
        : durationLabel
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration: durationLabel })
          : intl.formatMessage({ id: "chat.history.worked" });

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-2 border-b",
        highspeed ? "border-icon-purple/30 pb-3 pl-1" : "border-[var(--color-border)]/50 pb-2",
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_TRIGGER, segment.key)}
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <span
            className={cn("truncate", highspeed && "font-medium leading-5 text-icon-purple")}
            data-highspeed-duration={highspeed ? "true" : undefined}
          >
            {label}
          </span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-[var(--color-foreground-subtlest)] opacity-70 transition-transform",
                open ? "rotate-90" : "rotate-0",
              )}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
      {highspeed ? (
        <div className="ml-auto flex shrink-0 items-center gap-2 text-icon-purple">
          {savedDurationLabel ? (
            <span className="text-ui-sm font-medium leading-4" data-highspeed-saved-duration="true">
              {intl.formatMessage(
                { id: "chat.highspeed.savedDuration" },
                { duration: savedDurationLabel },
              )}
            </span>
          ) : null}
          <span
            className="rounded-full bg-hover px-2 py-0.5 text-ui-sm leading-4"
            data-highspeed-status-tag="true"
          >
            {intl.formatMessage({ id: "chat.highspeed.statusTag" })}
          </span>
        </div>
      ) : isRunning && throughputTokensPerSecond !== null ? (
        // Right-aligned live throughput: during streaming, use the sliding-window estimate (~ prefix); otherwise,
        // use exact tok/s from the most recently completed model request (same source as the developer-tools TPS).
        // Hide the whole section when both are absent (the first request is unfinished and the sample span is too short).
        <span
          data-testid="chat-working-throughput"
          data-throughput-estimated={isEstimate ? "true" : undefined}
          title={intl.formatMessage({
            id: isEstimate
              ? "chat.history.workingThroughputEstimateTitle"
              : "chat.history.workingThroughputTitle",
          })}
          className="ml-auto shrink-0 pl-2 text-ui-base tabular-nums text-foreground-subtle"
        >
          {isEstimate ? "~" : ""}
          {formatTokensPerSecond(locale, throughputTokensPerSecond)} tok/s
        </span>
      ) : null}
    </div>
  );
}

function ConversationWorkSegmentFlow({
  segment,
  sourceCommandIds,
  context,
  onFork,
  onRetry,
  onEdit,
  onPinChange,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  canForkLatestAssistant,
  canRetryLatestAssistant,
  highspeed,
  highspeedMeta,
  shareSelectionToggle,
  shareSelectionRowId,
}: {
  segment: ConversationTurnWorkSegment;
  sourceCommandIds: readonly string[];
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  onPinChange?: RowPinChangeHandler;
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantPreviewCards: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  canForkLatestAssistant: boolean;
  canRetryLatestAssistant: boolean;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
  shareSelectionToggle?: ReactNode;
  shareSelectionRowId?: number;
}) {
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);

  const shouldShowHistoryStatus = segment.workStatus !== undefined;
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (item) => item.kind !== "userInput",
  );
  let historyChunkIndex = 0;
  const open = segment.assistantHistoryDefaultOpen ? true : historyOpen;

  return (
    <Collapsible
      open={open}
      onOpenChange={segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
      // The outer flex gap is not part of the content height measured by Radix, so after collapsing to 0 the final
      // display:none frame would lose another 20px. Keep the original box model with margins for regular siblings,
      // and put history spacing inside the animation layer.
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item, index) => {
        const stageTailIsRunning =
          segment.workStatus?.state === "running" &&
          index === segment.flowItems.length - 1 &&
          (item.kind === "assistantHistory" || item.kind === "assistantWork");
        const showHistoryStatus = shouldShowHistoryStatus && index === firstAssistantFlowItemIndex;
        const itemKey =
          item.kind === "userInput" || item.kind === "assistantText"
            ? `${item.kind}:${item.row.rowId}`
            : `${item.kind}:${item.rows[0]?.rowId ?? index}`;
        let content: React.ReactNode;

        if (item.kind === "userInput") {
          const userRow = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onEdit={item.row.actions?.canEdit === true ? onEdit : undefined}
              onPinChange={onPinChange}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
            />
          );
          content =
            shareSelectionToggle && item.row.rowId === shareSelectionRowId ? (
              <div className="relative">
                {shareSelectionToggle}
                {userRow}
              </div>
            ) : (
              userRow
            );
        } else if (item.kind === "cuaGroup") {
          const group = <ConversationCuaGroupRow item={item} context={context} />;
          if (item.flowKind === "assistantHistory") {
            const chunkKey =
              historyChunkIndex === 0 ? segment.key : `${segment.key}:chunk-${historyChunkIndex}`;
            historyChunkIndex += 1;
            content = (
              <CollapsibleContent
                data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, chunkKey)}
                data-history-open={String(open)}
              >
                <div className="pt-5">{group}</div>
              </CollapsibleContent>
            );
          } else {
            content = group;
          }
        } else if (item.kind === "assistantHistory") {
          const chunkKey =
            historyChunkIndex === 0 ? segment.key : `${segment.key}:chunk-${historyChunkIndex}`;
          historyChunkIndex += 1;
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              stageTailIsRunning={stageTailIsRunning}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              historyContainer={{ chunkKey, open }}
            />
          );
        } else if (item.kind === "assistantText") {
          content = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onFork={item.latest && canForkLatestAssistant ? onFork : undefined}
              onRetry={item.latest && canRetryLatestAssistant ? onRetry : undefined}
              hideAssistantActions={!item.latest}
              deferAssistantActions={item.latest}
              assistantCopyText={item.latest ? assistantCopyText : undefined}
              assistantPreviewCards={item.latest ? assistantPreviewCards : undefined}
              assistantPreviewCardsAutoOpenKey={
                item.latest ? assistantPreviewCardsAutoOpenKey : undefined
              }
              assistantCodeCommentCards={item.latest ? assistantCodeCommentCards : undefined}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        } else {
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              stageTailIsRunning={stageTailIsRunning}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        }

        return (
          <Fragment key={itemKey}>
            {showHistoryStatus ? (
              <AssistantHistoryStatus
                segment={segment}
                open={open}
                context={context}
                highspeed={highspeed}
                highspeedMeta={highspeedMeta}
                sourceCommandIds={sourceCommandIds}
              />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {shouldShowHistoryStatus && firstAssistantFlowItemIndex < 0 ? (
        <AssistantHistoryStatus
          segment={segment}
          open={open}
          context={context}
          highspeed={highspeed}
          highspeedMeta={highspeedMeta}
          sourceCommandIds={sourceCommandIds}
        />
      ) : null}
    </Collapsible>
  );
}

function ConversationTurnFlow({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  onEdit,
  onPinChange,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
  highspeed,
  highspeedMeta,
  shareSelectionToggle,
  shareSelectionRowId,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  onPinChange?: RowPinChangeHandler;
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
  shareSelectionToggle?: ReactNode;
  shareSelectionRowId?: number;
}) {
  // Product semantics: visible text or tools do not mean the main turn has ended. ChatLoading follows the last turn's
  // running lifecycle, but interactive UI owns progress feedback while waiting for a user answer/authorization.
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: unit.latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow: unit.latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  if (unit.timelineOnly) {
    return (
      <div className="flex flex-col gap-2">
        <ConversationAssistantWorkItems
          rows={unit.assistantWorkRows}
          context={context}
          stageTailIsRunning={unit.isRunning}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
        <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
      </div>
    );
  }

  const projectedWorkSegments = unit.workSegments ?? [];
  const workSegments: ConversationTurnWorkSegment[] =
    projectedWorkSegments.length > 0
      ? projectedWorkSegments.length === 1
        ? [
            {
              ...projectedWorkSegments[0]!,
              // Compatibility for callers that still construct/override the old render unit directly; real multi-segment guides do not use this branch.
              assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            },
          ]
        : projectedWorkSegments
      : [
          {
            key: unit.key,
            flowItems: unit.flowItems,
            assistantWorkRows: unit.assistantWorkRows,
            assistantHistoryRows: unit.assistantHistoryRows,
            assistantFollowingRows: unit.assistantFollowingRows,
            assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
          },
        ];
  if (
    workSegments.every(
      (segment) => segment.flowItems.length === 0 && segment.workStatus === undefined,
    ) &&
    !showLoading
  ) {
    return null;
  }

  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;

  // Even when the complete guide row order is restored, do not make all history chunks share one Collapsible.
  // The CLI now bounds accepted guides with workSegments, and each segment component manages its own collapsed state.
  return (
    <div className="flex flex-col gap-5">
      {workSegments.map((segment) => (
        <ConversationWorkSegmentFlow
          key={segment.key}
          segment={segment}
          sourceCommandIds={[
            ...segment.flowItems.flatMap((item) =>
              item.kind === "userInput" && item.row.sourceCommandId
                ? [item.row.sourceCommandId]
                : [],
            ),
            ...(segment === workSegments[0] && unit.header?.sourceCommandId
              ? [unit.header.sourceCommandId]
              : []),
          ]}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onEdit={onEdit}
          onPinChange={onPinChange}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          canForkLatestAssistant={canForkLatestAssistant}
          canRetryLatestAssistant={canRetryLatestAssistant}
          highspeed={highspeed}
          highspeedMeta={highspeedMeta}
          shareSelectionToggle={shareSelectionToggle}
          shareSelectionRowId={shareSelectionRowId}
        />
      ))}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}

/**
 * Allowlist of sources that support the “background result header” rendering.
 *
 * Keep an allowlist instead of trusting the schema directly: `originMeta` is optional on userInputRow,
 * and another value may appear across versions. Unknown sources do not have suitable title semantics, so falling back
 * to the regular assistant branch is better than reporting a false title.
 *
 * A workflow run's `backgroundSource` is `"workflow"` (the CLI reports it at the CreateWorkflow terminal event in
 * `background-tasks.ts`, with the title created by `workflowTaskSubject`). It was previously outside the allowlist,
 * so after a run ended the turn **had no title and degraded to a regular assistant segment collapsed by work duration**—
 * the entire background-result grouping disappeared. The title does not need localization: the CLI is authoritative,
 * as it is for bash/subagent titles, which are also passed through directly.
 */
const BACKGROUND_RESULT_TITLE_SOURCES: ReadonlySet<string> = new Set([
  "bash",
  "subagent",
  "workflow",
]);

function resolveBackgroundResultTitle(unit: ConversationTurnRenderUnit): string | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
  if (!BACKGROUND_RESULT_TITLE_SOURCES.has(originMeta.backgroundSource)) {
    return undefined;
  }
  return originMeta.title.trim();
}

/**
 * Whether the turn starts with a workflow notification card (a ToolLayout row).
 *
 * Used in two places: `ConversationBackgroundResultWork` chooses a notification row or plain title row, and the turn
 * container decides whether to remove top `pt-14`. Background-result turns have no visible user row, so the notification
 * card is their first node. Keeping the usual top padding would add about 76px of blank space above the card (56px + the
 * previous turn's pb-5), which looks unnecessary.
 */
function resolveWorkflowNotification(
  unit: ConversationTurnRenderUnit,
): WorkflowNotificationMeta | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  return originMeta?.backgroundSource === "workflow" ? originMeta.workflowNotification : undefined;
}

function ConversationBackgroundResultWork({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  title,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  title: string;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
}) {
  const hasHistory = unit.assistantHistoryRows.length > 0;
  const hasFollowing = unit.assistantFollowingRows.length > 0;
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  // Background results have already been summarized in a separate wake-up turn. Reusing regular assistant work-duration
  // collapsing would show inaccurate segment durations and create a pointless collapsed state for a short summary.
  //
  // When a workflow notification for a workflow run has structured payload, render a notification row using existing
  // tool-card syntax instead of the plain title row. Without payload (batch turns, old transcripts, bash/subagent), keep the title row.
  const workflowNotification = resolveWorkflowNotification(unit);
  const workflowRunId = unit.header?.originMeta?.workId;
  // Open run details only when the host injects onOpenWorkflowRun and the join resolves toolCallId. If cold restoration
  // cannot find it, do not render a link in the expanded body. toolCallId comes from the projection/journal join table,
  // matching the CreateWorkflow tool-card navigation path.
  const workflowRunSummary =
    workflowNotification && workflowRunId
      ? context.workflowRunByRunId?.get(workflowRunId)
      : undefined;
  const openWorkflowRun =
    workflowNotification &&
    workflowRunId &&
    context.onOpenWorkflowRun &&
    context.sessionId &&
    workflowRunSummary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: context.sessionId!,
            toolCallId: workflowRunSummary.toolCallId!,
            runId: workflowRunId,
            workflowName: title,
          })
      : undefined;
  const workflowPendingQids =
    workflowNotification && workflowRunId
      ? context.workflowRunPendingQuestionsByRunId?.get(workflowRunId)
      : undefined;
  // Artifact chip → full-size viewer tab. This gate is looser than `openWorkflowRun`: an artifact tab needs only
  // (parentSessionId, runId, artifactId), **not** toolCallId—it does not draw a causal graph or need to return to
  // the CreateWorkflow tool row. A notification row whose toolCallId is missing after cold restoration can still open its artifact.
  const openWorkflowArtifact =
    workflowNotification && workflowRunId && context.onOpenWorkflowArtifact && context.sessionId
      ? (artifactId: string) => {
          // Include the artifact's `contentType` from the payload when available (only terminal notifications include an artifact list).
          // The host uses it to decide whether to open an HTML artifact in a browser tab or an artifact tab. The payload intentionally
          // omits `sourcePath` to limit status-frame size; the host looks it up in the journal when necessary.
          const contentType =
            workflowNotification.kind === "terminal"
              ? workflowNotification.artifacts?.find((candidate) => candidate.id === artifactId)
                  ?.contentType
              : undefined;
          context.onOpenWorkflowArtifact?.({
            parentSessionId: context.sessionId!,
            runId: workflowRunId,
            artifactId,
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      {workflowNotification ? (
        <WorkflowNotificationToolRow
          notification={workflowNotification}
          runName={title}
          testIdKey={unit.key}
          theme={context.theme}
          onOpenRun={openWorkflowRun}
          onOpenArtifact={openWorkflowArtifact}
          pendingQids={workflowPendingQids}
          // Three states for the hole row (docs/dynamic-workflow/transcript-and-notifications.md,
          // “The hole row's live state”): pass its hole map when the run is in the live projection
          // (possibly empty = completed/no record); if absent, use undefined → neutral wording.
          holes={
            workflowRunSummary?.run === undefined ? undefined : (workflowRunSummary.run.holes ?? [])
          }
        />
      ) : (
        <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
          <div
            data-testid={testId(TID_CHAT_BACKGROUND_RESULT_TITLE, unit.key)}
            className="min-w-0 whitespace-pre-wrap break-words text-left text-ui-base text-[var(--color-foreground-subtle)]"
          >
            {title}
          </div>
        </div>
      )}
      {hasHistory ? (
        <div className="flex flex-col gap-2">
          <ConversationAssistantWorkItems
            rows={unit.assistantHistoryRows}
            context={context}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        </div>
      ) : null}
      {latestAssistantTextRow ? (
        <ConversationTurnRow
          key={`${latestAssistantTextRow.rowId}:${latestAssistantTextRow.entityId ?? ""}`}
          row={latestAssistantTextRow}
          context={context}
          onFork={latestAssistantTextRow.actions?.canFork === true ? onFork : undefined}
          onRetry={latestAssistantTextRow.actions?.canRetry === true ? onRetry : undefined}
          deferAssistantActions
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      {hasFollowing ? (
        <ConversationAssistantWorkItems
          rows={unit.assistantFollowingRows}
          context={context}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}

function ConversationTurnGroupImpl({
  unit,
  nowMs = Date.now(),
  apiRetry = null,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onPinChange,
  onEdit,
  shareSelection,
}: ConversationTurnGroupProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const visibleUserRows = useMemo(() => unit.visibleUserInputs, [unit.visibleUserInputs]);
  useSyncExternalStore(subscribeHighspeedTurns, getHighspeedTurnVersion, getHighspeedTurnVersion);
  const sourceCommandId = unit.header?.sourceCommandId ?? visibleUserRows[0]?.sourceCommandId;
  const highspeedTurn = getHighspeedTurnByCommandId(sourceCommandId);
  // Root cause: historical identification used to rely only on Renderer memory. After card expiry
  // or cold restore, that record was unavailable, so accelerated output rendered as regular time
  // even when the transcript persisted Highspeed metadata.
  const isHighspeed = highspeedTurn !== null || visibleUserRows.some((row) => row.highspeed);
  const highspeedExpiresAt = Math.max(
    highspeedTurn?.card.expiresAt ?? Number.NEGATIVE_INFINITY,
    ...visibleUserRows.flatMap((row) => (row.highspeed ? [row.highspeed.expiresAt] : [])),
  );
  // Root cause: the purple shimmer previously checked only whether the turn had used Highspeed.
  // Metadata remains after card expiry, so a Tool still running in the fallback phase stayed purple
  // forever. Running styles must also respect the card's validity period.
  const showHighspeedAnimatedGradient = isHighspeed && unit.isRunning && highspeedExpiresAt > nowMs;
  // Even if completed statistics arrive first through a replayable event, do not show them in the UI until the whole turn has stopped generating.
  const highspeedMeta = unit.isRunning
    ? undefined
    : visibleUserRows.find((row) => row.highspeed)?.highspeed;
  const highspeedShareTarget = useMemo(() => {
    let target: { cardId: string; metrics: HighspeedShareMetrics } | null = null;
    if (
      highspeedTurn?.metrics &&
      highspeedTurn.metricsPersistedAt !== undefined &&
      highspeedTurn.metrics.regularTps > 0 &&
      highspeedTurn.metrics.highspeedTps !== undefined &&
      highspeedTurn.metrics.highspeedTps > 0
    ) {
      target = {
        cardId: highspeedTurn.card.cardId,
        metrics: aggregateHighspeedCardMetrics(highspeedTurn.card.cardId),
      };
    } else if (unit.highspeedOutputFooterTarget) {
      target = unit.highspeedOutputFooterTarget;
    } else if (
      highspeedMeta?.outputTokens !== undefined &&
      highspeedMeta.outputTokens > 0 &&
      highspeedMeta.highspeedTps !== undefined &&
      highspeedMeta.highspeedTps > 0 &&
      highspeedMeta.regularTps !== undefined &&
      highspeedMeta.regularTps > 0
    ) {
      // Root cause: after cold restore, Renderer memory is empty even though the transcript has
      // persisted complete sharing metrics. Relying only on highspeedTurn would leave the visible
      // historical Share button disabled forever.
      target = {
        cardId: highspeedMeta.cardId,
        metrics: {
          outputTokens: highspeedMeta.outputTokens,
          // The sharing API does not require durationMs; if missing, fall back to 0 for local duration without blocking sharing.
          durationMs: highspeedMeta.durationMs ?? 0,
          regularTps: highspeedMeta.regularTps,
          highspeedTps: highspeedMeta.highspeedTps,
          ...(highspeedMeta.savedDurationMs !== undefined
            ? { savedDurationMs: highspeedMeta.savedDurationMs }
            : {}),
        },
      };
    }
    // Keep the card and historical marker, but do not offer sharing when speedup is at most 1.2x or complete duration data is missing.
    return target && isHighspeedShareEligible(target.metrics) ? target : null;
  }, [highspeedMeta, highspeedTurn, unit.highspeedOutputFooterTarget]);
  const [highspeedShareDialogOpen, setHighspeedShareDialogOpen] = useState(false);
  const firstReasoningRowId = useMemo(
    () => unit.assistantWorkRows.find((row) => row.kind === "reasoning")?.rowId,
    [unit.assistantWorkRows],
  );
  const assistantRowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      ...context,
      ...(firstReasoningRowId !== undefined
        ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
        : {}),
    }),
    [context, firstReasoningRowId],
  );
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewPptxAutoOpenTarget = context.assistantPreviewPptxAutoOpenTarget;
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const assistantCodeCommentProjectionEnabled =
    codeCommentCardsEnabled &&
    (unit.isRunning ||
      latestAssistantTextRow?.state === "complete" ||
      latestAssistantTextRow?.state === "interrupted");
  const assistantRawCopyText = useMemo(
    () => resolveAssistantCopyText(unit),
    [unit.assistantTextRows, unit.assistantWorkRows, unit.latestAssistantTextRow],
  );
  const assistantFileSummaryText = useMemo(
    () => unit.assistantTextRows.map((row) => row.text).join("\n\n"),
    [unit.assistantTextRows],
  );
  const assistantCopyText = useMemo(
    () =>
      assistantCodeCommentProjectionEnabled && assistantRawCopyText !== undefined
        ? projectAssistantCodeComments(assistantRawCopyText, {
            streaming: unit.isRunning,
          }).visibleText
        : assistantRawCopyText,
    [assistantRawCopyText, assistantCodeCommentProjectionEnabled, unit.isRunning],
  );
  const assistantCodeCommentCards = useMemo(
    () =>
      codeCommentCardsEnabled &&
      assistantRawCopyText !== undefined &&
      // Match the zcode-file-citation preview card: project only the body while streaming and create the card only for a terminal row,
      // avoiding a card that appears mid-run and then rolls back when the model continues.
      (latestAssistantTextRow?.state === "complete" ||
        latestAssistantTextRow?.state === "interrupted")
        ? buildAssistantCodeCommentCards(assistantRawCopyText, context.workspacePath, 50, {
            homePath: context.workspaceHomePath,
          })
        : [],
    [
      assistantRawCopyText,
      codeCommentCardsEnabled,
      context.workspaceHomePath,
      context.workspacePath,
      latestAssistantTextRow?.state,
    ],
  );
  const cronAutomationTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveCronAutomationTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // A tool summary is already above; show the run card below as soon as its join resolves instead of waiting for the main agent's reply to finish.
  // Keep it live from the join table and let the parser deduplicate by runId. Direct-start turns also render their run card here:
  // they have no user bubble or assistant content, so the run card is the entire presentation.
  const workflowRunByToolCallId = context.workflowRunByToolCallId;
  const workflowRunByRunId = context.workflowRunByRunId;
  const workflowGraphByToolCallId = context.workflowGraphByToolCallId;
  const workflowFillGraphByRunId = context.workflowFillGraphByRunId;
  const workflowTurnDigests = useMemo(
    () =>
      resolveWorkflowTurnDigests(unit, {
        byToolCallId: workflowRunByToolCallId,
        byRunId: workflowRunByRunId,
        graphByToolCallId: workflowGraphByToolCallId,
        fillGraphByRunId: workflowFillGraphByRunId,
      }),
    [
      unit,
      workflowFillGraphByRunId,
      workflowGraphByToolCallId,
      workflowRunByRunId,
      workflowRunByToolCallId,
    ],
  );
  // Completion card: render at the end of the turn where the main agent consumes the completed notification.
  // Use the same gate (turn end); join only by byRunId because a notification turn has no CreateWorkflow row to join by toolCallId.
  const workflowTurnCompletion = useMemo(
    () =>
      unit.isRunning
        ? undefined
        : resolveWorkflowTurnCompletion(unit.header, { byRunId: workflowRunByRunId }),
    [unit.header, unit.isRunning, workflowRunByRunId],
  );
  const offPeakTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveOffPeakTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  const canRenderAssistantActions =
    !unit.timelineOnly &&
    latestAssistantTextRow?.state === "complete" &&
    assistantCopyText !== undefined;
  // The runtime turnId differs from the product turn ID; correlate delivery using command attribution on the CLI row, including headers for trimmed input.
  const deliverySourceCommandIds = [
    ...(unit.header?.sourceCommandId ? [unit.header.sourceCommandId] : []),
    ...unit.visibleUserInputs.flatMap((row) => (row.sourceCommandId ? [row.sourceCommandId] : [])),
  ];
  const hasHookActions =
    // Hook actions share turn eligibility with copy/feedback/fork.
    // timelineOnly maintenance turns (compact/modelChange marker turns) must not show the icon even if they contain
    // a legacy didExecute=true Hook row; otherwise a /compact turn could display an unexplained toolbar due to SessionStart Hook.
    !unit.timelineOnly &&
    !unit.isRunning &&
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute));
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;
  const backgroundResultTitle = resolveBackgroundResultTitle(unit);
  const showHighspeedOutputFooter =
    unit.showHighspeedOutputFooter === true && isHighspeed && !unit.timelineOnly && !unit.isRunning;
  const hasAssistantWorkContent = unit.timelineOnly
    ? unit.assistantWorkRows.length > 0
    : unit.assistantWorkRows.length > 0 ||
      unit.workSegments?.some((segment) => segment.workStatus?.state === "running") === true ||
      unit.workStatus?.state === "running";
  const hasAssistantTurnContent =
    hasAssistantWorkContent ||
    Boolean(unit.header?.fileChanges) ||
    canRenderAssistantActions ||
    hasHookActions ||
    showHighspeedOutputFooter ||
    workflowTurnDigests.length > 0;
  const editWorkspaceRewindAvailability = useMemo<EditWorkspaceRewindAvailability>(() => {
    const fileChanges = unit.header?.fileChanges;
    if (!fileChanges || fileChanges.files <= 0) return { enabled: false, reason: "noFiles" };
    if (fileChanges.state === "reverted") return { enabled: false, reason: "reverted" };
    if (unit.isRunning) return { enabled: false, reason: "running" };
    if (unit.header?.actions?.canRewindFiles !== true) {
      return { enabled: false, reason: "unavailable" };
    }
    return { enabled: true, reason: "available" };
  }, [unit.header?.actions?.canRewindFiles, unit.header?.fileChanges, unit.isRunning]);

  // Remove top padding from turns starting with a workflow notification card; the card uses only the normal flow spacing from the previous turn's pb-5.
  const startsWithWorkflowNotificationCard =
    backgroundResultTitle !== undefined && resolveWorkflowNotification(unit) !== undefined;
  // The same rule applies to two other sources: a turn launched directly from the hub and a
  // settings turn from “Configure” (docs/dynamic-workflow/presentation.md, “The run card”). Their
  // user rows are canonical sentences for the model and are removed by conversationTurnRenderUnits,
  // making the card or “Settings updated” row the first node in the turn.
  //
  // Root cause: `pt-14` reserves space for a user bubble, but the condition checked whether a turn
  // existed rather than whether it had a bubble. Without a bubble, these 56px stacked with the
  // previous turn's pb-5 and left about 76px of blank space above the row (especially noticeable
  // because settings turns appear mid-conversation).
  const startsWithoutUserBubble =
    startsWithWorkflowNotificationCard || unit.workflowLaunch !== undefined;

  const shareSelectionRows = shareSelection
    ? unit.visibleUserInputs.filter(
        (row) => row.origin === "realUser" && shareSelection.eligibleRowIds.has(row.rowId),
      )
    : [];
  // A turn can have multiple realUser inputs (steer/queued messages), but only one turn-level checkbox is rendered.
  // Reducing them to a boolean with every() would make a partially selected turn appear “unselected,”
  // so one click would make the count jump by 2. Show partial selection explicitly as indeterminate.
  const shareSelectionSelectedCount = shareSelection
    ? shareSelectionRows.filter((row) => shareSelection.selectedRowIds.has(row.rowId)).length
    : 0;
  const shareSelectionChecked: boolean | "indeterminate" =
    shareSelection === undefined || shareSelectionRows.length === 0
      ? false
      : shareSelectionSelectedCount === shareSelectionRows.length
        ? true
        : shareSelectionSelectedCount === 0
          ? false
          : "indeterminate";
  const shareSelectionToggle =
    shareSelectionRows.length > 0 ? (
      <div
        data-conversation-share-turn-toggle="true"
        data-conversation-share-turn-toggle-state={
          shareSelectionChecked === true
            ? "selected"
            : shareSelectionChecked === "indeterminate"
              ? "partial"
              : "unselected"
        }
        className="absolute left-0 top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center"
      >
        <label className="flex size-8 cursor-pointer items-center justify-center">
          <Checkbox
            checked={shareSelectionChecked}
            aria-label={
              shareSelectionRows[0]?.text ||
              intl.formatMessage({ id: "conversationShare.partial.panelLabel" })
            }
            onCheckedChange={(checked) => {
              if (!shareSelection) return;
              // Radix returns true when an indeterminate checkbox is clicked, so a partial selection completes the whole turn.
              if (checked === true) {
                for (const row of shareSelectionRows) {
                  if (!shareSelection.selectedRowIds.has(row.rowId))
                    shareSelection.onToggle(row.rowId);
                }
              } else if (checked === false) {
                for (const row of shareSelectionRows) {
                  if (shareSelection.selectedRowIds.has(row.rowId))
                    shareSelection.onToggle(row.rowId);
                }
              }
            }}
            checkIconStrokeWidth={1.33}
            className="size-4 rounded-sm border-foreground bg-transparent data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background data-[state=indeterminate]:border-foreground data-[state=indeterminate]:bg-foreground data-[state=indeterminate]:text-background"
          />
        </label>
      </div>
    ) : null;

  return (
    <section
      data-turn-id={unit.turnId}
      data-turn-key={unit.key}
      data-highspeed-gradient={showHighspeedAnimatedGradient ? "true" : undefined}
      className={cn(
        "relative mx-auto flex w-full flex-col gap-5 px-4 @md/conversation:px-6 pb-5",
        startsWithoutUserBubble ? "pt-0" : "pt-14",
        showHighspeedAnimatedGradient && "highspeed-animated-gradient-text",
      )}
    >
      {unit.leadingBoundaryRows.map((row) => (
        <ConversationTurnRow
          key={`${row.rowId}:${row.entityId ?? ""}`}
          row={row}
          context={context}
        />
      ))}
      {hasAssistantTurnContent ? (
        // After deferAssistantActions moves the toolbar below the file summary, the hover group previously wrapped
        // only the toolbar, so the user had to hover over an invisible button to reveal it.
        // Put assistant work, summary, and toolbar in the same turn-level hover container, matching the old behavior.
        <div className="group/assistant-turn flex w-full flex-col gap-5">
          {backgroundResultTitle ? (
            <>
              {visibleUserRows.map((row) =>
                shareSelectionToggle && row.rowId === shareSelectionRows[0]?.rowId ? (
                  <div className="relative" key={`${row.rowId}:${row.entityId ?? ""}`}>
                    {shareSelectionToggle}
                    <ConversationTurnRow
                      row={row}
                      context={context}
                      onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                      onPinChange={onPinChange}
                      editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                    />
                  </div>
                ) : (
                  <ConversationTurnRow
                    key={`${row.rowId}:${row.entityId ?? ""}`}
                    row={row}
                    context={context}
                    onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                    onPinChange={onPinChange}
                    editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                  />
                ),
              )}
              <ConversationBackgroundResultWork
                unit={unit}
                apiRetry={apiRetry}
                context={assistantRowContext}
                onFork={canForkLatestAssistant ? onFork : undefined}
                onRetry={onRetry}
                title={backgroundResultTitle}
                assistantCopyText={assistantCopyText}
                assistantCodeCommentCards={assistantCodeCommentCards}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
                assistantPreviewCardsAutoOpenKey={
                  assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                    ? assistantPreviewPptxAutoOpenTarget.key
                    : undefined
                }
              />
            </>
          ) : (
            <ConversationTurnFlow
              unit={unit}
              apiRetry={apiRetry}
              context={assistantRowContext}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={onRetry}
              onEdit={onEdit}
              onPinChange={onPinChange}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
              shareSelectionToggle={shareSelectionToggle}
              shareSelectionRowId={shareSelectionRows[0]?.rowId}
              assistantCopyText={assistantCopyText}
              assistantCodeCommentCards={assistantCodeCommentCards}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              highspeed={isHighspeed}
              highspeedMeta={highspeedMeta}
              assistantPreviewCardsAutoOpenKey={
                assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                  ? assistantPreviewPptxAutoOpenTarget.key
                  : undefined
              }
            />
          )}
          {/* Completion card: show what the run handled in this turn and how long it took, immediately
              after the final text segment. */}
          {workflowTurnCompletion === undefined ? null : (
            <ConversationWorkflowCompletion
              completion={workflowTurnCompletion}
              context={context}
              turnKey={unit.key}
            />
          )}
          {/* Turn-end summary: show runs still in progress for this turn after the completion card and
              before the other turn-end blocks. */}
          <ConversationWorkflowDigests
            context={context}
            digests={workflowTurnDigests}
            turnKey={unit.key}
          />
          {/* Fix reason: CronCreate/CronUpdate tools remain ordinary tool rows. The success card summarizes the
              result after the whole turn completes, so show it after the final assistant text only
              when the reply has ended. */}
          <CronAutomationTurnCards cards={cronAutomationTurnCards} context={context} />
          <OffPeakTurnCards cards={offPeakTurnCards} context={context} />
          {!isOfficeMode && unit.header?.fileChanges ? (
            <ConversationFileSummaryPanel
              header={unit.header}
              context={context}
              assistantText={assistantFileSummaryText}
            />
          ) : null}
          {unit.browserTurnEndRows.length > 0 ? (
            // The automatic screenshot represents the page's final state at the end of the turn. If placed inside assistant work,
            // it would appear between the Website preview and file-diff summary. It should be the last content block before the toolbar.
            <ConversationAssistantWorkItems
              rows={unit.browserTurnEndRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
          {canRenderAssistantActions && latestAssistantTextRow ? (
            // The file summary aggregates results after the entire turn. If the turn-tail toolbar renders inline with assistant text,
            // it appears before the summary and makes the summary look like it is not the turn's conclusion.
            <ConversationAssistantTextActions
              rowId={latestAssistantTextRow.rowId}
              entityId={latestAssistantTextRow.entityId}
              text={assistantCopyText}
              createdAt={latestAssistantTextRow.createdAt}
              compactForRemoteControl={context.compactForRemoteControl}
              feedback={readAssistantFeedback(latestAssistantTextRow)}
              pinnedAt={latestAssistantTextRow.pinnedAt}
              sessionId={context.sessionId}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={canRetryLatestAssistant ? onRetry : undefined}
              onFeedbackChange={onFeedbackChange}
              onPinChange={onPinChange}
              hookInvocations={unit.hookInvocations}
              turnId={unit.turnId}
              sourceCommandIds={deliverySourceCommandIds}
              className={cn(
                "flex items-center gap-1",
                // A pinned turn keeps the toolbar visible so the pin state stays discoverable and
                // unpin stays reachable without hover (same rule as the inline assistant toolbar).
                context.compactForRemoteControl || latestAssistantTextRow.pinnedAt !== undefined
                  ? "opacity-100"
                  : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
              )}
            />
          ) : (hasHookActions || !unit.isRunning) && !canRenderAssistantActions ? (
            // A conflict merge once attached this fallback to the Highspeed footer's else branch,
            // duplicating the entry for regular replies and removing it from Highspeed turns with
            // no body. It is mutually exclusive only with the regular action bar; the footer renders independently.
            <MessageActions
              className={cn(
                context.compactForRemoteControl
                  ? "opacity-100"
                  : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
              )}
            >
              {hasHookActions ? (
                <ConversationHookDetailsAction rows={unit.hookInvocations} turnId={unit.turnId} />
              ) : null}
              <ConnectedBotGroupDeliveryAction
                turnId={unit.turnId}
                sourceCommandIds={deliverySourceCommandIds}
              />
            </MessageActions>
          ) : null}
          {showHighspeedOutputFooter ? (
            <HighspeedOutputFooter
              generatedLabel={intl.formatMessage({ id: "chat.highspeed.generatedBy" })}
              shareLabel={intl.formatMessage({ id: "chat.highspeed.viewAction" })}
              shareAriaLabel={intl.formatMessage({ id: "chat.highspeed.share" })}
              shareEnabled={highspeedShareTarget !== null}
              sharePending={false}
              onShare={() => setHighspeedShareDialogOpen(true)}
            />
          ) : null}
          {highspeedShareTarget ? (
            <HighspeedShareDialog
              metrics={highspeedShareTarget.metrics}
              open={highspeedShareDialogOpen}
              onOpenChange={setHighspeedShareDialogOpen}
            />
          ) : null}
          {unit.assistantTailRows.length > 0 ? (
            // turnTailBoundary was split from work history but still rendered inside the flow,
            // making CronCreate, file summary, and toolbar appear below the fork divider. Move the boundary after
            // all turn-local auxiliary UI so it marks the actual logical end of the turn.
            <ConversationAssistantWorkItems
              rows={unit.assistantTailRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
        </div>
      ) : (
        <ConversationTurnFlow
          unit={unit}
          apiRetry={apiRetry}
          context={assistantRowContext}
          onEdit={onEdit}
          onPinChange={onPinChange}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          shareSelectionToggle={shareSelectionToggle}
          shareSelectionRowId={shareSelectionRows[0]?.rowId}
          assistantCopyText={assistantCopyText}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          highspeed={isHighspeed}
          highspeedMeta={highspeedMeta}
        />
      )}
      {unit.topicPreparations?.length ? (
        <BotTopicPreparation items={unit.topicPreparations} />
      ) : null}
    </section>
  );
}

export const ConversationTurnGroup = memo(ConversationTurnGroupImpl);
