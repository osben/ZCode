# v4 Session Workbench Groups

Status: **all creation entries are retired (2026-10-16)**. Dragging a Task-list item to the edge of
the conversation area and the context-menu "Open in split" no longer create or extend a group (see
`docs/v4-split-pane-workbench.md`); existing groups can still be restored, focused and have panes
closed. The original design below is kept as the behavior contract for existing groups.

## Summary

| Field                 | Value                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | A left-side session can be dragged into the central v4 workbench and creates a split by the target pane's top/bottom/left/right drop zone; several sessions form a keepable, restorable workbench group (user wording: "shell"). |
| User-visible surfaces | left session list, v4 central chat workbench, workspace header, Git branch entry, pane chrome, drag preview.                                                                                                                     |
| Existing docs         | `docs/v4-split-pane-workbench.md`, `docs/v4-refactor/06-ui.md`, `docs/testing/conversation-session-e2e-coverage-matrix.md`.                                                                                                      |
| Existing code owners  | `packages/ui/src/v4/paneLayoutStore.ts`, `packages/ui/src/v4/paneLayoutTree.ts`, `packages/ui/src/v4/V4WorkspaceChatArea.tsx`, `packages/ui/src/v4/WorkbenchPane.tsx`, left task/session item components.                        |
| Out of scope          | mobile Web, `/remote` web-remote replayable (must fully bypass the group lifecycle), agent/protocol/schema changes, pushing business state down to main/relay, cross-device group state sync.                                    |

## Product semantics

The user wants an IDE editor-group mental model, not a one-off "open in split":

```text
left session list
   drag session C
       |
       v
current central workbench group
+-------------------+-------------------+
| session A         | session B         |
|  top/left/right/  |  top/left/right/  |
|  bottom drop zone |  bottom drop zone |
+-------------------+-------------------+
       |
       v
after a successful drop, session C moves into this group and a new pane is split off in the given direction of the target pane.
```

A group is a renderer-side "shell":

```text
Group G1
+-----------+-----------+
| session A | session B |
+-----------+-----------+

Group G2
+-----------+
| session C |
+-----------+
```

Clicking a left session first looks up `sessionId -> groupId`:

```text
click A -> activeGroupId = G1 -> focus the pane holding A
click B -> activeGroupId = G1 -> focus the pane holding B
click C -> activeGroupId = G2 / implicit single pane -> focus C
```

If the session belongs to no multi-pane group, click keeps the old semantics: show a single-pane view
through the original session-open path. If it is later dragged into an existing group, it migrates
from its implicit single-pane shell to the target group.

## Clarification record

