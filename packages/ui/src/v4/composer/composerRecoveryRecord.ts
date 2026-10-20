/**
 * Extended recovery-record fields of the v4 composer draft store
 * (spec: specs/composer-worktree-setup-steps.md §Return to draft on failure).
 *
 * The draft store keeps the record's persistence and scope moves; this module owns the two fields
 * a worktree recovery record carries beyond the plain draft: the attachment manifest (with
 * persisted clipboard-text path metadata for local workspaces) and the frozen worktree intent.
 * Tolerant readers let an older build read a newer record as a partial one instead of failing the
 * whole draft; builders freeze live composer state into the persisted shapes.
 */

/**
 * Manifest entry of an attachment frozen into a recovery record. The base manifest is
 * `{id, filename}` (in-memory Files are never persisted); for clipboard-text attachments of local
 * workspaces the optional path metadata is persisted too, so restore can re-hydrate the item from
 * the temporary file instead of demanding a reattach. Records written before these fields existed
 * stay readable.
 */
export interface V4ComposerRecoveryAttachment {
  id: string;
  filename: string;
  localPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Only clipboard-text attachments persist path metadata; remote workspaces keep reattach. */
  sourceKind?: "clipboard-text";
}

/**
 * Worktree creation intent frozen into a recovery record so a restored draft can prefill Retry
 * and "Change branch/folder": the generated branch name, the resolved base, whether the base
 * defaulted to HEAD, and the custom location path when one was used.
 */
export interface V4ComposerWorktreeIntent {
  branchName: string;
  baseBranch?: string;
  baseFromHeadDefault?: boolean;
  customLocationPath?: string;
}

/** Structural attachment facts the manifest builder reads (satisfied by ChatComposerAttachment). */
interface RecoveryAttachmentSource {
  id: string;
  filename: string;
  localPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceKind?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerant read of the worktree intent snapshot: keep well-typed fields only, so a newer record
 * read by an older build degrades to a partial intent instead of failing the whole draft.
 */
export function readWorktreeIntent(value: unknown): V4ComposerWorktreeIntent | undefined {
  if (!isRecord(value) || typeof value.branchName !== "string" || !value.branchName.trim()) {
    return undefined;
  }
  return {
    branchName: value.branchName,
    ...(typeof value.baseBranch === "string" && value.baseBranch.trim()
      ? { baseBranch: value.baseBranch }
      : {}),
    ...(value.baseFromHeadDefault === true ? { baseFromHeadDefault: true } : {}),
    ...(typeof value.customLocationPath === "string" && value.customLocationPath.trim()
      ? { customLocationPath: value.customLocationPath }
      : {}),
  };
}

/**
 * Tolerant read of one manifest entry: the id/filename pair is required; persisted path metadata
 * survives only when fully well-typed, otherwise the entry degrades to the base manifest and the
 * restore path treats it as reattach-required, exactly like records written before the fields
 * existed.
 */
export function readRecoveryAttachment(value: unknown): V4ComposerRecoveryAttachment | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.filename !== "string") {
    return null;
  }
  return {
    id: value.id,
    filename: value.filename,
    ...(typeof value.localPath === "string" &&
    value.localPath.trim() &&
    value.sourceKind === "clipboard-text"
      ? {
          localPath: value.localPath,
          ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
          ...(typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
            ? { sizeBytes: value.sizeBytes }
            : {}),
          sourceKind: "clipboard-text" as const,
        }
      : {}),
  };
}

/**
 * Build the recovery manifest. Clipboard-text attachments of local workspaces persist their path
 * metadata so restore can re-hydrate from the temporary file; everything else keeps the base
 * `{id, filename}` manifest (Files are never persisted; remote workspaces keep reattach).
 */
export function buildV4RecoveryAttachmentsManifest(
  attachments: readonly RecoveryAttachmentSource[],
  options: { persistPathMetadata: boolean },
): V4ComposerRecoveryAttachment[] {
  return attachments.map((item) => ({
    id: item.id,
    filename: item.filename,
    ...(options.persistPathMetadata &&
    item.sourceKind === "clipboard-text" &&
    typeof item.localPath === "string" &&
    item.localPath.trim()
      ? {
          localPath: item.localPath,
          ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          ...(typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes)
            ? { sizeBytes: item.sizeBytes }
            : {}),
          sourceKind: "clipboard-text" as const,
        }
      : {}),
  }));
}

/** Worktree intent snapshot from the pipeline's frozen creation params (Retry/Change prefill). */
export function buildV4WorktreeIntentFromParams(params: {
  branchName: string;
  baseBranch?: string;
  baseFromHeadDefault?: boolean;
  customLocationPath?: string;
}): V4ComposerWorktreeIntent {
  return {
    branchName: params.branchName,
    ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
    ...(params.baseFromHeadDefault ? { baseFromHeadDefault: true } : {}),
    ...(params.customLocationPath ? { customLocationPath: params.customLocationPath } : {}),
  };
}
