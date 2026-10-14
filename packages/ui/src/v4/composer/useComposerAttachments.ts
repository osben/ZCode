/* oxlint-disable eslint(max-lines) -- Attachment collection, per-scope upload scheduling, and lifecycle must be coordinated atomically in one hook. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { nanoid } from "nanoid";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import {
  MAX_CHAT_ATTACHMENTS,
  MissingInlinePdfContentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
  createChatComposerAttachment,
  createChatComposerPathAttachment,
  createClipboardTextAttachmentFilenameForDate,
  createClipboardTextPathComposerAttachment,
  formatAttachmentSize,
  revokeChatComposerAttachment,
  serializeChatComposerAttachment,
  shouldCreateClipboardTextAttachment,
  shouldPreferSpreadsheetClipboardText,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import {
  WHITEBOARD_ADD_TO_CHAT_EVENT,
  buildWhiteboardWorkspaceKey,
  createWhiteboardPngFile,
  isWhiteboardAddToChatEvent,
} from "@/lib/whiteboard.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import type { ChatComposerPasteEvent } from "@/LexicalChatInput.js";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  exposeComposerAttachmentScopeKeyForE2E,
  readComposerAttachmentScope,
  updateComposerAttachmentScope,
  useComposerAttachmentUploadStore,
  type ComposerAttachmentUploadItem,
  type ComposerAttachmentUploadStatus,
} from "@/store/composerAttachmentUploadStore.js";
import {
  uploadComposerAttachment,
  uploadComposerAttachments,
  type AttachmentPutFn,
} from "@/v4/composer/attachmentUpload.js";

export const COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY = 2;
export const COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS = 500;
export const COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS = 300;
/**
 * Fallback limit for retries across generations. Development testing reached runtimeGeneration=4 (three generation changes) in one workspace;
 * use 5 for margin. This only prevents endless retries if the Helper repeatedly crashes and should not be reached in normal use.
 */
export const COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT = 5;
const EMPTY_COMPOSER_ATTACHMENTS: ComposerAttachmentUploadItem[] = [];
const REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE = "remoteAttachmentNotStaged";
export type {
  ComposerAttachmentUploadItem,
  ComposerAttachmentUploadStatus,
} from "@/store/composerAttachmentUploadStore.js";

interface UploadTarget {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  attachmentPut: AttachmentPutFn;
  transferService: IPromptAttachmentTransferService;
}

interface UploadQueueEntry {
  scopeKey: string;
  attachmentId: string;
}

export interface ComposerAttachmentsApi {
  attachments: ComposerAttachmentUploadItem[];
  attachmentError: string | null;
  hasAttachments: boolean;
  hasUnreadyAttachments: boolean;
  composerDragKind: "attachment" | "workspace" | null;
  isDraggingOverComposer: boolean;
  attachmentInputRef: React.RefObject<HTMLInputElement | null>;
  openAttachmentPicker: () => void;
  handleAttachmentInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (event: ChatComposerPasteEvent) => void;
  handleDragOverComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDragLeaveComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDropComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleWhiteboardMentionSelected: (boardId: string) => Promise<void>;
  /** Add files programmatically (for example, plugin UI image context); return accepted attachment IDs and discard any entries over the limit. */
  addAttachmentFiles: (files: File[]) => string[];
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  /** After a successful send, clear only the frozen attachment IDs; omit to explicitly clear the whole attachment area. */
  clearAttachments: (attachmentIds?: readonly string[]) => void;
  /** Restore queue refs already owned by the session as ready chips without triggering upload/adopt. */
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  /** Return only ready refs; return null as a second submit gate if any attachment is not ready. */
  prepareForSend: () => Promise<AttachmentRef[] | null>;
  /** Re-upload frozen draft content into a newly created session and return refs owned by that session. */
  reuploadForSession: (
    sessionId: string,
    attachmentIds: readonly string[],
  ) => Promise<AttachmentRef[]>;
  /** Transfer remote staged content only after sendText is accepted; the draft retains ownership if sending fails. */
  adoptSentAttachments: (attachmentIds: readonly string[]) => Promise<void>;
  setAttachmentError: (message: string | null) => void;
}

export interface UseComposerAttachmentsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  scopeId: string;
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /**
   * Prefer this when the transport exposes runtime liveness; it replaces onRuntimeRestart.
   * unavailable arrives at workspace-dispose time, separating invalidation and wake-up into two actual events.
   */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  disabled?: boolean;
  /**
   * Whether to consume global add-to-chat events (whiteboard references).
   * Semantics match useWebElementContexts and similar hooks: the caller passes `listenAddToChatEvents && !disabled`
   * (SessionPane uses focused to identify the active composer). SidePane forceMount keeps multiple SessionPanes for the same workspace mounted;
   * without this gate, one whiteboard reference would be preventDefaulted and inserted by every composer, silently adding it to background drafts the user cannot see.
   */
  listenAddToChatEvents?: boolean;
}

