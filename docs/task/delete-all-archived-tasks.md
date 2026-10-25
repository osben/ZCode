# One-Click Delete All Archived Tasks

## Requirements (confirmed 2026-09-07)

1. Delete archived tasks across all workspaces covered by the current window's archived list, including collapsed items from the 21st onward; projects already removed from the window are not scanned.
2. The archive toolbar has a neutral "More" icon between the filter and close buttons. Its menu shows the archive count and a red "Delete All Archived Tasks…", disabled when the list is empty. Available on desktop and mobile Web; single-item operations remain.
3. On click, read the full archive set from each workspace, then show one confirmation dialog with the accurate processable count and the inaccessible items. The body only states that tasks are removed from the task list and archive list (no session record or file retention details). Single-item archive deletion uses the same text, synchronized in Chinese and English. Cancel writes no data.
4. Existing delete semantics: persist a `deleted` flag and remove list and grouping references; CLI session records, project files and worktrees remain.
5. One failure does not block others; report counts of succeeded, skipped and failed tasks plus unprocessed items. Undeleted tasks are retained for retry. Offline projects are not auto-connected and deletion does not resume after reconnection.
6. The target set is fixed when the confirmation dialog opens. During execution `archived` is checked again inside the persist write transaction; restored or already-deleted tasks are skipped, and archives added afterward do not enter this operation.

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

Duplicate submissions at the batch entry are prohibited during query, confirmation and deletion; "processing" is shown during deletion. Results stay at the top of the archive list; after full success an empty state and a disabled entry remain. When all sources are inaccessible the reason is shown and no zero-item confirmation dialog appears.

### Batch Execution and Refresh Boundaries

1. Workspace is the request boundary: `deleteArchivedTasks({ workspacePath, workspaceIdentity, taskIds })`. Only the previously confirmed target IDs are accepted; the response has `deletedTaskIds`, `skippedTaskIds`, `failedTaskIds`, each target in exactly one. Duplicate IDs are deduplicated; an empty collection writes nothing and emits no events. Single-item `deleteArchivedTask` is unchanged.
2. The UI sends one RPC per workspace; the original-source adapter runs per-item transactions and aggregates, emitting one workspace `task_deleted` event if there are successes, after which Host/UI batch-read the latest list. (Before, the UI called the single conditional delete per target, each broadcasting separately and forcing a Host re-read.)
3. The batch holds the confirmed set without a second copy of task facts or input queue. Each item reuses the Repo's transactional archive check, tombstone and grouping cleanup; failed items roll back independently and later items continue. The UI overlay updates only after persistence succeeds; the workspace-level `task_deleted` event has no individual `taskId`/`taskMeta`, so all observers re-read deleted membership.
4. Only the original attachment's source is used; writes are prohibited when `remoteSessionId` does not match or the source is offline (no auto-reconnect or resumption).
5. The Host reuses existing event refresh and the final mutation refresh with single-flight. Event delivery and RPC response may arrive in either order, allowing constant-round convergence reads, but refresh counts per source must not grow with batch size. The UI removes only successful targets from the response; skipped and failed items keep original handling; one workspace RPC failing does not block others.
6. The contract extends only App service / Controller; App-Agent wire, desktop continuous and mobile replayable are unchanged.

Acceptance: deleting 1/8/72 items from one source makes one batch RPC each, one workspace event per workspace with successes, and constant Host partition reads. Covers mixed success/skip/failure, full failure, empty batch, duplicate IDs, same path with different identity, remote offline and stale `remoteSessionId`; retained CLI sessions and grouping transaction rollback continue to be verified.

### Entry Point Design Decision: Option B "More Menu" (2026-09-07)

The user selected B. The prototype and selection records are on the `prototype/archived-task-actions` branch (`eeb9244647`, `docs/task/archived-task-actions-prototype.md`); the official branch keeps only the selected design.

Presentation change only: `WorkspaceSidebar` provides a toolbar DOM slot; desktop and Web archive components share a batch control that portals the menu entry to that slot. Task collection, service resolution, confirmation and deletion state remain owned by the original component. Success/failure notices show in the list; zero results take no extra row. Closing the menu does not destroy async deletion state. Desktop continuous / mobile replayable, `workspaceIdentity` / `remoteSessionId` routing and persistence are unchanged.