| Round | Question                                                                                                                               | User answer                                                                                                                               | Boundary fixed                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Should the center drop zone replace the current pane, focus an existing pane, or not accept?                                           | Center accepts no drop; four-direction split only.                                                                                        | Only top/bottom/left/right drop zones; center shows no droppable state.                                                                                                                                                     |
| 2     | Cross-workspace sessions supported?                                                                                                    | Yes.                                                                                                                                      | Drop uses the dragged session's own `workspacePath/workspaceIdentity/remoteSessionId`.                                                                                                                                      |
| 3     | What if a session already open in the current view is dragged again?                                                                   | Not draggable; or no translucent zone when dragged.                                                                                       | A session already in the group cannot be added twice; disable drag at the source and guard again at the drop target.                                                                                                        |
| 4     | Is the four-direction drop anchor the target pane or the whole workbench?                                                              | The target pane.                                                                                                                          | Whichever pane's edge is dropped on, split relative to that pane.                                                                                                                                                           |
| 5     | Meaning of the 4-pane cap?                                                                                                             | Total pane count; no more splits when full.                                                                                               | One group has at most 4 panes, in horizontal, 2x2 or nested combinations.                                                                                                                                                   |
| 6     | Drop preview form?                                                                                                                     | Translucent area demo.                                                                                                                    | Translucent preview of the target pane's matching half; no center-replace state.                                                                                                                                            |
| 7     | Which clients enable it?                                                                                                               | Desktop and ordinary Web App; not mobile and web-remote.                                                                                  | Enable `desktop-continuous` and ordinary Web App v4; disable mobile and `/remote` web-remote replayable.                                                                                                                    |
| 8     | After dropping a cross-workspace session, do header/sidebar follow?                                                                    | Follow the active session.                                                                                                                | `focusedPaneId` derives the active context; workspace header, branch and left highlight follow the focused pane.                                                                                                            |
| 9     | "Shell" click semantics?                                                                                                               | A/B live in one shell; clicking A/B shows that shell and activates the session; an unsplit session opens in a new shell by the old logic. | Introduce the group concept; session click locates the group first, then focuses the pane.                                                                                                                                  |
| 10    | Is a group kept?                                                                                                                       | Yes.                                                                                                                                      | After switching to another session/group, the original group layout is kept and any member click restores it.                                                                                                               |
| 11    | Can one session belong to only one group?                                                                                              | Yes.                                                                                                                                      | `sessionId` belongs uniquely to one group; no duplicate open across groups.                                                                                                                                                 |
| 12    | When is a group dissolved?                                                                                                             | Degrades with 1 session left, deleted with 0.                                                                                             | A group's special identity exists only with 2+ sessions; GC by member count after close/move-out.                                                                                                                           |
| 13    | Is a group persisted?                                                                                                                  | Yes, in the renderer layer, e.g. localStorage.                                                                                            | Renderer-local persistence; restored on refresh/restart; not in agent/protocol.                                                                                                                                             |
| 14    | After dragging ungrouped C into G1, what happens to its original shell?                                                                | C moves into G1; the original implicit single-session shell disappears.                                                                   | Session move is the only ownership migration; the old implicit group is not kept.                                                                                                                                           |
| 15    | Does a subagent inline "open on the right" replace the main session?                                                                   | No; the detail belongs to a workspace right tab.                                                                                          | A child no longer creates a workbench group/pane; shown/hidden by parent session, full semantics in `subagent-session-side-tabs.md`.                                                                                        |
| 16    | Can a side-opened subagent child take input?                                                                                           | No; it is a read-only observation view.                                                                                                   | The child binding from a subagent split is marked `readOnly`; the pane renders no composer/input and offers no new prompt entry.                                                                                            |
| 17    | Can a session be dragged in to split while the center is a draft?                                                                      | Yes.                                                                                                                                      | A draft is not a session and builds no workbench group; after drop the primary stays the draft and the dragged session enters a non-primary pane.                                                                           |
| 18    | When a read-only subagent child is focused, does the left active task sync?                                                            | No.                                                                                                                                       | A readOnly pane has only workbench-local focus; shell active task, left highlight and task-list optimistic active do not switch to the child session.                                                                       |
| 19    | After closing the current focused pane, which task stays active outside?                                                               | The navigable focused session of the workbench after closing.                                                                             | After closing the child in a 2-pane layout, return to primary/main; closing a non-focused pane does not change shell active.                                                                                                |
| 20    | Where does `Cmd/Ctrl+N` create the new task in a split?                                                                                | The focused pane's workspace.                                                                                                             | Subagents no longer enter the workbench; an ordinary focused pane supplies only `workspaceScope` and creates a draft session in that workspace.                                                                             |
| 21    | Does `Cmd/Ctrl+N` split another draft inside the current split?                                                                        | No.                                                                                                                                       | After creating, leave the current active workbench group and return pane layout to a single primary panel; the historical group is kept and clicking a member restores it.                                                  |
| 22    | After deleting a group's primary session, what shows?                                                                                  | Back to the current workspace draft.                                                                                                      | After the CLI accepts the delete, dissolve the group and clear the shell's deleted session; a secondary is not implicitly promoted.                                                                                         |
| 23    | Is hiding only the group UI enough on `/remote`?                                                                                       | No.                                                                                                                                       | The remote renderer must not restore, create, persist or consume groups; sidebar and new-task both bypass the group store.                                                                                                  |
| 24    | On 2026-07-13, close the whole split or only the explicit buttons?                                                                     | Only the explicit buttons; the Task list can still be dragged into the conversation area to split.                                        | Pane chrome renders no split buttons; drag drop zones, group state and cross-workspace isolation remain the formal contract.                                                                                                |
| 25    | When draft A is beside a dragged-in existing task B, how does A upgrade on first send?                                                 | A binds in place to the new session created by the first send; A stays after focusing B.                                                  | On `createSession` accepted, first bind the primary draft to A′ and atomically promote the whole layout to a group, then sync shell active; later pane focus only changes the active context and cannot revert A′ to draft. |
| 26    | If the right-clicked target session is already in another workbench group, duplicate split or switch?                                  | Switch.                                                                                                                                   | "Open in split" first looks up an existing pane/group by `workspaceKey + sessionId`; on a hit in another group, activate and focus the existing pane, creating no copy.                                                     |
| 27    | With a draft primary and B opened beside it via right-click, then an ordinary click on ungrouped C: leave the split or replace a pane? | Keep the split; C replaces the currently focused B, giving `[draft A                                                                      | C]`.                                                                                                                                                                                                                        | In a draft temporary layout an ordinary session click only rebinds the focused non-primary pane; the primary draft does not take part in replacement. |