export async function selectAttachmentLocalPaths(
  platform: Pick<IPlatformService, "selectFile" | "selectFiles">,
): Promise<string[]> {
  const selectedPaths = platform.selectFiles
    ? await platform.selectFiles()
    : await platform.selectFile().then((selectedPath) => (selectedPath ? [selectedPath] : []));
  return selectedPaths.filter((path) => path.trim().length > 0);
}

function buildScopeKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}\u0000${scopeId}`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof Error && error.cause !== undefined ? isAbortError(error.cause) : false;
}

class RemoteAttachmentNotStagedError extends Error {
  readonly code = REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE;
}

export function isTransientAttachmentUploadError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof OversizedInlineVideoAttachmentError) return false;
  if (error instanceof OversizedInlinePdfAttachmentError) return false;
  if (error instanceof MissingInlinePdfContentError) return false;
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  // Video-size-limit errors must be in the blocklist or they trigger a pointless retry. Match the exact error type
  // so broadening the message regex does not change existing image-size-limit handling.
  return !/(?:payloadTooLarge|invalidBase64|invalidServerProgress|frameTooLarge|permission|EACCES|ENOENT|not found|unsupported|附件缺少|缺少可读取内容|远端附件未完成物化)/iu.test(
    message,
  );
}

function progressPercent(uploadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(99, Math.max(0, Math.floor((uploadedBytes / totalBytes) * 99)));
}

function isRemoteAttachmentTarget(
  target: Pick<UploadTarget, "remoteSessionId" | "workspaceIdentity">,
) {
  // This previously required workspaceIdentity to be recognized by the current parser. A new remote-identity format or
  // a temporarily non-canonical value could be misclassified as a local workspace before remoteSessionId was injected,
  // sending host localPath to a remote Agent via zero-copy. Identity provides isolation only; any non-empty value must fail closed as remote.
  return Boolean(target.remoteSessionId?.trim() || target.workspaceIdentity?.trim());
}

export function useComposerAttachments(
  options: UseComposerAttachmentsOptions,
): ComposerAttachmentsApi {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId,
    attachmentSessionId = null,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled = false,
    listenAddToChatEvents = true,
  } = options;
  const platform = usePlatform();
  const { promptAttachmentTransferService } = useServices();
  const { intl } = useZCodeIntl();
  const scopeKey = buildScopeKey(workspacePath, workspaceIdentity, scopeId);
  exposeComposerAttachmentScopeKeyForE2E(scopeKey);

  const targetsRef = useRef(new Map<string, UploadTarget>());
  const uploadQueueRef = useRef<UploadQueueEntry[]>([]);
  const activeUploadsRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const completeTimersRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Map<string, number>());
  const pumpQueueRef = useRef<() => void>(() => {});
  const attachments = useComposerAttachmentUploadStore(
    (state) => state.scopes[scopeKey] ?? EMPTY_COMPOSER_ATTACHMENTS,
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /**
   * Runtime generation counter. attachmentSessionId may remain unchanged after a generation change (formal sessions recover via cold-resume);
   * depending only on it would miss the wake-up and leave attachments stuck in waitingSession.
   */
  const [restartEpoch, setRestartEpoch] = useState(0);
  const [composerDragKind, setComposerDragKind] = useState<"attachment" | "workspace" | null>(null);
  const isDraggingOverComposer = composerDragKind !== null;
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const dragFeedbackTimerRef = useRef<number | null>(null);

  targetsRef.current.set(scopeKey, {
    sessionId: attachmentSessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    attachmentPut,
    transferService: promptAttachmentTransferService,
  });

  const commitScope = useCallback(
    (
      targetScopeKey: string,
      update: (current: ComposerAttachmentUploadItem[]) => ComposerAttachmentUploadItem[],
    ) => {
      updateComposerAttachmentScope(targetScopeKey, update);
    },
    [],
  );

  const updateItem = useCallback(
    (
      targetScopeKey: string,
      attachmentId: string,
      update: (item: ComposerAttachmentUploadItem) => ComposerAttachmentUploadItem,
    ) => {
      commitScope(targetScopeKey, (current) =>
        current.map((item) => (item.id === attachmentId ? update(item) : item)),
      );
    },
    [commitScope],
  );

  const enqueueUpload = useCallback((targetScopeKey: string, attachmentId: string) => {
    const exists = uploadQueueRef.current.some(
      (entry) => entry.scopeKey === targetScopeKey && entry.attachmentId === attachmentId,
    );
    if (!exists) uploadQueueRef.current.push({ scopeKey: targetScopeKey, attachmentId });
    queueMicrotask(() => pumpQueueRef.current());
  }, []);

  const finishWithReady = useCallback(
    (targetScopeKey: string, attachmentId: string, ref: AttachmentRef, staged: boolean) => {
      updateItem(targetScopeKey, attachmentId, (item) => ({
        ...item,
        uploadStatus: "ready",
        uploadProgress: 100,
        uploadError: undefined,
        uploadErrorKind: undefined,
        attachmentRef: ref,
        staged,
        showComplete: !item.localZeroCopy,
      }));
      const timerKey = `${targetScopeKey}\u0000${attachmentId}`;
      const previousTimer = completeTimersRef.current.get(timerKey);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(() => {
        completeTimersRef.current.delete(timerKey);
        updateItem(targetScopeKey, attachmentId, (item) => ({
          ...item,
          showComplete: false,
        }));
      }, COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS);
      completeTimersRef.current.set(timerKey, timer);
    },
    [updateItem],
  );

  const runUpload = useCallback(
    async (targetScopeKey: string, attachmentId: string, target: UploadTarget) => {
      const controllerKey = `${targetScopeKey}\u0000${attachmentId}`;
      const controller = new AbortController();
      controllersRef.current.set(controllerKey, controller);
      updateItem(targetScopeKey, attachmentId, (item) => ({
        ...item,
        uploadStatus: "uploading",
        uploadProgress: Math.min(item.uploadProgress, 99),
        uploadError: undefined,
        uploadErrorKind: undefined,
      }));
      let progressSubscription: { dispose(): void } | null = null;
      try {
        const item = readComposerAttachmentScope(targetScopeKey).find(
          (candidate) => candidate.id === attachmentId,
        );
        if (!item || !target.sessionId) return;
        if (item.localPath && isRemoteAttachmentTarget(target)) {
          if (!target.remoteSessionId) {
            updateItem(targetScopeKey, attachmentId, (current) => ({
              ...current,
              uploadStatus: "waitingSession",
            }));
            return;
          }
          progressSubscription = target.transferService.onDynamicProgress(item.operationId)(
            (progress) => {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(targetScopeKey, attachmentId, (current) => ({
                ...current,
                uploadStatus: progress.phase === "committing" ? "committing" : current.uploadStatus,
                uploadProgress: Math.max(
                  current.uploadProgress,
                  progressPercent(progress.uploadedBytes, progress.totalBytes),
                ),
              }));
            },
          );
          const result = await target.transferService.stage({
            operationId: item.operationId,
            sessionId: target.sessionId,
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            remoteSessionId: target.remoteSessionId,
            localPath: item.localPath,
            fileName: item.filename,
            mime: item.mimeType,
            sizeBytes: item.sizeBytes,
          });
          if (controllersRef.current.get(controllerKey) !== controller) return;
          // The remote ServiceAccessor previously injected a local transfer service by mistake and returned
          // staged:false + host localPath. The remote Agent cannot read that path, so block the send.
          if (!result.staged) {
            throw new RemoteAttachmentNotStagedError(
              intl.formatMessage({
                id: "chat.attachments.upload.remoteMaterializationRequired",
              }),
            );
          }
          finishWithReady(
            targetScopeKey,
            attachmentId,
            {
              ref: result.ref,
              fileName: item.filename,
              mime: item.mimeType,
              bytes: result.bytes,
              ...(item.sourceKind
                ? { sourceKind: item.sourceKind, messageCount: item.messageCount }
                : {}),
            },
            result.staged,
          );
          return;
        }

        const serialized = await serializeChatComposerAttachment(item);
        const ref = await uploadComposerAttachment(
          target.attachmentPut,
          target.sessionId,
          serialized,
          {
            signal: controller.signal,
            onProgress(progress) {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(targetScopeKey, attachmentId, (current) => ({
                ...current,
                uploadStatus: progress.phase === "committing" ? "committing" : "uploading",
                uploadProgress: Math.max(
                  current.uploadProgress,
                  progressPercent(progress.uploadedBytes, progress.totalBytes),
                ),
              }));
            },
          },
        );
        if (!ref) throw new Error("附件缺少可读取内容");
        if (controllersRef.current.get(controllerKey) !== controller) return;
        finishWithReady(targetScopeKey, attachmentId, ref, false);
      } catch (error) {
        if (controllersRef.current.get(controllerKey) !== controller || controller.signal.aborted) {
          return;
        }
        const current = readComposerAttachmentScope(targetScopeKey).find(
          (candidate) => candidate.id === attachmentId,
        );
        if (!current) return;
        // The UI formats structured size-limit errors by locale (matching the chatAttachments serialization-boundary contract).
        const message =
          error instanceof OversizedInlineVideoAttachmentError
            ? intl.formatMessage(
                { id: "chat.attachments.oversizedInlineVideo" },
                {
                  filename: error.filename,
                  size: formatAttachmentSize(error.sizeBytes),
                  maxSize: formatAttachmentSize(error.maxSizeBytes),
                },
              )
            : error instanceof OversizedInlinePdfAttachmentError
              ? intl.formatMessage(
                  { id: "chat.attachments.oversizedInlinePdf" },
                  {
                    filename: error.filename,
                    size: formatAttachmentSize(error.sizeBytes),
                    maxSize: formatAttachmentSize(error.maxSizeBytes),
                  },
                )
              : error instanceof MissingInlinePdfContentError
                ? intl.formatMessage(
                    { id: "chat.attachments.missingInlinePdfContent" },
                    { filename: error.filename },
                  )
                : error instanceof Error
                  ? error.message
                  : String(error);
        const transient = isTransientAttachmentUploadError(error);
        if (transient && current.autoRetryCount < 1) {
          updateItem(targetScopeKey, attachmentId, (item) => ({
            ...item,
            uploadStatus: "queued",
            uploadProgress: 0,
            uploadError: message,
            uploadErrorKind: "transient",
            autoRetryCount: item.autoRetryCount + 1,
          }));
          const timerKey = `${targetScopeKey}\u0000${attachmentId}`;
          const timer = window.setTimeout(() => {
            retryTimersRef.current.delete(timerKey);
            enqueueUpload(targetScopeKey, attachmentId);
          }, COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS);
          retryTimersRef.current.set(timerKey, timer);
        } else {
          updateItem(targetScopeKey, attachmentId, (item) => ({
            ...item,
            uploadStatus: "failed",
            uploadProgress: Math.min(item.uploadProgress, 99),
            uploadError: message,
            uploadErrorKind: transient ? "transient" : "permanent",
          }));
          logger.warn("[v4-composer-attachments] 附件上传失败", {
            attachmentId,
            error: message,
            scopeKey: targetScopeKey,
          });
        }
      } finally {
        progressSubscription?.dispose();
        if (controllersRef.current.get(controllerKey) === controller) {
          controllersRef.current.delete(controllerKey);
        }
        activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
        pumpQueueRef.current();
      }
    },
    [enqueueUpload, finishWithReady, intl, updateItem],
  );

  const pumpQueue = useCallback(() => {
    while (
      activeUploadsRef.current < COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY &&
      uploadQueueRef.current.length > 0
    ) {
      const entry = uploadQueueRef.current.shift();
      if (!entry) break;
      const item = readComposerAttachmentScope(entry.scopeKey).find(
        (candidate) => candidate.id === entry.attachmentId,
      );
      if (!item || (item.uploadStatus !== "queued" && item.uploadStatus !== "waitingSession")) {
        continue;
      }
      const target = targetsRef.current.get(entry.scopeKey);
      const waitingForRemoteSession = Boolean(
        target && item.localPath && isRemoteAttachmentTarget(target) && !target.remoteSessionId,
      );
      if (!target?.sessionId || waitingForRemoteSession) {
        updateItem(entry.scopeKey, entry.attachmentId, (current) => ({
          ...current,
          uploadStatus: "waitingSession",
        }));
        continue;
      }
      activeUploadsRef.current += 1;
      void runUpload(entry.scopeKey, entry.attachmentId, target);
    }
  }, [runUpload, updateItem]);
  pumpQueueRef.current = pumpQueue;

  useEffect(() => {
    const current = readComposerAttachmentScope(scopeKey);
    const remoteTargetReady =
      !isRemoteAttachmentTarget({ remoteSessionId, workspaceIdentity }) || Boolean(remoteSessionId);
    if (attachmentSessionId && remoteTargetReady) {
      for (const item of current) {
        if (item.uploadStatus === "waitingSession") {
          updateItem(scopeKey, item.id, (candidate) => ({
            ...candidate,
            uploadStatus: "queued",
          }));
          enqueueUpload(scopeKey, item.id);
        }
      }
    }
  }, [
    attachmentSessionId,
    enqueueUpload,
    remoteSessionId,
    restartEpoch,
    scopeKey,
    updateItem,
    workspaceIdentity,
  ]);

  /**
   * Invalidate on generation change: cancel in-flight uploads and remote staging, and return attachments to waitingSession for the new session.
   * With silent=true, do not show error copy—this is an automatic recovery (invalidate → rebuild prewarm → retry in 1–2s),
   * and an error would make users think something is wrong. waitingSession already renders “Waiting for session.”
   */
  const invalidateAttachmentsForRuntimeChange = useCallback(
    ({ silent }: { silent: boolean }) => {
      for (const [targetScopeKey, items] of Object.entries(
        useComposerAttachmentUploadStore.getState().scopes,
      )) {
        const target = targetsRef.current.get(targetScopeKey);
        if (!target) continue;
        for (const item of items) {
          if (
            item.referenceOwnership === "session" ||
            item.localZeroCopy ||
            item.uploadStatus === "failed"
          ) {
            continue;
          }
          const key = `${targetScopeKey}\u0000${item.id}`;
          controllersRef.current.get(key)?.abort();
          controllersRef.current.delete(key);
          if (item.staged) void target?.transferService.cleanup(item.operationId).catch(() => {});
          if (item.runtimeRebuildRetryCount >= COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT) {
            // Exhausting the retry allowance is a real failure and must be shown to the user, even in silent mode.
            updateItem(targetScopeKey, item.id, (current) => ({
              ...current,
              uploadStatus: "failed",
              uploadProgress: 0,
              uploadError: intl.formatMessage({
                id: "chat.attachments.upload.runtimeRestarted",
              }),
              uploadErrorKind: "runtimeRestarted",
              attachmentRef: undefined,
              staged: false,
              adopted: false,
              showComplete: false,
            }));
            continue;
          }
          // After a generation change, sessionId in targetsRef is necessarily stale (written during render, before the generation event arrives).
          // Enqueueing it would immediately hit sessionNotFound. Return all attachments to waitingSession, then let the wake-up effect
          // driven by restartEpoch/new attachmentSessionId enqueue them once the session is available.
          updateItem(targetScopeKey, item.id, (current) => ({
            ...current,
            uploadStatus: "waitingSession",
            uploadProgress: 0,
            ...(silent
              ? { uploadError: undefined, uploadErrorKind: undefined }
              : {
                  uploadError: intl.formatMessage({
                    id: "chat.attachments.upload.runtimeRestarted",
                  }),
                  uploadErrorKind: "runtimeRestarted" as const,
                }),
            attachmentRef: undefined,
            staged: false,
            adopted: false,
            showComplete: false,
            runtimeRebuildRetryCount: current.runtimeRebuildRetryCount + 1,
          }));
        }
      }
    },
    [intl, updateItem],
  );

  useEffect(() => {
    // Subscribe through only one channel: subscribing to both would invalidate twice for the same generation change and waste a retry.
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        if (state === "unavailable") {
          // Invalidation and wake-up are separated here: the old CLI is dead and the new one is not ready yet.
          // Incrementing restartEpoch would immediately enqueue the wake-up effect against the dead process (especially visible when formal-session sessionId stays unchanged).
          invalidateAttachmentsForRuntimeChange({ silent: true });
          return;
        }
        // Draft state is actually woken by the new attachmentSessionId after it is rebuilt; this path is the fallback for formal-session state.
        setRestartEpoch((current) => current + 1);
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(() => {
      invalidateAttachmentsForRuntimeChange({ silent: false });
      // Keep invalidation separate from wake-up: this handler invalidates only, and the effect depending on restartEpoch handles enqueueing.
      setRestartEpoch((current) => current + 1);
    });
  }, [invalidateAttachmentsForRuntimeChange, onRuntimeLifecycle, onRuntimeRestart]);

  const showAttachmentLimitWarning = useCallback(() => {
    // Updating only the text below the input gives little feedback for repeated size-limit errors; show a toast for every add without stacking toasts in one input.
    toast(
      intl.formatMessage(
        { id: "chat.attachments.maxFiles" },
        { count: String(MAX_CHAT_ATTACHMENTS) },
      ),
      { variant: "warning", position: "bottom-center", dedupeKey: `attachment-limit:${scopeKey}` },
    );
  }, [intl, scopeKey]);

  const addPreparedAttachments = useCallback(
    (selectedAttachments: ChatComposerAttachment[]): string[] => {
      if (selectedAttachments.length === 0) return [];
      const current = readComposerAttachmentScope(scopeKey);
      const remainingSlots = MAX_CHAT_ATTACHMENTS - current.length;
      if (remainingSlots <= 0) {
        selectedAttachments.forEach(revokeChatComposerAttachment);
        showAttachmentLimitWarning();
        return [];
      }
      const accepted = selectedAttachments.slice(0, remainingSlots);
      selectedAttachments.slice(remainingSlots).forEach(revokeChatComposerAttachment);
      const target = targetsRef.current.get(scopeKey);
      const items: ComposerAttachmentUploadItem[] = accepted.map((attachment) => {
        // Remote identity is often available before remoteSessionId is injected; do not fall back to direct local-path reads during this window.
        const localZeroCopy = Boolean(
          attachment.localPath && target && !isRemoteAttachmentTarget(target),
        );
        return {
          ...attachment,
          referenceOwnership: "composer",
          operationId: `prompt-attachment-${attachment.id}`,
          uploadStatus: localZeroCopy ? "ready" : target?.sessionId ? "queued" : "waitingSession",
          uploadProgress: localZeroCopy ? 100 : 0,
          ...(localZeroCopy && attachment.localPath
            ? {
                attachmentRef: {
                  ref: attachment.localPath,
                  fileName: attachment.filename,
                  mime: attachment.mimeType,
                  bytes: attachment.sizeBytes,
                },
              }
            : {}),
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: false,
          showComplete: false,
          localZeroCopy,
        };
      });
      commitScope(scopeKey, (existing) => [...existing, ...items]);
      setAttachmentError(null);
      if (selectedAttachments.length > remainingSlots) showAttachmentLimitWarning();
      for (const item of items) {
        if (item.uploadStatus === "queued") enqueueUpload(scopeKey, item.id);
      }
      return items.map((item) => item.id);
    },
    [commitScope, enqueueUpload, scopeKey, showAttachmentLimitWarning],
  );

  const addAttachmentFiles = useCallback(
    (selectedFiles: File[]): string[] => {
      return addPreparedAttachments(
        selectedFiles.map((file) => {
          let localPath: string | undefined;
          try {
            const resolvedPath = platform.getPathForFile?.(file);
            localPath = resolvedPath?.trim() ? resolvedPath : undefined;
          } catch (error) {
            // Electron 32+ files must be resolved through preload webUtils; on failure, fall back to Web bytes.
            logger.warn("[v4-composer-attachments] 解析附件本地路径失败", error);
          }
          return createChatComposerAttachment(file, localPath);
        }),
      );
    },
    [addPreparedAttachments, platform],
  );

  const addAttachmentLocalPaths = useCallback(
    (selectedPaths: string[]) => {
      addPreparedAttachments(selectedPaths.map(createChatComposerPathAttachment));
    },
    [addPreparedAttachments],
  );

  const openAttachmentPicker = useCallback(() => {
    if (readComposerAttachmentScope(scopeKey).length >= MAX_CHAT_ATTACHMENTS) {
      showAttachmentLimitWarning();
      return;
    }
    if (!platform.canSelectFilePath) {
      attachmentInputRef.current?.click();
      return;
    }
    void selectAttachmentLocalPaths(platform)
      .then((paths) => addAttachmentLocalPaths(paths))
      .catch((error) => {
        logger.warn("[v4-composer-attachments] 选择附件路径失败", error);
        setAttachmentError(
          intl.formatMessage(
            { id: "chat.attachments.readFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      });
  }, [addAttachmentLocalPaths, intl, platform, scopeKey, showAttachmentLimitWarning]);

  const handleAttachmentInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      addAttachmentFiles(files);
    },
    [addAttachmentFiles],
  );

  const handlePaste = useCallback(
    (event: ChatComposerPasteEvent) => {
      if (disabled || !event.clipboardData) return;
      const files = Array.from(event.clipboardData.files);
      const text = event.clipboardData.getData("text/plain");
      const html = event.clipboardData.getData("text/html");
      const prefersSpreadsheetText =
        files.length > 0 && shouldPreferSpreadsheetClipboardText(text, html);
      if (files.length > 0) {
        logger.debug("[v4-composer-attachments] 识别剪贴板多表示 payload", {
          clipboardTypes: Array.from(event.clipboardData.types),
          fileTypes: files.map((file) => file.type),
          prefersSpreadsheetText,
          textLength: text.length,
        });
      }
      if (files.length > 0 && !prefersSpreadsheetText) {
        event.preventDefault();
        event.stopPropagation?.();
        addAttachmentFiles(files);
        return;
      }
      if (!shouldCreateClipboardTextAttachment(text)) return;
      event.preventDefault();
      event.stopPropagation?.();
      void (async () => {
        try {
          const attachment = await platform.createTempTextAttachment?.({
            text,
            filename: createClipboardTextAttachmentFilenameForDate(),
          });
          if (!attachment) throw new Error("当前平台不支持临时文本附件");
          addPreparedAttachments([createClipboardTextPathComposerAttachment(text, attachment)]);
        } catch (error) {
          logger.warn("[v4-composer-attachments] 创建粘贴文本临时附件失败", error);
          setAttachmentError(
            intl.formatMessage(
              { id: "chat.attachments.readFailed" },
              { message: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      })();
    },
    [addAttachmentFiles, addPreparedAttachments, disabled, intl, platform],
  );

  const clearDragFeedbackTimer = useCallback(() => {
    if (dragFeedbackTimerRef.current !== null) {
      window.clearTimeout(dragFeedbackTimerRef.current);
      dragFeedbackTimerRef.current = null;
    }
  }, []);
  const resetComposerDragFeedback = useCallback(() => {
    clearDragFeedbackTimer();
    setComposerDragKind(null);
  }, [clearDragFeedbackTimer]);
  const scheduleComposerDragFeedbackReset = useCallback(() => {
    clearDragFeedbackTimer();
    dragFeedbackTimerRef.current = window.setTimeout(resetComposerDragFeedback, 300);
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  useEffect(() => {
    const handleDocumentDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) resetComposerDragFeedback();
    };
    window.addEventListener("dragend", resetComposerDragFeedback);
    window.addEventListener("drop", resetComposerDragFeedback);
    window.addEventListener("blur", resetComposerDragFeedback);
    document.addEventListener("dragleave", handleDocumentDragLeave);
    return () => {
      clearDragFeedbackTimer();
      window.removeEventListener("dragend", resetComposerDragFeedback);
      window.removeEventListener("drop", resetComposerDragFeedback);
      window.removeEventListener("blur", resetComposerDragFeedback);
      document.removeEventListener("dragleave", handleDocumentDragLeave);
    };
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  const handleDragOverComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const types = Array.from(event.dataTransfer.types);
      const hasFiles = Array.from(event.dataTransfer.items ?? []).some(
        (item) => item.kind === "file",
      );
      if (!hasFiles && !types.includes("Files") && !types.includes(WORKSPACE_FILE_DRAG_MIME)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setComposerDragKind(types.includes(WORKSPACE_FILE_DRAG_MIME) ? "workspace" : "attachment");
      scheduleComposerDragFeedbackReset();
    },
    [scheduleComposerDragFeedbackReset],
  );
  const handleDragLeaveComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
        resetComposerDragFeedback();
      }
    },
    [resetComposerDragFeedback],
  );
  const handleDropComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (Array.from(event.dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME)) {
        event.preventDefault();
        resetComposerDragFeedback();
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        event.preventDefault();
        addAttachmentFiles(files);
      }
      resetComposerDragFeedback();
    },
    [addAttachmentFiles, resetComposerDragFeedback],
  );

  const addWhiteboardToChat = useCallback(
    async (boardId: string) => {
      const board = useWhiteboardStore.getState().getBoard({
        boardId,
        workspaceIdentity,
        workspacePath,
      });
      if (!board) {
        setAttachmentError(intl.formatMessage({ id: "whiteboard.exportMissing" }));
        return;
      }
      try {
        addAttachmentFiles([createWhiteboardPngFile(board)]);
      } catch (error) {
        setAttachmentError(
          intl.formatMessage(
            { id: "whiteboard.exportFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      }
    },
    [addAttachmentFiles, intl, workspaceIdentity, workspacePath],
  );
  const handleWhiteboardMentionSelected = useCallback(
    async (boardId: string) => addWhiteboardToChat(boardId),
    [addWhiteboardToChat],
  );
  useEffect(() => {
    // Same early return as useWebElementContexts and similar hooks. SidePane forceMount keeps SessionPanes for unfocused conversations mounted;
    // only the focused composer (listenAddToChatEvents) may consume add-to-chat events, or multiple composers in the same workspace will all insert the attachment.
    if (!listenAddToChatEvents || typeof window === "undefined") return;
    const handle = (event: Event) => {
      if (!isWhiteboardAddToChatEvent(event)) return;
      if (
        buildWhiteboardWorkspaceKey(event.detail) !==
        buildWhiteboardWorkspaceKey({ workspacePath, workspaceIdentity })
      ) {
        return;
      }
      event.preventDefault();
      void addWhiteboardToChat(event.detail.boardId);
    };
    window.addEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
    return () => window.removeEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
  }, [addWhiteboardToChat, listenAddToChatEvents, workspaceIdentity, workspacePath]);

  const removeAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey);
      const item = current.find((candidate) => candidate.id === id);
      if (!item) return;
      const key = `${scopeKey}\u0000${id}`;
      controllersRef.current.get(key)?.abort();
      controllersRef.current.delete(key);
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => !(entry.scopeKey === scopeKey && entry.attachmentId === id),
      );
      const completeTimer = completeTimersRef.current.get(key);
      if (completeTimer !== undefined) window.clearTimeout(completeTimer);
      const retryTimer = retryTimersRef.current.get(key);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      completeTimersRef.current.delete(key);
      retryTimersRef.current.delete(key);
      revokeChatComposerAttachment(item);
      const target = targetsRef.current.get(scopeKey);
      if (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing") {
        void target?.transferService.cancel(item.operationId).catch((error) => {
          logger.warn("[v4-composer-attachments] 取消远程附件失败", error);
        });
      }
      commitScope(scopeKey, (items) => items.filter((candidate) => candidate.id !== id));
      setAttachmentError(null);
    },
    [commitScope, scopeKey],
  );

  const retryAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey).find(
        (candidate) => candidate.id === id,
      );
      if (!current || current.uploadStatus !== "failed") return;
      const target = targetsRef.current.get(scopeKey);
      void target?.transferService.cleanup(current.operationId).catch(() => {});
      updateItem(scopeKey, id, (item) => ({
        ...item,
        uploadStatus: target?.sessionId ? "queued" : "waitingSession",
        uploadProgress: 0,
        uploadError: undefined,
        uploadErrorKind: undefined,
        attachmentRef: undefined,
        autoRetryCount: 0,
        runtimeRebuildRetryCount: 0,
        staged: false,
        adopted: false,
        showComplete: false,
      }));
      if (target?.sessionId) enqueueUpload(scopeKey, id);
    },
    [enqueueUpload, scopeKey, updateItem],
  );

  const clearAttachments = useCallback(
    (attachmentIds?: readonly string[]) => {
      const ids = attachmentIds ? new Set(attachmentIds) : null;
      const current = readComposerAttachmentScope(scopeKey).filter(
        (item) => !ids || ids.has(item.id),
      );
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        const key = `${scopeKey}\u0000${item.id}`;
        controllersRef.current.get(key)?.abort();
        controllersRef.current.delete(key);
        const completeTimer = completeTimersRef.current.get(key);
        if (completeTimer !== undefined) window.clearTimeout(completeTimer);
        const retryTimer = retryTimersRef.current.get(key);
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        completeTimersRef.current.delete(key);
        retryTimersRef.current.delete(key);
        revokeChatComposerAttachment(item);
        if (
          !item.adopted &&
          (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing")
        ) {
          void target?.transferService.cleanup(item.operationId).catch((error) => {
            logger.warn("[v4-composer-attachments] 清理未发送附件失败", error);
          });
        }
      }
      // Clearing the whole scope after ACK would also delete attachments added while it was pending.
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => entry.scopeKey !== scopeKey || (ids !== null && !ids.has(entry.attachmentId)),
      );
      commitScope(scopeKey, (items) => (ids ? items.filter((item) => !ids.has(item.id)) : []));
      setAttachmentError(null);
    },
    [commitScope, scopeKey],
  );

  const restoreSessionOwnedAttachments = useCallback(
    (attachmentRefs: readonly AttachmentRef[]): boolean => {
      if (attachmentRefs.length === 0) return true;
      if (readComposerAttachmentScope(scopeKey).length > 0) return false;
      const restored: ComposerAttachmentUploadItem[] = attachmentRefs.map((attachmentRef) => {
        const id = nanoid();
        return {
          id,
          filename: attachmentRef.fileName,
          ...(attachmentRef.sourceKind
            ? { sourceKind: attachmentRef.sourceKind, messageCount: attachmentRef.messageCount }
            : {}),
          mimeType: attachmentRef.mime,
          sizeBytes: attachmentRef.bytes,
          referenceOwnership: "session",
          uploadStatus: "ready",
          uploadProgress: 100,
          attachmentRef: { ...attachmentRef },
          operationId: `session-owned-${id}`,
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: true,
          showComplete: false,
          localZeroCopy: false,
        };
      });
      // AttachmentRefs in the queue were taken over by the session on the first send. Rebuilding them as ordinary
      // composer files would repeat upload/adopt after retraction and incorrectly clear the references on runtime restart.
      commitScope(scopeKey, () => restored);
      setAttachmentError(null);
      return true;
    },
    [commitScope, scopeKey],
  );

  const prepareForSend = useCallback(async (): Promise<AttachmentRef[] | null> => {
    const current = readComposerAttachmentScope(scopeKey);
    if (current.some((item) => item.uploadStatus !== "ready" || !item.attachmentRef)) {
      return null;
    }
    return current.flatMap((item) => (item.attachmentRef ? [item.attachmentRef] : []));
  }, [scopeKey]);

  const reuploadForSession = useCallback(
    async (sessionId: string, attachmentIds: readonly string[]): Promise<AttachmentRef[]> => {
      const target = targetsRef.current.get(scopeKey);
      if (!target) throw new Error("Attachment target is unavailable");
      const current = readComposerAttachmentScope(scopeKey);
      const serializedAttachments = [];
      for (const id of attachmentIds) {
        const item = current.find((candidate) => candidate.id === id);
        if (!item) throw new Error("Frozen composer attachment is unavailable");
        serializedAttachments.push(await serializeChatComposerAttachment(item));
      }
      return await uploadComposerAttachments(
        target.attachmentPut,
        sessionId,
        serializedAttachments,
      );
    },
    [scopeKey],
  );

  const adoptSentAttachments = useCallback(
    async (attachmentIds: readonly string[]): Promise<void> => {
      const ids = new Set(attachmentIds);
      // The handoff boundary must match this Submission; do not transfer attachments for the next message to the Session early.
      const current = readComposerAttachmentScope(scopeKey).filter((item) => ids.has(item.id));
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        if (item.staged && !item.adopted) {
          try {
            await target?.transferService.adopt(item.operationId);
          } catch (error) {
            // sendText succeeded; an adopt-ack failure must not put the same message back into the composer.
            logger.warn("[v4-composer-attachments] 附件发送后 adopt 失败", error);
          }
          updateItem(scopeKey, item.id, (candidate) => ({
            ...candidate,
            adopted: true,
          }));
        }
      }
    },
    [scopeKey, updateItem],
  );

  return useMemo(
    () => ({
      attachments,
      attachmentError,
      composerDragKind,
      hasAttachments: attachments.length > 0,
      hasUnreadyAttachments: attachments.some((item) => item.uploadStatus !== "ready"),
      isDraggingOverComposer,
      attachmentInputRef,
      openAttachmentPicker,
      handleAttachmentInputChange,
      handlePaste,
      handleDragOverComposer,
      handleDragLeaveComposer,
      handleDropComposer,
      handleWhiteboardMentionSelected,
      addAttachmentFiles,
      removeAttachment,
      retryAttachment,
      clearAttachments,
      restoreSessionOwnedAttachments,
      prepareForSend,
      reuploadForSession,
      adoptSentAttachments,
      setAttachmentError,
    }),
    [
      addAttachmentFiles,
      attachmentError,
      adoptSentAttachments,
      attachments,
      composerDragKind,
      clearAttachments,
      restoreSessionOwnedAttachments,
      handleAttachmentInputChange,
      handleDragLeaveComposer,
      handleDragOverComposer,
      handleDropComposer,
      handlePaste,
      handleWhiteboardMentionSelected,
      isDraggingOverComposer,
      openAttachmentPicker,
      prepareForSend,
      reuploadForSession,
      removeAttachment,
      retryAttachment,
    ],
  );
}
