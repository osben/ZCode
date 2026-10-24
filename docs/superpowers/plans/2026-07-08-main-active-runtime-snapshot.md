# Main Active Runtime Snapshot

> Historical legacy-UI implementation plan (2026-07-08). Status (2026-07-15): the V4
> conversation main path judges foreground work from the snapshot itself — phase, active
> works, rows/control projection — not from `isMainActive`. `isMainActive` still exists only
> in the task compatibility layer; `useTaskRestore`, the task-stream handler, and the old E2E
> paths described below are not the current implementation entry.

**Goal:** Make "is the main turn active" a runtime snapshot fact instead of local UI
guesswork, so background-only work does not show fake bottom loading, ordinary messages are
not queued while only background work runs, and queued prompts can drain.

## Contract

- `mainActive` is an ephemeral field of `ZCodeSessionRuntimeSnapshot.runtime`
  (`mainActive: z.boolean().optional()` in `packages/shared/src/zcode-protocol/index.ts`;
  `mainActive?: boolean` in `packages/shared/src/zcode-task-types.ts`). It is not a persisted
  task-index field. The session mapper sets it from
  `mainActive = Boolean(input.activeTurn)` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`),
  emitting explicit `false` for idle snapshots; the schema stays optional for older snapshots.
- UI restores it only through the accepted-snapshot path:
  `applyTaskSnapshotEphemeralRuntimeState()` (`packages/ui/src/hooks/taskSnapshotRuntimeStateSync.ts`)
  applies `runtime.mainActive` when present; `syncTaskSnapshotAfterEvent()` applies it only
  after the existing stale/freshness guards accept the snapshot. A stale terminal snapshot
  must not roll back the current active state.
- Never infer `mainActive` from `activeTurnId` in UI, and never write `runtime.activeTurnId`
  into `activeInputId` (different semantics). The existing `runtime.status` /
  `displayedStatus` / `activeInputId` state stream is unchanged.
- Only three consumers read `TaskUiState.isMainActive`: main loading display, ordinary send
  queue decision (`shouldQueuePromptForMainActivity`), queued prompt drain.
- Live writers: main turn facts (`task_run_started`, `goal_iteration_started`, running
  context compaction timeline, `agent_message_chunk`, `agent_thought_chunk`, background
  monitor `task_run_started` for an inactive task) set `isMainActive = true`. Background-only
  facts (`background_bash_jobs_update`, mirrored child `tool_call` / `tool_call_update`,
  background control UI updates) must never set it `true`. Terminal cleanup stays
  centralized in `setTaskRuntimeState(non-running)`, which also clears `isMainActive = false`.

## Expected Behavior

- Foreground main turn running: `isMainActive === true`, bottom loading visible, ordinary
  send queues, drain waits.
- Background-only running, main idle: `runtime.status` may stay `streaming` (background
  activity), `isMainActive === false`, no fake bottom loading, ordinary send goes directly,
  drain can proceed.
- Restore/reconnect of an active main turn: snapshot carries `mainActive === true`; loading
  and queue behavior match an active turn before any live chunk arrives.
- Restore/reconnect of a completed task: `mainActive === false` or terminal runtime clears
  it; no fake loading; ordinary send can start a new turn.

## Anchors

- Protocol/mapper: `packages/shared/src/zcode-protocol/index.ts`,
  `packages/shared/src/zcode-task-types.ts`,
  `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`.
- UI sync: `packages/ui/src/hooks/taskSnapshotRuntimeStateSync.ts`,
  `packages/ui/src/hooks/taskStreamEventSnapshotSync.ts`,
  `packages/ui/src/hooks/taskStreamEventHandlers.ts`,
  `packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts`.
- Tests: `chatStatus.test.ts`, `useZCodeChatSendPromptQueuePolicy.test.ts`,
  `zcodeTaskRuntimeMonitorQueueDrain.test.ts`, `taskSnapshotRuntimeStateSync.test.ts`,
  bootstrap `zcode-protocol.test.ts`, E2E `conversation-session-background.test.ts`.