## Boundary decisions

| Boundary                   | Decision                                                                                                                   | Includes                                                                                                                                                                                       | Excludes / prunes                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Drop target                | Only the four edge zones are accepted.                                                                                     | top/right/bottom/left half preview and split.                                                                                                                                                  | center replace, center focus, drop-to-nowhere.                                                                                                                      |
| Anchor                     | Split relative to the pane under the pointer.                                                                              | Insert a new pane on top/bottom/left/right of the target pane.                                                                                                                                 | Fixed insertion at the outermost workbench.                                                                                                                         |
| Cross workspace            | Supported.                                                                                                                 | Local, SSH/WSL/Docker, as long as the session meta carries a complete scope.                                                                                                                   | Overriding the dragged session's scope with the current shell workspace.                                                                                            |
| Duplicate session          | One session belongs to only one group.                                                                                     | Drag disabled at the source when already in a group; drop guard shows no preview.                                                                                                              | Multi-copy views of the same session.                                                                                                                               |
| Group lifetime             | 2+ sessions form a group; 1 degrades; 0 deletes.                                                                           | Clicking any member restores the group.                                                                                                                                                        | Keeping an empty group or a special group with one member.                                                                                                          |
| Pane limit                 | At most 4 panes per group.                                                                                                 | Horizontal 4, 2x2 and nested 4 all allowed.                                                                                                                                                    | Splitting beyond 4.                                                                                                                                                 |
| Active context             | The focused pane derives header/sidebar.                                                                                   | Workspace header, branch and sidebar highlight follow the focused session.                                                                                                                     | A drop that changes only the pane without the active context; or directly switching the shell tab and breaking the group.                                           |
| Subagent split entry       | Open the child only beside the current pane.                                                                               | The child session enters a side pane; the primary pane keeps showing the parent session; the child pane is a read-only observation view.                                                       | Reusing the old global split open, which feeds the child focus back as the shell active session / primary; or treating the child as an ordinary session with input. |
| Draft drop entry           | A draft pane also accepts four-direction drag split.                                                                       | Primary stays draft; the dragged session enters a non-primary pane of `paneLayoutStore`; the draft's first send still binds in place.                                                          | Forbidding preview/drop because `sessionId === null`; or forcing a group that requires the draft to have a sessionId.                                               |
| Drop preview layering      | A translucent preview covers the whole target pane.                                                                        | The preview sits above the composer dock/input and pane content.                                                                                                                               | The bottom being covered by the composer/input's sticky `z-20`.                                                                                                     |
| Pane focus vs shell active | readOnly pane focus is not shell active task.                                                                              | Ordinary pane focus/close syncs shell active; readOnly child focus changes only workbench focus.                                                                                               | A child session showing in the left-list highlight or optimistic task active.                                                                                       |
| Close focus repair         | After closing the focused pane, sync the remaining navigable session.                                                      | A closed focused child returns to primary/main; with 3+ panes sync by the workbench focus after closing.                                                                                       | Forcing an active switch when closing a non-focused pane.                                                                                                           |
| New task shortcut          | `Cmd/Ctrl+N` creates a single-panel draft in the focused pane's workspace.                                                 | Desktop menu `NewTask`, ordinary Web `Cmd/Ctrl+N` and the top button reuse the Root create-task entry; the target workspace comes from the workbench focused pane, including a readOnly child. | Splitting a draft inside the current group/paneLayout; creating by the shell active tab's workspace only.                                                           |
| Persistence                | Renderer-local localStorage.                                                                                               | group layout, pane binding, focused pane, session-to-group mapping.                                                                                                                            | agent/runtime/main/relay persistence, cross-device sync.                                                                                                            |
| Client modes               | Desktop and ordinary Web App enabled.                                                                                      | `desktop-continuous`, ordinary web v4.                                                                                                                                                         | Mobile, small screens, `/remote` web-remote replayable.                                                                                                             |
| Explicit split buttons     | Pane chrome split buttons are retired.                                                                                     | Dragging a Task-list session to the conversation area edge.                                                                                                                                    | The pane chrome "split right / split down" buttons.                                                                                                                 |
| Primary draft promotion    | The temporary layout of draft + existing session upgrades atomically on the draft's first send.                            | The primary draft's new session binding, secondary bindings, root/focus move to the group in one step; shell active follows the new session.                                                   | Updating only shell `activeTaskId` and letting the primary keep depending on it; resetting a sent primary to draft after focusing a secondary.                      |
| Context-menu split parity  | Left-side right-click "Open in split" shares the pane/group owner with drag.                                               | A single session creates a group; an existing group appends a pane; a draft uses the temporary paneLayout; an existing session of another group only switches/focuses.                         | The menu unconditionally writing the global paneLayout; opening the same session twice; creating a second view when a group already exists.                         |
| Current-session guard      | The menu item is disabled when the focused pane already shows the target session.                                          | Ordinary single pane, group focused pane, focused secondary pane of a draft temporary layout.                                                                                                  | Judging only by shell `activeTaskId` and missing group/pane local focus.                                                                                            |
| Draft focused replacement  | An ordinary click on an ungrouped session inside a draft temporary layout replaces the focused secondary binding in place. | `[draft A                                                                                                                                                                                      | B] --click C--> [draft A                                                                                                                                            | C]`, workspace scope and sessionId replaced together. | Feeding shell `activeTaskId=C` straight into the primary; replacing the draft; unintentionally adding a third pane. |

