// Shared MIME inference and size validation for video attachments.
// Both the Read tool (read-video.ts) and prompt-attachment parser (attachments.ts) use this module,
// keeping one extension-to-MIME mapping; contracts (ReadVideoOutput) remains the single source for MIME enums.
import type { ReadVideoOutput } from "@zcode/contracts";
import { base64PayloadByteLength, isStrictBase64Payload } from "./attachment-data-url.js";

export type VideoInputMimeType = ReadVideoOutput["mimeType"];

const VIDEO_INPUT_MIME_BY_EXTENSION: Record<string, VideoInputMimeType> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** Infers video MIME from the extension; returns undefined for unsupported video extensions. */
export function inferVideoMimeFromPath(path: string): VideoInputMimeType | undefined {
  const lower = path.toLowerCase();
  for (const [extension, mime] of Object.entries(VIDEO_INPUT_MIME_BY_EXTENSION)) {
    if (lower.endsWith(extension)) return mime;
  }
  return undefined;
}

export function parseInlineVideoDataUrl(
  dataUrl: string,
): { mediaType: string; sizeBytes: number } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  const mediaType = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  // Inline video previously checked only a permissive data URL header; missing base64 markers,
  // invalid bodies, and non-video MIME types could continue into persistence or the generic-text path.
  if (
    !mediaType?.startsWith("video/") ||
    payload === undefined ||
    !isStrictBase64Payload(payload)
  ) {
    return undefined;
  }
  return { mediaType, sizeBytes: base64PayloadByteLength(payload) };
}
