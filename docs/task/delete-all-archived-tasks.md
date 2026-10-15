# One-Click Delete All Archived Tasks

## Requirements and Confirmation Log

2026-09-07 confirmed through two rounds of grilling:

1. Delete archived tasks across all workspaces covered by the current window's archived list, including collapsed items from the 21st onward; do not scan projects already removed from the window.
2. The archive toolbar provides a neutral "More" icon between the filter and close buttons, showing the archive count and a red "Delete All Archived Tasks…" in the menu; disabled when the list is empty. Available on both desktop and mobile Web, single-item operations remain.
3. On click, read the full archive set from each workspace, then show one confirmation dialog displaying the accurate processable count and inaccessible items. The confirmation body only states that tasks will be removed from the task list and archive list; session records or file retention details are not shown. Single-item archive deletion uses the same text, synchronized across Chinese and English. Cancel writes no data.
4. Follow the existing delete semantics: persist a `deleted` flag, remove list and grouping references; CLI session records, project files, and worktrees remain. Synchronize the single-item archive deletion confirmation text.
5. One failure does not block others; report counts of successful, skipped, and failed tasks, along with unprocessed items. Retain undeleted tasks for user retry. Offline projects are not auto-connected, nor does deletion resume after reconnection.
6. The target set is fixed at the moment the confirmation dialog opens; during execution, check `archived` again within the persist write transaction. Restored or already-deleted tasks are skipped; archives added afterward do not enter this operation.

## Interaction and State

```text
Archive view (window workspace scope)
  -> toolbar […] -> menu: archive count / Delete All Archived Tasks…
  -> select delete all -> close menu -> query all archives (not affected by UI collapse/sorting)
  -> confirmation dialog: count + inaccessible items + removal description
       | cancel: end
       v confirm
  -> route by workspaceIdentity + remoteSessionId to original source
  -> SQLite transaction: still archived and not deleted?
       | no: skip
       | yes: write deleted + clean grouping references -> task_deleted
       | failure: retain, continue other targets
  -> Desktop Controller / list cache refresh; Web list snapshot update; display results
```

Duplicate submissions at the batch entry point are prohibited during query, confirmation, and deletion; "processing" is shown during deletion. Results persist at the top of the archive list; after full success, an empty state and disabled entry point remain. When all sources are inaccessible, the reason is shown; a zero-item confirmation dialog is not shown.

### Batch Execution and Refresh Boundaries

Archive batch deletion uses workspace as the request boundary: `deleteArchivedTasks({ workspacePath, workspaceIdentity, taskIds })`. Only the target IDs confirmed earlier are accepted, returning `deletedTaskIds`, `skippedTaskIds`, `failedTaskIds`, each target falling into exactly one category.

Duplicate IDs are deduplicated; empty collections write nothing and emit no events. The existing contract for single-item `deleteArchivedTask` is unchanged.

```text
Old: UI calls single conditional delete per target via RPC -> per-transaction -> per-event + Host re-read -> UI re-query
New: UI sends one RPC per workspace -> original source adapter performs per-transaction and aggregates
                           -> one workspace task_deleted event if there are successes
                           -> Host / UI batch-reads the latest list
```

The batch holds the confirmed set without saving a second copy of task facts or input queue. Each item still reuses the Repo's transactional archive check, tombstone, and grouping cleanup; failed items roll back independently and continue subsequent items. UI overlay is updated only after persistence succeeds; a workspace-level `task_deleted` event without individual `taskId`/`taskMeta` is published after the batch ends, causing all observers to re-read deleted membership.

Only use the original attachment's source; writes are prohibited when `remoteSessionId` does not match or the source is offline — no auto-reconnect or resumption.

The Host reuses existing event refresh and final mutation refresh with single-flight. Event delivery and RPC response may arrive in either order, allowing constant-round convergence reads, but refresh counts per source must not grow with batch target size. The UI only removes successful targets from the response; skipped and failed items retain original handling; one workspace RPC failure does not block other workspaces.