## State model

A renderer-local group store is added on top of the existing pane layout. The point is not to change
the protocol into groups, but to maintain at the UI layer "which restorable workbench group a session belongs to".

```text
WorkbenchGroupState
  activeGroupId: string | null
  groups: Record<groupId, WorkbenchGroup>
  sessionIndex: Record<sessionKey, { groupId, paneId }>

WorkbenchGroup
  id: string
  root: PaneLayoutNode
  panes: Record<paneId, PaneBinding>
  focusedPaneId: string
  updatedAt: number

PaneBinding
  workspaceScope: {
    workspacePath: string
    workspaceIdentity?: string
    remoteSessionId?: string
  }
  sessionId: string
  readOnly?: boolean  // child session opened on the side from a subagent row: read-only, renders no composer/input
```

`sessionKey` must include the workspace identity boundary:

```text
sessionKey = `${workspaceIdentity?.trim() || workspacePath}::${sessionId}`
```

`workspacePath` stays for path display and execution; identity/isolation semantics uniformly use
`workspaceIdentity?.trim() || workspacePath`.

### Relationship between a single session and a group

An ordinary unsplit session need not be written into the group store in advance; clicking an ungrouped
session can show a single pane by the old logic. Only these actions create/keep a group:

- Drag an ungrouped session beside another session/pane, forming a 2-pane group.
- Keep dragging a new ungrouped session into an existing group, forming a 3/4-pane group.
- Restore a group with 2+ valid members from localStorage.

When a group has only 1 valid member left:

```text
remove group
remove remaining session from sessionIndex
next click on that session opens by the ordinary single-pane logic
```

## Event order

### Clicking a left session

```text
User click sidebar session
        |
        v
build sessionKey(workspaceIdentity?.trim() || workspacePath, sessionId)
        |
        +-- sessionIndex hit a group
        |       |
        |       v
        |   activeGroupId = groupId
        |   focusedPaneId = indexed paneId
        |   active context = focused pane binding
        |
        +-- miss
                |
                v
            old logic: open the single-session view
```

The draft temporary layout is an explicit exception to the "old logic" above: it has no draft
sessionId that can be written to the group index, but must still keep the editor-group focused pane semantics.

```text
paneLayout = [draft A | B], focused=B
        |
        | ordinary click on ungrouped C
        v
atomically replace pane B's complete binding (workspaceScope + sessionId)
        |
        v
paneLayout = [draft A | C], focused=C

Forbidden path: shell.activeTaskId=C -> primary reads C -> [C | B]
```

### Right-click "Open in split"

```text
drag / context-menu / sidebar-select target T
        |
        v
workbenchSessionPlacement resolver (decides only, writes no store)
        |
        +-- T == current focused session -> disabled / no-op
        +-- T already in another group/pane --> context: focus existing; drag: reject duplicate
        +-- current is ordinary session A ----> create / extend group
        +-- current primary is a draft -------> split temporary paneLayout
        `-- ordinary click in a draft split --> replace focused secondary
        |
        v
executor: commit the pane/group owner first, then sync shell active
```

### Dragging into a split

```text
dragstart sidebar session
        |
        +-- session already in any group -> draggable=false / no payload
        +-- pane count full in current target group -> payload may exist but the target shows no preview
        v
