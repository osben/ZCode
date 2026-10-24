# Task Grouped View

## Recovery Ruling (Current, 2026-10-13)

Status: implemented; GUI cases stay manual-review/pending. This ruling overrides the older
implementation notes later in this file.

- The filter menu is "By project / By group / Recently updated"; the old two-level switcher is not
  restored.
- A task belongs to at most one project and one group. A group may mix local and remote project tasks and
  only organizes membership and order: it never changes project_id, cwd, additional directories, config,
  permissions or CLI activity time.
- Existing manual, auto-generated, empty, scheduled and idle system groups are kept; groups are no longer
  created automatically per workspace. Queries are read-only and the forced 7-day archive is not
  restored; auto-archive keeps using the Host scheduler and user settings.
- Name, seven colors, collapse, expand/collapse all, manual drag, sticky header, virtual list and ungroup
  are restored. Ungroup moves all members back to their original top-level position in their original
  order and never deletes or archives tasks.
- "By group" reuses the global pinned task area at the top and the body does not repeat pinned tasks;
  archived tasks are hidden but keep membership and position. pin/unpin and archive/unarchive do not
  change group relations; only an explicit delete clears references.
- The task menu of all three views shares add-to/remove-from group. Project move and group move are
  expressed separately and never modify each other.
- New inside a group fixes the placement to that group; the execution project is still chosen in the
  Composer. Ordinary project selection and the remote-directory confirmation after chat connection both
  reuse that draft placement; a new draft started from an existing session does not read a leftover
  draft's group. The global New in group view inherits the group of the current task, otherwise goes to
  top level. A forked new task goes to top level.
- Placement binds to the stable draft identity; the first send reuses the existing warm-up single-flight;
  after creation, group admission is idempotent and must not be inferred from ordinary task navigation.
  If the target group was ungrouped, the task goes to top level. A failed organization commit retries only
  the organization action and never creates the session again.
- First-send directory confirmation and organization commit complete separately: once the authoritative
  task row arrives, the shared directory is published and detail promotion completes immediately; group
  registration runs independently and the group re-read is not part of the first-send barrier. Navigation
  cancel ends the UI wait immediately; if the task row has not arrived yet, the original directory owner
  keeps this creation's organization callback and runs it exactly once after confirmation, never
  navigating back to a detail the user already left. A pending or failed registration must not hold the
  directory read, block other tasks or trigger a duplicate creation; failure retries with the original
  creationId.
- System groups keep receiving new scheduled/idle tasks; first admission is committed in the same
  transaction as membership/order; repeated sync does not re-pin, and a restart must not pull back tasks
  the user moved out or organized.
- Display preference belongs to the current client; a valid new view wins. If no new preference exists,
  migrate the old `zcode-sidebar-task-preferences.organizeBy`: `grouped` -> by group, `chronological` ->
  recently updated, `project` -> by project; with no valid preference default to by project. A user who
  chose grouped before the upgrade still gets by group afterward; an explicit switch later wins. Project
  and group orders do not affect each other, and the Composer project directory does not respond to view
  switches.

```text
owning Host task/project projection ──┐
                                      ├─ shared directory owner ── by project / by group / recently updated
controller Host group structure ──────┘
menu/drag -> Host validation -> SQLite single transaction -> commit -> broadcast invalidation -> re-read
draft -> capture identity/placement -> same creation -> authoritative directory confirmation -> publish directory / promote real task
                                                        └-> independent group commit -> group re-read
desktop continuous / mobile replayable -> same organization owner, original session chains unchanged
```

- Reuse `task_groups`, `task_group_members`, `task_group_view_node_orders`; the bootstrap table is kept
  only as history. The group service provides structure read, CRUD, single-node move and first-task
  admission, stored in the controller's `tasks-index.sqlite`.
- A task reference keeps Host, canonical workspace identity and taskId; the temporary remoteSessionId is
  never in a persisted key. The shared task tree is reused: no separate task-fact cache, and group
  queries never connect to remotes or start an Agent.
- A move submits only the involved nodes and anchors, re-checks source and target inside the transaction,
  and rejects stale input then refreshes. The visible list never overwrites the whole database, so
  offline/archived/pinned members are kept; a disconnect or a snapshot missing a row is not a delete.
  A remote identity migration updates members and top-level keys together; a late response cannot restore
  a removed entry.
- The Group -> Project conversion is cancelled; workspace -> Project and the CLI fact handoff stay.
  Existing migration IDs/SQL checksums are not modified and recorded migrations are not re-run; needed
  initial state uses additive migrations. The refactor was unreleased, and already-converted development
  databases do not delete projects by name or directory guess.