```text
WorkspaceSidebar toolbar: [Filter] [Archive Action Slot] [Close]
                                   ^ portal (render position only)
Desktop archived list / Web task index
  -> shared control (count, busy, confirmation, results) -> existing scoped services
  -> list-top result status
```

Accepted: toolbar menu positioning; opening the menu neither queries nor deletes; full confirmation after menu selection; cancel and reopen; empty-state disable; Web shared entry; narrow screen and light/dark representative checks. Pruned: duplicate verification of all Repo/Controller state arrangements (only the entry moved; core guards/routing unchanged). The TSL39 test case now expands the menu first and then selects delete; it stays pending.

## Impact Brief

### Feature Summary

- Capability / mode: archive task batch delete.
- Change layer: presentation, validation, commit-effect, persistence.
- Primary seeds: WorkspaceArchivedTasksFlatSection, WebRemoteControlTaskIndex, createControllerRoutedTaskService, TaskIndexRepo.
- Out of scope: session physical cleanup, workspace files, CLI lifecycle, auto-reconnect, global disk project scan.

### UI Surface Matrix

- Desktop archive flat: toolbar more menu, confirmation dialog, workspace services resolver; display state from useGlobalTaskList (default collapse at 20 items); full `listArchivedTasks` then `deleteArchivedTasks`; authority is the corresponding Host tasks-index; all tabs of the current window, local/remote routed by full identity.
- Mobile Web archive index: same batch control and service interface; display state from the desktop workspace-list snapshot (unaffected by display filtering); processes only workspaces operable by the current attachment; authority is shared-host / the corresponding remote tasks-index; must not send local tasks to remote baseServices.

### Shared And Divergent Behavior

Collection reading, confirmation, per-workspace batch execution and result reporting are shared; desktop Controller membership and the Web workspace-list snapshot refresh independently. No draft inheritance or running-state default changes. The single-item delete entry keeps its behavior; only the text is corrected.

### Feature Relationships / State Owners and Commit Sinks

- must-inspect: archive entry -> scoped task service -> Controller -> Repo (cross-source writes must preserve host routing and the transactional archive check).
- must-inspect: deleted -> task_deleted -> list membership (CLI sessions are retained and must not be re-displayed by a later summary).
- should-inspect: delete -> grouping references and selected task state (same as single-item delete, cleaned after transaction success).
- invariant-only: desktop continuous / mobile replayable (no change to stream, snapshot recovery, queue, owner/lease; no state pushed to main/relay).
- evidence-only: TSL20, task-index row authority fixture (regression evidence for retained sessions and full lists).

### Must-Preserve Invariants

- Identity key is `workspaceIdentity?.trim() || workspacePath`; execution parameters keep passing `workspacePath`. `remoteSessionId` selects an existing source and cannot fall back to another same-path source.
- Archive check, deletion and grouping cleanup stay in one SQLite write transaction; failures set no deleted memory overlay and publish no success event.
- Only existing attachments are reused; no new Agent/Host/remote connections. The UI refreshes from task-saved success results; failed items are never optimistically removed.
- Light/dark themes, English/Chinese, keyboard confirm/cancel and narrow-screen accessibility follow DESIGN.md.
- `deleteArchivedTask` / `deleteArchivedTasks` belong only to the App service / Controller conditional delete interfaces: no new App-Agent wire commands, no CLI runtime snapshot reads or writes, no change to the trusted attachment-injected `clientMode`.

### Graph Evidence

No callable codegraph was available; two levels of file/symbol and direct-caller reading verified the two sidebar entries, Service adapter, Repo, Controller routing and tests. Archive batch semantics, the two entries and persistence edges were added to the feature graph; node, edge and file seed checks pass. The graph's existing `capability.mcp-oauth-authorization` and `persistence.desktop-user-data-root` missing references are not expanded here.

### Unresolved Questions

None; the user agreed to all boundaries above.

## Case Planning

Domains: UI, persistence, workspace isolation. Dimensions: task count 0/1/over 20, confirm/cancel, archive state changes, success/failure/offline, desktop/Web.