dragover target pane
        |
        +-- client unsupported -> ignore
        +-- target group full -> ignore
        +-- dragged session already in target/current group -> ignore
        +-- pointer in center -> ignore
        +-- pointer in edge zone -> show preview
        v
drop
        |
        v
split target pane by direction
bind new pane to dragged session workspaceScope + sessionId
sessionIndex[sessionKey] = { groupId, paneId }
activeGroupId = groupId
focusedPaneId = newPaneId
persist localStorage
```

### Recovery after closing a pane / deleting a session

```text
close pane or restore guard removes missing session
        |
        v
remove pane binding + sessionIndex entry
        |
        +-- group pane count >= 2 -> keep group
        +-- group pane count == 1 -> collapse to ordinary single session, delete group
        +-- group pane count == 0 -> delete group
```

Deleting the primary is an independent session lifecycle event: the group store GC and shell session
navigation must close out atomically.

```text
delete primary A accepted
        |
        +-- remove group/session index
        `-- shell.onSessionDeleted -> activeTaskId/sessionId = null -> workspace draft
```

`web-remote-replayable` is more than hiding the split affordance. While the remote shell is enabled,
all sidebar/new-task entries must bypass the group context, the renderer neither reads nor writes
`workbench-groups:v1`, and leftover old state cannot become a workspace target.

### paneLayout → group single ownership

```text
draft / ungrouped split: paneLayout:v2 owns root
        |
        | secondary pane binds a normal session and promotion succeeds
        v
session group: workbench-groups:v1 owns root
        |
        +-- consume/reset the paneLayout source to a single primary
        +-- divider ratio writes group.root
        `-- group GC falls back to the consumed single primary
```

Promotion is not copying the layout and keeping a double write. After success the old paneLayout split
must be consumed; otherwise the divider writes the ratio to an invisible owner and the old secondary
pane revives after the group closes. Workspace scope/binding is kept as is during ratio updates, and
the isolation key stays `workspaceIdentity?.trim() || workspacePath`.

### Subagent detail migration boundary

```text
User click "Open on the right" on a subagent child
        |
        v
row context provides parentSessionId + childSessionId + subagentType
        |
        v
open/reuse workspace side tab keyed by workspace + parent + child
        |
        +-- workbench group/pane count unchanged
        +-- child tab is a full readOnly SessionPane
        v
activate child tab, but shell active task remains parent
        |
        v
all open child tabs keep live leases; parent switch only filters tab triggers
```

This entry no longer goes through `paneLayoutStore` or a workbench group. When restoring historical
localStorage, an old group containing a `readOnly` child binding is discarded; ordinary session groups
keep the original restore semantics. A child pane also cannot be treated as an ordinary typable session:
a subagent's child session is produced by parent-session orchestration, and the inline side-open only
views its execution and result, so the user must not continue entering new prompts in the child pane.

## UI design constraints

- The drag preview is an overlay of the matching half of the target pane, using design tokens:
  - background: low opacity of brand/accent;
  - border: brand or focused border;
  - no hard-coded blue, compatible with light/dark/Zai themes.
- With multiple panes, a non-focused pane uses a weak mask to express "not active":
  - the mask is a low-opacity blend of the background token and does not lower the pane content's
    opacity directly, so text, code blocks and images do not fade together;
  - the mask is `pointer-events: none`, click/focus is still received by the pane shell;
  - the drop preview must layer above the non-active mask so the drag demo is not covered;
  - a single pane shows no mask, avoiding meaningless dimming of a draft/ordinary single session.
- The center zone shows no preview and triggers no drop.
- A session item already in any group shows no draggable affordance; if the browser still fires dragover, the workbench shows no preview.
- At 4 panes, no drop preview is shown and no split is triggered.
- Header and left highlight follow the focused pane's active context:

```text
focused pane binding
        |
        +--> workspace header path/remote label
        +--> Git branch switcher workspacePath
        +--> sidebar workspace/session highlight
        +--> focused pane command routing
