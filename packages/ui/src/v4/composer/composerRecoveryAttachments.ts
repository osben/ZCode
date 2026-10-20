/**
 * Re-hydration of persisted recovery-attachment metadata into the in-memory attachment store
 * (spec: specs/composer-worktree-setup-steps.md §Return to draft on failure).
 *
 * Clipboard-text attachments of local workspaces persist `localPath` metadata in the recovery
 * record; after a reload the in-memory Files are gone, so without re-hydration Restore blocks as
 * "reattach" even though the temporary file still exists on disk. This stages path-backed items
 * back into the recovery scope as zero-copy local attachments; entries without persisted metadata
 * keep the existing reattach requirement (remote workspaces included).
 */
import {
  readComposerAttachmentScope,
  updateComposerAttachmentScope,
  type ComposerAttachmentUploadItem,
} from "@/store/composerAttachmentUploadStore.js";
import type { V4ComposerRecoveryAttachment } from "@/v4/composer/composerRecoveryRecord.js";

export function rehydrateComposerRecoveryAttachments(options: {
  workspaceKey: string;
  recoveryScope: string;
  manifest: readonly V4ComposerRecoveryAttachment[];
}): void {
  const scopeKey = `${options.workspaceKey}\0${options.recoveryScope}`;
  const present = new Set(readComposerAttachmentScope(scopeKey).map((item) => item.id));
  const missing = options.manifest.filter(
    (entry): entry is V4ComposerRecoveryAttachment & { localPath: string } =>
      typeof entry.localPath === "string" &&
      entry.localPath.trim().length > 0 &&
      !present.has(entry.id),
  );
  if (missing.length === 0) return;
  updateComposerAttachmentScope(scopeKey, (items) => [
    ...items,
    ...missing.map((entry): ComposerAttachmentUploadItem => {
      const mimeType = entry.mimeType ?? "text/plain";
      const sizeBytes = entry.sizeBytes ?? 0;
      return {
        id: entry.id,
        filename: entry.filename,
        localPath: entry.localPath,
        mimeType,
        sizeBytes,
        sourceKind: "clipboard-text",
        referenceOwnership: "composer",
        operationId: `prompt-attachment-${entry.id}`,
        uploadStatus: "ready",
        uploadProgress: 100,
        attachmentRef: {
          ref: entry.localPath,
          fileName: entry.filename,
          mime: mimeType,
          bytes: sizeBytes,
        },
        autoRetryCount: 0,
        runtimeRebuildRetryCount: 0,
        staged: false,
        adopted: false,
        showComplete: false,
        localZeroCopy: true,
      };
    }),
  ]);
}
