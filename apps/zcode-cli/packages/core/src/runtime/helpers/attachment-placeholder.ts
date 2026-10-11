import type { FilePartSource, TurnAttachment } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { safeAttachmentOriginalRef } from "./attachment-artifacts.js";

export function resolvedPlaceholderAttachment(
  attachment: TurnAttachment,
  placeholder: string,
  errorCode: string,
  options: {
    filename?: string;
    mime?: string;
    sizeBytes?: number;
    source?: FilePartSource;
  } = {},
): ResolvedTurnAttachment {
  const mime =
    options.mime ??
    (attachment.type === "image"
      ? "image/*"
      : attachment.type === "pdf"
        ? "application/pdf"
        : "text/plain");
  const safeOriginalRef = safeAttachmentOriginalRef(attachment);
  return {
    contentBlock: { type: "text", text: `[Attached ${mime}: ${placeholder}]` },
    filename: options.filename,
    metadata: {
      errorCode,
      originalUrl: safeOriginalRef,
      recoverability: "metadata_only",
      sizeBytes: options.sizeBytes,
      storageKind: attachment.path ? "local_ref" : "metadata_only",
    },
    mime,
    source: options.source,
    // Invalid media data URLs were downgraded to placeholder text, but previously their base64 body was still persisted to the session
    // through the file part's url. Do not write PDF data URLs to part.data; retain recoverable artifact
    // URIs for later diagnostics and retries through the established authorization path.
    url:
      attachment.type === "video" || attachment.type === "pdf"
        ? attachment.content?.startsWith("zcode-artifact://")
          ? attachment.content
          : (attachment.path ??
            (attachment.type === "pdf" ? "inline:pdf" : (safeOriginalRef ?? "")))
        : (attachment.path ?? attachment.content ?? ""),
  };
}
