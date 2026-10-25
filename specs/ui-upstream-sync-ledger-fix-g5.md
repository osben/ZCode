# UI upstream sync 3.16.1: fix ledger G5 (project tree background unread)

Scope: `packages/ui/test/projectTreeBackgroundUnread.test.ts` (25 failing cases, upstream-only test,
no fork version). Result: 33/33 cases pass; no UI-2 skip was needed.

## Owners and event order (single writer per fact)

- Unread signal producer: `createWindowHostControllerRuntime`
  (`packages/services/src/window-controller/windowHostControllerService.ts`). One runtime per window
  owns `unreadSignalEmitter`. Attachment services only forward `onDynamicTaskUnreadSignal()` and must
  not own or dispose the emitter.
- Event order for a background completion:
  1. The source task service fires `workspace_task_list_changed` with `reason: task_status_changed`,
     `unreadSignal: "background_terminal"` and a terminal `taskMeta`.
  2. The runtime's per-source event handler maps it to a live-only signal, keyed by the source scope
     (`remoteSessionId` + workspace identity, never path alone), and fires it.
  3. The same handler then triggers the list refresh through the existing single-flight.
  4. The UI (`useProjectUnreadSignals.receive`) decides: viewed (desktop nav or mobile view) or write.
  5. The write is `mark-unread` through `setTaskUnread`. Its reply is the marker of that write.
  6. Clearing is a compare-and-clear `mark-read` with `expectedUnreadAt` from that reply, never from a
     later projection.
- Snapshots and reconciliation refreshes never carry `unreadSignal`, so they never create a completion.

## Changes

- `windowHostControllerService.ts`: runtime-level signal producer (`toBackgroundCompletionSignal`).
- `windowHostControllerService.ts`: `getTaskMeta` is owner-direct (the resolved source's
  `taskService.getTaskMeta`). An offline or unresolved owner returns `null`, not a projection row, so
  unread CAS never uses a stale snapshot.
- `windowHostControllerService.ts`: `mark-unread` returns the `setTaskUnread` reply; `mutateTask`
  returns that reply for `mark-unread` (the projection after the refresh could already hold a newer
  marker).
- `windowHostControllerService.ts`: `deleteArchivedTasks` narrows the batch result with
  `deletedTaskIds` (type only).
- `windowHostControllerProjection.ts`: `WindowHostControllerMutationResult` includes `ZCodeTaskMeta`.
  The file is 20.9 KB and is listed under this ledger's `.staged-file-size-exemptions` block.

## Tests

- `packages/ui/test/projectTreeBackgroundUnread.test.ts`: 33/33 pass (was 25 failing).
- Regression run, all pass (13 files, 58 tests):
  `packages/desktop/test/windowHostControllerService.test.ts`,
  `windowHostArchivedTaskDeletion.test.ts`, services `controllerRemoteIdentityMigration`,
  `windowControllerWorktreePreparation`, `windowControllerExportBoundary`,
  `taskIndexWorktreeFact`, `taskIndexIncognitoMarker`, UI `projectTreeWindowDirectory`,
  `projectSidebarForegroundUnread`, `taskUnreadSourceOfTruth`, `projectTreeRemoteRefresh`,
  `projectTreeStabilization`, `taskListUnreadState`.
- No new services-only test: the producer and owner-direct read are exercised end to end by the UI
  test above.

## Not changed

- UI source files in the G5 hints: `useProjectTree.ts`, `useProjectUnreadSignals.ts` and `tabStore.ts`
  are identical to upstream. `useWorkspaceTaskNavigation.ts`, `taskNavigationWorkspace.ts` and
  `zcodeSessionStore.ts` differ from upstream (fork navigation behaviour) and were not edited here.
  The failures were all on the services side.
- `specs/services-upstream-sync.md` line on `getTaskMeta` and `onDynamicTaskUnreadSignal` points here.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ui-upstream-sync-ledger-fix-g5.md
