# Task-Scoped Composer Drafts

## Background

The unsent state of the chat input must be isolated per task, not per component instance. After typing
text, adding attachments or context chips in task A, switching to task B and back, the user sees A's own
draft; B likewise.

## Cache Boundary

- Workspace isolation uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`.
- Draft scope uses `taskId`; the new-task state uses `null`, mapped to `__draft__` in the store.
- Each scope caches the complete composer draft: text, ordinary attachments, code comments, web element
  context and the local revision.
- Desktop restore replays the Lexical editor JSON snapshot first, keeping mention / token nodes; an old
  draft or missing snapshot falls back to plain-text restore.
- Transient UI state such as focus, drag highlight and prompt-enhancement loading does not enter the draft
  cache.

## Persistence Rules

- The current renderer keeps drafts in memory per workspace/task; saved/restored on task switch, unmount,
  page hide, queued prompt edit and first-send task promotion.
- The input hot path updates only the local composer state and revision, not the global store/localStorage
  per character; the full draft is saved or cleared only at task switch, unmount/hide, prefill/queued edit,
  first-send promotion and send failure/success boundaries, avoiding frequent re-renders or persistence
  writes from large attachments and long text.
- Desktop restart restore uses a small JSON cache in localStorage; the key must include the workspace key so
  same-path remote workspaces do not cross-wire.
- Ordinary attachments persist only recoverable references: file attachments with a `localPath` can be
  restored; a browser `File` with no recoverable path is not copied into app storage, is dropped after
  restart and the user is asked to re-add it.
- Task deletion or a successful send clears the matching draft, so old attachment references do not appear
  in later sessions.
