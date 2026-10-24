import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_V4_ROW, TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared/test-ids";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { copyTextToClipboard } from "@/useTaskListItemContextActions.js";

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
  // 与 Agent 摘要行复用同一 title resolver，保证右侧 tab 和用户点击的可见标题逐字一致。
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

  // Agent row context menu (specs/conversation-agent-row-context-menu.md): the trajectory reader
  // reads files on this machine, so remote workspaces and phones keep the native menu.
  const isMobileViewport = useIsMobileTextInputViewport();
  const workspaceKey = context.workspaceIdentity?.trim() || context.workspacePath;
  const menuEnabled = Boolean(
    childSessionId &&
    !isMobileViewport &&
    !context.workspaceRemoteSessionId &&
    !isRemoteWorkspaceIdentity(workspaceKey),
  );
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // A text selection inside the row keeps the native menu (Copy). Decided on the right-button
  // pointerdown, which React flushes before the contextmenu event reaches the trigger.
  const [selectionInRow, setSelectionInRow] = useState(false);
  const handlePointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return;
    const selection = window.getSelection();
    const row = rowRef.current;
    setSelectionInRow(
      Boolean(
        selection &&
        !selection.isCollapsed &&
        row &&
        selection.anchorNode &&
        row.contains(selection.anchorNode),
      ),
    );
  }, []);
  const copyLabel = intl.formatMessage({ id: "appHeader.copySessionId" });

  // Agent 工具行和普通工具行同属工作流，不能在配对壳上额外加 px-4，
  // 否则会和未配对 toolCall 行产生左右缩进差异。
  const rowNode = (
    <div
      ref={rowRef}
      data-row-id={item.row.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.row.rowId))}
      onPointerDownCapture={menuEnabled ? handlePointerDownCapture : undefined}
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
  // Always wrapped: the child id arrives mid-run, and swapping element types would remount the row
  // and drop its local state. Ineligible rows keep the native menu through `disabled`.
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild disabled={!menuEnabled || selectionInRow}>
        {rowNode}
      </ContextMenuTrigger>
      {menuOpen && menuEnabled && childSessionId ? (
        <ContextMenuContent>
          <ContextMenuItem
            data-agent-row-menu-trajectory={childSessionId}
            onSelect={() =>
              useModelTrajectoryStore.getState().requestOpen({
                taskId: childSessionId,
                workspaceKey,
                title,
                kind: "v2",
              })
            }
          >
            {intl.formatMessage({ id: "taskList.viewModelTrajectoryV2" })}
          </ContextMenuItem>
          <ContextMenuItem
            data-agent-row-menu-copy-id={childSessionId}
            onSelect={() => void copyTextToClipboard(copyLabel, childSessionId)}
          >
            {copyLabel}
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