This contract only extends App service / Controller; it does not change App-Agent wire, desktop continuous, or mobile replayable.

Acceptance: deleting 1/8/72 items from the same source generates one batch RPC call each, one workspace event per workspace with successes, and constant Host partition reads. Covers mixed success/skip/failure, full failure, empty batch, duplicate IDs, same path different identity, remote offline, and stale `remoteSessionId`. Continues verifying retained CLI sessions and grouping transaction rollback.

### 2026-09-07 Entry Point Design Decision: Option B "More Menu"

The user selected B. Design prototype and selection records are saved in the `prototype/archived-task-actions` branch (`eeb9244647`, document `docs/task/archived-task-actions-prototype.md`); the official branch retains only the selected design.

This is a presentation change: `WorkspaceSidebar` provides a toolbar DOM slot, which desktop and Web archive components share via a shared batch control that portals the menu entry to that slot; task collection, service resolution, confirmation, and deletion state remain owned by the original component. Success/failure notifications display in the list; zero results do not occupy an extra row. Closing the menu does not destroy async deletion state. Desktop continuous / mobile replayable, `workspaceIdentity` / `remoteSessionId` routing, and persistence logic are unchanged.

```text
WorkspaceSidebar toolbar: [Filter] [Archive Action Slot] [Close]
                                   ^ portal (render position only)
Desktop archived list / Web task index
  -> shared control (count, busy, confirmation, results) -> existing scoped services
  -> list-top result status
```

accepted: toolbar menu positioning, opening menu does not query/delete, full confirmation after menu selection, cancel and reopen, empty-state disable, Web shared entry, narrow screen and light/dark theme representative validation. pruned: duplicate verification of all Repo/Controller state arrangements, since this only moves the entry point, core guard/routing unchanged. TSL39 original test case updated to first expand the menu then select delete, still pending status.

## Impact Brief

### Feature Summary

| Field             | Content                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Capability / mode | Archive task batch delete / planning                                                                           |
| Change layer      | presentation, validation, commit-effect, persistence                                                           |
| Primary seeds     | WorkspaceArchivedTasksFlatSection, WebRemoteControlTaskIndex, createControllerRoutedTaskService, TaskIndexRepo |
| Out of scope      | Session physical cleanup, workspace files, CLI lifecycle, auto-reconnect, global disk project scan             |

### UI Surface Matrix

| Scenario / Entry         | Shared Implementation                                               | Display State / Default Source                                   | Validation and Submission                             | Authoritative Point                            | Mode and Isolation                                                |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| Desktop archive flat     | Toolbar more menu, confirmation dialog, workspace services resolver | useGlobalTaskList; default collapse at 20 items                  | Full listArchivedTasks; deleteArchivedTasks           | Corresponding Host tasks-index                 | All tabs in current window; local/remote by full identity routing |
| Mobile Web archive index | Same batch control and service interface                            | desktop workspace-list snapshot; unaffected by display filtering | Only process workspace operable by current attachment | shared-host / corresponding remote tasks-index | Cannot send local tasks to remote baseServices                    |

### Shared And Divergent Behavior

Collection reading, confirmation, per-workspace batch execution, and result reporting are shared; desktop Controller membership and Web workspace-list snapshot refresh independently. No draft inheritance or running-state default changes. The single-item delete entry retains existing behavior, only text corrected.

### Feature Relationships / State Owners And Commit Sinks

| Level          | Relation                                                   | Reason / Evidence                                                                                         |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| must-inspect   | Archive entry -> scoped task service -> Controller -> Repo | Cross-source writes must preserve host routing and transactional archive check                            |
| must-inspect   | deleted -> task_deleted -> list membership                 | CLI sessions retained, cannot be re-displayed by subsequent summary                                       |
| should-inspect | Delete -> grouping references and selected task state      | Same as single-item delete, cleaned after transaction success                                             |
| invariant-only | Desktop continuous / mobile replayable                     | This feature does not modify stream, snapshot recovery, queue, owner/lease; no state pushed to main/relay |
| evidence-only  | TSL20, task-index row authority fixture                    | Provides regression evidence for retained sessions and full lists                                         |

