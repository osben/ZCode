// Attachment command surface (UI side): ZCodePromptAttachment (composer serialization output) → AttachmentRef
// (v4 sendText/createSession attachment reference model).
//
// Dispatch rules (the inverse mapping of CLI attachment-refs.ts):
// - localPath (common desktop case: native picker / drag-and-drop getPathForFile / temporary file for large paste /
//   oversized-image path fallback) → ref carries the absolute path directly, no upload;
// - dataBase64 (inline image such as a pasted screenshot) → high-level put (internally begin/chunk/commit) → artifact ref;
// - textContent (pathless text, Web fallback) → encode and use put;
// - none of the above (metadata only) → discard and warn (nothing to send; do not fabricate a reference).
import type { ZCodePromptAttachment } from "@zcode/shared";
import type {
  AttachmentRef,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

export type AttachmentPutFn = (
  params: V4AttachmentPutParams,
  options?: AttachmentUploadOptions,
) => Promise<V4AttachmentPutResult>;

function encodeTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

/** Single attachment → AttachmentRef (uses a chunk transaction when upload is needed). Returns null = nothing to send (discarded). */
export async function uploadComposerAttachment(
  put: AttachmentPutFn,
  sessionId: string,
  attachment: ZCodePromptAttachment,
  options?: AttachmentUploadOptions,
): Promise<AttachmentRef | null> {
  const fileName = attachment.filename;
  const mime = attachment.mimeType;
  const source =
    attachment.kind === "file" && attachment.sourceKind
      ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
      : {};
  // Audio variants have no sizeBytes field; use narrowed access for all variants.
  const sizeBytes =
    "sizeBytes" in attachment && typeof attachment.sizeBytes === "number"
      ? attachment.sizeBytes
      : undefined;
  if (attachment.localPath) {
    return {
      ...source,
      ref: attachment.localPath,
      fileName,
      mime,
      bytes: sizeBytes ?? 0,
    };
  }
  const dataBase64 =
    "dataBase64" in attachment && attachment.dataBase64
      ? attachment.dataBase64
      : "textContent" in attachment && attachment.textContent !== undefined
        ? encodeTextToBase64(attachment.textContent)
        : null;
  if (dataBase64 === null) {
    logger.warn(
      `[v4-composer] 附件无内容可发（无 localPath/dataBase64/textContent），已丢弃: ${fileName}`,
    );
    return null;
  }
  const { ref } = await put({ sessionId, fileName, mime, dataBase64 }, options);
  return {
    ...source,
    ref,
    fileName,
    mime,
    bytes: sizeBytes ?? base64ByteLength(dataBase64),
  };
}

/**
 * Attachment array → AttachmentRef[] (preserving order). Propagate put failures unchanged so the caller can abort sending and keep the draft.
 */
export async function uploadComposerAttachments(
  put: AttachmentPutFn,
  sessionId: string,
  attachments: readonly ZCodePromptAttachment[],
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const attachment of attachments) {
    const ref = await uploadComposerAttachment(put, sessionId, attachment);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}
