import { ComposerSubmissionPendingContext } from "@/project-sidebar/index.js";
/* oxlint-disable eslint(max-lines) -- composer 集中收口输入区 wiring（附件/草稿/历史/mention），拆分会打散收口粒度。 */
import { useRemoteProjectReconnect } from "@/hooks/RemoteProjectPresentationContext.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import { restartPreparedWorktreeCreation } from "@/v4/composer/restartPreparedWorktreeCreation.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
/**
 * v4 会话 composer（composer parity）。
 *
 * 壳：ChatPromptEditor（Lexical 编辑器 + 动作菜单 + 拖拽反馈 + sticky 底座视觉），
 * 附件预览网格/大图预览/错误提示区一并提供。
 *
 * 芯：全新 v4 wiring——
 * - 路由/状态一律读 v4 投影 snapshot.inputRouting / control / config / usage；
 * - 发送键状态机对齐旧 UI：canSend（有文本或附件+路由允许）/ pending spinner /
 *   running+空草稿 → Stop（v4 stop 命令）/ 暂停队列（choice）→ 发送后弹清空/保留确认框；
 * - 附件全链路见 useComposerAttachments（发送经 v4 sendText attachments）；
 * - mention（@ 文件/画板、# 会话、$ 技能）与 slash 目录全集在 LexicalChatInput 内接线；
 * - 草稿 per-session 持久化（composerDraftStore）+ prompt history（promptHistoryStorage）；
 * - 工具条（模型/思考深度/模式/context usage）见 V4ComposerToolbar。
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { HighspeedComposerBackground } from "@/highspeed/HighspeedActivationVisual.js";
import { useHighspeedComposerEntrance } from "@/highspeed/useHighspeedComposerEntrance.js";
import {
  type HighspeedCardSnapshot,
  type IncognitoProfile,
  type PlanIdentitySnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import {
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_CHAT_ATTACHMENT_MENU_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import type {
  AttachmentRef,
  ConversationSnapshot,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ArrowUpIcon,
  ClipboardPenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  ChatErrorBanner,
  resolveChatErrorBannerDisplayMessage,
  shouldSuppressChatErrorBanner,
  type ChatErrorBannerModelConfigTarget,
} from "@/ChatErrorBanner.js";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { runUserAction, startUserAction } from "@/lib/userActionTelemetry.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isPdfChatComposerAttachment,
  isMediaChatComposerAttachment,
  isVideoChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { resolveChatPlaceholderKey } from "@/lib/chatPlaceholder.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  readWorkspaceFileDragPayload,
  isWorkspaceFileAddToChatEvent,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { resolveProviderBaseURL } from "@/lib/registryProviderView.js";
import type { ModelSelectionView, VoiceTranscriptionPreview } from "@zcode/services";
import type {
  ModelSelectionState,
  ModelSelectionRefreshResult,
} from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import {
  clearV4ComposerDraft,
  getV4FirstSubmissionVersion,
  getV4WorktreeRecoveryScope,
  isV4FirstSubmissionActive,
  moveV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  subscribeV4ComposerDrafts,
  updateV4FirstSubmission,
  setV4FirstSubmissionActive,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type V4ComposerRecoveryContexts,
} from "@/v4/composer/composerDraftStore.js";
import {
  buildV4RecoveryAttachmentsManifest,
  buildV4WorktreeIntentFromParams,
} from "@/v4/composer/composerRecoveryRecord.js";
import { restoreComposerRecoveryContexts } from "@/v4/composer/composerRecoveryContexts.js";
import {
  useComposerDraftWorktreeIntentSlot,
  type ComposerExecutionWorktree,
  type ComposerWorktreePreparationParams,
  type ComposerWorktreePreparationSync,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  armWorktreeSendContinuation,
  peekWorktreeSendContinuation,
  releaseWorktreeSendContinuation,
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
  type ArmedWorktreeSendContinuation,
} from "@/store/composerWorktreePipelineStore.js";
import { rehydrateComposerRecoveryAttachments } from "@/v4/composer/composerRecoveryAttachments.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import { moveComposerAttachmentScopeItems } from "@/store/composerAttachmentUploadStore.js";
import {
  applyDraftBranchIntentForSend,
  selectDraftBranchIntent,
  selectWorktreeIntentActive,
  applyPersistedWorktreeIntent,
  isSamePersistedWorktreeIntent,
  selectPersistableWorktreeIntent,
  useDraftBranchIntentStore,
} from "@/v4/composer/draftBranchIntent.js";
import {
  selectDraftIncognito,
  useDraftIncognitoIntentStore,
} from "@/v4/composer/draftIncognitoIntent.js";
import {
  shouldRenderComposerIncognitoControl,
  V4ComposerIncognitoControl,
} from "@/v4/composer/V4ComposerIncognitoControl.js";
import { V4ComposerDictationControl } from "@/v4/composer/V4ComposerDictationControl.js";
import { isComposerSubmissionOwnerCurrent } from "@/v4/composer/composerSubmissionOwner.js";
import { ComposerWorktreeRecovery } from "@/v4/composer/ComposerWorktreeRecovery.js";
import {
  isComposerModelBlockReason,
  resolveComposerSubmitBlockReason,
} from "@/v4/composer/composerSubmitBlockReason.js";
import { useBranchSwitchGuard } from "@/v4/composer/branchSwitchGuard.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import {
  consumeV4ComposerDraftAttachments,
  registerV4ComposerDraftReader,
  consumeV4ComposerDraftWorkspaceTransferRequest,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import { removeCodeCommentPreview } from "@/v4/composer/codeCommentPreviewSync.js";
import {
  countComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import {
  PluginUiModelContextChip,
  usePluginUiContextImages,
  usePluginUiModelContexts,
} from "@/plugin-ui/index.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
import { V4ComposerModeArea } from "@/v4/composer/V4ExternalAgentConfigControls.js";
import {
  resolveV4ComposerConfigPickerState,
  type V4ComposerConfigPicker,
} from "@/v4/composer/configPickerState.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { buildV4ConversationPromptTelemetryExtraDetail } from "@/v4/telemetry/conversationPromptTelemetry.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import {
  subscribeComposerSubmissionSettled,
  trackUnsettledComposerSubmission,
} from "@/v4/composer/composerSubmissionSettlement.js";
import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";
import { parseV4VisibleSlashCommand } from "@/v4/slashCommands.js";

const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

export interface ConversationComposerSendOptions {
  firstSubmissionId?: string;
  reservedSubmissionSessionId?: string;
  /** 原始正文供接纳恢复对账；协议正文可能已经附加文件或页面上下文。 */
  submittedDraftText?: string;
  /** 点击发送时复制的配置；null 表示未完成选择，Host 不得从 Session 补齐。 */
  submission?: ComposerSubmissionConfig | null;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  /** 发送确认框打开时看到的暂停队列 ID；CLI 用它拦截跨端增删竞态。 */
  expectedHeldQueueItemIds?: readonly string[];
  /** 附件命令面：已序列化附件（宿主转 AttachmentRef 后随 v4 sendText/createSession 发送）。 */
  attachments?: AttachmentRef[];
  /** Upload frozen draft attachments into the newly created worktree or incognito session. */
  reuploadAttachmentsForSession?: (sessionId: string) => Promise<AttachmentRef[]>;
  /** Prompt 文本内携带的上下文附件数量；用于阻止 /goal 等本地命令误消费。 */
  contextAttachmentCount?: number;
  /** 已 ready 的 worktree 执行位置；只能由 worktree 准备流水线给出。 */
  executionWorktree?: ComposerExecutionWorktree;
  /** worktree 准备流水线已为此消息预留的 session。 */
  preparedSessionId?: string;
  preparedAttemptId?: string;
  /** 只属于草稿首发的无痕配置，由 Session 冻结后不再受后续草稿影响。 */
  incognito?: IncognitoProfile;
  conversationQuotes?: import("@zcode/shared").ConversationSelectionText[];
  /** renderer-only：ACK accepted 后由 SessionPane 绑定真实 commandId/sessionId。 */
  telemetrySeed?: ConversationPromptTelemetrySeed;
  /** 本次 busy input 的一次性投递覆盖，不改 session 偏好。 */
  requestedDelivery?: "startNow" | "queue" | "guide";
  /** 提交命令创建后由 Composer 订阅权威 projection，覆盖 ACK 丢失后的收口。 */
  onCommandCreated?: (commandId: string) => void;
  /**
   * The command id an earlier attempt of this reserved first submission already created. It is sent as
   * expectedFirstInputCommandId, and only an input-admitted activation under it settles without resending
   * (ConversationComposerSendResult).
   */
  originalCommandId?: string;
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
  /** 插件 UI 代发：随 sendText 持久化，用户消息卡片显示"来自插件 X"。 */
  source?: import("@zcode/shared/zcode-protocol-v4").ConversationInputSource;
}

/**
 * "alreadyAdmitted": a prepared submission whose frozen input the Host had already admitted under its
 * original command id (preparedActivation input-admitted); the pane sent no new sendText. The composer
 * settles it as sending under that id. An already-active activation is not this result: it sends normally.
 */
export type ConversationComposerSendResult =
  | "sent"
  | "blocked"
  | "confirmationRequired"
  | "alreadyAdmitted";
function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export interface ExternalTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing" | "prepend-text";
}