### 2026-10-14 Legacy Presentation and Interaction Restore

Presentation and interaction follow the source before the group removal merge (`fd2f4f38a4a^1`):
`workspace-grouped-tasks/`, `WorkspaceGroupedTasksSection.tsx` and the sidebar toolbar; screenshots only
assist checking. The original components are restored, wired to the current directory and organization
services, without redesigning styles or gestures.

- The "By group" filter uses `Hash`; the new-group and collapse-all entries are back in the list toolbar,
  and no "By group" title is inserted in the list.
- Original task-row density, title fade, time/status/hover actions, context menu, rename dialog and file
  entry are restored.
- Original group color dot, arrow after the title, count, MessageCirclePlus, colored vertical line and the
  clickable dashed empty state are restored. Clicking the dot changes color; title/header collapses;
  right-click renames, recolors or ungroups. System groups cannot be renamed or ungrouped, as in the old
  component. New first creates the group, then enters name editing and opens the color menu; IME and
  menu-focus protection are kept.
- While renaming only drag is disabled (the input is not marked unavailable); menu-close focus return
  must not re-select already typed text, and a non-IME Enter commits explicitly. Verified by real
  component regressions and mobile long-press rename.
- Whole-row drag, direction-decided before/after insertion, group head/tail/empty-group drop targets,
  temporary collapse of the dragged group with cancel restore, preview animation and Workbench split
  hand-off are restored; a group move is not committed when a split takes over. The original virtual list
  and the sticky header outside the mask are reused.
- In-group draft display uses the current Composer draft's placement and creates no second task fact or
  persisted organization copy. Since an empty body is not persisted, the draft display subscribes to the
  existing in-memory workspace draft's `draftTaskGroupId`; when viewing a session only an actually saved
  uncommitted text draft is shown, and no empty row remains after first send. Closing clears only the
  in-memory intent and the group field in saved bodies, keeping body, project, model and warm-up state.
- The idle system group's new entry still opens Automations; closing the draft row only revokes the group
  intent and keeps body and project selection.
- The view the old component needs is only a display projection of the current task tree and Host group
  structure. A drag preview lives only during that gesture and commit and is cleared on completion or
  failure; release submits only the current node and anchors, keeps source validation, and does not
  restore the old full `applyOrder` write-back. The CR-01 fix for first-send directory and independent
  group registration is unchanged.

GRP11 (accepted): check the old component on desktop and mobile, light and dark; actually click color,
right-click rename/ungroup, empty-group new, draft, whole-row cross-group/top-level move, group sorting,
cancel and sticky header; assert Host ownership and that the current task is not cross-wired.

Mobile Web shared-host 1/1 passed (`desktop-e2e-20261014050943064-p51374-dd60ab66d87ef0e2`): touch dot
recolor, expand/collapse, long-press rename and ungroup, read back through a real Host; light/dark
screenshots and viewport bounds checked. Desktop final results are in the
[coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md). GUI cases stay
manual-review/pending, and this is not extended to physical phones, Windows/Linux or real remote
reconnect.

<a id="恢复验收"></a>

### Recovery Acceptance

| Case  | Setup -> Action -> Assertion                                                                                           | Evidence           |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------------------ |
| GRP01 | Old group / empty group / system group / mixed-device fixture -> upgrade twice -> groups kept, no Group project, workspace projects normal | SQLite hash/ledger |
| GRP02 | Three views -> switch/reload -> preference and collapse restored, project order and current task unchanged             | GUI/localStorage   |
| GRP03 | Create/rename/recolor/ungroup -> restart -> persisted, no task deleted                                                 | GUI/SQLite         |
| GRP04 | Top-level / in-group / empty group and invisible members -> menu/drag -> only target nodes change, execution scope unchanged | GUI/Host           |
| GRP05 | In-group task -> pin/archive/restore/delete -> no duplicates, position restored, explicit delete clears references    | GUI/SQLite         |
| GRP06 | Warm draft -> first send / switch group / switch project / ungroup / delayed ACK -> one session, placement does not cross groups | GUI/create calls   |
| GRP07 | Scheduled/idle first mark -> sync/move out/restart -> admitted once, respects organization                             | Host/GUI           |
| GRP08 | Different Hosts with same path and taskId -> mixed group / offline / reconnect / identity migration -> no cross-wiring, no lost members | identity/GUI       |
| GRP09 | Two windows/phone move concurrently -> interleaved commits -> unrelated nodes not overwritten, stale anchors rejected  | two connections/SQLite |
| GRP10 | Large list / continuous activity / split drag -> scroll and switch -> no blank flash, split does not change order      | GUI/runtime        |