### Must-Preserve Invariants

- Identity key is `workspaceIdentity?.trim() || workspacePath`; execution parameters continue passing `workspacePath`. `remoteSessionId` selects an existing source and cannot fall back to another same-path source.
- Archive check, deletion, and grouping cleanup remain in the same SQLite write transaction; failures do not set deleted memory overlay nor publish success events.
- Only reuse existing attachments; do not create new Agent/Host/remote connections. Refresh UI based on task-saved success results; failed items must not be optimistically removed.
- Light/dark themes, English/Chinese, keyboard confirm/cancel, narrow screen accessibility follow DESIGN.md component specs.
- `deleteArchivedTask` / `deleteArchivedTasks` belong only to App service / Controller conditional delete interfaces; no new App-Agent wire commands, no CLI runtime snapshot reads or writes, no change to trusted attachment-injected `clientMode`.

### Codegraph Evidence / Graph Drift / Graph Delta

This session has no callable codegraph; file/symbol and direct caller reading is used instead, spanning two levels. Sidebar two entries, Service adapter, Repo, Controller routing and tests have been verified. The existing graph lacks archive batch semantics; user-confirmed capability, two entries, and persistence edges are added. Node, edge, and file seed verification pass; the graph's existing `capability.mcp-oauth-authorization`, `persistence.desktop-user-data-root` missing references are not expanded in this modification.

### Unresolved Questions

None; the user has agreed to all boundaries above.

## Case Planning and Handoff

The main domain is UI, persistence, workspace isolation. Dimensions: task count 0/1/over 20, confirm/cancel, archive state changes, success/failure/offline, and desktop/Web.

| Case          | Setup -> Action                                                                         | Assertions                                                                                                                          | Evidence / Status                        |
| ------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| TSL39         | 25 archived + normal tasks; click batch, cancel, reconfirm                              | Confirm count includes collapsed items; cancel writes nothing; all archived deleted, normal items retained, UI empty-state disabled | Real SQLite + desktop pending E2E        |
| TSL39-guard   | Same path, different identity; restore/recreate archive after confirm; duplicate delete | Only delete confirmed set and still-archived targets; restore/skipped tasks skipped; identity isolation                             | Repo/adapter focused tests               |
| TSL39-partial | One source inaccessible, one task write failure                                         | Display unprocessed items; other items continue; failed items retained, no success broadcast                                        | Batch orchestration + Repo focused tests |
| TSL39-web     | Web archive entry, mixed write scope and read-only scope with attachment                | Same confirm/full-delete behavior; successful items removed from snapshot, unauthorized sources not called                          | Web UI / shared control focused tests    |

accepted: above cases. pruned: provider/Goal/queue/tools/theme deletion status full permutations (deletion only modifies membership); theme/locale uses UI representative validation, stream boundaries maintain existing regression. undefined: none. bug-candidate: old confirmation dialog falsely claims to clean session data; corrected this time.

Catalog and coverage matrix register TSL39; new E2Es retain manual-review/pending, not auto-promoted. Uses existing tasks-index cold-start fixture isolation data; no model requests needed, provider replay uses only common fixture; no timed model streams or Docker admission changes.

## Verification Record

### 2026-09-17 Batch Refresh Fix

- Root cause baseline `d1e524b2df`: UI calls single conditional delete per target, causing each submission to broadcast separately and force re-read of Host partitions.
  The fix passes the batch to the original workspace service; the adapter retains per-item transactions, aggregates results, and notifies once.
