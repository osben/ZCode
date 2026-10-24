# V4 Sidebar Task State Authority Design

## Goal

Fix the V4 sidebar task list's out-of-sync state, without reintroducing the "opening a history task jumps to the top" ordering regression:

- Opening a task clears the unread dot immediately and converges with tasks-index.
- Background sessions show a spinner in `prewarming/running` and an error state in `error`.
- Permission and userInput blocking requests show a lightweight attention tag in the sidebar.
- Title, unread, pin/archive, open/resume, and snapshot replay must never fabricate session activity time.
- After restart, clicking "new conversation" on a non-current workspace makes the explicit draft intent win over that workspace's last-session/group/pane restore.
- Desktop `desktop-continuous` and mobile `web-remote-replayable` recover terminal state from the same field authority while keeping their delivery boundaries.

This is not removing Zustand. Zustand keeps `activeTaskId`, navigation history, drafts, and renderer-local UI; only the sidebar's business facts stop reading the legacy `taskRuntimeByTaskId`, `taskUiByTaskId`, `taskUnreadByTaskId`, `taskListCache` maps.

## Root causes (fixed)

1. V4 sessions-index replaced the old runtime monitor, but `TaskListItem` still read running state from the old Zustand runtime map, so live `SessionSummary.phase` never reached the list.
2. `useWorkspaceTaskNavigation` cleared unread via the legacy `taskListCache`/optimistic cache while the current task lived in the task query cache.
3. The active pane rendered blocking cards from `ConversationSnapshot.pendingInteractions`, but the sidebar read legacy `taskUiByTaskId`, and `SessionSummary` had no lightweight attention field.
4. `mapSessionSummaryToTaskMeta` wrote live `phase/lastActivityAt` into persistence-semantic `status/updatedAt`, and the query cache's whole-meta merge used "newer updatedAt wins" — tasks-index mutations could hijack list order and stale optimistic `unreadAt` could suppress the authoritative clear.
5. `usePaneSessionPersistence` read `activeTaskId=null` as both "cold start, not yet restored" and "user explicitly entered a new draft"; a first-mount restore effect could re-select the old task after `startDraft`. The workspace-row entry also bypassed the global new-conversation `deactivateActiveGroup + resetToPrimaryPane`.

The existing "config/open task does not bump activity" fix is kept; membership/meta mutations additionally never enter activity sort fields.

## Product boundaries

1. Newly raised permission/userInput requests are user-visible activity and may update `lastActivityAt`; refresh/resume/replay of the same pending request does not.
2. Project / Timeline uses two-layer ordering: `prewarming/running` tasks form a pinned running layer ordered internally by `createdAt` DESC; the non-running layer follows the user's `Created` / `Updated` choice. A running task's `lastActivityAt` still updates display and activity facts but never reorders within the running layer (two concurrent tasks must not swap positions on streaming events). Unread-clear, rename, pin/archive tasks-index mutations never change order; grouped view only honors explicit `sort_order`.
3. Selecting a task optimistically clears the dot; on persistence failure, revert the overlay and refetch — the dot may come back; the UI must not lie long-term.
4. Leading icon priority: `error > unread > running > none`. Permission/userInput uses a separate attention tag that can coexist with the leading icon.
5. The spinner only follows `prewarming/running` in the current sessions-index snapshot/live projection; historical tasks-index `status=running` alone never spins.
6. Desktop verifies the full continuous interaction loop; mobile verifies field consistency after replayable snapshot/gap — no full permutations with split panes, queue, or subagents.
7. An explicit "new conversation" click beats local restore. Cold start with `draftFocusVersion=0` may restore the last session; once `startDraft` has bumped the version, keep the draft, clear that last-session, and exit the desktop workbench group / reset the primary pane. Normal workspace activation (no new-conversation click) still restores the last task.
8. A normal background task produces unread at a terminal turn; with a Goal, only the authoritative projection reaching `verified` is the completion-reminder boundary. `notSatisfied`, automatic continuation, Stop/cancel, and unpassed verifiers produce no completion unread; a real error still produces failure unread.
9. A collapsed workspace aggregates unread over its regular (non-pinned, non-archived) tasks; expanding only restores dots to task rows, it does not mean read. The aggregate must be computed before pagination trimming — hidden, unrendered tasks count too.

## State ownership