Acceptance covers desktop and mobile shared-host, light/dark themes and zh/en; narrow-screen screenshots
do not replace phone evidence. New GUI cases enter manual-review/pending first, and actual runs and
formal admission are recorded separately. Model/provider permutations, scheduler refactor and real
development database repair are out of scope.

### Verification Outcome (2026-10-13)

- macOS desktop 4/4 passed (`desktop-e2e-20261013112431949-p31219-24a66fb6a84a439e`): old group
  preference migration, new view reload priority, group editing, first send, pin/archive restore,
  cross-group handle move, thousand-row virtual scroll, sticky header and collapse reload; screenshots
  cover zh light and en dark.
- Database, concurrent organization commands, Host ownership, draft placement and view projection are
  verified by affected unit tests. Existing migration SQL/checksums are unchanged; the new
  `0006_task_group_admissions` records first admission so a system task moved out by the user is not
  pulled back by repeated sync. The schema baseline matches the generated result.
- Mobile shared-host results are in the coverage matrix above. Real SSH/WSL/Docker whole-machine group
  interaction, create-ACK recovery after network loss and long continuous-activity stress are not
  verified; GRP01-GRP10 are not claimed fully covered and are not auto-promoted.
- `pnpm typecheck` (incl. E2E types), `pnpm lint`, `pnpm architecture:check --changed` and
  `pnpm db:schema:check` passed; no full root unit run.

## Older Implementation Notes (Not the Current Data Chain)

> These records cover 2026-09 and earlier. Current behavior follows the recovery ruling above. The old
> workspace bootstrap, group-query auto-archive and the old two-level switcher are not restored.

`Group` is the user-visible view entry in the sidebar task area, mixing user-defined cross-workspace task
groups and ungrouped tasks in one list. Internal state, interfaces and persistence keep the `grouped` /
`Grouped` naming to avoid breaking existing data structures. Supported: the `Group` view entry, `New
Group`, mixed cross-workspace task/group display, menu move to / remove from group, SQLite persistence,
optimistic commit, group rename, group color, group header context menu, and restricted task-over-task
drag sorting.

Entering `Group` still reuses the global `Pinned` area above the grouped body. The grouped body shows only
non-pinned, non-archived tasks; a pinned task moves only to the `Pinned` area of the same page, never
appears in a group or top level too. pin/unpin does not modify the task's group membership and user order;
unpinning returns it to its original position.

## View Order

The task view menu order is fixed: 1. `Group`, 2. `Workspace`, 3. `Timeline`. `Workspace` keeps the
current per-workspace grouping; `Timeline` keeps the current timeline display.

## List Structure

```tsx
<task-group-list>
  <new-group-item />
  <new-task-item />

  <task-item />
  <task-item />
  <group-item>
    <group-title />
    <task-list>
      <task-item />
      <task-item />
    </task-list>
  </group-item>
  <task-item />
  <group-item>
    <group-title />
    <task-list>
      <task-item />
      <task-item />
    </task-list>
  </group-item>
  <task-item />
</task-group-list>
```

- `new-group-item` and the global `new-task-item` are fixed at the top of the mixed list and do not take
  part in persisted user order.
- A real group created by `new-group-item` is written to the top-level user order immediately, at the very
  top of the mixed list.
- A top-level `task-item` is a task in no group; `group-item` is a user-defined group; a task inside a
  group no longer appears at top level.
- Archived or deleted tasks are fully invisible in `Grouped`, including inside groups. Pinned tasks do not
  enter the grouped body but are visible in the global `Pinned` area at the top of the same page; this is
  not a delete, archive or group-membership removal.
- Empty groups are kept so user-created containers do not vanish when members are temporarily invisible.
- Group membership and mixed order are independent of the global task sort; switching the creation/update
  time sort of `Workspaces`/`Timeline` must not change `Grouped`.
- On first mount of the Grouped view, until the first structure/membership request has finished and the
  first sessions-index snapshot is hydrated, the body stays empty: no "fetching tasks" text, no store-held
  grouped draft, no group container, empty state or empty list; the already-present Pinned area is
  unaffected. After both sources are ready, draft and authoritative list show at once; later background
  refreshes keep existing content to avoid a blank flash or loading text.

## New Task Draft Placement

In `Grouped` mode the global `New task` derives the draft position from the current active task:

1. Active task inside a group: create a grouped draft in the same group and auto-expand it.
2. Active task is a top-level ungrouped task: create a top-level grouped draft.
3. No active task, active task not in the current grouped view, or the grouped view not yet mounted: fall
   back to a top-level grouped draft.
4. Already in a grouped draft state: reuse the current draft's placement, so an in-progress group draft is
   not moved to top level.
5. `New task` in a group header/menu always creates explicitly in that group.
6. A grouped draft's placement is bound to the new task id explicitly only after the draft session is
   actually created or the warm-up session is actually promoted. The create command must capture the stable
   draft identity and placement before the first async wait; when the ACK or a pending-command resend
   completes, only that snapshot is committed and the draft is cleared only if the current draft identity
   still matches. A null-session pending create must also persist the source workspace scope and filter
   the restore entry by `workspaceIdentity?.trim() || workspacePath`, so it is never shown or consumed in
   another workspace. Ordinary task selection, fork navigation and restoring an existing session only
   navigate and must not be inferred as draft promotion, which would wrongly change an existing task's
   group and order.
7. On first-send promotion of a root draft, the Host must commit the task row and the top-level
   `sort_order` in one SQLite transaction, and publish the sessions-index/task list refresh only after
   commit. Even if the Renderer receives the sessions-index content frame before the grouped structure, it
   keeps the optimistic root top position and must not append the new task at the end and then move it up.

## Expand and Collapse

`Grouped` reuses the `Expand all` / `Collapse all` tool button beside the sidebar task area title.

- The batch button shows when the current grouped view has at least one group.
- Expand/collapse is a display preference of the current user and device/browser, persisted in UI-side
  `localStorage` under `zcode-grouped-task-collapsed-groups`.
- The persisted value stores only collapsed group ids as `{ [groupId]: true }`; absent groups are
  expanded, so new groups default to expanded and the full group order is not copied into UI preferences.
- If no group is collapsed the button reads `Collapse all`: it writes all group ids of the current view
  into the collapsed set and syncs localStorage. If any group is collapsed it reads `Expand all`: it
  clears the set and syncs localStorage.
- After a group is deleted or the view refreshes, stale collapsed ids are cleaned against the current
  group id list and written back, so later new groups are not hit by old state.
- `New task` inside a group still auto-expands it so the new draft is visible.
- The project label of a draft task item uses `text-ui-sm` and stays visible and in place on hover; the
  status dot and close button share a fixed-width action slot and switch in place on hover. Clicking close
  clears only the current grouped draft; it does not archive or delete a real task.

## Group Semantics

A group is a user-defined global task organization container: it has a name; a color (reference: macOS
Finder tag colors); it may contain tasks of different workspaces; a task belongs to at most one group;
deleting a group only removes membership and never deletes or archives its tasks.

## Group Header Menu

The group header expands/collapses. Right-clicking it shows a context menu:

```txt
New task
---
Rename
Change Color >
  Gray
  Red
  Orange
  Yellow
  Green
  Blue
  Purple
---
Ungroup
```

- `New task` reuses the existing sidebar new-task entry and does not change the group's membership.
- `Change Color` is a submenu whose items show only text and a small color dot.
- `Rename` enters inline title edit with the same semantics as the bot channel.
- `Ungroup` moves all tasks of the group back to the root top level and deletes the group, with no second
  confirmation because tasks are never deleted or archived.
- `Ungroup` persists in this order: save the new root/grouped view order first, then delete the group, so
  the membership cascade does not lose the user-visible order of the group's tasks.

## Task Item Menu

All task items in `Grouped` (root and in-group) show a context menu:

```txt
Move to group >
  Remove from group
  ---
  <dot color> <group title>
  <dot color> <group title>
---
Rename task
Archive task
Mark as unread
---
Open in Finder / File Explorer / File Manager
Copy path
Copy task path
Copy log path
Copy session id
Go to config
---
Feedback
```

- `Move to group` is a submenu listing all groups of the current grouped view with the group color dot
  before the name.
- System groups (cron, idle) in `Move to group` use the localized display title
  (`getTaskGroupDisplayTitle`) like the group header, never the DB placeholder titles (`cron` /
  `off-peak`).
- The group the task is currently in is disabled in the submenu.
- `Remove from group` is disabled for a root task; for an in-group task it moves the task to root, placed
  after its former group to keep the spatial context.
- `Rename task`, `Archive task`, `Mark as unread`, path copy, config jump and feedback keep the
  workspace view's task-level semantics.

## Task Drag Sorting