- Same real UI orchestration / Controller boundary regression at 1, 8, 72 items: delete requests are all one call; Host partition reads
  converge from 3, 24, 216 calls to 3, 3, 3 calls. The test source uses observable fixtures; real Repo / adapter
  additionally validates mixed success/skip/failure, duplicate IDs, concurrent batches, identity isolation, and no-success-no-broadcast.
- 181 related tests pass in batches, including Web menu, workspace-level batch event refresh tombstone, Controller
  offline/stale remoteSessionId rejection, and refresh failure not re-reporting submitted results; `pnpm typecheck`,
  `pnpm lint` (52 pre-existing warnings, 0 errors), `pnpm architecture:check --changed` pass.
- Desktop pending E2E `desktop-e2e-20260917044517738-p61874-adfc3f6d1db019f0` passes, 25-item delete,
  cancel, empty-state, normal tasks, and CLI session retention all pass. Compare baseline run
  `desktop-e2e-20260917040534711-p42824-ae8a264ab2d3c00d` for the same case, taking the first delete RPC
  100ms before to 500ms after the last call execution window, delete RPC 25→1, five membership queries each 25→1, Controller queries 26→2.
  Service summary: requested=25, deleted=25, skipped=0, failed=0; these counts are not cross-environment time benchmarks.
- Coverage audit still has 10 pre-existing documentation errors, consistent with isolation original baseline item-by-item; no expansion of this fix.
  Real mobile shared-host, cross-device offline, Windows/Linux untested on real hardware; E2E remains pending.

### 2026-09-07 Initial Verification

- 143 related unit tests pass: full collection/cancel phase writes nothing, partial failures, archive check, duplicate delete, transaction rollback, same-path cross-identity isolation, Controller routing, Web entry, and empty-state.
- Desktop pending E2E passes: 25 archived fully deleted, cancel writes nothing, normal tasks and CLI sessions retained, success empty-state and entry disabled. Run ID: `desktop-e2e-20260907102609958-p94926-cacb5afb92b7b9fc`.
- Current desktop and CLI rebuilt. First startup failed due to temporary ChromeDriver cache missing binaries; cache restored and tests run. Test cancels dialog then waits for exit animation unmount to avoid clicking old confirmation button; final rerun reuses the same current desktop build.
- `pnpm typecheck`, desktop `typecheck:e2e`, `pnpm lint`, conversation coverage audit pass; lint has 43 pre-existing warnings, no new errors.
- Chinese dark confirmation dialog and post-delete empty-state screenshots checked. Real mobile shared-host remote control, real SSH/WSL/Docker offline, Windows/Linux and light-theme real hardware untested; related code implemented via shared components, identity isolation, and existing delivery boundaries; focused tests do not equal these real hardware coverage.

### Option B Landing Verification

- 18 UI/orchestration unit tests pass: toolbar portal, menu open no query/delete, confirmation disable, cancel retry, in-list results, Web index delete removes snapshot tasks and retains disabled entry.
- Current desktop and CLI rebuilt. Desktop pending E2E passes, run ID: `desktop-e2e-20260907110058327-p25062-fe50e38b20b124f9`; keyboard menu retest: `desktop-e2e-20260907-111050-819`. 25-item full confirm, cancel, actual delete, normal tasks and CLI session retention, empty-state all pass.
- Screenshot review found ChromeDriver element auto-scroll shifts sidebar internal `overflow-hidden` container horizontally by 65px. Runtime geometry records show body/viewport at 1200px, sidebar at 264px; waiting for entry enable, opening the menu via keyboard shows 0 horizontal scroll offset for all; screenshots complete. E2E uses the keyboard path, removed temporary diagnostic output.
- `pnpm typecheck`, desktop `typecheck:e2e`, `pnpm lint` (43 pre-existing warnings, 0 errors), conversation coverage audit, and graph YAML/updated export seed check pass.
- Real hardware screenshot for desktop Chinese dark; B prototype 390×844 English dark validation retained in prototype branch. Real mobile shared-host remote control, Windows/Linux, and light-theme real hardware untested; component tests do not equal these coverage.
