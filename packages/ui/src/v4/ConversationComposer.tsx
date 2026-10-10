/* oxlint-disable eslint(max-lines) -- The composer centralizes input-area wiring (attachments/drafts/history/mentions); splitting it would scatter this cohesive flow. */
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
/**
 * v4 conversation composer (composer parity).
 *
 * Shell: ChatPromptEditor (Lexical editor + action menu + drag-and-drop feedback + sticky base styling),
 * plus the attachment preview grid, full-size image preview, and error messages.
 *
 * Core: new v4 wiring:
 * - Routing and state all come from the v4 projection: snapshot.inputRouting / control / config / usage.
 * - The send-button state machine matches the old UI: canSend (text or attachments and routing allows it) / pending spinner /
 *   running + empty draft → Stop (v4 stop command) / pause queue (choice) → show a clear/keep confirmation after sending.
 * - See useComposerAttachments for the full attachment flow (sending uses v4 sendText attachments).
 * - Mentions (@ files/boards, # sessions, $ skills) and the full slash-command catalog are wired inside LexicalChatInput.
 * - Per-session draft persistence (composerDraftStore) and prompt history (promptHistoryStorage).
 * - See V4ComposerToolbar for the toolbar (model/reasoning depth/mode/context usage).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
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
  type PlanIdentitySnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
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
import { resolveChatEnterShortcut } from "@/lib/mobileTextInput.js";
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
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import { consumeV4ComposerDraftWorkspaceTransferRequest } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
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
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModeSwitch,
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
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
import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";

const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

export interface ConversationComposerSendOptions {
  /** Config snapshot copied at send time; null means selection is incomplete, and Host must not fill it from Session. */
  submission?: ComposerSubmissionConfig | null;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  /** Paused queue IDs seen when the send confirmation opened; CLI uses them to guard against cross-client add/delete races. */
  expectedHeldQueueItemIds?: readonly string[];
  /** Attachment command surface: serialized attachments sent with v4 sendText/createSession after the host converts them to AttachmentRef. */
  attachments?: AttachmentRef[];
  /** Number of context attachments carried in the prompt text; prevents local commands such as /goal from consuming them accidentally. */
  contextAttachmentCount?: number;
  /** Renderer-only: SessionPane binds the real commandId/sessionId after an accepted ACK. */
  telemetrySeed?: ConversationPromptTelemetrySeed;
  /** One-time delivery override for this busy input; does not change session preferences. */
  requestedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
}

export type ConversationComposerSendResult = "sent" | "blocked" | "confirmationRequired";
function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

interface ExternalTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

