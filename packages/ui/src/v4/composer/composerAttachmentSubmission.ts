import type { IPromptAttachmentTransferService } from "@zcode/services";
import {
  readComposerAttachmentScope,
  moveComposerAttachmentScopeItems,
  updateComposerAttachmentScope,
} from "@/store/composerAttachmentUploadStore.js";
import {
  revokeChatComposerAttachment,
  serializeChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { uploadComposerAttachments, type AttachmentPutFn } from "./attachmentUpload.js";
import { logger } from "@/logger.js";

/** All operations retain the submitted ids and owner after Composer changes scope. */
export function captureComposerAttachmentSubmission(
  sourceScope: string,
  attachmentIds: readonly string[],
  target: {
    attachmentPut: AttachmentPutFn;
    transferService: IPromptAttachmentTransferService;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  },
) {
  let scope = sourceScope;
  const ids = new Set(attachmentIds);
  const selected = () => readComposerAttachmentScope(scope).filter((item) => ids.has(item.id));
  return {
    moveToScope(nextScope: string) {
      if (nextScope === scope) return;
      moveComposerAttachmentScopeItems(scope, nextScope, attachmentIds);
      scope = nextScope;
    },
    async prepareForSend(
      _attachmentIds?: readonly string[],
      options?: { allowWaitingSession?: boolean },
    ) {
      const items = selected();
      if (
        items.length !== ids.size ||
        items.some(
          (item) =>
            !(options?.allowWaitingSession && item.uploadStatus === "waitingSession") &&
            (item.uploadStatus !== "ready" || !item.attachmentRef),
        )
      )
        return null;
      return items.flatMap((item) => (item.attachmentRef ? [item.attachmentRef] : []));
    },
    async reuploadForSession(sessionId: string, _attachmentIds?: readonly string[]) {
      const items = selected();
      if (items.length !== ids.size) throw new Error("Frozen composer attachment is unavailable");
      const refs = [];
      for (const item of items) {
        if (
          item.localPath &&
          (target.workspaceIdentity?.trim() || target.remoteSessionId?.trim())
        ) {
          if (!target.workspacePath || !target.remoteSessionId) {
            throw new Error("Remote attachment target is unavailable");
          }
          // A retry targets another deferred session; do not reuse the earlier session's transfer receipt.
          if (item.staged && !item.adopted) await target.transferService.cleanup(item.operationId);
          const operationId = `${item.operationId}:${sessionId}`;
          const result = await target.transferService.stage({
            operationId,
            sessionId,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            remoteSessionId: target.remoteSessionId,
            localPath: item.localPath,
            fileName: item.filename,
            mime: item.mimeType,
            sizeBytes: item.sizeBytes,
          });
          if (!result.staged) throw new Error("Remote attachment was not materialized");
          updateComposerAttachmentScope(scope, (items) =>
            items.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, operationId, staged: true, adopted: false }
                : candidate,
            ),
          );
          refs.push({
            ref: result.ref,
            fileName: item.filename,
            mime: item.mimeType,
            bytes: result.bytes,
            ...(item.sourceKind
              ? { sourceKind: item.sourceKind, messageCount: item.messageCount }
              : {}),
          });
        } else {
          refs.push(
            ...(await uploadComposerAttachments(target.attachmentPut, sessionId, [
              await serializeChatComposerAttachment(item),
            ])),
          );
        }
      }
      return refs;
    },
    async adoptSentAttachments(_attachmentIds?: readonly string[]) {
      for (const item of selected()) {
        if (item.staged && !item.adopted) {
          try {
            await target.transferService.adopt(item.operationId);
          } catch (error) {
            logger.warn("[composer-attachment] Accepted attachment adoption failed", error);
          }
          updateComposerAttachmentScope(scope, (items) =>
            items.map((candidate) =>
              candidate.id === item.id ? { ...candidate, adopted: true } : candidate,
            ),
          );
        }
      }
    },
    clearAttachments(_attachmentIds?: readonly string[]) {
      for (const item of selected()) revokeChatComposerAttachment(item);
      updateComposerAttachmentScope(scope, (items) => items.filter((item) => !ids.has(item.id)));
    },
    async discardAttachments() {
      for (const item of selected()) {
        if (item.staged && !item.adopted) await target.transferService.cleanup(item.operationId);
        revokeChatComposerAttachment(item);
      }
      updateComposerAttachmentScope(scope, (items) => items.filter((item) => !ids.has(item.id)));
    },
  };
}

export type ComposerAttachmentSubmission = ReturnType<typeof captureComposerAttachmentSubmission>;