```text
CLI conversation projection
  └─ sessions-index/<workspaceKey>
       ├─ phase --------------------------┐
       ├─ lastActivityAt (唯一排序权威) --┤
       ├─ hasBackgroundWork --------------┤
       └─ pendingInteractionSummary -------┤
                                           v
tasks-index.sqlite ----------------> TaskListRowState ------> TaskListItem
  ├─ pinned / archived / group             ^
  └─ unreadAt ------------------------------┤
                                           │
renderer field overlay --------------------┘
  └─ 仅覆盖正在提交的 owned field，不覆盖整行

Zustand（继续保留）
  ├─ activeTaskId / navigation / draft / local UI
  └─ draftFocusVersion（显式新建意图代次）

localStorage layout persistence
  ├─ last-session（仅冷启动、无显式 draft intent 时恢复）
  └─ workbench group / pane layout（显式新建时退出/重置）
```

### Row-existence authority (2026-07-20)

The diagram rules only field ownership; `sessions-index` never becomes the persistent task row set. Project, Timeline, Pinned, Archived, and Grouped row sets come from tasks-index; sessions-index overlays only the activity/detail fields of hit rows, and a task row stays static while its summary is missing. The not-yet-persisted new-task window keeps the renderer optimistic overlay; the task row takes over after persistence. Full boundaries and cases: `docs/superpowers/specs/2026-07-20-sidebar-task-row-authority-design.md`.

The identity key is always `workspaceKey = workspaceIdentity?.trim() || workspacePath`; execution paths in file display and service calls keep `workspacePath`. Remote service selection must also keep `remoteSessionId` — never match by path alone.

## Data contract

### Activity summary

sessions-index stays a lightweight conflated topic and gains an optional blocking-interaction summary on `SessionSummary`. It carries only kind/count — never commands, questions, answers, or other sensitive payloads. A legacy frame without the field means no attention.

```ts
type PendingInteractionSummary = {
  permissionCount: number;
  userInputCount: number;
};
```

`SessionSummary.phase`, `lastActivityAt`, `hasBackgroundWork`, and the summary derive from the same conversation projection; the active pane still renders interaction cards from the full `ConversationSnapshot.pendingInteractions`. With both kinds pending, the sidebar keeps both counts; display prefers the userInput copy with the total expressing pending volume, without dropping the permission fact.

### Sidebar row projection

New UI-only `TaskListRowState` (final naming may follow existing directory conventions) — live provenance no longer hides inside persistent `ZCodeTaskMeta.status/updatedAt`:

```ts
type TaskListRowState = {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  title: string;
  createdAt: number;
  activity: {
    phase: SessionSummary["phase"];
    lastActivityAt: number;
    hasBackgroundWork: boolean;
    pendingInteractions?: PendingInteractionSummary;
  };
  membership: {
    pinned: boolean;
    archived: boolean;
    unreadAt?: number;
  };
  persistedMeta: ZCodeTaskMeta;
};
```

The query cache may keep caching list entities and query results, but mutation APIs patch per field owner. Never overwrite activity fields with the whole `ZCodeTaskMeta` returned by `setTaskUnread`, rename, or pin/archive; never sort the Updated view by tasks-index `updatedAt`.

### Indicator derivation

```text
phase=error                         -> error icon
else membership.unreadAt is set    -> unread dot
else phase in prewarming|running   -> spinner
else                               -> none

pending userInput/permission       -> separate attention tag
```

`completedInterrupted` shows no error; a historical tasks-index terminal error only serves as a static error fallback while sessions-index has not hydrated and never produces a running spinner. Once a snapshot arrives, all activity fields come from sessions-index.

## Unread creation and aggregation

```text
sessions-index terminal summary
  ├─ phase=error ---------------------------------> unreadSignal
  ├─ no goal + completed/interrupted -------------> unreadSignal
  ├─ goalStatus=verified --------------------------> unreadSignal
  └─ active/paused/verifying/notSatisfied/failed --> status refresh only

unreadSignal
  -> renderer exact workspaceKey + inactive-task guard
  -> setTaskUnread(true)
  -> task row blue dot + Dock badge
  -> collapsed workspace aggregate dot
```

`task_status_changed` is only a state-convergence event, never implicitly "newly completed". Only an `unreadSignal` the Host explicitly attaches after observing the authoritative `SessionSummary.phase + goalStatus` may create unread. For the same terminal state, at most one of the task-index patch and snapshot backfill broadcast carries the signal; the renderer keeps idempotent reconciliation.

