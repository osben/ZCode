/**
 * Shared, browser-safe half of the attachment ref trust boundary
 * (specs/fork-attachment-ref-trust-boundary.md). The Host admission itself lives in
 * `packages/services/src/zcode-agent/fork-attachment-ref-trust`.
 */

/**
 * Stable code of a v4 command the Host refused because one of its attachment refs is not admitted
 * for the command's origin.
 */
export const ATTACHMENT_REF_NOT_AUTHORIZED = "fault.attachment.refNotAuthorized";

/** True when a rejected command error carries the attachment ref refusal code. */
export function isAttachmentRefNotAuthorizedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // IPC and RPC bridges prefix the remote message, so match the code anywhere in it.
  return message.includes(ATTACHMENT_REF_NOT_AUTHORIZED);
}

/**
 * Attachments an inline edit submits with `editUserQuery`.
 *
 * An untouched list (same refs in the same order) is omitted: the agent then keeps the edited
 * message's canonical attachments, so the edit never resends refs the client did not upload. A
 * changed list is sent in full; only an explicit [] removes every attachment.
 */
export function editAttachmentsToSubmit<T extends { ref: string }>(
  original: readonly T[] | undefined,
  edited: readonly T[],
): T[] | undefined {
  const base = original ?? [];
  const unchanged =
    base.length === edited.length && base.every((item, index) => item.ref === edited[index]?.ref);
  return unchanged ? undefined : [...edited];
}
