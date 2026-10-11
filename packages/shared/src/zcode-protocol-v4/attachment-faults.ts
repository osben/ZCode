// Structured error codes for attachment reads/probes, used to classify share preflight and publishing.
//
// Share preflight previously used regexes on `error.message` to distinguish "attachment missing / not
// authorized / other." Classification broke as soon as RPC wrapped, localized, or replaced the message
// (for example, a schema-validation ZodError), downgrading deterministic issues to deferred. Repository
// policy (AGENTS.md: "do not use error text for control flow") requires stable error codes; this module is
// the single source for that contract.
//
// Transport path: the CLI throws an Error with a `code` field, and `toProtocolError` forwards the string
// code to JSON-RPC `error.data.code`. The client reads it with readZCodeAttachmentFaultCode.

export const ZCODE_ATTACHMENT_FAULT_CODES = {
  /** The host does not implement stat. */
  statUnsupported: "fault.attachment.statUnsupported",
  /** The host does not implement reads. */
  readUnsupported: "fault.attachment.readUnsupported",
  /** The path referenced by ref exists but is not a regular file. */
  statNotFile: "fault.attachment.statNotFile",
  /** The target row/ref for share stat is not in the current session projection; authorization is denied. */
  shareStatNotAuthorized: "fault.attachment.shareStatNotAuthorized",
  /** The target row/ref for share read is not in the current session projection; authorization is denied. */
  shareReadNotAuthorized: "fault.attachment.shareReadNotAuthorized",
  /** The connection for share stat is not trusted. */
  shareStatConnectionUntrusted: "fault.attachment.shareStatConnectionUntrusted",
  /** The connection for share read is not trusted. */
  shareReadConnectionUntrusted: "fault.attachment.shareReadConnectionUntrusted",
  /** The attachment is missing from disk (a deterministic absence such as ENOENT). */
  shareStatNotFound: "fault.attachment.shareStatNotFound",
  /** The attachment's actual size exceeds the upper bound representable by the stat protocol. */
  shareStatTooLarge: "fault.attachment.shareStatTooLarge",
  /** The attachment byte count exceeds the preview/read channel limit and cannot be transferred. */
  previewTooLarge: "fault.attachment.previewTooLarge",
  /** The read result is not a previewable media type. */
  previewNotMedia: "fault.attachment.previewNotMedia",
} as const;

export type ZCodeAttachmentFaultCode =
  (typeof ZCODE_ATTACHMENT_FAULT_CODES)[keyof typeof ZCODE_ATTACHMENT_FAULT_CODES];

const KNOWN_FAULT_CODES = new Set<string>(Object.values(ZCODE_ATTACHMENT_FAULT_CODES));

export function isZCodeAttachmentFaultCode(value: unknown): value is ZCodeAttachmentFaultCode {
  return typeof value === "string" && KNOWN_FAULT_CODES.has(value);
}

/**
 * Attachment error with a stable error code. `code` is a string, and `toProtocolError` places it in
 * JSON-RPC `error.data.code`, allowing classification by code both in-process and across processes.
 */
export class ZCodeAttachmentFaultError extends Error {
  readonly code: ZCodeAttachmentFaultCode;

  constructor(code: ZCodeAttachmentFaultCode, options?: { cause?: unknown; message?: string }) {
    // The message defaults to the fault code itself so text matching in older clients still works.
    super(
      options?.message ?? code,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ZCodeAttachmentFaultError";
    this.code = code;
  }
}

/**
 * Read an attachment fault code from any error:
 * - ZCodeAttachmentFaultError or an Error with a code thrown in-process;
 * - `error.data.code` returned across JSON-RPC;
 * - compatibility fallback for older CLI versions that provide only message text (see below).
 */
export function readZCodeAttachmentFaultCode(error: unknown): ZCodeAttachmentFaultCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; data?: unknown };
  if (isZCodeAttachmentFaultCode(candidate.code)) return candidate.code;
  if (candidate.data && typeof candidate.data === "object") {
    const data = candidate.data as { code?: unknown };
    if (isZCodeAttachmentFaultCode(data.code)) return data.code;
  }
  // Compatibility fallback: desktop may connect to an older zcode-cli that has no structured code yet.
  // Match only when the entire message equals a fault code; do not fuzzy-match and misclassify arbitrary
  // wrapped text as a deterministic category.
  if (error instanceof Error && isZCodeAttachmentFaultCode(error.message)) return error.message;
  return undefined;
}
