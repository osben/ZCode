import { getLocalTtftObserver } from "@/v4/telemetry/local-ttft/contract.js";
import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { expandTopicInputMessages } from "@/v4/topicInputMessages.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
/* oxlint-disable eslint(max-lines) -- v4 row rendering is dispatched centrally (one memo leaf per row kind plus timelineMarker dividers); splitting it would scatter the row-type mapping. */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckIcon,
  Clock,
  CopyIcon,
  FileIcon,
  InfoIcon,
  PencilIcon,
  PinIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrendingUpDownIcon,
  XIcon,
} from "lucide-react";
import { parseAutomationRunId } from "@zcode/shared";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_ATTACHMENT_REMOVE,
  TID_V4_EDIT_IN_COMPOSER_HINT,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FEEDBACK_LIKE,
  TID_V4_FORK,
  TID_V4_PIN,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  testId,
} from "@zcode/shared/test-ids";
import type {
  AttachmentRef,
  ArtifactRow,
  AssistantTextRow,
  ConversationRow,
  ConversationInputSource,
  ConversationRowTarget,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UnreadableConversationRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { PdfViewerRangeSource } from "@/components/ui/pdf-viewer.js";
import { MessageAction, MessageActions } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { cn } from "@/components/lib/utils.js";
import { composerEditSessionKey, useComposerEditStore } from "@/composer-edit-mode/index.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import {
  readWorkflowName,
  readWorkflowRetuneCall,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { WorkflowRetuneRow } from "@/ToolCallBlocks/renderers/WorkflowRetuneRow.js";
import { workflowRunDefaultConcurrency } from "@/components/workflow-timeline/workflowRunSettings.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import {
  readWorkflowHoleTarget,
  workflowFillCounts,
} from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { requestTaskNavigation } from "@/store/zcodeSessionStoreNavigation.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import { PluginUiModelContextChip, formatPluginDisplayName } from "@/plugin-ui/index.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import {
  FileDisplayIcon,
  FileDisplayInline,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { ConversationTimelineMarkerDivider } from "@/v4/ConversationShareReadonlyTimeline.js";
import { formatMessageTimeLabel } from "@/v4/messageTimeLabel.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";
import {
  ForkDestinationMenu,
  WorktreeCreatedMarker,
  useForkDestination,
} from "@/managed-worktrees/index.js";

function RowShell({
  rowId,
  children,
  className = "",
}: {
  rowId: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-row-id={rowId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

const ArtifactRowView = memo(function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {row.artifactType.toUpperCase()} · {row.sizeBytes} bytes
          </p>
        </div>
      </div>
    </RowShell>
  );
});

type SessionSource = Extract<ConversationInputSource, { kind: "session" }>;

// 目录树的 tasks 是数组，而来源只有 sessionId。每个提示每次渲染都遍历一遍会随任务规模线性变差，
// 所以按数组引用缓存一份反查表：stabilizeProjectTree 只在内容真变化时换引用，缓存因此自动失效。
const taskByIdCache = new WeakMap<object, Map<string, ProjectTask>>();
function findTaskById(tasks: readonly ProjectTask[], taskId: string): ProjectTask | undefined {
  let index = taskByIdCache.get(tasks);
  if (!index) {
    index = new Map<string, ProjectTask>();
    for (const task of tasks) if (!index.has(task.taskId)) index.set(task.taskId, task);
    taskByIdCache.set(tasks, index);
  }
  return index.get(taskId);
}

/**
 * 跨会话发送的来源提示（规格 0.13）。
 *
 * 标题按「当前事实 → 旧快照 → 身份」回落：持久化载荷只带 sessionId，标题在这里按 id 解析。
 * 旧数据里的 `source.title` 是发送那一刻的快照，多半停在 titleSource=default 档（= 首条提示词
 * 原文），所以只作为解析不到时的兜底，不优先于当前标题。
 *
 * 解析用项目目录树——侧栏与 App 控制工具的 OpenSession 用的是同一份跨项目权威列表，
 * 不另起一份任务索引。全量目录 Context 会随任务活动变化，但只有带会话来源的行才挂这个组件，
 * 重渲染面限于这几条提示本身。
 *
 * 解析不到来源会话（已删除、嵌入 pane 没有目录 owner）时保持可读但不可点击：
 * 跳转需要的 workspacePath 与标题同源，猜路径会把「打不开」变成「打开了别的会话」。
 */
const SessionSourceHint = memo(function SessionSourceHint({ source }: { source: SessionSource }) {
  const { intl } = useZCodeIntl();
  const directory = useOptionalProjectDirectory();
  const task = directory ? findTaskById(directory.tree.tasks, source.sessionId) : undefined;
  const workspacePath = task?.workspacePath;
  const workspaceIdentity = task?.workspaceIdentity;
  const handleOpen = useCallback(() => {
    if (!workspacePath) return;
    requestTaskNavigation({
      taskId: source.sessionId,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
  }, [source.sessionId, workspaceIdentity, workspacePath]);
  const label = intl.formatMessage(
    { id: "conversation.fromSession" },
    { name: task?.title || source.title || source.sessionId },
  );
  return (
    <div
      className="mt-1 text-right text-ui-sm text-foreground-subtlest"
      data-v4-user-input-source="session"
      data-source-session-id={source.sessionId}
    >
      {workspacePath ? (
        <button
          type="button"
          onClick={handleOpen}
          title={intl.formatMessage({ id: "conversation.fromSession.open" })}
          data-source-session-navigable="true"
          className="rounded-sm underline-offset-2 hover:text-foreground-subtle hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {label}
        </button>
      ) : (
        label
      )}
    </div>
  );
});

/**
 * 「这一行读不懂」的占位行（10-protocol-spec §4.4.9，04-sync-and-recovery 封闭规则 13）。
 *
 * 为什么必须画出来而不是返回 null：静默跳过会让用户以为消息丢了，那比显示一条说明更失真。
 * rowId 与 turnId 都保留，所以它就停在原来那条消息的位置上，前后文不会错位。
 *
 * 用中性信息语义而不是 warning 色：会话本身没出错，只是这个 build 认不出其中一行——与
 * ConversationShareReadonlyTimeline 的「部分内容需要更新 ZCode 查看」是同一视觉语言。
 */
const UnreadableRowView = memo(function UnreadableRowView({
  row,
}: {
  row: UnreadableConversationRow;
}) {
  const { intl } = useZCodeIntl();
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div
        data-conversation-unreadable-row={row.sourceKind}
        className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-ui-xs text-foreground-subtle"
      >
        <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {intl.formatMessage({ id: "conversation.row.unreadable" })}
        </span>
      </div>
    </RowShell>
  );
});

/** 复制行文本：图标 ghost 按钮 + 1200ms 打勾态（对齐旧版 message copy）。
 *  label/tooltip 必须由调用方传入 i18n 文案，禁止硬编码语言。 */
const CopyRowAction = memo(function CopyRowAction({
  text,
  rowId,
  label,
  tooltip = label,
}: {
  text: string;
  rowId: number;
  label: string;
  tooltip?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!text || !navigator.clipboard) return;
    void runUserActionAsync({
      input: { featureId: "conversation.history.feedback", action: "copy", trigger: "button" },
      operation: () => navigator.clipboard.writeText(text),
      completed: { resultSource: "platform_result" },
      failureStage: "clipboard_write",
    }).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <MessageAction
      aria-label={label}
      label={label}
      tooltip={tooltip}
      data-testid={`v4-copy-${rowId}`}
      disabled={text.length === 0}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
});

/** 请求在底部 composer 编辑该 user 行（docs/ui/composer-edit-mode.md）；提交由 composer 完成。 */
export type UserInputEditHandler = (target: ConversationRowTarget) => Promise<void> | void;

type AssistantMessageFeedback = "like" | "dislike";

function getAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export type AssistantFeedbackHandler = (
  target: ConversationRowTarget,
  feedback: AssistantMessageFeedback | null,
) => Promise<boolean | void> | boolean | void;

export function readAssistantFeedback(row: AssistantTextRow): AssistantMessageFeedback | null {
  // feedback is an additive V4 row field; default to null for rows from older CLI versions.
  const feedback = row.feedback;
  return feedback === "like" || feedback === "dislike" ? feedback : null;
}

export type RowPinChangeHandler = (
  target: ConversationRowTarget,
  pinned: boolean,
) => Promise<boolean | void> | boolean | void;

// Pin toggle with optimistic state and rollback, shared by the user and assistant toolbars; mirrors the
// localFeedback pattern so a rejected command never leaves a stale pinned marker.
function useRowPinToggle(options: {
  rowId: number;
  entityId?: string;
  pinnedAt?: number;
  sessionId?: string | null;
  onPinChange?: RowPinChangeHandler;
}) {
  const platform = useOptionalPlatform();
  const [localPinnedAt, setLocalPinnedAt] = useState<number | null>(options.pinnedAt ?? null);
  useEffect(() => {
    setLocalPinnedAt(options.pinnedAt ?? null);
  }, [options.pinnedAt]);
  const togglePin = useCallback(() => {
    const previousPinnedAt = localPinnedAt;
    const pinned = previousPinnedAt === null;
    // Optimistic timestamp is display-only; the authoritative pinnedAt (CLI clock) arrives with the row.upserted delta.
    setLocalPinnedAt(pinned ? Date.now() : null);
    const { entityId, onPinChange, rowId, sessionId } = options;
    if (!entityId) return;
    void Promise.resolve(onPinChange?.({ rowId, entityId }, pinned)).then(
      (result) => {
        if (result === false) setLocalPinnedAt(previousPinnedAt);
      },
      (error: unknown) => {
        setLocalPinnedAt(previousPinnedAt);
        logger.warn("[ConversationRowView] 固定消息持久化失败", {
          error: error instanceof Error ? error.message : String(error),
          messageId: entityId,
        });
      },
    );
    if (platform) {
      void reportAppTelemetryEvent(
        platform,
        {
          elementName: "message_pin",
          eventRegion: "chat",
          eventType: "ck",
          eventExtraDetail: { pinned: pinned ? "pinned" : "unpinned" },
          ...(sessionId ? { talkId: sessionId } : {}),
          messageId: entityId,
        },
        "ConversationRowView",
      );
    }
  }, [localPinnedAt, options, platform]);
  return { pinned: localPinnedAt !== null, togglePin };
}

export interface EditWorkspaceRewindAvailability {
  enabled: boolean;
  reason: "available" | "noFiles" | "reverted" | "running" | "unavailable";
}

export interface ConversationRowViewProps {
  row: ConversationRow;
  /** Rendering context (theme/codePreviewSettings/workspacePath); the host guarantees a stable reference. */
  context: ConversationRowRenderContext;
  /** Fork entry point for a completed assistant row (forkAssistant command). */
  onFork?: (target: ConversationRowTarget) => void;
  /** Assistant-entity feedback CAS; UI updates optimistically and rolls back if the command fails. */
  onFeedbackChange?: AssistantFeedbackHandler;
  /** Display-only pin bookmark CAS (setRowPinned); optimistic with rollback, same contract as feedback. */
  onPinChange?: RowPinChangeHandler;
  /** Protocol compatibility: callers may still provide retryTurn capability, but product UI does not render the standard retry entry. */
  onRetry?: (target: ConversationRowTarget) => void;
  /** user 行的 edit 入口：进入底部 composer 编辑态，提交走 editUserQuery。 */
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  /** Remove the duplicate left guide and indentation from Reasoning nested inside a tool Group. */
  reasoningContentVariant?: "default" | "nested";
  /** Renderer-only submission state; not written to protocol rows or presented as drained history. */
  userInputStatus?: string;
  /**
   * A turn is one reply to the user: non-final text segments show no actions
   * (neither copy nor fork); actions appear only on the final segment.
   */
  hideAssistantActions?: boolean;
  /** TurnGroup must render turn-level actions after the file summary. */
  deferAssistantActions?: boolean;
  /** Copy content for the final segment = all text segments in the turn concatenated (not only the last segment). */
  assistantCopyText?: string;
  /** Assistant Preview Cards are computed by TurnGroup and passed only to the final terminal assistant text row. */
  assistantPreviewCards?: AssistantPreviewCard[];
  /** One-time auto-open identity, passed only when this renderer observes running → complete. */
  assistantPreviewCardsAutoOpenKey?: string;
  /** Assistant code-comment cards are computed by TurnGroup and passed only to the final terminal assistant text row. */
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  /** TurnGroup decides whether to hide code-comment protocol text for the entire turn. */
  assistantCodeCommentProjectionEnabled?: boolean;
}

// ── Each row type is a separate memoized leaf: in the virtual list, a parent render only rerenders rows whose props changed.
// Row types that need hooks (assistantText/toolCall) keep those calls in their own components to avoid conditional hooks in the switch dispatcher. ──

/**
 * Attachment rendering: rows still store only AttachmentRef. On image mount, read its thumbnail in chunks by session/ref;
 * on click, reuse the loaded URL in the shared preview. Non-images and failed images remain display-only to avoid a misleading pointer cursor.
 */
const UserInputAttachmentList = memo(function UserInputAttachmentList({
  attachments,
  attachmentIndices,
  entityId,
  attachmentKind = "all",
  directItems = false,
  onRemove,
  rowId,
  sessionId,
  readAttachment,
  readAttachmentRange,
}: {
  attachments: readonly AttachmentRef[] | undefined;
  /** Preserve the original index in the persisted FilePart list after deleting an attachment while editing. */
  attachmentIndices?: readonly number[];
  entityId?: string;
  attachmentKind?: "all" | "media" | "file";
  directItems?: boolean;
  onRemove?: (index: number) => void;
  rowId: number;
  sessionId?: string;
  readAttachment?: NonNullable<ConversationRowRenderContext["readAttachment"]>;
  readAttachmentRange?: NonNullable<ConversationRowRenderContext["readAttachmentRange"]>;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failedRefs, setFailedRefs] = useState<ReadonlySet<string>>(() => new Set());
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Prefetch image/video Blobs for visible message rows: show images directly and use a control-free video player for the first frame.
  // Reuse the video URL in the gallery to avoid reading a large file again after the user clicks it.
  const [videoPreview, setVideoPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [videoPreviewRef, setVideoPreviewRef] = useState<string | null>(null);
  const [videoPreviewLoading, setVideoPreviewLoading] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState(false);
  const [textPreview, setTextPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState(false);
  const textReadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => textReadAbort.current?.abort(), []);
  const closeTextPreview = () => {
    textReadAbort.current?.abort();
    textReadAbort.current = null;
    setTextPreview(null);
  };
  const openTextPreview = async (attachment: AttachmentRef, index: number) => {
    if (!sessionId || !readAttachment) return;
    textReadAbort.current?.abort();
    const controller = new AbortController();
    textReadAbort.current = controller;
    setTextPreview({ filename: attachment.fileName, mediaType: "text/plain" });
    setTextLoading(true);
    setTextError(false);
    try {
      const result = await readAttachment({
        sessionId,
        ref: attachment.ref,
        mediaType: attachment.mime,
        ...(entityId ? { target: { rowId, entityId }, attachmentIndex: index } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!("bytes" in result)) throw new Error("Text attachment bytes unavailable");
      setTextPreview({
        filename: attachment.fileName,
        mediaType: "text/plain",
        textContent: new TextDecoder().decode(result.bytes),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setTextError(true);
        logger.warn("Text attachment preview failed", error);
      }
    } finally {
      if (!controller.signal.aborted) setTextLoading(false);
    }
  };
  const [pdfPreview, setPdfPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState(false);
  const [pdfPreviewRef, setPdfPreviewRef] = useState<string | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const pdfPreviewAbortRef = useRef<AbortController | null>(null);
  const videoPreviewUrlRef = useRef<string | null>(null);
  const videoPreviewRequestRef = useRef(0);
  const videoPreviewAbortRef = useRef<AbortController | null>(null);
  const thumbnailUrlsRef = useRef<Map<string, string>>(new Map());
  const thumbnailObjectUrlsRef = useRef<Set<string>>(new Set());
  const previewOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const previewVideoOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const previewPdfOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openPdf",
  });
  const previewUnavailableLabel = intl.formatMessage({
    id: "chat.attachments.preview.unavailable",
  });

  useEffect(() => {
    if (attachmentKind === "file" || !attachments || !sessionId || !readAttachment) {
      return;
    }
    let cancelled = false;
    // Discarding only the read result does not stop the underlying chunked transfer; it may continue loading the full video after the row unmounts.
    // Propagate AbortSignal through the transport for the prefetch lifecycle to release file I/O and IPC resources promptly.
    const controller = new AbortController();
    const mediaAttachments = attachments.flatMap((attachment, index) =>
      attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/")
        ? [{ attachment, index }]
        : [],
    );

    // The V4 virtual list mounts only visible rows instead of scanning all history. Videos still use a stable row target,
    // ensuring that repeated sends of the same path use the durable artifact for the current message's thumbnail.
    void Promise.all(
      mediaAttachments.map(async ({ attachment, index }) => {
        const ref = attachment.previewRef ?? attachment.ref;
        const isVideo = attachment.mime.startsWith("video/");
        try {
          const result = await readAttachment({
            sessionId,
            ref,
            signal: controller.signal,
            ...(isVideo ? { mediaType: attachment.mime } : {}),
            ...(isVideo && entityId
              ? {
                  target: { rowId, entityId },
                  attachmentIndex: attachmentIndices?.[index] ?? index,
                }
              : {}),
          });
          if (cancelled) return;
          const isLocalUrl = "url" in result;
          const url = isLocalUrl
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                  type: result.mediaType,
                }),
              );
          if (!isLocalUrl) thumbnailObjectUrlsRef.current.add(url);
          if (cancelled) {
            if (!isLocalUrl) {
              thumbnailObjectUrlsRef.current.delete(url);
              URL.revokeObjectURL(url);
            }
            return;
          }
          thumbnailUrlsRef.current.set(ref, url);
          setThumbnailUrls(new Map(thumbnailUrlsRef.current));
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          if (!isVideo) setFailedRefs((current) => new Set(current).add(ref));
          logger.warn(
            `[v4-attachment-preview] failed to read sent ${isVideo ? "video" : "image"} thumbnail`,
            error,
          );
        }
      }),
    );

    return () => {
      controller.abort();
      cancelled = true;
      // Desktop local video returns a custom-protocol URL, not a renderer-created Blob.
      // Release only object URLs created by this effect; do not manage local media URLs as Blob lifetimes.
      for (const url of thumbnailObjectUrlsRef.current) URL.revokeObjectURL(url);
      thumbnailObjectUrlsRef.current.clear();
      thumbnailUrlsRef.current.clear();
    };
  }, [attachmentIndices, attachmentKind, attachments, entityId, readAttachment, rowId, sessionId]);

  // ── Read sent-video previews while preserving staging semantics ──
  const releaseVideoPreviewUrl = useCallback(() => {
    if (!videoPreviewUrlRef.current) return;
    URL.revokeObjectURL(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
  }, []);

  const cancelVideoPreviewRead = useCallback(() => {
    videoPreviewRequestRef.current += 1;
    videoPreviewAbortRef.current?.abort();
    videoPreviewAbortRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cancelVideoPreviewRead();
      releaseVideoPreviewUrl();
    },
    [cancelVideoPreviewRead, releaseVideoPreviewUrl],
  );

  const closeVideoPreview = useCallback(() => {
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
  }, [cancelVideoPreviewRead, releaseVideoPreviewUrl]);

  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    pdfPreviewAbortRef.current?.abort();
    pdfPreviewAbortRef.current = null;
    if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
    setPdfPreview(null);
    setPdfPreviewRef(null);
    setPdfPreviewLoading(false);
    setPdfPreviewError(false);
  }, []);

  useEffect(
    () => () => {
      closePdfPreview();
    },
    [closePdfPreview],
  );

  const openVideoPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number, galleryIndex: number) => {
      if (!sessionId || !readAttachment) return;
      const ref = attachment.previewRef ?? attachment.ref;
      cancelVideoPreviewRead();
      const thumbnailUrl = thumbnailUrlsRef.current.get(ref);
      if (thumbnailUrl) {
        releaseVideoPreviewUrl();
        setPreviewIndex(galleryIndex);
        setPreviewOpen(true);
        setVideoPreviewRef(ref);
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        });
        setVideoPreviewLoading(false);
        setVideoPreviewError(false);
        return;
      }
      const requestId = videoPreviewRequestRef.current;
      const abortController = new AbortController();
      videoPreviewAbortRef.current = abortController;
      releaseVideoPreviewUrl();
      setPreviewIndex(galleryIndex);
      setPreviewOpen(true);
      setVideoPreviewRef(ref);
      setVideoPreview({
        filename: attachment.fileName,
        mediaType: attachment.mime,
      });
      setVideoPreviewLoading(true);
      setVideoPreviewError(false);
      try {
        const result = await readAttachment({
          sessionId,
          ref,
          mediaType: attachment.mime,
          // When entityId exists, read by the stable row target; otherwise, fall back to matching by ref.
          ...(entityId ? { target: { rowId, entityId }, attachmentIndex } : {}),
          signal: abortController.signal,
        });
        if (videoPreviewRequestRef.current !== requestId) return;
        const isLocalUrl = "url" in result;
        const url = isLocalUrl
          ? result.url
          : URL.createObjectURL(
              new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
            );
        if (videoPreviewRequestRef.current !== requestId) {
          if (!isLocalUrl) URL.revokeObjectURL(url);
          return;
        }
        videoPreviewUrlRef.current = isLocalUrl ? null : url;
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (videoPreviewRequestRef.current !== requestId) return;
        // A single read failure used to permanently disable the attachment entry, incorrectly tying whether the Dialog could open to the read result.
        // Failure applies only to this preview; keep the entry available, retry on each open, and show errors inside the Dialog.
        setVideoPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent media", error);
      } finally {
        if (videoPreviewRequestRef.current === requestId) {
          videoPreviewAbortRef.current = null;
          setVideoPreviewLoading(false);
        }
      }
    },
    [cancelVideoPreviewRead, entityId, readAttachment, releaseVideoPreviewUrl, rowId, sessionId],
  );

  const openPdfPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number) => {
      if (!sessionId || (!readAttachment && !readAttachmentRange)) return;
      const ref = attachment.previewRef ?? attachment.ref;
      pdfPreviewRequestRef.current += 1;
      const requestId = pdfPreviewRequestRef.current;
      pdfPreviewAbortRef.current?.abort();
      const abortController = new AbortController();
      pdfPreviewAbortRef.current = abortController;
      if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
      setPdfPreviewRef(ref);
      setPdfPreview({ filename: attachment.fileName, mediaType: "application/pdf" });
      setPdfPreviewLoading(true);
      setPdfPreviewError(false);
      try {
        const target = entityId ? { target: { rowId, entityId }, attachmentIndex } : {};
        if (readAttachmentRange) {
          const firstRange = await readAttachmentRange({
            sessionId,
            ref,
            ...target,
            offset: 0,
            limit: 256 * 1024,
            signal: abortController.signal,
          });
          const source: PdfViewerRangeSource = {
            totalBytes: firstRange.totalBytes,
            initialData: firstRange.bytes,
            requestRange: async (offset, limit) => {
              const range = await readAttachmentRange({
                sessionId,
                ref,
                ...target,
                offset,
                limit,
                signal: abortController.signal,
              });
              return range.bytes;
            },
          };
          if (pdfPreviewRequestRef.current !== requestId) return;
          setPdfPreview({
            filename: attachment.fileName,
            mediaType: firstRange.mediaType,
            pdfSource: source,
          });
          return;
        }
        if (!readAttachment) return;
        const result = await readAttachment({
          sessionId,
          ref,
          ...target,
          signal: abortController.signal,
        });
        if (pdfPreviewRequestRef.current !== requestId) return;
        const url =
          "url" in result
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
              );
        if (!("url" in result)) pdfPreviewUrlRef.current = url;
        setPdfPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent PDF", error);
      } finally {
        if (pdfPreviewRequestRef.current === requestId) {
          pdfPreviewAbortRef.current = null;
          setPdfPreviewLoading(false);
        }
      }
    },
    [entityId, readAttachment, readAttachmentRange, rowId, sessionId],
  );

  const visibleAttachments = (attachments ?? [])
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => {
      if (attachmentKind === "all") return true;
      const isMedia = attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/");
      return attachmentKind === "media" ? isMedia : !isMedia;
    });
  if (attachmentKind === "all") {
    // The inline editor used to reuse the generic attachment list for read-only messages. It did not follow the input's
    // media → file visual order and used pills intended for sent messages. Sorting changes only render order;
    // index still refers to the original array so deleting an item does not submit the wrong attachment.
    visibleAttachments.sort(
      ({ attachment: left }, { attachment: right }) =>
        Number(right.mime.startsWith("image/") || right.mime.startsWith("video/")) -
        Number(left.mime.startsWith("image/") || left.mime.startsWith("video/")),
    );
  }
  if (visibleAttachments.length === 0) return null;
  const previewEntries = (attachments ?? []).flatMap((attachment, index) => {
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    if (!isImage && !isVideo) return [];
    const ref = attachment.previewRef ?? attachment.ref;
    const src = thumbnailUrls.get(ref);
    if (isImage && !src) return [];
    return [
      {
        attachment,
        index,
        persistedAttachmentIndex: attachmentIndices?.[index] ?? index,
      },
    ];
  });
  const previewItems = previewEntries.map(({ attachment }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isVideo = attachment.mime.startsWith("video/");
    return {
      alt: attachment.fileName,
      filename: attachment.fileName,
      mediaType: attachment.mime,
      src: isVideo && videoPreviewRef === ref ? videoPreview?.url : thumbnailUrls.get(ref),
      loading: isVideo && videoPreviewRef === ref && videoPreviewLoading,
      error: isVideo && videoPreviewRef === ref && videoPreviewError,
    };
  });
  const selectPreviewItem = (galleryIndex: number) => {
    const entry = previewEntries[galleryIndex];
    if (!entry) return;
    if (entry.attachment.mime.startsWith("video/")) {
      void openVideoPreview(entry.attachment, entry.persistedAttachmentIndex, galleryIndex);
      return;
    }
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
    setPreviewIndex(galleryIndex);
    setPreviewOpen(true);
  };
  const items = visibleAttachments.map(({ attachment, index }) => {
    const isTextMaterial =
      attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text";
    const ref = attachment.previewRef ?? attachment.ref;
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    const isPdf = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    const isMedia = isImage || isVideo;
    const isEditingAttachment = attachmentKind === "all";
    const isThumbnail = attachmentKind === "media" || (isEditingAttachment && isMedia);
    const fileDisplayDescriptor = resolveFileDisplayDescriptor(attachment.fileName);
    const isUnavailable = failedRefs.has(ref);
    const thumbnailUrl = thumbnailUrls.get(ref) ?? "";
    const previewItemIndex = previewEntries.findIndex((entry) => entry.index === index);
    // Images and videos share the current message's media gallery; read a video only when it first becomes the active item.
    const canOpen =
      (isTextMaterial && Boolean(sessionId && readAttachment)) ||
      (isImage && !isUnavailable && previewItemIndex >= 0) ||
      (isVideo && Boolean(sessionId && readAttachment)) ||
      (isPdf && Boolean(sessionId && (readAttachment || readAttachmentRange)));
    return (
      <Attachment
        key={`${attachment.ref}-${index}`}
        variant={isThumbnail ? "grid" : "inline"}
        data-v4-user-edit-attachment-kind={
          isEditingAttachment
            ? isImage
              ? "image"
              : isVideo
                ? "video"
                : isPdf
                  ? "pdf"
                  : "file"
            : undefined
        }
        data-v4-user-input-attachment-pill={isThumbnail ? undefined : "true"}
        data-v4-user-input-media-attachment={isThumbnail ? "true" : undefined}
        className={cn(
          isThumbnail &&
            (isEditingAttachment
              ? "relative size-12 overflow-hidden rounded-lg bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-[''] hover:bg-surface-hover"
              : "relative size-20 overflow-hidden rounded-xl bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-border after:content-[''] hover:bg-surface-hover"),
          !isThumbnail &&
            (isEditingAttachment
              ? "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
              : "rounded-full border-0 bg-surface px-3 py-1.5 hover:bg-surface-hover"),
        )}
        onRemove={onRemove ? () => onRemove(index) : undefined}
        onOpen={
          canOpen
            ? () =>
                isTextMaterial
                  ? void openTextPreview(attachment, attachmentIndices?.[index] ?? index)
                  : isPdf
                    ? void openPdfPreview(attachment, attachmentIndices?.[index] ?? index)
                    : selectPreviewItem(previewItemIndex)
            : undefined
        }
        openLabel={
          canOpen
            ? isTextMaterial
              ? intl.formatMessage({ id: "chat.attachments.preview.openText" })
              : isVideo
                ? previewVideoOpenLabel
                : isPdf
                  ? previewPdfOpenLabel
                  : previewOpenLabel
            : undefined
        }
        title={isUnavailable ? previewUnavailableLabel : undefined}
        data={{
          id: `${rowId}-${index}`,
          type: "file",
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        }}
      >
        {isThumbnail ? (
          <div className="relative size-full">
            <AttachmentPreview className="size-full rounded-none" />
          </div>
        ) : isEditingAttachment ? (
          <>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
              <FileDisplayIcon
                src={fileDisplayDescriptor.fileIconSrc}
                size={16}
                className="size-4 shrink-0"
              />
            </div>
            <div className="min-w-0 max-w-40 flex-1">
              <span
                className="block truncate text-ui-base font-medium text-foreground"
                title={attachment.fileName}
              >
                {attachment.fileName}
              </span>
              <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                {getAttachmentTypeLabel(attachment.fileName, attachment.mime)}
              </span>
            </div>
          </>
        ) : attachment.sourceKind === "topic-history" ? (
          <span className="truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              { id: "chat.attachments.topicHistory" },
              { count: attachment.messageCount ?? 0 },
            )}
          </span>
        ) : (
          <FileDisplayInline
            path={attachment.fileName}
            options={{
              className: "inline-flex min-w-0 max-w-40 items-center gap-1.5",
              iconSize: 16,
              fileNameClassName: "truncate text-ui-base font-medium text-foreground",
            }}
          />
        )}
        {onRemove && isEditingAttachment ? (
          <AttachmentRemove
            placement="corner"
            size="icon"
            variant="default"
            aria-label={intl.formatMessage({ id: "chat.attachments.remove" })}
            label={intl.formatMessage({ id: "chat.attachments.remove" })}
            data-testid={testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${rowId}-${index}`)}
            className="absolute top-0.5 right-0.5 z-10 size-3.5 rounded-full p-0 text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <XIcon className="size-2.5" />
          </AttachmentRemove>
        ) : null}
      </Attachment>
    );
  });
  return (
    <>
      {directItems ? (
        items
      ) : (
        <Attachments
          variant="inline"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(rowId))}
          className="max-w-full gap-2"
        >
          {items}
        </Attachments>
      )}
      <ChatMediaAttachmentPreviewDialog
        attachment={textPreview}
        open={textPreview !== null}
        onOpenChange={(open) => {
          if (!open) closeTextPreview();
        }}
        loading={textLoading}
        error={textError}
      />
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onActiveIndexChange={selectPreviewItem}
        onOpenChange={(open) => {
          if (open) {
            setPreviewOpen(true);
            return;
          }
          setPreviewOpen(false);
          closeVideoPreview();
        }}
        open={previewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfPreview}
        open={pdfPreviewRef !== null}
        loading={pdfPreviewLoading}
        error={pdfPreviewError}
        onOpenChange={(open) => {
          if (!open) closePdfPreview();
        }}
      />
    </>
  );
});

const SingleUserInputRowView = memo(function SingleUserInputRowView({
  row,
  context,
  onEdit,
  onPinChange,
  editWorkspaceRewindAvailability,
  status,
}: {
  row: UserInputRow;
  context: ConversationRowRenderContext;
  onEdit?: UserInputEditHandler;
  onPinChange?: RowPinChangeHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  status?: string;
}) {
  const { intl } = useZCodeIntl();
  const { pinned: rowPinned, togglePin } = useRowPinToggle({
    rowId: row.rowId,
    entityId: row.entityId,
    pinnedAt: row.pinnedAt,
    sessionId: context.sessionId,
    onPinChange,
  });
  const pinLabel = intl.formatMessage({
    id: rowPinned ? "chat.message.unpin" : "chat.message.pin",
  });
  // Collapse engine epilogues: body ends at epilogueStart, with later engine text folded into a disclosure at the bottom of the bubble.
  // Prompt-context parsing also reads only the body; epilogues contain no user references.
  const { body: bodyText, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
  const parsedPrompt = useMemo(
    () => ({
      ...parseComposerPromptContexts(bodyText, {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }),
      ...(row.conversationQuotes ? { conversationSelections: row.conversationQuotes } : {}),
    }),
    [context.workspaceIdentity, context.workspacePath, bodyText, row.conversationQuotes],
  );
  // Used only to strip the share URL trailing block from visible historical message bodies.
  // The block is no longer produced (see ConversationComposer's promptText comment); keep parsing it so messages sent
  // between the wiring fix and this removal do not display raw markup as body text.
  const parsedShareContext = useMemo(
    () => parseConversationShareContext(parsedPrompt.visibleContent),
    [parsedPrompt.visibleContent],
  );
  const editSessionKey = context.sessionId
    ? composerEditSessionKey(
        context.workspaceIdentity?.trim() || context.workspacePath,
        context.sessionId,
      )
    : null;
  // 只订阅本行是否为编辑目标，避免编辑态变化让整条时间线重渲染。
  const editingInComposer = useComposerEditStore((state) => {
    const target = editSessionKey ? state.sessions[editSessionKey]?.target : undefined;
    return target?.kind === "userQuery" && target.rowId === row.rowId;
  });
  useEffect(() => {
    if (!editingInComposer || !editSessionKey || !editWorkspaceRewindAvailability) return;
    // 「对话 + 文件重置」的可用性只有本行知道；编辑期间同步给 composer 状态条。
    useComposerEditStore.getState().update(editSessionKey, {
      workspaceRewind: {
        enabled: editWorkspaceRewindAvailability.enabled,
        reason: editWorkspaceRewindAvailability.reason,
      },
    });
  }, [editSessionKey, editWorkspaceRewindAvailability, editingInComposer]);
  const handleFocusComposerEdit = useCallback(() => {
    if (editSessionKey) useComposerEditStore.getState().requestFocus(editSessionKey);
  }, [editSessionKey]);
  const visibleText = parsedShareContext.visibleContent;
  const codeCommentContexts = parsedPrompt.codeComments;
  // 设计稿元素在正文里已经画成 token，卡片只给普通网页「选择元素」的引用
  const webElementContexts = useMemo(
    () => parsedPrompt.webElements.filter((context) => !context.inline),
    [parsedPrompt.webElements],
  );
  const pptxElementReferences = parsedPrompt.pptxElements;
  const conversationSelections = parsedPrompt.conversationSelections;
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  const hasMediaAttachments =
    row.attachments?.some(
      (attachment) => attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasFileAttachments =
    row.attachments?.some(
      (attachment) =>
        !attachment.mime.startsWith("image/") && !attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasVisibleText = visibleText.trim().length > 0;
  const pluginUiContexts = parsedPrompt.pluginUiContexts;
  // A nudge turn contains only engine text: the body is empty, but render a bubble with only the disclosure.
  const hasBubble = hasVisibleText || epilogue !== undefined;
  const hasContextReferences =
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    conversationSelections.length > 0 ||
    pluginUiContexts.length > 0;
  const hasAttachmentArea = hasAttachments || hasContextReferences;
  const hasAttachmentPills =
    hasFileAttachments ||
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    (!row.botGroupSource && conversationSelections.length > 0);
  // Root cause: the old logic accepted only schedule runIds, leaving manual runs from “Run now”
  // without a source marker. Show both valid automation runId forms; ordinary conversation input
  // still stays hidden because parsing fails.
  const isScheduledAutomationPrompt = parseAutomationRunId(row.sourceCommandId ?? "") !== null;
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath: context.workspacePath,
    workspaceIdentity: context.workspaceIdentity,
    remoteSessionId: context.workspaceRemoteSessionId,
    onOpenCodeViewer: context.onOpenCodeViewer,
  });

  const handleOpenEdit = useCallback(() => {
    if (!onEdit || !row.entityId) return;
    void onEdit({ rowId: row.rowId, entityId: row.entityId });
  }, [onEdit, row.entityId, row.rowId]);

  return (
    <RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
      {isScheduledAutomationPrompt ? (
        <div
          data-v4-user-input-automation-origin="schedule"
          className="mb-1 flex max-w-xl items-center gap-1 text-ui-sm text-foreground-subtle"
        >
          <Clock data-cron-task-icon="true" aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{intl.formatMessage({ id: "chat.message.sentByScheduledTask" })}</span>
        </div>
      ) : null}
      {row.botGroupSource ? (
        // Group attribution used to appear between attachments and message text, splitting one input; place it before attachments.
        <div data-v4-user-input-source="true" className="mb-2 flex min-w-0 max-w-full">
          <BotGroupSourceLabel source={row.botGroupSource} />
        </div>
      ) : null}

      {hasAttachmentArea ? (
        <div
          data-v4-user-input-attachments="true"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(row.rowId))}
          className="mb-2 flex max-w-xl flex-col items-end gap-2"
        >
          {row.botGroupSource && conversationSelections.length > 0 ? (
            <div data-v4-user-input-quotes="true" className="flex max-w-full justify-end">
              <ConversationSelectionReferenceChip
                references={conversationSelections}
                contentAlign="end"
              />
            </div>
          ) : null}
          {hasMediaAttachments ? (
            <div
              data-v4-user-input-media-attachments="true"
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              <UserInputAttachmentList
                attachments={row.attachments}
                entityId={row.entityId}
                attachmentKind="media"
                directItems
                rowId={row.rowId}
                sessionId={context.sessionId ?? undefined}
                readAttachment={context.readAttachment}
                readAttachmentRange={context.readAttachmentRange}
              />
            </div>
          ) : null}
          {hasAttachmentPills ? (
            <div
              data-v4-user-input-attachment-pills="true"
              // Non-media files and context references must share this layer to preserve the order
              // file → comments → web → PPT → conversation references and right-align them consistently when wrapping.
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              {hasFileAttachments ? (
                <UserInputAttachmentList
                  attachments={row.attachments}
                  entityId={row.entityId}
                  attachmentKind="file"
                  directItems
                  rowId={row.rowId}
                  sessionId={context.sessionId ?? undefined}
                  readAttachment={context.readAttachment}
                  readAttachmentRange={context.readAttachmentRange}
                />
              ) : null}
              <CodeCommentAttachmentChip comments={codeCommentContexts} contentAlign="end" />
              <WebElementContextAttachmentChip contexts={webElementContexts} contentAlign="end" />
              <PptxElementReferenceChip
                references={pptxElementReferences}
                contentAlign="end"
                onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
              />
              {!row.botGroupSource ? (
                <ConversationSelectionReferenceChip
                  references={conversationSelections}
                  contentAlign="end"
                />
              ) : null}
              <PluginUiModelContextChip contexts={pluginUiContexts} contentAlign="end" />
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBubble ? (
        // Attachments and context references belong to the message row, not the bubble; otherwise attachment-only messages leave an empty bubble.
        // The same row renders in the main conversation and Subagent sidebar, so a fixed width would ignore the actual host width.
        // Keep the bubble's automatic flex-item width; cap it at 36rem with 48px of remaining space only when the host is at least 624px wide.
        <ConversationUserInputBubble
          text={visibleText}
          imagePreviewContext={context}
          contentParts={row.botGroupSource?.contentParts}
          rowId={row.rowId}
          epilogue={epilogue}
          attachments={row.attachments}
          contextAttachmentCount={countComposerPromptContexts(parsedPrompt)}
        />
      ) : null}
      {row.source?.kind === "session" && <SessionSourceHint source={row.source} />}
      {row.source?.kind === "genUi" && (
        <div
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          data-v4-user-input-source="genUi"
        >
          {intl.formatMessage({ id: "genUi.from" }, { name: row.source.title || "Gen UI" })}
        </div>
      )}
      {row.source?.kind === "pluginUi" || row.source?.kind === "extension" ? (
        // 插件 UI 或扩展（docs/plugins/extension-host.md §17.8）代发：来源标记来自 CLI 持久化的 intent.source，
        // 不由 renderer 推断。两者同一句文案；名字取插件 id 的名字部分，手机没有扩展静态表，桌面与手机一致。
        <div
          data-v4-user-input-source={row.source.pluginId}
          data-v4-user-input-source-kind={row.source.kind}
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
        >
          {intl.formatMessage(
            { id: "pluginUi.fromPlugin" },
            { name: formatPluginDisplayName(row.source.pluginId) },
          )}
        </div>
      ) : null}
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
      {/* Bugfix: Mobile remote control has no hover. The v4 migration omitted the old UserMessage always-
          visible branch, making Copy and Edit hard to discover. Show them directly for remote
          control; desktop continues to reduce visual noise with hover/focus. A pinned row keeps the
          toolbar visible so the pin state stays discoverable and unpin stays reachable. */}
      <MessageActions
        className={cn(
          "mt-1",
          context.compactForRemoteControl || rowPinned
            ? "opacity-100"
            : "opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100",
        )}
      >
        <CopyRowAction
          text={row.text}
          rowId={row.rowId}
          label={intl.formatMessage({ id: "chat.message.copy" })}
        />
        {onPinChange && row.entityId && row.origin === "realUser" ? (
          <MessageAction
            aria-label={pinLabel}
            aria-pressed={rowPinned}
            label={pinLabel}
            tooltip={pinLabel}
            data-testid={testId(TID_V4_PIN, String(row.rowId))}
            className={rowPinned ? "!bg-success/10" : undefined}
            onClick={togglePin}
          >
            <PinIcon className="size-3.5" />
          </MessageAction>
        ) : null}
        {onEdit && row.entityId && !editingInComposer ? (
          <MessageAction
            label={intl.formatMessage({ id: "chat.message.edit" })}
            tooltip={intl.formatMessage({ id: "chat.message.edit" })}
            data-testid={testId(TID_V4_EDIT, String(row.rowId))}
            onClick={handleOpenEdit}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null}
      </MessageActions>
      {editingInComposer ? (
        <button
          type="button"
          data-testid={testId(TID_V4_EDIT_IN_COMPOSER_HINT, String(row.rowId))}
          className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-sm text-foreground-subtle hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={handleFocusComposerEdit}
        >
          <PencilIcon className="size-3.5" aria-hidden />
          {intl.formatMessage({ id: "chat.composerEdit.inComposerHint" })}
        </button>
      ) : null}
    </RowShell>
  );
});

const UserInputRowView = memo(function UserInputRowView(
  props: ComponentProps<typeof SingleUserInputRowView>,
) {
  const rows = useMemo(() => expandTopicInputMessages(props.row), [props.row]);
  if (rows.length === 1) return <SingleUserInputRowView {...props} row={rows[0]!} />;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-v4-topic-messages="true">
      {rows.map((row) => (
        <div
          key={row.botGroupSource!.messageId}
          data-topic-message-id={row.botGroupSource!.messageId}
        >
          {/* Multiple source rows share one accepted input; do not mistake a local edit for replacing the whole batch. */}
          <SingleUserInputRowView {...props} row={row} onEdit={undefined} />
        </div>
      ))}
    </div>
  );
});

// Array defaults for memoized components must be module-level constants; an inline [] is a new reference on every render and defeats memo comparison.
const EMPTY_SOURCE_COMMAND_IDS: readonly string[] = [];

export const ConversationAssistantTextActions = memo(function ConversationAssistantTextActions({
  rowId,
  entityId,
  text,
  createdAt,
  compactForRemoteControl = false,
  feedback = null,
  pinnedAt,
  hookInvocations,
  sessionId,
  turnId,
  sourceCommandIds = EMPTY_SOURCE_COMMAND_IDS,
  onFork,
  onFeedbackChange,
  onPinChange,
  className,
}: {
  rowId: number;
  entityId?: string;
  text: string;
  createdAt: number;
  compactForRemoteControl?: boolean;
  feedback?: AssistantMessageFeedback | null;
  pinnedAt?: number;
  hookInvocations?: readonly HookInvocationRow[];
  sessionId?: string | null;
  turnId?: string;
  sourceCommandIds?: readonly string[];
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onPinChange?: RowPinChangeHandler;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const { pinned: rowPinned, togglePin } = useRowPinToggle({
    rowId,
    entityId,
    pinnedAt,
    sessionId,
    onPinChange,
  });
  const pinLabel = intl.formatMessage({
    id: rowPinned ? "chat.message.unpin" : "chat.message.pin",
  });
  const [localFeedback, setLocalFeedback] = useState<AssistantMessageFeedback | null>(feedback);
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const likeLabel = intl.formatMessage({
    id: localFeedback === "like" ? "chat.message.liked" : "chat.message.like",
  });
  const dislikeLabel = intl.formatMessage({
    id: localFeedback === "dislike" ? "chat.message.disliked" : "chat.message.dislike",
  });
  const forkLabel = intl.formatMessage({ id: "chat.message.fork" });
  const timeLabel = formatMessageTimeLabel(createdAt, locale, intl);
  const resolveTooltip = (label: string): string | undefined =>
    compactForRemoteControl ? undefined : label;

  useEffect(() => {
    setLocalFeedback(feedback);
  }, [feedback]);

  const handleFeedback = useCallback(
    (nextFeedback: AssistantMessageFeedback) => {
      const previousFeedback = localFeedback;
      const resolvedFeedback = previousFeedback === nextFeedback ? null : nextFeedback;
      setLocalFeedback(resolvedFeedback);
      logger.info("[ConversationRowView] 用户反馈 assistant 消息", {
        messageId: entityId ?? null,
        reaction: resolvedFeedback ?? "none",
      });
      if (entityId) {
        void Promise.resolve(onFeedbackChange?.({ rowId, entityId }, resolvedFeedback)).then(
          (result) => {
            if (result === false) setLocalFeedback(previousFeedback);
          },
          (error: unknown) => {
            setLocalFeedback(previousFeedback);
            // The initial V4 implementation updated only renderer-local state, showing feedback that did not exist after command failure.
            // Roll back on failure to the projected value from before the click, then let a later authoritative row correct it.
            logger.warn("[ConversationRowView] 持久化 assistant 反馈失败", {
              error: error instanceof Error ? error.message : String(error),
              messageId: entityId,
            });
          },
        );
      }
      if (platform && entityId) {
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "assistant_message_feedback",
            eventRegion: "chat",
            eventType: "ck",
            eventExtraDetail: { reaction: resolvedFeedback ?? "none" },
            ...(sessionId ? { talkId: sessionId } : {}),
            messageId: entityId,
          },
          "ConversationRowView",
        );
      }
    },
    [entityId, localFeedback, onFeedbackChange, platform, rowId, sessionId],
  );
  const handleFork = useCallback(() => {
    if (entityId) {
      runUserAction({
        input: { featureId: "conversation.history.branch", action: "fork", trigger: "button" },
        operation: () => onFork?.({ rowId, entityId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "fork",
      });
    }
  }, [entityId, onFork, rowId]);
  const forkDestination = useForkDestination();
  const forkToWorktree = forkDestination.forkToWorktree;
  const handleForkToWorktree = useCallback(() => {
    if (entityId && forkToWorktree) forkToWorktree({ rowId, entityId });
  }, [entityId, forkToWorktree, rowId]);
  return (
    <MessageActions className={cn(className, "has-[[data-bot-group-delivery]]:opacity-100")}>
      <CopyRowAction
        text={text}
        rowId={rowId}
        label={copyLabel}
        tooltip={resolveTooltip(copyLabel)}
      />
      {entityId && onFeedbackChange ? (
        <>
          <MessageAction
            aria-label={likeLabel}
            aria-pressed={localFeedback === "like"}
            label={likeLabel}
            tooltip={resolveTooltip(likeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_LIKE, String(rowId))}
            className={localFeedback === "like" ? "!bg-success/10" : undefined}
            onClick={() => handleFeedback("like")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "like" && "zcode-reaction-burst",
              )}
            >
              <ThumbsUpIcon className="size-3.5" />
            </span>
          </MessageAction>
          <MessageAction
            aria-label={dislikeLabel}
            aria-pressed={localFeedback === "dislike"}
            label={dislikeLabel}
            tooltip={resolveTooltip(dislikeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_DISLIKE, String(rowId))}
            className={localFeedback === "dislike" ? "!bg-warning/10" : undefined}
            onClick={() => handleFeedback("dislike")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "dislike" && "zcode-reaction-burst",
              )}
            >
              <ThumbsDownIcon className="size-3.5" />
            </span>
          </MessageAction>
        </>
      ) : null}
      {onFork && entityId ? (
        forkToWorktree ? (
          <ForkDestinationMenu
            rowId={rowId}
            label={forkLabel}
            tooltip={resolveTooltip(forkLabel)}
            worktreeAvailable={forkDestination.available}
            inWorktree={forkDestination.inWorktree}
            onForkHere={handleFork}
            onForkToWorktree={handleForkToWorktree}
          />
        ) : (
          <MessageAction
            aria-label={forkLabel}
            label={forkLabel}
            tooltip={resolveTooltip(forkLabel)}
            data-testid={testId(TID_V4_FORK, String(rowId))}
            onClick={handleFork}
          >
            <TrendingUpDownIcon className="size-3.5" />
          </MessageAction>
        )
      ) : null}
      {onPinChange && entityId ? (
        <MessageAction
          aria-label={pinLabel}
          aria-pressed={rowPinned}
          label={pinLabel}
          tooltip={resolveTooltip(pinLabel)}
          data-testid={testId(TID_V4_PIN, String(rowId))}
          className={rowPinned ? "!bg-success/10" : undefined}
          onClick={togglePin}
        >
          <PinIcon className="size-3.5" />
        </MessageAction>
      ) : null}
      {turnId && hookInvocations ? (
        <ConversationHookDetailsAction rows={hookInvocations} turnId={turnId} />
      ) : null}
      {/* Bugfix: Removing the old conversation surface also dropped the message creation time from the
              V4 action bar. This is a read-only display derived from row.createdAt; do not add
              renderer state. */}
      {timeLabel ? (
        <span className="select-none text-ui-sm text-foreground-subtlest">{timeLabel}</span>
      ) : null}
      {turnId ? (
        <ConnectedBotGroupDeliveryAction turnId={turnId} sourceCommandIds={sourceCommandIds} />
      ) : null}
    </MessageActions>
  );
});

const AssistantTextRowView = memo(function AssistantTextRowView({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onPinChange,
  hideActions,
  deferActions,
  copyText,
  previewCards,
  previewCardsAutoOpenKey,
  codeCommentCards,
  codeCommentProjectionEnabled,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onPinChange?: RowPinChangeHandler;
  hideActions?: boolean;
  deferActions?: boolean;
  copyText?: string;
  previewCards?: AssistantPreviewCard[];
  previewCardsAutoOpenKey?: string;
  codeCommentCards?: AssistantCodeCommentCard[];
  codeCommentProjectionEnabled?: boolean;
}) {
  const streaming = row.state === "streaming";
  const isOfficeMode = useIsOfficeMode();
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const projectsCodeComments = codeCommentCardsEnabled && codeCommentProjectionEnabled === true;
  const visibleText = useMemo(
    () =>
      projectsCodeComments
        ? projectAssistantCodeComments(row.text, { streaming }).visibleText
        : row.text,
    [projectsCodeComments, row.text, streaming],
  );
  const visiblePreviewCards = previewCards && previewCards.length > 0 ? previewCards : null;
  const textElement = useRef<HTMLDivElement>(null);
  const paintFrames = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const frame of paintFrames.current) cancelAnimationFrame(frame);
    },
    [],
  );
  useLayoutEffect(() => {
    if (context.workspaceIdentity || !context.sessionId) return;
    const observer = getLocalTtftObserver();
    const args = [context.workspacePath, context.sessionId, row.turnId, row.rowId] as const;
    if (!observer?.needsTextRender(...args)) return;
    const element = textElement.current;
    if (!element?.textContent?.trim()) return;
    const visible = () => {
      if (
        !element.isConnected ||
        document.visibilityState !== "visible" ||
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        return false;
      const rect = element.getBoundingClientRect();
      return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };
    if (!observer.textRendered(...args, "committed", visible())) return;
    // The frame arrives before the React commit; two rAFs only mean a paint opportunity has passed and must not claim that pixels reached the screen.
    // Streaming text updates must not cancel the first-frame observation; only unmount cancels it, so frequent updates do not stretch the timing to the end of the whole turn.
    paintFrames.current.push(
      requestAnimationFrame(() => {
        paintFrames.current.push(
          requestAnimationFrame(() => {
            observer.textRendered(...args, "paint_estimate", visible());
          }),
        );
      }),
    );
  }, [
    context.workspaceIdentity,
    context.workspacePath,
    context.sessionId,
    row.turnId,
    row.rowId,
    visibleText,
  ]);
  return (
    <RowShell rowId={row.rowId} className="group/assistant-row">
      {/* M5④ phase 2: Assistant text uses streamdown (MessageResponse) for Markdown and code block rendering;
          streaming mode tolerates incomplete Markdown. */}
      {/* Bugfix: MessageResponse consumes only its declared props and does not forward data-* attributes to
          the real DOM. Although the assistant body was marked selectable in JSX, the selection
          logic could never find it. Put selectable on a stable DOM wrapper and use the same path
          for completed and streaming messages. */}
      <div ref={textElement} data-conversation-selectable="true" className="w-full text-ui-base">
        <GenUiMessageResponse
          completed={row.state === "complete"}
          messageKey={`${row.rowId}:${row.entityId ?? ""}`}
          renderZCodeFileCitations
          streaming={streaming}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
          workspaceRemoteSessionId={context.workspaceRemoteSessionId}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          forceCodeWrap={isOfficeMode}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenExternalUrl={context.onOpenBrowserUrl}
          sessionId={context.sessionId ?? undefined}
          readAttachment={context.readAttachment}
        >
          {visibleText}
        </GenUiMessageResponse>
      </div>
      {codeCommentCardsEnabled && codeCommentCards && codeCommentCards.length > 0 ? (
        <div className="mt-3">
          <AssistantCodeCommentCards
            cards={codeCommentCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenCodeViewer={context.onOpenCodeViewer}
          />
        </div>
      ) : null}
      {visiblePreviewCards ? (
        <div className="mt-3">
          <AssistantPreviewCards
            cards={visiblePreviewCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            autoOpenPptxKey={previewCardsAutoOpenKey}
            onAutoOpenPptx={context.onAutoOpenAssistantPptx}
            compactForRemoteControl={context.compactForRemoteControl}
          />
        </div>
      ) : null}
      {/* Show completed-message actions on hover, matching the old MessageActions: Copy and Fork
          use ghost icons. A turn is one reply to the user, so actions appear only on its final
          segment (TurnGroup controls hideActions). Copy merges all text segments in the turn;
          copyText overrides that value. */}
      {row.state === "complete" && !hideActions && !deferActions ? (
        <ConversationAssistantTextActions
          rowId={row.rowId}
          entityId={row.entityId}
          text={copyText ?? row.text}
          createdAt={row.createdAt}
          compactForRemoteControl={context.compactForRemoteControl}
          feedback={readAssistantFeedback(row)}
          pinnedAt={row.pinnedAt}
          sessionId={context.sessionId}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          onPinChange={onPinChange}
          className={cn(
            "mt-1",
            context.compactForRemoteControl || row.pinnedAt !== undefined
              ? "opacity-100"
              : "opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100",
          )}
        />
      ) : null}
    </RowShell>
  );
});

const ReasoningRowView = memo(function ReasoningRowView({
  row,
  contentVariant,
}: {
  row: ReasoningRow;
  contentVariant?: "default" | "nested";
}) {
  const streaming = row.state === "streaming";
  // Match the old ThoughtBlock in chatMessageParts with the ai-elements Reasoning disclosure.
  // Interaction change: expanded streaming reasoning continually pushes tools and body content out of view.
  // Collapse it by default during both streaming and completion, show only the running label, and let users expand it manually.
  // autoCollapseKey still ensures state-boundary changes do not override user interaction.
  const durationSeconds =
    row.durationMs !== undefined ? Math.max(1, Math.ceil(row.durationMs / 1000)) : undefined;
  if (streaming && row.text.length === 0) {
    return null;
  }
  return (
    <RowShell rowId={row.rowId}>
      <Reasoning
        className="w-full"
        isStreaming={streaming}
        autoCollapseKey={streaming ? null : row.state}
        {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}
      >
        {/* Bug cause: The attachment refactor accidentally dropped the streamingText wiring, leaving the summary
            component in place but always passing it empty text. */}
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent variant={contentVariant}>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </RowShell>
  );
});

const TurnHeaderRowView = memo(function TurnHeaderRowView({ row }: { row: TurnHeaderRow }) {
  return (
    <RowShell
      rowId={row.rowId}
      className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
    >
      turn · {row.origin} · {row.state}
    </RowShell>
  );
});

/** timelineMarker 分隔线与分享只读页共用；这里只注入 App 宿主能力。 */
const TimelineMarkerRowView = memo(function TimelineMarkerRowView({
  row,
  context,
}: {
  row: TimelineMarkerRow;
  context: ConversationRowRenderContext;
}) {
  const isOfficeMode = useIsOfficeMode();
  // "已创建 worktree"是可展开的输出块，不是分隔线（docs/git/worktree.md §3.3）。
  // 它依赖 App 侧 managed-worktrees 能力，留在宿主这里，不进分享只读页共用的分隔线组件。
  if (row.marker.type === "worktreeCreated") {
    return <WorktreeCreatedMarker rowId={row.rowId} output={row.marker.output} />;
  }
  return (
    <ConversationTimelineMarkerDivider
      row={row}
      isOfficeMode={isOfficeMode}
      modelSelectionView={context.modelSelectionView ?? null}
      onNavigateToRow={context.onNavigateToRow}
    />
  );
});

const ToolCallRowView = memo(function ToolCallRowView({
  row,
  context,
}: {
  row: ToolCallRow;
  context: ConversationRowRenderContext;
}) {
  // Connect toolCall rows back to ToolCallBlocks (execute/read/edit/... renderers dispatch by tool identity).
  // Memoize by row reference: rebuild only when row.delta/upserted replaces the object.
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  // Gate for the workflow-run details entry: get run identity from the workflowRuns projection (the schema defines
  // toolCallId as the key from tool card to details page), not from tool output, which is only a sentence in v4 rows.
  // The matched summary also selects the card shape: a run gets a compact clickable card; otherwise, use an expandable card.
  const workflowRun =
    context.workflowRunByToolCallId?.get(row.toolCallId) ??
    // Join ResumeWorkflowRun rows by runId: the display payload includes runId (same as backgroundTaskId), while the projected
    // run.toolCallId remains the original CreateWorkflow row across resume, so a resume row is never found by toolCallId.
    // After a match, narrow onOpenWorkflowRun through the same path; runId-keyed tab identity is idempotent.
    (row.display?.kind === "resume_workflow_run"
      ? context.workflowRunByRunId?.get(row.display.runId)
      : undefined);
  // A fill row joined to a run (docs/dynamic-workflow/presentation.md, “The fill row”) displays
  // “Hole filled · {name} · {k} phases · {m} subagents ↗”. Join the projection by input `run_id`
  // (the fill row's toolCallId differs from the launch row's) and accept only successful, compiled
  // rows. Failed fills appear as compilation feedback below and do not join the run. A new station
  // appears beneath the card (the turn-tail summary uses this row's graph).
  // The name comes from the display's `fill` block; the row input has no name because the transcript stores only the model's input.
  const fillTarget = isFillWorkflowHoleToolCall(row)
    ? readWorkflowHoleTarget(
        row.input,
        row.display?.kind === "create_workflow" ? row.display.fill : undefined,
      )
    : undefined;
  const fillRun =
    fillTarget?.runId === undefined ? undefined : context.workflowRunByRunId?.get(fillTarget.runId);
  if (
    fillTarget !== undefined &&
    fillTarget.holeId !== undefined &&
    fillRun !== undefined &&
    row.status === "success" &&
    row.display?.kind === "create_workflow" &&
    row.display.ok
  ) {
    const sessionId = context.sessionId;
    const counts = workflowFillCounts(row.display.causalityGraph, fillTarget.holeId);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={fillRun}
          fill={{
            name: fillTarget.name ?? fillTarget.holeId,
            ...counts,
          }}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, fillRun),
                    runId: fillRun.runId,
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // Reason: the started tool card and end-of-turn summary duplicated the same live progress; the summary above is now a regular entry point.
  // Replace only the successfully matched initiating row; compiler diagnostics, Resume, and other tools keep their existing rendering.
  if (
    workflowRun &&
    context.workflowRunByToolCallId?.has(row.toolCallId) &&
    row.status !== "error"
  ) {
    const workflowName = readWorkflowName(row.input);
    const sessionId = context.sessionId;
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={workflowRun}
          amend={isAmendWorkflowToolCall(row)}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                    ...(workflowName === undefined ? {} : { workflowName }),
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // In-place update: when only the concurrency limit changes while a run is active, this call does not compile or create a new run;
  // its result is a single sentence. Identify it using existing fields: the input shape, **no** display, and success without an error.
  // Tool structured output does not pass through v4, and all three create_workflow display schemas use a frozen `.strict()` field set.
  // Adding a key would make older clients discard the entire tool result, so do not add protocol fields for this path.
  // A real update after the run settles fails both checks: it has display and creates a run joinable by toolCallId, handled by the branch above.
  const retune = isAmendWorkflowToolCall(row) ? readWorkflowRetuneCall(row.input) : undefined;
  if (
    retune !== undefined &&
    row.status === "success" &&
    (row.output?.display ?? row.display) === undefined &&
    !context.workflowRunByToolCallId?.has(row.toolCallId)
  ) {
    const sessionId = context.sessionId;
    // Projection of the run being retuned, used only for two things: default concurrency (so
    // wording can describe “equal to default” as “restore default”) and the launch-row id for the
    // run in the open request. It does not go into `workflowRun` above, which answers whether this
    // row launched a run; this row did not.
    const retuned = context.workflowRunByRunId?.get(retune.runId);
    const defaultConcurrency =
      retuned?.run === undefined ? undefined : workflowRunDefaultConcurrency(retuned.run);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowRetuneRow
          requested={retune.requested}
          runId={retune.runId}
          {...(defaultConcurrency === undefined ? {} : { defaultConcurrency })}
          {...(context.onOpenWorkflowRun && sessionId
            ? {
                onOpen: () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, retuned),
                    runId: retune.runId,
                  }),
              }
            : {})}
        />
      </RowShell>
    );
  }
  // Remove vertical padding from tool rows (matching z-code-2, which has no per-tool padding); ConversationAssistantWorkItems supplies
  // consistent gap-4 spacing between consecutive tools.
  return (
    <RowShell rowId={row.rowId} className="py-0">
      <div data-conversation-selectable="true">
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
          onOpenPlanDetail={
            context.onOpenPlanDetail && context.sessionId
              ? (request) =>
                  context.onOpenPlanDetail?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                  })
              : undefined
          }
          onOpenWorkflowRun={
            context.onOpenWorkflowRun && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowRun?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    // The open request's join key is the initiating CreateWorkflow row ID, not the clicked row ID.
                    // They differ when opening from a resume row; the details page uses it to find the causalityGraph/script.
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onOpenWorkflowActor={
            context.onOpenWorkflowActor && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowActor?.({ ...request, parentSessionId: context.sessionId! })
              : undefined
          }
          // Script pill to script transcript: same join keys as onOpenWorkflowRun (initiating row ID + runId).
          onOpenWorkflowWorkspace={
            context.onOpenWorkflowWorkspace && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowWorkspace?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onResumeWorkflowRun={
            context.onResumeWorkflowRun && workflowRun?.resumable
              ? (request) => context.onResumeWorkflowRun?.(workflowRun.runId, request.workflowName)
              : undefined
          }
          // Artifact pill to artifact tab: same open path as notification-row chips (no version, so opening shows the latest).
          onOpenWorkflowArtifact={
            context.onOpenWorkflowArtifact && context.sessionId && workflowRun
              ? (artifactId) => {
                  // The live projection's artifact summary includes the latest `contentType` (the host uses it to open HTML artifacts
                  // directly in a browser tab). The `sourcePath` summary deliberately omits it; when absent, the host reads the journal.
                  const artifact = workflowRun.run?.artifacts?.find(
                    (candidate) => candidate.id === artifactId,
                  );
                  context.onOpenWorkflowArtifact?.({
                    parentSessionId: context.sessionId!,
                    runId: workflowRun.runId,
                    artifactId,
                    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                    ...(artifact?.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                  });
                }
              : undefined
          }
          workflowRun={workflowRun}
          workflowDraft={context.workflowDraftByToolCallId?.get(row.toolCallId)}
        />
      </div>
    </RowShell>
  );
});

const SubagentRowView = memo(function SubagentRowView({ row }: { row: SubagentRow }) {
  // Subagent rows are already rendered alongside Agent/Task tool rows. Keep a bare row only as an error fallback summary
  // to avoid creating another "child session" card or a second drill-down entry.
  const summary = (
    <>
      {row.subagentType} · {row.status}
      {row.summaryText ? ` — ${row.summaryText}` : ""}
    </>
  );
  return (
    <RowShell rowId={row.rowId}>
      <div className="text-ui-sm text-[var(--color-foreground-subtle)]">{summary}</div>
    </RowShell>
  );
});

/**
 * v4 row rendering dispatcher. Memoization: the virtual list renders each row separately, so a parent projection update rerenders only rows whose props changed
 * (provided onFork/onRetry/onEdit and context references are stable; see SessionPane's
 * useCallback/useMemo）。
 */
function ConversationRowViewImpl({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onPinChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  switch (row.kind) {
    case "userInput":
      return (
        <UserInputRowView
          row={row}
          context={context}
          onEdit={onEdit}
          onPinChange={onPinChange}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          status={userInputStatus}
        />
      );
    case "assistantText":
      return (
        <AssistantTextRowView
          row={row}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          onPinChange={onPinChange}
          hideActions={hideAssistantActions}
          deferActions={deferAssistantActions}
          copyText={assistantCopyText}
          previewCards={assistantPreviewCards}
          previewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          codeCommentCards={assistantCodeCommentCards}
          codeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      );
    case "reasoning":
      // Turning off "Show thinking process" hides only later reasoning in each turn. The first reasoning row
      // is the minimum necessary thinking indicator for that turn and must be retained using its ID derived from total turn order.
      return isConversationReasoningRowVisible(row.rowId, context) ? (
        <ReasoningRowView row={row} contentVariant={reasoningContentVariant} />
      ) : null;
    case "turnHeader":
      return <TurnHeaderRowView row={row} />;
    case "timelineMarker":
      return <TimelineMarkerRowView row={row} context={context} />;
    case "toolCall":
      // Returning null inside ToolCallBlock would leave an empty RowShell and extra spacing.
      // Apply the same tool-identity rule in the row dispatcher so disabling the setting produces no Todo DOM.
      if (
        context.messageStreamShowTodos !== true &&
        resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "todo"
      ) {
        return null;
      }
      return <ToolCallRowView row={row} context={context} />;
    case "subagent":
      return <SubagentRowView row={row} />;
    case "artifact":
      return <ArtifactRowView row={row} />;
    case "unreadable":
      return <UnreadableRowView row={row} />;
    default:
      return null;
  }
}

export const ConversationRowView = memo(ConversationRowViewImpl);
