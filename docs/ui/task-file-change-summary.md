# Task File Change Summary

## Goal

After a task ends, summarize the file changes involved in the task under the task title and task entry,
while keeping the turn information a later rollback feature needs.

## Data Flow

1. Agent runtime file writes keep recording only the raw `fileChanges`: the session file tracker is
   `packages/services/src/session/fileChangeTracker.ts`, and each write records `beforeContent` /
   `afterContent` in the session file change tracker.
2. The task summary is aggregated dynamically when the task list is read: aggregation in
   `packages/services/src/session/taskChangeSummary.ts`, injected in
   `packages/services/src/session/zcodeTaskService.ts`; the summary field hangs on
   `ZCodeTaskMeta.changeSummary`.
3. The UI consumes only the summary and never scans full snapshots: formatting in
   `packages/ui/src/lib/taskChangeSummary.ts`, task list in `packages/ui/src/TaskList.tsx`, top title in
   `packages/ui/src/App.tsx`.

## Summary Structure

`fileCount` (unique files involved), `added` / `removed` (total lines aggregated by the task's final
result), `files[]` with `path`, `added` / `removed`, `writeCount`, `lastTurnIndex`.

## Rollback Reservation

Real rollback still depends only on `fileChanges`; `changeSummary.files[].lastTurnIndex` is only a UI quick
locator. A later "roll back the whole task" or "roll back a single file" reuses the rewind/truncate
capability of the session file change tracker. `task_error` also persists the turn's `fileChanges`, so a
failed task also shows the file summary and keeps the data needed for later rollback.

## v4 Per-Turn File Summary and File Undo

The v4 conversation does not reuse the old `session/previewFileRewind` / `session/applyFileRewind` entries;
per-turn file summary and undo go through the v4 projection and command/query boundary. The product
semantics are fixed as "undo only workspace file modifications": after a successful undo no chat history is
deleted, truncated or rewritten; only the matching turn's file state is marked undone.

### State and Event Chain

```text
Write/Edit and other file tools
  -> core writes a workspace checkpoint artifact
  -> SessionEvent.CheckpointCreated(snapshotRef/diffRef/messageId/targetMessageId/toolMessageId)
  -> also written to the existing session_entry(runtime/workspace_checkpoint); cold restore rebuilds the checkpoint event
  -> v4 ProductProjection attributes it to turnHeader by stable messageId/turnId
  -> TurnHeader.fileChanges = { files, additions, deletions }
  -> UI shows the file summary at the tail of that turn

user clicks undo files
  -> previewFileRewind(turn/message target)
  -> core previewWorkspaceFileRewind does a hash safety check
  -> UI dialog shows safe / unsafe / ignored files
  -> applyFileRewind
  -> core applyWorkspaceFileRewind writes back or deletes files
  -> SessionEvent.RewindTriggered(scope=workspace, reason=file_summary_rewind)
  -> also written to the existing session_entry(runtime/workspace_file_rewind); cold restore rebuilds the undo event
  -> v4 ProductProjection marks the turn's files as undone, without row.removed
```

### Projection Boundary

- `turnHeader.fileChanges` carries only a light summary: file count, total additions, total deletions, and
  the undo state needed later; full patches or before/after content must not enter the replayable snapshot.
- File details, readonly diff patch and preview safe/unsafe lists are queried on demand from host/core; the
  checkpoint artifact is read when the panel expands or undo is clicked.
- The `CheckpointCreated` event store is an in-memory runtime ledger; the checkpoint payload must also be
  written to the existing `session_entry`, so child/main runtime cold restore rebuilds events before
  preview/apply. This persistence reuses the existing table, adding no table or migration; the artifact
  remains the only large-object source of before/after content.
- A workspace-only `RewindTriggered` is also written to the existing `session_entry`; otherwise closing
  details or restarting would project an undone turn as active again. When a detached child cold resume
  produces a new raw event epoch, `SessionResumed` resets the gateway raw cursor while the transport
  sequence keeps increasing monotonically.
- When the same file is changed several times in one turn, the summary is computed from the turn's initial
  before to the final after; intermediate checkpoints serve only the safe undo order and do not
  double-count lines.
- Attribution and undo targets prefer stable `messageId` / `turnId` / checkpoint id; `turnIndex` is only an
  old-data compatibility fallback, not the main locator of the new protocol.
- `CheckpointCreated(scope=workspace|both)` may contribute to the file summary; if core judges a shell/bash
  checkpoint as ignored, undo preview shows it only as ignored, not as a safely writable file.

### Undo Boundary

- File undo is allowed only when the session is idle; in running, compacting, permission/elicitation and
  other active states the entry is disabled or the command is rejected, avoiding a race with a tool loop
  that is writing files.
- At the preview stage, if any file has an external modification, a missing or unreadable checkpoint or an
  unsupported patch, the confirm button is disabled; apply does no partial write-back.
- After a successful apply the conversation rows stay unchanged; only the file summary panel of the turn
  shows the undone state and may keep the diff review entry.
- Subagent file undo is gated only by the child projection's `canRewindFiles`; whether the parent task is
  still running adds no parent guard. Modifications by the parent task or external processes to the same
  file are still judged unsafe by the existing hash preview.
- The right-side child detail keeps the conversation read-only, exposing preview/apply only as an explicit
  workspace capability; this must not open the composer, edit/retry/fork/stop or permission/elicitation
  responses.
- A detached live child with no direct bootstrap record may cold resume the persisted child record on first
  preview but must not start a new turn; a later apply still uses `childSessionId` as the command session.
- Apply only restores the real workspace and marks the target child turn as undone; it does not rewrite the
  parent Agent row, directory, parent task aggregate or any chat history.
- Desktop `desktop-continuous` updates the summary and undo state through live deltas; mobile `/remote`
  `web-remote-replayable` recovers through the same host projection/snapshot; no session/task/stream/file
  state sinks into relay or main.
- A remote workspace must carry `workspaceIdentity` / `remoteSessionId` through bridge, snapshot, undo
  target and cache key; identity isolation uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

### UI Form

- The per-turn file summary shows at the tail of the turn's assistant work area as `N files changed +A -D`;
  mobile keeps the same information with more compact buttons and file rows.
- Expanded, it shows each file's relative path and `+/-` line counts, without write/modify counts; clicking
  a file row or Review opens the code viewer diff. Write/modify counts show only in the undo pre-check
  dialog to explain the undo boundary, not in the summary row.
- The undo button first opens a preview dialog that separates safe, unsafe and ignored files, with unsafe
  reasons visible.
- Mobile remote keeps hiding the "choose app to open" dropdown and keeps only in-app diff review and file
  undo.

## In-Message Change Summary Interaction

- The change summary in a message expands only to the file list by default; inline diff expansion inside a
  single file row is no longer supported.
- Click, Enter and Space on a file row behave like that row's `Review` button: open the diff preview in the
  right code viewer. The `Review` button keeps a text entry without an icon, avoiding duplicate emphasis
  with the whole-row click.
- The file row keeps the ordinary file-open entry; mobile remote keeps hiding the "choose app to open"
  dropdown and keeps only in-app preview.
- The diff preview source still prefers the readonly patch, and falls back to the turn checkpoint's
  before/after snapshot when there is no patch.