Grouped supports direct drag between task items, modeled on the dnd-kit virtualized sortable list:

1. Drag sorting is driven by the dnd-kit `over` result: `collisionDetection` only picks the current over
   droppable, `onDragOver` updates the preview view by droppable type; there is no `dragMove` scan of all
   tasks nor pointer-midline decision. `dragMove` only records the drag direction from the delta change
   of two adjacent frames, and when the direction reverses with the over target unchanged it reuses the
   latest over target to refresh the preview.
2. Auto-scroll uses `autoScroll.threshold = { x: 0.1, y: 0.1 }`: scrolling triggers only when the drag
   rectangle enters the 10% edge zone of a scrollable ancestor (the default 20% is too sensitive in short
   containers).
3. Only task, group header, group footer, collapsed group, empty drop zone and group-sort targets are
   hit; draft tasks, the fixed `New group` / `New task` rows and blank areas do not take part.
4. Hitting a root task targets the root parent; hitting a group task targets that group.
5. Task-over-task insert position follows the continuously refreshed current direction: moving down
   inserts after the target task, moving up inserts before it; it is not toggled repeatedly by a
   `dragMove` midline inside the same over task.
6. A collapsed group item is an independent droppable; task over collapsed group inserts before/after the
   group at root level by `dragOver` direction.
7. An expanded group is `<group><header /><content /><footer /></group>`: the header is an independent
   droppable; task over header moves up = out to root before the group, down = into the group before the
   first task. Content sorts by task over task. The footer is an independent droppable in normal layout
   flow (no absolute bottom padding); task over footer moves up = insert at the tail of the group list,
   down = out to root after the group.
8. An expanded empty group has an independent empty drop zone; task over it moves the task into the
   group's first position by `dragOver`. The zone mounts/unmounts synchronously with the empty-group
   state, with no opacity fade, so it cannot affect hit testing while hidden.
9. The group header is the group drag handle; starting a group drag temporarily collapses that group and
   restores the pre-drag collapse state on end or cancel. The group drag overlay reuses the normal
   header's display title; the system cron group shows the localized name in normal header, sticky header
   and drag overlay, never the persisted placeholder `cron`.
10. Group drag only moves whole group blocks at root level: group over root task and group over group
    decide before/after by the direction at the moment of entering the target; group over group
    task/content never nests.
11. A same-parent move is a reorder; a cross-parent move removes from the old parent then inserts into the
    target parent.
12. Supported move types: root task over root task; root task over group task; group A task over group B
    task; group task over root task; task over group item area; task over empty group drop zone; group
    over root task; group over group.
13. After the drag ends, `applyGroupedTaskViewOrder` commits the final root order and group membership at
    once; cancel or save failure rolls back to the pre-drag view.
14. Tasks in the virtual list use a stable key of workspace identity + task id as draggable/droppable id,
    never the index, so scroll-window remounts do not misalign.
15. The drag preview is the in-list active task row showing the current drop position, not a mouse
    overlay; root and group previews use an invisible placeholder row style (no border or background),
    keeping only the container's natural indent and the group's left edge line.
16. The drag overlay is a display-only floating layer following the mouse, portaled to `document.body`
    (not inside the grouped scroll container, to avoid scrollbar and clipping), with `bg-background`,
    width following the actual width of the in-list preview row with a short transition, no tooltip,
    context menu or hover action state, and a short drop animation into the final position on release.
17. Dragging a Grouped task onto the four edges of the session-area Workbench pane reuses the Project
    task's split drop target and session identity rules; a successful split must not commit the grouped
    sort preview, and the task keeps its level and order in Grouped. Dragging a group header only sorts
    inside Grouped and cannot create a split.
18. While dragging, the currently mounted visible task rows play a FLIP make-way animation; group
    container height changes and following top-level node position changes when a task moves in/out of a
    group animate at the same pace; unmounted nodes outside the virtual window do not animate, and system
    reduced-motion is honored.
19. Drag changes only the Grouped user organization order; it does not change ZCode session, task
    realtime stream, desktop continuous or web remote replayable message recovery semantics.

## Fork and New Task Pinning

A top-level new task and a new task from fork must be written to the top-level order in
`task_group_view_node_orders` with a new minimum `sort_order`, at the top of the Grouped list. A New task
in a group, once promoted from draft, must write the group's membership with a new minimum member
`sort_order`, first inside the group. Optimistic UI placement is only instant feedback; the source of
truth after refresh is SQLite.