The workspace aggregate computes `hasUnread` from the full regular-task membership, then trims to the current page window. A collapsed workspace shows a dot (same size/color as task rows) after the name and before the action area; an expanded workspace shows no aggregate dot and performs no unread mutation.

## Unread clear

```text
select task
  -> activate exact workspace tab / resolve workspaceIdentity + remoteSessionId
  -> read membership.unreadAt from current task query row
  -> apply renderer overlay { unreadAt: undefined }
  -> setTaskUnread(unread=false)
       ├─ success: reconcile tasks-index membership; remove overlay
       └─ failure: remove overlay; refetch membership; warn through UI logger
  -> set activeTaskId
```

The overlay covers only `unreadAt`. The success response's `updatedAt/status/title` never join the activity merge, so clearing the dot cannot reorder. Re-selecting an already-read task is idempotent — no meaningless writes.

## Activity and ordering

Project / Timeline (desktop and web remote control) share one two-layer comparator:

```text
第一层：运行状态
  prewarming/running 或 hasBackgroundWork ----------> 位于非运行任务之前

第二层：层内排序
  running tasks -------------------------------> createdAt DESC, taskId tie-break
  non-running + Created -----------------------> createdAt DESC, updatedAt DESC
  non-running + Updated -----------------------> updatedAt DESC, createdAt DESC
```

The running layer never uses `updatedAt` as tie-break. Two tasks created in the same millisecond still decide by stable `taskId` — otherwise streaming events can still swap rows through the secondary key. Entering running moves the task into the running layer; its position is stable while running; entering completed/error exits the layer and re-seats by the current non-running rule.

```text
new PermissionRequested / userInput request
  -> projection pendingInteractions changes
  -> record.lastActivityAt bumps once
  -> sessions-index upsert
  -> running task stays in its createdAt slot
  -> non-running task in Updated view may move row

refresh / SessionResumed / replay same request
  -> rebuild identical summary
  -> no activity bump, no reorder

rename / unread / pin / archive
  -> tasks-index membership/meta patch
  -> lastActivityAt preserved
  -> Updated order unchanged

new message / tool / turn lifecycle
  -> real session activity
  -> lastActivityAt advances
  -> running peers do not reorder
  -> non-running Updated order may change
```

Grouped view does not consume this chain; SQLite group items' explicit `sort_order` decides position.

### Background work in the running layer

A workflow run is background work: after the launching turn closes, the parent session's `phase` is back at `completedSuccess` with only `hasBackgroundWork` true, while every `DynamicWorkflowRunProgress` event advances `record.updatedAt` (= `lastActivityAt`) and triggers an incremental sessions-index frame (only `ModelStreaming` is skipped). Two sessions each running a workflow would otherwise both sit in the `updatedAt`-ordered non-running layer and swap at engine-event frequency; background bash / detached-subagent `BackgroundTaskUpdated` advances activity time the same way, just shorter and quieter.

```text
engine RunEvent ──▶ DynamicWorkflowRunProgress ──▶ record.updatedAt = now
                                                   └─▶ sessions-index upsert (lastActivityAt)
UI: isRunning(phase) = false  ──▶ 非运行层 ──▶ 按 updatedAt 排 ──▶ 两行互换
```

Running-layer membership is therefore `prewarming/running` **or** `hasBackgroundWork` (desktop `isTaskListRowActive`; mobile remote `displayStatus === "running" || hasBackgroundWork`). `lastActivityAt` semantics are unchanged (still the activity fact and unread basis); sessions with background work are just fixed by `createdAt` inside the running layer and exit on completion. The spinner still follows only `phase` (boundary 5 unchanged). The alternative "classify run progress as non-activity events" was rejected: it would change the meaning of "last activity" and make running sessions look idle.

### Workflow run line

With a dynamic workflow run attached, the sidebar previously showed only the sort-position change, with no visible indication of which session runs a workflow or which step it is on.