```

- A cross-workspace pane's branch/status must not reuse the shell's current workspace Git summary. If
  the target workspace's Git summary is not loaded yet, show the workspace badge/path first and load the
  branch entry independently for that workspace or degrade it to an empty state.
- Mobile and `/remote` web-remote do not enable drag split; the entry is not shown and the drop target is not registered.

## Domain scope

| Domain                            | Include? | Why it can change behavior                                                                    | Primary sources                                                                        |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| UI shell/theme/locale/responsive  | yes      | drag affordance, drop preview, header/sidebar active context are UI shell behavior.           | `DESIGN.md`, `packages/ui/src/v4/*`                                                    |
| Conversation/session behavior     | yes      | session click, focus and pane command routing affect the current active session.              | `docs/conversation-protocol-declaration.md`, `packages/ui/src/v4/SessionPane.tsx`      |
| Workspace identity/remote runtime | yes      | A cross-workspace group must keep `workspaceIdentity` isolation and the remote session scope. | `docs/v4-split-pane-workbench.md`, `docs/remote-workspace-session-unified-settings.md` |
| Persistence/index/snapshot        | yes      | group layout localStorage restore, cleanup after delete/archive.                              | `packages/ui/src/v4/paneLayoutPersistence.ts`                                          |
| Mobile remote/replayable realtime | limited  | only to explicitly disable `/remote` and keep replayable semantics from spreading.            | `docs/web-remote-control/web-remote-control-architecture.md`                           |
| Protocol/agent runtime            | no       | A group is renderer-local UI state and does not change the v4 protocol.                       | `docs/v4-split-pane-workbench.md`                                                      |

## High-risk cross-products

| Cross-product                                | Candidate risk                                                                                  | Initial handling                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| focused pane x header/sidebar active context | The header shows A but commands/highlight still point at B.                                     | The active context must be derived from the focused pane binding as a single source.                                        |
| cross workspace x Git branch switcher        | A pane outside the current shell workspace reuses the wrong Git summary.                        | Branch/status reads must follow the focused pane's workspace scope.                                                         |
| group persistence x deleted/archived session | localStorage restores a session that no longer exists.                                          | After restore, validate against sessions-index; remove invalid members and GC the group.                                    |
| duplicate session x drag preview             | An already-open session still shows a droppable blue zone.                                      | Double guard at drag source and drop target.                                                                                |
| desktop/web x web-remote replayable          | Group state wrongly pushed down to the replayable remote chain.                                 | Client gate: ordinary desktop/web only; remote/mobile disabled.                                                             |
| pane limit x dragover                        | At 4 the preview still shows but the drop fails.                                                | At 4 show no preview and accept no drop.                                                                                    |
| context menu x current/group ownership       | The current session is still clickable, or a session already in another group is created twice. | A focused target is disabled; on a hit in another owner only activate/focus.                                                |
| draft paneLayout x sidebar navigation        | An ordinary click on C overwrites the primary draft via the shell's single session value.       | Atomically rebind the focused secondary first, then commit shell navigation; the primary draft never has a session binding. |

## Candidate combinations

| Candidate ID | State                                                                                                                         | Event                                                                      | Target/surface        | Expected guard/effect                                                                                                                       | Initial status                                                                 | Notes                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------- |
| SWG-01       | single-pane session A, session B ungrouped                                                                                    | drag B to the right of A                                                   | desktop/web workbench | Create G1, A/B split left-right, focus B.                                                                                                   | accepted                                                                       | base path.                                                                         |
| SWG-02       | G1 has A/B                                                                                                                    | click A on the left                                                        | sidebar               | Show G1, focus A, header/sidebar follow A.                                                                                                  | accepted                                                                       | group restore semantics.                                                           |
| SWG-03       | G1 has A/B, C ungrouped                                                                                                       | drag C below B                                                             | pane B bottom zone    | C moves into G1, split below B, the original implicit C shell disappears.                                                                   | accepted                                                                       | unique-ownership migration.                                                        |
| SWG-04       | G1 has A/B                                                                                                                    | drag A into the workbench                                                  | sidebar/workbench     | Not draggable at the source; if dragover happens, no preview.                                                                               | accepted                                                                       | duplicate guard.                                                                   |
| SWG-05       | G1 has 4 panes                                                                                                                | drag E into any pane                                                       | workbench             | No preview, no split.                                                                                                                       | accepted                                                                       | pane limit.                                                                        |
| SWG-06       | pointer at the target pane center                                                                                             | dragover                                                                   | workbench             | No preview, no drop.                                                                                                                        | accepted                                                                       | center disabled.                                                                   |
| SWG-07       | G1 A/B cross workspace                                                                                                        | focus B                                                                    | header/sidebar        | Header and left highlight show B's workspace/session.                                                                                       | accepted                                                                       | active context derivation.                                                         |
| SWG-08       | web-remote/mobile                                                                                                             | drag session                                                               | remote shell          | No drag split affordance, drop target not registered.                                                                                       | pruned                                                                         | explicitly disabled.                                                               |
| SWG-09       | localStorage restores G1 but B was deleted                                                                                    | restore                                                                    | renderer boot         | Remove B; if only A is left the group degrades and is deleted.                                                                              | accepted                                                                       | restore guard.                                                                     |
| SWG-10       | foreground subagent child B of session A is generated                                                                         | click "Open on the right" beside the `Prompt` title in the Agent expansion | Agent tool block      | No workbench group; the workspace right side activates B's full read-only tab, A stays the main session.                                    | migrated-to-SAT                                                                | current semantics in `subagent-session-side-tabs.md` and SAT01-SAT10.              |
| SWG-11       | primary pane is a draft, session B ungrouped                                                                                  | drag B to the right of the draft pane                                      | workbench draft pane  | Show a full right-half preview; after drop the primary is still a draft, B in the right pane; no group created.                             | accepted                                                                       | a draft is not a session, goes through paneLayoutStore.                            |
| SWG-12       | historical state contains a readOnly subagent child B pane                                                                    | renderer restore                                                           | workbench migration   | Discard the old readOnly group; B can only be reopened as a right tab from the parent Agent row.                                            | migrated-to-SAT                                                                | ordinary session groups unaffected.                                                |
| SWG-13       | session A primary + session/subagent B focused pane; if a draft split was already promoted, the paneLayout source is consumed | close the B pane                                                           | workbench close       | The workbench returns to A; shell activeTaskId/sidebar highlight sync back to A; after group GC B must not revive from a shadow paneLayout. | accepted                                                                       | a closed session must not remain; the visible layout has only one owner at a time. |
| SWG-14       | workspace A main session + historical workspace B readOnly subagent pane                                                      | renderer restore                                                           | migration             | The old readOnly subagent group is not restored and no longer takes part in `Cmd/Ctrl+N` focused pane routing.                              | migrated-to-SAT                                                                | the new subagent right tab does not change shell active workspace/task.            |
| SWG-15       | the current focused pane already shows session A                                                                              | right-click A                                                              | sidebar context menu  | "Open in split" stays visible but disabled; no paneLayout/group/shell written.                                                              | accepted                                                                       | the current guard must be judged by the focused owner.                             |
| SWG-16       | session B already belongs to non-current G2                                                                                   | right-click B in the current single pane/G1                                | sidebar context menu  | Activate G2 and focus B's existing pane; pane count and unique membership unchanged.                                                        | accepted                                                                       | user confirmed "switch".                                                           |
| SWG-17       | primary is draft A, B ungrouped                                                                                               | right-click B and choose "Open in split"                                   | sidebar context menu  | Same as drag, forming a `[draft A                                                                                                           | B]` temporary paneLayout, focus B; no real session or duplicate group created. | accepted                                                                           | menu and drag share the owner/action. |
| SWG-18       | temporary layout `[draft A                                                                                                    | B]` with B focused, C ungrouped                                            | ordinary click on C   | sidebar                                                                                                                                     | Replace the focused secondary's complete binding in place, giving `[draft A    | C]`; pane count unchanged, draft A is not overwritten by the shell session.        | accepted                              | bug-candidate of that round. |

## Accepted cases

| Case ID    | Setup                                                              | Action                                                        | Assertions                                                                                                                             | Evidence layers                                  | E2E status                                                |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------ | ------- |
| SWG-E2E-01 | Ordinary desktop/web, A is the current single pane, B ungrouped.   | Drag B from the sidebar to A's right zone.                    | A right-half preview appears; after drop A/B two panes; focus B; localStorage has G1.                                                  | UI + localStorage + v4 pane testids              | planned                                                   |
| SWG-E2E-02 | G1 A/B exists.                                                     | Click A on the left, then B.                                  | The group is not rebuilt in the center; focused pane switches; header/sidebar follow the matching session.                             | UI + store probe                                 | planned                                                   |
| SWG-E2E-03 | G1 A/B, C ungrouped.                                               | Drag C to B's bottom zone.                                    | Target is below pane B; G1 has three panes; C goes from ungrouped to a G1 member.                                                      | UI + localStorage                                | planned                                                   |
| SWG-E2E-04 | G1 A/B.                                                            | Try to drag A.                                                | The A item is not draggable or dragover shows no preview; pane count unchanged.                                                        | UI                                               | planned                                                   |
| SWG-E2E-05 | G1 with four panes.                                                | Drag E to any pane.                                           | No preview; drop is a no-op.                                                                                                           | UI + store                                       | planned                                                   |
| SWG-E2E-06 | G1 A/B persisted.                                                  | Click A/B after reloading the renderer.                       | G1 is restorable; the matching pane is focused.                                                                                        | UI + localStorage restore + sessions-index guard | planned                                                   |
| SWG-E2E-07 | Mobile or `/remote` shell.                                         | View the session list/workbench.                              | No drag split entry; existing click behavior unchanged.                                                                                | UI                                               | planned                                                   |
| SWG-E2E-08 | Session A's timeline expands subagent child B.                     | Click "Open on the right".                                    | Workbench pane count does not grow; the right child tab is fully read-only; the left active task stays A.                              | UI + store probe                                 | migrated-to-SAT                                           |
| SWG-E2E-09 | The primary pane is a new-conversation draft.                      | Drag session B to the draft pane edge zone.                   | The preview is not covered by the input; after drop draft + B are two panes; the workbench group stays empty.                          | UI + store probe                                 | planned                                                   |
| SWG-E2E-10 | Session A opens subagent child B on the right.                     | Activate and close the B tab.                                 | The left always highlights A; closing only releases the child tab/lease and does not change the main area.                             | UI + store probe                                 | migrated-to-SAT                                           |
| SWG-E2E-11 | Workspace B has a hidden subagent child tab.                       | `Cmd/Ctrl+N` / New task menu.                                 | The shortcut still routes by the shell/workbench focused ordinary pane; the hidden child tab does not become the task-creation target. | UI + store probe                                 | migrated-to-SAT                                           |
| SWG-E2E-12 | Current single pane/group focused session A.                       | Right-click A.                                                | "Open in split" is disabled; pane/group snapshots keep their original reference.                                                       | UI + store probe                                 | planned                                                   |
| SWG-E2E-13 | B is already in another group G2.                                  | Right-click B in the current view and choose "Open in split". | G2 is restored directly with B focused; no added pane/session membership.                                                              | UI + localStorage + store probe                  | planned                                                   |
| SWG-E2E-14 | Primary draft A; B/C are ungrouped sessions in the same workspace. | Right-click B to open in split, then ordinary-click C.        | First `[draft A                                                                                                                        | B]`, then `[draft A                              | C]`; pane count always 2; primary sessionId always draft. | UI + paneLayout store + v4 pane testids + UI debug log | planned |

## Implementation recommendation

Recommended option B: add a `workbenchGroupStore`; do not stuff the group concept into the existing
single `paneLayoutStore`.

```text
packages/ui/src/v4/workbenchGroupStore.ts
  - activeGroupId
  - groups
  - sessionIndex
  - openSessionFromSidebar(scope, sessionId)
  - splitSessionIntoGroup(targetPaneId, direction, draggedSession)
  - closePane(groupId, paneId)
  - focusPane(groupId, paneId)
  - restore/persist localStorage
```

The pure functions in the existing `paneLayoutTree.ts` can be reused: the binary split tree,
`splitPaneAt`, `closePane`, `setSplitNodeRatio`, `effectiveFocusedPaneId` etc. still hold. The
implementation lifts "one global layout" to "one layout per group".

The drag payload carries only the minimal facts the UI needs:

```ts
type DraggedSessionPayload = {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
};
```

The drop target must re-validate the payload from the store and not trust the drag source:

- whether the session already belongs to any group;
- whether the target group exists and is not full;
- whether the client mode allows it;
- whether the pointer lands in an edge zone;
- whether the workspace scope is complete.

## Matrix backfill

| File                                                       | Change                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `docs/conversation-session-case-catalog.md`                | Add product case entries for session workbench group / drag split.                                                    |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | Add SWG-E2E-01 to SWG-E2E-07, initially marked planned.                                                               |
| `docs/v4-split-pane-workbench.md`                          | At implementation, update the "single workbench layout" status to a group-aware workbench and point to this document. |

## E2E handoff notes

- Provider fixture: reuse the v4 conversation fixture; no special provider response needed.
- File-system fixture: at least two workspaces, covering a representative local + remote identity case; a real remote-machine regression can follow later.
- Timing strategy: assert the dragover preview with Playwright mouse move + data-testid; after drop wait for the pane testid and focused state.
- Docker preset: not required; remote workspace coverage can use the existing SSH/WSL/Docker specialized suites.
- Review risks:
  - Header/sidebar active context must not be implemented crudely by changing the global `activeTabId`, or the group-keeping semantics break.
  - Ordinary Web App works but `/remote` and mobile are disabled; the client gate must be testable.
  - localStorage restore must tolerate session deletion, workspace disconnection and schema corruption.
