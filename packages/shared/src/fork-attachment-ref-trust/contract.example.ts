import { editAttachmentsToSubmit, isAttachmentRefNotAuthorizedError } from "./contract.js";

/** An untouched edit of a row holding a desktop path sends no attachments. */
const rowAttachments = [{ ref: "/Users/example/Documents/picked.pdf" }];
export const exampleUntouchedEdit = editAttachmentsToSubmit(rowAttachments, [...rowAttachments]);

export const exampleRefusalRecognized = isAttachmentRefNotAuthorizedError(
  new Error("fault.attachment.refNotAuthorized"),
);
