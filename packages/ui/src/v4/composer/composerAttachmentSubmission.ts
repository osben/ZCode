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
  target: { attachmentPut: AttachmentPutFn; transferService: IPromptAttachmentTransferService },
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
    async prepareForSend(_attachmentIds?: readonly string[]) {
      const items = selected();
      if (
        items.length !== ids.size ||
        items.some((item) => item.uploadStatus !== "ready" || !item.attachmentRef)
      )
        return null;
      return items.flatMap((item) => (item.attachmentRef ? [item.attachmentRef] : []));
    },
    async reuploadForSession(sessionId: string, _attachmentIds?: readonly string[]) {
      const items = selected();
      if (items.length !== ids.size) throw new Error("Frozen composer attachment is unavailable");
      return uploadComposerAttachments(
        target.attachmentPut,
        sessionId,
        await Promise.all(items.map(serializeChatComposerAttachment)),
      );
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
