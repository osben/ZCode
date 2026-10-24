# Review pane: "Last turn" source

Fixes ISSUE-056 (Linear ZCO-50). The Review (Git) side pane offers a "Last turn" source whose rows come
from the v4 projection, which owns per-turn file changes (the chat's turn change summary already reads
them); the pane keeps no per-turn store of its own.

## Product rules

1. "Last turn" lists the files changed by the **latest turn of the active task that has file changes**
   (`turnHeader.fileChanges.files > 0`), the same turn whose summary the chat shows as
   `N files changed +A -D`. A later turn without file changes does not clear it.
2. Each row shows the workspace-relative path and the turn's `+additions -deletions` for that file, and its
   diff is the read-only patch from the turn (same hunks the chat's per-file Review opens).
3. The source stays read-only (no stage/discard), as before.
4. A reverted turn (`fileChanges.state === "reverted"`) still lists its files; rewind state is shown in the chat.
5. While details load, or when there is no active task, no v4 conversation, or no turn with file changes,
   the existing empty state stays ("The current task has no last-turn file changes yet").
6. The source option count is the header's file count until details load, then the number of listed files.

## Owners and data path

```text
CLI v4 ProductProjection (owner)
  └─ turnHeader.fileChanges {files, additions, deletions, state}  ── rows.window in the session snapshot
  └─ v4/conversation/fileChanges(sessionId, target, baseRevision, baseLogEpoch) → items[path, +/-, patches]

Review side pane (reader only)
  GitPaneWithLastTurn (packages/ui/src/review-last-turn)
    └─ V4PaneConversationProvider(scope = active workspace)   ← same registry connection as the chat pane
         └─ useLastTurnGitDataset(sessionId = activeTaskId, workspacePath = git review path)
              1. layer.acquire(sessionId) → shared projection store (no second subscription)
              2. select latest turnHeader with fileChanges.files > 0 and an entityId
              3. fileChanges(...) once per request key
              4. map items → GitPaneDataset "last-turn" and override gitState for GitPane only
```

- No new protocol, store slice, persistence or `setting.json` key. The Review pane keeps no second copy of
  per-turn truth; it re-derives from the projection on each change.
- Request key: `[workspaceKey, sessionId, logEpoch, rowId, entityId, header.state, header.fileChanges]`.
  A running turn refetches only when its aggregate summary changes, not on every revision.
  A response for an older key is dropped (stale-result rule).
- Failures are never cached as loads. The gateway rejects a `baseRevision` that is not its current revision
  (`proto.staleRevision`), so a stale failure retries once the projection reaches a newer revision; any other
  failure retries the next time "Last turn" is selected.
- Fetch only while the "Last turn" source is selected; otherwise the dataset stays empty and the count
  comes from the header aggregate.
- New UI code lives in the managed module `packages/ui/src/review-last-turn` (`CONTRACT.md`).
- Desktop (`desktop-continuous`) gets header updates from the live stream; mobile remote
  (`web-remote-replayable`) gets them from snapshot + gap repair. Both go through the same pane provider
  and host query, keyed by `workspaceIdentity` / `remoteSessionId`.
- If the provider is not ready (remote waiting, disconnected), the pane renders the plain GitPane. The side pane
  does not pass `sessionId` to the provider, so a disconnected session is not retained for it and the bridge
  unmounts, clearing the source.
- Ownership: the wrapper applies a reported dataset only when its owner (workspace key, remote session,
  task session, Git review path) matches the current pane, so a task switch never shows the previous task's
  files for a render. A new provider value (another transport binding) invalidates loaded results and failures.

## Known limit

The turn is searched only in the loaded snapshot tail (`snapshotTailWindowRows` = 60 rows, plus any history the
chat already loaded). If the latest editing turn is older than that window, "Last turn" shows the empty state.
Covering it needs either a bounded side read over `v4/conversation/rowsRange` exposed through the pane
conversation context, or a host query for the latest changed turn. The store's `loadAllOlder` must not be used,
since it rewrites the chat's shared row window. Pending a decision (PR #319 review).

## Acceptance

- After a turn edits `src/math.js` (+4), selecting "Last turn" lists `src/math.js +4-0` with its diff,
  and the option count is 1.
- A following turn with no file edits keeps listing `src/math.js`.
- With no turn that changed files, the empty state is shown.
- Unstaged / Staged / Branch sources are unchanged.