- **TSL39**: 25 archived + normal tasks; click batch, cancel, reconfirm. Confirmation count includes collapsed items; cancel writes nothing; all archived deleted, normal items retained, UI empty-state disabled. Real SQLite + desktop pending E2E.
- **TSL39-guard**: same path with different identity; restore/recreate archive after confirm; duplicate delete. Only the confirmed set and still-archived targets are deleted; restored/skipped tasks skipped; identity isolation. Repo/adapter focused tests.
- **TSL39-partial**: one source inaccessible, one task write failure. Unprocessed items displayed; other items continue; failed items retained, no success broadcast. Batch orchestration + Repo focused tests.
- **TSL39-web**: Web archive entry with mixed write scope and read-only scope. Same confirm/full-delete behavior; successful items removed from the snapshot; unauthorized sources not called. Web UI / shared control focused tests.

Pruned: provider/Goal/queue/tools/theme full permutations (deletion only changes membership); theme/locale use representative UI checks; stream boundaries keep existing regression. Bug found and fixed: the old confirmation dialog falsely claimed to clean session data.

The catalog and coverage matrix register TSL39; the new E2Es stay in manual-review/pending, not auto-promoted. They use the existing tasks-index cold-start fixture isolation data; no model requests, no timed model streams, no Docker admission changes.

## Verification Record

- 2026-09-07 initial: 143 related unit tests pass (full collection/cancel writes nothing, partial failures, archive check, duplicate delete, transaction rollback, same-path cross-identity isolation, Controller routing, Web entry, empty state). Desktop pending E2E passes (25 archived fully deleted, cancel writes nothing, normal tasks and CLI sessions retained, success empty state and disabled entry), run `desktop-e2e-20260907102609958-p94926-cacb5afb92b7b9fc`. `pnpm typecheck`, desktop `typecheck:e2e`, `pnpm lint` (43 pre-existing warnings, 0 errors), conversation coverage audit pass. Chinese dark confirmation dialog and post-delete empty-state screenshots checked.
- Option B landing: 18 UI/orchestration unit tests pass (toolbar portal, menu open does no query/delete, confirmation disable, cancel retry, in-list results, Web index delete removes snapshot tasks and keeps the disabled entry). Desktop pending E2E passes: `desktop-e2e-20260907110058327-p25062-fe50e38b20b124f9`; keyboard-menu retest `desktop-e2e-20260907-111050-819`. ChromeDriver element auto-scroll shifted the sidebar's `overflow-hidden` container horizontally by 65px; the E2E uses the keyboard path, which shows 0 horizontal scroll offset (body/viewport 1200px, sidebar 264px).
- 2026-09-17 batch refresh fix (baseline `d1e524b2df`): the UI used to call single conditional delete per target, each submission broadcasting and forcing Host partition re-reads. Now the batch goes to the original workspace service, the adapter keeps per-item transactions, aggregates and notifies once. At 1/8/72 items the delete request is one call each and Host partition reads converge from 3/24/216 to 3/3/3. Real Repo/adapter tests additionally cover mixed success/skip/failure, duplicate IDs, concurrent batches, identity isolation and no-success-no-broadcast. 181 related tests pass; `pnpm typecheck`, `pnpm lint` (52 pre-existing warnings, 0 errors), `pnpm architecture:check --changed` pass. Desktop pending E2E `desktop-e2e-20260917044517738-p61874-adfc3f6d1db019f0` passes (25-item delete, cancel, empty state, normal tasks, CLI session retention); against baseline run `desktop-e2e-20260917040534711-p42824-ae8a264ab2d3c00d`, delete RPC 25→1, membership queries 25→1 each, Controller queries 26→2 (requested=25, deleted=25, skipped=0, failed=0; not a cross-environment timing benchmark).
- Known gaps: coverage audit still has 10 pre-existing documentation errors (unchanged from baseline). Real mobile shared-host remote control, cross-device offline, real SSH/WSL/Docker offline, Windows/Linux and light-theme real hardware are untested (covered only through shared components, identity isolation and existing delivery boundaries; focused tests are not real-hardware coverage); E2E stays pending. A B-prototype 390×844 English dark check is retained on the prototype branch.