export function restorePersistedComposerDraftIntoInput({
  draft,
  inputApi,
  onEditorStateError,
}: {
  draft: Pick<V4ComposerDraft, "editorStateJson" | "mention" | "text">;
  inputApi: Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "setEditorStateJson" | "setMention" | "setText"
  >;
  onEditorStateError?: (error: unknown) => void;
}): string {
  if (draft.editorStateJson) {
    try {
      inputApi.setEditorStateJson(draft.editorStateJson);
      return inputApi.getMarkdown();
    } catch (error) {
      onEditorStateError?.(error);
    }
  }
  if (draft.mention && draft.text.startsWith(draft.mention.markdown)) {
    // Workspace 插件详情会卸载聊天 Composer。结构化 mention 必须从共享草稿事实源恢复，
    // 不能只依赖一次性插入事件，否则重挂载时会退化成 canonical 普通文本。
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}

export function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: Pick<
    LexicalChatInputHandle,
    | "getMarkdown"
    | "prependMentionIfMissing"
    | "setMention"
    | "setText"
    | "setTextWithPluginMentions"
  > | null;
  request: ExternalTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  if (request.mode === "prepend-text") {
    // zcode://task/new fills a draft the user may already have typed into; keep their unsent text after the task text.
    const existing = inputApi.getMarkdown();
    const combined = existing.trim() === "" ? request.text : `${request.text}\n\n${existing}`;
    if (combined.includes("](plugin://")) {
      inputApi.setTextWithPluginMentions(combined);
    } else {
      inputApi.setText(combined);
    }
    updateText(combined);
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug 原因：安装完成后若回放点击时保存的旧 prompt，会覆盖用户安装期间的编辑。
    // 节点级前置保留编辑器当前的 mention 与段落结构，再从编辑器读取 canonical 草稿。
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // 根因：商店试用以前只传 canonical 文本，Lexical 无法知道开头链接是结构化 Plugin mention。
    // request 同时携带 display-only 节点数据；发送与草稿事实源仍使用 request.text 原文。
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // 推荐任务可在正文中组合多个插件；按原位置构造成真实提及节点。
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

export interface ComposerRestoreRequest {
  requestId: number;
  sessionId: string;
  workspaceKey: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;
}

export function applyComposerRestoreRequestToComposer({
  appliedRequestId,
  currentSessionId,
  currentWorkspaceKey,
  hasDraftContent,
  inputApi,
  request,
  requestFocus,
  restoreSessionOwnedAttachments,
  restoreDraftConfig,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  currentSessionId: string | null;
  currentWorkspaceKey: string;
  hasDraftContent: boolean;
  inputApi: Pick<LexicalChatInputHandle, "setText"> | null;
  request: ComposerRestoreRequest | null | undefined;
  requestFocus: () => void;
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  restoreDraftConfig?: (config: NonNullable<ComposerRestoreRequest["config"]>) => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (
    request.sessionId !== currentSessionId ||
    request.workspaceKey !== currentWorkspaceKey ||
    hasDraftContent ||
    !inputApi
  ) {
    return appliedRequestId;
  }
  if (!restoreSessionOwnedAttachments(request.attachments)) {
    return appliedRequestId;
  }
  inputApi.setText(request.text);
  updateText(request.text);
  if (request.config) restoreDraftConfig?.(request.config);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

function arePromptHistoryEntriesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export interface ConversationComposerProps {
  snapshot: ConversationSnapshot | null;
  /** 草稿 scope（sessionId；draft 态 null → "__draft__" scope）。 */
  sessionId?: string | null;
  /** Skill catalog authority；草稿预热完成后为 prewarmSessionId，不改变 task/draft 身份。 */
  skillCatalogSessionId?: string | null;
  /** draft 态无 snapshot，但仍可 createSession 首发。 */
  draftMode?: boolean;
  /** renderer 当前草稿配置意图；只在 draftMode 下覆盖迟到的 prewarm projection。 */
  draftConfig?: Partial<SessionConfigState>;
  /** SessionPane 注入的完整 Draft owner；生产路径不再由编辑器直接覆盖持久记录。 */
  composerDraft: V4ComposerDraft;
  rootDraftScopeKey?: string;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention" | "firstSubmission">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 当前 Composer 是否能构造完整 Submission；空模型或空 Reasoning 时为 false。 */
  submissionReady?: boolean;
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null;
  /** 仅供发送埋点冻结模型维度；包含草稿初始化 config 与显式 intent 的合并值。 */
  telemetryDraftConfig?: Partial<SessionConfigState>;
  /**
   * 空态 contextHeader（m5-composer-parity）：workspace 切换菜单 + Git 分支
   * 切换器，渲染在编辑器上方（旧 ChatViewComposer contextHeaderContent 同位）。
   * 仅草稿态由宿主下发；会话建立后为空。
   */
  contextHeader?: ReactNode;
  /** 居中草稿布局（旧 shouldUseCenteredDraftChatLayout）：收窄 max-w-2xl、去 sticky。 */
  centered?: boolean;
  /**
   * v4 bottom dock 阻塞交互 id。存在时 composer 只隐藏不卸载，保留草稿、附件与编辑器实例。
   */
  blockingRequestId?: string | null;
  disabled?: boolean;
  onRetryInitialization?: () => void;
  /** 当前 Task 可用的 Highspeed 卡；只影响静态标识和模型锁定。 */
  highspeedCard?: HighspeedCardSnapshot | null;
  /**
   * 发送路径 draw 新命中登记的一次性激活请求（值为 cardId）。
   * 命中当前卡时才播放激活动效，composer 锁定入场方式后经回调消费；切回、恢复与重挂载不重播。
   */
  highspeedActivationCardId?: string | null;
  onHighspeedActivationApplied?: (cardId: string) => void;
  /**
   * 是否在新建任务 / 切换会话 / 挂载后自动把光标聚焦到输入框（默认开）。
   * 竖切多 pane 时由宿主传入 SessionPane.focused，仅焦点 pane 聚焦、后台 pane 不抢焦点。
   */
  autoFocusEnabled?: boolean;
  /** 当前 composer 是否运行在手机 Web 远控壳中。 */
  isWebRemoteControl?: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** SessionPane 从目标 Host 原子读取的选择事实；Composer 不自行解析 Host。 */
  modelSelectionView?: ModelSelectionView | null;
  /** Provider startup has settled; until then a stored-model verdict keeps the generic reason (ISSUE-026). */
  modelSelectionSettled?: boolean;
  modelSelectionState?: ModelSelectionState;
  /** Model Selection 首次读取失败后的显式重试入口。 */
  modelSelectionReload?: () => void;
  modelSelectionRefresh?: () => Promise<ModelSelectionRefreshResult>;
  /** 草稿态使用预热 session 作附件 transaction 载体。 */
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。 */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  provider?: ZCodeProvider;
  /** 宿主 pane 与 workspace 遮罩共同裁决的真实可见性，仅用于 visible-only telemetry。 */
  telemetryVisible?: boolean;
  /** 点击发送时读取套餐身份；二次确认会继续复用同一份冻结 seed。 */
  readPlanIdentitySnapshot?: () => PlanIdentitySnapshot;
  onSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult | void>;
  onPrepareFirstSubmission?: (params: {
    submissionId: string;
    incognito?: IncognitoProfile;
    reservation?: { sessionId: string; commandId: string };
    onReservationCreated?: (reservation: { sessionId: string; commandId: string }) => void;
  }) => Promise<string | undefined>;
  onFirstSubmissionReserved?: (sessionId: string) => void;
  /** Reserve/open the Host-owned session before the worktree Git operation begins. */
  onPrepareWorktreeSession?: (
    params: ComposerWorktreePreparationParams,
    options?: { shouldActivate: () => boolean },
  ) => Promise<string>;
  /**
   * Realign the Host preparation marker when Git settles the worktree at a directory other than the
   * frozen target, so the strict activation check accepts the path the composer sends.
   */
  onSyncWorktreePreparation?: ComposerWorktreePreparationSync;
  onWorktreePreparationFailed?: (
    sessionId: string,
    failureMessage: string,
    attemptId?: string,
  ) => Promise<void>;
  /** 把当前输入文本上抛给父组件（editUserQuery 用 composer 文本作 newText）。 */
  onTextChange?: (text: string) => void;
  /** queue 撤回 admission 读取的完整 composer 占用态；附件包含上传中状态。 */
  onDraftStateChange?: (state: { hasContent: boolean; busy: boolean }) => void;
  onStop: () => void;
  /** 目录选中模型（providerId/modelId）；thought/revision 由宿主从最新投影补齐。 */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void;
  /** 选中思考深度；同时带上用户操作时看到的模型，避免异步回流后把 thought 归到另一模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** S6: sends the user's choice for one select of the session's ACP agent (setExternalAgentConfigOption). */
  onSetExternalAgentConfigOption?: (configId: string, value: string) => void;
  /** 打开当前 session 的 Status panel，并直达 Running 明细。 */
  onOpenRunningBackgroundWorks?: () => void;
  /**
   * 后台任务入口点击的落点：`"workflow-run"` = 唯一在跑的工作流直达详情页（宿主判定），
   * 缺省 `"panel"` = 展开状态胶囊。入口据此换 tooltip；行为本身在 onOpenRunningBackgroundWorks 里。
   */
  backgroundWorkOpenTarget?: "panel" | "workflow-run";
  runningSubagentCount?: number;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  /** context usage 面板的 /compact 入口（宿主走 v4 compact 命令）。 */
  onSendCompressionCommand?: (command: string) => void;
  /** v4 会话级错误（snapshot.control.lastError），展示在输入框上方。 */
  error?: ZCodeUiError | null;
  onDismissError?: () => void;
  /** Resume action for the error banner. SessionPane sends the fixed continuation prompt as a new user message. */
  onResumeError?: () => void;
  /** 无可用模型横幅的恢复动作；由 SessionPane 注入壳层导航，组件不直接操作 tab。 */
  onOpenModelSettings?: () => void;
  onOpenModelUpgrade?: () => void;
  modelConfigTarget?: ChatErrorBannerModelConfigTarget;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * 是否监听全局「加入对话」事件（workspace file tree / 画板按钮）。
   * 分屏时仅 primary pane 监听，避免一次点击插入两份。
   */
  listenAddToChatEvents?: boolean;
  /**
   * 外部一次性文本预填请求（Example Prompt 等）。
   * requestId 保证同一文本可连续取回两次时仍能触发回填。
   */
  externalTextInsertRequest?: ExternalTextInsertRequest | null;
  onExternalTextInsertApplied?: (requestId: number) => void;
  /**
   * 队列“编辑”在 delete ACK 后把完整未来意图取回输入框。
   * requestId + session/workspace binding 保证幂等且不会串写其他 task。
   */
  composerRestoreRequest?: ComposerRestoreRequest | null;
  onComposerRestoreApplied?: (requestId: number) => void;
  /** 副屏会话不提供 goal 能力；协议层仍会拒绝直接调用。 */
  suppressGoalCommands?: boolean;
  /** App 层本地斜杠命令（如 `/side`），由 SessionPane 按门禁组装后透传。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** 把 composer 的 drop 路由暴露给整个对话 pane / 桌面草稿标题栏。 */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
  /** Voice input entry: desktop transcribes in the Desktop Host; web remote control transcribes in the browser (Web Speech API, hidden when unsupported). */
  voiceDictationEnabled?: boolean;
  /** Host supports durable first-submission reservation (specs/first-submission-lifecycle.md). */
  durableFirstSubmission?: boolean;
  /** A first submission is frozen or recovering for this composer; start-only controls (the incognito icon) hide. */
  firstSubmissionActive?: boolean;
  draftGeneration?: number;
}

function formatAttachmentLineCount(attachment: ChatComposerAttachment, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}

function ConversationComposerImpl({
  snapshot,
  sessionId = null,
  skillCatalogSessionId = sessionId,
  draftMode = false,
  draftConfig,
  composerDraft,
  rootDraftScopeKey,
  updateComposerContent,
  replaceComposerDraft,
  submissionReady = true,
  createSubmissionFromComposer,
  telemetryDraftConfig,
  contextHeader,
  centered = false,
  blockingRequestId = null,
  disabled: disabledProp = false,
  onRetryInitialization,
  highspeedCard = null,
  highspeedActivationCardId = null,
  onHighspeedActivationApplied,
  autoFocusEnabled = true,
  isWebRemoteControl = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  modelSelectionView = null,
  modelSelectionSettled = false,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  modelSelectionRefresh,
  attachmentSessionId = null,
  attachmentPut,
  onRuntimeRestart,
  onRuntimeLifecycle,
  provider,
  telemetryVisible = true,
  readPlanIdentitySnapshot,
  onSendText,
  onTextChange,
  onDraftStateChange,
  onStop,
  onSelectModel,
  onSelectThought,
  onSwitchMode,
  onSetExternalAgentConfigOption,
  onOpenRunningBackgroundWorks,
  backgroundWorkOpenTarget = "panel",
  runningSubagentCount = 0,
  onRecoverCustomModelSelection,
  onSendCompressionCommand,
  error,
  onDismissError,
  onOpenModelSettings,
  onOpenModelUpgrade,
  modelConfigTarget = "local",
  onOpenCodeViewer,
  listenAddToChatEvents = true,
  externalTextInsertRequest = null,
  onExternalTextInsertApplied,
  composerRestoreRequest = null,
  onComposerRestoreApplied,
  suppressGoalCommands = false,
  appSlashCommands,
  onDropTargetControllerChange,
  onPrepareWorktreeSession,
  onPrepareFirstSubmission,
  onFirstSubmissionReserved,
  onSyncWorktreePreparation,
  onWorktreePreparationFailed,
  onResumeError,
  voiceDictationEnabled = false,
  durableFirstSubmission = false,
  firstSubmissionActive = false,
  draftGeneration = 0,
}: ConversationComposerProps) {
  const remoteAvailable = useRemoteConversationAvailable();
  const remoteController = useOptionalRemoteWorkspaceController();
  const reconnectProject = useRemoteProjectReconnect();
  const remoteKind = useOptionalTabStore((state) =>
    state.tabs.find(
      (tab) =>
        tab.kind === "workspace" &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
          (workspaceIdentity?.trim() || workspacePath),
    ),
  );
  const [targetSelectionPending, setTargetSelectionPending] = useState(false);
  const targetSelectionPendingRef = useRef(false);
  const updateTargetSelectionPending = useCallback((pending: boolean) => {
    targetSelectionPendingRef.current = pending;
    setTargetSelectionPending(pending);
  }, []);
  const disabled = disabledProp || !remoteAvailable || targetSelectionPending;
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const draftScopeId =
    sessionId ??
    (rootDraftScopeKey ? `${V4_DRAFT_SCOPE_ROOT}:${rootDraftScopeKey}` : V4_DRAFT_SCOPE_ROOT);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const retryFirstSubmissionRef = useRef<V4ComposerDraft["firstSubmission"]>(undefined);
  const renderedOwnerRef = useRef({
    workspaceKey,
    scopeId: draftScopeId,
    draftGeneration,
    epoch: 0,
  });
  useLayoutEffect(() => {
    const currentOwner = renderedOwnerRef.current;
    if (
      currentOwner.workspaceKey === workspaceKey &&
      currentOwner.scopeId === draftScopeId &&
      currentOwner.draftGeneration === draftGeneration
    )
      return;
    retryFirstSubmissionRef.current = undefined;
    renderedOwnerRef.current = {
      workspaceKey,
      scopeId: draftScopeId,
      draftGeneration,
      epoch: currentOwner.epoch + 1,
    };
  }, [workspaceKey, draftScopeId, draftGeneration]);
  const reservingWorktreeRef = useRef<{ epoch: number; id: string } | null>(null);
  const queuedSubmissionIdRef = useRef<string | null>(null);
  const composerAliveRef = useRef(true);
  useEffect(() => {
    composerAliveRef.current = true;
    return () => {
      composerAliveRef.current = false;
    };
  }, []);
  // Empty-state "New worktree" first-send interception slot (stable object; value changes do not re-render).
  const worktreeIntentSlot = useComposerDraftWorktreeIntentSlot();
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  // Worktree setup queue (specs/composer-worktree-setup-steps.md): unlike `pending`, the queued
  // state never reports busy to the empty state and never blocks editing; it only shows the
  // spinner on the send button and rejects duplicate sends while creation is in flight.
  const [worktreeQueued, setWorktreeQueued] = useState(false);
  useEffect(() => {
    if (
      reservingWorktreeRef.current &&
      reservingWorktreeRef.current.epoch !== renderedOwnerRef.current.epoch
    ) {
      queuedSubmissionIdRef.current = null;
      setWorktreeQueued(false);
    }
  }, [workspaceKey, draftScopeId]);
  // Local cache of the armed worktree-send continuation; the authoritative copy lives in the
  // module-scope registry (composerWorktreePipelineStore) so it survives the first-send view
  // promotion remounting the composer as another instance (BUG-GWT-005 live path).
  const pendingWorktreeSendRef = useRef<ArmedWorktreeSendContinuation | null>(null);
  const reportedWorktreeFailuresRef = useRef(new Set<string>());
  const worktreePipeline = useComposerWorktreePipelineStore((state) =>
    selectComposerWorktreePipeline(state, workspaceKey, sessionId),
  );
  const worktreeIntentActive = useDraftBranchIntentStore((state) =>
    selectWorktreeIntentActive(state, workspaceKey),
  );
  const incognitoDraftActive = useDraftIncognitoIntentStore(
    (state) =>
      draftMode && sessionId === null && selectDraftIncognito(state, workspaceKey) !== null,
  );
  // Draft branch intent (specs/composer-branch-switcher-semantics.md): the guard and git access
  // needed to apply the intent at send time. Null services/guard = harness or compact shell
  // without providers; the branch resolution then never runs.
  const workspaceServiceResolution = useOptionalWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const baseWorkspaceServices = workspaceServiceResolution?.services ?? null;
  const branchSwitchGuard = useBranchSwitchGuard();
  const [presentedHighspeedCardId, setPresentedHighspeedCardId] = useState<string | null>(null);
  const [highspeedSweepActive, setHighspeedSweepActive] = useState(false);
  const highspeedCardId = highspeedCard?.cardId ?? null;
  const highspeedEntrance = useHighspeedComposerEntrance({
    cardId: highspeedCardId,
    activationCardId: highspeedActivationCardId,
    onActivationApplied: onHighspeedActivationApplied,
  });
  const highspeedEntranceAnimated = highspeedEntrance === "activation";
  // 恢复入场（切回 Task、快照恢复、重挂载）不经扩散交接，卡片出现即呈现模型与倒计时。
  const highspeedPresented =
    highspeedCardId !== null &&
    (!highspeedEntranceAnimated || presentedHighspeedCardId === highspeedCardId);
  const handleHighspeedModelTransitionStart = useCallback(() => {
    // 只记录已完成视觉交接的卡片身份，不改变卡片有效性或发送状态。
    setPresentedHighspeedCardId(highspeedCardId);
  }, [highspeedCardId]);
  useEffect(() => {
    // 扫光属于激活动效，只在 draw 新命中的交接后播放一次。
    if (!highspeedPresented || !highspeedEntranceAnimated) {
      setHighspeedSweepActive(false);
      return;
    }
    const timer = window.setTimeout(() => setHighspeedSweepActive(true), 1_900);
    return () => window.clearTimeout(timer);
  }, [highspeedEntranceAnimated, highspeedPresented]);
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({
    scopeKey: configPickerScopeKey,
    activePicker: null,
  }));
  // 固定 key 的 SessionPane 会跨 task/draft 复用 composer，旧 picker owner
  // 因此跟着实例进入新 scope。提交新 scope portal 前同步归零，避免菜单闪现一帧；
  // 旧 Radix layer 随后到达的 close 事件由下方 scope guard 丢弃。
  if (configPickerState.scopeKey !== configPickerScopeKey) {
    setConfigPickerState({
      scopeKey: configPickerScopeKey,
      activePicker: null,
    });
  }
  const activeConfigPicker =
    configPickerState.scopeKey === configPickerScopeKey ? configPickerState.activePicker : null;
  const handleConfigPickerOpenChange = useCallback(
    (picker: V4ComposerConfigPicker, open: boolean) => {
      // composer 内容为导航 rail 恢复 pointer-events 后，三个 Radix modal
      // picker 的独立 open 状态会在同一次 pointerdown 中竞争，旧 layer 无法可靠 dismiss。
      // 关闭回调可能晚于兄弟 picker 的打开回调，只允许它清理自己，避免误关接管者。
      setConfigPickerState((current) => {
        if (current.scopeKey !== configPickerScopeKey) {
          return current;
        }
        return {
          scopeKey: current.scopeKey,
          activePicker: resolveV4ComposerConfigPickerState(current.activePicker, picker, open),
        };
      });
    },
    [configPickerScopeKey],
  );
  const [heldQueueConfirmation, setHeldQueueConfirmation] = useState<{
    queueItemIds: readonly string[];
    telemetrySeed: ConversationPromptTelemetrySeed;
    requestedDelivery?: "startNow" | "queue" | "guide";
  } | null>(null);
  const [sendTooltipOpen, setSendTooltipOpen] = useState(false);
  // submit 经 ref 读取最新文本/pending，避免回调随每次输入变更引用。
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  // Repeat-submit owner token (specs/first-submission-instant-ux.md, flag lifetimes): the id of
  // the submission holding it. Only that owner releases it, so an earlier chain's `finally`
  // cannot clear a later send's guard; a first submission releases it at the P2 bind.
  const pendingRef = useRef<string | null>(null);
  const [pendingOwner, setPendingOwner] = useState<string | null>(null);
  // Repeat-click guard: the claim records the content revision it left behind. A submit at that
  // same revision is the same submission (a double click); any editor change makes a new draft.
  const claimedSubmissionRef = useRef<{ submissionId: string; revision: number } | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // 这条线断过一次：composer 原本读一个平行的 sharedContextImport prop，而 SessionPane 从没
  // 传过它（全仓 `sharedContextImport=` 零命中），于是首条消息永远不带 sharedContextRefs。
  // 现在从必然拿到的 snapshot 推导，理由与边界见 resolveAttachableShareContext。
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  // Restore re-attaches a recovered submission's shared context: the failed or queued worktree
  // submission never reached the CLI, so its reference is still unconsumed, but the session snapshot
  // may no longer offer it. A restored reference wins for the draft scope it was restored into.
  const [restoredShareContext, setRestoredShareContext] = useState<{
    scopeId: string;
    contextId: string;
  } | null>(null);
  const activeShareContextId =
    (restoredShareContext?.scopeId === draftScopeId ? restoredShareContext.contextId : null) ??
    pendingShareContext?.contextId ??
    null;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const voiceScopeRef = useRef<HTMLDivElement | null>(null);
  // Streaming ghost preview (specs/voice-dictation.md, "Ghost preview"): display state only; it is
  // drawn by the editor and never enters the draft text, submission, or undo history.
  const [voicePreview, setVoicePreview] = useState<VoiceTranscriptionPreview | null>(null);
  const insertVoiceTranscript = useCallback((text: string) => {
    const api = inputApiRef.current;
    if (!api) return;
    // Must go through the editor transaction API: getText/setText rebuild the editor as plain text nodes, flattening existing structured mentions.
    api.insertTextAtSelection(text);
    api.focus();
  }, []);
  const commandResolutionCleanupsRef = useRef(new Set<() => void>());
  const reportedErrorKeysRef = useRef(new Set<string>());
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  // Bugfix：M3 删除旧 ChatView 后，M5 只恢复了桌面端的 false 硬编码，已登记的手机远控
  // 接线没有补回，导致 Enter 误发送。恢复旧语义：手机视口下 Enter 换行并用按钮发送；
  // 桌面端仍由 resolveChatEnterSubmits 的视口门禁保持 Enter 发送。
  const enterSubmits = resolveChatEnterSubmits({
    isMobileTextInputViewport,
    preferEnterNewline: isWebRemoteControl,
  });
  // 修复原因：旧 ChatView 删除后，iOS 防聚焦放大的接线没有迁到 v4 composer，
  // 手机 Web 远控输入框会重新触发 Safari 的页面缩放。
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // Bugfix：手机远控把完整能力说明放进绝对定位 placeholder 后，三行英文会越过
  // 40px 编辑区并覆盖工具栏。手机端改用短文案并限制两行；桌面端继续保留完整提示。
  const compactMobilePlaceholder = isWebRemoteControl && isMobileTextInputViewport;
  const sendShortcut = resolveChatEnterShortcut({ enterSubmits });
  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      contentRevisionRef.current += 1;
      advanceComposerDraftRevision(workspacePath, workspaceIdentity);
      setText(next);
      onTextChange?.(next);
    },
    [onTextChange, workspaceIdentity, workspacePath],
  );

  const initialization = snapshot?.runtimeInitialization;
  const runtimeBlocked = initialization !== undefined && initialization.status !== "ready";

  // ── 附件全链路（选择/粘贴/拖拽/画板/预传/门禁）──
  const attachmentsApi = useComposerAttachments({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled: disabled || runtimeBlocked,
    listenAddToChatEvents: listenAddToChatEvents && !disabled && !runtimeBlocked,
  });
  // 对齐旧版 useChatComposer：窗口级 dragover 会在指针进入 ChatView 前预先点亮
  // 整个聊天区与桌面草稿标题栏；workspace payload 的文案优先于系统附件。
  const { externalFileDragging, workspaceFileDragging } = usePromptEditorDragState({
    enableExternalFileDrop: true,
    enableWorkspaceFileDrop: true,
  });
  const handleConversationDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragOverComposer(event);
    },
    [attachmentsApi.handleDragOverComposer],
  );
  const handleConversationDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragLeaveComposer(event);
    },
    [attachmentsApi.handleDragLeaveComposer],
  );
  const handleConversationDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const workspaceFilePayload = readWorkspaceFileDragPayload(event.dataTransfer);
      if (workspaceFilePayload) {
        // 文件树 payload 与 OS File[] 语义不同：只插入 mention，绝不能进入上传队列。
        event.preventDefault();
        attachmentsApi.handleDropComposer(event);
        appendWorkspaceFileMentionToComposer({
          inputApiRef,
          currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: updateText,
        });
        return;
      }
      attachmentsApi.handleDropComposer(event);
    },
    [attachmentsApi.handleDropComposer, updateText, workspaceIdentity, workspacePath],
  );
  const conversationDragKind = workspaceFileDragging
    ? "workspace"
    : externalFileDragging
      ? "attachment"
      : (attachmentsApi.composerDragKind ??
        (attachmentsApi.isDraggingOverComposer ? "attachment" : null));
  const dropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: conversationDragKind !== null,
      kind: conversationDragKind,
      onDragOver: handleConversationDragOver,
      onDragLeave: handleConversationDragLeave,
      onDrop: handleConversationDrop,
    }),
    [
      conversationDragKind,
      handleConversationDragLeave,
      handleConversationDragOver,
      handleConversationDrop,
    ],
  );
  useEffect(() => {
    onDropTargetControllerChange?.(dropTargetController);
    return () => onDropTargetControllerChange?.(null);
  }, [dropTargetController, onDropTargetControllerChange]);
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const hasAttachments = attachmentsApi.hasAttachments;
  const {
    contexts: webElementContexts,
    hasContexts: hasWebElementContexts,
    removeContext: removeWebElementContext,
    clearContexts: clearWebElementContexts,
  } = useWebElementContexts({
    workspacePath,
    workspaceIdentity,
    // queue 撤回等待 ACK 时 composer 处于 disabled；此时也要阻止全局 add-to-chat
    // 写入网页上下文，避免权威删除成功后撞上 ACK 窗口内的新草稿。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  // 插件 UI 经 ui/update-model-context 附加的上下文；按 sessionId 接收，随发送清空。
  const {
    contexts: pluginUiContexts,
    hasContexts: hasPluginUiContexts,
    removeContext: removePluginUiContext,
    clearContexts: clearPluginUiContexts,
  } = usePluginUiModelContexts({ sessionId, workspacePath, workspaceIdentity });
  // 上下文里的 image 块 → 本 composer 的图片附件，随下一回合发送。
  usePluginUiContextImages(pluginUiContexts, attachmentsApi);
  const {
    references: pptxElementReferences,
    hasReferences: hasPptxElementReferences,
    removeReference: removePptxElementReference,
    clearReferences: clearPptxElementReferences,
  } = usePptxElementReferences({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  });
  const {
    references: conversationSelectionReferences,
    limitReason: conversationSelectionLimitReason,
    removeReference: removeConversationSelectionReference,
    clearReferences: clearConversationSelectionReferences,
  } = useConversationSelectionReferences({
    sessionId,
    workspaceKey,
    draftScopeKey: rootDraftScopeKey,
  });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  // ── 草稿 per-session 持久化（切会话/刷新不丢；mention pill 经 editorStateJson 保真）──
  const draftScopeRef = useRef(draftScopeId);
  const draftTargetRef = useRef({
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const ownerDraftRef = useRef({
    draft: composerDraft,
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const draftPersistTimerRef = useRef<number | null>(null);
  const suppressDraftPersistRef = useRef(false);
  const draftPersistClaimRef = useRef<string | null>(null);
  const updateComposerContentRef = useRef(updateComposerContent);
  updateComposerContentRef.current = updateComposerContent;

  const snapshotDraftOfEditor = useCallback((): {
    text: string;
    editorStateJson?: string;
  } => {
    const currentText = textRef.current;
    let editorStateJson: string | undefined;
    try {
      const editorState = inputApiRef.current?.getEditorState();
      editorStateJson = editorState ? JSON.stringify(editorState.toJSON()) : undefined;
    } catch (error) {
      logger.warn(`[v4-composer] 草稿 editorState 序列化失败: ${String(error)}`);
    }
    return currentText.trim()
      ? { text: currentText, ...(editorStateJson ? { editorStateJson } : {}) }
      : { text: "" };
  }, []);

  useEffect(() => {
    // 新建 scope 已包含项目身份；不能只匹配旧的裸 __draft__ 而漏掉当前编辑器。
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    return registerV4ComposerDraftReader(workspaceKey, () => ({
      draft: { ...ownerDraftRef.current.draft, ...snapshotDraftOfEditor() },
      attachments: attachmentsApi.attachments,
    }));
  }, [draftScopeId, workspaceKey, snapshotDraftOfEditor, attachmentsApi.attachments]);

  const persistDraftNow = useCallback(
    (scopeId: string) => {
      if (suppressDraftPersistRef.current) return;
      const content = snapshotDraftOfEditor();
      if (scopeId === draftScopeRef.current) {
        updateComposerContent(content);
        return;
      }
    },
    [snapshotDraftOfEditor, updateComposerContent, workspaceIdentity, workspacePath],
  );

  const scheduleDraftPersist = useCallback(() => {
    if (typeof window === "undefined") return;
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      persistDraftNow(draftScopeRef.current);
    }, 350);
  }, [persistDraftNow]);

  // ── 自动聚焦（新建任务 / 切会话 / 挂载后把光标交还输入框）──
  // 触发源：startDraft 递增的 draftFocusVersion（覆盖 Cmd/Ctrl+N 与所有「新建任务」入口）、
  // sessionId→draftScopeId 变化（切会话/切草稿）、以及挂载。三者置位聚焦意图；因切到需
  // 连接的会话时 composer 短暂 disabled，聚焦意图暂存，待可编辑时兑现一次。
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  useEffect(() => {
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    const attachments = consumeV4ComposerDraftAttachments(workspaceKey, draftFocusVersion);
    if (attachments) attachmentsApi.restoreDraftAttachments(attachments);
  }, [draftFocusVersion, draftScopeId, workspaceKey, attachmentsApi.restoreDraftAttachments]);
  const pendingFocusRef = useRef(false);
  // 本次 focus 是否由程序触发（见 flushPendingFocus），供 send_input_focus 过滤非用户动作。
  const programmaticFocusRef = useRef(false);
  // 发送键与 Enter 共用同一个 form submit；按钮 onClick 早于 submit 触发，
  // 借此区分 send_click 的 send_trigger，读取后立刻复位回默认的 shortcut。
  const sendTriggerRef = useRef<"button" | "shortcut">("shortcut");
  // 修饰键点击先于 form submit；这里只保存这一拍的 delivery 反转意图，submit 消费后清零。
  const reversePointerDeliveryRef = useRef(false);
  const appliedComposerRestoreRequestRef = useRef<number | null>(null);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // 决策入参经 ref 读取，避免把 autoFocusEnabled/disabled/viewport 灌进 scope effect 依赖，
  // 触发多余的草稿重恢复（disabled 变化本不应重放草稿）。
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  });
  focusOptsRef.current = {
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  };
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;
    // 程序性聚焦与用户点击输入框会触发同一个 DOM focus 事件；置位后由 handleEditorFocus
    // 消费，避免把「切会话 / 挂载回焦 / 上下文块移除后回焦」误报成 send_input_focus。
    programmaticFocusRef.current = true;
    // Lexical root 可能晚一帧就绪，聚焦排到下一帧（与草稿回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => inputApiRef.current?.focus());
    } else {
      inputApiRef.current.focus();
    }
  }, []);
  const requestComposerFocus = useCallback(() => {
    if (resolveComposerAutoFocus(focusOptsRef.current) === "skip") return;
    pendingFocusRef.current = true;
    flushPendingFocus();
  }, [flushPendingFocus]);

  const handleCodeCommentRemoved = useCallback(
    (comment: Parameters<typeof removeCodeCommentPreview>[0]) => {
      removeCodeCommentPreview(comment, services?.broadcastService);
    },
    [services?.broadcastService],
  );
  const {
    contexts: codeCommentContexts,
    hasContexts: hasCodeCommentContexts,
    removeContext: removeCodeCommentContext,
    clearContexts: clearCodeCommentContexts,
    getContexts: getCodeCommentContexts,
  } = useCodeCommentContexts({
    // queue 撤回等待 ACK 时 composer 处于 disabled；与网页上下文保持同一写入门禁。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    onContextRemoved: handleCodeCommentRemoved,
    requestFocus: requestComposerFocus,
    scopeKey: `${workspaceKey}\0${draftScopeId}`,
  });

  useEffect(() => {
    if (!composerRestoreRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyComposerRestoreRequestToComposer({
        appliedRequestId: appliedComposerRestoreRequestRef.current,
        currentSessionId: sessionId,
        currentWorkspaceKey: workspaceKey,
        hasDraftContent:
          textRef.current.length > 0 ||
          attachmentsApi.attachments.length > 0 ||
          codeCommentContexts.length > 0 ||
          webElementContexts.length > 0 ||
          pptxElementReferences.length > 0 ||
          conversationSelectionReferences.length > 0 ||
          pluginUiContexts.length > 0,
        inputApi: inputApiRef.current,
        request: composerRestoreRequest,
        requestFocus: requestComposerFocus,
        restoreSessionOwnedAttachments: attachmentsApi.restoreSessionOwnedAttachments,
        // 撤回项携带独立 Submission 配置；沿用草稿 owner，一次恢复且保留已处理授权标记。
        restoreDraftConfig: (config) =>
          replaceComposerDraft({
            ...ownerDraftRef.current.draft,
            ...config,
            text: composerRestoreRequest.text,
            editorStateJson: undefined,
            mention: undefined,
          }),
        scheduleDraftPersist,
        updateText,
      });
      const appliedNow =
        nextAppliedRequestId === composerRestoreRequest.requestId &&
        appliedComposerRestoreRequestRef.current !== composerRestoreRequest.requestId;
      appliedComposerRestoreRequestRef.current = nextAppliedRequestId;
      if (appliedNow) onComposerRestoreApplied?.(composerRestoreRequest.requestId);
      return nextAppliedRequestId === composerRestoreRequest.requestId;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    attachmentsApi.attachments.length,
    attachmentsApi.restoreSessionOwnedAttachments,
    codeCommentContexts.length,
    composerRestoreRequest,
    conversationSelectionReferences.length,
    onComposerRestoreApplied,
    replaceComposerDraft,
    requestComposerFocus,
    scheduleDraftPersist,
    sessionId,
    updateText,
    webElementContexts.length,
    pptxElementReferences.length,
    pluginUiContexts.length,
    workspaceKey,
  ]);

  // scope 切换：先落旧 scope 草稿，再恢复新 scope（editorStateJson 优先，退纯文本）。
  useEffect(() => {
    const previousTarget = draftTargetRef.current;
    const targetChanged =
      previousTarget.scopeId !== draftScopeId ||
      previousTarget.workspacePath !== workspacePath ||
      previousTarget.workspaceIdentity !== workspaceIdentity;
    let transferredDraft: ReturnType<typeof snapshotDraftOfEditor> | null = null;
    if (targetChanged && !suppressDraftPersistRef.current) {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      const previousDraft = snapshotDraftOfEditor();
      const shouldTransferDraft =
        previousTarget.scopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // 项目解绑只改变草稿的 cwd；输入正文、mention editor state 和组件内附件继续保留。
        replaceComposerDraft({ ...ownerDraftRef.current.draft, ...previousDraft });
        transferredDraft = previousDraft;
      }
    }
    draftScopeRef.current = draftScopeId;
    draftTargetRef.current = {
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };

    const draft = transferredDraft ?? composerDraft;
    const restoreDraftInto = (api: LexicalChatInputHandle) => {
      if (!draft) {
        if (textRef.current) {
          api.clear();
          updateText("");
        }
        return;
      }
      updateText(
        restorePersistedComposerDraftIntoInput({
          draft,
          inputApi: api,
          onEditorStateError: (error) => {
            logger.warn(`[v4-composer] 草稿 editorState 恢复失败，退纯文本: ${String(error)}`);
          },
        }),
      );
    };
    let unsubscribeSettled: (() => void) | null = null;
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (!api) return;
      restoreDraftInto(api);
      // Bug 根因（R3A-B-07）：ACK 丢失时传输先 reject，提交正文被恢复回草稿；随即断连让
      // SessionPane 连同本组件卸载，闭包里的结算订阅一起消失。重连重挂后正文从草稿回填，
      // 权威 projection 到达却无人清空，用户再点发送就重复归属。这里在回填后向模块级账本
      // 认领该 scope 尚未结算的提交：结算已到则同步清空，否则等它到达。
      const restoredText = draft?.text ?? "";
      const restoredRevision = contentRevisionRef.current;
      unsubscribeSettled = subscribeComposerSubmissionSettled(
        `${workspaceKey}\0${draftScopeId}`,
        (submission) => {
          // 只清"确实是那次提交、且用户还没在其上继续编辑"的正文；编辑器把回填正文
          // 重新序列化后若与提交原文一致，也视为未编辑。
          if (submission.text !== restoredText) return;
          if (
            contentRevisionRef.current !== restoredRevision &&
            textRef.current !== submission.text
          ) {
            return;
          }
          inputApiRef.current?.clear();
          updateText("");
          updateComposerContent({ text: "" });
        },
      );
      // 草稿恢复后把光标交还输入框（切会话/切草稿/挂载）；连接中会话待可编辑后兑现。
      requestComposerFocus();
    };
    // Lexical root 可能晚一帧就绪；draft 恢复排到下一帧（与旧 initialValue 回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => {
        cancelAnimationFrame(frame);
        unsubscribeSettled?.();
      };
    }
    applyDraft();
    return () => unsubscribeSettled?.();
    // 依赖收敛到 scope/workspace：draft 恢复只应发生在 scope 切换或 workspace 切换。
  }, [
    draftScopeId,
    persistDraftNow,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateText,
    updateComposerContent,
    workspaceIdentity,
    workspacePath,
    replaceComposerDraft,
  ]);

  useEffect(() => {
    ownerDraftRef.current = {
      draft: composerDraft,
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };
  }, [composerDraft, draftScopeId, workspaceIdentity, workspacePath]);

  // 外部预填和 scope 恢复可能在同一轮发生。若预填 effect 先执行，后续恢复会用旧草稿
  // 覆盖用户刚点的 Example Prompt；因此必须在 scope 恢复之后应用并确认单次插入请求。
  useEffect(() => {
    if (!externalTextInsertRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedExternalTextInsertRequestRef.current,
        inputApi: inputApiRef.current,
        request: externalTextInsertRequest,
        requestFocus: requestComposerFocus,
        scheduleDraftPersist,
        updateText,
      });
      const applied = nextAppliedRequestId === externalTextInsertRequest.requestId;
      appliedExternalTextInsertRequestRef.current = nextAppliedRequestId;
      if (applied) {
        onExternalTextInsertApplied?.(externalTextInsertRequest.requestId);
      }
      return applied;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    requestComposerFocus,
    scheduleDraftPersist,
    updateText,
  ]);

  // 新建任务（含已在草稿态重复 Cmd/Ctrl+N，scope 未变）：startDraft 递增 nonce 即重新聚焦。
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // 切到需连接的会话时 disabled=true，聚焦意图 defer；连接完成 disabled→false 时兑现一次。
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // 刷新/关窗前落盘当前草稿。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => persistDraftNow(draftScopeRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      for (const cleanup of commandResolutionCleanupsRef.current) cleanup();
      commandResolutionCleanupsRef.current.clear();
    };
  }, [persistDraftNow]);

  // ── prompt history（per-workspace localStorage，↑/↓ 导航由 PromptHistoryPlugin 消费）──
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  const canStop = Boolean(snapshot?.control.canStop);
  const modifiedEnterReversesDelivery = modifiedEnterSubmits && canStop;
  const hasText = text.trim().length > 0;
  const hasDraftToSubmit =
    hasText ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(activeShareContextId);
  const hasComposerDraftContent =
    text.length > 0 ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(activeShareContextId);
  useEffect(() => {
    onDraftStateChange?.({
      hasContent: hasComposerDraftContent,
      busy: pending,
    });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // choice 保留正常发送按钮；提交后由 SessionPane 按 slash 语义决定是否弹确认框。
  // V4 重构时把 guide 当成“不可提交”状态，导致按钮和 Enter 同时失效；
  // guide 是 CLI 已授权的 busy 输入路由，是否最终 steer 或回退 queue 由命令层裁决。
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  // Incognito has no prewarm session: waiting files are uploaded only after its profile-bound create.
  const deferAttachmentUpload = draftMode && sessionId === null && incognitoDraftActive;
  const attachmentsReady =
    !attachmentsApi.hasUnreadyAttachments ||
    (deferAttachmentUpload &&
      attachmentsApi.attachments.every(
        (item) => item.uploadStatus === "ready" || item.uploadStatus === "waitingSession",
      ));
  const canSend =
    !disabled &&
    !pending &&
    !worktreeQueued &&
    hasDraftToSubmit &&
    routingAllowsSend &&
    attachmentsReady &&
    submissionReady &&
    !runtimeBlocked;
  // Same predicate as submit() (composerSubmitBlockReason), from render state: the bound-session
  // barrier and an in-flight first submission disable Send visibly instead of dropping the click.
  const heldFirstSubmission = composerDraft?.firstSubmission;
  const heldOutcomeUnresolved =
    heldFirstSubmission?.status === "sending" || heldFirstSubmission?.status === "unknown";
  const submitBlockReasonFor = (retrying: boolean, outcomeUnresolved: boolean) =>
    resolveComposerSubmitBlockReason({
      remoteAvailable,
      runtimeBlocked,
      submissionReady,
      submissionConfigured: true,
      modelSelectionIssue: modelSelectionView?.selectionIssue,
      modelSelectionSettled,
      sendInProgress: pendingOwner !== null || worktreeQueued,
      preparedSessionAwaitingFirstInput: Boolean(sessionId && snapshot?.meta.submissionPreparation),
      retrying,
      outcomeUnresolved,
      attachmentsReady,
    });
  const sendBlockReason = submitBlockReasonFor(Boolean(heldFirstSubmission), heldOutcomeUnresolved);
  const sendBarrierActive =
    sendBlockReason === "firstSubmissionDelivering" ||
    sendBlockReason === "outcomeUnresolved" ||
    (sendBlockReason === "sendInProgress" && pendingOwner !== null && !pending);
  const retryBlockReason = submitBlockReasonFor(true, false);
  // A settled (failed / restart-preparing) first-submission record of this session is not "still
  // being delivered": the barrier then names the record that needs Retry or Remove.
  useSyncExternalStore(
    subscribeV4ComposerDrafts,
    () => getV4FirstSubmissionVersion(workspacePath, workspaceIdentity),
    () => "",
  );
  const sessionFirstSubmission =
    sessionId !== null
      ? readV4WorktreeRecoveryDrafts(workspacePath, workspaceIdentity, sessionId).find(
          ({ draft }) => draft.firstSubmission,
        )?.draft.firstSubmission
      : undefined;
  const sendBlockMessageId =
    sendBlockReason === "firstSubmissionDelivering" &&
    sessionFirstSubmission &&
    !isV4FirstSubmissionActive(
      workspacePath,
      workspaceIdentity,
      sessionFirstSubmission.submissionId,
    ) &&
    (sessionFirstSubmission.status === "failed" || sessionFirstSubmission.status === "preparing")
      ? "composer.sendBlocked.firstSubmissionNeedsAction"
      : sendBlockReason
        ? `composer.sendBlocked.${sendBlockReason}`
        : null;
  // Enter during a model block keeps the draft (no newline) and repeats the inline copy, so the
  // reason is never only visible after a silent keypress (ISSUE-026).
  const handleModelBlockedEnter = useCallback(() => {
    if (!hasDraftToSubmit || !sendBlockMessageId) return;
    toast(intl.formatMessage({ id: sendBlockMessageId }), { dedupeKey: sendBlockMessageId });
  }, [hasDraftToSubmit, intl, sendBlockMessageId]);
  // 旧 UI 状态机：streaming + 空草稿 → Stop；有草稿 → 发送键（入队）。
  const showStopControl = canStop && !hasDraftToSubmit;

  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

  // Queued worktree send (specs/composer-worktree-setup-steps.md): dispatch exactly once when the
  // pipeline turns ready. The draft is claimed at queue time (the composer frees immediately and
  // the chat area shows the pending bubble), so a creation failure restores the message into the
  // composer for a plain re-send.
  useEffect(() => {
    let armed = pendingWorktreeSendRef.current;
    // The composer that armed the continuation may have unmounted when the first-send view
    // promoted this draft into the prepared session (BUG-GWT-005 live path): adopt the armed
    // continuation from the module-scope registry so the prepared session's composer can still
    // dispatch it when a retried creation turns ready.
    if (!armed && sessionId !== null) {
      const adopted = peekWorktreeSendContinuation(workspaceKey, sessionId);
      if (adopted) {
        pendingWorktreeSendRef.current = adopted;
        armed = adopted;
        if (adopted.restoredFailureKey) {
          reportedWorktreeFailuresRef.current.add(adopted.restoredFailureKey);
        }
        if (worktreePipeline?.status === "creating") setWorktreeQueued(true);
      }
    }
    const queued = armed;
    if (!queued) return;
    if (sessionId === queued.preparedSessionId) queued.hasBoundPreparedSession = true;
    // Every settled outcome detaches the queued submission first; only what happens next differs.
    const detachQueued = () => {
      pendingWorktreeSendRef.current = null;
      releaseWorktreeSendContinuation(queued.workspaceKey, queued.preparedSessionId);
      setWorktreeQueued(false);
    };
    if (
      queued.workspaceKey !== workspaceKey ||
      (queued.hasBoundPreparedSession && sessionId !== queued.preparedSessionId) ||
      (sessionId !== null && sessionId !== queued.preparedSessionId)
    ) {
      detachQueued();
      useComposerWorktreePipelineStore
        .getState()
        .detachQueuedSend(queued.workspaceKey, queued.preparedSessionId);
      queued.restore();
      return;
    }
    if (queued.attemptId && worktreePipeline?.params?.attemptId !== queued.attemptId) {
      const liveAttemptId = worktreePipeline?.params?.attemptId;
      if (
        !liveAttemptId ||
        (worktreePipeline?.status !== "creating" && worktreePipeline?.status !== "ready")
      ) {
        detachQueued();
        queued.restore();
        return;
      }
      // Retry restarts the same prepared session under a new attempt; the frozen submission
      // follows it instead of being detached.
      queued.attemptId = liveAttemptId;
    }
    if (worktreePipeline?.orphaned || worktreePipeline?.status === "discarded") {
      // Orphaned withdrawal and authoritative Host cancellation both stop local delivery; the
      // queued submission is restored and never dispatched.
      detachQueued();
      queued.restore();
      return;
    }
    if (
      worktreePipeline?.status === "ready" &&
      worktreePipeline.worktreePath &&
      worktreePipeline.params
    ) {
      detachQueued();
      void queued.dispatch(
        {
          path: worktreePipeline.worktreePath,
          branchName: worktreePipeline.params.branchName,
        },
        queued.preparedSessionId,
        queued.attemptId,
      );
      return;
    }
    if (worktreePipeline?.status === "failed") {
      if (worktreePipeline.returningToDraft) {
        // The return-to-draft orchestrator owns this failure (specs/composer-worktree-setup-steps.md
        // §Return to draft on failure): it reports to the Host, transfers the recovery record into
        // the draft pending scope, and settles the session. Running the local failure handling here
        // would re-create the session-scope recovery record the transfer just moved.
        // Keep the armed continuation registered: a Host-rejected hand-off falls back to the failed
        // row, where Retry must still admit the frozen submission. A successful hand-off releases it.
        pendingWorktreeSendRef.current = null;
        setWorktreeQueued(false);
        return;
      }
      const failureKey = `${queued.preparedSessionId}\0${worktreePipeline.params?.attemptId ?? ""}\0${worktreePipeline.failureMessage ?? ""}`;
      // After a failed tombstone the return-to-draft hand-off already reported the failure to the
      // Host; this effect must not send a second failure report. Retry stays armed below.
      if (
        onWorktreePreparationFailed &&
        !worktreePipeline.tombstoneFailed &&
        !reportedWorktreeFailuresRef.current.has(failureKey)
      ) {
        reportedWorktreeFailuresRef.current.add(failureKey);
        void onWorktreePreparationFailed(
          queued.preparedSessionId,
          worktreePipeline.failureMessage ?? "Worktree creation failed",
          worktreePipeline.params?.attemptId,
        ).catch((error) => {
          logger.warn("[WorktreePipeline] could not persist the preparation failure", {
            error: String(error),
            sessionId: queued.preparedSessionId,
          });
        });
      }
      if (worktreePipeline.params) {
        // Retryable failure: the frozen submission stays recoverable but also armed, so the
        // pipeline's Retry (a new attempt on this session) still activates it once it is ready.
        if (queued.restoredFailureKey !== failureKey) {
          queued.restoredFailureKey = failureKey;
          queued.restoreForRetry();
        }
        setWorktreeQueued(false);
        return;
      }
      detachQueued();
      queued.restore();
    }
  }, [onWorktreePreparationFailed, worktreePipeline, workspaceKey, sessionId]);

  // Explicitly turning worktree mode off withdraws the queued send. Navigation only detaches the
  // renderer callback; Host preparation remains durable and can be resumed on return.
  useEffect(() => {
    const queued = pendingWorktreeSendRef.current;
    if (!queued) {
      return;
    }
    if (sessionId === queued.preparedSessionId) queued.hasBoundPreparedSession = true;
    const navigatedAway =
      queued.workspaceKey !== workspaceKey ||
      (queued.hasBoundPreparedSession && sessionId !== queued.preparedSessionId) ||
      (sessionId !== null && sessionId !== queued.preparedSessionId);
    if (navigatedAway) {
      pendingWorktreeSendRef.current = null;
      releaseWorktreeSendContinuation(queued.workspaceKey, queued.preparedSessionId);
      setWorktreeQueued(false);
      useComposerWorktreePipelineStore
        .getState()
        .detachQueuedSend(queued.workspaceKey, queued.preparedSessionId);
      queued.restore();
      return;
    }
    // Once the composer is bound to the prepared session, the draft-only intent mirror must not
    // withdraw the queued send: the mirror flips off for non-user reasons when the empty-state
    // worktree toggle unmounts at first-send promotion, which stranded the armed submission after
    // a retried creation turned ready (BUG-GWT-005). Explicit toggles withdraw the store entry
    // themselves; the queued-send effect abandons delivery on that orphaned flag.
    if (sessionId === queued.preparedSessionId) return;
    if (worktreeIntentActive && sessionId === null) return;
    pendingWorktreeSendRef.current = null;
    releaseWorktreeSendContinuation(queued.workspaceKey, queued.preparedSessionId);
    setWorktreeQueued(false);
    useComposerWorktreePipelineStore
      .getState()
      .withdraw(queued.workspaceKey, queued.preparedSessionId);
    queued.restore();
  }, [draftMode, sessionId, worktreeIntentActive, workspaceKey]);

  // Composer unmount (workspace/tab switch, or the first-send view promotion remounting the
  // composer as the prepared session's composer) releases only the local cache: while the
  // pipeline is still recoverable the continuation stays armed in the module-scope registry, so
  // the composer instance that mounts next for that prepared session adopts it and a Retry that
  // turns ready still admits the frozen submission exactly once (BUG-GWT-005 live path). The
  // Host-owned preparation and Git operation continue for the same session either way; only an
  // unrecoverable pipeline falls back to detaching and restoring the frozen draft.
  useEffect(
    () => () => {
      const queued = pendingWorktreeSendRef.current;
      if (!queued) return;
      pendingWorktreeSendRef.current = null;
      setWorktreeQueued(false);
      const entry = selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        queued.workspaceKey,
        queued.preparedSessionId,
      );
      const recoverable =
        entry !== null &&
        !entry.orphaned &&
        (entry.status === "creating" ||
          entry.status === "ready" ||
          (entry.status === "failed" && entry.params !== undefined));
      if (recoverable) return;
      releaseWorktreeSendContinuation(queued.workspaceKey, queued.preparedSessionId);
      useComposerWorktreePipelineStore
        .getState()
        .detachQueuedSend(queued.workspaceKey, queued.preparedSessionId);
      queued.restore();
    },
    [workspaceKey],
  );

  const submit = useCallback(
    async (
      heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
      expectedHeldQueueItemIds?: readonly string[],
      existingTelemetrySeed?: ConversationPromptTelemetrySeed,
      requestedDelivery?: "startNow" | "queue" | "guide",
    ) => {
      const trimmed = textRef.current.trim();
      const submittedQueueItemIds =
        snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
      const hasPendingAttachments = attachmentsApi.attachments.length > 0;
      const currentCodeCommentContexts = getCodeCommentContexts();
      const hasPendingCodeCommentContexts = currentCodeCommentContexts.length > 0;
      const currentWebElementContexts = webElementContexts;
      const hasPendingWebElementContexts = currentWebElementContexts.length > 0;
      const currentPluginUiContexts = pluginUiContexts;
      const hasPendingPluginUiContexts = currentPluginUiContexts.length > 0;
      const currentPptxElementReferences = pptxElementReferences;
      const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
      const currentConversationSelections = conversationSelectionReferences;
      const hasPendingConversationSelections = currentConversationSelections.length > 0;
      const submittedShareContextId = activeShareContextId;
      // After first draft send is accepted, this Composer promotes in place from __draft__ to session scope.
      // If success cleanup reads the mutable ref later, it may clear the new scope by mistake and leave the first input in
      // __draft__, restoring it when the next task is created. Freeze the actual submitted scope at send start.
      const submittedDraft = snapshotDraftOfEditor();
      // Recovery carries the contexts actually included in this submission, so Restore
      // re-establishes exactly this input after navigation or reload.
      const submittedRecoveryContexts: V4ComposerRecoveryContexts | undefined =
        currentConversationSelections.length ||
        currentCodeCommentContexts.length ||
        currentWebElementContexts.length ||
        currentPptxElementReferences.length ||
        currentPluginUiContexts.length ||
        submittedShareContextId
          ? {
              ...(currentConversationSelections.length
                ? { conversationQuotes: [...currentConversationSelections] }
                : {}),
              ...(currentCodeCommentContexts.length
                ? { codeComments: [...currentCodeCommentContexts] }
                : {}),
              ...(currentWebElementContexts.length
                ? { webElements: [...currentWebElementContexts] }
                : {}),
              ...(currentPptxElementReferences.length
                ? { pptxElements: [...currentPptxElementReferences] }
                : {}),
              ...(currentPluginUiContexts.length
                ? { pluginUiContexts: [...currentPluginUiContexts] }
                : {}),
              ...(submittedShareContextId
                ? {
                    sharedContextRefs: [
                      {
                        kind: "shared_context_import" as const,
                        context_id: submittedShareContextId,
                      },
                    ],
                  }
                : {}),
            }
          : undefined;
      const retryFirstSubmission = retryFirstSubmissionRef.current ?? composerDraft.firstSubmission;
      const submissionId = retryFirstSubmission?.submissionId ?? crypto.randomUUID();
      let frozenFirstSubmission: V4ComposerDraft["firstSubmission"];
      let reservedSubmissionSessionId: string | undefined;
      let incognitoSubmission: ReturnType<
        ReturnType<typeof useDraftIncognitoIntentStore.getState>["captureForSubmission"]
      >;
      const pendingRecoveryScope = getV4WorktreeRecoveryScope(draftScopeId, submissionId);
      const submittedOwner = {
        epoch: renderedOwnerRef.current.epoch,
        workspaceKey,
        scopeId: draftScopeId,
        revision: contentRevisionRef.current,
      };
      const shouldActivatePreparedSession = () =>
        composerAliveRef.current &&
        renderedOwnerRef.current.workspaceKey === submittedOwner.workspaceKey &&
        renderedOwnerRef.current.scopeId === submittedOwner.scopeId &&
        renderedOwnerRef.current.epoch === submittedOwner.epoch;
      const clearQueuedSubmissionState = () => {
        if (queuedSubmissionIdRef.current !== submissionId) return;
        queuedSubmissionIdRef.current = null;
        setWorktreeQueued(false);
      };
      const isCurrentOwner = () =>
        isComposerSubmissionOwnerCurrent(
          { ...submittedOwner, revision: cleanupRevision },
          { ...renderedOwnerRef.current, revision: contentRevisionRef.current },
        );
      let cleanupRevision = contentRevisionRef.current;
      const acquirePending = () => {
        pendingRef.current = submissionId;
        setPendingOwner(submissionId);
        setPending(true);
      };
      // Only the owner releases: a later send may already hold the token.
      const releasePending = () => {
        if (pendingRef.current !== submissionId) return;
        pendingRef.current = null;
        setPendingOwner(null);
        setPending(false);
      };
      // Draft claim lives in the submit scope (not inside the send closure): a queued worktree
      // send claims the draft at queue time so the composer frees immediately, and the same
      // claim/restore pair guards the eventual dispatch.
      let draftSubmissionClaimed = false;
      let editorClearedOptimistically = false;
      const claimSubmittedDraft = (clearEditor = true) => {
        // A queued worktree send claims at queue time; the eventual dispatch re-enters here and
        // must not wipe text typed while the creation was in flight.
        if (draftSubmissionClaimed) return;
        if (!isCurrentOwner()) throw new Error("Submission owner changed before admission");
        if (draftPersistTimerRef.current !== null) {
          window.clearTimeout(draftPersistTimerRef.current);
          draftPersistTimerRef.current = null;
        }
        // First-send promotion may switch scope or remount Composer before onSendText returns.
        // If the old scope effect can still persist, the new Composer restores already-sent text as a draft.
        // Claim and hide the draft before submission; restore it on failure rather than masking the race with a delay.
        suppressDraftPersistRef.current = true;
        draftPersistClaimRef.current = submissionId;
        // The persisted draft must drop the submitted text even when the editor stays visible until
        // acceptance: the debounced persist may have already stored it, and the first-send promotion
        // re-applies that draft into the promoted session, so the input never clears. Failure
        // recovery does not read this store — restoreSubmittedDraft uses the frozen snapshot.
        updateComposerContentRef.current({ text: "", firstSubmission: undefined });
        if (clearEditor) {
          inputApiRef.current?.clear();
          updateText("");
          editorClearedOptimistically = true;
        }
        cleanupRevision = contentRevisionRef.current;
        if (clearEditor)
          claimedSubmissionRef.current = { submissionId, revision: contentRevisionRef.current };
        draftSubmissionClaimed = true;
      };
      const releaseRepeatClickGuard = () => {
        if (claimedSubmissionRef.current?.submissionId === submissionId)
          claimedSubmissionRef.current = null;
      };
      const restoreSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        if (frozenFirstSubmission)
          setV4FirstSubmissionActive(workspacePath, workspaceIdentity, submissionId, false);
        // Clipboard-text path metadata persists only for local workspaces (remote targets keep
        // the reattach requirement); the worktree intent snapshot prefills Retry/Change actions.
        const persistPathMetadata = !workspaceIdentity?.trim();
        const preparationParams = preparedSessionIdForSend
          ? selectComposerWorktreePipeline(
              useComposerWorktreePipelineStore.getState(),
              workspaceKey,
              preparedSessionIdForSend,
            )?.params
          : undefined;
        const restoredDraft: Omit<V4ComposerDraft, "updatedAt"> = {
          ...composerDraft,
          ...submittedDraft,
          ...(frozenFirstSubmission
            ? {
                firstSubmission: {
                  ...frozenFirstSubmission,
                  commandId: submittedCommandId ?? frozenFirstSubmission.commandId,
                  status:
                    submittedCommandId && !submittedCommandResolved
                      ? ("unknown" as const)
                      : ("failed" as const),
                },
              }
            : {}),
          ...(submittedRecoveryContexts ? { recoveryContexts: submittedRecoveryContexts } : {}),
          ...(preparationParams
            ? { worktreeIntent: buildV4WorktreeIntentFromParams(preparationParams) }
            : {}),
          recoveryAttachments: buildV4RecoveryAttachmentsManifest(
            attachmentsApi.attachments.filter((item) => submittedAttachmentIds.includes(item.id)),
            { persistPathMetadata },
          ),
        };
        // Recovery belongs to the frozen submission once a Host session exists; pre-reservation
        // failures keep the ordinary draft scope so blocked sends stay editable inline.
        const persistFrozenRecovery =
          preparedSessionIdForSend ||
          queueWorktreeSend ||
          (frozenFirstSubmission &&
            (reservedSubmissionSessionId || frozenFirstSubmission.reservation));
        if (persistFrozenRecovery) {
          // Persist where the user is looking (specs/first-submission-lifecycle.md): the reserved
          // session only once the bind moved the record there; otherwise the scope it still lives
          // in, with the reservation kept inside the record so Retry reuses it.
          const recoveryOwner =
            reservedSubmissionSessionId && reservationRecordBound
              ? reservedSubmissionSessionId
              : (preparedSessionIdForSend ?? submittedOwner.scopeId);
          const recovered = persistV4ComposerDraft(
            workspacePath,
            workspaceIdentity,
            getV4WorktreeRecoveryScope(recoveryOwner, submissionId),
            restoredDraft,
          );
          if (recovered)
            submittedAttachments.moveToScope?.(
              `${workspaceKey}\0${getV4WorktreeRecoveryScope(recoveryOwner, submissionId)}`,
            );
          if (
            recovered &&
            pendingRecoveryScope !== getV4WorktreeRecoveryScope(recoveryOwner, submissionId)
          )
            clearV4ComposerDraft(workspacePath, workspaceIdentity, pendingRecoveryScope);
          // Every unknown outcome is in the unsettled ledger (FSL07), whichever scope holds it.
          if (submittedCommandId && !submittedCommandResolved) {
            trackUnsettledComposerSubmission(`${workspaceKey}\0${recoveryOwner}`, {
              commandId: submittedCommandId,
              text: submittedDraft.text,
            });
          }
        } else if (isCurrentOwner()) {
          if (frozenFirstSubmission && !reservedSubmissionSessionId) {
            clearV4ComposerDraft(workspacePath, workspaceIdentity, pendingRecoveryScope);
          }
          updateComposerContentRef.current({
            ...submittedDraft,
            ...(frozenFirstSubmission && !reservedSubmissionSessionId
              ? { firstSubmission: undefined }
              : {}),
          });
          if (editorClearedOptimistically) {
            if (submittedDraft.editorStateJson)
              inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
            else inputApiRef.current?.setText(submittedDraft.text);
            updateText(submittedDraft.text);
          }
          // A transport failure is not proof the CLI did not admit the command (ACK can be lost):
          // keep the command in the module ledger so a remounted composer can still settle it.
          if (submittedCommandId && !submittedCommandResolved) {
            trackUnsettledComposerSubmission(submittedScopeKey, {
              commandId: submittedCommandId,
              text: submittedDraft.text,
            });
          }
        } else {
          persistV4ComposerDraft(
            workspacePath,
            workspaceIdentity,
            getV4WorktreeRecoveryScope(submittedOwner.scopeId, submissionId),
            restoredDraft,
          );
          if (submittedCommandId && !submittedCommandResolved) {
            trackUnsettledComposerSubmission(`${workspaceKey}\0${submittedOwner.scopeId}`, {
              commandId: submittedCommandId,
              text: submittedDraft.text,
            });
          }
        }
        if (draftPersistClaimRef.current === submissionId) {
          suppressDraftPersistRef.current = false;
          draftPersistClaimRef.current = null;
        }
        releaseRepeatClickGuard();
        draftSubmissionClaimed = false;
      };
      // Nothing reached the Host (cancelled checkout guard, failed preflight or validation, storage
      // failure): withdraw the frozen submission at every such return site (specs/first-submission-
      // lifecycle.md). With an empty editor the text returns inline and the record is deleted; text
      // typed meanwhile is never overwritten (spec decision 2), so the message stays as a plain
      // recovery card — never as a second optimistic turn. Ownership ignores the content revision:
      // the editor's own clear echo bumps it without changing who owns the view.
      const withdrawUnreservedSubmission = () => {
        if (!draftSubmissionClaimed) return;
        if (frozenFirstSubmission)
          setV4FirstSubmissionActive(workspacePath, workspaceIdentity, submissionId, false);
        const sameView =
          composerAliveRef.current &&
          isComposerSubmissionOwnerCurrent(
            { ...submittedOwner, revision: 0 },
            { ...renderedOwnerRef.current, revision: 0 },
          );
        if (sameView && textRef.current.trim().length === 0) {
          clearV4ComposerDraft(workspacePath, workspaceIdentity, pendingRecoveryScope);
          updateComposerContentRef.current({ ...submittedDraft, firstSubmission: undefined });
          if (editorClearedOptimistically) {
            if (submittedDraft.editorStateJson)
              inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
            else inputApiRef.current?.setText(submittedDraft.text);
            updateText(submittedDraft.text);
          }
        } else {
          persistV4ComposerDraft(workspacePath, workspaceIdentity, pendingRecoveryScope, {
            ...composerDraft,
            ...submittedDraft,
            firstSubmission: undefined,
            ...(submittedRecoveryContexts ? { recoveryContexts: submittedRecoveryContexts } : {}),
            recoveryAttachments: buildV4RecoveryAttachmentsManifest(
              attachmentsApi.attachments.filter((item) => submittedAttachmentIds.includes(item.id)),
              { persistPathMetadata: !workspaceIdentity?.trim() },
            ),
          });
        }
        if (draftPersistClaimRef.current === submissionId) {
          suppressDraftPersistRef.current = false;
          draftPersistClaimRef.current = null;
        }
        releaseRepeatClickGuard();
        draftSubmissionClaimed = false;
      };
      const restoreForRetry = () => {
        restoreSubmittedDraft();
        draftSubmissionClaimed = true;
      };
      const finalizeSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        if (draftPersistClaimRef.current === submissionId) {
          suppressDraftPersistRef.current = false;
          draftPersistClaimRef.current = null;
        }
        draftSubmissionClaimed = false;
      };
      const submission = createSubmissionFromComposer?.() ?? null;
      const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
      const submittedAttachments = attachmentsApi.captureSubmission?.(submittedAttachmentIds) ?? {
        ...attachmentsApi,
        moveToScope: undefined,
      };
      // Upstream settlement (composerSubmissionSettlement + pendingCommandRegistry): an accepted or
      // authoritative command projection settles the captured content even when the send ACK is lost.
      const submittedScopeKey = `${workspaceKey}\0${draftScopeRef.current}`;
      let submittedCommandId: string | null = null;
      let submittedCommandResolved = false;
      // Single logical bind writer for a reserved first submission (specs/first-submission-
      // instant-ux.md, P2 bind moment): move the frozen record into the session scope, hand
      // the attachments over, and promote the pane — gated by navigation ownership (FSL rule 7).
      // Called at the reservation identity (plain: createSession envelope) and retried after
      // admission only when it could not run earlier (storage failure or the navigation gate).
      let reservationRecordBound = false;
      const bindReservedSessionRecord = () => {
        if (reservationRecordBound || !reservedSubmissionSessionId) return;
        const targetScope = getV4WorktreeRecoveryScope(reservedSubmissionSessionId, submissionId);
        if (
          !moveV4ComposerDraft(workspacePath, workspaceIdentity, pendingRecoveryScope, targetScope)
        ) {
          logger.warn(
            "[v4-composer] first-submission draft move failed; keeping pending recovery scope",
          );
          return;
        }
        reservationRecordBound = true;
        // P2 bind releases the repeat-submit ref: a genuinely new draft now takes the ordinary
        // send path (double clicks stay caught by the repeat-click guard).
        releasePending();
        submittedAttachments.moveToScope?.(`${workspaceKey}\0${reservedSubmissionSessionId}`);
        if (shouldActivatePreparedSession())
          onFirstSubmissionReserved?.(reservedSubmissionSessionId);
      };
      let submittedContentSettled = false;
      let sendPreparedSessionId: string | undefined;
      const settleSubmittedContent = async () => {
        if (submittedContentSettled) return;
        submittedContentSettled = true;
        // Transfer staged content to the task only after the send is accepted; on failure the draft keeps ownership.
        await submittedAttachments.adoptSentAttachments(submittedAttachmentIds);
        const recoverySessionId =
          reservedSubmissionSessionId ?? sendPreparedSessionId ?? preparedSessionIdForSend;
        if (recoverySessionId && !frozenFirstSubmission) {
          clearV4ComposerDraft(
            workspacePath,
            workspaceIdentity,
            getV4WorktreeRecoveryScope(recoverySessionId, submissionId),
          );
        }
        if (!frozenFirstSubmission)
          clearV4ComposerDraft(workspacePath, workspaceIdentity, pendingRecoveryScope);
        // Bug cause: text entered while the send is pending belongs to the next Submission; an old ACK must not clear it.
        if (isCurrentOwner()) {
          inputApiRef.current?.clear();
          updateText("");
          updateComposerContentRef.current({ text: "" });
        }
        submittedAttachments.clearAttachments(submittedAttachmentIds);
        // As with attachments, remove only refs frozen for this send; refs added while waiting belong to the next message.
        currentCodeCommentContexts.forEach(removeCodeCommentContext);
        currentWebElementContexts.forEach((context) => removeWebElementContext(context.id));
        currentPluginUiContexts.forEach((context) => removePluginUiContext(context.id));
        if (submittedShareContextId) {
          setRestoredShareContext((current) =>
            current?.contextId === submittedShareContextId ? null : current,
          );
        }
        currentPptxElementReferences.forEach((reference) =>
          removePptxElementReference(reference.id),
        );
        currentConversationSelections.forEach((reference) =>
          removeConversationSelectionReference(reference.id),
        );
        // On success, clear the scope draft captured by this submission. Prompt history was synchronously persisted before the real send,
        // avoiding loss during first-send promotion or clearing the new scope created by promotion.
        finalizeSubmittedDraft();
      };
      const subscribeToCommandResolution = (commandId: string) => {
        let active = true;
        let cleanup = () => undefined;
        submittedCommandId = commandId;
        if (frozenFirstSubmission)
          updateV4FirstSubmission(workspacePath, workspaceIdentity, submissionId, {
            commandId,
            status: "sending",
          });
        const unsubscribe = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
          if (!active) return;
          if (resolution === "unknown") {
            if (frozenFirstSubmission)
              updateV4FirstSubmission(workspacePath, workspaceIdentity, submissionId, {
                status: "unknown",
              });
            return;
          }
          submittedCommandResolved = true;
          cleanup();
          if (
            resolution !== "accepted" &&
            resolution !== "duplicate" &&
            resolution !== "authoritative"
          ) {
            return;
          }
          void settleSubmittedContent();
        });
        cleanup = () => {
          if (!active) return;
          active = false;
          unsubscribe();
          commandResolutionCleanupsRef.current.delete(cleanup);
        };
        commandResolutionCleanupsRef.current.add(cleanup);
      };
      const hasNothingToSend =
        !trimmed &&
        !hasPendingAttachments &&
        !hasPendingCodeCommentContexts &&
        !hasPendingWebElementContexts &&
        !hasPendingPptxElementReferences &&
        !hasPendingConversationSelections &&
        !hasPendingPluginUiContexts &&
        !submittedShareContextId;
      const submitBlockReason = resolveComposerSubmitBlockReason({
        remoteAvailable,
        runtimeBlocked,
        submissionReady,
        submissionConfigured: !(createSubmissionFromComposer !== undefined && submission === null),
        modelSelectionIssue: modelSelectionView?.selectionIssue,
        modelSelectionSettled,
        sendInProgress:
          pendingRef.current !== null ||
          targetSelectionPendingRef.current ||
          worktreeQueued ||
          reservingWorktreeRef.current?.epoch === renderedOwnerRef.current.epoch ||
          pendingWorktreeSendRef.current !== null,
        preparedSessionAwaitingFirstInput: Boolean(snapshotRef.current?.meta.submissionPreparation),
        retrying: Boolean(retryFirstSubmission),
        outcomeUnresolved:
          retryFirstSubmission?.status === "sending" || retryFirstSubmission?.status === "unknown",
        attachmentsReady,
      });
      // A blocked Send with content must say why; a silent return looks like a lost message.
      // A failed worktree preparation keeps its frozen send armed (pendingWorktreeSendRef) after
      // worktreeQueued is cleared; that block is the failed first message awaiting Retry, not an
      // in-flight send, so it is named instead of being dropped with sendInProgress.
      const noticeReason =
        submitBlockReason === "sendInProgress" &&
        pendingWorktreeSendRef.current !== null &&
        !worktreeQueued
          ? "firstSubmissionNeedsAction"
          : submitBlockReason;
      // The reason is the dedupe key: toast() replaces the notice with the same key, so Enter spam keeps
      // one visible notice per reason. A live sendInProgress clears itself when the in-flight send settles,
      // and the Send tooltip already names it, so it gets no notice.
      if (!hasNothingToSend && noticeReason !== null && noticeReason !== "sendInProgress")
        toast(intl.formatMessage({ id: `composer.sendBlocked.${noticeReason}` }), {
          dedupeKey: `composer.sendBlocked.${noticeReason}`,
        });
      if (
        hasNothingToSend ||
        submitBlockReason !== null ||
        // A double click: no editor change since this composer's last claim.
        (claimedSubmissionRef.current !== null &&
          claimedSubmissionRef.current.revision === contentRevisionRef.current &&
          !retryFirstSubmissionRef.current)
      ) {
        return;
      }
      const localCommand = parseV4VisibleSlashCommand(trimmed, attachmentsApi.attachments, {
        contextAttachmentCount: Number(Boolean(submittedRecoveryContexts)),
      });
      if (durableFirstSubmission && (draftMode || retryFirstSubmission) && !localCommand) {
        incognitoSubmission =
          draftMode && sessionId === null
            ? useDraftIncognitoIntentStore.getState().captureForSubmission(workspaceKey)
            : undefined;
        frozenFirstSubmission = {
          submissionId,
          ownerKey: retryFirstSubmission?.ownerKey ?? draftScopeId,
          generation: draftGeneration,
          status: "preparing",
          // Freezing overwrites the stored record: keep the id of an earlier attempt's sendText so a
          // failure before this attempt creates its own command still leaves it reconcilable.
          ...(retryFirstSubmission?.commandId ? { commandId: retryFirstSubmission.commandId } : {}),
          ...(retryFirstSubmission?.incognito || incognitoSubmission?.profile
            ? { incognito: retryFirstSubmission?.incognito ?? incognitoSubmission?.profile }
            : {}),
          ...(retryFirstSubmission?.reservation
            ? { reservation: retryFirstSubmission.reservation }
            : {}),
        };
        const saved = persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          pendingRecoveryScope,
          {
            ...composerDraft,
            ...submittedDraft,
            firstSubmission: frozenFirstSubmission,
            recoveryContexts: submittedRecoveryContexts,
            recoveryAttachments: buildV4RecoveryAttachmentsManifest(attachmentsApi.attachments, {
              persistPathMetadata: !workspaceIdentity?.trim(),
            }),
          },
        );
        if (!saved) {
          toast(intl.formatMessage({ id: "composerRecovery.storageUnavailable" }));
          return;
        }
        setV4FirstSubmissionActive(workspacePath, workspaceIdentity, submissionId, true);
        // Claim at freeze (FSL owners: past this point the send closure reads only the frozen
        // snapshot, module draft stores and the reserved session id): the editor frees for the
        // next draft in the same commit as the optimistic turn, and the reservation-time bind
        // can no longer abort the send through the "Submission owner changed" guard. The
        // claim's suppress flags neutralize the editor-clear echo (357f25ca).
        claimSubmittedDraft();
        retryFirstSubmissionRef.current = undefined;
      }
      // Worktree setup pipeline (specs/composer-worktree-setup-steps.md): the first send with an
      // active "New worktree" intent starts creation WITHOUT blocking or disabling the composer.
      // The shell presents a provisional chat from pipeline state; the frozen send dispatches only
      // after the worktree is ready. A reused ready worktree (retry or orphan reuse) dispatches immediately.
      const worktreeIntent = worktreeIntentSlot?.current;
      let executionWorktree: ComposerExecutionWorktree | undefined;
      let preparedSessionIdForSend: string | undefined;
      let queueWorktreeSend = false;
      if (
        Boolean(sessionId && snapshotRef.current?.meta.worktreePreparation) ||
        (draftMode && sessionId === null && worktreeIntent?.workspaceKey === workspaceKey)
      ) {
        const pipeline = sessionId
          ? selectComposerWorktreePipeline(
              useComposerWorktreePipelineStore.getState(),
              workspaceKey,
              sessionId,
            )
          : null;
        const currentPreparedSessionId = snapshotRef.current?.meta.worktreePreparation
          ? sessionId
          : null;
        if (
          pipeline?.status === "ready" &&
          pipeline.worktreePath &&
          pipeline.params &&
          (!currentPreparedSessionId || pipeline.sessionId === currentPreparedSessionId)
        ) {
          executionWorktree = {
            path: pipeline.worktreePath,
            branchName: pipeline.params.branchName,
          };
          preparedSessionIdForSend = currentPreparedSessionId ?? pipeline.sessionId;
        } else if (pipeline?.status === "creating") {
          // Continue only the preparation bound to this session.
          if (!currentPreparedSessionId && !pipeline.sessionId) {
            withdrawUnreservedSubmission();
            return;
          }
          preparedSessionIdForSend = currentPreparedSessionId ?? pipeline.sessionId;
          queueWorktreeSend = true;
        } else {
          // The Host session is reserved below before beginCreation starts any Git work.
          preparedSessionIdForSend = currentPreparedSessionId ?? undefined;
          queueWorktreeSend = true;
        }
      }
      // Draft branch intent, checkout mode only (the worktree pipeline owns the branch while its
      // intent is active): a different branch runs the guard, then the switch; a cancelled guard
      // or failed switch aborts the send with the draft and the intent preserved (spec §1).
      const branchIntentGitService = baseWorkspaceServices?.gitService;
      const draftBranchIntent =
        !queueWorktreeSend &&
        executionWorktree === undefined &&
        draftMode &&
        sessionId === null &&
        branchIntentGitService
          ? selectDraftBranchIntent(useDraftBranchIntentStore.getState(), workspaceKey)
          : null;
      if (draftBranchIntent && branchIntentGitService) {
        acquirePending();
        try {
          const resolution = await applyDraftBranchIntentForSend({
            gitService: branchIntentGitService,
            ...(branchSwitchGuard ? { guard: branchSwitchGuard } : {}),
            workspaceKey,
            workspacePath,
            branchName: draftBranchIntent,
          });
          if (resolution.outcome === "aborted") {
            withdrawUnreservedSubmission();
            if (resolution.reason === "switch-failed") {
              toast(
                resolution.message ??
                  intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
              );
            } else if (resolution.reason === "switch-error") {
              toast(
                intl.formatMessage(
                  { id: "git.branchSwitcher.error.requestFailed" },
                  { error: resolution.message ?? "" },
                ),
              );
            }
            // "guard" is a user cancellation: no toast, draft and intent preserved.
            return;
          }
        } finally {
          releasePending();
        }
      }
      // Frozen-send closure: runs the actual dispatch either immediately (plain sends,
      // reused ready worktree) or from the queued-worktree effect when the pipeline turns ready.
      const runSend = async (
        executionWorktree: ComposerExecutionWorktree | undefined,
        preparedSessionId?: string,
        preparedAttemptId?: string,
      ): Promise<void> => {
        sendPreparedSessionId = preparedSessionId ?? preparedSessionIdForSend;
        const sendAction = startUserAction({
          featureId: "conversation.composer.message",
          action: "send",
          trigger: sendTriggerRef.current === "button" ? "button" : "shortcut",
          workspaceKind: workspaceIdentity?.trim() ? "remote" : "local",
        });
        acquirePending();
        // Bug cause: draft intent stores only explicit user changes; the normally inherited model is in frozen initialization config.
        // If the prewarm snapshot has not arrived and we read only draftConfig, send_btn incorrectly becomes an empty model/glm.
        const telemetryConfig = telemetryDraftConfig ?? snapshotRef.current?.config ?? draftConfig;
        let telemetrySeed: ConversationPromptTelemetrySeed;
        if (existingTelemetrySeed) {
          // Queue re-confirmation reuses the seed from the first click: do not report send_click again or reset the trigger source,
          // keeping send_click and send_result strictly 1:1.
          telemetrySeed = existingTelemetrySeed;
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, false);
        } else {
          const freshSeed: ConversationPromptTelemetrySeed = {
            sendTime: Date.now(),
            localTtft: !workspaceIdentity?.trim()
              ? getLocalTtftObserver()?.start(
                  workspacePath,
                  (snapshotRef.current !== null &&
                    snapshotRef.current.inputRouting.mode !== "startNow") ||
                    false,
                  trimmed.startsWith("/"),
                )
              : undefined,
            extraDetail: buildV4ConversationPromptTelemetryExtraDetail({
              askMode: telemetryConfig?.mode,
              modelName: telemetryConfig?.model,
              configProvider: telemetryConfig?.provider,
              agentProvider: provider,
              providerBaseURL: resolveProviderBaseURL(
                telemetryConfig?.provider,
                modelSelectionView,
              ),
              planIdentitySnapshot: readPlanIdentitySnapshot?.(),
            }),
          };
          const sendTrigger = sendTriggerRef.current;
          sendTriggerRef.current = "shortcut";
          // recordSendClick fills in sendClickId; use its returned value as the next seed.
          // Otherwise finalization lacks the correlation key and send_result is skipped as a background task.
          telemetrySeed =
            conversationTelemetry?.recordSendClick({
              sessionId: sessionId ?? null,
              seed: freshSeed,
              trigger: sendTrigger,
            }) ?? freshSeed;
        }
        let promptHistoryBeforeSend: readonly string[] | null = null;
        let promptHistoryAfterAppend: readonly string[] | null = null;
        let promptHistoryWasPersisted = false;
        // Set when onSendText threw: SessionPane.handleSendText has already set its admission-failure banner.
        let sendTextFailureShown = false;
        const rollbackPromptHistory = () => {
          if (!promptHistoryWasPersisted || !promptHistoryBeforeSend || !promptHistoryAfterAppend) {
            return;
          }
          const currentPromptHistory = readPromptHistoryEntries(workspacePath);
          if (arePromptHistoryEntriesEqual(currentPromptHistory, promptHistoryAfterAppend)) {
            persistPromptHistoryEntries(workspacePath, promptHistoryBeforeSend);
            setPromptHistory(promptHistoryBeforeSend);
            return;
          }
          setPromptHistory(currentPromptHistory);
        };
        try {
          // First submissions free the submit control at the fire moment (IUX "no dead Send"):
          // the background chain owns everything from here; the repeat-submit ref stays armed
          // until the P2 bind, restore or chain end (owner token), and the repeat-click guard
          // catches double clicks after that.
          if (frozenFirstSubmission) setPending(false);
          // Freeze the profile before attachment preparation; later draft edits belong to another submission.
          if (!frozenFirstSubmission && draftMode && sessionId === null)
            incognitoSubmission = useDraftIncognitoIntentStore
              .getState()
              .captureForSubmission(workspaceKey);
          const incognito = frozenFirstSubmission?.incognito ?? incognitoSubmission?.profile;
          if (
            frozenFirstSubmission &&
            !executionWorktree &&
            !preparedSessionId &&
            onPrepareFirstSubmission
          ) {
            reservedSubmissionSessionId = await onPrepareFirstSubmission({
              submissionId,
              ...(incognito ? { incognito } : {}),
              reservation: frozenFirstSubmission.reservation,
              onReservationCreated: (reservation) => {
                frozenFirstSubmission = {
                  ...frozenFirstSubmission!,
                  reservation,
                };
                try {
                  updateV4FirstSubmission(workspacePath, workspaceIdentity, submissionId, {
                    reservation,
                  });
                } catch (error) {
                  // The in-memory frozen record keeps the reservation; restore persists it.
                  logger.warn(
                    "[v4-composer] could not persist the first-submission reservation",
                    error,
                  );
                }
                // P2 bind moment: the reservation identity is known (client-proposed,
                // ACK-stable session id + command id), so hand the record to the session
                // scope and bind the pane now — never after sendText. Gated by navigation
                // ownership (FSL rule 7); a skipped bind reconciles from the record.
                reservedSubmissionSessionId = reservation.sessionId;
                bindReservedSessionRecord();
              },
            });
          }
          const readyAttachmentRefs = await submittedAttachments.prepareForSend(
            queueWorktreeSend ? submittedAttachmentIds : undefined,
            { allowWaitingSession: incognito !== undefined },
          );
          if (readyAttachmentRefs === null) {
            if (frozenFirstSubmission) restoreSubmittedDraft();
            if (telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
            // send_click has already been reported; failing to finalize here leaves an unmatched sample and skews the success-rate denominator.
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: sessionId ?? null,
              status: "fail",
              reasonCode: "attachment_not_ready",
            });
            sendAction.fail({ failureStage: "attachment_not_ready" });
            return;
          }
          // External context is not sent as protocol attachments. Serialize it in the fixed trailing order selection → code comment → web → PPTX
          // so historical user rows can parse it losslessly in reverse and hide internal prompt blocks.
          //
          // Do not serialize share handover here: the share URL block is renderer-only (nothing in CLI/shared parses it).
          // Its only purpose was to drive a chip that the product removed, while also putting a share URL into the model prompt.
          // Model-side content is injected by the hidden shared_context message through inputIntent.sharedContextRefs, independently of the body.
          const promptText = serializeComposerPromptContexts(trimmed, {
            codeComments: currentCodeCommentContexts,
            conversationSelections: [],
            webElements: currentWebElementContexts,
            pptxElements: currentPptxElementReferences,
            pluginUiContexts: currentPluginUiContexts,
          });
          const contextAttachmentCount =
            countComposerPromptContexts({
              codeComments: currentCodeCommentContexts,
              conversationSelections: currentConversationSelections,
              webElements: currentWebElementContexts,
              pptxElements: currentPptxElementReferences,
              pluginUiContexts: currentPluginUiContexts,
            }) + (submittedShareContextId ? 1 : 0);
          if (trimmed) {
            promptHistoryBeforeSend = readPromptHistoryEntries(workspacePath);
            promptHistoryAfterAppend = appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed);
            if (!arePromptHistoryEntriesEqual(promptHistoryBeforeSend, promptHistoryAfterAppend)) {
              // After prewarm first-send is accepted, SessionPane immediately promotes to a new session, and the draft Composer
              // may unmount before the await resumes; do not hide persistence inside a React state updater.
              // Keep using the old UI's localStorage history rather than the input_history database:
              // synchronously persist before the real send, then restore the pre-send snapshot if sending fails.
              persistPromptHistoryEntries(workspacePath, promptHistoryAfterAppend);
              promptHistoryWasPersisted = true;
              setPromptHistory(promptHistoryAfterAppend);
            }
          }
          // Keep the ordinary editor visible until the send is accepted. Worktree-queued sends
          // have already claimed and cleared it so the user can start another draft during Git setup.
          claimSubmittedDraft(false);
          if (requestedDelivery === "startNow" && contentRevisionRef.current === cleanupRevision) {
            // Atomic takeover waits for the old turn to exit and the new TurnStarted ACK to commit.
            // If the editor also waits for the full flow before clearing, the user may think the shortcut did nothing.
            // Clear visible text first; if the command is rejected, restore the frozen editor state exactly.
            inputApiRef.current?.clear();
            updateText("");
            cleanupRevision = contentRevisionRef.current;
            editorClearedOptimistically = true;
          }
          const sendResult = await onSendText(promptText, {
            ...(frozenFirstSubmission ? { firstSubmissionId: submissionId } : {}),
            ...(reservedSubmissionSessionId ? { reservedSubmissionSessionId } : {}),
            ...(retryFirstSubmission?.commandId
              ? { originalCommandId: retryFirstSubmission.commandId }
              : {}),
            submittedDraftText: submittedDraft.text,
            submission,
            onCommandCreated: subscribeToCommandResolution,
            ...(executionWorktree ? { executionWorktree } : {}),
            ...(incognito ? { incognito } : {}),
            ...(preparedSessionId ? { preparedSessionId, preparedAttemptId } : {}),
            ...(currentConversationSelections.length
              ? {
                  conversationQuotes: currentConversationSelections.map(
                    ({ text, path, senderName, senderId, messageId, sentAt }) => ({
                      text,
                      path,
                      senderName,
                      senderId,
                      messageId,
                      sentAt,
                    }),
                  ),
                }
              : {}),
            telemetrySeed,
            ...(requestedDelivery ? { requestedDelivery } : {}),
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
            ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
            ...((executionWorktree || incognito) && submittedAttachmentIds.length > 0
              ? {
                  reuploadAttachmentsForSession: (targetSessionId: string) =>
                    submittedAttachments.reuploadForSession(
                      targetSessionId,
                      submittedAttachmentIds,
                    ),
                }
              : {}),
            ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
            ...(submittedShareContextId
              ? {
                  sharedContextRefs: [
                    {
                      kind: "shared_context_import" as const,
                      context_id: submittedShareContextId,
                    },
                  ],
                }
              : {}),
          }).catch((error: unknown) => {
            sendTextFailureShown = true;
            throw error;
          });
          if (sendResult === "blocked") {
            if (telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
            // A product guard is a normal rejection and should not use the exception path. Roll back history staged before sending,
            // but keep the editor/draft/attachments so the user can switch modes and retry directly.
            rollbackPromptHistory();
            restoreSubmittedDraft();
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: sessionId ?? null,
              status: "fail",
              reasonCode: "blocked",
            });
            sendAction.reject({ resultSource: "authority_ack", admissionResult: "rejected" });
            return;
          }
          if (sendResult === "confirmationRequired") {
            if (telemetrySeed.localTtft)
              getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, true);
            rollbackPromptHistory();
            restoreSubmittedDraft();
            const latestQueueItemIds =
              snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
            // Freeze the current queue on first submit; if it goes stale across clients, replace it with the latest projection and ask the user to confirm again.
            setHeldQueueConfirmation({
              // Mark queueConfirmed; after confirmation, reuse this seed for finalization so send_cost_ms includes time spent in the dialog.
              telemetrySeed: { ...telemetrySeed, queueConfirmed: true },
              ...(requestedDelivery ? { requestedDelivery } : {}),
              queueItemIds:
                latestQueueItemIds.length > 0 ? latestQueueItemIds : submittedQueueItemIds,
            });
            sendAction.noop();
            return;
          }
          if (sendResult === "alreadyAdmitted" && frozenFirstSubmission) {
            // The Host already admitted this submission's frozen input under its original command id
            // (no new sendText was sent). The copy stays outstanding under that id until the real row
            // projects; the record keeps the id it was retried with, never a new one (FSL rule 4).
            try {
              updateV4FirstSubmission(workspacePath, workspaceIdentity, submissionId, {
                status: "sending",
                ...(retryFirstSubmission?.commandId
                  ? { commandId: retryFirstSubmission.commandId }
                  : {}),
              });
            } catch (error) {
              logger.warn(
                "[v4-composer] could not persist the admitted first-submission outcome",
                error,
              );
            }
          }
          if (reservedSubmissionSessionId) {
            // Fallback for a bind that could not run at the reservation moment (draft-storage
            // failure, or the navigation gate while the user was away): retry after admission,
            // when the pane may have returned to this draft. The owner race that used to forbid
            // promoting before admission is gone — the draft was claimed at freeze.
            bindReservedSessionRecord();
          }
          if (incognitoSubmission) {
            // The session now owns the frozen profile; the next draft starts normal again — unless
            // a newer draft re-armed or changed the intent while this send was in flight.
            useDraftIncognitoIntentStore
              .getState()
              .releaseAfterSend(workspaceKey, incognitoSubmission.generation);
          }
          if (executionWorktree) {
            // Setup pipeline terminal success: this worktree result is consumed by exactly this session.
            useComposerWorktreePipelineStore
              .getState()
              .consume(
                workspaceKey,
                preparedSessionId ?? preparedSessionIdForSend,
                preparedAttemptId,
              );
          }
          setHeldQueueConfirmation(null);
          // Settle the captured content (idempotent with the command-resolution subscription).
          await settleSubmittedContent();
          sendAction.complete({ resultSource: "authority_ack", admissionResult: "accepted" });
        } catch (error) {
          rollbackPromptHistory();
          // ACK-side failures may settle first; a settled submission must not restore its text again.
          if (!submittedContentSettled) restoreSubmittedDraft();
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
          // On failure, keep the draft in the input (do not clear it) and record only the reason.
          logger.warn(`[v4-composer] 发送失败: ${String(error)}`);
          // The restored text is the only trace of a failed send when no record was kept (the
          // reservation never landed). Say so, otherwise the user sees an unchanged composer.
          // A failure thrown by onSendText is already announced by the pane banner; only a failure in
          // the composer flow itself (no banner) gets this notice.
          if (!submittedContentSettled && !sendTextFailureShown)
            toast(intl.formatMessage({ id: "chat.error.sendFailed" }));
          // SessionPane already finalizes ACK-side failures; reaching this point means Composer's own flow failed.
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "composer_error",
          });
          sendAction.fail({ failureStage: "composer_send" });
        } finally {
          // The active-first-submission flag is NOT cleared here (flag lifetime table in the
          // instant-UX spec): SessionPane clears it when the real user row is projected, and
          // restore paths clear it on failure — a chain that ends between the two would flash
          // the composer back into the locked-looking state.
          releasePending();
        }
      };
      if (queueWorktreeSend) {
        const recoveryDraft: Omit<V4ComposerDraft, "updatedAt"> = {
          ...composerDraft,
          ...submittedDraft,
          ...(frozenFirstSubmission ? { firstSubmission: frozenFirstSubmission } : {}),
          ...(submittedRecoveryContexts ? { recoveryContexts: submittedRecoveryContexts } : {}),
          recoveryAttachments: buildV4RecoveryAttachmentsManifest(attachmentsApi.attachments, {
            persistPathMetadata: !workspaceIdentity?.trim(),
          }),
        };
        const recoverySaved = persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          pendingRecoveryScope,
          recoveryDraft,
        );
        if (!recoverySaved) {
          withdrawUnreservedSubmission();
          toast(intl.formatMessage({ id: "composerRecovery.storageUnavailable" }));
          return;
        }
        claimSubmittedDraft();
        if (!onPrepareWorktreeSession || (!worktreeIntent && !preparedSessionIdForSend)) {
          if (preparedSessionIdForSend) restoreSubmittedDraft();
          else withdrawUnreservedSubmission();
          useComposerWorktreePipelineStore
            .getState()
            .markValidationFailed(workspaceKey, "Worktree session preparation is unavailable");
          return;
        }
        const prepareOwnedSession = (params: ComposerWorktreePreparationParams) =>
          onPrepareWorktreeSession(params, { shouldActivate: shouldActivatePreparedSession });
        queuedSubmissionIdRef.current = submissionId;
        setWorktreeQueued(true);
        const currentPipeline = selectComposerWorktreePipeline(
          useComposerWorktreePipelineStore.getState(),
          workspaceKey,
          sessionId,
        );
        if (
          currentPipeline?.status === "ready" &&
          preparedSessionIdForSend &&
          currentPipeline.worktreePath &&
          currentPipeline.params
        ) {
          clearQueuedSubmissionState();
          pendingWorktreeSendRef.current = null;
          await runSend(
            { path: currentPipeline.worktreePath, branchName: currentPipeline.params.branchName },
            preparedSessionIdForSend,
            currentPipeline.params.attemptId,
          );
          return;
        }
        if (!preparedSessionIdForSend || currentPipeline?.status !== "creating") {
          const reservation = { epoch: renderedOwnerRef.current.epoch, id: submissionId };
          reservingWorktreeRef.current = reservation;
          let begin;
          try {
            const preparation = snapshotRef.current?.meta.worktreePreparation;
            begin =
              preparedSessionIdForSend && preparation && baseWorkspaceServices
                ? await restartPreparedWorktreeCreation({
                    workspaceKey,
                    workspacePath,
                    ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    sessionId: preparedSessionIdForSend,
                    preparation,
                    gitService: baseWorkspaceServices.gitService,
                    prepareSession: prepareOwnedSession,
                    syncPreparedWorktree: onSyncWorktreePreparation,
                    submissionId,
                    formatMessage: (id, values) => intl.formatMessage({ id }, values),
                  })
                : await worktreeIntent!.beginCreation(
                    trimmed,
                    prepareOwnedSession,
                    onSyncWorktreePreparation,
                    submissionId,
                  );
          } catch (error) {
            logger.warn("[WorktreePipeline] Preparation reservation failed", error);
            if (reservingWorktreeRef.current === reservation) setWorktreeQueued(false);
            restoreSubmittedDraft();
            return;
          } finally {
            if (reservingWorktreeRef.current === reservation) reservingWorktreeRef.current = null;
          }
          if (!begin.ok) {
            setWorktreeQueued(false);
            withdrawUnreservedSubmission();
            return;
          }
          preparedSessionIdForSend = begin.sessionId;
        }
        const pendingRecoveryDraft = readV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          pendingRecoveryScope,
        );
        if (pendingRecoveryDraft) {
          const persisted = moveV4ComposerDraft(
            workspacePath,
            workspaceIdentity,
            pendingRecoveryScope,
            getV4WorktreeRecoveryScope(preparedSessionIdForSend, submissionId),
          );
          if (!persisted) {
            setWorktreeQueued(false);
            restoreSubmittedDraft();
            toast(intl.formatMessage({ id: "composerRecovery.storageUnavailable" }));
            return;
          }
        }
        // The queued draft is already claimed (editor cleared), so later content revisions are the
        // editor's own clear echo or the user's next draft — neither changes submission ownership
        // (specs/first-submission-lifecycle.md rule 7: composing the next draft while preparation
        // proceeds must not withdraw the queued submission). Only owner identity decides.
        const queueOwnerCurrent = isComposerSubmissionOwnerCurrent(
          { ...submittedOwner, revision: 0 },
          { ...renderedOwnerRef.current, revision: 0 },
        );
        if (
          !queueOwnerCurrent &&
          !(
            renderedOwnerRef.current.workspaceKey === workspaceKey &&
            renderedOwnerRef.current.scopeId === preparedSessionIdForSend
          )
        ) {
          setWorktreeQueued(false);
          restoreSubmittedDraft();
          return;
        }
        // Worktree send acceptance: every failure check above has passed, so the send is committed.
        // The worktree creation keeps the base it captured at registration (its pipeline params
        // carry baseBranch), and the draft's base intent is consumed here, the worktree-mode
        // counterpart of applyDraftBranchIntentForSend's checkout success clear. Failures before this
        // point restore the draft with its base intent intact.
        if (draftMode && sessionId === null)
          useDraftBranchIntentStore.getState().clearDraftBranchIntent(workspaceKey);
        const joinedPipeline = selectComposerWorktreePipeline(
          useComposerWorktreePipelineStore.getState(),
          workspaceKey,
          preparedSessionIdForSend,
        );
        if (
          joinedPipeline?.status === "ready" &&
          joinedPipeline.worktreePath &&
          joinedPipeline.params
        ) {
          // A repeat of this submission can find its own pipeline already ready. Dispatch immediately: no store transition will
          // re-run the queued-send effect, so arming the ref would strand the claimed submission
          // with the editor already cleared and no recovery card in the current view.
          clearQueuedSubmissionState();
          pendingWorktreeSendRef.current = null;
          await runSend(
            { path: joinedPipeline.worktreePath, branchName: joinedPipeline.params.branchName },
            preparedSessionIdForSend,
            joinedPipeline.params.attemptId,
          );
          return;
        }
        submittedAttachments.moveToScope?.(`${workspaceKey}\0${preparedSessionIdForSend}`);
        const armedContinuation: ArmedWorktreeSendContinuation = {
          workspaceKey,
          preparedSessionId: preparedSessionIdForSend,
          hasBoundPreparedSession: renderedOwnerRef.current.scopeId === preparedSessionIdForSend,
          attemptId: selectComposerWorktreePipeline(
            useComposerWorktreePipelineStore.getState(),
            workspaceKey,
            preparedSessionIdForSend,
          )?.params?.attemptId,
          dispatch: runSend,
          restore: restoreSubmittedDraft,
          restoreForRetry,
        };
        // The authoritative armed continuation lives in the module-scope registry (not this
        // instance's ref): the first-send view promotion can unmount this composer and mount the
        // prepared session's composer as another instance, which adopts it from the registry
        // (BUG-GWT-005 live path).
        armWorktreeSendContinuation(armedContinuation);
        pendingWorktreeSendRef.current = armedContinuation;
        return;
      }
      await runSend(
        executionWorktree,
        preparedSessionIdForSend,
        selectComposerWorktreePipeline(
          useComposerWorktreePipelineStore.getState(),
          workspaceKey,
          preparedSessionIdForSend,
        )?.params?.attemptId,
      );
    },
    [
      attachmentsApi,
      attachmentsReady,
      baseWorkspaceServices,
      branchSwitchGuard,
      conversationSelectionReferences,
      conversationTelemetry,
      draftConfig,
      composerDraft,
      draftMode,
      createSubmissionFromComposer,
      submissionReady,
      remoteAvailable,
      runtimeBlocked,
      getCodeCommentContexts,
      telemetryDraftConfig,
      modelSelectionView,
      modelSelectionSettled,
      intl,
      onPrepareWorktreeSession,
      onSyncWorktreePreparation,
      onSendText,
      onPrepareFirstSubmission,
      onFirstSubmissionReserved,
      durableFirstSubmission,
      draftGeneration,
      activeShareContextId,
      provider,
      readPlanIdentitySnapshot,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeWebElementContext,
      removePluginUiContext,
      pluginUiContexts,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      updateComposerContent,
      webElementContexts,
      worktreeIntentSlot,
      worktreeIntentActive,
      pptxElementReferences,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  // One restore implementation shared by the recovery card's Restore and the return-to-draft
  // auto-restore (spec §Return to draft on failure): composer content, editor state, frozen
  // contexts (replaced, never merged), and the worktree intent that re-arms Retry/Change.
  const applyWorktreeRecoveryDraft = useCallback(
    (draft: V4ComposerDraft) => {
      retryFirstSubmissionRef.current = draft.firstSubmission;
      // The frozen plan state and mode are part of the submission (spec scenario 22), so they
      // replace the live values; updateComposerContent would keep the current plan/mode.
      replaceComposerDraft({
        ...composerDraft,
        text: draft.text,
        editorStateJson: draft.editorStateJson,
        mention: draft.mention,
        mode: draft.mode ?? composerDraft.mode,
        modelSelection: draft.modelSelection ?? composerDraft.modelSelection,
        firstSubmission: draft.firstSubmission,
        planEnabled: draft.planEnabled ?? composerDraft.planEnabled,
      });
      if (draft.editorStateJson) inputApiRef.current?.setEditorStateJson(draft.editorStateJson);
      else inputApiRef.current?.setText(draft.text);
      updateText(draft.text);
      clearConversationSelectionReferences();
      clearCodeCommentContexts();
      clearWebElementContexts();
      clearPptxElementReferences();
      clearPluginUiContexts();
      // Restore re-establishes exactly the frozen submission: the next draft's contexts are
      // replaced, never merged, and the frozen contexts return through the normal add paths.
      const restoredContextId = draft.recoveryContexts?.sharedContextRefs?.[0]?.context_id;
      setRestoredShareContext(
        restoredContextId ? { scopeId: draftScopeId, contextId: restoredContextId } : null,
      );
      restoreComposerRecoveryContexts(draft.recoveryContexts, {
        sessionId,
        workspaceKey,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (draft.worktreeIntent) applyPersistedWorktreeIntent(workspaceKey, draft.worktreeIntent);
    },
    [
      clearCodeCommentContexts,
      clearConversationSelectionReferences,
      clearPluginUiContexts,
      clearPptxElementReferences,
      clearWebElementContexts,
      composerDraft,
      draftScopeId,
      replaceComposerDraft,
      sessionId,
      updateText,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  // Frozen destination persistence (spec §Return to draft on failure, "Restored intent survives
  // reload"). The draft store is the store's mirror, not a second owner: the in-memory frozen
  // destination wins while mounted, and the root draft's `worktreeIntent` is hydrated only once per
  // mount so a released destination is not re-armed from the stale mirror.
  const frozenWorktreeDestination = useDraftBranchIntentStore(
    (state) => state.frozenWorktreeIntentByWorkspaceKey[workspaceKey],
  );
  const draftBranchBase = useDraftBranchIntentStore(
    (state) => state.intentByWorkspaceKey[workspaceKey],
  );
  const hydratedWorktreeIntentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (draftScopeId !== V4_DRAFT_SCOPE_ROOT) return;
    const hydrationKey = `${workspaceKey}\0${draftScopeId}`;
    const persisted = composerDraft.worktreeIntent;
    if (hydratedWorktreeIntentKeyRef.current !== hydrationKey) {
      hydratedWorktreeIntentKeyRef.current = hydrationKey;
      if (
        persisted &&
        !useDraftBranchIntentStore.getState().frozenWorktreeIntentByWorkspaceKey[workspaceKey]
      ) {
        applyPersistedWorktreeIntent(workspaceKey, persisted);
        return;
      }
    }
    const desired = selectPersistableWorktreeIntent(
      useDraftBranchIntentStore.getState(),
      workspaceKey,
    );
    if (!isSamePersistedWorktreeIntent(desired, persisted)) {
      replaceComposerDraft({ ...composerDraft, worktreeIntent: desired });
    }
  }, [
    composerDraft,
    draftBranchBase,
    draftScopeId,
    frozenWorktreeDestination,
    replaceComposerDraft,
    workspaceKey,
  ]);

  // ── Return-to-draft requests (workspace-scoped store; spec §Return to draft on failure) ──
  // The failure hand-off moves the frozen submission into the draft pending recovery scope and
  // bumps a restore request; the mounted draft composer consumes it by performing exactly the
  // card's Restore. A non-empty draft is never overwritten — the card stays and the modal says
  // the message is saved (spec decision 2).
  const failureReturnRestoreRequest = useWorktreeFailureReturnStore(
    (state) => state.restoreRequestByWorkspaceKey[workspaceKey],
  );
  const failureReturnRestoreScope = useWorktreeFailureReturnStore(
    (state) => state.restoreScopeByWorkspaceKey[workspaceKey],
  );
  const failureReturnSubmitRequest = useWorktreeFailureReturnStore(
    (state) => state.submitRequestByWorkspaceKey[workspaceKey],
  );
  const appliedFailureReturnRestoreRef = useRef(0);
  const appliedFailureReturnSubmitRef = useRef(0);
  const failureReturnDraftOccupiedRef = useRef<() => boolean>(() => false);
  failureReturnDraftOccupiedRef.current = () =>
    hasDraftToSubmit || pending || worktreeQueued || attachmentsApi.attachments.length > 0;

  useEffect(() => {
    if (sessionId !== null || !failureReturnRestoreRequest) return;
    if (appliedFailureReturnRestoreRef.current >= failureReturnRestoreRequest) return;
    appliedFailureReturnRestoreRef.current = failureReturnRestoreRequest;
    // The scope-switch draft restore is queued on the next animation frame and would overwrite a
    // restore applied now. Apply this restore in a later frame. It is not cancelled by effect
    // cleanup: the applied ref is already set, so a cancelled frame would never be retried.
    const restore = () => {
      useWorktreeFailureReturnStore.getState().consumeDraftRestoreRequest(workspaceKey);
      // The request names the failed submission's recovery scope. Never fall back to another pending
      // record: the oldest one may belong to an earlier failure, and this failure would stay stranded.
      if (!failureReturnRestoreScope) return;
      const savedDraft = readV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        failureReturnRestoreScope,
      );
      if (!savedDraft) return;
      const saved = { scope: failureReturnRestoreScope, draft: savedDraft };
      rehydrateComposerRecoveryAttachments({
        workspaceKey,
        recoveryScope: saved.scope,
        manifest: saved.draft.recoveryAttachments ?? [],
      });
      if (failureReturnDraftOccupiedRef.current()) {
        // The draft filled after the hand-off's draftEmpty check. The record stays on the recovery
        // card, so the modal must not keep Retry (it would submit the newer draft).
        useWorktreeFailureReturnStore.getState().markFailureSavedNotRestored(workspaceKey);
        return;
      }
      moveComposerAttachmentScopeItems(
        `${workspaceKey}\0${saved.scope}`,
        `${workspaceKey}\0${V4_DRAFT_SCOPE_ROOT}`,
        (saved.draft.recoveryAttachments ?? []).map((item) => item.id),
      );
      applyWorktreeRecoveryDraft(saved.draft);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, saved.scope);
    };
    if (typeof requestAnimationFrame !== "function") {
      restore();
      return;
    }
    requestAnimationFrame(restore);
  }, [
    applyWorktreeRecoveryDraft,
    failureReturnRestoreRequest,
    failureReturnRestoreScope,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
  ]);

  // Retry from the recovery card for a failed first submission (specs/first-submission-instant-ux.md,
  // Retry surface): restore the frozen record, then run the ordinary submit over it on the next
  // render, when the restored text/attachments are committed. The record moves to this composer's
  // own recovery scope for that submissionId so the retry freeze overwrites it in place: one record
  // per submission, and the optimistic turn never blinks.
  const [recoveryRetryRequest, setRecoveryRetryRequest] = useState(0);
  const appliedRecoveryRetryRef = useRef(0);
  const retryBlockedRef = useRef(false);
  retryBlockedRef.current = retryBlockReason !== null;
  const retryWorktreeRecoveryDraft = useCallback(
    (draft: V4ComposerDraft, recoveryScope: string) => {
      const submissionId = draft.firstSubmission?.submissionId;
      if (!submissionId) return;
      // Same predicate as submit(): a blocked Retry must not restore into the editor, or the card
      // would then report the editor as occupied and lock itself.
      if (retryBlockedRef.current) return;
      const ownScope = getV4WorktreeRecoveryScope(draftScopeId, submissionId);
      if (
        recoveryScope !== ownScope &&
        !moveV4ComposerDraft(workspacePath, workspaceIdentity, recoveryScope, ownScope)
      ) {
        toast(intl.formatMessage({ id: "composerRecovery.storageUnavailable" }));
        return;
      }
      applyWorktreeRecoveryDraft(draft);
      setRecoveryRetryRequest((request) => request + 1);
    },
    [applyWorktreeRecoveryDraft, draftScopeId, intl, workspaceIdentity, workspacePath],
  );
  // Remove (specs/first-submission-instant-ux.md, Retry surface): the frozen text returns to the
  // editor and the record is deleted — locally only, never a Host cancel or delete. A reserved
  // record keeps `firstSubmission` on this composer's draft so the next Send still activates the
  // prepared session; an unresolved command id goes to the unsettled ledger so its authoritative
  // acceptance clears the unedited editor instead of inviting a duplicate.
  const removedSettlementRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      removedSettlementRef.current?.();
      removedSettlementRef.current = null;
    },
    [draftScopeId, workspaceKey],
  );
  const removeFirstSubmissionRecord = useCallback(
    (draft: V4ComposerDraft, recoveryScope: string) => {
      const pending = draft.firstSubmission;
      if (!pending) return;
      // An unresolved outcome is always held (the copy must stay unsendable until decided), even
      // for an unreserved draft record; a decided one keeps only a reservation worth reusing.
      const keepReservation = Boolean(
        pending.reservation ||
        sessionId !== null ||
        pending.status === "sending" ||
        pending.status === "unknown",
      );
      applyWorktreeRecoveryDraft(
        keepReservation ? draft : { ...draft, firstSubmission: undefined },
      );
      if (!keepReservation) retryFirstSubmissionRef.current = undefined;
      clearV4ComposerDraft(workspacePath, workspaceIdentity, recoveryScope);
      if (pending.commandId && (pending.status === "sending" || pending.status === "unknown")) {
        const scopeKey = `${workspaceKey}\0${draftScopeId}`;
        trackUnsettledComposerSubmission(scopeKey, {
          commandId: pending.commandId,
          text: draft.text,
        });
        const restoredRevision = contentRevisionRef.current;
        removedSettlementRef.current?.();
        removedSettlementRef.current = subscribeComposerSubmissionSettled(scopeKey, (settled) => {
          // The original was admitted: the frozen submission is done even if the copy was edited
          // or unlocked, so the next message must not reuse its id through the Retry path.
          const current = composerDraftRef.current?.firstSubmission;
          const done = current?.commandId === settled.commandId;
          if (done && retryFirstSubmissionRef.current?.commandId === settled.commandId)
            retryFirstSubmissionRef.current = undefined;
          const unedited =
            settled.text === draft.text && contentRevisionRef.current === restoredRevision;
          if (unedited) {
            inputApiRef.current?.clear();
            updateText("");
          }
          if (unedited || done)
            updateComposerContent({
              text: unedited ? "" : textRef.current,
              ...(done ? { firstSubmission: undefined } : {}),
            });
        });
      }
    },
    [
      applyWorktreeRecoveryDraft,
      draftScopeId,
      sessionId,
      updateComposerContent,
      updateText,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  // Remove hold: a restored submission whose sendText outcome is still undecided stays unsendable
  // until an authoritative acceptance (the copy is dropped from the submission, and the ledger
  // clears an unedited editor) or a failed/discarded decision (it becomes an ordinary Retry). The
  // decision arrives through the command registry: a live ACK/projection, or the pane's
  // reconciliation result (specs/first-submission-instant-ux.md, Reconciliation).
  const composerDraftRef = useRef(composerDraft);
  composerDraftRef.current = composerDraft;
  const heldCommandId = heldOutcomeUnresolved ? heldFirstSubmission?.commandId : undefined;
  const [heldResubscribe, setHeldResubscribe] = useState(0);
  useEffect(() => {
    if (!heldCommandId) return;
    return pendingCommandRegistry.subscribeResolution(heldCommandId, (resolution) => {
      const held = composerDraftRef.current?.firstSubmission;
      if (held?.commandId !== heldCommandId) return;
      // The registry drops its listeners after a notification; an "unknown" keeps the hold.
      if (resolution === "unknown") {
        setHeldResubscribe((value) => value + 1);
        return;
      }
      const decided =
        resolution === "accepted" || resolution === "duplicate" || resolution === "authoritative"
          ? undefined
          : { ...held, status: "failed" as const };
      retryFirstSubmissionRef.current = decided;
      updateComposerContent({ text: textRef.current, firstSubmission: decided });
    });
  }, [heldCommandId, heldResubscribe, updateComposerContent]);
  // Unlock (specs/first-submission-instant-ux.md, Remove): a held copy whose outcome may never be
  // decided must not leave the composer dead. Only an explicit, confirmed click turns it into an
  // ordinary Retry of the same submission; it never sends by itself, and the ledger still clears
  // the unedited copy if the original turns out accepted before the user sends.
  const [heldUnlockConfirmOpen, setHeldUnlockConfirmOpen] = useState(false);
  useEffect(() => setHeldUnlockConfirmOpen(false), [heldCommandId]);
  const heldUnlockWarningId = useId();
  const heldUnlockButtonRef = useRef<HTMLButtonElement | null>(null);
  const heldUnlockConfirmRef = useRef<HTMLButtonElement | null>(null);
  const heldUnlockFocusReturnRef = useRef(false);
  useEffect(() => {
    // Focus follows the confirmation: onto Unlock sending when it opens, back to the trigger
    // when it is cancelled.
    if (heldUnlockConfirmOpen) heldUnlockConfirmRef.current?.focus();
    else if (heldUnlockFocusReturnRef.current) {
      heldUnlockFocusReturnRef.current = false;
      heldUnlockButtonRef.current?.focus();
    }
  }, [heldUnlockConfirmOpen]);
  const unlockHeldFirstSubmission = useCallback(() => {
    const held = composerDraftRef.current?.firstSubmission;
    setHeldUnlockConfirmOpen(false);
    if (!held || (held.status !== "sending" && held.status !== "unknown")) return;
    const unlocked = { ...held, status: "failed" as const };
    retryFirstSubmissionRef.current = unlocked;
    updateComposerContent({ text: textRef.current, firstSubmission: unlocked });
  }, [updateComposerContent]);
  useEffect(() => {
    if (recoveryRetryRequest <= appliedRecoveryRetryRef.current) return;
    appliedRecoveryRetryRef.current = recoveryRetryRequest;
    void submit();
  }, [recoveryRetryRequest, submit]);

  // "Retry" from the failure modal: run the ordinary submit over the restored submission — no
  // second dispatch path. The submit waits for any pending restore request to land first, so the
  // idempotency guard and the double-action protections of submit() apply unchanged.
  useEffect(() => {
    if (sessionId !== null || !failureReturnSubmitRequest) return;
    if (appliedFailureReturnSubmitRef.current >= failureReturnSubmitRequest) return;
    if (useWorktreeFailureReturnStore.getState().restoreRequestByWorkspaceKey[workspaceKey]) {
      return;
    }
    appliedFailureReturnSubmitRef.current = failureReturnSubmitRequest;
    useWorktreeFailureReturnStore.getState().consumeDraftSubmitRequest(workspaceKey);
    void submit();
  }, [failureReturnSubmitRequest, sessionId, submit, workspaceKey]);

  // Lexical onChange (the first character is also reported reliably; see LexicalChatInput.TextContentPlugin).
  // Lexical onChange（首字符也稳定回传，见 LexicalChatInput.TextContentPlugin）。
  // The only writer that drops the draft branch intent: the user emptying a non-empty draft
  // (spec §1). Programmatic editor updates (send claim, restore, replace) are reported with
  // `programmatic: true` and never clear it; a successful send consumes the intent separately.
  const handleEditorChange = useCallback(
    (value: string, meta?: { programmatic: boolean }) => {
      // An absent flag means a direct call, which is typing as far as the draft is concerned.
      const userEmptiedDraft =
        meta?.programmatic !== true &&
        value.trim().length === 0 &&
        textRef.current.trim().length > 0;
      suppressDraftPersistRef.current = false;
      conversationTelemetry?.recordComposerTextChange(value);
      updateText(value);
      if (userEmptiedDraft && draftMode && sessionId === null) {
        useDraftBranchIntentStore.getState().clearDraftBranchIntent(workspaceKey);
      }
      // 正文先进入与 mode/model 相同的内存 Draft；防抖只负责补充最新 Lexical JSON。
      updateComposerContent({ text: value });
      scheduleDraftPersist();
    },
    [
      conversationTelemetry,
      draftMode,
      scheduleDraftPersist,
      sessionId,
      updateComposerContent,
      updateText,
      workspaceKey,
    ],
  );

  const handleEditorFocus = useCallback(() => {
    conversationTelemetry?.recordComposerFocus();
    // 程序性聚焦不算「点击输入框」；标记一次性消费，之后的手动 focus 照常上报。
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    conversationTelemetry?.recordComposerFocusClick({
      sessionId: sessionId ?? null,
    });
  }, [conversationTelemetry, sessionId]);

  // 编辑器提交（Enter / 发送键 form submit 同路径）。返回 false：编辑器不自行 reset，
  // 由 submit 成功后经 inputApiRef.clear() 清空——失败时草稿留在输入框。
  const handleEditorSubmit = useCallback(
    (value: string) => {
      textRef.current = value;
      const reverseDelivery = reversePointerDeliveryRef.current;
      reversePointerDeliveryRef.current = false;
      const followupMode = snapshotRef.current?.config.followupMode;
      void submit(
        undefined,
        undefined,
        undefined,
        reverseDelivery && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleModifiedEditorSubmit = useCallback(
    (value: string) => {
      const followupMode = snapshotRef.current?.config.followupMode;
      textRef.current = value;
      // inputRouting 在 turn 启动初期可能仍为 startNow，不能用它
      // 推断空闲。组合键始终表达单次反向 delivery；空闲时 CLI 自然 startNow。
      void submit(
        undefined,
        undefined,
        undefined,
        followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleClearQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "clearQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleKeepQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "keepQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleStopClick = useCallback(() => {
    runUserAction({
      input: { featureId: "conversation.composer.message", action: "stop", trigger: "button" },
      operation: onStop,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "stop_generation",
    });
  }, [onStop]);

  // 发送键是 type="submit"，与 Enter 共用 handleEditorSubmit；DOM 事件顺序保证 click 早于
  // submit，故这里只置标记，由 submit() 读取并复位。
  const handleSendButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      sendTriggerRef.current = "button";
      reversePointerDeliveryRef.current = shouldReverseFollowupDeliveryForPointer({
        enabled: modifiedEnterReversesDelivery,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isApplePlatform: appleKeyboardPlatform,
      });
    },
    [appleKeyboardPlatform, modifiedEnterReversesDelivery],
  );

  // ── 「加入对话」全局事件（workspace file tree 右键/按钮）→ mention 插入 ──
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleWorkspaceFileAddToChat = (event: Event) => {
      if (!isWorkspaceFileAddToChatEvent(event)) {
        return;
      }
      event.preventDefault();
      appendWorkspaceFileMentionToComposer({
        inputApiRef,
        currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
        payload: event.detail,
        workspacePath,
        workspaceIdentity,
        onTextChange: updateText,
      });
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    };
  }, [listenAddToChatEvents, updateText, workspaceIdentity, workspacePath]);

  // 动态 placeholder（旧 chatViewPlaceholder 语义）：无历史 → newTask；
  // 有历史空闲 → followUpAsk；有历史处理中 → followUpQueue。
  const normalPlaceholder = intl.formatMessage({
    id: resolveChatPlaceholderKey({
      hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
      isTaskProcessing: canStop,
      compactNewTask: compactMobilePlaceholder,
    }),
  });
  const sendTooltipTitle = intl.formatMessage({
    id: mode === "enqueue" ? "chat.queue.enqueue" : "chat.send",
  });
  const modifierTooltip = resolveFollowupModifierTooltip({
    enabled: modifiedEnterReversesDelivery,
    canSend,
    modifierPressed: primaryModifierPressed,
    followupMode: snapshot?.config.followupMode,
    isApplePlatform: appleKeyboardPlatform,
  });
  const resolvedSendTooltipTitle = modifierTooltip
    ? intl.formatMessage({ id: modifierTooltip.titleId })
    : sendTooltipTitle;
  const resolvedSendTooltipShortcut = modifierTooltip?.shortcut ?? sendShortcut;
  const stopTooltipTitle = intl.formatMessage({ id: "chat.stop" });
  const visibleError = error && !shouldSuppressChatErrorBanner(error) ? error : null;

  useEffect(() => {
    if (!visibleError || !conversationTelemetry || !telemetryVisible) return;
    const telemetryKey = [
      visibleError.taskId ?? sessionId ?? "",
      visibleError.code ?? "",
      visibleError.traceId ?? "",
      visibleError.message,
    ].join(":");
    if (reportedErrorKeysRef.current.has(telemetryKey)) return;
    reportedErrorKeysRef.current.add(telemetryKey);
    // 错误只有经过 suppression 后真实进入 render 才曝光；同一 composer mount 相同 key 一次。
    conversationTelemetry.reportVisibleChatError({
      errorKey: telemetryKey,
      displayMessage: resolveChatErrorBannerDisplayMessage(visibleError, intl),
      error: visibleError,
    });
  }, [conversationTelemetry, intl, sessionId, telemetryVisible, visibleError]);

  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      menuItemTestId: TID_CHAT_ATTACHMENT_MENU_ITEM,
      onSelect: () =>
        runUserAction({
          input: {
            featureId: "conversation.composer.attachment",
            action: "add",
            trigger: "button",
          },
          operation: attachmentsApi.openAttachmentPicker,
          completed: { resultSource: "local_commit" },
          failureStage: "attachment_picker",
        }),
      testId: TID_CHAT_ATTACHMENT_BUTTON,
    }),
    [intl, attachmentsApi.openAttachmentPicker],
  );

  // ── 附件预览网格 ──
  const composerAttachments = attachmentsApi.attachments;
  const orderedComposerAttachments = useMemo(() => {
    // 媒体组（图片/视频）优先、文件在后；组内保持添加顺序。
    const media: (typeof composerAttachments)[number][] = [];
    const files: (typeof composerAttachments)[number][] = [];
    for (const attachment of composerAttachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [composerAttachments]);
  const composerMediaPreviewItems = useMemo(
    () =>
      composerAttachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [composerAttachments],
  );
  const topContentNode = useMemo(() => {
    if (
      composerAttachments.length === 0 &&
      codeCommentContexts.length === 0 &&
      webElementContexts.length === 0 &&
      pptxElementReferences.length === 0 &&
      conversationSelectionReferences.length === 0 &&
      pluginUiContexts.length === 0
    ) {
      return null;
    }
    return (
      <div className="flex max-w-full flex-col items-start gap-2">
        {composerAttachments.length > 0 ? (
          <Attachments
            variant="inline"
            className="flex max-w-full flex-wrap gap-2"
            data-composer-file-attachments-row="true"
          >
            {orderedComposerAttachments.map((attachment) => {
              const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
              const isMediaAttachment = isMediaChatComposerAttachment(attachment);
              const isVideoAttachment = isVideoChatComposerAttachment(attachment);
              const isPdfAttachment = isPdfChatComposerAttachment(attachment);
              const mediaType = attachment.objectUrl
                ? attachment.mimeType
                : attachment.mimeType.startsWith("image/")
                  ? "application/octet-stream"
                  : attachment.mimeType;
              const canPreviewImageAttachment =
                Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
              const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
              const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
              const fileDisplayDescriptor = resolveFileDisplayDescriptor(
                attachment.localPath ?? attachment.filename,
              );
              const uploadStatusLabel =
                attachment.uploadStatus === "uploading"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.uploading" },
                      { progress: String(attachment.uploadProgress) },
                    )
                  : attachment.uploadStatus === "failed"
                    ? intl.formatMessage(
                        { id: "chat.attachments.upload.failed" },
                        { message: attachment.uploadError ?? "unknown" },
                      )
                    : intl.formatMessage({
                        id: `chat.attachments.upload.${attachment.uploadStatus}`,
                      });
              const showUploadStatus =
                !attachment.localZeroCopy &&
                (attachment.uploadStatus !== "ready" || attachment.showComplete);
              return (
                <Attachment
                  key={attachment.id}
                  variant={isMediaAttachment ? "grid" : "inline"}
                  data-composer-attachment-kind={
                    isVideoAttachment
                      ? "video"
                      : isMediaAttachment
                        ? "image"
                        : isPdfAttachment
                          ? "pdf"
                          : "file"
                  }
                  data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
                  data-upload-status={attachment.uploadStatus}
                  className={
                    isMediaAttachment
                      ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                      : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
                  }
                  data={{
                    id: attachment.id,
                    type: "file",
                    filename: attachment.filename,
                    ...(isClipboardTextAttachment
                      ? {
                          description: intl.formatMessage(
                            {
                              id: "chat.attachments.clipboardText.description",
                            },
                            {
                              lineCount: formatAttachmentLineCount(attachment, locale),
                            },
                          ),
                          displayName: intl.formatMessage({
                            id: "chat.attachments.clipboardText",
                          }),
                          sourceKind: "clipboard-text" as const,
                        }
                      : {}),
                    mediaType,
                    url: attachment.objectUrl ?? "",
                  }}
                  onRemove={() => attachmentsApi.removeAttachment(attachment.id)}
                  // 附件支持非图片格式，PDF 走独立 PdfViewer，
                  // 其他文件展示类型图标和文件名，避免 doc 等普通文件被当成图片渲染失败。
                  // 图片与视频统一按添加顺序进入发送前 gallery，
                  // 保证同一组媒体可以连续导航。
                  onOpen={
                    canPreviewImageAttachment || canPreviewVideoAttachment
                      ? () => {
                          const previewIndex = composerMediaPreviewItems.findIndex(
                            (item) => item.src === attachment.objectUrl,
                          );
                          if (previewIndex < 0) return;
                          setAttachmentPreviewIndex(previewIndex);
                          setAttachmentPreviewOpen(true);
                        }
                      : canPreviewPdfAttachment
                        ? () => {
                            setPdfAttachmentPreview({
                              filename: attachment.filename,
                              mediaType: "application/pdf",
                              url: attachment.objectUrl,
                            });
                            setPdfAttachmentPreviewOpen(true);
                          }
                        : undefined
                  }
                  openLabel={
                    canPreviewVideoAttachment
                      ? videoAttachmentPreviewTitle
                      : canPreviewImageAttachment
                        ? attachmentPreviewTitle
                        : canPreviewPdfAttachment
                          ? intl.formatMessage({ id: "chat.attachments.preview.openPdf" })
                          : undefined
                  }
                >
                  <div
                    className={cn(
                      "relative shrink-0",
                      isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                    )}
                  >
                    <AttachmentPreview
                      className={cn(
                        isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md",
                      )}
                      fallbackIcon={
                        isClipboardTextAttachment ? (
                          <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                        ) : (
                          <FileDisplayIcon
                            src={fileDisplayDescriptor.fileIconSrc}
                            size={16}
                            className="size-4 shrink-0"
                          />
                        )
                      }
                    />
                    {showUploadStatus && isMediaAttachment ? (
                      <span
                        data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                        role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                        aria-label={uploadStatusLabel}
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-ui-xs font-semibold text-foreground"
                      >
                        <svg
                          aria-hidden="true"
                          className="absolute inset-0 size-full -rotate-90 text-brand"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="stroke-border"
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeWidth="2"
                          />
                          <circle
                            className={
                              attachment.uploadStatus === "failed"
                                ? "stroke-destructive"
                                : "stroke-current"
                            }
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeDasharray={`${attachment.uploadProgress} 100`}
                            strokeLinecap="round"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="relative">
                          {attachment.uploadStatus === "failed"
                            ? "!"
                            : `${attachment.uploadProgress}%`}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {!isMediaAttachment ? (
                    isClipboardTextAttachment ? (
                      <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                    ) : (
                      <div className="min-w-0 max-w-40 flex-1">
                        <span
                          className="block truncate text-ui-base font-medium text-foreground"
                          title={attachment.filename}
                        >
                          {attachment.sourceKind === "topic-history"
                            ? intl.formatMessage(
                                { id: "chat.attachments.topicHistory" },
                                { count: attachment.messageCount ?? 0 },
                              )
                            : attachment.filename}
                        </span>
                        <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                          {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                        </span>
                      </div>
                    )
                  ) : null}
                  {showUploadStatus && !isMediaAttachment ? (
                    <span
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                      role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      title={uploadStatusLabel}
                      className={cn(
                        "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                        attachment.uploadStatus === "failed" && "text-destructive",
                      )}
                    >
                      {attachment.uploadStatus === "uploading"
                        ? `${attachment.uploadProgress}%`
                        : uploadStatusLabel}
                    </span>
                  ) : null}
                  {attachment.uploadStatus === "failed" ? (
                    <button
                      type="button"
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                      aria-label={intl.formatMessage({
                        id: "chat.attachments.upload.retry",
                      })}
                      title={uploadStatusLabel}
                      className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        attachmentsApi.retryAttachment(attachment.id);
                      }}
                    >
                      <RotateCcwIcon className="size-3" />
                    </button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-composer-attachment-remove={attachment.id}
                    aria-label={intl.formatMessage({
                      id: "chat.attachments.remove",
                    })}
                    className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      attachmentsApi.removeAttachment(attachment.id);
                    }}
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Attachment>
              );
            })}
          </Attachments>
        ) : null}
        {codeCommentContexts.length > 0 ||
        webElementContexts.length > 0 ||
        pptxElementReferences.length > 0 ||
        conversationSelectionReferences.length > 0 ||
        pluginUiContexts.length > 0 ? (
          <div
            className="flex max-w-full flex-wrap items-center gap-2"
            data-composer-context-attachments-row="true"
          >
            <CodeCommentAttachmentChip
              comments={codeCommentContexts}
              onRemove={removeCodeCommentContext}
              onRemoveAll={clearCodeCommentContexts}
            />
            <WebElementContextAttachmentChip
              contexts={webElementContexts}
              onRemove={removeWebElementContext}
              onRemoveAll={clearWebElementContexts}
            />
            <PluginUiModelContextChip
              contexts={pluginUiContexts}
              onRemove={removePluginUiContext}
              onRemoveAll={clearPluginUiContexts}
            />
            <PptxElementReferenceChip
              references={pptxElementReferences}
              onOpen={onOpenCodeViewer ? openPptxElementReference : undefined}
              onRemove={removePptxElementReference}
              onRemoveAll={clearPptxElementReferences}
            />
            <ConversationSelectionReferenceChip
              references={conversationSelectionReferences}
              onRemove={removeConversationSelectionReference}
              onRemoveAll={clearConversationSelectionReferences}
            />
          </div>
        ) : null}
      </div>
    );
  }, [
    attachmentPreviewTitle,
    attachmentsApi,
    clearCodeCommentContexts,
    clearConversationSelectionReferences,
    clearWebElementContexts,
    clearPluginUiContexts,
    clearPptxElementReferences,
    codeCommentContexts,
    composerAttachments,
    composerMediaPreviewItems,
    orderedComposerAttachments,
    intl,
    locale,
    removeCodeCommentContext,
    removeConversationSelectionReference,
    removeWebElementContext,
    removePluginUiContext,
    removePptxElementReference,
    conversationSelectionReferences,
    activeShareContextId,
    webElementContexts,
    pluginUiContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
  ]);

  // 发送/停止控制簇（对齐旧 ChatViewComposer.submitControlNode 结构：
  // 左侧 model/thought/usage 簇 + 右侧 stop 或 send）。
  // useMemo：composer 随流式 snapshot 高频重渲染，控制簇只在语义依赖变化时重建，
  // 避免每个 token 批次都重建 Tooltip/Select 子树。
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModelTrace = useCallback(
    (
      nextProvider: string,
      nextModel: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) =>
      runUserAction({
        input: {
          featureId: "conversation.composer.config",
          action: "change_model",
          trigger: "select",
        },
        operation: () =>
          reasoningLevel === undefined
            ? onSelectModel(nextProvider, nextModel, sourceModel)
            : onSelectModel(nextProvider, nextModel, sourceModel, reasoningLevel),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "model_change",
      }),
    [onSelectModel],
  );
  const submitControlNode = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1">
        {!remoteAvailable ? (
          <span
            data-testid="remote-send-unavailable"
            className="max-w-40 text-right text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage({ id: "remote.conversation.sendUnavailable" })}
          </span>
        ) : null}
        {remoteAvailable ? (
          <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
            <V4ComposerModelControls
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              modelSelectionView={modelSelectionView}
              modelSelectionState={modelSelectionState}
              modelSelectionReload={modelSelectionReload}
              modelSelectionRefresh={modelSelectionRefresh}
              sessionId={sessionId ?? null}
              phase={composerPhase}
              provider={provider}
              isWebRemoteControl={isWebRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              draftMode={draftMode}
              draftConfig={draftConfig}
              usage={composerUsage}
              disabled={disabled || runtimeBlocked}
              modelLocked={highspeedCard !== null}
              highspeedPresented={highspeedPresented}
              highspeedEntranceAnimated={highspeedEntranceAnimated}
              highspeedSweepActive={highspeedSweepActive}
              highspeedExpiresAt={highspeedCard?.expiresAt}
              highspeedModel={highspeedCard?.model}
              activeConfigPicker={activeConfigPicker}
              onConfigPickerOpenChange={handleConfigPickerOpenChange}
              onSelectModel={handleSelectModelTrace}
              onSelectThought={onSelectThought}
              onSwitchMode={onSwitchMode}
              onRecoverCustomModelSelection={onRecoverCustomModelSelection}
              onSendCompressionCommand={onSendCompressionCommand}
            />
          </span>
        ) : null}
        {voiceDictationEnabled ? (
          <V4ComposerDictationControl
            disabled={disabled}
            onTranscript={insertVoiceTranscript}
            onPreviewChange={setVoicePreview}
            scopeRef={voiceScopeRef}
            webRemote={isWebRemoteControl}
          />
        ) : null}
        {showStopControl ? (
          <ControlHintTooltip title={stopTooltipTitle} shortcut="Esc">
            <Button
              type="button"
              variant="secondary"
              size="icon-md"
              onClick={handleStopClick}
              data-testid={TID_V4_STOP}
              aria-label={stopTooltipTitle}
            >
              <SquareIcon className="size-4 fill-current" />
              <span className="sr-only">{stopTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        ) : (
          <ControlHintTooltip
            title={resolvedSendTooltipTitle}
            shortcut={resolvedSendTooltipShortcut}
            open={Boolean(modifierTooltip) || sendTooltipOpen}
            onOpenChange={setSendTooltipOpen}
          >
            <Button
              type="submit"
              size="icon-md"
              disabled={!canSend}
              onClick={handleSendButtonClick}
              data-testid={TID_V4_COMPOSER_SEND}
              aria-label={resolvedSendTooltipTitle}
              className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
            >
              {pending || worktreeQueued ? (
                <Spinner className="size-4" />
              ) : (
                <ArrowUpIcon className="size-4" />
              )}
              <span className="sr-only">{resolvedSendTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    ),
    [
      canSend,
      worktreeQueued,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      disabled,
      runtimeBlocked,
      draftConfig,
      draftMode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      highspeedCard,
      highspeedEntranceAnimated,
      highspeedPresented,
      highspeedSweepActive,
      isWebRemoteControl,
      mode,
      handleSelectModelTrace,
      modelSelectionReload,
      modelSelectionRefresh,
      modelSelectionState,
      modelSelectionView,
      onSelectThought,
      onRecoverCustomModelSelection,
      onSendCompressionCommand,
      onSwitchMode,
      pending,
      provider,
      modifierTooltip,
      resolvedSendTooltipShortcut,
      resolvedSendTooltipTitle,
      sendTooltipOpen,
      remoteAvailable,
      sendShortcut,
      sendTooltipTitle,
      sessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // S6: the session's own model and the projected agent selects; the draft's model decides which control renders.
  const externalAgentConfig = snapshot?.config.externalAgentConfig;
  const externalAgentSessionProviderId = snapshot?.config.modelSelection?.providerId;
  // 左下：模式选择 + CUA 入口 + 当前 session 后台任务入口。followupMode 由 app 设置页同步到 CLI，
  // 不在 composer 暴露局部开关；后台入口只消费同一 snapshot，不维护第二份任务状态。
  const leadingActionsNode = useMemo(
    () => (
      <>
        <V4ComposerModeArea
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          provider={provider}
          draftConfig={draftConfig}
          disabled={disabled || runtimeBlocked}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={handleConfigPickerOpenChange}
          onSwitchMode={onSwitchMode}
          sessionId={sessionId}
          sessionProviderId={externalAgentSessionProviderId}
          externalAgentConfig={externalAgentConfig}
          onSetExternalAgentConfigOption={onSetExternalAgentConfigOption}
        />
        {/* Bug 原因：附件画廊 rebase 曾整段覆盖 leadingActions，误删 staging 的 CUA 常驻入口。
            入口自身继续负责平台、远程与设置可见性，不在 composer 重复判定。 */}
        <V4ComposerCuaEntry
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          isWebRemoteControl={isWebRemoteControl}
          currentSessionBusy={canStop}
        />
        <ConversationBackgroundWorkTrigger
          backgroundWorks={snapshot?.backgroundWorks ?? []}
          runningSubagentCount={runningSubagentCount}
          onOpen={onOpenRunningBackgroundWorks}
          openTarget={backgroundWorkOpenTarget}
        />
      </>
    ),
    [
      activeConfigPicker,
      canStop,
      disabled,
      runtimeBlocked,
      draftConfig,
      handleConfigPickerOpenChange,
      isWebRemoteControl,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      onSetExternalAgentConfigOption,
      externalAgentConfig,
      externalAgentSessionProviderId,
      sessionId,
      provider,
      remoteSessionId,
      runningSubagentCount,
      snapshot?.backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const isBlockedByInteraction = blockingRequestId !== null;

  // specs/incognito-session.md "Composer toggle": top row, after the project and branch chips.
  // Start-only like choosing Git: a frozen first submission drops the icon even before the
  // reserved session is bound, so preparation-time drafts cannot arm or change the frozen profile.
  const incognitoComposerControl = shouldRenderComposerIncognitoControl({
    draftMode,
    sessionId,
    isWebRemoteControl,
    firstSubmissionActive,
  }) ? (
    <V4ComposerIncognitoControl workspaceKey={workspaceKey} disabled={disabled} />
  ) : null;

  // v4 pendingInteractions 是 bottom dock 阻塞态；composer 必须保留挂载，
  // 只在视觉和可访问树中隐藏，避免权限/问答卡片出现时丢失草稿和编辑器内部状态。
  return (
    // 外层 bottom dock 负责 sticky 与横向主列宽度；composer 自身组织错误提示与输入壳。
    // centered（居中草稿布局，m5）：收窄 max-w-2xl（旧
    // getChatViewComposerWidthClassName 的 draft 档），由宿主的居中容器摆位。
    // 有 contextHeader（草稿态）时，内层输入 surface 套旧 ChatViewComposer 同款卡：
    // rounded-2xl bg-surface shadow-xl/5；会话态回落不透明页面底色。
    // 错误横幅虽然排在 contextHeader 前面，但不能与输入区共用同一个圆角 surface，
    // 视觉上会被误认为输入卡标题栏；将 surface 边界收窄到工作区头和编辑器后，桌面与手机
    // Web 仍共享同一 DOM 顺序，同时恢复错误提示与输入卡之间的独立层级。
    <div
      data-testid={TID_V4_COMPOSER}
      data-input-routing={mode}
      aria-hidden={isBlockedByInteraction ? true : undefined}
      style={isBlockedByInteraction ? { display: "none" } : undefined}
      className={cn(
        "chat-composer-region z-20 w-full shrink-0 @container/composer",
        centered && "max-w-2xl",
      )}
    >
      {/* 旧 ChatViewComposer 同款隐藏 file input（web/无 native picker 平台回退）。 */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // 仅展示附件错误会漏掉会话级 lastError，任务失败后也应在输入框上方显示原因。
        // 这里复用旧 ChatErrorBanner 壳，只接收 SessionPane 已归一化后的当前错误。
        // 错误横幅独立于输入 surface，并先于桌面和手机共用的 contextHeader。
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            remoteKind={
              remoteKind?.kind === "workspace" ? remoteKind.remoteTarget?.kind : undefined
            }
            onReconnect={
              reconnectProject || remoteController
                ? () => {
                    const request = reconnectProject
                      ? reconnectProject(workspaceKey)
                      : remoteController?.dispatch({ type: "reconnect-workspace", workspaceKey });
                    void request?.catch((error: unknown) =>
                      logger.warn("[v4-composer] 项目重连失败", { error }),
                    );
                  }
                : undefined
            }
            onDismiss={onDismissError}
            onResume={onResumeError}
            onOpenModelSettings={onOpenModelSettings}
            onOpenUpgrade={onOpenModelUpgrade}
            modelConfigTarget={modelConfigTarget}
          />
        </div>
      ) : null}
      {initialization?.status === "failed" ? (
        // 初始化中只限制执行，不额外显示提示；失败时才显示错误和重试。
        // 状态条悬在可滚动正文上方；必须使用不透明 card，避免历史文字透入错误提示。
        <div
          data-testid="v4-session-initialization"
          role="alert"
          className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "chat.initialization.failed" })}
          </span>
          {onRetryInitialization ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="v4-session-initialization-retry"
              onClick={onRetryInitialization}
            >
              {intl.formatMessage({ id: "chat.initialization.retry" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        data-highspeed-composer={highspeedCard ? "true" : undefined}
        data-highspeed-entrance={highspeedCard ? highspeedEntrance : undefined}
        ref={voiceScopeRef}
        className={cn(
          "chat-composer-input-surface relative w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
          highspeedCard && "highspeed-composer-surface",
          highspeedPresented && "highspeed-placeholder-presented",
        )}
      >
        {highspeedCard ? (
          <HighspeedComposerBackground
            key={highspeedCard.cardId}
            animated={highspeedEntranceAnimated}
            onModelTransitionStart={handleHighspeedModelTransitionStart}
          />
        ) : null}
        {contextHeader || incognitoComposerControl ? (
          // 旧 ChatViewComposer contextHeaderContent 同款包装（workspace 菜单 + Git 分支）。
          // specs/incognito-session.md "Composer toggle": the incognito control closes the row after the chips.
          <div
            data-composer-context-row=""
            className="relative z-10 p-1.5 flex min-w-0 flex-wrap items-center gap-0"
          >
            <ComposerSubmissionPendingContext.Provider value={updateTargetSelectionPending}>
              {contextHeader}
            </ComposerSubmissionPendingContext.Provider>
            {incognitoComposerControl}
          </div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="relative z-10 mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          voicePreview={voicePreview}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={
            remoteAvailable
              ? normalPlaceholder
              : intl.formatMessage({ id: "remote.conversation.sendUnavailable" })
          }
          disabled={disabled || mode === "reject"}
          submitting={pending}
          submitDisabled={
            runtimeBlocked ||
            pending ||
            sendBarrierActive ||
            worktreeQueued ||
            !routingAllowsSend ||
            !attachmentsReady ||
            !submissionReady
          }
          allowSubmitWhenEmpty={
            // 发送按钮已把代码评论视为可发送上下文，但这里曾漏掉同一状态，
            // 导致空文本仅附代码评论时 Enter 被编辑器判为空，必须改点发送按钮。
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences ||
            hasPluginUiContexts
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ 是 Plugin / 文件 / 对话 / 画板主入口；# 会话与 $ / ¥ / ￥ Skills
          // 仍由 MentionPlugin 保留兼容触发，但不在 + 菜单重复展示。
          showMentionButton
          topContent={topContentNode}
          attachmentAction={runtimeBlocked ? undefined : attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          avoidIosInputFocusZoom={avoidIosInputFocusZoom}
          compactPlaceholder={compactMobilePlaceholder}
          // Bugfix 原因：命令目录必须完整来自 CLI workspace slash catalog；UI 只在
          // secondary pane 按产品能力隐藏 goal，不再追加任何内建命令或别名。
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={runtimeBlocked ? [] : appSlashCommands}
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          className="p-0"
          shellClassName={
            highspeedCard
              ? "relative z-10 !rounded-none !border-0 !bg-transparent !transition-none hover:!border-transparent focus-within:!border-transparent focus-within:!bg-transparent"
              : incognitoDraftActive
                ? "!border-incognito hover:!border-incognito focus-within:!border-incognito"
                : undefined
          }
          onSubmitBlocked={
            isComposerModelBlockReason(sendBlockReason) ? handleModelBlockedEnter : undefined
          }
          onChange={handleEditorChange}
          onFocus={handleEditorFocus}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
        />
        {(sendBarrierActive || isComposerModelBlockReason(sendBlockReason)) &&
        hasDraftToSubmit &&
        sendBlockMessageId ? (
          <div className="flex flex-col gap-2 px-3 pb-2 text-ui-sm text-foreground-subtle">
            <p role="status" data-testid="composer-send-blocked-reason">
              {intl.formatMessage({ id: sendBlockMessageId })}
            </p>
            {sendBlockReason === "outcomeUnresolved" ? (
              heldUnlockConfirmOpen ? (
                <div className="flex flex-col gap-2">
                  <p
                    id={heldUnlockWarningId}
                    role="alert"
                    data-testid="composer-held-unlock-warning"
                    className="text-warning"
                  >
                    {intl.formatMessage({ id: "composer.heldCopy.warning" })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      ref={heldUnlockConfirmRef}
                      size="sm"
                      variant="outline"
                      data-testid="composer-held-unlock-confirm"
                      aria-describedby={heldUnlockWarningId}
                      onClick={unlockHeldFirstSubmission}
                    >
                      {intl.formatMessage({ id: "composer.heldCopy.confirm" })}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="composer-held-unlock-cancel"
                      onClick={() => {
                        heldUnlockFocusReturnRef.current = true;
                        setHeldUnlockConfirmOpen(false);
                      }}
                    >
                      {intl.formatMessage({ id: "common.cancel" })}
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <Button
                    ref={heldUnlockButtonRef}
                    size="sm"
                    variant="ghost"
                    data-testid="composer-held-unlock"
                    onClick={() => setHeldUnlockConfirmOpen(true)}
                  >
                    {intl.formatMessage({ id: "composer.heldCopy.unlock" })}
                  </Button>
                </div>
              )
            ) : null}
          </div>
        ) : null}
        <ComposerWorktreeRecovery
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          scopeId={draftScopeId}
          editorEmpty={!hasDraftToSubmit && !pending && !worktreeQueued}
          attachments={attachmentsApi.attachments}
          retryBlockedReason={
            retryBlockReason
              ? intl.formatMessage({ id: `composer.sendBlocked.${retryBlockReason}` })
              : null
          }
          onRemove={removeFirstSubmissionRecord}
          onDiscardAttachments={async (ids, recoveryScope) => {
            await attachmentsApi
              .captureSubmission?.(ids, `${workspaceKey}\0${recoveryScope}`)
              .discardAttachments();
          }}
          onRestore={applyWorktreeRecoveryDraft}
          onRetry={retryWorktreeRecoveryDraft}
        />
        {attachmentsApi.attachmentError ? (
          <p className="flex items-start gap-2 p-3 text-ui-base text-warning">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{attachmentsApi.attachmentError}</span>
          </p>
        ) : null}
      </div>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={composerMediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
      <Dialog
        open={heldQueueConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) {
            if (heldQueueConfirmation?.telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(
                heldQueueConfirmation.telemetrySeed.localTtft,
                "cancelled",
              );
            setHeldQueueConfirmation(null);
          }
        }}
      >
        <DialogContent
          data-testid={TID_V4_PAUSED_QUEUE_SEND_DIALOG}
          showCloseButton={false}
          className="max-w-xl gap-6 p-6 sm:p-8"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={pending}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute top-4 right-4"
            >
              <XIcon className="size-5" />
            </Button>
          </DialogClose>
          <DialogHeader className="gap-3 pr-8">
            <DialogTitle className="text-xl font-semibold sm:text-2xl">
              {intl.formatMessage({ id: "chat.queue.sendConfirm.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base sm:text-ui-lg">
              {intl.formatPlural(
                { id: "chat.queue.sendConfirm.description" },
                heldQueueConfirmation?.queueItemIds.length ?? 0,
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_V4_COMPOSER_CLEAR_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleClearQueueSend}
            >
              {intl.formatMessage({ id: "chat.queue.sendConfirm.clear" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_V4_COMPOSER_KEEP_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleKeepQueueSend}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {intl.formatMessage({ id: "chat.queue.sendConfirm.keep" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const ConversationComposer = memo(ConversationComposerImpl);