- Desktop continuous `createSession` and `forkSession` both write the task index and grouped top-level
  order through `ZCodeTaskIndexSyncer.syncSnapshotAndBroadcast(..., { moveGroupedTaskToTop: true })`.
- Web remote replayable/shared-host creation writes the grouped top-level order through the task adapter.
- A task already in a group, and a new task promoted from a group draft, must not be moved out of its
  group by an ordinary snapshot sync; top-level pinning is only for root new/fork entries where a new task
  first enters the list.
- Top-level order initialization of a new task must be idempotent: the visible state, first title and full
  snapshot of one session may flow back concurrently, and only the first time the task is found with no
  group membership and no top-level order may a new minimum `sort_order` be allocated. Later repeated
  syncs update only task meta and must not pin again, otherwise a slower old-task write-back would jump
  over a newer task.
- After the first top-level order write succeeds, a `task_created` semantic event must be emitted so the
  running Grouped structure cache is invalidated and re-fetched; the sessions-index visible frame may
  precede the SQLite order write, so relying only on session-list changes would append the order-less task
  at the end until a restart.
- Placement after group-draft promotion must not depend on `optimisticTaskListByTaskId`. V4 first send
  guarantees only the active session and the sessions-index authoritative task are visible; once the
  promoted marker and the authoritative task both appear, group membership and first-in-group order must
  be written by the marker.
- When a grouped draft is promoted to a real task id at the create/send accepted boundary, the promoted
  placement and the minimal renderable `optimisticTaskListByTaskId` metadata must be written in one
  renderer store transaction. Do not clear the draft row first and wait for sessions-index, or a task-row
  gap appears between the ACK and the authoritative list projection. That metadata is a short-term UI
  overlay that does not fake a conversation projection; its `updatedAt` must use a sentinel lower than any
  authoritative session time, never the renderer's local clock for ordering or field-authority races.
  Desktop continuous and web remote replayable both reconcile against the later sessions-index
  authoritative metadata with task-meta field-level merge; the minimal overlay's empty title and default
  mode/provider/status must not override later authoritative fields.

Colors store a semantic enum, not CSS values; the UI maps them per theme:

```ts
type TaskGroupColor = "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";
```

## Data Model

A task group repo/service lives in the service layer so the UI never accesses the repo directly.

```ts
interface TaskGroup {
  id: string;
  title: string;
  color: TaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

interface TaskGroupMember {
  groupId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sortOrder?: number;
  addedAt: number;
}
```

Ungrouped tasks also need a top-level user order, recorded separately for the `Grouped` view:

```ts
interface TaskGroupViewNodeOrder {
  nodeType: "task" | "group";
  nodeKey: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}
```

A task-type `nodeKey` must include workspace identity, not only `taskId`. Identity isolation and
cross-workspace matching always use:

