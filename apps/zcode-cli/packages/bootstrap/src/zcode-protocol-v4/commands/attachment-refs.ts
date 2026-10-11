// Attachment command surface: map the AttachmentRef reference model across the protocol boundary to core TurnAttachment.
//
// Two ref forms (paired with the "local path / artifact URI" comment on projection-side buildUserInputRow):
// 1. URI refs (scheme-based, such as zcode-artifact://): content references registered through an attachment chunk transaction.
//    - Images: content carries the URI; core's attachment-artifacts resolution chain reads back the
//      data URL when making the model request (same form as externalizePromptAttachments output).
//      Do not decode inline here, which could inflate memory use for large images at the command layer.
//    - PDFs: preserve the URI for core's PDF resolver. Other non-image files: read the artifact and
//      decode it as text up to 64 KiB, following the old decodeTextProtocolAttachment semantics
//      (over the limit or undecodable: keep display metadata only; do not fabricate content).
// 2. Local-path refs (absolute paths passed directly by Desktop): map to a path reference through
//    the old mapProtocolPromptAttachment localPath branch; core already applies read limits and fallback behavior.
import type { TurnAttachment } from "@zcode/core";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";

const URI_REF_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export function isUriAttachmentRef(ref: string): boolean {
  return URI_REF_PATTERN.test(ref);
}

function displayMetaOf(
  ref: AttachmentRef,
): Pick<TurnAttachment, "filename" | "mimeType" | "sizeBytes" | "sourceKind" | "messageCount"> {
  return {
    filename: ref.fileName,
    mimeType: ref.mime,
    sizeBytes: ref.bytes,
    ...(ref.sourceKind ? { sourceKind: ref.sourceKind, messageCount: ref.messageCount } : {}),
  };
}

function isImageRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("image/") ?? false;
}

function isVideoRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("video/") ?? false;
}

function isPdfRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

/** Convert a data URL (data:<mime>;base64,<payload>) to UTF-8 text; return non-base64 data URL bodies as-is. */
function decodeDataUrlText(content: string): string | undefined {
  if (!content.startsWith("data:")) return content;
  const commaIndex = content.indexOf(",");
  if (commaIndex === -1) return undefined;
  const header = content.slice(0, commaIndex);
  const payload = content.slice(commaIndex + 1);
  if (!header.includes(";base64")) return decodeURIComponent(payload);
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

async function mapAttachmentRef(app: ZCodeApp, ref: AttachmentRef): Promise<TurnAttachment> {
  const displayMeta = displayMetaOf(ref);
  if (!isUriAttachmentRef(ref.ref)) {
    // Local path ref: delegate to core's file/image read path (limits and fallback behavior are built in).
    if (isVideoRef(ref)) {
      return { path: ref.ref, type: "video", ...displayMeta };
    }
    return {
      path: ref.ref,
      type: isImageRef(ref) ? "image" : isPdfRef(ref) ? "pdf" : "file",
      ...displayMeta,
    };
  }
  if (ref.sourceKind === "topic-history" || ref.sourceKind === "clipboard-text") {
    // Text material must retain its durable reference; decoding it as an ordinary small file would re-inject the entire history hidden again.
    return { content: ref.ref, type: "file", ...displayMeta };
  }
  if (isImageRef(ref)) {
    // Image URI ref: content carries the artifact URI, which resolveAttachmentDataUrl reads back
    // during the model request (same form as externalizePromptAttachments output, so no second externalization is needed).
    return { content: ref.ref, path: ref.fileName, type: "image", ...displayMeta };
  }
  if (isVideoRef(ref)) {
    // Video URI ref: same shape as an image; content carries the artifact URI and is read back as a data URL during the model request.
    return { content: ref.ref, path: ref.fileName, type: "video", ...displayMeta };
  }
  if (isPdfRef(ref)) {
    // A PDF URI ref must retain its durable URI for core to read as a data URL; do not decode it as UTF-8 text.
    return { content: ref.ref, path: ref.fileName, type: "pdf", ...displayMeta };
  }
  // Non-image URI ref: restore up to 64 KiB of text using the old decodeTextProtocolAttachment semantics.
  if (ref.bytes > INLINE_TEXT_ATTACHMENT_MAX_BYTES) {
    return { type: "file", ...displayMeta };
  }
  try {
    const artifact = await app.readToolResultArtifact(ref.ref);
    const text = decodeDataUrlText(artifact.content);
    return text !== undefined
      ? { content: text, path: ref.fileName, type: "file", ...displayMeta }
      : { type: "file", ...displayMeta };
  } catch {
    // If the ref is invalid (TTL cleanup/write failure), keep display metadata and do not fail the entire send.
    return { type: "file", ...displayMeta };
  }
}

/**
 * Shared by sendText/createSession/editUserQuery: map the attachment ref array to core TurnAttachment[].
 * Empty or omitted array -> undefined (sendInput semantics: omit the field when there are no attachments).
 */
export async function mapAttachmentRefsToTurnAttachments(
  app: ZCodeApp,
  refs: readonly AttachmentRef[] | undefined,
): Promise<TurnAttachment[] | undefined> {
  if (!refs || refs.length === 0) return undefined;
  const mapped = await Promise.all(refs.map((ref) => mapAttachmentRef(app, ref)));
  return mapped.length > 0 ? mapped : undefined;
}
