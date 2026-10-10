// ============================================================
// Record an inline draft as a file the model has read
// ============================================================
// Edit / Write reject files the session has not read (FILE_NOT_READ): the model cannot change bytes it has not seen. An inline draft
// already meets this condition because its bytes are the `script` input from the call that created it. Without recording this fact,
// the first `Edit` requested by the NOTE would fail, forcing the model to `Read` the entire 20k-token script it just wrote—the cost the
// draft file is meant to avoid.
//
// Call this **only for inline input**: saved copies (with metadata the model has not seen), new drafts of inherited predecessor
// scripts (which may come from another session or before compaction), direct hub launches, and GUI settings revisions do not contain
// bytes written by the model in this call. Recording them would falsely certify content the model has not seen.
//
// Like the draft itself, this is **best effort**: if stat fails, do not record it and let the model's first Edit fall back to the usual “Read first” path.

import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";

export type WorkflowDraftAuthoringTool = "CreateWorkflow" | "AmendWorkflow";

const CRLF_PATTERN = /\r\n/gu;
const LF = "\n";

export async function recordAuthoredWorkflowDraft(
  context: ToolExecutionContext,
  draft: { path: string; source: string; toolName: WorkflowDraftAuthoringTool },
): Promise<void> {
  const { fileSystemPort, readFileState } = context;
  if (readFileState === undefined || fileSystemPort === undefined) return;

  let revision: { id: string; mtimeMs?: number; sizeBytes?: number } | undefined;
  try {
    // Use the same port as stale checks after Edit / Write so revision semantics match. Stat after writing: the recorded mtime is no
    // earlier than the draft's actual mtime, and later external changes advance it and are marked stale.
    const info = await fileSystemPort.stat(
      { path: draft.path, trace: context.traceContext },
      { signal: context.abortSignal },
    );
    revision = info.revision;
  } catch {
    return;
  }
  if (revision === undefined) return;

  const entry: ReadFileStateEntry = {
    path: draft.path,
    // The port normalizes returned text to LF (FileSystemReadTextResult.content); keep the snapshot in the same form.
    content: draft.source.replace(CRLF_PATTERN, LF),
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: draft.toolName,
    revisionId: revision.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision.mtimeMs),
    sizeBytes: revision.sizeBytes ?? Buffer.byteLength(draft.source, "utf8"),
  };
  readFileState.set(createReadFileStateKey(draft.path, 1, undefined), entry);

  // Resume restores read-state only from tool-part metadata (read-file-state-hydrator.ts). Without recording this entry, the same
  // bug returns after session recovery.
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry.readAt,
    entry,
    toolName: draft.toolName,
  });
  if (metadata !== undefined) context.recordReadFileStateMetadata?.(metadata);
}