```ts
const workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

Path execution semantics still use `workspacePath`.

## SQLite Persistence

Group data persists in the existing task index database:

```txt
~/.zcode/v2/tasks-index.sqlite
```

No separate JSON source of truth for groups, and no group state in the UI store, relay or main process.
The services-layer repo reads/writes SQLite; the UI accesses it only through service/hook. Three tables:

```sql
CREATE TABLE IF NOT EXISTS task_groups (
  group_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'gray',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_group_members (
  group_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_identity TEXT,
  task_id TEXT NOT NULL,
  sort_order INTEGER,
  added_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_key, task_id),
  FOREIGN KEY (group_id) REFERENCES task_groups(group_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_group_view_node_orders (
  node_type TEXT NOT NULL,
  node_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_type, node_key)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_task_group_members_group_order
ON task_group_members (group_id, sort_order, added_at);

CREATE INDEX IF NOT EXISTS idx_task_group_view_node_orders_order
ON task_group_view_node_orders (sort_order, created_at);
```

Constraints:

- The `task_group_members` primary key `(workspace_key, task_id)` mechanically guarantees a task belongs
  to at most one group.
- Deleting a `group_id` removes membership via `ON DELETE CASCADE`.
- `task_group_view_node_orders` stores the top-level mixed order; a group does not store an extra
  `sortOrder`, avoiding a split ordering source of truth.
- `node_type = 'group'`: `node_key = group_id`. `node_type = 'task'`: `node_key` is built from
  `workspace_key` and `task_id` with an encoding safe from SQLite/JS string truncation, e.g.
  `JSON.stringify([workspaceKey, taskId])`.
- `workspace_key` is generated as `workspaceIdentity?.trim() || workspacePath`.

The service layer opens the same SQLite file via `getTasksIndexDatabasePath()` and follows the existing
task index initialization habits: `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`,
`CREATE TABLE IF NOT EXISTS` for idempotent schema init, and `PRAGMA table_info` + `ALTER TABLE ADD
COLUMN` for added fields.

Order and membership changes from menu move, draft promotion and ungroup must commit in one SQLite
transaction; the task list/grouped view invalidation event is broadcast only after a successful commit.

## Query Result

The service layer returns a normalized view model; the UI only renders and holds interaction state:

```ts
type GroupedTaskViewNode =
  | { type: "task"; task: ZCodeTaskListItem; sortOrder?: number }
  | {
      type: "group";
      group: TaskGroup;
      tasks: ZCodeTaskListItem[];
      sortOrder?: number;
    };

interface GroupedTaskView {
  nodes: GroupedTaskViewNode[];
}
```

Query rules:

- Filter archived/deleted tasks; remove grouped tasks from top level; keep only visible tasks inside a
  group; groups may span workspaces; keep empty groups.
- If a visible top-level task/group lacks `TaskGroupViewNodeOrder.sortOrder`, the service fills the user
  order immediately by creation time descending. If a visible in-group task lacks
  `TaskGroupMember.sortOrder`, it fills it by join time descending.
- The query takes no `sortBy`; `Grouped` uses only the groups' own user order, not the global sort.

### Visibility Source of Truth and Delete Convergence

The Grouped client projection merges three data sources of different roles; `sessions-index` supplies only
task display content and cannot alone prove a task is still visible:

```txt
sessions-index summary (title/status etc.) ───────┐
active task entity keys (visibility allowlist) ───┼─> Grouped client projection
group structure (membership and user order) ──────┘
```

- Active task entity keys come from the task index's active `listTasks()` result, combined as
  `workspaceKey = workspaceIdentity?.trim() || workspacePath` + `taskId`; a historical summary that exists
  only in `sessions-index` but is marked deleted in the task index must not enter the projection.
- A new task before its authoritative task-index row appears keeps showing through the existing
  promoted/optimistic overlay; the active allowlist must not swallow an accepted new task, and optimistic
  metadata must not become persisted truth.
- When a task goes from active to deleted, one SQLite transaction writes `tasks.deleted = 1` and deletes
  the matching `task_group_members` and task-type top-level `task_group_view_node_orders`; the list change
  is broadcast only after commit.
- Task index initialization idempotently cleans membership and top-level order references left by
  historical deleted tasks, repairing dirty data from old versions.
- Group membership and user order of archived/pinned tasks are kept so they return to the original
  position after restore; the physical cleanup targets deleted tasks only.
- The service-side `applyGroupedTaskViewOrder` keeps rejecting missing, archived, deleted or pinned tasks
  as the final consistency guard, never replacing validation with silent ignoring.
- Do not use the `kind: "active"` list of sessions-index / Controller as evidence that a row should stay
  in grouped: that scope is `!archived` and includes pinned tasks, while grouped's scope is "not pinned and
  not archived"; using it to cancel out "row disappeared" would resurrect pinned tasks into groups. To
  distinguish "membership really changed" from "left table briefly lags", rely only on the membership
  version and structure version, not on activity.

Sort rules:

- Top-level groups and top-level ungrouped tasks sort by `TaskGroupViewNodeOrder.sortOrder`; in-group
  tasks by `TaskGroupMember.sortOrder`.
- `createdAt` only fills a missing top-level user order the first time and `addedAt` only fills a missing
  in-group user order the first time; neither takes part in later comparisons.
- New content must be assigned a top `sortOrder` first, never relying on creation-time fallback.

## Interaction

Group item shows: a Finder-tag style color dot, group title, visible task count, expand/collapse entry and
a more menu. Group menu: Rename, Set Color, Delete Group.

Task menu:

- An ungrouped task supports `Add to Group`; an in-group task supports `Remove from Group`.
- All tasks support `Move to top` (hover action and context menu): a root task becomes the first top-level
  item of the grouped view; an in-group task moves to the first position of its group.
- Existing pin, rename, archive and mark unread actions are reused.

## Move and Sort

Grouped tasks support drag moves and, via the task item context menu, moving into a group, out of a group
or to the top. `Move to top` is an explicit pin within the current level; it only modifies the grouped
view order and never changes the task's workspace/session.

## Render Stability (No Whole-Block Flash)

The Grouped body may be hidden only while the **first-screen authoritative data is not ready**; once a
non-empty list has been painted, any later refresh, remount or transient empty state must keep rendering
the previous list: old data beats a blank. This constraint is grouped-specific because grouped is the only
task view that keeps its authoritative list in component-instance state and has a first-screen gate
(timeline/pinned/archived render from the module-level query cache and cannot produce blank frames).

- The first-screen gate is a one-time latch and must not follow the Controller list's transient `loading`:
  each streaming node of a running task (prompt sent, first tool display, output done) triggers a
  re-query, and following it would unmount and remount the whole subtree.
- `loading` only means "no authoritative node yet on first screen". A background refresh with an existing
  list must not set it, or the empty-state text and the gate flash.
- The last authoritative view is cached at module level keyed by the workspace scope signature, so an
  ancestor remount / HMR keeps painting immediately. This cache has no active invalidation: deletes /
  archives / group changes during unmount do not evict it, so old rows may be briefly visible and
  clickable after remount, with the dirty-read window bounded by one refresh round trip. This is an
  explicit trade-off of "old data beats a blank", not a defect; narrowing it can only add a TTL or
  degrade to a placeholder, never widen the window to save RPCs.
- View and scope-related memos are keyed by value signature, not array identity, otherwise a parent
  rebuilding a same-valued array creates a "refresh changes identity -> effect refreshes again ->
  re-render" self-excitation loop. The scope signature's sort comparator must tie-break through all
  participating fields; comparing only the first element makes two tabs with the same workspaceKey but
  different purpose swap positions in the tabs array, producing a new signature and a redundant refresh.
- The two gate latches (`initialized`, `hasPaintedOnce`) write refs directly during render. This is safe
  only because they are monotonic (`false->true`, never back) and the new value derives fully from the
  render's inputs: a discarded concurrent render also assigns, which for a monotonic latch at worst opens
  the gate one frame early. Any state that can fall back or depends on commit order must not copy this and
  must use an effect.
- List and node reference stabilization short-circuits on content equivalence, and its failure is silent
  (only a whole-block flash regression, with no log or metric). Nested-object equivalence therefore uses
  key-order-insensitive structural comparison, not `JSON.stringify`, because upstream builds objects with
  conditional spread and key insertion order is not stable across frames. The key-order regression case in
  `taskListItemStabilization.test.ts` locks this.

Judgment criteria and verification: `docs/task-list-refresh-semantics.md` §4.2 / §5.1. Retests must fully
restart the app: vite HMR keeps the old state of mounted components, so hot-replaced observations are not
conclusions.

## Sticky Group Header

When Grouped scrolls, following the file tree's sticky directory, an extra sticky copy of the current
group header is rendered outside the masked scroll container, rather than relying only on the original
header's CSS sticky.

- The copy shows only when the group header has scrolled out of the container top and the group's content
  area still covers the top.
- A collapsed group shows no sticky copy (no scrollable in-group context, so sticking would mislead).
- The copy is rendered as a sibling/outer slot of the masked scroll list so the sidebar top fade mask does
  not clip it.
- It is hidden while dragging a task/group so the sticky header and the original header do not both
  register dnd hit targets.
- The sticky header reuses the group's color, collapse, new task, recolor and ungroup entries; order and
  membership are still persisted by the original grouped view mutation.

State layers: 1. Server snapshot: the real `GroupedTaskView` from the service. 2. Optimistic view: menu
move, ungroup and draft promotion apply the optimistic UI first, then call the service to persist.

```ts
async function applyGroupedViewChange(nextView) {
  applyOptimisticView(nextView);

  try {
    await taskGroupService.applyGroupedTaskViewOrder(viewToOrderInput(nextView));
    await refreshGroupedView();
  } catch (error) {
    rollbackOptimisticView();
    toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
  }
}
```

A view change must not bump the task list version of unrelated workspaces nor wrongly delete the order of
collapsed workspaces.

## Service-Layer Validation

Persisting mutations are validated uniformly in the service layer: task exists; task is not
archived/deleted; group exists; task does not already belong to another group; a cross-workspace task ref
carries `workspaceIdentity?`; the sort position is legal; and a task still belongs to at most one group.

## Multi-Device Boundary

`Grouped` is a cross-workspace UI organization view, but task execution, archive and delete still belong
to the original workspace/task flow.

- Group state does not sink into relay or the main process.
- The desktop `continuous` and mobile `replayable` conversation/task message flow semantics are unchanged.
- Remote workspace member references must pass `workspaceIdentity` and the available `remoteSessionId`
  context end to end; matching by `workspacePath` alone is forbidden.
- Mobile `/remote` still reuses the existing host through shared-host attachment and does not start a
  separate ZCode Agent runtime for the group view.