function restorePersistedComposerDraftIntoInput({
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
    // Workspace Plugin details unmount the chat Composer. Restore structured mentions from the shared draft source of truth;
    // relying only on a one-time insertion event would degrade them to canonical plain text after remount.
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}

function applyExternalTextInsertRequestToComposer({
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
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug cause: replaying the old prompt saved at click time after installation would overwrite edits made during installation.
    // Prepending nodes preserves the editor's current mentions and paragraph structure, then reads the canonical draft from the editor.
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // Root cause: store trials previously sent only canonical text, so Lexical could not tell that the leading link was a structured Plugin mention.
    // The request also carries display-only node data; sending and the draft source of truth still use the original request.text.
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // Recommended tasks can combine multiple plugins in the body; construct real mention nodes at their original positions.
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

function applyComposerRestoreRequestToComposer({
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

interface ConversationComposerProps {
  snapshot: ConversationSnapshot | null;
  /** Draft scope (sessionId; null maps to the "__draft__" scope in draft mode). */
  sessionId?: string | null;
  /** Skill catalog authority; becomes prewarmSessionId after draft prewarming without changing task/draft identity. */
  skillCatalogSessionId?: string | null;
  /** Draft mode has no snapshot, but can still create a session on the first send. */
  draftMode?: boolean;
  /** Renderer-side draft config intent; overrides a late prewarm projection only in draftMode. */
  draftConfig?: Partial<SessionConfigState>;
  /** Full Draft owner injected by SessionPane; in production the editor no longer overwrites persisted records directly. */
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** Whether the current Composer can build a complete Submission; false when the model or Reasoning is empty. */
  submissionReady?: boolean;
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null;
  /** Used only to freeze the model dimension for send telemetry; combines the draft's initial config with explicit intent. */
  telemetryDraftConfig?: Partial<SessionConfigState>;
  /**
   * Empty-state contextHeader (m5-composer-parity): workspace switcher menu + Git branch
   * switcher, rendered above the editor (same position as the old ChatViewComposer contextHeaderContent).
   * Passed by the host only in draft mode; empty after a session is created.
   */
  contextHeader?: ReactNode;
  /** Centered draft layout (old shouldUseCenteredDraftChatLayout): narrow to max-w-2xl and remove sticky positioning. */
  centered?: boolean;
  /**
   * ID of the interaction blocking the v4 bottom dock. When present, hide the composer without unmounting it,
   * preserving the draft, attachments, and editor instance.
   */
  blockingRequestId?: string | null;
  disabled?: boolean;
  /**
   * Whether to focus the input automatically after creating a task, switching sessions, or mounting (enabled by default).
   * For vertically split panes, the host passes SessionPane.focused so only the focused pane gets focus and background panes do not steal it.
   */
  autoFocusEnabled?: boolean;
  /** Whether the current composer runs inside the mobile Web remote-control shell. */
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Selection facts read atomically from the target Host by SessionPane; the Composer does not resolve Host itself. */
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  /** Explicit retry entry point after the initial Model Selection read fails. */
  modelSelectionReload?: () => void;
  /** Draft mode uses the prewarmed session as the attachment transaction carrier. */
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** Prefer the runtime liveness state exposed by the transport when available, in place of onRuntimeRestart. */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  provider?: ZCodeProvider;
  /** Actual visibility determined jointly by the host pane and workspace overlay; used only for visible-only telemetry. */
  telemetryVisible?: boolean;
  /** Read plan identity when Send is clicked; a second confirmation reuses the same frozen seed. */
  readPlanIdentitySnapshot?: () => PlanIdentitySnapshot;
  onSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult | void>;
  /** Pass the current input text to the parent (editUserQuery uses composer text as newText). */
  onTextChange?: (text: string) => void;
  /** Full composer occupancy state read when admitting a queue undo; attachments include items still uploading. */
  onDraftStateChange?: (state: { hasContent: boolean; busy: boolean }) => void;
  onStop: () => void;
  /** Model selected from the catalog (providerId/modelId); the host fills in thought/revision from the latest projection. */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
  ) => void;
  /** Selected reasoning depth, along with the model visible when the user acted, so async updates do not assign thought to another model. */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** Open the current session's Status panel directly to the Running details. */
  onOpenRunningBackgroundWorks?: () => void;
  /**
   * Destination when the background task entry is clicked: `"workflow-run"` opens the only running workflow's details (decided by the host),
   * while the default `"panel"` expands the status capsule. The entry updates its tooltip accordingly; behavior lives in onOpenRunningBackgroundWorks.
   */
  backgroundWorkOpenTarget?: "panel" | "workflow-run";
  runningSubagentCount?: number;
  /** For custom provider selection, use the workspace recovery path when prepare/configOptions fails. */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  /** /compact entry point in the context usage panel (the host uses the v4 compact command). */
  onSendCompressionCommand?: (command: string) => void;
  /** v4 session-level error (snapshot.control.lastError), displayed above the input. */
  error?: ZCodeUiError | null;
  onDismissError?: () => void;
  /** Resume action for the error banner. SessionPane sends the fixed continuation prompt as a new user message. */
  onResumeError?: () => void;
  /** Recovery action for the no-model-available banner; SessionPane injects shell navigation and the component does not manipulate tabs directly. */
  onOpenModelSettings?: () => void;
  onOpenModelUpgrade?: () => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * Whether to listen for the global "add to conversation" event (workspace file tree / board button).
   * In split view, only the primary pane listens so one click does not insert twice.
   */
  listenAddToChatEvents?: boolean;
  /**
   * One-time external text prefill request (such as Example Prompt).
   * requestId ensures that fetching the same text twice in succession can still trigger prefill.
   */
  externalTextInsertRequest?: ExternalTextInsertRequest | null;
  onExternalTextInsertApplied?: (requestId: number) => void;
  /**
   * After delete ACK, the queue's Edit action returns the full future intent to the input.
   * requestId + session/workspace binding makes it idempotent and prevents writes to another task.
   */
  composerRestoreRequest?: ComposerRestoreRequest | null;
  onComposerRestoreApplied?: (requestId: number) => void;
  /** Secondary-screen sessions do not offer goal capability; the protocol layer still rejects direct calls. */
  suppressGoalCommands?: boolean;
  /** App-layer local slash commands (such as `/side`), assembled by SessionPane after gating and passed through. */
  appSlashCommands?: readonly AppSlashCommand[];
  /** Expose the composer's drop routing to the full conversation pane / desktop draft title bar. */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
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
  updateComposerContent,
  replaceComposerDraft,
  submissionReady = true,
  createSubmissionFromComposer,
  telemetryDraftConfig,
  contextHeader,
  centered = false,
  blockingRequestId = null,
  disabled = false,
  autoFocusEnabled = true,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
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
  onOpenRunningBackgroundWorks,
  backgroundWorkOpenTarget = "panel",
  runningSubagentCount = 0,
  onRecoverCustomModelSelection,
  onSendCompressionCommand,
  error,
  onDismissError,
  onResumeError,
  onOpenModelSettings,
  onOpenModelUpgrade,
  onOpenCodeViewer,
  listenAddToChatEvents = true,
  externalTextInsertRequest = null,
  onExternalTextInsertApplied,
  composerRestoreRequest = null,
  onComposerRestoreApplied,
  suppressGoalCommands = false,
  appSlashCommands,
  onDropTargetControllerChange,
}: ConversationComposerProps) {
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const draftScopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({
    scopeKey: configPickerScopeKey,
    activePicker: null,
  }));
  // SessionPane uses a stable key and reuses Composer across tasks/drafts, so the old picker owner
  // follows the instance into the new scope. Reset synchronously before committing the new scope portal to avoid a one-frame menu flash;
  // the scope guard below drops any close event that arrives later from the old Radix layer.
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
      // When Composer content restores pointer events after the navigation rail, the independent open states of three Radix modal
      // pickers can compete during the same pointerdown, and the old layer cannot reliably dismiss.
      // A close callback may arrive after a sibling picker opens, so it may clear only itself and must not close the new owner.
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
  // Read the latest text/pending through refs in submit so the callback reference does not change on every input.
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  const pendingRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // This path broke once: Composer read a parallel sharedContextImport prop that SessionPane never
  // passed (there were no `sharedContextImport=` references in the repository), so the first message never included sharedContextRefs.
  // Derive it from the snapshot, which is always available; see resolveAttachableShareContext for rationale and boundaries.
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const reportedErrorKeysRef = useRef(new Set<string>());
  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  const enterSubmits = true;
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

  // ── Full attachment flow (selection/paste/drag/board/pre-upload/gating) ──
  const attachmentsApi = useComposerAttachments({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
  });
  // Match the old useChatComposer behavior: window-level dragover highlights the full chat area and
  // desktop draft title bar before the pointer enters ChatView. Workspace-payload copy takes precedence over system attachments.
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
        // File-tree payloads differ from OS File[] semantics: insert only a mention and never add them to the upload queue.
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
    // Composer is disabled while queue removal awaits ACK. Also block global add-to-chat from
    // writing web context during this window, so it cannot collide with a new draft after authoritative deletion succeeds.
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
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
  } = useConversationSelectionReferences({ sessionId, workspaceKey });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  // ── Per-session draft persistence (survives session switches/refresh; mention pills preserved through editorStateJson) ──
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

  // ── Auto-focus (return the cursor to the input after creating a task, switching sessions, or mounting) ──
  // Triggers: draftFocusVersion incremented by startDraft (covers Cmd/Ctrl+N and all create-task entry points),
  // sessionId→draftScopeId changes (session/draft switch), and mount. Each sets focus intent; when switching to a session
  // that needs to connect, Composer is briefly disabled, so keep the intent pending and fulfill it once editing is enabled.
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const pendingFocusRef = useRef(false);
  // Whether this focus was programmatic (see flushPendingFocus), used to filter non-user actions from send_input_focus.
  const programmaticFocusRef = useRef(false);
  // The send button and Enter share the same form submit. The button's onClick fires before submit,
  // so use it to distinguish send_click as the send_trigger, then immediately reset to the default shortcut.
  const sendTriggerRef = useRef<"button" | "shortcut">("shortcut");
  // Modified clicks happen before form submit; store only this one-time delivery inversion intent here, then clear it when submit consumes it.
  const reversePointerDeliveryRef = useRef(false);
  const appliedComposerRestoreRequestRef = useRef<number | null>(null);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // Read decision inputs through refs so autoFocusEnabled/disabled/viewport do not enter scope-effect dependencies
  // and trigger unnecessary draft restoration (a disabled-state change should not replay the draft).
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: false,
  });
  focusOptsRef.current = {
    autoFocusEnabled,
    disabled,
    isMobileViewport: false,
  };
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;
    // Programmatic focus and a user click on the input trigger the same DOM focus event. Set this flag for handleEditorFocus
    // to consume so session switches, mount-time focus, or refocus after removing a context block are not reported as send_input_focus.
    programmaticFocusRef.current = true;
    // Lexical root may be ready one frame later, so defer focus to the next frame (same timing as draft restoration).
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
    // Composer is disabled while queue removal awaits ACK; use the same write gate as web context.
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
          conversationSelectionReferences.length > 0,
        inputApi: inputApiRef.current,
        request: composerRestoreRequest,
        requestFocus: requestComposerFocus,
        restoreSessionOwnedAttachments: attachmentsApi.restoreSessionOwnedAttachments,
        // The restored item carries its own Submission config; reuse the draft owner, restore once, and preserve handled authorization markers.
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
    workspaceKey,
  ]);

  // Scope switch: persist the old scope's draft first, then restore the new scope (prefer editorStateJson, fall back to plain text).
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
        previousTarget.scopeId === V4_DRAFT_SCOPE_ROOT &&
        draftScopeId === V4_DRAFT_SCOPE_ROOT &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // Unbinding the project changes only the draft's cwd; keep the text, mention editor state, and component-held attachments.
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
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (!api) return;
      restoreDraftInto(api);
      // Return focus to the input after restoring a draft (session/draft switch or mount); for a connecting session, wait until editing is enabled.
      requestComposerFocus();
    };
    // Lexical root may be ready one frame later; defer draft restoration to the next frame (same timing as the old initialValue fill).
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => cancelAnimationFrame(frame);
    }
    applyDraft();
    return undefined;
    // Keep dependencies limited to scope/workspace: restore a draft only when scope or workspace changes.
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

  // External prefill and scope restoration may happen in the same cycle. If the prefill effect runs first, restoration
  // may overwrite the Example Prompt the user just selected with an old draft. Apply it after scope restoration and confirm the one-time insertion request.
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

  // New task (including repeated Cmd/Ctrl+N while already in draft state, with no scope change): startDraft increments the nonce to refocus.
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // When switching to a session that needs to connect, disabled=true defers focus intent; fulfill it once connection changes disabled to false.
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // Persist the current draft before refresh/window close.
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
    };
  }, [persistDraftNow]);

  // ── Prompt history (per-workspace localStorage; PromptHistoryPlugin handles ↑/↓ navigation) ──
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
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
    Boolean(pendingShareContext);
  const hasComposerDraftContent =
    text.length > 0 ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    Boolean(pendingShareContext);
  useEffect(() => {
    onDraftStateChange?.({
      hasContent: hasComposerDraftContent,
      busy: pending,
    });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // Keep the normal send button for choice; after submit, SessionPane decides whether to show confirmation based on slash semantics.
  // The V4 refactor treated guide as "not submittable", disabling both the button and Enter.
  // Guide is a CLI-authorized busy-input route; the command layer decides whether to steer or fall back to queue.
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  const attachmentsReady = !attachmentsApi.hasUnreadyAttachments;
  const canSend =
    !disabled &&
    !pending &&
    hasDraftToSubmit &&
    routingAllowsSend &&
    attachmentsReady &&
    submissionReady;
  // Old UI state machine: streaming + empty draft → Stop; with a draft → Send (enqueue).
  const showStopControl = canStop && !hasDraftToSubmit;

  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

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
      const currentPptxElementReferences = pptxElementReferences;
      const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
      const currentConversationSelections = conversationSelectionReferences;
      const hasPendingConversationSelections = currentConversationSelections.length > 0;
      const submittedShareContext = pendingShareContext;
      // After first draft send is accepted, this Composer promotes in place from __draft__ to session scope.
      // If success cleanup reads the mutable ref later, it may clear the new scope by mistake and leave the first input in
      // __draft__, restoring it when the next task is created. Freeze the actual submitted scope at send start.
      const submittedDraft = snapshotDraftOfEditor();
      let cleanupRevision = contentRevisionRef.current;
      const submission = createSubmissionFromComposer?.() ?? null;
      const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
      if (
        (!trimmed &&
          !hasPendingAttachments &&
          !hasPendingCodeCommentContexts &&
          !hasPendingWebElementContexts &&
          !hasPendingPptxElementReferences &&
          !hasPendingConversationSelections &&
          !submittedShareContext) ||
        pendingRef.current ||
        !submissionReady ||
        (createSubmissionFromComposer !== undefined && submission === null) ||
        attachmentsApi.hasUnreadyAttachments
      ) {
        return;
      }
      const sendAction = startUserAction({
        featureId: "conversation.composer.message",
        action: "send",
        trigger: sendTriggerRef.current === "button" ? "button" : "shortcut",
        workspaceKind: workspaceIdentity?.trim() ? "remote" : "local",
      });
      pendingRef.current = true;
      setPending(true);
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
            providerBaseURL: resolveProviderBaseURL(telemetryConfig?.provider, modelSelectionView),
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
      let draftSubmissionClaimed = false;
      let editorClearedOptimistically = false;
      const claimSubmittedDraft = () => {
        if (draftPersistTimerRef.current !== null) {
          window.clearTimeout(draftPersistTimerRef.current);
          draftPersistTimerRef.current = null;
        }
        // First-send promotion may switch scope or remount Composer before onSendText returns.
        // If the old scope effect can still persist, the new Composer restores already-sent text as a draft.
        // Claim and hide the draft before submission; restore it on failure rather than masking the race with a delay.
        suppressDraftPersistRef.current = true;
        updateComposerContent({ text: "" });
        draftSubmissionClaimed = true;
      };
      const restoreSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        // If the user edits while waiting, the current full text is the latest fact; an older failure response must not overwrite it.
        if (contentRevisionRef.current === cleanupRevision) {
          updateComposerContent(submittedDraft);
        }
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
        if (editorClearedOptimistically && contentRevisionRef.current === cleanupRevision) {
          if (submittedDraft.editorStateJson) {
            inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
          } else {
            inputApiRef.current?.setText(submittedDraft.text);
          }
          updateText(submittedDraft.text);
          editorClearedOptimistically = false;
        }
      };
      const finalizeSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
      };
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
        // Second gate: consume only refs whose pre-upload is complete; do not fall back to uploading on send click.
        const readyAttachmentRefs = await attachmentsApi.prepareForSend();
        if (readyAttachmentRefs === null) {
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
          conversationSelections: currentConversationSelections,
          webElements: currentWebElementContexts,
          pptxElements: currentPptxElementReferences,
        });
        const contextAttachmentCount =
          countComposerPromptContexts({
            codeComments: currentCodeCommentContexts,
            conversationSelections: currentConversationSelections,
            webElements: currentWebElementContexts,
            pptxElements: currentPptxElementReferences,
          }) + (submittedShareContext ? 1 : 0);
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
        claimSubmittedDraft();
        if (requestedDelivery === "startNow") {
          // Atomic takeover waits for the old turn to exit and the new TurnStarted ACK to commit.
          // If the editor also waits for the full flow before clearing, the user may think the shortcut did nothing.
          // Clear visible text first; if the command is rejected, restore the frozen editor state exactly.
          inputApiRef.current?.clear();
          updateText("");
          cleanupRevision = contentRevisionRef.current;
          editorClearedOptimistically = true;
        }
        const sendResult = await onSendText(promptText, {
          submission,
          telemetrySeed,
          ...(requestedDelivery ? { requestedDelivery } : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
          ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
          ...(submittedShareContext
            ? {
                sharedContextRefs: [
                  {
                    kind: "shared_context_import" as const,
                    context_id: submittedShareContext.contextId,
                  },
                ],
              }
            : {}),
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
        setHeldQueueConfirmation(null);
        // Transfer staged content to the task only after a successful send; on failure, keep it as a retryable draft.
        await attachmentsApi.adoptSentAttachments(submittedAttachmentIds);
        // Bug cause: text entered while the send is pending belongs to the next Submission; an old ACK must not clear it.
        if (contentRevisionRef.current === cleanupRevision) {
          inputApiRef.current?.clear();
          updateText("");
        }
        attachmentsApi.clearAttachments(submittedAttachmentIds);
        // As with attachments, remove only refs frozen for this send; refs added while waiting belong to the next message.
        currentCodeCommentContexts.forEach(removeCodeCommentContext);
        currentWebElementContexts.forEach((context) => removeWebElementContext(context.id));
        currentPptxElementReferences.forEach((reference) =>
          removePptxElementReference(reference.id),
        );
        currentConversationSelections.forEach((reference) =>
          removeConversationSelectionReference(reference.id),
        );
        // On success, clear the scope draft captured by this submission. Prompt history was synchronously persisted before the real send,
        // avoiding loss during first-send promotion or clearing the new scope created by promotion.
        finalizeSubmittedDraft();
        sendAction.complete({ resultSource: "authority_ack", admissionResult: "accepted" });
      } catch (error) {
        rollbackPromptHistory();
        restoreSubmittedDraft();
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        // On failure, keep the draft in the input (do not clear it) and record only the reason.
        logger.warn(`[v4-composer] 发送失败: ${String(error)}`);
        // SessionPane already finalizes ACK-side failures; reaching this point means Composer's own flow failed.
        conversationTelemetry?.settleSendResult({
          seed: telemetrySeed,
          sessionId: sessionId ?? null,
          status: "fail",
          reasonCode: "composer_error",
        });
        sendAction.fail({ failureStage: "composer_send" });
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [
      attachmentsApi,
      conversationSelectionReferences,
      conversationTelemetry,
      draftConfig,
      createSubmissionFromComposer,
      submissionReady,
      getCodeCommentContexts,
      telemetryDraftConfig,
      modelSelectionView,
      onSendText,
      pendingShareContext,
      provider,
      readPlanIdentitySnapshot,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeWebElementContext,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      updateComposerContent,
      webElementContexts,
      pptxElementReferences,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // Lexical onChange (the first character is also reported reliably; see LexicalChatInput.TextContentPlugin).
  const handleEditorChange = useCallback(
    (value: string) => {
      conversationTelemetry?.recordComposerTextChange(value);
      updateText(value);
      // Put text into the in-memory Draft along with mode/model; debounce only supplements the latest Lexical JSON.
      updateComposerContent({ text: value });
      scheduleDraftPersist();
    },
    [conversationTelemetry, scheduleDraftPersist, updateComposerContent, updateText],
  );

  const handleEditorFocus = useCallback(() => {
    conversationTelemetry?.recordComposerFocus();
    // Programmatic focus is not an "input click"; consume this marker once, then report later manual focus as usual.
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    conversationTelemetry?.recordComposerFocusClick({
      sessionId: sessionId ?? null,
    });
  }, [conversationTelemetry, sessionId]);

  // Editor submission (Enter and send-button form submit share the same path). Return false so the editor does not reset itself;
  // clear through inputApiRef.clear() only after successful submit, leaving the draft in the input on failure.
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
      // inputRouting may still be startNow at the beginning of a turn, so it cannot indicate idle state.
      // The modifier always requests one-time delivery inversion; while idle, the CLI naturally uses startNow.
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

  // The send button is type="submit" and shares handleEditorSubmit with Enter. DOM event order guarantees click before
  // submit, so set a marker here for submit() to read and reset.
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

  // ── Global "Add to chat" event (workspace file tree context menu/button) → insert mention ──
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

  // Dynamic placeholder (old chatViewPlaceholder semantics): no history → newTask;
  // history and idle → followUpAsk; history and busy → followUpQueue.
  const placeholder = intl.formatMessage({
    id: resolveChatPlaceholderKey({
      hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
      isTaskProcessing: canStop,
      compactNewTask: false,
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
    // Show an error only when it survives suppression and actually reaches render; at most once per key per Composer mount.
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

  // ── Attachment preview grid ──
  const composerAttachments = attachmentsApi.attachments;
  const orderedComposerAttachments = useMemo(() => {
    // Media groups (images/videos) come first, followed by files; preserve addition order within each group.
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
      conversationSelectionReferences.length === 0
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
                  // Attachments may be non-image files. PDFs use the separate PdfViewer;
                  // show a type icon and filename for other files so documents such as .doc are not rendered as broken images.
                  // Add images and videos to the pre-send gallery in insertion order
                  // so users can navigate continuously within a media group.
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
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
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
                          {attachment.filename}
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
        conversationSelectionReferences.length > 0 ? (
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
    removePptxElementReference,
    conversationSelectionReferences,
    pendingShareContext,
    webElementContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
  ]);

  // Send/stop control cluster (matching the old ChatViewComposer.submitControlNode structure:
  // model/thought/usage cluster on the left, stop or send on the right).
  // useMemo: Composer re-renders frequently as streaming snapshots arrive, so rebuild the controls only when semantic dependencies change
  // instead of rebuilding the Tooltip/Select subtree for every token batch.
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModelTrace = useCallback(
    (nextProvider: string, nextModel: string, sourceModel: ModelSelectionSource | null) =>
      runUserAction({
        input: {
          featureId: "conversation.composer.config",
          action: "change_model",
          trigger: "select",
        },
        operation: () => onSelectModel(nextProvider, nextModel, sourceModel),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "model_change",
      }),
    [onSelectModel],
  );
  const submitControlNode = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1">
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
          <V4ComposerModelControls
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            modelSelectionView={modelSelectionView}
            modelSelectionState={modelSelectionState}
            modelSelectionReload={modelSelectionReload}
            sessionId={sessionId ?? null}
            phase={composerPhase}
            provider={provider}
            draftMode={draftMode}
            draftConfig={draftConfig}
            usage={composerUsage}
            disabled={disabled}
            activeConfigPicker={activeConfigPicker}
            onConfigPickerOpenChange={handleConfigPickerOpenChange}
            onSelectModel={handleSelectModelTrace}
            onSelectThought={onSelectThought}
            onSwitchMode={onSwitchMode}
            onRecoverCustomModelSelection={onRecoverCustomModelSelection}
            onSendCompressionCommand={onSendCompressionCommand}
          />
        </span>
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
              {pending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
              <span className="sr-only">{resolvedSendTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    ),
    [
      canSend,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      disabled,
      draftConfig,
      draftMode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      mode,
      handleSelectModelTrace,
      modelSelectionReload,
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
      sendShortcut,
      sendTooltipTitle,
      sessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // Bottom left: mode selection + CUA entry + current-session background tasks. followupMode is synced to the CLI by app settings,
  // so Composer does not expose a local switch. The background entry consumes the same snapshot and keeps no second task state.
  const leadingActionsNode = useMemo(
    () => (
      <>
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          provider={provider}
          draftConfig={draftConfig}
          disabled={disabled}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={handleConfigPickerOpenChange}
          onSwitchMode={onSwitchMode}
        />
        {/* The attachment gallery refactor once replaced all of leadingActions and removed the
            persistent CUA entry. The entry itself still handles platform, remote, and settings
            visibility; do not duplicate those checks in the composer. */}
        <V4ComposerCuaEntry
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
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
      draftConfig,
      handleConfigPickerOpenChange,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      provider,
      remoteSessionId,
      runningSubagentCount,
      snapshot?.backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const isBlockedByInteraction = blockingRequestId !== null;

  // v4 pendingInteractions blocks the bottom dock; keep Composer mounted and hide it only visually and from the accessibility tree,
  // so permission/question cards do not cause the draft or editor state to be lost.
  return (
    // The outer bottom dock handles sticky positioning and main-column width; Composer arranges its error notice and input shell.
    // centered (centered draft layout, m5): narrow to max-w-2xl (the old draft size from
    // getChatViewComposerWidthClassName), positioned by the host's centered container.
    // With a contextHeader (draft state), wrap the inner input surface in the same card as old ChatViewComposer:
    // rounded-2xl bg-surface shadow-xl/5; in session state, use the opaque page background.
    // Although the error banner comes before contextHeader, it must not share the rounded input surface,
    // or it will look like the input card's title bar. Narrow the surface to the workspace header and editor;
    // Desktop and mobile Web still share DOM order while the error notice and input card regain separate hierarchy.
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
      {/* Hidden file input matching the old ChatViewComposer, used as a fallback on web and on
          platforms without a native picker. */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // Showing only attachment errors would miss session-level lastError; task failures should also explain themselves above the input.
        // Reuse the old ChatErrorBanner shell, receiving only the current error normalized by SessionPane.
        // Keep the banner separate from the input surface and before the shared Desktop/mobile contextHeader.
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            onDismiss={onDismissError}
            onResume={onResumeError}
            onOpenModelSettings={onOpenModelSettings}
            onOpenUpgrade={onOpenModelUpgrade}
          />
        </div>
      ) : null}
      <div
        className={cn(
          "chat-composer-input-surface w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
        )}
      >
        {contextHeader ? (
          // Same wrapper as the old ChatViewComposer contextHeaderContent (workspace menu + Git branch).
          <div className="p-1.5 flex min-w-0 flex-wrap items-center gap-0">{contextHeader}</div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={placeholder}
          disabled={disabled || mode === "reject"}
          submitting={pending}
          submitDisabled={pending || !routingAllowsSend || !attachmentsReady || !submissionReady}
          allowSubmitWhenEmpty={
            // The send button already treated code comments as sendable context, but this state was missing here,
            // so Enter treated a code-comment-only input as empty and users had to click Send.
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ is the main entry point for Plugin/file/conversation/board; # sessions and $ / ¥ / ￥ Skills
          // remain compatible MentionPlugin triggers but are not repeated in the + menu.
          showMentionButton
          topContent={topContentNode}
          attachmentAction={attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          // The command list must come entirely from the CLI workspace slash catalog. The UI only hides goal in
          // secondary panes based on product capabilities; do not add built-in commands or aliases here.
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={appSlashCommands}
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          className="p-0"
          onChange={handleEditorChange}
          onFocus={handleEditorFocus}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
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
              {intl.formatMessage(
                { id: "chat.queue.sendConfirm.description" },
                {
                  count: String(heldQueueConfirmation?.queueItemIds.length ?? 0),
                },
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