sessions-index summaries gain optional `workflowActivity` (≤ 4 runs per session: running first in launch order, then most recently finished; each `runId/toolCallId?/name?/status/stopReason?/startedAt?/phases[]/currentPhase?/agentsWorking`), derived by the CLI projection from the same snapshot's `workflowRuns` + `backgroundWorks` and delivered through the sidecar `TaskListRowActivity.workflowActivity`, the desktop host controller `taskActivity`, and the remote-control `WebRemoteControlTaskTarget`. Phase status derives only from control flow (running: current phase running or entered done, rest pending; completed: entered done; errored: current failed; stopped: current pending). The phase name table comes from `run.phaseNames` (carried by the `run-launched` event, filled by the submitter from the causal graph), degrading to entered phases.

UI: `TaskListItem` / grouped row / timeline row / remote row append a line under the title: "Workflow icon + mini track lights + current phase name", row height 32 → 52 (+20 per extra line, max two lines, the rest folded into `+n`). The leading 16px slot (error > unread > spinner) is unchanged — the run line is a second channel, not a fourth priority level. Finished run lines collapse **without timers**: the renderer keeps a bounded (256) persisted set of acknowledged runIds; opening a session acknowledges all its then-finished runs, and a run finishing inside the active session is acknowledged immediately. A collapsed group header shows a pulsing light next to the unread dot (with a count when > 1), counting only running runs. Clicking a run line selects the session and opens the run pane (same jump as the composer badge).

Boundaries unchanged: `hasBackgroundWork` remains the running-layer sort input; `workflowActivity` is draw-only — it never affects ordering or unread. `summariesEqual` includes the field in JSON comparison, so phase flips / settlement / running-agent-count changes are never eaten by conflation; it does not make the list quieter — every run progress event already advances `lastActivityAt` (same equality semantics as above). The virtualized grouped list switches to `measureElement`-measured row heights, 32 only as the initial estimate. See `docs/dynamic-workflow/presentation.md`, "The sidebar run line".

