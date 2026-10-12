import { z } from "zod";

/** Text material passes only file references; cross-device upload must never fall back to injecting the full text automatically. */
export const attachmentSourceKindSchema = z.enum(["clipboard-text", "topic-history"]);
export type AttachmentSourceKind = z.infer<typeof attachmentSourceKindSchema>;
