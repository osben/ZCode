/**
 * services-feedback public contract: diagnostic log archives for feedback upload and log export.
 *
 * - createFeedbackDiagnosticArchive: builds one zip from the given sources; each source applies its own content
 *   policy (`cli-memory` re-sanitises every record and caps file count and size); never throws for a skipped file.
 * - prepareCompactLogArchive / cleanupLogArchive: the compact archive for feedback upload and its removal.
 */
export { createFeedbackDiagnosticArchive } from "../feedbackLogArchive.js";
export type { FeedbackLogSource } from "../feedbackLogArchive.js";
export { cleanupLogArchive, prepareCompactLogArchive } from "../compactLogArchive.js";