Cross-client: `WebRemoteControlTaskTarget` gains optional `hasBackgroundWork` (renderer fills it from the sessions-index sidecar; desktop main's mobile snapshot signature counts it, so run start/stop pushes a new snapshot even when `displayStatus` is unchanged; legacy snapshots default to false).

## Restart recovery and explicit new draft

`activeTaskId=null` is not a sufficient restore predicate. Restore entry points must also read the workspace store's `draftFocusVersion`: default `0` means no explicit new-conversation intent this renderer lifetime; each `startDraft` increments it. The version is renderer-local navigation state — never in sessions-index/tasks-index, never persisted across renderer restarts.

```text
冷启动 + 普通激活 workspace B
  activeTaskId=null, draftFocusVersion=0
  -> restore last-session(B)
  -> select old session（允许）

冷启动后从 workspace A 点击 B 的“新建对话”
  -> activate exact B by workspaceKey
  -> deactivate desktop workbench group
  -> reset pane layout to primary
  -> startDraft(B), draftFocusVersion: 0 -> 1
  -> B shell mount sees explicit draft intent
  -> clear last-session(B), skip restore
  -> activeTaskId remains null（必须）
```

All desktop new-conversation entries (workspace row, global button, menu, Cmd/Ctrl+N, draft workspace selector) must converge into one navigation transaction — leaf components never compose `activateTab + startDraft` directly. The transaction locates the workspace exactly by `workspaceKey = workspaceIdentity?.trim() || workspacePath`; remote workspaces sharing a `workspacePath` must not clear each other's last-session. Mobile `/remote` neither restores nor consumes desktop workbench group/pane localStorage; it navigates only along the `web-remote-replayable` bridge's workspace/task/draft intents.

## Cross-client recovery boundary

```text
desktop-continuous              web-remote-replayable
  sessions-index delta             snapshot / resume / gap resync
           │                                  │
           └──────── TaskListRowState ─────────┘
                    field-level reconcile
```

- Desktop continuous never splices mobile replayable runtime-restore messages; it updates activity directly on delta.
- Mobile replayable replaces activity wholesale after full snapshot assembly; during gap/resync it keeps the last valid base and never guesses running/attention from tasks-index.
- relay/main keep forwarding only; they hold no task/session/sidebar business state.
- The permission/userInput summary recovers on the same sessions-index topic; `task_meta_changed` never triggers membership RPCs.

## Error handling and logging

- Unread write failure: UI logger `warn`, revert the field overlay, invalidate that workspace membership query; no permanent local read illusion.
- sessions-index gap/fault: existing owned-subscription resync; never fall back to the legacy Zustand runtime/ui maps.
- Missing optional attention field: interpret as none; compatible with old producers/frames.
- Unresolvable remote identity/service: existing navigation failure guard; never guess another remote session by the same `workspacePath`.
- last-session restore: only when `activeTaskId=null && draftFocusVersion=0`; an explicit draft must synchronously clear the exact workspaceKey's persisted key and skip restore.
- No new high-frequency `info` logs; frame/stream diagnosis stays on existing debug paths.

## Concurrent commit contract for the cross-source join

Workspace rows read tasks-index membership asynchronously; that RPC is not in the same transaction as sessions-index activity updates. Every join round must capture three input versions:

```text
sessions-index {scope, logEpoch, seq, serviceGeneration}
tasks-index    {membershipVersion}
renderer query {requestGeneration}
                    │
                    v
             async membership join
                    │
      任一版本变化 ──┴──> 丢弃旧结果，不清 stale，自动重算
```

- A new invalidation of an in-flight request with the same query signature must not be dropped as a duplicate; record the rerun intent.
- An old request commits only while activity revision, membership version, and request generation all still match.
- `stale` must not be the only invalidation generation; consecutive invalidations must be observable — an old response must never mark an updated query fresh.
- The revision coordinates the read model inside the renderer only: no new shared wire fields, no SQLite schema change.
- Desktop continuous and mobile replayable share the same commit gate; mobile snapshot/gap still recovers only via the owned subscription.

## Tests and evidence

### Unit / component

- sessions-index schema/projection: phase, attention counts, request/resolution, snapshot/cold hydration, equivalent replay produces no new activity.
- Row projection: activity and membership join by owner; tasks-index mutations never overwrite phase/lastActivityAt.
- Indicator: error/unread/running priority and attention coexistence.
- Unread navigation: judged from the query row, optimistic clear, success reconcile, failure rollback/refetch, exact workspaceIdentity/remoteSessionId routing.
- Unread creation: ordinary terminal / Goal verified / error produce an explicit signal; Goal intermediate terminals and resume/status-only events do not.
- Workspace aggregate: collapsed state, unread outside the page window, clearing multiple unreads one by one, pinned/archived pruning, workspaceIdentity isolation.
- Ordering: running always precedes non-running; multiple running keep `createdAt` DESC with alternating `updatedAt` not reordering; finished tasks return to the user's Created/Updated order; title/unread/pin/archive never reorder; grouped `sort_order` unchanged.
- Restart/new-draft: with a persisted last-session on a non-current workspace, the workspace-row new conversation keeps the draft; normal activation still restores; explicit new exits the active group and resets panes; different workspaceIdentity with the same path stay isolated.
- Static guard: TaskListItem/navigation no longer read the four legacy sidebar fact maps.

### E2E pruning

- Desktop `desktop-continuous` as the full representative: background run shows spinner, permission/userInput shows attention, error shows red state, opening unread clears the dot without reordering.
- TSL18 uses an E2E-only membership gate to stall a tasks-index `listTasks` response: confirm the running row and spinner, start and confirm an old membership refresh in flight, let Stop converge to `completedInterrupted`, then release the old response; finally wait for the workspace query to become fresh again and assert the spinner did not reappear in the release window. The gate is exposed via `window.__testActions` only under `VITE_ZCODE_E2E_STORE_BRIDGE=1`, never in the production renderer.
- Goal covers only the `ordinary terminal / notSatisfied / verified / cancelled / error` notification boundaries — no Cartesian product with queue kind, provider, or split panes.
- Desktop restart representative: persist a last-session for workspace B, click B's workspace-row "new conversation" from A, assert the draft intent wins with no old-session write-back; also prove normal activation of B still restores the last session.
- Mobile `web-remote-replayable` proves only that snapshot/gap recovery yields the same phase/attention/unread projection, plus workspace identity isolation.
- No full permutations with queue, compact, fork, subagent, split panes, model/provider, theme/locale — these dimensions do not change field ownership and are guarded by unit/existing cases.

## Non-goals

- Not deleting the Zustand package or the whole `zcodeSessionStore`.
- Not moving pin/archive/group/unread into sessions-index.
- Not putting full pending-interaction payloads into the list topic.
- Not rewriting task list virtualization, search, group drag-and-drop, or the global notification system.
- Not removing last-session refresh restore; only splitting "may restore" and "user explicitly created new" into two decidable states.
- Not changing desktop/mobile delivery profile, owner/lease, or command queue.
